import { describe, expect, it } from "vitest";
import { canUseSuperuserAccess } from "../src/lib/auth.server";
import { getRemainingSessionCookieMaxAge } from "../src/lib/cookies.server";
import { validateSessionIdentityMapsToOrg } from "../workers/main/src/helpers/proxy-auth-providers";
import {
  buildOrgSsoPublicConfig,
  getSafeSsoRedirect,
  isEmailAllowedForOrgSso,
  normalizeSsoEmailDomains,
  normalizeSsoIssuer,
} from "../workers/main/src/org-sso";
import {
  createSsoBrowserBinding,
  createSsoBrowserBindingCookie,
  getSsoBrowserBindingCookie,
  hashSsoBrowserBinding,
} from "../src/lib/org-sso-browser.server";
import {
  createSignedEnterpriseSsoLink,
  createSignedEnterpriseSsoState,
  createSignedSession,
  parseSignedEnterpriseSsoLink,
  parseSignedEnterpriseSsoState,
  parseSignedSession,
} from "../workers/main/src/signed-session";

describe("organization OIDC SSO", () => {
  it("normalizes and validates tenant constraints", () => {
    expect(normalizeSsoIssuer("https://idp.example.com/")).toBe("https://idp.example.com/");
    expect(normalizeSsoIssuer("https://idp.example.com")).toBe("https://idp.example.com");
    expect(normalizeSsoEmailDomains(" @Example.com,example.com, staff.example.com ")).toEqual([
      "example.com",
      "staff.example.com",
    ]);
    expect(isEmailAllowedForOrgSso("PERSON@EXAMPLE.COM", ["example.com"])).toBe(true);
    expect(isEmailAllowedForOrgSso("person@notexample.com", ["example.com"])).toBe(false);
    expect(normalizeSsoEmailDomains("")).toEqual([]);
    expect(isEmailAllowedForOrgSso("person@anywhere.example", [])).toBe(true);
    expect(() => normalizeSsoEmailDomains("localhost")).toThrow("Invalid email domain");
  });

  it("rejects unsafe issuer URLs", () => {
    for (const issuer of [
      "http://idp.example.com",
      "https://localhost",
      "https://127.0.0.1",
      "https://10.1.2.3",
      "https://169.254.169.254",
      "https://user:pass@idp.example.com",
      "https://idp.example.com?tenant=one",
    ]) {
      expect(() => normalizeSsoIssuer(issuer)).toThrow();
    }
  });

  it("accepts only same-origin relative post-login redirects", () => {
    expect(getSafeSsoRedirect("/chat/one?x=1")).toBe("/chat/one?x=1");
    for (const unsafe of ["https://evil.example", "//evil.example", "/\\evil.example", "\\evil.example", "/%5cevil.example", "/%2f%2fevil.example"] ) {
      expect(getSafeSsoRedirect(unsafe)).toBe("/");
    }
  });

  it("never exposes the encrypted client secret in public configuration", () => {
    const publicConfig = buildOrgSsoPublicConfig({
      enabled: true,
      connection_id: "connection",
      protocol: "oidc",
      issuer: "https://idp.example.com",
      client_id: "client",
      client_secret_encrypted: "secret-ciphertext",
      client_auth_method: "client_secret_post",
      email_claim: "email",
      email_domains: ["example.com"],
      jit_provisioning_enabled: false,
      config_version: 2,
      session_ttl_seconds: 28_800,
      updated_at: 1,
      updated_by: "admin",
    }, "https://app.camelai.dev", "acme");
    expect(publicConfig).toMatchObject({
      has_client_secret: true,
      login_url: "https://app.camelai.dev/sso/acme",
      callback_url: "https://app.camelai.dev/api/auth/enterprise-oidc/callback",
    });
    expect(JSON.stringify(publicConfig)).not.toContain("secret-ciphertext");
  });

  it("binds a login transaction to the initiating browser", async () => {
    const transactionId = "tx-1";
    const binding = createSsoBrowserBinding();
    expect(binding.length).toBeGreaterThanOrEqual(40);
    const cookie = createSsoBrowserBindingCookie(transactionId, binding, 600);
    const request = new Request("https://app.example/api/auth/enterprise-oidc/callback", {
      headers: { Cookie: cookie.split(";", 1)[0]! },
    });
    expect(getSsoBrowserBindingCookie(request, transactionId)).toBe(binding);
    expect(await hashSsoBrowserBinding(binding)).not.toBe(await hashSsoBrowserBinding(`${binding}x`));
  });

  it("requires a signed, user-bound intent before account linking", async () => {
    const link = await createSignedEnterpriseSsoLink("secret", {
      org_id: "org-a",
      user_id: "user-a",
      created_at: Date.now(),
    });
    await expect(parseSignedEnterpriseSsoLink("secret", link)).resolves.toMatchObject({
      org_id: "org-a",
      user_id: "user-a",
    });
    await expect(parseSignedEnterpriseSsoLink("wrong", link)).resolves.toBeNull();
  });

  it("signs short-lived, tenant-bound, replay-keyed state", async () => {
    const state = await createSignedEnterpriseSsoState("secret", {
      org_id: "org-a",
      transaction_id: "tx-a",
      connection_id: "connection-a",
      config_version: 3,
      purpose: "test",
      created_at: Date.now(),
    });
    await expect(parseSignedEnterpriseSsoState("secret", state)).resolves.toMatchObject({
      org_id: "org-a",
      transaction_id: "tx-a",
      config_version: 3,
      purpose: "test",
    });
    await expect(parseSignedEnterpriseSsoState("wrong", state)).resolves.toBeNull();
  });

  it("keeps reissued cookie lifetime within the signed absolute expiry", () => {
    const expiresAt = Date.now() + 90_000;
    const maxAge = getRemainingSessionCookieMaxAge({ expires_at: expiresAt });
    expect(maxAge).toBeGreaterThanOrEqual(89);
    expect(maxAge).toBeLessThanOrEqual(90);
    expect(getRemainingSessionCookieMaxAge({})).toBeUndefined();
  });

  it("never grants global superuser privileges to an enterprise SSO session", () => {
    const user = { is_superuser: true, email_verified_at: Date.now() } as never;
    expect(canUseSuperuserAccess({ user, session: { auth_source: "enterprise_oidc" } as never })).toBe(false);
    expect(canUseSuperuserAccess({ user, session: { auth_source: null } as never })).toBe(true);
    expect(
      canUseSuperuserAccess({
        user: { is_superuser: true, email_verified_at: null } as never,
        session: { auth_source: null } as never,
      }),
    ).toBe(false);
  });

  it("rejects an enterprise SSO session targeting another org", async () => {
    await expect(validateSessionIdentityMapsToOrg(
      new Request("https://app.example"),
      {} as never,
      {
        auth_source: "enterprise_oidc",
        user_id: "user",
        user_email: "person@example.com",
        org_id: "org-a",
        sso_connection_id: "connection",
        sso_config_version: 1,
      },
      "org-b",
    )).resolves.toBe("invalid");
  });

  it("rejects an enterprise SSO session after its absolute expiry", async () => {
    const token = await createSignedSession("test-secret", {
      user_id: "user",
      org_id: "org",
      workspace_id: null,
      created_at: Date.now(),
      expires_at: Date.now() - 1,
      auth_source: "enterprise_oidc",
      sso_connection_id: "connection",
      sso_config_version: 1,
    });
    await expect(parseSignedSession("test-secret", token)).resolves.toBeNull();
  });
});
