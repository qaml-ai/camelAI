import { describe, expect, it } from "vitest";

import {
  buildPomeriumConfig,
  requiredHttpsUrlWithOptionalPath,
} from "../scripts/selfhost-pomerium-config.mjs";

function bundledPomeriumEnv() {
  return {
    SELFHOST_AUTH_MODE: "bundled-pomerium",
    SELFHOST_PUBLIC_BASE_URL: "https://camel.example.com",
    SELFHOST_MAIN_HOSTNAME: "camel.example.com",
    POMERIUM_AUTHENTICATE_URL: "https://authenticate.example.com",
    POMERIUM_AUTHENTICATE_HOSTNAME: "authenticate.example.com",
    POMERIUM_IDP_PROVIDER: "oidc",
    POMERIUM_IDP_PROVIDER_URL: "https://idp.example.com",
    POMERIUM_IDP_CLIENT_ID: "camelai",
    POMERIUM_IDP_CLIENT_SECRET: "idp-secret",
    POMERIUM_COOKIE_SECRET: "cookie-secret",
    POMERIUM_SHARED_SECRET: "shared-secret",
    LOCAL_APP_VANITY_DOMAIN: "apps.example.com",
    LOCAL_APP_IFRAME_DOMAIN: "preview.example.com",
  };
}

describe("self-host Pomerium configuration", () => {
  it("accepts path-based OIDC issuer URLs", () => {
    expect(
      requiredHttpsUrlWithOptionalPath(
        "https://idp.example.com/application/o/camelai/",
        "POMERIUM_IDP_PROVIDER_URL",
      ).href,
    ).toBe("https://idp.example.com/application/o/camelai/");
  });

  it.each([
    "http://idp.example.com/application/o/camelai/",
    "https://idp.example.com/application/o/camelai/?tenant=example",
    "https://idp.example.com/application/o/camelai/#issuer",
  ])("rejects unsafe OIDC issuer URL %s", (url) => {
    expect(() =>
      requiredHttpsUrlWithOptionalPath(url, "POMERIUM_IDP_PROVIDER_URL"),
    ).toThrow(
      "POMERIUM_IDP_PROVIDER_URL must be an https URL without a query or fragment",
    );
  });

  it("lets the dispatcher enforce per-app access and allows the camelAI origin to frame apps", () => {
    const config = buildPomeriumConfig(bundledPomeriumEnv());
    expect(config).not.toBeNull();

    const appRoutes = config!.routes.filter(
      (route) =>
        route.from.startsWith("https://*.") &&
        "set_response_headers" in route,
    );
    expect(appRoutes).toHaveLength(2);
    expect(appRoutes.map((route) => route.from)).toEqual([
      "https://*.apps.example.com",
      "https://*.preview.example.com",
    ]);
    for (const route of appRoutes) {
      expect("allow_public_unauthenticated_access" in route).toBe(true);
      expect(
        "allow_public_unauthenticated_access" in route
          ? route.allow_public_unauthenticated_access
          : undefined,
      ).toBe(true);
      expect(route).not.toHaveProperty("allow_any_authenticated_user");
      expect(
        "set_response_headers" in route
          ? route.set_response_headers
          : undefined,
      ).toEqual({
        "Content-Security-Policy":
          "frame-ancestors 'self' https://camel.example.com",
      });
    }
  });

  it("uses the complete public origin in the app frame policy", () => {
    const env = bundledPomeriumEnv();
    env.SELFHOST_PUBLIC_BASE_URL = "https://camel.example.com:8443";
    const config = buildPomeriumConfig(env);
    const appRoute = config!.routes.find((route) =>
      "set_response_headers" in route && route.from.startsWith("https://*.")
    );

    expect(
      appRoute && "set_response_headers" in appRoute
        ? appRoute.set_response_headers
        : undefined,
    ).toEqual({
      "Content-Security-Policy":
        "frame-ancestors 'self' https://camel.example.com:8443",
    });
  });
});
