/**
 * Moving a ChatThreadDO thread to the agent runtime: its whole pi transcript
 * becomes the history of a new runtime agent (`initialMessages` on create),
 * its UI state moves to OrgDO, and its thread_runtime row (the commit point:
 * every entry path routes by it) makes it a direct runtime thread. A thread
 * the DO relays to a runtime agent is adopted instead (channel-turns.ts).
 *
 * Nothing is half-moved: until the row is written the DO holds the thread (no
 * new turns) under a lease, and any failure before it releases the lease and
 * deletes the agent it made, so the thread carries on on the DO.
 *
 * Anything the import cannot carry whole (a huge tool result, an image, a
 * history over the runtime's cap) is shortened, and the full original
 * transcript is saved to the agent's workspace; the imported history opens
 * with a note that says where.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ChatContextState, ChatEnv } from "../chat-thread/types.js";
import type { ThreadRuntimeRecord } from "../identity/org-do.js";
import type { PreviewTarget } from "../../../../src/types.js";
import { RuntimeApiError, runtimeApi, runtimeUrl } from "./runtime-api.js";
import { directRuntimeRow } from "./channel-turns.js";
import { resolveThreadRuntimeRoute, runtimeSystemPromptAppend } from "./run-gates.js";
import { runtimeDirectThreadsEnabled } from "./thread-runtime.js";

/** What a DO hands over when a move begins. */
export type RuntimeMigrationExport =
  | { status: "ok"; leaseId: string; messages: AgentMessage[]; previewTabs: PreviewTarget[]; previewActiveTabId: string | null }
  | { status: "busy"; reason: "moving" | "running" | "automation" | "question" }
  | { status: "relay" }
  | { status: "moved" };

/** A DO's record of a move: in progress under a lease, or done. */
export interface RuntimeMigrationRecord {
  leaseId: string;
  startedAt: number;
  expiresAt: number;
  movedAt?: number;
  agentId?: string;
}

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
  stats: { total: number; imported: number; droppedRoles: number; shortenedResults: number; omittedImages: number; tail: boolean };
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

/**
 * Images with their bytes inline go as they are; ones the DO keeps in storage
 * (a reference, no bytes) become a note pointing at the archive.
 */
function inlineImages(blocks: Block[], stats: { omittedImages: number }): Block[] {
  return blocks.map((block) => {
    if (block.type !== "image") return block;
    if (typeof block.data === "string" && block.data) {
      const { metadata: _metadata, ...image } = block;
      return image;
    }
    stats.omittedImages++;
    return { type: "text", text: `[image left out of the import; see ${ARCHIVE_PATH}]` };
  });
}

function preview(value: unknown, max: number): string {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/**
 * A DO transcript as a runtime import: the user, assistant and tool messages
 * (other kinds left out), compaction summaries as the runtime's, thinking
 * unsigned, long tool results shortened, stored images left out (inline ones
 * kept), and, over the cap, the latest context (from the last compaction
 * summary, else the newest messages that fit).
 */
export function convertTranscript(source: AgentMessage[], options: { rewriteToolCalls?: boolean } = {}): ConvertedTranscript {
  const rewrite = options.rewriteToolCalls ?? REWRITE_TOOL_CALLS;
  const stats = { total: source.length, imported: 0, droppedRoles: 0, shortenedResults: 0, omittedImages: 0, tail: false };
  const names = new Map<string, string>();
  const out: AgentMessage[] = [];
  for (const raw of source) {
    const message = raw as unknown as Record<string, unknown> & { role?: string; content?: unknown };
    if (!message || !IMPORTED_ROLES.has(String(message.role))) {
      stats.droppedRoles++;
      continue;
    }
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
      const content = Array.isArray(message.content) ? inlineImages(message.content as Block[], stats) : message.content;
      out.push({ ...message, content } as unknown as AgentMessage);
      continue;
    }
    if (message.role === "assistant") {
      const blocks = Array.isArray(message.content) ? (message.content as Block[]) : [];
      for (const block of blocks) {
        if (block.type === "toolCall" && typeof block.id === "string" && typeof block.name === "string") names.set(block.id, block.name);
      }
      const content = blocks.flatMap((block): Block[] => {
        if (rewrite && block.type === "toolCall") {
          return [{ type: "text", text: `[called ${String(block.name)}(${preview(block.arguments, ARGS_PREVIEW_CHARS)})]` }];
        }
        if (block.type !== "thinking") return [block];
        // A signature is checked by the model that made it, and an import can not
        // vouch for one; unsigned, the thinking reaches the model as text.
        if (block.redacted) return [];
        const { thinkingSignature: _signature, ...unsigned } = block;
        return [unsigned];
      });
      out.push({ ...message, content } as unknown as AgentMessage);
      continue;
    }
    // toolResult
    const text = blockText(message.content);
    const shortened = shorten(text, MAX_TOOL_RESULT_CHARS);
    if (rewrite) {
      if (Array.isArray(message.content)) stats.omittedImages += (message.content as Block[]).filter((block) => block.type === "image").length;
      const name = typeof message.toolName === "string" ? message.toolName : names.get(String(message.toolCallId)) ?? "tool";
      out.push({
        role: "user",
        content: `[${name} ${message.isError ? "error" : "result"}] ${preview(shortened, RESULT_PREVIEW_CHARS)}`,
        timestamp: typeof message.timestamp === "number" ? message.timestamp : Date.now(),
      } as AgentMessage);
      if (text.length > RESULT_PREVIEW_CHARS) stats.shortenedResults++;
    } else {
      if (shortened !== text) stats.shortenedResults++;
      const images = Array.isArray(message.content) ? inlineImages((message.content as Block[]).filter((block) => block.type === "image"), stats) : [];
      out.push({ ...message, content: [{ type: "text", text: shortened }, ...images] } as unknown as AgentMessage);
    }
  }
  let messages = out;
  if (byteLength(messages) > MAX_IMPORT_BYTES) {
    stats.tail = true;
    const summaryAt = findLastIndex(messages, (message) => (message.role as string) === "compactionSummary");
    if (summaryAt > 0) messages = messages.slice(summaryAt);
    while (messages.length > 1 && byteLength(messages) > MAX_IMPORT_BYTES) messages = messages.slice(Math.ceil(messages.length / 10));
  }
  stats.imported = messages.length;
  const lossy = stats.droppedRoles > 0 || stats.shortenedResults > 0 || stats.omittedImages > 0 || stats.tail;
  return { messages, lossy, stats };
}

