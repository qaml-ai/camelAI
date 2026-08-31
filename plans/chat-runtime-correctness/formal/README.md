# Bounded chat lifecycle model

`ChatLifecycle.tla` is the executable correctness contract for the bounded
plain-Durable-Object chat runtime. It does not model the retired Agents SDK,
Pi-session startup, stream replay, or an unbounded recovery ladder.

## Modeled protocol

The model composes five finite state machines:

- Transport moves `absent|closed -> pending -> open|closed`. `FlushTransport`
  emits first bytes only while its budget is live; `TimeoutTransport` closes a
  request whose budget expires. Both preserve every lifecycle variable, so
  migration, storage, recovery, and provider/tool work cannot disable or become
  a prerequisite for the transport decision. The model does not falsely
  promise that a disconnected caller always observes an open stream.
- A JIT legacy import moves `unseen -> pending -> complete|failed` only after a
  V2 turn is durable or transport has opened and durably requested it. Attempt
  one establishes one absolute migration deadline;
  the only retry uses a fresh token without renewing that deadline or any queued
  turn deadline/counter. Claim is disabled until the permanent terminal marker.
  The first-byte path never begins or waits for migration. The implementation
  also treats pre-existing settled or fork-sourced V2 history as authoritative
  and completes its marker without merging legacy rows; that initial-history
  selection is outside this lifecycle model.
- `ClientPost` pre-arms the alarm. `DurablyAdmit` is the server-side durable ACK
  decision: it records an id exactly once, appends a bounded FIFO queue, and
  starts one accepted-to-terminal deadline. A lifetime admission cap makes its
  idempotency tombstones finite. `PrunePayload` scrubs old payloads but never
  removes a seen id.
- The alarm owns one active FIFO turn. `StartNextInference` persists the
  provider dispatch count before the request. `CheckpointProviderBatch`
  atomically records one ordered, globally unique call-id batch. Each call then
  moves through a durable `BeginEffect` latch and exactly one
  `RecordToolResult`, in provider order. Another inference is disabled until
  every call in the preceding batch has one terminal result.
- One crash recovery gets a fresh attempt token and retains the original turn
  deadline, consumed provider budget, tool-call set, completed results, and
  checkpoint-byte count. It may restart a provider request or continue calls
  provably unstarted. A latched call without a result is uncertain, so the turn
  terminalizes and can never enter `CanonicalHistory`. No stream, promise,
  iterator, signal, or possibly started effect is resumed.

Provider, tool, migration, and total-turn clocks are distinct. Provider/tool
success is nondeterministic and is not assumed fair; a stalled operation reaches
its finite timeout or the original turn deadline. Token and time fences discard
late completions. Provider/tool timeout terminalizes first, arms subsequent
work, and then requires isolate abort for uncancellable local/RPC work.

## Durable action vocabulary

The store's static exported vocabulary and formal model share these 16 durable
action names exactly:

1. `DurablyAdmit`
2. `BeginLegacyMigration`
3. `RetryLegacyMigration`
4. `CompleteLegacyMigration`
5. `FailLegacyMigration`
6. `StartSelectedTurn`
7. `StartNextInference`
8. `CheckpointProviderBatch`
9. `CheckpointProviderFinal`
10. `BeginEffect`
11. `RecordToolResult`
12. `RecoverFromCheckpoint`
13. `CompleteTurn`
14. `FailTurn`
15. `ExpireOperation`
16. `ReconcileCrashedTurn`

`runtime-lifecycle.ts` intentionally remains a coarse, side-effect-free
seven-action admission/ownership/terminal projection. It does not duplicate
checkpoint JSON or legacy-import state. The conformance script compares that
coarse set exactly, compares the complete static store vocabulary to the model,
and checks semantic source structure rather than relying on vocabulary alone.

## Checked properties

TLC checks:

- transport first-byte work is independent and reaches open or explicit
  timeout-close;
- legacy reads require admitted V2 work or a durable authenticated post-open
  request, use at most two fresh fences under one absolute deadline, block claim
  while unresolved, and cannot occur after a terminal marker;
- admission ids never disappear, duplicate ids never re-enter the queue, and
  queue/admission slot and byte bounds always hold;
- work implies an alarm, while a pre-arm rejected before insert may leave one
  harmless surplus alarm;
- exactly one FIFO row and fenced token own execution;
- provider batches preserve order and unique ids; results are a prefix of the
  current batch and exactly match effect-latched calls;
- next inference implies the preceding batch is closed;
- attempts are bounded by one initial token plus one recovery token; recovery
  preserves deadlines, counters, and durable results;
