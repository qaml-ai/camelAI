/**
 * Run a live eval's prompt on the agent runtime, the way a chiridion thread
 * runs now (plans/runtime-threads-direct.md): the thread pinned to the
 * runtime, the prompt sent as a runtime turn (startRuntimeTurn: the run gates,
 * key scopes, the agent created from the camelai-thread definition), the run
 * waited on through its request record, and the agent's history read back.
 * The result has the shape ChatThreadDO.runAgentEvalSession gave, so every
 * eval's checks and the LLM judge read it unchanged.
 *
 * The runtime is the local one scripts/runtime-eval-harness.mjs starts; it
 * reaches chiridion's tools (/mcp/agent) through the eval relay
 * (scripts/lib/eval-runtime-relay.mjs), which this run serves for its org
 * while it lasts: the vitest workers pool listens on no port of its own.
 */
import { exports as workerExports } from "cloudflare:workers";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { RuntimeInputAnswer } from "../../../../src/lib/agent-runtime-shared";
import { runtimeDirectThreadsEnabled } from "../../../../src/lib/agent-runtime-shared";
import { collectAgentEvalDeployedApps } from "../../src/chat-thread/agent-eval";
import type {
  AgentEvalSessionRequest,
  AgentEvalSessionResult,
  ChatContextState,
  ChatEnv,
} from "../../src/chat-thread/types";
import type { CodeModeToolsProps } from "../../src/code-mode-tools";
import type { ThreadRuntimeRecord } from "../../src/identity/org-do";
import { RuntimeApiError, runtimeApi } from "../../src/agent-runtime/runtime-api";
import { abortRuntimeThread, pinNewThreadToRuntime, startRuntimeTurn } from "../../src/agent-runtime/thread-runtime";
import { runtimeTranscript } from "../../src/agent-runtime/thread-transcript";
import { piMessagesToParsedMessages } from "../../src/pi-message-export";
import { agentMcpHandler, type ToolsFactory } from "../../src/routes/agent-mcp";
import type { Env } from "../../src/types";
import {
  latestAssistantReply,
  localizeRuntimeHistory,
  runtimeEvalEvents,
  runtimeRunOutcome,
  waitForRuntimeRequest,
  type RuntimeRequestRecord,
  type RuntimeRunOutcome,
} from "./runtime-eval-shape";

export interface RuntimeEvalEnv {
  /** The eval relay on this machine (scripts/lib/eval-runtime-relay.mjs). */
  EVAL_RUNTIME_RELAY_URL?: string;
}

export interface RuntimeEvalRequest extends AgentEvalSessionRequest {
  /**
   * How a human input the run waits on is answered (nobody is at the eval):
   * declined by default, as the in-DO loop's AskUserQuestion answered "the user
   * is not at the computer" with no browser attached.
   */
  answerInput?: (input: { id: string; kind?: string; message?: string }) => RuntimeInputAnswer;
}

/** At most this many rounds of human input are answered before the run counts as stuck. */
const MAX_INPUT_ROUNDS = 5;

/** withAgentEvalTimeout's arithmetic: at least a second, two minutes by default. */
export function runtimeEvalTimeoutMs(timeoutMs: unknown): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(1_000, Math.floor(timeoutMs))
    : 120_000;
}

type OrgRuntimeStub = {
  getThreadRuntime(threadId: string): Promise<ThreadRuntimeRecord | null>;
};

/**
 * What the relay hands to a worker: one HTTP request from the runtime, which
 * this worker answers with chiridion's own handler.
 */
interface RelayedRequest {
  id: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
}

const RELAYED_REQUEST_HEADERS_DROPPED = new Set(["host", "content-length", "connection", "transfer-encoding", "keep-alive"]);

/** The routes of chiridion's the runtime calls, as the worker serves them. */
function relayedHandler(env: ChatEnv): (request: Request) => Promise<Response> {
  const exportsWithTools = workerExports as unknown as {
    CodeModeToolsBinding(init: { props: CodeModeToolsProps }): ReturnType<ToolsFactory>;
  };
  const mcp = agentMcpHandler(env as unknown as Env, (props) => exportsWithTools.CodeModeToolsBinding({ props }));
  return async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/mcp/agent") return await mcp(request);
    return Response.json({ error: `The eval relay serves only /mcp/agent, not ${pathname}` }, { status: 404 });
  };
}

