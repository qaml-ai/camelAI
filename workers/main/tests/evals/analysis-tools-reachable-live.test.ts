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
import type { ChatThreadDO } from "../../src/chat-thread-do";
import { usedTool } from "./project-eval-helpers";

// Regression eval for analysis-tool reachability.
//
// run_notebook / run_code / analysis_exec / add_python_dependency used to carry
// `category: "connections"`, which is one of the categories dropped from the
// model's top-level tool list. The agent was told elsewhere (system prompt,
// data-analysis skill, run_notebook's own description) that run_notebook is the
// primary data-analysis path, so it called them directly and got back
// `Tool run_notebook not found` / `Tool analysis_exec not found`. A production
// thread burned several turns on that before rediscovering them inside js_exec.
//
// The point of this eval is NOT which analysis tool the agent picks — any of
// them is a fine way to answer. It is that reaching for the analysis surface by
// name must not dead-end in a not-found error.
type AnalysisToolsEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as AnalysisToolsEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);

const ANALYSIS_TOOL_NAMES = [
  "run_notebook",
  "run_code",
  "analysis_exec",
  "add_python_dependency",
];

/**
 * Find `Tool <name> not found` style rejections for the analysis tools anywhere
 * in the transcript. This is deliberately string-based: the failure it guards
 * against is the harness refusing a tool the model was told it has, which shows
 * up as tool-result text rather than as a typed error.
 */
function findAnalysisToolNotFound(
  result: { events: Array<Record<string, unknown>>; messages: unknown[] },
): string[] {
  const haystack = `${JSON.stringify(result.events)}\n${JSON.stringify(result.messages)}`;
  const hits: string[] = [];
  for (const name of ANALYSIS_TOOL_NAMES) {
    const pattern = new RegExp(
      `(?:Tool\\s+)?${name}(?:\\s+tool)?\\s+(?:was\\s+)?not\\s+found|not\\s+found[^"]{0,40}${name}`,
      "i",
    );
    if (pattern.test(haystack)) hits.push(name);
  }
  return hits;
}

describe("analysis tools reachable agent eval", () => {
  maybeIt(
    "reaches the analysis sandbox by name without a not-found dead end",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `analysis-tools-eval-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Analysis Tools Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Analysis Tools Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Analysis tools reachable eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Analysis Tools Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "Use the Python analysis sandbox to work out the answer to this, rather than doing the arithmetic yourself.",
          "I have three excavators running 8.5 hours a day for 12 days at 145.50 per hour,",
          "and two dumpers running 6 hours a day over the same 12 days at 88.25 per hour.",
          "Compute the total plant cost for each machine type and the combined total,",
          "then tell me the three figures.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 8,
          maxBadToolCalls: 1,
        }),
      );

      const notFoundTools = findAnalysisToolNotFound(result);
      const reachedAnalysisSurface = ANALYSIS_TOOL_NAMES.some((name) =>
        usedTool(result.events, name),
      );

      // Ground truth: 3 * 8.5 * 12 * 145.50 = 44523; 2 * 6 * 12 * 88.25 = 12708.
      const answerText = JSON.stringify(result.messages);
      const reportedExcavators = /44[,.]?523/.test(answerText);
      const reportedDumpers = /12[,.]?708/.test(answerText);
      const reportedTotal = /57[,.]?231/.test(answerText);

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "no_analysis_tool_not_found",
            label: "No analysis tool was rejected as not found",
            passed: notFoundTools.length === 0,
            reason:
              notFoundTools.length === 0
                ? undefined
                : `Harness rejected analysis tools as not found: ${notFoundTools.join(", ")}.`,
            details: { notFoundTools, toolCallsByName: signal.toolCallsByName },
          }),
          passFailCriterion({
            id: "reached_analysis_surface",
            label: "Agent reached an analysis execution tool",
            passed: reachedAnalysisSurface,
            reason: reachedAnalysisSurface
              ? undefined
              : "Agent never called run_notebook, run_code, analysis_exec, or add_python_dependency.",
            details: { toolCallsByName: signal.toolCallsByName },
          }),
          passFailCriterion({
            id: "reported_correct_totals",
            label: "Agent reported the correct plant costs",
            passed: reportedExcavators && reportedDumpers && reportedTotal,
            reason:
              reportedExcavators && reportedDumpers && reportedTotal
                ? undefined
                : "Expected 44523 (excavators), 12708 (dumpers), and 57231 (combined) in the reply.",
            details: { reportedExcavators, reportedDumpers, reportedTotal },
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
              { maxAssistantTurns: 10, maxBadToolCalls: 1, points: 3 },
              { maxAssistantTurns: 16, maxBadToolCalls: 2, points: 2 },
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
          notFoundTools,
          reachedAnalysisSurface,
          reportedExcavators,
          reportedDumpers,
          reportedTotal,
          toolCallsByName: signal.toolCallsByName,
          failures: [
            ...(notFoundTools.length
              ? [`analysis tools rejected as not found: ${notFoundTools.join(", ")}`]
              : []),
            ...(reachedAnalysisSurface ? [] : ["agent never reached an analysis execution tool"]),
          ],
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
