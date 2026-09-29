/**
 * The view of a runtime thread (plans/runtime-threads-direct.md §5.3): the
 * agent's Pi messages, as the runtime keeps them, projected onto the `Message`
 * view model the chat renderer draws. Pure and recomputed per render; nothing
 * here is stored or sent.
 *
 * - A user message is a user bubble; its sender (`from.name`) is the author.
 * - Everything the agent did between two user messages (its assistant
 *   messages and their tool results) is one assistant message, as a turn is
 *   one message on ChatThreadDO's path; each tool result follows its call.
 * - Tool calls are shaped as the DO's live path shapes them (the same tool
 *   names and inputs, through pi-tool-builders), so every tool view works.
 * - An aborted response ends with "Stopped by user"; a failed one with an
 *   error block.
 */
import type { AgentMessage, AssistantMessage } from "@/lib/agent-messages";
import type { ContentBlock, ErrorBlock, FileBlock, Message, ToolResultBlock } from "@/types";
import { localToolName, readableProviderError } from "@/lib/agent-runtime-shared";
import { parseUploadRefs } from "@/lib/chat-attachment-refs";
import {
  buildToolResultFromPiItem,
  buildToolUseFromPiItem,
  type PiThreadItem,
} from "@/lib/pi-tool-builders";

function isAgentProgressTool(name: string): boolean {
  return name === "Task" || name === "Agent" || name === "agent" ||
    name === "Explore" || name === "explore" || name === "Research" ||
    name === "Oracle";
}

/** Splice a running tool's live output after its tool_use, until its settled
 * tool_result replaces it. Returns the message unchanged (same identity) when
 * nothing merges. */
export function mergeLiveToolOutput(
  message: Message,
  toolStream: Map<string, string>,
): Message {
  if (typeof message.content === "string") return message;
  const settled = new Set<string>();
  for (const block of message.content) {
    if (block.type === "tool_result") settled.add(block.tool_use_id);
  }
  const next: ContentBlock[] = [];
  let changed = false;
  for (const block of message.content) {
    next.push(block);
    if (block.type === "tool_use" && !settled.has(block.id)) {
      const liveText = toolStream.get(block.id);
      if (liveText) {
        next.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: liveText,
          status: "succeeded",
          ...(isAgentProgressTool(block.name) ? { isTaskUpdate: true } : {}),
          itemId: block.id,
          ...(block.itemKind ? { itemKind: block.itemKind } : {}),
        });
        changed = true;
      }
    }
  }
  return changed ? { ...message, content: next } : message;
}

const STOPPED_BY_USER_TEXT = "Stopped by user";

type Part = {
  type?: string; text?: string; thinking?: string; redacted?: boolean; thinkingSignature?: string;
  id?: string; name?: string; arguments?: unknown;
  /** A file reference (`type: "file"`): the path as the agent sees it, its size and type. */
  path?: string; size?: number; contentType?: string;
  /** An inline image (`type: "image"`): its base64 bytes and type. */
  data?: string; mimeType?: string;
};
type PiUser = {
  role: "user";
  content: string | Part[];
  timestamp?: number;
  from?: { id?: string; name?: string; username?: string };
  /** The request that sent it: chiridion's client message id. */
  requestId?: string;
  /** What chiridion recorded with it (runtimeMessageMetadata): its source among others. */
  metadata?: Record<string, string>;
};
type PiToolResult = {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content?: Part[];
  details?: unknown;
  isError?: boolean;
  timestamp?: number;
};

export interface PiRenderInput {
  threadId: string;
  /** The agent's messages, oldest first, and each one's index in its history. */
  messages: readonly AgentMessage[];
  indexes: readonly number[];
  /** The assistant message streaming now. */
  partial: AssistantMessage | null;
  /** Live tool output (a running call's latest progress), by tool call id. */
  progress?: ReadonlyMap<string, unknown>;
  running: boolean;
  /** The client message id each user message was sent with, by its history index (known only for this tab's sends). */
  clientMessageIds?: ReadonlyMap<number, string>;
  /** This tab's messages sent and not in the history yet: a turn that starts now follows them. */
  pendingSends?: number;
  /** Where the running run's first message goes (its `turn_opened`), when the stream said. */
  runStartIndex?: number;
}

