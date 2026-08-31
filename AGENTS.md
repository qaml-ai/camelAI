# camelAI Agent Guide

Keep this file concise and durable. Add details here only when they help future agents navigate the repo or avoid common mistakes. Feature-specific behavior should usually live near the code or in tests.

## What This Is

camelAI is an AI coding assistant platform on Cloudflare Workers + Durable Objects with Cloudflare sandbox containers for builds/analysis. Users chat with persistent coding workspaces; each thread runs camelAI's pi-based coding harness in `ChatThreadDO`, and generated apps publish to `*.camelai.app` / environment-specific app hosts.

## High-Level Architecture

```text
React Router SSR + browser WS
        |
        v
Cloudflare main Worker + Durable Objects
        |
        v
Project files in WorkspaceFilesystemDO + R2 (do-r2 backend)
Builds/deploys + analysis in Cloudflare sandbox containers

Dispatcher Worker routes published user apps.
R2 stores uploads/assets/previews.
Cloudflare AI Gateway and BYOK credentials back model access.
```

Agent turns run in `ChatThreadDO` (Pi coding agent). Project source files live
in `WorkspaceFilesystemDO` + R2 (every project is `backend: "do-r2"`); builds,
deploys, and analysis run in Cloudflare sandbox containers (`ProjectBuildSandbox`,
`AnalysisSandbox`, `DbQuerySandbox`). The legacy Azure project-runtime-service VM
and its `PROJECT_RUNTIME_HOST` bridge are gone; the only remaining VM is the
static-IP database egress relay (`infra/db-egress-relay/`, see `docs/db-egress-relay.md`).
SQL queries/exports run in `DbQuerySandbox` (the `DATA_PROXY` binding is served
worker-side). There is no in-repo Go sandbox-host or data-proxy tree.

## Repository Map

- `src/` - React Router 7 app, routes, loaders/actions, UI components, shared server/client libraries.
- `src/routes.ts` - Imperative React Router route config. Add page/API routes here.
- `src/routes/api/` - React Router API routes for most user-facing REST (billing checkout, workspaces, chat groups, etc.).
- `src/components/ui/` - shadcn/ui components.
- `workers/main/` - Main Cloudflare Worker, Durable Objects, HTTP/SSE transports (plus the log-tail WebSocket `/ws/logs`), MCP, admin APIs, proxies, container image Dockerfiles.
- `workers/main/src/identity/` - `UserDO` / `OrgDO` and related identity helpers (`auth.ts` is a compatibility barrel).
- `workers/main/src/routes/` - Worker-native HTTP (SSE streams, the log-tail WebSocket `/ws/logs`, Stripe webhook, data-proxy, MCP, most `/api/admin/*` on Hono). Prefer documenting new paths here vs `src/routes/api/` — see **API routing** below.
- `workers/dispatcher/` - Workers for Platforms dispatcher for deployed user apps.
- `workers/app-usage-guard/` - Account-wide Durable Object SQLite usage monitor and reversible app quarantine Worker; see `docs/deployed-app-usage-guard-design.md`.
- `workers/bedrock-provider/` - AI Gateway custom provider translating Anthropic-style requests to Bedrock.
- `workers/user-logs-tail/` - Tail worker for deployed app logs.
- `workers/e2e-reports/` - Public viewer at `e2e-reports.camelai.dev` serving Playwright E2E reports from R2 (uploaded by the E2E workflow); deploy with `bun run deploy:e2e-reports`.
- `workers/eval-reports/` - Read-only results store + viewer for agent evals at `evals.camelai.dev` (evals run locally; `EVAL_REPORT=1` publishes them); deploy with `bun run deploy:eval-reports`.
- The Go data-proxy (external `qaml-ai/project-runtime-service` `cmd/data-proxy`) is **retired**: SQL queries and warehouse exports now run in the `DbQuerySandbox` Cloudflare container (`workers/main/src/db-query-service.ts` + `data-proxy.ts` compat surface), and the `SANDBOX_HOST` VPC binding is gone. Do not reintroduce either. Decommission checklist: `docs/db-egress-relay.md`.
- `sandbox/` - Agent skills, project scaffold templates (`create-worker/`), and the canonical `validate-notebook.py` (byte-copied into `workers/main/analysis-sandbox-assets/` for the analysis image build context). Not the agent control plane or harness — those live in `workers/main` (`chat-thread-do.ts`, Pi tools, Dockerfiles).
- `scripts/` - Deploy, eval, self-host, and maintenance scripts.
- `docs/` - Supporting documentation; see `docs/README.md` for the canonical index (many `*-plan.md` / feedback files are historical).
- `plans/` - Active cross-cutting architecture plans (e.g. OrgDO split, no-VM build/deploy).
- `infra/` - Terraform for the static-IP database egress relay VM (`infra/db-egress-relay/`); `infra/selfhost/` for self-host cloud templates. See `infra/README.md`.
- `tests/` - Vitest UI / `src/lib` unit tests (`vitest.config.ts`).
- `workers/main/tests/` - Worker / Durable Object / Miniflare tests + `evals/` (`vitest.workers.config.ts`).
- `e2e/` - Playwright end-to-end specs.
- `.agents/skills/` - Agent skills for this repo (evals and shadcn).

### API routing

Two HTTP surfaces share the main worker:

| Surface | Location | Typical contents |
| --- | --- | --- |
| React Router | `src/routes/api/` | Session-cookie user REST (workspaces, billing checkout, uploads, chat groups) |
| Worker-native | `workers/main/src/routes/` | SSE streams, log-tail WebSocket (`/ws/logs`), Stripe webhook, MCP, data-proxy, most bearer admin REST |

`workers/main/src/index.ts` routes some paths (e.g. `/api/admin/*`) to worker modules before React Router SSR. When adding an API, match an existing neighbor; do not invent a third pattern.

### Internal vs product names

Product name is **camelAI**. Internal Cloudflare resources, DO/MCP class names, headers, and Analytics Engine datasets often still use legacy internal codenames (for example the `/qaml-backdoor` superuser UI and the `*_observability_*` / `*_errors_*` dataset prefixes). Prefer the existing name in code; do not rename bindings or exported DO classes casually.

## Development Commands

Use Bun for JS commands.

```bash
bun run dev                 # React Router dev with Cloudflare bindings, default localhost:3001
bun run build               # Production React Router build
bun run typecheck           # Generate route types, then tsc
bun run lint                # ESLint
bun run test                # Vitest watch mode
bun run test:run            # Vitest run once
bun run test:workers        # Worker/Miniflare tests
bun run test:all            # Unit + worker tests
bun run test:e2e            # Playwright
```

