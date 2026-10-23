# Moving the agent loop to the hosted agent runtime

Status: phase 2 built and tested end to end locally: the MCP server, the
ChatThreadDO adapter (behind a flag, new threads only), model calls through
the runtime's key scopes with a usage webhook (Codex forwarded), and human input (ask_user questions, delete confirmations) through the
runtime's human-input v1.

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
3. **The keys and the bill:** the runtime calls providers itself with keys
   chiridion keeps in its key scopes (`hosted`, `org_<id>`), chiridion sets
   each agent's model, scope and spend limit before every run, and the
   runtime reports each response's usage to chiridion's webhook, which
   writes usage_log and charges credits. Only the ChatGPT (Codex)
   subscription is still forwarded through chiridion.

```text
browser ─WS/poll─ ChatThreadDO ──POST prompt/steer/abort──> runtime (AWS us-west-2)
                     ^  └──── SSE /clients/:id/events <──┘      │
                     │                                           │ tools/call + identity JWT
                     └── UI state RPCs (preview, todos) ── /mcp/agent (Worker) ── CodeModeToolsBinding
                     │                                             └─ OrgDO, WorkspaceFilesystemDO, sandboxes, R2
                     └── runtimeProviderRequest ── /agent-runtime/llm/openai-codex/* <── Codex calls only (same JWT)
runtime ──model calls, key scope keys──> providers / AI Gateway
runtime ──usage.recorded webhook events (Standard Webhooks)──> /agent-runtime/events (Worker) ── OrgDO usage_log
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
  - adapter: `AGENT_RUNTIME_API_TOKEN` (operator token, a secret) and
    `AGENT_RUNTIME_DEFINITION`; with `AGENT_RUNTIME_TENANT` they turn the
    runtime on (§6);
  - `AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET`: the signing secret of the webhook
    endpoint for run, input and usage events.
- **SDK dependency.** `@camelai/agent-runtime@^0.9.0` from npm (`./server`, `./testing`, and `./watch` in the browser).
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

- **Backend pin.** `resolveAgentBackend` pins `agentBackend` in DO KV when
  the thread's first session is made (§6): `runtime` only for a thread the
  model has never answered (one probe of `pi_core_messages`) whose model has
  a runtime route, on a deployment with the runtime config. Everything else
  is `pi`; without the config nothing is written.
- **Create** (lazily, first run): `POST /v1/agents` with the operator token
  (`AGENT_RUNTIME_API_TOKEN`), `Idempotency-Key: thread_<id>`,
  `definition: AGENT_RUNTIME_DEFINITION`, `model: chiridion/<provider>/<model>`
  from the thread's pass-through route (section 10),
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
MCP, every model call went through the proxy (reasoning included), the UI stream
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

## 6. Which threads run on the runtime

No flag and no allowlist: a deployment turns the runtime on by having a
runtime tenant, i.e. `AGENT_RUNTIME_API_TOKEN`, `AGENT_RUNTIME_TENANT` and
`AGENT_RUNTIME_DEFINITION` all set (`runtimeConfigured`).

- A thread is pinned when its first session is made (`agentBackend` in DO
  KV) and never flips. It goes to the runtime when it is new (the model has
  never answered in it) and its resolved model has a runtime route (§10:
  hosted, free tier, BYOK Anthropic/OpenAI/OpenRouter/Bedrock, Codex).
  Otherwise it stays on the in-DO loop: custom endpoints, self-host
  providers, and every thread that already has a transcript. Transcripts are
  not migrated (`initialMessages` could import history later).
- Each pin is recorded as `agent_backend_pinned` with status `runtime`, or
  the fallback reason `pi_existing_transcript` / `pi_no_runtime_route`, plus
  the provider and model. A runtime thread whose model loses its route
  before the runtime started it is re-pinned `pi_route_changed`. A
  deployment without the runtime config pins nothing and records nothing.
- Turning it off: remove `AGENT_RUNTIME_DEFINITION` and redeploy. New
  threads then use the in-DO loop; threads already pinned to the runtime keep
  using it, since they only need the operator token (§12).

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
2. **Ask-user tools** (built, on the runtime's human-input v1):
   - AskUserQuestion → the runtime's `ask_user` built-in (the definition
     enables it).
   - delete_app/delete_project/delete_connection → `ctx.confirm` with the
     binding's own question (`describeDestructiveConfirmation` stops at the
     confirmation without effect), then the tool runs `preconfirmed` (a
     binding prop only the MCP server sets).
   - prompt_connection_setup → chiridion's in-chat setup form as before, so
     credentials never pass through the runtime; with nobody in the chat,
     `ctx.requireUrl` to the connections page (https only).
   - The adapter keeps a suspended run's UI turn open, asks each input in the
     chat's question card (questions as they are; approvals and confirmations
     Yes/No; URL steps Done/Cancel), answers with
     `POST /v1/agents/:id/inputs/:inputId` as the run's actor, and relays the
     resume run in the same turn. Stop or the 30-minute question timeout ends
     the turn; the input stays pending until the next message supersedes it.
   - Verified live: an ask_user question answered in the chat, a declined and
     an accepted delete_project confirmation.
3. **Subagents:** dropped for launch.
4. **js_exec capabilities:** exposed as tools (section 1).

Left: porting the eval runner; an actor for automation
threads without a user (`subject` falls back to the thread creator); a
browser-session cleanup at run end; measuring tool-call latency from us-west-2
in staging; per-tool `exposure` for remote MCP servers (R7) instead of relying
on list order for the 64 direct tools (R7 landed: tools now carry
`_meta["agent-runtime/exposure"]`: tools that ask are direct, chiridion's
direct set both, the rest codemode).

## 9. Runtime changes

Landed on agent-runtime main: R1 (`model`, `thinkingLevel`,
`systemPromptAppend`, `fileTools` alongside a definition), R2 (`_meta`
`agent-runtime/toolCallId`/`innerCallId`/`actor`, MCP progress relayed as
`tool_execution_update`), R3 (`fileTools: false`), R4 (1,200 s MCP tool
timeouts, reset by progress; js_exec itself still caps at 120 s, hence the
direct-first tool order), R6 (a tenant's `modelEndpoints`, identity-token
authenticated). Still needed:

- R5 landed: `@camelai/agent-runtime` 0.5.0 on npm, which chiridion now depends on.
- **R8.** Answering an input over the API with the operator token but no
  `actor` is refused (403) when the input has an audience; the README says
  the token has authority. Chiridion now sends the run's actor.

## 10. Model calls: key scopes, spend limits, usage webhook (built)

The runtime calls providers directly. chiridion only decides which model and
keys a thread's agent uses, how much it may spend, and bills what the runtime
reports. (An earlier design forwarded every model call through the thread's
DO; it held the DO open for every streamed call and added a hop, which is
cross-Atlantic for EU-placed DOs. Only Codex is still forwarded.)

**Hosted OpenRouter update (2026-10-23):** hosted agents now use camelRun platform keys with no key scope or gateway headers. See [the migration and dependency audit](runtime-platform-openrouter.md). The scope/run descriptions below describe the earlier gateway design.

**Key scopes** (`agent-runtime/key-scopes.ts`, runtime `PUT
/v1/key-scopes/:scope/providers/:provider {apiKey?, baseUrl?, headers?, region?}`;
a `baseUrl` replaces the provider's API root):

| Scope | Providers |
| --- | --- |
| `hosted` | `openrouter`: base URL the AI Gateway's OpenRouter prefix, no key (the gateway holds OpenRouter's), the gateway token as `cf-aig-authorization`, OpenRouter attribution headers |
| `org_<orgId>` | the org's BYOK provider: `anthropic`, `openai`, `openrouter` (key), or `amazon-bedrock` (the Bedrock API key, base `https://bedrock-runtime.<region>.amazonaws.com`) |

