# VM agent prototype

Run multiple agents on a Unix VM, one long-lived Pi process per agent, with a
fresh QuickJS/WebAssembly sandbox in a disposable process for each `js_exec` invocation. Node or Bun hosts the process; guest code never executes in their JavaScript context. This is an opt-in
prototype; on this branch the application uses this service for all agent execution.

```text
HTTP client / TypeScript or Python SSE client
  -> VM supervisor (auth, capacity, process lifecycle, tool bridge)
      -> agent A process (Pi loop, model key, native Pi transcript)
          -> disposable codemode process
              -> QuickJS/WASM (JavaScript/TypeScript, fixed memory)
                  -> JSON tool calls -> IPC -> supervisor's scoped ToolBridge
      -> agent B process ...
```

The process runtime has no Cloudflare runtime imports. It uses the same pinned
Pi packages as the application. Code preparation was extracted from the existing
Worker runner into `packages/agent-core/code-mode-source.ts`; both runners share
TypeScript stripping and trailing-expression behavior. The prototype uses a
small standalone prompt, rather than the platform prompt advertising unavailable
capabilities. Application authorization, tools, and UI projection remain in the app.

## Interactive local demos

Run `bun run agent:studio` from the repository root for agent chat URLs, live
TypeScript/Python application state, code/tool traces, run reviews and browser
voice controls. See [Local Agent Studio](studio/README.md) for Python setup,
model configuration and the distinction between live and scripted runs.

## Run the real application as an SDK client

From the camelAI repository root, run `bun run dev:external-agent`, then open
`http://localhost:3001/chat`. This starts local auth, the app, and a loopback
runtime. The launcher uses `SELFHOST_AI_*` or an existing `OPENROUTER_API_KEY`
with Sonnet 4.6. The runtime host receives the provider credential; agent
configuration and SDK journals never store it. Stop with Ctrl-C.

```text
camelAI browser -> ChatThreadDO (UI projection and application policy)
                    -> general TypeScript SDK / HTTP + SSE
                        -> service: model requests, Pi loop, history, context limits
                            -> QuickJS/WASM -> scoped SDK tool callbacks -> camelAI
```

`workers/main/src/chat-thread/service-agent.ts` is a camelAI-owned UI compatibility
adapter. It uses the same public SDK as other applications. The service contains
no camelAI/Cloudflare callbacks or workspace concepts. Agent/Explore and capability
subagents also use the service when this local flag is enabled.

On first attachment, the local app imports its loaded native history into an
empty service agent. It stores the returned scoped credential and SDK delivery
journal in the DO. Subsequent turns read service history; they never replace it
with the DO's copy. The existing DO transcript is retained as a render/usage
projection so the current UI works. Large legacy chats still use the app's bounded
initial import, not a complete historical migration.

The service owns model requests and `js_exec` now. Application tools retain their
existing authorization and policy checks. QuickJS exposes registered JSON tools,
not the old Worker `env` bindings or generic fetch; the local prompt reflects
that difference. Native tool results retain text/image content. SDK receipts and
native model tool-call IDs are separate identifiers.

This is still a local integration: model/provider selection is fixed at agent
creation and uses the runtime's configured credential. Mid-conversation provider
switching, production billing parity, long-running build/deploy tools, and full
DO-eviction recovery have not been certified. A tool call whose outcome is lost
settles as "unknown" and the model decides what to do next; the service never
replays side effects and never waits for an operator. Context limits currently
drop old complete turns from provider input while retaining full durable
history; this is not semantic summarization.

`LOCAL_AGENT_RUNTIME_URL` and `LOCAL_AGENT_RUNTIME_TOKEN` opt the loopback app in;
there is no in-DO execution fallback on this branch. Both settings are required. Local state lives under
`.agent-runtime/application/`. Containers are disabled for chat/file-tool trials;
`LOCAL_AGENT_CONTAINERS=1` enables the existing container setup. Optional local
Cloudflare AI features such as automatic titles may lack required bindings.

For the independent project layout and installation, see [STANDALONE.md](STANDALONE.md).

## Run locally or on a VM

Requires Linux/macOS, Node 22.21+ and Bun. Install from the repository root:

```sh
bun install --frozen-lockfile
bun run agent:demo
AGENT_RUNTIME=node bun run agent:demo
bun run test:agent-runtime
AGENT_RUNTIME=bun bun run test:agent-runtime
bun run --cwd services/agent-runtime typecheck
```

