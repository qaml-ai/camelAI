import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
  ProjectFilesystemClient,
  type WorkspaceFilesystemDO,
} from "../../src/workspace-filesystem-do";
import { runtimeToolReferenceOrder } from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type DashboardEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
};

const testEnv = env as unknown as DashboardEvalEnv;
const maybeIt = testEnv.RUN_AGENT_EVALS === "1" ? it : it.skip;
const DASHBOARD_FILE_PATH = "/index.html";
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 240_000);

function countHits(text: string, terms: string[]): number {
  return terms.filter((term) => text.includes(term)).length;
}

export function wasFileRereadAfterFinalWrite(
  events: Array<Record<string, unknown>>,
  path: string,
): boolean {
  const normalizedPath = path.replace(/^\/+/, "");
  const fileOperations = runtimeToolReferenceOrder(events, [
    { id: "write", toolName: "write", expectedText: normalizedPath },
    { id: "edit", toolName: "edit", expectedText: normalizedPath },
    { id: "read", toolName: "read", expectedText: normalizedPath },
  ]);
  const finalWriteIndex = Math.max(
    fileOperations.lastIndexOf("write"),
    fileOperations.lastIndexOf("edit"),
  );
  return finalWriteIndex >= 0 &&
    fileOperations.slice(finalWriteIndex + 1).includes("read");
}

