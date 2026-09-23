import { getModels, getProviders } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";

/** Providers that authenticate with something other than a single API key. */
const NOT_API_KEY: Record<string, string> = {
  "amazon-bedrock": "AWS credentials",
  "google-vertex": "a Google Cloud service account",
  "azure-openai-responses": "an Azure endpoint and deployment",
  "github-copilot": "GitHub OAuth",
  "openai-codex": "ChatGPT OAuth",
  "cloudflare-ai-gateway": "a Cloudflare account and gateway ID",
  "cloudflare-workers-ai": "a Cloudflare account ID",
};

export interface ProviderInfo {
  id: string;
  models: number;
  /** Whether a tenant can use this provider by setting one API key. */
  apiKey: boolean;
  /** Why the provider is unavailable, when it needs more than an API key. */
  requires?: string;
}

export interface ModelInfo {
  /** Pass this as `model` when creating or configuring an agent. */
  id: string;
  provider: string;
  modelId: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  maxTokens: number;
  /** USD per million tokens. */
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
}

const models = (provider: string) => getModels(provider as never) as Model<Api>[];
const usableEndpoint = (model: Model<Api>) => !!model.baseUrl && !model.baseUrl.includes("{");

export function listProviders(): ProviderInfo[] {
  return getProviders().map(id => {
    const all = models(id);
    const requires = NOT_API_KEY[id] ?? (all.every(usableEndpoint) ? undefined : "a provider-specific endpoint");
    return { id, models: all.length, apiKey: !requires, ...(requires ? { requires } : {}) };
  }).sort((a, b) => a.id.localeCompare(b.id));
}

export function providerInfo(id: string): ProviderInfo | undefined {
  return listProviders().find(provider => provider.id === id);
}

export function listModels(provider?: string): ModelInfo[] {
  const providers = provider ? [provider] : getProviders();
  return providers.flatMap(id => (getProviders().includes(id as never) ? models(id) : []).map(model => ({
    id: `${model.provider}/${model.id}`, provider: model.provider, modelId: model.id, name: model.name, api: model.api,
    reasoning: model.reasoning, input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
  })));
}
