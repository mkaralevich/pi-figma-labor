/**
 * figma-labor extension for pi
 *
 * Registers write (and read) tools that talk to the figma-labor bridge server,
 * which relays commands to the Figma plugin via WebSocket → Plugin API.
 *
 * Requires:
 *   1. Bridge server running at http://127.0.0.1:3846  (starts with pi; /figma-labor-start)
 *   2. figma-labor plugin open inside Figma desktop app
 *
 * Tools registered:
 *   labor_get_selection       Get currently selected nodes
 *   labor_get_node            Get a node by ID
 *   labor_get_node_full       Get a node with all layout/constraint properties
 *   labor_get_children        List children of a node
 *   labor_get_component_props Get component property definitions
 *   labor_get_component_set_summary Get a component set summary
 *   labor_reorder_variant_options Reorder variant property options in a component set
 *   labor_create_component_set Combine components into a component set
 *   labor_update_properties   Update position, size, name, opacity, etc.
 *   labor_resize_node         Resize a node
 *   labor_scale_node          Scale a node proportionally like Figma Scale tool
 *   labor_clone_node          Clone a node
 *   labor_update_fills        Change fill colors
 *   labor_update_text         Change text content and font size
 *   labor_set_layout          Set auto-layout alignment, sizing, padding, spacing
 *   labor_create_node         Create a new primitive node
 *   labor_create_instance     Create an instance of a component
 *   labor_delete_node         Delete a node
 *   labor_move_node           Move a node to a different parent
 *   labor_select_node         Select a node and zoom to it
 *   labor_zoom_to_node        Zoom the viewport to a node without selecting it
 *   labor_detach_instance     Detach an instance, converting it to a plain frame
 *   labor_run_script          Run arbitrary JS in the Figma plugin context
 *   labor_undo                Undo the last operation
 *   labor_list_files          List connected Figma files and this agent's target
 *   labor_use_file            Point this agent's tools at one connected file
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const __dirname = dirname(realpathSync(fileURLToPath(import.meta.url)));
const PROMPT_PATH = join(__dirname, "prompt.md");
const PROMPT_TEMPLATE = readFileSync(PROMPT_PATH, "utf8");
const DISCONNECTED_PROMPT = `## Figma labor

- figma-labor plugin: not connected. Labor tools fail until the user opens the plugin in Figma (Plugins → Development → figma-labor).
- If the task involves Figma, call \`labor_list_files\` to recheck the connection before asking the user for screenshots or exports.
- Once connected, read ${PROMPT_PATH} for Labor rules before the first canvas read or write. It is injected automatically from the next prompt on.`;

// LABOR_BRIDGE_PORT is for tests against a throwaway bridge; the plugin itself
// connects to 3846.
const BRIDGE_URL = `http://127.0.0.1:${process.env.LABOR_BRIDGE_PORT ?? "3846"}`;
const BRIDGE_BIN = join(__dirname, "bridge.js");
const MCP_URL = `http://127.0.0.1:${process.env.FIGMA_MCP_PORT ?? "3845"}/mcp`;
const MAX_OUTPUT_BYTES = 50 * 1024;

// ## MCP STATE

let mcpSessionId: string | undefined;
let mcpRequestId = 1;
let mcpConnected = false;
let mcpAvailableTools: Array<{ name: string; description: string }> = [];

// ## STATES

type EditorType = "figma" | "figjam" | "slides" | "dev" | "buzz";

interface PluginContext {
  editorType: EditorType;
  page: { id: string; name: string };
  selectionCount: number;
  focusedSlide?: { id: string; name: string } | null;
  slidesMode?: "grid" | "single-slide";
}

/** One Figma file with the plugin open, as reported by the bridge. */
interface BridgeFile {
  id: string;
  file: string | null;
  editorType: EditorType | null;
  page: { id: string; name: string } | null;
  selectionCount: number | null;
}

interface BridgeStatus {
  bridge: string;
  plugin: string;
  /** Only set when exactly one file is connected. */
  context: PluginContext | null;
  /** Missing on bridges that predate multi-file support. */
  files?: BridgeFile[];
}

let cachedStatus: BridgeStatus | null = null;

function footerSymbols(fileCount: number, mcpReady: boolean): string {
  const plugin =
    fileCount === 0 ? "◌" : fileCount === 1 ? "P" : `P${fileCount}`;
  const mcp = mcpReady ? "M" : "◌";
  return `${plugin} ${mcp}`;
}

function connectedFileCount(status: BridgeStatus): number {
  if (status.plugin !== "connected") return 0;
  return status.files?.length || 1;
}

function isStaleSessionContextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("stale after session replacement or reload")
  );
}

function updateFooterStatus(
  ctx: {
    ui: {
      setStatus: (key: string, value: string | undefined) => void;
    };
  },
  status: BridgeStatus | null = cachedStatus,
): boolean {
  try {
    if (status?.bridge !== "running") {
      ctx.ui.setStatus("labor", undefined);
      return true;
    }
    ctx.ui.setStatus(
      "labor",
      `labor ${footerSymbols(connectedFileCount(status), mcpConnected)}`,
    );
    return true;
  } catch (error) {
    if (isStaleSessionContextError(error)) return false;
    throw error;
  }
}

// ## BRIDGE HTTP

async function bridgeStatus(timeout = 2000): Promise<BridgeStatus | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`, {
      signal: AbortSignal.timeout(timeout),
    });
    return (await res.json()) as BridgeStatus;
  } catch {
    return null;
  }
}

function fileLabel(file: BridgeFile): string {
  const name = file.file === null ? "unidentified file" : `"${file.file}"`;
  return `${name} (${file.id})`;
}

function pluginStatusLabel(status: BridgeStatus | null): string {
  if (!status) return "disconnected";
  const files = status.files ?? [];
  if (files.length > 1) {
    return `${status.plugin} (${files.length} files: ${files.map(fileLabel).join(", ")})`;
  }
  const editor = status.context?.editorType;
  return editor ? `${status.plugin} (${editor})` : status.plugin;
}

// ## BRIDGE COMMAND HELPERS

interface BridgeCommandResult {
  result: unknown;
  /** The file that ran the command. */
  file: BridgeFile | null;
}

// Send a command to the bridge server. `target` is a file name or connection
// id; null lets the bridge use the only connected file.
async function bridgeCommand(
  command: string,
  params: Record<string, unknown>,
  opts?: { timeout?: number; signal?: AbortSignal; target?: string | null },
): Promise<BridgeCommandResult> {
  const timeoutMs = opts?.timeout ?? 35_000;
  const httpTimeoutSignal = AbortSignal.timeout(timeoutMs + 5_000); // HTTP timeout > bridge timeout
  const signal = opts?.signal
    ? AbortSignal.any([opts.signal, httpTimeoutSignal])
    : httpTimeoutSignal;
  const res = await fetch(`${BRIDGE_URL}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      command,
      params,
      timeout: opts?.timeout,
      target: opts?.target ?? undefined,
    }),
    signal,
  });
  const json = (await res.json()) as {
    result?: unknown;
    error?: string;
    file?: BridgeFile;
  };
  if (json.error) throw new Error(json.error);
  return { result: json.result, file: json.file ?? null };
}

