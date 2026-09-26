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
import { CODE_MODE_TOOL_DEFINITIONS } from "../code-mode-tools.js";
import type { CodeModeToolsProps } from "../code-mode-tools.js";
import type { Env, RouteContext } from "../types.js";
import { getOrgStub } from "../helpers/stubs.js";

const DEFAULT_RUNTIME = "https://agents.camelai.dev";

/**
 * Tools served so far: read-only workspace/project/app inspection plus the
 * workspace file write path. Anything needing the live chat UI (preview,
 * todos, questions, subagents) waits for the ChatThreadDO adapter.
 */
export const AGENT_MCP_TOOL_NAMES = new Set([
  "workspace_info",
  "list_projects",
  "list_commits",
  "list_apps",
  "list_deploy_versions",
  "get_latest_logs",
  "list_scheduled_prompts",
  "connections_list",
  "read_skill",
  "ls",
  "read",
  "grep",
  "find",
  "write",
  "edit",
]);

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

export function agentMcpTools() {
  return CODE_MODE_TOOL_DEFINITIONS
    .filter((definition) => AGENT_MCP_TOOL_NAMES.has(definition.name) && !definition.hidden)
    .map((definition) => ({
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
  return {
    content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data ?? null) }],
    ...(isRecord(data) ? { structuredContent: data } : {}),
  };
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
      return toMcpResult(await tools(props).callToolEnvelope(name, args));
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