function byteLength(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length;
}

function findLastIndex<T>(items: T[], test: (item: T) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) if (test(items[index])) return index;
  return -1;
}

/** The note that opens an import: where it came from, and where the original is when this is not all of it. */
export function importNote(lossy: boolean, importedAt: number): AgentMessage {
  const text = lossy
    ? `[This conversation was moved from camelAI's previous chat engine. Some of its earlier history was shortened or left out here; the full original transcript is at ${ARCHIVE_PATH}.]`
    : "[This conversation was moved from camelAI's previous chat engine; its history continues below.]";
  return { role: "user", content: `<camelai system message>${text}</camelai system message>`, timestamp: importedAt } as AgentMessage;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type RuntimeMigrationResult =
  | { status: "migrated"; row: ThreadRuntimeRecord; stats: ConvertedTranscript["stats"]; archived: boolean }
  | { status: "adopted" | "runtime"; row: ThreadRuntimeRecord }
  | { status: "busy"; reason: string }
  | { status: "skipped"; reason: string }
  | { status: "failed"; error: string }
  | { status: "dry_run"; stats: ConvertedTranscript["stats"]; lossy: boolean; bytes: number };

function orgStub(env: ChatEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as unknown as {
    getThread(id: string): Promise<{ created_by?: string | null } | null>;
    getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
    setThreadRuntimeAgent(threadId: string, update: {
      agentId: string;
      model: string | null;
      keyScope: string | null;
      configured?: Record<string, unknown> | null;
    }): Promise<ThreadRuntimeRecord | null>;
    setThreadUiState(threadId: string, preview: Record<string, unknown> | null): Promise<unknown>;
  };
}

/**
 * A thread's agent, made with a history (initialMessages) and no model or
 * configuration: the thread's first send configures it. The same history
 * always makes the same agent (a retry adopts it); a changed one makes a new
 * one, never an agent with stale history.
 */
export async function createAgentWithHistory(
  env: ChatEnv,
  context: ChatContextState,
  initialMessages: AgentMessage[],
  purpose: "migrate" | "fork",
): Promise<string> {
  const thread = await orgStub(env, context.orgId).getThread(context.threadId);
  const subject = thread?.created_by?.trim() || context.userId || "";
  const key = `${purpose}_${context.threadId}_${(await sha256Hex(JSON.stringify(initialMessages))).slice(0, 16)}`;
  const created = await runtimeApi(env, "POST", "/v1/agents", {
    definition: env.AGENT_RUNTIME_DEFINITION,
    name: context.threadId,
    type: "camelai-thread",
    ttlSeconds: null,
    systemPromptAppend: runtimeSystemPromptAppend(env, context),
    fileTools: false,
    ...(subject ? { subject } : {}),
    context: { org: context.orgId, workspace: context.workspaceId, thread: context.threadId },
    ...(initialMessages.length ? { initialMessages } : {}),
  }, { "Idempotency-Key": key }) as { id?: unknown };
  if (typeof created?.id !== "string") throw new Error("Agent runtime returned no agent id");
  return created.id;
}

/** Delete an agent a failed move or fork made (one already gone is fine). */
export async function deleteUnusedAgent(env: ChatEnv, agentId: string): Promise<void> {
  await runtimeApi(env, "DELETE", `/v1/agents/${encodeURIComponent(agentId)}`).catch((cause: unknown) => {
    if (!(cause instanceof RuntimeApiError && cause.status === 404)) console.warn("[runtime-thread] could not delete an unused agent", cause);
  });
}

function doStub(env: ChatEnv, threadId: string) {
  return env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(threadId)) as unknown as {
    beginRuntimeMigration(): Promise<RuntimeMigrationExport>;
    abortRuntimeMigration(leaseId: string): Promise<boolean>;
    completeRuntimeMigration(leaseId: string, agentId: string): Promise<boolean>;
  };
}