// Send an undo command to the bridge server
async function bridgeUndo(target: string | null): Promise<void> {
  const res = await fetch(`${BRIDGE_URL}/undo`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ target: target ?? undefined }),
    signal: AbortSignal.timeout(5000),
  });
  const json = (await res.json()) as { error?: string };
  if (json.error) throw new Error(json.error);
}

// Start the bridge server. It runs detached and outlives this session:
// sessions come and go (subagents, /reload, closed windows) while the Figma
// plugin stays connected to the one bridge. The port is the lock: if two
// sessions race to start one, the loser fails to bind and exits.
async function startBridge(signal?: AbortSignal): Promise<boolean> {
  // Already running?
  const status = await bridgeStatus();
  if (status) return true;
  if (signal?.aborted) return false;

  const proc = spawn("node", [BRIDGE_BIN], {
    detached: true,
    stdio: "ignore",
  });

  let spawnFailed = false;
  proc.on("error", (err) => {
    console.error("[figma-labor] Bridge process error:", err.message);
    spawnFailed = true;
  });
  proc.unref();

  // Wait up to 3s for it to start to avoid blocking the main thread. An
  // aborted wait leaves the bridge running; another session may be using it.
  for (let i = 0; i < 15; i++) {
    if (signal?.aborted) return false;
    if (spawnFailed) return false;
    await delay(200);
    const s = await bridgeStatus(300);
    if (s) return true;
  }

  return false;
}

// Ask the running bridge to exit (/figma-labor-stop). False when it did not
// stop, e.g. a bridge older than the /shutdown endpoint.
async function stopBridge(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/shutdown`, {
      method: "POST",
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return false;
  } catch {
    return false;
  }
  for (let i = 0; i < 10; i++) {
    if (!(await bridgeStatus(300))) return true;
    await delay(200);
  }
  return false;
}

// Plugins reconnect to a restarted bridge within a few seconds.
const PLUGIN_RECONNECT_WAIT_MS = 10_000;

function hasTargetFile(status: BridgeStatus, target: string | null): boolean {
  if (status.plugin !== "connected") return false;
  if (target === null) return true;
  return (status.files ?? []).some(
    (file) => file.file === target || file.id === target,
  );
}

// After restarting the bridge, wait for the target file's plugin to reconnect.
async function waitForPlugin(
  target: string | null,
  signal?: AbortSignal,
): Promise<BridgeStatus | null> {
  const deadline = Date.now() + PLUGIN_RECONNECT_WAIT_MS;
  let status = await bridgeStatus();
  while (
    status &&
    !hasTargetFile(status, target) &&
    Date.now() < deadline &&
    !signal?.aborted
  ) {
    await delay(500);
    status = await bridgeStatus();
  }
  return status;
}

// The bridge outlives sessions, but it can still be gone (stopped with
// /figma-labor-stop, killed, or never started). Every tool restarts it and
// gives the plugins time to reconnect, so no session is left without one.
async function ensureBridge(
  target: string | null,
  signal?: AbortSignal,
): Promise<BridgeStatus | null> {
  const status = await bridgeStatus();
  if (status) return status;
  if (!(await startBridge(signal))) return null;
  return waitForPlugin(target, signal);
}

// ## TOOL HELPERS

function formatToolOutput(output: unknown): string {
  return JSON.stringify(output, null, 2) ?? "No result returned by Figma.";
}

interface BridgeToolOptions {
  timeout?: number;
  signal?: AbortSignal;
  includeContext?: boolean;
  /** File name or connection id; null lets the bridge use the only connected file. */
  target?: string | null;
  /** Called with the file that ran the command. */
  onFile?: (file: BridgeFile) => void;
}

async function runBridgeTool(
  command: string,
  params: Record<string, unknown>,
  opts?: BridgeToolOptions,
) {
  const status = await ensureBridge(opts?.target ?? null, opts?.signal);

  // Handle connection errors
  if (!status) {
    return {
      content: [
        {
          type: "text" as const,
          text: "figma-labor bridge is not running and could not be started. Run /figma-labor-start.",
        },
      ],
      isError: true,
    };
  }

  if (status.plugin !== "connected") {
    return {
      content: [
        {
          type: "text" as const,
          text: "Figma plugin is not connected. Open the figma-labor plugin in Figma (Menu → Plugins → Development → figma-labor).",
        },
      ],
      isError: true,
    };
  }

  cachedStatus = status;

  // Execute command
  try {
    const { result, file } = await bridgeCommand(command, params, opts);
    if (file) opts?.onFile?.(file);
    const errorMessage =
      typeof result === "string" && result.startsWith("figma-labor error:")
        ? result
        : result &&
            typeof result === "object" &&
            "error" in result &&
            typeof result.error === "string"
          ? `figma-labor error: ${result.error}`
          : null;
    if (errorMessage) {
      return {
        content: [{ type: "text" as const, text: errorMessage }],
        isError: true,
      };
    }
    const output = opts?.includeContext
      ? {
          file: file?.file ?? null,
          editorType: file?.editorType ?? status.context?.editorType ?? null,
          page: file?.page ?? status.context?.page ?? null,
          selection: result,
        }
      : result;
    return {
      content: [{ type: "text" as const, text: formatToolOutput(output) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `figma-labor error: ${msg}` }],
      isError: true,
    };
  }
}

// ## MCP HELPERS

async function mcpPost(
  method: string,
  params?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const id = mcpRequestId++;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (mcpSessionId) headers["mcp-session-id"] = mcpSessionId;

  const response = await fetch(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal,
  });

  const newSessionId = response.headers.get("mcp-session-id");
  if (newSessionId) mcpSessionId = newSessionId;

  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${response.statusText}`);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const text = await response.text();
  let json: { result?: unknown; error?: { message: string } };

  if (contentType.includes("text/event-stream")) {
    const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
    if (!dataLine) throw new Error("No data in SSE response");
    json = JSON.parse(dataLine.slice(6));
  } else {
    json = JSON.parse(text);
  }

  if (json.error) throw new Error(json.error.message);
  return json.result;
}

