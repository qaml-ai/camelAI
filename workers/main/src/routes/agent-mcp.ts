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
import { InputRequired, type CallToolResult, type ToolContext, type ToolServer } from "@camelai/agent-runtime";
import { CODE_MODE_PI_PASSTHROUGH_TOOL_DEFINITIONS, CODE_MODE_TOOL_DEFINITIONS } from "../code-mode-tools.js";
import type { CodeModeToolsProps } from "../code-mode-tools.js";
import type { Env, RouteContext } from "../types.js";
import { getOrgStub } from "../helpers/stubs.js";
import { recordWorkspaceThreadStreaming } from "../thread-status.js";

const DEFAULT_RUNTIME = "https://agents.camelai.dev";

/**
 * CodeModeToolsBinding tools the runtime does NOT get. Everything else that is
 * not hidden (the warehouse_* compatibility aliases) is served; tools that
 * touch the thread's UI state (TodoWrite, set_preview, deploy_project...)
 * reach its ChatThreadDO by RPC with the threadId the runtime signs.
 */
export const AGENT_MCP_EXCLUDED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // The runtime's ask_user built-in replaces it.
  "AskUserQuestion",
  // The runtime's own web builtins replace these.
  "WebSearch",
  "WebFetch",
  // Subagents are not carried over to the runtime.
  "Agent",
  "Explore",
  "Research",
  "Oracle",
]);

/**
 * Destructive tools that confirm with the user first: over MCP the question
 * goes through the runtime (ctx.confirm, the turn waits), then the tool runs
 * preconfirmed.
 */
export const AGENT_MCP_CONFIRMED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "delete_app",
  "delete_project",
  "delete_connection",
]);

export const AGENT_MCP_TOOL_NAMES: ReadonlySet<string> = new Set(
  CODE_MODE_TOOL_DEFINITIONS
    .filter((definition) => !definition.hidden && !AGENT_MCP_EXCLUDED_TOOL_NAMES.has(definition.name))
    .map((definition) => definition.name),
);

type ToolsBinding = {
  describeDestructiveConfirmation(name: string, args: unknown): Promise<string | null>;
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
  return {
    orgId,
    workspaceId,
    threadId,
    userId,
    allowWebTools: false,
    // A thread with a runtime row has no ChatThreadDO (plans/runtime-threads-direct.md).
    ...(access.runtime ? { directRuntime: true } : {}),
  };
}

/**
 * The runtime declares at most 64 of a source's tools to the model directly
 * (the rest are reached from js_exec), in list order; js_exec runs are capped
 * at 120 s, so long tools must be among them. List the ones chiridion's own
 * loop gives the model directly first: the file tools, then the Pi passthrough
 * tools (deploy_project, run_notebook, set_preview, ...).
 */
