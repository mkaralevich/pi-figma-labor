/**
 * figma-labor bridge server
 *
 * Relays commands between the pi extension (HTTP) and the Figma plugin (WebSocket).
 *
 * Endpoints:
 *   POST /command    — send a command, waits for plugin response (sync)
 *   POST /undo       — send an undo command to the plugin
 *   GET  /status     — check bridge + plugin connection status
 *
 * Protocol:
 *   pi sends:        { id, command, params }
 *   plugin receives: { id, command, params }
 *   plugin sends:    { id, result } | { id, error }
 *   pi receives:     { result } | { error }
 */

import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";

const PORT = 3846;
const COMMAND_TIMEOUT_MS = 30_000;

// ## Types

interface Command {
  id: string;
  command: string;
  params: Record<string, unknown>;
}

interface PluginResponse {
  id: string;
  result?: unknown;
  error?: string;
}

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

// ## State

let pluginSocket: WebSocket | null = null;
const pending = new Map<string, PendingCommand>();

// ## Plugin communication

function sendToPlugin(command: Command, timeoutMs?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!pluginSocket || pluginSocket.readyState !== WebSocket.OPEN) {
      reject(new Error("Figma plugin is not connected. Make sure the plugin is open in Figma."));
      return;
    }

    const effectiveTimeout = timeoutMs ?? COMMAND_TIMEOUT_MS;
    const timer = setTimeout(() => {
      pending.delete(command.id);
      reject(new Error(`Command "${command.command}" timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);

    pending.set(command.id, { resolve, reject, timer });
    pluginSocket.send(JSON.stringify(command));
  });
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
    sendJson(res, 200, {
      bridge: "running",
      plugin: pluginSocket?.readyState === WebSocket.OPEN ? "connected" : "disconnected",
      pending: pending.size,
    });
    return;
  }

  if (req.method === "POST" && req.url === "/command") {
    let body: unknown;
    try {
      body = await readBody(req);
    } catch {
      sendJson(res, 400, { error: "Invalid JSON body" });
      return;
    }

    const { command, params = {}, timeout } = body as { command?: string; params?: Record<string, unknown>; timeout?: number };
    if (!command) {
      sendJson(res, 400, { error: "Missing required field: command" });
      return;
    }

    const id = randomUUID();
    try {
      const result = await sendToPlugin({ id, command, params }, timeout);
      sendJson(res, 200, { result });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendJson(res, 503, { error: message });
    }
    return;
  }

  if (req.method === "POST" && req.url === "/undo") {
    const id = randomUUID();
    try {
      await sendToPlugin({ id, command: "undo", params: {} });
      sendJson(res, 200, { result: "undo applied" });
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
  if (pluginSocket && pluginSocket.readyState === WebSocket.OPEN) {
    console.log("[bridge] New plugin connected, replacing previous connection");
    // Don't terminate — let the old socket die naturally.
    // Terminating triggers onclose in the plugin UI which causes a reconnect loop.
  }

  pluginSocket = ws;
  console.log("[bridge] Figma plugin connected");

  ws.on("message", (data) => {
    let msg: PluginResponse & { type?: string };
    try {
      msg = JSON.parse(data.toString()) as PluginResponse & { type?: string };
    } catch {
      console.error("[bridge] Invalid message from plugin:", data.toString());
      return;
    }

    if (msg.type === "ping") return;

    const p = pending.get(msg.id);
    if (!p) {
      console.warn("[bridge] Received response for unknown command id:", msg.id);
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
    console.log("[bridge] Figma plugin disconnected");
    if (pluginSocket === ws) pluginSocket = null;

    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new Error("Figma plugin disconnected"));
      pending.delete(id);
    }
  });

  ws.on("error", (err) => {
    console.error("[bridge] Plugin WebSocket error:", err.message);
  });
});

// ## Start
// To rebuild the bundled server for the extension: cd figma-bridge && npm run build

httpServer.listen(PORT, "127.0.0.1", () => {
  console.log(`[bridge] Running on http://127.0.0.1:${PORT}`);
  console.log(`[bridge] Waiting for Figma plugin to connect...`);
});

httpServer.on("error", (err) => {
  console.error("[bridge] Server error:", err.message);
  process.exit(1);
});

process.on("SIGTERM", () => {
  console.log("[bridge] Shutting down...");
  httpServer.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  httpServer.close(() => process.exit(0));
});
