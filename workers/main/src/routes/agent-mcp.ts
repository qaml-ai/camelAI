/**
 * MCP server for the hosted agent runtime (https://agents.camelai.dev).
 *
 * The runtime runs the model loop; chiridion serves the tools. `serveTools`
 * (the runtime SDK) verifies the identity token the runtime signs for every
 * request (EdDSA, two minutes, audience = this URL). Its `context` is the
 * { org, workspace, thread } chiridion gave the agent at creation, and
 * `identity.user` (act ?? sub) is who is acting. Nothing is stored here: each
 * call is authorized against OrgDO and answered by a fresh
 * CodeModeToolsBinding scoped to that org/workspace/thread/user, the same
 * implementation js_exec's `tools.<name>()` calls use today.
 */
import { serveTools, type RuntimeIdentity } from "@camelai/agent-runtime/server";
import type { CallToolResult, ToolServer } from "@camelai/agent-runtime";
import { CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS, CODE_MODE_TOOL_DEFINITIONS } from "../code-mode-tools.js";
import type { CodeModeToolsProps } from "../code-mode-tools.js";
import type { Env, RouteContext } from "../types.js";
import { getOrgStub } from "../helpers/stubs.js";

const DEFAULT_RUNTIME = "https://agents.camelai.dev";

/**
 * CodeModeToolsBinding tools the runtime does NOT get. Everything else that is
 * not hidden (the warehouse_* compatibility aliases) is served; tools that
 * touch the thread's UI state (TodoWrite, set_preview, deploy_project...)
 * reach its ChatThreadDO by RPC with the threadId the runtime signs.
 */
export const AGENT_MCP_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // Block on a human answer through AskUserQuestion / the chat UI; they wait
  // for a runtime-wide ask-user design.
  "AskUserQuestion",
  "prompt_connection_setup",
  "delete_app",
  "delete_project",
  "delete_connection",
  // The runtime's own web builtins replace these.
  "WebSearch",
  "WebFetch",
  // Subagents are not carried over to the runtime.
  "Agent",
  "Explore",
  "Research",
  "Oracle",
]);

export const AGENT_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  CODE_MODE_TOOL_DEFINITIONS
    .filter((definition) => !definition.hidden && !AGENT_MCP_EXCLUDED_TOOL_NAMES.has(definition.name))
    .map((definition) => definition.name),
);

type ToolsBinding = {
  callToolEnvelope(
    name: string,
    args: unknown,
  ): Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string } }>;
};
export type ToolsFactory = (props: CodeModeToolsProps) => ToolsBinding;

