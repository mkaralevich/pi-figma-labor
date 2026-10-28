/**
 * figma-labor bridge server
 *
 * Relays commands between the pi extension (HTTP) and Figma plugin instances
 * (WebSocket). Every Figma file with the plugin open keeps its own connection,
 * so several agents can work in different files at once.
 *
 * Endpoints:
 *   POST /command    — send a command, waits for plugin response (sync)
 *   POST /undo       — send an undo command to the plugin
 *   GET  /status     — bridge status plus every connected file
 *   POST /shutdown   — drop every plugin socket and exit (/figma-labor-stop)
 *
 * Targeting (optional `target` in POST bodies):
 *   connection id (e.g. "c3-4f1a") or exact file name. Without a target the
 *   command goes to the only connected file, and is refused when several
 *   files are connected, so a write never lands in a guessed file.
 *
 * Protocol:
 *   pi sends:        { command, params, timeout?, target? }
 *   plugin receives: { id, command, params }
 *   plugin sends:    { id, result } | { id, error }
 *   pi receives:     { result, file } | { error }
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

// The plugin connects to 3846; LABOR_BRIDGE_PORT is for running a throwaway
// bridge next to a live one (tests).
const PORT = Number(process.env.LABOR_BRIDGE_PORT ?? 3846);
const COMMAND_TIMEOUT_MS = 30_000;
const IDENTIFY_TIMEOUT_MS = 10_000;

// The plugin's hello carries no file identity, so the bridge asks each instance
// for its file name and an instance id stored in the plugin's globals. The
// instance id survives socket reconnects, which lets the bridge drop the stale
// socket when the same plugin instance connects again.
const IDENTIFY_SCRIPT =
  "globalThis.__laborInstanceId ??= Math.random().toString(36).slice(2); return { file: figma.root.name, instance: globalThis.__laborInstanceId };";

// ## Types

interface Command {
  id: string;
  command: string;
  params: Record<string, unknown>;
}

interface PluginContext {
  editorType: "figma" | "figjam" | "slides" | "dev" | "buzz";
  page: { id: string; name: string };
  selectionCount: number;
  focusedSlide?: { id: string; name: string } | null;
  slidesMode?: "grid" | "single-slide";
}

interface PluginMessage {
  id?: string;
  type?: "ping" | "hello";
  context?: PluginContext;
  result?: unknown;
  error?: string;
}

interface PluginConnection {
  id: string;
  ws: WebSocket;
  context: PluginContext | null;
  file: string | null;
  instance: string | null;
  identifying: boolean;
}

interface FileInfo {
  id: string;
  file: string | null;
  editorType: PluginContext["editorType"] | null;
  page: PluginContext["page"] | null;
  selectionCount: number | null;
}

interface PendingCommand {
  connectionId: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

// ## State

const connections = new Map<string, PluginConnection>();
const pending = new Map<string, PendingCommand>();
let nextConnectionId = 1;
// Ids must not repeat across bridge restarts: an agent pinned to an id from the
// previous bridge must be refused, not matched to whichever file reconnected
// first under the same number.
const BRIDGE_RUN = randomUUID().slice(0, 4);

// ## Connections

function openConnections(): PluginConnection[] {
  return [...connections.values()].filter(
    (conn) => conn.ws.readyState === WebSocket.OPEN,
  );
}

function describe(conn: PluginConnection): FileInfo {
  return {
    id: conn.id,
    file: conn.file,
    editorType: conn.context?.editorType ?? null,
    page: conn.context?.page ?? null,
    selectionCount: conn.context?.selectionCount ?? null,
  };
}

function label(conn: PluginConnection): string {
  const name = conn.file === null ? "unidentified file" : `"${conn.file}"`;
  return `${name} (${conn.id})`;
}

function resolveTarget(target: string | undefined): PluginConnection {
  const open = openConnections();
  if (open.length === 0) {
    throw new Error(
      "Figma plugin is not connected. Make sure the plugin is open in Figma.",
    );
  }
  const connected = open.map(label).join(", ");

  if (!target) {
    if (open.length === 1) return open[0];
    throw new Error(
      `${open.length} Figma files are connected: ${connected}. Pick one with labor_use_file.`,
    );
  }

  const byId = open.find((conn) => conn.id === target);
  if (byId) return byId;

  const byName = open.filter((conn) => conn.file === target);
  if (byName.length === 1) return byName[0];
  if (byName.length > 1) {
    throw new Error(
      `Several connected files are named "${target}": ${byName.map((conn) => conn.id).join(", ")}. Target one by id.`,
    );
  }
  throw new Error(
    `No connected Figma file matches "${target}". Connected: ${connected}.`,
  );
}

// ## Plugin communication

function sendToPlugin(
  conn: PluginConnection,
  command: Command,
  timeoutMs?: number,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (conn.ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`Figma file ${label(conn)} disconnected.`));
      return;
    }

    const effectiveTimeout = timeoutMs ?? COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      pending.delete(command.id);
      reject(
        new Error(
          `Command "${command.command}" timed out after ${effectiveTimeout}ms`,
        ),
      );
    }, effectiveTimeout);

    pending.set(command.id, {
      connectionId: conn.id,
      resolve,
      reject,
      timer,
    });
    conn.ws.send(JSON.stringify(command));
  });
}

async function identify(conn: PluginConnection): Promise<void> {
  conn.identifying = true;
  try {
    const result = await sendToPlugin(
      conn,
      {
        id: randomUUID(),
        command: "run_script",
        params: { code: IDENTIFY_SCRIPT },
      },
      IDENTIFY_TIMEOUT_MS,
    );
    if (!result || typeof result !== "object") {
      throw new Error(`unexpected identify result: ${JSON.stringify(result)}`);
    }
    const file = "file" in result ? result.file : undefined;
    const instance = "instance" in result ? result.instance : undefined;
    conn.file = typeof file === "string" ? file : null;
    conn.instance = typeof instance === "string" ? instance : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[bridge] Could not identify ${conn.id}: ${message}`);
    return;
  } finally {
    conn.identifying = false;
  }

  console.log(`[bridge] ${conn.id} is ${label(conn)}`);
  if (!conn.instance) return;

  // Same plugin instance on a newer socket: forget the older one. Don't
  // terminate it; terminating triggers onclose in the plugin UI, which causes a
  // reconnect loop. It closes on its own.
  for (const other of connections.values()) {
    if (other.id !== conn.id && other.instance === conn.instance) {
      connections.delete(other.id);
      console.log(`[bridge] ${other.id} replaced by ${conn.id}`);
    }
  }
}

// ## HTTP helpers

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(json),
  });
  res.end(json);
}

interface CommandRequest {
  command?: string;
  params: Record<string, unknown>;
  timeout?: number;
  target?: string;
}

function parseCommandRequest(body: unknown): CommandRequest {
  const fields: Record<string, unknown> =
    body && typeof body === "object" ? { ...body } : {};
  const params =
    fields.params && typeof fields.params === "object"
      ? (fields.params as Record<string, unknown>)
      : {};
  return {
    command: typeof fields.command === "string" ? fields.command : undefined,
    params,
    timeout: typeof fields.timeout === "number" ? fields.timeout : undefined,
    target:
      typeof fields.target === "string" && fields.target !== ""
        ? fields.target
        : undefined,
  };
}

// ## HTTP server

const httpServer = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === "GET" && req.url === "/status") {
    const open = openConnections();
    sendJson(res, 200, {
      bridge: "running",
      plugin: open.length > 0 ? "connected" : "disconnected",
      // Only unambiguous with a single file; use `files` otherwise.
      context: open.length === 1 ? open[0].context : null,
      files: open.map(describe),
      pending: pending.size,
    });
    return;
  }

  // The bridge outlives the sessions that start it, so stopping it is an
  // explicit request. Reply first: shutdown() drops open connections.
  if (req.method === "POST" && req.url === "/shutdown") {
    sendJson(res, 200, { ok: true });
    res.on("finish", shutdown);
    return;
  }

  if (req.method === "POST" && (req.url === "/command" || req.url === "/undo")) {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const { command, params, timeout, target } = parseCommandRequest(body);
    const effectiveCommand = req.url === "/undo" ? "undo" : command;
    if (!effectiveCommand) {
      sendJson(res, 400, { error: "Missing required field: command" });
      return;
    }

    let conn: PluginConnection;
    try {
      conn = resolveTarget(target);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 409, { error: message });
      return;
    }

    try {
      const result = await sendToPlugin(
        conn,
        { id: randomUUID(), command: effectiveCommand, params },
        timeout,
      );
      sendJson(res, 200, {
        result: (req.url === "/undo" ? "undo applied" : result) ?? null,
        file: describe(conn),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 503, { error: message });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

// ## WebSocket server

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws) => {
  const conn: PluginConnection = {
    id: `c${nextConnectionId++}-${BRIDGE_RUN}`,
    ws,
    context: null,
    file: null,
    instance: null,
    identifying: false,
  };
  connections.set(conn.id, conn);
  console.log(`[bridge] Figma plugin connected (${conn.id})`);

  ws.on("message", (data) => {
    let msg: PluginMessage;
    try {
      msg = JSON.parse(data.toString()) as PluginMessage;
    } catch {
      console.error("[bridge] Invalid message from plugin:", data.toString());
      return;
    }

    if (msg.type === "ping") return;
    if (msg.type === "hello" && msg.context) {
      conn.context = msg.context;
      if (conn.file === null && !conn.identifying) void identify(conn);
      return;
    }
    if (!msg.id) {
      console.warn("[bridge] Received message without an id");
      return;
    }

    const p = pending.get(msg.id);
    if (!p) {
      console.warn(
        "[bridge] Received response for unknown command id:",
        msg.id,
      );
      return;
    }

    clearTimeout(p.timer);
    pending.delete(msg.id);

    if (msg.error) {
      p.reject(new Error(msg.error));
    } else {
      p.resolve(msg.result);
    }
  });

  ws.on("close", () => {
    console.log(`[bridge] Figma plugin disconnected: ${label(conn)}`);
    if (connections.get(conn.id) === conn) connections.delete(conn.id);

    for (const [id, p] of pending) {
      if (p.connectionId !== conn.id) continue;
      clearTimeout(p.timer);
      p.reject(new Error(`Figma file ${label(conn)} disconnected`));
      pending.delete(id);
    }
  });

  ws.on("error", (err) => {
    console.error(`[bridge] Plugin WebSocket error (${conn.id}):`, err.message);
  });
});

// ## Start
// To rebuild the bundled server for the extension: cd bridge-src && npm run build

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] Running on http://127.0.0.1:${PORT}`);
  console.log(`[bridge] Waiting for Figma plugin to connect...`);
});

httpServer.on("error", (err) => {
  console.error("[bridge] Server error:", err.message);
  process.exit(1);
});

// httpServer.close() alone never finishes while plugin sockets are open, which
// left a stopped bridge holding every plugin connection. Drop the sockets so
// each plugin reconnects to the next bridge, then exit.
function shutdown() {
  console.log("[bridge] Shutting down...");
  for (const ws of wss.clients) ws.terminate();
  httpServer.closeAllConnections();
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
