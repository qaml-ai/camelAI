const DEFAULT_BEDROCK_REGION = 'us-east-1';

interface Env {
  BEDROCK_REGION?: string;
}

interface AnthropicMessagesRequest {
  model?: string;
  stream?: boolean;
  [key: string]: unknown;
}

interface BedrockModelMetadata {
  id: string;
  bedrockModelId: string;
  name: string;
  reasoning: boolean;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: {
    forceAdaptiveThinking?: boolean;
    supportsTemperature?: boolean;
    supportsEagerToolInputStreaming?: boolean;
  };
  input: ('text' | 'image')[];
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
}

const bedrockModels: BedrockModelMetadata[] = [
  {
    id: 'claude-fable-5-1',
    bedrockModelId: 'anthropic.claude-fable-5-1',
    name: 'Claude Fable 5.1',
    reasoning: true,
    thinkingLevelMap: { off: null, xhigh: 'xhigh' },
    input: ['text', 'image'],
    cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'claude-sonnet-5-5',
    bedrockModelId: 'anthropic.claude-sonnet-5-5',
    name: 'Claude Sonnet 5.5',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'claude-opus-5-5',
    bedrockModelId: 'anthropic.claude-opus-5-5',
    name: 'Claude Opus 5.5',
    reasoning: true,
    thinkingLevelMap: { xhigh: 'xhigh', max: 'max' },
    compat: {
      forceAdaptiveThinking: true,
      supportsTemperature: false,
      supportsEagerToolInputStreaming: false,
    },
    input: ['text', 'image'],
    cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
    contextWindow: 1_000_000,
    maxTokens: 128_000,
  },
  {
    id: 'claude-haiku-4-5',
    bedrockModelId: 'anthropic.claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    contextWindow: 200_000,
    maxTokens: 64_000,
  },
  {
    id: 'claude-sonnet-4-6',
    bedrockModelId: 'anthropic.claude-sonnet-4-6-v1',
    name: 'Claude Sonnet 4.6',
    reasoning: true,
    input: ['text', 'image'],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 1_000_000,
    maxTokens: 64_000,
  },
];

const bedrockModelMap: Record<string, string> = {
  ...Object.fromEntries(bedrockModels.map((model) => [model.id, model.bedrockModelId])),
  ...Object.fromEntries(bedrockModels.map((model) => [model.bedrockModelId, model.bedrockModelId])),
  sonnet: 'anthropic.claude-sonnet-5-5',
  'fable-5': 'anthropic.claude-fable-5-1',
  'fable-5.1': 'anthropic.claude-fable-5-1',
  'anthropic/claude-fable-5': 'anthropic.claude-fable-5-1',
  'anthropic/claude-fable-5.1': 'anthropic.claude-fable-5-1',
  'global.anthropic.claude-fable-5': 'anthropic.claude-fable-5-1',
  'global.anthropic.claude-fable-5-1': 'anthropic.claude-fable-5-1',
  'anthropic.claude-fable-5': 'anthropic.claude-fable-5-1',
  'claude-sonnet-5': 'anthropic.claude-sonnet-5-5',
  'anthropic.claude-sonnet-5': 'anthropic.claude-sonnet-5-5',
  'anthropic/claude-sonnet-5': 'anthropic.claude-sonnet-5-5',
  'anthropic/claude-sonnet-5.5': 'anthropic.claude-sonnet-5-5',
  'global.anthropic.claude-sonnet-5': 'anthropic.claude-sonnet-5-5',
  'global.anthropic.claude-sonnet-5-5': 'anthropic.claude-sonnet-5-5',
  opus: 'anthropic.claude-opus-5-5',
  'opus-4.7': 'anthropic.claude-opus-5-5',
  'opus-4.8': 'anthropic.claude-opus-5-5',
  'opus-5': 'anthropic.claude-opus-5-5',
  'opus-5.5': 'anthropic.claude-opus-5-5',
  'anthropic/claude-opus-5': 'anthropic.claude-opus-5-5',
  'anthropic/claude-opus-5.5': 'anthropic.claude-opus-5-5',
  'global.anthropic.claude-opus-5': 'anthropic.claude-opus-5-5',
  'global.anthropic.claude-opus-5-5': 'anthropic.claude-opus-5-5',
  'anthropic.claude-opus-5': 'anthropic.claude-opus-5-5',
  'anthropic/claude-opus-4.8': 'anthropic.claude-opus-5-5',
  'anthropic/claude-opus-4-8': 'anthropic.claude-opus-5-5',
  'global.anthropic.claude-opus-4-8': 'anthropic.claude-opus-5-5',
  'anthropic/claude-haiku-4.5': 'anthropic.claude-haiku-4-5',
  'claude-haiku-4-5-20251001': 'anthropic.claude-haiku-4-5',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0': 'anthropic.claude-haiku-4-5',
  'global.anthropic.claude-sonnet-4-6': 'anthropic.claude-sonnet-4-6-v1',
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'bedrock-provider' });
    }

    if (request.method === 'GET' && url.pathname === '/v1/models') {
      return Response.json({ data: bedrockModels.map(toModelListItem) });
    }

    if (request.method !== 'POST' || url.pathname !== '/v1/messages') {
      return new Response('Not Found', { status: 404 });
    }

    let body: AnthropicMessagesRequest;
    try {
      body = (await request.json()) as AnthropicMessagesRequest;
    } catch {
      return Response.json({ error: { message: 'Invalid JSON body' } }, { status: 400 });
    }

    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      return Response.json({ error: { message: 'Missing model in request body' } }, { status: 400 });
    }

    const region = request.headers.get('x-bedrock-region')?.trim() || env.BEDROCK_REGION?.trim() || DEFAULT_BEDROCK_REGION;
    const authorization = request.headers.get('authorization')?.trim();
    const apiKey = request.headers.get('x-api-key')?.trim();
    if (!authorization && !apiKey) {
      return Response.json({ error: { message: 'Missing Authorization or x-api-key header' } }, { status: 401 });
    }

    const stream = body.stream === true;
    const upstream = await fetch(`https://bedrock-mantle.${region}.api.aws/anthropic/v1/messages`, {
      method: 'POST',
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        'content-type': 'application/json',
        'anthropic-version': request.headers.get('anthropic-version')?.trim() || '2023-06-01',
        ...(request.headers.get('anthropic-beta') ? { 'anthropic-beta': request.headers.get('anthropic-beta')! } : {}),
      },
      body: JSON.stringify(toMantleBody(body)),
    });

    return new Response(upstream.body, {
      status: upstream.status,
      headers: stream && upstream.ok
        ? {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          }
        : passthroughHeaders(upstream.headers),
    });
  },
};

