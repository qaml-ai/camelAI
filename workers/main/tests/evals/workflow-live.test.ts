import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
  passFailCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";
import type { WorkspaceCronDO } from "../../src/workspace-cron";
import { runRuntimeEval } from "./runtime-eval";

// This eval exercises the workflow tools (validate_workflow / create_workflow /
// list_workflows). Those tools live in the "workflows" category, which the lean tool
// surface (now the default) drops from the model's top-level tool list — so this eval
// also verifies the agent can still DISCOVER and use them via tools.search inside
// js_exec, the long-tail capability that had no coverage before. Authoring a valid
// WorkflowEntrypoint module is part of the test (the agent should validate first).

type WorkflowEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as WorkflowEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

const WORKFLOW_NAME = "hourly-heartbeat";
const WORKFLOW_CRON = "0 * * * *";
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);

describe("workflow agent eval", () => {
  maybeIt(
    "asks the agent to create a deterministic workflow and verifies it persisted",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `workflow-eval-${suffix}@example.com`,
        "password123",
        "Workflow Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Workflow Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Workflow eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Workflow Eval",
        userEmail: `workflow-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Create a workflow for this workspace named exactly "${WORKFLOW_NAME}"`,
          `with the cron expression "${WORKFLOW_CRON}" and a short description.`,
          "The workflow source must export `class AutomationWorkflow extends WorkflowEntrypoint`",
          "and may import ONLY from `cloudflare:workers`; it can run a single step that returns the string \"ok\".",
          "Validate the source first, then create the workflow, and reply with the workflow name once it is created.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          // Authoring + validating a workflow module legitimately takes a few turns,
          // and a validate/fix cycle may surface one failed call.
          maxAssistantTurns: 12,
          maxBadToolCalls: 2,
        }),
      );

      // Verify the workflow actually persisted in the workspace cron DO.
      const cronStub = testEnv.WORKSPACE_CRON.get(
        testEnv.WORKSPACE_CRON.idFromName(defaultWorkspaceId),
      );
      const workflows = await cronStub.listDeterministicAutomations(defaultWorkspaceId);
      const match = workflows.find((w) => w.name === WORKFLOW_NAME);

      const workflowSource = match?.source ?? "";
      const importSpecifiers = [
        ...workflowSource.matchAll(/\bfrom\s+["']([^"']+)["']/g),
        ...workflowSource.matchAll(/\bimport\s+["']([^"']+)["']/g),
      ].map((match) => match[1]);
      const importsOnlyCloudflareWorkers = importSpecifiers.length > 0 &&
        importSpecifiers.every((specifier) => specifier === "cloudflare:workers");
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "workflow_persisted",
            label: "Workflow persisted",
            passed: Boolean(match),
            reason: match
              ? undefined
              : `No workflow named "${WORKFLOW_NAME}" was created.`,
            details: { workflowCount: workflows.length },
          }),
          passFailCriterion({
            id: "workflow_cron_correct",
            label: "Workflow has the requested cron expression",
            passed: match?.cron_expression === WORKFLOW_CRON,
            reason:
              match?.cron_expression === WORKFLOW_CRON
                ? undefined
                : `Expected cron "${WORKFLOW_CRON}", got "${match?.cron_expression ?? "none"}".`,
            details: { cron: match?.cron_expression ?? null },
          }),
          passFailCriterion({
            id: "workflow_source_has_entrypoint",
            label: "Workflow source is a real WorkflowEntrypoint module",
            passed: /class\s+AutomationWorkflow\s+extends\s+WorkflowEntrypoint/.test(workflowSource),
            reason: /class\s+AutomationWorkflow\s+extends\s+WorkflowEntrypoint/.test(workflowSource)
              ? undefined
              : "Persisted workflow source did not define AutomationWorkflow extending WorkflowEntrypoint.",
            details: { source: workflowSource },
          }),
          passFailCriterion({
            id: "imports_only_cloudflare_workers",
            label: "Workflow imports only cloudflare:workers",
            passed: importsOnlyCloudflareWorkers,
            reason: importsOnlyCloudflareWorkers
              ? undefined
              : `Expected only cloudflare:workers imports, got ${importSpecifiers.join(", ") || "none"}.`,
            details: { importSpecifiers },
          }),
          passFailCriterion({
            id: "workflow_description_nonempty",
            label: "Workflow has a non-empty description",
            passed: (match?.description ?? "").length > 0,
            reason:
              (match?.description ?? "").length > 0
                ? undefined
                : "Persisted workflow had an empty description.",
          }),
          passFailCriterion({
            id: "produced_token_usage",
            label: "Agent produced token usage",
            passed: signal.tokenUsage.totalTokens > 0,
            reason:
              signal.tokenUsage.totalTokens > 0
                ? undefined
                : "Signal reported zero total tokens.",
            details: { totalTokens: signal.tokenUsage.totalTokens },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 12, maxBadToolCalls: 2, points: 4 },
              { maxAssistantTurns: 24, maxBadToolCalls: 3, points: 3 },
              { maxAssistantTurns: 36, maxBadToolCalls: 5, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          workflowCount: workflows.length,
          createdName: match?.name ?? null,
          createdCron: match?.cron_expression ?? null,
          sourceHasEntrypoint: match
            ? match.source.includes("WorkflowEntrypoint")
            : false,
          failures: match
            ? []
            : [`no workflow named "${WORKFLOW_NAME}" was created`],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
