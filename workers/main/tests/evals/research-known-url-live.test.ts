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
import {
  capabilityChildUsedTools,
  usedTool,
} from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type ResearchKnownUrlEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as ResearchKnownUrlEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);
const CAMEL_FREE_MODEL = "deepseek-v4-auto";
const DOC_URL = "https://developers.cloudflare.com/browser-run/quick-actions/";
const EXPECTED_MARKER = "KNOWN_URL_RESEARCH_COMPLETE";
const RUBRIC = {
  version: 1,
  objective: "Use Research to answer a question from a supplied authoritative URL accurately and efficiently.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    { id: "grounded_answer", description: "The final answer accurately identifies the Markdown quick action and required compatibility date, and cites the direct source URL.", weight: 40, critical: true, evidenceHints: ["result", "messages"] },
    { id: "appropriate_delegation", description: "The primary delegates the external-document lookup to Research and integrates its findings without using unavailable direct web tools.", weight: 30, critical: true, evidenceHints: ["trajectory", "runtimeAssertions"] },
    { id: "known_url_efficiency", description: "Research fetches the supplied URL directly instead of performing unnecessary discovery searches or duplicate research.", weight: 20, critical: false, evidenceHints: ["trajectory", "runtimeAssertions.childToolsUsed"] },
    { id: "clear_response", description: "The response is concise, directly answers the user, and includes the requested completion marker.", weight: 10, critical: false, evidenceHints: ["result"] },
  ],
} as const;

describe("Research known-URL routing eval", () => {
  maybeIt(
    "fetches a supplied source through one focused Research job",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `research-known-url-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Research Known URL Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Research Known URL Eval ${suffix}`,
        userId,
        { billingPlan: "free" },
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Research known URL eval",
        userId,
        undefined,
        CAMEL_FREE_MODEL,
      );
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Research Known URL Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Read this current Cloudflare documentation page: ${DOC_URL}`,
          "Which Quick Action returns Markdown, and what compatibility date does the page require?",
          `Answer concisely with the direct source URL and end with ${EXPECTED_MARKER}.`,
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 0,
        }),
      );
      const calledResearch = usedTool(result.events, "Research");
      const calledOracle = usedTool(result.events, "Oracle");
      const attemptedDirectWeb = usedTool(result.events, "WebSearch") ||
        usedTool(result.events, "WebFetch");
      const childToolsUsed = capabilityChildUsedTools(result.events, "Research");
      const fetchedKnownUrl = childToolsUsed.includes("WebFetch");
      const searchedNeedlessly = childToolsUsed.includes("WebSearch");
      const finalResult = result.result ?? "";
      const groundedAnswer = /markdown/i.test(finalResult) &&
        /2026-03-24/.test(finalResult) &&
        /https:\/\/developers\.cloudflare\.com\/browser-(?:rendering|run)\//.test(finalResult) &&
        finalResult.includes(EXPECTED_MARKER);
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "known_url_routed_to_research",
            label: "Camel Free routed the supplied external source to Research",
            passed: calledResearch && !calledOracle && !attemptedDirectWeb,
            reason: calledResearch && !calledOracle && !attemptedDirectWeb
              ? undefined
              : "The primary did not cleanly route the known URL to Research.",
            details: { calledResearch, calledOracle, attemptedDirectWeb },
          }),
          passFailCriterion({
            id: "known_url_fetched_without_search",
            label: "Research fetched the supplied URL without unnecessary discovery",
            passed: fetchedKnownUrl && !searchedNeedlessly,
            reason: fetchedKnownUrl && !searchedNeedlessly
              ? undefined
              : `Research child tools: ${childToolsUsed.join(", ") || "none"}.`,
            details: { childToolsUsed },
          }),
          passFailCriterion({
            id: "known_url_answer_grounded",
            label: "Final answer contains the documented action, date, URL, and marker",
            passed: groundedAnswer,
            reason: groundedAnswer
              ? undefined
              : "The final answer lacked the Markdown finding, compatibility date, source URL, or marker.",
            details: { finalResult },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 6,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 3, maxBadToolCalls: 0, points: 6 },
              { maxAssistantTurns: 5, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 8, maxBadToolCalls: 1, points: 3 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        rubric: RUBRIC,
        referenceEvidence: {
          frozenAt: "2026-07-17",
          facts: [
            "The Markdown Quick Action is /markdown (action name markdown).",
            "Workers binding quickAction usage requires compatibility date 2026-03-24 or later.",
          ],
          sources: [DOC_URL],
        },
        evaluation,
        error: result.error,
        model: CAMEL_FREE_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          calledResearch,
          calledOracle,
          attemptedDirectWeb,
          childToolsUsed,
          fetchedKnownUrl,
          searchedNeedlessly,
          groundedAnswer,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
