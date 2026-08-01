import { describe, expect, it, vi } from "vitest";
import {
  proxyCloudflareApi,
  type CfApiProxyEnv,
} from "../src/cf-api-proxy";
import { selfhostWorkerKey, type SelfhostWorkerRecord } from "../src/selfhost-worker-registry";

class MemoryKv {
  store = new Map<string, string>();

  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

function makeNamespace<T>(stub: T) {
  return {
    idFromName: (name: string) => name,
    get: () => stub,
  };
}

function multipartBody(parts: Array<{
  name: string;
  body: string | Uint8Array;
  filename?: string;
  contentType?: string;
}>): { body: Uint8Array; contentType: string } {
  const boundary = "----camelai-selfhost-test";
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const part of parts) {
      const disposition = [
        `name="${part.name}"`,
        part.filename ? `filename="${part.filename}"` : null,
      ].filter(Boolean).join("; ");
      const headers = [
        `Content-Disposition: form-data; ${disposition}`,
        part.contentType ? `Content-Type: ${part.contentType}` : null,
      ].filter(Boolean).join("\r\n");
    chunks.push(encoder.encode(`--${boundary}\r\n${headers}\r\n\r\n`));
    chunks.push(typeof part.body === "string" ? encoder.encode(part.body) : part.body);
    chunks.push(encoder.encode("\r\n"));
  }
  chunks.push(encoder.encode(`--${boundary}--\r\n`));
  const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return {
    body,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

function makeEnv(
  kv: MemoryKv,
  overrides: Partial<CfApiProxyEnv> = {},
): CfApiProxyEnv {
  const orgStub = {
    getSlug: vi.fn(async () => "acme"),
    getWorkerScript: vi.fn(async () => null),
    getInfo: vi.fn(async () => null),
    listWorkerScriptsByWorkspace: vi.fn(async () => []),
  };

  return {
    CF_ACCOUNT_ID: "selfhost",
    CF_DISPATCH_NAMESPACE: "selfhost",
    CF_WORKER_NAME: "chiridion-selfhost",
    TOKEN_SIGNING_SECRET: "test-token-secret",
    INTEGRATION_SECRET_KEY: "test-integration-secret",
    APP_KV: kv as unknown as KVNamespace,
    EMAIL_TO_USER: kv as unknown as KVNamespace,
    R2_BUCKET: {} as unknown as R2Bucket,
    ORG: makeNamespace(orgStub) as unknown as CfApiProxyEnv["ORG"],
    WORKSPACE: makeNamespace({}) as unknown as CfApiProxyEnv["WORKSPACE"],
    WORKSPACE_FS: makeNamespace({}) as unknown as CfApiProxyEnv["WORKSPACE_FS"],
    CHAT_THREAD: makeNamespace({}) as unknown as CfApiProxyEnv["CHAT_THREAD"],
    ...overrides,
  };
}

describe("proxyCloudflareApi self-host publishing", () => {
  it("returns a local token verification response", async () => {
    const kv = new MemoryKv();
    const response = await proxyCloudflareApi(
      new Request("https://app.local/client/v4/accounts/selfhost/tokens/verify", {
        method: "GET",
      }),
      makeEnv(kv),
      {
        trustedIdentity: {
          orgId: "org_1",
          orgSlug: "acme",
          workspaceId: "workspace_1",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      result: { status: "active" },
    });
  });

  it("rewrites direct script secret reads to a local dispatch secret list", async () => {
    const kv = new MemoryKv();
    const response = await proxyCloudflareApi(
      new Request("https://app.local/client/v4/accounts/selfhost/workers/scripts/demo/secrets", {
        method: "GET",
      }),
      makeEnv(kv),
      {
        trustedIdentity: {
          orgId: "org_1",
          orgSlug: "acme",
          workspaceId: "workspace_1",
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      result: [],
    });
  });

  it("returns a JWT-shaped local asset upload token", async () => {
    const kv = new MemoryKv();
    const response = await proxyCloudflareApi(
      new Request("https://app.local/client/v4/accounts/selfhost/workers/dispatch/namespaces/selfhost/scripts/demo/assets-upload-session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          manifest: {
            "index.html": { hash: "hash-1", size: 12 },
          },
        }),
      }),
      makeEnv(kv),
      {
        trustedIdentity: {
          orgId: "org_1",
          orgSlug: "acme",
          workspaceId: "workspace_1",
        },
      },
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json() as {
      success: boolean;
      result: { jwt: string; buckets: string[][] };
    };
    expect(responseBody.success).toBe(true);
    expect(responseBody.result.jwt.split(".")).toHaveLength(3);
    const payload = JSON.parse(Buffer.from(responseBody.result.jwt.split(".")[1]!, "base64").toString());
    expect(payload.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(payload.max_file_count_allowed).toBe(1);
    expect(responseBody.result.buckets).toEqual([["hash-1"]]);
  });

  it("stores module worker uploads in the self-host worker registry", async () => {
    const kv = new MemoryKv();
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2026-06-09",
      compatibility_flags: ["nodejs_compat"],
      bindings: [
        { type: "plain_text", name: "GREETING", text: "hello" },
        { type: "worker_loader", name: "LOADER" },
        { type: "kv_namespace", name: "KV", namespace_id: "messages" },
        { type: "r2_bucket", name: "BUCKET", bucket_name: "files" },
        { type: "assets", name: "ASSETS" },
        { type: "ai", name: "AI" },
        { type: "service", name: "DATA_PROXY", service: "demo", entrypoint: "LocalDataProxyService" },
        { type: "service", name: "CONNECTIONS", service: "demo", entrypoint: "LocalConnectionsService" },
        { type: "service", name: "CAMELAI", service: "demo", entrypoint: "LocalCamelAiService" },
        { type: "durable_object_namespace", name: "COUNTER", class_name: "Counter" },
      ],
    };
    const upload = multipartBody([
      { name: "metadata", body: JSON.stringify(metadata) },
      {
        name: "index.js",
        filename: "index.js",
        contentType: "application/javascript+module",
        body: "export default { fetch() { return new Response('ok') } };",
      },
    ]);

    const response = await proxyCloudflareApi(
      new Request("https://app.local/client/v4/accounts/wrangler/workers/dispatch/namespaces/wrangler/scripts/demo", {
        method: "PUT",
        headers: { "content-type": upload.contentType },
        body: upload.body,
      }),
      makeEnv(kv),
      {
        trustedIdentity: {
          orgId: "org_1",
          orgSlug: "acme",
          workspaceId: "workspace_1",
        },
        onDeploySideEffects: vi.fn(async () => {}),
      },
    );

    expect(response.status).toBe(200);
    const responseBody = await response.json() as {
      success: boolean;
      result: { script_name: string; deployment_id: string };
    };
    expect(responseBody.success).toBe(true);
    expect(responseBody.result.script_name).toBe("demo--acme");

    const stored = await kv.get(selfhostWorkerKey("demo--acme"));
    expect(stored).toBeTruthy();
    const record = JSON.parse(stored!) as SelfhostWorkerRecord;
    expect(record).toMatchObject({
      appId: "demo--acme",
      scriptName: "demo",
      dispatchScriptName: "demo--acme",
      orgId: "org_1",
      orgSlug: "acme",
      workspaceId: "workspace_1",
      compatibilityDate: "2026-06-09",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "index.js",
    });
    expect(responseBody.result.deployment_id).toBe(record.version);
    expect(record.modules["index.js"]).toMatchObject({
      name: "index.js",
      type: "js",
      content: "export default { fetch() { return new Response('ok') } };",
    });
    expect(record.bindings).toEqual([
      { type: "plain_text", name: "GREETING", text: "hello" },
      {
        type: "service",
        name: "KV",
        service: "chiridion-selfhost",
        entrypoint: "KVVirtualNamespace",
        props: { workspaceId: "workspace_1", appId: "demo--acme", namespaceId: "messages" },
      },
      {
        type: "service",
        name: "BUCKET",
        service: "chiridion-selfhost",
        entrypoint: "R2VirtualBucket",
        props: { workspaceId: "workspace_1", bucketName: "files" },
      },
      {
        type: "service",
        name: "ASSETS",
        service: "chiridion-selfhost",
        entrypoint: "AssetsVirtualBinding",
        props: { appId: "demo--acme" },
      },
      {
        type: "service",
        name: "AI",
        service: "chiridion-selfhost",
        entrypoint: "AIVirtualBinding",
        props: { workspaceId: "workspace_1", orgId: "org_1" },
      },
      {
        type: "service",
        name: "DATA_PROXY",
        service: "chiridion-selfhost",
        entrypoint: "DataProxyService",
        props: { workspaceId: "workspace_1", orgId: "org_1" },
      },
      {
        type: "service",
        name: "CONNECTIONS",
        service: "chiridion-selfhost",
        entrypoint: "ConnectionsService",
        props: { workspaceId: "workspace_1", orgId: "org_1" },
      },
      {
        type: "service",
        name: "CAMELAI",
        service: "chiridion-selfhost",
        entrypoint: "CamelAiService",
        props: { workspaceId: "workspace_1", orgId: "org_1" },
      },
      { type: "durable_object_namespace", name: "COUNTER", class_name: "Counter" },
    ]);
    expect(record.bindings).not.toContainEqual({ type: "worker_loader", name: "LOADER" });
  });

  it("omits CONNECTIONS from stored self-host workers when the binding is disabled", async () => {
    const kv = new MemoryKv();
    const metadata = {
      main_module: "index.js",
      compatibility_date: "2026-06-09",
      bindings: [
        { type: "service", name: "CONNECTIONS", service: "demo", entrypoint: "LocalConnectionsService" },
        { type: "service", name: "CAMELAI", service: "demo", entrypoint: "LocalCamelAiService" },
      ],
    };
    const upload = multipartBody([
      { name: "metadata", body: JSON.stringify(metadata) },
      {
        name: "index.js",
        filename: "index.js",
        contentType: "application/javascript+module",
        body: "export default { fetch() { return new Response('ok') } };",
      },
    ]);

    const response = await proxyCloudflareApi(
      new Request("https://app.local/client/v4/accounts/wrangler/workers/dispatch/namespaces/wrangler/scripts/locked", {
        method: "PUT",
        headers: { "content-type": upload.contentType },
        body: upload.body,
      }),
      makeEnv(kv, { CONNECTIONS_BINDING_ENABLED: "false" }),
      {
        trustedIdentity: {
          orgId: "org_1",
          orgSlug: "acme",
          workspaceId: "workspace_1",
        },
        onDeploySideEffects: vi.fn(async () => {}),
      },
    );

    expect(response.status).toBe(200);
    const stored = await kv.get(selfhostWorkerKey("locked--acme"));
    expect(stored).toBeTruthy();
    const record = JSON.parse(stored!) as SelfhostWorkerRecord;
    expect(record.bindings.find((binding) => binding.name === "CONNECTIONS")).toBeUndefined();
    expect(record.bindings).toEqual([
      {
        type: "service",
        name: "CAMELAI",
        service: "chiridion-selfhost",
        entrypoint: "CamelAiService",
        props: { workspaceId: "workspace_1", orgId: "org_1" },
      },
    ]);
  });

  it("preserves binary module and blob bytes for self-host uploads", async () => {
    const kv = new MemoryKv();
    const wasmBytes = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const dataBytes = new Uint8Array([0x00, 0x9f, 0x92, 0x96, 0xff]);
    const metadata = {
      main_module: "index.js",
      bindings: [
        { type: "wasm_module", name: "WASM", part: "module.wasm" },
        { type: "text_blob", name: "TEXT", part: "message.txt" },
        { type: "data_blob", name: "DATA", part: "payload.bin" },
      ],
    };
    const upload = multipartBody([
      { name: "metadata", body: JSON.stringify(metadata) },
      {
        name: "index.js",
        filename: "index.js",
        contentType: "application/javascript+module",
        body: "export default { fetch() { return new Response('ok') } };",
      },
      {
        name: "module.wasm",
        filename: "module.wasm",
        contentType: "application/wasm",
        body: wasmBytes,
      },
      {
        name: "message.txt",
        filename: "message.txt",
        contentType: "text/plain",
        body: "hello text blob",
      },
      {
        name: "payload.bin",
        filename: "payload.bin",
        contentType: "application/octet-stream",
        body: dataBytes,
      },
    ]);

    const response = await proxyCloudflareApi(
      new Request("https://app.local/client/v4/accounts/wrangler/workers/dispatch/namespaces/wrangler/scripts/demo", {
        method: "PUT",
        headers: { "content-type": upload.contentType },
        body: upload.body,
      }),
      makeEnv(kv),
      {
        trustedIdentity: {
          orgId: "org_1",
          orgSlug: "acme",
          workspaceId: "workspace_1",
        },
        onDeploySideEffects: vi.fn(async () => {}),
      },
    );

    expect(response.status).toBe(200);
    const stored = await kv.get(selfhostWorkerKey("demo--acme"));
    expect(stored).toBeTruthy();
    const record = JSON.parse(stored!) as SelfhostWorkerRecord;
    expect(record.modules["module.wasm"]).toMatchObject({
      name: "module.wasm",
      type: "wasm",
      content: Buffer.from(wasmBytes).toString("base64"),
    });
    expect(record.modules["message.txt"]).toMatchObject({
      name: "message.txt",
      type: "text",
      content: "hello text blob",
    });
    expect(record.modules["payload.bin"]).toMatchObject({
      name: "payload.bin",
      type: "data",
      content: Buffer.from(dataBytes).toString("base64"),
    });
  });

  it("rejects self-host uploads with forbidden external bindings", async () => {
    const kv = new MemoryKv();
    const upload = multipartBody([
      {
        name: "metadata",
        body: JSON.stringify({
          main_module: "index.js",
          bindings: [{ type: "queue", name: "QUEUE" }],
        }),
      },
      {
        name: "index.js",
        filename: "index.js",
        contentType: "application/javascript+module",
        body: "export default { fetch() { return new Response('ok') } };",
      },
    ]);

    const response = await proxyCloudflareApi(
      new Request("https://app.local/client/v4/accounts/wrangler/workers/dispatch/namespaces/wrangler/scripts/demo", {
        method: "PUT",
        headers: { "content-type": upload.contentType },
        body: upload.body,
      }),
      makeEnv(kv),
      {
        trustedIdentity: {
          orgId: "org_1",
          orgSlug: "acme",
          workspaceId: "workspace_1",
        },
        onDeploySideEffects: vi.fn(async () => {}),
      },
    );

    expect(response.status).toBe(403);
    const responseBody = await response.json() as { success: boolean; errors: Array<{ code: number; message: string }> };
    expect(responseBody.success).toBe(false);
    expect(responseBody.errors[0]?.code).toBe(10005);
    expect(responseBody.errors[0]?.message).toContain("QUEUE (queue)");
    await expect(kv.get(selfhostWorkerKey("demo--acme"))).resolves.toBeNull();
  });
});
