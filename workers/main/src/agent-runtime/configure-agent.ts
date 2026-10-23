import { runtimeApi, type RuntimeApiEnv } from "./runtime-api";

export class RuntimeConfigurationFailedError extends Error {
  constructor() {
    super("Runtime configuration failed");
    this.name = "RuntimeConfigurationFailedError";
  }
}

/** Returns whether configure completed; queued/running requests are accepted. */
export async function configureRuntimeAgent(
  env: RuntimeApiEnv,
  agentId: string,
  configuration: Record<string, unknown> & { requestId: string },
  waitSeconds = 0,
): Promise<boolean> {
  const path = `/v1/agents/${encodeURIComponent(agentId)}`;
  const receipt = await runtimeApi(env, "PATCH", `${path}/configuration`, configuration) as { id?: string; requestId?: string };
  const requestId = receipt?.requestId ?? receipt?.id ?? configuration.requestId;
  // Only migration callers wait: ordinary configures must not block a steer.
  const request = await runtimeApi(env, "GET", `${path}/requests/${encodeURIComponent(requestId)}?wait=${waitSeconds}`) as {
    state?: string;
    status?: string;
    error?: unknown;
    outcome?: { error?: unknown; uncertain?: boolean };
  };
  if (request?.status === "failed") throw new RuntimeConfigurationFailedError();
  return request?.state === "completed" && !request.outcome?.uncertain;
}
