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
  buildHarnessIntegrityCriterion,
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
import { succeededWithTool, usedTool } from "./project-eval-helpers";

type ProjectSearchEvalEnv = TestEnv &
  EvalModelEnv &
  EvalSignalEnv & {
    CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
    WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
    RUN_AGENT_EVALS?: string;
  };

const testEnv = env as unknown as ProjectSearchEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);
const EXPECTED_PATH = "src/features/release-channel.ts";
const EXPECTED_VALUE = "orchid";
const SEARCH_MARKER = "SEARCH_TARGET_RELEASE_CHANNEL";
const RUBRIC = {
  version: 1,
  objective:
    "Locate an unknown project file by its content, inspect it, and report the requested fact without a tool-surface dead end.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    {
      id: "correct_discovery",
      description:
        "The agent finds and reports the exact matching project path and the configured release-channel value.",
      weight: 45,
      critical: true,
      evidenceHints: ["result", "runtimeAssertions"],
    },
    {
      id: "search_reachability",
      description:
        "The agent searches through a supported route and does not call code-mode-only grep or find as unavailable top-level tools.",
      weight: 30,
      critical: true,
      evidenceHints: ["trajectory", "runtimeAssertions"],
    },
    {
      id: "source_inspection",
      description:
        "The answer is grounded in the seeded source file rather than inferred from the prompt or invented.",
      weight: 15,
      critical: false,
      evidenceHints: ["trajectory", "runtimeAssertions.fileRead"],
    },
    {
      id: "concise_completion",
      description:
        "The final response clearly provides the path and value without claiming unrelated work.",
      weight: 10,
      critical: false,
      evidenceHints: ["result"],
    },
  ],
} as const;

function findTopLevelSearchNotFound(result: {
  events: Array<Record<string, unknown>>;
  messages: unknown[];
}): string[] {
  const haystack = `${JSON.stringify(result.events)}\n${JSON.stringify(result.messages)}`;
  return ["grep", "find"].filter((name) => {
    const pattern = new RegExp(
      `(?:Tool\\s+)?${name}(?:\\s+tool)?\\s+(?:was\\s+)?not\\s+found|not\\s+found[^"]{0,40}${name}`,
      "i",
    );
    return pattern.test(haystack);
  });
}

describe("project content search agent eval", () => {
  maybeIt(
    "locates a marker without a top-level search-tool dead end",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const projectName = `project-search-${suffix}`;
      const email = `project-search-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Project Search Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Project Search Eval ${suffix}`,
        userId,
      );
      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        name: projectName,
        description:
          "Synthetic source tree for project content-search coverage.",
        workspaceId: defaultWorkspaceId,
        backend: "do-r2",
      });
      const files = new ProjectFilesystemClient(testEnv, project.id);
      await files.writeFile(
        `/${EXPECTED_PATH}`,
        [
          `// ${SEARCH_MARKER}`,
          `export const releaseChannel = "${EXPECTED_VALUE}";`,
          "",
        ].join("\n"),
      );
      await files.writeFile(
        "/src/features/telemetry.ts",
        'export const telemetryMode = "sampled";\n',
      );
      await files.writeFile(
        "/src/config/defaults.ts",
        'export const defaultRegion = "west";\n',
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Project content search eval",
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
        userName: "Project Search Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Inspect the existing project "${projectName}".`,
          `Find the source file containing the exact marker ${SEARCH_MARKER}; I am not giving you its path.`,
          "Read the matching file and reply with its project-relative path and the releaseChannel value.",
          "Do not edit, build, or deploy anything.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 0,
        }),
      );
      const notFoundTools = findTopLevelSearchNotFound(result);
      const answer = result.result ?? "";
      const reportedPath = answer.includes(EXPECTED_PATH);
      const reportedValue = answer.toLowerCase().includes(EXPECTED_VALUE);
      const fileRead = await files.readFile(`/${EXPECTED_PATH}`);
      const usedSearch =
        usedTool(result.events, "grep") || usedTool(result.events, "find");
      const successfulSearch =
        succeededWithTool(result.events, "grep") ||
        succeededWithTool(result.events, "find");

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "no_top_level_search_not_found",
            label: "Search did not hit an unavailable top-level tool",
            passed: notFoundTools.length === 0,
            reason:
              notFoundTools.length === 0
                ? undefined
                : `Search tools were rejected as not found: ${notFoundTools.join(", ")}.`,
            details: { notFoundTools, toolCallsByName: signal.toolCallsByName },
          }),
          passFailCriterion({
            id: "reported_matching_source",
            label: "Agent reported the matching source path and value",
            passed: reportedPath && reportedValue,
            reason:
              reportedPath && reportedValue
                ? undefined
                : "The final response omitted the expected project-relative path or release-channel value.",
            details: { reportedPath, reportedValue },
          }),
          passFailCriterion({
            id: "seeded_source_intact",
            label: "The grounded source remained intact",
            passed:
              fileRead.success &&
              fileRead.content?.includes(SEARCH_MARKER) === true &&
              fileRead.content?.includes(`"${EXPECTED_VALUE}"`) === true,
            reason: fileRead.success
              ? "The seeded matching file was changed unexpectedly."
              : (fileRead.error ??
                "The seeded matching file could not be read."),
            details: {
              success: fileRead.success,
              markerPresent: fileRead.content?.includes(SEARCH_MARKER) === true,
              valuePresent:
                fileRead.content?.includes(`"${EXPECTED_VALUE}"`) === true,
            },
          }),
          buildHarnessIntegrityCriterion(signal),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 5,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 4, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 6, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 8, maxBadToolCalls: 1, points: 2 },
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
          notFoundTools,
          reportedPath,
          reportedValue,
          usedSearch,
          successfulSearch,
          fileRead: {
            success: fileRead.success,
            expectedPath: EXPECTED_PATH,
            markerPresent: fileRead.content?.includes(SEARCH_MARKER) === true,
          },
          toolCallsByName: signal.toolCallsByName,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
