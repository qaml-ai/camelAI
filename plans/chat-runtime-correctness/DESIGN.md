# Chat runtime correctness and simplification

Status: complete — bounded V2 implementation, tests, conformance/size gates,
focused finite A-D TLC matrix, and supplementary larger combined TLC run all pass

## Decision

The implementation replaces the former `ChatThreadDO extends AIChatAgent`
lifecycle with a small, application-owned Durable Object protocol:

```text
authenticated HTTP request
        |
        v
ChatThreadRuntimeDO extends DurableObject
        |
        +-- turns table       durable inbox + canonical transcript
        +-- runtime row       one active-turn pointer and attempt fence
        +-- outbox table      bounded client-visible state changes
        +-- one DO alarm      the only durable execution trigger
        |
        v
fresh, bounded TurnRunner attempt (plus at most one checkpoint recovery)
```

`AIChatAgent`, `Agent` lifecycle wrappers, resumable stream chunks, chat fibers,
and SDK-owned recovery do not participate in the new runtime. The Pi agent loop
may remain an implementation detail inside `TurnRunner`; it is constructed fresh
for a bounded attempt and is never allowed to own Durable Object startup.

This deliberately changes behavior. A crash may use one fresh attempt token to
continue from the last bounded durable provider/tool checkpoint. It never
reconstructs a stream, promise, or partially executed tool. If the checkpoint
contains an effect-latched call without one matching terminal result, the turn
terminates with an unknown-outcome error. The product promise is:

- an authenticated message is durably accepted exactly once;
- accepted work becomes successful or explicitly terminal within fixed bounds;
- a browser can always open the receive transport independently of agent state;
- a crash cannot duplicate a possibly side-effecting tool, and one safe
  checkpoint recovery cannot reset the original deadline or call budgets;
- reconnecting clients converge from canonical bounded state;
- the first V2 admission triggers at most one bounded legacy-history import,
  without placing migration work on transport attach or renewing the turn;
- no request, wake, replay, queue, context load, or output can grow with the
  lifetime size of the thread.

## Why replacement, not another adapter

The replaced class was 11,843 lines, while `workers/main/src/chat-thread/*.ts`
was another 11,400 lines at the baseline. Its boot path was indirectly controlled by constructors in
`Agent` and `AIChatAgent`: their wrapped `onStart` restores state and MCP data,
checks fibers, classifies interrupted chat, reads replay buffers, and schedules
recovery before application `onStart` runs. The application consequently patches
SDK private methods in its constructor, maintains an OOM wake breaker, mirrors
two transcripts, emulates WebSocket `Connection` objects over SSE, and reconciles
several overlapping recovery budgets.

Moving those methods to more files would not simplify that ownership model. The
new class therefore must extend `DurableObject<ChatEnv>` directly. It has no
`onStart` method, does no constructor I/O, and does not call
`__unsafe_ensureInitialized`.

## Non-goals

The replacement does not preserve these behaviors:

- exact token/chunk replay after a disconnect;
- exact continuation of a half-written assistant response after a DO crash;
- recovery of an effect-latched tool call without a matching terminal result;
- more than one recovery, or recovery from an in-memory stream/promise rather
  than a bounded durable provider-response/tool-result checkpoint;
- steering extra messages into an already-running Pi session;
- blocking a model attempt indefinitely on an attached browser, user question,
  connection setup, or tool approval;
- keeping an in-memory Pi session warm across turns;
- restarting an active turn because model, BYOK, or integration configuration
  changed; a running attempt keeps its configuration snapshot and the next turn
  gets the new version;
- retaining Agents SDK RPC, state, resume-handshake, or `UIMessageStream` wire
  compatibility;
- retaining `cf_ai_chat_*` tables as an authoritative store;
- preserving internal tool traces as future model context;
- provider-generated transcript summarization on a request path;
- preserving every historical admin repair RPC after the bounded cutover.

These are explicit product reductions, not temporary omissions. If one is added
later, it needs its own finite state, storage bound, deadline, formal action, and
source-size budget.

## Runtime components

The implemented runtime has these application-owned pieces. Exact size
acceptance comes from the audited manifest and gates below, not a parallel prose
estimate.

| Component                                                  | Responsibility                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `chat-thread/chat-thread-runtime-do.ts`                    | Plain-DO RPC facade, alarm entry point, bounded compatibility state |
| `chat-thread/runtime-lifecycle.ts`                         | Pure lifecycle states, events, reducer, invariants                  |
| `chat-thread/durable-turn-store.ts`                        | SQLite schema, fenced transitions, bounded snapshots/outbox         |
| `chat-thread/durable-turn-driver.ts`                       | Single alarm owner, attempt fencing, end-to-end deadline            |
| `chat-thread/bounded-turn-runner.ts`                       | Provider/tool loop, child deadlines, payload bounds                 |
| `chat-thread/chat-runtime-controller.ts`                   | Bounded POST/SSE protocol and writer registry                       |
| `chat-thread/pi-turn-adapter.ts`                           | Fresh model/tool adapter loaded only by the alarm runner            |
| `pi-system-prompt.ts` and `selfhost-agent-pack.ts`         | Pre-bounded prompt and deployment-skill projection                  |
| `chat-thread/legacy-session-migration.ts`                  | Bounded, read-only JIT legacy scan and atomic import                |
| `workers/main/src/index.ts`                                | Counted shared V2 route and authorization boundary                  |
| `src/lib/chat-runtime-bounds.ts`                           | Single registry of finite bounds                                    |
| `src/lib/chat-runtime-client.ts` and `use-chat-runtime.ts` | Cursor SSE, POST admission/control, reset handling                  |

