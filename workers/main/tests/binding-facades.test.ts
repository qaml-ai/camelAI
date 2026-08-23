import { describe, expect, it, vi } from "vitest";

import {
  BindingFacadeError,
  bindingFacadeFetch,
  bindingFacadeUrl,
  type BindingFacadeFetcher,
} from "../src/binding-facades/transport";
import {
  OBJECT_METADATA_HEADER,
  ServiceR2Bucket,
  encodeObjectMetadata,
  type FacadeObjectMetadata,
} from "../src/binding-facades/object-store";
import { ServiceSandboxClient } from "../src/binding-facades/compute";
import { ServiceArtifactsBinding } from "../src/binding-facades/artifacts";
import {
  resolveAiBinding,
  resolveBrowserBinding,
  resolveEmailBinding,
  resolveLakeStream,
  resolveQueueBinding,
} from "../src/binding-facades/managed";
import { ServiceImagesBinding } from "../src/binding-facades/images";
import { runPortableCode } from "../src/binding-facades/code-executor";
import { recordErrorEvent } from "../src/observability";
import celldFacadeWorker from "../../celld-facades/index";

function facadeFetcher(
  handler: (request: Request) => Response | Promise<Response>,
): BindingFacadeFetcher & { fetch: ReturnType<typeof vi.fn> } {
  return { fetch: vi.fn(handler) };
}

function objectMetadata(overrides: Partial<FacadeObjectMetadata> = {}): FacadeObjectMetadata {
  return {
    key: "uploads/report.txt",
    size: 5,
    etag: "etag-1",
    uploaded: "2026-08-23T12:00:00.000Z",
    httpMetadata: {
      contentType: "text/plain",
      cacheExpiry: new Date("2026-08-24T12:00:00.000Z"),
    },
    customMetadata: { workspace: "ws-1" },
    ...overrides,
  };
}

describe("binding facade transport", () => {
  it("normalizes capability paths and query parameters", () => {
    const url = bindingFacadeUrl("object-store", "multipart/part", {
      binding: "R2_BUCKET",
      key: "folder/file name.txt",
      partNumber: 2,
    });

    expect(url.pathname).toBe("/v1/object-store/multipart/part");
    expect(url.searchParams.get("binding")).toBe("R2_BUCKET");
    expect(url.searchParams.get("key")).toBe("folder/file name.txt");
    expect(url.searchParams.get("partNumber")).toBe("2");
  });

  it("turns non-success responses into typed errors", async () => {
    const service = facadeFetcher(() => Response.json(
      { error: "runner unavailable" },
      { status: 503 },
    ));

    await expect(bindingFacadeFetch(service, "compute", "rpc")).rejects.toMatchObject({
      name: "BindingFacadeError",
      capability: "compute",
      status: 503,
      message: "runner unavailable",
    } satisfies Partial<BindingFacadeError>);
  });
});

describe("observability facade privacy", () => {
  it("sends only bounded allowlisted error fields", async () => {
    let wireEvent: Record<string, unknown> | undefined;
    const service = facadeFetcher(async (request) => {
      const payload = await request.json() as { event: Record<string, unknown> };
      wireEvent = payload.event;
      return Response.json({ ok: true });
    });
    const error = Object.assign(new Error("x".repeat(3_000)), {
      authorization: "Bearer must-not-leak",
      request: { headers: { authorization: "Bearer must-not-leak" } },
    });

    recordErrorEvent({ OBSERVABILITY_SERVICE: service as unknown as Fetcher }, {
      event: "provider_failure",
      component: "provider",
      error,
    });
    await vi.waitFor(() => expect(wireEvent).toBeDefined());

    expect(wireEvent).not.toHaveProperty("error");
    expect(JSON.stringify(wireEvent)).not.toContain("must-not-leak");
    expect(String(wireEvent?.errorMessage)).toHaveLength(2_048);
  });
});