const DIRECT_FIRST = new Set([
  "read", "write", "edit", "ls", "delete", "import_file",
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
      // Tools that wait on the user cannot run in js_exec; the ones chiridion's
      // loop gives the model directly (long builds and notebooks among them,
      // which outlast js_exec's 120 s) stay direct too; the rest are for code.
      _meta: {
        "agent-runtime/exposure": AGENT_MCP_CONFIRMED_TOOL_NAMES.has(definition.name) || definition.name === "prompt_connection_setup"
          ? "direct"
          : DIRECT_FIRST.has(definition.name) ? "both" : "codemode",
      },
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
  // the model should see natively): pass them through. Code (js_exec) gets the
  // structured value, so it carries the text beside the details (a read's
  // file text, not only its truncation metadata).
  if (isRecord(data) && Array.isArray(data.content) && data.content.length > 0 && data.content.every(isContentBlock)) {
    const text = data.content.flatMap((block) => (block.type === "text" ? [block.text as string] : [])).join("\n");
    return {
      content: data.content,
      ...(isRecord(data.details) ? { structuredContent: { ...data.details, text } } : {}),
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

/** How often a tool call in flight renews its runtime thread's 5-minute running lease. */
const RUNNING_HEARTBEAT_MS = 60_000;

/**
 * A runtime thread has no ChatThreadDO to heartbeat its running lease, and
 * the runtime reports nothing while a tool call runs: keep the thread marked
 * running for as long as one is in flight here. The call's start marks it
 * (bringing back a row the sweeper cleared); the ticks only renew it.
 */
function runningHeartbeat(env: Env, workspaceId: string, threadId: string | undefined): () => void {
  if (!threadId) return () => {};
  // Never in the tool call's way: a lease write that fails is only logged.
  const mark = (options?: { refresh: true; source: string }) => {
    Promise.resolve()
      .then(() => recordWorkspaceThreadStreaming(env, workspaceId, threadId, true, options))
      .catch((error) => console.warn("[agent-mcp] could not renew the thread's running lease", error));
  };
  mark();
  const timer = setInterval(() => mark({ refresh: true, source: "runtime_tool_call" }), RUNNING_HEARTBEAT_MS);
  return () => clearInterval(timer);
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
      const scoped = parentToolUseId ? { ...props, parentToolUseId } : props;
      const stopHeartbeat = props.directRuntime ? runningHeartbeat(env, props.workspaceId, props.threadId) : () => {};
      try {
        if (AGENT_MCP_CONFIRMED_TOOL_NAMES.has(name)) {
          // Ask first: everything before an ask runs again when the user answers.
          const question = await tools(props).describeDestructiveConfirmation(name, args);
          if (question && !await context.confirm(question)) {
            return toMcpResult({ ok: true, data: { success: false, cancelled: true, message: "The user declined." } });
          }
          return toMcpResult(await tools({ ...scoped, preconfirmed: true }).callToolEnvelope(name, args));
        }
        const result = toMcpResult(await tools(scoped).callToolEnvelope(name, args));
        if (name === "prompt_connection_setup") return await connectionSetupFallback(env, result, args, context);
        return result;
      } catch (error) {
        if (error instanceof InputRequired) {
          return {
            resultType: "input_required",
            inputRequests: error.inputRequests,
            ...(error.requestState ? { requestState: error.requestState } : {}),
          } as unknown as CallToolResult;
        }
        throw error;
      } finally {
        stopHeartbeat();
      }
    },
  };
}

/**
 * prompt_connection_setup shows chiridion's own setup form in the thread's
 * chat (credentials never pass through the runtime). With nobody in the chat
 * to fill it in (a Slack or email thread), send the user to the connections
 * page instead, through the runtime (ctx.requireUrl), when it is https.
 */
async function connectionSetupFallback(
  env: Env,
  result: CallToolResult,
  args: Record<string, unknown>,
  context: ToolContext,
): Promise<CallToolResult> {
  const data = result.structuredContent;
  const unavailable = data?.cancelled === true && !data.requestId;
  const base = env.WORKER_BASE_URL?.replace(/\/+$/, "") ?? "";
  if (!unavailable || !base.startsWith("https://")) return result;
  const type = typeof args.integration_type === "string" ? args.integration_type : "the";
  const done = await context.requireUrl(
    `${base}/connections`,
    typeof args.message === "string" && args.message.trim() ? args.message : `Set up ${type} connection in camelAI, then come back.`,
  );
  return toMcpResult({
    ok: true,
    data: done
      ? { completed: true, message: "The user says they set up the connection; check it with connections_list." }
      : { cancelled: true, message: "The user did not set up the connection." },
  });
}

export function agentMcpHandler(env: Env, tools: ToolsFactory, options: AgentMcpOptions = {}) {
  // The SDK refuses tokens of other tenants' agents, and so needs ours.
  const tenant = env.AGENT_RUNTIME_TENANT?.trim();
  if (!tenant) {
    return async (_req: Request) => Response.json({ error: "The agent runtime is not configured" }, { status: 503 });
  }
  return serveTools(agentToolServer(env, tools), {
    tenant,
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
