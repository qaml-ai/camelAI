# Runtime threads without ChatThreadDO

Status: design, not started. Base: chiridion `main` d4753d950, agent-runtime `main` (2026-09-27).

**Goal:** a thread that runs on the hosted agent runtime has no per-thread Durable Object. The runtime is the only store of the transcript. Chiridion serves these threads from stateless Worker routes, with thread metadata in `OrgDO`. `ChatThreadDO` stays for old (in-DO Pi) threads until they are migrated, then goes away.

**Why:**
- A DO is billed wall-clock for every streamed turn it relays.
- `ChatThreadDO` is where every production memory incident lived: the render history, stream buffers and wake spirals.
- Runtime threads keep two copies of history today: the `pi_core` mirror plus the ai-chat archive, and the runtime's own transcript.

---

## 1. What ChatThreadDO does for a runtime thread today

File: `workers/main/src/chat-thread-do.ts` (11,965 lines; referred to below as DO), plus `workers/main/src/chat-thread/*`.

| Job | Where | Notes |
|---|---|---|
| Choose the backend and pin it per thread | DO:7905–7940 (`isRuntimeAgentThread`, `mayRunOnRuntime`, `resolveAgentBackend`); KV `CHAT_AGENT_BACKEND_KEY` | New threads pin to `runtime` when `runtimeConfigured()` holds and the model has a runtime route. |
| Create the agent and store its id, token and cursors | `chat-thread/runtime-agent.ts:371` (`agent()`, `POST /v1/agents` with Idempotency-Key `thread_<id>`); DO:7943 `createRuntimeAgentSession`; KV `runtimeAgent`, `runtimeAgentCursor`, `runtimeAgentRun` (DO:566–568) | The agent token is a bearer secret held in DO KV. |
| Gates before each run | DO:8018 `prepareRuntimeRun` → runtime-agent.ts:411 `configureRun` (`PATCH /v1/agents/:id/configuration`) | Covers credits, per-user limits, the route (model and key scope), `ensureHostedKeyScope`, `syncOrgKeyScope`, the spend limit and model headers. |
| Send, steer and abort | DO:3780 `sendMessage` → 6384 `handleClientUserMessage` → 6477 `enqueueRunnerUserMessage`; runtime-agent.ts:685 `run`, 746 `steer`, 754 `abort` (`POST /clients/:id/requests`); DO:3740 `requestStop` | See the list below. |
| Relay the runtime's event stream | runtime-agent.ts:501 `relay` (`GET /clients/:id/events`, Last-Event-ID, a 409 replay gap leads to `recoverFromHistory` at :656); runtime-agent.ts:443 `emit` (tool name localizing, input-placeholder filtering, held `agent_end`) | |
| Translate Pi `AgentEvent` into "PiRuntimeEvent" (codex-style `item/*`) | DO:9535 `handlePiSessionEvent` (to about 9995) | Runs inside the DO; it is not a pure module. |
| Encode for the UI | DO:10514 `writePiStreamChunks` → `PiChunkEncoder` (`src/lib/pi-chunk-encoder.ts:251`, shared code) | |
| Transport to the browser | ai-chat `AIChatAgent` (DO:1080) `cf_agent_*` frames over a native WS with HTTP-poll fallback | `chat-thread/{websocket,poll,sse}-connection.ts`, `transport.md`. The browser side is `src/lib/sse-agent-client.ts` (1,122 lines) and `use-sse-agent.ts`. |
| Render history: the pi_core mirror plus the ai-chat archive | `chat-thread/pi-core-store.ts`, `ui-mirror.ts`, `derived-render-page.ts`, `render-archive-preserve.ts`; DO:2543 `persistMessages`; DO:11639 `getOlderUiMessages` | This is the duplicate copy. |
| Agent state pushed to the UI | DO:1463 `syncAgentState`; payload in `src/lib/chat-agent-state.ts:50` | Fields: preview tabs, todos, context %, pending question, connection-setup prompt, title, model, fallback notice, `lastError`. |
| Human input | runtime-agent.ts:593 `answerInputs`; DO:8133 `answerRuntimeInput` | The DO turns a runtime input into an AskUserQuestion card and waits in memory for `answerQuestion` (DO:3745). |
| Model change | DO:3776 `refreshModel`, DO:3889 `setModel`; `configureRun` applies it on the next run | |
| Tool side effects from `/mcp/agent` | `code-mode-tools.ts` `chatThreadStub` RPCs, listed below | |
| Codex forwarder | DO:8078 `runtimeProviderRequest`, called from `routes/agent-runtime-llm.ts:56` | Per-user gate, subscription credentials. |
| Turn bookkeeping | `threadMetadata.updateThreadMetadataForUserMessage` (DO:6546), streaming status in WorkspaceDO `thread_streaming_status` (`workspace.ts:356`), title and avatar generation (`chat-thread/metadata.ts`), error counts in `OrgDO.threads` | |
| Restart recovery | DO:5655–5668 `resumeRuntimeTurn` (relays the in-flight run from its start cursor) | |

