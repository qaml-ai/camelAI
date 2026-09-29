/**
 * How a thread's resolved model (chiridion's resolver: picker, BYOK, hosted
 * gateway, credit fallback) runs on the hosted agent runtime:
 *
 * - `scope`: the runtime calls the provider itself, with a normal Pi model id
 *   and the keys of a key scope (`hosted`, or the org's `org_<id>`), and
 *   reports usage back as `usage.recorded` webhook events (agent-runtime/usage.ts);
 * - `codex`: the org's ChatGPT subscription, which only chiridion can
 *   authenticate: `chiridion/openai-codex/<model>` through chiridion's
 *   forwarder (agent-runtime/codex-forwarder.ts);
 * - null: no runtime route (custom endpoints, self-host providers, Bedrock
 *   OpenAI models, the gateway's other dynamic routes). Such a thread stays on
 *   the in-DO loop.
 */
import type { PiResolvedModelConfig } from "../chat-thread/pi-model-config";
import { codexRoute } from "./codex-forwarder";
import { HOSTED_KEY_SCOPE, orgKeyScope } from "./key-scopes";

export type RuntimeModelRoute =
  | { kind: "scope"; model: string; keyScope: string }
  | { kind: "codex"; model: string };

/** The tenant model endpoint in the runtime that is chiridion's Codex forwarder. */
export const RUNTIME_MODEL_ENDPOINT = "chiridion";

/**
 * The free tier on the runtime: GPT-6 Luna on OpenRouter (Responses) with the
 * hosted keys. The in-DO loop keeps the gateway's dynamic route, which only
 * takes chat completions.
 */
export const FREE_TIER_RUNTIME_MODEL = "openrouter/openai/gpt-6-luna";

/**
 * Bedrock's Converse ids for the bare ids chiridion's resolver names (bedrock-mantle's), where they
 * differ: Haiku 4.5 keeps its dated, versioned id there.
 */
const BEDROCK_CONVERSE_IDS: Record<string, string> = {
  "anthropic.claude-haiku-4-5": "anthropic.claude-haiku-4-5-20251001-v1:0",
};

/**
 * The geographic cross-region inference profiles Bedrock offers for each Claude model chiridion
 * resolves, as the runtime's catalog (Pi 0.87.1) lists them and `aws bedrock
 * list-inference-profiles` showed them on 2026-09-28. APAC has no `apac.` profile for any current
 * Claude (only 3.x and Sonnet 4): Tokyo and Osaka have `jp.`, Sydney and Melbourne `au.`, each for
 * some models. A model or region not listed here takes the `global.` profile, which every
 * commercial region offers for every current Claude; Sonnet 5.5 has only that one so far.
 */
const BEDROCK_GEO_PROFILES: Record<string, ReadonlySet<string>> = {
  "anthropic.claude-opus-5-5": new Set(["us", "eu", "jp", "au"]),
  "anthropic.claude-haiku-4-5-20251001-v1:0": new Set(["us", "eu", "jp", "au"]),
  "anthropic.claude-fable-5-1": new Set(["us"]),
};

function bedrockGeo(region: string): string | undefined {
  if (region.startsWith("us-")) return "us";
  if (region.startsWith("eu-")) return "eu";
  if (region === "ap-northeast-1" || region === "ap-northeast-3") return "jp";
  if (region === "ap-southeast-2" || region === "ap-southeast-4") return "au";
  return undefined;
}

/**
 * Converse on bedrock-runtime takes Claude through a cross-region inference profile: the region's
 * geography (`us.`/`eu.`/`jp.`/`au.`) + the model id where Bedrock has one, `global.` otherwise.
 * The bedrock-mantle endpoint chiridion's own loop uses takes the bare id.
 */
export function bedrockInferenceProfileId(modelId: string, region: string): string {
  if (/^(us|eu|apac|jp|au|global)\./.test(modelId)) return modelId;
  const id = BEDROCK_CONVERSE_IDS[modelId] ?? modelId;
  const geo = bedrockGeo(region);
  return geo && BEDROCK_GEO_PROFILES[id]?.has(geo) ? `${geo}.${id}` : `global.${id}`;
}

export function runtimeModelRoute(
  config: PiResolvedModelConfig,
  context: { orgId: string; freeTier?: boolean },
): RuntimeModelRoute | null {
  const { model } = config;
  if (model.provider === "cloudflare-ai-gateway") {
    if (context.freeTier && config.usageProvider === "compat") {
      return { kind: "scope", model: FREE_TIER_RUNTIME_MODEL, keyScope: HOSTED_KEY_SCOPE };
    }
    // The hosted scope holds OpenRouter through the gateway.
    if (config.usageProvider !== "openrouter") return null;
    return { kind: "scope", model: `openrouter/${model.id}`, keyScope: HOSTED_KEY_SCOPE };
  }
  if (config.billingSource !== "byok" || !config.apiKey) return null;
  const scope = orgKeyScope(context.orgId);
  if (model.provider === "openai-codex") {
    return codexRoute(config) ? { kind: "codex", model: `${RUNTIME_MODEL_ENDPOINT}/openai-codex/${model.id}` } : null;
  }
  if (config.usageProvider === "bedrock") {
    const region = /^https:\/\/bedrock-mantle\.([a-z0-9-]+)\.api\.aws\/anthropic\/?$/.exec(model.baseUrl)?.[1];
    if (!region || model.api !== "anthropic-messages") return null;
    return { kind: "scope", model: `amazon-bedrock/${bedrockInferenceProfileId(model.id, region)}`, keyScope: scope };
  }
  if (config.usageProvider === "openrouter") {
    if (!/^https:\/\/openrouter\.ai\/api(\/v1)?\/?$/.test(model.baseUrl)) return null;
    return { kind: "scope", model: `openrouter/${model.id}`, keyScope: scope };
  }
  if ((config.usageProvider === "anthropic" || config.usageProvider === "openai") && model.provider === config.usageProvider) {
    return { kind: "scope", model: `${config.usageProvider}/${model.id}`, keyScope: scope };
  }
  return null;
}