Each scope is synced by fingerprint (APP_KV `agent_runtime_key_scope:<scope>`):
new or changed entries are put before stale ones are deleted, and an empty
set deletes the scope. The hosted scope syncs before any hosted run; an org
scope before the org's runs (the lazy backfill) and on
`OrgDO.notifyByokChanged` (BYOK set, rotated, removed).

**Routes** (`agent-runtime/model-routes.ts`): the thread's resolved model
becomes a Pi model id and a scope:

| Thread route | Runtime model | Scope |
| --- | --- | --- |
| hosted (gateway OpenRouter) | `openrouter/<OpenRouter id>` (e.g. `openrouter/anthropic/claude-sonnet-5:nitro`) | `hosted` |
| free tier (camelCode) | `openrouter/openai/gpt-6-luna` (Responses) | `hosted` |
| BYOK Anthropic / OpenAI / OpenRouter | `anthropic/<id>`, `openai/<id>`, `openrouter/<id>` | `org_<id>` |
| BYOK Bedrock (Claude) | `amazon-bedrock/<inference profile id>` (`us.`/`eu.`/`apac.`/`global.`) | `org_<id>` |
| ChatGPT subscription | `chiridion/openai-codex/<model>` (the Codex forwarder, a tenant endpoint) | none |
| custom endpoint, self-host, Bedrock OpenAI models, other dynamic routes | none: the thread stays on the in-DO loop | — |

