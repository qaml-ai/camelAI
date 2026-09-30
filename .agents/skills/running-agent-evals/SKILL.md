---
name: running-agent-evals
description: Run camelAI agent evals locally and report results to the shared viewer at evals.camelai.dev. Use when asked to run an eval, run a custom-prompt eval, check eval results/scorecards, or hit the evals API. The full, always-current reference is served by the viewer itself at GET /skill.
---

# Running agent evals

Evals **run locally in this repo** (they need Docker + a `.dev.vars`); the shared history lives at
**`https://evals.camelai.dev`** (read-only viewer + upload API, behind Cloudflare Access). The full,
always-current reference is **served by the viewer itself** at `GET /skill`.

## Run an eval

```bash
bun run test:eval <eval-id>            # ids: workers/main/tests/evals/manifest.json
bun run test:eval:dashboard            # or :deploy / :sandbox shortcuts

# custom prompt (the generic harness):
CUSTOM_EVAL_PROMPT="Build a dashboard from fake data." bun scripts/run-agent-eval.mjs custom-prompt-live
```

Knobs: `--model <id>`, `--timeout-ms <ms>`, `EVAL_REAL_DEPLOY=0/1`, `CUSTOM_EVAL_*` (see
`bun scripts/run-agent-eval.mjs --help`).
`CHIRIDION_DEV_VARS_PATH` / `.dev.vars` are read only for eval-relevant Cloudflare Access,
Cloudflare API, and judge gateway credentials/settings; ordinary eval knobs such as `EVAL_MODEL`
and `EVAL_REPORT` should be passed explicitly in the shell or CLI.

### On the local agent runtime

Every eval's thread runs on a **local agent runtime** (the hosted runtime's self-host Compose files,
`deploy/selfhost/docker-compose.yml` + `compose.dev.yml` from `qaml-ai/run`), as chiridion
threads run on the hosted one: the test calls `runRuntimeEval` (`workers/main/tests/evals/runtime-eval.ts`),
which pins the thread to the runtime, sends the prompt with `startRuntimeTurn`, polls the run's request
record until it settles, and reads the agent's history back into the result shape the graders read.
`run-agent-eval.mjs` starts the runtime when it is not up; manage it with:

```bash
node scripts/runtime-eval-harness.mjs up            # build once (from ~/agent-runtime at origin/main) and start
node scripts/runtime-eval-harness.mjs run project-write-file-live   # or a list, all, hard, standard; --down to stop after
node scripts/runtime-eval-harness.mjs list          # runnable evals
node scripts/runtime-eval-harness.mjs status
node scripts/runtime-eval-harness.mjs down [--purge]
```

- Needs Docker and a `qaml-ai/run` checkout at `~/agent-runtime` (`AGENT_RUNTIME_DIR`; its
  `AGENT_RUNTIME_REF`, default `origin/main`, is built into `chiridion-eval-agent-runtime:<sha>`
  once, and kept until `up --rebuild`), or a ready image in `AGENT_RUNTIME_IMAGE`.
- Model keys are the same as before: chiridion syncs the runtime's `hosted` key scope from the AI
  Gateway credentials in `.dev.vars` (`CF_GATEWAY_TOKEN` or `AI_GATEWAY_AUTH_TOKEN`), so the
  runtime itself holds no provider key. The runtime's tenant (`chiridion-eval`), operator token and
  secrets are generated into `.eval-runtime/` (git-ignored) and never printed.
- The runtime (host port 18790, `AGENT_RUNTIME_PORT`) reaches chiridion's tools at
  `http://host.docker.internal:18791/mcp/agent`: the **eval relay** (`scripts/lib/eval-runtime-relay.mjs`,
  `EVAL_RUNTIME_RELAY_PORT`), which each running eval serves for its org by long-polling it, since the
  vitest workers pool listens on no port. Concurrent evals (the matrix) share it.
- A model must have a runtime route: hosted OpenRouter models (`gpt-6-luna`, `sonnet`, …; the free
  tier runs as `openrouter/openai/gpt-6-luna`) or BYOK Anthropic/OpenAI/OpenRouter/Bedrock. `--model custom`
  is refused. Nobody answers a run's human input (`ask_user`, confirmations): it is declined, as the
  in-DO loop's AskUserQuestion answered with no browser attached.
- Evals whose subject the runtime lacks carry `runtimeBlocked` in the manifest and are skipped
  (`EVAL_RUN_BLOCKED=1` runs them anyway): `research-agent-live` and `research-known-url-live`
  (the Research subagent). In js_exec, chiridion's tools are `tools.camel__<name>`; the eval helpers
  accept both spellings.

When `scripts/run-eval-suite.sh` runs a list or `all`, it automatically mints one
`EVAL_BATCH_ID` and default `EVAL_BATCH_LABEL` for the whole invocation. Pre-set those env vars to
join a run into an existing dashboard batch.

Captured artifacts use `openai/gpt-5.6-luna` on the `compat` route as the primary rollout judge
when Cloudflare AI Gateway credentials are available. The judge is blind to machine verdicts and
target-model identity, grades the task rubric from rollout/final-state evidence, and writes the
authoritative result to `grading`. Machine criteria remain diagnostic evidence; true harness and
artifact-contract failures still fail the run. Set `EVAL_LLM_JUDGE=0` to use machine-check fallback,
or override with `EVAL_JUDGE_MODEL`, `EVAL_JUDGE_GATEWAY_PROVIDER`, or
`EVAL_JUDGE_REASONING_EFFORT`.

