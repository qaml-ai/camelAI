import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseSessionCookie,
  serializeSessionCookie,
  SessionService,
} from "../src/server/auth/session.ts";
import { Store } from "../src/server/platform/store.ts";

const tempDirs: string[] = [];

function createStore(): Store {
  const dataDir = mkdtempSync(join(tmpdir(), "agentos-auth-session-"));
  tempDirs.push(dataDir);
  return new Store({ dataDir });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionService", () => {
  it("creates, retrieves, touches, and revokes persisted sessions", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = createStore();
    const sessions = new SessionService(store, {
      ttlSeconds: 60,
      now: () => now,
    });
    const created = sessions.createSession({
      userId: "user_1",
      orgId: "org_1",
      provider: "password",
    });

    expect(store.get(`session:${created.sessionId}`)).toEqual(created);
    expect(sessions.getSession(created.sessionId)).toEqual(created);

    now = new Date("2026-01-01T00:00:30.000Z");
    const touched = sessions.touchSession(created.sessionId);
    expect(touched?.expiresAt).toBe("2026-01-01T00:01:30.000Z");
    expect(sessions.revokeSession(created.sessionId)).toBe(true);
    expect(sessions.getSession(created.sessionId)).toBeUndefined();
  });

  it("deletes expired sessions on read", () => {
    let now = new Date("2026-01-01T00:00:00.000Z");
    const store = createStore();
    const sessions = new SessionService(store, {
      ttlSeconds: 10,
      now: () => now,
    });
    const session = sessions.createSession({
      userId: "user_1",
      orgId: "org_1",
      provider: "oauth",
    });

    now = new Date("2026-01-01T00:00:11.000Z");
    expect(sessions.getSession(session.sessionId)).toBeUndefined();
    expect(store.get(`session:${session.sessionId}`)).toBeUndefined();
  });
});

describe("session cookies", () => {
  it("serializes a secure HTTP-only cookie and parses it", () => {
    const cookie = serializeSessionCookie("abc/123", {
      secure: true,
      maxAge: 60,
    });
    expect(cookie).toContain("camelai_session=abc%2F123");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(parseSessionCookie(`theme=dark; ${cookie}`)).toBe("abc/123");
  });

  it("returns null when the session cookie is missing or malformed", () => {
    expect(parseSessionCookie(null)).toBeNull();
    expect(parseSessionCookie("other=value")).toBeNull();
    expect(parseSessionCookie("camelai_session=%E0%A4%A")).toBeNull();
  });
});