The demo needs no model credentials. It starts two real agent processes, writes
and reads separate files through codemode tool RPC, and kills an infinite loop.
The integration tests also exercise the real Pi provider loop against a local
OpenAI-compatible SSE fixture. No paid model API is called by these tests.

Start the HTTP supervisor on a VM using a trusted terminal:

```sh
export AGENT_RUNTIME_TOKEN="$(openssl rand -hex 32)"
export AGENT_API_KEY="your-provider-key"
export AGENT_PROVIDER=anthropic
export AGENT_MODEL=claude-sonnet-4-5
export AGENT_DATA_DIR=/absolute/path/to/agent-data
export AGENT_RUNTIME=node  # or bun; defaults to supervisor's runtime
bun run agent:serve
```

This starts on `127.0.0.1:8790`. `HOST`/`PORT` are configurable. Use a private
network and TLS termination before exposing the control plane remotely; the
token grants control of every agent and its approved tools on this supervisor.
It is an operator credential, not a tenant-scoped API token. `AGENT_BASE_URL`
optionally overrides the selected Pi model's provider endpoint. Model keys are
sent to the agent over IPC, not passed on argv or persisted in session files.

```sh
curl -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" -X POST \
  http://127.0.0.1:8790/agents/demo

curl -N -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"text":"Write hello.txt, read it back, and report the contents."}' \
  http://127.0.0.1:8790/agents/demo/prompt

curl -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" -X POST \
  http://127.0.0.1:8790/agents/demo/abort

curl -H "Authorization: Bearer $AGENT_RUNTIME_TOKEN" -X DELETE \
  http://127.0.0.1:8790/agents/demo
```

## Interface and behavior

| Request | Behavior |
| --- | --- |
| `POST /agents/:id` | Start an agent, loading its saved session if present |
| `GET /agents/:id` | PID, busy state, message count |
| `POST /agents/:id/prompt` | `{text}`; stream Pi events and a final result as NDJSON |
| `POST /agents/:id/execute` | `{code, timeoutMs?, maxOutputCharacters?}`; diagnostic codemode execution, outside the Pi transcript |
| `POST /agents/:id/abort` | Abort the current prompt/script and signal pending tools |
| `DELETE /agents/:id` | Kill the agent process group; keep its saved session/files |

Each agent admits one prompt or diagnostic execution at a time. The supervisor
admits eight agents by default (`maxAgents` in the SDK). There is no request
queue or automatic restart. HTTP errors before streaming use 400, auth failures
401; streamed failures use `{type:"error", error}` records. Disconnecting the
HTTP stream does not cancel the turn; send `abort` explicitly. Slow consumers
are disconnected rather than buffering unbounded events. Event replay is not
implemented for this legacy HTTP control surface. The client SDK SSE surface
supports bounded replay and durable request/tool outcomes (see its guide).

Codemode supports `tools.search(query)`, `tools.describe(name)`,
`tools.<name>(args)`, `text(value)`, `console.log(value)`, top-level `await`, and
`return`. It can compose parallel calls with `Promise.all`. `tools.read`,
`tools.write`, and `tools.ls` are the supplied local adapter; results follow
`{ok:true,data}`. Failed calls reject. No browser, connections, AI media, or
other Worker binding facades are supplied yet.

Scripts default to a 30-second external deadline, capped at 120 seconds. The
QuickJS interrupt handler separately allows 2 seconds spent executing guest code
(elapsed execution time, excluding time waiting for tools). Expensive built-ins
that do not invoke the interrupt handler are still bounded by the external
process deadline. Every invocation has fixed 32 MiB WebAssembly memory, a 16 MiB
QuickJS allocation limit and a 256 KiB interpreter stack limit. These are guest
limits, not a limit on the entire Node/Bun process's resident memory.

Output defaults to 32,000 characters, capped at 128,000 and 1,024 emitted chunks.
Each script permits 256 tool calls with at most 32 in flight; arguments are
limited to 128 KiB JSON, results to 1 MiB JSON and aggregate tool traffic to
8 MiB. Tools are allowlisted and their arguments validated against host-owned
schemas before dispatch. Call results are copied as JSON, never host references.
All tool calls must be awaited; unfinished calls on return are rejected and
pending calls are cancelled. Cancellation cannot undo effects already dispatched.
Guest requests cannot change the executable, memory limits, workspace or tools.
Script failures, timeouts and cancellation leave the agent process available.
Tool RPCs are correlated by unique IDs, so reverse completion order is safe.
External side effects cannot be rolled back by a process kill or AbortSignal.
Adapters must honor cancellation and must implement idempotency for writes.

