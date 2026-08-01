import type { LoaderFunctionArgs } from "react-router";
import { getEnv } from "@/lib/cloudflare.server";
import {
  getSelfhostAiProviderStatus,
  isSelfhostRuntime,
} from "@/lib/selfhost-ai-provider";
import { getSelfhostCapabilityContract } from "@/lib/selfhost-capabilities";

type HealthCheck = {
  name: string;
  status: "ok" | "warn" | "fail";
  message?: string;
};

export async function loader({ context }: LoaderFunctionArgs) {
  const env = getEnv(context);
  if (!isSelfhost(env)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  const checks: HealthCheck[] = [];

  checks.push(required("APP_KV", env.APP_KV));
  checks.push(required("SESSIONS", env.SESSIONS));
  checks.push(required("R2_BUCKET", env.R2_BUCKET));
  checks.push(required("APP_DB", env.APP_DB));
  checks.push(required("ARTIFACTS", env.ARTIFACTS));
  checks.push(configuredComputeBinding("PROJECT_BUILD_SANDBOX", env.PROJECT_BUILD_SANDBOX));
  checks.push(configuredComputeBinding("ANALYSIS_SANDBOX", env.ANALYSIS_SANDBOX));
  checks.push(configuredComputeBinding("DB_QUERY_SANDBOX", env.DB_QUERY_SANDBOX));
  checks.push(requiredVar("WORKER_BASE_URL", env.WORKER_BASE_URL));
  checks.push(requiredVar("LOCAL_APP_VANITY_DOMAIN", env.LOCAL_APP_VANITY_DOMAIN));
  checks.push(requiredVar("LOCAL_APP_IFRAME_DOMAIN", env.LOCAL_APP_IFRAME_DOMAIN));
  checks.push(checkAiProviderConfig(env));
  checks.push(checkAgentPack(env));

  if (env.APP_DB) {
    checks.push(await checkD1(env.APP_DB));
  }

  if (env.LOCAL_ARTIFACTS_BASE_URL) {
    checks.push(await checkHttp("local-artifacts", `${env.LOCAL_ARTIFACTS_BASE_URL.replace(/\/+$/, "")}/health`));
  } else {
    checks.push({ name: "local-artifacts", status: "warn", message: "LOCAL_ARTIFACTS_BASE_URL is not configured" });
  }

  const failed = checks.filter((check) => check.status === "fail").length;
  const warned = checks.filter((check) => check.status === "warn").length;
  return Response.json(
    {
      ok: failed === 0,
      mode: "selfhost",
      status: failed > 0 ? "fail" : warned > 0 ? "warn" : "ok",
      checks,
      capabilities: getSelfhostCapabilityContract({
        projectBuild: Boolean(env.PROJECT_BUILD_SANDBOX),
        analysis: Boolean(env.ANALYSIS_SANDBOX),
        databaseQuery: Boolean(env.DB_QUERY_SANDBOX),
      }),
    },
    { status: failed > 0 ? 503 : 200 },
  );
}

function isSelfhost(env: ReturnType<typeof getEnv>): boolean {
  return isSelfhostRuntime(env);
}

function required(name: string, value: unknown): HealthCheck {
  return value
    ? { name, status: "ok" }
    : { name, status: "fail", message: "binding is not configured" };
}

function configuredComputeBinding(name: string, value: unknown): HealthCheck {
  return value
    ? {
        name,
        status: "ok",
        message:
          "namespace configured; Docker execution is verified separately by the self-host container smoke",
      }
    : { name, status: "fail", message: "binding is not configured" };
}

function requiredVar(name: string, value: unknown): HealthCheck {
  return typeof value === "string" && value.trim()
    ? { name, status: "ok" }
    : { name, status: "fail", message: "environment variable is not configured" };
}

function checkAiProviderConfig(env: ReturnType<typeof getEnv>): HealthCheck {
  const selfhostAiProvider = getSelfhostAiProviderStatus(env);
  if (selfhostAiProvider.configured) {
    return selfhostAiProvider.valid
      ? {
          name: "ai-provider",
          status: "ok",
          message: `Using SELFHOST_AI_PROVIDER=${selfhostAiProvider.provider}`,
        }
      : {
          name: "ai-provider",
          status: "fail",
          message: selfhostAiProvider.message,
        };
  }

  const hasGateway =
    typeof env.CF_ACCOUNT_ID === "string" &&
    env.CF_ACCOUNT_ID.trim() &&
    env.CF_ACCOUNT_ID.trim() !== "selfhost" &&
    typeof env.CF_GATEWAY_NAME === "string" &&
    env.CF_GATEWAY_NAME.trim() &&
    ((typeof env.AI_GATEWAY_AUTH_TOKEN === "string" && env.AI_GATEWAY_AUTH_TOKEN.trim()) ||
      (typeof env.CF_GATEWAY_TOKEN === "string" && env.CF_GATEWAY_TOKEN.trim()));

  return hasGateway
    ? { name: "ai-provider", status: "ok" }
    : {
        name: "ai-provider",
        status: "fail",
        message:
          "No self-host AI provider is configured. Chat requires SELFHOST_AI_PROVIDER and SELFHOST_AI_API_KEY, or a hosted Cloudflare AI Gateway configuration.",
      };
}

function checkAgentPack(env: ReturnType<typeof getEnv>): HealthCheck {
  const promptAppend =
    typeof env.SELFHOST_AGENT_PROMPT_APPEND === "string"
      ? env.SELFHOST_AGENT_PROMPT_APPEND.trim()
      : "";
  const promptPrepend =
    typeof env.SELFHOST_AGENT_PROMPT_PREPEND === "string"
      ? env.SELFHOST_AGENT_PROMPT_PREPEND.trim()
      : "";
  const skillsJson =
    typeof env.SELFHOST_AGENT_SKILLS_JSON === "string"
      ? env.SELFHOST_AGENT_SKILLS_JSON.trim()
      : "";

  const parts: string[] = [];
  if (promptPrepend) parts.push("prompt prepend");
  if (promptAppend) parts.push("prompt append");

  if (skillsJson) {
    try {
      const parsed = JSON.parse(skillsJson) as { files?: Record<string, unknown> };
      const names = Object.keys(parsed.files ?? {})
        .filter((filePath) => filePath.endsWith("/SKILL.md"))
        .map((filePath) => filePath.slice(0, -"/SKILL.md".length))
        .sort();
      if (names.length > 0) {
        parts.push(
          `${names.length} custom skill${names.length === 1 ? "" : "s"} (${names.join(", ")})`,
        );
      }
    } catch (error) {
      return {
        name: "agent-pack",
        status: "fail",
        message: `SELFHOST_AGENT_SKILLS_JSON is invalid: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  return {
    name: "agent-pack",
    status: "ok",
    message: parts.length > 0
      ? `Loaded ${parts.join("; ")}`
      : "No custom agent pack configured (using bundled skills and stock prompt)",
  };
}

async function checkD1(db: D1Database): Promise<HealthCheck> {
  try {
    await db.prepare("SELECT 1 AS ok").first();
    return { name: "APP_DB query", status: "ok" };
  } catch (error) {
    return {
      name: "APP_DB query",
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function checkHttp(name: string, url: string): Promise<HealthCheck> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return response.ok
      ? { name, status: "ok" }
      : { name, status: "fail", message: `HTTP ${response.status}` };
  } catch (error) {
    return {
      name,
      status: "fail",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
