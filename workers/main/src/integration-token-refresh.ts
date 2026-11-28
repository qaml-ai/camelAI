import type { WorkspaceIntegrationRecord } from './workspace';

export const BIGQUERY_INTEGRATION_TYPE = 'bigquery';
export const TOKEN_REFRESH_BUFFER_MS = 10 * 60_000;

export function needsIntegrationTokenRefresh(
  record: Pick<WorkspaceIntegrationRecord, 'integration_type' | 'auth_method' | 'token_expires_at'>,
  credentials?: Record<string, unknown>,
): boolean {
  const { integration_type: type, auth_method: authMethod, token_expires_at: expiresAt } = record;
  const expiring = expiresAt != null && expiresAt <= Date.now() + TOKEN_REFRESH_BUFFER_MS;
  if (type === BIGQUERY_INTEGRATION_TYPE) {
    return expiresAt == null || expiring || (credentials !== undefined && !credentials.access_token);
  }
  return expiring && (authMethod === 'oauth2' || type === 'notion' || type === 'google_analytics' || type === 'remote_mcp');
}
