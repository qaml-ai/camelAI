# Hosted agent SDK

Expose ordinary application functions. The runtime runs the model loop, saves
conversation history, and executes generated code in QuickJS/WASM. The SDK
handles provisioning, SSE, tool results, reconnects, and shutdown.

These are local prototype SDKs for trusted TypeScript backends and Python; no package has been
published. Remote connections require HTTPS. The model key stays on the host.

## TypeScript

```ts
import { AgentRuntime, schema, tool } from "./services/agent-runtime/clients/node.ts";

const runtime = new AgentRuntime({
  url: "http://127.0.0.1:8790",
  apiKey: process.env.AGENT_RUNTIME_TOKEN,
});

const agent = await runtime.createAgent({
  name: "Research notes",
  type: "note-assistant",
  systemPrompt: "You help users summarize their selection and save useful notes. Keep replies concise.",
  tools: {
    read_selection: tool({
      description: "Read the selection in my application",
      input: schema.Object({}),
      execute: () => myApp.selection,
    }),
    save_note: tool({
      description: "Save a note in my application",
      input: schema.Object({ note: schema.String({ maxLength: 4000 }) }),
      execute: async ({ note }, { callId, signal }) => {
        // note is inferred as string. Use callId as an idempotency key if
        // your database/service supports one; honor signal for cancellation.
        return myApp.saveNote(note, { idempotencyKey: callId, signal });
      },
    }),
  },
  onEvent: event => renderAgentEvent(event),
});

try {
  await agent.prompt("Summarize my selection and save a note.");
} finally {
  await agent.destroy();
}
```

The Node/Bun entry shown above persists tool receipts and event cursors to disk.
For Cloudflare Workers or other Web API environments, import `clients/typescript.ts`
instead and inject `journalStore: { load, save }` backed by your application's
durable storage. That portable entry defaults to memory and does not read
environment variables. `save(sessionId, journal)` must resolve only after commit.

Keep `agent.session` in secret storage and reconnect with
`runtime.connectAgent(credentials, { tools, onEvent })`. An async
`onEvent(event, requestId)` finishes before its replay cursor is committed.
`history()`, `continue()`, `steer(text)`, `followUp(text)`, and `configure(...)`
operate on the same persistent agent. `reconcileHistory()` explicitly acknowledges
unknown tool effects after interruption; it does not replay those effects.

## Python

Install `clients/python/requirements.txt` and import the local `agent_client.py`
module (the complete demo adds its directory to `sys.path`).

```python
from agent_client import AgentRuntime, ToolContext, tool

@tool
async def read_inventory():
    """Read stock and target quantities from our application."""
    return await database.inventory()

@tool
async def plan_restock(sku: str, quantity: int, context: ToolContext):
    """Save a local restock plan without placing an order."""
    return await database.plan(sku, quantity, idempotency_key=context.call_id)

async with AgentRuntime() as runtime:
    agent = await runtime.create_agent(
        name="Downtown cafe",
        type="inventory-planner",
        system_prompt="You manage cafe stock. Plan restocks without purchasing anything.",
        tools=[read_inventory, plan_restock],
    )
    try:
        await agent.prompt("Plan restocks for items below target.")
    finally:
        await agent.destroy()
```

Python's `@tool` derives names, descriptions, and JSON schemas from function
names, docstrings, and annotations. This first version supports `str`, `int`,
`float`, `bool`, `list`, and `dict`, plus an optional `context: ToolContext`.
Callbacks must be async; use `asyncio.to_thread` for blocking operations. Python
cancellation uses task cancellation. Both SDKs expose parallel tool calls without
requiring applications to handle messages, request IDs, or raw HTTP.

## Agent identity and Studio

`name` identifies an individual agent; `type` groups agents in Studio. For example,
`September release` and `Docs launch` can both be `release-reviewer` agents. Types
are free-form labels, not an enum, template, or separate runtime object. Each
agent retains its own conversation and stable ID. Both fields accept 1–120
characters. Existing clients may omit them (ID as name, `general` as type).

Rename or regroup without changing its URL or history:

```ts
await agent.setMetadata({ name: "October release", type: "release-reviewer" });
```

