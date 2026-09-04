import { afterEach, describe, expect, test } from "vitest";
import {
  mintTicket,
  type AuthTicketPayload,
  verifyTicket,
} from "../src/server/auth/tickets.ts";

const originalSigningSecret = process.env.TOKEN_SIGNING_SECRET;

function payload(overrides: Partial<AuthTicketPayload> = {}): AuthTicketPayload {
  return {
    orgId: "org-1",
    workspaceId: "workspace-1",
    threadId: "thread-1",
    userId: "user-1",
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

afterEach(() => {
  if (originalSigningSecret === undefined) {
    delete process.env.TOKEN_SIGNING_SECRET;
  } else {
    process.env.TOKEN_SIGNING_SECRET = originalSigningSecret;
  }
});

describe("auth tickets", () => {
  test("mints and verifies an HMAC ticket", () => {
    const expected = payload();
    const ticket = mintTicket(expected, "test-secret");

    expect(ticket.split(".")).toHaveLength(2);
    expect(verifyTicket(ticket, "test-secret")).toEqual(expected);
  });

  test("rejects tampered tickets and the wrong secret", () => {
    const ticket = mintTicket(payload(), "test-secret");
    const [body, signature] = ticket.split(".");
    const tamperedBody = `${body?.startsWith("A") ? "B" : "A"}${body?.slice(1)}`;

    expect(verifyTicket(`${tamperedBody}.${signature}`, "test-secret")).toBeNull();
    expect(verifyTicket(ticket, "other-secret")).toBeNull();
  });

  test("rejects expired and malformed tickets", () => {
    const expired = mintTicket(
      payload({ exp: Math.floor(Date.now() / 1000) - 1 }),
      "test-secret",
    );

    expect(verifyTicket(expired, "test-secret")).toBeNull();
    expect(verifyTicket("not-a-ticket", "test-secret")).toBeNull();
  });

  test("uses TOKEN_SIGNING_SECRET with a development fallback", () => {
    process.env.TOKEN_SIGNING_SECRET = "environment-secret";
    const environmentTicket = mintTicket(payload());
    expect(verifyTicket(environmentTicket)).not.toBeNull();
    expect(verifyTicket(environmentTicket, "dev-secret")).toBeNull();

    delete process.env.TOKEN_SIGNING_SECRET;
    const developmentTicket = mintTicket(payload());
    expect(verifyTicket(developmentTicket, "dev-secret")).not.toBeNull();
  });
});
