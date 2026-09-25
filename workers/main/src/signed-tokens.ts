/**
 * Self-validating HMAC-signed tokens
 *
 * These tokens don't require storage - they contain their claims in the payload
 * and are validated by verifying the HMAC signature. This avoids KV eventual
 * consistency issues when tokens need to be used immediately after creation.
 *
 * Token format: st_<base64url(payload)>.<base64url(hmac)>
 */

export interface SignedTokenPayload {
  /** Organization ID */
  org_id: string;
  /** Organization slug for namespaced deployments */
  org_slug: string;
  /** User ID (optional for service tokens like MSSQL) */
  user_id?: string;
  /** Permission scopes (e.g., ['proxy'], ['mcp'], ['tail']) */
  scopes: string[];
  /** Issued at timestamp (ms) */
  iat: number;
  /** Expiry timestamp (ms), null for non-expiring */
  exp: number | null;
  /** Optional workspace ID for scoped tokens */
  workspace_id?: string;
  /** Optional thread ID for scoped service tokens */
  thread_id?: string;
  /** Optional token name/purpose */
  name?: string;
  /** Script name (user-facing) for tail tokens */
  script_name?: string;
  /** Dispatch script name ({script}--{org-slug}) for tail tokens */
  dispatch_script_name?: string;
}

const TOKEN_PREFIX = 'st_';

/**
 * Base64url encode (URL-safe, no padding)
 */
function base64urlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

/**
 * Base64url decode
 */
function base64urlDecode(str: string): Uint8Array {
  const base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/**
 * Import secret key for HMAC operations
 */
async function importKey(secret: string): Promise<CryptoKey> {
  const encoder = new TextEncoder();
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

/**
 * Create an HMAC-signed token
 *
 * @param secret - Secret key for signing (should be from environment)
 * @param payload - Token claims
 * @returns Signed token string (st_<payload>.<signature>)
 */
export async function createSignedToken(
  secret: string,
  payload: Omit<SignedTokenPayload, 'iat'> & { iat?: number }
): Promise<string> {
  const fullPayload: SignedTokenPayload = {
    ...payload,
    iat: payload.iat ?? Date.now(),
  };

  const encoder = new TextEncoder();
  const payloadBytes = encoder.encode(JSON.stringify(fullPayload));
  const payloadB64 = base64urlEncode(payloadBytes);

  const key = await importKey(secret);
  const signature = await crypto.subtle.sign('HMAC', key, payloadBytes);
  const signatureB64 = base64urlEncode(new Uint8Array(signature));

  return `${TOKEN_PREFIX}${payloadB64}.${signatureB64}`;
}

/**
 * Validate and decode a signed token
 *
 * @param secret - Secret key for verification
 * @param token - Token string to validate
 * @returns Decoded payload if valid, null if invalid or expired
 */
export async function validateSignedToken(
  secret: string,
  token: string
): Promise<SignedTokenPayload | null> {
  // Check prefix
  if (!token.startsWith(TOKEN_PREFIX)) {
    return null;
  }

  const tokenBody = token.slice(TOKEN_PREFIX.length);
  const dotIndex = tokenBody.indexOf('.');
  if (dotIndex === -1) {
    return null;
  }

  const payloadB64 = tokenBody.slice(0, dotIndex);
  const signatureB64 = tokenBody.slice(dotIndex + 1);

  try {
    const payloadBytes = base64urlDecode(payloadB64);
    const signatureBytes = base64urlDecode(signatureB64);

    // Verify signature
    const key = await importKey(secret);
    // Create fresh Uint8Arrays to satisfy TypeScript's strict BufferSource typing
    const valid = await crypto.subtle.verify(
      'HMAC',
      key,
      new Uint8Array(signatureBytes),
      new Uint8Array(payloadBytes)
    );
    if (!valid) {
      return null;
    }

    // Decode payload
    const decoder = new TextDecoder();
    const payload = JSON.parse(decoder.decode(payloadBytes)) as SignedTokenPayload;

    // Check expiry
    if (payload.exp && payload.exp < Date.now()) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}
