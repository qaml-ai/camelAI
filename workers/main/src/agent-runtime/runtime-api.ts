/**
 * The hosted agent runtime's tenant API, as chiridion's operator: key scopes
 * (the provider keys agents of a scope call providers with) and per-agent
 * configuration (model, key scope, spend limit).
 */
export interface RuntimeApiEnv {
  AGENT_RUNTIME_URL?: string;
  AGENT_RUNTIME_API_TOKEN?: string;
}

export class RuntimeApiError extends Error {
  /** The runtime's error `code` (e.g. IDEMPOTENCY_CONFLICT): stable, where the message is not. */
  constructor(message: string, readonly status: number, readonly code: string | null = null) {
    super(message);
    this.name = "RuntimeApiError";
  }
}

export function runtimeUrl(env: RuntimeApiEnv): string {
  return (env.AGENT_RUNTIME_URL || "https://agents.camelai.dev").replace(/\/+$/, "");
}

/** Pauses before retrying a 503 (a runtime node shutting down or draining), each capped by Retry-After at 1 s. */
const UNAVAILABLE_RETRY_MS = [300, 700];

/**
 * One call to the runtime. A 503 is the runtime's "retry" (a node shutting down
 * in a rollout refuses before doing anything): it is tried twice more after a
 * short pause, so a deploy reaches no sender. Calls that change something are
 * idempotent (a prompt's requestId, Idempotency-Key, PUT/PATCH/DELETE).
 */
export async function runtimeApi(
  env: RuntimeApiEnv,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  fetcher: typeof globalThis.fetch = globalThis.fetch.bind(globalThis),
): Promise<unknown> {
  const call = () => fetcher(`${runtimeUrl(env)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.AGENT_RUNTIME_API_TOKEN ?? ""}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let response = await call();
  for (const pause of UNAVAILABLE_RETRY_MS) {
    if (response.status !== 503) break;
    await response.body?.cancel();
    const retryAfter = Number(response.headers.get("Retry-After")) * 1000;
    await new Promise((resolve) => setTimeout(resolve, Math.min(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : pause, 1_000)));
    response = await call();
  }
  const text = await response.text();
  let parsed: unknown = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  if (!response.ok) {
    const message = parsed && typeof parsed === "object" && typeof (parsed as { error?: unknown }).error === "string"
      ? (parsed as { error: string }).error
      : text.slice(0, 500);
    const code = parsed && typeof parsed === "object" && typeof (parsed as { code?: unknown }).code === "string"
      ? (parsed as { code: string }).code
      : null;
    throw new RuntimeApiError(`Agent runtime ${method} ${path.split("?")[0]}: HTTP ${response.status} ${message}`, response.status, code);
  }
  return parsed;
}

/**
 * A provider entry of a key scope: the key, and for a gateway its base URL
 * and sealed extra headers. A gateway that authenticates by header alone takes
 * no key (the runtime then sends no Authorization/x-api-key).
 */
export interface KeyScopeProvider {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
}

export function putKeyScopeProvider(
  env: RuntimeApiEnv,
  scope: string,
  provider: string,
  entry: KeyScopeProvider,
  fetcher?: typeof globalThis.fetch,
) {
  return runtimeApi(env, "PUT", `/v1/key-scopes/${encodeURIComponent(scope)}/providers/${encodeURIComponent(provider)}`, entry, {}, fetcher);
}

export async function deleteKeyScope(env: RuntimeApiEnv, scope: string, fetcher?: typeof globalThis.fetch) {
  try {
    await runtimeApi(env, "DELETE", `/v1/key-scopes/${encodeURIComponent(scope)}`, undefined, {}, fetcher);
  } catch (error) {
    if (!(error instanceof RuntimeApiError && error.status === 404)) throw error;
  }
}