```python
await agent.set_metadata(name="Uptown cafe", type="inventory-planner")
```

When connected to the runtime launched by Agent Studio, SDK-created agents
appear automatically at `/studio/agents`; no UI registration is required.
Studio observes the runtime journal; your application's SSE connection continues
to own its tool callbacks. Get the runtime URL from the terminal or local
`.agent-runtime/studio/studio.json` (`runtimeUrl`), and its operator credential
from `.agent-runtime/studio/secrets.json` (`operator`). Keep credentials server-side.
Use `STUDIO_EXAMPLES=0 bun run agent:studio` to skip launching demos (existing agents remain listed).

## Run the demos

From the repository root:

```sh
bun install --frozen-lockfile
python3 -m venv /tmp/camelai-client-demo
/tmp/camelai-client-demo/bin/pip install -r services/agent-runtime/clients/python/requirements.txt
PYTHON=/tmp/camelai-client-demo/bin/python bun run agent:demo:clients
```

One temporary host runs two independent agent processes concurrently:

- [TypeScript release board](../examples/release-board.ts) reads application
  issues and saves a release readiness note.
- [Python SQLite inventory](../examples/inventory.py) reads its own database and
  saves restock quantities, recording the tool call ID alongside each write.

The default run is deterministic: supplied scripts exercise real QuickJS and
SSE/HTTP callbacks without calling a paid model. It cleans up its host, agents,
and temporary journals. `AGENT_RUNTIME=node` or `bun` selects the child runtime.

