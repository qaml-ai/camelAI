import { describe, expect, it, vi } from "vitest";

import {
  createSessionCookie,
  handleWorkerRequest,
  stripPlatformAuthMaterial,
} from "../../dispatcher/src/index";

describe("self-host dispatcher authentication", () => {
  it("uses host-only dispatcher cookies for multi-label enterprise domains", () => {
    const cookie = createSessionCookie("session-1");

    expect(cookie).toContain("chiridion_run_session=session-1");
    expect(cookie).not.toContain("Domain=");
  });

  it("removes platform and identity-proxy credentials before app dispatch", () => {
    const headers = new Headers({
      Cookie:
        "app_session=keep; chiridion_run_session=secret; chiridion_session_v3=main; " +
        "CF_Authorization=access; _pomerium=pomerium",
      "CF-Access-Jwt-Assertion": "access-jwt",
      "CF-Access-Authenticated-User-Email": "user@example.test",
      "X-Pomerium-Jwt-Assertion": "pomerium-jwt",
    });

    stripPlatformAuthMaterial(headers, "demo.apps.company.co.uk");

    expect(headers.get("Cookie")).toBe("app_session=keep");
    expect(headers.has("CF-Access-Jwt-Assertion")).toBe(false);
    expect(headers.has("CF-Access-Authenticated-User-Email")).toBe(false);
    expect(headers.has("X-Pomerium-Jwt-Assertion")).toBe(false);
  });

  it("dispatches a public self-host app without main-app authentication", async () => {
    const appFetch = vi.fn(async () => new Response("app"));
    const kvPut = vi.fn(async () => undefined);
    const env = {
      CF_ACCOUNT_ID: "selfhost",
      MAIN_APP_URL: "https://camel.example.test",
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === "script:demo--acme-85b"
            ? JSON.stringify({
                org_id: "org-1",
                org_slug: "acme-85b",
                is_public: true,
              })
            : null),
        put: kvPut,
      },
      SELFHOST_APP_RUNNER: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: appFetch }),
      },
    };

    const response = await handleWorkerRequest(
      new Request("https://demo--acme-85b.apps.example.test/"),
      env as never,
      {} as ExecutionContext,
      "demo",
      "demo--acme-85b",
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("app");
    expect(kvPut).not.toHaveBeenCalled();
    expect(appFetch).toHaveBeenCalledOnce();
  });

  it("redirects a private self-host app through main-app authentication", async () => {
    const appFetch = vi.fn(async () => new Response("app"));
    const kvPut = vi.fn(async () => undefined);
    const env = {
      CF_ACCOUNT_ID: "selfhost",
      MAIN_APP_URL: "https://camel.example.test",
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === "script:demo--acme-85b"
            ? JSON.stringify({
                org_id: "org-1",
                org_slug: "acme-85b",
                is_public: false,
              })
            : null),
        put: kvPut,
      },
      SELFHOST_APP_RUNNER: {
        idFromName: (name: string) => name,
        get: () => ({ fetch: appFetch }),
      },
    };

    const response = await handleWorkerRequest(
      new Request("https://demo--acme-85b.apps.example.test/"),
      env as never,
      {} as ExecutionContext,
      "demo",
      "demo--acme-85b",
    );

    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("Location")!);
    expect(location.origin).toBe("https://camel.example.test");
    expect(location.pathname).toBe("/auth/worker");
    expect(location.searchParams.get("state")).toBeTruthy();
    expect(kvPut).toHaveBeenCalledWith(
      expect.stringMatching(/^wauth_state:/),
      expect.any(String),
      { expirationTtl: 60 },
    );
    expect(appFetch).not.toHaveBeenCalled();
  });
});
