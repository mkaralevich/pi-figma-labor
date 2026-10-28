/**
 * The bridge outlives the pi sessions that use it. Every session (a window, a
 * subagent, /reload) runs this extension's session_start and session_shutdown,
 * while the Figma plugin stays connected to one bridge. Before the fix, any
 * session ending killed the bridge, so the plugin dropped and reconnected.
 *
 * Runs the real extension and bridge.js against a fake pi and a fake plugin,
 * on a free port so the live bridge on 3846 is never touched:
 *
 *   bun test
 */
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";

// pi provides these at runtime; the extension only uses them to describe tool
// parameters, which the fake pi never validates.
mock.module("@mariozechner/pi-ai", () => ({
  StringEnum: (values: string[]) => ({ type: "string", enum: values }),
}));
mock.module("@sinclair/typebox", () => ({
  Type: new Proxy({}, { get: () => (...args: unknown[]) => ({ args }) }),
}));

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = createServer();
  server.on("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address() as AddressInfo;
    server.close(() => resolve(port));
  });
  return promise;
}

const PORT = await freePort();
if (PORT === 3846) throw new Error("Refusing to test on the live bridge port");
process.env.LABOR_BRIDGE_PORT = String(PORT);
// Nothing listens here, so the extension's Figma MCP probe fails fast.
process.env.FIGMA_MCP_PORT = String(await freePort());
const BASE = `http://127.0.0.1:${PORT}`;

// Imported after the env is set and the mocks are registered: the extension
// reads LABOR_BRIDGE_PORT when it loads, so a static import would aim at 3846.
const extension = (await import("../extensions/index.ts")).default;

type Handler = (event: unknown, ctx: unknown) => unknown;

interface Tool {
  name: string;
  execute(
    id: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<{ isError?: boolean; content: { text: string }[] }>;
}

interface Session {
  tools: Map<string, Tool>;
  start(): Promise<void>;
  end(): Promise<void>;
}

interface FakePlugin {
  ws: WebSocket;
  closed: boolean;
}

interface Status {
  bridge: string;
  plugin: string;
}

/** One pi session sharing this process's extension module, like a subagent. */
function session(): Session {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, Tool>();
  const pi = {
    on: (event: string, handler: Handler) =>
      handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    registerTool: (tool: Tool) => tools.set(tool.name, tool),
    registerCommand: () => {},
    getActiveTools: () => [],
  };
  extension(pi as never);
  const ctx = { ui: { setStatus() {}, notify() {} } };
  const emit = async (event: string) => {
    for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
  };
  return {
    tools,
    start: () => emit("session_start"),
    end: () => emit("session_shutdown"),
  };
}

async function status(): Promise<Status | null> {
  try {
    const res = await fetch(`${BASE}/status`, {
      signal: AbortSignal.timeout(500),
    });
    return (await res.json()) as Status;
  } catch {
    return null;
  }
}

// The bridge is a separate process reached over real sockets, so these waits
// poll it on the real clock; fake timers can't advance another process.
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await Bun.sleep(100);
    value = await read();
  }
  return value;
}

/** The bridge process listening on the test port, if any. */
function bridgePid(): number | null {
  try {
    const out = execFileSync(
      "lsof",
      ["-nP", "-t", `-iTCP:${PORT}`, "-sTCP:LISTEN"],
      { encoding: "utf8" },
    );
    return Number(out.trim().split("\n")[0]) || null;
  } catch {
    return null;
  }
}

/** A fake Figma plugin: says hello and answers the bridge's identify call. */
async function plugin(): Promise<FakePlugin> {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}`);
  const state: FakePlugin = { closed: false, ws };
  ws.addEventListener("close", () => {
    state.closed = true;
  });
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(String(event.data)) as { id: string; command?: string };
    const result =
      msg.command === "run_script" ? { file: "test file", instance: "test" } : {};
    ws.send(JSON.stringify({ id: msg.id, result }));
  });
  const opened = Promise.withResolvers<void>();
  ws.addEventListener("open", () => opened.resolve());
  ws.addEventListener("error", () => opened.reject(new Error("no bridge")));
  await opened.promise;
  ws.send(
    JSON.stringify({
      type: "hello",
      context: {
        editorType: "figma",
        page: { id: "0:1", name: "Page" },
        selectionCount: 0,
      },
    }),
  );
  return state;
}

/** Like the real plugin, keep reconnecting until a bridge answers. */
async function reconnect(ms = 12_000): Promise<FakePlugin | null> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      return await plugin();
    } catch {
      await Bun.sleep(200);
    }
  }
  return null;
}

const connected = (s: Status | null) => s?.plugin === "connected";

describe("bridge lifetime", () => {
  const sessions: Session[] = [];
  let first: Session;
  let figma: FakePlugin;
  let pid: number | null;

  // A session ending used to SIGTERM the bridge, which drops the plugin socket
  // at once. Wait up to a second for that, returning as soon as it happens.
  const dropped = () =>
    until(
      async () => figma.closed || (await status()) === null,
      (lost) => lost,
      1000,
    );

  beforeAll(async () => {
    expect(await status()).toBeNull();
    first = session();
    sessions.push(first);
    await first.start();
    expect((await until(status, (s) => s !== null))?.bridge).toBe("running");
    figma = await plugin();
    expect(connected(await until(status, connected))).toBe(true);
    pid = bridgePid();
    expect(pid).not.toBeNull();
  });

  afterAll(async () => {
    for (const s of sessions) await s.end();
    figma?.ws.close();
    try {
      await fetch(`${BASE}/shutdown`, { method: "POST" });
    } catch {}
    const left = bridgePid();
    if (left) process.kill(left, "SIGTERM");
  });

  test("another session ending leaves the bridge and plugin connected", async () => {
    const other = session();
    sessions.push(other);
    await other.start();
    await other.end();

    expect(await dropped()).toBe(false);
    expect(connected(await status())).toBe(true);
    expect(bridgePid()).toBe(pid);
  });

  test("the session that started the bridge can end without stopping it", async () => {
    await first.end();

    expect(await dropped()).toBe(false);
    expect(connected(await status())).toBe(true);
    expect(bridgePid()).toBe(pid);
  });

  test("the bridge runs in its own process group, so it outlives the pi process", () => {
    const pgid = execFileSync("ps", ["-o", "pgid=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim();
    expect(Number(pgid)).toBe(pid);
  });

  test("labor_list_files starts a stopped bridge", async () => {
    // Stop it if it's still up; a bridge an earlier test lost is stopped too.
    await fetch(`${BASE}/shutdown`, { method: "POST" }).catch(() => {});
    expect(await until(status, (s) => s === null)).toBeNull();

    const later = session();
    sessions.push(later);
    const reconnecting = reconnect();
    const result = await later.tools.get("labor_list_files")!.execute("t", {});

    expect(result.isError).toBeFalsy();
    // It waits for the plugin to reconnect. The file can still read as
    // unidentified here: the bridge names it a moment after the hello.
    expect(JSON.parse(result.content[0].text).files).toHaveLength(1);
    const back = await reconnecting;
    expect(back).not.toBeNull();
    figma = back!;
    expect(connected(await status())).toBe(true);
  }, 20_000);
});
