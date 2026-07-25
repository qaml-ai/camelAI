import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import { ProjectFilesystemClient } from "../../src/workspace-filesystem-do";
import type { ChatThreadDO } from "../../src/chat-thread-do";
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
  asRecord,
  collectRuntimeEvidence,
  fetchWithRetry,
  legacyDeployPathEvidence,
  usedTool,
} from "./project-eval-helpers";
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";

type ProjectUpdateRedeployStateEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  APP_DB?: D1Database;
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

type SourceInspection = {
  readSuccess: boolean;
  packageHasReactRouter: boolean;
  wranglerHasDurableObjectBinding: boolean;
  wranglerHasMigration: boolean;
  sourceHasDurableObject: boolean;
  sourceHasUpdatedMarker: boolean;
  sourceHasInitialMarker: boolean;
  sourcePreservesReportForm: boolean;
  sourcePreservesHistoryPanel: boolean;
  error?: string;
};

type AppSmoke = {
  root?: {
    status?: number;
    bodyLength?: number;
    hasUpdatedMarker: boolean;
    hasInitialMarker: boolean;
    preservesReportForm: boolean;
    preservesHistoryPanel: boolean;
    attempts: number;
    durationMs: number;
  };
  api?: {
    beforeStatus?: number;
    postStatus?: number;
    afterStatus?: number;
    beforeCount?: number;
    postCount?: number;
    afterCount?: number;
    beforeNames?: string[];
    postNames?: string[];
    afterNames?: string[];
  };
  failures: string[];
};

type SeedSmoke = {
  success: boolean;
  app?: EvalDeployedApp;
  ready?: {
    success: boolean;
    attempts: number;
    durationMs: number;
    status?: number;
    count?: number;
    names?: string[];
    error?: string;
  };
  postStatus?: number;
  getStatus?: number;
  postCount?: number;
  getCount?: number;
  getNames?: string[];
  error?: string;
};

const PROJECT_NAME = "stateful-checkins";
const INITIAL_MARKER = "INITIAL_STATEFUL_CHECKINS_MARKER";
const UPDATED_MARKER = "UPDATED_STATEFUL_CHECKINS_MARKER";
const EXISTING_REPORT_FORM_MARKER = "EXISTING_REPORT_FORM_MARKER";
const EXISTING_HISTORY_PANEL_MARKER = "EXISTING_HISTORY_PANEL_MARKER";
const SEEDED_NAME = "eval-seed-before-redeploy";
const testEnv = env as unknown as ProjectUpdateRedeployStateEvalEnv;
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 720_000);
const TEST_TIMEOUT_MS = SESSION_TIMEOUT_MS * 2 + 180_000;

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

function namesFromJson(value: Record<string, unknown>): string[] {
  const rawNames = Array.isArray(value.names)
    ? value.names
    : Array.isArray(asRecord(value.data)?.names)
      ? asRecord(value.data)!.names
      : undefined;
  if (rawNames) {
    return rawNames.filter((name): name is string => typeof name === "string");
  }

  const rawCheckins = Array.isArray(value.checkins)
    ? value.checkins
    : Array.isArray(asRecord(value.data)?.checkins)
      ? asRecord(value.data)!.checkins
      : [];
  return rawCheckins
    .map((entry) => asRecord(entry)?.name)
    .filter((name): name is string => typeof name === "string");
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
  const checkinsDoRead = await readProjectText(project?.id, "/workers/checkins-do.ts");
  const checkinsRead = await readProjectText(project?.id, "/workers/checkins.ts");
  const homeRouteRead = await readProjectText(project?.id, "/app/routes/home.tsx");
  const packageJson = packageRead.text ? JSON.parse(packageRead.text) : {};
  const dependencies = asRecord(packageJson.dependencies) ?? {};
  const devDependencies = asRecord(packageJson.devDependencies) ?? {};
  const text = [
    wranglerRead.text,
    workerRead.text,
    checkinsDoRead.text,
    checkinsRead.text,
    homeRouteRead.text,
  ].join("\n");

  return {
    readSuccess: Boolean(
      packageRead.text && wranglerRead.text && workerRead.text && homeRouteRead.text,
    ),
    packageHasReactRouter: Boolean(
      dependencies["@react-router/cloudflare"] || devDependencies["@react-router/cloudflare"],
    ),
    wranglerHasDurableObjectBinding:
      text.includes("durable_objects") && text.includes("CHECKINS"),
    wranglerHasMigration:
      text.includes("migrations") &&
      /new_(?:sqlite_)?classes|renamed_classes|deleted_classes/.test(text),
    sourceHasDurableObject:
      /class\s+\w*Check\w*\s+extends\s+DurableObject/.test(text) ||
      text.includes("DurableObjectState"),
    sourceHasUpdatedMarker: text.includes(UPDATED_MARKER),
    sourceHasInitialMarker: text.includes(INITIAL_MARKER),
    sourcePreservesReportForm: text.includes(EXISTING_REPORT_FORM_MARKER),
    sourcePreservesHistoryPanel: text.includes(EXISTING_HISTORY_PANEL_MARKER),
    error: packageRead.error ?? wranglerRead.error ?? workerRead.error ?? homeRouteRead.error,
  };
}

