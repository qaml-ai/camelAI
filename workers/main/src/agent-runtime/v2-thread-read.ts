import type { AgentInput, Message } from "@camelai/run";
import type { ChatEnv } from "../chat-thread/types";
import { v2AgentPath, v2Fetch, v2Json, type V2Agent, type V2Input, type V2Run } from "./runtime-v2";

interface V2Message {
  seq: number;
  createdAt: number;
  role: "user" | "assistant" | "system" | "tool";
  content: {
    text?: string;
    toolCalls?: Array<{ id: string; name: string; args: Record<string, unknown> }>;
    toolCallId?: string;
    toolName?: string;
    isError?: boolean;
    meta?: { requestId?: string | null; v1?: Message };
  };
}

interface V2Event {
  seq: number;
  type: string;
  runId: string | null;
  createdAt: number;
  data: Record<string, unknown>;
}

function assistant(timestamp: number, content: Extract<Message, { role: "assistant" }>["content"] = []): Extract<Message, { role: "assistant" }> {
  return { role: "assistant", timestamp, provider: "camelRun", model: "v2", stopReason: "stop", content };
}

function message({ role, content, createdAt: timestamp }: V2Message): Message {
  if (content.meta?.v1) return content.meta.v1;
  const text = content.text ?? "";
  if (role === "system") return { role, timestamp, content: text };
  if (role === "user") return { role, timestamp, content: text, ...(content.meta?.requestId ? { requestId: content.meta.requestId } : {}) };
  if (role === "tool") {
    let details: unknown;
    try { details = JSON.parse(text); } catch { details = undefined; }
    return {
      role: "toolResult", timestamp, content: [{ type: "text", text }],
      toolCallId: content.toolCallId ?? "", toolName: content.toolName ?? "",
      details, isError: content.isError ?? false,
    };
  }
  const blocks: Extract<Message, { role: "assistant" }>["content"] = text ? [{ type: "text", text }] : [];
  for (const tool of content.toolCalls ?? []) {
    blocks.push({ type: "toolCall", id: tool.id, name: tool.name, arguments: tool.args });
  }
  return { ...assistant(timestamp, blocks), stopReason: content.toolCalls?.length ? "toolUse" : "stop" };
}

export async function v2HistoryPage(env: ChatEnv, agentId: string, page: {
  limit?: number; before?: number | null; signal?: AbortSignal;
} = {}) {
  const query = new URLSearchParams({ before: String(page.before ?? "latest"), limit: String(page.limit ?? 50) });
  const result = await v2Json<{ messages: V2Message[]; nextBefore: number | null }>(
    env, v2AgentPath(agentId) + "/history?" + query, { signal: page.signal },
  );
  return { entries: result.messages.map((row) => ({ index: row.seq, message: message(row) })), next: result.nextBefore };
}

function browserInput(agentId: string, run: V2Run, input: V2Input): AgentInput {
  const prompt = input.prompt;
  const message = prompt.message ?? prompt.question ?? "Input requested";
  const kind = prompt.elicitation?.mode ?? input.kind;
  return {
    id: input.id, agent: agentId, requestId: run.idempotencyKey ?? run.id, toolCallId: input.toolCallId,
    kind, message, state: "pending",
    detail: {
      ...(kind === "question" ? { questions: [{
        question: message,
        options: (prompt.options ?? []).map((label) => ({ label, description: "" })),
        allowOther: true,
      }] } : {}),
      ...(kind === "form" ? { requestedSchema: prompt.elicitation?.requestedSchema } : {}),
      ...(kind === "url" ? { url: prompt.elicitation?.url } : {}),
    } as AgentInput["detail"],
    responders: run.actor ? { audience: [run.actor] } : {},
    createdAt: run.startedAt, expiresAt: input.expiresAt,
  };
}

async function pendingInputs(env: ChatEnv, agentId: string, viewer: string, signal: AbortSignal) {
  const { runs } = await v2Json<{ runs: V2Run[] }>(env, v2AgentPath(agentId) + "/inputs", { signal });
  return runs.filter((run) => run.actor === viewer).flatMap((run) =>
    run.inputs.filter((input) => input.status === "pending").map((input) => browserInput(agentId, run, input)));
}

type BrowserFrame = Record<string, unknown>;
const snapshot = { type: "snapshot" };
const eventFrame = (event: BrowserFrame) => ({ type: "event", event });

