import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import { defaultProjectScaffoldFiles } from "../../src/project-scaffold";
import { ProjectFilesystemClient } from "../../src/workspace-filesystem-do";
import type {
  WorkspaceFilesystemDO,
  WorkspaceProject,
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
import {
  assertDeployedApp,
  countWorkspaceApps,
  type EvalDeployedApp,
} from "./eval-deploy-assert";
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
  collectRuntimeEvidence,
  fetchWithRetry,
  legacyDeployPathEvidence,
  runtimeToolMentionOrder,
  usedTool,
} from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type ProjectRevertRedeployEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  APP_DB?: D1Database;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

type AppSmoke = {
  status?: number;
  bodyLength?: number;
  hasRestoredMarker: boolean;
  hasBrokenMarker: boolean;
  error?: string;
};

const PROJECT_NAME = "versioned-notes-live";
const BASELINE_MESSAGE = "last good live version";
const RESTORED_MARKER = "RESTORED_LIVE_VERSION_MARKER";
const BROKEN_MARKER = "BROKEN_LIVE_VERSION_MARKER";

const testEnv = env as unknown as ProjectRevertRedeployEvalEnv;
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 900_000);

function homeRoute(marker: string, label: string): string {
  return [
    `export function meta() {`,
    `  return [{ title: "Versioned Notes Live" }];`,
    `}`,
    ``,
    `export default function Home() {`,
    `  return (`,
    `    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", fontFamily: "Inter, system-ui, sans-serif" }}>`,
    `      <section style={{ maxWidth: 720, padding: 32 }}>`,
    `        <p>Versioned Notes Live</p>`,
    `        <h1>${marker}</h1>`,
    `        <p>${label}</p>`,
    `      </section>`,
    `    </main>`,
    `  );`,
    `}`,
    ``,
  ].join("\n");
}

async function seedVersionedProject(workspaceId: string): Promise<{
  project: WorkspaceProject;
  baselineSnapshot: unknown;
}> {
  const workspaceFs = testEnv.WORKSPACE_FS.get(
    testEnv.WORKSPACE_FS.idFromName(workspaceId),
  );
  const project = await workspaceFs.createProject({
    name: PROJECT_NAME,
    description: "Rollback and redeploy eval fixture.",
    backend: "do-r2",
    workspaceId,
  });
  const files = new ProjectFilesystemClient(testEnv, project.id);
  for (const file of defaultProjectScaffoldFiles(PROJECT_NAME, "crud", PROJECT_NAME)) {
    await files.writeFile(file.path, file.content);
  }
  await files.writeFile(
    "/app/routes/home.tsx",
    homeRoute(RESTORED_MARKER, "This is the source snapshot that must be published."),
  );
  await files.writeFile(
    "/README.md",
    `# Versioned Notes Live\n\nMarker: ${RESTORED_MARKER}\n`,
  );
  const baselineSnapshot = await files.createSourceSnapshot({ message: BASELINE_MESSAGE });
  await files.writeFile(
    "/app/routes/home.tsx",
    homeRoute(BROKEN_MARKER, "This broken edit should not be deployed."),
  );
  await files.writeFile(
    "/README.md",
    `# Versioned Notes Live\n\nMarker: ${BROKEN_MARKER}\n`,
  );
  return { project, baselineSnapshot };
}

async function inspectSource(project: WorkspaceProject): Promise<{
  readSuccess: boolean;
  route?: string;
  readme?: string;
  hasRestoredMarker: boolean;
  hasBrokenMarker: boolean;
  error?: string;
}> {
  const files = new ProjectFilesystemClient(testEnv, project.id);
  const route = await files.readFile("/app/routes/home.tsx");
  const readme = await files.readFile("/README.md");
  const text = `${route.content ?? ""}\n${readme.content ?? ""}`;
  return {
    readSuccess: route.success && readme.success,
    route: route.content,
    readme: readme.content,
    hasRestoredMarker: text.includes(RESTORED_MARKER),
    hasBrokenMarker: text.includes(BROKEN_MARKER),
    error: route.error ?? readme.error,
  };
}

