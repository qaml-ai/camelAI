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

The SDK has one runtime dependency (`typebox`). Its message and model types come
from Pi; for full typing of history and events, also install
`@earendil-works/pi-agent-core@0.80.6` and `@earendil-works/pi-ai@0.80.6` as dev
dependencies. Without them those types resolve to `any` (with `skipLibCheck`).

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
  model: "anthropic/claude-sonnet-5", // any "provider/model-id" from GET /v1/models
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

Switch models between turns with `await agent.configure({ model: "openai/gpt-5.2" })`;
the history carries over. Your tenant needs a key for that provider.

## Console and REST API

Sign in at https://agents.camelai.dev/console with GitHub (qaml-ai members) to add
provider keys, browse models, create API tokens, watch agents and see usage.
Everything there is also available over REST with an API token:

```sh
curl -X PUT https://agents.camelai.dev/v1/providers/anthropic/key \
  -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" -H "Content-Type: application/json" \
  -d '{"apiKey": "sk-ant-..."}'
curl "https://agents.camelai.dev/v1/models?available=true" -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN"
```

The routes are `/v1/me`, `/v1/providers` (+ `/:provider/key`), `/v1/models`,
`/v1/agents` (+ `/:id`, `/:id/history`, `/:id/prompt`, `/:id/abort`),
`/v1/tokens` and `/v1/usage`; see `services/agent-runtime/src/api.ts`.

Save `agent.session` (it contains a scoped credential) to reconnect later with
`runtime.connectAgent(session, { tools })`. Pass the same `idempotencyKey` to
`createAgent` to get the same agent back instead of a new one.

`@qaml-ai/agent-runtime` (without `/node`) is the portable build for Workers and
other runtimes without a filesystem; supply your own `journalStore`.

See `services/agent-runtime/clients/README.md` in the repository for delivery
guarantees, tool-call semantics, and the full API.
