import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import { ProjectFilesystemClient, type WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";
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
  fetchJsonWithRetry,
  type EvalDeployedApp,
} from "./eval-deploy-assert";
import { emitEvalTranscript } from "./eval-transcript";
import { evaluateAgentEvalSignal, getEvalSignalThresholds, type EvalSignalEnv } from "./eval-signal";
import { configureEvalModel, getEvalTimeoutMs, type EvalModelEnv } from "./model-config";
import { asRecord, fetchWithRetry, legacyDeployPathEvidence } from "./project-eval-helpers";
import { runRuntimeEval } from "./runtime-eval";

type OrdersAnalyticsEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

const PROJECT_NAME = "orders-analytics";
const WORKLOAD_TEMPLATE = [
  { item: "star chart", category: "gear", amountCents: 1999 },
  { item: "fuel cell", category: "gear", amountCents: 5501 },
  { item: "ration pack", category: "supply", amountCents: 850 },
  { item: "ration pack", category: "supply", amountCents: 850 },
  { item: "nav module", category: "avionics", amountCents: 12000 },
  { item: "patch kit", category: "supply", amountCents: 300 },
] as const;

type EvalOrder = {
  item: string;
  category: string;
  amountCents: number;
};

type OrderSummary = {
  totalCents: number;
  orderCount: number;
  byCategory: Record<string, { totalCents: number; orderCount: number }>;
};

const testEnv = env as unknown as OrdersAnalyticsEvalEnv;
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 900_000);

function appUrl(app: EvalDeployedApp, path: string): string {
  return new URL(path, app.url).toString();
}

function buildEvalWorkload(suffix: string): EvalOrder[] {
  return WORKLOAD_TEMPLATE.map((order) => ({
    ...order,
    category: `eval-${suffix}-${order.category}`,
  }));
}

function summarizeOrders(orders: EvalOrder[]): OrderSummary {
  const summary: OrderSummary = { totalCents: 0, orderCount: 0, byCategory: {} };
  for (const order of orders) {
    summary.totalCents += order.amountCents;
    summary.orderCount += 1;
    const category = summary.byCategory[order.category] ?? { totalCents: 0, orderCount: 0 };
    category.totalCents += order.amountCents;
    category.orderCount += 1;
    summary.byCategory[order.category] = category;
  }
  return summary;
}

function orderKey(value: unknown): string | undefined {
  const order = asRecord(value);
  if (
    typeof order?.item !== "string" ||
    typeof order.category !== "string" ||
    typeof order.amountCents !== "number"
  ) {
    return undefined;
  }
  return JSON.stringify([order.item, order.category, order.amountCents]);
}

function missingExpectedOrders(actual: unknown[], expected: EvalOrder[]): EvalOrder[] {
  const counts = new Map<string, number>();
  for (const order of actual) {
    const key = orderKey(order);
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return expected.filter((order) => {
    const key = orderKey(order)!;
    const remaining = counts.get(key) ?? 0;
    if (remaining === 0) return true;
    counts.set(key, remaining - 1);
    return false;
  });
}

function finiteSummaryNumber(
  summary: Record<string, unknown> | undefined,
  key: "totalCents" | "orderCount",
  path: string,
  failures: string[],
): number | undefined {
  const value = summary?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    failures.push(`${path}.${key} was not a finite number`);
    return undefined;
  }
  return value;
}