The bundled shadcn/ui catalog served by `add_shadcn_component` and the scaffold's seeded
primitives live in `workers/main/src/shadcn-registry.generated.ts`; refresh it from the public
registry with `bun scripts/generate-shadcn-registry.mjs` (also update
`workers/main/project-build-sandbox-warmup/package.json` — `tests/project-scaffold-warmup.test.ts`
enforces the sync so the build-sandbox image keeps all installable packages in its bun cache).

Common deploy commands:

```bash
bun run deploy:main:prod
bun run deploy:main:staging
bun run deploy:dispatcher:prod
bun run deploy:dispatcher:staging
bun run deploy:dispatcher:evals       # testing-grounds dispatcher for real-deploy evals
bun run deploy:usage-guard:prod
bun run deploy:usage-guard:staging
bun run deploy:bedrock-provider:prod
```

### Real-deploy evals (testing grounds)

Agent evals deploy apps for real to a dedicated testing-grounds namespace so they are
actually usable. The eval sandbox runs inside Miniflare, so `eval-sandbox.ts` intercepts the
container's Cloudflare API traffic and forwards it to the production `proxyCloudflareApi`
in-process (identity via `trustedIdentity` from the per-container eval deploy context in
`eval-deploy-context.ts`). The deploy then publishes to the `chiridion-platform-evals`
dispatch namespace and registers in OrgDO exactly like production — so `list_apps` /
`set_preview` and `AgentEvalSessionResult.deployedApps` surface the app through the normal
app path with no eval-specific branches in `mcp-handler`/`chat-thread-do`. The testing-grounds
host comes from the eval env's `WORKER_BASE_URL` / `LOCAL_APP_VANITY_DOMAIN`
(`*.evals.camelai.app`), and virtual bindings resolve against the staging main worker
(`CF_WORKER_NAME`); these are pinned in `wrangler.test.jsonc`. Real deploy is the default for
agent eval runs whenever `CF_API_TOKEN` is set; `EVAL_REAL_DEPLOY=0` disables it (deploy evals
then skip). Served by the evals dispatcher (`workers/dispatcher/wrangler.evals.jsonc`); the
namespace + DNS routes are created out-of-band. Eval apps are kept (no cleanup). Live-data
bindings (`DATA_PROXY`/`CONNECTIONS`) won't resolve to the eval's local workspace;
self-contained apps render fully.

### Eval results viewer (`workers/eval-reports/`)

Agent evals **run locally** (they need Docker + `.dev.vars`; Miniflare spawns the eval sandbox
containers via the local Docker daemon): `bun run test:eval <id>` (or the `:dashboard` / `:deploy`
/ `:sandbox` shortcuts) wraps `scripts/run-agent-eval.mjs`; `scripts/run-eval-suite.sh` runs a
list/`all`. There is no remote runner — the retired `qaml-ai/camelai-eval-runner` VM control plane
was replaced by a shared results store + read-only viewer on Cloudflare (`workers/eval-reports/`,
`evals.camelai.dev`: Worker + R2, everything behind Cloudflare Access, no worker secrets).

Set `EVAL_REPORT=1` on a run to publish it there when it finishes: `run-agent-eval.mjs` captures
the output log and invokes `scripts/report-eval-run.mjs`, which uploads the transcript artifact +
log and posts metadata (auth via an Access service token in `CF_ACCESS_CLIENT_ID/SECRET`, or a
local `cloudflared access login`). Use the **`running-agent-evals`** skill for the run/report/read
workflows; the always-current API doc is served at `GET evals.camelai.dev/skill`. Deploy the
viewer with `bun run deploy:eval-reports`; see `workers/eval-reports/README.md`.
Suite and matrix runs share an `EVAL_BATCH_ID`, and the viewer groups those reported runs into
batches.

**Adding a new eval.** `workers/main/tests/evals/manifest.json` is the single source of truth for the
committed eval list. To add one: (1) create `workers/main/tests/evals/<id>.test.ts`, gated on
`RUN_AGENT_EVALS === "1"`, ending in `emitEvalTranscript({...})` from `./eval-transcript` (every eval
shares one transcript marker pair); (2) add a `{ "id", "description", "kind", "realDeploy"? }` entry to
`manifest.json`. It is then runnable via `bun run test:eval <id>` and included in `EVAL_TARGET=all` —
no other files to edit. `custom-prompt-live` is intentionally not in the manifest (it's the generic
`CUSTOM_EVAL_*`-driven harness). `run-agent-eval.mjs` runs exactly one eval; `run-eval-suite.sh`
iterates a comma-separated list or `all`, running each eval in turn.

**Apple Silicon: build the analysis sandbox natively.** Cloudflare publishes `cloudflare/sandbox`
images for amd64 only; under Rosetta/QEMU the Jupyter kernel never answers its handshake, so
`run_notebook` (and every notebook eval) fails on arm64 hosts. `scripts/build-analysis-sandbox-image.mjs`
builds the pinned sandbox base from source for the host arch and layers the analysis image on top;
`run-agent-eval.mjs` and `run-eval-suite.sh` invoke it automatically (it also rebuilds when the
cached image arch doesn't match the host, or when the analysis Dockerfile / baked assets under
`workers/main/analysis-sandbox-assets/` changed — a content hash is stamped on the image as a label).

