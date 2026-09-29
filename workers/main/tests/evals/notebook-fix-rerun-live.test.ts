import { env } from "cloudflare:test";
import { describe, it } from "vitest";

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
import {
  asRecord,
  collectRuntimeEvidence,
  hasSuccessfulNotebookRun,
  legacyDeployPathEvidence,
  usedTool,
} from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type NotebookFixRerunEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
};

type NotebookInspection = {
  readSuccess: boolean;
  readError?: string;
  parseError?: string;
  hasTypo: boolean;
  hasStaleMarker: boolean;
  hasRefreshedMarker: boolean;
  outputText: string;
  hasExpectedOutput: boolean;
  codeCellCount: number;
  executedOutputCount: number;
};

const PROJECT_NAME = "quarterly-maintenance-report";
const REPORT_TITLE = "Quarterly Maintenance Report";
const STALE_MARKER = "STALE_REPORT_MARKER";
const REFRESHED_MARKER = "REFRESHED_REPORT_READY";
const EXPECTED_TOTAL = 450;
const EXPECTED_OUTPUT = `REFRESHED_TOTAL_REVENUE=${EXPECTED_TOTAL}`;

const testEnv = env as unknown as NotebookFixRerunEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 420_000);

function brokenNotebook(): string {
  return JSON.stringify({
    cells: [
      {
        cell_type: "markdown",
        metadata: {},
        source: [
          `# ${REPORT_TITLE}\n`,
          "\n",
          `${STALE_MARKER}\n`,
          "This report was not regenerated after the latest data change.",
        ],
      },
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: [
          "import pandas as pd\n",
          "\n",
          "df = pd.DataFrame([\n",
          "    {'quarter': 'Q1', 'revenue': 100},\n",
          "    {'quarter': 'Q2', 'revenue': 150},\n",
          "    {'quarter': 'Q3', 'revenue': 200},\n",
          "])\n",
          "total_revenue = int(df['revnue'].sum())\n",
          `print(f\"REFRESHED_TOTAL_REVENUE={total_revenue}\")\n`,
        ],
      },
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: {
        name: "python",
        version: "3.13",
      },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2);
}

function cellSourceText(cell: Record<string, unknown>): string {
  const source = cell.source;
  if (typeof source === "string") return source;
  if (Array.isArray(source)) return source.map((line) => String(line)).join("");
  return "";
}

function cellOutputText(cell: Record<string, unknown>): string {
  const outputs = Array.isArray(cell.outputs) ? cell.outputs.map(asRecord).filter(Boolean) : [];
  return outputs.map((output) => {
    const text = output?.text;
    if (typeof text === "string") return text;
    if (Array.isArray(text)) return text.map((line) => String(line)).join("");
    const data = asRecord(output?.data);
    const plain = data?.["text/plain"];
    if (typeof plain === "string") return plain;
    if (Array.isArray(plain)) return plain.map((line) => String(line)).join("");
    return "";
  }).join("\n");
}

async function seedDataAnalysisProject(
  workspaceId: string,
): Promise<WorkspaceProject> {
  const workspaceFs = testEnv.WORKSPACE_FS.get(
    testEnv.WORKSPACE_FS.idFromName(workspaceId),
  );
  const project = await workspaceFs.createProject({
    name: PROJECT_NAME,
    description: "Notebook maintenance eval fixture.",
    backend: "do-r2",
    workspaceId,
  });
  const files = new ProjectFilesystemClient(testEnv, project.id);
  for (const file of defaultProjectScaffoldFiles(PROJECT_NAME, "data-analysis", PROJECT_NAME)) {
    await files.writeFile(file.path, file.content);
  }
  await files.writeFile("/analysis.ipynb", brokenNotebook());
  return project;
}

async function inspectNotebook(project: WorkspaceProject): Promise<NotebookInspection> {
  const read = await new ProjectFilesystemClient(testEnv, project.id).readFile("/analysis.ipynb");
  if (!read.success) {
    return {
      readSuccess: false,
      readError: read.error ?? "failed to read analysis.ipynb",
      hasTypo: false,
      hasStaleMarker: false,
      hasRefreshedMarker: false,
      outputText: "",
      hasExpectedOutput: false,
      codeCellCount: 0,
      executedOutputCount: 0,
    };
  }

  try {
    const parsed = JSON.parse(read.content ?? "{}");
    const cells = Array.isArray(asRecord(parsed)?.cells)
      ? asRecord(parsed)!.cells as unknown[]
      : [];
    const cellRecords = cells.map(asRecord).filter((cell): cell is Record<string, unknown> => Boolean(cell));
    const sourceText = cellRecords.map(cellSourceText).join("\n");
    const outputText = cellRecords.map(cellOutputText).join("\n");
    const codeCells = cellRecords.filter((cell) => cell.cell_type === "code");
    const codeSourceText = codeCells.map(cellSourceText).join("\n");
    const executedOutputCount = codeCells.filter((cell) =>
      typeof cell.execution_count === "number" ||
      (Array.isArray(cell.outputs) && cell.outputs.length > 0),
    ).length;
    return {
      readSuccess: true,
      hasTypo: codeSourceText.includes("revnue"),
      hasStaleMarker: sourceText.includes(STALE_MARKER),
      hasRefreshedMarker: sourceText.includes(REFRESHED_MARKER),
      outputText,
      hasExpectedOutput: outputText.includes(EXPECTED_OUTPUT),
      codeCellCount: codeCells.length,
      executedOutputCount,
    };
  } catch (error) {
    return {
      readSuccess: true,
      parseError: error instanceof Error ? error.message : String(error),
      hasTypo: false,
      hasStaleMarker: false,
      hasRefreshedMarker: false,
      outputText: "",
      hasExpectedOutput: false,
      codeCellCount: 0,
      executedOutputCount: 0,
    };
  }
}

describe("notebook fix and rerun agent eval", () => {
  maybeIt(
    "asks the agent to fix a stale failing notebook and rerun it",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `notebook-fix-eval-${suffix}@example.com`,
        "password123",
        "Notebook Fix Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Notebook Fix Eval ${suffix}`,
        userId,
      );

      const project = await seedDataAnalysisProject(defaultWorkspaceId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Notebook fix rerun eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Notebook Fix Eval",
        userEmail: `notebook-fix-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `The existing DO-backed data-analysis project named exactly "${PROJECT_NAME}" has a stale failing analysis.ipynb report titled "${REPORT_TITLE}".`,
          `Inspect the notebook, fix the execution bug, and remove the stale marker from the report; the literal string "${STALE_MARKER}" must not appear anywhere in the final notebook source.`,
          `Add the exact markdown marker "${REFRESHED_MARKER}" after the notebook is fixed.`,
          `The executed notebook output must include the exact text "${EXPECTED_OUTPUT}".`,
          "Run the notebook with run_notebook until it succeeds; the successful run should open analysis.ipynb in preview automatically.",
          "Do not create a new project, do not deploy it, and do not use legacy VM shell commands.",
          "Reply with the refreshed total revenue number from the executed notebook output.",
        ].join(" "),
      });

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const projects = await workspaceFs.listProjectsForMigrationReset();
      const matchingProjects = projects.filter((candidate) => candidate.name === PROJECT_NAME);
      const notebookInspection = await inspectNotebook(project);
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 10,
          maxBadToolCalls: 2,
        }),
      );
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const runtimeAssertions = {
        usedCreateProject: usedTool(result.events, "create_project"),
        usedRunNotebook: usedTool(result.events, "run_notebook"),
        successfulNotebookRun: hasSuccessfulNotebookRun(result.events, "analysis.ipynb"),
        usedDeployProject: usedTool(result.events, "deploy_project"),
        legacyFailures,
        evidence: collectRuntimeEvidence(result.events),
      };
      const finalResult = result.result ?? "";

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
            id: "used_notebook_flow",
            label: "Agent reran and previewed the notebook",
            passed: runtimeAssertions.successfulNotebookRun,
            reason:
              runtimeAssertions.successfulNotebookRun
                ? undefined
                : `run_notebook=${runtimeAssertions.usedRunNotebook}, run_notebook succeeded and auto-previewed=${runtimeAssertions.successfulNotebookRun}`,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "notebook_source_fixed",
            label: "Notebook source was fixed and refreshed",
            passed:
              notebookInspection.readSuccess &&
              !notebookInspection.hasTypo &&
              !notebookInspection.hasStaleMarker &&
              notebookInspection.hasRefreshedMarker,
            reason:
              notebookInspection.readSuccess &&
              !notebookInspection.hasTypo &&
              !notebookInspection.hasStaleMarker &&
              notebookInspection.hasRefreshedMarker
                ? undefined
                : notebookInspection.readError ??
                  notebookInspection.parseError ??
                  `hasTypo=${notebookInspection.hasTypo}, stale=${notebookInspection.hasStaleMarker}, refreshed=${notebookInspection.hasRefreshedMarker}`,
            details: notebookInspection,
          }),
          passFailCriterion({
            id: "notebook_output_refreshed",
            label: "Executed notebook output contains the refreshed total",
            passed:
              notebookInspection.hasExpectedOutput &&
              notebookInspection.executedOutputCount > 0,
            reason:
              notebookInspection.hasExpectedOutput && notebookInspection.executedOutputCount > 0
                ? undefined
                : `Expected output ${EXPECTED_OUTPUT}; executed outputs=${notebookInspection.executedOutputCount}`,
            details: notebookInspection,
          }),
          passFailCriterion({
            id: "avoided_web_deploy_path",
            label: "Agent avoided web deploy and legacy scaffold/deploy paths",
            passed:
              !runtimeAssertions.usedDeployProject &&
              legacyFailures.length === 0,
            reason:
              !runtimeAssertions.usedDeployProject &&
              legacyFailures.length === 0
                ? undefined
                : [
                    runtimeAssertions.usedDeployProject ? "used deploy_project" : "",
                    ...legacyFailures,
                  ].filter(Boolean).join("; "),
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "final_response_has_total",
            label: "Final response includes the refreshed total",
            passed: /(^|[^0-9])450([^0-9]|$)/.test(finalResult) || finalResult.includes(EXPECTED_OUTPUT),
            reason: /(^|[^0-9])450([^0-9]|$)/.test(finalResult) || finalResult.includes(EXPECTED_OUTPUT)
              ? undefined
              : `Final response did not include ${EXPECTED_TOTAL}.`,
            details: { finalResult },
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
              { maxAssistantTurns: 10, maxBadToolCalls: 2, points: 4 },
              { maxAssistantTurns: 14, maxBadToolCalls: 4, points: 3 },
              { maxAssistantTurns: 20, maxBadToolCalls: 8, points: 2 },
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
        notebookInspection,
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
