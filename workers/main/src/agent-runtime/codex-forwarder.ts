/**
 * ChatGPT (Codex) subscription route extraction: resolves the org's refreshed
 * OAuth token, ChatGPT account id, and proxy headers for syncing into v2 key scopes.
 */
import type { PiResolvedModelConfig } from "../chat-thread/pi-model-config";

export interface CodexRoute {
  /** The model id the runtime's agent has (and a plain body names). */
  modelId: string;
  /** The Codex backend root (`https://chatgpt.com/backend-api`) or the proxy's. */
  upstreamBase: string;
  /** The subscription's access token, freshly refreshed by the resolver. */
  credential: string;
  /** The ChatGPT account the token belongs to. */
  accountId: string;
  /** Extra headers (chiridion's Codex proxy token). */
  headers: Record<string, string>;
}

/** The ChatGPT account id in a Codex access token (the claim Codex clients read). */
export function codexAccountId(accessToken: string): string | null {
  try {
    const [, payload] = accessToken.split(".");
    if (!payload) return null;
    const claims = JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/"))) as Record<string, unknown>;
    const auth = claims["https://api.openai.com/auth"];
    const accountId = auth && typeof auth === "object" ? (auth as Record<string, unknown>).chatgpt_account_id : undefined;
    return typeof accountId === "string" && accountId ? accountId : null;
  } catch {
    return null;
  }
}

/** The Codex route for a thread resolved to the org's ChatGPT subscription, else null. */
export function codexRoute(config: PiResolvedModelConfig): CodexRoute | null {
  const { model } = config;
  if (model.provider !== "openai-codex" || config.billingSource !== "byok" || !config.apiKey) return null;
  const accountId = codexAccountId(config.apiKey);
  if (!accountId) return null;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries((model.headers ?? {}) as Record<string, string | null>)) {
    if (typeof value === "string" && value && !/^(authorization|x-api-key)$/i.test(name)) headers[name] = value;
  }
  return {
    modelId: model.id,
    upstreamBase: model.baseUrl.replace(/\/+$/, "").replace(/\/codex$/, ""),
    credential: config.apiKey,
    accountId,
    headers,
  };
}
