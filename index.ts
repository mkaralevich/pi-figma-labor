/**
 * figma-labor extension for pi
 *
 * Registers write (and read) tools that talk to the figma-labor bridge server,
 * which relays commands to the Figma plugin via WebSocket → Plugin API.
 *
 * Requires:
 *   1. Bridge server running at http://127.0.0.1:3846  (start with /figma-labor-start)
 *   2. figma-labor plugin open inside Figma desktop app
 *
 * Tools registered:
 *   figma_get_selection       Get currently selected nodes
 *   figma_get_node            Get a node by ID
 *   figma_get_node_full       Get a node with all layout/constraint properties
 *   figma_get_children        List children of a node
 *   figma_get_component_props Get component property definitions
 *   figma_update_properties   Update position, size, name, opacity, etc.
 *   figma_resize_node         Resize a node
 *   figma_update_fills        Change fill colors
 *   figma_update_text         Change text content and font size
 *   figma_set_layout          Set auto-layout alignment, sizing, padding, spacing
 *   figma_create_node         Create a new primitive node
 *   figma_create_instance     Create an instance of a component
 *   figma_delete_node         Delete a node
 *   figma_move_node           Move a node to a different parent
 *   figma_select_node         Select a node and zoom to it
 *   figma_detach_instance     Detach an instance, converting it to a plain frame
 *   figma_run_script          Run arbitrary JS in the Figma plugin context
 *   figma_undo                Undo the last operation
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = realpathSync(dirname(fileURLToPath(import.meta.url)));
const PROMPT_TEMPLATE = readFileSync(join(__dirname, "prompt.md"), "utf8");

const BRIDGE_URL = "http://127.0.0.1:3846";
const BRIDGE_BIN = join(__dirname, "bridge.js");

// ## State

let bridgeProc: ChildProcess | null = null;
let bridgeStartedByUs = false;
let cachedStatus: { bridge: string; plugin: string } | null = null;

// ## Bridge HTTP helpers

async function bridgeStatus(timeout = 2000): Promise<{ bridge: string; plugin: string } | null> {
  try {
    const res = await fetch(`${BRIDGE_URL}/status`, { signal: AbortSignal.timeout(timeout) });
    return await res.json() as { bridge: string; plugin: string };
  } catch {
    return null;
  }
}

async function bridgeCommand(command: string, params: Record<string, unknown>, opts?: { timeout?: number; signal?: AbortSignal }): Promise<unknown> {
  const timeoutMs = opts?.timeout ?? 35_000;
  const httpTimeoutSignal = AbortSignal.timeout(timeoutMs + 5_000); // HTTP timeout > bridge timeout
  const signal = opts?.signal
    ? AbortSignal.any([opts.signal, httpTimeoutSignal])
    : httpTimeoutSignal;
  const res = await fetch(`${BRIDGE_URL}/command`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command, params, timeout: opts?.timeout }),
    signal,
  });
  const json = await res.json() as { result?: unknown; error?: string };
  if (json.error) throw new Error(json.error);
  return json.result;
}

async function bridgeUndo(): Promise<void> {
  await fetch(`${BRIDGE_URL}/undo`, {
    method: "POST",
    signal: AbortSignal.timeout(5000),
  });
}

// ## Start / stop bridge server

async function startBridge(): Promise<boolean> {
  // Already running?
  const status = await bridgeStatus();
  if (status) return true;

  bridgeProc = spawn("node", [BRIDGE_BIN], {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let spawnFailed = false;
  bridgeProc.on("error", (err) => {
    console.error("[figma-labor] Bridge process error:", err.message);
    spawnFailed = true;
  });

  // Wait up to 3s for it to start — use short per-check timeout so we don't
  // block 2s × 15 iterations (= 30s) when the bridge isn't responding
  for (let i = 0; i < 15; i++) {
    if (spawnFailed) return false;
    await new Promise((r) => setTimeout(r, 200));
    const s = await bridgeStatus(300);
    if (s) { bridgeStartedByUs = true; return true; }
  }

  return false;
}

function stopBridge() {
  if (bridgeProc && bridgeStartedByUs) {
    bridgeProc.kill("SIGTERM");
    bridgeProc = null;
    bridgeStartedByUs = false;
  }
}

// ## Footer status helper

function footerLabel(plugin: string): string {
  return plugin === "connected" ? "figma-labor ✓" : "figma-labor ○";
}

// ## Tool wrapper

async function runTool(command: string, params: Record<string, unknown>, opts?: { timeout?: number; signal?: AbortSignal }) {
  const status = await bridgeStatus();

  if (!status) {
    return {
      content: [{ type: "text" as const, text: "figma-labor bridge is not running. Start pi fresh or run the bridge manually: cd ~/Git/figma-labor/bridge && npm start" }],
      isError: true,
    };
  }

  if (status.plugin !== "connected") {
    return {
      content: [{ type: "text" as const, text: "Figma plugin is not connected. Open the figma-labor plugin in Figma (Menu → Plugins → Development → figma-labor)." }],
      isError: true,
    };
  }

  try {
    const result = await bridgeCommand(command, params, opts);
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text" as const, text: `figma-labor error: ${msg}` }],
      isError: true,
    };
  }
}

// ## Extension

export default function (pi: ExtensionAPI) {

  // ## Lifecycle

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  function startPolling(ctx: Parameters<Parameters<typeof pi.on>[1]>[1]) {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      const s = await bridgeStatus();
      cachedStatus = s;
      ctx.ui.setStatus("figma-labor", s ? footerLabel(s.plugin) : "figma-labor ✗");
    }, 3000);
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  pi.on("session_start", async (_event, ctx) => {
    // Probe once in the background to warm up cachedStatus and start polling
    (async () => {
      const s = await bridgeStatus();
      cachedStatus = s;
      ctx.ui.setStatus("figma-labor", s ? footerLabel(s.plugin) : "figma-labor ✗");
      if (s) startPolling(ctx);
    })();
  });

  pi.on("session_shutdown", async (_event) => {
    stopPolling();
    stopBridge();
  });

  // System prompt injection — uses cachedStatus to avoid blocking every Enter press

  pi.on("before_agent_start", async (event) => {
    if (!cachedStatus) return;

    const prompt = PROMPT_TEMPLATE.replace("{{plugin_status}}", cachedStatus.plugin);
    return {
      systemPrompt: event.systemPrompt + "\n\n" + prompt,
    };
  });

  pi.registerCommand("figma-labor-start", {
    description: "Start the figma-labor bridge server",
    handler: async (_args, ctx) => {
      const already = await bridgeStatus();
      if (already) {
        ctx.ui.notify(`figma-labor bridge is already running.\nPlugin: ${already.plugin}`, "info");
        startPolling(ctx);
        return;
      }
      ctx.ui.notify("Starting figma-labor bridge...", "info");
      const ok = await startBridge();
      if (!ok) {
        ctx.ui.setStatus("figma-labor", "figma-labor ✗");
        ctx.ui.notify("Failed to start figma-labor bridge.\n\nMake sure bridge.js exists at:\n" + BRIDGE_BIN, "error");
        return;
      }
      const status = await bridgeStatus();
      cachedStatus = status;
      ctx.ui.setStatus("figma-labor", footerLabel(status?.plugin ?? "disconnected"));
      ctx.ui.notify(`figma-labor bridge started.\nPlugin: ${status?.plugin ?? "disconnected"}`, "success");
      startPolling(ctx);
    },
  });

  pi.registerCommand("figma-labor-end", {
    description: "Stop the figma-labor bridge server",
    handler: async (_args, ctx) => {
      stopPolling();
      stopBridge();
      cachedStatus = null;
      ctx.ui.setStatus("figma-labor", "figma-labor ✗");
      ctx.ui.notify("figma-labor bridge stopped.", "info");
    },
  });

  pi.registerCommand("figma-labor", {
    description: "Show Figma bridge server connection status",
    handler: async (_args, ctx) => {
      const status = await bridgeStatus();
      if (!status) {
        ctx.ui.notify("figma-labor bridge is not running.\n\nRun /figma-labor-start to launch it.", "error");
        return;
      }
      ctx.ui.notify(
        `figma-labor bridge: ${status.bridge}\nFigma plugin: ${status.plugin}`,
        status.plugin === "connected" ? "success" : "info"
      );
    },
  });

  // Tools

  pi.registerTool({
    name: "figma_get_selection",
    label: "Figma Get Selection",
    description: "Get the currently selected nodes in Figma. Always call this first to understand what the user has selected.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      return runTool("get_selection", {}, { signal });
    },
  });

  pi.registerTool({
    name: "figma_get_node",
    label: "Figma Get Node",
    description: "Get a Figma node by ID, including its properties.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID, e.g. '123:456'" }),
    }),
    async execute(_id, params, signal) {
      return runTool("get_node", { nodeId: params.nodeId }, { signal });
    },
  });

  pi.registerTool({
    name: "figma_get_children",
    label: "Figma Get Children",
    description: "List children of a node. Omit nodeId to list children of the current page.",
    parameters: Type.Object({
      nodeId: Type.Optional(Type.String({ description: "Parent node ID. Omit for current page." })),
    }),
    async execute(_id, params, signal) {
      return runTool("get_children", { nodeId: params.nodeId }, { signal });
    },
  });

  pi.registerTool({
    name: "figma_get_component_props",
    label: "Figma Get Component Props",
    description: "Get component property definitions for a COMPONENT_SET node, including variant options.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "COMPONENT_SET node ID" }),
    }),
    async execute(_id, params, signal) {
      return runTool("get_component_properties", { nodeId: params.nodeId }, { signal });
    },
  });

  pi.registerTool({
    name: "figma_update_properties",
    label: "Figma Update Properties",
    description: "Update one or more properties of a node: name, x, y, width, height, opacity (0–1), visible, rotation.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID" }),
      name: Type.Optional(Type.String({ description: "New name" })),
      x: Type.Optional(Type.Number({ description: "X position" })),
      y: Type.Optional(Type.Number({ description: "Y position" })),
      width: Type.Optional(Type.Number({ description: "Width in px" })),
      height: Type.Optional(Type.Number({ description: "Height in px" })),
      opacity: Type.Optional(Type.Number({ description: "Opacity 0–1" })),
      visible: Type.Optional(Type.Boolean({ description: "Visibility" })),
      rotation: Type.Optional(Type.Number({ description: "Rotation in degrees" })),
    }),
    async execute(_id, params, signal) {
      const { nodeId, ...properties } = params;
      return runTool("update_properties", { nodeId, properties }, { signal });
    },
  });

  pi.registerTool({
    name: "figma_resize_node",
    label: "Figma Resize Node",
    description: "Resize a node to specific dimensions. Zooms the viewport to it.",
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
    name: "figma_update_fills",
    label: "Figma Update Fills",
    description: "Replace the fill colors of a node. Colors use 0–1 range for r/g/b/a.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID" }),
      fills: Type.Array(
        Type.Object({
          r: Type.Number({ description: "Red 0–1" }),
          g: Type.Number({ description: "Green 0–1" }),
          b: Type.Number({ description: "Blue 0–1" }),
          a: Type.Optional(Type.Number({ description: "Alpha 0–1, defaults to 1" })),
        }),
        { description: "Array of solid fills" }
      ),
    }),
    async execute(_id, params, signal) {
      return runTool("update_fills", params, { signal });
    },
  });

  pi.registerTool({
    name: "figma_update_text",
    label: "Figma Update Text",
    description: "Change the text content and/or font size of a TEXT node.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "TEXT node ID" }),
      text: Type.Optional(Type.String({ description: "New text content" })),
      fontSize: Type.Optional(Type.Number({ description: "Font size in px" })),
    }),
    async execute(_id, params, signal) {
      return runTool("update_text", params, { signal });
    },
  });

  pi.registerTool({
    name: "figma_create_node",
    label: "Figma Create Node",
    description: "Create a new node inside a parent. Type can be RECTANGLE, ELLIPSE, FRAME, or TEXT.",
    parameters: Type.Object({
      type: StringEnum(["RECTANGLE", "ELLIPSE", "FRAME", "TEXT"] as const),
      parentId: Type.Optional(Type.String({ description: "Parent node ID. Omit to add to current page." })),
      name: Type.Optional(Type.String({ description: "Node name" })),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      width: Type.Optional(Type.Number()),
      height: Type.Optional(Type.Number()),
      text: Type.Optional(Type.String({ description: "Initial text (TEXT nodes only)" })),
    }),
    async execute(_id, params, signal) {
      return runTool("create_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "figma_create_instance",
    label: "Figma Create Instance",
    description: "Create an instance of a COMPONENT node and place it on the canvas or inside a parent. The componentId must point to a COMPONENT (not a COMPONENT_SET) — call figma_get_children on the set to find the specific variant you want. Optionally pass properties to set variant or text overrides.",
    parameters: Type.Object({
      componentId: Type.String({ description: "ID of the COMPONENT node to instantiate (not COMPONENT_SET)" }),
      parentId: Type.Optional(Type.String({ description: "Parent node ID to append the instance into. Omit to place on current page." })),
      x: Type.Optional(Type.Number({ description: "X position" })),
      y: Type.Optional(Type.Number({ description: "Y position" })),
      name: Type.Optional(Type.String({ description: "Override the instance name" })),
      properties: Type.Optional(Type.Record(Type.String(), Type.Unknown(), { description: "Component property overrides, e.g. { 'size': 'medium', 'label': 'Click me' }" })),
    }),
    async execute(_id, params, signal) {
      return runTool("create_instance", params as Record<string, unknown>, { signal });
    },
  });

  pi.registerTool({
    name: "figma_delete_node",
    label: "Figma Delete Node",
    description: "Delete a node. This is destructive — call figma_undo immediately if it was a mistake.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID to delete" }),
    }),
    async execute(_id, params, signal) {
      return runTool("delete_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "figma_move_node",
    label: "Figma Move Node",
    description: "Move a node to a different parent, optionally at a specific index.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID to move" }),
      parentId: Type.String({ description: "Target parent node ID" }),
      index: Type.Optional(Type.Number({ description: "Insert at this child index (0 = first)" })),
    }),
    async execute(_id, params, signal) {
      return runTool("move_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "figma_select_node",
    label: "Figma Select Node",
    description: "Select a node in Figma and zoom the viewport to it.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID to select" }),
    }),
    async execute(_id, params, signal) {
      return runTool("select_node", params, { signal });
    },
  });

  pi.registerTool({
    name: "figma_get_node_full",
    label: "Figma Get Node Full",
    description: "Get a Figma node with ALL properties including auto-layout, constraints, padding, sizing modes, min/max sizes, clipsContent, and locked state. Use this instead of figma_get_node when you need to diagnose layout issues or read/set alignment.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Node ID, e.g. '123:456'" }),
    }),
    async execute(_id, params, signal) {
      return runTool("get_node_full", { nodeId: params.nodeId }, { signal });
    },
  });

  pi.registerTool({
    name: "figma_set_layout",
    label: "Figma Set Layout",
    description: "Set auto-layout properties on a frame or component. Use layoutMode to enable auto-layout, then set alignment, sizing modes, padding and spacing. primaryAxisAlignItems/counterAxisAlignItems require layoutMode to be HORIZONTAL or VERTICAL.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "Frame or component node ID" }),
      layoutMode: Type.Optional(StringEnum(["NONE", "HORIZONTAL", "VERTICAL"] as const, { description: "Auto-layout direction. NONE disables auto-layout." })),
      primaryAxisAlignItems: Type.Optional(StringEnum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"] as const, { description: "Main axis alignment (requires layoutMode HORIZONTAL or VERTICAL)" })),
      counterAxisAlignItems: Type.Optional(StringEnum(["MIN", "CENTER", "MAX", "BASELINE"] as const, { description: "Cross axis alignment (requires layoutMode HORIZONTAL or VERTICAL)" })),
      primaryAxisSizingMode: Type.Optional(StringEnum(["FIXED", "AUTO"] as const, { description: "Whether the frame hugs content on the main axis" })),
      counterAxisSizingMode: Type.Optional(StringEnum(["FIXED", "AUTO"] as const, { description: "Whether the frame hugs content on the cross axis" })),
      paddingTop: Type.Optional(Type.Number({ description: "Top padding in px" })),
      paddingRight: Type.Optional(Type.Number({ description: "Right padding in px" })),
      paddingBottom: Type.Optional(Type.Number({ description: "Bottom padding in px" })),
      paddingLeft: Type.Optional(Type.Number({ description: "Left padding in px" })),
      itemSpacing: Type.Optional(Type.Number({ description: "Gap between children in px" })),
    }),
    async execute(_id, params, signal) {
      const { nodeId, ...layoutProps } = params;
      return runTool("set_layout", { nodeId, ...layoutProps }, { signal });
    },
  });

  pi.registerTool({
    name: "figma_detach_instance",
    label: "Figma Detach Instance",
    description: "Detach a component instance, converting it into a plain frame whose children can be freely repositioned. Call this when you need to reorder or reposition children that are locked inside an instance.",
    parameters: Type.Object({
      nodeId: Type.String({ description: "INSTANCE node ID to detach" }),
    }),
    async execute(_id, params, signal) {
      return runTool("detach_instance", params, { signal });
    },
  });

  pi.registerTool({
    name: "figma_run_script",
    label: "Figma Run Script",
    description: "Run arbitrary JavaScript in the Figma plugin context. The script has full access to the `figma` Plugin API. Use `return` to return a value. Async is supported. Example: `return figma.currentPage.findAll(n => n.type === 'COMPONENT').length`",
    parameters: Type.Object({
      code: Type.String({ description: "JS code to execute. Has access to `figma`. Use return to return a value." }),
    }),
    async execute(_id, params, signal) {
      return runTool("run_script", { code: params.code }, { timeout: 60_000, signal });
    },
  });

  pi.registerTool({
    name: "figma_undo",
    label: "Figma Undo",
    description: "Undo the last Figma operation. Call this immediately if a change was wrong.",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      const status = await bridgeStatus();
      if (!status || status.plugin !== "connected") {
        return {
          content: [{ type: "text" as const, text: "Plugin not connected — cannot undo." }],
          isError: true,
        };
      }
      try {
        await bridgeUndo();
        return { content: [{ type: "text" as const, text: "Undo applied." }] };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { content: [{ type: "text" as const, text: `Undo failed: ${msg}` }], isError: true };
      }
    },
  });
}