async function initializeMcpSession(signal?: AbortSignal): Promise<boolean> {
  try {
    mcpSessionId = undefined;
    await mcpPost(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "pi-figma-labor", version: "2.0" },
      },
      signal,
    );
    return true;
  } catch {
    return false;
  }
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<
      string,
      {
        type: string;
        description?: string;
        enum?: string[];
        items?: unknown;
        default?: unknown;
      }
    >;
    required?: string[];
  };
}

interface McpContent {
  type: "text" | "image" | "resource";
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
}

interface McpToolResult {
  content: McpContent[];
  isError?: boolean;
}

async function listMcpTools(signal?: AbortSignal): Promise<McpTool[]> {
  const result = (await mcpPost("tools/list", undefined, signal)) as {
    tools: McpTool[];
  };
  return result.tools ?? [];
}

async function callMcpTool(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  return (await mcpPost(
    "tools/call",
    { name, arguments: args },
    signal,
  )) as McpToolResult;
}

function truncateMcpText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
  return (
    Buffer.from(text, "utf8").slice(0, MAX_OUTPUT_BYTES).toString("utf8") +
    "\n\n[Output truncated — use a more specific nodeId or break the design into smaller sections.]"
  );
}

function convertMcpContent(
  mcpContent: McpContent[],
): Array<
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string }
> {
  const out: ReturnType<typeof convertMcpContent> = [];
  for (const content of mcpContent) {
    if (content.type === "text" && content.text) {
      out.push({ type: "text", text: truncateMcpText(content.text) });
    } else if (content.type === "image" && content.data && content.mimeType) {
      out.push({
        type: "image",
        mimeType: content.mimeType,
        data: content.data,
      });
    } else if (content.type === "resource" && content.uri) {
      out.push({ type: "text", text: `[Resource: ${content.uri}]` });
    }
  }
  return out;
}

function buildMcpSchema(inputSchema: McpTool["inputSchema"]): TSchema {
  const props = inputSchema.properties ?? {};
  const required = new Set(inputSchema.required ?? []);
  const fields: Record<string, TSchema> = {};

  for (const [key, prop] of Object.entries(props)) {
    let schema: TSchema;

    if (prop.enum) {
      schema = Type.Union(prop.enum.map((value) => Type.Literal(value)));
    } else if (prop.type === "boolean") {
      schema = Type.Boolean();
    } else if (prop.type === "number" || prop.type === "integer") {
      schema = Type.Number();
    } else if (prop.type === "array") {
      schema = Type.Array(Type.Any());
    } else {
      schema = Type.String();
    }

    const description = prop.description ?? "";
    const withDescription = description ? { ...schema, description } : schema;
    fields[key] = required.has(key)
      ? withDescription
      : Type.Optional(withDescription);
  }

  return Type.Object(fields);
}

function formatMcpLabel(name: string): string {
  return name
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function normalizeMcpNodeId(value: string): string {
  const squashed = value.replace(/\s+/g, "").trim();
  if (!squashed) return squashed;

  try {
    const url = new URL(squashed);
    const fromQuery =
      url.searchParams.get("node-id") ?? url.searchParams.get("nodeId");
    if (fromQuery) return normalizeMcpNodeId(fromQuery);
  } catch {}

  const queryMatch = squashed.match(/[?&]node-id=([0-9]+(?:[:-][0-9]+)?)/i);
  if (queryMatch?.[1]) return normalizeMcpNodeId(queryMatch[1]);

  const plainMatch = squashed.match(/\b([0-9]+[:-][0-9]+)\b/);
  if (!plainMatch) return squashed;

  return plainMatch[1].replace(/-/g, ":");
}

const MCP_EDITOR_ROUTES: Partial<
  Record<
    string,
    {
      editors: readonly EditorType[];
      fallback: string;
    }
  >
> = {
  get_design_context: {
    editors: ["figma", "dev"],
    fallback: "Use get_figjam in FigJam or Labor reads in Slides.",
  },
  get_metadata: {
    editors: ["figma", "dev"],
    fallback: "Use Labor reads outside Figma Design.",
  },
  get_variable_defs: {
    editors: ["figma", "dev"],
    fallback: "Variables are only supported in Figma Design.",
  },
  get_figjam: {
    editors: ["figjam"],
    fallback: "Use get_design_context in Design or Labor reads in Slides.",
  },
};

function mcpEditorRoutingError(name: string): string | null {
  const route = MCP_EDITOR_ROUTES[name];
  const editor = cachedStatus?.context?.editorType;
  if (!route || !editor || route.editors.includes(editor)) return null;
  return `${name} does not support the current ${editor} editor. ${route.fallback}`;
}

function normalizeMcpArgs(
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...args };
  if (
    typeof next.nodeId === "string" &&
    [
      "get_design_context",
      "get_screenshot",
      "get_metadata",
      "get_variable_defs",
      "get_code_connect_map",
      "add_code_connect_map",
      "get_code_connect_suggestions",
      "send_code_connect_mappings",
      "get_figjam",
    ].includes(name)
  ) {
    next.nodeId = normalizeMcpNodeId(next.nodeId);
  }
  return next;
}