**Runs.** Before each run `prepareRuntimeRun` resolves the route, gates as the
acting user (credit exhaustion through the resolver, per-user limits against
the model the runtime will call), syncs the scope, and computes the spend limit:
the least of the org's remaining hosted credit (hosted, credit-chargeable only)
and the user's per-limit headroom (null when neither applies). The adapter
creates the agent with `model`, `keyScope`, `spendLimit` and `modelHeaders`,
and PATCHes the spend limit before every run, with the model, scope and model
headers when they changed. Hosted-scope agents send the thread's
`cf-aig-metadata` (as the in-DO loop does) on every model call, so the shared
gateway's logs stay attributed per thread; BYOK and Codex agents send none. A
run the runtime stops at the limit ends with `stopped: "spend_limit"`, which
the adapter shows as an error message after the turn's last response; the next
message then meets the gate's own refusal.

Usage reaches chiridion a few seconds after each response (the runtime's usage
flush, then the webhook), so a message sent right after a turn is gated on
spend that may not yet include that turn. The overshoot is bounded by what one
run can spend inside that lag, and the next run's gate sees it.

**Usage events** (`usage.recorded` on `POST /agent-runtime/events`,
`agent-runtime/usage.ts`; the legacy `/v1/usage-webhook` and its
`/agent-runtime/usage` receiver are gone): Standard Webhooks signature under
`AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET` (`whsec_…`, five-minute tolerance, any of
several signatures). Each event becomes one
usage_log row in the org of its `context`, as `actor ?? subject`, source
`agent_runtime`, source_id the event id (so a redelivery inserts nothing).
The runtime's `amazon-bedrock` is recorded as `bedrock` (chiridion's pricing
name). A subject equal to the agent id (the runtime's stand-in when an agent
has none) is no user. The hosted scope is billed as hosted and credit-chargeable unless the model is
the free tier's or the org is enterprise; an org scope and the Codex endpoint
are BYOK. A provider-reported cost is stored as reported, a catalog cost as
estimated. Events without an org are acknowledged and logged, not billed (an
endpoint's secret is its tenant's, so every signed event is the tenant's own).

**Codex forwarder** (`agent-runtime/codex-forwarder.ts`,
`POST /agent-runtime/llm/openai-codex/codex/responses`): the identity token from
`X-Agent-Runtime-Identity`, the per-user gate, then the subscription's
refreshed access token and real `chatgpt-account-id` in place of the runtime's,
Codex's own headers passed through, and the body forwarded as bytes (the runtime
sends it zstd; a compressed body is not checked for its model, since the agent's
model is one only chiridion sets) to `https://chatgpt.com/backend-api` or
`OPENAI_CODEX_PROXY_BASE_URL`. Not verified live: it needs a connected ChatGPT
subscription.

