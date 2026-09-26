# Moving the agent loop to the hosted agent runtime

Status: phase 2 built and tested end to end locally: the MCP server, the
ChatThreadDO adapter (behind a flag, new threads only) and the inference proxy.
Human input (ask-user tools, confirmations) waits for the runtime's v1.

Today `ChatThreadDO` runs the Pi agent in the Durable Object: model calls,
retries, compaction, transcript durability, isolate-death recovery, tools. The
hosted agent runtime (`qaml-ai/agent-runtime`, <https://agents.camelai.dev>)
does the model loop, history, compaction, retries and turn handoff itself. After
the move chiridion is:

1. **An MCP server** the runtime calls for tools: `/mcp/agent`
   (`workers/main/src/routes/agent-mcp.ts`, built).
2. **A client** that creates one runtime agent per thread, sends prompts, and
   streams the agent's events into the existing chat UI (the ChatThreadDO
   adapter, `workers/main/src/chat-thread/runtime-agent.ts`).
3. **An inference proxy** the runtime sends every model call to
   (`workers/main/src/routes/agent-runtime-llm.ts`), so chiridion keeps its
   model routing, BYOK, credit and user-limit gates and usage metering.

```text
browser ─WS/poll─ ChatThreadDO ──POST prompt/steer/abort──> runtime (AWS us-west-2)
                     ^  └──── SSE /clients/:id/events <──┘      │
                     │                                           │ tools/call + identity JWT
                     └── UI state RPCs (preview, todos) ── /mcp/agent (Worker) ── CodeModeToolsBinding
                     │                                             └─ OrgDO, WorkspaceFilesystemDO, sandboxes, R2
                     └── runtimeChatCompletion ── /agent-runtime/llm/v1/chat/completions <── model calls (same JWT)
```

## 1. The MCP server (built)

- **Route.** `ALL /mcp/agent` in `workers/main/src/index.ts`. It is
  stateless Streamable HTTP with JSON answers, no session and no Durable
  Object. It uses `serveTools` from the runtime SDK
  (`@camelai/agent-runtime/server`), which verifies the runtime's identity
  token on every request:
  - Ed25519 signature against `${AGENT_RUNTIME_URL}/.well-known/jwks.json`;
  - issuer, audience (the request URL, or `AGENT_RUNTIME_MCP_AUDIENCE`) and expiry;
  - a missing or bad token gets 401.
- **Implementation reused.** Each call goes to
  `ctx.exports.CodeModeToolsBinding({ props }).callToolEnvelope(name, args)`.
  That binding already implements every non-subagent tool, the same one
  js_exec's `tools.<name>()` uses. Its props are only
  `{orgId, workspaceId, threadId, userId}`, so nothing about the Pi loop is
  needed to serve a tool.
- **Result mapping.**
  - Tool failures become `isError` results.
  - Object results become a JSON text block plus `structuredContent`.
  - The Pi file tools' own `{content:[text|image]}` blocks pass through
    unchanged, so an image read reaches the model as an image.
  - A result with an `imageDataUrl` (browser_action screenshot,
    take_screenshot) becomes an image block plus the rest as JSON.
