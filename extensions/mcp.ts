import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type, type TSchema } from "@sinclair/typebox";

const MCP_URL = `http://127.0.0.1:${process.env.FIGMA_MCP_PORT ?? "3845"}/mcp`;
const MAX_OUTPUT_BYTES = 50 * 1024;

let sessionId: string | undefined;
let requestId = 1;
let connected = false;
let availableTools: Array<{ name: string; description: string }> = [];

async function mcpPost(
	method: string,
	params?: Record<string, unknown>,
	signal?: AbortSignal
): Promise<unknown> {
	const id = requestId++;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
	};
	if (sessionId) headers["mcp-session-id"] = sessionId;

	const response = await fetch(MCP_URL, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
		signal,
	});

	const newSid = response.headers.get("mcp-session-id");
	if (newSid) sessionId = newSid;

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

async function initializeSession(signal?: AbortSignal): Promise<boolean> {
	try {
		sessionId = undefined;
		await mcpPost(
			"initialize",
			{
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "pi-figma-mcp", version: "2.0" },
			},
			signal
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

async function listTools(signal?: AbortSignal): Promise<McpTool[]> {
	const result = (await mcpPost("tools/list", undefined, signal)) as {
		tools: McpTool[];
	};
	return result.tools ?? [];
}

async function callTool(
	name: string,
	args: Record<string, unknown>,
	signal?: AbortSignal
): Promise<McpToolResult> {
	return (await mcpPost("tools/call", { name, arguments: args }, signal)) as McpToolResult;
}

function truncate(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) return text;
	return (
		Buffer.from(text, "utf8").slice(0, MAX_OUTPUT_BYTES).toString("utf8") +
		"\n\n[Output truncated — use a more specific nodeId or break the design into smaller sections.]"
	);
}

function convertContent(
	mcpContent: McpContent[]
): Array<{ type: "text"; text: string } | { type: "image"; mimeType: string; data: string }> {
	const out: ReturnType<typeof convertContent> = [];
	for (const content of mcpContent) {
		if (content.type === "text" && content.text) {
			out.push({ type: "text", text: truncate(content.text) });
		} else if (content.type === "image" && content.data && content.mimeType) {
			out.push({ type: "image", mimeType: content.mimeType, data: content.data });
		} else if (content.type === "resource" && content.uri) {
			out.push({ type: "text", text: `[Resource: ${content.uri}]` });
		}
	}
	return out;
}

function buildSchema(inputSchema: McpTool["inputSchema"]): TSchema {
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
		const withDesc = description ? { ...schema, description } : schema;
		fields[key] = required.has(key) ? withDesc : Type.Optional(withDesc);
	}

	return Type.Object(fields);
}

function formatLabel(name: string): string {
	return name
		.split("_")
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ");
}

function normalizeNodeId(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) return trimmed;

	try {
		const url = new URL(trimmed);
		const fromQuery = url.searchParams.get("node-id") ?? url.searchParams.get("nodeId");
		if (fromQuery) {
			return normalizeNodeId(fromQuery);
		}
	} catch {}

	const queryMatch = trimmed.match(/[?&]node-id=([0-9]+(?:[:-][0-9]+)?)/i);
	if (queryMatch?.[1]) return normalizeNodeId(queryMatch[1]);

	const plainMatch = trimmed.match(/\b([0-9]+[:-][0-9]+)\b/);
	if (!plainMatch) return trimmed;

	return plainMatch[1].replace(/-/g, ":");
}

function normalizeToolArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
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
		next.nodeId = normalizeNodeId(next.nodeId);
	}
	return next;
}

function registerMcpTools(pi: ExtensionAPI, tools: McpTool[]) {
	availableTools = tools.map((tool) => ({
		name: tool.name,
		description: tool.description,
	}));

	for (const tool of tools) {
		const schema = buildSchema(tool.inputSchema);

		pi.registerTool({
			name: tool.name,
			label: formatLabel(tool.name),
			description: tool.description,
			parameters: schema,

			async execute(_id, params, signal) {
				if (!sessionId) {
					const ok = await initializeSession(signal);
					if (!ok) {
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
					const normalizedParams = normalizeToolArgs(
						tool.name,
						params as Record<string, unknown>
					);
					const result = await callTool(tool.name, normalizedParams, signal);
					return {
						content: convertContent(result.content),
						isError: result.isError ?? false,
					};
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error);
					if (message.includes("404") || message.includes("session")) sessionId = undefined;
					return {
						content: [{ type: "text", text: `Figma MCP error: ${message}` }],
						isError: true,
					};
				}
			},
		});
	}
}

export function registerFigmaMcp(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		(async () => {
			const signal = AbortSignal.timeout(10_000);
			try {
				const ok = await initializeSession(signal);
				if (!ok) {
					connected = false;
					ctx.ui.setStatus("figma", "figma ✗");
					return;
				}

				const tools = await listTools(signal);
				connected = true;
				ctx.ui.setStatus("figma", "figma ✓");
				registerMcpTools(pi, tools);
			} catch {
				connected = false;
				ctx.ui.setStatus("figma", "figma ✗");
			}
		})();
	});

	pi.registerCommand("figma-mcp", {
		description: "Show Figma MCP server connection status and available tools",
		handler: async (_args, ctx) => {
			if (!connected) {
				ctx.ui.notify(
					"Figma MCP server is not connected.\n\nTo enable:\n1. Open Figma desktop app\n2. Open a Design file\n3. Switch to Dev Mode (Shift+D)\n4. In the Inspect panel → MCP server → Enable desktop MCP server",
					"error"
				);
				return;
			}
			ctx.ui.notify(
				`Figma MCP server connected ✓\nURL: ${MCP_URL}\n\nAvailable tools (${availableTools.length}):\n${availableTools.map((tool) => `  • ${tool.name}`).join("\n")}`,
				"success"
			);
		},
	});
}
