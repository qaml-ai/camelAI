import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
  scoreCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import { emitEvalTranscript } from "./eval-transcript";
import { evaluateAgentEvalSignal, getEvalSignalThresholds, type EvalSignalEnv } from "./eval-signal";
import { configureEvalModel, getEvalTimeoutMs, type EvalModelEnv } from "./model-config";
import {
  asRecord,
  hasSuccessfulNotebookRun,
  legacyDeployPathEvidence,
  seedDoProjectFiles,
  usedTool,
} from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type MetricsNotebookEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
};

type SalesRow = { month: string; region: "North" | "South" | "West"; units: number; unitPriceCents: number };
const SALES_ROWS: SalesRow[] = [
  { month: "2025-01", region: "North", units: 11, unitPriceCents: 100 },
  { month: "2025-01", region: "South", units: 21, unitPriceCents: 120 },
  { month: "2025-01", region: "West", units: 6, unitPriceCents: 200 },
  { month: "2025-02", region: "North", units: 12, unitPriceCents: 100 },
  { month: "2025-02", region: "South", units: 22, unitPriceCents: 120 },
  { month: "2025-02", region: "West", units: 7, unitPriceCents: 200 },
  { month: "2025-03", region: "North", units: 13, unitPriceCents: 100 },
  { month: "2025-03", region: "South", units: 23, unitPriceCents: 120 },
  { month: "2025-03", region: "West", units: 8, unitPriceCents: 200 },
  { month: "2025-04", region: "North", units: 14, unitPriceCents: 100 },
  { month: "2025-04", region: "South", units: 24, unitPriceCents: 120 },
  { month: "2025-04", region: "West", units: 9, unitPriceCents: 200 },
  { month: "2025-05", region: "North", units: 15, unitPriceCents: 100 },
  { month: "2025-05", region: "South", units: 25, unitPriceCents: 120 },
  { month: "2025-05", region: "West", units: 10, unitPriceCents: 200 },
  { month: "2025-06", region: "North", units: 16, unitPriceCents: 100 },
  { month: "2025-06", region: "South", units: 26, unitPriceCents: 120 },
  { month: "2025-06", region: "West", units: 11, unitPriceCents: 200 },
  { month: "2025-07", region: "North", units: 17, unitPriceCents: 100 },
  { month: "2025-07", region: "South", units: 27, unitPriceCents: 120 },
  { month: "2025-07", region: "West", units: 12, unitPriceCents: 200 },
  { month: "2025-08", region: "North", units: 18, unitPriceCents: 100 },
  { month: "2025-08", region: "South", units: 28, unitPriceCents: 120 },
  { month: "2025-08", region: "West", units: 13, unitPriceCents: 200 },
  { month: "2025-09", region: "North", units: 19, unitPriceCents: 100 },
  { month: "2025-09", region: "South", units: 29, unitPriceCents: 120 },
  { month: "2025-09", region: "West", units: 14, unitPriceCents: 200 },
  { month: "2025-10", region: "North", units: 20, unitPriceCents: 100 },
  { month: "2025-10", region: "South", units: 30, unitPriceCents: 120 },
  { month: "2025-10", region: "West", units: 15, unitPriceCents: 200 },
  { month: "2025-11", region: "North", units: 21, unitPriceCents: 100 },
  { month: "2025-11", region: "South", units: 31, unitPriceCents: 120 },
  { month: "2025-11", region: "West", units: 16, unitPriceCents: 200 },
  { month: "2025-12", region: "North", units: 22, unitPriceCents: 100 },
  { month: "2025-12", region: "South", units: 32, unitPriceCents: 120 },
  { month: "2025-12", region: "West", units: 17, unitPriceCents: 200 },
];

