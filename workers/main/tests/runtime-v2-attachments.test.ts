/**
 * Tests for CamelRun v2 upload attachment handling, including automatic
 * server-side image resizing via Cloudflare Images and graceful degradation
 * for oversized/invalid attachments.
 *
 * Run with: bun run test:workers -- workers/main/tests/runtime-v2-attachments.test.ts
 */
import { Buffer } from "node:buffer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import { CAMEL_CODE_LLM_MODEL } from "../../../src/lib/llm-provider-config";
import { buildWorkspaceScopedR2Key } from "../../../src/lib/workspace-r2-paths";
import type { ChatContextState, ChatEnv } from "../src/chat-thread/types";
import { CAMEL_CODE_RUNTIME_MODEL } from "../src/agent-runtime/model-routes";
import { attachV2Uploads, V2_REQUEST_IMAGE_BYTES } from "../src/agent-runtime/runtime-v2";
import { startRuntimeTurn } from "../src/agent-runtime/thread-runtime";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;
const V2_ORIGIN = "https://run.camelai.com";
const FAKE_COMMIT = "a".repeat(64);

// Minimal valid PNG header (8-byte signature + 13-byte IHDR chunk header)
function fakePngBytes(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(32, totalBytes));
  bytes.set([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  ], 0);
  return bytes;
}

// Minimal valid JPEG header (SOI + APP0)
function fakeJpegBytes(totalBytes: number): Uint8Array {
  const bytes = new Uint8Array(Math.max(16, totalBytes));
  bytes.set([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46], 0);
  return bytes;
}

function makeFakeImagesBinding(
  handler: (options: {
    transform: ImageTransform | undefined;
    output: ImageOutputOptions;
    inputSize: number;
  }) => Response,
): ImagesBinding {
  return {
    info: vi.fn(),
    input(stream: ReadableStream<Uint8Array>) {
      let transformOpt: ImageTransform | undefined;
      const transformer: ImageTransformer = {
        transform(next) {
          transformOpt = next;
          return transformer;
        },
        draw() {
          return transformer;
        },
        async output(outputOpt) {
          const inputBytes = new Uint8Array(await new Response(stream).arrayBuffer());
          const response = handler({ transform: transformOpt, output: outputOpt, inputSize: inputBytes.byteLength });
          return {
            response: () => response,
            contentType: () => response.headers.get("content-type") ?? outputOpt.format,
            image: () => response.body ?? new ReadableStream(),
          };
        },
      };
      return transformer;
    },
  } as unknown as ImagesBinding;
}

function baseV2Env(overrides: Partial<ChatEnv> = {}): ChatEnv {
  return {
    ...(env as unknown as ChatEnv),
    WORKER_BASE_URL: "https://camelai.dev",
    AGENT_RUNTIME_URL: "https://runtime.test",
    AGENT_RUNTIME_API_TOKEN: "operator-token",
    AGENT_RUNTIME_TENANT: "chiridion-test",
    AGENT_RUNTIME_DEFINITION: "def_test",
    AGENT_RUNTIME_V2_TENANT: "test-v2",
    AGENT_RUNTIME_V2_API_TOKEN: "test-v2-key",
    AGENT_RUNTIME_V2_EVENTS_WEBHOOK_SECRET: "test-v2-secret",
    AGENT_RUNTIME_V2_ADDITIONAL_MODELS: CAMEL_CODE_RUNTIME_MODEL,
    CF_ACCOUNT_ID: "acct",
    CF_GATEWAY_NAME: "gw",
    AI_GATEWAY_AUTH_TOKEN: "gw-token",
    ...overrides,
  };
}

function makeContext(suffix = crypto.randomUUID()): ChatContextState {
  return {
    orgId: `org_${suffix}`,
    workspaceId: `ws_${suffix}`,
    threadId: `thr_${suffix}`,
    userId: `usr_${suffix}`,
    userName: "Test User",
    userEmail: "test@example.com",
  };
}

