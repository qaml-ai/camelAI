/**
 * Moving a ChatThreadDO thread to the agent runtime: its pi history becomes
 * the history of a new runtime agent (`initialMessages` on create), its UI
 * state moves to OrgDO, and its thread_runtime row (the commit point: every
 * entry path routes by it) makes it a direct runtime thread. A thread the DO
 * relays to a runtime agent is adopted instead (channel-turns.ts).
 *
 * The DO drives the move itself (chat-thread/runtime-migration.ts), so the
 * transcript never crosses an RPC and an alarm finishes or undoes a move its
 * caller abandoned. This module is the worker's side: which threads may move,
 * who the agent acts for, and turning a DO transcript into a runtime import.
 *
 * Anything the import cannot carry whole (a huge tool result, a stored image,
 * a history over the runtime's cap) is shortened, and the full original
 * transcript is saved to the agent's workspace; the import says where.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import type { OrgMember, OrgThread, ThreadRuntimeRecord } from "../identity/org-do.js";
import { directRuntimeRow } from "./channel-turns.js";
import { resolveThreadRuntimeRoute } from "./run-gates.js";
import { runtimeDirectThreadsEnabled } from "./thread-runtime.js";

/** Tool results longer than this are shortened (their head and tail kept). */
export const MAX_TOOL_RESULT_CHARS = 64 * 1024;
/** What the import may send: under the runtime's 16 MB cap, with room for the note. */
export const MAX_IMPORT_BYTES = 15 * 1024 * 1024;
/** Where the full original transcript is saved in the agent's workspace. */
export const ARCHIVE_REQUEST_ID = "camel-migration";
export const ARCHIVE_FILE_NAME = "original-transcript.jsonl";
export const ARCHIVE_PATH = `/workspace/uploads/${ARCHIVE_REQUEST_ID}/${ARCHIVE_FILE_NAME}`;
/**
 * Old tool calls stay calls: the DO's tool names are not the runtime agent's
 * (camel__…), but every provider the runtime reaches takes calls to tools it
 * was not given (checked by the runtime team). True writes them as text.
 */
export const REWRITE_TOOL_CALLS = false;
const SUMMARY_PREFIX = "[Context Summary]";

const ARGS_PREVIEW_CHARS = 500;
const RESULT_PREVIEW_CHARS = 2_000;
const IMPORTED_ROLES = new Set(["user", "assistant", "toolResult"]);

export interface ConvertedTranscript {
  messages: AgentMessage[];
  /** Something was shortened or left out: the original is archived. */
  lossy: boolean;
  /** Not even the newest turn fits the runtime's cap: the thread cannot move. */
  tooLarge: boolean;
  /** normalized: blocks or messages changed or left out to meet the runtime's import validator. */
  stats: { total: number; imported: number; droppedRoles: number; shortenedResults: number; omittedImages: number; normalized: number; tail: boolean };
}

type Block = Record<string, unknown> & { type?: string };

function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = (left: number) => `\n\n[… ${left} characters left out; see ${ARCHIVE_PATH} …]\n\n`;
  const half = Math.floor((max - marker(text.length).length) / 2);
  return `${text.slice(0, half)}${marker(text.length - 2 * half)}${text.slice(-half)}`;
}

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as Block[]).map((block) => (block.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

const isObject = (value: unknown): value is Block => !!value && typeof value === "object" && !Array.isArray(value);

type ConvertStats = ConvertedTranscript["stats"];

/**
 * A user message's or tool result's blocks as the runtime's import takes them
 * (its validator: text, and images with their bytes and type). Images the DO
 * keeps in storage (a reference, no bytes) and any other block become a note
 * pointing at the archive.
 */
function inputBlocks(blocks: unknown[], stats: ConvertStats): Block[] {
  return blocks.flatMap((block): Block[] => {
    if (!isObject(block)) {
      stats.normalized++;
      return [];
    }
    if (block.type === "text") {
      if (typeof block.text === "string") return [{ type: "text", text: block.text }];
      stats.normalized++;
      return [];
    }
    if (block.type === "image") {
      if (typeof block.data === "string" && block.data && typeof block.mimeType === "string" && block.mimeType) {
        return [{ type: "image", data: block.data, mimeType: block.mimeType }];
      }
      stats.omittedImages++;
      return [{ type: "text", text: `[image left out of the import; see ${ARCHIVE_PATH}]` }];
    }
    stats.normalized++;
    return [{ type: "text", text: `[${String(block.type ?? "content")} left out of the import; see ${ARCHIVE_PATH}]` }];
  });
}

/** A toolCall's arguments as the runtime takes them: an object (a JSON string parsed, anything else wrapped). */
function toolArguments(value: unknown, stats: ConvertStats): Record<string, unknown> {
  if (isObject(value)) return value;
  stats.normalized++;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (isObject(parsed)) return parsed;
    } catch {
      // Not JSON: wrapped below.
    }
  }
  return value === undefined || value === null ? {} : { value };
}

