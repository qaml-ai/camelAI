# @qaml-ai/agent-runtime

SDK for the camelAI hosted agent runtime. Your application defines tools as
ordinary functions; the runtime runs the model loop, keeps each agent's history,
and executes model-written code in a sandbox that can only call your tools.
Tool calls come back to your process over SSE, so your data and credentials
never leave it.

Requires Node 22 or later (or Bun).

## Install

The package is published to GitHub Packages. Create a GitHub token with
`read:packages`, then add an `.npmrc` next to your `package.json`:

```
@qaml-ai:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

```sh
GITHUB_TOKEN=<token> npm install @qaml-ai/agent-runtime
```

Upgrade with `npm update @qaml-ai/agent-runtime`.

## Use

You need the runtime URL and your tenant's operator token. Keep the operator
token on your backend; it can create and control every agent in your tenant.

```ts
import { AgentRuntime, schema, tool } from "@qaml-ai/agent-runtime/node";

const runtime = new AgentRuntime({
  url: "https://agents.camelai.dev",
  apiKey: process.env.AGENT_RUNTIME_TOKEN,
  stateDirectory: ".agent-runtime", // tool receipts and cursors survive restarts
});

const agent = await runtime.createAgent({
  name: "Inventory planner",
  type: "inventory",
  systemPrompt: "You plan restocks. Never place orders.",
  tools: {
    read_inventory: tool({
      description: "Read stock and target quantities",
      input: schema.Object({}),
      execute: () => db.inventory(),
    }),
    plan_restock: tool({
      description: "Save a restock plan",
      input: schema.Object({ sku: schema.String(), quantity: schema.Integer() }),
      // callId is stable across retries: use it as your idempotency key.
      execute: ({ sku, quantity }, { callId }) => db.plan(sku, quantity, { idempotencyKey: callId }),
    }),
  },
  onEvent: event => console.log(event.type),
});

await agent.prompt("Plan restocks for anything below target.");
```

Save `agent.session` (it contains a scoped credential) to reconnect later with
`runtime.connectAgent(session, { tools })`. Pass the same `idempotencyKey` to
`createAgent` to get the same agent back instead of a new one.

`@qaml-ai/agent-runtime` (without `/node`) is the portable build for Workers and
other runtimes without a filesystem; supply your own `journalStore`.

See `services/agent-runtime/clients/README.md` in the repository for delivery
guarantees, tool-call semantics, and the full API.
