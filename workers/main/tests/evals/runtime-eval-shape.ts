/**
 * The pure parts of running an eval on the agent runtime (runtime-eval.ts):
 * waiting on the run's request record, reading its outcome, and shaping the
 * agent's history into what ChatThreadDO.runAgentEvalSession returned (parsed
 * messages and chat events), so the graders, the signal and the LLM judge read
 * a runtime run as they read an in-DO one.
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { localToolName } from "../../../../src/lib/agent-runtime-shared";
import { addPiRuntimeUsageSummaries, piRuntimeUsageSummary } from "../../src/chat-thread/pi-message-helpers";

/** The runtime's record of one request (GET /v1/agents/:id/requests/:requestId). */
export interface RuntimeRequestRecord {
  id: string;
  state: "running" | "completed";
  error?: string;
  stopped?: "input_required" | "spend_limit";
  steeredInto?: string;
  outcome?: {
    error?: string;
    uncertain?: boolean;
    result?: {
      reply?: string;
      error?: string | null;
      stopped?: string;
      inputs?: Array<{ id: string; kind?: string; message?: string }>;
      toolErrors?: Array<Record<string, unknown>>;
      sourceErrors?: Array<Record<string, unknown>>;
    };
  };
}

export type RuntimeRequestWait =
  | { status: "settled"; record: RuntimeRequestRecord }
  | { status: "timeout"; record: RuntimeRequestRecord | null };

/**
 * Poll a request until the runtime settles it or `deadline` passes. Polling
 * the durable record, not the event stream or the webhook: the runtime's docs
 * name the record as the truth ("events are for display"), it needs no
 * inbound route to chiridion, and a dropped poll is just retried. A 404 early
 * on is a request not yet recorded; `read` returns null for it.
 */
