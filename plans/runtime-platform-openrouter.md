# Hosted runtime OpenRouter: platform keys

Implementation and source audit, 2026-10-23. camelRun was read at local
`origin/main`, commit `f86ddc24`; no files in that checkout were changed.
This is a code change, not a production rollout or a verification of deployed
`chiridion-prod` settings.

## Configuration and migration

Hosted routes (paid models and free-tier GPT-6 Luna) now use ordinary
`openrouter/<model>` identifiers, omitting `keyScope` and
`modelHeaders` on creation (the create API accepts strings/objects, not null).
Existing agents receive explicit `keyScope: null`, `modelHeaders: null` through
the configuration API. No gateway base URL, token, authorization header, or
`cf-aig-metadata` is sent to camelRun. Resolving a hosted runtime route no longer
requires gateway environment variables. Shared access checks, credit fallback,
org/user limits, and per-run budgets still apply. The in-DO resolver keeps its
gateway path. BYOK, custom endpoints, Bedrock, Codex, and the self-host
operator's `SELFHOST_AI_*` provider continue through their existing paths.

The `hosted` gateway provider declaration and its sync/header builders were
removed. There is no eager deletion of the remote legacy scope: deleting it
would change credentials underneath still-running agents. Its name remains
only for migration, late usage events, and browser cost redaction.

