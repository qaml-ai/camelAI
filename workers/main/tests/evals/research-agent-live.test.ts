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
import {
  asRecord,
  asString,
  usedTool,
} from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type ResearchEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as ResearchEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 300_000);
const EXPECTED_MARKER = "RESEARCH_COMPLETE";
const RESEARCH_MODEL = "deepseek-v4-auto";
const RUBRIC = {
  version: 1,
  objective: "Use Research to answer a current multi-source question accurately, efficiently, and with traceable sources.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    { id: "accurate_synthesis", description: "The answer accurately identifies the relevant Quick Action and compatibility requirement and distinguishes documented facts from inference.", weight: 40, critical: true, evidenceHints: ["result", "messages"] },
    { id: "appropriate_delegation", description: "The primary delegates the external-source investigation to Research and meaningfully integrates the findings.", weight: 25, critical: true, evidenceHints: ["trajectory"] },
    { id: "source_quality", description: "The research uses relevant, authoritative sources and ties direct URLs to the important claims without padding the answer with needless searches.", weight: 25, critical: false, evidenceHints: ["trajectory", "result"] },
    { id: "clear_response", description: "The final response is concise, directly answers the question, and includes the requested completion marker.", weight: 10, critical: false, evidenceHints: ["result"] },
  ],
} as const;

function distinctHttpUrls(text: string): string[] {
  return [...new Set(text.match(/https?:\/\/[^\s)>\]}"']+/g) ?? [])];
}

function successfulResearchResult(
  events: Array<Record<string, unknown>>,
): { output: string; model?: string } {
  for (const rawEvent of events) {
    if (rawEvent.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(rawEvent.event);
    if (runtimeEvent?.method !== "item/completed") continue;
    const item = asRecord(asRecord(runtimeEvent.params)?.item);
    if (!item || asString(item.tool)?.toLowerCase() !== "research") continue;
    // Research can complete after recovering from an individual child request
    // failure. Judge the capability item itself instead of recursively treating
    // an errored child activity as a failed Research call.
    if (item.isError === true || asString(item.status)?.toLowerCase() !== "completed") continue;
    const result = asRecord(item.result);
    const content = Array.isArray(result?.content) ? result.content : [];
    const text = content
      .map((entry) => asString(asRecord(entry)?.text) ?? "")
      .filter(Boolean)
      .join("\n");
    if (text) {
      return {
        output: text,
        model: asString(asRecord(result?.details)?.model),
      };
    }
  }
  return { output: "" };
}

describe("Research capability agent eval", () => {
  maybeIt(
    "delegates a multi-source web investigation to Research",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `research-eval-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Research Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Research Eval ${suffix}`,
        userId,
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Research capability eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const researchQuestion = [
        "Investigate Cloudflare Browser Run Quick Actions using multiple sources.",
        "Identify which Quick Action converts a page to Markdown, explain why it is",
        "appropriate for one-off page fetching, and state the compatibility-date requirement.",
        "Include direct source URLs and distinguish documented facts from inference.",
      ].join(" ");
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Research Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "Please investigate this using current external sources:",
          researchQuestion,
          `Synthesize what you find and end with ${EXPECTED_MARKER}.`,
        ].join(" "),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 0,
        }),
      );
      const calledResearch = usedTool(result.events, "Research");
      const attemptedDirectWeb = usedTool(result.events, "WebSearch") ||
        usedTool(result.events, "WebFetch");
      const finalResult = result.result ?? "";
      const research = successfulResearchResult(result.events);
      const researchOutput = research.output;
      const successfulResearchCall = calledResearch && researchOutput.length > 0;
      const urls = distinctHttpUrls(researchOutput);
      const includesCoreFinding = /markdown/i.test(researchOutput) && /2026-03-24/.test(researchOutput);
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "called_research",
            label: "Agent chose Research for an ordinary web request without being told a tool name",
            passed: calledResearch && !attemptedDirectWeb,
            reason: calledResearch && !attemptedDirectWeb
              ? undefined
              : "The agent did not cleanly delegate the web request to Research.",
            details: { toolCallsByName: signal.toolCallsByName },
          }),
          passFailCriterion({
            id: "research_call_succeeded",
            label: "Research completed the requested investigation",
            passed: successfulResearchCall,
            reason: successfulResearchCall
              ? undefined
              : "No successful Research call referenced Browser Run Quick Actions.",
          }),
          passFailCriterion({
            id: "research_used_deepseek_auto",
            label: "Research ran on DeepSeek Auto",
            passed: research.model === RESEARCH_MODEL,
            reason: research.model === RESEARCH_MODEL
              ? undefined
              : `Research reported model ${research.model ?? "unknown"}.`,
            details: { model: research.model },
          }),
          passFailCriterion({
            id: "research_synthesis_grounded",
            label: "Research output contains the core finding and multiple URLs",
            passed: includesCoreFinding && urls.length >= 2 && finalResult.includes(EXPECTED_MARKER),
            reason: includesCoreFinding && urls.length >= 2 && finalResult.includes(EXPECTED_MARKER)
              ? undefined
              : "Research output lacked Markdown/date facts or two source URLs, or the final marker was absent.",
            details: { includesCoreFinding, urls, researchOutput, finalResult },
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
              { maxAssistantTurns: 4, maxBadToolCalls: 0, points: 6 },
              { maxAssistantTurns: 6, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 9, maxBadToolCalls: 1, points: 3 },
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
            "The official launch changelog URL is dated 2026-05-28, not 2025.",
          ],
          sources: [
            "https://developers.cloudflare.com/browser-run/quick-actions/",
            "https://developers.cloudflare.com/browser-run/quick-actions/markdown-endpoint/",
            "https://developers.cloudflare.com/changelog/post/2026-05-28-use-browser-run-quick-actions-directly-from-workers/",
          ],
        },
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        runtimeAssertions: {
          calledResearch,
          attemptedDirectWeb,
          successfulResearchCall,
          researchModel: research.model,
          includesCoreFinding,
          sourceUrls: urls,
          researchOutput,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
