import {
  normalizeRemoteMcpUrl,
  validateRemoteMcpUrl,
} from "../../../src/lib/remote-mcp.js";

type FetchLike = typeof fetch;

export class RemoteMcpOAuthError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "discovery_failed"
      | "metadata_failed"
      | "registration_unsupported"
      | "registration_failed"
      | "token_exchange_failed"
      | "refresh_failed",
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RemoteMcpOAuthError";
  }
}

export interface RemoteMcpOAuthDiscovery {
  authorizationServer: string;
  resource: string;
  scope: string | null;
  metadata: Record<string, unknown>;
  resourceMetadata: Record<string, unknown> | null;
}

export interface RemoteMcpRegisteredClient {
  client_id: string;
  client_secret?: string;
  token_endpoint_auth_method?: string;
}

export interface RemoteMcpOAuthTokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface ProtectedResourceAttempt {
  url: string;
  status?: number;
  contentType?: string;
  error?: string;
}

interface ProtectedResourceDiscoveryResult {
  metadata: Record<string, unknown> | null;
  candidates: string[];
  attempts: ProtectedResourceAttempt[];
}

const MCP_PROTOCOL_VERSION = "2025-06-18";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function safeUrl(raw: unknown): URL | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const url = new URL(raw.trim());
    if (validateRemoteMcpUrl(url.toString()).length > 0) return null;
    return url;
  } catch {
    return null;
  }
}

function assertSafeEndpoint(raw: unknown, label: string): string {
  const url = safeUrl(raw);
  if (!url) throw new Error(`${label} must be a remote HTTPS URL`);
  return url.toString();
}

// Never forward OAuth POST bodies (codes, verifiers, or refresh tokens) to
// redirect targets. Apply the same policy to discovery to prevent redirect SSRF.
// Cloudflare Workers does not implement redirect: "error"; manual mode never
// follows a redirect, and callers treat the unfollowed 3xx as a failed response.
function oauthFetch(fetchFn: FetchLike, url: string, init: RequestInit = {}): Promise<Response> {
  return fetchFn(assertSafeEndpoint(url, "OAuth endpoint"), {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  });
}

function appendPath(base: URL, prefix: string): string {
  const path = base.pathname === "/" ? "" : base.pathname.replace(/\/$/, "");
  return `${base.origin}${prefix}${path}`;
}