export async function waitForRuntimeRequest(options: {
  read: () => Promise<RuntimeRequestRecord | null>;
  deadline: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<RuntimeRequestWait> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = options.pollMs ?? 1_000;
  let last: RuntimeRequestRecord | null = null;
  while (true) {
    try {
      last = (await options.read()) ?? last;
    } catch (error) {
      // A transient failure reading the record; the deadline bounds retries.
      console.warn("[runtime-eval] reading the request failed; retrying", error);
    }
    if (last?.state === "completed") return { status: "settled", record: last };
    const left = options.deadline - now();
    if (left <= 0) return { status: "timeout", record: last };
    await sleep(Math.min(pollMs, left));
  }
}

export type RuntimeRunOutcome =
  | { status: "completed"; reply?: string }
  | { status: "error"; error: string; reply?: string }
  | { status: "input_required"; inputIds: string[]; reply?: string };

/** What a settled request says happened: the runtime's error, the model's, an early stop, or the reply. */
export function runtimeRunOutcome(record: RuntimeRequestRecord): RuntimeRunOutcome {
  const result = record.outcome?.result;
  const reply = typeof result?.reply === "string" ? result.reply : undefined;
  const stopped = record.stopped ?? result?.stopped;
  if (stopped === "input_required") {
    return { status: "input_required", inputIds: (result?.inputs ?? []).map((input) => input.id).filter(Boolean), reply };
  }
  const error = record.error ?? record.outcome?.error ?? result?.error ?? undefined;
  if (error) return { status: "error", error: record.outcome?.uncertain ? `${error} (outcome uncertain)` : error, reply };
  if (stopped === "spend_limit") return { status: "error", error: "The run reached its spend limit", reply };
  return { status: "completed", reply };
}

type Record_ = Record<string, unknown>;

function isRecord(value: unknown): value is Record_ {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * The agent's history with chiridion's tools under their own names
 * (`camel__deploy_project` → `deploy_project`), as the chat shows them and as
 * the in-DO loop named them, which is what the evals' checks look for.
 */
export function localizeRuntimeHistory(messages: AgentMessage[]): AgentMessage[] {
  return messages.map((message) => {
    const record = message as unknown as Record_;
    if (record.role === "assistant" && Array.isArray(record.content)) {
      return {
        ...record,
        content: record.content.map((block) =>
          isRecord(block) && block.type === "toolCall" ? { ...block, name: localToolName(block.name) } : block),
      } as unknown as AgentMessage;
    }
    if (record.role === "toolResult") {
      return { ...record, toolName: localToolName(record.toolName) } as unknown as AgentMessage;
    }
    return message;
  });
}

function assistantText(message: Record_): string {
  return Array.isArray(message.content)
    ? message.content.flatMap((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("")
    : "";
}

function runtimeEvent(method: string, params: Record_): Record_ {
  return { type: "runtime_event", event: { method, params } };
}

/**
 * The chat events ChatThreadDO emitted for a run (pushPiRuntimeEvent and the
 * final `result`), rebuilt from the run's messages: per model response an
 * `sdk/turn/started`, each tool call's `item/completed` with its result, the
 * text as an `agentMessage` item, and `sdk/turn/completed` with its usage;
 * then `turn/completed` and, for a run that answered, `result`. The runtime
 * streams its own events, but the history is the durable record of what ran.
 */
export function runtimeEvalEvents(input: {
  threadId: string;
  /** The messages this run added to the history (localized). */
  messages: AgentMessage[];
  status: "completed" | "error";
  reply?: string;
  error?: string;
  startedAtMs: number;
  completedAtMs: number;
}): Array<Record_> {
  const { threadId } = input;
  const events: Array<Record_> = [];
  const results = new Map<string, Record_>();
  for (const message of input.messages) {
    const record = message as unknown as Record_;
    if (record.role === "toolResult" && typeof record.toolCallId === "string") results.set(record.toolCallId, record);
  }
  let sdkTurnIndex = 0;
  let usageTotal: Record<string, unknown> | null = null;
  for (const message of input.messages) {
    const record = message as unknown as Record_;
    if (record.role !== "assistant") continue;
    sdkTurnIndex += 1;
    events.push(runtimeEvent("sdk/turn/started", { threadId, sdkTurnIndex }));
    for (const block of Array.isArray(record.content) ? record.content : []) {
      if (!isRecord(block) || block.type !== "toolCall") continue;
      const id = typeof block.id === "string" ? block.id : `runtime_tool_${sdkTurnIndex}`;
      const result = results.get(id);
      const isError = result ? result.isError === true : true;
      events.push(runtimeEvent("item/completed", {
        threadId,
        item: {
          id,
          type: "dynamicToolCall",
          tool: localToolName(block.name),
          arguments: isRecord(block.arguments) ? block.arguments : {},
          status: isError ? "failed" : "completed",
          isError,
          result: result
            ? { content: result.content, ...(isRecord(result.details) ? { details: result.details } : {}) }
            : { content: [{ type: "text", text: "The tool call has no result in the agent's history." }] },
        },
      }));
    }
    const text = assistantText(record);
    if (text) {
      events.push(runtimeEvent("item/completed", {
        threadId,
        item: { id: `runtime_agent_${sdkTurnIndex}`, type: "agentMessage", text },
      }));
    }
    const usage = piRuntimeUsageSummary(message);
    usageTotal = addPiRuntimeUsageSummaries(usageTotal, usage);
    events.push(runtimeEvent("sdk/turn/completed", { threadId, sdkTurnIndex, ...(usage ? { usage } : {}) }));
  }
  events.push(runtimeEvent("turn/completed", {
    threadId,
    completedAtMs: input.completedAtMs,
    turnDurationMs: Math.max(0, input.completedAtMs - input.startedAtMs),
    sdkTurnCount: sdkTurnIndex,
    ...(usageTotal ? { usage: usageTotal } : {}),
  }));
  if (input.status === "completed") {
    events.push({ type: "result", threadId, result: input.reply ?? "", sessionId: threadId, completedAt: input.completedAtMs });
  } else {
    events.push({ type: "error", threadId, title: "Agent runtime error", message: input.error ?? "The run failed" });
  }
  return events;
}

/** The final assistant text of a run's messages, for a run whose record carries no reply. */
export function latestAssistantReply(messages: AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const record = messages[index] as unknown as Record_;
    if (record.role !== "assistant") continue;
    const text = assistantText(record);
    if (text) return text;
  }
  return undefined;
}
