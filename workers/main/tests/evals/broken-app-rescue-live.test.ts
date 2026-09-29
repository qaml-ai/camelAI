import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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
  scoreCriterion,
  scoreSignalEfficiency,
} from "./eval-criteria";
import { assertDeployedApp, assertJsonSubset, fetchJsonWithRetry, type EvalDeployedApp } from "./eval-deploy-assert";
import { emitEvalTranscript } from "./eval-transcript";
import { evaluateAgentEvalSignal, getEvalSignalThresholds, type EvalSignalEnv } from "./eval-signal";
import { configureEvalModel, getEvalTimeoutMs, type EvalModelEnv } from "./model-config";
import {
  asRecord,
  diffProjectFileSnapshots,
  fetchWithRetry,
  legacyDeployPathEvidence,
  seedDoProjectFiles,
  snapshotProjectFiles,
  type ProjectFileDiff,
} from "./project-eval-helpers";

type BrokenAppRescueEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

const PROJECT_NAME = "expense-portal";
const EXPENSE_ROWS = [
  { item: "Flight", category: "travel", amountCents: 4200 },
  { item: "Team lunch", category: "meals", amountCents: 1850 },
  { item: "Monitor", category: "equipment", amountCents: 12500 },
  { item: "Taxi", category: "travel", amountCents: 3100 },
  { item: "Coffee", category: "meals", amountCents: 900 },
  { item: "Keyboard", category: "equipment", amountCents: 4900 },
] as const;
const EXPECTED_SUMMARY = {
  totalCents: 27450,
  orderCount: 6,
  byCategory: {
    travel: { totalCents: 7300, orderCount: 2 },
    meals: { totalCents: 2750, orderCount: 2 },
    equipment: { totalCents: 17400, orderCount: 2 },
  },
};

const EXPENSES_SOURCE = `export const EXPENSES = ${JSON.stringify(EXPENSE_ROWS, null, 2)} as const;

export function summarizeExpenses() {
  let totalCents = 0;
  const byCategory: Record<string, { totalCents: number; orderCount: number }> = {};
  for (const expense of EXPENSES) {
    totalCents = expense.amountCents;
    const key = expense.item;
    const current = byCategory[key] ?? { totalCents: 0, orderCount: 0 };
    current.totalCents += expense.amountCents;
    current.orderCount += 1;
    byCategory[key] = current;
  }
  return { totalCents, orderCount: EXPENSES.length, byCategory };
}
`;

const WORKER_SOURCE = `import { createRequestHandler } from "react-router";
import { summarizeExpenses } from "../app/lib/expense";
import { runRuntimeEval } from "./runtime-eval";

interface Env { ASSETS?: { fetch(request: Request): Promise<Response> | Response } }
const requestHandler = createRequestHandler(() => import("virtual:react-router/server-build"), import.meta.env.MODE);
function shouldServeAsset(request: Request) {
  const pathname = new URL(request.url).pathname;
  return (request.method === "GET" || request.method === "HEAD") && (pathname.startsWith("/assets/") || pathname.includes("."));
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/api/expenses/summary") {
      return Response.json(summarizeExpenses());
    }
    if (env.ASSETS && shouldServeAsset(request)) {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) return response;
    }
    return requestHandler(request, { cloudflare: { env, ctx } });
  },
} satisfies ExportedHandler<Env>;
`;

const HOME_SOURCE = `import { summarizeExpenses } from "~/lib/expenses";

function formatCents(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 10);
}

export function meta() { return [{ title: "Expense Portal" }]; }
export default function Home() {
  const summary = summarizeExpenses();
  return <main><h1>Expense Portal</h1><p>EXPENSE_PORTAL_TOTAL Total spent: {formatCents(summary.totalCents)}</p></main>;
}
`;

const SEEDED_FILES: Record<string, string> = {
  "/app/lib/expenses.ts": EXPENSES_SOURCE,
  "/workers/app.ts": WORKER_SOURCE,
  "/app/routes/home.tsx": HOME_SOURCE,
};
const GENERATED_BUILD_PATHS = new Set([
  "/bun.lock",
  "/.camelai/tmp/build.log",
]);

const testEnv = env as unknown as BrokenAppRescueEvalEnv;
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 900_000);

type ParsedExpenseRow = {
  item: string;
  category: string;
  amountCents: number;
};

