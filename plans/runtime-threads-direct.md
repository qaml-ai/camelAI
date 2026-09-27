# Runtime threads, browser-direct

Status: design, not started. Base: chiridion `main` 1021a9bb9; agent-runtime `feat/runtime-threads` (2026-09-27).
Replaces the "runtime threads without ChatThreadDO" design (Worker stream proxy, browser-side chunk encoder, history cache, lazy migration).

**Goal:**
- A thread that runs on the hosted agent runtime has no per-thread Durable Object and no chiridion copy of its transcript. The runtime is the only store.
- The browser reads the thread directly from the runtime with the runtime's TypeScript SDK: live stream, reconnect with a turn snapshot, long-poll fallback, older pages. It uses a short-lived, read-only token for one agent, which chiridion mints.
- Every write (send, steer, answer, stop, model change) still goes through a chiridion Worker route. The route checks access, quotas and billing, then calls the runtime with the tenant token.
- The UI renders Pi messages (`user` / `assistant` / `toolResult`) as they are. There is no `UIMessage`, no chunk encoder and no `@cloudflare/ai-chat` on this path.
- Old DO-backed threads are not migrated. They stay viewable, read-only, on the existing path until they are deleted. Then `ChatThreadDO`, the in-DO loop, the WS/poll transport and ai-chat are deleted.

