/**
 * What chiridion appends to a runtime agent's system prompt, and the version
 * of it (a send re-sends it when the version changes), plus a run's model
 * configuration and whether the hosted runtime is configured at all.
 */
import { RUNTIME_TOOL_PREFIX as TOOL_PREFIX } from "../../../../src/lib/agent-runtime-shared";

/**
 * Leads chiridion's system prompt when it is appended to the runtime's: the
 * prompt was written for the in-DO tool surface, whose names and js_exec
 * bindings differ here.
 */
export const RUNTIME_PROMPT_PREAMBLE = [
  "# camelAI tools on this runtime",
  `camelAI's tools are named ${TOOL_PREFIX}<tool> (for example ${TOOL_PREFIX}read, ${TOOL_PREFIX}deploy_project, ${TOOL_PREFIX}set_preview). Where the instructions below name a tool, use its ${TOOL_PREFIX} form; in js_exec call it as tools.${TOOL_PREFIX}<tool>(args).`,
  `js_exec has no env bindings, connections object or network here: query or call a connection with ${TOOL_PREFIX}connections_query / ${TOOL_PREFIX}connections_invoke, drive a browser with ${TOOL_PREFIX}browser_launch / ${TOOL_PREFIX}browser_action, generate images or transcribe audio with ${TOOL_PREFIX}generate_image / ${TOOL_PREFIX}transcribe_audio, call a deployed app with ${TOOL_PREFIX}http_request, and read the web with web_fetch / web_search.`,
  [
    "There are two filesystems.",
    "/workspace is this conversation's scratch space: files attached to messages, files tools return (under /workspace/tool-outputs/), and your own intermediate files. Read and write it with fs in js_exec, and give a file to the user with present_file. It is private to this conversation and deleted with it.",
    `The camelAI workspace is the user's durable storage, shared with their apps and other chats: workspace, project and uploaded files live there (location "workspace", "project" or "r2"). Use the ${TOOL_PREFIX} file tools for it, never fs. Save something from /workspace into it only when the user asks, with ${TOOL_PREFIX}import_file ({ source: { "$file": "/workspace/<path>" }, destination: { location, path } }).`,
    "A tool result that was too long is cut, and its whole text saved under /workspace/tool-results/: read that file in parts with fs in js_exec (fs.readFile), not with the camel__ file tools.",
    "Where the instructions below name a camelAI file path (such as /workspace/AGENTS.md, or a project VM's /workspace for shell commands), that is the camelAI workspace or the project, not the scratch space.",
  ].join(" "),
  `In js_exec, await tools.${TOOL_PREFIX}<tool>(args) returns the tool's data itself (for example ${TOOL_PREFIX}list_apps gives { total, count, apps: [...] }; a file read gives its text, or { text, ...details }): use it directly, without JSON.parse or unwrapping.`,
].join("\n\n");

/**
 * The version of the instructions chiridion appends for runtime agents
 * (RUNTIME_PROMPT_PREAMBLE and the prompt after it). Bump it when they change
 * in a way existing threads must get: their next send re-sends them.
 */
export const RUNTIME_PROMPT_VERSION = 4;

/** A run's configuration: a Pi model id (or the Codex forwarder's), its key scope, and its spend limit. */
export interface RuntimeRunConfig {
  model: string;
  /** `hosted` or `org_<id>`; null for the Codex forwarder (a tenant endpoint). */
  keyScope: string | null;
  /** USD the run may spend; null for no limit. */
  spendLimitUsd: number | null;
  /** Non-secret headers on every model call (the hosted scope's gateway metadata); null for none. They follow the key scope. */
  modelHeaders: Record<string, string> | null;
}

/** The hosted runtime's tenant, operator token and agent definition are all set. */
export function runtimeConfigured(env: {
  AGENT_RUNTIME_API_TOKEN?: string;
  AGENT_RUNTIME_TENANT?: string;
  AGENT_RUNTIME_DEFINITION?: string;
}): boolean {
  return Boolean(env.AGENT_RUNTIME_API_TOKEN?.trim() && env.AGENT_RUNTIME_TENANT?.trim() && env.AGENT_RUNTIME_DEFINITION?.trim());
}
