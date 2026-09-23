export interface AgentMetadata { name?: string; type?: string }
export function agentMetadata(input: AgentMetadata): AgentMetadata {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Agent metadata must be an object");
  const result: AgentMetadata = {};
  for (const key of ['name', 'type'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 120) throw new Error(`${key} must contain 1–120 characters`);
    result[key] = value.trim();
  }
  return result;
}