Product helpers such as preview state, model resolution, code-mode tools, billing,
and metadata may remain collaborators, but they may not mutate lifecycle state
except through an explicit machine action.

## Persisted schema

`chat_turns_v2` is both the durable inbox and canonical transcript. We do not
need a second message table or a durable token stream. The schema is
intentionally small; literal limits shown below are also checked in application
validation so a clear error can be returned before SQLite rejects a row.

```sql
CREATE TABLE IF NOT EXISTS chat_turns_v2 (
  id                    TEXT PRIMARY KEY,
  client_message_id     TEXT NOT NULL UNIQUE,
  thread_id             TEXT NOT NULL,
  workspace_id          TEXT NOT NULL,
  org_id                TEXT NOT NULL,
  user_id               TEXT,
  source                TEXT NOT NULL,
  user_content          TEXT NOT NULL,
  user_display          TEXT NOT NULL,
  assistant_final       TEXT,
  assistant_error       TEXT,
  status                TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'interrupted')
  ),
  payload_bytes         INTEGER NOT NULL CHECK (payload_bytes >= 0),
  attempt_count         INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
  recovery_count        INTEGER NOT NULL DEFAULT 0 CHECK (recovery_count BETWEEN 0 AND 1),
  attempt_token         TEXT UNIQUE,
  lease_expires_at      INTEGER,
  terminal_deadline_at  INTEGER NOT NULL,
  effect_started        INTEGER NOT NULL DEFAULT 0 CHECK (effect_started IN (0, 1)),
  checkpoint_json       TEXT NOT NULL,
  retained              INTEGER NOT NULL DEFAULT 1 CHECK (retained IN (0, 1)),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS chat_turns_v2_one_running
  ON chat_turns_v2 ((1)) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS chat_attempt_tokens_v2 (
  token       TEXT PRIMARY KEY,
  turn_id     TEXT NOT NULL,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_runtime_v2 (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  revision        INTEGER NOT NULL,
  active_turn_id  TEXT,
  thread_id       TEXT,
  workspace_id    TEXT,
  org_id          TEXT
);

CREATE TABLE IF NOT EXISTS chat_outbox_v2 (
  seq            INTEGER PRIMARY KEY AUTOINCREMENT,
  revision       INTEGER NOT NULL,
  event_type     TEXT NOT NULL,
  turn_id        TEXT NOT NULL,
  status         TEXT NOT NULL,
  payload_bytes  INTEGER NOT NULL,
  created_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_legacy_migration_v2 (
  singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
  state           TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'failed')),
  attempt_count   INTEGER NOT NULL CHECK (attempt_count BETWEEN 0 AND 2),
  attempt_token   TEXT,
  deadline_at     INTEGER NOT NULL,
  imported_turns  INTEGER NOT NULL,
  imported_bytes  INTEGER NOT NULL,
  source           TEXT,
  error            TEXT,
  started_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
);
```

Important schema rules:

- `client_message_id` is the idempotency key. An admission retry returns the
  existing row's status and never creates a second turn.
- `chat_runtime_v2.active_turn_id` is either null or names exactly one `running`
  row. Recovery replaces the token; it never creates a second owner.
- `attempt_count` records the initial claim and `recovery_count` records the sole
  recovery, so their sum is at most two. `chat_attempt_tokens_v2` permanently
  rejects token reuse. Every durable transition is fenced by the current token
  and original absolute deadline; a late promise from either token has no
  authority.
- One bounded, validated `checkpoint_json` is the atomic recovery record. It
  stores the turn-wide provider count, provider-in-flight bit, ordered provider
  batches, every call's exact input/effect latch/matching terminal result, and
  an optional final response. No parallel batch or tool-result table can drift.
- The per-call `effectStarted` latch is persisted before every tool invocation;
  the turn-level `effect_started` column is only a coarse durable summary. There
  is no name-based read-only classification. Recovery may continue calls proved
  unstarted; any latched call without a result terminalizes the turn.
- Provider-call count, tool-call count, checkpoint bytes, and the accepted-to-
  terminal deadline are turn-wide. Recovery inherits them; none resets. Another
  inference is rejected until the latest checkpointed batch is completely
  closed.
- A live V2 attempt can commit `completed` only after its fenced final
  checkpoint exactly matches the answer; terminal commit then scrubs the
  execution checkpoint. Context admits only completed rows, including bounded
  settled rows validated and inserted atomically by legacy migration. Failed,
  interrupted, incomplete, or uncertain turns are excluded.
- The final assistant payload is canonical. Live token deltas are ephemeral and
  optional; the first implementation should show activity and then the settled
  answer rather than persist token chunks.
- Tool results are canonicalized to bounded JSON text and committed against the
  exact checkpointed batch/call id before another provider request. Full oversized
  artifacts belong in workspace R2; checkpoints retain only bounded payloads.
- Preview, title, todo, and automation metadata may remain in their existing
  bounded scalar stores during extraction. They are not lifecycle truth.

## Global bounds

All values live in `src/lib/chat-runtime-bounds.ts`. No caller supplies or increases a
bound. Child deadlines are `min(parentDeadline, localDeadline)`.

