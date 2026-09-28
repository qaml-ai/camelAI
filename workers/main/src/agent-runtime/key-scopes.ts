/**
 * The provider keys runtime agents call providers with, kept in the runtime's
 * key scopes: `hosted` (camelAI's AI Gateway, shared by every hosted thread)
 * and `org_<orgId>` (an org's BYOK key). Synced lazily: before a runtime run,
 * and when an org's AI provider settings change. What was last synced is
 * remembered in APP_KV by fingerprint, and in this isolate once seen, so an
 * unchanged scope costs nothing after its isolate's first send.
 */
import { decryptCredentials } from "../../../../src/lib/integration-crypto";
import { parseStoredLlmProviderConfig } from "../../../../src/lib/llm-provider-config";
import { buildCloudflareGatewayUrl } from "../../../../src/lib/cloudflare-ai-gateway";
import { deleteKeyScope, putKeyScopeProvider, runtimeApi, type KeyScopeProvider, type RuntimeApiEnv } from "./runtime-api";

export const HOSTED_KEY_SCOPE = "hosted";

export function orgKeyScope(orgId: string): string {
  return `org_${orgId}`;
}

export interface KeyScopeEnv extends RuntimeApiEnv {
  APP_KV: KVNamespace;
  ORG: DurableObjectNamespace;
  INTEGRATION_SECRET_KEY: string;
  CF_ACCOUNT_ID?: string;
  CF_GATEWAY_NAME?: string;
  CF_GATEWAY_BASE_URL?: string;
  AI_GATEWAY_AUTH_TOKEN?: string;
  CF_GATEWAY_TOKEN?: string;
  TEST_LLM_REPLAY_URL?: string;
}

type Providers = Record<string, KeyScopeProvider>;

const OPENROUTER_ATTRIBUTION = {
  "HTTP-Referer": "https://camelai.dev",
  "X-OpenRouter-Title": "camelAI",
  "X-OpenRouter-Categories": "cloud-agent,programming-app",
};

/**
 * camelAI's hosted providers: OpenRouter through the AI Gateway, which holds
 * the provider keys and takes its own token as `cf-aig-authorization` (the
 * entry has no key). Null when the gateway is not configured (hosted threads
 * then stay on the in-DO loop).
 */
export function hostedScopeProviders(env: KeyScopeEnv): Providers | null {
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const gatewayName = env.CF_GATEWAY_NAME?.trim();
  const token = env.AI_GATEWAY_AUTH_TOKEN?.trim() || env.CF_GATEWAY_TOKEN?.trim();
  if (!accountId || !gatewayName || !token) return null;
  const gateway = buildCloudflareGatewayUrl(
    env,
    `/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayName)}`,
  );
  return {
    openrouter: {
      baseUrl: `${gateway}/openrouter`,
      headers: { "cf-aig-authorization": `Bearer ${token}`, ...OPENROUTER_ATTRIBUTION },
    },
  };
}

/**
 * The per-agent headers a hosted-scope agent sends on every model call: the
 * thread's AI Gateway metadata, as the in-DO loop sends it (pi-model-config).
 * BYOK and Codex agents send none, so internal ids stay off customers' providers.
 */
export function hostedModelHeaders(thread: { orgId: string; workspaceId: string; threadId: string }): Record<string, string> {
  const { orgId, workspaceId, threadId } = thread;
  return {
    "cf-aig-metadata": JSON.stringify({
      uid: [orgId, workspaceId, threadId].filter(Boolean).join(":"),
      chiridion: { orgId, workspaceId, threadId },
    }),
  };
}

/**
 * An org's BYOK providers, from its AI provider settings: Anthropic, OpenAI,
 * OpenRouter, Bedrock (its API key, at its region's bedrock-runtime). Custom
 * endpoints and the ChatGPT subscription have no key-scope entry (a custom
 * route stays on the in-DO loop; Codex goes through chiridion's forwarder).
 */
