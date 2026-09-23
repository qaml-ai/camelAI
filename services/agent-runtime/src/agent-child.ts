import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { parentRpc } from "./rpc.ts";
import { executeCode } from "./codemode.ts";
import type { AgentConfig, Snapshot, ToolBridge } from "./protocol.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { writeDurableJson } from "../shared/durable-json.ts";
import { boundedContext, reconcileMessages, validateInitialMessages } from "./history.ts";
import { codeRequest } from "./limits.ts";

const rpc = parentRpc(() => process.kill(-process.pid, "SIGKILL"));
let agent: Agent | undefined;
let config: AgentConfig;
let busy = false;
let active: AbortController | undefined;
let snapshot: Snapshot = { version: 1, active: false, messages: [] };
let persistenceError: unknown;

async function checkpoint() {
  const path = join(config.directory, "session.json");
  writeDurableJson(path, snapshot);
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

rpc.handler = async (method, params) => {
  if (method === "init") {
    if (agent) throw new Error("Agent already initialized");
    config = params;
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    try { snapshot = JSON.parse(await readFile(join(config.directory, "session.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.messages)) throw new Error("Invalid session snapshot");
    if (!snapshot.active && snapshot.messages.length === 0 && config.initialMessages?.length) {
      validateInitialMessages(config.initialMessages);
      snapshot.messages = config.initialMessages;
      await checkpoint();
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
        tools: [jsExec, ...directTools], messages: snapshot.messages,
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
        // Keep native Pi messages intact, including reasoning/signatures and
        // ordered tool results. Never round-trip through browser render history.
        snapshot.messages.push(event.message);
        try { await checkpoint(); }
        catch (error) { persistenceError = error; agent!.abort(); throw error; }
      }
      rpc.send({ type: "event", event });
    });
    return { pid: process.pid, interrupted: snapshot.active, messages: snapshot.messages.length };
  }
  if (!agent) throw new Error("Agent is not initialized");
  if (method === "status") return { pid: process.pid, busy, interrupted: snapshot.active && !busy, messages: snapshot.messages.length };
  if (method === "configure") {
    if (busy) throw new Error("Agent is busy");
    if (params.systemPrompt !== undefined) { config.systemPrompt = params.systemPrompt; agent.state.systemPrompt = buildSystemPrompt(params.systemPrompt); }
    if (params.model !== undefined) { config.model = params.model; agent.state.model = params.model; }
    if (params.thinkingLevel !== undefined) { config.thinkingLevel = params.thinkingLevel; agent.state.thinkingLevel = params.thinkingLevel; }
    if (params.apiKey !== undefined) config.apiKey = params.apiKey;
    if (params.tools !== undefined) { config.tools = params.tools; agent.state.tools = [agent.state.tools.find(tool => tool.name === "js_exec")!, ...directAgentTools(config.tools)]; }
    return { configured: true };
  }
  if (method === "history") return { messages: snapshot.messages, interrupted: snapshot.active && !busy };
  if (method === "reconcile") {
    if (busy) throw new Error("Agent is busy");
    if (params.acknowledged !== true) throw new Error("Acknowledge interrupted effects before reconciliation");
    if (snapshot.active) {
      snapshot.messages = reconcileMessages(snapshot.messages);
      snapshot.active = false;
      try { await checkpoint(); } catch (error) { snapshot.active = true; persistenceError = error; throw error; }
      agent.state.messages = snapshot.messages;
    }
    return { reconciled: true, messages: snapshot.messages.length };
  }
  if (method === "steer" || method === "followUp") {
    if (!busy) throw new Error("Agent is not running; send a prompt instead");
    if (params.message !== undefined) {
      validateInitialMessages([params.message]);
      agent[method](params.message);
    } else {
      if (typeof params.text !== "string" || !params.text.trim()) throw new Error("Prompt text is required");
      agent[method]({ role: "user", content: params.text, timestamp: Date.now() });
    }
    return { queued: true };
  }
  if (method === "abort") { active?.abort(); agent.abort(); return { aborted: true }; }
  if (method !== "prompt" && method !== "execute" && method !== "continue") throw new Error(`Unknown method: ${method}`);
  if (busy) throw new Error("Agent is busy");
  if (persistenceError) throw new Error("Session persistence failed; restart and inspect session.json");
  if (snapshot.active) throw new Error("Interrupted turn needs reconciliation; inspect session.json before resuming side effects");
  if (method === "prompt" && params.message === undefined && (typeof params.text !== "string" || !params.text.trim())) throw new Error("Prompt text is required");
  busy = true;
  active = new AbortController();
  try {
    if (method === "execute") return await executeCode({ ...codeRequest(params), directory: config.directory, bridge: bridge(active.signal), signal: active.signal, onEvent: event => rpc.send({ type: "event", event }) });
    snapshot.active = true;
    await checkpoint();
    if (method === "continue") await agent.continue();
    else if (params.message !== undefined) {
      validateInitialMessages(Array.isArray(params.message) ? params.message : [params.message]);
      await agent.prompt(params.message);
    } else await agent.prompt(params.text, params.images);
    if (persistenceError) throw persistenceError;
    snapshot.messages = [...agent.state.messages];
    snapshot.active = false;
    await checkpoint();
    return { messages: snapshot.messages.length, error: agent.state.errorMessage ?? null };
  } finally {
    await rpc.request("cancel-tools");
    active = undefined;
    busy = false;
  }
};