## Add or update an eval

Committed evals are listed in `workers/main/tests/evals/manifest.json`. Each entry requires
`kind`: use `unit` for a one-mechanism check and `skill` for end-to-end agent ability. Keep
scorecard budgets aligned with the dashboard weighting convention: unit evals 1-5 pts, skill evals
6-20 pts scaled to task complexity. New evals should emit a task-specific `rubric` with 3-8
criteria whose positive weights total 100, a pass threshold (normally 75), and critical criteria
where applicable. Machine pass/fail and scorecard checks are evidence, not the primary grade. Use
optional `tier: "hard"` for
high-difficulty evals and optional `realDeploy: true` when the eval requires the testing-grounds
deploy path.

Author evals with these guardrails:

- Always reach `emitEvalTranscript({...})`. Catch post-session/live-verification errors into
  diagnostic criteria and transcript details instead of throwing before emission.
- Use structured runtime evidence from `project-eval-helpers.ts`. Associate expected paths with
  the specific invocation (`toolCallReferences`), and require successful result evidence where
  outcome matters (`hasSuccessfulNotebookRun`); never hard-gate on serialized event substrings.
- Keep deterministic pass/fail checks to objective persisted state, safety boundaries, and harness
  integrity. Put semantic quality, acceptable tool strategy, and instruction-following in the
  task rubric for the primary judge; keep exact tool spellings/order and prose probes diagnostic.
- Clear seeded notebook execution state, require a successful clean `run_notebook`, and reject
  persisted error outputs. Seed data-analysis fixtures with `resetNotebookExecution: true`.
- Use `fetchJsonWithRetry`/`fetchWithRetry` for live checks. Mutations default to one attempt to
  avoid replaying a committed request after a lost response; add idempotency before explicitly
  retrying them. Isolate harness-created data with run-unique values or baseline deltas when the
  agent may have tested the API itself.

## Run a matrix

```bash
bun run test:eval:matrix -- --models sonnet,gpt-6-luna --evals do-backed-project-deploy-live --repeat 3
bun run test:eval:matrix -- --models deepseek-v4-auto --evals all --concurrency max
```

The matrix runner writes `<artifact-dir>/matrix-summary.json` with per-run status, artifact path,
report URLs, score, signal, judge agreement/usage metadata, and the shared batch id. It includes
and prints the batch dashboard URL only when `EVAL_REPORT=1`, the invocation is not a dry run, and
at least one child report was uploaded successfully. It also sets one `EVAL_BATCH_ID` and default
label for every child run; pre-set `EVAL_BATCH_ID` / `EVAL_BATCH_LABEL` to override.
`--concurrency auto` (the default) uses twice the available CPU count because evals are primarily
I/O-bound, capped by the run count and a 2 GiB-per-eval memory budget. `--concurrency max` uses
every memory-safe slot, so a 36-cell suite runs all 36 cells together on a host with at least 72 GiB
available. A numeric value requests that many slots subject only to the same run-count and memory
guards. Concurrent jobs run in waves so leaked Miniflare containers can be reaped safely between
waves; individual children set `EVAL_MANAGED_CLEANUP=1` and never sweep active siblings.

## Report the run to the shared viewer

Set `EVAL_REPORT=1` and the run's log and metadata are uploaded when it finishes; the transcript
artifact, including its scorecard, is included when the eval emitted it:

```bash
EVAL_REPORT=1 bun run test:eval <eval-id>
```

The final `POST /upload/:runId/complete` is retried up to three times with the same run id so a
transient index or canonical-write failure can finish its idempotent reconciliation.
Artifactless harness failures are still reported and ingest synthesizes an `evaluation_contract`
failure so they remain visible in the dashboard.

Auth for the upload (and for reading the API): everything on `evals.camelai.dev` is behind
Cloudflare Access. Either export a service token (`CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET`,
the `evals-ci` token in Zero Trust → Access → Service Auth), or log in once with
`cloudflared access login https://evals.camelai.dev` — the reporter picks up either automatically.

Re-report an existing artifact by hand:

```bash
node scripts/report-eval-run.mjs --eval <id> --artifact <file> \
  [--batch <id>] [--batch-label <text>] [--kind unit|skill] [--tier hard] \
  [--description <text>]
```

The extra flags map directly to `run.json`: `batchId`, `batchLabel`, `kind`, `tier`, and
`description`. The uploaded artifact is still the source of `startPrompt`.

## Read results from the CLI

```bash
curl -s https://evals.camelai.dev/api/runs?limit=20 \
  -H "cf-access-token: $(cloudflared access token -app=https://evals.camelai.dev)"
# or with a service token:
#   -H "CF-Access-Client-Id: $CF_ACCESS_CLIENT_ID" -H "CF-Access-Client-Secret: $CF_ACCESS_CLIENT_SECRET"
```

`GET /skill` documents the rest (`/api/runs/:id`, `/log`, `/artifacts`, `/artifact/:name`).
Run JSON may include `batchId`, `batchLabel`, `kind`, `tier`, `description`, `exitCode`, `error`,
`signal.violations`, and ingest-derived `startPrompt`. A failed run without a failed criterion is
shown using `run.error`, then signal violations, then a nonzero-exit fallback. The dashboard is at
`https://evals.camelai.dev/` (log in with an `@camelai.com` email) and defaults to Batches, with
Runs and Evals switcher views plus batch pages at `/batches/:id`.
