import type {
  IdentityService,
  User,
} from "../platform/identity.ts";
import type { OAuthProfile } from "./oauth.ts";
import { hashPassword, verifyPassword } from "./password.ts";
import {
  resolveProxyAuth,
  type ProxyAuthHeaders,
  type ProxyAuthMode,
  type ProxyIdentity,
} from "./proxy-auth.ts";
import {
  parseSessionCookie,
  type SessionRecord,
  type SessionService,
} from "./session.ts";

export type AuthServiceOptions = {
  proxyAuthMode?: ProxyAuthMode;
};

export type RequiredSession = {
  session: SessionRecord;
  user: User;
};

function normalizeEmail(email: string): string {
  const normalized = email?.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) {
    throw new Error("A valid email address is required");
  }
  return normalized;
}

function displayName(name: string | undefined, email: string): string {
  return name?.trim() || email.split("@")[0]?.trim() || "camelAI User";
}

function proxyModeFromEnv(): ProxyAuthMode {
  const mode = process.env.PROXY_AUTH_MODE?.trim() || "off";
  if (
    mode !== "off" &&
    mode !== "cloudflare-access" &&
    mode !== "pomerium"
  ) {
    throw new Error(`Invalid PROXY_AUTH_MODE: ${mode}`);
  }
  return mode;
}

export class AuthService {
  private readonly proxyAuthMode: ProxyAuthMode;

  constructor(
    private readonly identity: IdentityService,
    private readonly sessions: SessionService,
    options: AuthServiceOptions = {},
  ) {
    this.proxyAuthMode = options.proxyAuthMode ?? proxyModeFromEnv();
  }

  async registerPassword(input: {
    email: string;
    password: string;
    name: string;
  }): Promise<SessionRecord> {
    const email = normalizeEmail(input.email);
    if (!input.password) {
      throw new Error("Password is required");
    }

    let user = this.identity.findUserByEmail(email);
    if (user && this.identity.getPasswordHash(user.id)) {
      throw new Error("An account with this email already exists");
    }
    if (!user) {
      user = this.createUserTenant({
        email,
        name: displayName(input.name, email),
      });
    }

    const passwordHash = await hashPassword(input.password);
    this.identity.setPasswordHash(user.id, passwordHash);
    return this.sessions.createSession({
      userId: user.id,
      orgId: user.orgId,
      provider: "password",
    });
  }

  async loginPassword(input: {
    email: string;
    password: string;
  }): Promise<SessionRecord> {
    const email = normalizeEmail(input.email);
    const user = this.identity.findUserByEmail(email);
    const passwordHash = user
      ? this.identity.getPasswordHash(user.id)
      : undefined;
    if (
      !user ||
      !passwordHash ||
      !(await verifyPassword(input.password, passwordHash))
    ) {
      throw new Error("Invalid email or password");
    }
    return this.sessions.createSession({
      userId: user.id,
      orgId: user.orgId,
      provider: "password",
    });
  }

  loginFromProxy(
    headers: ProxyAuthHeaders,
    mode: ProxyAuthMode = this.proxyAuthMode,
  ): SessionRecord {
    const proxyIdentity = resolveProxyAuth(headers, mode);
    if (!proxyIdentity) {
      throw new Error(
        mode === "off"
          ? "Proxy authentication is disabled"
          : "Proxy identity was not provided",
      );
    }
    const user = this.findOrCreateUser(proxyIdentity);
    return this.sessions.createSession({
      userId: user.id,
      orgId: user.orgId,
      provider: "proxy",
    });
  }

  loginFromOAuthProfile(profile: OAuthProfile): SessionRecord {
    const email = normalizeEmail(profile.email);
    if (!profile.providerUserId?.trim()) {
      throw new Error("OAuth profile user ID is required");
    }
    const user = this.findOrCreateUser({
      email,
      name: displayName(profile.name, email),
    });
    return this.sessions.createSession({
      userId: user.id,
      orgId: user.orgId,
      provider: "oauth",
    });
  }

  requireSession(cookieHeader: string | null | undefined): RequiredSession {
    const sessionId = parseSessionCookie(cookieHeader);
    const session = sessionId
      ? this.sessions.getSession(sessionId)
      : undefined;
    if (!session) {
      throw new Error("Authentication required");
    }
    const user = this.identity.getUser(session.userId);
    if (!user || user.orgId !== session.orgId) {
      this.sessions.revokeSession(session.sessionId);
      throw new Error("Authentication required");
    }
    return { session, user };
  }

  private findOrCreateUser(identity: ProxyIdentity): User {
    const email = normalizeEmail(identity.email);
    return (
      this.identity.findUserByEmail(email) ??
      this.createUserTenant({
        email,
        name: displayName(identity.name, email),
      })
    );
  }

  private createUserTenant(input: { email: string; name: string }): User {
    const org = this.identity.createOrg({
      name: `${input.name}'s Org`,
    });
    this.identity.createWorkspace({
      orgId: org.id,
      name: "My Workspace",
      slug: "workspace",
    });
    return this.identity.createUser({
      orgId: org.id,
      email: input.email,
      name: input.name,
    });
  }
}