function stripSourceComments(source: string): string {
  let output = "";
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
    if (quote) {
      output += char;
      if (char === "\\") {
        index += 1;
        output += source[index] ?? "";
      } else if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < source.length && source[index] !== "\n") index += 1;
      output += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < source.length && !(source[index] === "*" && source[index + 1] === "/")) {
        if (source[index] === "\n") output += "\n";
        index += 1;
      }
      index += 1;
      continue;
    }
    output += char;
  }
  return output;
}

function splitTopLevelList(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let roundDepth = 0;
  let squareDepth = 0;
  let braceDepth = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "(") roundDepth += 1;
    else if (char === ")") roundDepth -= 1;
    else if (char === "[") squareDepth += 1;
    else if (char === "]") squareDepth -= 1;
    else if (char === "{") braceDepth += 1;
    else if (char === "}") braceDepth -= 1;
    else if (char === "," && roundDepth === 0 && squareDepth === 0 && braceDepth === 0) {
      const part = source.slice(start, index).trim();
      if (part) parts.push(part);
      start = index + 1;
    }
  }
  const finalPart = source.slice(start).trim();
  if (finalPart) parts.push(finalPart);
  return parts;
}

function findTopLevelColon(source: string): number {
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "{" || char === "[" || char === "(") depth += 1;
    else if (char === "}" || char === "]" || char === ")") depth -= 1;
    else if (char === ":" && depth === 0) return index;
  }
  return -1;
}

function parseStringLiteral(source: string): string {
  const text = source.trim();
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.at(-1) !== quote) {
    throw new Error(`Expected a quoted string, got ${text}`);
  }
  if (quote === '"') return JSON.parse(text) as string;
  let value = "";
  const escapes: Record<string, string> = {
    "\\": "\\",
    "'": "'",
    '"': '"',
    n: "\n",
    r: "\r",
    t: "\t",
    b: "\b",
    f: "\f",
  };
  for (let index = 1; index < text.length - 1; index += 1) {
    const char = text[index];
    if (char !== "\\") {
      value += char;
      continue;
    }
    const escaped = text[++index];
    if (!(escaped in escapes)) throw new Error(`Unsupported string escape \\${escaped}`);
    value += escapes[escaped];
  }
  return value;
}

function parseExpenseObject(source: string, index: number): ParsedExpenseRow {
  const text = source.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    throw new Error(`EXPENSES[${index}] is not an object literal`);
  }
  const values: Partial<ParsedExpenseRow> = {};
  for (const field of splitTopLevelList(text.slice(1, -1))) {
    const colon = findTopLevelColon(field);
    if (colon < 0) throw new Error(`EXPENSES[${index}] contains an invalid field`);
    const rawKey = field.slice(0, colon).trim();
    const key = /^[A-Za-z_$][\w$]*$/.test(rawKey)
      ? rawKey
      : parseStringLiteral(rawKey);
    if (key !== "item" && key !== "category" && key !== "amountCents") {
      throw new Error(`EXPENSES[${index}] contains unexpected field ${key}`);
    }
    if (Object.prototype.hasOwnProperty.call(values, key)) {
      throw new Error(`EXPENSES[${index}] repeats field ${key}`);
    }
    const rawValue = field.slice(colon + 1).trim();
    if (key === "amountCents") {
      if (!/^-?\d+$/.test(rawValue)) {
        throw new Error(`EXPENSES[${index}].amountCents is not an integer literal`);
      }
      values.amountCents = Number(rawValue);
    } else {
      values[key] = parseStringLiteral(rawValue);
    }
  }
  if (
    typeof values.item !== "string" ||
    typeof values.category !== "string" ||
    !Number.isSafeInteger(values.amountCents)
  ) {
    throw new Error(`EXPENSES[${index}] does not contain exactly item, category, and amountCents`);
  }
  return values as ParsedExpenseRow;
}

export function parseExpenseRowsFromSource(source: string): ParsedExpenseRow[] {
  const text = stripSourceComments(source);
  const declaration = /\bconst\s+EXPENSES\b[^=;\n]*=/.exec(text);
  if (!declaration) throw new Error("Could not find the EXPENSES declaration");
  let start = declaration.index + declaration[0].length;
  while (/\s/.test(text[start] ?? "")) start += 1;
  if (text[start] !== "[") throw new Error("EXPENSES is not initialized with an array literal");
  let end = -1;
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end < 0) throw new Error("EXPENSES array literal is unterminated");
  return splitTopLevelList(text.slice(start + 1, end)).map(parseExpenseObject);
}

