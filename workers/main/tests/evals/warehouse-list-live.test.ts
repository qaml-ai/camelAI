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

// This eval exercises connection discovery through the lean code-mode surface.
// The specialized analysis listing and the general connections listing both
// answer an empty-workspace warehouse question correctly, so grade the semantic
// listing behavior rather than overfitting to one internal alias.

type WarehouseEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as WarehouseEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 150_000);

describe("warehouse list connections agent eval", () => {
  maybeIt(
    "asks the agent to list warehouse connections, verifying tool discovery",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `warehouse-eval-${suffix}@example.com`,
        "password123",
        "Warehouse Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Warehouse Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Warehouse list eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Warehouse Eval",
        userEmail: `warehouse-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "Using the data-warehouse query tooling, list the data warehouse connections configured in this workspace",
          "(for example BigQuery, ClickHouse, Snowflake, or Databricks) and report how many there are.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 1,
        }),
      );

      // Requires a listing call to have actually SUCCEEDED. With usedTool this
      // eval was near-vacuous: an empty workspace gives it no state to check, so
      // "did the agent emit the call" was its entire substance — and that passes
      // even when the listing tool errors or is unreachable.
      const LISTING_TOOLS = [
        "analysis_list_connections",
        "connections_list",
      ];
      const calledWarehouseList = LISTING_TOOLS.some((name) =>
        succeededWithTool(result.events, name),
      );
      const attemptedWarehouseList = LISTING_TOOLS.some((name) =>
        usedTool(result.events, name),
      );
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "called_warehouse_list",
            label: "A connection-listing call succeeded",
            passed: calledWarehouseList,
            reason: calledWarehouseList
              ? undefined
              : attemptedWarehouseList
                ? "Agent called a connection-listing path but it did not succeed."
                : "Agent did not call a supported connection-listing path.",
            details: { attemptedWarehouseList, toolCallsByName: signal.toolCallsByName },
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
          calledWarehouseList,
          toolCallsByName: signal.toolCallsByName,
          failures: calledWarehouseList
            ? []
            : ["agent did not call a supported connection-listing path"],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
