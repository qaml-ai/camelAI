# VM agent prototype

Run multiple agents on a Unix VM, one long-lived Pi process per agent, with a
fresh QuickJS/WebAssembly sandbox in a disposable process for each `js_exec` invocation. Node or Bun hosts the process; guest code never executes in their JavaScript context. This is an opt-in
prototype; the application still runs its production agent inside ChatThreadDO.

```text
HTTP client / TypeScript or Python SSE client / future ChatThreadDO adapter
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
capabilities. It does not yet move the whole production harness out of the DO.

## Interactive local demos

Run `bun run agent:studio` from the repository root for agent chat URLs, live
TypeScript/Python application state, code/tool traces, run reviews and browser
voice controls. See [Local Agent Studio](studio/README.md) for Python setup,
model configuration and the distinction between live and scripted runs.

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
| `GET /agents/:id` | PID, busy/interrupted state, message count |
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

Native Pi messages are saved atomically after `message_end`, preserving message
objects instead of converting them to UI messages. A settled process can be
restarted with its history. An interrupted prompt leaves an active marker and
refuses further work until its effects/history have been reconciled. This
prototype deliberately has no automatic re-drive: repeating an interrupted
tool could duplicate a side effect. There is no reconciliation API yet; inspect
the snapshot and reconcile it offline with the process stopped. Diagnostic
`execute` calls are not journaled. Snapshots are local files, not replicated
durable storage, and the whole transcript is loaded into memory.

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
process group. Production ChatThreadDO routing remains unchanged.

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

The next integration step is an opt-in ChatThreadDO driver that replaces the
in-isolate Pi session with supervisor requests and consumes Pi events through
the existing UI chunk encoder. Before switching real users, port/bridge these
existing behaviors:

- `chat-thread-do.ts` model resolution, provider-specific routing, prompt/skills,
  context transformation/compaction, billing and usage checks.
- `chat-thread/pi-tools.ts` top-level interactive tools, subagent spawning and
  scoped tool discovery; subagents should call supervisor `start`, not `new Agent`
  inside the parent process.
- `pi_core_*` ownership, turn journals, tool outcome evidence, steering,
  interrupted-history repair, bounded recovery and durable replay cursors.
- `pi-chunk-encoder.ts` streaming, previews, artifacts, completion metadata and
  reconnect/resume behavior.

No existing browser/Worker route has been switched, no VM has been provisioned,
and no deployment is required to review or run this prototype.