function mockV2RepoWrites() {
  const writes: Array<{ ref: string; puts: Array<{ path: string; base64: string }> }> = [];
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== V2_ORIGIN) {
      throw new Error(`Unexpected fetch to ${url.toString()}`);
    }
    const method = init?.method ?? "GET";
    if (method === "PUT" && url.pathname.endsWith("/repo")) {
      return Response.json({ repoId: "repo_1", branch: "main" });
    }
    if (method === "POST" && url.pathname === "/v2/repos/repo_1/write") {
      const body = JSON.parse(String(init?.body)) as { ref: string; puts: Array<{ path: string; base64: string }> };
      writes.push(body);
      return Response.json({ commit: FAKE_COMMIT });
    }
    return Response.json({}, { status: 404 });
  });
  return { writes, fetchSpy };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("attachV2Uploads", () => {
  it("attaches valid images within the model limit directly without invoking IMAGES", async () => {
    const context = makeContext();
    const png = fakePngBytes(2048);
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/chart-1790000000000-ab12cd.png"),
      png,
      { httpMetadata: { contentType: "image/png" } },
    );
    const imagesMock = makeFakeImagesBinding(() => {
      throw new Error("IMAGES should not be called for small valid images");
    });
    const { writes } = mockV2RepoWrites();

    const files = await attachV2Uploads(
      baseV2Env({ IMAGES: imagesMock }),
      context,
      "agt_1",
      "initial_thread_1",
      "Check this (user uploaded file to uploads/chart-1790000000000-ab12cd.png)",
    );

    expect(files).toEqual([
      {
        path: "uploads/initial_thread_1/1-chart.png",
        contentType: "image/png",
        commit: FAKE_COMMIT,
      },
    ]);
    expect(writes).toHaveLength(1);
    expect(Buffer.from(writes[0].puts[0].base64, "base64").byteLength).toBe(2048);
  });

  it("resizes oversized PNGs (even > 8 MiB) via env.IMAGES to a JPEG under the v2 image limit", async () => {
    const context = makeContext();
    // 9 MiB PNG — exceeds both v2's 3.75 MiB request image cap and the 8 MiB repo-write cap!
    const hugePng = fakePngBytes(9 * 1024 * 1024);
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/IMG_3083-1790000000000-ab12cd.png"),
      hugePng,
      { httpMetadata: { contentType: "image/png" } },
    );

    const resizeAttempts: Array<{ width?: number; quality?: number; inputSize: number }> = [];
    const resizedJpeg = fakeJpegBytes(180_000);
    const imagesMock = makeFakeImagesBinding(({ transform, output, inputSize }) => {
      resizeAttempts.push({ width: transform?.width, quality: output.quality, inputSize });
      return new Response(resizedJpeg, { headers: { "content-type": "image/jpeg" } });
    });
    const { writes } = mockV2RepoWrites();

    const files = await attachV2Uploads(
      baseV2Env({ IMAGES: imagesMock }),
      context,
      "agt_1",
      "initial_9024e085-9977-4ff1-b7be-80fbd8eacd78",
      "What is in this screenshot? (user uploaded file to uploads/IMG_3083-1790000000000-ab12cd.png)",
    );

    expect(resizeAttempts).toEqual([
      { width: 1568, quality: 80, inputSize: 9 * 1024 * 1024 },
    ]);
    expect(files).toEqual([
      {
        path: "uploads/initial_9024e085-9977-4ff1-b7be-80fbd8eacd78/1-IMG_3083.jpg",
        contentType: "image/jpeg",
        commit: FAKE_COMMIT,
      },
    ]);
    expect(writes).toHaveLength(1);
    expect(Buffer.from(writes[0].puts[0].base64, "base64").byteLength).toBe(180_000);
  });

  it("retries with smaller dimensions when the first IMAGES resize still exceeds the byte budget", async () => {
    const context = makeContext();
    const oversizedPng = fakePngBytes(V2_REQUEST_IMAGE_BYTES + 500_000);
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/dense-1790000000000-ab12cd.png"),
      oversizedPng,
      { httpMetadata: { contentType: "image/png" } },
    );

    const attemptedWidths: Array<number | undefined> = [];
    const imagesMock = makeFakeImagesBinding(({ transform }) => {
      attemptedWidths.push(transform?.width);
      if ((transform?.width ?? 0) >= 1568) {
        return new Response(fakeJpegBytes(V2_REQUEST_IMAGE_BYTES + 10_000), {
          headers: { "content-type": "image/jpeg" },
        });
      }
      return new Response(fakeJpegBytes(220_000), {
        headers: { "content-type": "image/jpeg" },
      });
    });
    mockV2RepoWrites();

    const files = await attachV2Uploads(
      baseV2Env({ IMAGES: imagesMock }),
      context,
      "agt_1",
      "req_retry_resize",
      "(user uploaded file to uploads/dense-1790000000000-ab12cd.png)",
    );

    expect(attemptedWidths).toEqual([1568, 1280]);
    expect(files).toEqual([
      {
        path: "uploads/req_retry_resize/1-dense.jpg",
        contentType: "image/jpeg",
        commit: FAKE_COMMIT,
      },
    ]);
  });

  it("skips oversized images gracefully without throwing when IMAGES is unavailable", async () => {
    const context = makeContext();
    const oversizedPng = fakePngBytes(V2_REQUEST_IMAGE_BYTES + 100_000);
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/big-1790000000000-ab12cd.png"),
      oversizedPng,
      { httpMetadata: { contentType: "image/png" } },
    );
    const { writes, fetchSpy } = mockV2RepoWrites();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const files = await attachV2Uploads(
      baseV2Env({ IMAGES: undefined }),
      context,
      "agt_1",
      "req_no_images",
      "(user uploaded file to uploads/big-1790000000000-ab12cd.png)",
    );

    expect(files).toEqual([]);
    expect(writes).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("uses sniffed magic bytes for mislabeled images and downgrades non-image bytes claiming image/png", async () => {
    const context = makeContext();
    // JPEG bytes stored with image/png metadata
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/mislabeled-1790000000000-ab12cd.png"),
      fakeJpegBytes(512),
      { httpMetadata: { contentType: "image/png" } },
    );
    // Plain text stored with image/png metadata
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/notpng-1790000000001-ef34gh.png"),
      "not actually a png",
      { httpMetadata: { contentType: "image/png" } },
    );
    mockV2RepoWrites();

    const files = await attachV2Uploads(
      baseV2Env({ IMAGES: undefined }),
      context,
      "agt_1",
      "req_sniff",
      "(user uploaded file to uploads/mislabeled-1790000000000-ab12cd.png) (user uploaded file to uploads/notpng-1790000000001-ef34gh.png)",
    );

    expect(files).toEqual([
      {
        path: "uploads/req_sniff/1-mislabeled.png",
        contentType: "image/jpeg",
        commit: FAKE_COMMIT,
      },
      {
        path: "uploads/req_sniff/2-notpng.png",
        contentType: "application/octet-stream",
        commit: FAKE_COMMIT,
      },
    ]);
  });

  it("skips unsafe, missing, zero-byte, and > 8 MiB non-image files while still attaching valid files", async () => {
    const context = makeContext();
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/script-1790000000000-ab12cd.exe"),
      "MZ",
      { httpMetadata: { contentType: "application/octet-stream" } },
    );
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/empty-1790000000001-ef34gh.png"),
      new Uint8Array(0),
      { httpMetadata: { contentType: "image/png" } },
    );
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/huge-1790000000002-ij56kl.csv"),
      new Uint8Array(9 * 1024 * 1024),
      { httpMetadata: { contentType: "text/csv" } },
    );
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(context.orgId, context.workspaceId, "user-uploads/notes-1790000000003-mn78op.txt"),
      "hello",
      { httpMetadata: { contentType: "text/plain" } },
    );
    mockV2RepoWrites();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const files = await attachV2Uploads(
      baseV2Env({ IMAGES: undefined }),
      context,
      "agt_1",
      "req_mixed",
      [
        "(user uploaded file to uploads/script-1790000000000-ab12cd.exe)",
        "(user uploaded file to uploads/missing-1790000000009-zz99yy.png)",
        "(user uploaded file to uploads/empty-1790000000001-ef34gh.png)",
        "(user uploaded file to uploads/huge-1790000000002-ij56kl.csv)",
        "(user uploaded file to uploads/notes-1790000000003-mn78op.txt)",
      ].join(" "),
    );

    expect(files).toEqual([
      {
        path: "uploads/req_mixed/5-notes.txt",
        contentType: "text/plain",
        commit: FAKE_COMMIT,
      },
    ]);
    warnSpy.mockRestore();
  });
});

