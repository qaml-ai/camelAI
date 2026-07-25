import { env } from "cloudflare:test";
import { describe, it } from "vitest";

import { isRealEvalDeployEnabled } from "../../src/eval-deploy-context";
import type { ChatThreadDO } from "../../src/chat-thread-do";
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
import {
  assertDeployedApp,
  type EvalDeployedApp,
} from "./eval-deploy-assert";
import { emitEvalTranscript } from "./eval-transcript";
import {
  evaluateAgentEvalSignal,
  getEvalSignalThresholds,
  type EvalSignalEnv,
} from "./eval-signal";
import {
  diffProjectFileSnapshots,
  fetchWithRetry,
  legacyDeployPathEvidence,
  seedDoProjectFiles,
  snapshotProjectFiles,
  type ProjectFileDiff,
} from "./project-eval-helpers";
import {
  configureEvalModel,
  getEvalTimeoutMs,
  type EvalModelEnv,
} from "./model-config";

type LoginFlowRescueEvalEnv = TestEnv & EvalModelEnv & EvalSignalEnv & {
  CHAT_THREAD: DurableObjectNamespace<ChatThreadDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  RUN_AGENT_EVALS?: string;
  EVAL_REAL_DEPLOY?: string;
  CF_API_TOKEN?: string;
};

const PROJECT_NAME = "login-portal";
const USERNAME = "operator";
const CORRECT_PASSWORD = "Cedar-Bridge-42!";
const WRONG_PASSWORD = "Cedar-Bridge-99!";
const HOME_MARKER = "EXISTING_OPERATIONS_HOME";
const LOGIN_MARKER = "LOGIN_PORTAL_FORM";
const ADMIN_MARKER = "PROTECTED_ADMIN_CONSOLE";
const GENERATED_BUILD_PATHS = new Set(["/bun.lock", "/.camelai/tmp/build.log"]);
const testEnv = env as unknown as LoginFlowRescueEvalEnv;
const maybeIt = isRealEvalDeployEnabled(testEnv) ? it : it.skip;
const SESSION_TIMEOUT_MS = getEvalTimeoutMs(testEnv, 900_000);

const RUBRIC = {
  version: 1,
  objective:
    "Diagnose and minimally repair an existing deployed login flow, proving both negative and positive authentication behavior instead of declaring success from one API response.",
  passThreshold: 75,
  criticalMinimum: 3,
  criteria: [
    {
      id: "authentication_correctness",
      description:
        "Wrong credentials are rejected, correct credentials create a session, and the protected route enforces that session.",
      weight: 40,
      critical: true,
      evidenceHints: ["smoke", "runtimeAssertions"],
    },
    {
      id: "user_flow_verification",
      description:
        "The deployed login page remains usable and the repair addresses the client-side loading/navigation failure, not just the POST endpoint.",
      weight: 30,
      critical: true,
      evidenceHints: ["result", "sourceInspection", "smoke"],
    },
    {
      id: "scoped_repair",
      description:
        "The agent fixes the existing project and preserves the operations home instead of replacing the application.",
      weight: 20,
      critical: false,
      evidenceHints: ["projectDiff", "sourceInspection"],
    },
    {
      id: "evidence_quality",
      description:
        "The handoff reports the live URL and distinguishes the invalid-login, valid-login, and protected-route checks performed.",
      weight: 10,
      critical: false,
      evidenceHints: ["result", "trajectory"],
    },
  ],
} as const;

