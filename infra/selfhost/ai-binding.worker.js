const AUXILIARY_MODEL_IDS = new Set([
  "@cf/meta/llama-3.2-3b-instruct",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
]);

// Auxiliary work should stay on the configured self-host provider and use a
// fast inexpensive model. Bedrock's auxiliary-only Luna route is intentionally
// independent from the user-facing chat model picker.
const AUXILIARY_MODELS = {
  anthropic: "claude-haiku-4-5-20251001",
  bedrock: "openai.gpt-5.6-luna",
  openai: "gpt-5.6-luna",
  openrouter: "deepseek/deepseek-v4-flash",
  requesty: "gpt-5.6-luna",
};

const BEDROCK_OPENAI_MODEL_REGIONS = {
  "openai.gpt-5.6-sol": ["us-east-1", "us-east-2"],
  "openai.gpt-5.6-terra": ["us-east-1", "us-east-2", "us-west-2"],
  "openai.gpt-5.6-luna": ["us-east-1", "us-east-2", "us-west-2"],
};

const REQUEST_TIMEOUT_MS = 15_000;
const MAX_REQUEST_ATTEMPTS = 2;
const DEFAULT_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 2_000;

const SUPPORTED_PROVIDERS = new Set([
  "anthropic",
  "bedrock",
  "cloudflare-ai-gateway",
  "custom",
  "openai",
  "openrouter",
  "requesty",
]);

const SUPPORTED_CUSTOM_APIS = new Set([
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
]);

function bedrockRegionCandidates(model, preferredRegion) {
  const supported = BEDROCK_OPENAI_MODEL_REGIONS[model] ?? [
    preferredRegion,
    "us-east-1",
    "us-east-2",
    "us-west-2",
  ];
  return [
    ...(supported.includes(preferredRegion) ? [preferredRegion] : []),
    ...supported.filter((region) => region !== preferredRegion),
  ];
}

function isBedrockRegionUnavailableError(message) {
  const lower = message.toLowerCase();
  return (
    lower.includes("not_found_error") ||
    lower.includes("model not found") ||
    (lower.includes("model") && lower.includes("does not exist")) ||
    (lower.includes("model") && lower.includes("not available in")) ||
    (lower.includes("model") && lower.includes("unsupported region"))
  );
}

function resolveProviderModel(provider, requestedModel, customModel) {
  const trimmed = String(requestedModel || "").trim();
  if (!trimmed) {
    throw new Error("Self-host AI binding requires a model id");
  }
  if (provider === "custom") {
    if (!customModel) {
      throw new Error("SELFHOST_AI_MODEL is required for custom auxiliary generation");
    }
    return customModel;
  }
  if (provider === "cloudflare-ai-gateway") return trimmed;
  return AUXILIARY_MODEL_IDS.has(trimmed)
    ? AUXILIARY_MODELS[provider]
    : trimmed;
}

function stripTrailingSlashes(value) {
  return value.replace(/\/+$/, "");
}

function appendEndpoint(baseUrl, endpoint) {
  return `${stripTrailingSlashes(baseUrl)}/${endpoint.replace(/^\/+/, "")}`;
}

function anthropicBaseUrl(baseUrl) {
  return stripTrailingSlashes(baseUrl).replace(/\/v1$/i, "");
}

function gatewayBaseUrl(baseUrl) {
  const normalized = stripTrailingSlashes(baseUrl.trim());
  return normalized.startsWith("http://")
    ? `https://${normalized.slice("http://".length)}`
    : normalized;
}