function groundTruth(rows: SalesRow[]) {
  let totalRevenueCents = 0;
  let totalUnits = 0;
  const byRegion = new Map<string, number>();
  const byMonth = new Map<string, number>();
  for (const row of rows) {
    const revenue = row.units * row.unitPriceCents;
    totalRevenueCents += revenue;
    totalUnits += row.units;
    byRegion.set(row.region, (byRegion.get(row.region) ?? 0) + revenue);
    byMonth.set(row.month, (byMonth.get(row.month) ?? 0) + revenue);
  }
  const winner = (values: Map<string, number>) =>
    [...values.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] ?? "";
  return {
    TOTAL_REVENUE_CENTS: String(totalRevenueCents),
    TOP_REGION: winner(byRegion),
    TOP_MONTH: winner(byMonth),
    REVENUE_PER_UNIT_CENTS: String(Math.round(totalRevenueCents / totalUnits)),
  };
}

const EXPECTED_FINDINGS = groundTruth(SALES_ROWS);
const CSV = [
  "month,region,units,unit_price_cents",
  ...SALES_ROWS.map((row) => `${row.month},${row.region},${row.units},${row.unitPriceCents}`),
].join("\n") + "\n";
const testEnv = env as unknown as MetricsNotebookEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 480_000);

function cellText(cell: Record<string, unknown>): string {
  if (typeof cell.source === "string") return cell.source;
  return Array.isArray(cell.source) ? cell.source.map(String).join("") : "";
}

export function extractKeyFindingsSection(markdown: string): string | undefined {
  const heading = /^## Key Findings[ \t]*(?:\r?\n|$)/m.exec(markdown);
  if (!heading || heading.index === undefined) return undefined;
  const remainder = markdown.slice(heading.index + heading[0].length);
  const nextPeerHeading = /^#{1,2}(?:[ \t]+|$)/m.exec(remainder);
  return nextPeerHeading?.index === undefined
    ? remainder
    : remainder.slice(0, nextPeerHeading.index);
}

describe("metrics notebook Key Findings parsing", () => {
  it("requires the exact level-two heading and scopes findings to its section", () => {
    expect(extractKeyFindingsSection("### Key Findings\n- TOTAL_REVENUE_CENTS=1"))
      .toBeUndefined();
    expect(extractKeyFindingsSection([
      "## Key Findings",
      "Section introduction only.",
      "## Appendix",
      "- TOTAL_REVENUE_CENTS=1",
    ].join("\n"))).toBe("Section introduction only.\n");
    expect(extractKeyFindingsSection([
      "## Key Findings",
      "- TOTAL_REVENUE_CENTS=1",
      "- TOP_REGION=North",
    ].join("\n"))).toContain("- TOP_REGION=North");
  });
});