`handleClientUserMessage` does several things before the runtime call:
- clientMessageId dedupe (`chatAccess`);
- the ban check;
- mention expansion and the file-safety preamble;
- `formatAttributedUserMessage` (author and source);
- the thread metadata update;
- the "running" activity;
- choosing steer or prompt according to `isThreadStreaming()`.

The `chatThreadStub` RPCs in `code-mode-tools.ts`:
- `setTodoState` :4004
- `setPreviewTarget` :4043, :4085
- `setPreviewAppVisibility` :4202
- `streamToolProgress` :2412 (build progress)
- `recordCodeModeArtifact` :3846
- `recordVerifiedWorkEvidence` :3730
- `recordProjectActivity` :3788
- `recordAutomationOutcome` :4437
- `promptConnectionSetup` :4876
- `askUserQuestion` :3978 (excluded over MCP)
- `runCodeModeSubagent` :3985 (excluded over MCP)

Other readers of the DO transcript also need a new source:
- the thread page loader: `src/routes/_app.chat.$id.tsx:523` `getUiMessagePage`;
- `api/threads.$id.condensed-transcript.ts`;
- `api/admin.threads.$id.jsonl.ts`;
- the fork route: `api/workspaces.$id.chat.$threadId.fork.ts`;
- agent-eval and the transcript lake (`chat-thread/transcript-lake.ts`);
- automations (`chat-thread/automation-run.ts`, `src/lib/automations.server.ts`);
- channel ingress and replies (`chat-channels.ts`, `channels.ts`).

## 2. The chat UI today, and what changes

**Today:**
- `Chat.tsx:918` calls `usePiChatStream` (`src/lib/use-pi-chat-stream.ts`). That wraps `useAgentChat` from `@cloudflare/ai-chat/react` over `SseAgentClient` (a WS that falls back to polling).
- It returns `PiChatStream` (use-pi-chat-stream.ts:52): `messages`, `uiMessages`, `status`, `isStreaming`, `isStallClamped`, `streamingMessageId` and `setUiMessages`.
- Agent state arrives via `onStateUpdate` (Chat.tsx:893, 3383).
- RPCs:
  - `sendMessage(content, clientMessageId)` (Chat.tsx:2958);
  - `requestStop` (:4298);
  - `answerQuestion` (:4313);
  - `refreshModel` (:3979);
  - `setPreviewTabsState` (:2692);
  - `getOlderUiMessages(cursor)` (:1780).
- Send recovery retries with the same clientMessageId (Chat.tsx:2946–3000).

**Why not the AI SDK's `useChat` with its default HTTP transport:**
- `useChat` scopes a stream to the request that started it.
- Threads have turns that start elsewhere: another tab, another org member (shared threads), automations, channels, and resume after an `ask_user` answered from another device.
- ai-chat covered this with DO broadcast. The replacement must be a thread-level subscription, not a request-scoped one.

**Proposed: a second implementation behind the same `PiChatStream` interface.** Chat.tsx picks it per thread from the loader's `backend` field, so the renderer, send recovery, optimistic bubbles and adapter (`ui-message-adapter.ts`) stay as they are.