const SEEDED_FILES: Record<string, string> = {
  "/app/routes.ts": `import { index, route, type RouteConfig } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("login", "routes/login.tsx"),
  route("admin", "routes/admin.tsx"),
] satisfies RouteConfig;
`,
  "/app/routes/home.tsx": `export default function Home() {
  return (
    <main>
      <h1>Operations Portal</h1>
      <p>${HOME_MARKER}</p>
      <a href="/login">Team login</a>
    </main>
  );
}
`,
  "/app/routes/login.tsx": `import { useState } from "react";
import { useNavigate } from "react-router";

export default function Login() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success?: boolean; error?: string }>();
  if (result?.success) navigate("/admin");

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setLoading(true);
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: form.get("username"),
        password: form.get("password"),
      }),
    });
    setResult(await response.json());
  }

  return (
    <main>
      <h1>Team login</h1>
      <p>${LOGIN_MARKER}</p>
      <form onSubmit={submit}>
        <input name="username" aria-label="Username" />
        <input name="password" type="password" aria-label="Password" />
        <button type="submit" disabled={loading}>
          {loading ? "Signing in..." : "Sign in"}
        </button>
      </form>
      {result?.error ? <p role="alert">{result.error}</p> : null}
    </main>
  );
}
`,
  "/app/routes/admin.tsx": `export default function Admin() {
  return (
    <main>
      <h1>Admin console</h1>
      <p>${ADMIN_MARKER}</p>
    </main>
  );
}
`,
  "/workers/app.ts": `import { createRequestHandler } from "react-router";

interface Env {
  ASSETS?: { fetch(request: Request): Promise<Response> | Response };
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function shouldServeAsset(request: Request): boolean {
  const pathname = new URL(request.url).pathname;
  return (request.method === "GET" || request.method === "HEAD") &&
    (pathname.startsWith("/assets/") || pathname.includes("."));
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/api/login" && request.method === "POST") {
      const body = await request.json<{ username?: string; password?: string }>();
      return Response.json({
        success: body.username === "${USERNAME}",
        error: body.username === "${USERNAME}" ? undefined : "Invalid credentials",
      });
    }
    if (env.ASSETS && shouldServeAsset(request)) {
      const response = await env.ASSETS.fetch(request);
      if (response.status !== 404) return response;
    }
    return requestHandler(request, { cloudflare: { env, ctx } });
  },
} satisfies ExportedHandler<Env>;
`,
};

