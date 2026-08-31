import { describe, expect, it, vi } from "vitest";

import { deployWorkerModulesDirect, rollbackWorkerDeployFromArtifactCache, type DirectDeployAsset } from "../src/direct-dispatch-deploy";
import { selfhostAssetObjectKey, selfhostAssetsKey } from "../src/selfhost-assets-registry";
import { selfhostWorkerKey } from "../src/selfhost-worker-registry";

// Instruments lazy asset handles so tests can assert bytes are read on demand
// and only in bounded batches (never the whole asset set at once).
function assetTracker() {
  let inFlight = 0;
  let maxInFlight = 0;
  let totalReads = 0;
  const asset = (path: string, body: string, contentType?: string): DirectDeployAsset => {
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
    get maxInFlight() { return maxInFlight; },
    get totalReads() { return totalReads; },
  };
}

// A single lazy asset for the existing single-asset upload/rollback tests.
function lazyAsset(path: string, body: string, contentType?: string): DirectDeployAsset {
  return assetTracker().asset(path, body, contentType);
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
  it("publishes self-host apps to the local worker registry without Cloudflare credentials", async () => {
    const kv = new Map<string, string>();
    const putKv = vi.fn(async (key: string, value: string) => {
      kv.set(key, value);
    });
    const putR2 = vi.fn(async () => undefined);
    const fetcher = vi.fn();
    const onDeploySideEffects = vi.fn(async () => undefined);
    const oversizedForCloudflare = lazyAsset(
      "index.html",
      "local asset",
      "text/html; charset=utf-8",
    );
    oversizedForCloudflare.size = 26 * 1024 * 1024;

    const result = await deployWorkerModulesDirect({
      CF_ACCOUNT_ID: "selfhost",
      CF_DISPATCH_NAMESPACE: "selfhost",
      APP_KV: { put: putKv } as unknown as KVNamespace,
      R2_BUCKET: { put: putR2 } as unknown as R2Bucket,
    }, {
      scriptName: "guestbook",
      hostname: "apps.example.test",
      identity,
      metadata: {
        main_module: "index.js",
        compatibility_date: "2026-06-01",
        compatibility_flags: ["nodejs_compat"],
        assets: { directory: "../client" },
        bindings: [
          { type: "durable_object_namespace", name: "GUESTBOOK", class_name: "Guestbook" },
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
      assets: [oversizedForCloudflare],
      commitSha: "snapshot-1",
    }, {
      fetcher: fetcher as unknown as typeof fetch,
      onDeploySideEffects,
    });

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

    const worker = JSON.parse(
      kv.get(selfhostWorkerKey("guestbook--acme"))!,
    );
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
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    const result = await deployWorkerModulesDirect(env, {
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
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

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
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme");
    expect(init).toMatchObject({ method: "PUT" });
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer cf-token");
    const form = init?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.bindings).toEqual([
      {
        type: "service",
        name: "KV",
        service: "chiridion-main",
        entrypoint: "KVVirtualNamespace",
        props: { workspaceId: "workspace-1", appId: "demo-app--acme", namespaceId: "messages" },
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
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { deployment_id: "deploy-1" } }));

    const result = await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        observability: {
          enabled: false,
          logs: { enabled: false },
          traces: { enabled: false, persist: false, head_sampling_rate: 0.01 },
        },
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

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
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    await deployWorkerModulesDirect({ ...env, TAIL_WORKER_NAME: "chiridion-user-logs-tail" }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js" },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toEqual([{ service: "chiridion-user-logs-tail" }]);
  });

  it("preserves project-declared tail consumers and dedupes the platform one", async () => {
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    await deployWorkerModulesDirect({ ...env, TAIL_WORKER_NAME: "chiridion-user-logs-tail" }, {
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
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

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
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js" },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls[0]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toBeUndefined();
  });

  it("normalizes wrangler durable object migrations for first deploy", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json({ success: false, errors: [{ code: 10092, message: "not found" }], result: null }, { status: 404 });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        migrations: [{ tag: "v1", new_sqlite_classes: ["CounterDO"] }],
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

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
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));

    await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        migrations: [],
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const upload = fetcher.mock.calls.find((call) => call[1]?.method === "PUT")!;
    const form = upload[1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata).not.toHaveProperty("migrations");
  });

  it("skips durable object migrations that are already applied", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json({ success: true, result: { script: { migration_tag: "v2", version_id: "version-1" } } });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(env, {
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
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    const form = fetcher.mock.calls[1]![1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.migrations).toBeUndefined();
  });

  it("uploads only pending durable object migration steps after the current tag", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/scripts/demo-app--acme")) {
        return Response.json({ success: true, result: { script: { migration_tag: "v1", version_id: "version-1" } } });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await deployWorkerModulesDirect(env, {
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
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
    }, { fetcher: fetcher as unknown as typeof fetch });

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
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        const body = JSON.parse(init?.body as string) as { manifest: Record<string, { hash: string }> };
        return Response.json({ success: true, result: { jwt: "upload-jwt", buckets: [Object.values(body.manifest).map((entry) => entry.hash)] } });
      }
      if (url.endsWith("/workers/assets/upload?base64=true")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt" } });
      }
      return Response.json({ success: true, result: { id: "version-1", has_assets: true } });
    });
    const assetEnv = {
      ...env,
      APP_KV: { put: vi.fn(async (key: string, value: string) => kv.set(key, value)) },
      R2_BUCKET: { put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })) },
    };

    const result = await deployWorkerModulesDirect(assetEnv, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: {
        main_module: "index.js",
        assets: { directory: "../client", binding: "STATIC_ASSETS" },
      },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(true);
    expect(result.sideEffects.artifactCacheKey).toMatch(/^deploy-artifacts\/org-1\/workspace-1\/project-1\/demo-app--acme\/[a-f0-9]{64}\.json$/);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const [sessionUrl, sessionInit] = fetcher.mock.calls[0]!;
    expect(sessionUrl).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme/assets-upload-session");
    expect(sessionInit).toMatchObject({ method: "POST" });
    const sessionBody = JSON.parse(sessionInit?.body as string);
    expect(sessionBody.manifest["/index.html"]).toMatchObject({ size: 5 });
    const assetHash = sessionBody.manifest["/index.html"].hash;
    const [, uploadInit] = fetcher.mock.calls[1]!;
    expect((uploadInit?.headers as Record<string, string>).Authorization).toBe("Bearer upload-jwt");
    const uploadForm = uploadInit?.body as FormData;
    expect(await (uploadForm.get(assetHash) as Blob).text()).toBe("aGVsbG8=");
    const stored = kv.get(selfhostAssetsKey("demo-app--acme"));
    expect(stored).toBeTruthy();
    const record = JSON.parse(stored!);
    expect(record.manifest["index.html"]).toMatchObject({ size: 5, contentType: "text/html; charset=utf-8" });
    expect(r2.has(selfhostAssetObjectKey("demo-app--acme", record.manifest["index.html"].hash))).toBe(true);
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
    expect(cachedRecord.modules).toEqual([{ name: "index.js", contentType: "application/javascript+module", contentBase64: "ZXhwb3J0IGRlZmF1bHQge307" }]);
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

  it("streams a large asset set through bounded batches and uploads every asset", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    // One bucket per asset so the native upload pass touches every asset.
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        const body = JSON.parse(init?.body as string) as { manifest: Record<string, { hash: string }> };
        return Response.json({
          success: true,
          result: { jwt: "upload-jwt", buckets: Object.values(body.manifest).map((entry) => [entry.hash]) },
        });
      }
      if (url.endsWith("/workers/assets/upload?base64=true")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt" } });
      }
      return Response.json({ success: true, result: { id: "version-1", has_assets: true } });
    });

    const tracker = assetTracker();
    const assets = Array.from({ length: 20 }, (_, index) =>
      tracker.asset(`assets/file-${index}.txt`, `payload-${index}`, "text/plain"));

    const result = await deployWorkerModulesDirect({
      ...env,
      APP_KV: { put: vi.fn(async (key: string, value: string) => kv.set(key, value)) },
      R2_BUCKET: { put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })) },
    }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client", binding: "ASSETS" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets,
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(true);

    // Every asset made it into the upload-session manifest with the right size.
    const sessionBody = JSON.parse(fetcher.mock.calls[0]![1]?.body as string);
    expect(Object.keys(sessionBody.manifest)).toHaveLength(20);
    for (let index = 0; index < 20; index += 1) {
      expect(sessionBody.manifest[`/assets/file-${index}.txt`]).toMatchObject({ size: `payload-${index}`.length });
    }

    // Every asset was uploaded (one bucket each) and stored to R2 for rollback.
    const uploadCalls = fetcher.mock.calls.filter(([callUrl]) => String(callUrl).endsWith("/workers/assets/upload?base64=true"));
    expect(uploadCalls).toHaveLength(20);
    const storedRecord = JSON.parse(kv.get(selfhostAssetsKey("demo-app--acme"))!);
    expect(Object.keys(storedRecord.manifest)).toHaveLength(20);

    // Reads are lazy and batched: no more than the batch width were ever in
    // flight at once, so the whole asset set is never resident together.
    expect(tracker.maxInFlight).toBeGreaterThan(1);
    expect(tracker.maxInFlight).toBeLessThanOrEqual(8);
    // Fingerprint pass + R2 rollback pass + native upload pass each re-read.
    expect(tracker.totalReads).toBe(60);
  });

  it("skips assets above Cloudflare's per-file limit without reading or failing the deploy", async () => {
    const oversizedRead = vi.fn(async () => {
      throw new Error("oversized asset must not cross sandbox RPC");
    });
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        const body = JSON.parse(init?.body as string) as { manifest: Record<string, { hash: string }> };
        return Response.json({
          success: true,
          result: { jwt: "upload-jwt", buckets: [Object.values(body.manifest).map((entry) => entry.hash)] },
        });
      }
      if (url.endsWith("/workers/assets/upload?base64=true")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt" } });
      }
      return Response.json({ success: true, result: { id: "version-1", has_assets: true } });
    });

    const result = await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client", binding: "ASSETS" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [
        lazyAsset("index.html", "hello", "text/html; charset=utf-8"),
        {
          path: "assets/hero.png",
          contentType: "image/png",
          size: 25 * 1024 * 1024 + 1,
          read: oversizedRead,
        },
      ],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(true);
    expect(oversizedRead).not.toHaveBeenCalled();
    expect(result.skippedAssets).toEqual([{
      path: "assets/hero.png",
      size: 25 * 1024 * 1024 + 1,
      limit: 25 * 1024 * 1024,
      reason: "asset_too_large",
    }]);
    expect(result.warnings).toEqual(expect.arrayContaining([
      'Skipped static asset "assets/hero.png" (25.0 MiB, 26214401 bytes): Cloudflare Workers allows at most 25 MiB per asset. The deployed app will return 404 for this file.',
    ]));
    const sessionBody = JSON.parse(fetcher.mock.calls[0]![1]?.body as string);
    expect(Object.keys(sessionBody.manifest)).toEqual(["/index.html"]);
  });

  it("keeps an asset exactly at Cloudflare's 25 MiB boundary", async () => {
    const boundaryRead = vi.fn(async () => new Uint8Array());
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt", buckets: [] } });
      }
      return Response.json({ success: true, result: { id: "version-1", has_assets: true } });
    });

    const result = await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [{ path: "assets/boundary.bin", size: 25 * 1024 * 1024, read: boundaryRead }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(true);
    expect(result.skippedAssets).toBeUndefined();
    expect(boundaryRead).toHaveBeenCalled();
  });

  it("deploys module-only when every static asset is oversized", async () => {
    const oversizedRead = vi.fn(async () => {
      throw new Error("oversized asset must not cross sandbox RPC");
    });
    const fetcher = vi.fn(async () =>
      Response.json({ success: true, result: { id: "version-1", has_assets: false } }));

    const result = await deployWorkerModulesDirect(env, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client", binding: "ASSETS" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [{
        path: "assets/hero.png",
        contentType: "image/png",
        size: 30 * 1024 * 1024,
        read: oversizedRead,
      }],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(true);
    expect(oversizedRead).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    const metadata = JSON.parse(await ((fetcher.mock.calls[0]![1]?.body as FormData).get("metadata") as Blob).text());
    expect(metadata.assets).toBeUndefined();
    expect(metadata.bindings).not.toContainEqual(expect.objectContaining({ type: "assets" }));
  });

  it("does not publish the active self-host asset manifest when script upload fails", async () => {
    const kvPut = vi.fn(async () => undefined);
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt", buckets: [] } });
      }
      return Response.json({ success: false, errors: [{ message: "script failed" }] }, { status: 500 });
    });

    const result = await deployWorkerModulesDirect({
      ...env,
      APP_KV: { put: kvPut },
      R2_BUCKET: { put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })) },
    }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result.success).toBe(false);
    expect(kvPut).not.toHaveBeenCalledWith(selfhostAssetsKey("demo-app--acme"), expect.any(String));
  });

  it("continues native asset deploy when the local rollback asset cache R2 put fails", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        const body = JSON.parse(init?.body as string) as { manifest: Record<string, { hash: string }> };
        return Response.json({ success: true, result: { jwt: "upload-jwt", buckets: [Object.values(body.manifest).map((entry) => entry.hash)] } });
      }
      if (url.endsWith("/workers/assets/upload?base64=true")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt" } });
      }
      return Response.json({ success: true, result: { id: "version-1", has_assets: true } });
    });
    const r2Put = vi.fn(async () => {
      throw new Error("put: Unspecified error (0)");
    });

    const result = await deployWorkerModulesDirect({
      ...env,
      APP_KV: { put: vi.fn(async () => undefined) },
      R2_BUCKET: { put: r2Put },
    }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
    }, { fetcher: fetcher as unknown as typeof fetch });

    expect(result).toMatchObject({
      success: true,
      result: { success: true, result: { has_assets: true } },
    });
    expect(result.warnings).toEqual(["Deploy artifact cache unavailable: put: Unspecified error (0)"]);
    expect(result.sideEffects.artifactCacheKey).toBeUndefined();
    expect(r2Put).toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(String(fetcher.mock.calls[2]![0])).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme");
    const metadata = JSON.parse(await ((fetcher.mock.calls[2]![1]?.body as FormData).get("metadata") as Blob).text());
    expect(metadata.assets).toEqual({ jwt: "assets-jwt" });
  });

  it("includes Cloudflare error bodies when asset upload session returns result null", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        return Response.json({
          success: false,
          errors: [{ code: 10001, message: "upload session denied" }],
          messages: [],
          result: null,
        }, { status: 400 });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });

    await expect(deployWorkerModulesDirect({
      ...env,
      APP_KV: { put: vi.fn(async () => undefined) },
      R2_BUCKET: { put: vi.fn(async () => undefined) },
    }, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
    }, { fetcher: fetcher as unknown as typeof fetch })).rejects.toThrow(/upload session denied/);
  });

  it("rolls back by replaying a cached deploy artifact", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/assets-upload-session")) {
        const body = JSON.parse(init?.body as string) as { manifest: Record<string, { hash: string }> };
        return Response.json({ success: true, result: { jwt: "upload-jwt", buckets: [Object.values(body.manifest).map((entry) => entry.hash)] } });
      }
      if (url.endsWith("/workers/assets/upload?base64=true")) {
        return Response.json({ success: true, result: { jwt: "assets-jwt" } });
      }
      return Response.json({ success: true, result: { id: "version-1" } });
    });
    const rollbackEnv = {
      ...env,
      APP_KV: { put: vi.fn(async (key: string, value: string) => kv.set(key, value)) },
      R2_BUCKET: {
        put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })),
        get: vi.fn(async (key: string) => {
          const item = r2.get(key);
          return item ? {
            text: async () => item.body as string,
            arrayBuffer: async () => item.body instanceof Uint8Array
              ? item.body.buffer.slice(item.body.byteOffset, item.body.byteOffset + item.body.byteLength)
              : new TextEncoder().encode(item.body).buffer,
          } : null;
        }),
      },
    };
    const deploy = await deployWorkerModulesDirect(rollbackEnv, {
      scriptName: "demo-app",
      hostname: "camelai.dev",
      identity,
      metadata: { main_module: "index.js", assets: { directory: "../client" } },
      modules: [{ name: "index.js", contentType: "application/javascript+module", content: "export default {};" }],
      assets: [lazyAsset("index.html", "hello", "text/html; charset=utf-8")],
    }, { fetcher: fetcher as unknown as typeof fetch });
    kv.clear();
    fetcher.mockClear();

    const rollback = await rollbackWorkerDeployFromArtifactCache(rollbackEnv, {
      artifactCacheKey: deploy.sideEffects.artifactCacheKey!,
      hostname: "camelai.dev",
      expected: { orgId: "org-1", workspaceId: "workspace-1", scriptName: "demo-app" },
      threadId: "thread-rollback",
    }, { fetcher: fetcher as unknown as typeof fetch });

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
    expect(String(fetcher.mock.calls[0]![0])).toContain("/assets-upload-session");
    expect(String(fetcher.mock.calls[1]![0])).toContain("/workers/assets/upload?base64=true");
    const [url, init] = fetcher.mock.calls[2]!;
    expect(url).toBe("https://api.cloudflare.com/client/v4/accounts/account-id/workers/dispatch/namespaces/dispatch-ns/scripts/demo-app--acme");
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
    const r2 = new Map<string, { body: string | Uint8Array; options?: unknown }>();
    const fetcher = vi.fn(async () => Response.json({ success: true, result: { id: "version-1" } }));
    const rollbackEnv = {
      ...env,
      TAIL_WORKER_NAME: "chiridion-user-logs-tail",
      APP_KV: { put: vi.fn(async () => undefined) },
      R2_BUCKET: {
        put: vi.fn(async (key: string, body: string | Uint8Array, options?: unknown) => r2.set(key, { body, options })),
        get: vi.fn(async (key: string) => {
          const item = r2.get(key);
          return item ? { text: async () => item.body as string } : null;
        }),
      },
    };
    // Cache an artifact whose metadata predates the tail-consumer behavior.
    const artifactCacheKey = "deploy-artifacts/org-1/workspace-1/project-1/demo-app--acme/legacy.json";
    r2.set(artifactCacheKey, {
      body: JSON.stringify({
        schemaVersion: 1,
        createdAt: "2026-01-01T00:00:00.000Z",
        scriptName: "demo-app",
        dispatchScriptName: "demo-app--acme",
        identity,
        metadata: { main_module: "index.js" },
        modules: [{ name: "index.js", contentType: "application/javascript+module", contentBase64: "ZXhwb3J0IGRlZmF1bHQge307" }],
        assetsRecord: null,
      }),
    });

    await rollbackWorkerDeployFromArtifactCache(rollbackEnv, {
      artifactCacheKey,
      hostname: "camelai.dev",
      expected: { orgId: "org-1", workspaceId: "workspace-1", scriptName: "demo-app" },
    }, { fetcher: fetcher as unknown as typeof fetch });

    const upload = fetcher.mock.calls.find((call) => call[1]?.method === "PUT")!;
    const form = upload[1]?.body as FormData;
    const metadata = JSON.parse(await (form.get("metadata") as Blob).text());
    expect(metadata.tail_consumers).toEqual([{ service: "chiridion-user-logs-tail" }]);
  });
});