| Resource                                 |                                        Initial hard bound |
| ---------------------------------------- | --------------------------------------------------------: |
| accepted request body                    |                                                   256 KiB |
| lifetime durable admissions per thread   |                                                     4,096 |
| queued turns per thread                  |                                         8 and 1 MiB total |
| total accepted-to-terminal duration      |                                                20 minutes |
| attempts per turn                        |      2: initial plus at most one safe checkpoint recovery |
| one provider request                     |                                                 2 minutes |
| provider calls per turn, across recovery |                                                        34 |
| provider stream events per call          |                                                     8,192 |
| provider output                          |                   16,384 tokens, then 1 MiB retained text |
| one tool call                            |                                                10 minutes |
| tool calls per turn, across recovery     |                                                        32 |
| durable recovery checkpoint              |                                                     8 MiB |
| model context                            |                           newest 64 messages and <= 4 MiB |
| system prompt                            |                                                   256 KiB |
| tool schema catalog                      |                                                   512 KiB |
| one tool input / retained result         |                                          64 KiB / 256 KiB |
| all tool inputs / results per turn       |                                           1 MiB / 1 MiB |
| one temporary tool-result overflow       |                                                     2 MiB |
| temporary overflows per alarm attempt    |                                   4 objects / 4 MiB |
| temporary overflows per turn             |      8 objects / 8 MiB across the two-attempt limit |
| retained overflow-reference stub         |                                                     4 KiB |
| all provider checkpoint state per turn   |                                                     2 MiB |
| one tool source text read                |                                2 MiB / 4,096 chunks |
| one inline image result                  |                              128 KiB base64 payload |
| one `tools.move` operation               |                  256 files / 8 MiB each / 64 MiB total |
| live presentation per turn               |                           4,096 frames / 64 MiB total |
| browser snapshot cache                   |                 8 entries / 5 MiB each / 16 MiB total |
| assistant payload                        | 1 MiB; provider overflow rejects and generic output clips |
| retained settled history                 |                                    128 turns and <= 8 MiB |
| reconnect snapshot source                |                                  50 messages and <= 8 MiB |

These are allocation boundaries as well as retained-data boundaries. Stream,
R2, provider, and checkpoint sizes are checked before materialization when the
source exposes a length. Unknown streams are read with byte and chunk ceilings.
Text line windows are scanned incrementally rather than split into arrays, and
recovered provider JSON is rejected before replay when its top-level parts,
depth, entries, or nodes exceed the shared structural limits. Tool outputs are
bounded before artifact capture, telemetry, RPC, checkpoint, or prompt copies;
multimodal output must fit the same result budget. A complete result that cannot
fit inline is written best-effort to the thread-scoped R2 `tmp/` namespace and
replaced by a bounded reference/preview. The checkpoint reserves one such stub
for every unresolved call; unavailable or over-ceiling storage becomes an
explicit preview-only stub and never causes tool replay or an unbounded write.
The counters are attempt-local because no overflow bookkeeping is durable; the
per-attempt ceiling is half the two-attempt turn ceiling. Externalization shares
the already-latched effect window and has its own 10-second deadline. A crash or
deadline after the tool but before its reference is recorded therefore
interrupts the turn as an uncertain effect; it never reruns the tool. A late R2
put is observed and best-effort deleted, and can never become a durable result.
| outbox event                             |                                                    64 KiB |
| retained outbox                          |                                   256 events and <= 2 MiB |
| SSE writers                              |                                 8 per user, 32 per thread |
| escaped SSE data frame                   |                                                     5 MiB |
| undrained writer queue                   |                                             5 MiB + 4 KiB |
| aggregate undrained SSE bytes per DO     |                                                    40 MiB |
| live presentation per turn               |                              4,096 frames / 64 MiB |
| settled browser snapshot cache           |                       8 entries / 16 MiB aggregate |
| turns processed by one alarm invocation  |                                                         1 |
| JIT legacy migration                     |                         30 seconds; 2 attempts; one retry |
| legacy scan                              |          32 metadata rows/page; 4,480 source rows maximum |
| legacy import                            |                   newest 128 completed turns and <= 8 MiB |

The fixed model-only context projection selects `user_content` and
`assistant_final` only from bounded retained `completed` rows, excluding the
current turn, and stops before either message/byte limit. It never substitutes
UI display text or includes an incomplete or uncertain terminal turn. There is
no request-time transcript summary, history watermark, or full thread
materialization.

The outbox prunes on append. If a client's cursor predates the retained minimum,
the server emits an authoritative `reset` containing the newest bounded snapshot.
The 8 MiB source-snapshot and checkpoint ceilings account for worst-case JSON
escaping of one legal 1 MiB assistant result plus bounded metadata. The SSE
encoder independently measures the fully escaped wire frame, removes oldest
complete turns first while preserving the newest turn, and dynamically truncates
content if needed to fit the 5 MiB frame ceiling. Each writer has 4 KiB of
additional bounded queue space for its heartbeat and hello frame. Exact remaining
queue capacity and the 40 MiB aggregate reservation are checked before enqueue;
a slow writer is discarded and reconnects from its durable cursor.

## Transport protocol

Main-worker authorization remains the trust boundary. It strips user-controlled
scope headers and forwards verified thread/workspace/org/user scope to the runtime.
The runtime verifies that new message scope matches its stored thread scope, but it
does not rerun organization/network checks during stream attachment.

### Receive

`GET /agents/chat-thread/:threadId/v2/events?after=<outbox-seq>`:

1. allocate a bounded writer and register it in the isolate-local map;
2. synchronously write `:hb\n\n`;
3. return the `text/event-stream` response;
4. after open, read only the singleton runtime row and one bounded outbox page;
5. send `hello`, then catch-up events or `reset`;
6. close idle streams after a fixed grace and let the client reconnect.

Transport establishment never waits for schema migration, history, context,
provider configuration, Pi construction, MCP/integration restoration, an active
turn, or crash classification.

There is no synthetic `Connection`, pending-resume set, resume ACK, durable stream
chunk table, framework `onConnect`, or framework `onClose` cleanup chain.

### Send

`POST /agents/chat-thread/:threadId/v2/messages` carries a typed message plus
`clientMessageId`. A successful response is `202` with `{turnId, status}` and means:

- an immediate alarm was durably pre-armed;
- validation and queue-cap checks passed;
- the unique `chat_turns_v2` row and `accepted` outbox event are durable;
- the response was released only after both operations succeeded.

The receive stream is not required for sending. Queue full returns `429` with a
bounded retry hint. Invalid/oversized input is terminal `4xx`.

The explicit control endpoint allowlists `stop`, `answer_question`, and
`connection_setup`; the latter two store bounded compatibility responses but do
not unblock or resume the bounded model loop. Preview/history compatibility
remains typed DO RPC, not generic Agents frames.

## Bounded JIT legacy migration

The first durable V2 admission creates the only authority to inspect legacy
history. Opening or reconnecting an SSE stream never starts migration and never
waits for it. The durable marker moves monotonically through
`unseen -> pending -> complete|failed`; `complete` and `failed` are permanent.

`BeginLegacyMigration` records a fresh migration token, attempt one, and a fixed
30-second absolute deadline. `RetryLegacyMigration` may mint one fresh token for
attempt two, but preserves that deadline and every queued turn deadline/counter.
While the marker is `unseen` with admitted work or `pending`, the alarm cannot
claim a turn. Admission itself remains available and each queued row continues
to age toward its original accepted-to-terminal deadline.

The legacy source is read-only. A scan reads at most 32 metadata rows per page,
4,480 source rows total, and imports only the newest 128 completed turns within
8 MiB. `CompleteLegacyMigration` commits the bounded imported rows and the
`complete` marker in one SQLite transaction. Deadline, malformed/oversized
source, or exhausted retry commits `failed`; V2 then proceeds without legacy
history. Either terminal marker prevents every later legacy read or write.

The ai-chat fallback pages by indexed `rowid` unless both its permanent
`metadata_v1` completion marker and chronology index exist; only that completed
pair authorizes `chronology_key` ordering. A partially backfilled chronology
column is never trusted as a total order.

## Alarm and attempt protocol

The alarm is the only durable driver. `waitUntil` may publish telemetry or mirrors,
but never owns accepted work, completion, or required cleanup.

Before an alarm attempt performs any external await, it schedules a future alarm
at the attempt deadline. That future alarm is the crash detector. On ordinary
completion it is moved to `now` for queued work or deleted when idle. If the
handler or isolate dies, the already-scheduled alarm observes the expired running
row.

The runner uses one `AbortController` rooted at the original turn deadline.
Every provider/tool call receives a child signal and is fenced by
`Promise.race`. Timeout first persists terminal state and the next alarm, then
calls `ctx.abort()` to evict uncancellable local/RPC work. Ignoring abort cannot
restore authority: every late result is fenced by token and time, observed to
avoid unhandled rejection, and discarded.

Provider work is checkpointed in whole batches. Before a provider request, a
durable action increments the turn-wide provider-call counter. Its response is
then committed atomically with the complete call-id set. For each call, persist
`effect_started = 1` before invocation and commit exactly one terminal result
against the same batch/call id. A later inference is enabled only after the
entire preceding batch is closed by those one-to-one terminal results.

A crash or deployment may recover once with a fresh token. Recovery retains the
original absolute deadline, provider/tool counters, bounded checkpoint bytes,
completed call results, and tool limits. It starts only from the last durable
base/closed-batch checkpoint or a provider-response checkpoint whose incomplete
calls are all provably unstarted. It constructs new provider/tool operations;
it never resumes an old stream, promise, iterator, or signal.

If any call has an effect latch without a matching terminal result, its external
outcome is unknown. The whole turn terminalizes, is marked ineligible for future
model context, and is never recovered. This at-most-once bias can produce a false
terminal if the isolate dies between latch and invocation; retrying an unknown
deployment, purchase, message send, or mutation is not acceptable.

## Transition table

The durable store/outbox, tests, telemetry, and formal model share these names
verbatim. The pure reducer intentionally exposes only the coarse seven-action
admission/ownership/terminal projection; it does not duplicate checkpoint or
migration payload state.