async function readBoundedText(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1024 * 1024) {
        await reader.cancel();
        throw new Error("OAuth response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(body);
}

async function readJsonObject(response: Response): Promise<Record<string, unknown> | null> {
  if (!response.ok) return null;
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("json")) return null;
  try {
    const parsed = JSON.parse(await readBoundedText(response));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function parseWwwAuthenticate(header: string | null): Record<string, string> {
  if (!header || !/^Bearer\b/i.test(header.trim())) return {};
  const params: Record<string, string> = {};
  const input = header.replace(/^Bearer\s*/i, "");
  const pattern = /([A-Za-z_][A-Za-z0-9_-]*)=(?:"([^"]*)"|([^,\s]+))/g;
  for (const match of input.matchAll(pattern)) {
    params[match[1].toLowerCase()] = match[2] ?? match[3] ?? "";
  }
  return params;
}

async function discoverChallenge(serverUrl: URL, fetchFn: FetchLike): Promise<Record<string, string>> {
  try {
    const response = await oauthFetch(fetchFn, serverUrl.toString(), {
      method: "GET",
      headers: { "mcp-protocol-version": MCP_PROTOCOL_VERSION },
    });
    return parseWwwAuthenticate(response.headers.get("www-authenticate"));
  } catch {
    return {};
  }
}

async function discoverProtectedResourceMetadata(
  serverUrl: URL,
  challenge: Record<string, string>,
  fetchFn: FetchLike
): Promise<ProtectedResourceDiscoveryResult> {
  const candidates: string[] = [];
  if (challenge.resource_metadata) {
    const challenged = safeUrl(challenge.resource_metadata);
    if (challenged) candidates.push(challenged.toString());
  }
  candidates.push(appendPath(serverUrl, "/.well-known/oauth-protected-resource"));
  candidates.push(`${serverUrl.origin}/.well-known/oauth-protected-resource`);
  const uniqueCandidates = [...new Set(candidates)];
  const attempts: ProtectedResourceAttempt[] = [];

  for (const candidate of uniqueCandidates) {
    let response: Response;
    try {
      response = await oauthFetch(fetchFn, candidate, {
        headers: { "mcp-protocol-version": MCP_PROTOCOL_VERSION },
      });
    } catch (error) {
      attempts.push({
        url: candidate,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    const body = await readBoundedText(response).catch(() => "");
    let metadata: Record<string, unknown> | null = null;
    if (response.ok && contentType.includes("json")) {
      try {
        const parsed = JSON.parse(body);
        metadata = isRecord(parsed) ? parsed : null;
      } catch {
        metadata = null;
      }
    }
    attempts.push({
      url: candidate,
      status: response.status,
      contentType,
    });
    if (metadata) return { metadata, candidates: uniqueCandidates, attempts };
  }
  return { metadata: null, candidates: uniqueCandidates, attempts };
}

function authorizationServerMetadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  if (!path) {
    return [
      `${url.origin}/.well-known/oauth-authorization-server`,
      `${url.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

async function discoverAuthorizationServerMetadata(
  issuer: string,
  fetchFn: FetchLike
): Promise<Record<string, unknown>> {
  for (const candidate of authorizationServerMetadataUrls(issuer)) {
    const response = await oauthFetch(fetchFn, candidate).catch(() => null);
    if (!response) continue;
    const metadata = await readJsonObject(response);
    if (metadata) {
      if (metadata.issuer !== issuer) {
        throw new RemoteMcpOAuthError("OAuth metadata issuer does not match the selected authorization server", "metadata_failed");
      }
      return metadata;
    }
  }
  throw new RemoteMcpOAuthError(
    "OAuth authorization server metadata could not be discovered",
    "metadata_failed",
  );
}

function scopeFromMetadata(
  challenge: Record<string, string>,
  resourceMetadata: Record<string, unknown> | null
): string | null {
  if (challenge.scope?.trim()) return challenge.scope.trim();
  const scopes = resourceMetadata?.scopes_supported;
  if (Array.isArray(scopes)) {
    const values = scopes.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
    if (values.length > 0) return values.join(" ");
  }
  return null;
}

export async function discoverRemoteMcpOAuth(
  rawServerUrl: string,
  fetchFn: FetchLike = fetch
): Promise<RemoteMcpOAuthDiscovery> {
  const normalizedServerUrl = normalizeRemoteMcpUrl(rawServerUrl);
  const serverUrl = new URL(normalizedServerUrl);
  const challenge = await discoverChallenge(serverUrl, fetchFn);
  const resourceDiscovery = await discoverProtectedResourceMetadata(serverUrl, challenge, fetchFn);
  const resourceMetadata = resourceDiscovery.metadata;
  const authorizationServers = resourceMetadata?.authorization_servers;
  const issuer = Array.isArray(authorizationServers)
    ? authorizationServers.find((value): value is string => typeof value === "string" && Boolean(safeUrl(value)))
    : null;
  if (!issuer) {
    throw new RemoteMcpOAuthError(
      "Remote MCP server did not advertise an OAuth authorization server",
      "discovery_failed",
      {
        serverUrl: normalizedServerUrl,
        challenge,
        candidates: resourceDiscovery.candidates,
        attempts: resourceDiscovery.attempts,
        resourceMetadata,
      },
    );
  }

  const metadata = await discoverAuthorizationServerMetadata(issuer, fetchFn);
  const authorizationEndpoint = assertSafeEndpoint(metadata.authorization_endpoint, "OAuth authorization endpoint");
  const tokenEndpoint = assertSafeEndpoint(metadata.token_endpoint, "OAuth token endpoint");
  metadata.authorization_endpoint = authorizationEndpoint;
  metadata.token_endpoint = tokenEndpoint;
  if (metadata.registration_endpoint) {
    metadata.registration_endpoint = assertSafeEndpoint(metadata.registration_endpoint, "OAuth registration endpoint");
  }

  return {
    authorizationServer: issuer,
    resource: typeof resourceMetadata?.resource === "string" && resourceMetadata.resource.trim()
      ? resourceMetadata.resource.trim()
      : normalizedServerUrl,
    scope: scopeFromMetadata(challenge, resourceMetadata),
    metadata,
    resourceMetadata,
  };
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function createPkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64Url(bytes);
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

export async function registerRemoteMcpOAuthClient(
  discovery: RemoteMcpOAuthDiscovery,
  redirectUri: string,
  fetchFn: FetchLike = fetch
): Promise<RemoteMcpRegisteredClient> {
  const registrationEndpoint = discovery.metadata.registration_endpoint;
  if (typeof registrationEndpoint !== "string" || !registrationEndpoint) {
    throw new RemoteMcpOAuthError(
      "OAuth authorization server does not support dynamic client registration",
      "registration_unsupported",
    );
  }

  const response = await oauthFetch(fetchFn, registrationEndpoint, {
    method: "POST",
    headers: {
      "accept": "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      client_name: "camelAI Remote MCP",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "web",
      ...(discovery.scope ? { scope: discovery.scope } : {}),
    }),
  });

  const text = await readBoundedText(response);
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  if (!response.ok || !isRecord(payload) || typeof payload.client_id !== "string") {
    throw new RemoteMcpOAuthError(
      `OAuth dynamic client registration failed with HTTP ${response.status}`,
      "registration_failed",
    );
  }

  return {
    client_id: payload.client_id,
    client_secret: typeof payload.client_secret === "string" ? payload.client_secret : undefined,
    token_endpoint_auth_method: typeof payload.token_endpoint_auth_method === "string"
      ? payload.token_endpoint_auth_method
      : "none",
  };
}

export function buildRemoteMcpAuthorizationUrl(args: {
  discovery: RemoteMcpOAuthDiscovery;
  client: RemoteMcpRegisteredClient;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}): string {
  const authUrl = new URL(String(args.discovery.metadata.authorization_endpoint));
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", args.client.client_id);
  authUrl.searchParams.set("redirect_uri", args.redirectUri);
  authUrl.searchParams.set("state", args.state);
  authUrl.searchParams.set("code_challenge", args.codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");
  authUrl.searchParams.set("resource", args.discovery.resource);
  if (args.discovery.scope) {
    authUrl.searchParams.set("scope", args.discovery.scope);
  }
  return authUrl.toString();
}

function tokenRequestAuth(
  body: URLSearchParams,
  clientId: string,
  clientSecret: string | undefined,
  method: string | undefined
): Headers {
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (method === "client_secret_basic" && clientSecret) {
    headers.set("authorization", `Basic ${btoa(`${clientId}:${clientSecret}`)}`);
    return headers;
  }
  body.set("client_id", clientId);
  if (method === "client_secret_post" && clientSecret) {
    body.set("client_secret", clientSecret);
  }
  return headers;
}

export async function exchangeRemoteMcpOAuthCode(
  args: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret?: string;
    tokenEndpointAuthMethod?: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
  },
  fetchFn: FetchLike = fetch
): Promise<RemoteMcpOAuthTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: args.redirectUri,
    code_verifier: args.codeVerifier,
    resource: args.resource,
  });
  const headers = tokenRequestAuth(body, args.clientId, args.clientSecret, args.tokenEndpointAuthMethod);
  const response = await oauthFetch(fetchFn, args.tokenEndpoint, { method: "POST", headers, body });
  const payload = await readBoundedText(response).then(text => JSON.parse(text)).catch(() => ({})) as RemoteMcpOAuthTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new RemoteMcpOAuthError(
      "OAuth token exchange failed",
      "token_exchange_failed",
    );
  }
  return payload;
}

export async function refreshRemoteMcpOAuthToken(
  credentials: Record<string, unknown>,
  fetchFn: FetchLike = fetch
): Promise<{ credentials: Record<string, unknown>; expiresAt: number }> {
  const refreshToken = typeof credentials.refresh_token === "string" ? credentials.refresh_token : "";
  const tokenEndpoint = typeof credentials.oauth_token_endpoint === "string" ? credentials.oauth_token_endpoint : "";
  const clientId = typeof credentials.oauth_client_id === "string" ? credentials.oauth_client_id : "";
  const clientSecret = typeof credentials.oauth_client_secret === "string" ? credentials.oauth_client_secret : undefined;
  const authMethod = typeof credentials.oauth_token_endpoint_auth_method === "string"
    ? credentials.oauth_token_endpoint_auth_method
    : "none";
  const resource = typeof credentials.oauth_resource === "string" ? credentials.oauth_resource : "";
  if (!refreshToken || !tokenEndpoint || !clientId || !resource) {
    throw new Error("Remote MCP OAuth credentials are missing refresh metadata");
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    resource,
  });
  const headers = tokenRequestAuth(body, clientId, clientSecret, authMethod);
  const response = await oauthFetch(fetchFn, tokenEndpoint, { method: "POST", headers, body });
  const payload = await readBoundedText(response).then(text => JSON.parse(text)).catch(() => ({})) as RemoteMcpOAuthTokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new RemoteMcpOAuthError(
      "Remote MCP OAuth token refresh failed",
      "refresh_failed",
    );
  }
  const expiresAt = Date.now() + (payload.expires_in ?? 3600) * 1000;
  return {
    credentials: {
      ...credentials,
      access_token: payload.access_token,
      refresh_token: payload.refresh_token || refreshToken,
      token_type: payload.token_type,
      scope: payload.scope ?? credentials.scope,
      expires_at: expiresAt,
    },
    expiresAt,
  };
}
