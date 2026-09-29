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
  asString,
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

type BrowserAutomationEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

type SourceInspection = {
  homeExists: boolean;
  homeHasTitle: boolean;
  homeHasCounterButton: boolean;
  homeHasClickedTwiceText: boolean;
  homeError?: string;
};

type AppSmoke = {
  status?: number;
  bodyLength?: number;
  hasTitle: boolean;
  hasCounterButton: boolean;
  hasCounterButtonId: boolean;
  hasInitialCounterText: boolean;
  error?: string;
  failures: string[];
};

type RuntimeItem = Record<string, unknown>;

const PROJECT_NAME = "browser-automation-lab";
const APP_TITLE = "Browser Automation Lab";
const BUTTON_TEXT = "Increment lab counter";
const CLICKED_TWICE_TEXT = "Clicked 2 times";
const PASS_MARKER = '"browserE2E":"passed"';
const testEnv = env as unknown as BrowserAutomationEvalEnv;
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 900_000);

export function normalizeSsrText(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ").trim();
}

function collectRuntimeItems(events: Array<Record<string, unknown>>): RuntimeItem[] {
  const items: RuntimeItem[] = [];
  for (const rawEvent of events) {
    const event = asRecord(rawEvent);
    if (event?.type !== "runtime_event") continue;
    const runtimeEvent = asRecord(event.event);
    if (runtimeEvent?.method !== "item/completed") continue;
    const params = asRecord(runtimeEvent.params);
    const item = asRecord(params?.item);
    if (item) items.push(item);
  }
  return items;
}

function collectItemText(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => asString(asRecord(entry)?.text) ?? "")
    .filter(Boolean);
}

function runtimeToolName(item: RuntimeItem): string | undefined {
  return asString(item.tool)?.toLowerCase();
}

function collectJsExecResultTexts(events: Array<Record<string, unknown>>): string[] {
  return collectRuntimeItems(events)
    .filter((item) => {
      const tool = runtimeToolName(item);
      return tool === "js_exec" || tool?.endsWith("__js_exec") === true;
    })
    .flatMap((item) => [
      ...collectItemText(asRecord(item.result)?.content),
      ...collectItemText(item.contentItems),
    ]);
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
  const homeRead = await readProjectText(project?.id, "/app/routes/home.tsx");
  const home = homeRead.text ?? "";
  return {
    homeExists: Boolean(homeRead.text),
    homeHasTitle: home.includes(APP_TITLE),
    homeHasCounterButton: home.includes(BUTTON_TEXT) && home.includes("lab-counter-button"),
    homeHasClickedTwiceText:
      home.includes(CLICKED_TWICE_TEXT) ||
      (home.includes("Clicked") && home.includes("count") && home.includes("time")),
    homeError: homeRead.error,
  };
}

async function smokeCheckDeployedApp(app: EvalDeployedApp | undefined): Promise<AppSmoke> {
  const failures: string[] = [];
  if (!app) {
    return {
      hasTitle: false,
      hasCounterButton: false,
      hasCounterButtonId: false,
      hasInitialCounterText: false,
      failures: ["no deployed app was captured"],
    };
  }
  try {
    const response = await fetchWithRetry(app.url);
    const body = await response.text();
    const normalizedBodyText = normalizeSsrText(body);
    const smoke = {
      status: response.status,
      bodyLength: body.length,
      hasTitle: body.includes(APP_TITLE),
      hasCounterButton: body.includes(BUTTON_TEXT),
      hasCounterButtonId: /id=["']lab-counter-button["']/.test(body),
      hasInitialCounterText: normalizedBodyText.includes("Clicked 0 times"),
      failures,
    };
    if (response.status !== 200) failures.push(`root returned HTTP ${response.status}`);
    if (body.length === 0) failures.push("root returned an empty body");
    if (!smoke.hasTitle) failures.push(`root did not include ${APP_TITLE}`);
    if (!smoke.hasCounterButton) failures.push(`root did not include ${BUTTON_TEXT}`);
    if (!smoke.hasCounterButtonId) failures.push("root did not include lab-counter-button id");
    if (!smoke.hasInitialCounterText) failures.push("root did not include Clicked 0 times");
    return smoke;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      hasTitle: false,
      hasCounterButton: false,
      hasCounterButtonId: false,
      hasInitialCounterText: false,
      error: message,
      failures: [`root fetch failed: ${message}`],
    };
  }
}

