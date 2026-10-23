import { runtimeApi, type RuntimeApiEnv } from "./runtime-api";

/** A 202 only admits configure; validation and application happen asynchronously. */
export async function configureRuntimeAgent(
  env: RuntimeApiEnv,
  agentId: string,
  configuration: Record<string, unknown> & { requestId: string },
): Promise<void> {
  const path = `/v1/agents/${encodeURIComponent(agentId)}`;
  const receipt = await runtimeApi(env, "PATCH", `${path}/configuration`, configuration) as { id?: string; requestId?: string };
  const requestId = receipt?.requestId ?? receipt?.id ?? configuration.requestId;
  // The runtime long-polls for at most 25 seconds, then returns the current state.
  const request = await runtimeApi(env, "GET", `${path}/requests/${encodeURIComponent(requestId)}?wait=25`) as {
    state?: string;
    status?: string;
    error?: unknown;
    outcome?: { error?: unknown; uncertain?: boolean };
  };
  if (request?.state !== "completed") throw new Error("Runtime configuration timed out");
  if (request.status === "failed" || request.error || request.outcome?.error || request.outcome?.uncertain) {
    throw new Error("Runtime configuration failed");
  }
}