describe("Code Mode facade", () => {
  it("aborts a runner that exceeds the host timeout plus transport grace", async () => {
    vi.useFakeTimers();
    try {
      const service = facadeFetcher((request) => new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason));
      }));
      const execution = runPortableCode({ CODE_EXECUTOR_SERVICE: service }, {
        code: "return 1",
        orgId: "org-1",
        workspaceId: "ws-1",
        timeoutMs: 10,
        maxOutputCharacters: 1_000,
      });

      const rejection = expect(execution).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(5_010);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("object-store facade", () => {
  it("preserves logical bucket names, streaming bodies, and metadata", async () => {
    const metadata = objectMetadata();
    const service = facadeFetcher(async (request) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("binding")).toBe("R2_OUTPUTS_BUCKET");
      expect(url.searchParams.get("key")).toBe(metadata.key);
      if (request.method === "PUT") {
        expect(await request.text()).toBe("hello");
        return new Response(null, {
          headers: { [OBJECT_METADATA_HEADER]: encodeObjectMetadata(metadata) },
        });
      }
      return new Response("hello", {
        headers: { [OBJECT_METADATA_HEADER]: encodeObjectMetadata(metadata) },
      });
    });
    const bucket = new ServiceR2Bucket(service, "R2_OUTPUTS_BUCKET");

    const written = await bucket.put(metadata.key, "hello", {
      httpMetadata: { contentType: "text/plain" },
    });
    expect(written).toMatchObject({
      key: metadata.key,
      etag: "etag-1",
      size: 5,
    });

    const read = await bucket.get(metadata.key);
    expect(read && "body" in read ? await read.text() : null).toBe("hello");
    expect(read?.uploaded).toEqual(new Date(metadata.uploaded));
    expect(read?.httpMetadata?.cacheExpiry).toEqual(
      new Date("2026-08-24T12:00:00.000Z"),
    );
    const headers = new Headers();
    read?.writeHttpMetadata(headers);
    expect(headers.get("content-type")).toBe("text/plain");
    expect(headers.get("expires")).toBe("Mon, 24 Aug 2026 12:00:00 GMT");
  });

  it("supports list and multipart operations", async () => {
    const metadata = objectMetadata();
    const service = facadeFetcher(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/list")) {
        return Response.json({
          objects: [metadata],
          delimitedPrefixes: ["uploads/folder/"],
          truncated: true,
          cursor: "next",
        });
      }
      if (url.pathname.endsWith("/multipart/create")) {
        return Response.json({ key: metadata.key, uploadId: "upload-1" });
      }
      if (url.pathname.endsWith("/multipart/part")) {
        expect(url.searchParams.get("partNumber")).toBe("1");
        expect(await request.text()).toBe("part-one");
        return Response.json({ partNumber: 1, etag: "part-etag" });
      }
      if (url.pathname.endsWith("/multipart/complete")) {
        return new Response(null, {
          headers: { [OBJECT_METADATA_HEADER]: encodeObjectMetadata(metadata) },
        });
      }
      return new Response(null, { status: 204 });
    });
    const bucket = new ServiceR2Bucket(service, "R2_BUCKET");

    await expect(bucket.list({ prefix: "uploads/" })).resolves.toMatchObject({
      objects: [{ key: metadata.key }],
      delimitedPrefixes: ["uploads/folder/"],
      truncated: true,
      cursor: "next",
    });
    const upload = await bucket.createMultipartUpload(metadata.key);
    await expect(upload.uploadPart(1, "part-one")).resolves.toEqual({
      partNumber: 1,
      etag: "part-etag",
    });
    await expect(upload.complete([{ partNumber: 1, etag: "part-etag" }])).resolves.toMatchObject({
      key: metadata.key,
    });
  });
});