function summaryDeltaFailures(
  baselineValue: unknown,
  finalValue: unknown,
  expectedDelta: OrderSummary,
  path: string,
): string[] {
  const failures: string[] = [];
  const baseline = asRecord(baselineValue);
  const final = asRecord(finalValue);
  if (!baseline) failures.push("baseline summary was not an object");
  if (!final) failures.push(`${path} was not an object`);
  if (!baseline || !final) return failures;

  const baselineTotal = finiteSummaryNumber(baseline, "totalCents", "baseline", failures);
  const baselineCount = finiteSummaryNumber(baseline, "orderCount", "baseline", failures);
  const finalTotal = finiteSummaryNumber(final, "totalCents", path, failures);
  const finalCount = finiteSummaryNumber(final, "orderCount", path, failures);
  if (
    baselineTotal !== undefined && finalTotal !== undefined &&
    finalTotal - baselineTotal !== expectedDelta.totalCents
  ) {
    failures.push(
      `${path}.totalCents delta expected ${expectedDelta.totalCents}, got ${finalTotal - baselineTotal}`,
    );
  }
  if (
    baselineCount !== undefined && finalCount !== undefined &&
    finalCount - baselineCount !== expectedDelta.orderCount
  ) {
    failures.push(
      `${path}.orderCount delta expected ${expectedDelta.orderCount}, got ${finalCount - baselineCount}`,
    );
  }

  const baselineCategories = asRecord(baseline.byCategory) ?? {};
  const finalCategories = asRecord(final.byCategory);
  if (!finalCategories) {
    failures.push(`${path}.byCategory was not an object`);
    return failures;
  }
  for (const [category, expected] of Object.entries(expectedDelta.byCategory)) {
    const baselineCategory = asRecord(baselineCategories[category]);
    const finalCategory = asRecord(finalCategories[category]);
    if (!finalCategory) {
      failures.push(`${path}.byCategory.${category} was missing`);
      continue;
    }
    const baselineCategoryTotal = baselineCategory
      ? finiteSummaryNumber(baselineCategory, "totalCents", `baseline.byCategory.${category}`, failures)
      : 0;
    const baselineCategoryCount = baselineCategory
      ? finiteSummaryNumber(baselineCategory, "orderCount", `baseline.byCategory.${category}`, failures)
      : 0;
    const finalCategoryTotal = finiteSummaryNumber(
      finalCategory,
      "totalCents",
      `${path}.byCategory.${category}`,
      failures,
    );
    const finalCategoryCount = finiteSummaryNumber(
      finalCategory,
      "orderCount",
      `${path}.byCategory.${category}`,
      failures,
    );
    if (
      baselineCategoryTotal !== undefined && finalCategoryTotal !== undefined &&
      finalCategoryTotal - baselineCategoryTotal !== expected.totalCents
    ) {
      failures.push(
        `${path}.byCategory.${category}.totalCents delta expected ${expected.totalCents}, got ${finalCategoryTotal - baselineCategoryTotal}`,
      );
    }
    if (
      baselineCategoryCount !== undefined && finalCategoryCount !== undefined &&
      finalCategoryCount - baselineCategoryCount !== expected.orderCount
    ) {
      failures.push(
        `${path}.byCategory.${category}.orderCount delta expected ${expected.orderCount}, got ${finalCategoryCount - baselineCategoryCount}`,
      );
    }
  }
  return failures;
}

async function inspectPersistenceConfig(projectId: string | undefined) {
  if (!projectId) {
    return {
      configured: false,
      hasBinding: false,
      hasMigration: false,
      paths: [] as string[],
      error: "project was not created",
    };
  }
  const files = new ProjectFilesystemClient(testEnv, projectId);
  const listing = await files.listFiles("/", { recursive: true, limit: 2000 });
  if (!listing.success) {
    return {
      configured: false,
      hasBinding: false,
      hasMigration: false,
      paths: [] as string[],
      error: listing.error,
    };
  }
  const source: Record<string, string> = {};
  for (const entry of listing.files) {
    if (entry.type !== "file" || !/\.(?:ts|tsx|json|jsonc)$/.test(entry.name)) continue;
    const path = entry.absolutePath || `/${entry.relativePath ?? entry.name}`;
    const read = await files.readFile(path);
    if (read.success && typeof read.content === "string") source[path] = read.content;
  }
  const wranglerText = Object.entries(source)
    .filter(([path]) => /(?:^|\/)wrangler\.jsonc?$/.test(path))
    .map(([, content]) => content)
    .join("\n");
  const hasBinding = /durable_objects[\s\S]{0,600}bindings/i.test(wranglerText);
  const hasMigration = /new_(?:sqlite_)?classes/i.test(wranglerText);
  return { configured: hasBinding && hasMigration, hasBinding, hasMigration, paths: Object.keys(source) };
}

describe("orders analytics verification helpers", () => {
  it("accepts the six eval orders and exact summary delta on top of agent test data", () => {
    const workload = buildEvalWorkload("run123");
    const expectedDelta = summarizeOrders(workload);
    const baseline = {
      totalCents: 2500,
      orderCount: 2,
      byCategory: { "agent-test": { totalCents: 2500, orderCount: 2 } },
    };
    const final = {
      totalCents: baseline.totalCents + expectedDelta.totalCents,
      orderCount: baseline.orderCount + expectedDelta.orderCount,
      byCategory: { ...baseline.byCategory, ...expectedDelta.byCategory },
    };
    const listing = [
      { item: "agent probe", category: "agent-test", amountCents: 1000 },
      { item: "agent probe 2", category: "agent-test", amountCents: 1500 },
      ...workload,
    ];

    expect(listing).toHaveLength(8);
    expect(missingExpectedOrders(listing, workload)).toEqual([]);
    expect(summaryDeltaFailures(baseline, final, expectedDelta, "summary1")).toEqual([]);
    expect(summaryDeltaFailures(
      baseline,
      { ...final, totalCents: final.totalCents + 1 },
      expectedDelta,
      "summary1",
    )).toContain("summary1.totalCents delta expected 21500, got 21501");
  });
});

