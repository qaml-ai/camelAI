import * as oidc from "openid-client";
import type { Organization, User } from "@/types";
import type { AuthEnv, SessionData } from "./auth-helpers";
import {
  createSession,
  createTenantScopedUserFromEnterpriseSso,
  getUserByEmail,
} from "./auth-do";
import { decryptCredentials } from "./integration-crypto";
import { isOrgBanned, isUserBanned } from "../../workers/main/src/ban-list";
import {
  isEmailAllowedForOrgSso,
  normalizeSsoIssuer,
  type OrgSsoConfig,
  type OidcClientAuthMethod,
} from "../../workers/main/src/org-sso";
import { ENTERPRISE_OIDC_AUTH_SOURCE } from "../../workers/main/src/signed-session";
import { isSuperuserEmail } from "../../workers/main/src/identity/superuser";

const OIDC_HTTP_TIMEOUT_MS = 10_000;
const MAX_OIDC_RESPONSE_BYTES = 1_000_000;

class OidcProviderValidationError extends Error {
  override name = "OidcProviderValidationError";
}

export interface OrgSsoSessionResult {
  session: SessionData;
  signedToken: string;
}

export interface ValidatedOrgSsoIdentity {
  subject: string;
  email: string;
  name: string | null;
  domain: string;
  emailVerified: boolean | null;
  hostedDomain: string | null;
  eligibleForAutoLink: boolean;
}

interface OrgSsoIdentityLookup {
  getMember(userId: string): Promise<unknown>;
  claimSsoInvitedIdentity?(
    connectionId: string,
    issuer: string,
    subject: string,
    email: string,
  ): Promise<OrgSsoIdentityMapping | null>;
  claimSsoJitIdentity?(
    connectionId: string,
    issuer: string,
    subject: string,
    email: string,
  ): Promise<OrgSsoIdentityMapping | null>;
}

interface OrgSsoIdentityMapping {
  userId: string;
  email: string;
  tenantScoped: boolean;
  membershipRevoked: boolean;
}

function oidcClientAuthentication(
  method: OidcClientAuthMethod,
  secret: string,
) {
  return method === "client_secret_basic"
    ? oidc.ClientSecretBasic(secret)
    : oidc.ClientSecretPost(secret);
}