function translateEvents(env: ChatEnv, agentId: string, viewer: string, signal: AbortSignal) {
  let partialStep: unknown = null;
  return async (event: V2Event): Promise<BrowserFrame[]> => {
    const { data, type, runId, createdAt } = event;
    if (type === "text_delta") {
      const start = partialStep !== data.step || partialStep === null;
      partialStep = data.step;
      return [
        ...(start ? [eventFrame({ type: "message_start", message: assistant(createdAt) })] : []),
        eventFrame({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: data.delta } }),
      ];
    }
    partialStep = null;
    if (type === "tool_call_start" || type === "tool_call_end" || type === "run_started" || type === "run_resumed") {
      // v2 persists assistant and tool messages before publishing these events.
      return [snapshot];
    }
    if (type === "input_resolved") return [eventFrame({ type, id: data.id, state: data.status })];
    if (!runId || !["run_completed", "run_failed", "run_cancelled", "input_required"].includes(type)) return [];
    const run = await v2Json<V2Run>(env, v2AgentPath(agentId) + "/runs/" + encodeURIComponent(runId), { signal });
    const id = run.idempotencyKey ?? runId;
    if (type === "input_required") {
      const input = data.input as V2Input;
      return [
        snapshot,
        ...(run.actor === viewer ? [eventFrame({ type, input: browserInput(agentId, run, input) })] : []),
        { type: "response", id, outcome: { stopped: "input_required" } },
      ];
    }
    return [snapshot, { type: "response", id, outcome: {
      ...(type === "run_failed" ? { error: run.error?.message } : {}),
      ...(type === "run_cancelled" ? { stopped: "aborted" } : {}),
    } }];
  };
}

async function v2Events(env: ChatEnv, agentId: string, viewer: string, req: Request) {
  const resource = v2AgentPath(agentId) + "/events";
  const supplied = req.headers.get("Last-Event-ID");
  if (supplied && !/^\d{1,16}$/.test(supplied)) return Response.json({ error: "Invalid event cursor" }, { status: 400 });
  const { signal } = req;
  const cursor = supplied ?? String((await v2Json<{ nextAfter: number }>(env, resource + "?after=latest", { signal })).nextAfter);
  const translate = translateEvents(env, agentId, viewer, signal);
  const query = new URL(req.url).searchParams;
  if (query.has("poll")) {
    const page = await v2Json<{ events: V2Event[]; nextAfter: number }>(env, resource + "?after=" + cursor, { signal });
    const events = [];
    if (!supplied) events.push({ id: "", data: snapshot });
    for (const event of page.events) {
      for (const data of await translate(event)) events.push({ id: String(event.seq), data });
    }
    return Response.json({ cursor: page.nextAfter, events }, { headers: { "Cache-Control": "no-store" } });
  }
  const upstream = await v2Fetch(env, resource + "?after=" + cursor, { signal, headers: { Accept: "text/event-stream" } });
  if (!upstream.ok || !upstream.body || !upstream.headers.get("content-type")?.includes("text/event-stream")) {
    await upstream.body?.cancel();
    return Response.json({ error: "Could not open the v2 event stream" }, { status: 502 });
  }
  let pending = "";
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("event: ready\ndata: {}\n\n"));
      if (!supplied) controller.enqueue(encoder.encode(`id: ${cursor}\ndata: ${JSON.stringify(snapshot)}\n\n`));
    },
    async transform(chunk, controller) {
      pending += decoder.decode(chunk, { stream: true });
      for (let end; (end = pending.indexOf("\n\n")) !== -1;) {
        const packet = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const json = packet.split("\n").find((line) => line.startsWith("data: "))?.slice(6);
        if (!json) {
          controller.enqueue(encoder.encode(": keepalive\n\n"));
          continue;
        }
        const event = JSON.parse(json) as V2Event;
        const frames = await translate(event);
        const encoded = frames.map((data, index) =>
          `${index === frames.length - 1 ? `id: ${event.seq}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("");
        if (encoded) controller.enqueue(encoder.encode(encoded));
      }
    },
  });
  return new Response(upstream.body.pipeThrough(stream), {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" },
  });
}

/** Expose the fields used by the existing watcher after the app has authenticated the thread. */
export async function readV2Thread(env: ChatEnv, agentId: string, userId: string, read: string, request: Request) {
  const query = new URL(request.url).searchParams;
  if (read === "events") return v2Events(env, agentId, userId, request);
  if (read === "history") {
    const before = query.get("before");
    return Response.json(await v2HistoryPage(env, agentId, {
      before: before === null ? null : Number(before), limit: Number(query.get("limit") ?? 50), signal: request.signal,
    }));
  }
  if (read === "inputs") return Response.json(await pendingInputs(env, agentId, userId, request.signal));
  const state = await v2Json<V2Agent>(env, v2AgentPath(agentId), { signal: request.signal });
  return Response.json({ requests: state.activeRunId ? [{ method: "prompt", state: "running", began: true }] : [] });
}
