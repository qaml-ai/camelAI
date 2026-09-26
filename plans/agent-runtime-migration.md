# Moving the agent loop to the hosted agent runtime

Status: phase 1 (MCP server) built and tested end to end locally. Phases 2+
wait for Miguel's answers to the open questions below.

Today `ChatThreadDO` runs the Pi agent in the Durable Object: model calls,
retries, compaction, transcript durability, isolate-death recovery, tools. The
hosted agent runtime (`qaml-ai/agent-runtime`, <https://agents.camelai.dev>)
does the model loop, history, compaction, retries and turn handoff itself. After
the move chiridion is:

1. **An MCP server** the runtime calls for tools: `/mcp/agent`
   (`workers/main/src/routes/agent-mcp.ts`, built).
2. **A client** that creates one runtime agent per thread, sends prompts, and
   streams the agent's events into the existing chat UI (the ChatThreadDO
   adapter, not built).

```text
browser ─WS/poll─ ChatThreadDO ──POST prompt/steer/abort──> runtime (AWS us-west-2)
                     ^  └──── SSE /clients/:id/events <──┘      │
                     │                                           │ tools/call + identity JWT
                     └── UI state RPCs (preview, todos) ── /mcp/agent (Worker) ── CodeModeToolsBinding
                                                                   └─ OrgDO, WorkspaceFilesystemDO, sandboxes, R2
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
- **Served so far** (`AGENT_MCP_TOOL_NAMES`):
  - read-only: workspace_info, list_projects, list_commits, list_apps,
    list_deploy_versions, get_latest_logs, list_scheduled_prompts,
    connections_list, read_skill, ls, read, grep, find;
  - one write path: `write` / `edit` on workspace or project files.
  - Adding a stateless tool is one name in the set.
- **Config** (`Env`):
  - `AGENT_RUNTIME_URL` (default `https://agents.camelai.dev`);
  - `AGENT_RUNTIME_TENANT`: when set, tokens for any other tenant are refused;
  - `AGENT_RUNTIME_MCP_AUDIENCE`: only needed behind a proxy.
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

## 4. ChatThreadDO adapter (design only)

One runtime agent per thread, created lazily on the thread's first
runtime-backed turn:

- **Create.** `POST /v1/agents` with the operator key and:
  - `definition`: the environment's definition (camel MCP server, builtins
    `web_search`/`web_fetch`);
  - `subject`, `context` (section 2);
  - `ttlSeconds: null` (the default TTL is one day);
  - `idempotencyKey: "thread:<threadId>"`, so a retried create returns the
    same agent.
- **Store** in DO KV: `runtime_agent = {id, token}`, `runtime_cursor`,
  `runtime_request` (the in-flight request id = the turn id).
- **Model and system prompt.** A definition supplies model and system prompt,
  and creating an agent from one refuses both (`definitions.ts:176`).
  - Until R1: create, then `PATCH /v1/agents/:id/configuration {model, systemPrompt}`
    before the first prompt. It is queued ahead of it.
  - The model is chiridion's per-thread choice mapped to a runtime
    `provider/model`.
  - The system prompt is `createPiSystemPrompt` (~3.4K tokens; only ids and
    skills vary). The per-turn parts (verified-work state, the automation
    outcome block) move into the prompt text.

**Turn.** `sendRunnerCommand` keeps its shape, but instead of `piSession.prompt`:
1. Run the existing gates (ban list, org credits, user limits) before
   submitting.
2. `POST /v1/agents/:id/prompt {text, actor, requestId: turnId}`. Messages
   during a turn go to `steer`.
3. Hold `GET /clients/:id/events` (agent token, `Last-Event-ID: cursor`) open
   while a turn runs.
4. Each frame's `event` is a native Pi `AgentEvent`, so it goes into the
   existing `handlePiSessionEvent` → `PiChunkEncoder` path unchanged. This is
   what makes the adapter small: the encoder, UIMessage parts, ai-chat
   resumable stream and client all stay.
5. `message_end` rows are still appended to `pi_core_*`. They are now a render
   mirror, not the model's context, so `derived-render-page` keeps working.
6. The `response` frame for our request id ends the turn (finish chunk,
   metadata, usage). Usage is recorded from `message_end.usage` as today.
7. Persist the cursor after non-delta frames only, as the SDK does.

**Reconnect / DO restart.**
- On wake with `runtime_request` set, reopen the stream from the cursor and
  let ai-chat's resumable stream rebuild the UI.
- On 409 (REPLAY_GAP), fetch `GET /v1/agents/:id/history` and the request
  outcome, re-derive the render window, and broadcast `CHAT_MESSAGES`.
- Never re-prompt to reconstruct a stream. The runtime resumes a turn itself
  if its node dies (`turn_resumed`/`turn_recovered` become a `data-pi-turn-notice`).

**Abort.** `requestStop` sends `POST /v1/agents/:id/abort` and ends the local
stream. The runtime cancels in-flight MCP calls: the request's signal aborts.

**What becomes dead code** (behind the flag first, deleted after rollout):
- Pi session lifecycle, `streamPiModel`/pi-stream-retry, pi-compaction.
- The turn journal, resume ladder, salvage, transient retry, the stall
  watchdog's session disposal, and most OOM guards.
- In-DO subagents.

That is roughly `chat-thread-do.ts` 4675-4790, 5484-6116, 7633-8627,
8865-8950 and 10513-11190.