- **Served** (`AGENT_MCP_TOOL_NAMES`): every non-hidden
  `CODE_MODE_TOOL_DEFINITIONS` entry minus `AGENT_MCP_EXCLUDED_TOOL_NAMES`:
  - excluded: AskUserQuestion, prompt_connection_setup, delete_app,
    delete_project, delete_connection (wait on the ask-user design, Q3);
    WebSearch/WebFetch (runtime builtins); Agent/Explore/Research/Oracle
    (subagents dropped); hidden warehouse_* aliases.
  - UI-state tools (TodoWrite, set_preview, deploy_project's preview...)
    reach the thread's DO by RPC with the signed threadId.
  - js_exec's binding-only capabilities are registry tools (Q4, decided):
    connections_query / connections_invoke (connections[alias]),
    browser_launch / browser_action (env.BROWSER), generate_image /
    transcribe_audio (env.CAMELAI; images saved to R2 outputs and returned
    as image content), http_request (SECURE_FETCH's dispatcher route; only
    this workspace's deployed apps, since the runtime's `web_fetch` is the
    way to the web).
  - Browser sessions opened over MCP are not closed when a run ends (js_exec
    closed its own); they rely on browser_action close or the 5-minute
    auto-close.
  - report_automation_outcome is a binding tool calling
    `ChatThreadDO.recordAutomationOutcome` (which validates the active run).
- **Config** (`Env`):
  - `AGENT_RUNTIME_URL` (default `https://agents.camelai.dev`);
  - `AGENT_RUNTIME_TENANT`: when set, tokens for any other tenant are refused;
  - `AGENT_RUNTIME_MCP_AUDIENCE` / `AGENT_RUNTIME_LLM_AUDIENCE`: only needed
    behind a proxy;
  - adapter: `AGENT_RUNTIME_ENABLED`, `AGENT_RUNTIME_API_TOKEN` (operator
    token, a secret), `AGENT_RUNTIME_DEFINITION`.
- **SDK dependency.** `serveTools` and `testRuntime` are not on npm yet
  (npm has 0.4.0 without `./server`). The SDK is vendored as
  `vendor/camelai-agent-runtime-0.4.0-9bb8ecd.tgz`, built from agent-runtime
  9bb8ecd. Swap it for the published version when it ships.
- **Tests.** `bun run test:workers -- agent-mcp` (`testRuntime()` signs real
  tokens). They cover:
  - bad, expired, wrong-audience and wrong-issuer tokens;
  - the actor, not the subject, being authorized;
  - OrgDO denial, wrong tenant, and a missing thread;
  - image passthrough, errors, and unknown tools.
- **Verified end to end locally.**
  - Setup: a local runtime on :8795 (tenant `chiridion`, identity tokens
    issued by `http://127.0.0.1:8795`), a definition with
    `mcpServers: [{name: "camel", url: "http://127.0.0.1:3001/mcp/agent", auth: {type: "runtime"}}]`,
    and an agent with `subject` = the thread's creator and
    `context = {org, workspace, thread}`.
  - The runtime listed the 15 `camel__*` tools.
  - A prompt called `camel__workspace_info`, `camel__write`, `camel__read` and
    `camel__list_projects`. The file landed in the chiridion workspace (read
    back through `/api/workspaces/:id/fs/content`).
  - The same prompt with `actor: "intruder-user"` got `Forbidden (forbidden)`
    on every call.

## 2. Identity and authorization

| Token claim | Set by chiridion when | Meaning in chiridion |
| --- | --- | --- |
| `tenant` | runtime tenant of the operator key | must equal `AGENT_RUNTIME_TENANT` (one chiridion tenant per environment) |
| `sub` | `createAgent({ subject })`, once | the thread's creator (`threads.created_by`) |
| `ctx` | `createAgent({ context })`, once | `{ org, workspace, thread }` |
| `act` | each `prompt({ actor })` | the chiridion user who sent this message |
| `origin` | runtime, for its own channels | unused (chiridion keeps its own Slack/email/Telegram/Discord ingress) |

Every `tools/call` authorizes `act ?? sub` with
`OrgDO.validateChatWebSocketAccess(user, workspace, thread)`, the same check
the chat socket uses. It requires:
- an unarchived org and workspace;
- org membership;
- full workspace access;
- the thread belongs to that workspace.

The check runs per call, so removing a member cuts off tool access
immediately. No per-user secret is stored.

Rules for the adapter:
- Always pass `actor` = the sending user. Web: the session user. Channels: the
  mapped chiridion user, else omit so the thread creator (`sub`) acts.
  Automations: the schedule's owner.
- Send `from` only for shared/group threads. The model never needs `act`.

## 3. Tool inventory and mapping

Source: registry at `code-mode-tools.ts:738-1397`, dispatch at `:1941` and
`:3246`, and Pi surface in `chat-thread/pi-tools.ts:393`. "Stateless" means the
binding only needs org/workspace/thread/user.

| Group | Tools | Needs at call time | Runtime mapping |
| --- | --- | --- | --- |
| Files | read, write, edit, ls, grep, find (served); delete, move | WorkspaceFilesystemDO / R2 (`location: workspace, project, r2`) | MCP, `both` exposure (see R3 on name clashes) |
| Projects | list_projects, list_commits (served); create_project, set_project_description, add_shadcn_component, revert_project, delete_project* | WorkspaceFilesystemDO | MCP |
| Build/deploy | add_dependency, deploy_project, rollback_deploy, list_deploy_versions (served) | ProjectBuildSandbox, OrgDO; deploy ends with `setPreview` on the thread DO | MCP; needs R4 (timeouts) and progress (R2) |
| Apps | list_apps, get_latest_logs (served); take_screenshot, delete_app*, set_app_visibility, set_preview | OrgDO, WORKER_LOGS, Browser Rendering; set_preview RPCs `ChatThreadDO.setPreviewTarget` | MCP; UI state is reached by RPC to the thread DO, which still owns it |
| Analysis | run_notebook, run_code, analysis_exec, inspect/extract_archive, add_python_dependency, analysis_list_connections | AnalysisSandbox | MCP |
| Connections | connections_list (served), _get/_tools/_methods/_find/_test/_verify, connections_invoke; list/create_integration, prompt_connection_setup*, delete_connection* | connections-runtime, DbQuerySandbox | MCP (`codemode` exposure; they're a long tail) |
| Automations | 5 scheduled-prompt tools, 7 workflow tools, report_automation_outcome | WorkspaceCronDO | MCP; keep chiridion's cron, not the runtime's `schedule` builtin |
| Domains, messaging | 4 custom-domain tools; send_email/slack/telegram/discord | OrgDO, channel creds | MCP |
| UI interaction | AskUserQuestion, TodoWrite | the thread DO's live state | MCP tool that RPCs the thread DO; AskUserQuestion needs a decision (Q3) |
| Web | WebSearch, WebFetch (Research only today) | OrgDO allowance | runtime builtins `web_search`, `web_fetch` |
| Code | js_exec | CODE_MODE_LOADER with env.CONNECTIONS/AI/BROWSER/SECURE_FETCH/WORKSPACE/PROJECTS | the runtime's js_exec (QuickJS, `tools.*` + `fs` only); binding-only capabilities need tools (Q4) |
| Subagents | Agent, Explore, Research (Oracle unregistered) | in-DO Pi loop, model resolution, usage | child runtime agents (Q5) |

\* These confirm through AskUserQuestion today, so they follow its design.

**Tool progress.** Today `deploy_project`/`add_dependency` stream
`Build environment is starting…` via `ChatThreadDO.streamToolProgress`, keyed by
the Pi tool call id. The MCP tool can keep doing that by RPC to the thread DO,
but only if the runtime tells it which model tool call it is serving (R2).

**Pre-existing bugs found in the survey** (worth fixing regardless):
- The stop button's abort signal is dropped at `chat-thread-do.ts:8955`, so a
  running tool is not freed on stop.
- `deploy_project` and `run_notebook` throw after the app is already live when
  there is no threadId (workflow deploys).
- Direct top-level deploys get no build progress (no `parentToolUseId`,
  `chat-thread-do.ts:8930`).

## 4. ChatThreadDO adapter (built)

`RuntimeAgentSession` (`chat-thread/runtime-agent.ts`) stands where the
in-process Pi `Agent` stands, with the members the DO uses (`state`,
`subscribe`, `prompt`, `steer`, `abort`, `continue`, `waitForIdle`). The
runtime's event stream carries native Pi `AgentEvent`s, so
`handlePiSessionEvent` → `PiChunkEncoder` → ai-chat → the browser, and the
`pi_core_*` render mirror, run unchanged. `camel__` tool names are mapped back
(`camel__list_apps` → `list_apps`) so the UI's tool renderers apply.

- **Backend pin.** `resolveAgentBackend` pins `agentBackend` in DO KV the
  first time a thread is asked: `runtime` only for a thread the model has
  never answered (one probe of `pi_core_messages`), in an allowlisted org,
  with `AGENT_RUNTIME_ENABLED=true`. Everything else is `pi`; with the flag
  unset nothing is written.
- **Create** (lazily, first run): `POST /v1/agents` with the operator token
  (`AGENT_RUNTIME_API_TOKEN`), `Idempotency-Key: thread_<id>`,
  `definition: AGENT_RUNTIME_DEFINITION`, `model: chiridion/<thread model id>`
  (falling back to `chiridion/default` for ids the catalog lacks),
  `thinkingLevel`, `systemPromptAppend` (a preamble mapping tool names and
  js_exec bindings to this surface, then `createPiSystemPrompt`),
  `fileTools: false`, `ttlSeconds: null`, `subject` (the thread creator) and
  `context {org, workspace, thread}`.
- **DO KV.** `runtimeAgent {id, token, model}`, `runtimeAgentCursor` (the event
  cursor at the last run boundary), `runtimeAgentRun {requestId, cursor}` (the
  run in flight and where it began).
- **Run.** `POST /clients/:id/requests {method: prompt, params: {text, actor}}`
  with the agent token, then `GET /clients/:id/events` from the start cursor
  until the run's `response` frame. A thread model change is configured
  (`PATCH …/configuration {model}`) before the next run. A scheduled run's
  outcome instructions go ahead of its message (the prompt is fixed at
  creation). Runtime heartbeats keep the DO's stall watchdog quiet during
  long tool calls. A run the runtime refuses (402, spend limit) is closed with
  an error message and `agent_end`, so the turn ends normally.
- **Steer / stop.** A message sent while a run streams becomes a `steer`
  request (no actor: it joins the run's). Stop sends an `abort` request; the
  runtime's `agent_end` and `response` close the turn as usual.
- **DO restart.** `resumeActivePiTurn` relays the run in flight again from its
  start cursor (the runtime buffers the run's events), without prompting
  again. A turn admitted while the session was cold goes through the same
  branch and prompts its unanswered user messages. A run the runtime never
  took is closed with "did not reach the agent". A replay gap (409) recovers
  the run's messages from `/history`.
- **Unchanged / dead for runtime threads.** Usage is not metered from
  `turn_end` (the proxy meters each call); the transient-retry deferral, the
  journal resume ladder, compaction and provider streaming are not used;
  `disposePiSession` stops relaying without aborting the remote run.
  Deleting that code waits for the rollout.
- **Other ingress** (Slack, email, Telegram, Discord, cron) enters through
  `startInitialUserMessage` and follows the thread's pin. The eval runner calls
  `piSession.prompt` directly and is not ported.

Verified locally (runtime from agent-runtime main, chiridion `bun run
dev:local-auth`): a new thread's first message created the runtime agent,
the runtime called `camel__list_apps` and `camel__read` in parallel through
MCP, every model call went through the proxy (reasoning included; the tool
continuation after thinking worked, so signatures round-trip), the UI stream
got ListApps/Read tool parts and text, the render history reloads, a second
turn kept context, steer and stop worked, and `usage_log` rows carry the
acting user and cache reads. Not exercised live: a DO restart mid-run (unit
tested), and 402/429 from the proxy ending a runtime turn.

## 5. Files

- **Source of truth stays chiridion.** Project and workspace files stay in
  WorkspaceFilesystemDO/R2; uploads and outputs stay in R2
  (`{org}/{ws}/user-uploads|user-outputs`). The model reaches them only
  through `camel__*` file tools.
- **Uploads stay unchanged.** They go through `/api/workspaces/:id/upload` and
  the prompt refers to them by path, as today. Optionally, small images and
  PDFs can also be passed as prompt `files` (inline, ≤4 MiB) so the model sees
  them natively without a read.
- **The runtime's `/workspace` volume is scratch only:** tool outputs it
  saves (images from MCP results over 64 KiB, `web_fetch` binaries),
  attachments, `present_file`. Chiridion does not mirror it.
  - Anything the user should keep is written with `camel__write` to R2
    outputs.
  - A `file_presented` event (with its signed URL) can be shown in chat as a
    download.
- **No name clash.** Runtime agents are created with `fileTools: false`, so
  the runtime's own `read/write/...` are gone; `fs`, `present_file` and
  attachments stay.

## 6. Rollout flag

There is no generic flag system. Use the pattern of the KV ban list, which is
already checked where messages are accepted (`isOrgBanned`, CTD:6433):

- `AGENT_RUNTIME_ENABLED` (env kill switch), plus a KV allowlist
  `agent_runtime_org:<orgId>` in `APP_KV`, managed with
  `GET/PUT/DELETE /api/admin/orgs/:id/agent-runtime`.
- The decision is pinned per thread at its first turn (`agentBackend`
  in DO KV) and never flips. Existing threads keep the in-DO loop, and new
  threads in allowlisted orgs use the runtime. Transcripts are not migrated.
  Importing history later is possible with `initialMessages`.
- Kill switch semantics: new threads fall back to the in-DO loop. Pinned
  runtime threads keep using the runtime.

## 7. Latency and cost risks

- **Tool call path.** runtime (us-west-2) → nearest Cloudflare POP (SJC/SEA)
  → Worker → OrgDO auth RPC → binding → the tool's DO/container. DOs live
  where they were created, so for EU orgs every tool call crosses the Atlantic
  twice. Once for the auth RPC:
  - Option 1: cache the grant for the token's `jti` lifetime.
  - Option 2: authorize once per MCP session. Not possible statelessly.
  
  And once for the tool itself, which is the same as today.
- **Expected overhead.** Roughly 20–50 ms per call in the US and 150–300 ms
  for EU-homed orgs, on top of today's cost.
- **js_exec fan-out.** A script that makes many calls pays this per call. It
  used to be an in-isolate RPC.
- **Measure before rollout.** `get_latest_logs` p50/p95 from the runtime,
  in staging.
- **Token streaming.** us-west-2 → the thread DO over SSE adds one hop. The
  DO stays awake while a turn's stream is open (it already does today).
- **Connection setup.** The runtime keeps one MCP connection per agent
  (`initialize` + `tools/list` on start, cached five minutes), so a cold
  agent's first turn pays those round trips.
- **JWKS.** `serveTools` caches the runtime's keys per isolate in a
  module-level map (five minutes). That is a mutable module cache, which
  AGENTS.md discourages, but it holds only public keys.

## 8. Decisions (Miguel) and what is left

1. **Billing and routing: an inference proxy in chiridion** (built, section
   10). The runtime tenant bills nothing for these calls; chiridion keeps
   per-call gates, BYOK/Bedrock/Codex/self-host routing and metering.
2. **Ask-user tools** (AskUserQuestion, prompt_connection_setup, delete
   confirmations): the runtime's human-input v1 (`ctx.confirm/ask/requireUrl`
   in serveTools, the `ask_user` built-in, `POST /v1/agents/:id/inputs/:id`).
   Not built here until v1 lands; the tools are not served meanwhile.
3. **Subagents:** dropped for launch.
4. **js_exec capabilities:** exposed as tools (section 1).

Left: human input (2); porting the eval runner; an actor for automation
threads without a user (`subject` falls back to the thread creator); a
browser-session cleanup at run end; measuring tool-call latency from us-west-2
in staging; per-tool `exposure` for remote MCP servers (R7) instead of relying
on list order for the 64 direct tools.

## 9. Runtime changes

Landed on agent-runtime main: R1 (`model`, `thinkingLevel`,
`systemPromptAppend`, `fileTools` alongside a definition), R2 (`_meta`
`agent-runtime/toolCallId`/`innerCallId`/`actor`, MCP progress relayed as
`tool_execution_update`), R3 (`fileTools: false`), R4 (1,200 s MCP tool
timeouts, reset by progress; js_exec itself still caps at 120 s, hence the
direct-first tool order), R6 (a tenant's `modelEndpoints`, identity-token
authenticated). Still needed:

- **R5.** Publish `@camelai/agent-runtime` with `./server` and `./testing`,
  so chiridion can drop the vendored tarball.
- **R7.** Per-tool `exposure` for remote MCP servers (today only attached
  servers read `_meta["agent-runtime/exposure"]`), so chiridion can pick its
  direct tools instead of relying on list order.
- Human-input v1 (decision 2).

## 10. Inference proxy (built)

`POST /agent-runtime/llm/v1/chat/completions` (`routes/agent-runtime-llm.ts`):
verifies the runtime identity token (SDK `verifyRuntimeToken`, audience = the
base URL or the endpoint, or `AGENT_RUNTIME_LLM_AUDIENCE`), authorizes
`act ?? sub` in `ctx` like the MCP server, then calls the thread's
`ChatThreadDO.runtimeChatCompletion`. That converts the OpenAI request to a
Pi context (`agent-runtime/openai-bridge.ts`), resolves the thread's current
model (`piModelResolver`: picker, BYOK, Bedrock, Codex, credit fallback),
applies the user-limit gate as the acting user, streams through
`streamPiModel` (provider retries, Bedrock region fallback, prompt caching
keyed by thread) and streams chat-completion chunks back; the final message is
metered with `recordPiAssistantUsage`. Gate refusals are 429 (user limit) or
402 (credits) before any stream. The request's `model` is informational.
Thinking/thought signatures ride as `reasoning_details` keyed by tool call id
and are restored on the way back in.

## 11. Local end-to-end recipe

```sh
# runtime (from ~/agent-runtime main), own database; tenants file entry:
#   "chiridion": {"tokenSha256": …, "modelEndpoints": {"chiridion": {
#     "baseUrl": "http://127.0.0.1:3001/agent-runtime/llm/v1",
#     "models": {"default": {"contextWindow": 200000, "maxTokens": 16000, "reasoning": true, "input": ["text", "image"]}},
#     "compat": {"maxTokensField": "max_tokens"}}}}
docker exec agent-runtime-pg psql -U postgres -c "create database chiridion_r6"
AGENT_TENANTS_FILE=… AGENT_SECRETS_KEY=<64 hex> AGENT_SESSION_SECRET=… \
AGENT_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/chiridion_r6 \
AGENT_PUBLIC_URL=http://127.0.0.1:8795 PORT=8795 \
AGENT_OUTBOUND_ALLOW_HTTP=true AGENT_OUTBOUND_ALLOW_CIDRS=127.0.0.1/32 \
node --experimental-strip-types src/server.ts

# definition
POST /v1/definitions {"name": "camelai-thread", "model": "chiridion/default",
  "builtins": ["web_fetch", "web_search"], "fileTools": false,
  "mcpServers": [{"name": "camel", "url": "http://127.0.0.1:3001/mcp/agent",
    "auth": {"type": "runtime"}, "exposure": "both", "timeoutMs": 1200000}]}

# chiridion .dev.vars: AGENT_RUNTIME_URL=http://127.0.0.1:8795
#   AGENT_RUNTIME_TENANT=chiridion AGENT_RUNTIME_ENABLED=true
#   AGENT_RUNTIME_API_TOKEN=<operator token> AGENT_RUNTIME_DEFINITION=def_…
npx wrangler kv key put --local --binding APP_KV --persist-to .wrangler/state agent_runtime_org:local-dev-org 1
E2E_LOCAL=1 bun run dev:local-auth
# then start a new chat thread in the UI
```