**Codex enablement** (for checking use later): an org admin connects a
ChatGPT subscription in Settings → Organization → AI provider (device-code
sign-in, `POST /api/orgs/:id/llm-provider` intents `startOpenAiSubscription` /
`pollOpenAiSubscription`), which stores one row in the org's OrgDO table
`openai_subscription` (`id = 'active'`, `account_email`, `plan_type`,
`created_at`). A thread then uses it whenever its model resolves to an OpenAI
model. There is no cross-org index: find users per OrgDO
(`getOpenAiSubscription`, e.g. through `admin_js_exec`), or from `usage_log`
rows with `billing_source = 'byok'` and `provider = 'openai'` on orgs without
an OpenAI API key.

Verified locally end to end (runtime 83ebb52, chiridion dev): the keyless
hosted scope through chiridion (Sonnet `:nitro` over Messages, gpt-5.6-luna
over Responses, the free tier's gpt-6-luna), BYOK Anthropic and Bedrock (with the scope rotating
on a settings change and an existing thread PATCHed to the new route), prompt
caching on second turns, a per-user limit stopping a turn mid-way and then
refusing the next message, webhook rows with provider-reported costs, and a
redelivered event inserting nothing.

## 11. Local end-to-end recipe

```sh
# runtime (from ~/agent-runtime main), own database; tenants file entry:
#   "chiridion": {"tokenSha256": …, "modelEndpoints": {"chiridion": {
#     "baseUrl": "http://127.0.0.1:3001/agent-runtime/llm"}}}   (Codex only)
#   plus the tenant's usage webhook pointing at http://127.0.0.1:3001/agent-runtime/usage
docker exec agent-runtime-pg psql -U postgres -c "create database chiridion_r6"
AGENT_TENANTS_FILE=… AGENT_SECRETS_KEY=<64 hex> AGENT_SESSION_SECRET=… \
AGENT_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/chiridion_r6 \
AGENT_PUBLIC_URL=http://127.0.0.1:8795 PORT=8795 \
AGENT_OUTBOUND_ALLOW_HTTP=true AGENT_OUTBOUND_ALLOW_CIDRS=127.0.0.1/32 \
node --experimental-strip-types src/server.ts

# definition
POST /v1/definitions {"name": "camelai-thread", "model": "openrouter/anthropic/claude-sonnet-5:nitro",
  "builtins": ["web_fetch", "web_search", "ask_user"], "fileTools": false,
  "mcpServers": [{"name": "camel", "url": "http://127.0.0.1:3001/mcp/agent",
    "auth": {"type": "runtime"}, "exposure": "both", "timeoutMs": 1200000}]}

# chiridion .dev.vars: AGENT_RUNTIME_URL=http://127.0.0.1:8795
#   AGENT_RUNTIME_TENANT=chiridion
#   AGENT_RUNTIME_API_TOKEN=<operator token> AGENT_RUNTIME_DEFINITION=def_…
#   AGENT_RUNTIME_WEBHOOK_SECRET=whsec_… (the runtime's webhook secret)
E2E_LOCAL=1 bun run dev:local-auth
# then start a new chat thread in the UI
```

## 12. Staging rollout plan

The steps are in one script Miguel runs (`staging-activate.sh`, kept outside
the repo): runtime tenant, usage webhook, definition, worker secrets, Access
bypass. It prints no secret and is safe to re-run.

**Deploy**
1. Merge this branch; staging deploys it. It is inert there until the
   runtime config exists: without `AGENT_RUNTIME_API_TOKEN`,
   `AGENT_RUNTIME_TENANT` and `AGENT_RUNTIME_DEFINITION` no thread is pinned,
   and the MCP, Codex and usage routes only answer valid runtime tokens or
   signatures.
