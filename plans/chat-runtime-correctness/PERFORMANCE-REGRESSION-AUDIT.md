# Bounded runtime regression and complexity audit

Date: 2026-08-30

This is the release audit for the bounded chat/runtime, workspace filesystem,
analysis, build, and deploy changes. It records measured regressions, fixed
release blockers, intentional compatibility changes, and remaining risks. The
list is exhaustive for the changed surfaces reviewed here; it is not a claim
that testing can prove the absence of unknown defects or platform-level
regressions.

## Release position

The architecture is substantially better bounded, but the first implementation
did contain serious throughput and compatibility regressions. The audit found
them by comparing the branch to `origin/main`, exercising maximum-size inputs,
and counting external operations rather than relying only on happy-path tests.
No item in the first table may remain open at release.

### Code-size acceptance

There are two different answers, and conflating them would be misleading:

- The declared chat-runtime manifest is **17,989 lines versus the frozen
  28,448-line baseline**: 10,459 lines smaller (36.8%), within the 18,000 total
  and 3,000 core hard gates. The four-file lifecycle core is 2,988 / 3,000.
- This is not only a line-formatting result. The current manifest is 609,851
  bytes; the closest clean historical baseline commit is 1,121,992 bytes for
  the frozen file list (45.6% smaller). Prettier-normalizing the current files
  would produce 18,671 lines, still 34.4% below the frozen 28,448-line source,
  but above the deliberately stricter 18,000 checked-in-line gate. The gate's
  eleven-line margin is consequently brittle and dense formatting is itself a
  maintainability risk.
- The complete memory-hardening diff against `origin/main` is currently
  **11,544 net new production lines** (tests and documentation excluded). Eight
  execution/storage hotspots grew from 13,543 to 24,997 lines (+84.6%) and from
  559,499 to 871,742 bytes (+55.8%).

Therefore the narrow lifecycle replacement meets its smaller-code test, while
the broader hardening change does not. Before release, new runtime fixes must
stay inside the existing manifest gates, and the broader source growth must be
treated as explicit technical debt rather than described as globally simpler.

## Reproduced release blockers

