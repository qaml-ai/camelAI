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
  countNotebookErrorOutputs,
  fetchWithRetry,
  hasSuccessfulNotebookRun,
  legacyDeployPathEvidence,
  usedTool,
} from "./project-eval-helpers";
import { ProjectFilesystemClient } from "../../src/workspace-filesystem-do";
import type {
  WorkspaceFilesystemDO,
  WorkspaceProject,
} from "../../src/workspace-filesystem-do";
import { runRuntimeEval } from "./runtime-eval";

type NotebookDeployEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  ASSETS?: Fetcher;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

type NotebookInspection = {
  readSuccess: boolean;
  readError?: string;
  hasTitle: boolean;
  hasFinding: boolean;
  hasExecutedOutput: boolean;
  hasErrorOutput: boolean;
  errorOutputCount: number;
  parseError?: string;
};

type NotebookAppSmoke = {
  root?: {
    status?: number;
    bodyLength?: number;
    hasFilenameInjection: boolean;
    error?: string;
  };
  asset?: { path?: string; status?: number; error?: string };
  notebook?: {
    status?: number;
    hasTitle: boolean;
    hasFinding: boolean;
    hasExecutedOutput: boolean;
    hasErrorOutput: boolean;
    errorOutputCount: number;
    error?: string;
  };
  failures: string[];
};

// The prompt is deliberately minimal — it names the deliverable ("data-analysis
// project", "publish as a shareable app") but no tools. The eval measures that
// the agent discovers the create_project template → run_notebook →
// deploy_project flow from tool descriptions and the system prompt alone.
const PROJECT_NAME = "monthly-revenue-report";
const REPORT_TITLE = "Monthly Revenue Report";
const REQUIRED_FINDING = "Product Alpha led total revenue.";

const testEnv = env as unknown as NotebookDeployEvalEnv;
// Publishes a live notebook app in the testing-grounds namespace.
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 600_000);

function cellSourceText(cell: Record<string, unknown>): string {
  const source = cell.source;
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.map((line) => String(line)).join("");
  return "";
}