function positiveTokenLimit(value, fallback = 256) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function extractResponseText(payload) {
  if (!payload || typeof payload !== "object") return "";
  if (typeof payload.response === "string" && payload.response.trim()) {
    return payload.response.trim();
  }
  if (typeof payload.output_text === "string" && payload.output_text.trim()) {
    return payload.output_text.trim();
  }

  const choiceContent = payload.choices?.[0]?.message?.content;
  if (typeof choiceContent === "string" && choiceContent.trim()) {
    return choiceContent.trim();
  }
  if (Array.isArray(choiceContent)) {
    const text = choiceContent
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("")
      .trim();
    if (text) return text;
  }

  if (Array.isArray(payload.content)) {
    const text = payload.content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("")
      .trim();
    if (text) return text;
  }

  if (Array.isArray(payload.output)) {
    const text = payload.output
      .flatMap((item) => (Array.isArray(item?.content) ? item.content : []))
      .filter((item) => item?.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("")
      .trim();
    if (text) return text;
  }

  return "";
}

function isTransientStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

function retryDelayMs(response) {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value) return DEFAULT_RETRY_DELAY_MS;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds)
    ? seconds * 1_000
    : Date.parse(value) - Date.now();
  return Math.max(0, Math.min(MAX_RETRY_DELAY_MS, delay));
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function fetchJson(url, init) {
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    let response;
    let bodyText;
    try {
      response = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      bodyText = await response.text();
    } catch (error) {
      if (attempt < MAX_REQUEST_ATTEMPTS) {
        await wait(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw error;
    }

    if (!response.ok) {
      if (attempt < MAX_REQUEST_ATTEMPTS && isTransientStatus(response.status)) {
        await wait(retryDelayMs(response));
        continue;
      }
      throw new Error(bodyText || `Self-host AI request failed (${response.status})`);
    }
    try {
      return bodyText ? JSON.parse(bodyText) : {};
    } catch {
      if (attempt < MAX_REQUEST_ATTEMPTS) {
        await wait(DEFAULT_RETRY_DELAY_MS);
        continue;
      }
      throw new Error("Self-host AI returned invalid JSON");
    }
  }
  throw new Error("Self-host AI request failed after retrying");
}

function normalizedResult(payload) {
  const outputText = extractResponseText(payload);
  return outputText ? { response: outputText } : payload;
}

function anthropicMessages(inputs) {
  const system = inputs.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();
  const messages = inputs.messages.filter((message) => message.role !== "system");
  return { system, messages };
}

class SelfhostAiBinding {
  constructor(env) {
    this.provider = String(env.provider || "").trim().toLowerCase();
    this.apiKey = String(env.apiKey || "").trim();
    this.awsRegion = String(env.awsRegion || "us-east-1").trim();
    this.baseUrl = String(env.baseUrl || "").trim();
    this.customModel = String(env.model || "").trim();
    this.authType = env.authType === "x-api-key" ? "x-api-key" : "bearer";
    this.api = String(env.api || "openai-completions").trim().toLowerCase();
    this.gatewayAccountId = String(env.gatewayAccountId || "").trim();
    this.gatewayName = String(env.gatewayName || "").trim();
    this.gatewayBaseUrl = gatewayBaseUrl(
      String(env.gatewayBaseUrl || "").trim() ||
        "https://gateway.ai.cloudflare.com",
    );
  }

  async run(model, inputs) {
    if (!SUPPORTED_PROVIDERS.has(this.provider)) {
      throw new Error(
        `Unsupported SELFHOST_AI_PROVIDER for auxiliary generation: ${this.provider || "unset"}`,
      );
    }
    if (!this.apiKey) {
      throw new Error("SELFHOST_AI_API_KEY is required for self-host AI binding");
    }
    if (!Array.isArray(inputs?.messages) || inputs.messages.length === 0) {
      throw new Error(`Self-host AI binding does not support model ${model} without chat messages`);
    }

    const providerModel = resolveProviderModel(this.provider, model, this.customModel);
    switch (this.provider) {
      case "anthropic":
        return this.runAnthropic(providerModel, inputs, {
          baseUrl: "https://api.anthropic.com",
          authType: "x-api-key",
        });
      case "bedrock":
        return this.runBedrock(providerModel, inputs);
      case "cloudflare-ai-gateway":
        return this.runCloudflareGateway(providerModel, inputs);
      case "openai":
        return this.runOpenAiResponses(
          providerModel,
          inputs,
          "https://api.openai.com/v1",
          { Authorization: `Bearer ${this.apiKey}` },
          { disableReasoning: true },
        );
      case "openrouter":
        return this.runOpenAiCompletions(
          providerModel,
          inputs,
          "https://openrouter.ai/api/v1",
          {
            Authorization: `Bearer ${this.apiKey}`,
            "HTTP-Referer": "https://camelai.dev",
            "X-OpenRouter-Title": "camelAI",
            "X-OpenRouter-Categories": "cloud-agent,programming-app",
          },
          { disableReasoning: true },
        );
      case "requesty":
        return this.runOpenAiCompletions(
          providerModel,
          inputs,
          "https://router.requesty.ai/v1",
          {
            Authorization: `Bearer ${this.apiKey}`,
            "HTTP-Referer": "https://camelai.dev",
            "X-Title": "camelAI",
          },
          { disableReasoning: true },
        );
      case "custom":
        return this.runCustom(providerModel, inputs);
    }
  }

  async runAnthropic(model, inputs, { baseUrl, authType }) {
    const { system, messages } = anthropicMessages(inputs);
    const authHeaders =
      authType === "x-api-key"
        ? { "x-api-key": this.apiKey }
        : { Authorization: `Bearer ${this.apiKey}` };
    const payload = await fetchJson(
      appendEndpoint(anthropicBaseUrl(baseUrl), "/v1/messages"),
      {
        method: "POST",
        headers: {
          ...authHeaders,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model,
          ...(system ? { system } : {}),
          messages,
          max_tokens: positiveTokenLimit(inputs.max_tokens),
          ...(typeof inputs.temperature === "number"
            ? { temperature: inputs.temperature }
            : {}),
        }),
      },
    );
    return normalizedResult(payload);
  }

  async runOpenAiCompletions(
    model,
    inputs,
    baseUrl,
    authHeaders,
    { disableReasoning = false } = {},
  ) {
    const payload = await fetchJson(appendEndpoint(baseUrl, "/chat/completions"), {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: inputs.messages,
        max_tokens: positiveTokenLimit(inputs.max_tokens),
        ...(typeof inputs.temperature === "number"
          ? { temperature: inputs.temperature }
          : {}),
        ...(disableReasoning ? { reasoning: { effort: "none" } } : {}),
      }),
    });
    return normalizedResult(payload);
  }

  async runOpenAiResponses(
    model,
    inputs,
    baseUrl,
    authHeaders,
    { disableReasoning = false } = {},
  ) {
    const payload = await fetchJson(appendEndpoint(baseUrl, "/responses"), {
      method: "POST",
      headers: {
        ...authHeaders,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        input: inputs.messages,
        max_output_tokens: positiveTokenLimit(inputs.max_tokens),
        store: false,
        ...(disableReasoning ? { reasoning: { effort: "none" } } : {}),
      }),
    });
    return normalizedResult(payload);
  }

  async runCustom(model, inputs) {
    if (!this.baseUrl) {
      throw new Error("SELFHOST_AI_BASE_URL is required for custom auxiliary generation");
    }
    if (!SUPPORTED_CUSTOM_APIS.has(this.api)) {
      throw new Error(`Unsupported SELFHOST_AI_API for auxiliary generation: ${this.api}`);
    }

    if (this.api === "anthropic-messages") {
      return this.runAnthropic(model, inputs, {
        baseUrl: this.baseUrl,
        authType: this.authType,
      });
    }

    const authHeaders =
      this.authType === "x-api-key"
        ? { "x-api-key": this.apiKey }
        : { Authorization: `Bearer ${this.apiKey}` };
    return this.api === "openai-responses"
      ? this.runOpenAiResponses(model, inputs, this.baseUrl, authHeaders)
      : this.runOpenAiCompletions(model, inputs, this.baseUrl, authHeaders);
  }

  async runBedrock(model, inputs) {
    const regions = bedrockRegionCandidates(model, this.awsRegion);
    let payload;
    for (const [index, region] of regions.entries()) {
      const baseUrl = `https://bedrock-mantle.${region}.api.aws/openai/v1`;
      try {
        payload = await fetchJson(appendEndpoint(baseUrl, "/responses"), {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model,
            input: inputs.messages,
            max_output_tokens: positiveTokenLimit(inputs.max_tokens),
            store: false,
            reasoning: { effort: "none" },
          }),
        });
        break;
      } catch (error) {
        if (
          index < regions.length - 1 &&
          isBedrockRegionUnavailableError(
            error instanceof Error ? error.message : String(error),
          )
        ) {
          continue;
        }
        throw error;
      }
    }

    if (!payload) {
      throw new Error("Self-host AI request failed in all supported Bedrock regions");
    }
    return normalizedResult(payload);
  }

  async runCloudflareGateway(model, inputs) {
    if (!this.gatewayAccountId || !this.gatewayName) {
      throw new Error(
        "CF_ACCOUNT_ID and CF_GATEWAY_NAME are required for Gateway auxiliary generation",
      );
    }
    const url = `${this.gatewayBaseUrl}/v1/${encodeURIComponent(this.gatewayAccountId)}/${encodeURIComponent(this.gatewayName)}/compat/chat/completions`;
    const payload = await fetchJson(url, {
      method: "POST",
      headers: {
        // Workers AI authenticates through Authorization; authenticated
        // Gateway uses the same scoped token in cf-aig-authorization.
        Authorization: `Bearer ${this.apiKey}`,
        "cf-aig-authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...inputs,
        model: `workers-ai/${model}`,
      }),
    });
    return normalizedResult(payload.result ?? payload);
  }
}

export default function makeBinding(env) {
  return new SelfhostAiBinding(env);
}