**Container egress workaround (workerd#6793).** Evals run the agent in a Cloudflare Container via
`@cloudflare/vitest-pool-workers`/Miniflare. On newer hosts (Linux kernel ~6.17 / Docker 29.x) the
stock `cloudflare/proxy-everything` egress sidecar's TPROXY rules intercept docker bridge *control*
traffic, so the container never becomes ready and evals fail with `kj/timer ... operation timed out`
/ "Container failed to start". `workers/main/eval-egress-fix/` is a thin wrapper image that adds a
bridge-bypass rule; `run-eval-suite.sh` builds it and `run-agent-eval.mjs` auto-selects it via
`MINIFLARE_CONTAINER_EGRESS_IMAGE` (both no-ops where the bug doesn't trigger). Such hosts also need
the docker bridge allowed to reach the host (e.g. `ufw allow in on docker0`). Remove the wrapper
once cloudflare/workerd#6794 ships in a release.

Separately, vitest-pool-workers leaves the eval container + sidecar running after each run
(workers-sdk#14242); they accumulate and exhaust the host. `run-agent-eval.mjs` prunes leftover
`EvalSandbox` containers before/after each run. The sweep is global, so it's only safe when one
eval runs at a time (the normal local case); an orchestrator that runs evals concurrently must set
`EVAL_MANAGED_CLEANUP=1` to skip it and own cleanup itself.

## Frontend Conventions

- React Router is in framework mode. Prefer `loader`, `action`, `<Form>`, and `useFetcher` over client-only fetching in `useEffect`.
- Route definitions live in `src/routes.ts`; route modules live in `src/routes/`.
- Tailwind CSS v4 and shadcn/ui are the default UI stack.
- For UI work, use the `shadcn-components` skill and existing primitives in `src/components/ui/`.
- Use `cn()` from `@/lib/utils` for class composition.
- Use Lucide icons where appropriate.
- Keep app surfaces work-focused and dense. Avoid marketing-style pages unless the task explicitly asks for one.

## Worker And Durable Object Conventions

Important DOs and runtime classes live primarily in `workers/main/src/`:

- `identity/` (`auth.ts` barrel) - `UserDO`, `OrgDO`, and identity helpers. OrgDO domain extraction is in progress (`plans/split-auth-durable-objects.md`); prefer new org logic in `identity/org/` modules rather than growing `org-do.ts`.
- `workspace.ts` - `WorkspaceDO`, workspace metadata, integration state, token refresh alarms.
- `chat-thread-do.ts` - `ChatThreadDO` compatibility façade and chat SSE/turn orchestration (the browser bridge itself is `chat-thread/sse-connection.ts`; no WebSocket upgrade reaches this DO). Focused collaborators live in `chat-thread/` (Pi persistence, model/tool setup, UI mirroring, recovery journals, verified completion evidence, metadata, preview/access/automation, and streaming activity); verify this surface with `bun run test:workers -- chat-thread`.
- `workspace-cron.ts` - `WorkspaceCronDO`, scheduled prompt storage and dispatch.
- `worker-logs-do.ts` - `WorkerLogsDO`, deployed app log tail/streaming (in-memory ring buffer; not SQLite-persisted).
- `admin-index-do.ts` - `AdminIndexDO`, admin indexes and dashboard-style aggregates.
- `org-slug-registry.ts` - `OrgSlugDO`, atomic org slug ownership.
- `email-handle-registry.ts` - `EmailHandleDO`, email handle ownership.
- `mcp-handler.ts` - Internal MCP agent/tools.
- `*-mcp.ts` / `connections-runtime.ts` - Per-provider connection MCP wrappers and shared connection runtime (candidate for an `integrations/` folder).
- `observability.ts` - Shared Cloudflare Analytics Engine event/error writer. New structured instrumentation should go through this helper instead of calling `writeDataPoint` directly.
- `lake-streams.ts` + `chat-thread/transcript-lake.ts` - Transcript / tool-call export to Iceberg tables in R2 Data Catalog via Cloudflare Pipelines. Both bindings are optional and every helper no-ops without them, so dev/tests/self-host never export. Tool durations are measured live (Pi records no tool start timestamp) and stamped as `uiMetadata.toolDurationMs`. Design, setup commands, and the privacy posture: `config/pipelines/README.md`. Verify with `bun run test:workers -- transcript-lake`.

Durable Objects use SQLite-backed storage. Prefer:

```ts
this.ctx.storage.sql.exec("SELECT * FROM table WHERE id = ?", id);
this.ctx.storage.kv.put("key", value);
const value = this.ctx.storage.kv.get("key");
```

Do not use legacy async DO storage (`await ctx.storage.get/put`) in new code. Do not use module-level mutable `Map`, `Set`, or singleton instance caches in Worker code; isolate reuse can leak stale state across requests.

For background work in Workers, import `waitUntil` from `cloudflare:workers` and catch/log failures:

```ts
import { waitUntil } from "cloudflare:workers";

waitUntil(
  task().catch((error) => console.error("Background task failed", error)),
);
```

## Observability

- Cloudflare Workers Observability and source-map uploads are enabled in deployed Wrangler configs.
- Structured operational events go to `OBSERVABILITY_EVENTS`; structured errors are mirrored through `ERROR_ANALYTICS`. Use `recordObservabilityEvent` / `recordErrorEvent` from `workers/main/src/observability.ts` for new instrumentation.
- Keep observability payloads diagnostic but not transcript-like: include ids, counts, status, durations, routes, and error metadata; do not store chat message contents, secrets, request bodies, or auth headers. The one deliberate exception is the transcript data lake (`config/pipelines/README.md`), which exports transcript text on purpose and is governed by its own access/retention rules — it is not a licence to widen Analytics Engine payloads.
- The main app workers attach Tail Consumers to `workers/user-logs-tail/`, which forwards raw Worker trace/log/exception events into `WorkerLogsDO`.
- Production datasets are `chiridion_observability_prod` and `chiridion_errors_prod`; staging uses the corresponding `_staging` datasets. Verify bindings in the environment-specific `wrangler*.jsonc` files before changing collection paths.
- Query Analytics Engine through Cloudflare's SQL API with an account token that has Account Analytics Read. The account id is `CF_ACCOUNT_ID` in Wrangler vars. Example:

```bash
curl "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/analytics_engine/sql" \
  --header "Authorization: Bearer $CF_API_TOKEN" \
  --data "SELECT timestamp, blob1 AS event, blob3 AS component, blob5 AS status, blob9 AS thread_id, double2 AS duration_ms FROM chiridion_observability_staging WHERE timestamp > NOW() - INTERVAL '1' HOUR ORDER BY timestamp DESC LIMIT 100 FORMAT JSON"
```

- `OBSERVABILITY_EVENTS` schema: `blob1 event`, `blob2 severity`, `blob3 component`, `blob4 operation`, `blob5 status`, `blob6 route`, `blob7 method`, `blob8 path`, `blob9 threadId`, `blob10 workspaceId`, `blob11 orgId`, `blob12 userId`, `blob13 requestId`, `blob14 provider`, `blob15 model`, `blob16 errorName`, `blob17 errorMessage`, `blob18 errorStack`; `double1 timestamp_ms`, `double2 duration_ms`, `double3 status_code`, `double4 count`, `double5 size`; `index1 sample key`. A few events carry extra numeric dimensions (`extraCounts`) appended from `double6` on, so the fixed positions above never move; each such event documents its own order — `pi_context_budget` is `double6 image_count`, `double7 image_chars`, `double8 message_count`, `double9 result_bytes` (payload bytes of the view that actually shipped), with `double4` the estimated context tokens and `double5` the estimated payload bytes going in. Its `blob5 status` is one of `unchanged` / `memo_hit` / `row_hit` / `summarized` / `no_cut`; more than one `summarized` per turn is a regression, and any `no_cut` means an over-budget context shipped whole.
- `ERROR_ANALYTICS` has the error-focused subset: `blob1 event`, `blob2 component`, `blob3 operation`, `blob4 status`, `blob5 errorName`, `blob6 errorMessage`, `blob7 threadId`, `blob8 workspaceId`, `blob9 orgId`, `blob10 userId`, `blob11 requestId`, `blob12 route`, `blob13 path`, `blob14 errorStack`; doubles match the same timestamp/duration/status/count/size order.
- For aggregate counts/sums, account for sampling with `_sample_interval`, for example `SUM(_sample_interval)` instead of `COUNT()`.

## Chat And Runtime Flow

- Browser chat transport is HTTP + SSE (no WebSocket since 2026-08): the client receives frames over `GET /agents/chat-thread/:threadId/sse` (one stream per thread view, `SseAgentClient` in `src/lib/sse-agent-client.ts`) and sends RPCs/resume frames via `POST /agents/chat-thread/:threadId/call`. The legacy `/agents/chat-thread/:threadId` WebSocket upgrade and the `/ws/workspaces/:id/status` socket were REMOVED 2026-08-15 once prod telemetry showed the WS attach rate decay to ~1/day; a WebSocket upgrade to any path other than `/ws/logs` (still live — it is the `wrangler tail` endpoint handed out by the CF API proxy) now gets a plain 404 without touching authorization. A stale bundle does NOT see a terminal error from that 404 — a failed handshake surfaces as close code 1006, which every reconnecting client treats as retryable — so it reconnect-loops until the version-skew check (`src/lib/version-skew.ts`, wired app-wide by `src/hooks/use-version-skew-watch.ts`) reloads or prompts the tab; the 404 fallthrough records `ws_upgrade_route_removed` so that population is visible. Client SSE lifecycle telemetry is `chat_sse_*` / `chat_post_*` (`src/lib/chat-sse-telemetry.ts`); server auth events keep the `chat_ws_auth_completed`/`chat_ws_upgrade_rejected`/`chat_ws_upgrade_degraded` names. Workspace status streams over `GET /api/workspaces/:id/status/stream` (snapshot always first).
- The main worker validates access (`authorizeChatTransportRequest`) and routes to `ChatThreadDO`, which bridges each SSE stream into the partyserver connection model via a synthetic `SseConnection` (`workers/main/src/chat-thread/sse-connection.ts`) — the wrapped `onConnect`/`onMessage`/`onClose` chains and the resume handshake run unchanged. Design + invariants: `plans/sse-migration/DESIGN.md` (untracked, kept in the repo checkout).
- `ChatThreadDO` runs the Pi coding agent in the Durable Object. Project file operations go to `WorkspaceFilesystemDO` + R2 (`do-r2` backend); builds/deploys/analysis run in Cloudflare sandbox containers. There is no shell/`bash` tool — the agent uses the DO-backed file tools plus `deploy_project`/`add_dependency` and `js_exec`. `deploy_project` builds, publishes, returns the live URL, and opens preview; no manual `set_preview` is needed, though the tool remains available for explicit preview switches. `run_notebook` likewise opens a clean successful notebook run in preview automatically and leaves preview unchanged on failure. `dry_run: true` validates a deploy without publishing.
- Transport + render history are owned by `@cloudflare/ai-chat` (`ChatThreadDO extends AIChatAgent`). A turn is a resumable UIMessage stream: `onChatMessage` runs the Pi prompt (or the recovery/resume branch) and relays Pi runtime events through the encoder as native UIMessage chunks; `chatRecovery` owns bounded re-drives of an interrupted turn and `chatStreamStallTimeoutMs` bounds a stalled turn (its stream-cancel disposes the hung Pi session and routes the turn into recovery). `chatRecovery`'s budget is PROGRESS-GATED, so a turn that journals a checkpoint and then kills the isolate every pass renews it forever: the `piActiveTurn` marker additionally carries progress-independent re-drive counters that abandon such a turn — commit the journal tail, teardown, durable terminal — instead of resuming it. They are split by cause: `isolateDeathResumeAttempts` (`PI_TURN_RESUME_BUDGET`, charged only when nothing in-process observed the interruption), `voluntaryResumeAttempts` (`PI_TURN_VOLUNTARY_RESUME_BUDGET`, for transient-provider-retry / config-change re-drives) and a loose total (`PI_TURN_TOTAL_RESUME_BUDGET`), so ordinary deploy resets and provider 529s cannot abandon a healthy turn. The isolate-death count also picks a RECOVERY LADDER rung (`piTurnResumeRung`), each cheaper in memory than the last: deaths 1-2 resume normally, the 3rd resumes DEGRADED (eager compaction + a hard image-hydration budget, applied per provider request via `transformPiProviderContext`; the compaction is EPHEMERAL — no `pi_core_compaction` row — and floored at `PI_DEGRADED_COMPACTION_FLOOR_FRACTION` of the real threshold, so a recovery can never permanently truncate a thread), the 4th skips the provider entirely and SALVAGES the journal (settled work + an "ask me to continue" note committed as the final assistant message, turn closed out normally), and anything past that is the terminal abandonment. The client renders from `useAgentChat` (`resume: true`); no bespoke websocket transcript fan-out.
- Two message stores: **`pi_core_*`** tables are Pi's model-side transcript (authoritative for the agent and repair/eval tooling); the **ai-chat message table** is the browser render history. A high-water-mark backfill (`topUpUiMessagesFromPiCore` / `getUiMessages` RPC) mirrors new pi_core rows into render history. Same-content-same-id invariant: every pi_core row is stamped with the render message id it streams into (`uiMetadata.renderMessageId` — turnId for assistant rows, the persisted skeleton's id for user rows), so the mirror is an idempotent upsert and a whole turn folds into the one live message id. The chat-route loader calls `getUiMessages` for cold load only; live sync rides the stream + CHAT_MESSAGES broadcasts. See `docs/chat-transcript-simplification.md` for the invariants and the derive-on-read roadmap.
- Settled render history is derived AT THE STORAGE BOUNDARY (`workers/main/src/chat-thread/derived-render-page.ts`): pi_core rows are paged newest-first by `idx` (metadata first, then payloads one at a time), derived incrementally, and the walk stops once the 50-message / 4MB window is covered. On that SETTLED READ path peak memory is bounded by the page (a window admits at most `CHAT_RENDER_WINDOW_MAX_BYTES * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR` = 8MB of stored payload plus one oversized row), not by the thread. It is NOT an end-to-end O(page) claim: the compaction WRITE path (`materializeSettledRenderArchiveFromPiCore`) and the mirror rebuild (`ChatThreadUiMirror.topUpUiMessagesFromPiCore`, reachable only via `uiRender: "rebuild"` / admin resync / fork seeding) still load the whole transcript, as does the pi session's own provider context — see open_issues. It replaced a path that materialized the whole transcript plus the whole ai-chat archive table before paginating, which OOM-killed the DO on every load of a 5,232-row thread. Two invariants govern it: a page NEVER cuts a `renderMessageId` fold below the window byte ceiling (a turn is atomic for pagination); past that ceiling the window closes mid-fold, reports `foldCuts` at warn severity, and the two halves are reunited by `prependOlderRenderMessages`, which MERGES parts for a duplicate id instead of dropping the arrival, and windowed rows reconstruct their absolute position in the legacy full load, because an unstamped user row's derived id embeds it. Older-page cursors are `dp:p:<piRowIdx>` while the derived tail lasts and `dp:a:<aiChatChronologyCursor>` once a page reaches back past it — the pre-compaction archive is paged lazily from `created_at` — the seam is the MINIMUM pi timestamp in the derived window (never `messages[0]`, which after a preserve-compaction is the wall-clock-stamped "[Context Summary]" row) and archive rows are additionally filtered against the derive's ids and `role+createdAtMs` keys, because `pi_user_<ts>_<index>` ids renumber across a compaction — so an ordinary load never reads it (legacy `d:<index>` cursors are accepted and degrade to "serve the newest page"). `getDerivedUiMessagePage` is the one seam; the golden pagination-equivalence test against the old full-thread pager is `workers/main/tests/chat-thread-derive-pagination.test.ts`.
- The Pi event → UIMessage chunk encoder is `src/lib/pi-chunk-encoder.ts`; the UIMessage → legacy `Message` render adapter (both directions) is `src/lib/ui-message-adapter.ts`. Steering appends via RPC + `persistMessages`. The Agent-state payload (`src/lib/chat-agent-state.ts`, shared DO/client) now carries only coarse fields (preview, todos, title, model, terminal error) — streaming and turn duration/completion are derived from the hook + `message-metadata.pi`.
- Client seed/stream ownership seam: on a tab switch, the snapshot-derived `useAgentChat` seed EXCLUDES the mid-stream assistant message (`resolveDisplayChatData`); the resumed stream rebuilds it from scratch and Chat bridges the paint gap (`bridgedStreamingMessageId`). Don't reintroduce hydrated in-flight content into the seed — replay onto it duplicates parts (upstream `ai`/`agents` merge is replace-last-or-push).
- Thread records store provider/model state on org thread data. Verify current fields in `OrgDO` before changing related behavior.
- Slash commands are allowlisted in `ChatThreadDO`; check `SLASH_COMMANDS` before adding or changing one.
- Clarifying questions use the Pi `AskUserQuestion`/`ask_user_question` tools.

### Adding a new chat model

When adding a model from Anthropic, OpenAI, OpenRouter, or another provider,
follow the checklist at the top of `src/lib/model-catalog.ts`. The picker,
pricing, and harness routing live in separate files, and the catalog tests fail
if any of them drift apart.

## Uploads, Files, And Safety

- Chat uploads use multipart R2 upload APIs under `/api/workspaces/:id/upload`.
- Workspace file API routes live under `/api/workspaces/:id/fs/*`.
- File safety logic lives in `workers/main/src/file-safety.ts` and is applied before agent turns for suspicious uploaded-file/deploy/bridge workflows.
- The Pi system prompt is assembled in `workers/main/src/chat-thread-do.ts`; keep security-relevant prompt changes explicit and tested.

## Proxies And Bindings

- Sandbox containers do not get a generic Worker API proxy. File, shell, and runtime operations go through explicit project-runtime / host control-plane APIs.
- BYOK credentials are scoped by org/thread and should not be placed into container environment variables.
- User app deploys can rewrite internal service bindings such as the data proxy, virtual AI binding, and virtual R2 bucket. Relevant files include `workers/main/src/cf-api-proxy.ts`, `data-proxy-service.ts`, `ai-virtual-binding.ts`, and `r2-virtual-bucket.ts`.
- Outbound database traffic egresses from the sandbox host VM IP `20.46.233.68` (surfaced in direct database connection setup UIs for firewall/VPC allowlisting; constant in `src/lib/sandbox-network.ts`).
- `DbQuerySandbox` (Cloudflare sandbox container, no user code) is THE SQL query/export path — the connection MCP, the `DATA_PROXY` user-app binding, and the sandbox container routes all go through the legacy-contract surface in `workers/main/src/data-proxy.ts` → `db-query-compat.ts` → `db-query-service.ts`. It keeps the static-IP guarantee by dialing databases through a SOCKS relay on the sandbox host VM (`infra/db-egress-relay/`; design + smoke + decommission checklist in `docs/db-egress-relay.md`); with no relay configured it dials from the container's own IP. The query logic is shipped from the worker per call (not baked): the runner `workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs` is embedded through the `virtual:db-query-runner-source` alias (Vite `?raw` for the main worker, Wrangler `Text` for dispatchers) and piped into node over stdin in one stateless exec; exports write Parquet straight into the workspace's mounted warehouse R2 prefix. Keep the SSRF denylists in that runner and `infra/db-egress-relay/gost.yaml.example` in sync.

## Stripe Billing And Credits

- Org billing state lives on `org_info` JSON. Key fields include `billing_status`, Stripe customer/subscription ids, purchased credit cents, included/granted credit cents, trial credit grant metadata, and the last included-credit invoice id.
- Hosted model access is enforced in the Worker/DO inference path. Hosted `trialing` and `active` usage requires positive included/purchased credits; BYOK can be used from the free onboarding path and does not consume camelAI credits; `enterprise` bypasses Stripe subscription and credits.
- Hosted credit allowances come from `src/lib/billing-plans.ts`: Starter includes $10/month, Pro includes $40/month, and Team includes $50/month per paid seat. `BILLING_TRIAL_CREDIT_CENTS` and `BILLING_SUBSCRIPTION_INCLUDED_CREDIT_CENTS` are global emergency overrides; do not set them for normal tier-specific pricing.
- Admins can grant credits manually with `POST /api/admin/orgs/:id/credits`; credits add to `billing_credit_grant_total_cents` and can use an idempotency key.
- `STRIPE_MODE` can be set to `test` or `live`; Stripe API calls reject secret keys whose `sk_`/`rk_` prefix does not match. Staging should use `STRIPE_MODE=test`, and production should use `STRIPE_MODE=live`.
- Stripe webhooks land on `POST /api/billing/stripe/webhook`. Subscription events sync status and grant the one-time trial cap; `invoice.payment_succeeded` grants recurring included credits idempotently; credit checkout sessions increment purchased credits.
- Credit balance is purchased credits plus included/granted credits minus sandbox-host usage rows marked `credit_chargeable = 1`.

## Auth, Onboarding, And Admin

- Session/auth helpers are split between app-side loaders/actions in `src/lib/` and Worker-side helpers in `workers/main/src/helpers/`.
- Reverse-proxy identity providers (auto-login behind Cloudflare Access or Pomerium) share one engine in `workers/main/src/helpers/proxy-auth-core.ts` (JWT verify, JWKS, org mapping, revalidation); per-provider adapters are `access-session.ts` (RS256, get-identity endpoint) and `pomerium-session.ts` (ES256, inline-group claims). The registry/dispatcher is `proxy-auth-providers.ts`; app-side silent login/provisioning is `src/lib/proxy-auth.server.ts`. To add a provider, implement `ProxyAuthProvider` and register it. Tests: `tests/{pomerium,cloudflare-access}-*.test.ts`. Docs: `docs/pomerium-auth.md`, `docs/cloudflare-access-auth.md`.
- Self-host Compose uses containerized Caddy as its ingress/TLS service. Bundled Pomerium is plaintext on loopback `127.0.0.1:5444`; do not restore direct Pomerium TLS or a host-installed Caddy service. TLS modes are `automatic` (Cloudflare/Route 53 DNS validation), `external`, and `provided`.
- Self-host agent customization (additive skills + prompt append/prepend) loads from `.selfhost/agent/` at workerd-config generation; see `SELF_HOSTING.md` and `scripts/selfhost-agent-pack.mjs`. Verify with `bun run test:workers -- selfhost-agent-pack` and `bun run test:run -- selfhost-agent-pack-loader`.
- Password auth, OAuth account creation, email verification, onboarding, bans, and blocked signup policies all have tests in `workers/main/tests/`; update or add focused tests when touching these flows.
- First-touch marketing attribution and the durable first-accepted-message definition of `new_camel_activation` are documented in `MARKETING_ATTRIBUTION.md`.
- Superuser UI routes live under `/qaml-backdoor`.
- Bearer-auth admin APIs live under `/api/admin/*`; implementation is in `workers/main/src/routes/admin/` and related route modules in `src/routes/api/`.
- Admin MCP is served at `/api/admin/mcp` (`https://staging.camelai.dev/api/admin/mcp` in staging) and uses OAuth scope `admin:mcp`. Staging is also behind Cloudflare Access; pass `CF-Access-Token: $(cloudflared access token -app=https://staging.camelai.dev)` when connecting with `mcporter`. If an MCP client opens an authorize URL with `scope=openid+email+profile`, the flow will fail with `invalid_scope`; force `admin:mcp` with `oauthScope` or a pre-registered static OAuth client.
- `admin_js_exec` is the generic superuser remote Worker console for staging/production (binding RPC/fetch, Durable Objects, admin/self/outbound HTTP, assertions, and checked-in smoke suites). See `docs/admin-js-exec.md`; primitive env values and secrets are intentionally non-readable.
- A reliable staging smoke path for admin MCP is: register or provide an OAuth client for the chosen localhost callback with `scope: "admin:mcp"`, set `ACCESS_TOKEN=$(cloudflared access token -app=https://staging.camelai.dev)`, then add a private `mcporter` config entry with `baseUrl: "https://staging.camelai.dev/api/admin/mcp"`, `auth: "oauth"`, `oauthScope: "admin:mcp"`, and `headers: { "CF-Access-Token": "$env:ACCESS_TOKEN" }`. Run `npx mcporter auth <server-name>` followed by `npx mcporter list <server-name> --json`. The browser session must be a camelAI superuser, otherwise authorization fails with `Admin access required`.
- Admin and moderation flows often involve durable tombstones in KV plus destructive cleanup. Avoid changing ordering without tests.

## Integrations And Ingress

- Slack ingress starts in `workers/main/src/slack-events-queue.ts` and routes turns into `ChatThreadDO`.
- Email ingress starts in `workers/main/src/email-ingress.ts`; workspace addresses are subaddressed by org/workspace slug.
- Local Email Worker ingress can be simulated with `POST /cdn-cgi/handler/email` on the local dev server, passing `from` and `to` query params plus a raw RFC 822-style body. Real MX-routed inbound email always reaches the deployed Worker route, not localhost.
- Local outbound email uses the `send_email` binding from Wrangler config. For agent email, sender addresses must resolve to workspace email handles on `WORKSPACE_EMAIL_DOMAIN`; do not fall back to `EMAIL_FROM_ADDRESS`/`no-reply` for agent sends.
- OAuth integration code is split across `workers/main/src/services/oauth.ts`, route files, and workspace integration storage. Admin MCP OAuth is implemented separately in `workers/main/src/admin-mcp-oauth.ts`.
- Imported API definitions, typed operation policies, generic HTTP fallback, and GA4 behavior are documented in `docs/integrations-runtime.md`; use `docs/connections-improvement-guide.md` for the living UX, quality, safety, and evaluation strategy.
- Scheduled prompts are owned by `WorkspaceCronDO` and exposed through MCP tools.

## Project Runtime

- Projects are DO+R2 backed (`backend: "do-r2"`): metadata and source files live in `WorkspaceFilesystemDO` (`ProjectFilesystemClient` for per-project files), with Cloudflare Artifacts git history.
- Builds/deploys run in `ProjectBuildSandbox` (`project-build-service.ts`); notebook analysis in `AnalysisSandbox`; SQL in `DbQuerySandbox`.
- The build container sleeps when idle and takes 30-120s to wake, far longer than the deploy retry ladder. `deploy_project`/`add_dependency` therefore run `ensureBuildSandboxReady` (`project-build-readiness.ts`) before their first sandbox call — one `exec("true")` probe when warm, a budgeted re-probe loop when cold — and the existing 5-attempt ladder stays as the guard for post-readiness blips (it re-arms the gate between attempts, under one shared budget). The gate and the ladder live in `project-build-readiness.ts`; the admin `project-build-verify` route drives the same pair through `runWithProjectBuildReadiness`, so an operator repro cannot fail on a container the user-facing path would have waited for.
- The probe MUST run through the session/shell layer. A ZOMBIE container (sandbox server up, shell dead) answers `exists` while every `exec` fails `SessionTerminatedError`, so the old `exists` probe concluded "ready" instantly and the build died in ~15s of ladder. Session death is a transient readiness cause (`session_death`); after `SANDBOX_ZOMBIE_PROBE_THRESHOLD` CONSECUTIVE session-death probes the gate asks the DO to `restartZombieContainer`. The probe runs through `ProjectBuildSandbox.probeShell`, NOT `exec`, precisely so that threshold means something: `exec` self-heals on the first session death INSIDE the DO, before the rejection crosses back to the worker, which would destroy the container before the gate could count a second probe (and leave `probe_session_death` a dead telemetry dimension). `ProjectBuildSandbox`/`AnalysisSandbox` still self-heal from their own `exec` (`sandbox-zombie-recovery.ts`): the build container on the first session death (its ladder has no session recovery of its own), the analysis container on the SECOND consecutive one (`SANDBOX_ZOMBIE_EXEC_DEATH_THRESHOLD`), so `AnalysisService`'s cheap one-shot `resetSession`+retry against the still-warm container runs first and only a death that survives a fresh session handshake is treated as a zombie. The heal destroys the container so the next call boots clean; it fires ONLY on the session-death signature (never on timeouts, transports or 503s, so a healthy slow boot can never trigger it) and at most once per `SANDBOX_ZOMBIE_RESTART_COOLDOWN_MS` per container, stamped in DO storage BEFORE the destroy so a broken image cannot restart-loop. `destroy()` does not synchronously run `onStop`, so the heal notifies the DO itself (`onContainerDestroyed`) to drop mount bookkeeping and the cached session — otherwise the next run short-circuits `ensureMounted` against a container that no longer exists. A teardown that never settles is remembered per DO instance: the SDK coalesces every later `destroy()` onto that same hung promise, so the next heal evicts the instance (`ctx.abort()`) instead of waiting again. Every forced restart emits `build_sandbox_zombie_restart`; suppressed ones deliberately do not.
- `PROJECT_BUILD_COLD_START_BUDGET_MS` must stay above the sandbox SDK's own per-call retry budget (`computeRetryTimeoutMs()`, ~150s with default container timeouts) or the first probe eats the whole budget; every probe also carries its own deadline (`PROJECT_BUILD_PROBE_TIMEOUT_MS`) because capnweb calls have no client-side timeout. Re-check both when `@cloudflare/sandbox` is upgraded.
- Terminal build-container failures never wait: storage-mount (FUSE/S3FS) failures, and the SDK's permanent-startup class (`isProjectBuildPermanentStartupError`). Under `transport: "rpc"` the SDK discards the error body, so the upgrade status is the only signal — `WebSocket upgrade failed: 500` gets a few seconds, `503` gets the full cold-boot budget.
- While a cold boot is in progress the tools stream `Build environment is starting…` to the client via `ChatThreadDO.streamToolProgress` (an `item/commandExecution/outputDelta` on the parent `js_exec` call), and stamp `buildEnvironment` onto the result so the agent does not re-deploy into the same boot window.
- When a build FINISHES the tools mark the org's build session active; `ProjectBuildSandbox.onActivityExpired` then defers the idle reaper for `PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS` so a second deploy in the same chat does not pay another cold boot. Each deferral emits `build_sandbox_stop_deferred` — warm instances hold `max_instances` slots, so check that telemetry before widening the window.
- Every sandbox exec-class call is bounded CLIENT-side by `createSandboxExecDeadline` (`sandbox-exec-deadline.ts`): op-class default/max (the same constants the services forward container-side) + an op-class IO overhead + a 15s marshalling grace. That covers the whole exec-class surface, including preludes — db-query's relay-forwarder probes and mount ensures run through the same deadline, since their `timeout` is enforced container-side only. The container's own `timeout` stays primary and its error still wins inside the grace; the deadline only stops a wedged container from holding a turn to the 20-minute `PI_TURN_TOOL_HARD_TIMEOUT`. The analysis project legs size their IO overhead to the tree (`analysisProjectIoOverheadMs`) because materialize/persist is one RPC round trip per file.
- The SDK exposes no way to cancel an in-flight `exec` (the `signal` option is only checked before dispatch; `killProcess` covers `startProcess` only), so nothing is killed container-side — re-check on SDK upgrade. Two consequences are load-bearing: `deploy_project`/`add_dependency` share ONE budget across the retry ladder and an EXHAUSTED budget is terminal (`run` refuses to dispatch rather than starting a build it would abandon into the same per-project workdir; the ladder stops on it), and cold-boot waits and backoff sleeps are charged OUTSIDE that budget via `deadline.excluding` so a container wake cannot eat the build's own time.
- Stop interrupts a RUNNING tool: `requestStop` → `piSession.abort()` → the tool's abort signal, which `pi-tools` passes INTO `keepPiTurnToolProgressAliveWhile`. The wrapper rejects with `Operation aborted` and releases the heartbeat immediately rather than waiting for the abandoned RPC (which keeps running until its own deadline).
- Code-mode tool failures are recorded at the `callToolEnvelope` seam as `code_mode_project_tool_call_failed`, for BOTH surfaces: a throw, and an operational failure returned as a value (`{ success: false }` / `{ ok: false }`). The `provider` column carries `throw`/`value`. Value-shaped failures used to be invisible — a gated deploy failing every attempt showed nothing in telemetry. Two value shapes are deliberately NOT failures (`toolValueFailureMessage`): a SHELL OUTCOME (`exitCode`/`stdout`/`stderr` present — `analysis_exec`/`run_code`/`run_notebook`/`add_python_dependency` set `ok:false` for any non-zero exit of user code, whose `error` field is the container's raw stderr and must never reach ERROR_ANALYTICS), and a `cancelled: true` user-declined confirmation. Events are deduped on tool+message and capped per binding instance (`CODE_MODE_TOOL_FAILURE_EVENT_BUDGET`); the value-path message is bounded (`CODE_MODE_VALUE_FAILURE_MESSAGE_MAX`) so it cannot inflate that key, and carries no fabricated stack. Arguments and program output are never logged.
- A container OOM/restart kills the analysis container's persistent shell; `AnalysisService.withSessionRecovery` classifies the SDK's session/process-death family, calls `AnalysisSandbox.resetSession()`, and retries at most once — and ONLY when the death happened BEFORE the agent's command was dispatched (the `AnalysisCommandDispatch` marker each run flips right before `sandbox.exec`). A death from the dispatch onward is reported, never re-executed: the command may have run, and its external effects outlive the shell. `add_dependency` opts back in via `retryAfterDispatch` because `uv add` converges. A retry that succeeds stamps `sessionRecovered` on the result so it is never silent; a second death returns `ANALYSIS_SESSION_RESTARTED_MESSAGE` — an SDK error name must never reach a user. Both attempts emit `sandbox_session_terminated`. `runCode`'s result-shaped death is keyed on a structured `sessionDeath` marker, never on program stderr.
- Subagent tools (`Agent`/`Explore`/`Research`/`Oracle`) get `PI_SUBAGENT_ABORT_GRACE_MS` in `keepPiTurnToolProgressAliveWhile`: they CAN cancel, and `child.prompt()` returns the accumulated answer after `child.abort()`, so a stop keeps that work instead of persisting an empty `Operation aborted` result. Sandbox-backed tools keep zero grace.
- `AnalysisSandbox`/`DbQuerySandbox` clear their `mountedPaths`/`mountGates` in `onStop`. A container stop fires `onStop` on the SURVIVING DO instance, so without it the subclass bookkeeping outlives the mounts and `ensureMounted` no-ops against a fresh container (a run then reads an empty `/exports` and exits 0).
- The legacy Azure `project-runtime-service` VM, its `PROJECT_RUNTIME_HOST` bridge, the VM `bash`/`vm_exec`/`clone_project` tools, and all their deploy/dev/migration scripts have been removed. The only remaining VM is the static-IP database egress relay (`infra/db-egress-relay/`). Do not reintroduce a project VM runtime.

## Testing Guidance

- Place tests next to the surface they cover:
  - `tests/` — React Router UI, `src/lib`, and other non-worker unit tests (`bun run test` / `test:run`).
  - `workers/main/tests/` — Worker, Durable Object, and Miniflare tests (`bun run test:workers`). Agent evals live in `workers/main/tests/evals/`.
  - `e2e/` — Playwright (`bun run test:e2e`).
- For UI route/component changes, run at least `bun run typecheck` and the most relevant Vitest test(s).
- For Worker/DO behavior, prefer focused `bun run test:workers -- <test-file>` or `bun run test:workers` when the surface is shared.
- For changes crossing browser chat, worker routing, and project runtime behavior, test the smallest representative path plus typecheck.
- Add tests when changing auth, billing/usage, admin purge/ban behavior, proxy auth, file safety, or persistence semantics.
- `sandbox/validate-notebook.py` is canonical; `workers/main/analysis-sandbox-assets/validate-notebook.py` must stay byte-identical (`tests/analysis-sandbox-asset-drift.test.ts`).

## Error Handling Culture

- Prefer failing loudly and early over silently swallowing errors or falling back to unclear behavior. Hidden failures make production bugs much harder to debug.
- Only add fallbacks when they preserve a clearly defined user experience and still expose enough signal through errors, logs, or tests to diagnose the original failure.
- Do not convert unexpected persistence, auth, upload, billing, or runtime/tool failures into empty data unless the caller explicitly treats "not found" as a valid state.

## Local Environment Notes

Minimal prerequisites: Node.js 22+, Bun, Tailscale, and Cloudflare credentials for deployed/bound services.

Common local secret/config files:

- `.dev.vars` for Worker/dev secrets.
- `wrangler*.jsonc` for environment-specific Cloudflare config.
Useful local variables include `CF_GATEWAY_TOKEN`, OAuth client IDs/secrets, `INTEGRATION_SECRET_KEY`, `TOKEN_SIGNING_SECRET`, and email provider settings.


### SSH to shared hosts

Use Tailscale SSH as user `chiridion`; do not rely on shared private keys for normal access:

```bash
tailscale ssh chiridion@chiridion-sandbox-staging
tailscale ssh chiridion@chiridion-sandbox-prod
```

Tailscale host IPs are staging `100.115.221.105` and prod `100.112.135.2`. Public SSH ingress should remain closed except temporary break-glass access.

## Maintenance Rules

- Keep this guide short. Prefer pointers to files and tests over duplicating implementation details.
- When adding a major subsystem, add a short map entry and the canonical test command.
- When removing or renaming a subsystem, update this file in the same change.
- If a detail is likely to drift quickly, document where to verify it instead of freezing it here.

## Cursor Cloud specific instructions

Durable, non-obvious notes for running this repo inside a Cursor Cloud VM (no Cloudflare account/credentials available). Standard commands live in the `README.md` / `package.json` tables above — this section only captures the gotchas.

- **Run fully offline with `E2E_LOCAL=1`.** The default `bun run dev` marks several bindings `remote: true` (`AI`, `R2_BUCKET`, `R2_OUTPUTS_BUCKET`, `ARTIFACTS`, `BROWSER`, `send_email`) and expects a Cloudflare login. Setting `E2E_LOCAL=1` forces every binding into local Miniflare and disables sandbox containers (see `vite.config.ts`), so no Cloudflare creds and no Docker are needed for the web app. Use `E2E_LOCAL=1 bun run dev:local-auth` (auto-seeds a `Local Dev` user/org/workspace and auto-logs-in; localhost-only) → app on `http://localhost:3001`.
- **`.dev.vars` is required to boot** and must contain non-empty `TOKEN_SIGNING_SECRET` and `INTEGRATION_SECRET_KEY` (random values are fine — copy `.dev.vars.example`). It is gitignored; the setup step already created one in the snapshot, so it normally persists across sessions. Recreate it if missing.
- **Exercising a real chat turn offline (no model creds):** run the deterministic fake LLM `node scripts/fake-llm.mjs` (port `8788`) and start the dev server with `TEST_LLM_REPLAY_URL=http://localhost:8788` so `resolvePiModel` routes model calls to it. The fake echoes text after `Reply with:` (prefixed `[fake-llm] `). Full hello-world command:
  ```bash
  TEST_LLM_REPLAY_URL=http://localhost:8788 E2E_LOCAL=1 bun run dev:local-auth
  ```
- **Local Playwright E2E:** `E2E_LOCAL=1 bun run test:e2e` reuses an already-running `:3001` dev server (and `:8788` fake LLM) via `reuseExistingServer`; if you want Playwright to own both, stop your manual servers first. Chromium + system deps are already installed in the snapshot (`bunx playwright install --with-deps chromium` to refresh). The two `connections-local` specs can flake against a live Vite dev server (dialog open timing); the app page itself loads fine.
- **CI does not gate `typecheck` or `lint`** (`.github/workflows/ci.yml` runs only `test:run`, `test:workers`, and self-host checks). As a result `bun run typecheck` and `bun run lint` currently report pre-existing failures on `main` (e.g. `tests/container-sizing.test.ts` TS5097; a `no-unused-vars` warning in `chat-thread-do.ts`) that are unrelated to environment setup — do not treat them as regressions you introduced.
- **Bun** is installed at `~/.bun/bin/bun` and symlinked to `/usr/local/bin/bun` so it resolves in non-login shells (the update script's `bun install --frozen-lockfile` depends on this).
