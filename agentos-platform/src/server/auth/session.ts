import { randomBytes } from "node:crypto";
import type { Store } from "../platform/store.ts";

export const SESSION_COOKIE_NAME = "camelai_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const DEFAULT_SESSION_TTL_SECONDS = SESSION_TTL_SECONDS;

export type SessionProvider = "password" | "oauth" | "proxy";

export type SessionRecord = {
  sessionId: string;
  userId: string;
  orgId: string;
  createdAt: string;
  expiresAt: string;
  provider: SessionProvider;
};

export type SessionServiceOptions = {
  ttlSeconds?: number;
  now?: () => Date;
};

export type SessionCookieOptions = {
  secure?: boolean;
  maxAge?: number;
};

function sessionKey(sessionId: string): string {
  return `session:${sessionId}`;
}

function sessionTtlFromEnv(): number {
  const raw = process.env.SESSION_TTL_SECONDS;
  if (!raw) {
    return DEFAULT_SESSION_TTL_SECONDS;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid SESSION_TTL_SECONDS: ${raw}`);
  }
  return value;
}

function cookieIsSecure(): boolean {
  const configured = process.env.SESSION_COOKIE_SECURE?.trim().toLowerCase();
  if (configured) {
    if (configured === "true" || configured === "1") {
      return true;
    }
    if (configured === "false" || configured === "0") {
      return false;
    }
    throw new Error(
      `Invalid SESSION_COOKIE_SECURE: ${process.env.SESSION_COOKIE_SECURE}`,
    );
  }
  return process.env.NODE_ENV === "production";
}

export class SessionService {
  readonly ttlSeconds: number;
  private readonly now: () => Date;

  constructor(
    private readonly store: Store,
    options: SessionServiceOptions = {},
  ) {
    this.ttlSeconds = options.ttlSeconds ?? sessionTtlFromEnv();
    if (!Number.isInteger(this.ttlSeconds) || this.ttlSeconds <= 0) {
      throw new Error("Session TTL must be a positive integer");
    }
    this.now = options.now ?? (() => new Date());
  }

  createSession(input: {
    userId: string;
    orgId: string;
    provider: SessionProvider;
  }): SessionRecord {
    if (!input.userId?.trim()) {
      throw new Error("createSession: userId is required");
    }
    if (!input.orgId?.trim()) {
      throw new Error("createSession: orgId is required");
    }
    if (!["password", "oauth", "proxy"].includes(input.provider)) {
      throw new Error(`createSession: unsupported provider: ${input.provider}`);
    }

    const createdAt = this.now();
    const record: SessionRecord = {
      sessionId: randomBytes(32).toString("base64url"),
      userId: input.userId,
      orgId: input.orgId,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(
        createdAt.getTime() + this.ttlSeconds * 1000,
      ).toISOString(),
      provider: input.provider,
    };
    this.store.set(sessionKey(record.sessionId), record);
    return record;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    if (!sessionId) {
      return undefined;
    }
    const record = this.store.get<SessionRecord>(sessionKey(sessionId));
    if (!record) {
      return undefined;
    }
    const expiresAt = Date.parse(record.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now().getTime()) {
      this.store.delete(sessionKey(sessionId));
      return undefined;
    }
    return record;
  }

  revokeSession(sessionId: string): boolean {
    if (!sessionId) {
      return false;
    }
    return this.store.delete(sessionKey(sessionId));
  }

  touchSession(sessionId: string): SessionRecord | undefined {
    const current = this.getSession(sessionId);
    if (!current) {
      return undefined;
    }
    const updated: SessionRecord = {
      ...current,
      expiresAt: new Date(
        this.now().getTime() + this.ttlSeconds * 1000,
      ).toISOString(),
    };
    this.store.set(sessionKey(sessionId), updated);
    return updated;
  }
}

export function serializeSessionCookie(
  sessionId: string,
  options: SessionCookieOptions = {},
): string {
  const secure = options.secure ?? cookieIsSecure();
  const maxAge = options.maxAge ?? sessionTtlFromEnv();
  if (!Number.isInteger(maxAge) || maxAge < 0) {
    throw new Error("Session cookie maxAge must be a non-negative integer");
  }

  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${maxAge}`,
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

export function parseSessionCookie(
  cookieHeader: string | null | undefined,
): string | null {
  if (!cookieHeader) {
    return null;
  }
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE_NAME) {
      continue;
    }
    try {
      const value = decodeURIComponent(part.slice(separator + 1).trim());
      return value || null;
    } catch {
      return null;
    }
  }
  return null;
}