describe("orders analytics API agent eval", () => {
  maybeIt(
    "builds and live-verifies an order analytics app",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const workload = buildEvalWorkload(suffix);
      const expectedSummaryDelta = summarizeOrders(workload);
      const supplyCategory = `eval-${suffix}-supply`;
      const invalidOrders = [
        { category: `eval-${suffix}-invalid`, amountCents: 100 },
        { item: "ghost", category: `eval-${suffix}-invalid`, amountCents: -5 },
      ];
      const email = `orders-analytics-eval-${suffix}@example.com`;
      const { userId } = await createUser(testEnv, email, "password123", "Orders Analytics Eval");
      const { org, defaultWorkspaceId } = await createOrg(testEnv, `Orders Analytics Eval ${suffix}`, userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(defaultWorkspaceId, "Orders analytics API eval", userId, undefined, testEnv.EVAL_MODEL);
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Orders Analytics Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: `Build and deploy a small order-tracking app as a project named exactly "orders-analytics", deployed with script_name "orders-analytics".
Requirements for the deployed app:
- POST /api/orders accepts JSON { item: string, category: string, amountCents: number }, persists the order durably, and returns the stored order as JSON. Reject invalid bodies (missing or empty item or category, or amountCents that is not a positive integer) with HTTP 400 and a JSON error body.
- GET /api/orders returns JSON { orders: [...] } of all persisted orders, and supports an optional ?category= query parameter that filters by exact category.
- GET /api/summary returns JSON { totalCents, orderCount, byCategory } where byCategory maps each category to { totalCents, orderCount }, all computed from the persisted orders.
- Orders must survive across separate requests using Durable Object storage, not in-memory state.
- The root page is a small HTML UI titled "Orders Analytics" that lists the orders and shows the summary.
When done, reply with the live URL.`,
      });

      const workspaceFs = testEnv.WORKSPACE_FS.get(testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId));
      const project = (await workspaceFs.listProjectsForMigrationReset()).find((candidate) => candidate.name === PROJECT_NAME);
      let deployedApp: EvalDeployedApp | undefined;
      let deployError: string | undefined;
      try {
        deployedApp = assertDeployedApp(result, { name: PROJECT_NAME, hostSuffix: ".evals.camelai.app" });
      } catch (error) {
        deployError = error instanceof Error ? error.message : String(error);
      }

      const verification = {
        workload,
        expectedSummaryDelta,
        postStatuses: [] as number[],
        invalid: [] as Array<{ status: number; json: unknown }>,
        baselineSummary: undefined as { status: number; json: unknown } | undefined,
        listing: undefined as { status: number; json: unknown } | undefined,
        filtered: undefined as { status: number; json: unknown } | undefined,
        summaries: [] as Array<{ status: number; json: unknown }>,
        root: undefined as { status: number; body: string } | undefined,
        readyStatus: undefined as number | undefined,
        failures: [] as string[],
      };
      if (!deployedApp) {
        verification.failures.push(deployError ?? "no deployed app was captured");
      } else {
        try {
          const ready = await fetchWithRetry(deployedApp.url);
          verification.readyStatus = ready.status;
          await ready.body?.cancel();
          if (ready.status !== 200) {
            verification.failures.push(`preflight root returned HTTP ${ready.status}`);
          }
          verification.baselineSummary = await fetchJsonWithRetry(
            appUrl(deployedApp, "/api/summary"),
          );
          for (const order of workload) {
            const response = await fetchJsonWithRetry(appUrl(deployedApp, "/api/orders"), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(order),
            });
            verification.postStatuses.push(response.status);
          }
          for (const invalid of invalidOrders) {
            verification.invalid.push(await fetchJsonWithRetry(appUrl(deployedApp, "/api/orders"), {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(invalid),
            }));
          }
          verification.listing = await fetchJsonWithRetry(appUrl(deployedApp, "/api/orders"));
          verification.filtered = await fetchJsonWithRetry(
            appUrl(deployedApp, `/api/orders?category=${encodeURIComponent(supplyCategory)}`),
          );
          verification.summaries.push(await fetchJsonWithRetry(appUrl(deployedApp, "/api/summary")));
          verification.summaries.push(await fetchJsonWithRetry(appUrl(deployedApp, "/api/summary")));
          const rootResponse = await fetchWithRetry(deployedApp.url);
          verification.root = { status: rootResponse.status, body: await rootResponse.text() };
        } catch (error) {
          verification.failures.push(
            `live verification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const orders = Array.isArray(asRecord(verification.listing?.json)?.orders)
        ? asRecord(verification.listing?.json)!.orders as unknown[]
        : [];
      const filteredOrders = Array.isArray(asRecord(verification.filtered?.json)?.orders)
        ? asRecord(verification.filtered?.json)!.orders as unknown[]
        : [];
      const summaryFailures: string[] = [];
      if (!verification.baselineSummary) {
        summaryFailures.push("baseline summary response missing");
      } else if (verification.baselineSummary.status !== 200) {
        summaryFailures.push(
          `baseline summary returned HTTP ${verification.baselineSummary.status}`,
        );
      }
      verification.summaries.forEach((summary, index) => {
        const path = `summary${index + 1}`;
        if (summary.status !== 200) {
          summaryFailures.push(`${path} returned HTTP ${summary.status}`);
        } else if (verification.baselineSummary?.status === 200) {
          summaryFailures.push(...summaryDeltaFailures(
            verification.baselineSummary.json,
            summary.json,
            expectedSummaryDelta,
            path,
          ));
        }
      });
      if (verification.summaries.length !== 2) {
        summaryFailures.push(`expected two summary responses, got ${verification.summaries.length}`);
      }
      if (verification.summaries.length === 2 &&
        JSON.stringify(verification.summaries[0]?.json) !== JSON.stringify(verification.summaries[1]?.json)) {
        summaryFailures.push("summary responses differed across requests");
      }
      const persistence = await inspectPersistenceConfig(project?.id);
      const invalidBodiesHaveErrors = verification.invalid.length === invalidOrders.length &&
        verification.invalid.every((entry) =>
        entry.status === 400 && typeof asRecord(entry.json)?.error === "string" &&
        String(asRecord(entry.json)?.error).trim().length > 0
      );
      const signal = evaluateAgentEvalSignal(result, getEvalSignalThresholds(testEnv, { maxAssistantTurns: 24, maxBadToolCalls: 4 }));
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const rootBody = verification.root?.body ?? "";
      const validOrdersAccepted = verification.postStatuses.length === workload.length &&
        verification.postStatuses.every((status) => status >= 200 && status < 300);
      const invalidOrdersRejected = verification.invalid.length === invalidOrders.length &&
        verification.invalid.every((entry) => entry.status === 400 && entry.json !== undefined);
      const missingOrders = missingExpectedOrders(orders, workload);
      const ordersListingCorrect = verification.listing?.status === 200 &&
        missingOrders.length === 0;
      const expectedFilteredOrders = workload.filter((order) => order.category === supplyCategory);
      const missingFilteredOrders = missingExpectedOrders(filteredOrders, expectedFilteredOrders);
      const categoryFilterCorrect = verification.filtered?.status === 200 &&
        filteredOrders.length === expectedFilteredOrders.length &&
        missingFilteredOrders.length === 0 &&
        filteredOrders.every((entry) => asRecord(entry)?.category === supplyCategory);
      const finalSummaryTotal = asRecord(verification.summaries[0]?.json)?.totalCents;
      const uiShowsData = workload.some((order) => rootBody.includes(order.item)) &&
        typeof finalSummaryTotal === "number" &&
        (rootBody.includes(String(finalSummaryTotal)) ||
          rootBody.includes((finalSummaryTotal / 100).toFixed(2)));
      const verificationFailure = verification.failures.join("; ");
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({ id: "deployed_app_live", label: "Orders app deployed and is live", passed: verification.root?.status === 200 && rootBody.length > 0, reason: verification.root?.status === 200 && rootBody.length > 0 ? undefined : verificationFailure || deployError || `root status=${verification.root?.status ?? "missing"}`, details: { root: verification.root, failures: verification.failures } }),
          passFailCriterion({ id: "orders_accepted", label: "All six valid orders were accepted", passed: validOrdersAccepted, reason: validOrdersAccepted ? undefined : [`Expected six successful POSTs; statuses: ${verification.postStatuses.join(", ") || "none"}.`, verificationFailure].filter(Boolean).join(" "), details: { statuses: verification.postStatuses, failures: verification.failures } }),
          passFailCriterion({ id: "invalid_orders_rejected", label: "Invalid orders return HTTP 400 JSON", passed: invalidOrdersRejected, reason: invalidOrdersRejected ? undefined : ["One or more invalid orders did not return HTTP 400 JSON.", verificationFailure].filter(Boolean).join(" "), details: { invalid: verification.invalid, failures: verification.failures } }),
          passFailCriterion({ id: "orders_listing_correct", label: "Orders listing contains all six isolated eval orders", passed: ordersListingCorrect, reason: ordersListingCorrect ? undefined : `status=${verification.listing?.status ?? "missing"}, orders=${orders.length}, missing=${missingOrders.length}`, details: { listing: verification.listing, missingOrders } }),
          passFailCriterion({ id: "category_filter_correct", label: "Run-isolated supply filter returns exactly the three eval orders", passed: categoryFilterCorrect, reason: categoryFilterCorrect ? undefined : `status=${verification.filtered?.status ?? "missing"}, orders=${filteredOrders.length}, missing=${missingFilteredOrders.length}, category=${supplyCategory}`, details: { filtered: verification.filtered, expected: expectedFilteredOrders, missing: missingFilteredOrders } }),
          passFailCriterion({ id: "summary_math_correct", label: "Summary changes by the exact eval workload and is stable", passed: summaryFailures.length === 0, reason: summaryFailures.length ? summaryFailures.join("; ") : undefined, details: { baseline: verification.baselineSummary, summaries: verification.summaries, expectedDelta: expectedSummaryDelta, failures: summaryFailures } }),
          passFailCriterion({ id: "durable_object_persistence_configured", label: "Durable Object binding and migration are configured", passed: persistence.configured, reason: persistence.configured ? undefined : persistence.error ?? `binding=${persistence.hasBinding}, migration=${persistence.hasMigration}`, details: persistence }),
          passFailCriterion({ id: "ui_page_served", label: "Root UI is titled Orders Analytics", passed: verification.root?.status === 200 && rootBody.includes("Orders Analytics"), reason: verification.root?.status === 200 && rootBody.includes("Orders Analytics") ? undefined : "Root page did not contain Orders Analytics.", details: verification.root }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreSignalEfficiency(signal, { maxPoints: 4, fallbackPoints: 1, tiers: [{ maxAssistantTurns: 24, maxBadToolCalls: 4, points: 4 }, { maxAssistantTurns: 32, maxBadToolCalls: 6, points: 3 }, { maxAssistantTurns: 44, maxBadToolCalls: 8, points: 2 }] }),
          scoreCriterion({ id: "error_response_quality", label: "Invalid-order bodies include a non-empty error message", points: invalidBodiesHaveErrors ? 3 : 0, maxPoints: 3, reason: invalidBodiesHaveErrors ? undefined : "Not every 400 body had a non-empty error string.", details: verification.invalid }),
          scoreCriterion({ id: "ui_shows_data", label: "Root UI renders workload data and the post-workload total", points: uiShowsData ? 4 : 0, maxPoints: 4, reason: "Scored from post-workload root HTML and summary response.", details: { finalSummaryTotal, bodyExcerpt: rootBody.slice(0, 1000) } }),
          scoreCriterion({ id: "avoided_legacy_paths", label: "Avoided legacy scaffold/deploy paths", points: legacyFailures.length === 0 ? 2 : 0, maxPoints: 2, reason: legacyFailures.length ? legacyFailures.join("; ") : undefined }),
          scoreCriterion({ id: "reply_includes_url", label: "Final reply includes the deployed URL", points: deployedApp && (result.result ?? "").includes(new URL(deployedApp.url).hostname) ? 2 : 0, maxPoints: 2, reason: deployedApp && (result.result ?? "").includes(new URL(deployedApp.url).hostname) ? undefined : "Final reply did not include the deployed hostname." }),
        ],
      });

      emitEvalTranscript({ status: result.status, evaluation, error: result.error, model: testEnv.EVAL_MODEL, signal, deployedApps: result.deployedApps, project, verification, persistence, result: result.result, events: result.events, messages: result.messages });
      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 120_000,
  );
});
