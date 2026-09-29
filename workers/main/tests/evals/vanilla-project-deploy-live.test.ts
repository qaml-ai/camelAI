import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";
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
  assertDeployedApp,
  countWorkspaceApps,
  type EvalDeployedApp,
} from "./eval-deploy-assert";
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
  fetchWithRetry,
  toolCallReferences,
  usedTool,
} from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type VanillaDeployEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

type LiveSmoke = {
  status?: number;
  bodyLength?: number;
  markerFound: boolean;
  error?: string;
};

const testEnv = env as unknown as VanillaDeployEvalEnv;
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 900_000);
const MARKER = "Vanilla web starter";

async function smokeApp(app: EvalDeployedApp | undefined): Promise<LiveSmoke> {
  if (!app) return { markerFound: false, error: "no deployed app was captured" };
  try {
    const response = await fetchWithRetry(app.url);
    const body = await response.text();
    return {
      status: response.status,
      bodyLength: body.length,
      markerFound: body.includes(MARKER),
    };
  } catch (error) {
    return {
      markerFound: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("vanilla project real deploy agent eval", () => {
  maybeIt(
    "builds and deploys the untouched vanilla scaffold through the platform stack",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const projectName = `vanilla-smoke-${suffix}`;
      const email = `vanilla-deploy-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Vanilla Deploy Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Vanilla Deploy Eval ${suffix}`,
        userId,
      );
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Vanilla project deploy smoke",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const appsBefore = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Vanilla Deploy Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Create a new project named exactly "${projectName}" with a concise description and explicitly select the vanilla starter.`,
          "Do not edit any generated project files and do not install dependencies.",
          `Deploy it through js_exec with await tools.deploy_project({ project: "${projectName}", script_name: "${projectName}" }).`,
          "Do not use shell commands, wrangler deploy, or any legacy VM path.",
          "Reply with the deployed URL after the platform deploy succeeds.",
        ].join(" "),
      });

      const projects = await workspaceFs.listProjectsForMigrationReset();
      const project = projects.find((candidate) => candidate.name === projectName);
      const appsAfter = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      let deployedApp: EvalDeployedApp | undefined;
      let deployedAppError: string | undefined;
      try {
        deployedApp = assertDeployedApp(result, {
          name: projectName,
          hostSuffix: ".evals.camelai.app",
        });
      } catch (error) {
        deployedAppError = error instanceof Error ? error.message : String(error);
      }
      const smoke = await smokeApp(deployedApp);
      const usedCreateProject = usedTool(result.events, "create_project");
      const selectedVanilla = toolCallReferences(
        result.events,
        "create_project",
        "vanilla",
      );
      const usedDeployProject = usedTool(result.events, "deploy_project");
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 12,
          maxBadToolCalls: 1,
        }),
      );
      const runtimeAssertions = {
        usedCreateProject,
        selectedVanilla,
        usedDeployProject,
        evidence: collectRuntimeEvidence(result.events),
      };
      const deployedAndServed =
        smoke.status === 200 &&
        (smoke.bodyLength ?? 0) > 0 &&
        smoke.markerFound;
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "vanilla_project_created",
            label: "Agent created the vanilla DO-backed project",
            passed:
              project?.backend === "do-r2" &&
              usedCreateProject &&
              selectedVanilla,
            reason: project
              ? `backend=${project.backend}; create_project=${usedCreateProject}; vanilla=${selectedVanilla}`
              : "Requested project was not created.",
            details: { project, runtimeAssertions },
          }),
          passFailCriterion({
            id: "platform_deploy_used",
            label: "Agent used deploy_project",
            passed: usedDeployProject,
            reason: usedDeployProject ? undefined : "deploy_project was not called.",
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "workspace_app_created",
            label: "Deploy registered one workspace app",
            passed: appsAfter === appsBefore + 1,
            reason:
              appsAfter === appsBefore + 1
                ? undefined
                : `Expected one new app; before=${appsBefore}, after=${appsAfter}.`,
            details: { appsBefore, appsAfter },
          }),
          passFailCriterion({
            id: "real_eval_url_deployed",
            label: "Deploy produced a real testing-grounds URL",
            passed: Boolean(deployedApp),
            reason: deployedApp ? undefined : deployedAppError,
            details: { deployedApp },
          }),
          passFailCriterion({
            id: "deployed_vanilla_app_served",
            label: "Deployed vanilla app returned its generated HTML",
            passed: deployedAndServed,
            reason: deployedAndServed
              ? undefined
              : smoke.error ?? `status=${smoke.status}; markerFound=${smoke.markerFound}`,
            details: smoke,
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, {
            maxPoints: 8,
            fallbackPoints: 2,
            tiers: [
              { maxAssistantTurns: 8, maxBadToolCalls: 0, points: 8 },
              { maxAssistantTurns: 12, maxBadToolCalls: 1, points: 6 },
              { maxAssistantTurns: 18, maxBadToolCalls: 3, points: 4 },
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
        deployedApps: result.deployedApps,
        project,
        deployedApp,
        smoke,
        runtimeAssertions,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });
      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 120_000,
  );
});