describe("compute facade", () => {
  it("maps sandbox RPC and file streaming onto the shared service", async () => {
    const service = facadeFetcher(async (request) => {
      const url = new URL(request.url);
      expect(url.searchParams.get("kind")).toBe("project-build");
      expect(url.searchParams.get("id")).toBe("org:one");
      if (url.pathname.endsWith("/rpc")) {
        const body = await request.json() as { method: string; args: unknown[] };
        return Response.json({ method: body.method, args: body.args, exitCode: 0 });
      }
      if (request.method === "PUT") {
        expect(url.searchParams.get("path")).toBe("/workspace/app.ts");
        expect(await request.text()).toBe("export default {};");
        return Response.json({ written: true });
      }
      return new Response("export default {};", {
        headers: {
          "content-type": "text/typescript",
          "x-camelai-file-size": "18",
        },
      });
    });
    const sandbox = new ServiceSandboxClient(service, "project-build", "org:one");

    await expect(sandbox.exec("bun run build", { cwd: "/workspace" })).resolves.toMatchObject({
      method: "exec",
      args: ["bun run build", { cwd: "/workspace" }],
      exitCode: 0,
    });
    await expect(sandbox.writeFile("/workspace/app.ts", "export default {};"))
      .resolves.toEqual({ written: true });
    await expect(sandbox.readFile("/workspace/app.ts")).resolves.toEqual({
      content: "export default {};",
      size: 18,
      mimeType: "text/typescript",
    });
  });
});

describe("artifacts and managed binding facades", () => {
  it("supports repository and token operations", async () => {
    const service = facadeFetcher(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/repos")) {
        return Response.json({
          name: "repo-one",
          remote: "https://artifacts.internal/repo-one.git",
          status: "ready",
        });
      }
      if (url.pathname.endsWith("/repo")) {
        expect(url.searchParams.get("name")).toBe("repo-one");
        return Response.json({
          name: "repo-one",
          remote: "https://artifacts.internal/repo-one.git",
          status: "ready",
        });
      }
      expect(url.pathname).toMatch(/\/tokens$/);
      expect(url.searchParams.get("name")).toBe("repo-one");
      return Response.json({ plaintext: "token", expiresAt: "2026-08-24T00:00:00Z" });
    });
    const artifacts = new ServiceArtifactsBinding(service);

    await expect(artifacts.create("repo-one")).resolves.toMatchObject({ name: "repo-one" });
    const repo = await artifacts.get("repo-one");
    await expect(repo.createToken("write", 300)).resolves.toEqual({
      plaintext: "token",
      expiresAt: "2026-08-24T00:00:00Z",
    });
  });

  it("preserves logical names for AI, email, queue, and pipeline calls", async () => {
    const calls: Array<{ path: string; body: unknown }> = [];
    const service = facadeFetcher(async (request) => {
      calls.push({
        path: new URL(request.url).pathname,
        body: await request.json(),
      });
      return Response.json(
        new URL(request.url).pathname.endsWith("/run")
          ? { response: "ok" }
          : {},
      );
    });

    await resolveAiBinding({ AI_SERVICE: service })?.run("auto", { prompt: "hello" });
    await resolveEmailBinding({ EMAIL_SERVICE: service })?.send({ to: "user@example.com" });
    await resolveQueueBinding({ QUEUE_SERVICE: service }, "APP_SCREENSHOT_QUEUE")?.send({ id: 1 });
    await resolveLakeStream({ PIPELINE_SERVICE: service }, "TRANSCRIPT_LAKE")?.send([{ id: 2 }]);

    expect(calls).toEqual([
      {
        path: "/v1/ai/run",
        body: { model: "auto", input: { prompt: "hello" } },
      },
      {
        path: "/v1/email/send",
        body: { message: { to: "user@example.com" } },
      },
      {
        path: "/v1/queues/send",
        body: { binding: "APP_SCREENSHOT_QUEUE", message: { id: 1 } },
      },
      {
        path: "/v1/pipelines/send",
        body: { binding: "TRANSCRIPT_LAKE", records: [{ id: 2 }] },
      },
    ]);
  });

  it("wraps the browser protocol and quick actions under its capability", async () => {
    const service = facadeFetcher(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/binding")) {
        expect(url.searchParams.get("url")).toBe("https://browser.internal/session");
        expect(await request.text()).toBe("protocol-body");
        return new Response("protocol-response");
      }
      expect(url.pathname).toBe("/v1/browser/quick-action");
      expect(await request.json()).toEqual({
        action: "content",
        options: { url: "https://example.com" },
      });
      return new Response("page content");
    });
    const browser = resolveBrowserBinding({ BROWSER_SERVICE: service });

    const protocol = await browser?.fetch(new Request(
      "https://browser.internal/session",
      { method: "POST", body: "protocol-body" },
    ));
    expect(await protocol?.text()).toBe("protocol-response");
    const content = await browser?.quickAction?.("content", { url: "https://example.com" });
    expect(await content?.text()).toBe("page content");
  });
});