async function callMcpToolWithRetry(
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<McpToolResult> {
  try {
    return await callMcpTool(name, args, signal);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    const shouldRetry =
      lower.includes("aborted") ||
      message.includes("404") ||
      lower.includes("session");
    if (!shouldRetry) throw error;

    mcpSessionId = undefined;
    const ok = await initializeMcpSession(signal);
    if (!ok) throw error;
    return await callMcpTool(name, args, signal);
  }
}

function registerFigmaMcp(pi: ExtensionAPI) {
  const registeredToolNames = new Set<string>();
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let pollingActive = false;
  let refreshInFlight = false;

  function registerMcpTools(tools: McpTool[]) {
    mcpAvailableTools = tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    }));

    for (const tool of tools) {
      if (registeredToolNames.has(tool.name)) continue;
      registeredToolNames.add(tool.name);
      pi.registerTool({
        name: tool.name,
        label: formatMcpLabel(tool.name),
        description: tool.description,
        parameters: buildMcpSchema(tool.inputSchema),
        async execute(_id, params, signal, _onUpdate, ctx) {
          const routingError = mcpEditorRoutingError(tool.name);
          if (routingError) {
            return {
              content: [{ type: "text", text: routingError }],
              isError: true,
            };
          }

          if (!mcpSessionId) {
            const ok = await initializeMcpSession(signal);
            if (!ok) {
              markMcpDisconnected(ctx);
              return {
                content: [
                  {
                    type: "text",
                    text: "Figma MCP server is not reachable. Make sure the Figma desktop app is open and the MCP server is enabled.",
                  },
                ],
                isError: true,
              };
            }
          }

          try {
            const normalizedParams = normalizeMcpArgs(
              tool.name,
              params as Record<string, unknown>,
            );
            const result = await callMcpToolWithRetry(
              tool.name,
              normalizedParams,
              signal,
            );
            return {
              content: convertMcpContent(result.content),
              isError: result.isError ?? false,
            };
          } catch (error: unknown) {
            const message =
              error instanceof Error ? error.message : String(error);
            if (isMcpConnectionError(message)) markMcpDisconnected(ctx);
            return {
              content: [{ type: "text", text: `Figma MCP error: ${message}` }],
              isError: true,
            };
          }
        },
      });
    }
  }

  function scheduleMcpPoll(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
    if (!pollingActive) return;
    if (pollTimer) clearTimeout(pollTimer);
    const delay = mcpConnected ? 30_000 : 5_000;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      await refreshMcpStatus(ctx);
      scheduleMcpPoll(ctx);
    }, delay);
  }

  function markMcpDisconnected(
    ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
  ) {
    mcpConnected = false;
    mcpSessionId = undefined;
    updateFooterStatus(ctx);
    scheduleMcpPoll(ctx);
  }

  function isMcpConnectionError(message: string): boolean {
    const lower = message.toLowerCase();
    return (
      lower.includes("fetch failed") ||
      lower.includes("econnrefused") ||
      lower.includes("aborted") ||
      lower.includes("404") ||
      lower.includes("session")
    );
  }

  async function refreshMcpStatus(
    ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
  ) {
    if (refreshInFlight) return;
    refreshInFlight = true;
    const signal = AbortSignal.timeout(3000);
    try {
      if (!mcpSessionId) {
        const ok = await initializeMcpSession(signal);
        if (!ok) throw new Error("MCP initialization failed");
      }

      let tools: McpTool[];
      try {
        tools = await listMcpTools(signal);
      } catch {
        mcpSessionId = undefined;
        const ok = await initializeMcpSession(signal);
        if (!ok) throw new Error("MCP reconnection failed");
        tools = await listMcpTools(signal);
      }

      mcpConnected = true;
      registerMcpTools(tools);
    } catch {
      mcpConnected = false;
      mcpSessionId = undefined;
    } finally {
      refreshInFlight = false;
      updateFooterStatus(ctx);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    pollingActive = true;
    void (async () => {
      await refreshMcpStatus(ctx);
      scheduleMcpPoll(ctx);
    })();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    pollingActive = false;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    updateFooterStatus(ctx, null);
  });

  pi.registerCommand("figma-mcp", {
    description: "Show Figma MCP server connection status and available tools",
    handler: async (_args, ctx) => {
      if (!mcpConnected) {
        ctx.ui.notify(
          "Figma MCP server is not connected.\n\nTo enable:\n1. Open Figma desktop app\n2. Open a Design file\n3. Switch to Dev Mode (Shift+D)\n4. In the Inspect panel → MCP server → Enable desktop MCP server",
          "error",
        );
        return;
      }
      ctx.ui.notify(
        `Figma MCP server connected ✓\nURL: ${MCP_URL}\n\nAvailable tools (${mcpAvailableTools.length}):\n${mcpAvailableTools.map((tool) => `  • ${tool.name}`).join("\n")}`,
        "success",
      );
    },
  });
}

// ## EXTENSION