describe("metrics ground-truth notebook agent eval", () => {
  maybeIt(
    "checks notebook findings against harness-computed ground truth",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `metrics-notebook-${suffix}@example.com`;
      const { userId } = await createUser(testEnv, email, "password123", "Metrics Notebook Eval");
      const { org, defaultWorkspaceId } = await createOrg(testEnv, `Metrics Notebook ${suffix}`, userId);
      const workspaceFs = testEnv.WORKSPACE_FS.get(testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId));
      const { project, files } = await seedDoProjectFiles(workspaceFs, testEnv, {
        workspaceId: defaultWorkspaceId,
        name: "sales-insights",
        description: "Ground-truth sales analysis fixture.",
        template: "data-analysis",
        resetNotebookExecution: true,
        files: { "/data/sales.csv": CSV },
      });
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(defaultWorkspaceId, "Metrics ground truth notebook eval", userId, undefined, testEnv.EVAL_MODEL);
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Metrics Notebook Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: `The existing data-analysis project "sales-insights" contains /data/sales.csv with columns month, region, units, unit_price_cents. Revenue for a row is units * unit_price_cents.
Edit analysis.ipynb into a report titled exactly "Sales Insights Report" that analyzes this file and includes at least one chart of revenue over time.
The report must contain a markdown section headed exactly "## Data Provenance" with these three exact lines:
- SOURCE=/data/sales.csv
- ROW_COUNT=${SALES_ROWS.length}
- DATA_MODE=observed fixture (not live)
Do not add or infer any campaigns, prompts, sources, or fields that are absent from the CSV.
The report must also contain a markdown section headed exactly "## Key Findings" with these four lines, using exact integer values computed from the data (no thousands separators):
- TOTAL_REVENUE_CENTS=<total revenue in cents>
- TOP_REGION=<region with the highest total revenue>
- TOP_MONTH=<YYYY-MM month with the highest total revenue>
- REVENUE_PER_UNIT_CENTS=<total revenue divided by total units, rounded to the nearest integer>
Run the notebook with run_notebook until it executes cleanly; the successful run should open analysis.ipynb in preview automatically.
Do not deploy or use wrangler for this notebook-only project. Reply with the four Key Findings lines.`,
      });

      const read = await files.readFile("/analysis.ipynb");
      let cells: Record<string, unknown>[] = [];
      let parseError: string | undefined;
      try {
        const parsed = JSON.parse(read.content ?? "{}");
        cells = Array.isArray(asRecord(parsed)?.cells)
          ? (asRecord(parsed)!.cells as unknown[]).map(asRecord).filter((cell): cell is Record<string, unknown> => Boolean(cell))
          : [];
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
      const markdownCells = cells.filter((cell) => cell.cell_type === "markdown");
      const markdown = markdownCells.map(cellText).join("\n");
      const keyFindingsSection = extractKeyFindingsSection(markdown);
      const provenancePresent = markdown.includes("## Data Provenance") &&
        markdown.includes("- SOURCE=/data/sales.csv") &&
        markdown.includes(`- ROW_COUNT=${SALES_ROWS.length}`) &&
        markdown.includes("- DATA_MODE=observed fixture (not live)");
      const executedCells = cells.filter((cell) =>
        cell.cell_type === "code" &&
        (typeof cell.execution_count === "number" || (Array.isArray(cell.outputs) && cell.outputs.length > 0))
      );
      const errorOutputs = cells.flatMap((cell, cellIndex) =>
        Array.isArray(cell.outputs)
          ? cell.outputs.flatMap((output, outputIndex) => {
            const outputRecord = asRecord(output);
            return outputRecord?.output_type === "error"
              ? [{ cellIndex, outputIndex, errorName: outputRecord.ename, errorValue: outputRecord.evalue }]
              : [];
          })
          : []
      );
      const extracted: Record<string, string | undefined> = {};
      const findingFailures: string[] = [];
      for (const [name, expected] of Object.entries(EXPECTED_FINDINGS)) {
        const match = keyFindingsSection?.match(
          new RegExp(`^-\\s*${name}=([^\\s]+)\\s*$`, "m"),
        );
        extracted[name] = match?.[1];
        if (match?.[1] !== expected) findingFailures.push(`${name} expected ${expected}, got ${match?.[1] ?? "missing"}`);
      }
      const successfulNotebookRun = hasSuccessfulNotebookRun(result.events, "analysis.ipynb");
      const cleanNotebookExecution = successfulNotebookRun && executedCells.length > 0 && errorOutputs.length === 0;
      const chartOutputPresent = cleanNotebookExecution && cells.some((cell) =>
        Array.isArray(cell.outputs) && cell.outputs.some((output) => {
          const data = asRecord(asRecord(output)?.data);
          return Object.keys(data ?? {}).some((mime) =>
            mime === "image/png" || mime === "image/svg+xml" || mime.startsWith("application/vnd.vegalite")
          );
        })
      );
      const usedDeploy = usedTool(result.events, "deploy_project");
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const finalResult = result.result ?? "";
      const finalHasFindings = Object.entries(EXPECTED_FINDINGS).every(([name, value]) => finalResult.includes(`${name}=${value}`));
      const keyFindingsPresent = keyFindingsSection !== undefined &&
        Object.keys(EXPECTED_FINDINGS).every((name) =>
          new RegExp(`^-\\s*${name}=`, "m").test(keyFindingsSection)
        );
      const signal = evaluateAgentEvalSignal(result, getEvalSignalThresholds(testEnv, { maxAssistantTurns: 10, maxBadToolCalls: 2 }));
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({ id: "notebook_persisted_and_executed", label: "Notebook persisted after a clean successful run", passed: read.success && !parseError && cleanNotebookExecution, reason: read.success && !parseError && cleanNotebookExecution ? undefined : read.error ?? parseError ?? (!successfulNotebookRun ? "No successful clean run_notebook result referenced analysis.ipynb." : errorOutputs.length > 0 ? "The persisted notebook contains error outputs." : "No executed notebook cells were persisted."), details: { readSuccess: read.success, parseError, cellCount: cells.length, executedCellCount: executedCells.length, successfulNotebookRun, errorOutputs } }),
          passFailCriterion({ id: "data_provenance_present", label: "Report labels the exact source, row count, and non-live data mode", passed: provenancePresent, reason: provenancePresent ? undefined : "The exact ## Data Provenance contract was missing or changed.", details: { expectedSource: "/data/sales.csv", expectedRowCount: SALES_ROWS.length, expectedMode: "observed fixture (not live)" } }),
          passFailCriterion({ id: "key_findings_present", label: "Exact ## Key Findings section contains all four lines", passed: keyFindingsPresent, reason: keyFindingsPresent ? undefined : keyFindingsSection === undefined ? "The exact ## Key Findings heading was missing." : "One or more Key Findings lines were missing from that section.", details: { markdown, keyFindingsSection } }),
          passFailCriterion({ id: "findings_match_ground_truth", label: "All four findings match harness-computed ground truth", passed: findingFailures.length === 0, reason: findingFailures.length ? findingFailures.join("; ") : undefined, details: { expected: EXPECTED_FINDINGS, extracted, failures: findingFailures } }),
          passFailCriterion({ id: "notebook_auto_previewed", label: "Successful run_notebook opened analysis.ipynb in preview", passed: successfulNotebookRun, reason: successfulNotebookRun ? undefined : "No successful run_notebook result referenced analysis.ipynb.", details: { successfulNotebookRun } }),
          passFailCriterion({ id: "avoided_web_deploy_path", label: "Notebook flow avoided deploy_project and web deploy commands", passed: !usedDeploy && legacyFailures.length === 0, reason: !usedDeploy && legacyFailures.length === 0 ? undefined : [usedDeploy ? "used deploy_project" : "", ...legacyFailures].filter(Boolean).join("; "), details: { usedDeploy, legacyFailures } }),
          passFailCriterion({ id: "final_response_has_findings", label: "Final response contains all four exact finding tokens", passed: finalHasFindings, reason: finalHasFindings ? undefined : "Final response omitted or changed one or more exact finding tokens.", details: { finalResult, expected: EXPECTED_FINDINGS } }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({ id: "chart_output_present", label: "Cleanly executed notebook contains a rendered chart output", points: chartOutputPresent ? 3 : 0, maxPoints: 3, reason: chartOutputPresent ? undefined : cleanNotebookExecution ? "No image or Vega-Lite output MIME type was found." : "Chart credit requires a successful clean run_notebook result and no persisted error outputs." }),
          scoreCriterion({ id: "report_narrative", label: "Report has the exact title and at least two markdown cells", points: markdown.includes("Sales Insights Report") && markdownCells.length >= 2 ? 2 : 0, maxPoints: 2, reason: `title=${markdown.includes("Sales Insights Report")}, markdownCells=${markdownCells.length}.` }),
          scoreSignalEfficiency(signal, { maxPoints: 4, fallbackPoints: 1, tiers: [{ maxAssistantTurns: 10, maxBadToolCalls: 2, points: 4 }, { maxAssistantTurns: 14, maxBadToolCalls: 4, points: 3 }, { maxAssistantTurns: 20, maxBadToolCalls: 8, points: 2 }] }),
          scoreCriterion({ id: "avoided_legacy_paths", label: "Avoided legacy scaffold/deploy paths", points: legacyFailures.length === 0 ? 2 : 0, maxPoints: 2, reason: legacyFailures.length ? legacyFailures.join("; ") : undefined }),
        ],
      });

      emitEvalTranscript({ status: result.status, evaluation, error: result.error, model: testEnv.EVAL_MODEL, signal, project, expectedFindings: EXPECTED_FINDINGS, keyFindingsSection, extracted, findingFailures, successfulNotebookRun, errorOutputs, result: result.result, events: result.events, messages: result.messages });
      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
