import type { AgentConfig } from './protocol.ts';
import { validateDefinitions } from './tool-policy.ts';
import { validateInitialMessages } from './history.ts';

type SessionConfig = Omit<AgentConfig, 'id' | 'directory' | 'tools' | 'apiKey'>;

/** Only operator-authenticated provisioning may choose an inference endpoint. */
export function sessionConfig(input: any, defaultModel: AgentConfig['model'], defaultPrompt?: string): SessionConfig {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid session configuration');
  if ('apiKey' in input) throw new Error('Configure credentials on the runtime host, not in agent configuration');
  const model = input.model ?? defaultModel;
  if (!model || typeof model !== 'object' || Array.isArray(model) ||
      ['id', 'name', 'api', 'provider', 'baseUrl'].some(key => typeof model[key] !== 'string' || !model[key]) ||
      typeof model.reasoning !== 'boolean' || !Array.isArray(model.input) || !model.input.every((value: unknown) => value === 'text' || value === 'image') ||
      !Number.isFinite(model.contextWindow) || model.contextWindow <= 0 || !Number.isFinite(model.maxTokens) || model.maxTokens <= 0 ||
      !model.cost || ['input', 'output', 'cacheRead', 'cacheWrite'].some(key => !Number.isFinite(model.cost[key]) || model.cost[key] < 0)) throw new Error('Invalid model configuration');
  const url = new URL(model.baseUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Model baseUrl must be an HTTP(S) endpoint without credentials or query parameters');
  if (model.headers || model.apiKey || model.token) throw new Error('Model credentials and custom headers must be configured on the runtime host');
  const updates = configurationUpdate({
    ...(input.systemPrompt !== undefined || defaultPrompt !== undefined ? { systemPrompt: input.systemPrompt !== undefined ? input.systemPrompt : defaultPrompt } : {}),
    ...(input.thinkingLevel !== undefined ? { thinkingLevel: input.thinkingLevel } : {}),
  });
  if (input.initialMessages !== undefined) validateInitialMessages(input.initialMessages);
  return { model, ...updates, ...(input.initialMessages !== undefined ? { initialMessages: input.initialMessages } : {}) };
}

/** Scoped credentials can change behavior and tools, but never the model endpoint or credentials. */
export function configurationUpdate(input: any): Pick<AgentConfig, 'systemPrompt' | 'thinkingLevel'> & { tools?: AgentConfig['tools'] } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid configuration');
  for (const key of Object.keys(input)) if (!['systemPrompt', 'thinkingLevel', 'tools'].includes(key)) throw new Error(`Unsupported scoped configuration field: ${key}`);
  if (input.systemPrompt !== undefined && (typeof input.systemPrompt !== 'string' || !input.systemPrompt.trim() || input.systemPrompt.length > 32000)) throw new Error('systemPrompt must contain 1–32000 characters');
  if (input.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(input.thinkingLevel)) throw new Error('Invalid thinkingLevel');
  if (input.tools !== undefined) validateDefinitions(input.tools);
  return input;
}
