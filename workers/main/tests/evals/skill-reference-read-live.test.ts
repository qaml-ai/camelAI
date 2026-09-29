import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import {
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
  scoreSignalEfficiency,
} from "./eval-criteria";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import { emitEvalTranscript } from "./eval-transcript";
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";
import {
  collectRuntimeEvidence,
  seedDoProjectFiles,
  toolCallReferences,
  usedTool,
} from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type SkillReferenceReadEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as SkillReferenceReadEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 180_000);
describe("skill reference read agent eval", () => {
  maybeIt(
    "reads a starter-specific skill reference without misrouting it into the project",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const projectName = `skill-reader-${suffix}`;
      const email = `skill-reader-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Skill Reference Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Skill Reference Eval ${suffix}`,
        userId,
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Skill reference read",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const { project } = await seedDoProjectFiles(workspaceFs, testEnv, {
        workspaceId: defaultWorkspaceId,
        name: projectName,
        description: "Existing client-only keyboard-controlled canvas game",
        template: "vanilla",
        files: {},
      });
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Skill Reference Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Continue work on the existing project named exactly "${projectName}".`,
          "It uses the vanilla starter for a client-only keyboard-controlled canvas game.",
          "Inspect public/index.html, then follow the developing-software skill and read its relevant starter-specific reference.",
          "Reply with one concrete canvas verification recommendation from that reference.",
          "Do not modify files, create another project, build, deploy, or install dependencies.",
        ].join(" "),
      });

      const readRootSkill = toolCallReferences(
        result.events,
        "read_skill",
        "developing-software",
      );
      const readVanillaReference = toolCallReferences(
        result.events,
        "read_skill",
        "VANILLA-APPS.md",
      );
      const inspectedProjectFile = toolCallReferences(
        result.events,
        "read",
        "public/index.html",
      );
      const usedGenericSkillRead =
        toolCallReferences(result.events, "read", "SKILL.md") ||
        toolCallReferences(result.events, "read", "VANILLA-APPS.md");
      const usedCreateProject = usedTool(result.events, "create_project");
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 10,
          maxBadToolCalls: 0,
        }),
      );
      const failedSkillReads = signal.badToolCalls.filter(
        (call) => call.tool === "read" || call.tool === "read_skill",
      );
      const runtimeAssertions = {
        readRootSkill,
        readVanillaReference,
        inspectedProjectFile,
        usedGenericSkillRead,
        usedCreateProject,
        failedSkillReads,
        evidence: collectRuntimeEvidence(result.events),
      };
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "read_root_skill",
            label: "Agent successfully read the developing-software skill",
            passed: readRootSkill,
            reason: readRootSkill ? undefined : "No successful root skill read was observed.",
          }),
          passFailCriterion({
            id: "read_vanilla_reference",
            label: "Agent successfully read the vanilla skill reference",
            passed: readVanillaReference,
            reason: readVanillaReference
              ? undefined
              : "No successful VANILLA-APPS.md skill read was observed.",
          }),
          passFailCriterion({
            id: "no_generic_skill_read",
            label: "Agent used read_skill rather than generic file reads for skills",
            passed: !usedGenericSkillRead,
            reason: usedGenericSkillRead
              ? "A successful generic read call referenced a bundled skill file."
              : undefined,
          }),
          passFailCriterion({
            id: "no_misrouted_skill_reads",
            label: "Agent did not misroute skill reads into project storage",
            passed: failedSkillReads.length === 0,
            reason: failedSkillReads.length
              ? `${failedSkillReads.length} skill read call(s) failed.`
              : undefined,
            details: failedSkillReads,
          }),
          passFailCriterion({
            id: "existing_project_inspected",
            label: "Agent inspected the existing vanilla project without recreating it",
            passed:
              project.backend === "do-r2" &&
              !usedCreateProject &&
              inspectedProjectFile,
            reason:
              project.backend === "do-r2" && !usedCreateProject && inspectedProjectFile
                ? undefined
                : `backend=${project.backend}; create=${usedCreateProject}; inspected=${inspectedProjectFile}`,
            details: { project },
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
              { maxAssistantTurns: 6, maxBadToolCalls: 0, points: 5 },
              { maxAssistantTurns: 10, maxBadToolCalls: 0, points: 3 },
              { maxAssistantTurns: 14, maxBadToolCalls: 1, points: 1 },
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
        project,
        runtimeAssertions,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });
      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
