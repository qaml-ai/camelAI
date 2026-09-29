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
import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import {
  assertDeployedApp,
  countWorkspaceApps,
  type EvalDeployedApp,
} from "./eval-deploy-assert";
import { emitEvalTranscript } from "./eval-transcript";
import {
  asRecord,
  collectRuntimeEvidence,
  fetchWithRetry,
  legacyDeployPathEvidence,
  usedTool,
} from "./project-eval-helpers";
import { ProjectFilesystemClient } from "../../src/workspace-filesystem-do";
import type {
  WorkspaceFilesystemDO,
  WorkspaceProject,
} from "../../src/workspace-filesystem-do";
import { runRuntimeEval } from "./runtime-eval";

type DoBackedDeployEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  APP_DB?: D1Database;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

type AppSmoke = {
  root?: {
    status?: number;
    bodyLength?: number;
    hasTitle: boolean;
    hasCounterLabel: boolean;
    errorStrings: string[];
    error?: string;
  };
  api?: {
    beforeStatus?: number;
    postStatus?: number;
    afterStatus?: number;
    beforeCount?: number;
    postCount?: number;
    afterCount?: number;
    error?: string;
  };
  failures: string[];
};

type SourceInspection = {
  packageHasZod: boolean;
  wranglerHasDurableObjectBinding: boolean;
  wranglerHasMigration: boolean;
  sourceHasDurableObject: boolean;
  sourceHasTitle: boolean;
  packageError?: string;
  wranglerError?: string;
  workerError?: string;
  homeRouteError?: string;
};

const PROJECT_NAME = "event-check-in";
const APP_TITLE = "Event Check-In Console";
const COUNTER_LABEL = "Total check-ins";
const testEnv = env as unknown as DoBackedDeployEvalEnv;
// This eval publishes a live app in the testing-grounds namespace and verifies
// Durable Object persistence through the deployed URL.
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 900_000);

function parseJsonObject(text: string | undefined): Record<string, unknown> {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

async function readProjectText(
  projectId: string | undefined,
  path: string,
): Promise<{ text?: string; error?: string }> {
  if (!projectId) return { error: "project was not created" };
  const result = await new ProjectFilesystemClient(testEnv, projectId).readFile(path);
  if (!result.success) return { error: result.error ?? `failed to read ${path}` };
  return { text: result.content ?? "" };
}

async function inspectProjectSource(
  project: WorkspaceProject | undefined,
): Promise<SourceInspection> {
  const packageRead = await readProjectText(project?.id, "/package.json");
  const wranglerRead = await readProjectText(project?.id, "/wrangler.jsonc");
  const workerRead = await readProjectText(project?.id, "/workers/app.ts");
  const homeRouteRead = await readProjectText(project?.id, "/app/routes/home.tsx");
  const packageJson = parseJsonObject(packageRead.text);
  const dependencies = asRecord(packageJson.dependencies) ?? {};
  const devDependencies = asRecord(packageJson.devDependencies) ?? {};
  const wrangler = wranglerRead.text ?? "";
  const workerSource = workerRead.text ?? "";
  const homeRouteSource = homeRouteRead.text ?? "";

  return {
    packageHasZod: Boolean(dependencies.zod || devDependencies.zod),
    wranglerHasDurableObjectBinding:
      wrangler.includes("durable_objects") && wrangler.includes("CHECKINS"),
    wranglerHasMigration:
      wrangler.includes("migrations") &&
      /new_(?:sqlite_)?classes|renamed_classes|deleted_classes/.test(wrangler),
    sourceHasDurableObject:
      /class\s+\w+\s+extends\s+DurableObject/.test(workerSource) ||
      workerSource.includes("DurableObjectState"),
    sourceHasTitle:
      workerSource.includes(APP_TITLE) || homeRouteSource.includes(APP_TITLE),
    packageError: packageRead.error,
    wranglerError: wranglerRead.error,
    workerError: workerRead.error,
    homeRouteError: homeRouteRead.error,
  };
}

function appUrl(app: EvalDeployedApp, path: string): string {
  return new URL(path, app.url).toString();
}

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const parsed = await response.json();
    return asRecord(parsed) ?? {};
  } catch {
    return {};
  }
}

function countFromJson(value: Record<string, unknown>): number | undefined {
  const count = value.count;
  if (typeof count === "number" && Number.isFinite(count)) return count;
  const dataCount = asRecord(value.data)?.count;
  return typeof dataCount === "number" && Number.isFinite(dataCount)
    ? dataCount
    : undefined;
}

