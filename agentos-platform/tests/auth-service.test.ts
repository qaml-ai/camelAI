import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AuthService } from "../src/server/auth/service.ts";
import {
  serializeSessionCookie,
  SessionService,
} from "../src/server/auth/session.ts";
import { createAuthHttpHandler } from "../src/server/http/api.ts";
import { createPlatform, type Platform } from "../src/server/platform/index.ts";

const tempDirs: string[] = [];

function createServices(
  proxyAuthMode: "off" | "cloudflare-access" | "pomerium" = "off",
): {
  platform: Platform;
  sessions: SessionService;
  auth: AuthService;
} {
  const dataDir = mkdtempSync(join(tmpdir(), "agentos-auth-service-"));
  tempDirs.push(dataDir);
  const platform = createPlatform({ dataDir });
  const sessions = new SessionService(platform.store);
  const auth = new AuthService(platform.identity, sessions, { proxyAuthMode });
  return { platform, sessions, auth };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("AuthService", () => {
  it("registers a complete tenant and logs the user in by password", async () => {
    const { platform, auth } = createServices();
    const registration = await auth.registerPassword({
      email: "New.User@example.com",
      password: "a strong test password",
      name: "New User",
    });
    const user = platform.identity.getUser(registration.userId);

    expect(registration.provider).toBe("password");
    expect(user).toEqual(
      expect.objectContaining({
        email: "new.user@example.com",
        name: "New User",
        orgId: registration.orgId,
      }),
    );
    expect(platform.store.listByPrefix("workspace:")).toHaveLength(1);
    expect(platform.identity.getPasswordHash(registration.userId)).toMatch(
      /^scrypt\$/,
    );

    const login = await auth.loginPassword({
      email: "new.user@example.com",
      password: "a strong test password",
    });
    expect(login.userId).toBe(registration.userId);
    expect(
      auth.requireSession(serializeSessionCookie(login.sessionId)).user,
    ).toEqual(user);
  });

  it("rejects duplicate registration and invalid credentials", async () => {
    const { auth } = createServices();
    const input = {
      email: "user@example.com",
      password: "password one",
      name: "User",
    };
    await auth.registerPassword(input);
    await expect(auth.registerPassword(input)).rejects.toThrow(/already exists/);
    await expect(
      auth.loginPassword({
        email: input.email,
        password: "wrong password",
      }),
    ).rejects.toThrow("Invalid email or password");
  });

  it("finds or creates users from proxy and OAuth identities", () => {
    const { platform, auth } = createServices("pomerium");
    const proxySession = auth.loginFromProxy(
      new Headers({
        "X-Pomerium-Claim-Email": "external@example.com",
        "X-Pomerium-Claim-Name": "External User",
      }),
    );
    const oauthSession = auth.loginFromOAuthProfile({
      providerUserId: "provider-123",
      email: "external@example.com",
      name: "External User",
    });

    expect(proxySession.provider).toBe("proxy");
    expect(oauthSession.provider).toBe("oauth");
    expect(oauthSession.userId).toBe(proxySession.userId);
    expect(platform.store.listByPrefix("user:")).toHaveLength(1);
    expect(platform.store.listByPrefix("org:")).toHaveLength(1);
  });

  it("rejects missing and revoked sessions", async () => {
    const { auth, sessions } = createServices();
    expect(() => auth.requireSession(null)).toThrow("Authentication required");
    const session = await auth.registerPassword({
      email: "user@example.com",
      password: "password",
      name: "User",
    });
    sessions.revokeSession(session.sessionId);
    expect(() =>
      auth.requireSession(serializeSessionCookie(session.sessionId)),
    ).toThrow("Authentication required");
  });

  it("serves register, me, and logout through the HTTP API", async () => {
    const { platform } = createServices();
    const handler = createAuthHttpHandler({ platform });
    const registration = await handler(
      new Request("http://localhost/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "http@example.com",
          password: "http password",
          name: "HTTP User",
        }),
      }),
    );
    expect(registration.status).toBe(201);
    const cookie = registration.headers.get("set-cookie");
    expect(cookie).toContain("camelai_session=");

    const me = await handler(
      new Request("http://localhost/api/auth/me", {
        headers: { Cookie: cookie ?? "" },
      }),
    );
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual(
      expect.objectContaining({
        user: expect.objectContaining({ email: "http@example.com" }),
      }),
    );

    const logout = await handler(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { Cookie: cookie ?? "" },
      }),
    );
    expect(logout.status).toBe(200);
    expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
