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
import { runRuntimeEval } from "./runtime-eval";

// This eval exercises the integration tools (create_integration / list_integrations).
// Those tools live in the "integrations" category, which the lean tool surface (now the
// default) drops from the model's top-level tool list — so this eval verifies the agent
// can still DISCOVER and use them via tools.search inside js_exec. A remote_mcp
// integration is created without any network call, so the assertion is deterministic:
// the integration must actually persist on the workspace.

type IntegrationEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as IntegrationEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;

const INTEGRATION_NAME = "docs-mcp";
const INTEGRATION_TYPE = "remote_mcp";
const SERVER_URL = "https://mcp.example.com/sse";
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 180_000);

describe("integration create agent eval", () => {
  maybeIt(
    "asks the agent to add a remote MCP integration and verifies it persisted",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `integration-eval-${suffix}@example.com`,
        "password123",
        "Integration Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Integration Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Integration create eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Integration Eval",
        userEmail: `integration-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "Add a remote MCP server integration to this workspace directly — do NOT prompt me to set it up interactively.",
          `Use integration type "${INTEGRATION_TYPE}", name it exactly "${INTEGRATION_NAME}",`,
          `set its server URL to "${SERVER_URL}" and auth type "none".`,
          "Reply with the integration name once it is created.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 1,
        }),
      );

      // Verify the integration actually persisted on the workspace, independent of
      // the agent's reply.
      const integrations = await orgStub.getWorkspaceIntegrations(defaultWorkspaceId);
      const match = integrations.find((integration) => integration.name === INTEGRATION_NAME);
      let persistedConfig: Record<string, unknown> = {};
      try {
        persistedConfig = JSON.parse(match?.config ?? "{}");
      } catch {
        persistedConfig = {};
      }
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "integration_persisted",
            label: "Integration persisted",
            passed: Boolean(match),
            reason: match
              ? undefined
              : `No ${INTEGRATION_TYPE} integration named "${INTEGRATION_NAME}" was created.`,
            details: { integrationCount: integrations.length },
          }),
          passFailCriterion({
            id: "integration_type_correct",
            label: "Integration has the requested type",
            passed: match?.integration_type === INTEGRATION_TYPE,
            reason:
              match?.integration_type === INTEGRATION_TYPE
                ? undefined
                : `Expected integration type "${INTEGRATION_TYPE}", got "${match?.integration_type ?? "none"}".`,
            details: { integrationType: match?.integration_type ?? null },
          }),
          passFailCriterion({
            id: "integration_config_correct",
            label: "Integration has the requested server URL and auth type",
            passed:
              persistedConfig.server_url === SERVER_URL &&
              persistedConfig.auth_type === "none",
            reason:
              persistedConfig.server_url === SERVER_URL && persistedConfig.auth_type === "none"
                ? undefined
                : `Expected server_url=${SERVER_URL} and auth_type=none.`,
            details: { config: persistedConfig },
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
              { maxAssistantTurns: 6, maxBadToolCalls: 1, points: 4 },
              { maxAssistantTurns: 12, maxBadToolCalls: 2, points: 3 },
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
          integrationCount: integrations.length,
          createdName: match?.name ?? null,
          createdType: match?.integration_type ?? null,
          toolCallsByName: signal.toolCallsByName,
          failures: match
            ? []
            : [`no ${INTEGRATION_TYPE} integration named "${INTEGRATION_NAME}" was created`],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