- **`useRuntimeThread(threadId)`** (new, `src/lib/use-runtime-thread.ts`):
  - It keeps one `fetch()` stream to `GET /api/threads/:id/events`, a long-lived SSE resumed by `Last-Event-ID`, with backoff and a visibility pause.
  - Why not `EventSource`: we need headers, and fetch lets us fall back to the same route with `?poll=1`, which returns a JSON batch and a cursor. That is the fallback that exists today for users whose WS or SSE fails (see `transport.md`).
  - Runtime frames are folded into `UIMessage[]` by `src/lib/runtime-event-fold.ts`. That is:
    - a pure Pi `AgentEvent` → PiRuntimeEvent translator, extracted from DO:9535, so it is shared;
    - then the existing `PiChunkEncoder`;
    - then AI SDK `readUIMessageStream`, or the same chunk reducer ai-chat uses.
  - Encoding runs in the browser. The Worker is a byte pipe that does no parsing and uses almost no CPU.
  - History seeds from the loader page, and older pages come from `GET /api/threads/:id/history?before=`.
- **Sends:** `POST /api/threads/:id/messages {content, clientMessageId}`. It returns `{status:"accepted"|"busy"|"error"}`, the same `SendMessageResult` shape (Chat.tsx:270), so the retry logic is unchanged.
- **Other RPCs become `fetch` calls:** stop, answer, preview, model.
- **Agent-state fields are rebuilt without DO push:**
  - `currentTodos`: from `TodoWrite` tool calls in the stream (the encoder already emits `data-pi-todos`). The last call in history seeds page load.
  - `contextUsedPercent`: from the latest assistant `usage` and the model's context window.
  - `pendingQuestion`: from the runtime's pending inputs, read at load via `GET …/inputs` and live from the response frame whose `stopped:"input_required"`. The `runtimeInputQuestions` card mapping (runtime-agent.ts:154) moves to `src/lib`.
  - `lastError`: from the response outcome and error events.
  - `previewTabs`/`activeTabId`: the durable copy in OrgDO comes with the loader. Live updates come from `set_preview`/deploy tool results in the stream: the client applies the target from the tool's structured result.
  - `title`, `model`, `modelFallbackNotice`: OrgDO `threads` in the loader. A live title rides the existing workspace status channel (sidebar), or the page revalidates the thread on turn finish.
  - `connectionSetupPrompt`: becomes a runtime human input (see §4, open question 4).
- **What goes, for runtime threads:** `SseAgentClient`/`useSseAgent`/`useAgentChat` and `onStateUpdate`. Old threads keep all of them until §5 step 5.

## 3. Target design (chiridion)

### Worker routes (`workers/main/src/routes/runtime-threads.ts`, all stateless)

Authorization is one `OrgDO.validateChatWebSocketAccess(userId, workspaceId, threadId)` call per request (already used by `agent-mcp.ts:105`), and it returns the thread's runtime record too (below).

| Route | Does |
|---|---|
| `POST /api/threads/:id/messages` | Runs the send pipeline taken out of the DO: ban check, mentions, file safety, attribution, the gates of `prepareRuntimeRun` (moved to `agent-runtime/run-gates.ts`), agent creation if missing (idempotent, as today), configure if the model, scope or limit changed, then `POST /clients/:id/requests {id: clientMessageId, method:"prompt", params:{text, from, meta, actor, whileRunning:"steer"}}`. The runtime's request idempotency (a retried id returns the committed record) replaces `chatAccess` dedupe. It then updates `OrgDO.threads` (last_user_message, updated_at) via `waitUntil`. |
| `GET /api/threads/:id/events` | Proxies the runtime's thread event stream (§4 "watch"), passing `Last-Event-ID` through. Sends a `: keepalive` every 25 s. `?poll=1` returns buffered frames plus a cursor as JSON (the fallback). |
| `GET /api/threads/:id/history?before=&limit=` | Proxies the paged, turn-aligned runtime history (§4), with caching below. The thread loader calls the same helper server-side for the first page. |
| `POST /api/threads/:id/inputs/:inputId` | Answers a runtime input (`POST /clients/:id/inputs/:input`). The runtime resumes the run, and every tab sees it on its stream. |
| `POST /api/threads/:id/stop` | `abort` request. |
| `PATCH /api/threads/:id/model` | Writes `OrgDO.threads` model and history (existing `updateThreadModel`). The runtime configuration is applied lazily by the next send's configure, as `configureRun` does today, so a model change never races a running turn. |
| `PUT /api/threads/:id/preview` | `setPreviewTabsState` → OrgDO. |
| `POST /agent-runtime/llm/openai-codex/*` | Unchanged externally. The body moves from DO:8078 into the route, reading the thread's backend and model from OrgDO instead of DO KV. |