const boundedOidcFetch: oidc.CustomFetch = async (url, options) => {
  const response = await fetch(url, {
    method: options.method,
    headers: options.headers,
    body: options.body as BodyInit,
    // Cloudflare Workers does not implement redirect: "error". Manual mode
    // lets us preserve the same deny-redirect policy without failing every
    // provider request before it reaches the network.
    redirect: "manual",
    signal: AbortSignal.timeout(OIDC_HTTP_TIMEOUT_MS),
  });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new OidcProviderValidationError(
      "OIDC provider redirects are not allowed",
    );
  }
  const length = Number(response.headers.get("Content-Length") ?? "0");
  if (Number.isFinite(length) && length > MAX_OIDC_RESPONSE_BYTES) {
    await response.body?.cancel();
    throw new OidcProviderValidationError(
      "OIDC provider response is too large",
    );
  }
  if (!response.body) return response;
  const reader = response.body.getReader();
  let received = 0;
  const boundedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await reader.read();
      if (chunk.done) {
        controller.close();
        return;
      }
      received += chunk.value.byteLength;
      if (received > MAX_OIDC_RESPONSE_BYTES) {
        await reader.cancel();
        controller.error(
          new OidcProviderValidationError(
            "OIDC provider response is too large",
          ),
        );
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return new Response(boundedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

function validateProviderEndpoint(value: unknown, label: string): void {
  if (typeof value !== "string") {
    throw new OidcProviderValidationError(`OIDC provider is missing ${label}`);
  }
  normalizeSsoIssuer(value);
}

interface OidcErrorDetail {
  name: string;
  message: string;
}

function getOidcErrorChain(error: unknown): OidcErrorDetail[] {
  const details: OidcErrorDetail[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (
    current &&
    typeof current === "object" &&
    !seen.has(current) &&
    details.length < 5
  ) {
    seen.add(current);
    const record = current as {
      name?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    details.push({
      name: typeof record.name === "string" ? record.name : "UnknownError",
      message:
        typeof record.message === "string"
          ? record.message
          : "Unknown OIDC discovery error",
    });
    current = record.cause;
  }
  return details;
}

export function getOidcDiscoveryErrorDiagnostic(error: unknown): {
  errorName: string;
  errorMessage: string;
  causeName?: string;
  causeMessage?: string;
} {
  const chain = getOidcErrorChain(error);
  const top = chain[0] ?? {
    name: "UnknownError",
    message: "Unknown OIDC discovery error",
  };
  const cause = chain.at(-1);
  return {
    errorName: top.name,
    errorMessage: top.message.slice(0, 500),
    ...(cause && cause !== top
      ? { causeName: cause.name, causeMessage: cause.message.slice(0, 500) }
      : {}),
  };
}

export function getOidcDiscoveryErrorMessage(error: unknown): string {
  const chain = getOidcErrorChain(error);
  const providerError = chain.find(
    ({ name }) => name === "OidcProviderValidationError",
  );
  if (providerError) return providerError.message;
  if (
    chain.some(
      ({ name, message }) =>
        name === "TimeoutError" || /timed?\s*out/i.test(message),
    )
  ) {
    return "The OIDC discovery request timed out";
  }
  if (
    chain.some(
      ({ name, message }) =>
        name === "TypeError" || /fetch failed|network error/i.test(message),
    )
  ) {
    return "Could not reach the OIDC issuer; verify that its discovery endpoint is publicly reachable";
  }
  return "The issuer did not return a valid OpenID Connect discovery document";
}

export function getOidcConnectionTestErrorMessage(error: unknown): string {
  if (error instanceof oidc.AuthorizationResponseError) {
    return error.error === "access_denied"
      ? "The provider sign-in was cancelled or denied"
      : "The provider rejected the authorization request";
  }
  if (error instanceof oidc.ResponseBodyError) {
    if (error.error === "invalid_client") {
      return "The token endpoint rejected the client credentials; verify the client ID, client secret, and authentication method";
    }
    if (error.error === "invalid_grant") {
      return "The token endpoint rejected the authorization code; verify the registered callback URL";
    }
    return `The token endpoint rejected the connection test (HTTP ${error.status})`;
  }
  const chain = getOidcErrorChain(error);
  if (chain.some(({ name }) => name === "TimeoutError")) {
    return "The provider timed out during the connection test";
  }
  if (
    chain.some(
      ({ name, message }) =>
        name === "TypeError" || /fetch failed|network error/i.test(message),
    )
  ) {
    return "The provider could not be reached during the connection test";
  }
  return "The provider login or token exchange could not be verified";
}

export async function discoverOidcConfiguration(
  config: Pick<OrgSsoConfig, "issuer" | "client_id" | "client_auth_method">,
  clientSecret: string,
): Promise<oidc.Configuration> {
  const issuer = normalizeSsoIssuer(config.issuer);
  const resolved = await oidc.discovery(
    new URL(issuer),
    config.client_id,
    { client_secret: clientSecret, redirect_uris: [] },
    oidcClientAuthentication(config.client_auth_method, clientSecret),
    { [oidc.customFetch]: boundedOidcFetch },
  );
  resolved.timeout = Math.ceil(OIDC_HTTP_TIMEOUT_MS / 1000);
  // Verify ID-token signatures even when tokens arrive directly from the TLS
  // token endpoint; tenant identity must never rely on transport alone.
  oidc.enableNonRepudiationChecks(resolved);
  const metadata = resolved.serverMetadata();
  if (normalizeSsoIssuer(metadata.issuer) !== issuer) {
    throw new OidcProviderValidationError(
      "OIDC discovery issuer does not match the configured issuer",
    );
  }
  validateProviderEndpoint(
    metadata.authorization_endpoint,
    "authorization_endpoint",
  );
  validateProviderEndpoint(metadata.token_endpoint, "token_endpoint");
  validateProviderEndpoint(metadata.jwks_uri, "jwks_uri");
  if (!metadata.response_types_supported?.includes("code")) {
    throw new OidcProviderValidationError(
      "OIDC provider does not support the authorization code flow",
    );
  }
  if (!metadata.code_challenge_methods_supported?.includes("S256")) {
    throw new OidcProviderValidationError(
      "OIDC provider does not advertise PKCE S256 support",
    );
  }
  if (
    !metadata.token_endpoint_auth_methods_supported?.includes(
      config.client_auth_method,
    )
  ) {
    throw new OidcProviderValidationError(
      "OIDC provider does not support the selected client authentication method",
    );
  }
  const signingAlgorithms =
    metadata.id_token_signing_alg_values_supported ?? [];
  if (
    !signingAlgorithms.some((algorithm) =>
      /^(?:RS|PS|ES)\d+$|^EdDSA$/.test(algorithm),
    )
  ) {
    throw new OidcProviderValidationError(
      "OIDC provider does not advertise an asymmetric ID-token signing algorithm",
    );
  }
  return resolved;
}

export async function validateOidcJwks(
  configuration: oidc.Configuration,
): Promise<void> {
  const jwksUri = configuration.serverMetadata().jwks_uri;
  validateProviderEndpoint(jwksUri, "jwks_uri");
  if (typeof jwksUri !== "string") {
    throw new OidcProviderValidationError("OIDC provider is missing jwks_uri");
  }
  const response = await boundedOidcFetch(jwksUri, {
    method: "GET",
    headers: { Accept: "application/json" },
    body: undefined,
    redirect: "manual",
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new OidcProviderValidationError(
      `OIDC provider JWKS endpoint returned HTTP ${response.status}`,
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new OidcProviderValidationError(
      "OIDC provider JWKS endpoint did not return JSON",
    );
  }
  const keys =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { keys?: unknown }).keys)
      ? (body as { keys: unknown[] }).keys
      : null;
  if (!keys?.length || !keys.every((key) => key && typeof key === "object")) {
    throw new OidcProviderValidationError(
      "OIDC provider JWKS endpoint returned no signing keys",
    );
  }
}

export async function getOidcConfiguration(
  config: OrgSsoConfig,
  encryptionKey: string,
): Promise<oidc.Configuration> {
  const credentials = await decryptCredentials<{ client_secret: string }>(
    config.client_secret_encrypted,
    encryptionKey,
  );
  if (!credentials.client_secret)
    throw new Error("OIDC client secret is missing");
  return discoverOidcConfiguration(config, credentials.client_secret);
}

export async function exchangeOidcCode(input: {
  request: Request;
  callbackUrl: string;
  expectedState: string;
  pkceVerifier: string;
  expectedNonce: string;
  oidcConfig: oidc.Configuration;
}) {
  const callback = new URL(input.callbackUrl);
  callback.search = new URL(input.request.url).search;
  const tokens = await oidc.authorizationCodeGrant(input.oidcConfig, callback, {
    pkceCodeVerifier: input.pkceVerifier,
    expectedState: input.expectedState,
    expectedNonce: input.expectedNonce,
    idTokenExpected: true,
  });
  const claims = tokens.claims();
  if (!claims) throw new Error("OIDC provider did not return an ID token");
  return claims;
}

function booleanClaim(value: unknown): boolean | null {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return null;
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

function isValidSsoSubject(value: string): boolean {
  return (
    value.length >= 1 &&
    value.length <= 512 &&
    !hasControlCharacter(value)
  );
}

function parseSsoEmail(value: unknown): {
  email: string;
  domain: string;
} | null {
  if (typeof value !== "string" || value !== value.trim()) return null;
  if (value.length > 254 || /\s/.test(value) || hasControlCharacter(value)) {
    return null;
  }
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [rawLocal, rawDomain] = parts;
  if (!rawLocal || rawLocal.length > 64 || !rawDomain) return null;
  const domain = rawDomain.toLowerCase();
  if (
    domain.length > 253 ||
    !domain
      .split(".")
      .every(
        (label) =>
          label.length >= 1 &&
          label.length <= 63 &&
          /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
      )
  ) {
    return null;
  }
  return { email: `${rawLocal.toLowerCase()}@${domain}`, domain };
}

export function validateOrgSsoIdentityClaims(
  claims: Record<string, unknown>,
  config: Pick<OrgSsoConfig, "issuer" | "email_claim" | "email_domains">,
): ValidatedOrgSsoIdentity {
  const subject = typeof claims.sub === "string" ? claims.sub : "";
  const claimValue = claims[config.email_claim];
  const parsedEmail = parseSsoEmail(claimValue);
  const email = parsedEmail?.email ?? "";
  const domain = parsedEmail?.domain ?? "";
  if (
    !isValidSsoSubject(subject) ||
    !parsedEmail ||
    !isEmailAllowedForOrgSso(email, config.email_domains)
  ) {
    throw new Response(
      "Enterprise identity is not allowed for this organization",
      { status: 403 },
    );
  }

  const emailVerified = booleanClaim(claims.email_verified);
  const name =
    typeof claims.name === "string" && claims.name.trim()
      ? claims.name.trim().slice(0, 200)
      : null;
  const hostedDomain =
    typeof claims.hd === "string" && claims.hd.trim()
      ? claims.hd.trim().toLowerCase()
      : null;
  const isGoogle =
    normalizeSsoIssuer(config.issuer) === "https://accounts.google.com";
  if (
    isGoogle &&
    (emailVerified !== true ||
      !hostedDomain ||
      hostedDomain !== domain ||
      (config.email_domains.length > 0 &&
        !config.email_domains.includes(hostedDomain)))
  ) {
    throw new Response(
      "Google Workspace did not verify this email and hosted domain for the organization",
      { status: 403 },
    );
  }

  return {
    subject,
    email,
    name,
    domain,
    emailVerified,
    hostedDomain,
    // The organization owner explicitly selected and tested this issuer, so a
    // signed identity from it is authoritative within this organization.
    eligibleForAutoLink: true,
  };
}

export async function resolveOrgSsoUser(input: {
  authEnv: AuthEnv;
  orgStub: OrgSsoIdentityLookup;
  identity: ValidatedOrgSsoIdentity;
  mappedUserId: string | null;
  mappedTenantScoped?: boolean;
  mappedMembershipRevoked?: boolean;
  connectionId?: string;
  issuer?: string;
  linkUserId: string | null;
  jitProvisioningEnabled?: boolean;
}): Promise<{ userId: string; user: User; tenantScoped: boolean } | null> {
  const { authEnv, identity } = input;
  let invitedIdentity: OrgSsoIdentityMapping | null = null;
  if (input.mappedMembershipRevoked) {
    if (
      input.connectionId &&
      input.issuer &&
      input.orgStub.claimSsoInvitedIdentity &&
      !isSuperuserEmail(identity.email, authEnv.SUPERUSER_EMAILS)
    ) {
      invitedIdentity = await input.orgStub.claimSsoInvitedIdentity(
        input.connectionId,
        input.issuer,
        identity.subject,
        identity.email,
      );
    }
    if (!invitedIdentity) {
      throw new Response(
        "Enterprise SSO access was revoked for this organization",
        { status: 403 },
      );
    }
  }
  const directlyMappedUserId =
    invitedIdentity?.userId ?? input.mappedUserId ?? input.linkUserId;
  if (directlyMappedUserId) {
    const tenantScoped =
      invitedIdentity?.tenantScoped ?? (input.mappedTenantScoped === true);
    if (tenantScoped) {
      const existingProfile = await authEnv.USER.get(
        authEnv.USER.idFromName(directlyMappedUserId),
      ).getProfile();
      if (!existingProfile) {
        if (
          !invitedIdentity &&
          !input.jitProvisioningEnabled &&
          !(await input.orgStub.getMember(directlyMappedUserId))
        ) {
          return null;
        }
        if (isSuperuserEmail(identity.email, authEnv.SUPERUSER_EMAILS)) {
          throw new Response("Superuser identities cannot use enterprise SSO", {
            status: 403,
          });
        }
        await createTenantScopedUserFromEnterpriseSso(
          authEnv,
          directlyMappedUserId,
          identity.email,
          identity.name,
        );
      }
    }
    const mapped = await getMappedUser(
      authEnv,
      directlyMappedUserId,
      identity.email,
    );
    return { ...mapped, tenantScoped };
  }
  if (!identity.eligibleForAutoLink) return null;

  let account = await getUserByEmail(authEnv, identity.email);
  if (account) {
    const member = await input.orgStub.getMember(account.userId);
    // A configured IdP may authenticate an existing org member, but it must
    // not annex an unrelated global account that happens to use the asserted
    // email. JIT creates a separate organization-scoped principal instead.
    if (member) {
      const mapped = await getMappedUser(
        authEnv,
        account.userId,
        identity.email,
      );
      return { ...mapped, tenantScoped: false };
    }
    account = null;
  }

  if (isSuperuserEmail(identity.email, authEnv.SUPERUSER_EMAILS)) {
    throw new Response("Superuser identities cannot use enterprise SSO", {
      status: 403,
    });
  }
  if (
    !input.connectionId ||
    !input.issuer ||
    !input.orgStub.claimSsoInvitedIdentity
  ) {
    if (!input.jitProvisioningEnabled) return null;
  } else {
    const claim = await input.orgStub.claimSsoInvitedIdentity(
      input.connectionId,
      input.issuer,
      identity.subject,
      identity.email,
    );
    if (claim) {
      if (claim.tenantScoped) {
        await createTenantScopedUserFromEnterpriseSso(
          authEnv,
          claim.userId,
          identity.email,
          identity.name,
        );
      }
      const mapped = await getMappedUser(authEnv, claim.userId, identity.email);
      return { ...mapped, tenantScoped: claim.tenantScoped };
    }
  }

  if (!input.jitProvisioningEnabled) return null;
  if (
    !input.connectionId ||
    !input.issuer ||
    !input.orgStub.claimSsoJitIdentity
  ) {
    throw new Error("Enterprise SSO tenant identity claiming is unavailable");
  }
  const claim = await input.orgStub.claimSsoJitIdentity(
    input.connectionId,
    input.issuer,
    identity.subject,
    identity.email,
  );
  if (!claim) {
    throw new Response(
      "This email is already bound to a different enterprise identity",
      { status: 403 },
    );
  }
  if (!claim.tenantScoped) {
    // A non-tenant identity can only be reached through the existing-account
    // resolution path above. Never turn a global identity into a JIT account.
    const mapped = await getMappedUser(authEnv, claim.userId, identity.email);
    return { ...mapped, tenantScoped: false };
  }
  account = await createTenantScopedUserFromEnterpriseSso(
    authEnv,
    claim.userId,
    identity.email,
    identity.name,
  );
  const mapped = await getMappedUser(authEnv, account.userId, identity.email);
  return { ...mapped, tenantScoped: true };
}

export async function completeOrgSsoLogin(input: {
  request: Request;
  callbackUrl: string;
  expectedState: string;
  transaction: {
    pkce_verifier: string;
    nonce: string;
    link_user_id: string | null;
  };
  authEnv: AuthEnv;
  org: Organization;
  config: OrgSsoConfig;
  encryptionKey: string;
}): Promise<OrgSsoSessionResult> {
  const { request, authEnv, org, config } = input;
  if (org.billing_status !== "enterprise" || !config.enabled) {
    throw new Response("SSO is not available for this organization", {
      status: 403,
    });
  }
  const oidcConfig = await getOidcConfiguration(config, input.encryptionKey);
  let claims;
  try {
    claims = await exchangeOidcCode({
      request,
      callbackUrl: input.callbackUrl,
      expectedState: input.expectedState,
      pkceVerifier: input.transaction.pkce_verifier,
      expectedNonce: input.transaction.nonce,
      oidcConfig,
    });
  } catch (error) {
    console.warn("[enterprise-oidc] authorization code exchange failed", {
      orgId: org.id,
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw new Response("Enterprise sign-in could not be verified", {
      status: 403,
    });
  }

  const identity = validateOrgSsoIdentityClaims(claims, config);
  const { subject, email } = identity;
  if (await isOrgBanned(authEnv.APP_KV, { orgId: org.id })) {
    throw new Response("Organization is blocked", { status: 403 });
  }
  if (await isUserBanned(authEnv.APP_KV, { email })) {
    throw new Response("Account is blocked", { status: 403 });
  }

  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.id));
  const subjectIdentity = await orgStub.getSsoIdentity(
    config.connection_id,
    config.issuer,
    subject,
  );
  const mappedIdentity = subjectIdentity;
  if (
    !mappedIdentity &&
    (await orgStub.getSsoIdentityByEmail(
      config.connection_id,
      config.issuer,
      email,
    ))
  ) {
    throw new Response(
      "This email is already bound to a different enterprise identity",
      { status: 403 },
    );
  }
  if (
    input.transaction.link_user_id &&
    mappedIdentity &&
    mappedIdentity.userId !== input.transaction.link_user_id
  ) {
    throw new Response(
      "This enterprise identity is already linked to another account",
      { status: 403 },
    );
  }
  const resolvedUser = await resolveOrgSsoUser({
    authEnv,
    orgStub,
    identity,
    mappedUserId: mappedIdentity?.userId ?? null,
    mappedTenantScoped: mappedIdentity?.tenantScoped ?? false,
    mappedMembershipRevoked: mappedIdentity?.membershipRevoked ?? false,
    connectionId: config.connection_id,
    issuer: config.issuer,
    linkUserId: input.transaction.link_user_id,
    jitProvisioningEnabled: config.jit_provisioning_enabled,
  });
  if (!resolvedUser) {
    throw new Response(
      config.jit_provisioning_enabled
        ? "Enterprise SSO could not provision this account"
        : "No organization member or active invitation matches this enterprise identity. Ask an organization administrator to invite this exact email address or allow uninvited SSO users.",
      { status: 403 },
    );
  }
  const { userId, user } = resolvedUser;
  const workspaceId = await ensureOrgMembership(authEnv, org, userId, {
    jitProvisioningEnabled: config.jit_provisioning_enabled,
  });
  const boundUserId = await orgStub.bindSsoIdentity(
    config.connection_id,
    config.issuer,
    subject,
    userId,
    email,
    input.transaction.link_user_id === userId,
  );
  if (boundUserId !== userId) {
    throw new Response(
      "This email is already bound to a different enterprise identity",
      { status: 403 },
    );
  }
  const expiresAt = Date.now() + config.session_ttl_seconds * 1000;
  const { signedToken, sessionData } = await createSession(
    authEnv,
    userId,
    org.id,
    workspaceId,
    { name: user.name, email: user.email },
    {
      authSource: ENTERPRISE_OIDC_AUTH_SOURCE,
      expiresAt,
      ssoConnectionId: config.connection_id,
      ssoConfigVersion: config.config_version,
    },
  );
  return { signedToken, session: sessionData };
}

async function getMappedUser(
  authEnv: AuthEnv,
  userId: string,
  assertedEmail: string,
): Promise<{ userId: string; user: User }> {
  const user = await authEnv.USER.get(
    authEnv.USER.idFromName(userId),
  ).getProfile();
  if (
    !user ||
    user.email.toLowerCase() !== assertedEmail ||
    user.is_superuser
  ) {
    throw new Response("Enterprise identity mapping is invalid", {
      status: 403,
    });
  }
  if (await isUserBanned(authEnv.APP_KV, { userId, email: assertedEmail })) {
    throw new Response("Account is blocked", { status: 403 });
  }
  return { userId, user };
}

export async function ensureOrgMembership(
  authEnv: AuthEnv,
  org: Organization,
  userId: string,
  options: { jitProvisioningEnabled?: boolean } = {},
): Promise<string | null> {
  const orgStub = authEnv.ORG.get(authEnv.ORG.idFromName(org.id));
  const userStub = authEnv.USER.get(authEnv.USER.idFromName(userId));
  let member = await orgStub.getMember(userId);
  if (!member) {
    if (!options.jitProvisioningEnabled) {
      throw new Response("SSO membership has been removed", { status: 403 });
    }

    const workspaces = (await orgStub.getWorkspaces()).filter(
      (workspace) => !workspace.archived,
    );
    const workspaceId = workspaces[0]?.id ?? null;
    await orgStub.addMember(userId, "member", "enterprise-sso-jit", {
      workspaceAccessDefault: "none",
      initialWorkspaceId: workspaceId,
    });
    member = await orgStub.getMember(userId);
    if (!member) {
      throw new Error("Enterprise SSO membership provisioning failed");
    }
    if (!(await userStub.hasOrg(org.id))) {
      await userStub.addOrg(org.id, "member", workspaceId);
    } else {
      await userStub.updateOrgRole(org.id, "member");
    }
    await userStub.setOrphaned(false);
    if (workspaceId) {
      const workspaceStub = authEnv.WORKSPACE.get(
        authEnv.WORKSPACE.idFromName(workspaceId),
      );
      await workspaceStub.setMemberAccess(userId, "full", "enterprise-sso-jit");
      await userStub.setOrgLastWorkspace(org.id, workspaceId);
    }
    return workspaceId;
  }
  const memberRole = member.role;
  const [activeWorkspaces, allWorkspaces, userOrgs] = await Promise.all([
    orgStub.listUserWorkspaces(userId),
    orgStub.getWorkspaces(),
    userStub.getOrgs(),
  ]);
  const rememberedWorkspace = userOrgs.find(
    (entry) => entry.org_id === org.id,
  )?.last_workspace_id;
  const workspaceId =
    activeWorkspaces.find((workspace) => workspace.id === rememberedWorkspace)
      ?.id ??
    activeWorkspaces[0]?.id ??
    null;

  if (!(await userStub.hasOrg(org.id))) {
    await userStub.addOrg(org.id, memberRole, workspaceId);
  } else {
    await userStub.updateOrgRole(org.id, memberRole);
  }
  await Promise.all(
    allWorkspaces
      .filter((workspace) => !workspace.archived)
      .map(async (workspace) => {
        const accessLevel = await orgStub.getWorkspaceAccess(
          workspace.id,
          userId,
        );
        const workspaceStub = authEnv.WORKSPACE.get(
          authEnv.WORKSPACE.idFromName(workspace.id),
        );
        await workspaceStub.setMemberAccess(
          userId,
          accessLevel,
          "enterprise-sso-jit",
        );
      }),
  );
  if (workspaceId) {
    await userStub.setOrgLastWorkspace(org.id, workspaceId);
  }
  return workspaceId;
}