**Why:**
- A DO is billed wall-clock for every streamed turn it relays. `ChatThreadDO` is also where every production memory incident lived: render history, stream buffers, wake spirals.
- The previous design's Worker proxy removed the DO but kept a hop: a Worker invocation per stream and per poll, re-encoding of every frame, plus a history cache and KV snapshot to hide the extra round trip. The runtime now has everything a browser needs: watchers, deltas with a turn snapshot on reconnect, a JSON long-poll, and paged turn-aligned history.
- Runtime threads today keep two copies of history (the `pi_core` mirror plus the ai-chat archive, and the runtime's transcript). They also translate every message three times: Pi → PiRuntimeEvent → UIMessage chunks → the legacy `Message` the renderer actually draws.

---

## 1. Architecture

```
                 reads: SSE / long-poll / history pages
 Browser ──────────────────────────────────────────────────►  Runtime (agents.camelai.dev)
   │   SDK watcher, browser token (read-only, one agent, ~15 min)   ▲   ▲
   │                                                                 │   │ tenant token, /v1/agents/:id/*
   │   writes                                                        │   │
   └── POST /api/threads/:id/{messages,inputs,stop,token}, PATCH model ──► chiridion Worker routes
                                                                     │     (access, bans, quotas, billing,
                                                                     │      attribution, gates)
 Runtime ──► chiridion /mcp/agent              tools; stateless, runtime-signed identity (exists)
         ──► chiridion /agent-runtime/usage    usage webhook, billing (exists)
         ──► chiridion /agent-runtime/events   lifecycle webhook (new)
```

- **Per-thread state in chiridion** is one `OrgDO` row: agent id, model, key scope, preview state. There is no DO, no KV entry and no stored agent token.
- **The browser holds only a browser token.** It is read-only, for one agent, short-lived, and can be limited to an allow-list of event types. It cannot prompt, answer, abort or configure. Chiridion mints it after the same access check as every thread request.
- **Every turn starts server-side.** The send route, automations and channels all call one `startRuntimeTurn()` in the Worker. No turn needs a browser attached. End-of-turn work runs from the lifecycle webhook.

## 2. What ChatThreadDO does for a runtime thread today, and where each job goes

File: `workers/main/src/chat-thread-do.ts` (11,965 lines; "DO" below), plus `workers/main/src/chat-thread/*` (12,134 lines). Line numbers are against `main` 1021a9bb9.

| Job today | Where | New home |
|---|---|---|
| Choose the backend and pin it per thread | DO:7905–7940 (`isRuntimeAgentThread`, `mayRunOnRuntime`, `resolveAgentBackend`); KV `CHAT_AGENT_BACKEND_KEY` | The `OrgDO.thread_runtime` row. A thread with a row is a direct runtime thread. Any other thread is old. |
| Create the agent; store its id, token and cursors | `runtime-agent.ts:371` (`POST /v1/agents`, Idempotency-Key `thread_<id>`); DO KV `runtimeAgent`, `runtimeAgentCursor`, `runtimeAgentRun` | `startRuntimeTurn()` creates the agent with the same idempotency key and stores only its id. There is no agent token and no cursor. |
| Gates before each run | DO:8018 `prepareRuntimeRun` → `runtime-agent.ts:411` `configureRun` | Moved unchanged to `workers/main/src/agent-runtime/run-gates.ts`, called by `startRuntimeTurn()`. |
| Send, steer, abort | DO:3780 `sendMessage` → 6384 `handleClientUserMessage` → 6477 `enqueueRunnerUserMessage`; `runtime-agent.ts:685/746/754` | Worker routes (§4). |
| Relay the event stream | `runtime-agent.ts:501` `relay`, `:443` `emit` | **Gone.** The browser watches the runtime itself. |
| Pi `AgentEvent` → PiRuntimeEvent → UI chunks | DO:9535 `handlePiSessionEvent`; `writePiStreamChunks` → `PiChunkEncoder` (`src/lib/pi-chunk-encoder.ts`, 686) | **Gone.** The SDK folds Pi events into Pi messages (§5.2). |
| WS / poll transport, `cf_agent_*` frames | ai-chat `AIChatAgent`; `chat-thread/{websocket,poll,sse}-connection.ts`; `src/lib/sse-agent-client.ts` (1,122), `use-sse-agent.ts` | **Gone** for runtime threads. The SDK watcher does SSE, then long-poll. |
| Render history: the `pi_core` mirror plus the ai-chat archive | `pi-core-store.ts`, `ui-mirror.ts`, `derived-render-page.ts`, `render-archive-preserve.ts`; DO:2543 `persistMessages`; DO:11639 `getOlderUiMessages` | **Gone.** The runtime's paged history, which the browser reads itself. The loader reads the first page server-side for first paint. |
| Agent state pushed to the UI | DO:1463 `syncAgentState`; `src/lib/chat-agent-state.ts` | Derived in the browser from messages and events, or read from `OrgDO` by the loader (§5.5). |
| Human input | `runtime-agent.ts:593` `answerInputs`, `:154` `runtimeInputQuestions`; DO:8133 `answerRuntimeInput` | The browser sees `input_required` / `input_resolved` on the stream and pending inputs at connect. It answers through a Worker route. `runtimeInputQuestions` moves to `src/lib`. |
| Model change | DO:3776 `refreshModel`, DO:3889 `setModel` | `PATCH /api/threads/:id/model` writes OrgDO. The next send's configure applies it. |
| Tool side effects from `/mcp/agent` | `code-mode-tools.ts` `chatThreadStub` RPCs | See §4.4. |
| Codex forwarder | DO:8078 `runtimeProviderRequest`, called from `routes/agent-runtime-llm.ts:56` | Moves into the route and reads the thread from OrgDO. |
| Turn bookkeeping: streaming status, last message, title, error counts | DO:6546 `updateThreadMetadataForUserMessage`; WorkspaceDO `thread_streaming_status`; `chat-thread/metadata.ts` | The send route at the start, the lifecycle webhook at the end (§4.5). |
| Restart recovery | DO:5655–5668 `resumeRuntimeTurn` | **Gone.** Nothing in chiridion holds a run open. |

Other readers of the DO transcript read the runtime's history server-side with the tenant token instead:
- the thread loader;
- `api/threads.$id.condensed-transcript.ts`;
- `api/admin.threads.$id.jsonl.ts`;
- the fork route;
- agent-eval and the transcript lake;
- automations;
- channel replies.

## 3. The browser token (runtime, new)

`POST /v1/agents/:id/browser-tokens` with the tenant token:

```json
{ "ttlSeconds": 900,
  "scopes": ["events", "state", "history", "inputs"],
  "events": ["agent_start", "agent_end", "turn_opened", "message_start", "message_update", "message_end",
             "tool_execution_start", "tool_execution_update", "tool_execution_end",
             "input_required", "input_resolved", "compaction_start", "compaction_end",
             "auto_retry_start", "auto_retry_end"],
  "subject": "user_123" }
→ 201 { "token": "…", "expiresAt": 1790000900000, "url": "https://agents.camelai.dev" }
```

- **It is stateless and signed.** The runtime already signs Ed25519 identity tokens for tool servers; this is the same machinery. The claims are tenant, agent, scopes, event allow-list, subject and expiry. The runtime stores nothing and revokes nothing: the short TTL is the revocation. Chiridion stores nothing either.
- **What it allows:**
  - `GET /v1/agents/:id/events`: always a watcher, with `deltas=1` forced, and `?poll=1&wait=N`;
  - `GET /v1/agents/:id/state`;
  - `GET /v1/agents/:id/history?limit&before`;
  - `GET /v1/agents/:id/inputs?state=pending`.

  Every other route, and every other agent, is 403 or 404.
- **The event allow-list** filters `event` frames by their inner Pi event type.
  - Runtime-internal frames are always dropped: `mcp`, `ready.connection`, `codemode`, `compaction_usage`, and `spend_limit_reached` unless listed.
  - `response` frames are reduced to `{id, outcome: {stopped, error}}`, with no result payload.
  - Snapshots pass: they contain only messages.
- **Field redaction** is a later option: `redact: ["toolCall.arguments", "toolResult.details", "usage.cost"]` for tenants whose end users must not see tool internals or costs. Chiridion needs at most `usage.cost` at launch (open question 3); thread viewers already see tool arguments and results today.
- **CORS** comes from per-tenant configured origins: `PUT /v1/cors-origins ["https://camelai.dev", "https://staging.camelai.dev", "https://*.camelai.dev"]`.
  - Only requests with a browser token get CORS headers. Operator and API tokens keep today's `Origin` rejection (`server.ts:447`, `client-sessions.ts:1420`).
  - Preflight allows `Authorization`, `Last-Event-ID` and `Accept`, with `Access-Control-Max-Age: 86400`, so a tab pays for one preflight.
- **The token travels in a header, never in the URL,** so it stays out of ALB and proxy logs. The SDK uses `fetch`, not `EventSource`, so this works.
- **Capacity:** browser watchers count against the watcher limits: 32 per agent, and per node 1,024 per tenant and 4,096 in total. Every open runtime-thread tab is one watcher (or one waiting poll), so chiridion alone would pass 1,024 per node. The limits must be per-tenant configurable, and an idle agent's watchers must be cheap (runtime item 3).

## 4. Chiridion server: stateless Worker routes

Every request is authorized by one `OrgDO.validateChatWebSocketAccess(userId, workspaceId, threadId)` call (already used by `agent-mcp.ts:105`). The call also returns the thread's `thread_runtime` row. Runtime calls use the tenant token on `/v1/agents/:id/*`.

### 4.1 Routes

| Route | Does |
|---|---|
| `POST /api/threads/:id/token` | Access check, then `POST /v1/agents/:id/browser-tokens` with the scopes above and `subject` = the user id. Returns `{token, expiresAt, url, agentId}`. The loader calls the same helper, in parallel with the first history page, so first paint needs no extra round trip. Minting is one signature, so no caching is needed. |
| `POST /api/threads/:id/messages` | `startRuntimeTurn()` (§4.2). Returns `{status: "accepted" \| "busy" \| "error", requestId}`, the same `SendMessageResult` shape Chat.tsx uses today, so send recovery keeps working. |
| `POST /api/threads/:id/inputs/:inputId` | Access check, then `POST /v1/agents/:id/inputs/:inputId` with `{action, content, actor: userId}`. The runtime checks that the actor may answer. |
| `POST /api/threads/:id/stop` | `POST /v1/agents/:id/abort`. |
| `PATCH /api/threads/:id/model` | Writes the OrgDO model and model history (existing `updateThreadModel`). The next send's configure applies it, as `configureRun` does today, so a model change never races a running turn. |
| `PUT /api/threads/:id/preview` | Writes preview tabs to `OrgDO.thread_ui_state`. |
| `POST /agent-runtime/events` | The lifecycle webhook receiver (§4.5). |
| `POST /agent-runtime/llm/openai-codex/*` | Unchanged externally. Its body moves from DO:8078 into the route. |

### 4.2 `startRuntimeTurn(thread, sender, text, files, clientMessageId, source)`

This is the send half of `handleClientUserMessage`, moved out of the DO. The send route, automations (`automation-run.ts`, `automations.server.ts`) and channel ingress (`chat-channels.ts`) all call it:

1. Ban check, mention expansion, file-safety preamble.
2. Run gates (`run-gates.ts`, from DO:8018): credits, per-user limits, the model route and key scope, `ensureHostedKeyScope`, `syncOrgKeyScope`, the spend limit, model headers.
3. If the row has no agent yet, create one: `POST /v1/agents` with Idempotency-Key `thread_<id>`, chiridion's definition, and `context: {org, workspace, thread}`. Write the row.
4. `PATCH …/configuration` if the model, key scope or spend limit changed since the row's last configure.
5. `POST /v1/agents/:id/prompt {text, from: {id: userId, name}, actor: initiatorId, requestId: clientMessageId, files, meta, whileRunning: "steer"}`.
   - `requestId` = `clientMessageId` makes retries idempotent. This replaces the `chatAccess` dedupe.
   - `from` replaces `formatAttributedUserMessage`. The runtime stores the sender on the message as data and shows it to the model in a block only the runtime can write. The user's text stays exactly what they typed, and the UI shows `from.name`.
   - `meta` (runtime item 5) carries what the model must not see: `{source: "web" | "slack" | "automation" | …, clientMessageId}`.
   - `whileRunning: "steer"` (runtime item 6) joins a running turn if there is one, and starts one otherwise. Until it ships: `prompt`, and on a busy answer, `steer`.
6. Via `waitUntil`: `OrgDO.threads` last_user_message and updated_at; WorkspaceDO streaming status "running".

### 4.3 Thread metadata in OrgDO

Two new OrgDO tables, kept from the previous design:
- `thread_runtime (thread_id PK, agent_id, model, key_scope, configured_json, created_at)`;
- `thread_ui_state (thread_id PK, preview_json, preview_version, updated_at)`.

Why OrgDO and not D1: `threads` (org-do.ts:1166) and the access check already live there. Authorization and the agent lookup are then one RPC, which every chat request already pays. The writes are small and happen once per turn or per preview change.

### 4.4 Tool side effects (`code-mode-tools.ts`, when `threadId` is a runtime thread)

The tools are already served statelessly from `/mcp/agent` with the runtime-signed identity. Only their `chatThreadStub` calls need new homes:

| RPC | New behavior |
|---|---|
| `setTodoState` :4004 | Nothing. The UI reads todos from the latest todo tool call. |
| `setPreviewTarget` :4043/:4085, `setPreviewAppVisibility` :4202 | Write `thread_ui_state`. The tool result's `structuredContent` (the toolResult's `details`) carries the target, and the UI applies it live. |
| `streamToolProgress` :2412 | An MCP `notifications/progress`. The runtime turns it into a `tool_execution_update` (at most one per 250 ms) on the model's tool call. |
| `recordCodeModeArtifact` :3846 | Artifacts go into the tool result's `structuredContent`, which the runtime keeps as the toolResult's `details`. |
| `recordVerifiedWorkEvidence` :3730, `recordProjectActivity` :3788 | WorkspaceDO / OrgDO calls. They never needed the thread DO. |
| `recordAutomationOutcome` :4437 | An automation-store write keyed by thread and request. |
| `promptConnectionSetup` :4876 | A runtime human input of kind `url` (`ctx.requireUrl`) or `form` (`ctx.ask`). The OAuth completion (`connection-setup-completion.ts`) answers it through the inputs route instead of calling the DO. See open question 8. |
| `askUserQuestion`, `runCodeModeSubagent` | Already excluded over MCP. `ask_user` is the runtime builtin. |