- uncertain effects, expiry, and exhausted/unsafe crash recovery are terminal
  and excluded from canonical future context;
- terminal migration/turn decisions are immutable, and stale-token observation
  cannot mutate status; and
- every transport, migration, provider, tool, turn, queue, checkpoint, and
  admission quantity remains finite.

Under the explicit weak-fairness boundary, TLC also checks that pending
transport decides, pending migration terminalizes, every accepted turn becomes
terminal, every active owner releases, safe crash recovery either obtains its
fresh fence or terminalizes, and every required isolate abort occurs.

Fairness covers clock ticks, transport flush/timeout, migration begin and
deadline failure, alarm selection, deadline expiry, safe recovery, crash
reconciliation, and isolate abort. It does not assume client activity, crashes,
migration success/retry, provider responses, tool results, terminal success,
ordinary provider failure, pruning, or late-result arrival. As in production,
no liveness claim survives a platform that never schedules the DO or alarm.

## Conformance seam

Run:

```bash
bun scripts/check-chat-runtime-conformance.mjs
```

Besides the exact action sets, it checks first-byte-before-scope ordering,
alarm-before-admission and alarm-before-claim, permanent tombstone counting,
FIFO selection, migration attempt/deadline/read/claim fences, checkpoint parse
and token/time fences, batch closure and result matching, latch-before-tool,
dispatch-before-provider, final-checkpoint-before-completion, one recovery with
unchanged budgets, terminal-before-isolate-abort, and read-only bounded legacy
scanning. It also rejects the deleted runtime-startup/retry axis and requires
this model to remain below the former model's 641 lines.

This structural checker and deterministic TypeScript tests narrow the refinement
gap; TLC alone is not claimed to prove the TypeScript implementation.

## Run TLC

CI pins the official TLA+ 1.7.4 tools jar (TLC 2.19) with SHA-256:

```text
936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88
```

From the repository root, download and verify the jar once:

```bash
curl -fL https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar \
  -o /tmp/tla2tools.jar
echo '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88  /tmp/tla2tools.jar' \
  | shasum -a 256 -c -
cd plans/chat-runtime-correctness/formal
sha256sum --check SHA256SUMS
```

`-lncheck final` explores the same complete unsymmetrized state graph and checks
the same temporal properties once after the graph is complete, avoiding TLC's
otherwise repeated intermediate liveness passes. Do not add `SYMMETRY` to this
combined safety/liveness run: TLC 2.19 warns that symmetry reduction may miss
liveness violations.

### Bounded exhaustive CI matrix

CI runs four unsymmetrized configurations as independent jobs. Every file lists
the same nine invariants and nine temporal properties as `ChatLifecycle.cfg`;
only the finite constants differ. Splitting independent dimensions avoids the
state explosion of multiplying three messages by two tool-call ids while still
making each important boundary reachable. A successful job exhaustively explores
its one finite graph; CI's 50-minute process deadline bounds the job and fails it
rather than treating an incomplete frontier as evidence.

| Config | Message ids | Call ids | Admission / queue | Tool / checkpoint | Boundary made reachable                             |
| ------ | ----------: | -------: | ----------------: | ----------------: | --------------------------------------------------- |
| A      |           2 |        1 |             1 / 1 |             1 / 4 | duplicate tombstone and `thread_full`               |
| B      |           2 |        1 |             2 / 2 |             1 / 4 | two admitted rows, FIFO selection, and next work    |
| C      |           1 |        2 |             1 / 1 |             2 / 6 | ordered two-call batch, exact closure, and recovery |
| D      |           2 |        1 |             2 / 1 |             1 / 4 | `queue_bound` before the lifetime cap               |

All four use a one-tick transport/provider/tool budget and a two-tick
migration/turn budget. They retain transport, migration, alarm, expiry, crash,
late-token, terminal, pruning, and abort interleavings in addition to the focus
shown above.

Run one CI instance locally with a fresh disposable state directory:

```bash
tlc_state_dir="$(mktemp -d /tmp/chat-tlc-A.XXXXXX)"
trap 'rm -rf -- "$tlc_state_dir"' EXIT
java -Xmx4g -XX:+UseParallelGC -cp /tmp/tla2tools.jar tlc2.TLC \
  -config ChatLifecycleA.cfg -workers 2 -lncheck final -checkpoint 1000 \
  -metadir "$tlc_state_dir" ChatLifecycle.tla
```