| Action                    | Preconditions                                                                          | Durable transition                                                                         | Command after commit                                                  |
| ------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| `DurablyAdmit`            | id absent; queue count/byte caps available; scope matches                              | insert `queued`, append event, increment revision                                          | return 202 only after the pre-armed alarm and row both exist          |
| `BeginLegacyMigration`    | a V2 turn is durably admitted; marker unseen                                           | set pending, fixed deadline, attempt one and fresh token                                   | scan the bounded read-only legacy source                              |
| `RetryLegacyMigration`    | pending attempt one; original migration deadline live                                  | increment to attempt two with a fresh token; preserve deadlines/counters                   | repeat the bounded read only once                                     |
| `CompleteLegacyMigration` | current migration token; bounded validated import                                      | atomically insert bounded settled history and mark complete                                | arm admitted V2 work; never read legacy state again                   |
| `FailLegacyMigration`     | current token; deadline/data failure or retry exhausted                                | permanently mark failed                                                                    | arm admitted V2 work without legacy context                           |
| `StartSelectedTurn`       | migration complete/failed; no active row; oldest queued row; attempt count is 0        | set `running`, initial token and lease, preserve original terminal deadline, set active id | set exact lease/deadline alarm, then begin provider call              |
| `StartNextInference`      | current token; clean base/closed batch; provider budget remains                        | increment turn-wide provider count; mark provider in flight                                | invoke one bounded provider request                                   |
| `CheckpointProviderBatch` | current token and in-flight provider; bounded response and cumulative call budget      | atomically store provider response and complete call-id set                                | dispatch only calls represented by the checkpoint                     |
| `CheckpointProviderFinal` | current token and in-flight provider; bounded final response                           | durably store the final response checkpoint                                                | commit terminal success using the same token and bytes                |
| `BeginEffect`             | current token; exact next pending batch/call; deadline live                            | set that call's effect latch                                                               | invoke the tool; externalize a complete overflow within 10 seconds    |
| `RecordToolResult`        | current token; exact effect-latched batch/call; bounded inline/reference result ready  | store one bounded terminal result for that call                                            | begin inference only if the whole batch is now closed                 |
| `RecoverFromCheckpoint`   | foreign initial token; one recovery remains; original deadline live; no uncertain call | mint fresh token, increment recovery count, preserve checkpoint and all counters           | construct new operations from the durable checkpoint only             |
| `CompleteTurn`            | current token; closed checkpoint with matching bounded final answer; deadline live     | store answer, set `completed`, scrub execution checkpoint, clear active                    | publish snapshot and arm next queued turn                             |
| `FailTurn`                | current token; bounded provider/tool/runtime failure; deadline live                    | store bounded error, set `failed`, scrub checkpoint, clear active                          | persist next alarm, then abort isolate for uncancellable timeout work |
| `ExpireOperation`         | queued terminal deadline or running lease/terminal deadline crossed                    | set queued work `failed` or running work `interrupted`, clear active if needed             | publish and arm remaining work                                        |
| `ReconcileCrashedTurn`    | stop; recovery exhausted; invalid checkpoint; or effect-latched call lacks a result    | set `interrupted`, scrub checkpoint, clear active                                          | abort local work when present, publish, never recover this turn again |

There is no unbounded `recovering` phase. An alarm makes one atomic decision:
recover once from a safe bounded checkpoint or terminalize. A client sees
`queued`, `running`, or a terminal status; recovery is an internal token change
with a hard count of one and never renews the absolute deadline.

## Pure machine and storage boundary

`chat-thread/runtime-lifecycle.ts` is deterministic and side-effect free:

```ts
transitionRuntimeLifecycle(state, event) -> result
```

It knows the coarse admission/ownership/terminal projection but not SQL,
checkpoint payloads, legacy scans, `fetch`, Pi, timers, or SSE.
`chat-thread/durable-turn-store.ts` owns the complete durable action vocabulary
in synchronous SQLite transactions and checks revision/attempt fences. The
driver performs alarms and external work only around those durable boundaries.

Ordinary lifecycle writes to `chat_runtime_v2`, `chat_turns_v2`, and
`chat_outbox_v2` belong to `DurableChatTurnStore`. The sole intentional
exception is `LegacySessionMigrator`: under its migration token and fixed
deadline, one transaction inserts only validated, already-completed historical
turns and atomically advances the migration marker, runtime revision, and
bounded outbox. It never claims or updates an admitted V2 turn. No other
collaborator writes those tables directly.

## Formal model

The TLA+ model lives at:

```text
plans/chat-runtime-correctness/formal/ChatLifecycle.tla
plans/chat-runtime-correctness/formal/ChatLifecycle.cfg        # larger combined instance
plans/chat-runtime-correctness/formal/ChatLifecycle{A,B,C,D}.cfg # focused CI matrix
```

It models finite turns, lifetime admissions, one bounded JIT legacy migration,
one recovery, atomic multi-call provider batches, exact call/result matching,
alarms, and time ticks.
Nondeterministic actions include duplicate admission, provider batch size,
provider/tool success/failure/stall, crash around every checkpoint, late old-token
completion, effect start, pruning, and isolate abort.

Required safety properties:

- `TypeOK`;
- at most one active turn;
- active implies exactly one running row;
- terminal status never changes or returns to nonterminal; bounded pruning may
  scrub payload while preserving the admission tombstone;
- an accepted client id names one turn;
- only the current attempt token and a live original deadline can commit;
- attempts never exceed two and recovery never exceeds one;
- recovery uses a fresh token and never resets deadline or call counters;
- provider responses are atomic call sets; every call has at most one matching
  terminal result;
- next inference implies every call in the preceding batch has exactly one
  matching terminal result;
- a crash with an effect-latched call lacking a result terminalizes and makes
  that turn ineligible for future canonical context;
- admission, queue, checkpoint, provider/tool, migration, transport, and clock
  quantities remain within their finite formal bounds;
- a transport open action is independent of runner/recovery state;
- legacy reads begin only after durable V2 admission, use at most two fresh
  tokens under one absolute deadline, and are impossible after a terminal marker;
- turn claim is disabled until migration is complete or failed, and migration
  never resets queued-turn deadlines or execution counters.