### Thread metadata: OrgDO, not D1

Recommendation: new OrgDO tables:
- `thread_runtime (thread_id PK, agent_id, backend, model, key_scope, created_at)`;
- `thread_ui_state (thread_id PK, preview_json, preview_version, updated_at)`.

Why OrgDO:
- `threads` (org-do.ts:1166) and the access check already live there, so authorization and the runtime lookup are one RPC, which every chat request already pays.
- Writes are small and per turn or per tool call. That is well within one org's DO.
- D1 would be a second store plus a migration, and staleness between it and `OrgDO.threads`.

The agent token is not stored if the runtime grants the tenant token read access (§4). Until then `thread_runtime.agent_token` is kept, as DO KV does today.

### Tool side effects (`code-mode-tools.ts`, when `threadId` belongs to a runtime thread)

- `setTodoState`: nothing. The UI derives todos from `TodoWrite` calls.
- `setPreviewTarget`/`setPreviewAppVisibility`: write `thread_ui_state` in OrgDO. The tool result carries the target, and the UI applies it live.
- `streamToolProgress`: becomes an MCP `notifications/progress` from `/mcp/agent`. The runtime already turns these into `tool_execution_update` events on the model's tool call (agent-runtime `client-sessions.ts:669`).
- `recordCodeModeArtifact`, `recordVerifiedWorkEvidence`, `recordProjectActivity`: artifacts go into the structured tool result, which is rendered from the stream and history. Evidence and project activity move to WorkspaceDO or OrgDO calls; they never needed the thread DO.
- `recordAutomationOutcome`: becomes an OrgDO or automation-store write keyed by thread and run.
- `promptConnectionSetup`: a runtime human input of kind `url`/`form` (`ctx.requireUrl`/`ctx.ask`). See open question 4.

### History caching

- A settled turn never changes. Compaction keeps the full log.
- Cache pages in the Workers Cache API under `history:<agentId>:<epoch>:<before>:<limit>`, with `epoch` = the runtime's history epoch, which changes only on a log `reset`.
- The newest page (`before` absent) is not cached. It is small and must include the running turn.
- **Optional:** a KV snapshot of the last page per thread, written on the turn-finished webhook, so a thread still renders read-only during a runtime outage.

### Auth toward the runtime

- Server-side only: the browser never holds a runtime token, and the runtime rejects requests with an `Origin` header anyway (`client-sessions.ts:1083`).
- Target: the tenant token over `/registry/:id/*` (§4). An interim option is the per-agent token from `thread_runtime`.

### Multiple tabs and users

- Each tab opens its own `/events` proxy, so the runtime fans out.
- Sends from anyone land in the one request queue, and every subscriber sees every frame in the same order.
- Ids are the runtime's event cursor, so order is total per agent.

### Turn lifecycle without a stream attached

No browser may be connected. Streaming status, `last_assistant_completed_at`/summary, error counts, title generation, automation completion and channel replies are driven by a **runtime lifecycle webhook** (§4) delivered to `POST /agent-runtime/events`, next to `/agent-runtime/usage`, with the same Standard Webhooks verification. It writes OrgDO and WorkspaceDO and triggers the channel reply. The route also needs a Cloudflare Access bypass path (see the Access app `e14c1349…`).

## 4. Runtime additions (read against agent-runtime `main`)

What exists already:
- `GET /clients/:id/events`: SSE with cursor replay; the buffer is 512 events or 2 MB (`client-sessions.ts:153, 477`); a gap returns 409.
- `GET /clients/:id/history`: the full transcript, reading the whole log every call (`supervisor.ts:56`, `agent-host.ts:459`).
- `GET /clients/:id/state`, `GET|POST /clients/:id/inputs[/:input]`.
- Idempotent `POST /clients/:id/requests` with prompt, steer, followUp, abort and configure (`client-sessions.ts:1228`).
- The operator bridge `POST /registry/:id/requests` (tenant token; requests only, `server.ts:455`).
- Usage webhook (usage only).
- MCP progress → `tool_execution_update`.