export function scoreableRescueChangedPaths(changedPaths: string[]): string[] {
  return changedPaths.filter((path) => !GENERATED_BUILD_PATHS.has(path));
}

export function scoreRescueMinimalDiff(changedPaths: string[]): number {
  const count = scoreableRescueChangedPaths(changedPaths).length;
  return count <= 3 ? 4 : count <= 5 ? 2 : 0;
}

function expectedSummaryFromRows() {
  const byCategory: Record<string, { totalCents: number; orderCount: number }> = {};
  let totalCents = 0;
  for (const row of EXPENSE_ROWS) {
    totalCents += row.amountCents;
    const bucket = byCategory[row.category] ?? { totalCents: 0, orderCount: 0 };
    bucket.totalCents += row.amountCents;
    bucket.orderCount += 1;
    byCategory[row.category] = bucket;
  }
  return { totalCents, orderCount: EXPENSE_ROWS.length, byCategory };
}

function diagnosedBeforeEditing(events: Array<Record<string, unknown>>): boolean {
  let firstRead = Number.POSITIVE_INFINITY;
  let firstWrite = Number.POSITIVE_INFINITY;
  events.forEach((rawEvent, index) => {
    const event = asRecord(rawEvent);
    const runtime = asRecord(event?.event);
    const item = asRecord(asRecord(runtime?.params)?.item);
    if (event?.type !== "runtime_event" || runtime?.method !== "item/completed" || !item) return;
    const tool = typeof item.tool === "string" ? item.tool.toLowerCase() : "";
    const code = JSON.stringify(item.arguments ?? {}).toLowerCase();
    if (["read", "ls", "list_files"].some((name) => tool === name || tool.endsWith(`__${name}`)) || /tools\.(?:read|ls|list_files)\s*\(/.test(code)) firstRead = Math.min(firstRead, index);
    if (["write", "edit"].some((name) => tool === name || tool.endsWith(`__${name}`)) || /tools\.(?:write|edit)\s*\(/.test(code)) firstWrite = Math.min(firstWrite, index);
  });
  return Number.isFinite(firstRead) && firstRead < firstWrite;
}

describe("broken app rescue fixture", () => {
  it("keeps the ground truth and all three planted defects intact", () => {
    expect(expectedSummaryFromRows()).toEqual(EXPECTED_SUMMARY);
    expect(parseExpenseRowsFromSource(EXPENSES_SOURCE)).toEqual(
      EXPENSE_ROWS.map((row) => ({ ...row })),
    );
    expect(EXPENSES_SOURCE).toContain("totalCents = expense.amountCents");
    expect(EXPENSES_SOURCE).toContain("const key = expense.item");
    expect(WORKER_SOURCE).toContain('from "../app/lib/expense"');
    expect(HOME_SOURCE).toContain("value / 10");
  });

  it("parses the declared array instead of accepting literals left in comments", () => {
    const changed = `${EXPENSES_SOURCE.replace('"Flight"', '"Hotel"')}\n// Original row: ${JSON.stringify(EXPENSE_ROWS[0])}`;
    expect(parseExpenseRowsFromSource(changed)).not.toEqual(
      EXPENSE_ROWS.map((row) => ({ ...row })),
    );
  });

  it("excludes only known generated build artifacts from minimal-diff scoring", () => {
    const idealRepairPaths = [
      ...Object.keys(SEEDED_FILES),
      "/bun.lock",
      "/.camelai/tmp/build.log",
    ];
    expect(scoreableRescueChangedPaths(idealRepairPaths))
      .toEqual(Object.keys(SEEDED_FILES));
    expect(scoreRescueMinimalDiff(idealRepairPaths)).toBe(4);
    expect(scoreableRescueChangedPaths([...idealRepairPaths, "/README.md"]))
      .toEqual([...Object.keys(SEEDED_FILES), "/README.md"]);
  });
});

describe("broken app rescue agent eval", () => {
  maybeIt(
    "diagnoses, repairs, and redeploys a seeded app",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `broken-app-rescue-${suffix}@example.com`;
      const { userId } = await createUser(testEnv, email, "password123", "Broken App Rescue Eval");
      const { org, defaultWorkspaceId } = await createOrg(testEnv, `Broken App Rescue ${suffix}`, userId);
      const workspaceFs = testEnv.WORKSPACE_FS.get(testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId));
      const { project, files } = await seedDoProjectFiles(workspaceFs, testEnv, {
        workspaceId: defaultWorkspaceId,
        name: PROJECT_NAME,
        description: "Seeded broken expense report app.",
        files: SEEDED_FILES,
      });
      const initialProjectSnapshot = await snapshotProjectFiles(files);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(defaultWorkspaceId, "Broken app rescue eval", userId, undefined, testEnv.EVAL_MODEL);
      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Broken App Rescue Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: `My expense report app in the existing project "expense-portal" is broken and I need it working today.
Deploying it currently fails with a build error. The last time it did deploy, the summary API returned obviously wrong numbers, and the page showed the wrong total dollars.
Find and fix the problems in the existing project without rewriting it and without changing the expense data, then deploy it with script_name "expense-portal".
Reply with the live URL and the correct total dollars shown on the page.`,
      });

      let deployedApp: EvalDeployedApp | undefined;
      let deployError: string | undefined;
      try {
        deployedApp = assertDeployedApp(result, { name: PROJECT_NAME, hostSuffix: ".evals.camelai.app" });
      } catch (error) {
        deployError = error instanceof Error ? error.message : String(error);
      }
      const smoke = {
        summary: undefined as { status: number; json: unknown } | undefined,
        page: undefined as { status: number; body: string } | undefined,
        failures: [] as string[],
      };
      if (!deployedApp) {
        smoke.failures.push(deployError ?? "no deployed app was captured");
      } else {
        try {
          smoke.summary = await fetchJsonWithRetry(new URL("/api/expenses/summary", deployedApp.url).toString());
          const pageUrl = new URL(deployedApp.url);
          pageUrl.searchParams.set("eval_smoke", String(Date.now()));
          const pageResponse = await fetchWithRetry(pageUrl.toString(), {
            headers: { "cache-control": "no-cache" },
          });
          smoke.page = { status: pageResponse.status, body: await pageResponse.text() };
        } catch (error) {
          smoke.failures.push(
            `live verification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const summaryFailures = smoke.summary
        ? [
            ...(smoke.summary.status === 200 ? [] : [`summary returned HTTP ${smoke.summary.status}`]),
            ...assertJsonSubset(smoke.summary.json, EXPECTED_SUMMARY, "summary"),
          ]
        : ["summary response missing"];
      const pageBody = smoke.page?.body ?? "";
      const finalExpensesRead = await files.readFile("/app/lib/expenses.ts");
      const finalExpenses = finalExpensesRead.content ?? "";
      let parsedExpenseRows: ParsedExpenseRow[] | undefined;
      let expenseDataParseError: string | undefined;
      try {
        parsedExpenseRows = parseExpenseRowsFromSource(finalExpenses);
      } catch (error) {
        expenseDataParseError = error instanceof Error ? error.message : String(error);
      }
      const expectedExpenseRows = EXPENSE_ROWS.map((row) => ({ ...row }));
      const dataUnchanged = JSON.stringify(parsedExpenseRows) === JSON.stringify(expectedExpenseRows);
      let projectDiff: ProjectFileDiff | undefined;
      let projectDiffError: string | undefined;
      try {
        const finalProjectSnapshot = await snapshotProjectFiles(files);
        projectDiff = diffProjectFileSnapshots(initialProjectSnapshot, finalProjectSnapshot);
      } catch (error) {
        projectDiffError = error instanceof Error ? error.message : String(error);
      }
      const changedPaths = projectDiff?.changedPaths ?? [];
      const scoredChangedPaths = scoreableRescueChangedPaths(changedPaths);
      const ignoredGeneratedPaths = changedPaths.filter((path) =>
        GENERATED_BUILD_PATHS.has(path)
      );
      const minimalDiffPoints = projectDiffError
        ? 0
        : scoreRescueMinimalDiff(changedPaths);
      const signal = evaluateAgentEvalSignal(result, getEvalSignalThresholds(testEnv, { maxAssistantTurns: 20, maxBadToolCalls: 3 }));
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const diagnosedFirst = diagnosedBeforeEditing(result.events);
      const finalResult = result.result ?? "";
      const smokeFailure = smoke.failures.join("; ");
      const pageShowsCorrectTotal = smoke.page?.status === 200 &&
        pageBody.includes("EXPENSE_PORTAL_TOTAL") &&
        pageBody.includes("$274.50") &&
        !pageBody.includes("$2745.00") &&
        !pageBody.includes("NaN");
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({ id: "deployed_app_live", label: "Repaired app deployed and is live", passed: smoke.page?.status === 200 && pageBody.length > 0, reason: smoke.page?.status === 200 && pageBody.length > 0 ? undefined : smokeFailure || deployError || `page status=${smoke.page?.status ?? "missing"}`, details: { page: smoke.page, failures: smoke.failures } }),
          passFailCriterion({ id: "summary_api_correct", label: "Summary API returns the exact corrected totals", passed: summaryFailures.length === 0, reason: summaryFailures.length ? summaryFailures.join("; ") : undefined, details: { summary: smoke.summary, failures: summaryFailures } }),
          passFailCriterion({ id: "page_shows_correct_total", label: "Page shows $274.50 and no bad total", passed: pageShowsCorrectTotal, reason: pageShowsCorrectTotal ? undefined : "Page did not contain the marker and exact corrected $274.50 total without bad values.", details: { status: smoke.page?.status, bodyExcerpt: pageBody.slice(0, 1200) } }),
          passFailCriterion({ id: "expense_data_unchanged", label: "The seeded EXPENSES rows remain exactly unchanged", passed: finalExpensesRead.success && dataUnchanged, reason: finalExpensesRead.success && dataUnchanged ? undefined : finalExpensesRead.error ?? expenseDataParseError ?? "The parsed EXPENSES array differed from the seeded rows.", details: { expected: expectedExpenseRows, actual: parsedExpenseRows, parseError: expenseDataParseError } }),
          passFailCriterion({ id: "final_response_has_total", label: "Final response includes $274.50", passed: finalResult.includes("$274.50"), reason: finalResult.includes("$274.50") ? undefined : "Final response did not include $274.50.", details: { finalResult } }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({ id: "minimal_diff", label: "No more than three non-generated project files changed", points: minimalDiffPoints, maxPoints: 4, reason: projectDiffError ?? `${scoredChangedPaths.length} non-generated project file(s) added, removed, or modified.`, details: { ...projectDiff, scoredChangedPaths, ignoredGeneratedPaths, error: projectDiffError } }),
          scoreSignalEfficiency(signal, { maxPoints: 4, fallbackPoints: 1, tiers: [{ maxAssistantTurns: 20, maxBadToolCalls: 3, points: 4 }, { maxAssistantTurns: 28, maxBadToolCalls: 5, points: 3 }, { maxAssistantTurns: 38, maxBadToolCalls: 8, points: 2 }] }),
          scoreCriterion({ id: "diagnosed_before_editing", label: "Project files were inspected before the first edit", points: diagnosedFirst ? 2 : 0, maxPoints: 2, reason: diagnosedFirst ? undefined : "No project read/list evidence preceded the first write/edit." }),
          scoreCriterion({ id: "avoided_legacy_paths", label: "Avoided legacy scaffold/deploy paths", points: legacyFailures.length === 0 ? 2 : 0, maxPoints: 2, reason: legacyFailures.length ? legacyFailures.join("; ") : undefined }),
          scoreCriterion({ id: "reply_quality", label: "Final reply includes the live URL and corrected total", points: deployedApp && finalResult.includes(new URL(deployedApp.url).hostname) && finalResult.includes("$274.50") ? 2 : 0, maxPoints: 2, reason: "Scored from URL and total tokens in the final reply." }),
        ],
      });

      emitEvalTranscript({ status: result.status, evaluation, error: result.error, model: testEnv.EVAL_MODEL, signal, deployedApps: result.deployedApps, project, smoke, summaryFailures, parsedExpenseRows, expenseDataParseError, projectDiff, projectDiffError, changedPaths, scoredChangedPaths, ignoredGeneratedPaths, result: result.result, events: result.events, messages: result.messages });
      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 120_000,
  );
});