For a model-driven run, start `bun run agent:serve` with the provider configuration
in the [host README](../README.md#run-locally-or-on-a-vm), then run:

```sh
export AGENT_URL=http://127.0.0.1:8790
export AGENT_RUNTIME_TOKEN=your-host-operator-token
bun services/agent-runtime/examples/release-board.ts --prompt \
  "Review release readiness and save a note naming blockers and owners."
/tmp/camelai-client-demo/bin/python services/agent-runtime/examples/inventory.py --prompt \
  "Plan restocks for everything below target and explain the quantities."
```

## Lifecycle and recovery API

| TypeScript | Python | Purpose |
| --- | --- | --- |
| `runtime.createAgent({tools})` | `runtime.create_agent(tools=[...])` | Provision and connect |
| `runtime.connectAgent(session, {tools})` | `runtime.connect_agent(session, tools=[...])` | Reattach using scoped credentials |
| `agent.prompt(text)` | `agent.prompt(text)` | Run a model turn |
| `agent.execute(code)` | `agent.execute(code)` | Diagnostic QuickJS execution, outside model history |
| `agent.status()` / `agent.abort()` | Same | Inspect or cancel a turn |
| `agent.outcomes()` | Same | Inspect recorded requests and tool outcomes |
| `agent.requestStatus(id)` | `agent.request_status(id)` | Recover a timed-out request's result |
| `agent.reconcile(callId, {result})` | `agent.reconcile(call_id, {"result": value})` | Record an explicitly verified uncertain tool outcome |
| `agent.close()` | Same | Disconnect locally, retain hosted agent |
| `agent.destroy()` | Same | Revoke the session and stop its agent |

The SDK automatically retries provisioning and request POSTs with the same
idempotency key. Callers can supply `idempotencyKey` (Python `idempotency_key`) to
resume a request after their own restart. Reusing a key with different parameters
fails. Request errors include `requestId` / `request_id` for status inspection.
`agent.session` contains scoped credentials: store them securely to reconnect;
never log them. `createAgent` needs an operator key, but `connectAgent` doesn't.
Provision on your trusted backend and give the client only its scoped session.

`close()` does not cancel a hosted model turn. If you intend to stop one, await
`abort()` before closing. Disconnecting during a client tool may leave an
uncertain outcome. `destroy()` is intended for demo/ephemeral sessions. In an
application, keep the agent connected across multiple prompts.

## What reconnects guarantee

The host persists numbered events and replays them using `Last-Event-ID`. Both
SDKs reconnect with backoff and retain their cursors. A bounded replay window
holds up to 512 events / approximately 2 MiB; if the cursor falls behind it,
SDKs recover requests/tool calls from saved session state and emit `replay_gap`.
Old display events outside that window are not reconstructed.

A tool must obtain a **one-time execution claim** before running. The SDK saves
its result locally before POSTing it. If the result acknowledgement is lost, it
resends that saved result. Replayed events do not re-execute a completed tool.
A brief SSE disconnect leaves already-running callbacks and their HTTP uploads
active, so it doesn't automatically turn a successful write into a failure.

If a client dies after starting a tool but before saving its result, the runtime
cannot know whether the side effect happened. It marks the call uncertain and
blocks further execution until the application checks the real state and uses
`reconcile()`. Late results are retained as evidence; they do not silently unblock
an uncertain turn. Timeouts and cancellation are not rollback.

This is **not an exactly-once transaction across the SDK and your database**.
Business authorization, transactional writes, and application idempotency stay
in your tools. A new model-issued call gets a new call ID; the SDK cannot infer
that two different calls represent the same business operation. Ordinary tool
exceptions are returned to the model; uncertainty is explicit for interrupted
execution. Keep handlers and schemas trusted.

## Persistence and prototype limits

- Host journals use atomic, fsynced JSON files under `AGENT_DATA_DIR/client-sessions`.
  SDK receipts/cursors default to `.agent-runtime/client-sdk`, configurable with
  `stateDirectory` / `state_directory` or `AGENT_CLIENT_STATE_DIR`. Use persistent,
  application-owned directories. Do not share one SDK journal between concurrent
  application processes.
- Settled sessions and deduplication records survive a host restart with the same
  data directory and operator secret. An interrupted model turn still uses the
  existing conservative transcript-reconciliation policy. Acknowledging an
  uncertain request with `acknowledgeRequest` / `acknowledge_request` does not
  repair an interrupted Pi transcript or rerun the turn.
- Session credentials expire after 24 hours and can be revoked via `destroy()`.
  There is no renewal or automatic cleanup policy yet. The prototype retains up
  to 128 sessions, 1,024 request records and 1,024 tool records per session, and a
  32 MiB session journal ceiling. It refuses additional work instead of deleting
  deduplication evidence. This file store is intended for small prototypes, not
  distributed hosting or high-volume event ingestion.
- Tool calls default to a 15-second deadline. The existing sandbox, schema,
  argument, result and concurrency limits remain enforced. JSON frames are
  capped at 1.1 MB, with bounded SSE output buffering and no event compression.
- TLS is required remotely. Redirects are disabled. Credentials are headers,
  never URL parameters. The host rejects browser `Origin` headers for now;
  browser SDK packaging, CORS and a user-authenticated credential handoff remain
  separate work. No browser or production application route has been switched.

The wire transport is ordinary HTTP: `GET /clients/:id/events` streams SSE;
`POST /clients/:id/requests` accepts idempotent requests; call-specific `claim`,
`outcome`, and `reconcile` endpoints manage execution. Application code should
use the SDK rather than implement this protocol itself.

Validation: `bun run test:agent-runtime` covers the host and TypeScript SDK;
`python3 services/agent-runtime/tests/python_sdk.py` covers Python schema
inference, reconnects and lost request/result acknowledgements. Both suites
accept `AGENT_RUNTIME=node` or `AGENT_RUNTIME=bun` for the hosted agent processes.

## System prompts

Pass `systemPrompt` (TypeScript) or `system_prompt` (Python) when creating an
agent. This defines the application instructions and takes precedence over the host's
`AGENT_SYSTEM_PROMPT`, and is stored with that agent. Reconnecting or restarting
the host retains it; `connectAgent` / `connect_agent` do not change configuration.
The runtime automatically prepends tool discovery, sandbox execution and result
handling instructions. Developers only need to describe the agent’s role and
behavior; no `js_exec` instructions are needed. The stored application prompt is
kept separate from the assembled prompt, so reconnects do not duplicate instructions.
Prompts must be nonblank strings of at most 32,000 characters.
Sandbox capability restrictions are enforced independently of the prompt.
Editing an existing agent's prompt through the Studio UI is not implemented yet.
