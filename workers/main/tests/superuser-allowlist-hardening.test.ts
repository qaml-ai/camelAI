import { describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import {
  createUser,
  getUserById,
  updateUserProfile,
  type TestEnv,
} from "./test-helpers";
import {
  isSuperuserEmail,
  parseSuperuserEmails,
} from "../src/identity/superuser";
import { canCreateEnterpriseSsoUser } from "../src/identity/user-do";

const testEnv = env as unknown as TestEnv;

describe("superuser allowlist hardening", () => {
  it("does not treat any email as superuser without an explicit allowlist", () => {
    expect(isSuperuserEmail("admin@example.com")).toBe(false);
    expect(isSuperuserEmail("admin-one@example.com")).toBe(false);
    expect(isSuperuserEmail("admin@camelai.com")).toBe(false);
    expect(isSuperuserEmail("ops@camelai.test", undefined)).toBe(false);
    expect(isSuperuserEmail("ops@camelai.test", "")).toBe(false);
  });

  it("honors only the configured SUPERUSER_EMAILS allowlist", () => {
    const allowlist = parseSuperuserEmails(
      "ops@camelai.test, other@camelai.test",
    );
    expect(isSuperuserEmail("ops@camelai.test", allowlist)).toBe(true);
    expect(isSuperuserEmail("OPS@CamelAI.test", "ops@camelai.test")).toBe(
      true,
    );
    expect(isSuperuserEmail("admin-one@example.com", allowlist)).toBe(false);
  });

  it("does not auto-grant superuser on signup when SUPERUSER_EMAILS is unset", async () => {
    for (const email of [
      `user-${crypto.randomUUID()}@example.com`,
      `admin-${crypto.randomUUID()}@example.com`,
    ]) {
      const { userId, user } = await createUser(
        testEnv,
        email,
        "password123",
        "User",
      );
      expect(user.is_superuser).toBe(false);
      expect((await getUserById(testEnv, userId))?.is_superuser).toBe(false);
    }
  });

  it("still allows explicit admin grants", async () => {
    const email = `grant-${crypto.randomUUID()}@example.com`;
    const { userId } = await createUser(testEnv, email, "password123", "User");
    await updateUserProfile(testEnv, userId, { is_superuser: true });
    expect((await getUserById(testEnv, userId))?.is_superuser).toBe(true);
  });

  it("allows enterprise SSO user creation when no allowlist is configured", () => {
    expect(canCreateEnterpriseSsoUser("admin-one@example.com")).toBe(true);
    expect(
      canCreateEnterpriseSsoUser("ops@camelai.test", "ops@camelai.test"),
    ).toBe(false);
  });
});