## Persistence

Nothing is serialized per streamed delta. Each agent has two append-only logs:

- `transcript.jsonl`: one durable record per finished native Pi message
  (`message_end`), plus turn start/end markers. Messages stay native instead of
  being converted to UI messages. A retried provider error is retracted.
- `<session>.journal.jsonl`: request and tool-call state changes. It is fsynced
  only where correctness needs it: accepting a request, claiming a tool call
  (before the application performs the side effect), and recording outcomes.
  Old settled records are folded away, keeping the most recent 256 of each
  for idempotent retries.

Streamed events (token deltas, tool progress) are kept in a bounded in-memory
buffer for SSE replay. After a host restart a client's cursor falls outside the
buffer, it receives `REPLAY_GAP`, and it recovers durable state from `/state`
and `/history`. The session header (`<session>.json`) is rewritten only when
configuration or metadata changes.

If the runtime dies mid-turn, the next start closes the turn automatically:
tool calls without results get an explicit "outcome unknown" result, and a
runtime notice is added so the model neither assumes success nor repeats the
effect blindly. The interrupted request completes with an `uncertain` error.
Nothing is re-driven automatically and nothing blocks later requests.

Transient provider failures (overload, rate limits, 5xx, dropped streams) are
retried in the same turn with exponential backoff (3 attempts from 2 s).
Context overflow is not retried.

Sessions load lazily and unload after `AGENT_IDLE_MS` (default 5 minutes)
without activity; the agent's process stops at the same point. When all
`AGENT_MAX_PROCESSES` slots are in use, the least recently active idle agent is
stopped to make room. Logs are local files, not replicated storage; the whole
transcript of an active agent is still held in memory.

The host provider key is only sent to trusted endpoints: the default model's,
Pi's published endpoint for the requested provider and model, or an entry in
`AGENT_ALLOWED_BASE_URLS` (comma-separated). Scoped credentials can only submit
user messages; assistant and tool-result history is produced by the runtime.

## Tenant isolation contract

This prototype is **single-tenant, with one trusted operator**. Separate agent
processes and scoped SDK session credentials do not constitute a multi-tenant
authorization system. The operator credential controls the whole runtime.

- **Generated code:** QuickJS/WASM confines generated JavaScript to the exposed
  capabilities. It does not enforce tenant ownership of agents, tools or data.
- **Application tools:** Tool implementations are trusted host code. Applications
  must limit them to the intended workspace, data and credentials; model-supplied
  arguments are not a trusted source of tenant identity.
- **Shared chat:** Anyone who can reach `/a/:agentId` can access that agent's
  shared conversation and send prompts. The URL does not create a private
  conversation per visitor. Studio's developer access protects inspection and
  configuration data, not access to the shared conversation.
- **Host resources:** Guest execution limits do not enforce per-tenant quotas
  or isolate all host-process memory, filesystem permissions and network access.

Before deploying a shared multi-tenant service, implement authenticated tenant
identity as an end-to-end authorization boundary: derive it from verified
credentials and carry it through agent creation, storage access, tool connections
and every API access check. Bind tool capabilities and credentials to that
identity. Do not treat knowledge of an agent ID as permission to access it, and
define an explicit access policy for end-user chat links.

Acceptance tests must prove tenant A cannot list, read, prompt, inspect, stop or
attach tools to tenant B's agents, including after reconnects and restarts.
Then enforce per-tenant concurrency, CPU/memory, tool-use and inference-spending
quotas. Restrict host-process permissions and use OS/container containment as
appropriate for the code being hosted; hosting customers' arbitrary Node/Python
tool implementations requires a separate isolation boundary.

Multiple agents per VM remains the intended architecture; this does not require
a VM per tenant. A `tenantId` field alone provides no protection, so add it with
the authentication and enforcement design rather than as a placeholder.

## Sandbox boundary and remaining production work

