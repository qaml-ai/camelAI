/**
 * The provider keys runtime agents call providers with, kept in the runtime's
 * key scopes: `hosted` (camelAI's AI Gateway, shared by every hosted thread)
 * and `org_<orgId>` (an org's BYOK key, and the org's own endpoints as the
 * scope's model providers: a custom endpoint, Bedrock's OpenAI models). Synced
 * lazily: before a runtime run, and when an org's AI provider settings change.
 * What was last synced is remembered in APP_KV by fingerprint, and in this
 * isolate once seen, so an unchanged scope costs nothing after its isolate's
 * first send.
 */
import type { Model } from "@earendil-works/pi-ai";
import { decryptCredentials } from "../../../../src/lib/integration-crypto";
import {
  BEDROCK_OPENAI_MODEL_REGIONS,
  getLlmModelOptions,
  isBedrockOpenAiModelAllowedInRegion,
  parseStoredLlmProviderConfig,
  type LlmProviderStoredConfig,
} from "../../../../src/lib/llm-provider-config";
import { buildCloudflareGatewayUrl } from "../../../../src/lib/cloudflare-ai-gateway";
import type { LlmModel } from "../../../../src/types";
import { piCatalogModel } from "../chat-thread/pi-model-config";
import { PiModelMapping } from "../pi-model-resolution";
import {
  deleteKeyScope,
  deleteKeyScopeModelProvider,
  putKeyScopeModelProvider,
  putKeyScopeProvider,
  runtimeApi,
  type KeyScopeModel,
  type KeyScopeModelProvider,
  type KeyScopeProvider,
  type RuntimeApiEnv,
} from "./runtime-api";

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
type ModelProviders = Record<string, KeyScopeModelProvider>;

/** What a key scope holds: keys for built-in providers, and model providers of its own. */
export interface ScopeEntries {
  providers: Providers;
  modelProviders?: ModelProviders;
}

/** The scope model provider an org's custom endpoint is: its agents name `custom/<model id>`. */
export const CUSTOM_MODEL_PROVIDER = "custom";

/**
 * The scope model provider of Bedrock's OpenAI models served from one region
 * (bedrock-mantle's OpenAI Responses API there): `bedrock-openai-<region>`.
 */
