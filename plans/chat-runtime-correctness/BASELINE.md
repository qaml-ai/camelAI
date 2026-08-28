# Chat runtime complexity baseline

Measured 2026-08-26 from the current working tree. This is the production-runtime
line-count baseline for the chat lifecycle simplification. Tests, formal models,
plans, generated build output, and dependencies under `node_modules/` are not in
the number. New production files that replace or move any code in this manifest
**must** be added to the after-count; deleting or moving a file may not be used to
hide runtime growth.

## Hard gate

- Dirty-tree baseline: **28,448 lines**.
- Equivalent `HEAD` baseline: **28,384 lines**.
- Required post-migration runtime total: **18,000 lines or fewer**.
- Required reduction from the dirty-tree baseline: **at least 10,448 lines
  (36.7%)**, net of every new runtime reducer, store, transport, and adapter.
- At baseline, `workers/main/src/chat-thread-do.ts` was 11,843 lines; the target
  was **4,500 lines or fewer**.

The formal specification and tests are deliberately outside the runtime gate,
but they do not excuse moving runtime behavior into an uncounted production
directory. The after-count is the surviving files below plus every new
production `.ts`/`.tsx` file introduced for this migration.

The machine-enforced final manifest is
[`runtime-source-manifest.json`](./runtime-source-manifest.json), and the honest
final comparison lives in [`COMPLEXITY.md`](./COMPLEXITY.md).

The historical table below did not include the shared UI, Worker composition,
authentication, or attempt-setup roots. The post-cutover manifest
conservatively counts all of `src/components/Chat.tsx`,
`workers/main/src/helpers/auth.ts`, `workers/main/src/index.ts`,
`workers/main/src/pi-system-prompt.ts`, and
`workers/main/src/selfhost-agent-pack.ts`, because the V2 UI, dispatch,
authorization, prompt, and skill bounds now cross those files. That asymmetry
can only make the reported reduction smaller; no retroactive lines were added
to this frozen baseline.

## Dirty-tree note

The working tree was already dirty when this audit was taken. Of the production
files below, `workers/main/src/chat-thread-do.ts` differs from `HEAD`: the working
copy is 11,843 lines, while `HEAD` is 11,779. Its current diff is 75 insertions
and 11 deletions (net +64), containing the in-progress SSE-open-before-startup
change. Therefore the full manifest is 28,448 lines in the working tree and
28,384 at `HEAD`. `workers/main/tests/chat-sse-transport.test.ts` is also modified,
but tests are not included in this production-runtime baseline.

## Exact audited manifest