describe("browser automation SSR verification", () => {
  it("recognizes visible counter text split by React SSR comments", () => {
    expect(normalizeSsrText("<p>Clicked <!-- -->0<!-- --> times</p>"))
      .toContain("Clicked 0 times");
  });
});

function outputExcerpt(text: string): string {
  const sanitized = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return sanitized.length > 800 ? `${sanitized.slice(0, 800)}...` : sanitized;
}

describe("browser automation agent eval", () => {
  maybeIt(
    "requires the agent to deploy an app and verify it with env.BROWSER",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const { userId } = await createUser(
        testEnv,
        `browser-automation-eval-${suffix}@example.com`,
        "password123",
        "Browser Automation Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Browser Automation Eval ${suffix}`,
        userId,
      );

      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Browser automation eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const appsBefore = await countWorkspaceApps(orgStub, defaultWorkspaceId);

      const result = await runRuntimeEval(testEnv, {
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Browser Automation Eval",
        userEmail: `browser-automation-eval-${suffix}@example.com`,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Create a new DO-backed React Router project named exactly "${PROJECT_NAME}" using create_project with a concise description.`,
          `Replace the home page with a small interactive client component titled exactly "${APP_TITLE}".`,
          `The page must render a button with id "lab-counter-button" and visible text "${BUTTON_TEXT}". Clicking it increments visible text from "Clicked 0 times" to "Clicked 1 time" to exactly "${CLICKED_TWICE_TEXT}".`,
          `Deploy it with deploy_project using script_name exactly "${PROJECT_NAME}".`,
          `After deploying, attempt an interactive browser automation check in js_exec using env.BROWSER.launch({ scriptName: "${PROJECT_NAME}", path: "/" }): click #lab-counter-button twice, wait for the text "${CLICKED_TWICE_TEXT}", read logs(), and console.log JSON containing exactly ${PASS_MARKER} if every step succeeded.`,
          "If env.BROWSER is unavailable in this environment, say so explicitly in your reply instead of pretending the check ran.",
          "Always close the browser session in a finally block. When done, reply with the deployed URL and the browser automation result.",
        ].join(" "),
      });

      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 18,
          maxBadToolCalls: 4,
        }),
      );
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
      const runtimeEvidence = collectRuntimeEvidence(result.events);
      const runtimeResultTexts = collectJsExecResultTexts(result.events);
      const runtimeOutputText = runtimeResultTexts.join("\n");
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const runtimeAssertions = {
        usedCreateProject: usedTool(result.events, "create_project", [
          /\bPROJECTS\s*\.\s*create\s*\(/i,
        ]),
        usedDeployProject: usedTool(result.events, "deploy_project"),
        usedJsExec: usedTool(result.events, "js_exec"),
        attemptedBrowserLaunch: runtimeEvidence.jsExecCodeBlocks.some((code) =>
          /\benv\s*\.\s*BROWSER\s*\.\s*launch\s*\(/.test(code)
        ),
        usedBrowserSessionActions: ["click", "waitForText", "logs", "close"].every((method) =>
          runtimeEvidence.jsExecCodeBlocks.some((code) => new RegExp(`\\.${method}\\s*\\(`).test(code))
        ),
        browserPassMarkerFound: runtimeOutputText.includes(PASS_MARKER),
        browserLaunchInfrastructureFailure:
          runtimeOutputText.includes("Browser sessions require the BROWSER binding") ||
          runtimeOutputText.includes("env.BROWSER is not configured") ||
          runtimeOutputText.includes("ServiceStub serialization requires the 'experimental' compat flag"),
        legacyFailures,
        evidence: runtimeEvidence,
        outputExcerpts: runtimeResultTexts.map(outputExcerpt),
      };
      const finalResult = result.result ?? "";
      const honestlyReportedEnvironment = runtimeAssertions.browserPassMarkerFound ||
        /browser.{0,40}(unavailable|not available|binding|not configured)/i.test(finalResult) ||
        /(unavailable|not available|not configured).{0,40}browser/i.test(finalResult);

      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "project_created_do_backed",
            label: "Agent created a DO-backed project",
            passed: project?.backend === "do-r2" && runtimeAssertions.usedCreateProject,
            reason: project
              ? `Project backend was ${project.backend}, create_project=${runtimeAssertions.usedCreateProject}`
              : `No project named ${PROJECT_NAME} was created.`,
            details: { project, runtimeAssertions },
          }),
          passFailCriterion({
            id: "interactive_source_present",
            label: "Interactive counter source is present",
            passed:
              sourceInspection.homeExists &&
              sourceInspection.homeHasTitle &&
              sourceInspection.homeHasCounterButton &&
              sourceInspection.homeHasClickedTwiceText,
            reason:
              sourceInspection.homeExists &&
              sourceInspection.homeHasTitle &&
              sourceInspection.homeHasCounterButton &&
              sourceInspection.homeHasClickedTwiceText
                ? undefined
                : "Home route was missing the required title, button, or clicked-twice text behavior.",
            details: sourceInspection,
          }),
          passFailCriterion({
            id: "app_deployed",
            label: "Agent deployed a real eval app",
            passed:
              runtimeAssertions.usedDeployProject &&
              Boolean(deployedApp) &&
              appsAfter === appsBefore + 1,
            reason:
              runtimeAssertions.usedDeployProject && Boolean(deployedApp) && appsAfter === appsBefore + 1
                ? undefined
                : `deploy_project=${runtimeAssertions.usedDeployProject}, deployedApp=${Boolean(deployedApp)}, appsBefore=${appsBefore}, appsAfter=${appsAfter}, error=${deployedAppError ?? "none"}`,
            details: { deployedApp, appsBefore, appsAfter, runtimeAssertions },
          }),
          passFailCriterion({
            id: "deployed_app_interactivity_present",
            label: "Deployed app serves the interactive counter contract",
            passed: appSmoke.failures.length === 0,
            reason: appSmoke.failures.length ? appSmoke.failures.join("; ") : undefined,
            details: appSmoke,
          }),
          passFailCriterion({
            id: "browser_automation_attempted",
            label: "Agent attempted env.BROWSER browser automation",
            passed:
              runtimeAssertions.usedJsExec &&
              runtimeAssertions.attemptedBrowserLaunch,
            reason:
              runtimeAssertions.usedJsExec &&
              runtimeAssertions.attemptedBrowserLaunch
                ? undefined
                : `jsExec=${runtimeAssertions.usedJsExec}, launch=${runtimeAssertions.attemptedBrowserLaunch}`,
            details: runtimeAssertions,
          }),
          passFailCriterion({
            id: "avoided_legacy_deploy_path",
            label: "Agent avoided legacy scaffold/deploy paths",
            passed: legacyFailures.length === 0,
            reason: legacyFailures.length ? legacyFailures.join("; ") : undefined,
            details: runtimeAssertions,
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "browser_workflow_quality",
            label: "Browser launch, interaction workflow, and pass marker quality",
            points:
              (runtimeAssertions.attemptedBrowserLaunch ? 2 : 0) +
              (runtimeAssertions.usedBrowserSessionActions ? 2 : 0) +
              (runtimeAssertions.browserPassMarkerFound ? 4 : 0),
            maxPoints: 8,
            reason: `launch=${runtimeAssertions.attemptedBrowserLaunch}, actions=${runtimeAssertions.usedBrowserSessionActions}, marker=${runtimeAssertions.browserPassMarkerFound}`,
            details: runtimeAssertions,
          }),
          scoreCriterion({
            id: "honest_env_reporting",
            label: "Final reply reports browser success or binding unavailability honestly",
            points: honestlyReportedEnvironment ? 2 : 0,
            maxPoints: 2,
            reason: honestlyReportedEnvironment
              ? undefined
              : "Final reply neither had pass evidence nor reported the unavailable browser binding.",
            details: {
              finalResult,
              browserPassMarkerFound: runtimeAssertions.browserPassMarkerFound,
            },
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 14, maxBadToolCalls: 2, points: 4 },
              { maxAssistantTurns: 18, maxBadToolCalls: 4, points: 3 },
              { maxAssistantTurns: 26, maxBadToolCalls: 8, points: 2 },
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
        appSmoke,
        runtimeAssertions,
        sourceInspection,
        result: result.result,
        eventCount: result.events.length,
        messageCount: result.messages.length,
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 120_000,
  );
});