`ChatLifecycle.cfg` is a larger combined instance: three message ids, two call
ids, lifetime admission and queue caps of two, and the same finite clocks. It is
suitable for a larger local or cloud verifier, not the standard CI runner. It
does not subsume every focused boundary: config D can reject for queue capacity
before the lifetime cap, while the combined instance's two caps are equal.

```bash
java -XX:+UseParallelGC -cp /tmp/tla2tools.jar tlc2.TLC \
  -config ChatLifecycle.cfg -workers auto -lncheck final ChatLifecycle.tla
```

For a disposable large AWS host, `run-cloud-instance.sh` verifies
`SHA256SUMS` and the jar digest before execution, runs A-D in parallel with a
45-minute ceiling per process, then gives the larger combined instance at most
180 minutes. Its `EXIT` trap schedules machine shutdown after a 15-minute log
collection window. Attach an independent provider-side shutdown guard as well;
the script's process and shutdown bounds are complementary.

### Verification record

On 2026-08-30, the checked-in `SHA256SUMS` verified the current model and all
five configs, and the TLA+ 1.7.4 jar verified against the pinned digest above.
The four unsymmetrized focused configs then completed locally with
`-lncheck final`; every configured invariant and temporal property was clean,
the final state queue was zero, and TLC exited 0:

| Config | Workers | Generated |  Distinct | Queue | Depth | Elapsed |
| ------ | ------: | --------: | --------: | ----: | ----: | ------: |
| A      |       2 |   295,927 |    53,111 |     0 |    23 |   1m40s |
| B      |       6 | 8,363,179 | 1,184,087 |     0 |    32 |  25m08s |
| C      |       2 |   351,817 |    65,210 |     0 |    26 |   1m10s |
| D      |       6 | 8,330,079 | 1,179,935 |     0 |    32 |  24m53s |

A and C used the exact two-worker CI setting. B and D used six workers to
reduce local wall time; worker count changes parallel graph exploration, not the
configured state machine or checked properties. Earlier two-worker B/D sizing
runs were stopped with nonzero frontiers and are not verification evidence.

The larger `ChatLifecycle.cfg` instance was not rerun in this 2026-08-30 audit.
Its 2026-08-27 AWS result predates the current model/config checksum set, so it
must be treated as historical sizing information rather than verification of the
current model. The focused A-D matrix above is the current exhaustive record.

The model is 639 lines, below the 641-line runtime-startup/retry model it
replaced, while adding the bounded migration and checkpoint-recovery contract.

## Production bounds

Finite TLC values are exhaustive abstractions, not production settings. The
production ceilings live in `src/lib/chat-runtime-bounds.ts`:

| Resource                               |                   Production bound |
| -------------------------------------- | ---------------------------------: |
| Selected serialized payload accounting |                             48 MiB |
| Lifetime admissions                    |                              4,096 |
| Queue                                  |                    8 turns / 1 MiB |
| Retained history                       |                  128 turns / 8 MiB |
| Model context                          |                64 messages / 2 MiB |
| Reconnect snapshot source              |            50 messages / 1,536 KiB |
| SSE writers                            |                    4 per thread DO |
| Escaped SSE data frame                 |                  2 MiB minus 4 KiB |
| Undrained SSE writer queue             |                              2 MiB |
| Aggregate undrained SSE per DO         |                              8 MiB |
| Turn accepted-to-terminal              |                         20 minutes |
| Migration                              |            30 seconds / 2 attempts |
| Legacy scan                            |          32 rows/page / 4,480 rows |
| Legacy row                             |                          1,536 KiB |
| Legacy import                          |                  128 turns / 8 MiB |
| Provider call                          |                          2 minutes |
| Provider calls per turn                |                                 34 |
| Provider stream events/call            |                              8,192 |
| Tool call                              |                         10 minutes |
| Tool calls per turn                    |                                 32 |
| Nested calls inside one `js_exec`      |                                 31 |
| `js_exec` wall / loaded-worker CPU     |            10 minutes / 10 seconds |
| `js_exec` cleanup                      |                         10 seconds |
| `js_exec` scratch                      | 128 entries / 64 KiB / 1 MiB total |
| `js_exec` captured output              |                 200,000 characters |
| Analysis command                       |                          6 minutes |
| Analysis output overflow               |                              1 MiB |
| Tool source text read                  |           2 MiB / 4,096 chunks max |
| Inline image result                    |                 128 KiB base64 max |
| `tools.move`                           |   256 files / 8 MiB / 64 MiB total |
| Tool inputs/results per turn           |                      1 MiB / 1 MiB |
| Tool overflow object                   |                              2 MiB |
| Tool overflows per attempt             |                  4 objects / 4 MiB |
| Tool overflows per turn                |                  8 objects / 8 MiB |
| Overflow-reference stub                |                              4 KiB |
| Provider state per turn                |                              2 MiB |
| Checkpoint                             |                              4 MiB |
| Live presentation per turn             |          2,048 frames / 32 MiB max |
| Browser snapshot cache                 |    8 entries / 2 MiB / 8 MiB total |
| Attempts                               |             1 initial + 1 recovery |
| Turns per alarm invocation             |                                  1 |

