/** Pasted Authorization schemes are supplied by the connection adapter itself. */
export function stripAuthScheme(value: string): string {
  return value.trim().replace(/^(?:(?:bearer|token)(?:\s+|$))+/i, '').trim();
}

/** Normalize only token-based MCP credentials; custom header values are opaque. */
export function normalizeIntegrationTokens(
  integrationType: string,
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
): Record<string, unknown> {
  if (integrationType !== 'github' && !(
    integrationType === 'remote_mcp' && ['bearer', 'oauth'].includes(String(config.auth_type))
  )) return credentials;
  return Object.fromEntries(Object.entries(credentials).map(([key, value]) => [
    key,
    ['token', 'api_key', 'access_token'].includes(key) && typeof value === 'string'
      ? stripAuthScheme(value)
      : value,
  ]));
}