| ID | Regression | Evidence before correction | Required/corrected state |
| --- | --- | --- | --- |
| R1 | Cumulative provider updates rescanned and reserialized the entire growing assistant payload for every provider delta. | A synthetic 8,192-event stream growing to 64 KiB took a 2,318.95 ms median on the branch versus 71.92 ms on `origin/main` (about 32x). A 2,048-event structured-content stream was about 20x slower. | Common ASCII sizing has an exact allocation-free fast path. Provider presentation normalization is coalesced to at most once per 50 ms, with end events forced. The 8,192-event burst performs one presentation normalization while terminal durable output remains exact. |
| R2 | The cumulative live-frame byte/count ceilings could permanently freeze a still-running turn. | A roughly 1 MiB cumulative trace exhausted 32 MiB after 31 frames, or about 1.55 seconds at 50 ms. The 2,048 frame count also ended at 102.4 seconds, before the 120-second provider deadline. | Large frames must be size-paced throughout a finite attempt instead of consuming the whole allowance in the opening seconds. Small text must retain near-20 Hz presentation and terminal durable reset must never be suppressed. |
| R3 | Oversized snapshot fitting repeatedly serialized nearly the whole frame while deleting one old message at a time, then repeatedly recounted the same largest string. | Up to 50 full, nearly 2 MiB serializations could occur for one durable publish (roughly 100 MiB of transient CPU scanning). The first binary-search fix still rescanned one 1.5 MiB string across as many as 50 candidates. | Prefix selection is logarithmic, the newest turn is retained, every candidate string is sized once, and exact final truncation has a maximum-work/stringify-count test. |
| R4 | Old Pi sessions that had been compacted, steered, or followed up were not reconstructed compatibly. | The simplified migrator removed the Pi compaction watermark/summary and steering/follow-up reconstruction, together with their prior tests. Compacted context could be omitted or imported in the wrong semantic shape. | Restore those semantics within the same page, row, byte, and 30-second migration ceilings; incomplete/in-flight provider work remains intentionally excluded. |
| R5 | The 201st distinct project snapshot failed permanently instead of rolling retention. | Deploy creates a source snapshot. With a 200-snapshot cap, a long-lived project became undeployable at deploy 201. No cap test covered the transition. | Retention is a rolling newest-200 window, with old blob cleanup remaining durable and bounded. |
| R6 | Snapshot restore promoted even tiny source files to R2 and read each restored object twice. | Every restored file first staged into R2 and remained R2-backed, so future reads/builds paid an R2 GET per small file. Restore also downloaded a blob for validation and again for placement. | Small files return to inline SQLite within an aggregate inline budget; staged bytes/checksum are reused once; large files remain streamed/R2-backed. |
| R7 | Snapshot deduplication re-read and hashed existing snapshot objects. | An unchanged snapshot read the live source, opened a second source GET, and then fully GET+hashed the existing content-addressed snapshot blob. | Existing immutable snapshot blobs are validated with bounded metadata/checksum operations; source streams are consumed once where the storage API permits it. |
| R8 | Ordinary workspace mutations synchronously drained the entire unrelated R2 deletion backlog. | A small write/adopt/delete/snapshot could spend two to five minutes deleting old objects or fail because one unrelated R2 delete was transiently unavailable. | Committed delete backlog is alarm-owned. Foreground operations only settle the pending-put fences necessary for their own correctness. |
| R9 | Successful R2 puts scheduled cleanup alarms twice. | A 4,096-file snapshot could trigger about 8,192 redundant alarm writes because cleanup settlement unconditionally re-armed the alarm on two success paths. | Alarm scheduling is edge-triggered/deduplicated and covered by operation-count tests. |
| R10 | Recursive workspace listing used `LIMIT/OFFSET` without the ordering index it needed. | In the final indexed 50,000-row microbenchmark, the same 391 pages took 147.9 ms with OFFSET versus 11.5 ms with keyset pagination (12.9x). Earlier unindexed synthetic runs were worse. | Production traversal uses `(parent_path,type,name,path)` / `(type,name,path)` indexes and a keyset cursor. A deterministic test asserts 391 reads and zero OFFSET fallback reads. |
| R11 | Standard deploy serialized thousands of independent asset operations, and one bounded fix accidentally serialized module reads that had been width 4. | At width 1 and 20 ms per operation, a 4,096-file fingerprint or rollback phase alone is about 82 seconds. Serial modules were up to four waves slower than `origin/main`. | Small fingerprints/rollback/asset reads use up to eight weighted lanes; modules are restored to width four and artifact-cache hashes to width sixteen. Pools stop admission on first error and drain all started operations. Maximum 8 MiB assets deliberately narrow to fingerprint width one / rollback width two; see P24. |
| R12 | Analysis became fail-fast single-flight per workspace. | The second harmless agent or app analysis request immediately failed `busy`; the regression was explicitly encoded in a test. | Each local agent/app scope now has one active operation plus two FIFO waiters for at most 30 seconds, inside the original absolute lifecycle deadline. Durable busy is polled at one-second intervals. Cross-instance amplification remains in P25. |

## Remaining performance and capacity tradeoffs

These are not hidden. They must be accepted as product limits, monitored, or
changed before release.