Needed, in priority order:

1. **Multi-subscriber event stream.**
   - Today a new `/events` connection ends the previous one (`client-sessions.ts:1114`), because the stream doubles as the attached-MCP channel. Two tabs would evict each other in a loop.
   - Add read-only watchers (`GET …/events?watch=1`): no attached server, never replaces or is replaced, and the same cursor and replay semantics.
2. **Tenant-token reads:** `GET /registry/:id/{events,history,state,inputs}` and `POST /registry/:id/inputs/:input`, like the existing requests bridge. Chiridion then stores no per-agent tokens.
3. **Delta streaming, plus a snapshot on subscribe.**
   - Today every `message_update` carries the whole partial message (backlog "Streaming efficiency", `plans/agent-runtime-service.md:330`), which makes browser traffic quadratic.
   - A long turn also overruns the 512-event replay buffer, so a reconnect mid-turn gets a 409.
   - Send deltas (text, thinking and tool-arg deltas), and on subscribe or replay-gap send one `message_snapshot` of the in-progress assistant message plus the committed messages of the running turn. With that, a reconnect never needs a separate history read and a 409 becomes rare.
   - Throttle MCP progress at the same time.
4. **Paged, turn-aligned history:**
   - Shape: `GET …/history?before=<index>&limit=<messages>` → `{ entries: [{ index, requestId, turn, message, meta }], next: <index>|null, epoch }`.
   - Pages never cut a turn.
   - It must not read the whole log per page. Keep a per-turn offset index (Postgres, or log segment boundaries) when writing `turn` records.
5. **Request attribution on messages:**
   - Record `requestId` on each transcript `message` record, plus an opaque `meta` (≤2 KB, never sent to the model) on user messages from `prompt`/`steer` params.
   - Return both in history and on `message_end` events.
   - Chiridion puts `{renderText, authorDisplayName, messageSource}` in `meta`, because the model sees the attributed text.
   - The render ids become `user:<requestId>` and `turn:<requestId>`, replacing the DO's `renderMessageId` stamping.
6. **Atomic steer-or-prompt:** `prompt` with `whileRunning: "steer"` joins the in-flight run if there is one, otherwise starts a run. This removes the race behind the DO's `isThreadStreaming()` choice. If `steer` with no active run already fails cleanly, the route can retry as `prompt`; this is the fallback if (6) slips.
7. **Lifecycle webhook** (extend the usage-webhook outbox; the same receiver, signing and at-least-once delivery):
   - `run.started {agent, request, actor}`;
   - `run.finished {agent, request, stopped, error, usage}`;
   - `input.requested {agent, input}`.
8. **History epoch:** a counter bumped on log `reset`, for cache keys.

## 5. Rollout and coexistence

The backend is chosen per thread, as today:
- `OrgDO.thread_runtime.backend` is `runtime` for new threads.
- Threads without a row are old DO threads.
- The loader returns `backend`, and Chat.tsx mounts `useRuntimeThread` or `usePiChatStream`.
- Nothing changes for DO threads.

1. **Runtime:** items 1–3 (watchers, registry reads, deltas plus snapshot), then 4–5 (paged history, attribution), then 6–8. Each ships behind the existing API; the SDKs pick up the history paging.
2. **Chiridion, shared code:** extract the AgentEvent → PiRuntimeEvent translator (DO:9535) and `runtimeInputQuestions` into `src/lib`. Add `runtime-event-fold.ts` with tests replaying recorded runtime traces (the staging trace `staging-trace.json` is a good fixture).
3. **Chiridion, server:**
   - the routes in §3, the OrgDO tables, `run-gates.ts` (moved from DO:8018) and the lifecycle receiver;
   - move the Codex forwarder off the DO;
   - switch the tool side effects for runtime threads;
   - switch the other transcript readers (condensed transcript, admin jsonl, fork, eval, lake) to runtime history for runtime threads.
