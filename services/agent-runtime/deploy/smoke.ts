/**
 * End-to-end check of a running runtime through the SDK:
 *   AGENT_URL=https://agents.camelai.dev AGENT_RUNTIME_TOKEN=<operator token> node --experimental-strip-types deploy/smoke.ts
 * Add SMOKE_PROMPT=1 to also run one real model turn (uses the tenant's provider key).
 */
import { AgentRuntime, memoryJournalStore, schema, tool } from "../clients/typescript.ts";

const url = process.env.AGENT_URL ?? "http://127.0.0.1:8790";
const apiKey = process.env.AGENT_RUNTIME_TOKEN;
if (!apiKey) throw new Error("Set AGENT_RUNTIME_TOKEN to an operator token");

const health = await fetch(new URL("/healthz", url));
if (!health.ok) throw new Error(`Health check failed: HTTP ${health.status}`);

let calls = 0;
const runtime = new AgentRuntime({ url, apiKey, journalStore: memoryJournalStore() });
const agent = await runtime.createAgent({
  name: `smoke-${new Date().toISOString()}`, type: "smoke-test",
  systemPrompt: "You are a smoke test. Call lookup with key \"answer\" and reply with its value only.",
  tools: {
    lookup: tool({
      description: "Look up a value by key",
      input: schema.Object({ key: schema.String() }, { additionalProperties: false }),
      execute: ({ key }) => { calls++; return key === "answer" ? "42" : null; },
    }),
  },
});
try {
  const executed = await agent.execute('return await tools.lookup({ key: "answer" })');
  if (executed.output?.[0] !== "42" || calls !== 1) throw new Error(`Unexpected execute result: ${JSON.stringify(executed)}`);
  console.log("execute: ok (client tool called through the sandbox)");
  if (process.env.SMOKE_PROMPT) {
    const result = await agent.prompt("What is the answer?", { timeoutMs: 120_000 });
    const { messages } = await agent.history();
    const reply = JSON.stringify(messages.at(-1));
    if (result.error || !reply.includes("42")) throw new Error(`Unexpected model turn: ${result.error ?? reply}`);
    console.log("prompt: ok (model called the client tool and answered)");
  }
} finally {
  await agent.destroy();
}
console.log(`smoke test passed against ${url}`);