**Other ingress** (Slack, email, Telegram, Discord, cron, evals) all enters
through `startInitialUserMessage`/`enqueueRunnerUserMessage`, so they switch
with the thread. Evals call `piSession.prompt` directly and need their own
small change.

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
- **Name clash.** The runtime's own `read/write/edit/ls/glob/grep` over
  `/workspace` sit next to `camel__read` etc. Two file systems with the same
  verbs will confuse the model (R3).

## 6. Rollout flag

There is no generic flag system. Use the pattern of the KV ban list, which is
already checked where messages are accepted (`isOrgBanned`, CTD:6433):

- `AGENT_RUNTIME_ENABLED` (env kill switch), plus a KV allowlist
  `agent_runtime_org:<orgId>`, managed through an admin route.
- The decision is pinned per thread at its first turn (`runtime_backend`
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

## 8. Open questions for Miguel

1. **Tenant and billing.** One chiridion tenant per environment with
   `billing: "none"` and camelAI's provider keys?
   - Then per-org credits, user limits and the free-model fallback stay in
     chiridion. They can be checked before each prompt, but not before each
     model call mid-turn: a long turn can overdraw.
   - Acceptable, or do we need R6?
2. **BYOK and provider routing.** Orgs with their own keys (Anthropic,
   OpenAI, OpenRouter, Bedrock, Codex subscription) and AI Gateway metadata
   cannot be served by one tenant's keys.
   - Options: keep those orgs on the in-DO loop, or R6.
3. **AskUserQuestion and confirmations.** Should they block inside the tool
   call (needs the MCP timeout ≥ the user's think time), or end the turn with
   the question and take the answer as the next message? The latter is simpler
   and stateless. It also covers delete_* confirmations and
   prompt_connection_setup.
4. **js_exec capabilities.** Today's js_exec has env.CONNECTIONS, AI (image
   gen, transcription), BROWSER, SECURE_FETCH, WORKSPACE/PROJECTS and
   `connections[alias]`. The runtime's has `tools.*` and `fs` only. Expose the
   missing ones as MCP tools (connections_invoke, generate_image,
   browser_action, …), accepting that scripts change shape?
5. **Subagents.** Explore/Research as child runtime agents (a definition each,
   deleted after use), or drop them in favour of js_exec + web tools?
6. **Model catalog.** Map chiridion's picker to the runtime's `/v1/models`;
   what happens to models it lacks (deepseek free tier, Bedrock)?
7. **Rollout order.** Staff orgs → free tier → paid? Evals first?

## 9. Runtime changes needed (for the lead)

- **R1.** Allow `model` and `systemPrompt` (ideally `systemPromptAppend`)
  alongside `definition` at creation (`src/definitions.ts:176` rejects them).
  Chiridion threads choose their model, and the prompt carries thread ids.
  Workaround: `PATCH /configuration` right after create.
- **R2.** Send the model's tool call id to remote MCP servers. `_meta` for
  definition sources carries only `agent-runtime/origin`
  (`src/tool-sources.ts:359`); attached servers also get `callId`,
  `toolCallId` and `actor` (`src/client-sessions.ts:1348`). Chiridion needs
  `toolCallId` (the js_exec call's id for calls from code) to key tool
  progress and preview updates to the UI's tool part. Better still: relay MCP
  `notifications/progress` as `tool_execution_update` events.
- **R3.** A definition option to leave out the runtime's file tools (keep
  the `/workspace` mount for attachments and tool outputs), or to let a
  definition source's `read/write/...` take precedence. Otherwise the model
  sees two file systems.
- **R4.** MCP `timeoutMs` is capped at 600 s (`src/tool-sources.ts:136`).
  deploy_project and run_notebook can run up to chiridion's 20-minute tool
  limit (cold container plus build). Raise the cap to 1,200 s, or reset the
  timeout on progress notifications.
- **R5.** Publish `@camelai/agent-runtime` with `./server` and `./testing`,
  so chiridion can drop the vendored tarball.
- **R6** (depends on Q1/Q2). A per-agent provider key or base URL (a
  chiridion inference proxy that applies BYOK and credit gates per model
  call), or a per-agent spend limit.

## 10. Local end-to-end recipe

```sh
# runtime (from ~/agent-runtime), own database
docker exec agent-runtime-pg psql -U postgres -c "create database chiridion_mcp"
AGENT_TENANTS_FILE=… AGENT_SECRETS_KEY=<64 hex> AGENT_SESSION_SECRET=… \
AGENT_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/chiridion_mcp \
AGENT_PUBLIC_URL=http://127.0.0.1:8795 PORT=8795 \
AGENT_OUTBOUND_ALLOW_HTTP=true AGENT_OUTBOUND_ALLOW_CIDRS=127.0.0.1/32 \
node --experimental-strip-types src/server.ts

# chiridion: .dev.vars gets AGENT_RUNTIME_URL=http://127.0.0.1:8795 and AGENT_RUNTIME_TENANT=chiridion
E2E_LOCAL=1 bun run dev:local-auth
# POST /v1/definitions {mcpServers:[{name:"camel",url:"http://127.0.0.1:3001/mcp/agent",auth:{type:"runtime"}}]}
# POST /v1/agents {definition, subject:<user>, context:{org,workspace,thread}}
# POST /v1/agents/:id/prompt {text, actor}
```
