import { describe, expect, it, vi } from "vitest";

import {
  DIRECT_DEPLOY_ARTIFACT_MODULE_CONCURRENCY,
  DIRECT_DEPLOY_ASSET_FINGERPRINT_CONCURRENCY,
  DIRECT_DEPLOY_ASSET_FINGERPRINT_MAX_IN_FLIGHT_RAW_BYTES,
  DIRECT_DEPLOY_ASSET_BUCKET_MAX_BYTES,
  DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES,
  DIRECT_DEPLOY_ASSET_ROLLBACK_MAX_IN_FLIGHT_BYTES,
  DIRECT_DEPLOY_ASSET_ROLLBACK_WRITE_CONCURRENCY,
  DIRECT_DEPLOY_MODULE_MAX_TOTAL_BYTES,
  DirectDeployOutcomeUnknownError,
  deployWorkerModulesDirect,
  rollbackWorkerDeployFromArtifactCache,
  type DirectDeployAsset,
} from "../src/direct-dispatch-deploy";
import {
  selfhostAssetObjectKey,
  selfhostAssetsKey,
} from "../src/selfhost-assets-registry";
import { selfhostWorkerKey } from "../src/selfhost-worker-registry";
import { handleDeploySideEffects } from "../src/services/deploy";

// Instruments lazy asset handles so tests can assert bytes are read on demand
// and only in bounded batches (never the whole asset set at once).
function assetTracker() {
  let inFlight = 0;
  let maxInFlight = 0;
  let totalReads = 0;
  const asset = (
    path: string,
    body: string,
    contentType?: string,
  ): DirectDeployAsset => {
    const bytes = new TextEncoder().encode(body);
    return {
      path,
      ...(contentType ? { contentType } : {}),
      size: bytes.byteLength,
      read: async () => {
        inFlight += 1;
        totalReads += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // Yield so concurrently-started reads overlap before any resolves,
        // making maxInFlight reflect the real batch width.
        await Promise.resolve();
        inFlight -= 1;
        return bytes;
      },
    };
  };
  return {
    asset,
    get maxInFlight() {
      return maxInFlight;
    },
    get totalReads() {
      return totalReads;
    },
  };
}

// A single lazy asset for the existing single-asset upload/rollback tests.
function lazyAsset(
  path: string,
  body: string,
  contentType?: string,
): DirectDeployAsset {
  return assetTracker().asset(path, body, contentType);
}

function r2Body(body: string | Uint8Array): {
  size: number;
  body: ReadableStream<Uint8Array>;
} {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    size: bytes.byteLength,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
  };
}

const env = {
  CF_API_TOKEN: "cf-token",
  CF_ACCOUNT_ID: "account-id",
  CF_DISPATCH_NAMESPACE: "dispatch-ns",
  CF_WORKER_NAME: "chiridion-main",
};

const identity = {
  orgId: "org-1",
  orgSlug: "acme",
  workspaceId: "workspace-1",
  userId: "user-1",
  threadId: "thread-1",
  projectId: "project-1",
};

