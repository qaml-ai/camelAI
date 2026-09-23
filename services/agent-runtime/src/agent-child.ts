import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Agent, type AgentTool } from "@earendil-works/pi-agent-core";
import { parentRpc } from "./rpc.ts";
import { executeCode } from "./codemode.ts";
import type { AgentConfig, Snapshot, ToolBridge } from "./protocol.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
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
  await writeFile(`${path}.tmp`, JSON.stringify(snapshot), { mode: 0o600 });
  await rename(`${path}.tmp`, path);
}

function bridge(signal: AbortSignal): ToolBridge {
  return {
    definitions: config.tools,
    call: async (name, args) => {
      signal.throwIfAborted();
      return rpc.request("tool", { name, args });
    },
  };
}

rpc.handler = async (method, params) => {
  if (method === "init") {
    if (agent) throw new Error("Agent already initialized");
    config = params;
    await mkdir(config.directory, { recursive: true, mode: 0o700 });
    try { snapshot = JSON.parse(await readFile(join(config.directory, "session.json"), "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (snapshot.version !== 1 || !Array.isArray(snapshot.messages)) throw new Error("Invalid session snapshot");
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
        tools: [jsExec], messages: snapshot.messages,
      },
      getApiKey: () => config.apiKey,
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
  if (method === "abort") { active?.abort(); agent.abort(); return { aborted: true }; }
  if (method !== "prompt" && method !== "execute") throw new Error(`Unknown method: ${method}`);
  if (busy) throw new Error("Agent is busy");
  if (persistenceError) throw new Error("Session persistence failed; restart and inspect session.json");
  if (snapshot.active) throw new Error("Interrupted turn needs reconciliation; inspect session.json before resuming side effects");
  if (method === "prompt" && (typeof params.text !== "string" || !params.text.trim())) throw new Error("Prompt text is required");
  busy = true;
  active = new AbortController();
  try {
    if (method === "execute") return await executeCode({ ...codeRequest(params), directory: config.directory, bridge: bridge(active.signal), signal: active.signal, onEvent: event => rpc.send({ type: "event", event }) });
    snapshot.active = true;
    await checkpoint();
    await agent.prompt(params.text);
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
