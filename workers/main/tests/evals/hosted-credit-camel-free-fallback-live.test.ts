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
import { getEvalTimeoutMs, type EvalModelEnv } from "./model-config";
import { runRuntimeEval } from "./runtime-eval";

type CreditFallbackEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as CreditFallbackEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 180_000);
const REQUESTED_MODEL = "gpt-6-sol";
const FALLBACK_MODEL = "deepseek-v4-auto";
const RUBRIC = {
  version: 1,
  objective: "Fall back a zero-credit hosted thread to Camel Free and complete the user's exact request.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    { id: "fallback_persisted", description: `The thread model changes from ${REQUESTED_MODEL} to the Camel Free model id ${FALLBACK_MODEL}.`, weight: 45, critical: true, evidenceHints: ["runtimeAssertions.persistedModel"] },
    { id: "request_completed", description: "The fallback model completes the request with exactly FALLBACK_OK.", weight: 35, critical: true, evidenceHints: ["result"] },
    { id: "clean_runtime", description: "The session completes without a terminal assistant, provider, or harness error and records runtime/final-result events.", weight: 20, critical: false, evidenceHints: ["events", "signal"] },
  ],
} as const;

describe("hosted credit Camel Free fallback agent eval", () => {
  maybeIt(
    "switches a zero-credit hosted thread to Camel Free and completes the turn",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `credit-fallback-eval-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Credit Fallback Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Credit Fallback Eval ${suffix}`,
        userId,
        { billingPlan: "payg" },
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Hosted credit fallback eval",
        userId,
        undefined,
        REQUESTED_MODEL,
      );
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Credit Fallback Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: "Reply with exactly FALLBACK_OK and nothing else.",
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 3,
          maxBadToolCalls: 0,
        }),
      );

      let persistedModel: string | null = null;
      let persistenceError: string | undefined;
      try {
        persistedModel = (await orgStub.getThread(thread.id))?.model ?? null;
      } catch (error) {
        persistenceError = error instanceof Error ? error.message : String(error);
      }
      const finalResult = result.result?.trim() ?? "";
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "thread_switched_to_camel_free",
            label: `Thread model persisted as Camel Free (${FALLBACK_MODEL})`,
            passed: persistedModel === FALLBACK_MODEL,
            reason: persistedModel === FALLBACK_MODEL
              ? undefined
              : persistenceError ?? `Persisted model was ${persistedModel ?? "missing"}.`,
            details: { requestedModel: REQUESTED_MODEL, persistedModel, persistenceError },
          }),
          passFailCriterion({
            id: "camel_free_completed_turn",
            label: "Fallback model completed the requested turn",
            passed: finalResult === "FALLBACK_OK",
            reason: finalResult === "FALLBACK_OK"
              ? undefined
              : "Final response was not exactly FALLBACK_OK.",
            details: { finalResult },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 5,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 2, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 3, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 5, maxBadToolCalls: 1, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        rubric: RUBRIC,
        evaluation,
        error: result.error,
        model: `${REQUESTED_MODEL} -> ${FALLBACK_MODEL}`,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          requestedModel: REQUESTED_MODEL,
          persistedModel,
          persistenceError,
          fallbackCompleted: finalResult === "FALLBACK_OK",
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