### 4.5 Lifecycle webhook

No browser need be connected, so end-of-turn work cannot depend on one. The runtime posts lifecycle events to `POST /agent-runtime/events`. It uses the usage webhook's outbox, Standard Webhooks signing and at-least-once delivery. The route needs the same Cloudflare Access bypass as `/agent-runtime/usage`.
- `run.started {agent, request, actor, meta}` → WorkspaceDO streaming status "running". This covers turns chiridion did not start itself, such as a resume after an answer.
- `run.finished {agent, request, stopped, error, usage}` → streaming status idle. Also: `OrgDO.threads` last_assistant_completed_at, summary and error counts; title and avatar generation (`chat-thread/metadata.ts`, reading the newest history page); automation completion; the channel reply.
- `input.requested {agent, input}` → "waiting for you" notifications and channel prompts.

Deliveries are idempotent by `(agent, request, type)`: a redelivery writes the same values again.

The usage webhook (`/agent-runtime/usage`) stays as it is for billing.

## 5. The UI

### 5.1 Today

The renderer does not draw `UIMessage`s. It draws the legacy Anthropic-style `Message` (`src/types.ts:255`), with blocks `text`, `thinking`, `tool_use`, `tool_result`, `error`, `teammate_message` and `task_notification`. `UIMessage` is only the transport shape between ai-chat and the renderer:

