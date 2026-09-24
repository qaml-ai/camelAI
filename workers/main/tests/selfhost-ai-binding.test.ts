import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error self-host worker module has no types
import makeBinding from "../../../infra/selfhost/ai-binding.worker.js";
import { AUXILIARY_AI_MODEL } from "../../../src/lib/auxiliary-ai.server";

describe("selfhost ai binding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("maps Workers AI auxiliary model ids to Bedrock Mantle", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: "Generated title" }],
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "bedrock",
      apiKey: "bedrock-test-key",
      awsRegion: "us-west-2",
    });

    const result = await binding.run("@cf/meta/llama-3.2-3b-instruct", {
      messages: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_tokens: 32,
      temperature: 0.2,
    });

    expect(result).toEqual({ response: "Generated title" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://bedrock-mantle.us-west-2.api.aws/openai/v1/responses");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer bedrock-test-key",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "openai.gpt-5.6-luna",
      input: [
        { role: "system", content: "system" },
        { role: "user", content: "user" },
      ],
      max_output_tokens: 32,
      store: false,
      reasoning: { effort: "none" },
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("maps the auxiliary utility model to Bedrock Mantle", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ output_text: "🧠" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "bedrock",
      apiKey: "bedrock-test-key",
      awsRegion: "us-west-2",
    });

    await binding.run(AUXILIARY_AI_MODEL, {
      messages: [{ role: "user", content: "Architecture planning" }],
      max_tokens: 32,
    });

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // A raw "@cf/..." id passed through to Bedrock means a missing alias.
    expect(JSON.parse(String(init.body)).model).toBe("openai.gpt-5.6-luna");
  });

  it("tries the next supported region when Bedrock reports the model missing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              type: "not_found_error",
              message: "The model does not exist in this region",
            },
          }),
          { status: 404 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ output_text: "Fallback title" }), {
          status: 200,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "bedrock",
      apiKey: "bedrock-test-key",
      awsRegion: "us-east-1",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "Fallback" }],
      }),
    ).resolves.toEqual({ response: "Fallback title" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "https://bedrock-mantle.us-east-1.api.aws/openai/v1/responses",
      "https://bedrock-mantle.us-east-2.api.aws/openai/v1/responses",
    ]);
  });

  it("does not change regions for authentication failures", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ error: { type: "authentication_error" } }), {
        status: 401,
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "bedrock",
      apiKey: "invalid-key",
      awsRegion: "us-east-1",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "No retry" }],
      }),
    ).rejects.toThrow(/authentication_error/);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses Haiku for Anthropic auxiliary generation", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        content: [{ type: "text", text: "Generated Anthropic title" }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "anthropic",
      apiKey: "anthropic-test-key",
    });

    const result = await binding.run(AUXILIARY_AI_MODEL, {
      messages: [
        { role: "system", content: "Return a short title" },
        { role: "user", content: "Build an incident dashboard" },
      ],
      max_tokens: 50,
      temperature: 0,
    });

    expect(result).toEqual({ response: "Generated Anthropic title" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers).toMatchObject({
      "x-api-key": "anthropic-test-key",
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      model: "claude-haiku-4-5-20251001",
      system: "Return a short title",
      messages: [{ role: "user", content: "Build an incident dashboard" }],
      max_tokens: 50,
      temperature: 0,
    });
  });

  it("uses Luna for OpenAI auxiliary generation", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({ output_text: "Generated OpenAI title" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "openai",
      apiKey: "openai-test-key",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "Build a search page" }],
        max_tokens: 32,
      }),
    ).resolves.toEqual({ response: "Generated OpenAI title" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer openai-test-key",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-5.6-luna",
      max_output_tokens: 32,
      store: false,
      reasoning: { effort: "none" },
    });
  });

  it("uses a fast inexpensive model for OpenRouter auxiliary generation", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: "Generated OpenRouter title" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "openrouter",
      apiKey: "openrouter-test-key",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "Build a chart" }],
        max_tokens: 24,
      }),
    ).resolves.toEqual({ response: "Generated OpenRouter title" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer openrouter-test-key",
      "HTTP-Referer": "https://camelai.dev",
      "X-OpenRouter-Title": "camelAI",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "deepseek/deepseek-v4-flash",
      max_tokens: 24,
      reasoning: { effort: "none" },
    });
  });

  it("uses a fast inexpensive model for Requesty auxiliary generation", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: "Generated Requesty title" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "requesty",
      apiKey: "requesty-test-key",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "Build a chart" }],
        max_tokens: 24,
      }),
    ).resolves.toEqual({ response: "Generated Requesty title" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://router.requesty.ai/v1/chat/completions");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer requesty-test-key",
      "HTTP-Referer": "https://camelai.dev",
      "X-Title": "camelAI",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "gpt-5.6-luna",
      max_tokens: 24,
      reasoning: { effort: "none" },
    });
  });

  it.each([429, 524, 529])(
    "retries a transient Anthropic %i failure before returning success",
    async (status) => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { type: "overloaded_error" } }), {
            status,
            headers: { "Retry-After": "0" },
          }),
        )
        .mockResolvedValueOnce(
          Response.json({
            content: [{ type: "text", text: "Recovered title" }],
          }),
        );
      vi.stubGlobal("fetch", fetchMock);

      const binding = makeBinding({
        provider: "anthropic",
        apiKey: "anthropic-test-key",
      });

      await expect(
        binding.run(AUXILIARY_AI_MODEL, {
          messages: [{ role: "user", content: "Name this thread" }],
          max_tokens: 50,
        }),
      ).resolves.toEqual({ response: "Recovered title" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("retries when a response body fails while being read", async () => {
    const failedBody = new ReadableStream({
      start(controller) {
        controller.error(new Error("connection reset while reading response"));
      },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(failedBody, { status: 200 }))
      .mockResolvedValueOnce(
        Response.json({
          content: [{ type: "text", text: "Recovered body" }],
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "anthropic",
      apiKey: "anthropic-test-key",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "Name this thread" }],
      }),
    ).resolves.toEqual({ response: "Recovered body" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("uses the configured Cloudflare AI Gateway for auxiliary generation", async () => {
    const fetchMock = vi.fn(async () =>
      Response.json({
        choices: [{ message: { content: "Gateway title" } }],
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "cloudflare-ai-gateway",
      apiKey: "gateway-test-token",
      gatewayAccountId: "account-id",
      gatewayName: "gateway-name",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "Name this thread" }],
        max_tokens: 50,
      }),
    ).resolves.toEqual({ response: "Gateway title" });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://gateway.ai.cloudflare.com/v1/account-id/gateway-name/compat/chat/completions",
    );
    expect(init.headers).toMatchObject({
      Authorization: "Bearer gateway-test-token",
      "cf-aig-authorization": "Bearer gateway-test-token",
    });
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: `workers-ai/${AUXILIARY_AI_MODEL}`,
      max_tokens: 50,
    });
  });

  it.each([
    {
      api: "openai-completions",
      authType: "bearer",
      expectedUrl: "https://llm.example.test/v1/chat/completions",
      expectedAuth: { Authorization: "Bearer custom-test-key" },
      response: { choices: [{ message: { content: "Custom completion" } }] },
    },
    {
      api: "openai-responses",
      authType: "x-api-key",
      expectedUrl: "https://llm.example.test/v1/responses",
      expectedAuth: { "x-api-key": "custom-test-key" },
      response: { output_text: "Custom response" },
    },
    {
      api: "anthropic-messages",
      authType: "bearer",
      expectedUrl: "https://llm.example.test/v1/messages",
      expectedAuth: { Authorization: "Bearer custom-test-key" },
      response: { content: [{ type: "text", text: "Custom Anthropic" }] },
    },
  ])("uses the configured custom $api endpoint", async ({
    api,
    authType,
    expectedUrl,
    expectedAuth,
    response,
  }) => {
    const fetchMock = vi.fn(async () => Response.json(response));
    vi.stubGlobal("fetch", fetchMock);

    const binding = makeBinding({
      provider: "custom",
      apiKey: "custom-test-key",
      baseUrl: "https://llm.example.test/v1",
      model: "local-small-model",
      authType,
      api,
    });

    const result = await binding.run(AUXILIARY_AI_MODEL, {
      messages: [{ role: "user", content: "Name this thread" }],
      max_tokens: 20,
    });

    expect(result).toEqual({
      response:
        api === "openai-completions"
          ? "Custom completion"
          : api === "openai-responses"
            ? "Custom response"
            : "Custom Anthropic",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(expectedUrl);
    expect(init.headers).toMatchObject(expectedAuth);
    expect(JSON.parse(String(init.body))).toMatchObject({
      model: "local-small-model",
      ...(api === "openai-responses" ? { store: false } : {}),
    });
  });

  it("rejects unknown providers", async () => {
    const binding = makeBinding({
      provider: "unknown",
      apiKey: "test-key",
    });

    await expect(
      binding.run(AUXILIARY_AI_MODEL, {
        messages: [{ role: "user", content: "hello" }],
      }),
    ).rejects.toThrow(/unsupported selfhost_ai_provider/i);
  });
});
