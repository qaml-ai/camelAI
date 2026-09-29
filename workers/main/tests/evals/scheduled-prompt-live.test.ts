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

// This eval exercises the scheduled-prompt tools (create_scheduled_prompt /
// list_scheduled_prompts). Those tools live in the "schedules" category, which the lean
// tool surface (now the default) drops from the model's top-level tool list — so this
// eval also verifies the agent can still DISCOVER and use them via tools.search inside
// js_exec, the long-tail capability that had no coverage before.

type ScheduledPromptEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as ScheduledPromptEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

const SCHEDULE_NAME = "daily-standup";
const SCHEDULE_CRON = "0 9 * * *";
const SCHEDULE_PROMPT = "Reply with a one-line workspace status summary.";
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 180_000);

describe("scheduled prompt agent eval", () => {
  maybeIt(
    "asks the agent to create a scheduled prompt and verifies it persisted",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `scheduled-prompt-eval-${suffix}@example.com`,
        "password123",
        "Scheduled Prompt Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Scheduled Prompt Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Scheduled prompt eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Scheduled Prompt Eval",
        userEmail: `scheduled-prompt-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Schedule a recurring prompt for this workspace named exactly "${SCHEDULE_NAME}"`,
          `with the cron expression "${SCHEDULE_CRON}" and the prompt text`,
          `"${SCHEDULE_PROMPT}".`,
          "Once it is scheduled, reply with the schedule's name and cron expression.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 0,
        }),
      );

      // Verify the scheduled prompt actually persisted in the workspace cron DO,
      // independent of what the agent claims in its reply.
      const cronStub = testEnv.WORKSPACE_CRON.get(
        testEnv.WORKSPACE_CRON.idFromName(defaultWorkspaceId),
      );
      const prompts = await cronStub.listScheduledPrompts(defaultWorkspaceId);
      const match = prompts.find((p) => p.name === SCHEDULE_NAME);

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "schedule_persisted",
            label: "Scheduled prompt persisted",
            passed: Boolean(match),
            reason: match
              ? undefined
              : `No scheduled prompt named "${SCHEDULE_NAME}" was created.`,
            details: { scheduledPromptCount: prompts.length },
          }),
          passFailCriterion({
            id: "schedule_cron_correct",
            label: "Scheduled prompt has the requested cron expression",
            passed: match?.cron_expression === SCHEDULE_CRON,
            reason:
              match?.cron_expression === SCHEDULE_CRON
                ? undefined
                : `Expected cron "${SCHEDULE_CRON}", got "${match?.cron_expression ?? "none"}".`,
            details: { cron: match?.cron_expression ?? null },
          }),
          passFailCriterion({
            id: "schedule_prompt_exact",
            label: "Scheduled prompt text exactly matches the request",
            passed: match?.prompt === SCHEDULE_PROMPT,
            reason: match?.prompt === SCHEDULE_PROMPT
              ? undefined
              : `Expected prompt "${SCHEDULE_PROMPT}", got "${match?.prompt ?? "none"}".`,
            details: { prompt: match?.prompt ?? null },
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
              { maxAssistantTurns: 6, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 12, maxBadToolCalls: 1, points: 3 },
              { maxAssistantTurns: 18, maxBadToolCalls: 3, points: 2 },
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
          scheduledPromptCount: prompts.length,
          createdName: match?.name ?? null,
          createdCron: match?.cron_expression ?? null,
          failures: match
            ? []
            : [`no scheduled prompt named "${SCHEDULE_NAME}" was created`],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