```
runtime Pi events ─► DO: PiRuntimeEvent ─► PiChunkEncoder ─► ai-chat UIMessage ─► useAgentChat
   ─► usePiChatStream (386) ─► uiMessageToMessage (ui-message-adapter.ts, 581) ─► Message[]
   ─► ChatMessagesView (484) ─► MessageBubble (922) ─► ToolCall / tool-details/* / ThinkingBlock / …
```

A Pi message is closer to `Message` than `UIMessage` is:
- Pi `toolCall {id, name, arguments}` is `tool_use {id, name, input}`.
- Pi `ToolResultMessage {toolCallId, content, details, isError}` is `tool_result {tool_use_id, content, details, is_error}`.
- Pi `thinking` is `thinking`.

The leaf components (tool views, file previews, thinking, markdown, question and connection cards) therefore stay. The layers above them are what change: the stream hook, the adapters, and the grouping of blocks into turns.

§5.3 has the per-component table.

### 5.2 Data flow

- **`useRuntimeThread(threadId, initial)`** is new (`src/lib/use-runtime-thread.ts`, ~250 lines). It wraps the SDK watcher:
  - It seeds from the loader: `{token, url, agentId, page}`, where `page` is the newest history page read server-side.
  - It opens `watchAgent({url, agentId, token, getToken, deltas: true})`. The SDK streams SSE and falls back to `?poll=1&wait=25` when a stream fails or stalls. It reconnects with backoff, pauses while the tab is hidden, and after a gap restarts from the snapshot.
  - It exposes `{messages: AgentMessage[], partial: AssistantMessage | null, progress: Map<toolCallId, update>, running, pendingInputs, lastOutcome, loadOlder()}`.
  - For token refresh, the SDK's `getToken()` calls `POST /api/threads/:id/token` on a 401, or 60 s before expiry.
- **Folding happens in the SDK**, not in chiridion, so every tenant gets it:
  - `message_start` opens a message.
  - A delta `message_update` appends text, thinking or tool-argument JSON at `contentIndex`. Tool arguments are parsed as partial JSON, as pi-ai does, so a `js_exec` card shows its code while it streams.
  - `message_end` replaces the message with the final one.
  - A `snapshot` replaces the running turn from `turn.start`, with `turn.messages` plus `turn.partial`. On `truncated: true` the SDK reads that turn from history instead.
- **History:** the loader's page first, then `loadOlder()` → `historyPage({before: next})` straight from the runtime on scroll-up. Settled pages never change, so the browser keeps them in memory. There is no server cache and no history epoch.
- **Sends and the other writes** are `fetch` calls to the routes in §4.1.
  - The optimistic user bubble is keyed by `clientMessageId`.
  - It is replaced when a user `message_end` arrives with a matching `requestId` / `meta.clientMessageId` (runtime item 5).
  - Send recovery (Chat.tsx:2946–3000) keeps retrying with the same id. The runtime's request idempotency makes this safe.
- **Multiple tabs and users:** each tab is its own watcher. The runtime fans out, and orders everything by one cursor per agent. Sends from anyone land in one queue. A `BroadcastChannel` that shares one watcher across a user's tabs on the same thread is an optional later saving.

### 5.3 Component mapping

Sizes are line counts on `main`. "Pi props" means the component's props change from `ToolUseBlock` / `ToolResultBlock` to Pi `ToolCall` / `ToolResultMessage`. That is a mechanical rename: `input` → `arguments`, `tool_use_id` → `toolCallId`, `is_error` → `isError`, `artifacts` → `details.artifacts`, and `content` is always an array.