async function smokeApp(app: EvalDeployedApp | undefined): Promise<AppSmoke> {
  if (!app) {
    return {
      hasRestoredMarker: false,
      hasBrokenMarker: false,
      error: "no deployed app was captured",
    };
  }
  try {
    const response = await fetchWithRetry(app.url);
    const body = await response.text();
    return {
      status: response.status,
      bodyLength: body.length,
      hasRestoredMarker: body.includes(RESTORED_MARKER),
      hasBrokenMarker: body.includes(BROKEN_MARKER),
    };
  } catch (error) {
    return {
      hasRestoredMarker: false,
      hasBrokenMarker: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function orderedRestoreDeploy(order: string[]): boolean {
  const listIndex = order.indexOf("list_commits");
  const revertIndex = order.indexOf("revert_project");
  const deployIndex = order.indexOf("deploy_project");
  return listIndex >= 0 && revertIndex > listIndex && deployIndex > revertIndex;
}

describe("project revert and redeploy agent eval", () => {
  maybeIt(
    "asks the agent to restore a source snapshot and publish it live",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `project-redeploy-eval-${suffix}@example.com`,
        "password123",
        "Project Redeploy Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Project Redeploy Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const { project, baselineSnapshot } = await seedVersionedProject(defaultWorkspaceId);
      const appsBefore = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Project revert and redeploy eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Project Redeploy Eval",
        userEmail: `project-redeploy-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `The existing DO-backed React Router project named exactly "${PROJECT_NAME}" has broken current source containing "${BROKEN_MARKER}".`,
          `Use js_exec to call await tools.camel__list_commits({ project: "${PROJECT_NAME}" }) and find the source snapshot with message exactly "${BASELINE_MESSAGE}" that contains "${RESTORED_MARKER}"; list_commits is not a top-level tool.`,
          `Use js_exec to call await tools.camel__revert_project({ project: "${PROJECT_NAME}", snapshot_id }), then call the deploy_project tool directly (not from js_exec: its 120-second limit is shorter than a deploy) with { project: "${PROJECT_NAME}", script_name: "${PROJECT_NAME}" } to publish the restored source live; revert_project is not a top-level tool.`,
          "Do not create a new project, do not use rollback_deploy, and do not use wrangler or legacy VM commands.",
          `After deployment, reply with the deployed URL and the restored marker "${RESTORED_MARKER}".`,
        ].join(" "),
      });

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const projects = await workspaceFs.listProjectsForMigrationReset();
      const matchingProjects = projects.filter((candidate) => candidate.name === PROJECT_NAME);
      const appsAfter = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      const sourceInspection = await inspectSource(project);
      let deployedApp: EvalDeployedApp | undefined;
      let deployedAppError: string | undefined;
      try {
        deployedApp = assertDeployedApp(result, {
          name: PROJECT_NAME,
          hostSuffix: ".evals.camelai.app",
        });
      } catch (error) {
        deployedAppError = error instanceof Error ? error.message : String(error);
      }
      const appSmoke = await smokeApp(deployedApp);
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 14,
          maxBadToolCalls: 2,
        }),
      );
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const order = runtimeToolMentionOrder(result.events, [
        "list_commits",
        "revert_project",
        "deploy_project",
      ]);
      const runtimeAssertions = {
        usedListCommits: usedTool(result.events, "list_commits"),
        usedRevertProject: usedTool(result.events, "revert_project"),
        usedDeployProject: usedTool(result.events, "deploy_project"),
        usedCreateProject: usedTool(result.events, "create_project"),
        usedRollbackDeploy: usedTool(result.events, "rollback_deploy"),
        toolOrder: order,
        orderedRestoreDeploy: orderedRestoreDeploy(order),
        legacyFailures,
        evidence: collectRuntimeEvidence(result.events),
      };
      const finalResult = result.result ?? "";

      const sourceRestored =
        sourceInspection.readSuccess &&
        sourceInspection.hasRestoredMarker &&
        !sourceInspection.hasBrokenMarker;
      const liveRestored =
        appSmoke.status === 200 &&
        appSmoke.hasRestoredMarker &&
        !appSmoke.hasBrokenMarker;

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "used_existing_project",
            label: "Agent used the existing project instead of creating another",
            passed:
              matchingProjects.length === 1 &&
              !runtimeAssertions.usedCreateProject,
            reason:
              matchingProjects.length === 1 && !runtimeAssertions.usedCreateProject
                ? undefined
                : `matchingProjects=${matchingProjects.length}, usedCreateProject=${runtimeAssertions.usedCreateProject}`,
            details: { matchingProjects, runtimeAssertions },
          }),
          passFailCriterion({
            id: "used_snapshot_tools",
            label: "Agent used list_commits, revert_project, and deploy_project",
            passed:
              runtimeAssertions.usedListCommits &&
              runtimeAssertions.usedRevertProject &&
              runtimeAssertions.usedDeployProject,
            reason:
              runtimeAssertions.usedListCommits &&
              runtimeAssertions.usedRevertProject &&
              runtimeAssertions.usedDeployProject
                ? undefined
                : `list_commits=${runtimeAssertions.usedListCommits}, revert_project=${runtimeAssertions.usedRevertProject}, deploy_project=${runtimeAssertions.usedDeployProject}`,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "avoided_wrong_rollback_paths",
            label: "Agent avoided rollback_deploy and legacy scaffold/deploy paths",
            passed:
              !runtimeAssertions.usedRollbackDeploy &&
              legacyFailures.length === 0,
            reason:
              !runtimeAssertions.usedRollbackDeploy && legacyFailures.length === 0
                ? undefined
                : [
                    runtimeAssertions.usedRollbackDeploy ? "used rollback_deploy" : "",
                    ...legacyFailures,
                  ].filter(Boolean).join("; "),
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "source_restored",
            label: "Project source was restored from the baseline snapshot",
            passed: sourceRestored,
            reason: sourceRestored
              ? undefined
              : sourceInspection.error ?? "Source did not include restored marker or still included broken marker.",
            details: { sourceInspection, baselineSnapshot },
          }),
          passFailCriterion({
            id: "workspace_app_deployed",
            label: "A workspace app was deployed",
            passed: appsAfter === appsBefore + 1 && Boolean(deployedApp),
            reason:
              appsAfter === appsBefore + 1 && deployedApp
                ? undefined
                : deployedAppError ?? `Expected app count to increase by one; before=${appsBefore}, after=${appsAfter}`,
            details: { appsBefore, appsAfter, deployedApp },
          }),
          passFailCriterion({
            id: "live_app_restored",
            label: "Live app serves the restored marker and not the broken marker",
            passed: liveRestored,
            reason: liveRestored
              ? undefined
              : appSmoke.error ?? `status=${appSmoke.status}, restored=${appSmoke.hasRestoredMarker}, broken=${appSmoke.hasBrokenMarker}`,
            details: appSmoke,
          }),
          passFailCriterion({
            id: "final_response_mentions_restored_marker",
            label: "Final response mentions the restored marker",
            passed: finalResult.includes(RESTORED_MARKER),
            reason: finalResult.includes(RESTORED_MARKER)
              ? undefined
              : "Final response did not include the restored marker.",
            details: { finalResult },
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "restore_flow_order",
            label: "list_commits preceded revert_project, which preceded deploy_project",
            points: runtimeAssertions.orderedRestoreDeploy ? 2 : 0,
            maxPoints: 2,
            reason: `Observed order: ${order.join(" -> ") || "none"}.`,
            details: { order },
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 14, maxBadToolCalls: 2, points: 4 },
              { maxAssistantTurns: 20, maxBadToolCalls: 4, points: 3 },
              { maxAssistantTurns: 28, maxBadToolCalls: 8, points: 2 },
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
        baselineSnapshot,
        runtimeAssertions,
        sourceInspection,
        appSmoke,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 120_000,
  );
});
