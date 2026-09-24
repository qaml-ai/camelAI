import { describe, expect, it } from "vitest";
import {
  hashPassword,
  verifyPassword,
} from "../src/server/auth/password.ts";

describe("password auth", () => {
  it("hashes and verifies passwords with a unique salt", async () => {
    const first = await hashPassword("correct horse battery staple");
    const second = await hashPassword("correct horse battery staple");

    expect(first).toMatch(/^scrypt\$/);
    expect(second).not.toBe(first);
    await expect(
      verifyPassword("correct horse battery staple", first),
    ).resolves.toBe(true);
    await expect(verifyPassword("incorrect", first)).resolves.toBe(false);
  });

  it("rejects malformed hashes without throwing", async () => {
    await expect(verifyPassword("password", "not-a-hash")).resolves.toBe(false);
    await expect(
      verifyPassword("password", "scrypt$999999$8$1$salt$hash"),
    ).resolves.toBe(false);
  });
});
