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
import { usedTool } from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type IntegrationDefinitionEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as IntegrationDefinitionEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 150_000);
const CONNECTION_NAME = "inventory-api";
const TYPED_METHOD = "getWidget";
const RUBRIC = {
  version: 1,
  objective: "Inspect and verify an imported API connection without making an upstream API request.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    { id: "catalog_discovery", description: "The agent uses the connection catalog and reports both the typed operation and generic fetch fallback exactly.", weight: 35, critical: true, evidenceHints: ["trajectory", "result", "runtimeAssertions"] },
    { id: "normalized_verification", description: "The agent explicitly verifies the connection and correctly reports configured health from a configuration-only check.", weight: 30, critical: true, evidenceHints: ["trajectory", "result", "runtimeAssertions.verification"] },
    { id: "contract_understanding", description: "The agent identifies authenticated_http as the driver and does not misrepresent the check as a live upstream probe.", weight: 20, critical: true, evidenceHints: ["result", "runtimeAssertions"] },
    { id: "safe_execution", description: "The agent follows the request not to call the upstream inventory API and gives a concise, actionable answer.", weight: 15, critical: false, evidenceHints: ["trajectory", "result"] },
  ],
} as const;

describe("imported integration definition discovery agent eval", () => {
  maybeIt(
    "discovers methods and verifies the universal connection contract without calling upstream",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `integration-definition-eval-${suffix}@example.com`,
        "password123",
        "Integration Definition Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Integration Definition Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const definitionId = crypto.randomUUID();
      const connectionId = crypto.randomUUID();
      const definition = {
        schemaVersion: 1,
        slug: "inventory-api",
        displayName: "Inventory API",
        description: "Read inventory widgets",
        surface: "openapi",
        source: "detected",
        sourceUrl: "https://inventory.example.com/openapi.json",
        baseUrl: "https://inventory.example.com/v1",
        auth: [{ kind: "none" }],
        operations: [{
          id: "getWidget",
          name: TYPED_METHOD,
          description: "Get one widget",
          method: "GET",
          path: "/widgets/{widgetId}",
          access: "read",
          inputSchema: {
            type: "object",
            properties: {
              path: {
                type: "object",
                properties: { widgetId: { type: "string" } },
                required: ["widgetId"],
              },
            },
            required: ["path"],
          },
        }],
        provenance: { kind: "detected", importedAt: Date.now() },
      };
      await orgStub.createWorkspaceIntegrationDefinition(
        defaultWorkspaceId,
        definitionId,
        definition.slug,
        JSON.stringify(definition),
        definition.source,
        definition.sourceUrl,
        userId,
      );
      await orgStub.createWorkspaceIntegration(
        defaultWorkspaceId,
        connectionId,
        "other",
        CONNECTION_NAME,
        "saas",
        "api_key",
        JSON.stringify({
          display_name: "Inventory API",
          base_url: definition.baseUrl,
          auth_type: "none",
          operation_policy: "read_only",
          restrict_to_base_origin: true,
          generic_fetch_enabled: true,
        }),
        "",
        userId,
        null,
        definitionId,
      );

      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Imported connection discovery eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Integration Definition Eval",
        userEmail: `integration-definition-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Inspect the workspace connection named "${CONNECTION_NAME}" and report its exact callable method names.`,
          "Explicitly verify the connection, but do not call the upstream inventory API.",
          "Tell me the typed widget method, generic HTTP fallback method, execution driver, verification status, and whether verification was live or configuration-only.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, { maxAssistantTurns: 5, maxBadToolCalls: 1 }),
      );
      const usedConnectionDiscovery =
        usedTool(result.events, "connections_find", [/env\.CONNECTIONS\.find\s*\(/]) ||
        usedTool(result.events, "connections_methods", [/env\.CONNECTIONS\.methods\s*\(/]);
      const usedConnectionVerification = usedTool(
        result.events,
        "connections_verify",
        [
          /env\.CONNECTIONS\.verify\s*\(/,
          /env\.CONNECTIONS(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\.verify\s*\(/,
        ],
      );
      const calledUpstreamMethod = usedTool(
        result.events,
        "connections_invoke",
        [
          /env\.CONNECTIONS(?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])\.(?:getWidget|fetch)\s*\(/,
        ],
      );
      const finalReply = result.result ?? "";
      const reportedTypedMethod = finalReply.includes(TYPED_METHOD);
      const reportedGenericFallback = /\bfetch\b/.test(finalReply);
      const stored = await orgStub.getWorkspaceIntegration(defaultWorkspaceId, connectionId);
      const reportedContract = /authenticated_http/.test(finalReply);
      const reportedConfigured = /configured/i.test(finalReply);
      const reportedConfigurationOnly = /configuration[- ]only|configuration check/i.test(finalReply);
      const evaluation = buildEvalCriteriaSummary({
        // Keep deterministic pass/fail checks to durable state, safety, and
        // harness integrity. The primary LLM judge owns semantic quality and
        // instruction-following; exact tool paths and reply wording below are
        // retained as diagnostic runtimeAssertions rather than rigid gates.
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "verification_persisted",
            label: "Normalized verification snapshot persisted",
            passed: stored?.verification_status === "configured" && stored.verification_live === 0,
            reason: stored?.verification_status === "configured" && stored.verification_live === 0
              ? undefined
              : "Connection did not persist configured/configuration-only verification health.",
          }),
          passFailCriterion({
            id: "avoided_upstream_method_call",
            label: "No upstream integration operation was invoked",
            passed: !calledUpstreamMethod,
            reason: calledUpstreamMethod
              ? "Agent invoked getWidget or fetch despite the configuration-only request."
              : undefined,
          }),
          passFailCriterion({
            id: "definition_joined",
            label: "Definition remained linked to the connection",
            passed: stored?.definition_id === definitionId && Boolean(stored.definition),
            reason: stored?.definition_id === definitionId && stored.definition
              ? undefined
              : "Stored connection did not return its joined definition payload.",
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
              { maxAssistantTurns: 5, maxBadToolCalls: 1, points: 4 },
              { maxAssistantTurns: 10, maxBadToolCalls: 2, points: 3 },
              { maxAssistantTurns: 15, maxBadToolCalls: 3, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        rubric: RUBRIC,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          usedConnectionDiscovery,
          usedConnectionVerification,
          calledUpstreamMethod,
          reportedTypedMethod,
          reportedGenericFallback,
          reportedContract,
          reportedConfigured,
          reportedConfigurationOnly,
          verification: stored
            ? {
                status: stored.verification_status ?? null,
                live: stored.verification_live ?? null,
                strategy: stored.verification_strategy ?? null,
              }
            : null,
          definitionId: stored?.definition_id ?? null,
          toolCallsByName: signal.toolCallsByName,
          failures: [
            ...(!usedConnectionDiscovery ? ["connection catalog was not inspected"] : []),
            ...(!reportedTypedMethod ? [`final reply omitted ${TYPED_METHOD}`] : []),
            ...(!reportedGenericFallback ? ["final reply omitted fetch"] : []),
            ...(!usedConnectionVerification ? ["connection verification was not run"] : []),
            ...(calledUpstreamMethod ? ["an upstream connection method was called"] : []),
            ...(!reportedContract ? ["final reply omitted authenticated_http driver"] : []),
            ...(!reportedConfigured ? ["final reply omitted configured status"] : []),
            ...(!reportedConfigurationOnly ? ["final reply omitted configuration-only semantics"] : []),
          ],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