The guest has ECMAScript built-ins plus `tools`, `text` and captured `console`
methods. There is no `process`, `Bun`, `require`, filesystem, `fetch`, sockets,
workers, timers, shared memory or nested WebAssembly. Every module import is
denied, including `node:`, `file:`, `data:` and HTTP URLs. `eval` and function
constructors stay inside QuickJS; they never create host functions. Each
invocation gets a separate WASM instance and interpreter heap.

The WASM linear memory has equal initial and maximum sizes, and initialization
checks that QuickJS actually uses that memory. This matters because the pinned
QuickJS package's `setMemoryLimit` alone can undercount large arrays/strings:
[upstream report #271](https://github.com/justjake/quickjs-emscripten/issues/271).
Regression tests allocate retained bulk arrays and strings beyond the nominal
heap limit and verify that the fixed WASM boundary stops them.

The supervisor, Pi process, tool schemas and tool implementations remain trusted
code with OS access. The example filesystem adapter rejects traversal, symlinks
(including dangling links), hard links and special files, uses `O_NOFOLLOW` for
file opens, and bounds reads, writes and directory listings. Its workspace must
be owned exclusively by the service: this portable adapter does not provide
race-proof directory traversal against another OS process replacing directories.
Use DO/R2-backed tools or an OS-contained filesystem service for that threat.

The tests cover known escape patterns and limits; they are not a security audit
or proof against engine vulnerabilities. Production shared-VM operation still
needs OS/container containment and resource quotas around the executor, tenant
authentication, tool-specific authorization, controlled egress for tool hosts,
and a maintained engine/security update process. Agent shutdown reaps its Unix
process group. No deployed environment has been changed.

### Remote executors

Setting `AGENT_EXECUTOR_URL` and `AGENT_EXECUTOR_TOKEN` moves `js_exec` off the
runtime host. With them set, `executeCode()` posts each program to an executor
(`src/executor/server.ts`, the same image with a different command). The
executor runs it in the same fresh code-child and QuickJS limits, and streams
output back as NDJSON. The executor holds no credentials or agent state, and it
clears its own environment at startup.

Guest tool calls come back to a separate runtime listener
(`AGENT_EXECUTOR_CALLBACK_PORT`, default 8791) at
`POST /internal/executions/:id/tools`. The executor reaches that listener
through `AGENT_EXECUTOR_CALLBACK_URL`. Each call carries a random capability,
minted for that one execution, that expires at its deadline.

The agent process has no HTTP server, so the supervisor registers the
execution. The supervisor then relays each callback over IPC into the owning
agent's `executeCode`. That relay runs the same validation, quotas and
`ToolBridge` path as a local child. The runtime never trusts the executor: it
checks streamed output against the same limits. When the runtime aborts or
times out, it disconnects, and the executor kills the child.

Without these variables, execution stays local and unchanged. Deployment is
covered in [`infra/agent-runtime/executor`](../../infra/agent-runtime/executor/README.md),
and the tests are in `tests/executor.test.ts`.

## Integration seam and next extraction

`AgentSupervisor` is the embeddable host API. `ToolBridge` is the key platform
boundary: it contains discoverable JSON schemas and `call(name,args,signal)`.
The [client adapters and runnable demos](clients/README.md) implement this bridge
over SSE plus HTTP POST, with replay, execution claims, and recorded outcomes. The TypeScript release board and Python
SQLite inventory app each expose their own functions while the hosted agent
owns the model loop, sandbox and history. Run both with `bun run agent:demo:clients`
(install the documented Python dependency first).
The agent and its scripts never import DO classes. A production adapter should
implement the bridge with a short-lived, thread-scoped RPC capability back to
the Worker, retaining its authorization and confirmation checks.

The application no longer owns model retries, model-context compaction, or
isolate-death recovery. A browser/DO reconnect observes the saved service request
ID. It never re-prompts the model to reconstruct a UI stream. The DO retains only
a UI turn marker, the SDK receipt cursor, and a render projection.

The service persists native messages and tool outcomes. A killed service run
completes with an uncertain error, and the agent's next start closes the turn
with "outcome unknown" tool results; unknown side effects are never
automatically repeated. The service retries transient provider errors itself,
so no degraded retry ladder, salvage mode, or retry budget is needed in the
application.

Remaining production migration work includes model/provider reconfiguration,
billing enforcement at the inference boundary, and testing application tools
under real deployment conditions. Configuration changes during a run are rejected;
they do not abort and regenerate the turn. Nothing has been deployed.