async function jsonRecord(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json();
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

function appUrl(app: EvalDeployedApp, path: string): string {
  return new URL(path, app.url).toString();
}

describe("login flow rescue agent eval", () => {
  maybeIt(
    "repairs invalid-login, session, protected-route, and client-flow behavior",
    async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const email = `login-flow-rescue-${suffix}@example.com`;
      const { userId } = await createUser(
        testEnv,
        email,
        "password123",
        "Login Flow Rescue Eval",
      );
      const { org, defaultWorkspaceId } = await createOrg(
        testEnv,
        `Login Flow Rescue ${suffix}`,
        userId,
      );
      const workspaceFs = testEnv.WORKSPACE_FS.get(
        testEnv.WORKSPACE_FS.idFromName(defaultWorkspaceId),
      );
      const { project, files } = await seedDoProjectFiles(workspaceFs, testEnv, {
        workspaceId: defaultWorkspaceId,
        name: PROJECT_NAME,
        description: "A seeded operations portal with a broken login flow.",
        files: SEEDED_FILES,
      });
      const initialSnapshot = await snapshotProjectFiles(files);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      await configureEvalModel(testEnv, orgStub, userId);
      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        "Login flow rescue eval",
        userId,
        undefined,
        testEnv.EVAL_MODEL,
      );
      const chatThread = testEnv.CHAT_THREAD.get(
        testEnv.CHAT_THREAD.idFromName(thread.id),
      );
      const result = await chatThread.runAgentEvalSession({
        threadId: thread.id,
        workspaceId: defaultWorkspaceId,
        orgId: org.id,
        userId,
        userName: "Login Flow Rescue Eval",
        userEmail: email,
        messageSource: "eval",
        timeoutMs: SESSION_TIMEOUT_MS,
        message: [
          `Fix the existing project "${PROJECT_NAME}" without recreating or redesigning it.`,
          "The login screen gets stuck on Signing in, wrong passwords are accepted, and /admin is not protected.",
          `For this sanitized fixture, the only valid credentials are username "${USERNAME}" and password "${CORRECT_PASSWORD}".`,
          "A wrong password must fail. A correct login must issue a secure session cookie. An unauthenticated /admin request must redirect to /login or return 401/403, while an authenticated request must render the existing admin console.",
          `Preserve the existing operations home marker "${HOME_MARKER}".`,
          `Deploy the same project with script_name "${PROJECT_NAME}".`,
          "Verify the negative login, successful login, protected route, and deployed login page. Do not claim the flow works from only a successful POST.",
          "Reply with the live URL and concise verification evidence.",
        ].join(" "),
      });

      let deployedApp: EvalDeployedApp | undefined;
      let deployError: string | undefined;
      try {
        deployedApp = assertDeployedApp(result, {
          name: PROJECT_NAME,
          hostSuffix: ".evals.camelai.app",
        });
      } catch (error) {
        deployError = error instanceof Error ? error.message : String(error);
      }

      const smoke = {
        wrongLogin: undefined as
          | { status: number; body: Record<string, unknown> }
          | undefined,
        correctLogin: undefined as
          | {
              status: number;
              body: Record<string, unknown>;
              hasCookie: boolean;
              hasSecureCookieFlags: boolean;
            }
          | undefined,
        anonymousAdmin: undefined as
          | { status: number; location: string | null }
          | undefined,
        authenticatedAdmin: undefined as
          | { status: number; hasMarker: boolean }
          | undefined,
        loginPage: undefined as
          | { status: number; hasFormMarker: boolean; hasSigningInText: boolean }
          | undefined,
        failures: [] as string[],
      };

      if (!deployedApp) {
        smoke.failures.push(deployError ?? "no deployed app was captured");
      } else {
        try {
          const wrongResponse = await fetchWithRetry(appUrl(deployedApp, "/api/login"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ username: USERNAME, password: WRONG_PASSWORD }),
          });
          const wrongBody = await jsonRecord(wrongResponse);
          smoke.wrongLogin = { status: wrongResponse.status, body: wrongBody };

          const correctResponse = await fetchWithRetry(
            appUrl(deployedApp, "/api/login"),
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ username: USERNAME, password: CORRECT_PASSWORD }),
            },
          );
          const correctBody = await jsonRecord(correctResponse);
          const setCookie = correctResponse.headers.get("set-cookie");
          const cookie = setCookie?.split(";")[0];
          smoke.correctLogin = {
            status: correctResponse.status,
            body: correctBody,
            hasCookie: Boolean(cookie),
            hasSecureCookieFlags: Boolean(
              setCookie &&
                /\bHttpOnly\b/i.test(setCookie) &&
                /\bSecure\b/i.test(setCookie) &&
                /\bSameSite=(?:Lax|Strict)\b/i.test(setCookie),
            ),
          };

          const anonymousAdmin = await fetchWithRetry(
            appUrl(deployedApp, "/admin"),
            { redirect: "manual" },
          );
          smoke.anonymousAdmin = {
            status: anonymousAdmin.status,
            location: anonymousAdmin.headers.get("location"),
          };
          await anonymousAdmin.body?.cancel();

          const authenticatedAdmin = await fetchWithRetry(
            appUrl(deployedApp, "/admin"),
            { headers: cookie ? { cookie } : {} },
          );
          const authenticatedAdminBody = await authenticatedAdmin.text();
          smoke.authenticatedAdmin = {
            status: authenticatedAdmin.status,
            hasMarker: authenticatedAdminBody.includes(ADMIN_MARKER),
          };

          const loginPage = await fetchWithRetry(appUrl(deployedApp, "/login"));
          const loginPageBody = await loginPage.text();
          smoke.loginPage = {
            status: loginPage.status,
            hasFormMarker: loginPageBody.includes(LOGIN_MARKER),
            hasSigningInText: loginPageBody.includes("Signing in"),
          };
        } catch (error) {
          smoke.failures.push(
            `live verification failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const finalWorker = await files.readFile("/workers/app.ts");
      const finalLogin = await files.readFile("/app/routes/login.tsx");
      const finalHome = await files.readFile("/app/routes/home.tsx");
      const workerSource = finalWorker.content ?? "";
      const loginSource = finalLogin.content ?? "";
      const homeSource = finalHome.content ?? "";
      const sourceInspection = {
        readSuccess: finalWorker.success && finalLogin.success && finalHome.success,
        homePreserved: homeSource.includes(HOME_MARKER),
        loginPreserved: loginSource.includes(LOGIN_MARKER),
        avoidsNavigateDuringRender:
          !/^\s*if\s*\([^\n]*\)\s*navigate\s*\(/m.test(loginSource),
        clearsLoading:
          /setLoading\s*\(\s*false\s*\)/.test(loginSource) ||
          /finally\s*\{[\s\S]{0,300}setLoading\s*\(\s*false\s*\)/.test(loginSource),
        checksPassword:
          workerSource.includes(CORRECT_PASSWORD) ||
          /\bpassword\b[\s\S]{0,100}(?:===|!==|timingSafeEqual|verify)/i.test(workerSource),
      };

      let projectDiff: ProjectFileDiff | undefined;
      let projectDiffError: string | undefined;
      try {
        projectDiff = diffProjectFileSnapshots(
          initialSnapshot,
          await snapshotProjectFiles(files),
        );
      } catch (error) {
        projectDiffError = error instanceof Error ? error.message : String(error);
      }
      const scoredChangedPaths = (projectDiff?.changedPaths ?? []).filter(
        (path) => !GENERATED_BUILD_PATHS.has(path),
      );
      const wrongLoginRejected = Boolean(
        smoke.wrongLogin &&
          [400, 401, 403].includes(smoke.wrongLogin.status) &&
          smoke.wrongLogin.body.success !== true,
      );
      const correctLoginAccepted = Boolean(
        smoke.correctLogin &&
          smoke.correctLogin.status >= 200 &&
          smoke.correctLogin.status < 300 &&
          smoke.correctLogin.body.success === true &&
          smoke.correctLogin.hasCookie &&
          smoke.correctLogin.hasSecureCookieFlags,
      );
      const anonymousAdminBlocked = Boolean(
        smoke.anonymousAdmin &&
          ([401, 403].includes(smoke.anonymousAdmin.status) ||
            (smoke.anonymousAdmin.status >= 300 &&
              smoke.anonymousAdmin.status < 400 &&
              /\/login\b/.test(smoke.anonymousAdmin.location ?? ""))),
      );
      const authenticatedAdminAllowed = Boolean(
        smoke.authenticatedAdmin?.status === 200 &&
          smoke.authenticatedAdmin.hasMarker,
      );
      const loginPageAvailable = Boolean(
        smoke.loginPage?.status === 200 && smoke.loginPage.hasFormMarker,
      );
      const sourceFlowRepaired =
        sourceInspection.avoidsNavigateDuringRender &&
        sourceInspection.clearsLoading;
      const signal = evaluateAgentEvalSignal(
        result,
        getEvalSignalThresholds(testEnv, {
          maxAssistantTurns: 24,
          maxBadToolCalls: 4,
        }),
      );
      const legacyFailures = legacyDeployPathEvidence(result.events);
      const finalResult = result.result ?? "";
      const finalHasEvidence =
        Boolean(deployedApp && finalResult.includes(new URL(deployedApp.url).hostname)) &&
        /\b(?:wrong|invalid|negative)\b/i.test(finalResult) &&
        /\b(?:protected|unauthenticated|admin)\b/i.test(finalResult);
      const evaluation = buildEvalCriteriaSummary({
        passFail: [
          buildSessionCompletedCriterion(result),
          passFailCriterion({
            id: "invalid_credentials_rejected",
            label: "Wrong password is rejected",
            passed: wrongLoginRejected,
            reason: wrongLoginRejected
              ? undefined
              : `wrong-login status=${smoke.wrongLogin?.status ?? "missing"}, success=${String(smoke.wrongLogin?.body.success)}`,
            details: smoke.wrongLogin,
          }),
          passFailCriterion({
            id: "valid_credentials_issue_session",
            label: "Correct credentials succeed and issue a session cookie",
            passed: correctLoginAccepted,
            reason: correctLoginAccepted
              ? undefined
              : `correct-login status=${smoke.correctLogin?.status ?? "missing"}, success=${String(smoke.correctLogin?.body.success)}, cookie=${smoke.correctLogin?.hasCookie ?? false}, secureFlags=${smoke.correctLogin?.hasSecureCookieFlags ?? false}`,
            details: smoke.correctLogin,
          }),
          passFailCriterion({
            id: "protected_route_enforces_session",
            label: "Admin route blocks anonymous access and allows the authenticated session",
            passed: anonymousAdminBlocked && authenticatedAdminAllowed,
            reason:
              anonymousAdminBlocked && authenticatedAdminAllowed
                ? undefined
                : `anonymousBlocked=${anonymousAdminBlocked}, authenticatedAllowed=${authenticatedAdminAllowed}`,
            details: {
              anonymousAdmin: smoke.anonymousAdmin,
              authenticatedAdmin: smoke.authenticatedAdmin,
            },
          }),
          passFailCriterion({
            id: "deployed_login_flow_present",
            label: "Deployed login page and client flow are repaired",
            passed: loginPageAvailable && sourceFlowRepaired,
            reason:
              loginPageAvailable && sourceFlowRepaired
                ? undefined
                : `loginPage=${loginPageAvailable}, avoidsRenderNavigation=${sourceInspection.avoidsNavigateDuringRender}, clearsLoading=${sourceInspection.clearsLoading}`,
            details: { loginPage: smoke.loginPage, sourceInspection },
          }),
          passFailCriterion({
            id: "existing_app_preserved",
            label: "Existing operations home remains intact",
            passed: sourceInspection.homePreserved,
            reason: sourceInspection.homePreserved
              ? undefined
              : `The repair removed ${HOME_MARKER}.`,
            details: sourceInspection,
          }),
          buildNoAssistantErrorCriterion(result),
          buildRuntimeEventsCriterion(result),
          buildResultEventCriterion(result),
        ],
        scorecard: [
          scoreCriterion({
            id: "scoped_diff",
            label: "Repair stays within five non-generated project files",
            points: scoredChangedPaths.length <= 5 ? 4 : 0,
            maxPoints: 4,
            reason:
              projectDiffError ??
              `${scoredChangedPaths.length} non-generated project files changed.`,
            details: { projectDiff, scoredChangedPaths },
          }),
          scoreSignalEfficiency(signal, {
            maxPoints: 4,
            fallbackPoints: 1,
            tiers: [
              { maxAssistantTurns: 18, maxBadToolCalls: 2, points: 4 },
              { maxAssistantTurns: 24, maxBadToolCalls: 4, points: 3 },
              { maxAssistantTurns: 32, maxBadToolCalls: 7, points: 2 },
            ],
          }),
          scoreCriterion({
            id: "verified_handoff",
            label: "Final response includes URL and negative/protected-route evidence",
            points: finalHasEvidence ? 2 : 0,
            maxPoints: 2,
            reason: finalHasEvidence
              ? undefined
              : "Final response lacked the live URL or specific verification evidence.",
          }),
          scoreCriterion({
            id: "avoided_legacy_paths",
            label: "Avoided legacy deploy paths",
            points: legacyFailures.length === 0 ? 2 : 0,
            maxPoints: 2,
            reason: legacyFailures.length ? legacyFailures.join("; ") : undefined,
          }),
        ],
      });

      emitEvalTranscript({
        status: result.status,
        rubric: RUBRIC,
        evaluation,
        error: result.error,
        model: testEnv.EVAL_MODEL,
        signal,
        project,
        deployedApps: result.deployedApps,
        smoke,
        sourceInspection,
        projectDiff,
        projectDiffError,
        runtimeAssertions: {
          wrongLoginRejected,
          correctLoginAccepted,
          anonymousAdminBlocked,
          authenticatedAdminAllowed,
          loginPageAvailable,
          sourceFlowRepaired,
          finalHasEvidence,
          legacyFailures,
        },
        result: result.result,
        events: result.events,
        messages: result.messages,
      });

      assertPassFailCriteria(evaluation);
    },
    SESSION_TIMEOUT_MS + 120_000,
  );
});
