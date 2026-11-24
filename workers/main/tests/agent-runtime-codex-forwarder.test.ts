import { describe, expect, it } from "vitest";

import { codexAccountId, codexRoute } from "../src/agent-runtime/codex-forwarder";
import type { PiResolvedModelConfig } from "../src/chat-thread/pi-model-config";

const b64url = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const TOKEN = `${b64url({ alg: "RS256" })}.${b64url({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_123" } })}.sig`;

function config(model: Record<string, unknown>, apiKey = TOKEN): PiResolvedModelConfig {
  return { apiKey, billingSource: "byok", creditChargeable: false, usageProvider: "openai", provider: "openai", modelId: "gpt-5.6-sol", model } as unknown as PiResolvedModelConfig;
}
const codex = config({ provider: "openai-codex", api: "openai-codex-responses", id: "gpt-5.6-sol", baseUrl: "https://chatgpt.com/backend-api/codex" });

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
});