2. Runtime: nothing to deploy (agents.camelai.dev). There is no staging
   runtime, so staging chiridion uses production's runtime under its own tenant.

**Runtime config** (tenants secret `camelai/agent-runtime/tenants`)
- Tenant `chiridion-staging`: its own operator token (kept at
  `camelai/agent-runtime/operator-token/chiridion-staging`), `billing: "none"`,
  a modest `maxAgents`, and
  `"modelEndpoints": {"chiridion": {"baseUrl": "https://staging.camelai.dev/agent-runtime/llm"}}`
  (Codex only). Its webhook endpoint `https://staging.camelai.dev/agent-runtime/events`
  receives the run, input and `usage.recorded` events (`scripts/agent-runtime-webhook.sh`).
  chiridion creates the `hosted` and `org_<id>` key scopes itself.
- One definition, made with that tenant's token:
  `{"name": "camelai-thread", "model": "openrouter/anthropic/claude-sonnet-5:nitro", "builtins": ["web_fetch", "web_search", "ask_user"], "fileTools": false,
  "mcpServers": [{"name": "camel", "url": "https://staging.camelai.dev/mcp/agent", "auth": {"type": "runtime"}, "exposure": "both", "timeoutMs": 1200000}]}`.
  Its model is only a default: chiridion sets each agent's model and key scope.

**Chiridion staging config**
- Secrets `AGENT_RUNTIME_API_TOKEN` (the tenant's operator token) and
  `AGENT_RUNTIME_EVENTS_WEBHOOK_SECRET` (the webhook endpoint's `whsec_…`).
- Vars in `wrangler.staging.jsonc`: `AGENT_RUNTIME_TENANT=chiridion-staging`,
  `AGENT_RUNTIME_DEFINITION=def_…` (`AGENT_RUNTIME_URL` defaults to
  agents.camelai.dev). Once they are deployed with the secrets, every new
  thread with a runtime route runs on the runtime.
- Cloudflare Access: staging is behind Access, which would block the runtime.
  Bypass `/mcp/agent`, `/agent-runtime/llm/openai-codex` and
  `/agent-runtime/events` only; each refuses anything without a valid runtime
  token or webhook signature.

**Check**
- A new thread: `agent_backend_pinned` status `runtime`, the camel tools on
  its agent, usage_log rows with source `agent_runtime`.
- A thread from before the deploy, and one on a custom endpoint: pinned
  `pi_existing_transcript` / `pi_no_runtime_route`.

**What to measure** (a week of internal use, compared with in-DO threads)
- Tool-call latency from the runtime: `code_mode_project_tool_call_*` and
  lake `tool_calls` durations for runtime threads, plus the runtime's MCP call
  timings, for US- and EU-homed orgs.
- Time to first token and turn duration.
- Turn outcomes: completed / errored / stopped, `agent_backend_pinned` counts
  by status, runtime `turn_resumed`/`turn_recovered`, replay gaps, "did not
  reach the agent" closes.
- Usage parity: `usage_log` rows per turn (source `agent_runtime`, acting
  user), cache-read share, credit and user-limit refusals, spend-limit stops.
- Deploy/notebook tools over MCP (long calls, progress in the UI).
- DO duration and wake counts for runtime threads.

**Rollback**
- Remove `AGENT_RUNTIME_DEFINITION` from `wrangler.staging.jsonc` and deploy.
  The runtime config is then incomplete, so new threads use the in-DO loop at
  once, while threads already pinned to the runtime keep working: their agents
  exist, and the operator token (still set) is all they need.
- Removing the token or the tenant as well would break those pinned threads
  (their transcripts live in the runtime), so leave them until those threads
  are abandoned or a migration back exists.

**Production** would need the same: its own runtime tenant, webhook,
definition, secrets and vars. Deploying this code to production changes
nothing until production has that config; from then on all its new threads
with a runtime route use the runtime. Miguel decides when.