async function smokeCheckDeployedApp(
  app: EvalDeployedApp | undefined,
): Promise<AppSmoke> {
  const failures: string[] = [];
  if (!app) return { failures: ["no deployed app was captured"] };

  const smoke: AppSmoke = { failures };
  try {
    const rootResponse = await fetchWithRetry(app.url);
    const body = await rootResponse.text();
    const lower = body.toLowerCase();
    const errorStrings = [
      "application error",
      "internal server error",
      "not found",
      "stack trace",
    ].filter((term) => lower.includes(term));
    smoke.root = {
      status: rootResponse.status,
      bodyLength: body.length,
      hasTitle: body.includes(APP_TITLE),
      hasCounterLabel: body.includes(COUNTER_LABEL),
      errorStrings,
    };
    if (rootResponse.status !== 200 || body.length === 0) {
      failures.push(
        `root returned HTTP ${rootResponse.status} with ${body.length} bytes`,
      );
    }
    if (!body.includes(APP_TITLE)) failures.push(`root did not include ${APP_TITLE}`);
    if (!body.includes(COUNTER_LABEL)) {
      failures.push(`root did not include ${COUNTER_LABEL}`);
    }
    if (errorStrings.length) {
      failures.push(`root contained error marker(s): ${errorStrings.join(", ")}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    smoke.root = {
      hasTitle: false,
      hasCounterLabel: false,
      errorStrings: [],
      error: message,
    };
    failures.push(`root fetch failed: ${message}`);
  }

  try {
    const before = await fetchWithRetry(appUrl(app, "/api/checkins"));
    const beforeJson = await responseJson(before);
    const post = await fetchWithRetry(appUrl(app, "/api/checkins"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada Lovelace" }),
    });
    const postJson = await responseJson(post);
    const after = await fetchWithRetry(appUrl(app, "/api/checkins"));
    const afterJson = await responseJson(after);
    const beforeCount = countFromJson(beforeJson);
    const postCount = countFromJson(postJson);
    const afterCount = countFromJson(afterJson);
    smoke.api = {
      beforeStatus: before.status,
      postStatus: post.status,
      afterStatus: after.status,
      beforeCount,
      postCount,
      afterCount,
    };
    if (before.status !== 200) failures.push(`GET before returned HTTP ${before.status}`);
    if (post.status < 200 || post.status >= 300) {
      failures.push(`POST returned HTTP ${post.status}`);
    }
    if (after.status !== 200) failures.push(`GET after returned HTTP ${after.status}`);
    if (afterCount === undefined) failures.push("GET after did not return a numeric count");
    if (beforeCount !== undefined && afterCount !== undefined && afterCount < beforeCount + 1) {
      failures.push(
        `count did not persist/increment; before=${beforeCount}, after=${afterCount}`,
      );
    }
    if (postCount !== undefined && afterCount !== undefined && afterCount < postCount) {
      failures.push(
        `GET after did not reflect POST count; post=${postCount}, after=${afterCount}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    smoke.api = { error: message };
    failures.push(`check-in API smoke failed: ${message}`);
  }

  return smoke;
}

describe("DO-backed project deploy agent eval", () => {
  maybeIt(
    "asks the agent to create and deploy a DO-backed Durable Object app",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `do-project-deploy-eval-${suffix}@example.com`,
        "password123",
        "DO Project Deploy Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `DO Project Deploy Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "DO-backed project deploy eval",
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
        userName: "DO Project Deploy Eval",
        userEmail: `do-project-deploy-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Create a new DO-backed React Router project named exactly "${PROJECT_NAME}" using create_project with a concise description.`,
          "Use the default deployable React Router scaffold; do not use the data-analysis template for this web app.",
          "Use js_exec to call `await tools.camel__add_dependency({ project: \"event-check-in\", dependency: \"zod\" })`; add_dependency is not a top-level tool.",
          `Update the root React page so the deployed HTML contains the exact text "${APP_TITLE}" and "${COUNTER_LABEL}".`,
          "Update workers/app.ts so the Worker exports a Durable Object-backed check-in counter class and intercepts /api/checkins before falling through to React Router.",
          "Use Durable Object binding name CHECKINS. Add GET /api/checkins returning JSON with a numeric count, and POST /api/checkins accepting JSON { name: string }, validating it with zod, incrementing the Durable Object count, and returning JSON with the numeric count.",
          "Ensure the wrangler config/build manifest preserves durable_objects and migrations for that Durable Object.",
          `Call the deploy_project tool directly with { project: "${PROJECT_NAME}", script_name: "${PROJECT_NAME}" } (not from js_exec: its 120-second limit is shorter than a deploy).`,
          "Do not use legacy VM work, create-worker, wrangler deploy, or bun run deploy for this DO-backed project.",
          "When done, reply with the deployed URL and the current check-in count.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 24,
          maxBadToolCalls: 4,
        }),
      );
      const projects = await workspaceFs.listProjectsForMigrationReset();
      const project = projects.find((candidate) => candidate.name === PROJECT_NAME);
      const sourceInspection = await inspectProjectSource(project);
      const appsAfter = await countWorkspaceApps(orgStub, defaultWorkspaceId);
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
      const appSmoke = await smokeCheckDeployedApp(deployedApp);
      const runtimeEvidence = collectRuntimeEvidence(result.events);
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const runtimeAssertions = {
        usedCreateProject: usedTool(result.events, "create_project", [
          /\bPROJECTS\s*\.\s*create\s*\(/i,
        ]),
        usedAddDependency: usedTool(result.events, "add_dependency"),
        usedDeployProject: usedTool(result.events, "deploy_project"),
        legacyFailures,
        evidence: runtimeEvidence,
      };

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "project_created_do_backed",
            label: "Agent created a DO-backed project",
            passed: project?.backend === "do-r2",
            reason: project
              ? `Project backend was ${project.backend}`
              : `No project named ${PROJECT_NAME} was created.`,
            details: { project },
          }),
          passFailCriterion({
            id: "used_platform_project_tools",
            label: "Agent used platform project tools",
            passed:
              runtimeAssertions.usedCreateProject &&
              runtimeAssertions.usedAddDependency &&
              runtimeAssertions.usedDeployProject,
            reason:
              runtimeAssertions.usedCreateProject &&
              runtimeAssertions.usedAddDependency &&
              runtimeAssertions.usedDeployProject
                ? undefined
                : `create_project=${runtimeAssertions.usedCreateProject}, add_dependency=${runtimeAssertions.usedAddDependency}, deploy_project=${runtimeAssertions.usedDeployProject}`,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "zod_dependency_persisted",
            label: "zod dependency persisted",
            passed: sourceInspection.packageHasZod,
            reason: sourceInspection.packageHasZod
              ? undefined
              : sourceInspection.packageError ?? "package.json did not include zod",
            details: sourceInspection,
          }),
          passFailCriterion({
            id: "durable_object_source_configured",
            label: "Durable Object source/config is present",
            passed:
              sourceInspection.wranglerHasDurableObjectBinding &&
              sourceInspection.wranglerHasMigration &&
              sourceInspection.sourceHasDurableObject &&
              sourceInspection.sourceHasTitle,
            reason:
              sourceInspection.wranglerHasDurableObjectBinding &&
              sourceInspection.wranglerHasMigration &&
              sourceInspection.sourceHasDurableObject &&
              sourceInspection.sourceHasTitle
                ? undefined
                : "Missing Durable Object binding, migration, DurableObject source, or title marker.",
            details: sourceInspection,
          }),
          passFailCriterion({
            id: "avoided_legacy_deploy_path",
            label: "Agent avoided legacy scaffold/deploy paths",
            passed: legacyFailures.length === 0,
            reason: legacyFailures.length ? legacyFailures.join("; ") : undefined,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "workspace_app_created",
            label: "Workspace app was created",
            passed: appsAfter === appsBefore + 1,
            reason:
              appsAfter === appsBefore + 1
                ? undefined
                : `Expected app count to increase by one; before=${appsBefore}, after=${appsAfter}.`,
            details: { appsBefore, appsAfter },
          }),
          passFailCriterion({
            id: "eval_app_url_deployed",
            label: "A real eval app URL was deployed",
            passed: Boolean(deployedApp),
            reason: deployedApp ? undefined : deployedAppError,
            details: { deployedApp },
          }),
          passFailCriterion({
            id: "deployed_app_smoke_passed",
            label: "Deployed app root and API smoke passed",
            passed: appSmoke.failures.length === 0,
            reason: appSmoke.failures.length ? appSmoke.failures.join("; ") : undefined,
            details: appSmoke,
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
              { maxAssistantTurns: 24, maxBadToolCalls: 4, points: 4 },
              { maxAssistantTurns: 32, maxBadToolCalls: 8, points: 3 },
              { maxAssistantTurns: 44, maxBadToolCalls: 16, points: 2 },
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