| ID | Potential regression / tradeoff | Impact and bound | Guard or mitigation |
| --- | --- | --- | --- |
| P1 | JSON is lexically preflighted before `JSON.parse`. | This adds a second linear pass. On a representative 144,901-byte object the local median was 0.637 ms for preflight+parse versus 0.080 ms for parse alone (about 8x, under 1 ms absolute on this machine). It prevents allocation-amplifying depth/node/string payloads from reaching the native parser. | Linear work counters and byte/node/depth limits; do not put this pass on already trusted scalar data. |
| P2 | Live presentation is coalesced. | Ordinary visible updates may arrive up to about 50 ms later, and large cumulative frames are deliberately paced more slowly to enforce finite egress. Durable completion is independent. | Forced provider boundary/end updates and durable reset; size-aware pacing tests. |
| P3 | Durable changes publish full bounded snapshots rather than durable token deltas. | One revision can serialize/send almost 2 MiB. Encoding is shared across the at-most-four writers, but network cost is still per writer. | 50-message/1.5 MiB snapshot selection, 2 MiB frame/queue caps, shared encoding, slow-writer eviction. |
| P4 | Opening an unmigrated old thread starts just-in-time migration. | The first SSE heartbeat is still enqueued before storage I/O, but background SQL scanning can contend with the first queued turn for up to the 30-second migration deadline. | 32-row pages, finite scan/byte/deadline budgets, at most two attempts, explicit failed state. |
| P5 | One alarm invocation executes at most one turn. | Queue throughput is lower and a queue of eight turns can accumulate alarm/scheduling latency. This is the simplicity and crash-fencing boundary. | Immediate re-arm, queue metrics, per-turn absolute deadlines. Do not batch without extending the formal model. |
| P6 | Provider retries are disabled and unknown effects are not automatically repeated. | Transient provider errors are more visible; a crash after an effect begins can terminalize the turn instead of transparently resuming it. | Explicit interruption/error, idempotency/effect latch, one checkpoint-only recovery. This is a correctness tradeoff, not a throughput optimization. |
| P7 | Buffered workspace reads perform metadata validation, stream consumption, and one final bounded concatenation. | More calls/copies than the former unbounded scalar read for small files. | Two buffered-read lanes, four stream lanes, 2 MiB whole-buffer ceiling; callers should stream larger files. |
| P8 | Workspace mutations are fail-fast single-flight per filesystem DO. | A second write/edit/adopt/delete/snapshot/restore can fail `EBUSY` immediately even when it targets a different path. This is less permissive and can reduce write throughput, but retains no waiter payloads and prevents mutation/GC races. | Separate read/stream lanes, retryable error surfaced to callers. A future queue must have an explicit waiter count/byte/deadline budget; none exists today. |
| P9 | Project trees, paths, files, snapshots, manifests, and delete sets now have hard ceilings. | Previously accepted huge projects can now fail explicitly. Limits also add metadata/stat queries before bytes are transferred. | Error names the exact ceiling; stream large objects; use rolling snapshot retention. |
| P10 | Content-addressed snapshots require source hashing. | New/changed R2-backed files may require a complete streaming read even when size/mtime are known. | Bounded hash lanes, immutable digest reuse, metadata-only check for existing snapshot blobs. |
| P11 | Build source collection uses four read, two hash, and at most three archive lanes. | It may be slower than unconstrained fan-out on extremely low-latency storage, but prevents thousands of simultaneous streams and connections. | Lane-count tests and all-started-operation settlement on failure. |
| P12 | Build output module/asset collection is bounded and may still be partly serial. | Latency can grow linearly with file count where ownership-safe parallel reads are not possible. Sandbox listing also starts a bounded subprocess. | 4,096 entries, per-file/aggregate byte limits, 30-second listing deadline; add lanes only where stream ownership is proven independent. |
| P13 | Deploy asset upload buckets are intentionally conservative. | Independent fingerprint/rollback work is parallelized, but platform upload remains narrow to bound multipart bodies and unknown side effects. | 16 MiB raw buckets, absolute caller deadline, one effect scope, explicit uncertainty on late completion. |
| P14 | Failure cleanup consumes reserved deadline. | Bundle collection reserves 15 seconds (including reset/cleanup); direct deploy and sandbox execution reserve their own cleanup windows. Short caller deadlines can reject before starting useful work. | Deadline planner refuses work without a viable slice; cleanup is itself time-bounded. |
| P15 | Large tool/analysis output spills to workspace/R2. | A spill adds storage I/O and can be slower than returning an in-memory string. | 256 KiB inline tool result, 1 MiB analysis spill threshold, per-attempt spill bytes/file count/deadline, small inline stub. |
| P16 | Code-mode and tool execution have finite call, CPU, wall-time, scratch, input, and result budgets. | Tool-heavy programs that formerly ran longer or retained more intermediate data now fail explicitly or spill. | 31 nested calls, 32 tool calls/turn, 10-second code CPU, 10-minute tool deadline, bounded scratch/result totals. |
| P17 | Source validation rereads executable code even for otherwise unchanged builds. | Adds linear source I/O, but prevents executing a manifest whose content changed after enumeration. | Bounded read/hash lanes and source manifest digest. |
| P18 | More implementation code can increase Worker parse/compile/cold-start cost. | The eight main workspace/analysis/code-mode/build/deploy production hotspots grew from 13,543 to 24,997 lines (+84.6%) and 559,499 to 871,742 bytes (+55.8%). Generated `js_exec` source grew from 58,926 to 83,409 bytes (+41.6%). The smaller-code acceptance criterion is not met in this area even though the core chat lifecycle source is smaller. | Track generated Worker/module bytes and cold-start timings in staging. Split generated schemas/scripts and delete duplicated adapters before calling the whole change a simplification. |
| P19 | Formal verification does not establish latency, heap size, or external-service performance. | TLC covers the finite lifecycle abstraction, not V8/R2/SQLite/Cloudflare scheduling or all workspace/build state machines. | Keep executable bound/conformance tests, operation-count tests, max-input tests, and staging telemetry; do not market TLC as a performance proof. |
| P20 | The 48 MiB chat payload envelope is accounting, not a V8 heap cap. | It deliberately excludes object headers, allocator fragmentation, SQLite pages, SDK/workerd buffers, other DOs sharing the isolate, and some transient structured-clone/platform copies. A platform eviction can still occur. | Eviction tests prove durable recovery/fencing, while conservative phase multipliers reduce risk. Production eviction/memory telemetry is still required for a stronger empirical claim. |
| P21 | Repeated checkpoint painting is cumulative. | A 32-call tool batch can rebuild a growing bounded trace after each settled result. Work is finite but can approach tens of MiB of CPU scanning even when network pacing suppresses frames. | Tool-call count/result-byte caps and presentation coalescing; profile maximum tool batches in staging and move to an internal append-only projection only if measurement justifies the extra state. |
| P22 | The live egress ceiling is larger than before. | To guarantee that a legal 1.5 MiB cumulative frame earns another slot within eight seconds for a full 20-minute turn, the logical-frame cap grew from 64 MiB / 4,096 frames to 304 MiB / 24,000 frames. Four readers can therefore consume substantially more aggregate network/encode work during an extreme long turn even though retained DO memory remains capped. | 4 MiB burst, 256 KiB/s refill, shared frame encoding, four-writer cap, and durable completion bypass. A delta protocol could reduce egress but would add protocol/replay state. |
| P23 | Snapshot restore remains serial across files. | Up to 4,096 blob GETs are opened one at a time under the five-minute operation deadline. This keeps stream ownership and memory simple but can time out on high-latency R2. | Each blob is opened only once; <=1 MiB files retain at most 16 MiB raw aggregate inline, larger/excess files stream to R2. Parallel restore would need a weighted stream lane plus atomic-staging accounting. |
| P24 | Maximum-size deploy assets are intentionally slower than `origin/main`. | Small assets retain width eight. Eight 8 MiB assets now require up to eight fingerprint waves (width one) and four rollback waves (width two), versus one unweighted width-eight wave before. Fingerprint accounting permits about 72 MiB modeled transient payload for one large file; rollback permits 16 MiB raw and excludes possible SDK copies. Assets may also be read in three logical passes (fingerprint, native upload, rollback). | This is the direct memory-for-latency tradeoff that prevents the old 8×8 MiB plus base64/WebCrypto-copy eviction pattern. Native upload buckets remain serial in both versions. |
| P25 | Analysis serialization and queueing reduce throughput and are not globally cardinality-bounded. | Same-scope work that previously used isolated concurrent trees is now one-at-a-time. One active plus two waiters is per `WorkerEntrypoint` instance, not a durable global queue; cross-isolate bursts can each poll the AnalysisSandbox DO about once per second for up to 30 seconds. | The durable lease still prevents overlap and every caller has an absolute deadline. A true global queue needs a signal-only DO wait primitive so disconnected waiters cannot orphan granted leases. |
| P26 | Analysis project transfer is still serial. | Materialization/persistence may process 4,096 files / 256 MiB sequentially inside a fixed 120-second I/O allowance. Large or high-latency projects can fail explicitly even when the command itself is fast. | Hard file/byte/deadline caps and staged cleanup prevent hangs; a future weighted transfer lane must preserve per-file stream ownership and deterministic conflict handling. |
| P27 | Workspace snapshot retention and GC move cost rather than erase it. | Evicting snapshot 201 can scan up to 199 retained manifests, each bounded to 4,096 entries / 1 MiB, to avoid deleting shared content-addressed blobs. The first old-DO list lazily creates indexes. Ordinary delete backlog drains 128 keys per alarm invocation (about 32 invocations for 4,096 keys). | All three costs are finite and foreground mutations no longer drain unrelated delete backlog. Refcounts/eager schema migration would reduce latency but add durable state and migration complexity. |
| P28 | Legacy snapshot reuse still has slow paths. | Blobs created before checksum metadata require a body GET/hash on reuse, and an R2-backed live source without a persisted checksum must still be streamed/hashed. | New blobs use exact size plus immutable SHA metadata HEAD; unchanged new snapshots need one source GET, one blob HEAD, zero blob GET/PUT, and zero alarm writes. |
| P29 | Bounded overflow cannot cancel every platform operation. | Caller deadlines return promptly, but APIs such as R2 PUT do not accept an AbortSignal. A late PUT can retain its <=2 MiB payload until the platform promise settles; late success is deleted best-effort. Successfully stored tool-result `tmp/` objects are not explicitly deleted at turn completion by this code, so retention depends on an external bucket lifecycle or later user deletion. | Per-attempt 4 MiB / four-file reservation, 15-second storage deadline, late-result fencing and delete attempt. Platform non-cancellation and temp-object retention must remain visible in operational review. |
| P30 | Client/coarse-state bounds can cause extra reloads or brief UI loss. | Snapshot cache fell from 16 MiB to 8 MiB and 5 MiB to 2 MiB per entry; reconnect clears the non-durable live overlay to avoid showing stale text. Titles, todos, and preview tabs share a 256 KiB coarse-state budget. | Durable snapshots reload on reconnect; scalar state commits increment the same revision. Users can briefly see live text disappear before the canonical reset arrives. |
| P31 | Some whole-buffer capabilities are materially smaller. | Mounted audio and code-mode R2 writes are capped at 2 MiB; secure fetch is 256 KiB/result and 1 MiB/run; scratch is JSON-only with 128 entries, 64 KiB/value, 1 MiB total. Previously accepted larger operations now reject or require a streaming/overflow path. | Exact errors and bounded alternatives; see B13-B15. |
| P32 | Generated and dense source complicates cold starts and review. | Generated `js_exec` source is 83,409 bytes / 2,047 lines versus 58,926 / 1,370 on main (+41.6% bytes, +49.4% lines). The chat manifest's checked-in line gate passes by only eleven lines and is 682 lines denser than Prettier output. | Generated-source size test (<=84 KiB), byte-based complexity evidence, and explicit hotspot list. Do not treat line compression as semantic simplification. |
| P33 | Bounded readers may preallocate or retain conservative maxima. | `readSandboxFileBytes` can preallocate its maximum when expected size is unavailable; successful fetch controllers remain retained until the attempt ends; tool results can undergo bounded serialization, telemetry sizing, cloning, and runner validation. | All maxima are finite, but staging heap/CPU telemetry is needed to validate the accounting multipliers. |
| P34 | Local build success is not a cold-start or bundle-size regression measurement. | The final build still warns about >500 KiB chunks (for example the 950.68 KiB Chat client chunk and 2.66 MiB server entry). No clean before/after staging cold-start trace was captured in this audit, and local module sizes do not include workerd compilation/cache behavior. | Treat P18/P32 source growth as an unresolved cold-start risk and measure Worker startup plus first SSE byte on a staging canary before broad rollout. |

