import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, convertToLlm, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { parentRpc } from "./rpc.ts";
import { executeCode } from "./codemode.ts";
import type { AgentConfig, ToolBridge } from "./protocol.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { fileAppendLog } from "../shared/append-log.ts";
import { Transcript, legacySnapshotPath, readTranscript, readTranscriptLog, summaryMessage, transcriptPath, type CompactionState, type TranscriptRecord } from "./transcript.ts";
import { openStorage } from "../shared/storage-config.ts";
import type { Storage } from "../shared/storage.ts";
import { boundedContext, interruptedTurnRepairs, validateInitialMessages, validateUserMessages } from "./history.ts";
import { compactionSettings, contextTokens, explicitKeyStream, needsCompaction, runCompaction } from "./compaction.ts";
import { codeRequest, DEFAULT_RETRY } from "./limits.ts";

const rpc = parentRpc(() => process.kill(-process.pid, "SIGKILL"));
let agent: Agent | undefined;
let config: AgentConfig;
let transcript: Transcript;
let storage: Storage | undefined;
let busy = false;
let active: AbortController | undefined;
let persistenceError: unknown;
/** Messages a compaction folded into the summary during the current run, still in Pi's live state. */
let dropped = new WeakSet<AgentMessage>();
let summary: { state: CompactionState; message: AgentMessage } | undefined;

function summaryView(): AgentMessage[] {
  const state = transcript.compaction;
  if (!state) return [];
  if (summary?.state !== state) summary = { state, message: summaryMessage(state) };
  return [summary.message];
}

/** The model's context: the current summary plus live messages not yet folded into it. */
function liveView(messages: AgentMessage[]): AgentMessage[] {
  return [...summaryView(), ...messages.filter(message => message.role !== "compactionSummary" && !dropped.has(message))];
}

/** Summarize older context into the transcript. Failures leave the context as is; the next request retries. */
async function compactNow(reason: "threshold" | "overflow", signal?: AbortSignal): Promise<boolean> {
  if (!config.apiKey) return false;
  rpc.send({ type: "event", event: { type: "compaction_start", reason } });
  try {
    const context = transcript.context.slice();
    const offset = transcript.offset;
    // An overflow means the real limit is lower than assumed: keep about a fifth of the context.
    const keepRecentTokens = reason === "overflow" ? Math.max(1_000, Math.floor(contextTokens(liveView(context)) * 0.2)) : undefined;
    const outcome = await runCompaction({ context, offset, previous: transcript.compaction, model: config.model, apiKey: config.apiKey, signal, keepRecentTokens });
    if ("skipped" in outcome) {
      rpc.send({ type: "event", event: { type: "compaction_end", reason, skipped: outcome.skipped } });
      return false;
    }
    for (const message of context.slice(0, outcome.state.cut - offset)) dropped.add(message);
    await transcript.compact(outcome.state);
    rpc.send({ type: "event", event: { type: "compaction_end", reason, tokensBefore: outcome.state.tokensBefore, summarizedMessages: outcome.state.cut - offset, keptMessages: transcript.context.length } });
    return true;
  } catch (error) {
    if (signal?.aborted) throw error;
    rpc.send({ type: "event", event: { type: "compaction_end", reason, error: error instanceof Error ? error.message : String(error) } });
    return false;
  }
}

/** Before every model request: compact when the context is too big, trimming only as a last resort. */
async function contextFor(messages: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]> {
  let view = liveView(messages);
  const systemTokens = Math.ceil(agent!.state.systemPrompt.length / 4);
  if (needsCompaction(view, config.model, systemTokens) && await compactNow("threshold", signal)) view = liveView(messages);
  // Same budget as the compaction threshold, so this only trims when compaction could not run.
  const budget = config.model.contextWindow - compactionSettings(config.model).reserveTokens - systemTokens;
  const bounded = boundedContext(view, budget);
  if (bounded.length !== view.length) rpc.send({ type: "event", event: { type: "context_trimmed", retainedMessages: bounded.length, omittedMessages: view.length - bounded.length } });
  return bounded;
}

function bridge(signal: AbortSignal): ToolBridge {
  return {
    definitions: config.tools.filter(tool => tool.exposure !== "direct"),
    call: async (name, args) => {
      signal.throwIfAborted();
      return rpc.request("tool", { name, args });
    },
  };
}