describe("startRuntimeTurn v2 attachment_size fallback", () => {
  it("retries a v2 run without native image attachments if CamelRun v2 still responds 413 attachment_size", async () => {
    const email = `v2-img-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
    const { userId } = await createUser(testEnv, email, "password123", "V2 Sender");
    const { org, defaultWorkspaceId } = await createOrg(testEnv, "V2 Org", userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId as string, "V2 Image Thread", userId);
    await orgStub.updateThreadModel(thread.id, CAMEL_CODE_LLM_MODEL);
    await orgStub.pinThreadRuntime(thread.id, null, "v2");

    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(org.id, defaultWorkspaceId as string, "user-uploads/shot-1790000000000-ab12cd.png"),
      fakePngBytes(1024),
      { httpMetadata: { contentType: "image/png" } },
    );
    await testEnv.R2_BUCKET.put(
      buildWorkspaceScopedR2Key(org.id, defaultWorkspaceId as string, "user-uploads/data-1790000000001-ef34gh.csv"),
      "a,b\n1,2\n",
      { httpMetadata: { contentType: "text/csv" } },
    );

    const runBodies: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.origin !== V2_ORIGIN) return originalFetch(input, init);
      const method = init?.method ?? "GET";
      if (method === "PUT" && url.pathname === `/v2/agents/chiridion-thread-${thread.id}`) {
        return Response.json({ id: "agt_v2_img" });
      }
      if (method === "PUT" && url.pathname === "/v2/agents/agt_v2_img/repo") {
        return Response.json({ repoId: "repo_1", branch: "main" });
      }
      if (method === "POST" && url.pathname === "/v2/repos/repo_1/write") {
        return Response.json({ commit: FAKE_COMMIT });
      }
      if (method === "POST" && url.pathname === "/v2/agents/agt_v2_img/runs") {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        runBodies.push(body);
        if (runBodies.length === 1) {
          return Response.json(
            { error: { code: "attachment_size", message: "Image uploads/cm_v2/1-shot.png exceeds the model request image limit" } },
            { status: 413 },
          );
        }
        return Response.json({ id: "run_2", idempotencyKey: "cm_v2", status: "queued" });
      }
      return Response.json({}, { status: 404 });
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const row = (await orgStub.getThreadRuntime(thread.id))!;
    const result = await startRuntimeTurn(baseV2Env(), {
      context: {
        orgId: org.id,
        workspaceId: defaultWorkspaceId as string,
        threadId: thread.id,
        userId,
        userName: "V2 Sender",
        userEmail: email,
      },
      row,
      sender: { userId, userName: "V2 Sender", userEmail: email },
      text: "Check (user uploaded file to uploads/shot-1790000000000-ab12cd.png) and (user uploaded file to uploads/data-1790000000001-ef34gh.csv)",
      clientMessageId: "cm_v2",
      waitUntil: () => {},
    });
    warnSpy.mockRestore();

    expect(result).toMatchObject({ status: "accepted", agentId: "agt_v2_img" });
    expect(runBodies).toHaveLength(2);
    expect(runBodies[0].files).toHaveLength(2);
    expect(runBodies[1].files).toEqual([
      {
        path: "uploads/cm_v2/2-data.csv",
        contentType: "text/csv",
        commit: FAKE_COMMIT,
      },
    ]);
  });
});