## Intentional behavior and compatibility changes

| ID | Change | User-visible consequence |
| --- | --- | --- |
| B1 | History retains at most 128 turns / 8 MiB; provider context uses the newest 64 messages / 2 MiB; snapshots render at most 50 messages / 1.5 MiB. | Very old or very large content is omitted from active context/render snapshots. Historical rows may remain in legacy storage during rollback retention but are not permanently dual-read. |
| B2 | Migration imports a bounded recent, settled window. | In-flight provider messages and incomplete tool batches are dropped; an active turn at cutover is shown as interrupted and must be continued. |
| B3 | Old token streams and JavaScript/provider processes are not resumed. | Users keep the thread and settled context, not the exact pre-deployment execution. |
| B4 | Active steering, nested agents, and model-blocking question/connection setup are absent or constrained unless represented as their own finite durable actions. | Some old interactive workflows no longer behave identically. This was explicitly allowed by the architecture goal, but must be release-noted. |
| B5 | The queue admits at most eight turns / 1 MiB and a thread at most 4,096 admissions. | Excess sends receive a finite rejection instead of increasing DO memory/storage forever. |
| B6 | Only four SSE writers attach to one thread, each with a roughly 2 MiB queue. | A fifth simultaneous tab/client receives 429 and retries; a slow reader is disconnected after ten seconds. |
| B7 | Assistant output, live content, checkpoints, provider state, tool catalogs, inputs, results, and transfer sets all have explicit ceilings. | Oversized content is truncated, spilled, or rejected depending on whether lossless continuation is possible. |
| B8 | A provider/tool timeout aborts and discards late results. | A late successful external operation may be reported as uncertain rather than silently accepted; automatic replay is forbidden after `BeginEffect`. |
| B9 | Recursive delete/list and project snapshot/restore reject trees beyond their metadata/file/byte limits. | Extremely large existing workspaces require an offline/admin migration or smaller operations. |
| B10 | Restoring a snapshot intentionally replaces current project files. | Old R2 objects are queued for durable cleanup; cleanup may be delayed, but visible metadata cutover is atomic. |
| B11 | Direct deployment artifacts and rollback data are bounded. | A very large prior deployment may not be cacheable for automatic rollback; this is surfaced instead of retaining it unboundedly. |
| B12 | Errors and observability omit transcript bodies/tool payloads. | Diagnosis depends on ids, counts, durations, stages, and error metadata rather than replaying sensitive content from logs. |
| B13 | Mounted audio and direct code-mode R2 writes are whole-buffer limited to 2 MiB. | Larger audio/transfers must use a streaming path or are rejected; an old large audio transcription can no longer be read through this helper. |
| B14 | Secure fetch and code-mode scratch are smaller finite capabilities. | Secure fetch rejects responses above 256 KiB or a 1 MiB run total; scratch is JSON-only at 128 entries / 64 KiB each / 1 MiB total. |
| B15 | `env.AI.run({ stream: true })` is rejected inside `js_exec`. | Streaming through the generated code runner would create an untracked open stream; callers must use a bounded non-streaming result. |
| B16 | Same-scope analysis is serialized behind a short queue. | The fourth local request is rejected; a queued request can wait at most 30 seconds and can still fail busy across isolates. Agent and app scopes remain separate. |
| B17 | Client reconnect discards the current live overlay. | Uncommitted visible text/tool progress may briefly disappear; the next durable snapshot is authoritative and avoids stale overlay corruption. |
| B18 | Coarse state and browser snapshot cache are smaller. | Oversized preview/todo/title data is bounded, and switching among many large threads causes earlier cache eviction/refetch. |
| B19 | Project build/deploy inputs have explicit compatibility ceilings. | Build-source collection and output assets cap at 4,096 entries / 16 MiB aggregate / 8 MiB each; modules cap at 256 / 8 MiB; analysis caps at 4,096 / 256 MiB / 25 MiB. Workspace source-snapshot limits are separate and much larger. Exact limits vary by phase and are reported at rejection. |
| B20 | Rollback caching is deliberately partial. | Modules above 4 MiB aggregate and artifact records above 8 MiB are not retained for automatic rollback; publication can still succeed with an explicit warning. |
| B21 | Source snapshots retain the newest 200. | Creating snapshot 201 evicts the oldest manifest and schedules unreferenced blobs for bounded durable GC rather than making the project permanently undeployable. |