export interface PiRenderResult {
  messages: Message[];
  /** The turn message streaming now, if any. */
  streamingMessageId: string | null;
}

/** A message's id in the view: `rt:<its index>`, or for a turn, the index of its first message. */
export function runtimeMessageId(index: number): string {
  return `rt:${index}`;
}

/** Where chiridion serves a thread's scratch file (routes/api/threads.$id.files.$.ts). */
export function scratchFileHref(threadId: string, path: string): string {
  const segments = path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  return `/api/threads/${encodeURIComponent(threadId)}/files/${segments}`;
}

function fileBlock(threadId: string, file: { path: string; contentType?: unknown; size?: unknown; caption?: unknown }): FileBlock {
  return {
    type: "file",
    path: file.path,
    name: file.path.split("/").filter(Boolean).pop() ?? file.path,
    href: scratchFileHref(threadId, file.path),
    threadId,
    ...(typeof file.contentType === "string" && file.contentType ? { contentType: file.contentType } : {}),
    ...(typeof file.size === "number" && Number.isFinite(file.size) ? { size: file.size } : {}),
    ...(typeof file.caption === "string" && file.caption.trim() ? { caption: file.caption.trim() } : {}),
  };
}

function isImagePart(part: unknown): part is Part & { data: string; mimeType: string } {
  return isRecord(part) && part.type === "image" && typeof part.data === "string" && part.data.length > 0
    && typeof part.mimeType === "string" && part.mimeType.startsWith("image/");
}

/** An inline image a user message carries (a moved thread's, a channel's), shown as its thumbnail. */
function imageBlock(image: Part & { data: string; mimeType: string }, position: number): FileBlock {
  const name = `image-${position + 1}.${image.mimeType.slice("image/".length).split("+")[0] || "png"}`;
  return { type: "file", path: name, name, href: `data:${image.mimeType};base64,${image.data}`, contentType: image.mimeType };
}

function isFilePart(part: unknown): part is Part & { path: string } {
  return isRecord(part) && part.type === "file" && typeof part.path === "string" && part.path.length > 0;
}

/** A file a tool saved, as the line the model reads for it (not the reference's JSON). */
function fileLine(part: Part & { path: string }): Part {
  const size = typeof part.size === "number" ? `, ${part.size} bytes` : "";
  return { type: "text", text: `[File ${part.path} (${part.contentType ?? "file"}${size})]` };
}

/** What present_file handed over: its result (or, failing that, its arguments). */
function presentedFile(args: unknown, result: PiToolResult): { path: string; contentType?: unknown; size?: unknown; caption?: unknown } | null {
  const details = isRecord(result.details) ? result.details : (() => {
    try {
      const parsed = JSON.parse(textOf(result.content)) as unknown;
      return isRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  })();
  const path = typeof details.path === "string" ? details.path : isRecord(args) && typeof args.path === "string" ? args.path : "";
  if (!path) return null;
  return { path, contentType: details.contentType, size: details.size, caption: isRecord(args) ? args.caption : undefined };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function textOf(content: string | Part[] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (part?.type === "text" && typeof part.text === "string" ? part.text : "")).join("");
}

/** A tool call as the DO's live path describes it (a dynamicToolCall item). */
function toolItem(id: string, name: unknown, args: unknown, result?: PiToolResult): PiThreadItem {
  const tool = String(localToolName(name) || "tool");
  const argumentsValue = isRecord(args) ? args : {};
  if (!result) return { id, type: "dynamicToolCall", tool, arguments: argumentsValue, status: "inProgress" };
  const isError = result.isError === true;
  return {
    id,
    type: "dynamicToolCall",
    tool,
    arguments: argumentsValue,
    status: isError ? "failed" : "completed",
    isError,
    result: { content: result.content ?? [], details: result.details },
    contentItems: (result.content ?? []).map((part) => (isFilePart(part) ? fileLine(part) : part)),
  };
}

/**
 * A direct tool's result the runtime cut for the model ends with
 * `[Result cut at … The whole result is in /workspace/tool-results/<call>.txt: read it in parts.]`.
 */
const CUT_RESULT = /\[Result cut at [\d,]+ of [\d,]+ characters\. The whole result(?: \([^)]*\))? is in (\/workspace\/tool-results\/[^\s:\]]+): read it in parts\.\]\s*$/;

