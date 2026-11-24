const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const JWT_BEARER_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:jwt-bearer';
const GOOGLE_TOKEN_TIMEOUT_MS = 15_000;

export class ServiceAccountTokenError extends Error {
  readonly permanent: boolean;
  readonly status?: number;

  constructor(message: string, options: { permanent?: boolean; status?: number } = {}) {
    super(message);
    this.name = 'ServiceAccountTokenError';
    this.permanent = options.permanent ?? false;
    this.status = options.status;
  }
}

interface GoogleServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}

interface GoogleTokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

function base64urlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function decodePemToBytes(pem: string): Uint8Array {
  const normalized = pem
    .replace('-----BEGIN PRIVATE KEY-----', '')
    .replace('-----END PRIVATE KEY-----', '')
    .replace(/\s+/g, '');

  const binary = atob(normalized);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  try {
    const keyBytes = decodePemToBytes(pem);
    const keyBuffer = keyBytes.buffer.slice(
      keyBytes.byteOffset,
      keyBytes.byteOffset + keyBytes.byteLength
    ) as ArrayBuffer;
    return await crypto.subtle.importKey(
      'pkcs8',
      keyBuffer,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['sign']
    );
  } catch (error) {
    throw new ServiceAccountTokenError(
      `service_account_json private_key is invalid: ${error instanceof Error ? error.message : String(error)}`,
      { permanent: true }
    );
  }
}

function parseServiceAccountJson(serviceAccountJson: string): GoogleServiceAccountKey {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serviceAccountJson);
  } catch {
    throw new ServiceAccountTokenError('service_account_json is not valid JSON', { permanent: true });
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new ServiceAccountTokenError('service_account_json must be a JSON object', { permanent: true });
  }

  const key = parsed as GoogleServiceAccountKey;
  if (!key.client_email) throw new ServiceAccountTokenError('service_account_json missing client_email', { permanent: true });
  if (!key.private_key) throw new ServiceAccountTokenError('service_account_json missing private_key', { permanent: true });

  return key;
}

async function createJwtAssertion(
  serviceAccount: GoogleServiceAccountKey,
  tokenUrl: string
): Promise<string> {
  const nowSeconds = Math.floor(Date.now() / 1000);

  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: serviceAccount.client_email,
    scope: BIGQUERY_SCOPE,
    aud: tokenUrl,
    iat: nowSeconds - 60, // small skew buffer
    exp: nowSeconds + 3600,
  };

  const encoder = new TextEncoder();
  const encodedHeader = base64urlEncode(encoder.encode(JSON.stringify(header)));
  const encodedClaims = base64urlEncode(encoder.encode(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;

  const privateKey = await importPrivateKey(serviceAccount.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    privateKey,
    encoder.encode(signingInput)
  );
  const encodedSignature = base64urlEncode(new Uint8Array(signature));

  return `${signingInput}.${encodedSignature}`;
}

export async function mintBigQueryAccessTokenFromServiceAccount(serviceAccountJson: string): Promise<{
  accessToken: string;
  tokenType: string;
  expiresAt: number;
  projectId: string | null;
}> {
  const serviceAccount = parseServiceAccountJson(serviceAccountJson);
  const tokenUrl = serviceAccount.token_uri || GOOGLE_OAUTH_TOKEN_URL;
  const assertion = await createJwtAssertion(serviceAccount, tokenUrl);

  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: JWT_BEARER_GRANT_TYPE,
      assertion,
    }),
    signal: AbortSignal.timeout(GOOGLE_TOKEN_TIMEOUT_MS),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const permanent = response.status >= 400 && response.status < 500 && response.status !== 408 && response.status !== 429;
    throw new ServiceAccountTokenError(`Google token exchange failed: ${response.status} ${errorText}`, {
      permanent,
      status: response.status,
    });
  }

  const data = (await response.json()) as GoogleTokenResponse;
  if (!data.access_token) {
    throw new Error('Google token exchange returned no access_token');
  }

  const expiresIn = data.expires_in ?? 3600;
  const expiresAt = Date.now() + expiresIn * 1000;

  return {
    accessToken: data.access_token,
    tokenType: data.token_type || 'Bearer',
    expiresAt,
    projectId: serviceAccount.project_id ?? null,
  };
}