async function smokeCheckDeployedApp(
  app: EvalDeployedApp | undefined,
): Promise<AppSmoke> {
  const failures: string[] = [];
  if (!app) return { failures: ["no deployed app was captured"] };

  const smoke: AppSmoke = { failures };
  const rootStartedAt = Date.now();
  let rootAttempts = 0;
  try {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      rootAttempts = attempt + 1;
      const rootUrl = new URL(app.url);
      // A redeploy keeps the public hostname, so bypass an edge-cached copy of
      // the initial HTML while waiting for the new script to become visible.
      rootUrl.searchParams.set("eval_smoke", `${Date.now()}-${attempt}`);
      const root = await fetchWithRetry(rootUrl.toString(), {
        headers: { "cache-control": "no-cache" },
      }, 2);
      const body = await root.text();
      smoke.root = {
        status: root.status,
        bodyLength: body.length,
        hasUpdatedMarker: body.includes(UPDATED_MARKER),
        hasInitialMarker: body.includes(INITIAL_MARKER),
        preservesReportForm: body.includes(EXISTING_REPORT_FORM_MARKER),
        preservesHistoryPanel: body.includes(EXISTING_HISTORY_PANEL_MARKER),
        attempts: rootAttempts,
        durationMs: Date.now() - rootStartedAt,
      };
      if (
        smoke.root.status === 200 &&
        smoke.root.hasUpdatedMarker &&
        !smoke.root.hasInitialMarker &&
        smoke.root.preservesReportForm &&
        smoke.root.preservesHistoryPanel
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 750 * (attempt + 1)));
    }
    if (smoke.root.status !== 200) failures.push(`root returned HTTP ${smoke.root.status}`);
    if (!smoke.root.hasUpdatedMarker) failures.push("root did not include updated marker");
    if (smoke.root.hasInitialMarker) failures.push("root still included initial marker");
    if (!smoke.root.preservesReportForm) {
      failures.push(`root lost ${EXISTING_REPORT_FORM_MARKER}`);
    }
    if (!smoke.root.preservesHistoryPanel) {
      failures.push(`root lost ${EXISTING_HISTORY_PANEL_MARKER}`);
    }
  } catch (error) {
    smoke.root = {
      ...smoke.root,
      hasUpdatedMarker: smoke.root?.hasUpdatedMarker ?? false,
      hasInitialMarker: smoke.root?.hasInitialMarker ?? false,
      preservesReportForm: smoke.root?.preservesReportForm ?? false,
      preservesHistoryPanel: smoke.root?.preservesHistoryPanel ?? false,
      attempts: rootAttempts,
      durationMs: Date.now() - rootStartedAt,
    };
    failures.push(`root fetch failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  try {
    const before = await fetchWithRetry(appUrl(app, "/api/checkins"));
    const beforeJson = await responseJson(before);
    const beforeCount = countFromJson(beforeJson);
    const beforeNames = namesFromJson(beforeJson);
    const post = await fetch(appUrl(app, "/api/checkins"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "eval-post-redeploy" }),
    });
    const postJson = await responseJson(post);
    const postCount = countFromJson(postJson);
    const postNames = namesFromJson(postJson);
    const after = await fetchWithRetry(appUrl(app, "/api/checkins"));
    const afterJson = await responseJson(after);
    const afterCount = countFromJson(afterJson);
    const afterNames = namesFromJson(afterJson);
    smoke.api = {
      beforeStatus: before.status,
      postStatus: post.status,
      afterStatus: after.status,
      beforeCount,
      postCount,
      afterCount,
      beforeNames,
      postNames,
      afterNames,
    };
    if (before.status !== 200) failures.push(`GET before returned HTTP ${before.status}`);
    if (post.status < 200 || post.status >= 300) failures.push(`POST returned HTTP ${post.status}`);
    if (after.status !== 200) failures.push(`GET after returned HTTP ${after.status}`);
    if (beforeCount === undefined) failures.push("GET before did not return a numeric count");
    if (!beforeNames.includes(SEEDED_NAME)) {
      failures.push(`GET before did not preserve seeded name ${SEEDED_NAME}`);
    }
    if (beforeCount !== undefined && (postCount === undefined || postCount <= beforeCount)) {
      failures.push(`POST count ${postCount ?? "missing"} did not increase ${beforeCount}`);
    }
    if (postCount !== undefined && afterCount !== postCount) {
      failures.push(`GET after count ${afterCount ?? "missing"} did not persist POST count ${postCount}`);
    }
  } catch (error) {
    failures.push(`API smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  return smoke;
}

async function waitForCheckinsApiReady(
  app: EvalDeployedApp,
): Promise<NonNullable<SeedSmoke["ready"]>> {
  const startedAt = Date.now();
  let last: NonNullable<SeedSmoke["ready"]> = {
    success: false,
    attempts: 0,
    durationMs: 0,
  };
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      const response = await fetch(appUrl(app, "/api/checkins"));
      const json = await responseJson(response);
      const count = countFromJson(json);
      const names = namesFromJson(json);
      last = {
        success: response.status === 200 && typeof count === "number",
        attempts: attempt + 1,
        durationMs: Date.now() - startedAt,
        status: response.status,
        count,
        names,
      };
      if (last.success) return last;
    } catch (error) {
      last = {
        success: false,
        attempts: attempt + 1,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return last;
}

async function seedLiveCheckinState(
  app: EvalDeployedApp | undefined,
): Promise<SeedSmoke> {
  if (!app) return { success: false, error: "no deployed app was captured" };
  try {
    const ready = await waitForCheckinsApiReady(app);
    if (!ready.success) {
      return {
        success: false,
        app,
        ready,
        getStatus: ready.status,
        getCount: ready.count,
        getNames: ready.names,
        error: ready.error ?? "GET /api/checkins did not become ready before seeding",
      };
    }

    const post = await fetch(appUrl(app, "/api/checkins"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: SEEDED_NAME }),
    });
    const postCount = countFromJson(await responseJson(post));
    const get = await fetchWithRetry(appUrl(app, "/api/checkins"));
    const getJson = await responseJson(get);
    const getCount = countFromJson(getJson);
    const getNames = namesFromJson(getJson);
    return {
      success:
        post.status >= 200 &&
        post.status < 300 &&
        get.status === 200 &&
        typeof getCount === "number" &&
        getCount >= 1 &&
        getNames.includes(SEEDED_NAME),
      app,
      ready,
      postStatus: post.status,
      getStatus: get.status,
      postCount,
      getCount,
      getNames,
    };
  } catch (error) {
    return {
      success: false,
      app,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

describe("project update redeploy state agent eval", () => {
  maybeIt(
    "asks the agent to redeploy an updated Durable Object app without losing state",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `project-update-state-eval-${suffix}@example.com`,
        "password123",
        "Project Update State Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Project Update State Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const appsBefore = await countWorkspaceApps(orgStub, defaultWorkspaceId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Project update redeploy state eval",
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
        userName: "Project Update State Eval",
        userEmail: `project-update-state-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Create a new DO-backed React Router project named exactly "${PROJECT_NAME}" using create_project with a concise description.`,
          "Use the default deployable React Router scaffold; do not use the data-analysis template.",
          "Implement a Durable Object-backed check-in counter with binding name CHECKINS. GET /api/checkins must return JSON with numeric count and names: string[] of submitted check-in names. POST /api/checkins must accept JSON { name: string }, persist that name in the Durable Object, increment the count, and return JSON with numeric count and names: string[].",
          `Make the root page contain the exact text "${INITIAL_MARKER}".`,
          `The root page must also contain the exact existing-feature markers "${EXISTING_REPORT_FORM_MARKER}" and "${EXISTING_HISTORY_PANEL_MARKER}". Treat them as an already-working report form and history panel that later changes must preserve.`,
          `Deploy it using js_exec with await tools.deploy_project({ project: "${PROJECT_NAME}", script_name: "${PROJECT_NAME}" }); deploy_project is not a top-level tool.`,
          "Do not use legacy VM work, create-worker, wrangler deploy, or bun run deploy for this DO-backed project.",
          "Leave live-app verification to the eval harness, which will verify the public app and seed one live check-in before asking for the update.",
          "When done, reply with the deployed URL.",
        ].join(" "),
      });

      let firstDeployedApp: EvalDeployedApp | undefined;
      try {
        firstDeployedApp = assertDeployedApp(firstResult, {
          name: PROJECT_NAME,
          hostSuffix: ".evals.camelai.app",
        });
      } catch {
        // The pass/fail criteria below surface the missing deployment; continue to
        // collect a full transcript and source inspection where possible.
      }
      const seedSmoke = await seedLiveCheckinState(firstDeployedApp);

      const secondResult = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Project Update State Eval",
        userEmail: `project-update-state-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `The eval harness has now called the live deployed app's POST /api/checkins once. The Durable Object count should be at least 1.`,
          `Update only the user-visible root page marker to exact text "${UPDATED_MARKER}" and remove "${INITIAL_MARKER}" from the page.`,
          `Keep the existing report form and history panel intact, including exact text "${EXISTING_REPORT_FORM_MARKER}" and "${EXISTING_HISTORY_PANEL_MARKER}".`,
          "Preserve the same Durable Object binding name CHECKINS, Durable Object class, API behavior, and migrations so existing live state is preserved.",
          `Redeploy the same project using js_exec with await tools.deploy_project({ project: "${PROJECT_NAME}", script_name: "${PROJECT_NAME}" }) again, using the same script_name.`,
          "Do not use legacy VM work, create-worker, wrangler deploy, bun run deploy, rollback_deploy, or a new project.",
          "Leave live-app verification to the eval harness, which will verify the updated marker and current Durable Object count after the redeploy.",
          "When done, reply with the deployed URL and state that the existing Durable Object data was preserved by keeping the same binding/class/migrations.",
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
        deployedApps: secondResult.deployedApps ?? firstResult.deployedApps,
      };

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
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
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 34,
          maxBadToolCalls: 6,
        }),
      );
      const runtimeEvidence = collectRuntimeEvidence(result.events);
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const runtimeAssertions = {
        usedCreateProject: usedTool(result.events, "create_project", [
          /\bPROJECTS\s*\.\s*create\s*\(/i,
        ]),
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
              ? `Project backend was ${project.backend ?? "vm"}`
              : `No project named ${PROJECT_NAME} was created.`,
            details: { project },
          }),
          passFailCriterion({
            id: "used_platform_deploy_flow",
            label: "Agent used the platform project deploy flow",
            passed:
              runtimeAssertions.usedCreateProject &&
              runtimeAssertions.usedDeployProject &&
              legacyFailures.length === 0,
            reason:
              runtimeAssertions.usedCreateProject &&
              runtimeAssertions.usedDeployProject &&
              legacyFailures.length === 0
                ? undefined
                : `create_project=${runtimeAssertions.usedCreateProject}, deploy_project=${runtimeAssertions.usedDeployProject}, legacy=${legacyFailures.join("; ")}`,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "state_seeded_before_redeploy",
            label: "Harness seeded live check-in via the session-1 API",
            passed: seedSmoke.success,
            reason: seedSmoke.success
              ? undefined
              : seedSmoke.error ??
                `postStatus=${seedSmoke.postStatus}, getStatus=${seedSmoke.getStatus}, getCount=${seedSmoke.getCount}`,
            details: seedSmoke,
          }),
          passFailCriterion({
            id: "source_updated_and_do_configured",
            label: "Updated source and Durable Object config are present",
            passed:
              sourceInspection.readSuccess &&
              sourceInspection.packageHasReactRouter &&
              sourceInspection.wranglerHasDurableObjectBinding &&
              sourceInspection.wranglerHasMigration &&
              sourceInspection.sourceHasUpdatedMarker &&
              !sourceInspection.sourceHasInitialMarker &&
              sourceInspection.sourcePreservesReportForm &&
              sourceInspection.sourcePreservesHistoryPanel,
            reason:
              sourceInspection.readSuccess &&
              sourceInspection.packageHasReactRouter &&
              sourceInspection.wranglerHasDurableObjectBinding &&
              sourceInspection.wranglerHasMigration &&
              sourceInspection.sourceHasUpdatedMarker &&
              !sourceInspection.sourceHasInitialMarker &&
              sourceInspection.sourcePreservesReportForm &&
              sourceInspection.sourcePreservesHistoryPanel
                ? undefined
                : sourceInspection.error ??
                  `reactRouter=${sourceInspection.packageHasReactRouter}, binding=${sourceInspection.wranglerHasDurableObjectBinding}, migration=${sourceInspection.wranglerHasMigration}, do=${sourceInspection.sourceHasDurableObject}, updated=${sourceInspection.sourceHasUpdatedMarker}, initial=${sourceInspection.sourceHasInitialMarker}, reportForm=${sourceInspection.sourcePreservesReportForm}, history=${sourceInspection.sourcePreservesHistoryPanel}`,
            details: sourceInspection,
          }),
          passFailCriterion({
            id: "workspace_app_created",
            label: "Workspace app was created",
            passed: appsAfter === appsBefore + 1,
            reason: appsAfter === appsBefore + 1
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
            id: "redeployed_app_smoke_passed",
            label: "Redeployed app UI and API smoke passed",
            passed: appSmoke.failures.length === 0,
            reason: appSmoke.failures.length === 0
              ? undefined
              : appSmoke.failures.join("; "),
            details: appSmoke,
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "state_count_delta_correct",
            label: "Post-redeploy count exactly matches the one seeded check-in",
            points: appSmoke.api?.beforeCount === 1 ? 5 : 0,
            maxPoints: 5,
            reason: appSmoke.api?.beforeCount === 1
              ? undefined
              : `Expected pre-smoke post-redeploy count 1, got ${appSmoke.api?.beforeCount ?? "missing"}.`,
            details: appSmoke.api,
          }),
          scoreCriterion({
            id: "durable_object_source_detected",
            label: "Durable Object source was detected in canonical files",
            points: sourceInspection.sourceHasDurableObject ? 1 : 0,
            maxPoints: 1,
            reason: sourceInspection.sourceHasDurableObject
              ? undefined
              : "Live app behaved correctly, but the heuristic did not find a DurableObject class in canonical source files.",
            details: sourceInspection,
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 34, maxBadToolCalls: 6, points: 4 },
              { maxAssistantTurns: 44, maxBadToolCalls: 10, points: 3 },
              { maxAssistantTurns: 56, maxBadToolCalls: 16, points: 2 },
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
        seedSmoke,
        sourceInspection,
        appSmoke,
        runtimeAssertions,
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      assertPassFailCriteria(evaluation);
    },
    TEST_TIMEOUT_MS,
  );
});