function toModelListItem(model: BedrockModelMetadata): Record<string, unknown> {
  return {
    id: model.id,
    object: 'model',
    name: model.name,
    reasoning: model.reasoning,
    thinkingLevelMap: model.thinkingLevelMap,
    compat: model.compat,
    input: model.input,
    cost: model.cost,
    contextWindow: model.contextWindow,
    context_window: model.contextWindow,
    maxTokens: model.maxTokens,
    max_tokens: model.maxTokens,
    bedrockModelId: model.bedrockModelId,
  };
}

function toMantleBody(body: AnthropicMessagesRequest): Record<string, unknown> {
  const sourceModel = typeof body.model === 'string' ? body.model : '';
  const next: Record<string, unknown> = {
    ...body,
    model: mapToBedrockModel(sourceModel),
  };

  if (!isLegacyOpusModel(sourceModel)) return next;

  // Opus 4.6 and earlier accepted manual thinking budgets and sampling
  // parameters that Opus 5 rejects. Older clients may still send those fields
  // through the 4.7/4.8 compatibility aliases, so migrate the request body at
  // the same boundary where the model ID is upgraded.
  delete next.temperature;
  delete next.top_p;
  delete next.top_k;

  const thinking = asRecord(next.thinking);
  if (thinking?.type === 'enabled') {
    const adaptiveThinking = { ...thinking, type: 'adaptive' };
    delete adaptiveThinking.budget_tokens;
    next.thinking = adaptiveThinking;
  } else if (
    thinking?.type === 'disabled' &&
    isAboveDisabledThinkingEffort(asRecord(next.output_config)?.effort)
  ) {
    // Opus 5 permits disabled thinking only through high effort. Preserve the
    // requested xhigh/max effort and re-enable adaptive thinking.
    next.thinking = { type: 'adaptive' };
  }

  return next;
}

function isLegacyOpusModel(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === 'opus' ||
    normalized.includes('opus-4-8') ||
    normalized.includes('opus-4.8') ||
    normalized.includes('opus-4-7') ||
    normalized.includes('opus-4.7');
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isAboveDisabledThinkingEffort(effort: unknown): boolean {
  return effort === 'xhigh' || effort === 'max';
}

function mapToBedrockModel(model: string): string {
  const direct = bedrockModelMap[model] ?? bedrockModelMap[model.toLowerCase()];
  if (direct) return direct;

  const normalized = model.toLowerCase();
  if (normalized.includes('fable-5')) return 'anthropic.claude-fable-5-1';
  if (normalized.includes('sonnet-5')) return 'anthropic.claude-sonnet-5-5';
  if (
    normalized.includes('opus-5') ||
    normalized.includes('opus-4-8') ||
    normalized.includes('opus-4.8') ||
    normalized.includes('opus-4-7') ||
    normalized.includes('opus-4.7')
  ) return 'anthropic.claude-opus-5-5';
  if (normalized.includes('sonnet-4-6') || normalized.includes('sonnet-4.6')) return 'anthropic.claude-sonnet-4-6-v1';
  if (normalized.includes('haiku-4-5') || normalized.includes('haiku-4.5')) return 'anthropic.claude-haiku-4-5';

  return normalized.startsWith('anthropic.') ? normalized : `anthropic.${model}`;
}

function passthroughHeaders(headers: Headers): Headers {
  const next = new Headers();
  const contentType = headers.get('content-type');
  if (contentType) next.set('content-type', contentType);
  const requestId = headers.get('x-amzn-requestid');
  if (requestId) next.set('x-amzn-requestid', requestId);
  return next;
}
