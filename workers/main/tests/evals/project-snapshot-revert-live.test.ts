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
import { emitEvalTranscript } from "./eval-transcript";
import {
  collectRuntimeEvidence,
  legacyDeployPathEvidence,
  usedTool,
} from "./project-eval-helpers";
import { ProjectFilesystemClient } from "../../src/workspace-filesystem-do";
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";
import { runRuntimeEval } from "./runtime-eval";

type ProjectSnapshotRevertEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
};

const PROJECT_NAME = "versioned-notes";
const BASELINE_MESSAGE = "baseline versioned notes";
const RESTORED_MARKER = "RESTORED_VERSIONED_NOTES_BASELINE";
const BROKEN_MARKER = "BROKEN_VERSION_SHOULD_BE_REVERTED";
const BASELINE_README = [
  "# Versioned Notes",
  "",
  `Marker: ${RESTORED_MARKER}`,
  "This is the baseline source snapshot the agent should restore.",
  "",
].join("\n");
const BROKEN_README = [
  "# Versioned Notes",
  "",
  `Marker: ${BROKEN_MARKER}`,
  "This later edit should disappear after revert_project runs.",
  "",
].join("\n");

const testEnv = env as unknown as ProjectSnapshotRevertEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);

describe("project snapshot revert agent eval", () => {
  maybeIt(
    "asks the agent to discover and restore a DO-backed project source snapshot",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `project-revert-eval-${suffix}@example.com`,
        "password123",
        "Project Revert Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Project Revert Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Project snapshot revert eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        name: PROJECT_NAME,
        description: "Project snapshot revert eval fixture.",
        backend: "do-r2",
        workspaceId: defaultWorkspaceId,
      });
      const projectFiles = new ProjectFilesystemClient(testEnv, project.id);
      await projectFiles.writeFile("/README.md", BASELINE_README);
      const baselineSnapshot = await projectFiles.createSourceSnapshot({
        message: BASELINE_MESSAGE,
      });
      await projectFiles.writeFile("/README.md", BROKEN_README);

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Project Revert Eval",
        userEmail: `project-revert-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `The existing DO-backed project named "${PROJECT_NAME}" has a broken README edit.`,
          `Use js_exec to call await tools.camel__list_commits({ project: "${PROJECT_NAME}" }) and find the source snapshot with message exactly "${BASELINE_MESSAGE}"; list_commits is not a top-level tool.`,
          `Use js_exec to call await tools.camel__revert_project({ project: "${PROJECT_NAME}", snapshot_id }) to restore that snapshot; revert_project is not a top-level tool. Do not deploy or run build/deploy commands.`,
          "After reverting, read /README.md from the project and reply with the restored marker.",
        ].join(" "),
      });

      const finalRead = await projectFiles.readFile("/README.md");
      const finalReadme = finalRead.content ?? "";
      const snapshots = await projectFiles.listSourceSnapshots(5);
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 8,
          maxBadToolCalls: 1,
        }),
      );
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const runtimeAssertions = {
        usedListCommits: usedTool(result.events, "list_commits"),
        usedRevertProject: usedTool(result.events, "revert_project"),
        usedDeployProject: usedTool(result.events, "deploy_project"),
        legacyFailures,
        evidence: collectRuntimeEvidence(result.events),
      };
      const restored =
        finalRead.success &&
        finalReadme.includes(RESTORED_MARKER) &&
        !finalReadme.includes(BROKEN_MARKER);

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "used_snapshot_tools",
            label: "Agent used source snapshot tools",
            passed:
              runtimeAssertions.usedListCommits &&
              runtimeAssertions.usedRevertProject,
            reason:
              runtimeAssertions.usedListCommits && runtimeAssertions.usedRevertProject
                ? undefined
                : `list_commits=${runtimeAssertions.usedListCommits}, revert_project=${runtimeAssertions.usedRevertProject}`,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "did_not_deploy",
            label: "Agent did not deploy while reverting",
            passed:
              !runtimeAssertions.usedDeployProject && legacyFailures.length === 0,
            reason:
              !runtimeAssertions.usedDeployProject && legacyFailures.length === 0
                ? undefined
                : [
                    runtimeAssertions.usedDeployProject ? "used deploy_project" : "",
                    ...legacyFailures,
                  ].filter(Boolean).join("; "),
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "readme_restored",
            label: "README was restored from the baseline snapshot",
            passed: restored,
            reason: restored
              ? undefined
              : finalRead.error ?? "README did not contain the restored marker or still contained the broken marker.",
            details: {
              finalReadSuccess: finalRead.success,
              finalReadme,
              baselineSnapshot,
              snapshots: snapshots.map((snapshot) => ({
                id: snapshot.id,
                message: snapshot.message,
                fileCount: snapshot.fileCount,
              })),
            },
          }),
          passFailCriterion({
            id: "final_response_mentions_restored_marker",
            label: "Final response mentions the restored marker",
            passed: (result.result ?? "").includes(RESTORED_MARKER),
            reason: (result.result ?? "").includes(RESTORED_MARKER)
              ? undefined
              : `Final response did not include ${RESTORED_MARKER}.`,
            details: { finalResult: result.result },
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
              { maxAssistantTurns: 8, maxBadToolCalls: 1, points: 4 },
              { maxAssistantTurns: 12, maxBadToolCalls: 3, points: 3 },
              { maxAssistantTurns: 18, maxBadToolCalls: 6, points: 2 },
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
        baselineSnapshot,
        runtimeAssertions,
        finalReadme,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