export function inspectDashboardHtml(html: string): {
  hasStaticHtml: boolean;
  hasCss: boolean;
  placeholderOnly: boolean;
  metricSignals: string[];
  hasTableMarkup: boolean;
  tableRowCount: number;
  hasTable: boolean;
  hasChart: boolean;
  hasFakeData: boolean;
  sectionSignalCount: number;
  richnessPoints: number;
  richnessDetails: Record<string, boolean | number | string[]>;
} {
  const lower = html.toLowerCase();
  const metricTerms = [
    "revenue",
    "sales",
    "orders",
    "customers",
    "users",
    "conversion",
    "profit",
    "margin",
    "growth",
    "retention",
    "churn",
    "pipeline",
    "inventory",
    "tickets",
    "satisfaction",
  ];
  const metricSignals = metricTerms.filter((term) => lower.includes(term));
  const hasStaticHtml = /<!doctype\s+html/i.test(html) || /<html[\s>]/i.test(html);
  const hasCss = /<style[\s>]/i.test(html) || /\b(class|style)=["']/i.test(html);
  const placeholderOnly =
    html.trim().length < 500 ||
    /\b(todo|lorem ipsum|placeholder|coming soon)\b/i.test(html);
  const hasTableMarkup = /<table[\s>]/i.test(html);
  const tableRowCount = html.match(/<tr[\s>]/gi)?.length ?? 0;
  const hasTable = hasTableMarkup && tableRowCount >= 4;
  const hasChart = /<canvas[\s>]|<svg[\s>]/i.test(html);
  const hasFakeData = /\$[0-9][0-9,]+/.test(html) || /[0-9]+%/.test(html);
  const sectionSignalCount = countHits(lower, [
    "metric",
    "card",
    "panel",
    "section",
    "grid",
    "table",
    "chart",
    "activity",
    "sales",
    "operations",
  ]);
  const richnessDetails = {
    structuredLayout: /\b(card|metric|panel|grid|section|header)\b/i.test(lower),
    polishedCss:
      /\b(box-shadow|border-radius|gap|padding|background|--[a-z0-9-]+|font-weight|letter-spacing)\b/i
        .test(lower),
    multipleSections: sectionSignalCount >= 2,
    chartQuality:
      hasChart &&
      (/<canvas[\s>]|<svg[\s>]/i.test(html) ||
        /\b(legend|axis|bar|line|data-label|sparkline)\b/i.test(lower)),
    tableDetail:
      hasTable &&
      ((html.match(/<tr[\s>]/gi)?.length ?? 0) >= 4 ||
        (html.match(/\b(row|record|customer|order|product|region)\b/gi)?.length ?? 0) >= 6),
    responsiveStyling:
      /@media|minmax|auto-fit|auto-fill|width:\s*\d+%|clamp\(|display:\s*(grid|flex)/i
        .test(html),
  };
  const richnessPoints =
    (richnessDetails.structuredLayout ? 1 : 0) +
    (richnessDetails.polishedCss ? 1 : 0) +
    (richnessDetails.multipleSections ? 1 : 0) +
    (richnessDetails.chartQuality ? 1 : 0) +
    (richnessDetails.tableDetail ? 1 : 0) +
    (richnessDetails.responsiveStyling ? 1 : 0);
  return {
    hasStaticHtml,
    hasCss,
    placeholderOnly,
    metricSignals,
    hasTableMarkup,
    tableRowCount,
    hasTable,
    hasChart,
    hasFakeData,
    sectionSignalCount,
    richnessPoints,
    richnessDetails,
  };
}

describe("dashboard HTML inspection", () => {
  it("requires table markup and at least four rows", () => {
    expect(inspectDashboardHtml("<table><tr></tr><tr></tr><tr></tr><tr></tr></table>").hasTable)
      .toBe(true);
    expect(inspectDashboardHtml("<table></table>").hasTable).toBe(false);
    expect(inspectDashboardHtml("<tr></tr><tr></tr><tr></tr><tr></tr>").hasTable).toBe(false);
  });

  it("requires an /index.html read after its final write", () => {
    const eventFor = (item: Record<string, unknown>) => ({
      type: "runtime_event",
      event: { method: "item/completed", params: { item } },
    });
    const events = [
      eventFor({ tool: "read", arguments: { path: "/README.md" } }),
      eventFor({ tool: "write", arguments: { path: "index.html" } }),
      eventFor({ tool: "read", arguments: { path: "/SKILL.md" } }),
    ];
    expect(wasFileRereadAfterFinalWrite(events, "/index.html")).toBe(false);
    expect(wasFileRereadAfterFinalWrite([
      ...events,
      eventFor({ tool: "read", arguments: { path: "index.html" } }),
    ], "/index.html")).toBe(true);
  });
});

describe("dashboard fake data agent eval", () => {
  maybeIt(
    "asks the agent to build a dashboard from fake data and prints the transcript",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `dashboard-eval-${suffix}@example.com`,
        "password123",
        "Dashboard Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Dashboard Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Dashboard fake data eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );

      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const project = await workspaceFs.createProject({
        id: "dashboard-app",
        name: "dashboard-app",
        description: "Dashboard eval project.",
        workspaceId: defaultWorkspaceId,
        backend: "do-r2",
      });

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Dashboard Eval",
        userEmail: `dashboard-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          "In the dashboard-app project, create a polished static HTML dashboard using fake business data, as a single file named index.html at the project root.",
          "Include at least three metric cards with labeled values, a data table with at least four rows, and a small chart rendered with inline SVG or a <canvas> element.",
          "Use only HTML, CSS, and vanilla JavaScript in that one file so it can be opened directly.",
          "After creating it, read the file back to verify it exists, then briefly summarize what you built.",
        ].join("\n"),
      });
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 6,
          maxBadToolCalls: 0,
        }),
      );
      const readResponse = await new ProjectFilesystemClient(testEnv, project.id)
        .readFile(DASHBOARD_FILE_PATH);
      const html = readResponse.content ?? "";
      const inspection = inspectDashboardHtml(html);
      const rereadFile = wasFileRereadAfterFinalWrite(
        result.events,
        DASHBOARD_FILE_PATH,
      );
      const summarizedDashboard = /dashboard/i.test(result.result ?? "");
      const contentPassed =
        inspection.metricSignals.length >= 3 &&
        inspection.hasTable &&
        inspection.hasChart &&
        inspection.hasFakeData;
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "wrote_index_html",
            label: "Agent wrote /index.html",
            passed: readResponse.success,
            reason: readResponse.success
              ? undefined
              : readResponse.error ?? `Reading ${DASHBOARD_FILE_PATH} failed.`,
            details: readResponse,
          }),
          passFailCriterion({
            id: "valid_static_html",
            label: "Generated file is valid static HTML",
            passed:
              inspection.hasStaticHtml &&
              inspection.hasCss &&
              !inspection.placeholderOnly,
            reason:
              inspection.hasStaticHtml &&
              inspection.hasCss &&
              !inspection.placeholderOnly
                ? undefined
                : "Generated file is missing an HTML document marker, CSS/style evidence, or enough non-placeholder content.",
            details: inspection,
          }),
          passFailCriterion({
            id: "required_dashboard_content",
            label: "Dashboard includes required product content",
            passed: contentPassed,
            reason: contentPassed
              ? undefined
              : "Dashboard did not include at least three metric signals, table markup with at least four rows, chart evidence, and fake business data.",
            details: inspection,
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "dashboard_richness",
            label: "Dashboard richness",
            points: inspection.richnessPoints,
            maxPoints: 6,
            reason: `${inspection.richnessPoints}/6 static HTML richness heuristics passed.`,
            details: inspection.richnessDetails,
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 6, maxBadToolCalls: 0, points: 4 },
              { maxAssistantTurns: 10, maxBadToolCalls: 1, points: 3 },
              { maxAssistantTurns: 16, maxBadToolCalls: 3, points: 2 },
            ],
          }),
          scoreCriterion({
            id: "verified_and_summarized",
            label: "File re-read and final reply summarizes the dashboard",
            points: (rereadFile ? 1 : 0) + (summarizedDashboard ? 1 : 0),
            maxPoints: 2,
            reason: `file re-read=${rereadFile}; dashboard summary=${summarizedDashboard}.`,
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        result: result.result,
        events: result.events,
        messages: result.messages,
        fileInspection: {
          path: DASHBOARD_FILE_PATH,
          readSuccess: readResponse.success,
          size: html.length,
          dashboard: inspection,
        },
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 60_000,
  );
});