export async function archiveTranscript(env: ChatEnv, agentId: string, messages: AgentMessage[]): Promise<void> {
  const body = messages.map((message) => JSON.stringify(message)).join("\n");
  const response = await fetch(
    `${runtimeUrl(env)}/v1/agents/${encodeURIComponent(agentId)}/uploads/${ARCHIVE_REQUEST_ID}/${ARCHIVE_FILE_NAME}`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`,
        "Content-Type": "application/x-ndjson",
      },
      body,
    },
  );
  await response.body?.cancel();
  if (!response.ok) throw new Error(`Could not save the original transcript: HTTP ${response.status}`);
}

/**
 * Move a thread to the runtime (see the module comment), or say why not. A
 * thread already on the runtime, or one the DO relays (adopted), needs no
 * import. `dryRun` converts and reports without moving anything.
 */
export async function migrateThreadToRuntime(
  env: ChatEnv,
  context: ChatContextState,
  options: { dryRun?: boolean } = {},
): Promise<RuntimeMigrationResult> {
  if (!runtimeDirectThreadsEnabled(env)) return { status: "skipped", reason: "direct threads are off" };
  const org = orgStub(env, context.orgId);
  const existing = await org.getThreadRuntime(context.threadId);
  if (existing) return { status: "runtime", row: existing };
  // A model the runtime cannot run yet (a custom endpoint, Bedrock's OpenAI models) stays here.
  try {
    const { route } = await resolveThreadRuntimeRoute(env, context, { persistFallback: false });
    if (!route) return { status: "skipped", reason: "no runtime route for its model" };
  } catch (error) {
    return { status: "skipped", reason: `its model did not resolve: ${error instanceof Error ? error.message : String(error)}` };
  }
  const handover = await doStub(env, context.threadId).beginRuntimeMigration();
  if (handover.status === "relay") {
    if (options.dryRun) return { status: "skipped", reason: "relay (adopted, no import)" };
    const row = await directRuntimeRow(env, context.orgId, context.threadId, { adopt: true });
    return row ? { status: "adopted", row } : { status: "busy", reason: "relay turn running" };
  }
  if (handover.status === "moved") return { status: "skipped", reason: "moved" };
  if (handover.status === "busy") return { status: "busy", reason: handover.reason };

  const dostub = doStub(env, context.threadId);
  const { leaseId } = handover;
  let agentId: string | null = null;
  try {
    const converted = convertTranscript(handover.messages);
    const importedAt = Date.now();
    // After the last compaction summary: the model sees nothing before it.
    const noteAt = findLastIndex(converted.messages, (message) => (message.role as string) === "compactionSummary") + 1;
    const initialMessages = handover.messages.length
      ? [...converted.messages.slice(0, noteAt), importNote(converted.lossy, importedAt), ...converted.messages.slice(noteAt)]
      : [];
    if (options.dryRun) {
      await dostub.abortRuntimeMigration(leaseId);
      return { status: "dry_run", stats: converted.stats, lossy: converted.lossy, bytes: byteLength(initialMessages) };
    }
    agentId = await createAgentWithHistory(env, context, initialMessages, "migrate");
    if (converted.lossy) await archiveTranscript(env, agentId, handover.messages);
    if (handover.previewTabs.length) {
      await org.setThreadUiState(context.threadId, { tabs: handover.previewTabs, activeTabId: handover.previewActiveTabId });
    }
    // The commit: from here every entry path runs the thread on the runtime.
    // No model or configuration is recorded, so the first send configures the
    // agent for the thread's model, key scope and instructions.
    const row = await org.setThreadRuntimeAgent(context.threadId, { agentId, model: null, keyScope: null, configured: null });
    if (!row) throw new Error("Thread not found");
    await dostub.completeRuntimeMigration(leaseId, agentId).catch((error: unknown) =>
      console.warn("[runtime-migration] the DO did not record the move; its lease runs out", error));
    return { status: "migrated", row, stats: converted.stats, archived: converted.lossy };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (agentId) await deleteUnusedAgent(env, agentId);
    await dostub.abortRuntimeMigration(leaseId).catch(() => false);
    return { status: "failed", error: message };
  }
}