4. **Chiridion, UI:** `useRuntimeThread` behind `PiChatStream`, plus the fetch-based RPCs. Ship on staging, and dogfood multi-tab, multi-user, ask_user, stop, model switch and reconnect under a throttled network.
5. **Cut over:**
   - New threads pin to `thread_runtime` instead of DO KV. The DO path for runtime threads stays only for threads already pinned in DO KV; those are staging-only today, and a one-off copy can move them.
   - Automations and channels move when the lifecycle webhook is live. Until then they create DO threads.
6. **Old threads:**
   - Lazily migrate on open: import `pi_core` into a new runtime agent (`POST /v1/agents` with initial `messages`; the runtime validates them, `history.ts:5`), write `thread_runtime`, and serve from then on.
   - Threads that fail import stay read-only from the DO until they age out.

**What gets deleted once step 5 is done:**
- `chat-thread/runtime-agent.ts`'s `RuntimeAgentSession`, and every runtime branch in the DO (`resolveAgentBackend`, `resumeRuntimeTurn`, `answerRuntimeInput`, `prepareRuntimeRun`, `runtimeProviderRequest`, `createRuntimeAgentSession`);
- the pi_core and archive writes for runtime threads.

**Deleted after step 6:**
- `ChatThreadDO` and its in-DO Pi loop: `pi-*.ts`, `ui-mirror.ts`, `derived-render-page.ts`, `render-archive-preserve.ts`, `pi-turn-journal.ts`, `pi-compaction.ts`, `pi-stream-retry.ts`;
- the chat WS, poll and SSE transport (`sse-agent-client.ts`, `use-sse-agent.ts`, `chat-thread/*-connection.ts`, `transport.md`);
- `@cloudflare/ai-chat`;
- `bedrock-pi-*`, if Bedrock only serves the runtime path by then;
- the `CHAT_THREAD` binding, via a deletion migration.

## 6. Risks and open questions

1. **Latency to us-west-2:**
   - A send or history call is one Worker → runtime round trip (~150–250 ms from Europe), versus a local DO today.
   - Mitigations: settled history pages are cached; the first paint comes from the loader, which is server-side and cached; streaming latency is dominated by the model.
   - Measure the time to first chunk on staging before cutting over.
2. **Runtime outage:** runtime threads cannot send, and without the KV snapshot they cannot load. Today they cannot send either; a DO would still render. Decide whether the read-only snapshot is worth building (recommend yes, small).
3. **Ordering and reconnect:**
   - The runtime cursor is the only order. Sends are idempotent by clientMessageId.
   - A reconnect resumes at the cursor, or takes the snapshot on a gap (runtime item 3).
   - Until item 3 ships, a gap means re-reading the newest history page and continuing from `/state`'s cursor, with the partial message lost until its `message_end`. That is acceptable only on staging.
4. **Connection setup and other interactive tools:** check that `prompt_connection_setup` over MCP can be expressed as a runtime `url`/`form` input without the DO. It uses `promptConnectionSetup` on the DO now (code-mode-tools.ts:4876), and its OAuth completion (`connection-setup-completion.ts`) calls the DO.
5. **Poll fallback cost:** users on the poll fallback (~50% day one, see the SSE-migration notes) poll the Worker, and each poll becomes a runtime `/events` connect and read with a cursor. The runtime must answer a short-lived watcher cheaply, e.g. `?poll=1` returns buffered frames and closes. Add this to runtime item 1.
6. **Private data in the stream:** events include tool args and results, which the thread's viewers already see. The proxy must still drop the runtime's `ready.connection` id and any runtime-internal frames. Keep an allow-list of frame types.
7. **Thread-level features that assumed DO state need a home:** verified-work state, streaming activity for sidebars and the `thread_streaming_status` writer. The lifecycle webhook covers start and finish. Mid-turn "activity text" in the sidebar would come from WorkspaceDO being updated on `run.started`, or be dropped. Decide.
8. **Billing attribution for steers from another user:** today steering keeps the initiator's `actor` (DO:6541). The runtime keeps the run's actor for steers (runtime-agent.ts:748), and `whileRunning:"steer"` must preserve that.