Snapshot, context, prompt, tool-schema, and UTF-8 payload windows are
enforced in their data-plane modules and adversarial tests, including
pre-materialization stream/R2 checks, incremental line scanning, and recovered
JSON depth/entry/node validation. Complete oversized tool results use bounded,
best-effort thread-scoped R2 overflow while checkpoints retain only a reserved
reference stub. Attempt-local overflow capacity is half the two-attempt turn
ceiling. The bounded externalization wait occurs after `BeginEffect` and before
`RecordToolResult`: a crash there remains an uncertain effect and interrupts
without replay, while a late object is never checkpointed and is best-effort
deleted. The formal state abstracts that wait into the same latched interval and
keeps only bounds that affect ownership, recovery, migration, or
canonical-history safety.

The code-mode nested-call ledger covers envelope tools, raw tools, secure
`fetch`, and direct `env.AI`, `env.CAMELAI`, and `env.SCREENSHOT` methods
together: 31 nested calls (the outer `js_exec` is the turn's 32nd tool call),
1 MiB of admitted arguments, and 1 MiB of retained results per run, with a
256 KiB per-result ceiling. Secure-fetch bodies are charged as their bounded
stream chunks are retained. Direct runtime-binding results reject at that seam;
ordinary tool results alone may use the separately bounded R2 overflow path.

TLC exhaustively checked the configured finite A-D state graphs for the modeled
lifecycle semantics: ownership, fencing, migration, recovery, terminality, and
the stated safety/liveness properties under the documented weak-fairness
assumptions. It does **not** prove a refinement from TypeScript, nor model or
prove the 48 MiB selected-payload ledger.
That ledger is an implementation accounting model for named, serialized
ChatThreadDO payload windows. Deterministic phase arithmetic and adversarial
tests use explicit duplicate-copy allowances at modeled seams; object overhead,
SQLite, SDK/workerd allocations, source RPC materialization, unmodeled request
interleavings, and unrelated Durable Objects are excluded. It is not a claim
that total V8/workerd heap is at most 48 MiB.

Analysis/container bounds are implementation-tested but are not variables in
`ChatLifecycle.tla`: strict project traversal admits at most 8,192 entries,
4,096 files, 224 KiB of paths, 25 MiB per file, and 256 MiB aggregate source or
persist bytes; the manifest is capped at 512 KiB and never hashes an inadmissible
file body. Lightweight request validation precedes admission and sandbox work.
Within each independently isolated agent/app sandbox scope, one durable token
lease owns the complete lifecycle under one absolute deadline; those two scopes
may run concurrently. Write-ahead session/archive taints force confirmed reset
and exact-key archive cleanup after uncertain work, and
release/acknowledgement is owner-fenced. Commands, persistence, workdir cleanup,
session deletion, and reset fallbacks each have finite waits. The ordinary
command process group is reaped, but deliberate cross-session daemonization,
transport allocation inside the SDK before our parser, total heap, cancellation
of already-dispatched RPCs, a late unused session after non-cancelable acquisition,
and an unreferenced acknowledged archive after outer-response loss remain
outside both the model and the implementation claim.

Workspace/R2, code-mode execution, analysis, build/bundle, and direct deploy
are also outside `ChatLifecycle.tla`. Their count, byte, concurrency, and
deadline ceilings are implementation contracts covered by source conformance
checks and deterministic adversarial tests. In particular, workspace mutation
is single-flight; reads retain bounded slots through cancellation; R2 pointer
changes have durable write-ahead GC; sandbox listings are bounded at the
producer; bundle streams share one absolute deadline and require confirmed
destructive reset after abandonment; bundle reads are serial and return stable
bounded asset values; and direct deploy uses single-lane asset work plus one
attempt scope across HTTP/storage/registration awaits. A timed-out dispatched
write is terminal/unknown, while confirmed publication followed by bookkeeping
failure returns success with a warning rather than repeating publication. None
of that establishes a total V8/workerd/SDK/R2/`FormData` heap
bound. The finite 30-second workspace late-put grace also cannot prove cleanup
against an arbitrarily delayed provider commit.