describe("deployWorkerModulesDirect", () => {
  it("rejects an oversized module aggregate before any fetch", async () => {
    const fetcher = vi.fn();
    const half = Math.floor(DIRECT_DEPLOY_MODULE_MAX_TOTAL_BYTES / 2) + 1;

    await expect(
      deployWorkerModulesDirect(
        env,
        {
          scriptName: "demo-app",
          hostname: "camelai.dev",
          identity,
          metadata: { main_module: "index.js" },
          modules: [
            {
              name: "index.js",
              contentType: "application/javascript+module",
              content: new Uint8Array(half),
            },
            {
              name: "chunk.js",
              contentType: "application/javascript+module",
              content: new Uint8Array(half),
            },
          ],
        },
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    ).rejects.toThrow(
      `${DIRECT_DEPLOY_MODULE_MAX_TOTAL_BYTES} aggregate byte limit`,
    );
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("publishes self-host apps to the local worker registry without Cloudflare credentials", async () => {
    const kv = new Map<string, string>();
    const putKv = vi.fn(async (key: string, value: string) => {
      kv.set(key, value);
    });
    const putR2 = vi.fn(async () => undefined);
    const fetcher = vi.fn();
    const onDeploySideEffects = vi.fn(async () => undefined);
    const localAsset = lazyAsset(
      "index.html",
      "local asset",
      "text/html; charset=utf-8",
    );

    const result = await deployWorkerModulesDirect(
      {
        CF_ACCOUNT_ID: "selfhost",
        CF_DISPATCH_NAMESPACE: "selfhost",
        APP_KV: { put: putKv } as unknown as KVNamespace,
        R2_BUCKET: { put: putR2 } as unknown as R2Bucket,
      },
      {
        scriptName: "guestbook",
        hostname: "apps.example.test",
        identity,
        metadata: {
          main_module: "index.js",
          compatibility_date: "2026-06-01",
          compatibility_flags: ["nodejs_compat"],
          assets: { directory: "../client" },
          bindings: [
            {
              type: "durable_object_namespace",
              name: "GUESTBOOK",
              class_name: "Guestbook",
            },
            { type: "worker_loader", name: "LOADER" },
          ],
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export class Guestbook {}; export default {};",
          },
        ],
        assets: [localAsset],
        commitSha: "snapshot-1",
      },
      {
        fetcher: fetcher as unknown as typeof fetch,
        onDeploySideEffects,
      },
    );

    expect(result).toMatchObject({
      success: true,
      status: 200,
      scriptName: "guestbook",
      dispatchScriptName: "guestbook--acme",
      result: { source: "selfhost" },
      sideEffects: {
        commitSha: "snapshot-1",
        scriptVersion: expect.any(String),
      },
    });
    expect(result.skippedAssets).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(onDeploySideEffects).toHaveBeenCalledOnce();

    const worker = JSON.parse(kv.get(selfhostWorkerKey("guestbook--acme"))!);
    expect(worker).toMatchObject({
      appId: "guestbook--acme",
      mainModule: "index.js",
      compatibilityFlags: ["nodejs_compat"],
      modules: {
        "index.js": {
          type: "js",
          content: "export class Guestbook {}; export default {};",
        },
      },
    });
    expect(worker.bindings).toContainEqual({
      type: "durable_object_namespace",
      name: "GUESTBOOK",
      class_name: "Guestbook",
    });
    expect(worker.bindings).toContainEqual({ type: "assets", name: "ASSETS" });
    expect(worker.bindings).not.toContainEqual(
      expect.objectContaining({ type: "worker_loader" }),
    );
    expect(kv.get(selfhostAssetsKey("guestbook--acme"))).toBeTruthy();
    expect(putR2).toHaveBeenCalled();
  });

  it("uploads a module worker bundle directly to the dispatch namespace", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "version-1" } }),
    );

    const result = await deployWorkerModulesDirect(
      env,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          compatibility_date: "2026-06-01",
          config_path: "wrangler.jsonc",
          bindings: [
            { type: "kv_namespace", name: "KV", namespace_id: "messages" },
            { type: "ai", name: "AI" },
          ],
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      success: true,
      scriptName: "demo-app",
      dispatchScriptName: "demo-app--acme",
      sideEffects: {
        scriptName: "demo-app",
        dispatchScriptName: "demo-app--acme",
        orgId: "org-1",
        workspaceId: "workspace-1",
        threadId: "thread-1",
        projectId: "project-1",
        configPath: "wrangler.jsonc",
        scriptVersion: "version-1",
      },
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme",
    );
    expect(init).toMatchObject({ method: "PUT" });
    expect((init?.headers as Record<string, string>).Authorization).toBe(
      "Bearer cf-token",
    );
    const form = init?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.bindings).toEqual([
      {
        type: "service",
        name: "KV",
        service: "chiridion-main",
        entrypoint: "KVVirtualNamespace",
        props: {
          workspaceId: "workspace-1",
          appId: "demo-app--acme",
          namespaceId: "messages",
        },
      },
      {
        type: "service",
        name: "AI",
        service: "chiridion-main",
        entrypoint: "AIVirtualBinding",
        props: { orgId: "org-1", workspaceId: "workspace-1", userId: "user-1" },
      },
      {
        type: "service",
        name: "CONNECTIONS",
        service: "chiridion-main",
        entrypoint: "ConnectionsService",
        props: { orgId: "org-1", workspaceId: "workspace-1", userId: "user-1" },
      },
      {
        type: "service",
        name: "CAMELAI",
        service: "chiridion-main",
        entrypoint: "CamelAiService",
        props: { orgId: "org-1", workspaceId: "workspace-1", userId: "user-1" },
      },
    ]);
    expect(metadata.observability).toEqual({
      enabled: true,
      traces: { enabled: true, persist: true, head_sampling_rate: 1 },
    });
    expect(form.get("index.js")).toBeInstanceOf(Blob);
  });

  it("overrides project trace disabling while preserving log preferences", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { deployment_id: "deploy-1" } }),
    );

    const result = await deployWorkerModulesDirect(
      env,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          observability: {
            enabled: false,
            logs: { enabled: false },
            traces: {
              enabled: false,
              persist: false,
              head_sampling_rate: 0.01,
            },
          },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.observability).toEqual({
      enabled: true,
      logs: { enabled: false },
      traces: { enabled: true, persist: true, head_sampling_rate: 1 },
    });
    expect(result.sideEffects.scriptVersion).toBe("deploy-1");
  });

  it("attaches the tail worker as a tail consumer when TAIL_WORKER_NAME is set", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "version-1" } }),
    );

    await deployWorkerModulesDirect(
      { ...env, TAIL_WORKER_NAME: "chiridion-user-logs-tail" },
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: { main_module: "index.js" },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toEqual([
      { service: "chiridion-user-logs-tail" },
    ]);
  });

  it("preserves project-declared tail consumers and dedupes the platform one", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "version-1" } }),
    );

    await deployWorkerModulesDirect(
      { ...env, TAIL_WORKER_NAME: "chiridion-user-logs-tail" },
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          tail_consumers: [
            { service: "project-own-tail" },
            { service: "chiridion-user-logs-tail" },
            { service: "chiridion-user-logs-tail", environment: "staging" },
          ],
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    // The exact platform consumer is deduped; an environment-scoped consumer
    // for the same service is preserved (Wrangler treats it as distinct).
    expect(metadata.tail_consumers).toEqual([
      { service: "project-own-tail" },
      { service: "chiridion-user-logs-tail", environment: "staging" },
      { service: "chiridion-user-logs-tail" },
    ]);
  });

  it("omits tail consumers when TAIL_WORKER_NAME is not configured", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "version-1" } }),
    );

    await deployWorkerModulesDirect(
      env,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: { main_module: "index.js" },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toBeUndefined();
  });

  it("normalizes wrangler durable object migrations for first deploy", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10092, message: "not found" }],
            result: null,
          },
          { status: 404 },
        );
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(
      env,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          migrations: [{ tag: "v1", new_sqlite_classes: ["CounterDO"] }],
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(fetcher).toHaveBeenCalledTimes(2);
    const form = fetcher.mock.calls[1]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.migrations).toEqual({
      new_tag: "v1",
      steps: [{ new_sqlite_classes: ["CounterDO"] }],
    });
  });

  it("omits an empty wrangler migrations array from upload metadata", async () => {
    // @cloudflare/vite-plugin emits `migrations: []` by default; the upload
    // API rejects any array (its reader wants the object form), so an empty
    // config array must not reach the metadata at all.
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "version-1" } }),
    );

    await deployWorkerModulesDirect(
      env,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          migrations: [],
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    const upload = fetcher.mock.calls.find(
      (call) => call[1]?.method === "PUT",
    )!;
    const form = upload[1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata).not.toHaveProperty("migrations");
  });

  it("skips durable object migrations that are already applied", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json({
          success: true,
          result: { script: { migration_tag: "v2", version_id: "version-1" } },
        });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(
      env,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          migrations: [
            { tag: "v1", new_sqlite_classes: ["CounterDO"] },
            { tag: "v2", new_sqlite_classes: ["SessionDO"] },
          ],
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    const form = fetcher.mock.calls[1]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.migrations).toBeUndefined();
  });

  it("uploads only pending durable object migration steps after the current tag", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json({
          success: true,
          result: { script: { migration_tag: "v1", version_id: "version-1" } },
        });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(
      env,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          migrations: [
            { tag: "v1", new_sqlite_classes: ["CounterDO"] },
            { tag: "v2", new_sqlite_classes: ["SessionDO"] },
          ],
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    const form = fetcher.mock.calls[1]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.migrations).toEqual({
      old_tag: "v1",
      new_tag: "v2",
      steps: [{ new_sqlite_classes: ["SessionDO"] }],
    });
  });

  it("uploads build assets natively and publishes the self-host manifest after script upload succeeds", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<
      string,
      { body: string | Uint8Array; options?: unknown }
    >();
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/assets-upload-session")) {
          const body = JSON.parse(init?.body as string) as {
            manifest: Record<string, { hash: string }>;
          };
          return Response.json({
            success: true,
            result: {
              jwt: "upload-jwt",
              buckets: [
                Object.values(body.manifest).map((entry) => entry.hash),
              ],
            },
          });
        }
        if (url.endsWith("/workers/assets/upload?base64=true")) {
          return Response.json({
            success: true,
            result: { jwt: "assets-jwt" },
          });
        }
        return Response.json({
          success: true,
          result: { id: "version-1", has_assets: true },
        });
      },
    );
    const assetEnv = {
      ...env,
      APP_KV: {
        put: vi.fn(async (key: string, value: string) => kv.set(key, value)),
      },
      R2_BUCKET: {
        put: vi.fn(
          async (key: string, body: string | Uint8Array, options?: unknown) =>
            r2.set(key, { body, options }),
        ),
      },
    };

    const result = await deployWorkerModulesDirect(
      assetEnv,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          assets: { directory: "../client", binding: "STATIC_ASSETS" },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(result.success).toBe(true);
    expect(result.sideEffects.artifactCacheKey).toMatch(
      /^deploy-artifacts\/org-1\/workspace-1\/project-1\/demo-app--acme\/[a-f0-9]{64}\.json$/,
    );
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [sessionUrl, sessionInit] = fetcher.mock.calls[0]!;
    expect(sessionUrl).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme/assets-upload-session",
    );
    expect(sessionInit).toMatchObject({ method: "POST" });
    const sessionBody = JSON.parse(sessionInit?.body as string);
    expect(sessionBody.manifest["/index.html"]).toMatchObject({ size: 5 });
    const assetHash = sessionBody.manifest["/index.html"].hash;
    const [, uploadInit] = fetcher.mock.calls[1]!;
    expect((uploadInit?.headers as Record<string, string>).Authorization).toBe(
      "Bearer upload-jwt",
    );
    const uploadForm = uploadInit?.body as FormData;
    expect(await (uploadForm.get(assetHash) as Blob).text()).toBe("aGVsbG8=");
    const stored = kv.get(selfhostAssetsKey("demo-app--acme"));
    expect(stored).toBeTruthy();
    const record = JSON.parse(stored!);
    expect(record.manifest["index.html"]).toMatchObject({
      size: 5,
      contentType: "text/html; charset=utf-8",
    });
    expect(
      r2.has(
        selfhostAssetObjectKey(
          "demo-app--acme",
          record.manifest["index.html"].hash,
        ),
      ),
    ).toBe(true);
    const cached = r2.get(result.sideEffects.artifactCacheKey!);
    expect(cached).toBeTruthy();
    expect(cached?.options).toMatchObject({
      httpMetadata: { contentType: "application/json; charset=utf-8" },
      customMetadata: {
        type: "direct-deploy-artifact-cache",
        orgId: "org-1",
        workspaceId: "workspace-1",
        projectId: "project-1",
      },
    });
    const cachedRecord = JSON.parse(cached?.body as string);
    expect(cachedRecord).toMatchObject({
      schemaVersion: 1,
      scriptName: "demo-app",
      dispatchScriptName: "demo-app--acme",
      identity,
      assetsRecord: { appId: "demo-app--acme" },
    });
    expect(cachedRecord.modules).toEqual([
      {
        name: "index.js",
        contentType: "application/javascript+module",
        contentBase64: "ZXhwb3J0IGRlZmF1bHQge307",
      },
    ]);
    expect(cachedRecord.metadata.bindings).toContainEqual({
      type: "assets",
      name: "STATIC_ASSETS",
    });
    expect(cachedRecord.metadata.assets).toEqual({ jwt: "assets-jwt" });

    const form = fetcher.mock.calls[2]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.assets).toEqual({ jwt: "assets-jwt" });
    expect(metadata.bindings).toContainEqual({
      type: "assets",
      name: "STATIC_ASSETS",
    });
  });

  it("fingerprints small rollback-cache modules at the prior width of sixteen", async () => {
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    let digestsInFlight = 0;
    let maximumDigestsInFlight = 0;
    const digestSpy = vi
      .spyOn(crypto.subtle, "digest")
      .mockImplementation(async (algorithm, data) => {
        digestsInFlight += 1;
        maximumDigestsInFlight = Math.max(
          maximumDigestsInFlight,
          digestsInFlight,
        );
        await Promise.resolve();
        try {
          return await originalDigest(algorithm, data);
        } finally {
          digestsInFlight -= 1;
        }
      });
    try {
      const modules = Array.from({ length: 20 }, (_, index) => ({
        name: `module-${index}.js`,
        contentType: "application/javascript+module",
        content: `export const value${index} = ${index};`,
      }));
      const result = await deployWorkerModulesDirect(
        {
          CF_ACCOUNT_ID: "selfhost",
          APP_KV: { put: vi.fn(async () => undefined) },
          R2_BUCKET: { put: vi.fn(async () => undefined) },
        },
        {
          scriptName: "demo-app",
          hostname: "camelai.dev",
          identity,
          metadata: { main_module: "module-0.js" },
          modules,
        },
      );

      expect(result.success).toBe(true);
      expect(maximumDigestsInFlight).toBe(
        DIRECT_DEPLOY_ARTIFACT_MODULE_CONCURRENCY,
      );
    } finally {
      digestSpy.mockRestore();
    }
  });

  it("rejects an oversized native upload bucket before any bucket reread or upload fetch", async () => {
    const assetBytes = 6 * 1024 * 1024;
    expect(3 * assetBytes).toBeGreaterThan(
      DIRECT_DEPLOY_ASSET_BUCKET_MAX_BYTES,
    );
    const reads = [vi.fn(), vi.fn(), vi.fn()];
    const assets = reads.map((read, index): DirectDeployAsset => {
      const bytes = new Uint8Array(assetBytes);
      bytes[0] = index + 1;
      read.mockResolvedValue(bytes);
      return {
        path: `assets/part-${index}.bin`,
        size: bytes.byteLength,
        read,
      };
    });
    const fetcher = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        const body = JSON.parse(init?.body as string) as {
          manifest: Record<string, { hash: string }>;
        };
        return Response.json({
          success: true,
          result: {
            jwt: "upload-jwt",
            buckets: [Object.values(body.manifest).map((entry) => entry.hash)],
          },
        });
      },
    );

    await expect(
      deployWorkerModulesDirect(
        env,
        {
          scriptName: "demo-app",
          hostname: "camelai.dev",
          identity,
          metadata: {
            main_module: "index.js",
            assets: { directory: "../client" },
          },
          modules: [
            {
              name: "index.js",
              contentType: "application/javascript+module",
              content: "export default {};",
            },
          ],
          assets,
        },
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    ).rejects.toThrow(`${DIRECT_DEPLOY_ASSET_BUCKET_MAX_BYTES} raw byte limit`);
    expect(reads.map((read) => read.mock.calls.length)).toEqual([1, 1, 1]);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      "/assets-upload-session",
    );
  });

  it("streams a large asset set through bounded batches and uploads every asset", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<
      string,
      { body: string | Uint8Array; options?: unknown }
    >();
    // One bucket per asset so the native upload pass touches every asset.
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/assets-upload-session")) {
          const body = JSON.parse(init?.body as string) as {
            manifest: Record<string, { hash: string }>;
          };
          return Response.json({
            success: true,
            result: {
              jwt: "upload-jwt",
              buckets: Object.values(body.manifest).map((entry) => [
                entry.hash,
              ]),
            },
          });
        }
        if (url.endsWith("/workers/assets/upload?base64=true")) {
          return Response.json({
            success: true,
            result: { jwt: "assets-jwt" },
          });
        }
        return Response.json({
          success: true,
          result: { id: "version-1", has_assets: true },
        });
      },
    );

    const tracker = assetTracker();
    let rollbackWritesInFlight = 0;
    let rollbackWriteBytesInFlight = 0;
    let maximumRollbackWritesInFlight = 0;
    let maximumRollbackWriteBytesInFlight = 0;
    const assets = Array.from({ length: 20 }, (_, index) =>
      tracker.asset(
        `assets/file-${index}.txt`,
        `payload-${index}`,
        "text/plain",
      ),
    );

    const result = await deployWorkerModulesDirect(
      {
        ...env,
        APP_KV: {
          put: vi.fn(async (key: string, value: string) => kv.set(key, value)),
        },
        R2_BUCKET: {
          put: vi.fn(
            async (
              key: string,
              body: string | Uint8Array,
              options?: unknown,
            ) => {
              if (key.startsWith("selfhost-assets/")) {
                const size =
                  typeof body === "string" ? body.length : body.byteLength;
                rollbackWritesInFlight += 1;
                rollbackWriteBytesInFlight += size;
                maximumRollbackWritesInFlight = Math.max(
                  maximumRollbackWritesInFlight,
                  rollbackWritesInFlight,
                );
                maximumRollbackWriteBytesInFlight = Math.max(
                  maximumRollbackWriteBytesInFlight,
                  rollbackWriteBytesInFlight,
                );
                await Promise.resolve();
                rollbackWritesInFlight -= 1;
                rollbackWriteBytesInFlight -= size;
              }
              r2.set(key, { body, options });
            },
          ),
        },
      },
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          assets: { directory: "../client", binding: "ASSETS" },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        assets,
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(result.success).toBe(true);

    // Every asset made it into the upload-session manifest with the right size.
    const sessionBody = JSON.parse(fetcher.mock.calls[0]![1]?.body as string);
    expect(Object.keys(sessionBody.manifest)).toHaveLength(20);
    for (let index = 0; index < 20; index += 1) {
      expect(sessionBody.manifest[`/assets/file-${index}.txt`]).toMatchObject({
        size: `payload-${index}`.length,
      });
    }

    // Every asset was uploaded (one bucket each) and stored to R2 for rollback.
    const uploadCalls = fetcher.mock.calls.filter(([callUrl]) =>
      String(callUrl).endsWith("/workers/assets/upload?base64=true"),
    );
    expect(uploadCalls).toHaveLength(20);
    const storedRecord = JSON.parse(
      kv.get(selfhostAssetsKey("demo-app--acme"))!,
    );
    expect(Object.keys(storedRecord.manifest)).toHaveLength(20);

    // Reads are lazy and batched: no more than the batch width were ever in
    // flight at once, so the whole asset set is never resident together.
    expect(tracker.maxInFlight).toBe(
      DIRECT_DEPLOY_ASSET_FINGERPRINT_CONCURRENCY,
    );
    expect(maximumRollbackWritesInFlight).toBe(
      DIRECT_DEPLOY_ASSET_ROLLBACK_WRITE_CONCURRENCY,
    );
    expect(maximumRollbackWriteBytesInFlight).toBeLessThanOrEqual(
      DIRECT_DEPLOY_ASSET_ROLLBACK_MAX_IN_FLIGHT_BYTES,
    );
    // Fingerprint pass + R2 rollback pass + native upload pass each re-read.
    expect(tracker.totalReads).toBe(60);
  });

  it("caps maximum-sized asset reads and rollback writes by byte weight", async () => {
    const bytes = new Uint8Array(DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES);
    let readsInFlight = 0;
    let readBytesInFlight = 0;
    let maximumReadsInFlight = 0;
    let maximumReadBytesInFlight = 0;
    let rollbackWritesInFlight = 0;
    let rollbackWriteBytesInFlight = 0;
    let maximumRollbackWritesInFlight = 0;
    let maximumRollbackWriteBytesInFlight = 0;
    const readsPerAsset = Array.from({ length: 4 }, () => 0);
    const assets = Array.from(
      { length: 4 },
      (_, index): DirectDeployAsset => ({
        path: `assets/maximum-${index}.bin`,
        size: bytes.byteLength,
        read: async () => {
          readsPerAsset[index] += 1;
          const fingerprintRead = readsPerAsset[index] === 1;
          if (fingerprintRead) {
            readsInFlight += 1;
            readBytesInFlight += bytes.byteLength;
            maximumReadsInFlight = Math.max(
              maximumReadsInFlight,
              readsInFlight,
            );
            maximumReadBytesInFlight = Math.max(
              maximumReadBytesInFlight,
              readBytesInFlight,
            );
          }
          await Promise.resolve();
          if (fingerprintRead) {
            readsInFlight -= 1;
            readBytesInFlight -= bytes.byteLength;
          }
          return bytes;
        },
      }),
    );
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      Response.json({
        success: true,
        result: String(input).endsWith("/assets-upload-session")
          ? { jwt: "upload-jwt", buckets: [] }
          : { id: "version-1", has_assets: true },
      }),
    );

    const result = await deployWorkerModulesDirect(
      {
        ...env,
        APP_KV: { put: vi.fn(async () => undefined) },
        R2_BUCKET: {
          put: vi.fn(async (key: string, body: string | Uint8Array) => {
            if (!key.startsWith("selfhost-assets/")) return;
            const size =
              typeof body === "string" ? body.length : body.byteLength;
            rollbackWritesInFlight += 1;
            rollbackWriteBytesInFlight += size;
            maximumRollbackWritesInFlight = Math.max(
              maximumRollbackWritesInFlight,
              rollbackWritesInFlight,
            );
            maximumRollbackWriteBytesInFlight = Math.max(
              maximumRollbackWriteBytesInFlight,
              rollbackWriteBytesInFlight,
            );
            await Promise.resolve();
            rollbackWritesInFlight -= 1;
            rollbackWriteBytesInFlight -= size;
          }),
        },
      },
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          assets: { directory: "../client", binding: "ASSETS" },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        assets,
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(result.success).toBe(true);
    expect(maximumReadsInFlight).toBe(1);
    expect(maximumReadBytesInFlight).toBeLessThanOrEqual(
      DIRECT_DEPLOY_ASSET_FINGERPRINT_MAX_IN_FLIGHT_RAW_BYTES,
    );
    expect(maximumRollbackWritesInFlight).toBe(2);
    expect(maximumRollbackWriteBytesInFlight).toBeLessThanOrEqual(
      DIRECT_DEPLOY_ASSET_ROLLBACK_MAX_IN_FLIGHT_BYTES,
    );
  });

  it("stops rollback admission after failure and drains already-started writes", async () => {
    let startedRollbackWrites = 0;
    let resolveAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    const assets = Array.from({ length: 10 }, (_, index) =>
      lazyAsset(`assets/file-${index}.txt`, `payload-${index}`, "text/plain"),
    );
    const fetcher = vi.fn(async (input: string | URL | Request) =>
      Response.json({
        success: true,
        result: String(input).endsWith("/assets-upload-session")
          ? { jwt: "upload-jwt", buckets: [] }
          : { id: "version-1", has_assets: true },
      }),
    );
    const deployment = deployWorkerModulesDirect(
      {
        ...env,
        APP_KV: { put: vi.fn(async () => undefined) },
        R2_BUCKET: {
          put: vi.fn(async (key: string) => {
            if (!key.startsWith("selfhost-assets/")) return;
            startedRollbackWrites += 1;
            if (
              startedRollbackWrites ===
              DIRECT_DEPLOY_ASSET_ROLLBACK_WRITE_CONCURRENCY
            ) {
              resolveAllStarted();
            }
            if (startedRollbackWrites === 1) {
              await allStarted;
              throw new Error("rollback write failed");
            }
            await drain;
          }),
        },
      },
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          assets: { directory: "../client", binding: "ASSETS" },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        assets,
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    await allStarted;
    let settled = false;
    void deployment.finally(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(startedRollbackWrites).toBe(
      DIRECT_DEPLOY_ASSET_ROLLBACK_WRITE_CONCURRENCY,
    );

    releaseDrain();
    await expect(deployment).resolves.toMatchObject({
      success: true,
      warnings: expect.arrayContaining([
        expect.stringContaining("rollback write failed"),
      ]),
    });
    expect(startedRollbackWrites).toBe(
      DIRECT_DEPLOY_ASSET_ROLLBACK_WRITE_CONCURRENCY,
    );
  });

  it("rejects oversized asset metadata before reading or fetching", async () => {
    const oversizedRead = vi.fn(async () => {
      throw new Error("oversized asset must not cross sandbox RPC");
    });
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/assets-upload-session")) {
          const body = JSON.parse(init?.body as string) as {
            manifest: Record<string, { hash: string }>;
          };
          return Response.json({
            success: true,
            result: {
              jwt: "upload-jwt",
              buckets: [
                Object.values(body.manifest).map((entry) => entry.hash),
              ],
            },
          });
        }
        if (url.endsWith("/workers/assets/upload?base64=true")) {
          return Response.json({
            success: true,
            result: { jwt: "assets-jwt" },
          });
        }
        return Response.json({
          success: true,
          result: { id: "version-1", has_assets: true },
        });
      },
    );

    await expect(
      deployWorkerModulesDirect(
        env,
        {
          scriptName: "demo-app",
          hostname: "camelai.dev",
          identity,
          metadata: {
            main_module: "index.js",
            assets: { directory: "../client", binding: "ASSETS" },
          },
          modules: [
            {
              name: "index.js",
              contentType: "application/javascript+module",
              content: "export default {};",
            },
          ],
          assets: [
            {
              path: "assets/hero.png",
              contentType: "image/png",
              size: DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES + 1,
              read: oversizedRead,
            },
          ],
        },
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    ).rejects.toThrow(`${DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES} byte limit`);
    expect(oversizedRead).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps an asset exactly at the bounded per-file limit", async () => {
    const boundaryRead = vi.fn(
      async () => new Uint8Array(DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES),
    );
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        return Response.json({
          success: true,
          result: { jwt: "assets-jwt", buckets: [] },
        });
      }
      return Response.json({
        success: true,
        result: { id: "version-1", has_assets: true },
      });
    });

    const result = await deployWorkerModulesDirect(
      env,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          assets: { directory: "../client" },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        assets: [
          {
            path: "assets/boundary.bin",
            size: DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES,
            read: boundaryRead,
          },
        ],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(result.success).toBe(true);
    expect(result.skippedAssets).toBeUndefined();
    expect(boundaryRead).toHaveBeenCalled();
  });

  it("fails closed rather than silently dropping every oversized asset", async () => {
    const oversizedRead = vi.fn(async () => {
      throw new Error("oversized asset must not cross sandbox RPC");
    });
    const fetcher = vi.fn(async () =>
      Response.json({
        success: true,
        result: { id: "version-1", has_assets: false },
      }),
    );

    await expect(
      deployWorkerModulesDirect(
        env,
        {
          scriptName: "demo-app",
          hostname: "camelai.dev",
          identity,
          metadata: {
            main_module: "index.js",
            assets: { directory: "../client", binding: "ASSETS" },
          },
          modules: [
            {
              name: "index.js",
              contentType: "application/javascript+module",
              content: "export default {};",
            },
          ],
          assets: [
            {
              path: "assets/hero.png",
              contentType: "image/png",
              size: DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES + 1,
              read: oversizedRead,
            },
          ],
        },
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    ).rejects.toThrow(`${DIRECT_DEPLOY_ASSET_MAX_FILE_BYTES} byte limit`);
    expect(oversizedRead).not.toHaveBeenCalled();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not publish the active self-host asset manifest when script upload fails", async () => {
    const kvPut = vi.fn(async () => undefined);
    const r2 = new Map<
      string,
      { body: string | Uint8Array; options?: unknown }
    >();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        return Response.json({
          success: true,
          result: { jwt: "assets-jwt", buckets: [] },
        });
      }
      return Response.json(
        { success: false, errors: [{ message: "script failed" }] },
        { status: 500 },
      );
    });

    const result = await deployWorkerModulesDirect(
      {
        ...env,
        APP_KV: { put: kvPut },
        R2_BUCKET: {
          put: vi.fn(
            async (key: string, body: string | Uint8Array, options?: unknown) =>
              r2.set(key, { body, options }),
          ),
        },
      },
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          assets: { directory: "../client" },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(result.success).toBe(false);
    expect(kvPut).not.toHaveBeenCalledWith(
      selfhostAssetsKey("demo-app--acme"),
      expect.any(String),
    );
  });

  it("continues native asset deploy when the local rollback asset cache R2 put fails", async () => {
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/assets-upload-session")) {
          const body = JSON.parse(init?.body as string) as {
            manifest: Record<string, { hash: string }>;
          };
          return Response.json({
            success: true,
            result: {
              jwt: "upload-jwt",
              buckets: [
                Object.values(body.manifest).map((entry) => entry.hash),
              ],
            },
          });
        }
        if (url.endsWith("/workers/assets/upload?base64=true")) {
          return Response.json({
            success: true,
            result: { jwt: "assets-jwt" },
          });
        }
        return Response.json({
          success: true,
          result: { id: "version-1", has_assets: true },
        });
      },
    );
    const r2Put = vi.fn(async () => {
      throw new Error("put: Unspecified error (0)");
    });

    const result = await deployWorkerModulesDirect(
      {
        ...env,
        APP_KV: { put: vi.fn(async () => undefined) },
        R2_BUCKET: { put: r2Put },
      },
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          assets: { directory: "../client" },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(result).toMatchObject({
      success: true,
      result: { success: true, result: { has_assets: true } },
    });
    expect(result.warnings).toEqual([
      "Deploy asset rollback cache unavailable after publish: put: Unspecified error (0)",
      "Deploy artifact cache unavailable after publish: put: Unspecified error (0)",
    ]);
    expect(result.sideEffects.artifactCacheKey).toBeUndefined();
    expect(r2Put).toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2]![0])).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme",
    );
    const metadata = JSON.parse(
      await (
        (fetcher.mock.calls[2]![1]?.body as FormData).get("metadata") as Blob
      ).text(),
    );
    expect(metadata.assets).toEqual({ jwt: "assets-jwt" });
  });

  it("includes Cloudflare error bodies when asset upload session returns result null", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        return Response.json(
          {
            success: false,
            errors: [{ code: 10001, message: "upload session denied" }],
            messages: [],
            result: null,
          },
          { status: 400 },
        );
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await expect(
      deployWorkerModulesDirect(
        {
          ...env,
          APP_KV: { put: vi.fn(async () => undefined) },
          R2_BUCKET: { put: vi.fn(async () => undefined) },
        },
        {
          scriptName: "demo-app",
          hostname: "camelai.dev",
          identity,
          metadata: {
            main_module: "index.js",
            assets: { directory: "../client" },
          },
          modules: [
            {
              name: "index.js",
              contentType: "application/javascript+module",
              content: "export default {};",
            },
          ],
          assets: [
            lazyAsset("index.html", "hello", "text/html; charset=utf-8"),
          ],
        },
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/upload session denied/);
  });

  it("rolls back by replaying a cached deploy artifact", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<
      string,
      { body: string | Uint8Array; options?: unknown }
    >();
    const fetcher = vi.fn(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/assets-upload-session")) {
          const body = JSON.parse(init?.body as string) as {
            manifest: Record<string, { hash: string }>;
          };
          return Response.json({
            success: true,
            result: {
              jwt: "upload-jwt",
              buckets: [
                Object.values(body.manifest).map((entry) => entry.hash),
              ],
            },
          });
        }
        if (url.endsWith("/workers/assets/upload?base64=true")) {
          return Response.json({
            success: true,
            result: { jwt: "assets-jwt" },
          });
        }
        return Response.json({ success: true, result: { id: "version-1" } });
      },
    );
    const rollbackEnv = {
      ...env,
      APP_KV: {
        put: vi.fn(async (key: string, value: string) => kv.set(key, value)),
      },
      R2_BUCKET: {
        put: vi.fn(
          async (key: string, body: string | Uint8Array, options?: unknown) =>
            r2.set(key, { body, options }),
        ),
        get: vi.fn(async (key: string) => {
          const item = r2.get(key);
          return item ? r2Body(item.body) : null;
        }),
      },
    };
    const deploy = await deployWorkerModulesDirect(
      rollbackEnv,
      {
        scriptName: "demo-app",
        hostname: "camelai.dev",
        identity,
        metadata: {
          main_module: "index.js",
          assets: { directory: "../client" },
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
        assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );
    kv.clear();
    fetcher.mockClear();

    const rollback = await rollbackWorkerDeployFromArtifactCache(
      rollbackEnv,
      {
        artifactCacheKey: deploy.sideEffects.artifactCacheKey!,
        hostname: "camelai.dev",
        expected: {
          orgId: "org-1",
          workspaceId: "workspace-1",
          scriptName: "demo-app",
        },
        threadId: "thread-rollback",
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    expect(rollback).toMatchObject({
      success: true,
      scriptName: "demo-app",
      dispatchScriptName: "demo-app--acme",
      sideEffects: {
        threadId: "thread-rollback",
        artifactCacheKey: deploy.sideEffects.artifactCacheKey,
      },
    });
    expect(kv.get(selfhostAssetsKey("demo-app--acme"))).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[0]![0])).toContain(
      "/assets-upload-session",
    );
    expect(String(fetcher.mock.calls[1]![0])).toContain(
      "/workers/assets/upload?base64=true",
    );
    const [url, init] = fetcher.mock.calls[2]!;
    expect(url).toBe(
      "https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme",
    );
    const form = init?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.assets).toEqual({ jwt: "assets-jwt" });
    expect(metadata.bindings).toContainEqual({
      type: "assets",
      name: "ASSETS",
    });
    expect(form.get("index.js")).toBeInstanceOf(Blob);
  });

  it("re-applies the platform tail consumer when rolling back an artifact cached without one", async () => {
    const r2 = new Map<
      string,
      { body: string | Uint8Array; options?: unknown }
    >();
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "version-1" } }),
    );
    const rollbackEnv = {
      ...env,
      TAIL_WORKER_NAME: "chiridion-user-logs-tail",
      APP_KV: { put: vi.fn(async () => undefined) },
      R2_BUCKET: {
        put: vi.fn(
          async (key: string, body: string | Uint8Array, options?: unknown) =>
            r2.set(key, { body, options }),
        ),
        get: vi.fn(async (key: string) => {
          const item = r2.get(key);
          return item ? r2Body(item.body) : null;
        }),
      },
    };
    // Cache an artifact whose metadata predates the tail-consumer behavior.
    const artifactCacheKey =
      "deploy-artifacts/org-1/workspace-1/project-1/demo-app--acme/legacy.json";
    r2.set(artifactCacheKey, {
      body: JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        scriptName: "demo-app",
        dispatchScriptName: "demo-app--acme",
        identity,
        metadata: { main_module: "index.js" },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            contentBase64: "ZXhwb3J0IGRlZmF1bHQge307",
          },
        ],
        assetsRecord: null,
      }),
    });

    await rollbackWorkerDeployFromArtifactCache(
      rollbackEnv,
      {
        artifactCacheKey,
        hostname: "camelai.dev",
        expected: {
          orgId: "org-1",
          workspaceId: "workspace-1",
          scriptName: "demo-app",
        },
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );

    const upload = fetcher.mock.calls.find(
      (call) => call[1]?.method === "PUT",
    )!;
    const form = upload[1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toEqual([
      { service: "chiridion-user-logs-tail" },
    ]);
  });

  it("aborts a hung Cloudflare publish and reports a terminal unknown outcome", async () => {
    let publishSignal: AbortSignal | undefined;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          publishSignal = init?.signal ?? undefined;
          publishSignal?.addEventListener(
            "abort",
            () => reject(new Error("fetch aborted")),
            { once: true },
          );
        }),
    );

    const result = deployWorkerModulesDirect(
      env,
      {
        scriptName: "deadline-app",
        hostname: "camelai.dev",
        identity,
        metadata: { main_module: "index.js" },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      {
        fetcher: fetcher as unknown as typeof fetch,
        deadlineAt: Date.now() + 100,
      },
    );

    await expect(result).rejects.toBeInstanceOf(
      DirectDeployOutcomeUnknownError,
    );
    expect(publishSignal?.aborted).toBe(true);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("fences a late R2 artifact read before its body can be materialized", async () => {
    let resolveGet:
      | ((value: { size: number; text: () => Promise<string> }) => void)
      | undefined;
    const text = vi.fn(async () => "{}");
    const get = vi.fn(
      () =>
        new Promise<{ size: number; text: () => Promise<string> }>(
          (resolve) => {
            resolveGet = resolve;
          },
        ),
    );

    const rollback = rollbackWorkerDeployFromArtifactCache(
      {
        ...env,
        R2_BUCKET: { get } as unknown as R2Bucket,
      },
      {
        artifactCacheKey: "deploy-artifacts/hung.json",
        hostname: "camelai.dev",
      },
      { deadlineAt: Date.now() + 100 },
    );

    await expect(rollback).rejects.toMatchObject({
      code: "DIRECT_DEPLOY_DEADLINE_EXCEEDED",
    });
    resolveGet?.({ size: 2, text });
    await Promise.resolve();
    await Promise.resolve();
    expect(text).not.toHaveBeenCalled();
  });

  it("cancels a hung streamed R2 artifact body before returning", async () => {
    const cancel = vi.fn(async () => undefined);
    const get = vi.fn(async () => ({
      size: 2,
      body: new ReadableStream<Uint8Array>({
        pull: () => new Promise<void>(() => {}),
        cancel,
      }),
    }));

    const rollback = rollbackWorkerDeployFromArtifactCache(
      {
        ...env,
        R2_BUCKET: { get } as unknown as R2Bucket,
      },
      {
        artifactCacheKey: "deploy-artifacts/hung-body.json",
        hostname: "camelai.dev",
      },
      { deadlineAt: Date.now() + 100 },
    );

    await expect(rollback).rejects.toMatchObject({
      code: "DIRECT_DEPLOY_DEADLINE_EXCEEDED",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("returns published success when the confirmed PUT response body hangs", async () => {
    const cancel = vi.fn();
    let publishSignal: AbortSignal | undefined;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        publishSignal = init?.signal ?? undefined;
        return new Response(
          new ReadableStream<Uint8Array>({
            pull: () => new Promise<void>(() => {}),
            cancel,
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        );
      },
    );
    const onDeploySideEffects = vi.fn(async () => undefined);

    const result = await deployWorkerModulesDirect(
      env,
      {
        scriptName: "body-timeout-app",
        hostname: "camelai.dev",
        identity,
        metadata: { main_module: "index.js" },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      {
        fetcher: fetcher as unknown as typeof fetch,
        onDeploySideEffects,
        deadlineAt: Date.now() + 100,
      },
    );

    expect(result.success).toBe(true);
    expect(result.status).toBe(200);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Cloudflare deploy response body unavailable"),
        expect.stringContaining("Deploy registration skipped"),
      ]),
    );
    expect(publishSignal?.aborted).toBe(true);
    expect(cancel).toHaveBeenCalled();
    expect(onDeploySideEffects).not.toHaveBeenCalled();
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("cancel rejected"))],
    ["never settles", () => new Promise<void>(() => {})],
  ])(
    "bounds cleanup when confirmed PUT response cancellation %s",
    async (_label, cancelResult) => {
      const cancel = vi.fn(cancelResult);
      const fetcher = vi.fn(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              pull: () => new Promise<void>(() => {}),
              cancel,
            }),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      );
      const startedAt = Date.now();

      const result = await deployWorkerModulesDirect(
        env,
        {
          scriptName: "body-cancel-timeout-app",
          hostname: "camelai.dev",
          identity,
          metadata: { main_module: "index.js" },
          modules: [
            {
              name: "index.js",
              contentType: "application/javascript+module",
              content: "export default {};",
            },
          ],
        },
        {
          fetcher: fetcher as unknown as typeof fetch,
          deadlineAt: Date.now() + 100,
        },
      );

      expect(result.success).toBe(true);
      expect(result.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining("cancellation could not be confirmed"),
        ]),
      );
      expect(cancel).toHaveBeenCalledOnce();
      expect(Date.now() - startedAt).toBeLessThan(2_500);
    },
  );

  it("does not turn a post-publish artifact-cache timeout into a retryable deploy failure", async () => {
    const r2Put = vi.fn(() => new Promise<void>(() => {}));
    const onDeploySideEffects = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "published-version" } }),
    );

    const result = await deployWorkerModulesDirect(
      { ...env, R2_BUCKET: { put: r2Put } as unknown as R2Bucket },
      {
        scriptName: "cache-timeout-app",
        hostname: "camelai.dev",
        identity,
        metadata: { main_module: "index.js" },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      {
        fetcher: fetcher as unknown as typeof fetch,
        onDeploySideEffects,
        deadlineAt: Date.now() + 100,
      },
    );

    expect(result).toMatchObject({ success: true, status: 200 });
    expect(result.sideEffects.artifactCacheKey).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Deploy artifact cache unavailable after publish",
        ),
      ]),
    );
    expect(r2Put).toHaveBeenCalledOnce();
    expect(onDeploySideEffects).not.toHaveBeenCalled();
  });

  it("prevents a late registration await from resuming into another effect", async () => {
    let resolveFirst: (() => void) | undefined;
    const secondEffect = vi.fn(async () => undefined);
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "published-version" } }),
    );

    const result = await deployWorkerModulesDirect(
      env,
      {
        scriptName: "registration-timeout-app",
        hostname: "camelai.dev",
        identity,
        metadata: { main_module: "index.js" },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      {
        fetcher: fetcher as unknown as typeof fetch,
        deadlineAt: Date.now() + 100,
        onDeploySideEffects: async (_info, scope) => {
          await scope.read(
            "the first registration lookup",
            () =>
              new Promise<void>((resolve) => {
                resolveFirst = resolve;
              }),
          );
          await scope.write("the second registration write", secondEffect);
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Deploy registration unavailable after publish",
        ),
      ]),
    );
    resolveFirst?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(secondEffect).not.toHaveBeenCalled();
  });

  it("fences the production deploy registration handler after a late OrgDO read", async () => {
    let resolveThread:
      | ((value: { created_by: string; workspace_id: string }) => void)
      | undefined;
    const registerWorkerScript = vi.fn(async () => ({
      is_public: false,
      updated_at: Date.now(),
    }));
    const orgStub = {
      getThread: vi.fn(
        () =>
          new Promise<{ created_by: string; workspace_id: string }>(
            (resolve) => {
              resolveThread = resolve;
            },
          ),
      ),
      registerWorkerScript,
      updateWorkerScriptPreview: vi.fn(async () => ({ stale: false })),
    };
    const appKvGet = vi.fn(async () => null);
    const appKvPut = vi.fn(async () => undefined);
    const productionEnv = {
      ...env,
      ORG: {
        idFromName: vi.fn((value: string) => value),
        get: vi.fn(() => orgStub),
      },
      APP_KV: { get: appKvGet, put: appKvPut },
    };
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "published-version" } }),
    );

    const result = await deployWorkerModulesDirect(
      productionEnv as never,
      {
        scriptName: "production-registration-timeout-app",
        hostname: "camelai.dev",
        identity,
        metadata: { main_module: "index.js" },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export default {};",
          },
        ],
      },
      {
        fetcher: fetcher as unknown as typeof fetch,
        deadlineAt: Date.now() + 100,
        onDeploySideEffects: (info, scope) =>
          handleDeploySideEffects(productionEnv as never, info, scope),
      },
    );

    expect(result).toMatchObject({ success: true, status: 200 });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "Deploy registration unavailable after publish",
        ),
      ]),
    );
    resolveThread?.({ created_by: "user-1", workspace_id: "workspace-1" });
    await Promise.resolve();
    await Promise.resolve();
    expect(registerWorkerScript).not.toHaveBeenCalled();
    expect(appKvGet).not.toHaveBeenCalled();
    expect(appKvPut).not.toHaveBeenCalled();
  });
});