Required liveness properties under weak fairness for alarm delivery and time:

- every pending transport reaches first-byte open or explicit timeout-close;
- every pending legacy migration eventually reaches complete or failed after
  its fixed clock reaches zero if no earlier outcome occurs;
- every accepted turn eventually becomes terminal and every active owner is
  released;
- every safely recoverable crash obtains its one fresh fence or terminalizes;
- every terminal timeout that requires isolate abort eventually performs it.

TLC runs four focused finite configurations in parallel CI. A successful run
exhaustively explores its configured finite graph and checks the complete
invariant and liveness set. Separate instances make duplicate/lifetime admission,
two-row FIFO, two-call batch recovery, and queue rejection reachable without
multiplying all dimensions into one standard-runner state space.
`ChatLifecycle.cfg` is a larger three-message/two-call combined instance for a
large verifier; it does not subsume every focused boundary, including D's
queue-before-lifetime-cap case. The formal model is not claimed to prove
TypeScript conformance by itself. The checked implementation seam is:

- a script that compares the complete durable action vocabulary in the model
  and store/outbox, checks the reducer's deliberate coarse subset, and checks
  migration, one-recovery, and batch-checkpoint structure;
- exhaustive short reducer traces that assert the lifecycle invariants after
  every action;
- deterministic store/driver tests for deduplication, token/time fences, batch
  atomicity, exact result matching, safe recovery, unsafe reconciliation,
  original-deadline preservation, migration fencing, stop, and late completion;
- deterministic controller and runner tests for transport, payload, call-count,
  deadline, abort, and UTF-8 bounds.

## Implemented deletion surface

The following code existed only because the application delegated lifecycle and
transport semantics to Agents/AIChatAgent. It was removed when V2 took traffic.

### Removed source files

- `workers/main/src/chat-thread/sse-connection.ts`
- `workers/main/src/chat-thread/ui-mirror.ts`
- `workers/main/src/chat-thread/render-archive-preserve.ts`
- `workers/main/src/chat-thread/pi-turn-journal.ts`
- `workers/main/src/chat-thread/pi-stream-retry.ts`
- `workers/main/src/chat-thread/chat-memory-telemetry.ts`
- `src/lib/sse-agent-client.ts`
- `src/lib/use-sse-agent.ts`
- `src/lib/use-pi-chat-stream.ts`
- `src/lib/pi-chunk-encoder.ts`
- `src/lib/ui-message-adapter.ts`
- `src/lib/steer-split.ts`

The cutover also removed rather than preserving compatibility facades for:

- `workers/main/src/chat-thread/derived-render-page.ts` with a bounded `chat_turns`
  pager;
- `workers/main/src/chat-thread/pi-core-store.ts` with the much smaller turn store;
- `workers/main/src/chat-thread/pi-compaction.ts` with a fixed newest-turn/byte
  context reader;
- the relevant transport/streaming sections of `src/components/Chat.tsx` with the
  cursor client hook.

`src/lib/chat-thread-display.ts` survives as a small canonical `Message[]` route
adapter and remains inside the source-size manifest. The V2 browser path does not
convert through or replay `UIMessage` chunks.

### Removed `ChatThreadDO` method families

- inheritance/imports for `AIChatAgent`, Agents `Connection`, `callable`, and
  `agents/chat`;
- constructor wrapping of framework `onStart` and `onMessage`;
- `chatRecovery`, `chatStreamStallTimeoutMs`, `initialState`, state hydration, and
  `syncAgentState`;
- `onStart`, `_cleanupStreamBuffers`, `armWakeOomGuard`, `resetWakeOomGuard`,
  `quarantineStreamBuffers`, every `installBounded*`, every `replay*`, stream byte
  accounting, and degraded-stream bookkeeping;
- `persistMessages` override, `sweepOrphanedActiveTurnMarker`,
  `hasActiveChatRecovery`, resident render-history send, and client reconcile;
- synthetic-connection registry/capture helpers, pending/close registries,
  `broadcast` override, framework `onConnect`, `onMessage`, and `onClose`, and
  resume-frame POST dispatch;
- `onChatMessage`, `onChatRecovery`, `onChatResponse`, reply-stream stall wrapping,
  cancellation disposal, chunk writer/encoder/pre-attach buffering, and durable
  terminal reassertion;
- journal wrapper methods, active-turn marker methods, `resumeActivePiTurn`, the
  split recovery budgets, degraded recovery, transient/config-change re-drive,
  salvage, give-up, abandonment, and terminal-delivery ladder;
- long-lived Pi session/promise/subscription/baseline/load-window state and runner
  transition locks; attempts use local `TurnRunner` state;
- UI mirror/top-up/rebuild/healing/resync and render archive preservation;
- request-path and post-turn transcript compaction, compaction memos, and rerun
  scheduling;
- `forceClearHungTurn`; the ordinary idempotent stop/reconciliation path now
  terminalizes the owned turn;
- durable viewer-presence inference and auto-recovery decisions based on a presumed
  browser. Future questions are bounded records, not blocked model promises;
- config-change active-turn rebuild. Configuration changes affect later turns
  only.

### Removed fields

The cutover deleted the framework/recovery state, including:

- `ssePendingConnectionRegistry`, `sseCloseChainRegistry`, framework resume maps,
  and `sseQueueBudgetRef` in its synthetic-connection form;
- `wakeGuardArmed`, `replayBoundOverrides`, `boundedReplayStream`,
  `boundedRecoveryPartialRead`, and degraded replay caches;