|      Lines | Production file                                           |
| ---------: | --------------------------------------------------------- |
|     11,843 | `workers/main/src/chat-thread-do.ts`                      |
|      1,455 | `workers/main/src/chat-thread/pi-core-store.ts`           |
|      1,171 | `src/lib/sse-agent-client.ts`                             |
|      1,043 | `workers/main/src/chat-thread/pi-tools.ts`                |
|        997 | `workers/main/src/chat-thread/derived-render-page.ts`     |
|        995 | `workers/main/src/chat-thread/pi-compaction.ts`           |
|        928 | `workers/main/src/chat-thread/ui-mirror.ts`               |
|        821 | `workers/main/src/chat-thread/pi-model-config.ts`         |
|        734 | `workers/main/src/chat-thread/pi-message-helpers.ts`      |
|        686 | `src/lib/pi-chunk-encoder.ts`                             |
|        655 | `workers/main/src/chat-thread/metadata.ts`                |
|        581 | `src/lib/ui-message-adapter.ts`                           |
|        568 | `src/lib/chat-sse-telemetry.ts`                           |
|        514 | `workers/main/src/pi-message-storage.ts`                  |
|        424 | `workers/main/src/chat-thread/streaming-activity.ts`      |
|        414 | `src/lib/derive-ui-messages-from-pi-core.ts`              |
|        400 | `src/lib/chat-render-history.ts`                          |
|        396 | `workers/main/src/chat-thread/pi-turn-journal.ts`         |
|        386 | `src/lib/use-pi-chat-stream.ts`                           |
|        385 | `workers/main/src/chat-thread/sse-connection.ts`          |
|        378 | `workers/main/src/chat-thread/types.ts`                   |
|        332 | `workers/main/src/chat-thread/pi-stream-retry.ts`         |
|        330 | `workers/main/src/chat-thread/render-archive-preserve.ts` |
|        261 | `workers/main/src/chat-thread/transcript-lake.ts`         |
|        246 | `workers/main/src/chat-thread-browser-prompts.ts`         |
|        228 | `workers/main/src/chat-thread/errors.ts`                  |
|        199 | `workers/main/src/chat-thread/verified-work-state.ts`     |
|        180 | `workers/main/src/chat-thread/preview-state.ts`           |
|        149 | `workers/main/src/chat-thread/automation-run.ts`          |
|        105 | `workers/main/src/chat-thread/code-mode-artifacts.ts`     |
|        101 | `workers/main/src/chat-thread/access.ts`                  |
|         93 | `src/lib/use-sse-agent.ts`                                |
|         89 | `workers/main/src/chat-thread/chat-memory-telemetry.ts`   |
|         84 | `workers/main/src/chat-thread/agent-eval.ts`              |
|         76 | `workers/main/src/pi-turn-journal.ts`                     |
|         76 | `workers/main/src/chat-thread/project-activity.ts`        |
|         70 | `src/lib/chat-agent-state.ts`                             |
|         55 | `workers/main/src/chat-thread/transport-headers.ts`       |
| **28,448** | **Total**                                                 |

The server files under `workers/main/src/chat-thread/*.ts` account for 11,400
lines by themselves. The audited manifest intentionally adds the DO facade,
adjacent Pi persistence/prompt helpers, and the client transport/render path so
complexity cannot merely cross the server/client boundary and disappear from
the measurement.

## Largest deletion seams

1. **Framework wake/replay and synthetic transport surgery.**
   `chat-thread-do.ts` lines 1,849-3,474 are 1,626 lines, before counting
   `sse-connection.ts` (385), `sse-agent-client.ts` (1,171),
   `chat-sse-telemetry.ts` (568), and `use-sse-agent.ts` (93). This cluster wraps
   constructor-installed `onStart`/`onMessage` hooks, replaces private stream
   readers, merges synthetic SSE connections into PartyServer connection APIs,
   and reproduces resumable-stream replay.

2. **Multiple transcript/render/replay representations.**
   The canonical `pi_core` store, ai-chat render mirror, resumable chunk store,
   derive-on-read pager, archive preservation, adapters, and main-DO glue total
   approximately 7,020 audited lines. A single canonical bounded message/draft
   store should replace this cluster.

3. **Layered turn recovery.**
   The two Pi journal files, provider retry module, recovery ladder, SDK
   `chatRecovery`, transient settled-turn retries, and their main-DO glue account
   for approximately 2,650 audited lines. The replacement should have one
   durable turn state machine and no model/tool side-effect replay after a crash.

## Recommended replacement budget

| Replacement area                                                | Maximum runtime lines |
| --------------------------------------------------------------- | --------------------: |
| `ChatThreadDO` facade, public RPC compatibility, Pi turn driver |                 4,500 |
| Pure lifecycle reducer, transition types, and budget registry   |                   650 |
| Single canonical message/turn store                             |                   600 |
| Server SSE transport and connection registry                    |                   450 |
| Client SSE transport/hook                                       |                   500 |
| Client rendering adapter and pagination helpers                 |                   350 |
| Existing adjacent feature modules retained or simplified        |                10,950 |
| **Hard maximum**                                                |            **18,000** |

The minimum product behavior to preserve is durable accept-before-ack,
idempotent client message admission, at most one active turn, an immediately
open best-effort SSE notification channel, a bounded canonical history/draft
snapshot, explicit terminal failure/interruption, and finite turn/tool/queue
budgets. Stream replay, automatic re-execution after a crash, dual render
history, recovery ladders, and exact legacy frame behavior are not part of that
minimum.
