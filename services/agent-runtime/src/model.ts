import { getModel } from "@earendil-works/pi-ai/compat";
import type { Api, Model } from "@earendil-works/pi-ai";

export function configuredModel(): Model<Api> {
  const provider = process.env.AGENT_PROVIDER ?? "anthropic";
  const id = process.env.AGENT_MODEL ?? "claude-sonnet-4-5";
  const model = (getModel as (provider: string, id: string) => Model<Api> | undefined)(provider, id);
  if (!model) throw new Error(`Unknown Pi model: ${provider}/${id}`);
  return { ...model, ...(process.env.AGENT_BASE_URL ? { baseUrl: process.env.AGENT_BASE_URL } : {}) };
}