function toolResultBlock(id: string, item: PiThreadItem, result: PiToolResult, threadId: string): ToolResultBlock {
  // The status rides the call's input; the result's text is the tool's own.
  const { status: _status, ...withoutStatus } = item;
  const built = buildToolResultFromPiItem(withoutStatus as PiThreadItem);
  const isError = result.isError === true || built?.isError === true;
  const cut = CUT_RESULT.exec(textOf(result.content));
  const fullResult = cut ? { path: cut[1], href: scratchFileHref(threadId, cut[1]) } : undefined;
  const found = built?.details ?? (isRecord(result.details) ? result.details : undefined);
  const details = fullResult ? { ...found, fullResult } : found;
  return {
    type: "tool_result",
    tool_use_id: id,
    content: built?.content ?? "",
    ...(isError ? { is_error: true, status: "failed" as const } : { status: "succeeded" as const }),
    itemId: id,
    ...(details ? { details } : {}),
  };
}

/** A tool result waiting on a person: its call shows as running until the real result replaces it. */
function isInputPlaceholder(result: PiToolResult): boolean {
  return isRecord(result.details) && Boolean(result.details.inputRequired);
}

function errorBlock(message: string): ErrorBlock {
  return { type: "error", error: readableProviderError(message) };
}

/** The results of an assistant message's tool calls, in order (undefined where there is none yet). */
function toolCallResults(message: AssistantMessage, results: ReadonlyMap<string, PiToolResult>): Array<PiToolResult | undefined> {
  return ((message.content ?? []) as Part[])
    .filter((part) => part?.type === "toolCall" && typeof part.id === "string")
    .map((part) => results.get(part.id as string));
}

/** An assistant message's blocks, each tool call followed by its result when there is one. */
function assistantBlocks(message: AssistantMessage, results: ReadonlyMap<string, PiToolResult>, threadId: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  for (const part of (message.content ?? []) as Part[]) {
    if (!part) continue;
    if (part.type === "text" && typeof part.text === "string") {
      if (part.text) blocks.push({ type: "text", text: part.text });
    } else if (part.type === "thinking") {
      if (part.redacted) blocks.push({ type: "redacted_thinking" });
      else if (part.thinking) blocks.push({ type: "thinking", thinking: part.thinking, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}) });
    } else if (part.type === "toolCall" && typeof part.id === "string") {
      const result = results.get(part.id);
      const settled = result && !isInputPlaceholder(result) ? result : undefined;
      const item = toolItem(part.id, part.name, part.arguments, settled);
      const use = buildToolUseFromPiItem(item);
      blocks.push({ type: "tool_use", id: part.id, name: use?.name ?? String(item.tool), input: use?.input ?? {} });
      if (settled) blocks.push(toolResultBlock(part.id, item, settled, threadId));
      // A file the agent handed over (present_file) shows after its call, as output.
      if (settled && !settled.isError && item.tool === "present_file") {
        const presented = presentedFile(part.arguments, settled);
        if (presented) blocks.push(fileBlock(threadId, presented));
      }
    }
  }
  if (message.stopReason === "aborted") {
    blocks.push({ type: "text", text: STOPPED_BY_USER_TEXT, itemKind: "userStop" } as ContentBlock);
  } else if (message.stopReason === "error" && message.errorMessage) {
    blocks.push(errorBlock(message.errorMessage));
  }
  return blocks;
}

/** A user message's text, and its attached files and inline images as file blocks after it. */
function userContent(threadId: string, content: string | Part[]): string | ContentBlock[] {
  const text = textOf(content);
  // Uploads stay in R2 and are also attached (uploads/<request>/): the text's
  // references already show them, so their runtime copies are not shown again.
  const uploadsShown = parseUploadRefs(text).refs.length > 0;
  const files = (Array.isArray(content) ? content.filter(isFilePart) : [])
    .filter((file) => !(uploadsShown && file.path.startsWith("/workspace/uploads/")));
  const images = Array.isArray(content) ? content.filter(isImagePart) : [];
  if (files.length === 0 && images.length === 0) return text;
  return [
    ...(text ? [{ type: "text" as const, text }] : []),
    ...files.map((file) => fileBlock(threadId, file)),
    ...images.map(imageBlock),
  ];
}

