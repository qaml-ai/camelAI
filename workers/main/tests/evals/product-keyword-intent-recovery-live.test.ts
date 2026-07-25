import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import type { ChatThreadDO } from "../../src/chat-thread-do";
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

type ProductKeywordEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as ProductKeywordEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 180_000);
const RUBRIC = {
  version: 1,
  objective:
    "Recover from a frustrated clarification by separating removal intent from prompt-based replacement intent and giving a defensible SEO category recommendation.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    {
      id: "intent_distinction",
      description:
        "The answer explicitly distinguishes erase/remove workflows from brush-and-prompt fill or replacement workflows.",
      weight: 40,
      critical: true,
      evidenceHints: ["result"],
    },
    {
      id: "correct_category",
      description:
        "The primary recommendation is Generative Fill or AI Inpainting, while Magic Eraser is treated only as a removal term rather than the product's category.",
      weight: 35,
      critical: true,
      evidenceHints: ["result", "referenceEvidence"],
    },
    {
      id: "uses_supplied_evidence",
      description:
        "The recommendation uses the supplied keyword metrics and does not invent unsupported volume data.",
      weight: 15,
      critical: false,
      evidenceHints: ["result", "referenceEvidence"],
    },
    {
      id: "frustration_recovery",
      description:
        "The response acknowledges and corrects the misunderstanding directly without defensiveness or repeating the same conflation.",
      weight: 10,
      critical: false,
      evidenceHints: ["result", "messages"],
    },
  ],
} as const;

describe("product keyword intent recovery agent eval", () => {
  maybeIt(
    "separates removal and generative-fill intent after a correction",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `keyword-intent-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Keyword Intent Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Keyword Intent Eval ${suffix}`,
        userId,
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Product keyword intent recovery eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const firstResult = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Keyword Intent Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message:
          "We are launching an AI image tool that users brush over and then type a prompt. Should we call it Magic Eraser or Inpainting for SEO?",
      });
      const secondResult = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Keyword Intent Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "You're mixing up two different intents. Magic Eraser removes something.",
          "Our product fills the brushed region with whatever the user prompts.",
          "Reassess using only these frozen US monthly metrics:",
          "generative fill 2400, AI generative fill 880, image inpainting 390, AI inpainting 320, magic eraser 8100.",
          "Recommend one primary category name and a secondary technical keyword.",
        ].join(" "),
      });
      const result = {
        status:
          firstResult.status === "completed" && secondResult.status === "completed"
            ? "completed"
            : "error",
        error: [firstResult.error, secondResult.error].filter(Boolean).join("; ") || undefined,
        result: secondResult.result,
        events: [...firstResult.events, ...secondResult.events],
        messages: secondResult.messages,
      };
      const finalResult = secondResult.result ?? "";
      const distinguishesIntents =
        /\b(?:erase|eraser|remove|removal)\b/i.test(finalResult) &&
        /\b(?:fill|replace|replacement|inpaint)\b/i.test(finalResult) &&
        /\bprompt/i.test(finalResult);
      const recommendsCorrectCategory =
        /\b(?:AI\s+)?Generative Fill\b/i.test(finalResult) ||
        /\b(?:AI\s+)?Inpainting\b/i.test(finalResult);
      const recommendsMagicEraserAsPrimary =
        /\b(?:primary (?:name|category)|call (?:it|the product)|recommendation(?: is|:))\s*(?:\*\*)?Magic Eraser\b/i.test(
          finalResult,
        );
      const usesFrozenMetrics =
        /2[,.]?400/.test(finalResult) &&
        /(?:390|320)/.test(finalResult);
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 5,
          maxBadToolCalls: 0,
        }),
      );
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "removal_and_fill_intents_distinguished",
            label: "Final answer distinguishes removal from prompt-based fill",
            passed: distinguishesIntents,
            reason: distinguishesIntents
              ? undefined
              : "The final answer did not clearly separate the two product intents.",
            details: { finalResult },
          }),
          passFailCriterion({
            id: "primary_category_matches_product",
            label: "Final recommendation matches the prompt-based fill capability",
            passed: recommendsCorrectCategory && !recommendsMagicEraserAsPrimary,
            reason:
              recommendsCorrectCategory && !recommendsMagicEraserAsPrimary
                ? undefined
                : "The final answer did not recommend Generative Fill/Inpainting cleanly, or still treated Magic Eraser as the primary category.",
            details: {
              finalResult,
              recommendsCorrectCategory,
              recommendsMagicEraserAsPrimary,
            },
          }),
          passFailCriterion({
            id: "supplied_keyword_metrics_used",
            label: "Final recommendation uses the supplied keyword metrics",
            passed: usesFrozenMetrics,
            reason: usesFrozenMetrics
              ? undefined
              : "The final answer did not ground the recommendation in the supplied volumes.",
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
              { maxAssistantTurns: 3, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 5, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 8, maxBadToolCalls: 1, points: 2 },
            ],
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        rubric: RUBRIC,
        referenceEvidence: {
          source: "sanitized synthetic fixture derived from a July 25 user correction",
          facts: [
            "Magic Eraser describes object removal.",
            "The product replaces a brushed region using a text prompt.",
            "Frozen monthly volumes: generative fill 2400, AI generative fill 880, image inpainting 390, AI inpainting 320, magic eraser 8100.",
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
          distinguishesIntents,
          recommendsCorrectCategory,
          recommendsMagicEraserAsPrimary,
          usesFrozenMetrics,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS * 2 + 30_000,
  );
});