export default function (pi: ExtensionAPI) {
  registerFigmaMcp(pi);

  // Lifecycle
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let bridgeSessionRun = 0;
  let bridgeStartupAbort: AbortController | null = null;

  // File this agent's Labor tools target: a file name, or a connection id when
  // the name is ambiguous. Each agent (subagents included) gets its own. The
  // first command that runs with a single connected file pins it, so a file
  // connecting later can't redirect this agent's writes.
  let targetFile: string | null = null;

  function runTool(
    command: string,
    params: Record<string, unknown>,
    opts?: Omit<BridgeToolOptions, "target" | "onFile">,
  ) {
    return runBridgeTool(command, params, {
      ...opts,
      target: targetFile,
      onFile: (file) => {
        targetFile ??= file.file ?? file.id;
      },
    });
  }

  function isCurrentBridgeSession(run: number, signal: AbortSignal): boolean {
    return run === bridgeSessionRun && !signal.aborted;
  }

  function startPolling(
    ctx: Parameters<Parameters<typeof pi.on>[1]>[1],
    run: number,
    signal: AbortSignal,
  ) {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!isCurrentBridgeSession(run, signal)) {
        stopPolling();
        return;
      }
      const s = await bridgeStatus();
      if (!isCurrentBridgeSession(run, signal)) {
        stopPolling();
        return;
      }
      cachedStatus = s;
      if (!updateFooterStatus(ctx)) stopPolling();
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  function currentBridgeSessionSignal(): AbortSignal {
    if (!bridgeStartupAbort || bridgeStartupAbort.signal.aborted) {
      bridgeStartupAbort = new AbortController();
    }
    return bridgeStartupAbort.signal;
  }

  pi.on("session_start", async (_event, ctx) => {
    targetFile = null;
    bridgeStartupAbort?.abort();
    const run = ++bridgeSessionRun;
    const controller = new AbortController();
    bridgeStartupAbort = controller;

    void (async () => {
      let s = await bridgeStatus();
      if (!isCurrentBridgeSession(run, controller.signal)) return;
      if (!s) {
        await startBridge(controller.signal);
        if (!isCurrentBridgeSession(run, controller.signal)) return;
        s = await bridgeStatus();
        if (!isCurrentBridgeSession(run, controller.signal)) return;
      }
      cachedStatus = s;
      if (!updateFooterStatus(ctx)) return;
      if (s) startPolling(ctx, run, controller.signal);
    })();
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    bridgeStartupAbort?.abort();
    bridgeStartupAbort = null;
    bridgeSessionRun++;
    stopPolling();
    // Leave the bridge and shared state alone: other sessions in this process
    // (subagents) and other pi windows use the same bridge and plugin.
    updateFooterStatus(ctx, null);
  });

  // System prompt injection. The full Labor guide is ~10 KB; inject it only
  // while the plugin is connected, and a pointer to it otherwise.
  pi.on("before_agent_start", async (event) => {
    // The first prompt of a session can arrive before session_start's async
    // status probe lands; ask the bridge directly instead of guessing.
    const status = cachedStatus ?? (await bridgeStatus(500));
    if (status?.plugin !== "connected") {
      return {
        systemPrompt: event.systemPrompt + "\n\n" + DISCONNECTED_PROMPT,
      };
    }
    const mcpAvailable = pi
      .getActiveTools()
      .some((toolName) =>
        [
          "get_screenshot",
          "get_design_context",
          "get_metadata",
          "get_variable_defs",
          "search_design_system",
        ].includes(toolName),
      );
    const prompt = PROMPT_TEMPLATE.replace(
      "{{plugin_status}}",
      pluginStatusLabel(status),
    )
      .replace(
        "{{target_file}}",
        targetFile === null ? "none yet" : `"${targetFile}"`,
      )
      .replace("{{mcp_status}}", mcpAvailable ? "available" : "unavailable");
    return {
      systemPrompt: event.systemPrompt + "\n\n" + prompt,
    };
  });

  // Slash commands

  pi.registerCommand("figma-labor-start", {
    description: "Start the figma-labor bridge server",
    handler: async (_args, ctx) => {
      const already = await bridgeStatus();
      if (already) {
        cachedStatus = already;
        updateFooterStatus(ctx);
        ctx.ui.notify(
          `figma-labor bridge is already running.\nPlugin: ${pluginStatusLabel(already)}`,
          "info",
        );
        startPolling(ctx, bridgeSessionRun, currentBridgeSessionSignal());
        return;
      }
      ctx.ui.notify("Starting figma-labor bridge...", "info");
      const ok = await startBridge(currentBridgeSessionSignal());
      if (!ok) {
        cachedStatus = null;
        updateFooterStatus(ctx);
        ctx.ui.notify(
          "Failed to start figma-labor bridge.\n\nMake sure bridge.js exists at:\n" +
            BRIDGE_BIN,
          "error",
        );
        return;
      }
      const status = await bridgeStatus();
      cachedStatus = status;
      updateFooterStatus(ctx);
      ctx.ui.notify(
        `figma-labor bridge started.\nPlugin: ${pluginStatusLabel(status)}`,
        "success",
      );
      startPolling(ctx, bridgeSessionRun, currentBridgeSessionSignal());
    },
  });

  pi.registerCommand("figma-labor-stop", {
    description: "Stop the figma-labor bridge server",
    handler: async (_args, ctx) => {
      stopPolling();
      if (!(await bridgeStatus())) {
        ctx.ui.notify("figma-labor bridge is not running.", "info");
        return;
      }
      if (!(await stopBridge())) {
        ctx.ui.notify(
          "Could not stop the figma-labor bridge. It may predate /figma-labor-stop; kill its `node …/bridge.js` process once.",
          "error",
        );
        return;
      }
      cachedStatus = null;
      updateFooterStatus(ctx);
      ctx.ui.notify(
        "figma-labor bridge stopped. Any Labor tool call (or /figma-labor-start) starts it again.",
        "info",
      );
    },
  });

  pi.registerCommand("figma-labor", {
    description: "Show Figma bridge server connection status",
    handler: async (_args, ctx) => {
      const status = await bridgeStatus();
      if (!status) {
        ctx.ui.notify(
          "figma-labor bridge is not running.\n\nRun /figma-labor-start to launch it.",
          "error",
        );
        return;
      }
      const files = status.files ?? [];
      const context = status.context;
      const details =
        files.length > 1
          ? `\nFiles:\n${files
              .map(
                (file) =>
                  `  • ${fileLabel(file)}, page "${file.page?.name ?? "?"}"${file.file === targetFile || file.id === targetFile ? " ← this session" : ""}`,
              )
              .join("\n")}`
          : context
            ? `\nEditor: ${context.editorType}\nPage: ${context.page.name}\nSelection: ${context.selectionCount}`
            : "";
      ctx.ui.notify(
        `figma-labor bridge: ${status.bridge}\nFigma plugin: ${status.plugin}${details}`,
        status.plugin === "connected" ? "success" : "info",
      );
    },
  });

  // Tools

  // ## Files

  pi.registerTool({
    name: "labor_list_files",
    label: "List Files",
    description:
      "List the Figma files that have the Labor plugin open, and which one this agent's Labor tools target.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const status = await ensureBridge(targetFile, signal);
      if (!status) {
        return {
          content: [
            {
              type: "text" as const,
              text: "figma-labor bridge is not running and could not be started. Run /figma-labor-start.",
            },
          ],
          isError: true,
        };
      }
      if (!status.files) {
        return {
          content: [
            {
              type: "text" as const,
              text: "The running figma-labor bridge predates multi-file support. Stop its bridge.js process so the extension can start the current one.",
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { target: targetFile, files: status.files },
              null,
              2,
            ),
          },
        ],
      };
    },
  });

  pi.registerTool({
    name: "labor_use_file",
    label: "Use File",
    description:
      "Point this agent's Labor tools at one connected Figma file, by file name or connection id from labor_list_files. Required when several files are connected.",
    parameters: Type.Object({
      file: Type.String({
        description: "Exact file name, or connection id from labor_list_files",
      }),
    }),
    async execute(_id, params, signal) {
      const files = (await ensureBridge(null, signal))?.files ?? [];
      const sameName = files.filter((file) => file.file === params.file);
      const match =
        files.find((file) => file.id === params.file) ??
        (sameName.length === 1 ? sameName[0] : undefined);
      if (!match) {
        const reason =
          sameName.length > 1
            ? `Several connected files are named "${params.file}"; use a connection id.`
            : `No connected Figma file matches "${params.file}".`;
        const connected = files.length
          ? files.map(fileLabel).join(", ")
          : "none";
        return {
          content: [
            { type: "text" as const, text: `${reason} Connected: ${connected}.` },
          ],
          isError: true,
        };
      }
      // Prefer the name: it survives plugin reconnects, which change the id.
      const nameIsUnique =
        match.file !== null &&
        files.filter((file) => file.file === match.file).length === 1;
      targetFile = nameIsUnique ? match.file : match.id;
      return {
        content: [
          {
            type: "text" as const,
            text: `Labor tools now target ${fileLabel(match)}: ${match.editorType ?? "unknown"} editor, page "${match.page?.name ?? "?"}".`,
          },
        ],
      };
    },
  });

  // ## Selection & navigation

  pi.registerTool({
    name: "labor_get_selection",
    label: "Get Selection",
    description:
      "Lightweight discovery: get the active editor, page, and currently selected nodes. Always call this first before editor-specific tools.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return runTool("get_selection", {}, { signal, includeContext: true });
    },
  });

  pi.registerTool({
    name: "labor_select_node",
    label: "Select Node",
    description: "Select a node in Figma and zoom the viewport to it.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID to select" }),
    }),
    async execute(_id, params, signal) {
      return runTool("select_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_zoom_to_node",
    label: "Zoom To Node",
    description: "Zoom the viewport to a node without changing selection.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID to zoom to" }),
    }),
    async execute(_id, params, signal) {
      return runTool("zoom_to_node", params, { signal });
    },
  });

  // ## Reading & inspection

  pi.registerTool({
    name: "labor_get_node",
    label: "Get Node",
    description: "Get a Figma node by ID, including its properties.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID, e.g. '123:456'" }),
    }),
    async execute(_id, params, signal) {
      return runTool("get_node", { nodeId: params.nodeId }, { signal });
    },
  });

  pi.registerTool({
    name: "labor_get_node_full",
    label: "Get Node Full",
    description:
      "Get a Figma node with ALL properties including auto-layout, constraints, padding, sizing modes, min/max sizes, clipsContent, and locked state. Use this instead of labor_get_node when you need to diagnose layout issues or read/set alignment.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID, e.g. '123:456'" }),
    }),
    async execute(_id, params, signal) {
      return runTool("get_node_full", { nodeId: params.nodeId }, { signal });
    },
  });

  pi.registerTool({
    name: "labor_get_children",
    label: "Get Children",
    description:
      "List children of a node. Omit nodeId to list children of the current page.",
    parameters: Type.Object({
      nodeId: Type.Optional(
        Type.String({ description: "Parent node ID. Omit for current page." }),
      ),
    }),
    async execute(_id, params, signal) {
      return runTool("get_children", { nodeId: params.nodeId }, { signal });
    },
  });

  pi.registerTool({
    name: "labor_run_script",
    label: "Run Script",
    description:
      "Run arbitrary JavaScript in the Figma plugin context. The script has full access to the `figma` Plugin API. Use `return` to return a value. Async is supported. Example: `return figma.currentPage.findAll(n => n.type === 'COMPONENT').length`",
    parameters: Type.Object({
      code: Type.String({
        description:
          "JS code to execute. Has access to `figma`. Use return to return a value.",
      }),
    }),
    async execute(_id, params, signal) {
      return runTool(
        "run_script",
        { code: params.code },
        { timeout: 60_000, signal },
      );
    },
  });

  // ## Components & variants

  pi.registerTool({
    name: "labor_get_component_props",
    label: "Get Component Props",
    description:
      "Get component property definitions for a COMPONENT_SET node, including variant options.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "COMPONENT_SET node ID" }),
    }),
    async execute(_id, params, signal) {
      return runTool(
        "get_component_properties",
        { nodeId: params.nodeId },
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "labor_get_component_set_summary",
    label: "Get Component Set Summary",
    description:
      "Get a COMPONENT_SET summary including layout, variant groups, component property definitions, and child variant names/sizes.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "COMPONENT_SET node ID" }),
    }),
    async execute(_id, params, signal) {
      return runTool(
        "get_component_set_summary",
        { nodeId: params.nodeId },
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "labor_reorder_variant_options",
    label: "Reorder Variant Options",
    description:
      "Reorder the options of a VARIANT property on a component or component set.",
    parameters: Type.Object({
      nodeId: Type.String({
        description: "COMPONENT or COMPONENT_SET node ID",
      }),
      property: Type.String({
        description: "Variant property name, e.g. 'size'",
      }),
      order: Type.Array(Type.String(), {
        description:
          "New variant option order, e.g. ['small', 'medium', 'large']",
      }),
    }),
    async execute(_id, params, signal) {
      return runTool("reorder_variant_options", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_create_component_set",
    label: "Create Component Set",
    description:
      "Combine existing COMPONENT nodes into a COMPONENT_SET. Optionally set the new set name, parent, and position.",
    parameters: Type.Object({
      componentIds: Type.Array(Type.String(), {
        description: "COMPONENT node IDs to combine as variants",
      }),
      name: Type.Optional(
        Type.String({ description: "New component set name" }),
      ),
      parentId: Type.Optional(
        Type.String({ description: "Parent node ID for the new set" }),
      ),
      x: Type.Optional(
        Type.Number({ description: "X position for the new set" }),
      ),
      y: Type.Optional(
        Type.Number({ description: "Y position for the new set" }),
      ),
    }),
    async execute(_id, params, signal) {
      return runTool(
        "create_component_set",
        params as Record<string, unknown>,
        { signal },
      );
    },
  });

  pi.registerTool({
    name: "labor_create_instance",
    label: "Create Instance",
    description:
      "Create an instance of a COMPONENT node and place it on the canvas or inside a parent. The componentId must point to a COMPONENT (not a COMPONENT_SET) — call labor_get_children on the set to find the specific variant you want. Optionally pass properties to set variant or text overrides.",
    parameters: Type.Object({
      componentId: Type.String({
        description:
          "ID of the COMPONENT node to instantiate (not COMPONENT_SET)",
      }),
      parentId: Type.Optional(
        Type.String({
          description:
            "Parent node ID to append the instance into. Omit to place on current page.",
        }),
      ),
      x: Type.Optional(Type.Number({ description: "X position" })),
      y: Type.Optional(Type.Number({ description: "Y position" })),
      name: Type.Optional(
        Type.String({ description: "Override the instance name" }),
      ),
      properties: Type.Optional(
        Type.Record(Type.String(), Type.Unknown(), {
          description:
            "Component property overrides, e.g. { 'size': 'medium', 'label': 'Click me' }",
        }),
      ),
    }),
    async execute(_id, params, signal) {
      return runTool("create_instance", params as Record<string, unknown>, {
        signal,
      });
    },
  });

  pi.registerTool({
    name: "labor_detach_instance",
    label: "Detach Instance",
    description:
      "Detach a component instance, converting it into a plain frame whose children can be freely repositioned. Call this when you need to reorder or reposition children that are locked inside an instance.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "INSTANCE node ID to detach" }),
    }),
    async execute(_id, params, signal) {
      return runTool("detach_instance", params, { signal });
    },
  });

  // ## Create & structure

  pi.registerTool({
    name: "labor_create_node",
    label: "Create Node",
    description:
      "Create a primitive or native product node. Supports standard nodes; FigJam stickies, shapes, connectors, code blocks, tables, and sections; and Slides slides and rows. In Slides, ordinary content defaults to the focused slide.",
    parameters: Type.Object({
      type: StringEnum([
        "RECTANGLE",
        "ELLIPSE",
        "FRAME",
        "TEXT",
        "STICKY",
        "SHAPE_WITH_TEXT",
        "CONNECTOR",
        "CODE_BLOCK",
        "TABLE",
        "SECTION",
        "SLIDE",
        "SLIDE_ROW",
      ] as const),
      parentId: Type.Optional(
        Type.String({
          description: "Parent node ID. Omit to add to current page.",
        }),
      ),
      name: Type.Optional(Type.String({ description: "Node name" })),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      width: Type.Optional(Type.Number()),
      height: Type.Optional(Type.Number()),
      text: Type.Optional(
        Type.String({ description: "Initial text for text-bearing nodes" }),
      ),
      shapeType: Type.Optional(
        Type.String({
          description: "FigJam SHAPE_WITH_TEXT shape type",
        }),
      ),
      connectorLineType: Type.Optional(
        StringEnum(["ELBOWED", "STRAIGHT", "CURVED"] as const),
      ),
      startNodeId: Type.Optional(
        Type.String({ description: "CONNECTOR start node ID" }),
      ),
      endNodeId: Type.Optional(
        Type.String({ description: "CONNECTOR end node ID" }),
      ),
      code: Type.Optional(Type.String({ description: "CODE_BLOCK contents" })),
      codeLanguage: Type.Optional(
        Type.String({
          description: "CODE_BLOCK language, such as TYPESCRIPT or PLAINTEXT",
        }),
      ),
      rows: Type.Optional(Type.Number({ description: "TABLE row count" })),
      columns: Type.Optional(
        Type.Number({ description: "TABLE column count" }),
      ),
      row: Type.Optional(
        Type.Number({ description: "SLIDE or SLIDE_ROW grid row" }),
      ),
      column: Type.Optional(Type.Number({ description: "SLIDE grid column" })),
    }),
    async execute(_id, params, signal) {
      return runTool("create_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_clone_node",
    label: "Clone Node",
    description:
      "Clone a node. Optionally rename it, move it to another parent, and position it.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID to clone" }),
      parentId: Type.Optional(
        Type.String({ description: "Target parent node ID" }),
      ),
      name: Type.Optional(
        Type.String({ description: "Override the cloned node name" }),
      ),
      x: Type.Optional(Type.Number({ description: "X position" })),
      y: Type.Optional(Type.Number({ description: "Y position" })),
    }),
    async execute(_id, params, signal) {
      return runTool("clone_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_move_node",
    label: "Move Node",
    description:
      "Move a node to a different parent, optionally at a specific index.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID to move" }),
      parentId: Type.String({ description: "Target parent node ID" }),
      index: Type.Optional(
        Type.Number({ description: "Insert at this child index (0 = first)" }),
      ),
    }),
    async execute(_id, params, signal) {
      return runTool("move_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_delete_node",
    label: "Delete Node",
    description:
      "Delete a node. This is destructive — call labor_undo immediately if it was a mistake.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID to delete" }),
    }),
    async execute(_id, params, signal) {
      return runTool("delete_node", params, { signal });
    },
  });

  // ## Layout, styling & text

  pi.registerTool({
    name: "labor_update_properties",
    label: "Update Properties",
    description:
      "Update generic node properties plus supported FigJam-native properties for stickies, sections, code blocks, and connectors.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID" }),
      name: Type.Optional(Type.String({ description: "New name" })),
      x: Type.Optional(Type.Number({ description: "X position" })),
      y: Type.Optional(Type.Number({ description: "Y position" })),
      width: Type.Optional(Type.Number({ description: "Width in px" })),
      height: Type.Optional(Type.Number({ description: "Height in px" })),
      opacity: Type.Optional(Type.Number({ description: "Opacity 0–1" })),
      visible: Type.Optional(Type.Boolean({ description: "Visibility" })),
      rotation: Type.Optional(
        Type.Number({ description: "Rotation in degrees" }),
      ),
      authorVisible: Type.Optional(
        Type.Boolean({ description: "STICKY author visibility" }),
      ),
      isWideWidth: Type.Optional(
        Type.Boolean({ description: "Whether a STICKY uses wide format" }),
      ),
      sectionContentsHidden: Type.Optional(
        Type.Boolean({ description: "Whether SECTION contents are hidden" }),
      ),
      codeLanguage: Type.Optional(
        StringEnum(
          [
            "TYPESCRIPT",
            "CPP",
            "RUBY",
            "CSS",
            "JAVASCRIPT",
            "HTML",
            "JSON",
            "GRAPHQL",
            "PYTHON",
            "GO",
            "SQL",
            "SWIFT",
            "KOTLIN",
            "RUST",
            "BASH",
            "PLAINTEXT",
            "DART",
          ] as const,
          { description: "CODE_BLOCK language" },
        ),
      ),
      connectorLineType: Type.Optional(
        StringEnum(["ELBOWED", "STRAIGHT", "CURVED"] as const, {
          description: "CONNECTOR line type",
        }),
      ),
      connectorStartNodeId: Type.Optional(
        Type.String({
          description: "Node ID for the CONNECTOR start endpoint",
        }),
      ),
      connectorEndNodeId: Type.Optional(
        Type.String({ description: "Node ID for the CONNECTOR end endpoint" }),
      ),
      connectorStartMagnet: Type.Optional(
        StringEnum([
          "NONE",
          "AUTO",
          "TOP",
          "LEFT",
          "BOTTOM",
          "RIGHT",
          "CENTER",
        ] as const),
      ),
      connectorEndMagnet: Type.Optional(
        StringEnum([
          "NONE",
          "AUTO",
          "TOP",
          "LEFT",
          "BOTTOM",
          "RIGHT",
          "CENTER",
        ] as const),
      ),
      connectorStartStrokeCap: Type.Optional(
        StringEnum([
          "NONE",
          "ARROW_EQUILATERAL",
          "ARROW_LINES",
          "TRIANGLE_FILLED",
          "DIAMOND_FILLED",
          "CIRCLE_FILLED",
          "ERD_ZERO_OR_ONE",
          "ERD_EXACTLY_ONE",
          "ERD_ZERO_OR_MORE",
          "ERD_ONE_OR_MORE",
          "ERD_ONE",
          "ERD_MANY",
        ] as const),
      ),
      connectorEndStrokeCap: Type.Optional(
        StringEnum([
          "NONE",
          "ARROW_EQUILATERAL",
          "ARROW_LINES",
          "TRIANGLE_FILLED",
          "DIAMOND_FILLED",
          "CIRCLE_FILLED",
          "ERD_ZERO_OR_ONE",
          "ERD_EXACTLY_ONE",
          "ERD_ZERO_OR_MORE",
          "ERD_ONE_OR_MORE",
          "ERD_ONE",
          "ERD_MANY",
        ] as const),
      ),
    }),
    async execute(_id, params, signal) {
      const { nodeId, ...properties } = params;
      return runTool("update_properties", { nodeId, properties }, { signal });
    },
  });

  pi.registerTool({
    name: "labor_update_table",
    label: "Update Table",
    description:
      "Insert, remove, move, or resize rows and columns on a FigJam TABLE node.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "TABLE node ID" }),
      action: StringEnum([
        "INSERT_ROW",
        "INSERT_COLUMN",
        "REMOVE_ROW",
        "REMOVE_COLUMN",
        "MOVE_ROW",
        "MOVE_COLUMN",
        "RESIZE_ROW",
        "RESIZE_COLUMN",
      ] as const),
      rowIndex: Type.Optional(Type.Integer({ minimum: 0 })),
      columnIndex: Type.Optional(Type.Integer({ minimum: 0 })),
      fromIndex: Type.Optional(Type.Integer({ minimum: 0 })),
      toIndex: Type.Optional(Type.Integer({ minimum: 0 })),
      width: Type.Optional(Type.Number({ minimum: 0.01 })),
      height: Type.Optional(Type.Number({ minimum: 0.01 })),
    }),
    async execute(_id, params, signal) {
      return runTool("update_table", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_resize_node",
    label: "Resize Node",
    description:
      "Resize a node to specific dimensions. Zooms the viewport to it.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID" }),
      width: Type.Number({ description: "New width in px" }),
      height: Type.Number({ description: "New height in px" }),
    }),
    async execute(_id, params, signal) {
      return runTool("resize_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_scale_node",
    label: "Scale Node",
    description:
      "Scale a node proportionally like Figma's Scale tool, using a scale factor from the top-left corner.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID" }),
      scale: Type.Number({ description: "Scale factor, e.g. 0.5 or 1.5" }),
    }),
    async execute(_id, params, signal) {
      return runTool("scale_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_set_layout",
    label: "Set Layout",
    description:
      "Set auto-layout properties on a frame or component. Use layoutMode to enable auto-layout, then set alignment, sizing modes, padding and spacing. primaryAxisAlignItems/counterAxisAlignItems require layoutMode to be HORIZONTAL or VERTICAL.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Frame or component node ID" }),
      layoutMode: Type.Optional(
        StringEnum(["NONE", "HORIZONTAL", "VERTICAL"] as const, {
          description: "Auto-layout direction. NONE disables auto-layout.",
        }),
      ),
      primaryAxisAlignItems: Type.Optional(
        StringEnum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"] as const, {
          description:
            "Main axis alignment (requires layoutMode HORIZONTAL or VERTICAL)",
        }),
      ),
      counterAxisAlignItems: Type.Optional(
        StringEnum(["MIN", "CENTER", "MAX", "BASELINE"] as const, {
          description:
            "Cross axis alignment (requires layoutMode HORIZONTAL or VERTICAL)",
        }),
      ),
      primaryAxisSizingMode: Type.Optional(
        StringEnum(["FIXED", "AUTO"] as const, {
          description: "Whether the frame hugs content on the main axis",
        }),
      ),
      counterAxisSizingMode: Type.Optional(
        StringEnum(["FIXED", "AUTO"] as const, {
          description: "Whether the frame hugs content on the cross axis",
        }),
      ),
      paddingTop: Type.Optional(
        Type.Number({ description: "Top padding in px" }),
      ),
      paddingRight: Type.Optional(
        Type.Number({ description: "Right padding in px" }),
      ),
      paddingBottom: Type.Optional(
        Type.Number({ description: "Bottom padding in px" }),
      ),
      paddingLeft: Type.Optional(
        Type.Number({ description: "Left padding in px" }),
      ),
      itemSpacing: Type.Optional(
        Type.Number({ description: "Gap between children in px" }),
      ),
    }),
    async execute(_id, params, signal) {
      const { nodeId, ...layoutProps } = params;
      return runTool("set_layout", { nodeId, ...layoutProps }, { signal });
    },
  });

  pi.registerTool({
    name: "labor_update_fills",
    label: "Update Fills",
    description:
      "Replace the fill colors of a node. Colors use 0–1 range for r/g/b/a.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID" }),
      fills: Type.Array(
        Type.Object({
          r: Type.Number({ description: "Red 0–1" }),
          g: Type.Number({ description: "Green 0–1" }),
          b: Type.Number({ description: "Blue 0–1" }),
          a: Type.Optional(
            Type.Number({ description: "Alpha 0–1, defaults to 1" }),
          ),
        }),
        { description: "Array of solid fills" },
      ),
    }),
    async execute(_id, params, signal) {
      return runTool("update_fills", params, { signal });
    },
  });

  pi.registerTool({
    name: "labor_update_text",
    label: "Update Text",
    description:
      "Change text content and/or font size on a TEXT node or a native FigJam node with an editable text sublayer, such as a sticky, shape, or connector.",
    parameters: Type.Object({
      nodeId: Type.String({
        description: "TEXT or text-bearing FigJam node ID",
      }),
      text: Type.Optional(Type.String({ description: "New text content" })),
      fontSize: Type.Optional(Type.Number({ description: "Font size in px" })),
    }),
    async execute(_id, params, signal) {
      return runTool("update_text", params, { signal });
    },
  });

  // ## Safety

  pi.registerTool({
    name: "labor_undo",
    label: "Undo",
    description:
      "Undo the last Figma operation. Call this immediately if a change was wrong.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const status = await bridgeStatus();
      if (!status || status.plugin !== "connected") {
        return {
          content: [
            {
              type: "text" as const,
              text: "Plugin not connected — cannot undo.",
            },
          ],
          isError: true,
        };
      }
      try {
        await bridgeUndo(targetFile);
        return { content: [{ type: "text" as const, text: "Undo applied." }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{ type: "text" as const, text: `Undo failed: ${msg}` }],
          isError: true,
        };
      }
    },
  });
}