function timestampOf(message: unknown): number | undefined {
  const value = isRecord(message) ? message.timestamp : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * What piRender built last time, by message id, with what it was built from:
 * a message whose sources are the same objects is the same object again, so
 * rows that did not change do not re-render on every streamed event.
 */
export type PiRenderMemo = Map<string, { sources: readonly unknown[]; message: Message }>;

function sameSources(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((source, at) => source === right[at]);
}

/** Whether a turn's last response hands off to tools (the turn goes on), rather than ending it. */
function continuesTurn(message: unknown): boolean {
  const last = message as { role?: string; stopReason?: string } | undefined;
  return last?.role === "toolResult" || (last?.role === "assistant" && last.stopReason === "toolUse");
}

/** Project a runtime thread's messages onto the chat's view model. */
export function piRender(input: PiRenderInput, memo?: PiRenderMemo): PiRenderResult {
  const { threadId, messages, indexes } = input;
  const results = new Map<string, PiToolResult>();
  for (const message of messages) {
    if ((message as { role?: string }).role === "toolResult") {
      const result = message as unknown as PiToolResult;
      results.set(result.toolCallId, result);
    }
  }

  type Group =
    | { kind: "user"; index: number; lastIndex: number; user: PiUser; clientMessageId: string | undefined }
    | { kind: "turn"; index: number; lastIndex: number; assistants: AssistantMessage[]; lastUserAt: number | undefined };
  const groups: Group[] = [];
  let lastUserAt: number | undefined;
  let open: Extract<Group, { kind: "turn" }> | null = null;
  messages.forEach((message, position) => {
    const index = indexes[position] ?? position;
    const role = (message as { role?: string }).role;
    if (role === "user") {
      open = null;
      const user = message as unknown as PiUser;
      lastUserAt = timestampOf(user);
      const clientMessageId = typeof user.requestId === "string" && user.requestId
        ? user.requestId
        : input.clientMessageIds?.get(index);
      groups.push({ kind: "user", index, lastIndex: index, user, clientMessageId });
      return;
    }
    if (role !== "assistant") {
      // A tool result belongs to its turn: forking there keeps it.
      if (open) open.lastIndex = index;
      return;
    }
    if (!open) {
      open = { kind: "turn", index, lastIndex: index, assistants: [], lastUserAt };
      groups.push(open);
    }
    open.lastIndex = index;
    open.assistants.push(message as unknown as AssistantMessage);
  });

  // The turn streaming now:
  // - a response streaming (partial) goes into the open turn when that turn
  //   goes on (its last response called tools), else it opens a new turn, at
  //   the index its first message will take (after this tab's messages still
  //   on their way). A new turn appears only with its first token.
  // - with nothing streaming, the open turn is still the running one (its
  //   tail: `running` stays true between its final message_end and
  //   agent_end) unless the run opened after it (`runStartIndex`) and has no
  //   message yet, or a message of ours is still on its way. Then no turn
  //   row shows yet, and Chat shows the send as submitted.
  let streaming: Extract<Group, { kind: "turn" }> | null = null;
  const lastMessage = messages[messages.length - 1];
  const lastGroup = groups[groups.length - 1];
  const lastIndex = indexes.length > 0 ? indexes[indexes.length - 1] : -1;
  if (input.partial) {
    if (lastGroup?.kind === "turn" && continuesTurn(lastMessage)) {
      streaming = lastGroup;
    } else {
      streaming = { kind: "turn", index: lastIndex + 1 + (input.pendingSends ?? 0), lastIndex: lastIndex + 1 + (input.pendingSends ?? 0), assistants: [], lastUserAt };
      groups.push(streaming);
    }
  } else if (input.running && !input.pendingSends && lastGroup?.kind === "turn") {
    const runStartedAfter = input.runStartIndex !== undefined && input.runStartIndex > lastIndex;
    if (!runStartedAfter) streaming = lastGroup;
  }

  const view: Message[] = [];
  const nextMemo: PiRenderMemo = new Map();
  for (const group of groups) {
    const id = group.kind === "user" && group.clientMessageId ? group.clientMessageId : runtimeMessageId(group.index);
    const isStreaming = group === streaming;
    const sources: unknown[] = group.kind === "user"
      ? [group.user, group.clientMessageId]
      : [...group.assistants, ...group.assistants.flatMap((assistant) => toolCallResults(assistant, results))];
    const previous = memo?.get(id);
    if (!isStreaming && previous && sameSources(previous.sources, sources)) {
      view.push(previous.message);
      nextMemo.set(id, previous);
      continue;
    }
    let built: Message;
    if (group.kind === "user") {
      const source = group.user.metadata?.source;
      const at = timestampOf(group.user);
      built = {
        // The client's id when it sent it: the optimistic bubble's, so its row stays.
        id,
        thread_id: threadId,
        role: "user",
        content: userContent(threadId, group.user.content),
        created_at: at ?? 0,
        ...(group.user.from?.name ? { authorDisplayName: group.user.from.name } : {}),
        ...(group.clientMessageId ? { clientMessageId: group.clientMessageId } : {}),
        ...(typeof source === "string" && source ? { messageSource: source } : {}),
      };
    } else {
      const blocks = group.assistants.flatMap((assistant) => assistantBlocks(assistant, results, threadId));
      if (isStreaming && input.partial) blocks.push(...assistantBlocks(input.partial, results, threadId).filter((block) => block.type !== "error"));
      const firstAt = timestampOf(group.assistants[0]) ?? (isStreaming ? timestampOf(input.partial) ?? Date.now() : 0);
      built = { id, thread_id: threadId, role: "assistant", content: blocks, created_at: firstAt };
      if (isStreaming) {
        built.isStreaming = true;
      } else {
        const settledAt = timestampOf(group.assistants[group.assistants.length - 1]);
        if (settledAt !== undefined) {
          built.completedAtMs = settledAt;
          if (group.lastUserAt !== undefined && settledAt >= group.lastUserAt) built.turnDurationMs = settledAt - group.lastUserAt;
        }
      }
    }
    // Where a fork from this message cuts the history (routes/api/…fork.ts).
    if (!isStreaming) built.forkEntryId = runtimeMessageId(group.lastIndex);
    view.push(built);
    if (!isStreaming) nextMemo.set(id, { sources, message: built });
  }
  if (memo) {
    memo.clear();
    for (const [id, entry] of nextMemo) memo.set(id, entry);
  }
  const streamingMessageId = streaming ? runtimeMessageId(streaming.index) : null;

  if (input.progress && input.progress.size > 0 && streamingMessageId) {
    const live = new Map<string, string>();
    for (const [toolCallId, update] of input.progress) {
      const text = isRecord(update) ? textOf(update.content as Part[]) : typeof update === "string" ? update : "";
      if (text) live.set(toolCallId, text);
    }
    const at = view.findIndex((message) => message.id === streamingMessageId);
    if (at >= 0 && live.size > 0) view[at] = mergeLiveToolOutput(view[at], live);
  }
  return { messages: view, streamingMessageId };
}

/** The todo list of the thread's latest TodoWrite call, or null when it has none. */
export function latestRuntimeTodos(messages: readonly AgentMessage[]): Array<{ content: string; status: string; activeForm: string }> | null {
  for (let at = messages.length - 1; at >= 0; at--) {
    const message = messages[at] as { role?: string; content?: Part[] };
    if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
    for (let part = message.content.length - 1; part >= 0; part--) {
      const block = message.content[part];
      if (block?.type !== "toolCall" || !isRecord(block.arguments)) continue;
      const name = String(localToolName(block.name));
      if (name !== "TodoWrite" && name !== "todo_write" && name !== "update_todo") continue;
      const list = Array.isArray(block.arguments.todos) ? block.arguments.todos : Array.isArray(block.arguments.items) ? block.arguments.items : [];
      return list.flatMap((item: unknown) => {
        if (!isRecord(item)) return [];
        const content = String(item.content ?? item.text ?? "").trim();
        if (!content) return [];
        const status = item.status === "completed" || item.status === "in_progress" ? item.status : item.status === "inProgress" ? "in_progress" : "pending";
        return [{ content, status, activeForm: String(item.activeForm ?? item.active_form ?? content) }];
      });
    }
  }
  return null;
}