- `legacyUiMessageHealingPromise`, `derivedRenderWindowCache`,
  `piDeriveRowSourceInstance`, `lastDerivedRenderPageStats`, and
  `uiMirrorInstance`;
- `piTurnJournalInstance`, `pendingPiPromptQueue`, `activePiStreamTurnId`,
  `piChunkEncoder`, `piStreamWriter`, and `piPreAttachChunkBuffer`;
- `piConfigChangeResumeDepth`, `piDegradedResumeAttempt`,
  `piEphemeralCompaction`, `pendingPiTurnTerminal`, transient retry/backoff state,
  and all resume counters/markers;
- long-lived `piSessionPromise`, `piSession`, `piUnsubscribe`,
  `piMainBaselineIndex`, and `piSessionLoadWindow`;
- the separate streaming lease, tool keepalive, and recovery timers. One
  original absolute turn deadline plus one alarm owns both attempts;
- memory-store sampling caches whose only purpose is observing unbounded SDK stores.

The replacement keeps only a simple isolate-local SSE writer registry, queue byte counters, one local
abort controller for the current attempt, and optional ephemeral live activity.
None is durable truth.

## Test deletion and replacement

The cutover deleted tests whose asserted contract was intentionally removed:

- `workers/main/tests/chat-sse-connection.test.ts`
- Agents resume/frame-order/Connection portions of
  `workers/main/tests/chat-sse-transport.test.ts`
- `workers/main/tests/chat-thread-pi-stream-bridge.test.ts`
- `workers/main/tests/chat-thread-stream-replay-bounds.test.ts`
- `workers/main/tests/chat-thread-render-archive-preserve.test.ts`
- `workers/main/tests/chat-thread-ui-mirror.test.ts`
- old derive-versus-ai-chat pagination equivalence tests in
  `workers/main/tests/chat-thread-derive-pagination.test.ts`
- `workers/main/tests/chat-thread-agent-state.test.ts`
- old recovery-ladder, resume-budget, stream-stall, reply-trim, orphan-marker,
  durable-terminal-reassert, and post-turn-compaction sections in the large Pi-turn
  suites;
- memory telemetry tests that inspect `cf_ai_chat_*` stores.

Those contracts were not mechanically ported. A compact suite is organized by
the new invariants:

- SSE first byte is available while schema/history/runner promises are blocked;
- 202 implies durable unique turn plus armed work;
- duplicate message id is idempotent before, during, and after an attempt;
- queue/body/history/context/outbox/writer caps reject or reset deterministically;
- one active owner under duplicate/early alarms;
- attempt token rejects late completion;
- exhaustive short crash/fault traces preserve the pure lifecycle invariants;
- a safe first-attempt crash recovers once from a bounded checkpoint with a
  fresh token and unchanged deadline/counters;
- a crash after an effect latch without its result terminalizes, excludes the
  turn from future context, and never reinvokes that call;
- multi-call provider batches cannot advance inference until every call has one
  matching terminal result;
- provider/tool/end-to-end deadlines all terminate;
- stop is idempotent, clears ownership, and fences a late result;
- reconnect catches up a retained cursor or receives reset;
- alarm processing handles one turn and re-arms the next;
- the conformance check keeps the reducer/store action vocabulary aligned with
  TLA+;
- fixed-tail context never reads more rows/bytes than its contract.

Existing tool, billing, model-selection, preview, channel, metadata, and eval tests stay
only for behavior the smaller runner retains. Split useful tool tests out of the
16,000-line facade suite rather than constructing prototype-fake ChatThreadDO objects.

## Implemented cutover

The cutover deliberately did not build a compatibility mode inside the old
`AIChatAgent` subclass and did not create a parallel `CHAT_THREAD_V2` namespace.
Instead:

- `workers/main/src/chat-thread-do.ts` became a small compatibility export that
  preserves the deployed `ChatThreadDO` class/binding name and therefore existing
  Durable Object identities;
- that export points directly to `chat-thread/chat-thread-runtime-do.ts`, a plain
  `DurableObject<ChatEnv>` implementation;
- all browser traffic moved to `/v2/events`, `/v2/messages`, and `/v2/controls`,
  while non-browser callers retained bounded typed RPC methods on the same stub;
- `ChatRuntimeClient`/`useChatRuntime` replaced the Agents client directly; there
  is no feature flag, dual writer, runtime-version resolver, or cohort split;
- the new SQLite tables are authoritative for V2 turns. After the first durable
  V2 admission, one alarm-owned bounded JIT migration may read legacy history;
  transport attach, ordinary requests, and later model-context paths never do;
- that one-way importer scans read-only legacy state within fixed row/byte/time
  bounds, atomically commits at most 128 settled turns, and leaves a permanent
  `complete` or `failed` marker. There is no exporter or reverse migration;
- the old runtime files, routes, and behavior-specific tests were deleted rather
  than hidden behind compatibility branches.

Because V2 writes use a new canonical schema and there is no reverse exporter,
rollback must remain on the bounded runtime. Reintroducing the old export against a
DO that accepted V2 messages would hide accepted state and is not a valid rollback.

## Source-size and ownership gate

