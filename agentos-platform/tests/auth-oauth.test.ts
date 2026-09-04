import { describe, expect, it, vi } from "vitest";
import {
  buildAuthorizeUrl,
  exchangeCodeForProfile,
  getOAuthProviderConfig,
} from "../src/server/auth/oauth.ts";

describe("OAuth", () => {
  it("builds provider authorization URLs from environment config", () => {
    const config = getOAuthProviderConfig("github", {
      GITHUB_CLIENT_ID: "client-id",
      GITHUB_CLIENT_SECRET: "client-secret",
      GITHUB_AUTHORIZE_URL: "https://identity.example/authorize",
    });
    const authorizeUrl = new URL(
      buildAuthorizeUrl(config, "state-value", "https://app.example/callback"),
    );

    expect(authorizeUrl.origin).toBe("https://identity.example");
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client-id");
    expect(authorizeUrl.searchParams.get("state")).toBe("state-value");
    expect(authorizeUrl.searchParams.get("scope")).toContain("user:email");
  });

  it("exchanges a code and maps the provider profile with mocked fetch", async () => {
    const config = getOAuthProviderConfig("google", {
      GOOGLE_CLIENT_ID: "google-client",
      GOOGLE_CLIENT_SECRET: "google-secret",
      GOOGLE_TOKEN_URL: "https://identity.example/token",
      GOOGLE_USER_INFO_URL: "https://identity.example/userinfo",
    });
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: "access-token" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            sub: "google-user-1",
            email: "Ada@Example.com",
            name: "Ada Lovelace",
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        ),
      );

    await expect(
      exchangeCodeForProfile(
        config,
        "authorization-code",
        "https://app.example/callback",
        fetchMock,
      ),
    ).resolves.toEqual({
      providerUserId: "google-user-1",
      email: "ada@example.com",
      name: "Ada Lovelace",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer access-token",
        }),
      }),
    );
  });

  it("throws a clear error when provider credentials are absent", async () => {
    const config = getOAuthProviderConfig("github", {});
    expect(() =>
      buildAuthorizeUrl(config, "state", "https://app.example/callback"),
    ).toThrow("OAuth not configured for github");
    await expect(
      exchangeCodeForProfile(
        config,
        "code",
        "https://app.example/callback",
      ),
    ).rejects.toThrow("OAuth not configured for github");
  });
});
