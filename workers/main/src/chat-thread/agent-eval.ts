// Agent-eval session helpers extracted from chat-thread-do.ts: run timeout,
// terminal-result extraction from collected chat events, and deployed-app
// collection for AgentEvalSessionResult. The session-driving orchestration
// (runAgentEvalSession) stays on ChatThreadDO.
import { getPreferredAppUrl } from "../../../../src/lib/app-url";
import type {
  AgentEvalDeployedApp,
  ChatEnv,
} from "./types";

export async function withAgentEvalTimeout<T>(
  promise: Promise<T>,
  timeoutMs: unknown,
): Promise<T> {
  const normalizedTimeoutMs =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.max(1_000, Math.floor(timeoutMs))
      : 120_000;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Agent eval timed out after ${normalizedTimeoutMs}ms`));
        }, normalizedTimeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}

export function latestAgentEvalResult(
  events: Array<Record<string, unknown>>,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.type !== "result") continue;
    const result = event.result;
    return typeof result === "string" ? result : undefined;
  }
  return undefined;
}

export async function collectAgentEvalDeployedApps(
  env: ChatEnv,
  ids: { orgId?: string | null; workspaceId?: string | null },
): Promise<AgentEvalDeployedApp[] | undefined> {
  const workspaceId = ids.workspaceId ?? "";
  const orgId = ids.orgId ?? "";
  if (!workspaceId || !orgId) return undefined;
  const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
  const scripts = await orgStub.listWorkerScriptsByWorkspace(workspaceId);
  if (!scripts.length) return undefined;
  // Build the app URL the same way the tools' getAppUrl does (the eval env pins the
  // testing-grounds host via WORKER_BASE_URL/LOCAL_APP_VANITY_DOMAIN), so the result
  // carries the authoritative *.evals.camelai.app URL with no eval-specific code.
  let appHostname = "camelai.dev";
  const workerBaseUrl = (env as { WORKER_BASE_URL?: string }).WORKER_BASE_URL;
  if (workerBaseUrl) {
    try {
      appHostname = new URL(workerBaseUrl).host;
    } catch {
      appHostname = "camelai.dev";
    }
  }
  const orgSlug = (await orgStub.getSlug()) ?? undefined;
  return scripts
    .sort((a, b) => b.updated_at - a.updated_at)
    .map((script) => ({
      name: script.script_name,
      url: getPreferredAppUrl(script, {
        hostname: {
          hostname: appHostname,
          vanityDomain: env.LOCAL_APP_VANITY_DOMAIN,
          iframeDomain: env.LOCAL_APP_IFRAME_DOMAIN,
        },
        orgSlug,
        orgCustomDomain: null,
      }),
      isPublic: script.is_public,
    }));
}