function directAgentTools(tools: AgentConfig["tools"]): AgentTool[] {
  return tools.filter(tool => ["direct", "both"].includes(tool.exposure ?? "codemode")).map(tool => ({
      name: tool.name, label: tool.name, description: tool.description,
      parameters: tool.parameters as AgentTool["parameters"], executionMode: tool.executionMode,
      execute: async (toolCallId, args, signal) => {
        signal?.throwIfAborted();
        const value = await rpc.request("tool", { name: tool.name, args, toolCallId });
        signal?.throwIfAborted();
        if (tool.resultFormat === "content") {
          if (!value || !Array.isArray(value.content) || value.content.some((part: any) => !part || !(part.type === "text" && typeof part.text === "string" || part.type === "image" && typeof part.data === "string" && typeof part.mimeType === "string"))) throw new Error("Invalid content tool result");
          if (value.isError === true) throw new Error(value.content.filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n") || "Tool execution failed");
          return value;
        }
        return { content: [{ type: "text", text: JSON.stringify(value) ?? "null" }], details: value };
      },
    }));
}

function userMessages(value: unknown): AgentMessage[] {
  const messages = (Array.isArray(value) ? value : [value]) as AgentMessage[];
  validateUserMessages(messages);
  return messages;
}

/**
 * Recover failed responses within the same turn: a context overflow compacts and
 * continues once; transient provider failures retry with backoff. The failed
 * response is retracted either way, so it never becomes history.
 */
async function recoverFailedResponses(signal: AbortSignal) {
  const policy = config.retry ?? DEFAULT_RETRY;
  let overflowHandled = false;
  for (let attempt = 1; ; attempt++) {
    const last = agent!.state.messages.at(-1) as AssistantMessage | undefined;
    if (signal.aborted || !last || last.role !== "assistant" || last.stopReason !== "error") return;
    if (isContextOverflow(last, config.model.contextWindow)) {
      if (overflowHandled) return;
      overflowHandled = true;
      await transcript.retract();
      agent!.state.messages = agent!.state.messages.slice(0, -1);
      if (!await compactNow("overflow", signal)) {
        // Keep the error visible: nothing could be summarized, so a retry would overflow again.
        await transcript.push(last);
        agent!.state.messages = [...agent!.state.messages, last];
        return;
      }
      await agent!.continue();
      attempt--;
      continue;
    }
    if (!isRetryableAssistantError(last)) return;
    if (attempt > policy.maxAttempts) {
      rpc.send({ type: "event", event: { type: "auto_retry_end", success: false, attempt: attempt - 1, finalError: last.errorMessage } });
      return;
    }
    const delayMs = policy.baseDelayMs * 2 ** (attempt - 1);
    rpc.send({ type: "event", event: { type: "auto_retry_start", attempt, maxAttempts: policy.maxAttempts, delayMs, errorMessage: last.errorMessage ?? "Unknown error" } });
    // The failed attempt is not history: drop it from the log and the live state.
    await transcript.retract();
    agent!.state.messages = agent!.state.messages.slice(0, -1);
    try { await sleep(delayMs, undefined, { signal }); }
    catch { return; }
    await agent!.continue();
    if ((agent!.state.messages.at(-1) as AssistantMessage | undefined)?.stopReason !== "error") {
      rpc.send({ type: "event", event: { type: "auto_retry_end", success: true, attempt } });
    }
  }
}

rpc.handler = async (method, params) => {
  if (method === "init") {
    if (agent) throw new Error("Agent already initialized");
    config = params;
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    if (config.storage && config.transcriptKey) {
      storage = await openStorage(config.storage);
      transcript = new Transcript(storage.log<TranscriptRecord>(config.transcriptKey));
      await transcript.load();
    } else {
      transcript = new Transcript(fileAppendLog<TranscriptRecord>(transcriptPath(config.directory)));
      await transcript.load(legacySnapshotPath(config.directory));
    }
    let recovered = false;
    if (transcript.active) {
      // Close the interrupted turn instead of refusing work until an operator intervenes.
      await transcript.append(interruptedTurnRepairs(transcript.context));
      await transcript.setActive(false);
      recovered = true;
    } else if (transcript.total === 0 && config.initialMessages?.length) {
      validateInitialMessages(config.initialMessages);
      await transcript.replace(config.initialMessages);
    }
    const directTools = directAgentTools(config.tools);
    const jsExec: AgentTool = {
      name: "js_exec", label: "JavaScript",
      description: "Execute JavaScript or TypeScript in a fresh QuickJS/WebAssembly sandbox. Only approved tools and output helpers are available: no filesystem, network, imports, process, Node/Bun APIs, or timers. Use await tools.search(query), await tools.describe(name), and await tools.<name>(args). Use text(value), console.log(value), or return to emit output. Calls can be composed with Promise.all. State does not survive between invocations.",
      parameters: {
        type: "object", required: ["code"],
        properties: { code: { type: "string" }, description: { type: "string" }, timeoutMs: { type: "number" }, maxOutputCharacters: { type: "number" } },
      } as AgentTool["parameters"],
      executionMode: "sequential",
      execute: async (id, args, signal, onUpdate) => {
        try {
          const result = await executeCode({
            ...codeRequest(args), directory: config.directory, bridge: bridge(signal ?? new AbortController().signal), signal,
            onEvent: event => {
              rpc.send({ type: "event", event: { type: "codemode", toolCallId: id, event } });
              onUpdate?.({ content: [{ type: "text", text: JSON.stringify(event) }], details: event });
            },
          });
          return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
        } finally { await rpc.request("cancel-tools"); }
      },
    };
    agent = new Agent({
      initialState: {
        model: config.model,
        systemPrompt: buildSystemPrompt(config.systemPrompt),
        tools: [jsExec, ...directTools], messages: transcript.view(),
        thinkingLevel: config.thinkingLevel ?? "off",
      },
      getApiKey: () => config.apiKey,
      // Only the tenant's explicit key, never provider keys from the process environment.
      streamFn: explicitKeyStream(),
      // Renders compaction summaries for the model (the default drops non-chat roles).
      convertToLlm,
      transformContext: (messages, signal) => contextFor(messages, signal),
      sessionId: config.id,
      toolExecution: "parallel",
    });
    agent.subscribe(async event => {
      if (event.type === "message_end") {
        // One durable append per finished message. Streaming deltas are never persisted.
        try { await transcript.push(event.message); }
        catch (error) { persistenceError = error; agent!.abort(); throw error; }
      }
      rpc.send({ type: "event", event });
    });
    return { pid: process.pid, recovered, messages: transcript.total };
  }
  if (!agent) throw new Error("Agent is not initialized");
  if (method === "status") return { pid: process.pid, busy, messages: transcript.total, contextMessages: transcript.context.length, compacted: !!transcript.compaction };
  if (method === "configure") {
    if (busy) throw new Error("Agent is busy");
    if (params.systemPrompt !== undefined) { config.systemPrompt = params.systemPrompt; agent.state.systemPrompt = buildSystemPrompt(params.systemPrompt); }
    if (params.model !== undefined) { config.model = params.model; agent.state.model = params.model; }
    if (params.thinkingLevel !== undefined) { config.thinkingLevel = params.thinkingLevel; agent.state.thinkingLevel = params.thinkingLevel; }
    if (params.apiKey !== undefined) config.apiKey = params.apiKey;
    if (params.tools !== undefined) { config.tools = params.tools; agent.state.tools = [agent.state.tools.find(tool => tool.name === "js_exec")!, ...directAgentTools(config.tools)]; }
    return { configured: true };
  }
  // Full history comes from the log; memory holds only the working set.
  if (method === "history") return { messages: storage ? await readTranscriptLog(storage.log(config.transcriptKey!)) : await readTranscript(config.directory) };
  if (method === "steer" || method === "followUp") {
    // Pi queues these whether or not a run is active; an idle queue drains into the next run.
    const messages = params.message !== undefined ? userMessages(params.message) : undefined;
    if (!messages && (typeof params.text !== "string" || !params.text.trim())) throw new Error("Prompt text is required");
    for (const message of messages ?? [{ role: "user", content: params.text, timestamp: Date.now() } as AgentMessage]) agent[method](message);
    return { queued: true, running: busy };
  }
  if (method === "abort") { active?.abort(); agent.abort(); return { aborted: true }; }
  if (method !== "prompt" && method !== "execute" && method !== "continue") throw new Error(`Unknown method: ${method}`);
  if (busy) throw new Error("Agent is busy");
  if (persistenceError) throw new Error(`Session persistence failed: ${String(persistenceError)}`);
  if (method === "prompt" && params.message === undefined && (typeof params.text !== "string" || !params.text.trim())) throw new Error("Prompt text is required");
  const promptMessages = method === "prompt" && params.message !== undefined ? userMessages(params.message) : undefined;
  busy = true;
  active = new AbortController();
  try {
    if (method === "execute") return await executeCode({ ...codeRequest(params), directory: config.directory, bridge: bridge(active.signal), signal: active.signal, onEvent: event => rpc.send({ type: "event", event }) });
    await transcript.setActive(true);
    if (method === "continue") await agent.continue();
    else if (promptMessages) await agent.prompt(promptMessages);
    else await agent.prompt(params.text, params.images);
    await recoverFailedResponses(active.signal);
    if (persistenceError) throw persistenceError;
    await transcript.setActive(false);
    return { messages: transcript.total, error: agent.state.errorMessage ?? null };
  } finally {
    // Release what compaction folded away: the next run starts from summary + kept messages.
    if (method !== "execute" && !persistenceError) {
      agent.state.messages = transcript.view();
      dropped = new WeakSet();
    }
    await rpc.request("cancel-tools");
    active = undefined;
    busy = false;
  }
};