Smaller code is a binding acceptance criterion, not an aesthetic goal. The exact
checked-in authority is
`plans/chat-runtime-correctness/runtime-source-manifest.json`; prose inventories
must not substitute for it. The manifest owns every TypeScript file under
`workers/main/src/chat-thread/` and `workers/main/src/chat-runtime/`, and watches
the stable DO export and browser-prompt collaborator, plus the bounded browser
client/state modules that primarily exist for this lifecycle. It also watches
and counts the entire shared `src/components/Chat.tsx`,
`workers/main/src/helpers/auth.ts`, `workers/main/src/index.ts`,
`workers/main/src/pi-system-prompt.ts`, and
`workers/main/src/selfhost-agent-pack.ts` files rather than selected excerpts.
Those files own the V2 UI seam, authorization, dispatch/header/fallthrough
boundary, and pre-bounded attempt setup. Only the shared UI component is exempt
from the per-file cap; every line still counts toward the aggregate. The size
checker hard-requires these integration sources, while the conformance checker
pins their lifecycle semantics; moving work to an uncounted helper therefore
fails the gates.
The manifest must be updated whenever that ownership changes.

The frozen dirty-tree baseline is **28,448 physical lines**. The cutover may not
be declared complete unless the currently declared production surface is
**18,000 physical source lines or fewer**, a reduction of at least 10,448 lines
(36.7%). Tests, TLA+ specifications, plans, and vendored/generated code are
excluded. Moving a runtime-owned helper outside an owned directory does not
exclude it: it must be added as a watched file.

Additional gates:

- no runtime-owned production file over 1,500 lines;
- lifecycle + storage + transport (excluding product tool implementations) at or
  below 3,000 lines, with a stretch target of 2,000;
- no `AIChatAgent`, Agents `Connection`, `__unsafe_ensureInitialized`, `chatRecovery`,
  `cf_ai_chat_`, or generic `callable()` import/reference in the final runtime;
- no SQL write to lifecycle tables outside
  `chat-thread/durable-turn-store.ts`, except the bounded atomic
  `LegacySessionMigrator` import described above;
- no unbounded transcript/history API reachable from HTTP, RPC, alarm, or runner;
- no essential `waitUntil` task;
- every loop over stored/user data has a named row/byte/attempt bound.

CI runs the checked-in manifest and deterministic line-count script. It fails when
a runtime-owned module is unlisted, a declared file is missing, the total exceeds
18,000, or a file exceeds its cap. The same script prints the per-file total and
the before/after report; no hand-maintained total decides the gate.

## Principal risks and accepted answers

| Risk                                                                    | Answer                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A tool completed externally but the DO crashed before recording success | Persist the per-call effect latch first; terminalize the whole uncertain batch, exclude it from future context, never retry that call                                        |
| A provider ignores abort                                                | Deadline race invalidates the attempt token; late completion cannot write                                                                                                    |
| Crash during acceptance                                                 | Pre-arm the alarm before inserting the turn. An alarm with no row is a harmless no-op; an inserted row always has a future wake                                              |
| Crash during provider work or before an unstarted checkpointed call     | Recover once with a fresh token from the bounded checkpoint; preserve original deadline and counters                                                                         |
| Crash after claiming work with an uncertain call                        | Terminalize and exclude from canonical context; no second recovery or tool replay                                                                                            |
| Slow/disconnected client misses events                                  | Bounded cursor catch-up or reset to canonical bounded history; no unbounded replay                                                                                           |
| Existing huge thread                                                    | The first V2 admission permits one 30-second, two-attempt bounded scan; only the newest 128 completed turns within 8 MiB import, then a permanent marker fences legacy state |
| Long coding task exceeds the new limit                                  | Explicit timeout and preserved workspace effects; user may start another turn                                                                                                |
| User question or approval would block                                   | Initial v2 returns an unavailable/needs-follow-up result; a later bounded workflow requires a separate formal design                                                         |
| New config arrives mid-turn                                             | Current attempt uses its snapshot; next attempt/turn reads the new generation                                                                                                |
| Old/new histories diverge                                               | The importer is read-only and one-way; bounded imported rows plus later V2 rows are authoritative after its atomic terminal marker, with no dual writer                      |
| TLA+ passes but TypeScript drifts                                       | Pure reducer, shared action-name check, exhaustive short traces, and deterministic store/driver tests                                                                        |
| Simplification merely moves code                                        | Audited dependency manifest, forbidden imports, per-file caps, and <=18,000-line final gate                                                                                  |

## Definition of done

The replacement is complete only when all of the following are true:

- production browser and non-browser message producers use v2;
- every accepted turn has one canonical row, at most two fenced tokens, and
  reaches a terminal state under the declared fairness assumption;
- SSE opens before any runtime/history/runner work;
- JIT legacy migration starts only after durable admission, never on transport
  attach, uses at most two tokens under one fixed deadline, and leaves a
  permanent terminal marker before claim;
- every configured invariant and temporal property passes TLC in each focused
  finite A-D instance, and the reducer trace tests pass;
- deterministic tests cover admission, ownership, atomic provider batches,
  exact call/result closure, safe one-shot recovery, unsafe batch exclusion,
  terminal/stop/expiry, migration deadline/retry/terminal fences, isolate abort
  ordering, and late-result fences;
- the model/reducer/store conformance script and the checked TLC configurations
  pass;
- the old AIChatAgent runtime, replay/recovery/mirror files, client adapter, and
  behavior-specific tests are deleted;
- the audited production surface is <=18,000 lines and passes every ownership gate;
- there is no essential unbounded promise, retry, queue, read, replay, output, or
  background task in the chat lifecycle; the only recovery is the bounded
  checkpoint action described above.
