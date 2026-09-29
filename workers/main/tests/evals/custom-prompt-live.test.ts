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
  scoreCriterion,
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
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";
import { asRecord } from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

// Generic, env-driven eval used by the control plane to run custom prompts that are NOT
// committed to the source tree. The prompt, optional project name, and optional pass/fail
// substring assertions are supplied via env (whitelisted in vitest.workers.config.ts):
//   CUSTOM_EVAL_PROMPT                         (required) the user message sent to the agent
//   CUSTOM_EVAL_PROJECT                        (optional) project name to scaffold; default "custom-eval"
//   CUSTOM_EVAL_REQUIRED_TRANSCRIPT_SUBSTRINGS (optional) JSON array of lowercase substrings
//                                               that must appear in the transcript for the eval to pass
// Model selection (EVAL_MODEL / EVAL_CUSTOM_*), signal thresholds (EVAL_MAX_* /
// EVAL_ENFORCE_SIGNAL), and real-deploy opt-in (EVAL_REAL_DEPLOY) reuse the shared harness.
type CustomEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  CUSTOM_EVAL_PROMPT?: string;
  CUSTOM_EVAL_PROJECT?: string;
  CUSTOM_EVAL_REQUIRED_TRANSCRIPT_SUBSTRINGS?: string;
};

const testEnv = env as unknown as CustomEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 600_000);

function parseRequiredTranscriptSubstrings(raw: string | undefined): string[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `CUSTOM_EVAL_REQUIRED_TRANSCRIPT_SUBSTRINGS must be a JSON array of strings: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(
      "CUSTOM_EVAL_REQUIRED_TRANSCRIPT_SUBSTRINGS must be a JSON array of strings",
    );
  }
  return (parsed as string[]).map((item) => item.toLowerCase());
}

function projectId(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return slug || "custom-eval";
}

describe("custom prompt agent eval", () => {
  maybeIt(
    "runs a control-plane supplied prompt and captures the transcript",
    async () => {
      const prompt = testEnv.CUSTOM_EVAL_PROMPT?.trim();
      let requiredTranscriptSubstrings: string[] = [];
      let configError: string | undefined;
      try {
        requiredTranscriptSubstrings = parseRequiredTranscriptSubstrings(
          testEnv.CUSTOM_EVAL_REQUIRED_TRANSCRIPT_SUBSTRINGS,
        );
      } catch (error) {
        configError = error instanceof Error ? error.message : String(error);
      }
      const projectName = testEnv.CUSTOM_EVAL_PROJECT?.trim() || "custom-eval";
      if (!prompt || configError) {
        const evaluation = buildEvalCriteriaSummary({
          passFail: [
            passFailCriterion({
              id: "custom_prompt_present",
              label: "Custom prompt is present",
              passed: Boolean(prompt),
              reason: prompt
                ? undefined
                : "CUSTOM_EVAL_PROMPT is required to run custom-prompt-live.",
            }),
            passFailCriterion({
              id: "required_transcript_substrings_config_valid",
              label: "Required transcript substring config is valid",
              passed: !configError,
              reason: configError,
            }),
          ],
          scorecard: [
            scoreCriterion({
              id: "no_bad_tool_calls",
              label: "No bad tool calls",
              points: 0,
              maxPoints: 1,
              reason: "Agent session did not run.",
            }),
          ],
        });
        const payload = {
          status: "harness_error",
          evaluation,
          error: configError ?? "CUSTOM_EVAL_PROMPT is required",
          model: testEnv.EVAL_MODEL,
          prompt,
          requiredTranscriptSubstrings,
        };
        emitEvalTranscript(payload);
        assertPassFailCriteria(evaluation);
        return;
      }

      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `custom-eval-${suffix}@example.com`,
        "password123",
        "Custom Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Custom Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Custom prompt eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      await workspaceFs.createProject({
        id: projectId(projectName),
        name: projectName,
        description: "Custom prompt eval project.",
        workspaceId: defaultWorkspaceId,
        backend: "do-r2",
      });

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Custom Eval",
        userEmail: `custom-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: prompt,
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, { maxBadToolCalls: 0 }),
      );

      const runtimeToolItems = result.events.filter((rawEvent) => {
        if (rawEvent.type !== "runtime_event") return false;
        return asRecord(rawEvent.event)?.method === "item/completed";
      });
      const agentAuthoredText = JSON.stringify({
        result: result.result,
        messages: result.messages.filter((message) => message.role === "assistant"),
        runtimeToolItems,
      }).toLowerCase();
      const missingSubstrings = requiredTranscriptSubstrings.filter(
        (substring) => !agentAuthoredText.includes(substring),
      );
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
          passFailCriterion({
            id: "required_transcript_substrings_present",
            label: "Required transcript substrings are present",
            passed: missingSubstrings.length === 0,
            reason: missingSubstrings.length
              ? `Missing required substring(s): ${missingSubstrings.join(", ")}`
              : undefined,
            details: {
              requiredTranscriptSubstrings,
              missingSubstrings,
            },
          }),
        ],
        scorecard: [
          scoreCriterion({
            id: "no_bad_tool_calls",
            label: "No bad tool calls",
            points: signal.badToolCallCount === 0 ? 1 : 0,
            maxPoints: 1,
            reason: `${signal.badToolCallCount} bad tool call(s).`,
          }),
        ],
      });
      const finalPayload = {
        status: result.status,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        prompt,
        requiredTranscriptSubstrings,
        signal,
        deployedApps: result.deployedApps,
        result: result.result,
        events: result.events,
        messages: result.messages,
      };
      emitEvalTranscript(finalPayload);

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
