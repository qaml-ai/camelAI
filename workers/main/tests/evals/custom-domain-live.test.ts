import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { createOrg, createUser, type TestEnv } from "../test-helpers";
import {
  assertPassFailCriteria,
  buildEvalCriteriaSummary,
  buildNoAssistantErrorCriterion,
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildHarnessIntegrityCriterion,
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
import { succeededWithTool, usedTool } from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

// This eval exercises the custom-domain tools (get_custom_domain). Those tools live in
// the "domains" category, which the lean tool surface (now the default) drops from the
// model's top-level tool list — so this eval verifies the agent can still DISCOVER and
// invoke them via tools.search inside js_exec. get_custom_domain is a workspace-level
// read (no args, no network when there are no deployed apps), so it is deterministic:
// the discriminating signal is whether the agent found and called the dropped tool.

type CustomDomainEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as CustomDomainEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 150_000);

describe("custom domain agent eval", () => {
  maybeIt(
    "asks the agent to report custom domain diagnostics, verifying tool discovery",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `custom-domain-eval-${suffix}@example.com`,
        "password123",
        "Custom Domain Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Custom Domain Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Custom domain eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Custom Domain Eval",
        userEmail: `custom-domain-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "Check whether any of this workspace's deployed apps have a custom domain configured,",
          "and report the custom domain diagnostics for the workspace.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 1,
        }),
      );

      // succeededWithTool, not usedTool: this eval exists to catch the tool
      // becoming unreachable, and usedTool passes on a call that came back
      // "Tool not found" — it also matches the name appearing in js_exec source
      // text, so the agent merely writing tools.get_custom_domain(...) counted.
      const calledGetCustomDomain = succeededWithTool(result.events, "get_custom_domain");
      const attemptedGetCustomDomain = usedTool(result.events, "get_custom_domain");
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          // The core regression check: in lean mode get_custom_domain is not a
          // top-level tool, so the agent must have discovered it via tools.search and
          // invoked it.
          passFailCriterion({
            id: "called_get_custom_domain",
            label: "Agent discovered and successfully called get_custom_domain",
            passed: calledGetCustomDomain,
            reason: calledGetCustomDomain
              ? undefined
              : attemptedGetCustomDomain
                ? "Agent called get_custom_domain but the call did not succeed."
                : "Agent did not discover/call get_custom_domain.",
            details: { attemptedGetCustomDomain, toolCallsByName: signal.toolCallsByName },
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
          buildHarnessIntegrityCriterion(signal),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 5, maxBadToolCalls: 1, points: 4 },
              { maxAssistantTurns: 10, maxBadToolCalls: 2, points: 3 },
              { maxAssistantTurns: 15, maxBadToolCalls: 3, points: 2 },
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
          calledGetCustomDomain,
          toolCallsByName: signal.toolCallsByName,
          failures: calledGetCustomDomain
            ? []
            : ["agent did not discover/call get_custom_domain"],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