## Complexity hotspots encountered

Line counts are current working-branch source counts and are a rough navigation
signal, not a quality metric by themselves.

| Hotspot | Size | Why it is complex / risky |
| --- | ---: | --- |
| `code-mode-tools.ts` | ~7,173 lines | Tool registry, schemas, passthrough compatibility, analysis/build/deploy orchestration, storage overflow, connection tools, and telemetry are coupled in one module. Generated tool definitions also inflate cold source. |
| `workspace-filesystem-do.ts` | ~5,151 lines | SQLite metadata, inline/R2 placement, streaming ownership, mutation admission, write-ahead cleanup, alarms, recursive trees, source snapshots, atomic restore, and R2 garbage collection share one DO. This was the densest correctness/performance hotspot. |
| `analysis-service.ts` | ~3,534 lines | Container lifecycle, local queue plus durable lease, command deadlines, notebook validation, streaming output, serial project transfer, overflow, and cleanup interact across failure paths. |
| `direct-dispatch-deploy.ts` | ~2,661 lines | Multipart limits, deadline/effect fencing, adaptive weighted asset lanes, platform APIs, caching/rollback, R2/KV persistence, idempotency, and unknown late side effects form a multi-system transaction without a real distributed transaction. |
| `code-mode-runner.ts` | ~2,189 lines | JavaScript execution, tool proxying, scratch accounting, nested-call limits, help/schema generation, output serialization, and CPU/wall deadlines live together. |
| `analysis-sandbox.ts` | ~2,041 lines | Bounded process I/O, session ownership, stream draining, archive transfer, status polling, and forced cleanup have many race-sensitive branches. |
| `chat-thread-runtime-do.ts` | ~1,469 lines | The lifecycle is delegated, but the deployed DO still combines HTTP, alarms, compatibility metadata, preview/todo/title/admin surfaces, migration wakeups, and tool/environment wiring. |
| `durable-turn-store.ts` | ~1,422 lines | SQLite lifecycle transitions, queue/admission limits, leases/tokens, effect/checkpoint fences, snapshots, revisions, and migration cutover require transaction-level invariants. |
| `bounded-turn-runner.ts` + checkpoint/driver | ~1,522 lines | Attempt deadlines, provider ownership, BeginEffect latches, ordered tool batches, checkpoint-only recovery, late-result fencing, overflow, and final terminalization span three layers. The rules are finite but a boundary mistake can duplicate an external effect. |
| `pi-turn-adapter.ts` plus content normalization | ~1,760 lines | Provider schema sanitization, bounded context, BYOK/billing/model resolution, cumulative live presentation, tool schemas, checkpoints, and final content conversion meet here. Repeated cumulative serialization caused R1. |
| `project-worker-bundle.ts` + `project-build-source.ts` | ~2,248 lines | Sandbox enumeration, path validation, manifest rules, weighted/drained streaming reads, hashing, archive lanes, module/asset classification, and cleanup deadlines are split across two passes with duplicated limits. |
| `legacy-session-migration.ts` | ~1,095 lines | It must recognize heterogeneous legacy tables, compaction, steering/tool-batch semantics, page newest-first without loading all history, and atomically fence a live v2 runtime. Compatibility shortcuts here caused R4. |
| `chat-runtime-controller.ts` + client | ~1,757 lines | SSE backpressure, first-byte guarantee, cursors, bounded snapshots, cumulative-frame pacing, reconnect/version skew, and client caching must agree on a small protocol. |
| `utf8-byte-length.ts` and bounded JSON helpers | ~230 lines | These replace allocation-heavy native conversions with exact lexical accounting. Small mistakes multiply across every provider delta or let hostile JSON allocate before bounds are checked; correctness depends on Unicode escape/surrogate edge cases and max-work tests. |
| Analysis admission across `analysis-service.ts` / `analysis-sandbox.ts` | multiple files | The in-isolate FIFO improves ordinary overlap but the durable lease is the cross-isolate authority. Queueing, stale-owner reset, archive cleanup, and deadline ownership are distributed across two runtimes. |
| Weighted concurrency helpers | duplicated in deploy/bundle | Lane count, byte weight, stop-admission, drain-on-error, and deadline semantics are subtle and currently implemented twice. A shared helper could reduce drift only if it preserves each caller's stream/effect ownership rules. |
| Deploy side-effect scope across proxy/service/direct deploy | multiple files | Publication, OrgDO registration, usage-guard D1, KV registry, preview state, and screenshot queue are deadline-fenced but cannot form one transaction. Timeout after publication necessarily has an explicit partial/uncertain state. |
| Browser live overlay/reconnect path | client + hook + cache | Durable snapshots and best-effort cumulative live frames have different cursors and lifetimes. Reconnect must discard stale live state without erasing the last durable snapshot, and cache byte accounting must not retain live overlays. |
| Formal model/conformance manifest boundary | multiple files | TLA actions, TypeScript transition names, source manifests, executable bounds, and conformance checks can drift. Every new durable action or limit needs updates in more than one representation. |

