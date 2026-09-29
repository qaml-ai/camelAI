import { describe, expect, it } from "vitest";

import { codexAccountId, codexRoute, codexUpstreamCall } from "../src/agent-runtime/codex-forwarder";
import type { PiResolvedModelConfig } from "../src/chat-thread/pi-model-config";

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const TOKEN = `${b64url({ alg: "RS256" })}.${b64url({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })}.sig`;

function config(model: Record<string, unknown>, apiKey = TOKEN): PiResolvedModelConfig {
  return { apiKey, billingSource: "byok", creditChargeable: false, usageProvider: "openai", provider: "openai", modelId: "gpt-5.6-sol", model } as unknown as PiResolvedModelConfig;
}
const codex = config({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api/codex" });
const ZSTD = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x04, 0x58, 0x99, 0x00, 0xff, 0x10]);

describe("codex route", () => {
  it("reads the ChatGPT account from the subscription's token", () => {
    expect(codexAccountId(TOKEN)).toBe("acct_123");
    expect(codexAccountId("not-a-jwt")).toBeNull();
  });

  it("goes to the Codex backend, or to chiridion's Codex proxy with its token", () => {
    expect(codexRoute(codex)).toEqual({ modelId: "gpt-5.6-sol", upstreamBase: "https://chatgpt.com/backend-api", credential: TOKEN, accountId: "acct_123", headers: {} });
    expect(codexRoute(config({ provider: "openai-codex", id: "gpt-5.6-sol", baseUrl: "https://codex-proxy.example/backend-api/codex", headers: { "X-CamelAI-Proxy-Token": "proxy" } })))
      .toMatchObject({ upstreamBase: "https://codex-proxy.example/backend-api", headers: { "X-CamelAI-Proxy-Token": "proxy" } });
    expect(codexRoute(config({ provider: "openai", id: "gpt-5.6-sol", baseUrl: "https://api.openai.com/v1" }))).toBeNull();
    expect(codexRoute(config({ provider: "openai-codex", id: "x", baseUrl: "https://chatgpt.com/backend-api/codex" }, "not-a-jwt"))).toBeNull();
  });

  it("swaps the runtime's credentials for the subscription's and keeps Codex's own headers", () => {
    const call = codexUpstreamCall(codexRoute(codex)!, "codex/responses", "", [
      ["authorization", "Bearer runtime-jwt"],
      ["x-agent-runtime-identity", "runtime-jwt"],
      ["chatgpt-account-id", "passthrough"],
      ["content-type", "application/json"],
      ["content-encoding", "zstd"],
      ["originator", "pi"],
      ["openai-beta", "responses=experimental"],
      ["session-id", "s1"],
      ["user-agent", "pi (linux)"],
      ["cookie", "a=b"],
    ], ZSTD) as { url: string; headers: Headers };
    expect(call.url).toBe("https://chatgpt.com/backend-api/codex/responses");
    expect(Object.fromEntries(call.headers)).toEqual({
      authorization: `Bearer ${TOKEN}`,
      "chatgpt-account-id": "acct_123",
      "content-type": "application/json",
      "content-encoding": "zstd",
      originator: "pi",
      "openai-beta": "responses=experimental",
      "session-id": "s1",
      "user-agent": "pi (linux)",
    });
  });

  it("checks a plain body's model, and refuses other paths", () => {
    const route = codexRoute(codex)!;
    const plain = (model: string) => new TextEncoder().encode(JSON.stringify({ model }));
    expect(codexUpstreamCall(route, "codex/responses", "", [], plain("gpt-5.6-sol"))).toHaveProperty("url");
    expect(codexUpstreamCall(route, "codex/responses", "", [], plain("gpt-6"))).toEqual({ error: expect.stringMatching(/not gpt-6/) });
    expect(codexUpstreamCall(route, "v1/models", "", [], plain("gpt-5.6-sol"))).toEqual({ error: expect.stringMatching(/Not a Codex call/) });
  });
});