| Component | Lines | Renders | Verdict |
|---|---|---|---|
| `components/Chat.tsx` | 5,112 | Page: stream wiring, RPCs, send recovery, optimistic bubbles, preview, composer | **Rewire.** Replace `usePiChatStream` / `agent.call(...)` / `onStateUpdate` with `useRuntimeThread` plus fetches. ~1,000 lines touched; the net change is a deletion. Layout, composer and preview stay. |
| `lib/use-pi-chat-stream.ts` | 386 | ai-chat → `Message[]` | **Replace** with `use-runtime-thread.ts` (~250). |
| `lib/ui-message-adapter.ts` | 581 | `UIMessage` ⇄ `Message` | **Delete** (kept frozen for old threads until Phase 6). |
| `lib/pi-chunk-encoder.ts` | 686 | Pi → UI chunks | **Delete** (as above). |
| `hooks/use-chat-transcript.ts`, `lib/chat-render-history.ts`, `lib/derive-ui-messages-from-pi-core.ts`, `lib/steer-split.ts` | 217 + 400 + 414 + 201 | Render-history plumbing | **Delete** for runtime threads. The Pi grouping below replaces them. |
| `components/chat-messages-view.tsx` | 484 | Message list, virtualized turns, paging trigger | **Rewrite the data half** (~200): it walks `turns` instead of `Message[]`. The virtualization and scroll code stays. |
| `components/message-bubble.tsx` | 922 | Block dispatch, turn layout, copy-as-text | **Rewrite** as `pi-turn.tsx` (~600). It iterates Pi content parts and looks up results by `toolCallId`. Copy-as-text, the stop notice and the error notice move over. |
| `lib/turn-utils.ts` | 246 | Grouping into turns, "agent continued" | **Rewrite** as `pi-turns.ts` (~200). A turn is a user message plus the assistant and toolResult messages that follow it. |
| `tool-call/tool-call.tsx`, `tool-status.ts`, `tool-details.tsx`, `tool-utils.ts`, `mcp-utils.ts`, `tool-summary.ts` | 193 + 68 + 136 + 97 + 58 + 5 | Tool card shell, status, per-tool dispatch by name | **Pi props.** Status becomes: result present → complete / error (`isError`); else running while the turn runs; else complete. The name dispatch stays, fed through `localToolName` (`camel__x` → `x`). |
| `tool-call/details/*` (javascript, bash, read, write, edit, search, web, todo, task, skill, notebook, mcp, ask-user-question, team-create, generic, shared) | 1,833 | Per-tool bodies | **Pi props.** Each reads the call's arguments and the result's text / `details`. `JavaScriptDetails` reads `details.output` / `details.truncated` / artifacts; `EditDetails` reads the diff from `details`. |
| `tool-call/thinking-block.tsx` | 194 | Thinking / plan | **Reuse.** Feed it Pi `thinking` (and `redacted`). |
| `tool-call/file-link.tsx`, `app-link.tsx`, `file-card.tsx`, `chat-file-preview/*` | 163 + 73 + 162 + ~2,450 | present_file / artifact / attachment previews | **Reuse.** Their inputs are paths and URLs, which come from `details.artifacts` or the tool's arguments. |
| `tool-call/task-notification.tsx`, `teammate-message.tsx` | 89 + 98 | Sub-agent notices | **Pi props.** Live sub-agent progress is `tool_execution_update` on the Task call, not a fake `tool_result` (`isTaskUpdate`). |
| `ask-user-question.tsx` | 791 | Question card | **Reuse.** It is fed `runtimeInputQuestions(input)` for a pending `question` input. It answers through the inputs route. |
| `connection-setup-prompt.tsx` | 612 | Connection setup card | **Reuse**, fed a `url` / `form` input (open question 8). |
| `floating-todo/*` | 259 | Todo panel | **Reuse**, fed the latest todo tool call's arguments. |
| `context-indicator.tsx`, `compact-summary-card.tsx`, `turn-summary-bar.tsx`, `model-fallback-banner.tsx`, `chat-error-notice.tsx`, `collapsible-user-message.tsx`, `chat/channel-logo.tsx` | 75 + 89 + 110 + … | Context %, compaction, turn duration, errors, user bubble, source | **Reuse.** Their inputs change source (§5.4, §5.5). |
| `preview-panel/*`, `chat-preview/*` | ~860 + … | Preview tabs | **Reuse.** State comes from the loader (`thread_ui_state`) and from preview tool results. |
| `markdown-renderer.tsx` | — | Text | **Reuse.** |

Size: about **1,500 new lines** (hook, grouping, turn view, derivations) and **about 1,500 changed** (Pi props across ~35 files, Chat.tsx rewiring). This replaces about **4,000 lines** on the runtime path (adapters, encoder, stream hook, render-history plumbing, bubble, turn utils). The old path's copies are deleted in Phase 6.

During the transition, the frozen old-thread view still produces `Message` blocks. To keep one prop type on the leaves, it converts `ToolUseBlock` / `ToolResultBlock` to Pi shapes in a ~80-line shim at its boundary. The shim goes away with the old view.

### 5.4 Rendering Pi messages

