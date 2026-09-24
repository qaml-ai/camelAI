import { describe, expect, it } from "vitest";
import {
  cloudflareAccessProxyAuth,
  pomeriumProxyAuth,
  resolveProxyAuth,
} from "../src/server/auth/proxy-auth.ts";

describe("proxy authentication", () => {
  it("prefers Cloudflare Access's authenticated email header", () => {
    const headers = new Headers({
      "CF-Access-Authenticated-User-Email": "Ada@Example.com",
      "CF_Authorization": "invalid.jwt.value",
    });
    expect(cloudflareAccessProxyAuth.extractIdentity(headers)).toEqual({
      email: "ada@example.com",
      name: "ada",
    });
  });

  it("can read a simple Cloudflare Access JWT payload", () => {
    const payload = Buffer.from(
      JSON.stringify({
        email: "grace@example.com",
        name: "Grace Hopper",
        groups: ["engineering"],
      }),
    ).toString("base64url");
    const token = `header.${payload}.signature`;
    expect(
      resolveProxyAuth(
        { CF_Authorization: token },
        "cloudflare-access",
      ),
    ).toEqual({
      email: "grace@example.com",
      name: "Grace Hopper",
      groups: ["engineering"],
    });
  });

  it("reads Pomerium claim headers and groups", () => {
    expect(
      pomeriumProxyAuth.extractIdentity(
        new Headers({
          "X-Pomerium-Email": "linus@example.com",
          "X-Pomerium-Claim-Name": "Linus",
          "X-Pomerium-Claim-Groups": '["admins","engineering"]',
        }),
      ),
    ).toEqual({
      email: "linus@example.com",
      name: "Linus",
      groups: ["admins", "engineering"],
    });
  });

  it("returns null when proxy auth is off or identity is absent", () => {
    expect(resolveProxyAuth(new Headers(), "off")).toBeNull();
    expect(resolveProxyAuth(new Headers(), "pomerium")).toBeNull();
  });
});