The most important structural follow-up is to split storage mechanics from
product operations in `WorkspaceFilesystemDO`, generated schemas/catalogs from
`code-mode-tools.ts`, and transport/presentation from provider conversion. The
split must reduce executable concepts and duplicated policy, not merely move
the same branches into more files.

## Verification gates

Release verification must include all of the following after the fixes above:

1. Focused regression tests for R1-R12, including operation-count or
   concurrency assertions where wall-clock tests would be flaky.
2. Chat-runtime source-size/conformance gates (total <= 18,000 lines, core <=
   3,000 lines) and TLC checks.
3. Complete unit and Worker suites, typecheck, lint, and production build.
4. Maximum-bound tests for SSE frames/writers, migration rows/bytes/deadline,
   workspace trees/snapshots/restore, build modules/assets, direct deploy, and
   tool/analysis overflow.
5. A staging canary measuring p50/p95/p99 first SSE byte, first live content,
   turn completion, snapshot/restore, build collection, deploy, DO eviction,
   and peak memory/CPU where Cloudflare exposes it. Local synthetic timings
   cannot substitute for R2/SQLite/container/platform latency.

## Verification record

Completed on the final working tree on 2026-08-30:

- Application tests: 314 files passed / one skipped; 2,544 tests passed / six
  skipped.