| Pi shape | Renders as |
|---|---|
| `user`, `content: string \| (text \| image)[]` | User bubble (`collapsible-user-message`). Images are image tiles. The author is `from.name`, which the runtime stores on the message (not in its text). The source (Slack, automation, …) comes from `meta.source` as a channel logo. Attachments sent as `files` are saved under `uploads/<requestId>/` and named in the message; they render as file chips. The runtime should return them structured on the message too (runtime item 5). |
| `assistant` `text` | Markdown. |
| `assistant` `thinking` | Thinking block; `redacted` shows as "Thinking (redacted)". |
| `assistant` `toolCall` | Tool card, keyed by `id`. While streaming, arguments are partial JSON. |
| `toolResult` | Joined to its call by `toolCallId`: `content` (text / image), `details` (structured: diffs, artifacts, js_exec output), `isError`. Never rendered on its own. |
| `toolResult` with `details.inputRequired` | The placeholder for a call waiting on a person. The card shows "waiting for your answer" until the real result replaces it. |
| `assistant` `stopReason: "aborted"` | "Stopped by user" (replaces `data-pi-user-stop`). |
| `assistant` `stopReason: "error"` + `errorMessage` | Error notice via `readableProviderError` (moved to `src/lib`). Billing and quota errors keep their CTA by matching error type. |
| `assistant` `usage` | Context % (latest input + cache tokens over the model's window); turn duration from timestamps. |
| Compaction | The runtime's history keeps the full log and has no summary message, so the transcript shows none. `compaction_end` (live) can show `compact-summary-card` as a transient notice. If the marker should persist, the runtime needs to mark where compaction happened in history (small; not on the priority list). |
| `tool_execution_update` (live only) | Progress text / partial result on the running card (build progress, sub-agent activity). |
| `auto_retry_start` / `_end` | "Retrying…" notice on the running turn. |
| `compaction_start` / `_end` | Compacting indicator. |

Custom message kinds that exist only in the DO path (`teammate_message`, `turnNotice`) are not produced by the runtime. They survive only in the frozen old-thread view.

### 5.5 Agent-state fields without a DO push

| Field (`chat-agent-state.ts`) | Source |
|---|---|
| `currentTodos` | The latest todo tool call in the messages; history seeds it. |
| `contextUsedPercent` | The latest assistant `usage` over the model's context window. |
| `pendingQuestion` | Pending inputs: `GET inputs` at connect, then `input_required` / `input_resolved` live. Mapped by `runtimeInputQuestions`. |
| `lastError` | Assistant `stopReason: "error"`, and `response` outcomes with an `error`. |
| `previewTabs`, `activeTabId` | `thread_ui_state` from the loader; live from preview and deploy tool results' `details`. |
| `title`, `model`, `modelFallbackNotice` | `OrgDO.threads` in the loader. A live title rides the workspace status channel (the sidebar), or the page revalidates on `agent_end`. |
| `connectionSetupPrompt` | A `url` / `form` input, rendered by the connection-setup card. |
| isStreaming / the working indicator | The snapshot's `turn != null` at connect, then `agent_start` / `agent_end` and `response` outcomes. |

## 6. Old DO-backed threads

They are not migrated. The backend is chosen per thread: a thread with a `thread_runtime` row is a direct runtime thread; every other thread is old. That includes runtime threads that were started through the DO and are pinned in DO KV (see open question 11).

**The minimum to keep them viewable (Phase 4):**
- The loader already reads the first page with `getUiMessagePage` over DO RPC. Keep that.
- Older pages: a plain `GET /api/threads/:id/legacy-messages?cursor=` that calls the DO's `getOlderUiMessages` over RPC. No WS and no ai-chat client.
- They render through the existing `UIMessage` → `Message` adapter and the frozen renderer, via the Pi-props shim (§5.3). The composer is replaced by "This conversation is read-only. Start a new chat."
- The Worker refuses `sendMessage` and every other write RPC for old threads. Their DO never starts a loop again, so the Pi loop, stream retry, compaction and transport are dead code for them.
- Automations and channels attached to an old thread get a new runtime thread on their next run.

**End state (Phase 6).** Old threads age out, either by retention or because users delete them. There are two options:
- **(A) Retention cutoff.** Announce a date. Old threads become unavailable after it. Delete the `CHAT_THREAD` class with a deletion migration.
- **(B) Freeze to R2**, if old threads must be kept. A one-off job reads each old thread's `pi_core` rows, which are already Pi `AgentMessage`s (`pi-core-store.ts`), and writes them to R2 as JSON pages. The viewer renders them with the **new** Pi renderer, read-only. Threads without `pi_core` rows (pre-Pi) are either exported once through the `Message` adapter or dropped. Then the DO class is deleted.

Recommendation: (B) if product wants history kept (it costs one job plus a ~100-line R2 page reader), otherwise (A).

Either way, the end state deletes:
- `ChatThreadDO` (`chat-thread-do.ts`, 11,965) and `chat-thread/*` (12,134): the in-DO Pi loop, `pi-core-store.ts`, `ui-mirror.ts`, `derived-render-page.ts`, `render-archive-preserve.ts`, `pi-turn-journal.ts`, `pi-compaction.ts`, `pi-stream-retry.ts` and `runtime-agent.ts`;
- `workers/main/src/pi-*.ts` and `bedrock-pi-*` (~3,000), if Bedrock serves only the runtime path by then;
- the chat WS / poll / SSE transport: `sse-agent-client.ts`, `use-sse-agent.ts`, `chat-thread/*-connection.ts`, `transport-headers.ts`, `transport.md`;
- the `UIMessage` layer: `pi-chunk-encoder.ts`, `use-pi-chat-stream.ts`, `ui-message-adapter.ts`, `derive-ui-messages-from-pi-core.ts`, `chat-render-history.ts`, `use-chat-transcript.ts`, `chat-do.server.ts`, the legacy `Message` block types and the Pi-props shim;
- the `@cloudflare/ai-chat` and `agents` packages, and `ai` if only the chat used it;
- the `CHAT_THREAD` binding, via a deletion migration.

That is roughly 30,000 lines.

## 7. Chiridion work, in phases

| Phase | Work | Size |
|---|---|---|
| **0. Prep** | Move pure helpers to `src/lib`: `runtimeInputQuestions`, `localToolName`, `readableProviderError`. OrgDO tables `thread_runtime` and `thread_ui_state`. Runtime config: tenant CORS origins, lifecycle webhook URL. Add the SDK dependency. | S: ~300 lines, 2–3 days |
| **1. Server** | `startRuntimeTurn()` and `run-gates.ts` (moved from DO:8018 and DO:6384); the routes in §4.1; token minting; the lifecycle receiver; the tool side-effect switch (§4.4); the Codex forwarder off the DO; the transcript readers (condensed transcript, admin jsonl, fork, eval, lake) moved to runtime history. Tests against a local runtime. | M–L: ~1,500–2,000 lines, 1.5–2 weeks |
| **2. UI** | `useRuntimeThread`; Pi grouping and turn view; Pi props on the leaves plus the old-view shim; §5.5 derivations; Chat.tsx rewiring, chosen per thread from the loader's `backend`. Fixture tests from recorded runtime traces (the staging trace is a good start). | L: ~1,500 new plus ~1,500 changed, 2–3 weeks |
| **3. Cut over** | New threads pin to direct runtime (`thread_runtime` row at creation). Then automations and channels via `startRuntimeTurn()`, once the lifecycle webhook is live. Dogfood on staging: multi-tab, multi-user, ask_user, stop, model switch, reconnect on a throttled network, the poll fallback, a corporate-proxy network. | S: ~200 lines plus dogfooding, 1 week |
| **4. Freeze old threads** | Read-only view, refusal of writes, the legacy page route, the composer bar. | S: ~300 lines, 2–3 days |
| **5. Delete the runtime-in-DO path** | `RuntimeAgentSession` and every runtime branch in the DO (`resolveAgentBackend`, `resumeRuntimeTurn`, `answerRuntimeInput`, `prepareRuntimeRun`, `runtimeProviderRequest`, `createRuntimeAgentSession`). | S: net −2,000 lines |
| **6. End state** | Retention or the R2 export (§6); delete the DO, the in-DO loop, the transport, the `UIMessage` layer and ai-chat. | M: one job plus deletions, net about −30,000 lines |

Phases 0–1 can start before the runtime work lands, against `feat/runtime-threads` and a stub token endpoint. Phase 2 needs runtime items 2 and 4.

## 8. Runtime work, in priority order

Already on `feat/runtime-threads`, to merge first:
- read-only watchers (`?watch=1`);
- tenant-token reads at `/v1/agents/:id/{events,state,history,inputs}`;
- delta `message_update`s with a turn snapshot on connect, and `turn_opened`;
- paged turn-aligned history `?limit&before`;
- the JSON long-poll `?poll=1&wait=N`;
- coalesced tool progress.

The previous design's KV snapshot, history cache, history epoch and lazy migration are no longer needed.

1. **Browser tokens and CORS (§3).**
   - `POST /v1/agents/:id/browser-tokens`: signed, scoped to one agent and to read routes, with an event allow-list and `response` reduction;
   - per-tenant CORS origins;
   - browser-token auth on the four read routes;
   - the stream closes at token expiry, so the SDK reconnects with a fresh token and access changes apply within the TTL.
   - Size M.
2. **SDK browser watcher**, as `@camelai/agent-runtime/watch`, a browser-safe entry with no typebox and no Node APIs:
   - `watchAgent({url, agentId, token, getToken, deltas})`: SSE, then long-poll, with backoff, a stall watchdog and a visibility pause;
   - it folds deltas into Pi messages, including partial-JSON tool arguments;
   - it applies snapshots (and `truncated` → a history read), keeps tool progress per call, tracks pending inputs, and exposes `historyPage`;
   - tested in a real browser.
   - Today's `AgentClient` is an application connection: it owns tool calls, a journal and `typebox`. It is not a watcher.
   - Size M.
3. **Watcher capacity for browsers.**
   - A per-tenant configurable watcher limit, instead of the fixed 1,024 per tenant per node.
   - Watching an idle, unloaded agent must not load its session: a waiting poll or stream on an idle agent should cost a registration, woken by the agent's next event. Today an idle agent's watchers are ended, and a tab's reconnect loop would otherwise keep reloading it.
   - Size M.
4. **Attribution and source on messages:**
   - Record `requestId` on each transcript message, and an opaque `meta` (≤2 KB, never sent to the model) on user messages from `prompt` / `steer`.
   - Return both in history, snapshots and `message_end`.
   - Return attached `files` structured on the user message.
   - Size S–M.
5. **Atomic steer-or-prompt:** `prompt` with `whileRunning: "steer"`. This removes the race behind the DO's `isThreadStreaming()` choice. Size S.
6. **Lifecycle webhook** (§4.5): `run.started`, `run.finished`, `input.requested`, on the usage-webhook outbox. Size M.
7. **Provider error text safe for browsers:** assistant `errorMessage` is now visible to the browser. The runtime should strip gateway URLs, account ids and key-scope names, as chiridion's `readableProviderError` does today server-side. Size S.
8. **Custom domain**, for tenants whose users' networks block `agents.camelai.dev`: a host alias per tenant (ACM certificate plus an ALB rule), or Cloudflare in front of the ALB. Infra. Size S–M.
9. **Field redaction in browser tokens** (`redact: [...]`). This is for other tenants; chiridion needs at most `usage.cost`. Size S.

## 9. Risks and open questions

1. **Third-party domain blocked by firewalls or ad blockers.**
   - `agents.camelai.dev` is on the same registrable domain as the app (`camelai.dev`). Ad blockers and third-party-cookie rules treat it as first-party, and it carries no cookies anyway.
   - The risk is corporate allow-lists that name hosts, and TLS-inspecting proxies that buffer SSE. The long-poll fallback covers buffering.
   - For allow-lists: (a) tell customers to allow `agents.camelai.dev`; (b) a custom domain (runtime item 8); (c) as a last resort, a per-org switch that sends the SDK through a byte-for-byte Worker pass-through (`/api/runtime/*` → the runtime, no parsing). (c) brings back the Worker cost only for those orgs.
   - Self-hosted chiridion deployments need a configurable runtime URL and their own CORS origin.
   - Decide whether (c) is built up front or only on demand.
2. **What the browser can see.** Everything a thread viewer sees today: tool arguments and results, assistant errors, usage. It cannot see the system prompt, the `context` claims, MCP traffic or other agents.
   - Open: should assistant `usage.cost` (the provider's raw cost) be hidden from hosted-key users? If so, add `usage.cost` to the token's redaction list (runtime item 9).
   - Provider errors need runtime-side cleaning (runtime item 7).
3. **Token refresh and revocation.**
   - A 15-minute TTL; the SDK refreshes through chiridion before expiry and on a 401. The runtime ends a stream at expiry.
   - A user removed from an org or thread can keep reading that one thread for up to the TTL.
   - Shared-thread and public-share viewers get tokens under the share's own access check.
   - Decide the TTL: shorter means faster revocation, longer means fewer mint calls.
4. **Latency.**
   - Streams go browser → us-west-2 directly: one hop, where today the path is DO → runtime → DO → browser. Time to first token should improve outside the US West.
   - Writes are browser → Worker → runtime: ~150–250 ms from Europe for the Worker → runtime leg, as today.
   - First paint: the loader mints the token and reads the newest page in parallel, one runtime round trip.
   - Measure on staging from EU and APAC before cutover.
5. **Runtime outage.**
   - Runtime threads can neither load nor send; old DO threads, the thread list and the rest of the app keep working. Today runtime threads cannot send during an outage either, but they still render from the DO.
   - The UI shows "Can't reach the agent service" with retry.
   - The previous design's KV snapshot is dropped. Decide whether a read-only fallback is needed; if so, the lifecycle webhook could write the newest page to R2 on `run.finished`.
6. **Multiple tabs.**
   - Each tab is a watcher; the runtime orders every event by one cursor, and all tabs see sends from anyone.
   - The capacity limit is per agent (32) and per tenant per node (runtime item 3).
   - Hidden tabs pause after a grace period, and on return they resume at the cursor or from the snapshot.
7. **Automations and channels starting turns.**
   - They call `startRuntimeTurn()` server-side, with `from` / `actor` / `meta.source` set. Open tabs see those turns live, because a watcher sees every event.
   - End-of-turn work (the automation outcome, the channel reply) runs from `run.finished`, so it must not ship before the lifecycle webhook.
   - Billing: a steer from another user keeps the run's `actor`, and `whileRunning: "steer"` must preserve that.
8. **Connection setup and other interactive tools.** Check that `prompt_connection_setup` over MCP can be a runtime `url` / `form` input. Its OAuth completion (`connection-setup-completion.ts`) would answer the input through the inputs route; today it calls the DO.
9. **Tool-result fidelity.** The UI depends on chiridion tools returning `structuredContent` (preview targets, artifacts, diffs), which the runtime keeps as `details`. Audit every `code-mode-tools.ts` tool whose card reads more than its text result.
10. **Sidebar activity text.** Mid-turn "activity text" in the sidebar came from DO state. With the lifecycle webhook, the sidebar gets running / idle only. Decide whether to drop the text or have the browser that is watching report it (not recommended).
11. **Runtime threads already pinned in DO KV.** Their agents already live on the runtime, so adopting them is cheap: write a `thread_runtime` row with the stored agent id. This is not a transcript migration. It is optional and outside "no migration". Decide adopt or freeze; freezing is the default in this design.
