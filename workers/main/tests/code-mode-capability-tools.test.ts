import { describe, expect, it, vi } from "vitest";

vi.mock("../src/connections-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/connections-runtime")>()),
  invokeConnectionMethod: vi.fn(async () => ({ rows: [{ ok: 1 }] })),
}));

import { invokeConnectionMethod } from "../src/connections-runtime";
import {
  CODE_MODE_TOOL_DEFINITIONS,
  CodeModeToolsBinding,
  decodeImageDataUrl,
  generatedImagePath,
  serializeHttpToolResponse,
} from "../src/code-mode-tools";

/**
 * Tool forms of js_exec's binding-only capabilities (connections[alias],
 * env.BROWSER, env.CAMELAI, env.SECURE_FETCH), served to the hosted runtime
 * over MCP and on js_exec's `tools`.
 */
const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const PROPS = { orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user1" };

type Methods = Record<string, (this: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>>;
const methods = CodeModeToolsBinding.prototype as unknown as Methods;

function binding(overrides: Record<string, unknown> = {}) {
  const instance = Object.create(CodeModeToolsBinding.prototype) as Record<string, unknown>;
  Object.assign(instance, { ctx: { props: PROPS }, env: {} }, overrides);
  return instance;
}

function r2Bucket(objects: Record<string, Uint8Array> = {}) {
  return {
    put: vi.fn(async () => ({})),
    head: vi.fn(async (key: string) => (objects[key] ? { size: objects[key].byteLength } : null)),
    get: vi.fn(async (key: string) => (objects[key]
      ? { arrayBuffer: async () => objects[key].slice().buffer, httpMetadata: { contentType: "audio/ogg" } }
      : null)),
  };
}

describe("capability tool registry", () => {
  it("registers the capability tools with object schemas", () => {
    for (const name of [
      "connections_query",
      "connections_invoke",
      "browser_launch",
      "browser_action",
      "generate_image",
      "transcribe_audio",
      "http_request",
    ]) {
      const definition = CODE_MODE_TOOL_DEFINITIONS.find((tool) => tool.name === name);
      expect(definition, name).toBeDefined();
      expect(definition!.hidden).toBe(false);
      expect((definition!.parameters as { type?: string }).type).toBe("object");
    }
    const browserAction = CODE_MODE_TOOL_DEFINITIONS.find((tool) => tool.name === "browser_action")!;
    const method = (browserAction.parameters as { properties: { method: { anyOf: Array<{ const: string }> } } })
      .properties.method;
    expect(method.anyOf.map((literal) => literal.const)).toEqual(expect.arrayContaining(["click", "screenshot", "close"]));
  });
});

describe("connections_query", () => {
  it("invokes the connection's query method with the remaining arguments as input", async () => {
    const handlers = (CodeModeToolsBinding as unknown as {
      TOOL_CALL_HANDLERS: Record<string, (binding: unknown, args: Record<string, unknown>, name: string) => Promise<unknown>>;
    }).TOOL_CALL_HANDLERS;
    const instance = binding();
    await expect(handlers.connections_query(instance, {
      connection: "warehouse",
      query: "SELECT 1 AS ok",
      limit: 5,
      toolUseId: "call_1",
    }, "connections_query")).resolves.toEqual({ rows: [{ ok: 1 }] });
    expect(invokeConnectionMethod).toHaveBeenCalledWith(instance.env, expect.objectContaining({ workspaceId: "ws1" }), {
      connection: "warehouse",
      method: "query",
      input: { query: "SELECT 1 AS ok", limit: 5 },
    });
    await expect(async () => handlers.connections_query(instance, { connection: "warehouse" }, "connections_query"))
      .rejects.toThrow("query is required");
  });
});

describe("generate_image", () => {
  it("saves each generated image to R2 and returns it as image content", async () => {
    const generateImage = vi.fn(async () => ({
      text: "Here you go",
      imageDataUrl: `data:image/png;base64,${PNG_BASE64}`,
      images: [
        { dataUrl: `data:image/png;base64,${PNG_BASE64}`, index: 0 },
        { dataUrl: `data:image/png;base64,${PNG_BASE64}`, index: 1 },
      ],
    }));
    const bucket = r2Bucket();
    const instance = binding({ env: { R2_BUCKET: bucket }, camelAiService: () => ({ generateImage }) });

    const result = await methods.generateImageTool.call(instance, { prompt: "a camel", output_path: "outputs/camel.png" });

    expect(generateImage).toHaveBeenCalledWith({ prompt: "a camel" });
    expect(bucket.put).toHaveBeenCalledTimes(2);
    const keys = bucket.put.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(keys[0]).toMatch(/user-outputs\/camel\.png$/);
    expect(keys[1]).toMatch(/user-outputs\/camel-2\.png$/);
    expect(result.content).toEqual([
      { type: "text", text: expect.stringContaining("outputs/camel.png, outputs/camel-2.png") },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
      { type: "image", data: PNG_BASE64, mimeType: "image/png" },
    ]);
    expect((result.details as { images: Array<{ path: string; publicUrl: string }> }).images[0]).toMatchObject({
      path: "outputs/camel.png",
      publicUrl: "/api/workspaces/ws1/outputs/camel.png",
    });
  });

  it("refuses a read-only destination before generating anything", async () => {
    const generateImage = vi.fn();
    const instance = binding({ env: { R2_BUCKET: r2Bucket() }, camelAiService: () => ({ generateImage }) });
    await expect(methods.generateImageTool.call(instance, { prompt: "a camel", output_path: "uploads/x.png" }))
      .rejects.toThrow("uploads/ is read-only");
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("sends a stored reference image as a data URL", async () => {
    const generateImage = vi.fn(async () => ({
      text: null,
      imageDataUrl: null,
      images: [{ dataUrl: `data:image/png;base64,${PNG_BASE64}`, index: 0 }],
    }));
    const png = Uint8Array.from(atob(PNG_BASE64), (char) => char.charCodeAt(0));
    const bucket = r2Bucket();
    bucket.head.mockImplementation(async () => ({ size: png.byteLength }));
    bucket.get.mockImplementation(async () => ({
      arrayBuffer: async () => png.slice().buffer,
      httpMetadata: { contentType: "image/png" },
    }));
    const instance = binding({ env: { R2_BUCKET: bucket }, camelAiService: () => ({ generateImage }) });
    await methods.generateImageTool.call(instance, {
      prompt: "same style",
      reference_image: { location: "r2", path: "uploads/ref.png" },
    });
    expect(generateImage).toHaveBeenCalledWith({
      prompt: "same style",
      referenceImageUrl: `data:image/png;base64,${PNG_BASE64}`,
    });
  });
});

describe("transcribe_audio", () => {
  it("transcribes an R2 file with Whisper", async () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const bucket = r2Bucket();
    bucket.head.mockImplementation(async () => ({ size: audio.byteLength }));
    bucket.get.mockImplementation(async () => ({ arrayBuffer: async () => audio.slice().buffer, httpMetadata: {} }));
    const run = vi.fn(async () => ({ text: " hello there " }));
    const instance = binding({ env: { R2_BUCKET: bucket, AI: { run } } });

    await expect(methods.transcribeAudioTool.call(instance, { location: "r2", path: "uploads/memo.ogg" }))
      .resolves.toEqual({ text: "hello there", location: "r2", path: "uploads/memo.ogg", bytes: 4 });
    expect(run).toHaveBeenCalledWith("@cf/openai/whisper-large-v3-turbo", { audio: "AQIDBA==" });
  });

  it("refuses files over the Whisper limit without reading them", async () => {
    const bucket = r2Bucket();
    bucket.head.mockImplementation(async () => ({ size: 26 * 1024 * 1024 }));
    const instance = binding({ env: { R2_BUCKET: bucket, AI: { run: vi.fn() } } });
    await expect(methods.transcribeAudioTool.call(instance, { location: "r2", path: "uploads/long.wav" }))
      .rejects.toThrow(/too large/);
    expect(bucket.get).not.toHaveBeenCalled();
  });
});

const appHosts = async () => ({ routesByHostname: new Map(), hostnames: new Set(["app.example.test"]) });

describe("http_request", () => {
  it("fetches through the secure fetch binding and returns a bounded body", async () => {
    const fetch = vi.fn(async () => new Response("abcdef", { status: 201, headers: { "content-type": "text/plain" } }));
    const instance = binding({ secureFetchBinding: () => ({ fetch }), workspaceAppHostIndex: appHosts });
    const result = await methods.httpRequest.call(instance, {
      url: "https://app.example.test/api",
      method: "post",
      headers: { "content-type": "application/json" },
      body: "{}",
      max_characters: 3,
    });
    expect(fetch).toHaveBeenCalledWith("https://app.example.test/api", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(result).toMatchObject({ status: 201, body: "abc", bodyBytes: 6, truncated: true, encoding: "text" });
  });

  it("rejects non-http URLs and GET bodies", async () => {
    const instance = binding({ secureFetchBinding: () => ({ fetch: vi.fn() }), workspaceAppHostIndex: appHosts });
    await expect(methods.httpRequest.call(instance, { url: "file:///etc/passwd" })).rejects.toThrow(/http\(s\)/);
    await expect(methods.httpRequest.call(instance, { url: "https://app.example.test", body: "a" })).rejects.toThrow(/body/);
  });

  it("refuses URLs that are not this workspace's deployed apps", async () => {
    const fetch = vi.fn();
    const instance = binding({ secureFetchBinding: () => ({ fetch }), workspaceAppHostIndex: appHosts });
    await expect(methods.httpRequest.call(instance, { url: "https://example.com/" })).rejects.toThrow(/web_fetch/);
    await expect(methods.httpRequest.call(instance, { url: "http://169.254.169.254/latest" })).rejects.toThrow(/deployed apps/);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("capability tool helpers", () => {
  it("decodes generated image data URLs", () => {
    const decoded = decodeImageDataUrl(`data:image/jpg;base64,${PNG_BASE64}`);
    expect(decoded.mimeType).toBe("image/jpeg");
    expect(decoded.bytes.byteLength).toBeGreaterThan(0);
    expect(() => decodeImageDataUrl("https://example.test/a.png")).toThrow(/data URL/);
  });

  it("names generated images after the requested path", () => {
    expect(generatedImagePath("outputs/hero.png", 0, "image/png")).toBe("outputs/hero.png");
    expect(generatedImagePath("outputs/hero.png", 1, "image/jpeg")).toBe("outputs/hero-2.jpg");
    expect(generatedImagePath("outputs/a.b/hero", 0, "image/webp")).toBe("outputs/a.b/hero.webp");
  });

  it("caps buffered response bytes and base64 output", async () => {
    const text = await serializeHttpToolResponse(new Response("0123456789"), {
      requestedUrl: "https://x.test",
      format: "text",
      maxCharacters: 100,
      maxBytes: 4,
    });
    expect(text).toMatchObject({ body: "0123", bodyBytes: 4, truncated: true, url: "https://x.test" });
    const base64 = await serializeHttpToolResponse(new Response(new Uint8Array([1, 2, 3, 4, 5, 6])), {
      requestedUrl: "https://x.test",
      format: "base64",
      maxCharacters: 4,
      maxBytes: 100,
    });
    expect(base64).toMatchObject({ body: "AQID", bodyBytes: 6, truncated: true, encoding: "base64" });
  });
});

describe("report_automation_outcome", () => {
  it("records the outcome on the thread's DO", async () => {
    const recordAutomationOutcome = vi.fn(async (status: string) => ({ status, text: `Automation outcome recorded: ${status}` }));
    const instance = binding();
    Object.defineProperty(instance, "chatThreadStub", { value: { recordAutomationOutcome } });
    await expect(methods.reportAutomationOutcome.call(instance, { status: "partial", summary: "half done" }))
      .resolves.toEqual({ status: "partial", text: "Automation outcome recorded: partial" });
    expect(recordAutomationOutcome).toHaveBeenCalledWith("partial", "half done");
  });

  it("needs a thread", async () => {
    const instance = binding({ ctx: { props: { ...PROPS, threadId: undefined } } });
    await expect(methods.reportAutomationOutcome.call(instance, { status: "success", summary: "x" })).rejects.toThrow(/thread scope/);
  });
});