export function bedrockOpenAiModelProvider(region: string): string {
  return `bedrock-openai-${region}`;
}

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
 * An org's key scope, from its AI provider settings: its BYOK key for
 * Anthropic, OpenAI, OpenRouter or Bedrock (its API key, at its region's
 * bedrock-runtime), and as model providers of the scope its custom endpoint,
 * or Bedrock's OpenAI models over bedrock-mantle. The ChatGPT subscription has
 * no entry (Codex goes through chiridion's forwarder).
 */
export async function orgScopeProviders(
  env: KeyScopeEnv,
  record: { provider: string; credentials_encrypted: string; config: string } | null,
): Promise<ScopeEntries> {
  if (!record) return { providers: {} };
  const creds = await decryptCredentials<Record<string, string>>(record.credentials_encrypted, env.INTEGRATION_SECRET_KEY);
  const config = parseStoredLlmProviderConfig(record.config);
  switch (record.provider) {
    case "anthropic":
    case "openai":
      return { providers: creds.api_key ? { [record.provider]: { apiKey: creds.api_key } } : {} };
    case "openrouter":
      return { providers: creds.api_key ? { openrouter: { apiKey: creds.api_key, headers: OPENROUTER_ATTRIBUTION } } : {} };
    case "bedrock": {
      const region = config.aws_region?.trim() || "us-east-1";
      if (!creds.bearer_token || !/^[a-z0-9-]+$/.test(region)) return { providers: {} };
      return {
        providers: { "amazon-bedrock": { apiKey: creds.bearer_token, baseUrl: `https://bedrock-runtime.${region}.amazonaws.com` } },
        modelProviders: await bedrockOpenAiModelProviders(creds.bearer_token, region),
      };
    }
    case "custom": {
      const provider = creds.api_key ? await customModelProvider(creds.api_key, config) : null;
      return { providers: {}, modelProviders: provider ? { [CUSTOM_MODEL_PROVIDER]: provider } : {} };
    }
    default:
      return { providers: {} };
  }
}

type GetModel = (provider: never, modelId: never) => Model<any> | null | undefined;

async function catalogGetModel(): Promise<GetModel> {
  const { getModel } = await import("@earendil-works/pi-ai/compat");
  return getModel as unknown as GetModel;
}

/**
 * A model's declaration as the in-DO loop runs it: the catalog model it is
 * looked up as gives its context window, output limit, reasoning, input and
 * price (pi-model-config's resolvePiModelConfig). The price is the in-DO
 * loop's estimate too (Pi's usage cost, its usage_log `estimated_cost_usd`):
 * it feeds usage rows and per-user spend limits, never credit, since an org
 * scope's runs are BYOK (agent-runtime/usage.ts) and the runtime never charges
 * a tenant's own providers to credit.
 */
function declaredModel(id: string, catalog: Model<any> | null): KeyScopeModel | null {
  if (!catalog || !runtimeModelId(id)) return null;
  const contextWindow = Math.min(Math.max(Math.floor(Number(catalog.contextWindow) || 0), 1024), 10_000_000);
  const maxTokens = Math.floor(Number(catalog.maxTokens) || 0);
  const price = (value: unknown) => {
    const usd = Number(value);
    return Number.isFinite(usd) && usd > 0 ? Math.min(usd, 10_000) : 0;
  };
  const cost = catalog.cost;
  return {
    id,
    contextWindow,
    ...(maxTokens > 0 ? { maxOutputTokens: Math.min(maxTokens, contextWindow) } : {}),
    input: catalog.input?.includes("image") ? ["text", "image"] : ["text"],
    reasoning: Boolean(catalog.reasoning),
    ...(cost
      ? { pricing: { input: price(cost.input), output: price(cost.output), cacheRead: price(cost.cacheRead), cacheWrite: price(cost.cacheWrite) } }
      : {}),
  };
}

/**
 * Whether an org's custom endpoint can be a runtime model provider: the
 * runtime calls only `https` addresses, and sends the key the API's own way
 * (Bearer; x-api-key for Anthropic Messages) or as another header. Anthropic
 * Messages behind `Authorization: Bearer` cannot be said (the runtime sets
 * Authorization itself), so such an endpoint stays on the in-DO loop.
 */
export function customEndpointRunsOnRuntime(
  api: string | undefined,
  authType: LlmProviderStoredConfig["custom_auth_type"],
  baseUrl: string | undefined,
): boolean {
  if (!api || !CUSTOM_APIS.has(api) || !baseUrl || !/^https:\/\//i.test(baseUrl)) return false;
  return api !== "anthropic-messages" || authType === "x-api-key";
}

const CUSTOM_APIS = new Set(["openai-completions", "openai-responses", "anthropic-messages"]);

/** A model id the runtime takes: 1-200 characters without spaces. */
export const runtimeModelId = (id: string) => /^\S{1,200}$/.test(id);

/**
 * An org's custom endpoint as a scope model provider, declaring every model a
 * thread of the org can run on it (resolveCustomProviderModelReference over
 * the models the org's picker allows, as the in-DO loop resolves them): its
 * own model id, or chiridion's models of the endpoint's API by the ids the
 * loop sends.
 */
async function customModelProvider(apiKey: string, config: LlmProviderStoredConfig): Promise<KeyScopeModelProvider | null> {
  const { custom_api: api, custom_base_url: baseUrl, custom_auth_type: authType, custom_model_id: customModelId } = config;
  if (!api || !baseUrl || !customEndpointRunsOnRuntime(api, authType, baseUrl)) return null;
  const mapping = new PiModelMapping();
  const getModel = await catalogGetModel();
  const models = new Map<string, KeyScopeModel>();
  for (const { value } of getLlmModelOptions("custom", { customApi: api, customModelId })) {
    // A hosted-only route (camelCode) never reaches the org's endpoint.
    if (mapping.resolvePiModelReference(value).byokAllowed === false) continue;
    const reference = mapping.resolveCustomProviderModelReference(api, value, customModelId);
    const model = declaredModel(reference.requestModelId, piCatalogModel(getModel, reference.provider, reference.lookupModelId));
    if (model && !models.has(model.id)) models.set(model.id, model);
  }
  if (models.size === 0) return null;
  // An OpenAI-API endpoint that takes its key as x-api-key gets that header
  // and no Authorization, as the in-DO loop sends it (customProviderAuthHeaders).
  const asHeader = api !== "anthropic-messages" && authType === "x-api-key";
  return {
    type: api,
    baseUrl,
    apiKey: asHeader ? null : apiKey,
    headers: asHeader ? { "x-api-key": apiKey } : null,
    models: [...models.values()],
  };
}

/**
 * Bedrock's OpenAI models an org in `region` can run, as one model provider
 * per bedrock-mantle region they are served from (bedrockOpenAiModelConfig,
 * as the in-DO loop picks it), over OpenAI Responses with the Bedrock API key.
 */
async function bedrockOpenAiModelProviders(apiKey: string, region: string): Promise<ModelProviders> {
  const mapping = new PiModelMapping();
  const getModel = await catalogGetModel();
  const providers: ModelProviders = {};
  for (const model of Object.keys(BEDROCK_OPENAI_MODEL_REGIONS) as LlmModel[]) {
    if (!isBedrockOpenAiModelAllowedInRegion(model, region)) continue;
    const reference = mapping.resolvePiModelReference(model);
    const bedrock = mapping.bedrockOpenAiModelConfig(reference.modelId, region);
    const served = bedrock ? BEDROCK_OPENAI_BASE_URL.exec(bedrock.baseUrl)?.[1] : undefined;
    if (!bedrock || !served) continue;
    const declared = declaredModel(bedrock.modelId, piCatalogModel(getModel, reference.provider, reference.modelId));
    if (!declared) continue;
    const provider = providers[bedrockOpenAiModelProvider(served)] ??=
      { type: "openai-responses", baseUrl: bedrock.baseUrl, apiKey, headers: null, models: [] };
    if (!provider.models.some((entry) => entry.id === declared.id)) provider.models.push(declared);
  }
  return providers;
}

/** bedrock-mantle's OpenAI API in a region (the region captured). */
export const BEDROCK_OPENAI_BASE_URL = /^https:\/\/bedrock-mantle\.([a-z0-9-]+)\.api\.aws\/openai\/v1\/?$/;

const canonicalOf = <T>(entries: Record<string, T>) => Object.keys(entries).sort().map((name) => [name, entries[name]]);

async function fingerprint({ providers, modelProviders = {} }: ScopeEntries): Promise<string> {
  // A scope of keys only prints as it did before scopes had model providers.
  const canonical = JSON.stringify(Object.keys(modelProviders).length
    ? { providers: canonicalOf(providers), modelProviders: canonicalOf(modelProviders) }
    : canonicalOf(providers));
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
 * Make the runtime's scope hold exactly `entries`: put changed entries, then
 * drop ones no longer configured (so a rotation never leaves the scope empty
 * in between). An empty set deletes the scope, its model providers with it.
 */
export async function syncKeyScope(
  env: KeyScopeEnv,
  scope: string,
  entries: ScopeEntries,
  fetcher?: typeof globalThis.fetch,
): Promise<void> {
  const print = await fingerprint(entries);
  if (syncedRecently(scope, print)) return;
  const synced = await env.APP_KV.get<{ fingerprint: string; providers: string[]; modelProviders?: string[] }>(syncedKey(scope), "json");
  if (synced?.fingerprint === print) {
    rememberSynced(scope, print);
    return;
  }
  const { providers, modelProviders = {} } = entries;
  const names = Object.keys(providers);
  const modelNames = Object.keys(modelProviders);
  if (names.length === 0 && modelNames.length === 0) {
    if (synced) await deleteKeyScope(env, scope, fetcher);
    await env.APP_KV.delete(syncedKey(scope));
    rememberSynced(scope, print);
    return;
  }
  for (const name of names) await putKeyScopeProvider(env, scope, name, providers[name], fetcher);
  for (const name of modelNames) await putKeyScopeModelProvider(env, scope, name, modelProviders[name], fetcher);
  for (const stale of synced?.providers ?? []) {
    if (!names.includes(stale)) {
      await runtimeApi(env, "DELETE", `/v1/key-scopes/${encodeURIComponent(scope)}/providers/${encodeURIComponent(stale)}`, undefined, {}, fetcher)
        .catch(() => undefined);
    }
  }
  for (const stale of synced?.modelProviders ?? []) {
    if (!modelNames.includes(stale)) await deleteKeyScopeModelProvider(env, scope, stale, fetcher).catch(() => undefined);
  }
  await env.APP_KV.put(syncedKey(scope), JSON.stringify({
    fingerprint: print,
    providers: names,
    ...(modelNames.length ? { modelProviders: modelNames } : {}),
  }));
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
  await syncKeyScope(env, HOSTED_KEY_SCOPE, { providers }, fetcher);
  return true;
}
