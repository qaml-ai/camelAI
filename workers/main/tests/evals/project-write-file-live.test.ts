import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import type { ChatThreadDO } from "../../src/chat-thread-do";
import {
  ProjectFilesystemClient,
  type WorkspaceFilesystemDO,
} from "../../src/workspace-filesystem-do";
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

type ProjectWriteEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as ProjectWriteEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const EXPECTED_FILE_CONTENT = "project write eval ok.";
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 180_000);
const RUBRIC = {
  version: 1,
  objective:
    "Write and verify an exact project file, then finish with a persisted assistant response that reports the verified contents.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    {
      id: "exact_file",
      description:
        "The requested project file exists and contains exactly the supplied synthetic text.",
      weight: 40,
      critical: true,
      evidenceHints: ["fileInspection", "runtimeAssertions"],
    },
    {
      id: "verified_readback",
      description:
        "The agent reads the persisted file and grounds its response in that successful readback.",
      weight: 25,
      critical: true,
      evidenceHints: ["trajectory", "runtimeAssertions"],
    },
    {
      id: "assistant_completion",
      description:
        "The turn ends with a non-empty assistant response after the final tool result rather than silently stopping at the tool boundary.",
      weight: 25,
      critical: true,
      evidenceHints: ["result", "runtimeAssertions"],
    },
    {
      id: "concise_reply",
      description:
        "The final response provides the requested contents directly without unrelated narration.",
      weight: 10,
      critical: false,
      evidenceHints: ["result"],
    },
  ],
} as const;

function messageRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : undefined;
}

describe("project write file agent eval", () => {
  maybeIt(
    "asks the agent to write and read back a file in a DO-backed project",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `project-write-eval-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Project Write Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Project Write Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Project write file eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        id: "file-write-app",
        name: "file-write-app",
        description: "File write eval project.",
        workspaceId: defaultWorkspaceId,
        backend: "do-r2",
      });

      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Project Write Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: 'In the file-write-app project, create a file at the project root named eval-output.txt containing exactly this text (everything between the quotes, including the final period): "project write eval ok." Then read the file back and reply with the file contents only.',
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 4,
          maxBadToolCalls: 0,
        }),
      );

      const readResponse = await new ProjectFilesystemClient(testEnv, project.id)
        .readFile("/eval-output.txt");
      const fileContents = readResponse.content ?? "";
      const normalizedFileContents = fileContents.trim();
      const finalResult = result.result?.trim() ?? "";
      const finalResultLower = finalResult.toLowerCase();
      const finalResultExtra = finalResultLower
        .replace(EXPECTED_FILE_CONTENT, "")
        .trim();
      const terminalRole = messageRole(result.messages.at(-1));
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "expected_file_written",
            label: "Agent wrote the expected file",
            passed: readResponse.success,
            reason: readResponse.success
              ? undefined
              : readResponse.error ?? "Reading /eval-output.txt failed.",
            details: readResponse,
          }),
          passFailCriterion({
            id: "file_contents_exact",
            label: "File contents are exactly correct",
            passed: normalizedFileContents === EXPECTED_FILE_CONTENT,
            reason: normalizedFileContents === EXPECTED_FILE_CONTENT
              ? undefined
              : `Expected "${EXPECTED_FILE_CONTENT}" after whitespace normalization.`,
            details: { actual: normalizedFileContents },
          }),
          passFailCriterion({
            id: "final_response_includes_file_contents",
            label: "Final response includes the file contents",
            passed: finalResultLower.includes(EXPECTED_FILE_CONTENT),
            reason: finalResultLower.includes(EXPECTED_FILE_CONTENT)
              ? undefined
              : "Final response did not include the expected file contents.",
            details: { finalResult },
          }),
          passFailCriterion({
            id: "terminal_assistant_completion",
            label: "Turn persisted a final assistant response after tool use",
            passed: terminalRole === "assistant" && finalResult.length > 0,
            reason:
              terminalRole === "assistant" && finalResult.length > 0
                ? undefined
                : `Expected a non-empty assistant completion, got terminal role ${terminalRole ?? "missing"}.`,
            details: { terminalRole, hasFinalResult: finalResult.length > 0 },
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
              { maxAssistantTurns: 4, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 6, maxBadToolCalls: 1, points: 3 },
              { maxAssistantTurns: 10, maxBadToolCalls: 3, points: 2 },
            ],
          }),
          scoreCriterion({
            id: "reply_conciseness",
            label: "Reply contains no more than 80 extra characters",
            points: finalResultExtra.length <= 80 ? 1 : 0,
            maxPoints: 1,
            reason: `${finalResultExtra.length} extra character(s).`,
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
        fileInspection: {
          path: "/eval-output.txt",
          success: readResponse.success,
          contents: fileContents,
        },
        runtimeAssertions: {
          terminalRole,
          hasFinalResult: finalResult.length > 0,
          exactFileContents:
            normalizedFileContents === EXPECTED_FILE_CONTENT,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