On the next **new send** through `ensureConfiguredAgent`, an existing thread
whose stored scope is `hosted` gets a configuration PATCH on the same agent ID
with `keyScope: null` and `modelHeaders: null`, before its prompt. Its history,
files, and conversation identity survive. The local row is updated after the
PATCH succeeds; failures are retried through the existing send flow. Retrying
an already-admitted request does not patch/restart that request. An in-flight
turn at deployment keeps its current runtime configuration and gateway path
until that turn finishes; simply opening a conversation does not migrate it.
Late gateway usage events remain hosted for billing. New threads, transcript
migrations and prewarms use null from creation. A fork of a legacy agent first
inherits its scope (camelRun's fork API has no scope override), then gets a
configuration PATCH before its row is claimed or it can be prompted.

Once all legacy agents have transitioned, the remote `hosted` scope and
`agent_runtime_key_scope:hosted` KV marker can be removed as operational
cleanup. This commit does not need that cleanup to route migrated agents.

## camelRun resolution and tenant settings

Checked in `origin/main`: `src/tenants.ts`, `src/accounts.ts`, `src/node.ts`,
`src/session-config.ts`, `src/client-sessions.ts`, `src/model-attempts.ts`,
`docs/guides/models-and-keys.md`, and `docs/operations/{billing,configuration}.md`.

Resolution is scope provider entry, tenant-stored provider key, tenant-file
`apiKeys`, then platform key. `node.ts`'s `scopedKey` falls back through
`accounts.providerKey` when a scope has no entry, including an absent/deleted
scope. Thus an old scoped agent could also fall back to the platform, but
patching its scope AND headers is preferable to changing shared credentials
mid-turn. A scoped gateway entry with only a base URL explicitly chooses an
empty API key, which caused the old reconciliation failure.

For Miguel to apply/verify before deploying:

- `AGENT_TENANTS_FILE` points to the runtime tenants JSON, reloaded on SIGHUP.
- Top-level `platformKeys.openrouter` must contain the intended platform key.
- `tenants["chiridion-prod"]` must be an admin tenant with `platformKeys` absent
  or true (not false). `Tenants.usesPlatformKeys` allows admin tenants by default;
  self-serve tenants instead need prepaid billing. The normal internal-product
  configuration uses `billing: "none"` (also the default), so camelRun records
  platform usage without charging runtime prepaid credit. camelAI still meters
  and charges its own customers.
- No stored OpenRouter key or `apiKeys.openrouter` should
  override that platform key. Check tenant custom providers/model endpoints
  for an OpenRouter override too.
- `tenants["chiridion-prod"].maxMonthlyCost` is the optional non-negative USD
  cap. Absent means uncapped; zero refuses model work immediately. It counts
  **all tenant model cost**, including turns/compaction on own keys, in the UTC
  month, not only platform spend. `Accounts.runLimit` checks it before starting
  or continuing model work; spend is cached for a few seconds. Choose headroom
  deliberately. Per-agent/per-run limits and throughput/concurrency limits are
  separate. No dedicated per-tenant platform-only cap was found.

The reconciler compares a dispatch key hash against the current scoped,
tenant, and platform OpenRouter keys, then queries OpenRouter's generation
endpoint. New attempts now have the real key and can match. Old attempts
recorded with an empty-key hash are not repaired by this change. Generation
IDs, provider availability, or later key rotation can still delay settlement.

## Gateway dependency inventory

Search covered tracked app/worker code, scripts, configurations and plans.
No production AI Gateway logs/GraphQL analytics reader or gateway-based cost
reconciliation job was found in this repo. External dashboards/automation are
outside this source audit.

| Dependent | Effect for runtime chats / retained behavior |
| --- | --- |
| `agent-runtime/key-scopes.ts`, `run-gates.ts`, `thread-runtime.ts`, `thread-fork.ts`, `thread-migration.ts` | Hosted gateway scope/configuration removed; migration behavior above. Org/self-host scopes retained. |
| `agent-runtime/usage.ts`, `routes/agent-runtime-events.ts` | Billing now recognizes unscoped platform usage, excluding the unscoped `chiridion` Codex endpoint, plus legacy `hosted` deliveries. Provider cost remains reported cost; catalog cost remains an estimate. |
| `identity/org/usage-controls.ts`, `identity/usage.ts`, `src/lib/usage-pricing.ts`, billing and organization-usage routes | Consume OrgDO usage rows, not gateway logs. Credits, per-user limits, and cost reports continue from runtime webhooks. This does not add a handler for later camelRun reconciliation adjustments. |
| `admin-dashboard-metrics.ts`, `admin-index-*`, admin metrics/routes | Read org/index/observability aggregates rather than gateway analytics. Continue to receive normal usage aggregation; gateway dashboard itself loses migrated chat calls. |
| `chat-thread/pi-model-config.ts`, `pi-model-resolution.ts`, `chat-thread/metadata.ts` | In-DO gateway routing and metadata retained. Hosted runtime ignores its gateway transport configuration; ordinary OpenRouter routing replaces gateway policies, caches, retries and rate limits for those calls. No app-side gateway log consumer found. |
| `ai-virtual-binding.ts`, `user-app-cost-controls*`, dispatcher | Published apps' dynamic AI routes, gateway metadata, quotas and usage controls remain unchanged, even when the app is created by a runtime chat. |
| `src/lib/auxiliary-ai.server.ts`, `chat-do.server.ts`, title/summary/icon helpers | Workers AI auxiliary generation can still use the configured gateway and attribution. Not the runtime's OpenRouter model loop. |
| `scripts/lib/eval-llm-judge.mjs`, icon-selection evaluation script | Judge/utility gateway calls unchanged. Their `cf-aig-metadata` remains. |
| `scripts/lib/eval-runtime.mjs`, `runtime-eval-harness.mjs`, fake LLM/replay | Local runtime evals no longer acquire hosted model credentials from chiridion's gateway scope. Their separate camelRun instance needs its own OpenRouter key/platform configuration. Gateway-only `.dev.vars` no longer suffices for hosted eval model calls. Offline runtime replay must likewise configure the runtime's provider; this change does not redirect remote camelRun with `TEST_LLM_REPLAY_URL`. No live eval run was requested or executed. |
| Self-host initialization/doctor/health, `infra/selfhost/ai-binding.worker.js`, self-host runtime scripts | Operator-provider org scopes and private custom endpoints retained. Self-host gateway AI binding is separate and unchanged. A self-host installation that relied on the removed shared runtime gateway scope, rather than `SELFHOST_AI_*`, needs its runtime provider configured explicitly. |
| `cf-aig-metadata` | Removed only from hosted runtime configuration. Still emitted for in-DO calls, virtual app AI and auxiliary/eval gateway calls. No in-repo reader of gateway metadata/logs was found. |

## Validation

- `bun install --frozen-lockfile`: passed (796 packages).
- `bun run test:workers -- agent-runtime-key-scopes agent-runtime-model-routes agent-runtime-usage runtime-thread-turns runtime-thread-fork thread-migration`: 6 files, 147 tests passed.
- `bun run typecheck`: passed (route type generation, main TypeScript, usage guard, Discord bridge).
- Tests include platform agent creation without gateway env, legacy in-place PATCH
  ordering, legacy fork clearing, billing and free/enterprise exemptions, plus
  existing BYOK, Bedrock, custom endpoint and self-host operator scope cases.