describe("images facade", () => {
  it("transports image transforms and reproduces raw and base64 outputs", async () => {
    const outputBytes = new Uint8Array([1, 2, 3, 4]);
    const service = facadeFetcher(async (request) => {
      expect(new URL(request.url).pathname).toBe("/v1/images/transform");
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]));
      expect(request.headers.get("x-camelai-image-options")).toBeTruthy();
      return new Response(outputBytes, { headers: { "content-type": "image/png" } });
    });
    const images = new ServiceImagesBinding(service);
    const input = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([9, 8, 7]));
        controller.close();
      },
    });

    const result = await images
      .input(input)
      .transform({ width: 64, height: 64, fit: "scale-down" })
      .output({ format: "image/png" });
    expect(result.contentType()).toBe("image/png");
    expect(new Uint8Array(await result.response().arrayBuffer())).toEqual(outputBytes);
    expect(await new Response(result.image({ encoding: "base64" })).text()).toBe("AQIDBA");
  });
});

describe("celld facade proxy", () => {
  it("rejects unknown capabilities and missing gateway configuration", async () => {
    await expect(celldFacadeWorker.fetch(
      new Request("https://facade.internal/v1/unknown/path"),
      {},
    ).then((response) => response.status)).resolves.toBe(404);
    await expect(celldFacadeWorker.fetch(
      new Request("https://facade.internal/v1/object-store/object"),
      {},
    ).then((response) => response.status)).resolves.toBe(503);
    await expect(celldFacadeWorker.fetch(
      new Request("https://facade.internal/v1/object-store/object"),
      { FACADE_GATEWAY_URL: "https://gateway.internal" },
    ).then((response) => response.status)).resolves.toBe(503);
    await expect(celldFacadeWorker.fetch(
      new Request("https://facade.internal/__celld/health"),
      { FACADE_GATEWAY_URL: "https://gateway.internal" },
    ).then((response) => response.status)).resolves.toBe(503);
  });

  it("forwards allowlisted streams to the configured gateway prefix", async () => {
    const originalFetch = globalThis.fetch;
    const gatewayFetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const forwarded = request instanceof Request ? request : new Request(request, init);
      expect(forwarded.url).toBe(
        "https://gateway.internal/camelai/v1/object-store/object?binding=R2_BUCKET&key=a.txt",
      );
      expect(forwarded.headers.get("authorization")).toBe("Bearer secret");
      expect(forwarded.headers.get("x-camelai-facade-capability")).toBe("object-store");
      expect(await forwarded.text()).toBe("payload");
      return new Response("stored");
    });
    globalThis.fetch = gatewayFetch as typeof fetch;
    try {
      const response = await celldFacadeWorker.fetch(
        new Request(
          "https://facade.internal/v1/object-store/object?binding=R2_BUCKET&key=a.txt",
          { method: "PUT", body: "payload" },
        ),
        {
          FACADE_GATEWAY_URL: "https://gateway.internal/camelai/",
          FACADE_GATEWAY_TOKEN: "secret",
        },
      );
      expect(await response.text()).toBe("stored");
      expect(gatewayFetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("reports ready only after the authenticated host gateway is healthy", async () => {
    const originalFetch = globalThis.fetch;
    const gatewayFetch = vi.fn(async (request: RequestInfo | URL, init?: RequestInit) => {
      const forwarded = request instanceof Request ? request : new Request(request, init);
      expect(forwarded.url).toBe("https://gateway.internal/camelai/__celld/health");
      expect(forwarded.headers.get("authorization")).toBe("Bearer secret");
      return Response.json({ ok: true });
    });
    globalThis.fetch = gatewayFetch as typeof fetch;
    try {
      const response = await celldFacadeWorker.fetch(
        new Request("https://facade.internal/__celld/health"),
        {
          FACADE_GATEWAY_URL: "https://gateway.internal/camelai/",
          FACADE_GATEWAY_TOKEN: "secret",
        },
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        gatewayStatus: 200,
      });
      expect(gatewayFetch).toHaveBeenCalledOnce();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
