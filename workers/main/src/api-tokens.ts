/**
 * API Token utilities with direct KV access.
 *
 * Tokens are stored in the APP_KV KV namespace with automatic TTL expiration.
 * No DO coordination needed - KV faults to origin if key isn't in local cache.
 */

export interface ApiTokenData {
  org_id: string;
  user_id: string;
  integration_id: string | null;
  name: string;
  scopes: string[];
  created_at: number;
  expires_at: number | null;
}

export interface CreateApiTokenInput {
  orgId: string;
  userId: string;
  name: string;
  scopes: string[];
  integrationId?: string | null;
  expiresAt?: number | null;
}

/**
 * Validate an API token from KV
 * Returns null if token doesn't exist or is expired
 */
export async function validateApiToken(
  kv: KVNamespace,
  tokenId: string
): Promise<ApiTokenData | null> {
  const data = await kv.get(tokenId);
  if (!data) return null;

  const tokenData = JSON.parse(data) as ApiTokenData;

  // Double-check expiration (KV TTL should handle this, but be safe)
  if (tokenData.expires_at && tokenData.expires_at < Date.now()) {
    await kv.delete(tokenId);
    return null;
  }

  return tokenData;
}
