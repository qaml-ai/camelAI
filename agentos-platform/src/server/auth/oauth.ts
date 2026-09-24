export type OAuthProviderName = "github" | "google";

export type OAuthProviderConfig = {
  provider: OAuthProviderName;
  clientId: string;
  secret: string;
  authorizeUrl: string;
  tokenUrl: string;
  userInfoUrl: string;
  scopes: string[];
};

export type OAuthProfile = {
  providerUserId: string;
  email: string;
  name: string;
};

type OAuthEnvironment = Record<string, string | undefined>;
export type OAuthFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const PROVIDER_DEFAULTS: Record<
  OAuthProviderName,
  Pick<
    OAuthProviderConfig,
    "authorizeUrl" | "tokenUrl" | "userInfoUrl" | "scopes"
  >
> = {
  github: {
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userInfoUrl: "https://api.github.com/user",
    scopes: ["read:user", "user:email"],
  },
  google: {
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userInfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scopes: ["openid", "email", "profile"],
  },
};

function providerPrefix(provider: OAuthProviderName): string {
  return provider.toUpperCase();
}

function configuredValue(
  env: OAuthEnvironment,
  provider: OAuthProviderName,
  name: string,
): string {
  const prefix = providerPrefix(provider);
  return (
    env[`${prefix}_OAUTH_${name}`]?.trim() ||
    env[`${prefix}_${name}`]?.trim() ||
    ""
  );
}

export function getOAuthProviderConfig(
  provider: OAuthProviderName,
  env: OAuthEnvironment = process.env,
): OAuthProviderConfig {
  const defaults = PROVIDER_DEFAULTS[provider];
  if (!defaults) {
    throw new Error(`Unsupported OAuth provider: ${provider}`);
  }
  const prefix = providerPrefix(provider);
  return {
    provider,
    clientId: configuredValue(env, provider, "CLIENT_ID"),
    secret:
      configuredValue(env, provider, "CLIENT_SECRET") ||
      configuredValue(env, provider, "SECRET"),
    authorizeUrl:
      env[`${prefix}_OAUTH_AUTHORIZE_URL`]?.trim() ||
      env[`${prefix}_AUTHORIZE_URL`]?.trim() ||
      defaults.authorizeUrl,
    tokenUrl:
      env[`${prefix}_OAUTH_TOKEN_URL`]?.trim() ||
      env[`${prefix}_TOKEN_URL`]?.trim() ||
      defaults.tokenUrl,
    userInfoUrl:
      env[`${prefix}_OAUTH_USER_INFO_URL`]?.trim() ||
      env[`${prefix}_USER_INFO_URL`]?.trim() ||
      defaults.userInfoUrl,
    scopes: defaults.scopes,
  };
}

export const oauthProviderConfig = getOAuthProviderConfig;

function requireConfigured(config: OAuthProviderConfig): void {
  const missing: string[] = [];
  if (!config.clientId) {
    missing.push("client ID");
  }
  if (!config.secret) {
    missing.push("client secret");
  }
  if (missing.length > 0) {
    throw new Error(
      `OAuth not configured for ${config.provider}: missing ${missing.join(" and ")}`,
    );
  }
}

export function buildAuthorizeUrl(
  config: OAuthProviderConfig,
  state: string,
  redirectUri: string,
): string {
  requireConfigured(config);
  if (!state) {
    throw new Error("OAuth state is required");
  }
  if (!redirectUri) {
    throw new Error("OAuth redirect URI is required");
  }

  const url = new URL(config.authorizeUrl);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", state);
  if (config.provider === "google") {
    url.searchParams.set("access_type", "online");
  }
  return url.toString();
}

function stringField(
  value: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) {
      return field.trim();
    }
    if (typeof field === "number" && Number.isFinite(field)) {
      return String(field);
    }
  }
  return "";
}

async function responseJson(
  response: Response,
  operation: string,
): Promise<Record<string, unknown>> {
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${operation} returned an invalid JSON response`);
  }
  if (!response.ok) {
    const detail =
      payload && typeof payload === "object"
        ? stringField(payload as Record<string, unknown>, "error_description", "error")
        : "";
    throw new Error(
      `${operation} failed (${response.status})${detail ? `: ${detail}` : ""}`,
    );
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${operation} returned an invalid response`);
  }
  return payload as Record<string, unknown>;
}

export async function exchangeCodeForProfile(
  config: OAuthProviderConfig,
  code: string,
  redirectUri: string,
  fetchImpl: OAuthFetch = globalThis.fetch,
): Promise<OAuthProfile> {
  requireConfigured(config);
  if (!code) {
    throw new Error("OAuth authorization code is required");
  }
  if (!redirectUri) {
    throw new Error("OAuth redirect URI is required");
  }

  const tokenResponse = await fetchImpl(config.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.secret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });
  const tokenPayload = await responseJson(tokenResponse, "OAuth token exchange");
  const accessToken = stringField(tokenPayload, "access_token");
  if (!accessToken) {
    throw new Error("OAuth token exchange returned no access token");
  }

  const profileResponse = await fetchImpl(config.userInfoUrl, {
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${accessToken}`,
      "User-Agent": "camelAI-agentOS",
    },
  });
  const profilePayload = await responseJson(
    profileResponse,
    "OAuth profile request",
  );
  const providerUserId = stringField(profilePayload, "sub", "id");
  const email = stringField(profilePayload, "email").toLowerCase();
  const name =
    stringField(profilePayload, "name", "login") ||
    (email ? email.split("@")[0] ?? email : "");
  if (!providerUserId || !email) {
    throw new Error("OAuth profile is missing a user ID or email address");
  }
  return { providerUserId, email, name };
}

export function createOAuthClient(
  provider: OAuthProviderName,
  options: { env?: OAuthEnvironment; fetch?: OAuthFetch } = {},
): {
  config: OAuthProviderConfig;
  buildAuthorizeUrl: (state: string, redirectUri: string) => string;
  exchangeCodeForProfile: (
    code: string,
    redirectUri: string,
  ) => Promise<OAuthProfile>;
} {
  const config = getOAuthProviderConfig(provider, options.env);
  return {
    config,
    buildAuthorizeUrl: (state, redirectUri) =>
      buildAuthorizeUrl(config, state, redirectUri),
    exchangeCodeForProfile: (code, redirectUri) =>
      exchangeCodeForProfile(config, code, redirectUri, options.fetch),
  };
}