export async function orgScopeProviders(
  env: KeyScopeEnv,
  record: { provider: string; credentials_encrypted: string; config: string } | null,
): Promise<Providers> {
  if (!record) return {};
  const creds = await decryptCredentials<Record<string, string>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY);
  const config = parseStoredLlmProviderConfig(record.config);
  switch (record.provider) {
    case "anthropic":
    case "openai":
      return creds.api_key ? { [record.provider]: { apiKey: creds.api_key } } : {};
    case "openrouter":
      return creds.api_key ? { openrouter: { apiKey: creds.api_key, headers: OPENROUTER_ATTRIBUTION } } : {};
    case "bedrock": {
      const region = config.aws_region?.trim() || "us-east-1";
      return creds.bearer_token && /^[a-z0-9-]+$/.test(region)
        ? { "amazon-bedrock": { apiKey: creds.bearer_token, baseUrl: `https://bedrock-runtime.${region}.amazonaws.com` } }
        : {};
    }
    default:
      return {};
  }
}

async function fingerprint(providers: Providers): Promise<string> {
  const canonical = JSON.stringify(Object.keys(providers).sort().map((name) => [name, providers[name]]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const syncedKey = (scope: string) => `agent_runtime_key_scope:${scope}`;

/**
 * Fingerprints this isolate saw synced, by scope, for a few minutes. A change
 * to a scope's providers changes its fingerprint, which misses here and goes
 * to KV (and the runtime) as before; the expiry bounds how long a scope
 * changed behind KV's back (a failed sync elsewhere) goes unrepaired.
 */
const syncedHere = new Map<string, { print: string; at: number }>();
const SYNCED_HERE_TTL_MS = 5 * 60_000;
const SYNCED_HERE_MAX = 1000;

function syncedRecently(scope: string, print: string): boolean {
  const seen = syncedHere.get(scope);
  return seen?.print === print && Date.now() - seen.at < SYNCED_HERE_TTL_MS;
}

function rememberSynced(scope: string, print: string): void {
  if (syncedHere.size >= SYNCED_HERE_MAX) syncedHere.clear();
  syncedHere.set(scope, { print, at: Date.now() });
}

/**
 * Make the runtime's scope hold exactly `providers`: put changed entries, then
 * drop ones no longer configured (so a rotation never leaves the scope empty
 * in between). An empty set deletes the scope.
 */
export async function syncKeyScope(
  env: KeyScopeEnv,
  scope: string,
  providers: Providers,
  fetcher?: typeof globalThis.fetch,
): Promise<void> {
  const print = await fingerprint(providers);
  if (syncedRecently(scope, print)) return;
  const synced = await env.APP_KV.get<{ fingerprint: string; providers: string[] }>(syncedKey(scope), "json");
  if (synced?.fingerprint === print) {
    rememberSynced(scope, print);
    return;
  }
  const names = Object.keys(providers);
  if (names.length === 0) {
    if (synced) await deleteKeyScope(env, scope, fetcher);
    await env.APP_KV.delete(syncedKey(scope));
    rememberSynced(scope, print);
    return;
  }
  for (const name of names) await putKeyScopeProvider(env, scope, name, providers[name], fetcher);
  for (const stale of synced?.providers ?? []) {
    if (!names.includes(stale)) {
      await runtimeApi(env, "DELETE", `/v1/key-scopes/${encodeURIComponent(scope)}/providers/${encodeURIComponent(stale)}`, undefined, {}, fetcher)
        .catch(() => undefined);
    }
  }
  await env.APP_KV.put(syncedKey(scope), JSON.stringify({ fingerprint: print, providers: names }));
  rememberSynced(scope, print);
}

type ProviderRecord = { provider: string; credentials_encrypted: string; config: string } | null;

/** Sync an org's BYOK scope from its current AI provider settings (read from OrgDO unless given). */
export async function syncOrgKeyScope(
  env: KeyScopeEnv,
  orgId: string,
  record?: ProviderRecord,
  fetcher?: typeof globalThis.fetch,
): Promise<void> {
  const current = record !== undefined
    ? record
    : await (env.ORG.get(env.ORG.idFromName(orgId)) as unknown as { getLlmProviderConfig(): Promise<ProviderRecord> })
        .getLlmProviderConfig();
  await syncKeyScope(env, orgKeyScope(orgId), await orgScopeProviders(env, current), fetcher);
}

/** Sync the shared hosted scope; false when the gateway is not configured. */
export async function ensureHostedKeyScope(env: KeyScopeEnv, fetcher?: typeof globalThis.fetch): Promise<boolean> {
  const providers = hostedScopeProviders(env);
  if (!providers) return false;
  await syncKeyScope(env, HOSTED_KEY_SCOPE, providers, fetcher);
  return true;
}