async function answerRelayed(relayUrl: string, relayed: RelayedRequest, handle: (request: Request) => Promise<Response>) {
  let status = 502;
  let headers: Record<string, string> = {};
  let body: string | null = null;
  try {
    const request = new Request(relayed.url, {
      method: relayed.method,
      headers: Object.entries(relayed.headers).filter(([name]) => !RELAYED_REQUEST_HEADERS_DROPPED.has(name.toLowerCase())),
      ...(relayed.body && relayed.method !== "GET" && relayed.method !== "HEAD"
        ? { body: Buffer.from(relayed.body, "base64") }
        : {}),
    });
    const response = await handle(request);
    status = response.status;
    const contentType = response.headers.get("content-type");
    headers = {
      ...(contentType ? { "content-type": contentType } : {}),
      ...(response.headers.get("www-authenticate") ? { "www-authenticate": response.headers.get("www-authenticate") as string } : {}),
    };
    const bytes = new Uint8Array(await response.arrayBuffer());
    body = bytes.byteLength > 0 ? Buffer.from(bytes).toString("base64") : null;
  } catch (error) {
    console.error("[runtime-eval] a relayed request failed", error);
    status = 500;
    headers = { "content-type": "application/json" };
    body = Buffer.from(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })).toString("base64");
  }
  await fetch(`${relayUrl}/__eval_tunnel/respond/${encodeURIComponent(relayed.id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ status, headers, body }),
  }).catch((error) => console.warn("[runtime-eval] could not answer the relay", error));
}

/**
 * Serve this org's relayed requests until stopped: long-polls (two, so a long
 * tool call never holds up the next request), each request answered on its own.
 */
export function serveRuntimeEvalRelay(env: ChatEnv, relayUrl: string, orgId: string): { stop(): Promise<void> } {
  const handle = relayedHandler(env);
  const controller = new AbortController();
  const inFlight = new Set<Promise<void>>();
  const poll = async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetch(
          `${relayUrl}/__eval_tunnel/next?key=${encodeURIComponent(orgId)}&waitMs=15000`,
          { signal: controller.signal },
        );
        if (response.status !== 200) {
          await response.body?.cancel();
          if (response.status !== 204) await new Promise((resolve) => setTimeout(resolve, 500));
          continue;
        }
        const relayed = await response.json() as RelayedRequest;
        const answered = answerRelayed(relayUrl, relayed, handle).finally(() => inFlight.delete(answered));
        inFlight.add(answered);
      } catch (error) {
        if (controller.signal.aborted) return;
        console.warn("[runtime-eval] relay poll failed; retrying", error);
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
  };
  const loops = [poll(), poll()];
  return {
    async stop() {
      controller.abort();
      await Promise.allSettled([...loops, ...inFlight]);
    },
  };
}

async function readRequest(env: ChatEnv, agentId: string, requestId: string): Promise<RuntimeRequestRecord | null> {
  try {
    return await runtimeApi(
      env,
      "GET",
      `/v1/agents/${encodeURIComponent(agentId)}/requests/${encodeURIComponent(requestId)}`,
    ) as RuntimeRequestRecord;
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status === 404) return null;
    throw error;
  }
}

/** Answer each input a run waits on; the request the last answer resumed, if any. */
async function answerInputs(
  env: ChatEnv,
  agentId: string,
  record: RuntimeRequestRecord,
  answer: NonNullable<RuntimeEvalRequest["answerInput"]>,
): Promise<string | null> {
  let resumed: string | null = null;
  for (const input of record.outcome?.result?.inputs ?? []) {
    const answered = await runtimeApi(
      env,
      "POST",
      `/v1/agents/${encodeURIComponent(agentId)}/inputs/${encodeURIComponent(input.id)}`,
      answer(input),
    ) as { request?: { id?: unknown } | null } | null;
    if (typeof answered?.request?.id === "string") resumed = answered.request.id;
  }
  return resumed;
}

function errorResult(error: string, status: AgentEvalSessionResult["status"] = "error"): AgentEvalSessionResult {
  return { status, error, events: [{ type: "error", title: "Agent runtime error", message: error }], messages: [] };
}

/**
 * ChatThreadDO.runAgentEvalSession on the runtime: the same request, the same
 * result. `messages` are the thread's whole transcript; `events` are this
 * run's.
 */
export async function runRuntimeEval(env: unknown, body: RuntimeEvalRequest): Promise<AgentEvalSessionResult> {
  const chatEnv = env as ChatEnv & RuntimeEvalEnv;
  const threadId = body.threadId?.trim() ?? "";
  const workspaceId = body.workspaceId?.trim() ?? "";
  const orgId = body.orgId?.trim() ?? "";
  const userId = body.userId?.trim() || null;
  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!threadId || !workspaceId || !orgId || !userId) return errorResult("Missing chat context for eval");
  if (!message) return errorResult("Missing message");
  const relayUrl = chatEnv.EVAL_RUNTIME_RELAY_URL?.trim().replace(/\/+$/, "");
  if (!runtimeDirectThreadsEnabled(chatEnv) || !relayUrl) {
    return errorResult(
      "The local agent runtime is not configured for this run: run evals with scripts/run-agent-eval.mjs, which starts it (node scripts/runtime-eval-harness.mjs up).",
    );
  }

  const context: ChatContextState = {
    threadId,
    workspaceId,
    orgId,
    userId,
    userName: body.userName ?? null,
    userEmail: body.userEmail ?? null,
  };
  const relay = serveRuntimeEvalRelay(chatEnv, relayUrl, orgId);
  const background: Array<Promise<unknown>> = [];
  const timeoutMs = runtimeEvalTimeoutMs(body.timeoutMs);
  try {
    const org = chatEnv.ORG.get(chatEnv.ORG.idFromName(orgId)) as unknown as OrgRuntimeStub;
    const row = await org.getThreadRuntime(threadId) ?? await pinNewThreadToRuntime(chatEnv, context);
    if (!row) {
      return errorResult(
        "This thread's model has no route on the agent runtime (custom endpoints and the gateway's non-OpenRouter routes stay on ChatThreadDO), so it cannot run as a runtime eval.",
      );
    }
    const historyBefore = row.agentId ? (await runtimeTranscript(chatEnv, row.agentId)).length : 0;
    const startedAtMs = Date.now();
    const deadline = startedAtMs + timeoutMs;
    const clientMessageId = body.clientMessageId?.trim() || `eval_${crypto.randomUUID().replace(/-/g, "")}`;
    const send = async () => startRuntimeTurn(chatEnv, {
      context,
      row: await org.getThreadRuntime(threadId) ?? row,
      sender: { userId, userName: context.userName, userEmail: context.userEmail },
      text: message,
      clientMessageId,
      source: body.messageSource?.trim() || "eval",
      waitUntil: (promise) => {
        background.push(promise.catch((error: unknown) => console.warn("[runtime-eval] background work failed", error)));
      },
    });
    let sent = await send();
    // A 429 is the tenant's agents-awake quota while other evals run (the
    // matrix): wait for room, a minute at most. The same request id makes a
    // retry the same message.
    for (let tries = 0; sent.status === "busy" && tries < 12 && Date.now() < deadline; tries += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      sent = await send();
    }
    if (sent.status !== "accepted") return errorResult(sent.error, sent.status === "busy" ? "busy" : "error");

    let requestId = sent.requestId;
    let outcome: RuntimeRunOutcome | null = null;
    for (let round = 0; outcome === null; ) {
      const wait = await waitForRuntimeRequest({ read: () => readRequest(chatEnv, sent.agentId, requestId), deadline });
      if (wait.status === "timeout") {
        await abortRuntimeThread(chatEnv, sent.agentId).catch(() => undefined);
        outcome = { status: "error", error: `Agent eval timed out after ${timeoutMs}ms` };
        break;
      }
      // A prompt a running turn took shares that turn's outcome.
      if (wait.record.steeredInto && wait.record.steeredInto !== requestId) {
        requestId = wait.record.steeredInto;
        continue;
      }
      const settled = runtimeRunOutcome(wait.record);
      if (settled.status !== "input_required") {
        outcome = settled;
        break;
      }
      round += 1;
      const resumed = round <= MAX_INPUT_ROUNDS
        ? await answerInputs(chatEnv, sent.agentId, wait.record, body.answerInput ?? (() => ({ action: "decline" })))
        : null;
      if (!resumed) {
        outcome = { status: "error", error: "The run kept waiting on human input nobody answers in an eval.", reply: settled.reply };
        break;
      }
      requestId = resumed;
    }

    const history = localizeRuntimeHistory(await runtimeTranscript(chatEnv, sent.agentId)) as AgentMessage[];
    const runMessages = history.slice(historyBefore);
    const completedAtMs = Date.now();
    const status = outcome.status === "completed" ? "completed" : "error";
    const reply = outcome.reply ?? latestAssistantReply(runMessages);
    const error = outcome.status === "error" ? outcome.error : undefined;
    return {
      status,
      ...(error ? { error } : {}),
      ...(status === "completed" ? { result: reply } : {}),
      events: runtimeEvalEvents({ threadId, messages: runMessages, status, reply, error, startedAtMs, completedAtMs }),
      messages: piMessagesToParsedMessages(history, threadId),
      deployedApps: await collectAgentEvalDeployedApps(chatEnv, { orgId, workspaceId }),
    };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    console.error("[runtime-eval] the eval run failed", error);
    return errorResult(text);
  } finally {
    await relay.stop();
    // Thread bookkeeping (title, last message) the send started; never longer than a few seconds.
    await Promise.race([Promise.allSettled(background), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  }
}
