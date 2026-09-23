import { mkdir } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import { isContextOverflow, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import { parentRpc } from "./rpc.ts";
import { executeCode } from "./codemode.ts";
import type { AgentConfig, ToolBridge } from "./protocol.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { fileAppendLog } from "../shared/append-log.ts";
import { Transcript, legacySnapshotPath, transcriptPath, type TranscriptRecord } from "./transcript.ts";
import { boundedContext, recoverInterruptedTurn, validateInitialMessages, validateUserMessages } from "./history.ts";
import { codeRequest, DEFAULT_RETRY } from "./limits.ts";

const rpc = parentRpc(() => process.kill(-process.pid, "SIGKILL"));
let agent: Agent | undefined;
let config: AgentConfig;
let transcript: Transcript;
let busy = false;
let active: AbortController | undefined;
let persistenceError: unknown;

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

/** Retry transient provider failures by retracting the error and continuing the same turn. */
async function retryTransientErrors(signal: AbortSignal) {
  const policy = config.retry ?? DEFAULT_RETRY;
  for (let attempt = 1; ; attempt++) {
    const last = agent!.state.messages.at(-1) as AssistantMessage | undefined;
    if (signal.aborted || !last || last.role !== "assistant" || last.stopReason !== "error") return;
    if (isContextOverflow(last, config.model.contextWindow) || !isRetryableAssistantError(last)) return;
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
    transcript = new Transcript(fileAppendLog<TranscriptRecord>(transcriptPath(config.directory)));
    await transcript.load(legacySnapshotPath(config.directory));
    let recovered = false;
    if (transcript.active) {
      // Close the interrupted turn instead of refusing work until an operator intervenes.
      await transcript.replace(recoverInterruptedTurn(transcript.messages), false);
      recovered = true;
    } else if (transcript.messages.length === 0 && config.initialMessages?.length) {
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
        tools: [jsExec, ...directTools], messages: [...transcript.messages],
        thinkingLevel: config.thinkingLevel ?? "off",
      },
      getApiKey: () => config.apiKey,
      transformContext: async messages => {
        const bounded = boundedContext(messages, config.model.contextWindow, agent!.state.systemPrompt);
        if (bounded.length !== messages.length) rpc.send({ type: "event", event: { type: "context_trimmed", retainedMessages: bounded.length, omittedMessages: messages.length - bounded.length } });
        return bounded;
      },
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
    return { pid: process.pid, recovered, messages: transcript.messages.length };
  }
  if (!agent) throw new Error("Agent is not initialized");
  if (method === "status") return { pid: process.pid, busy, messages: transcript.messages.length };
  if (method === "configure") {
    if (busy) throw new Error("Agent is busy");
    if (params.systemPrompt !== undefined) { config.systemPrompt = params.systemPrompt; agent.state.systemPrompt = buildSystemPrompt(params.systemPrompt); }
    if (params.model !== undefined) { config.model = params.model; agent.state.model = params.model; }
    if (params.thinkingLevel !== undefined) { config.thinkingLevel = params.thinkingLevel; agent.state.thinkingLevel = params.thinkingLevel; }
    if (params.apiKey !== undefined) config.apiKey = params.apiKey;
    if (params.tools !== undefined) { config.tools = params.tools; agent.state.tools = [agent.state.tools.find(tool => tool.name === "js_exec")!, ...directAgentTools(config.tools)]; }
    return { configured: true };
  }
  if (method === "history") return { messages: transcript.messages };
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
    await retryTransientErrors(active.signal);
    if (persistenceError) throw persistenceError;
    await transcript.setActive(false);
    return { messages: transcript.messages.length, error: agent.state.errorMessage ?? null };
  } finally {
    await rpc.request("cancel-tools");
    active = undefined;
    busy = false;
  }
};