function preview(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

const encoder = new TextEncoder();

function byteLength(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function findLastIndex<T>(items: T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return index;
  return -1;
}

const roleOf = (message: AgentMessage | undefined) => (message as { role?: string } | undefined)?.role;
/** Where an import may start: a user message or a summary, never mid-turn (a toolResult whose call is cut off). */
const opensTurn = (message: AgentMessage) => roleOf(message) === "user" || roleOf(message) === "compactionSummary";

/**
 * A DO history as a runtime import: the user, assistant and tool messages
 * (other kinds left out), compaction summaries as the runtime's, thinking
 * unsigned, long tool results shortened, stored images left out (inline ones
 * kept). Over the cap, the model's part (the last summary and what follows)
 * is kept first and the history before it fills what room is left, newest
 * turns first; when the model's part alone is over, it keeps its summary and
 * the newest turns that fit. Deterministic: the same history always converts
 * to the same import.
 */
export function convertTranscript(source: AgentMessage[], options: { rewriteToolCalls?: boolean } = {}): ConvertedTranscript {
  const rewrite = options.rewriteToolCalls ?? REWRITE_TOOL_CALLS;
  const stats: ConvertStats = { total: source.length, imported: 0, droppedRoles: 0, shortenedResults: 0, omittedImages: 0, normalized: 0, tail: false };
  const names = new Map<string, string>();
  const out: AgentMessage[] = [];
  let lastTimestamp = 0;
  for (const raw of source) {
    const message = raw as unknown as Record<string, unknown> & { role?: string; content?: unknown };
    if (!isObject(message) || !IMPORTED_ROLES.has(String(message.role))) {
      stats.droppedRoles++;
      continue;
    }
    if (typeof message.timestamp === "number") lastTimestamp = message.timestamp;
    if (message.role === "user") {
      // The DO's compaction summary, as the runtime's: it stands in for all before it.
      const text = typeof message.content === "string" ? message.content : null;
      if (text?.startsWith(SUMMARY_PREFIX) && text.slice(SUMMARY_PREFIX.length).trim()) {
        out.push({
          role: "compactionSummary",
          summary: text.slice(SUMMARY_PREFIX.length).trim(),
          ...(typeof message.timestamp === "number" ? { timestamp: message.timestamp } : {}),
        } as unknown as AgentMessage);
        continue;
      }
      const content = typeof message.content === "string"
        ? message.content
        : inputBlocks(Array.isArray(message.content) ? message.content : [], stats);
      out.push({ ...message, content } as unknown as AgentMessage);
      continue;
    }
    if (message.role === "assistant") {
      const blocks: unknown[] = typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : Array.isArray(message.content) ? message.content : [];
      const content = blocks.flatMap((block): Block[] => {
        if (!isObject(block)) {
          stats.normalized++;
          return [];
        }
        if (block.type === "text") {
          if (typeof block.text === "string") return [block];
          stats.normalized++;
          return [];
        }
        if (block.type === "thinking") {
          // A signature is checked by the model that made it, and an import can not
          // vouch for one; unsigned, the thinking reaches the model as text.
          if (block.redacted || typeof block.thinking !== "string") return [];
          const { thinkingSignature: _signature, ...unsigned } = block;
          return [unsigned];
        }
        if (block.type === "toolCall") {
          const name = typeof block.name === "string" && block.name ? block.name : null;
          if (typeof block.id !== "string" || !block.id || !name) {
            stats.normalized++;
            return [{ type: "text", text: `[called ${name ?? "a tool"}]` }];
          }
          names.set(block.id, name);
          if (rewrite) return [{ type: "text", text: `[called ${name}(${preview(block.arguments, ARGS_PREVIEW_CHARS)})]` }];
          return [{ ...block, arguments: toolArguments(block.arguments, stats) }];
        }
        stats.normalized++;
        return [];
      });
      out.push({ ...message, content } as unknown as AgentMessage);
      continue;
    }
    // toolResult
    const text = blockText(message.content);
    const shortened = shorten(text, MAX_TOOL_RESULT_CHARS);
    const toolCallId = typeof message.toolCallId === "string" && message.toolCallId ? message.toolCallId : null;
    const toolName = typeof message.toolName === "string" && message.toolName
      ? message.toolName
      : (toolCallId && names.get(toolCallId)) || "tool";
    if (rewrite) {
      if (Array.isArray(message.content)) stats.omittedImages += (message.content as Block[]).filter((block) => isObject(block) && block.type === "image").length;
      out.push({
        role: "user",
        content: `[${toolName} ${message.isError ? "error" : "result"}] ${preview(shortened, RESULT_PREVIEW_CHARS)}`,
        timestamp: typeof message.timestamp === "number" ? message.timestamp : lastTimestamp,
      } as AgentMessage);
      if (text.length > RESULT_PREVIEW_CHARS) stats.shortenedResults++;
      continue;
    }
    // A result that answers no call cannot be imported as one.
    if (!toolCallId) {
      stats.normalized++;
      continue;
    }
    if (shortened !== text) stats.shortenedResults++;
    const images = Array.isArray(message.content)
      ? inputBlocks((message.content as unknown[]).filter((block) => isObject(block) && block.type === "image"), stats)
      : [];
    out.push({ ...message, toolCallId, toolName, content: [{ type: "text", text: shortened }, ...images] } as unknown as AgentMessage);
  }

  const fitted = fitImport(out);
  if (!fitted) return { messages: [], lossy: true, tooLarge: true, stats: { ...stats, tail: true } };
  stats.tail = fitted.length < out.length;
  stats.imported = fitted.length;
  const lossy = stats.droppedRoles > 0 || stats.shortenedResults > 0 || stats.omittedImages > 0 || stats.normalized > 0 || stats.tail;
  return { messages: fitted, lossy, tooLarge: false, stats };
}

/**
 * The messages that fit MAX_IMPORT_BYTES (the array as JSON), or null when
 * not even the newest turn does. Each message is measured once.
 */
function fitImport(messages: AgentMessage[]): AgentMessage[] | null {
  const sizes = messages.map((message) => byteLength(message));
  // suffix[i]: the JSON bytes of messages[i..] as an array.
  const suffix = Array.from({ length: messages.length + 1 }, () => 2);
  for (let index = messages.length - 1; index >= 0; index--) {
    suffix[index] = suffix[index + 1] + sizes[index] + (index < messages.length - 1 ? 1 : 0);
  }
  if (suffix[0] <= MAX_IMPORT_BYTES) return messages;

  const summaryAt = findLastIndex(messages, (message) => roleOf(message) === "compactionSummary");
  const modelFrom = Math.max(summaryAt, 0);
  if (suffix[modelFrom] <= MAX_IMPORT_BYTES && summaryAt >= 0) {
    // The model's part fits: fill the rest with the newest earlier turns that do.
    let start = modelFrom;
    for (let index = modelFrom - 1; index >= 0; index--) {
      if (suffix[index] > MAX_IMPORT_BYTES) break;
      if (opensTurn(messages[index])) start = index;
    }
    return messages.slice(start);
  }
  // The model's part alone is over: its summary, then the newest turns that fit.
  const summary = summaryAt >= 0 ? messages[summaryAt] : null;
  const budget = MAX_IMPORT_BYTES - (summary ? sizes[summaryAt] + 1 : 0);
  for (let index = modelFrom + (summary ? 1 : 0); index < messages.length; index++) {
    if (opensTurn(messages[index]) && suffix[index] <= budget) {
      return summary ? [summary, ...messages.slice(index)] : messages.slice(index);
    }
  }
  return null;
}

/**
 * The note a moved thread's model reads, after the last compaction summary
 * (or first): the conversation came from the old engine, and where the full
 * original is when the import is not all of it.
 */
export function importNote(archived: boolean, timestamp: number): AgentMessage {
  const text = archived
    ? `[This conversation was moved here from camelAI's previous chat engine. Some of its earlier messages were shortened or left out in the move; the full original transcript is at ${ARCHIVE_PATH}.]`
    : "[This conversation was moved here from camelAI's previous chat engine, with all of its messages.]";
  return { role: "user", content: `<camelai system message>${text}</camelai system message>`, timestamp } as AgentMessage;
}

/** The import with its note, after the last compaction summary; stamped from its neighbours, so it never changes. */
export function withImportNote(messages: AgentMessage[], archived: boolean): AgentMessage[] {
  if (messages.length === 0) return [];
  const noteAt = findLastIndex(messages, (message) => roleOf(message) === "compactionSummary") + 1;
  const neighbour = (messages[noteAt] ?? messages[noteAt - 1]) as { timestamp?: unknown } | undefined;
  const timestamp = typeof neighbour?.timestamp === "number" ? neighbour.timestamp : 0;
  return [...messages.slice(0, noteAt), importNote(archived, timestamp), ...messages.slice(noteAt)];
}

export type RuntimeMigrationResult =
  | { status: "migrated"; row: ThreadRuntimeRecord; stats: ConvertedTranscript["stats"]; archived: boolean }
  | { status: "adopted" | "runtime"; row: ThreadRuntimeRecord }
  | { status: "busy"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "dry_run"; stats: ConvertedTranscript["stats"]; lossy: boolean; bytes: number };

/** What ChatThreadDO#migrateToRuntime answers: a result, or "relay" (the worker adopts its agent). */
export type DoMigrationResult = RuntimeMigrationResult | { status: "relay" };

export interface DoMigrationRequest {
  context: ChatContextState;
  /** Who the agent acts for (its `subject`). */
  subject: string | null;
  dryRun?: boolean;
}

function orgStub(env: ChatEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as {
    getThread(id: string): Promise<OrgThread | null>;
    getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
    getMember(userId: string): Promise<OrgMember | null>;
    getMembers(): Promise<OrgMember[]>;
  };
}

/**
 * Who a moved thread's agent acts for: its creator when that is a member;
 * for a channel thread (created by "slack", "telegram", …) the member who
 * connected the channel; else (a "system" scheduled thread) the org's owner.
 */
async function migrationSubject(env: ChatEnv, thread: OrgThread, context: ChatContextState): Promise<string | null> {
  const org = orgStub(env, context.orgId);
  const creator = thread.created_by?.trim();
  if (creator && await org.getMember(creator)) return creator;
  if (thread.channel_connection_id && env.WORKSPACE) {
    const integration = await env.WORKSPACE.get(env.WORKSPACE.idFromName(context.workspaceId))
      .getIntegration(thread.channel_connection_id)
      .catch(() => null);
    const owner = integration?.created_by?.trim();
    if (owner) return owner;
  }
  const members = await org.getMembers();
  return members.find((member) => member.role === "owner")?.user_id ?? context.userId ?? null;
}

/**
 * Move a thread to the runtime, or say why not. Only a thread of
 * `context.workspaceId` moves; one already on the runtime, or one the DO
 * relays (adopted), needs no import. `dryRun` converts and reports without
 * moving anything.
 */
export async function migrateThreadToRuntime(
  env: ChatEnv,
  context: ChatContextState,
  options: { dryRun?: boolean } = {},
): Promise<RuntimeMigrationResult> {
  if (!runtimeDirectThreadsEnabled(env)) return { status: "skipped", reason: "direct threads are off" };
  const org = orgStub(env, context.orgId);
  const thread = await org.getThread(context.threadId);
  if (!thread || thread.workspace_id !== context.workspaceId) return { status: "skipped", reason: "not a thread of this workspace" };
  const existing = await org.getThreadRuntime(context.threadId);
  if (existing) return { status: "runtime", row: existing };
  const chat = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(context.threadId)) as unknown as {
    runtimeMigrationStatus(): Promise<{ state: "moving" | "moved" | "backoff" | null; retryAt?: number }>;
    migrateToRuntime(request: DoMigrationRequest): Promise<DoMigrationResult>;
  };
  // One cheap question first: a thread moving, moved or backing off needs none of the reads below.
  if (!options.dryRun) {
    const { state } = await chat.runtimeMigrationStatus();
    if (state === "moving") return { status: "busy", reason: "moving" };
    if (state === "moved") return { status: "skipped", reason: "moved" };
    if (state === "backoff") return { status: "skipped", reason: "backoff" };
  }
  // A model the runtime cannot run yet (a custom endpoint, Bedrock's OpenAI models) stays here.
  try {
    const { route } = await resolveThreadRuntimeRoute(env, context, { persistFallback: false });
    if (!route) return { status: "skipped", reason: "no runtime route for its model" };
  } catch (error) {
    return { status: "skipped", reason: `its model did not resolve: ${error instanceof Error ? error.message : String(error)}` };
  }
  const subject = await migrationSubject(env, thread, context);
  const result = await chat.migrateToRuntime({ context, subject, dryRun: options.dryRun });
  if (result.status !== "relay") return result;
  if (options.dryRun) return { status: "skipped", reason: "relay (adopted, no import)" };
  const row = await directRuntimeRow(env, context.orgId, context.threadId, { adopt: true });
  return row ? { status: "adopted", row } : { status: "busy", reason: "relay turn running" };
}
