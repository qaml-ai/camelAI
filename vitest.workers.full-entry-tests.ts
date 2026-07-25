// Worker test files that run against the REAL worker entry
// (workers/main/src/index.ts): those using SELF routing, the CHAT_THREAD
// binding, ChatThreadDO internals, code-mode/workflow bindings, a
// container sandbox, or living under tests/evals/ (agent evals need the
// real entry and are invoked by name from scripts/run-agent-eval.mjs).
//
// Everything else runs against workers/main/tests/slim-entry.ts, whose
// module graph excludes ChatThreadDO. workerd re-evaluates the entry
// graph in every test isolate, and ChatThreadDO's deps (agents,
// @cloudflare/ai-chat, pi-agent-core, pi-ai) cost ~9s each time.
//
// tests/worker-test-entry-classification.test.ts fails if a test needs
// the full entry but is missing here, so this list cannot silently rot.
export const FULL_ENTRY_TESTS = [
  "workers/main/tests/admin-api-thread-update.test.ts",
  "workers/main/tests/admin-mcp-oauth.test.ts",
  "workers/main/tests/chat-thread-billing-access.test.ts",
  "workers/main/tests/chat-thread-memory-telemetry.test.ts",
  "workers/main/tests/chat-thread-pi-stream-bridge.test.ts",
  "workers/main/tests/chat-thread-streaming-reply-trim.test.ts",
  "workers/main/tests/code-mode-outbound.test.ts",
  "workers/main/tests/deterministic-automation-workflow.test.ts",
  "workers/main/tests/evals/analysis-tools-reachable-live.test.ts",
  "workers/main/tests/evals/broken-app-rescue-live.test.ts",
  "workers/main/tests/evals/browser-automation-live.test.ts",
  "workers/main/tests/evals/camel-free-oracle-fix-live.test.ts",
  "workers/main/tests/evals/camel-free-oracle-live.test.ts",
  "workers/main/tests/evals/camel-free-oracle-project-start-live.test.ts",
  "workers/main/tests/evals/camel-free-oracle-trivial-live.test.ts",
  "workers/main/tests/evals/camel-free-routine-restraint-live.test.ts",
  "workers/main/tests/evals/custom-domain-live.test.ts",
  "workers/main/tests/evals/custom-prompt-live.test.ts",
  "workers/main/tests/evals/dashboard-fake-data-live.test.ts",
  "workers/main/tests/evals/data-analysis-report-live.test.ts",
  "workers/main/tests/evals/do-backed-project-deploy-live.test.ts",
  "workers/main/tests/evals/eval-criteria.test.ts",
  "workers/main/tests/evals/eval-deploy-assert.test.ts",
  "workers/main/tests/evals/eval-signal.test.ts",
  "workers/main/tests/evals/hosted-credit-camel-free-fallback-live.test.ts",
  "workers/main/tests/evals/integration-create-live.test.ts",
  "workers/main/tests/evals/integration-definition-discovery-live.test.ts",
  "workers/main/tests/evals/metrics-ground-truth-notebook-live.test.ts",
  "workers/main/tests/evals/notebook-deploy-live.test.ts",
  "workers/main/tests/evals/notebook-fix-rerun-live.test.ts",
  "workers/main/tests/evals/orders-analytics-api-live.test.ts",
  "workers/main/tests/evals/output-file-delivery-live.test.ts",
  "workers/main/tests/evals/project-eval-helpers.test.ts",
  "workers/main/tests/evals/project-revert-redeploy-live.test.ts",
  "workers/main/tests/evals/project-snapshot-revert-live.test.ts",
  "workers/main/tests/evals/project-update-redeploy-state-live.test.ts",
  "workers/main/tests/evals/project-write-file-live.test.ts",
  "workers/main/tests/evals/research-agent-live.test.ts",
  "workers/main/tests/evals/research-known-url-live.test.ts",
  "workers/main/tests/evals/scheduled-prompt-live.test.ts",
  "workers/main/tests/evals/shadcn-components-live.test.ts",
  "workers/main/tests/evals/skill-reference-read-live.test.ts",
  "workers/main/tests/evals/space-matching-game-live.test.ts",
  "workers/main/tests/evals/template-select-ai-chat-live.test.ts",
  "workers/main/tests/evals/template-select-crud-live.test.ts",
  "workers/main/tests/evals/template-select-data-analysis-live.test.ts",
  "workers/main/tests/evals/template-select-data-dashboard-live.test.ts",
  "workers/main/tests/evals/template-select-integration-dashboard-live.test.ts",
  "workers/main/tests/evals/template-select-vanilla-live.test.ts",
  "workers/main/tests/evals/vanilla-project-deploy-live.test.ts",
  "workers/main/tests/evals/warehouse-list-live.test.ts",
  "workers/main/tests/evals/workflow-live.test.ts",
  "workers/main/tests/project-build-sandbox-repro.test.ts",
  "workers/main/tests/websocket-access.test.ts",
  "workers/main/tests/workspace-cron.test.ts",];