export interface AgentMcpOptions {
  /** Where the runtime's keys are fetched from; tests pass `testRuntime().fetch`. */
  fetch?: typeof globalThis.fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function toolError(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * The binding props a verified identity may act with, or why not. `context`
 * was set by chiridion at agent creation (the runtime signs it; the agent
 * cannot change it); membership is checked on every call so a removed user
 * loses tool access at once.
 */
export async function authorizeRuntimeIdentity(
  env: Env,
  identity: RuntimeIdentity,
): Promise<CodeModeToolsProps | { error: string }> {
  const expectedTenant = env.AGENT_RUNTIME_TENANT?.trim();
  if (expectedTenant && identity.tenant !== expectedTenant) {
    return { error: "Forbidden: the agent belongs to another runtime tenant" };
  }
  const orgId = text(identity.context.org);
  const workspaceId = text(identity.context.workspace);
  const threadId = text(identity.context.thread);
  const userId = text(identity.user);
  if (!orgId || !workspaceId || !threadId || !userId) {
    return { error: "Forbidden: the agent has no org, workspace, thread or user" };
  }
  const access = await getOrgStub(env, orgId).validateChatWebSocketAccess(userId, workspaceId, threadId);
  if (!access.ok) return { error: `Forbidden (${access.reason})` };
  if (access.orgId !== orgId) return { error: "Forbidden (org_mismatch)" };
  return { orgId, workspaceId, threadId, userId, allowWebTools: false };
}

/**
 * The runtime declares at most 64 of a source's tools to the model directly
 * (the rest are reached from js_exec), in list order; js_exec runs are capped
 * at 120 s, so long tools must be among them. List the ones chiridion's own
 * loop gives the model directly first: the file tools, then the Pi passthrough
 * tools (deploy_project, run_notebook, set_preview, ...).
 */
const DIRECT_FIRST = new Set([
  "read", "write", "edit", "ls", "delete",
  ...CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS.map((definition) => definition.name),
]);

export function agentMcpTools() {
  const served = CODE_MODE_TOOL_DEFINITIONS.filter((definition) => AGENT_MCP_TOOL_NAMES.has(definition.name));
  return [
    ...served.filter((definition) => DIRECT_FIRST.has(definition.name)),
    ...served.filter((definition) => !DIRECT_FIRST.has(definition.name)),
  ].map((definition) => ({
      name: definition.name,
      description: definition.description,
      // TypeBox schemas are JSON Schema; the round trip drops its symbol keys.
      inputSchema: JSON.parse(JSON.stringify(definition.parameters)) as Record<string, unknown>,
    }));
}

function isContentBlock(block: unknown): block is Record<string, unknown> {
  if (!isRecord(block)) return false;
  if (block.type === "text") return typeof block.text === "string";
  return block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string";
}

/** An MCP tools/call result from the code-mode envelope. */
export function toMcpResult(envelope: Awaited<ReturnType<ToolsBinding["callToolEnvelope"]>>): CallToolResult {
  if (!envelope.ok) return toolError(envelope.error.message);
  const { data } = envelope;
  // The Pi file tools already answer in MCP content blocks (text, and images
  // the model should see natively): pass them through.
  if (isRecord(data) && Array.isArray(data.content) && data.content.length > 0 && data.content.every(isContentBlock)) {
    return {
      content: data.content,
      ...(isRecord(data.details) ? { structuredContent: data.details } : {}),
    };
  }
  // Screenshots (browser_action screenshot, take_screenshot with
  // include_image_data_url) answer { imageDataUrl, ... }: show the image, not
  // its base64 as JSON text.
  const image = isRecord(data) ? imageDataUrlBlock(data.imageDataUrl) : null;
  if (image && isRecord(data)) {
    const { imageDataUrl: _imageDataUrl, ...rest } = data;
    return { content: [{ type: "text", text: JSON.stringify(rest) }, image], structuredContent: rest };
  }
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data ?? null) }],
    ...(isRecord(data) ? { structuredContent: data } : {}),
  };
}

function imageDataUrlBlock(value: unknown): { type: "image"; data: string; mimeType: string } | null {
  if (typeof value !== "string") return null;
  const match = /^data:(image\/[a-z0-9.+-]+);base64,(.+)$/is.exec(value);
  return match ? { type: "image", data: match[2], mimeType: match[1].toLowerCase() } : null;
}

export function agentToolServer(env: Env, tools: ToolsFactory): ToolServer {
  return {
    listTools: agentMcpTools,
    async callTool(name, args, context) {
      if (!AGENT_MCP_TOOL_NAMES.has(name)) throw new Error(`Unknown tool: ${name}`);
      // serveTools always verifies a token and sets the identity.
      if (!context.identity) return toolError("Forbidden: no runtime identity");
      const props = await authorizeRuntimeIdentity(env, context.identity);
      if ("error" in props) return toolError(props.error);
      // The model's tool call (the js_exec call, for calls from code): the
      // binding streams build progress and records artifacts under it, into
      // the thread's live UI, as it does for js_exec's calls in chiridion.
      const parentToolUseId = context.toolCallId;
      return toMcpResult(await tools(parentToolUseId ? { ...props, parentToolUseId } : props).callToolEnvelope(name, args));
    },
  };
}

export function agentMcpHandler(env: Env, tools: ToolsFactory, options: AgentMcpOptions = {}) {
  return serveTools(agentToolServer(env, tools), {
    runtime: env.AGENT_RUNTIME_URL || DEFAULT_RUNTIME,
    ...(env.AGENT_RUNTIME_MCP_AUDIENCE ? { audience: env.AGENT_RUNTIME_MCP_AUDIENCE } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    metadata: false,
    serverInfo: { name: "camelai", version: "1.0.0" },
  });
}

export async function handleAgentMcp({ req, env, ctx }: RouteContext): Promise<Response> {
  const exports = (ctx as unknown as {
    exports: { CodeModeToolsBinding(init: { props: CodeModeToolsProps }): ToolsBinding };
  }).exports;
  return agentMcpHandler(env, (props) => exports.CodeModeToolsBinding({ props }))(req);
}