function inspectNotebookJson(text: string): Omit<NotebookInspection, "readSuccess" | "readError"> {
  try {
    const parsed = JSON.parse(text);
    const cells = Array.isArray(asRecord(parsed)?.cells)
      ? asRecord(parsed)!.cells as unknown[]
      : [];
    const cellRecords = cells.map(asRecord).filter((cell): cell is Record<string, unknown> => Boolean(cell));
    const sourceText = cellRecords.map(cellSourceText).join("\n");
    const executedOutputs = cellRecords.filter((cell) =>
      cell.cell_type === "code" && Array.isArray(cell.outputs) && cell.outputs.length > 0,
    );
    const errorOutputCount = countNotebookErrorOutputs(cellRecords);
    return {
      hasTitle: sourceText.includes(REPORT_TITLE),
      hasFinding: sourceText.includes(REQUIRED_FINDING),
      hasExecutedOutput: executedOutputs.length > 0,
      hasErrorOutput: errorOutputCount > 0,
      errorOutputCount,
    };
  } catch (error) {
    return {
      hasTitle: false,
      hasFinding: false,
      hasExecutedOutput: false,
      hasErrorOutput: false,
      errorOutputCount: 0,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function inspectProjectNotebook(
  project: WorkspaceProject | undefined,
): Promise<NotebookInspection> {
  const empty = {
    hasTitle: false,
    hasFinding: false,
    hasExecutedOutput: false,
    hasErrorOutput: false,
    errorOutputCount: 0,
  };
  if (!project) return { readSuccess: false, readError: "project was not created", ...empty };
  const read = await new ProjectFilesystemClient(testEnv, project.id).readFile("/analysis.ipynb");
  if (!read.success) {
    return {
      readSuccess: false,
      readError: read.error ?? "failed to read analysis.ipynb",
      ...empty,
    };
  }
  return { readSuccess: true, ...inspectNotebookJson(read.content ?? "{}") };
}

// The published app renders client-side, so the smoke check verifies the static
// contract instead of rendered DOM: the shell injects window.__FILENAME__, a
// renderer bundle asset is served, and /files/<name> returns the executed
// notebook with the required content.
async function smokeCheckNotebookApp(
  app: EvalDeployedApp | undefined,
): Promise<NotebookAppSmoke> {
  const failures: string[] = [];
  if (!app) return { failures: ["no deployed app was captured"] };
  const smoke: NotebookAppSmoke = { failures };

  let body = "";
  try {
    const rootResponse = await fetchWithRetry(app.url);
    body = await rootResponse.text();
    smoke.root = {
      status: rootResponse.status,
      bodyLength: body.length,
      hasFilenameInjection: body.includes("window.__FILENAME__"),
    };
    if (rootResponse.status !== 200) failures.push(`root returned HTTP ${rootResponse.status}`);
    if (!body.includes("window.__FILENAME__")) {
      failures.push("root HTML did not include the window.__FILENAME__ injection");
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    smoke.root = { hasFilenameInjection: false, error: message };
    failures.push(`root fetch failed: ${message}`);
  }

  const assetMatch = body.match(/\/assets\/[\w.-]+\.js/);
  if (assetMatch) {
    try {
      const assetResponse = await fetchWithRetry(new URL(assetMatch[0], app.url).toString());
      smoke.asset = { path: assetMatch[0], status: assetResponse.status };
      if (assetResponse.status !== 200) {
        failures.push(`renderer asset ${assetMatch[0]} returned HTTP ${assetResponse.status}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      smoke.asset = { path: assetMatch[0], error: message };
      failures.push(`renderer asset fetch failed: ${message}`);
    }
  } else {
    failures.push("root HTML referenced no /assets/*.js renderer bundle");
  }

  try {
    const notebookResponse = await fetchWithRetry(
      new URL("/files/analysis.ipynb", app.url).toString(),
    );
    const notebookText = await notebookResponse.text();
    const inspection = notebookResponse.status === 200
      ? inspectNotebookJson(notebookText)
      : {
          hasTitle: false,
          hasFinding: false,
          hasExecutedOutput: false,
          hasErrorOutput: false,
          errorOutputCount: 0,
        };
    smoke.notebook = { status: notebookResponse.status, ...inspection };
    if (notebookResponse.status !== 200) {
      failures.push(`/files/analysis.ipynb returned HTTP ${notebookResponse.status}`);
    } else {
      if (inspection.parseError) failures.push(`published notebook is not valid JSON: ${inspection.parseError}`);
      if (!inspection.hasTitle) failures.push("published notebook did not include the report title");
      if (!inspection.hasFinding) failures.push("published notebook did not include the required finding");
      if (!inspection.hasExecutedOutput) failures.push("published notebook had no executed cell outputs");
      if (inspection.hasErrorOutput) {
        failures.push(`published notebook had ${inspection.errorOutputCount} error output(s)`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    smoke.notebook = {
      hasTitle: false,
      hasFinding: false,
      hasExecutedOutput: false,
      hasErrorOutput: false,
      errorOutputCount: 0,
      error: message,
    };
    failures.push(`published notebook fetch failed: ${message}`);
  }

  return smoke;
}

describe("notebook deploy agent eval", () => {
  maybeIt(
    "asks the agent to analyze data and publish the notebook report as an app with minimal prompting",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `notebook-deploy-eval-${suffix}@example.com`,
        "password123",
        "Notebook Deploy Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Notebook Deploy Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Notebook deploy eval",
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
        userName: "Notebook Deploy Eval",
        userEmail: `notebook-deploy-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Create a data-analysis project named exactly "${PROJECT_NAME}" that analyzes hardcoded monthly revenue for at least three product lines, with the notebook report titled exactly "${REPORT_TITLE}".`,
          `Include this exact finding in markdown: "${REQUIRED_FINDING}"`,
          "The default Python data stack is preinstalled; do not install extra packages unless you truly need one.",
          `Run the notebook until it executes cleanly, then publish the report as a shareable app named exactly "${PROJECT_NAME}" and reply with the live app URL.`,
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 12,
          maxBadToolCalls: 2,
        }),
      );
      const projects = await workspaceFs.listProjectsForMigrationReset();
      const project = projects.find((candidate) => candidate.name === PROJECT_NAME);
      const notebookInspection = await inspectProjectNotebook(project);
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
      const appSmoke = await smokeCheckNotebookApp(deployedApp);
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const runtimeAssertions = {
        usedCreateProject: usedTool(result.events, "create_project", [
          /\bPROJECTS\s*\.\s*create\s*\(/i,
        ]),
        usedRunNotebook: usedTool(result.events, "run_notebook"),
        successfulNotebookRun: hasSuccessfulNotebookRun(result.events, "analysis.ipynb"),
        usedDeployProject: usedTool(result.events, "deploy_project"),
        legacyFailures,
        evidence: collectRuntimeEvidence(result.events),
      };
      const finalResult = result.result ?? "";
      const finalResponseHasUrl = Boolean(
        deployedApp && finalResult.includes(new URL(deployedApp.url).hostname),
      );

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "project_created_do_backed",
            label: "Agent created a DO-backed analysis project",
            passed: project?.backend === "do-r2",
            reason: project
              ? `Project backend was ${project.backend}`
              : `No project named ${PROJECT_NAME} was created.`,
            details: { project },
          }),
          passFailCriterion({
            id: "discovered_notebook_deploy_flow",
            label: "Agent discovered the notebook analyze/run/deploy flow unprompted",
            passed:
              runtimeAssertions.usedCreateProject &&
              runtimeAssertions.successfulNotebookRun &&
              runtimeAssertions.usedDeployProject,
            reason:
              runtimeAssertions.usedCreateProject &&
              runtimeAssertions.successfulNotebookRun &&
              runtimeAssertions.usedDeployProject
                ? undefined
                : `create_project=${runtimeAssertions.usedCreateProject}, run_notebook invoked=${runtimeAssertions.usedRunNotebook}, run_notebook succeeded=${runtimeAssertions.successfulNotebookRun}, deploy_project=${runtimeAssertions.usedDeployProject}`,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "notebook_executed_and_persisted",
            label: "Notebook report content persisted with executed outputs",
            passed:
              notebookInspection.readSuccess &&
              notebookInspection.hasTitle &&
              notebookInspection.hasFinding &&
              notebookInspection.hasExecutedOutput &&
              !notebookInspection.hasErrorOutput &&
              runtimeAssertions.successfulNotebookRun,
            reason:
              notebookInspection.readSuccess &&
              notebookInspection.hasTitle &&
              notebookInspection.hasFinding &&
              notebookInspection.hasExecutedOutput &&
              !notebookInspection.hasErrorOutput &&
              runtimeAssertions.successfulNotebookRun
                ? undefined
                : notebookInspection.readError ??
                  notebookInspection.parseError ??
                  `title=${notebookInspection.hasTitle}, finding=${notebookInspection.hasFinding}, executed=${notebookInspection.hasExecutedOutput}, error outputs=${notebookInspection.errorOutputCount}, run_notebook succeeded=${runtimeAssertions.successfulNotebookRun}`,
            details: { notebookInspection, successfulNotebookRun: runtimeAssertions.successfulNotebookRun },
          }),
          passFailCriterion({
            id: "avoided_legacy_paths",
            label: "Agent avoided legacy deploy paths",
            passed: legacyFailures.length === 0,
            reason:
              legacyFailures.length === 0
                ? undefined
                : legacyFailures.join("; "),
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
            id: "published_notebook_smoke_passed",
            label: "Published notebook app serves the renderer and executed notebook",
            passed: appSmoke.failures.length === 0,
            reason: appSmoke.failures.length ? appSmoke.failures.join("; ") : undefined,
            details: appSmoke,
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "final_response_has_live_url",
            label: "Final response includes the live app URL",
            points: finalResponseHasUrl ? 1 : 0,
            maxPoints: 1,
            reason: finalResponseHasUrl
              ? undefined
              : "Final response did not include the deployed app hostname.",
            details: { finalResult, deployedAppUrl: deployedApp?.url },
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 12, maxBadToolCalls: 2, points: 4 },
              { maxAssistantTurns: 16, maxBadToolCalls: 4, points: 3 },
              { maxAssistantTurns: 24, maxBadToolCalls: 8, points: 2 },
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
        notebookInspection,
        runtimeAssertions,
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