- Worker tests: 162 files passed / 36 skipped; 1,900 tests passed / 43 skipped.
- Post-cleanup max-path focus: five files / 157 tests passed, covering snapshot
  fitting, Unicode byte accounting, workspace snapshots/GC, direct deploy, and
  bundle lanes.
- `typecheck`, zero-warning `lint`, production `build`, and `git diff --check`
  passed.
- Chat size passed at 17,989 / 18,000 total and 2,988 / 3,000 core.
- Conformance passed with 16 exact durable actions and all four complete-property
  TLC configs represented.
- `ChatLifecycle.tla`, configs A-D, and the pinned TLA+ 1.7.4 jar all matched
  their checked hashes. The previously recorded exhaustive A-D runs remain
  byte-for-byte applicable: 53,111; 1,184,087; 65,210; and 1,179,935 distinct
  states, each with zero final queue and exit 0. The larger combined config is
  not current verification evidence, as already stated in `formal/README.md`.

Performance evidence is deliberately split between deterministic work counts
and synthetic timings:

- An 8,192-event same-window provider burst now performs one presentation
  normalization rather than 8,192; the corresponding structured 2,048-event
  burst also performs one. Full-harness local medians were 3.67 ms / 0.40 ms
  versus 5,479 ms / 2,110 ms on `origin/main`. These are synchronous-burst
  measurements, not real-network throughput claims; the stable regression guard
  is the operation count and production presentation remains near 20 Hz.
- The 50,000-row workspace traversal benchmark improved from 147.9 ms OFFSET to
  11.5 ms keyset for the same 391 pages. The test additionally prohibits OFFSET.
- At an illustrative 20 ms per small-asset operation, width eight changes a
  4,096-file phase from about 81.9 seconds to 10.2 seconds. Maximum-size assets
  intentionally do not receive this speedup (P24).

The required staging canary in gate 5 has **not** been run for this uncommitted
working tree. Therefore the audit supports merging to a controlled canary, not
a claim that Cloudflare p99 latency or eviction rate is already empirically
better in production.
