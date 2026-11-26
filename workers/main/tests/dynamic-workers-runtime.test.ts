import { describe, expect, it, vi } from "vitest";

import {
  dynamicBundleObjectKey,
  dynamicDoAliasKey,
  extractCodemodeLoaderBindingNames,
  extractHasAssetsBinding,
  extractLocalDoBindings,
  isDynamicRuntimeMode,
  type DynamicWorkerBundleRecord,
} from "../src/dynamic-worker-registry";
import {
  deployWorkerModulesDirect,
  rollbackWorkerDeployFromArtifactCache,
  type DirectDeployAsset,
} from "../src/direct-dispatch-deploy";
import { refreshAppRegistryAfterDeploy } from "../src/services/deploy";
import {
  checkShardQuota,
  createEmptyShardQuotaState,
  emitAppUsageMetric,
  quotaLimitsForTier,
  resolveQuotaTier,
  rolloverShardQuotaState,
  UTC_DAY_MS,
} from "../../dispatcher/src/dynamic/quota-policy";
import { classifyOutboundUrl } from "../../dispatcher/src/dynamic/outbound-gate";
import { generateDynamicWorkerWrapperSource } from "../../dispatcher/src/dynamic/wrapper-generator";
import { clearBundleStoreCachesForTest } from "../../dispatcher/src/dynamic/bundle-store";
import { handleWorkerRequest } from "../../dispatcher/src/index";

function makeAsset(path: string, body: string, contentType?: string): DirectDeployAsset {
  const bytes = new TextEncoder().encode(body);
  return {
    path,
    ...(contentType ? { contentType } : {}),
    size: bytes.byteLength,
    read: async () => bytes,
  };
}

describe("dynamic-worker-registry helpers", () => {
  it("builds stable R2 bundle keys and DO alias keys", () => {
    expect(dynamicBundleObjectKey("my-app--acme85", "0123456789abcdef")).toBe(
      "dynamic-bundles/my-app--acme85/0123456789abcdef.json",
    );
    expect(dynamicDoAliasKey("my-app--acme85", "CounterDO", "abc123")).toBe(
      "do_alias:my-app--acme85:CounterDO:abc123",
    );
    expect(isDynamicRuntimeMode("dynamic")).toBe(true);
    expect(isDynamicRuntimeMode("dynamic_migrating")).toBe(true);
    expect(isDynamicRuntimeMode("wfp")).toBe(false);
    expect(isDynamicRuntimeMode(undefined)).toBe(false);
  });

  it("extracts local DO bindings, assets, and codemode loader bindings", () => {
    const bindings: Array<Record<string, unknown>> = [
      { type: "durable_object_namespace", name: "COUNTER", class_name: "CounterDO" },
      { type: "durable_object_namespace", name: "EXT", class_name: "ExtDO", script_name: "other" },
      { type: "assets", name: "ASSETS" },
      { type: "worker_loader", name: "LOADER" },
    ];
    expect(extractLocalDoBindings(bindings)).toEqual({ COUNTER: "CounterDO" });
    expect(extractHasAssetsBinding(bindings)).toBe(true);
    expect(extractCodemodeLoaderBindingNames(bindings)).toEqual(["LOADER"]);
  });
});

describe("quota-policy", () => {
  it("enforces tiered daily and per-event SQLite and DB size caps", () => {
    expect(resolveQuotaTier(undefined)).toBe("free");
    expect(resolveQuotaTier("pro")).toBe("pro");
    expect(resolveQuotaTier("exempt")).toBe("exempt");
    expect(quotaLimitsForTier("exempt")).toBeNull();

    const freeState = createEmptyShardQuotaState(1_700_000_000_000);
    expect(checkShardQuota({ tier: "free", daily: freeState }).allowed).toBe(true);

    expect(
      checkShardQuota({
        tier: "free",
        daily: { ...freeState, rowsWritten: 100_000 },
      }),
    ).toMatchObject({ allowed: false, reason: "daily_rows_written" });

    expect(
      checkShardQuota({
        tier: "free",
        daily: freeState,
        eventRowsWritten: 10_001,
      }),
    ).toMatchObject({ allowed: false, reason: "event_rows_written" });

    expect(
      checkShardQuota({
        tier: "free",
        daily: freeState,
        dbSizeBytes: 500 * 1024 * 1024,
      }),
    ).toMatchObject({ allowed: false, reason: "db_size_bytes" });

    // Pro tier allows 10x free writes
    expect(
      checkShardQuota({
        tier: "pro",
        daily: { ...freeState, rowsWritten: 500_000 },
      }).allowed,
    ).toBe(true);

    // Exempt tier is never hard-blocked
    expect(
      checkShardQuota({
        tier: "exempt",
        daily: { ...freeState, rowsWritten: 999_999_999 },
      }).allowed,
    ).toBe(true);
  });

  it("rolls over daily counters cleanly on a new UTC day", () => {
    const day1 = 100 * UTC_DAY_MS + 1234;
    const state = {
      ...createEmptyShardQuotaState(day1),
      rowsWritten: 50_000,
      rowsRead: 1_000_000,
    };
    expect(rolloverShardQuotaState(state, day1 + 1000).rowsWritten).toBe(50_000);
    expect(rolloverShardQuotaState(state, day1 + UTC_DAY_MS).rowsWritten).toBe(0);
  });

  it("emits structured Analytics Engine data points", () => {
    const writeDataPoint = vi.fn();
    emitAppUsageMetric({ writeDataPoint } as unknown as AnalyticsEngineDataset, {
      dispatchScriptName: "demo--acme",
      orgId: "org-1",
      className: "CounterDO",
      eventKind: "do_fetch",
      quotaTier: "free",
      rowsRead: 42,
      rowsWritten: 7,
      durationMs: 12,
      dbSizeBytes: 4096,
    });
    expect(writeDataPoint).toHaveBeenCalledWith({
      indexes: ["demo--acme"],
      blobs: ["org-1", "CounterDO", "do_fetch", "free"],
      doubles: [42, 7, 12, 4096, 0, 0],
    });
  });
});

describe("outbound-gate SSRF protection", () => {
  it("blocks private, loopback, metadata, IPv6-mapped, obfuscated IP, and non-HTTP URLs", () => {
    const blocked = [
      "http://127.0.0.1/admin",
      "http://169.254.169.254/latest/meta-data/",
      "http://10.0.0.1/secret",
      "http://172.16.5.10/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://localhost:8787/",
      "http://service.internal/",
      "http://metadata.google.internal/computeMetadata/v1/",
      "http://[::1]/",
      "http://[::ffff:127.0.0.1]/",
      "http://[fc00::1]/",
      "http://[fe80::1]/",
      "http://0x7f000001/",
      "http://2130706433/",
      "file:///etc/passwd",
    ];
    for (const url of blocked) {
      expect(classifyOutboundUrl(url).allowed, `expected blocked: ${url}`).toBe(false);
    }
  });

  it("allows public HTTP and HTTPS URLs", () => {
    expect(classifyOutboundUrl("https://api.github.com/repos/qaml-ai/camelAI").allowed).toBe(true);
    expect(classifyOutboundUrl("https://8.8.8.8/dns-query").allowed).toBe(true);
  });
});

describe("wrapper-generator", () => {
  it("generates zero-top-level-IO wrapper with Object.defineProperty metering, alarm bridge, DO router, and codemode shim", () => {
    const record: DynamicWorkerBundleRecord = {
      schemaVersion: 2,
      appId: "demo--acme",
      scriptName: "demo",
      dispatchScriptName: "demo--acme",
      orgId: "org-1",
      orgSlug: "acme",
      workspaceId: "ws-1",
      bundleSha: "deadbeef12345678",
      createdAt: "2026-11-26T00:00:00Z",
      compatibilityDate: "2026-07-13",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "index.js",
      modules: {
        "index.js": { name: "index.js", type: "js", content: "export default {};" },
      },
      bindings: [
        { type: "durable_object_namespace", name: "AGENT", class_name: "ChatAgent" },
        { type: "worker_loader", name: "LOADER" },
      ],
      doBindings: { AGENT: "ChatAgent" },
      doClasses: ["ChatAgent"],
      hasAssets: false,
      hasCodemodeLoader: true,
    };

    const source = generateDynamicWorkerWrapperSource(record);
    expect(source).toContain("export class ChatAgent extends ChiridionMeteredDurableObject");
    expect(source).toContain('Object.defineProperty(sql, "exec"');
    expect(source).toContain('Object.defineProperty(storage, "setAlarm"');
    expect(source).toContain("this.__router.fetchObject(");
    expect(source).toContain("this.__router.rpcObject(");
    expect(source).toContain("proxy.invokeEntrypoint(");
    expect(source).toContain('const CODEMODE_BINDING_NAMES = ["LOADER"]');
    // Ensure we never proxy ctx
    expect(source).not.toContain("new Proxy(ctx");
  });
});

describe("deployWorkerModulesDirect -> Dynamic Workers publishing & rollback", () => {
  it("publishes directly to R2 bundle + APP_KV without calling WfP API when DYNAMIC_WORKERS_NEW_APPS_ENABLED=true", async () => {
    const kv = new Map<string, string>();
    const r2 = new Map<string, string | Uint8Array>();
    const fetcher = vi.fn();

    const env = {
      CF_WORKER_NAME: "chiridion-app",
      DYNAMIC_WORKERS_NEW_APPS_ENABLED: "true",
      APP_KV: {
        get: vi.fn(async (k: string) => kv.get(k) ?? null),
        put: vi.fn(async (k: string, v: string) => {
          kv.set(k, v);
        }),
      } as unknown as KVNamespace,
      R2_BUCKET: {
        put: vi.fn(async (k: string, v: string | Uint8Array) => {
          r2.set(k, v);
        }),
        get: vi.fn(async (k: string) => {
          const val = r2.get(k);
          if (val === undefined) return null;
          return {
            text: async () => (typeof val === "string" ? val : new TextDecoder().decode(val)),
            arrayBuffer: async () =>
              typeof val === "string" ? new TextEncoder().encode(val).buffer : val.buffer,
          };
        }),
      } as unknown as R2Bucket,
    };

    const result = await deployWorkerModulesDirect(
      env,
      {
        scriptName: "tracker",
        hostname: "camelai.dev",
        identity: {
          orgId: "org-1",
          orgSlug: "acme85",
          workspaceId: "ws-1",
          userId: "user-1",
        },
        metadata: {
          main_module: "index.js",
          compatibility_date: "2026-07-13",
          compatibility_flags: ["nodejs_compat"],
          assets: { directory: "dist" },
          bindings: [
            { type: "durable_object_namespace", name: "STORE", class_name: "TrackerDO" },
          ],
        },
        modules: [
          {
            name: "index.js",
            contentType: "application/javascript+module",
            content: "export class TrackerDO {}; export default { fetch: () => new Response('ok') };",
          },
        ],
        assets: [makeAsset("index.html", "<h1>Hello</h1>", "text/html")],
      },
      {
        fetcher: fetcher as unknown as typeof fetch,
        onDeploySideEffects: async (info) => {
          await refreshAppRegistryAfterDeploy(env as never, info, true);
        },
      },
    );

    expect(result.success).toBe(true);
    expect(result.result).toMatchObject({ source: "dynamic" });
    expect(fetcher).not.toHaveBeenCalled();

    const registry = JSON.parse(kv.get("script:tracker--acme85")!);
    expect(registry).toMatchObject({
      org_id: "org-1",
      org_slug: "acme85",
      is_public: true,
      runtime_mode: "dynamic",
      do_classes: ["TrackerDO"],
      has_assets: true,
    });
    expect(registry.bundle_r2_key).toMatch(/^dynamic-bundles\/tracker--acme85\/[0-9a-f]{16}\.json$/);

    const bundle = JSON.parse(r2.get(registry.bundle_r2_key) as string) as DynamicWorkerBundleRecord;
    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.doBindings).toEqual({ STORE: "TrackerDO" });

    // Rollback from artifact cache also stays purely on Dynamic Workers without calling WfP
    const rollback = await rollbackWorkerDeployFromArtifactCache(
      env,
      {
        artifactCacheKey: result.sideEffects.artifactCacheKey!,
        hostname: "camelai.dev",
      },
      { fetcher: fetcher as unknown as typeof fetch },
    );
    expect(rollback.success).toBe(true);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("dispatcher edge routing for runtime_mode=dynamic", () => {
  it("serves static assets at edge and routes dynamic HTTP to USER_APP_LOADER without touching WfP", async () => {
    clearBundleStoreCachesForTest();
    const bundleKey = dynamicBundleObjectKey("demo--acme85", "abcdef0123456789");
    const bundleRecord: DynamicWorkerBundleRecord = {
      schemaVersion: 2,
      appId: "demo--acme85",
      scriptName: "demo",
      dispatchScriptName: "demo--acme85",
      orgId: "org-1",
      orgSlug: "acme85",
      workspaceId: "ws-1",
      bundleSha: "abcdef0123456789",
      createdAt: "2026-11-26T00:00:00Z",
      compatibilityDate: "2026-07-13",
      compatibilityFlags: ["nodejs_compat"],
      mainModule: "index.js",
      modules: {
        "index.js": { name: "index.js", type: "js", content: "export default {};" },
      },
      bindings: [{ type: "assets", name: "ASSETS" }],
      doBindings: {},
      doClasses: [],
      hasAssets: true,
      hasCodemodeLoader: false,
    };

    const wfpFetch = vi.fn();
    const dynamicFetch = vi.fn(async () => new Response("from-dynamic-worker"));
    const loaderGet = vi.fn((_id: string, getCode: () => unknown) => {
      // Trigger code factory to verify wrapper + outbound gate assembly.
      getCode();
      return {
        getEntrypoint: () => ({ fetch: dynamicFetch }),
      };
    });
    const assetFetch = vi.fn(async (req: Request) =>
      new URL(req.url).pathname === "/assets/app.js"
        ? new Response("console.log('asset')", { status: 200 })
        : new Response("Not Found", { status: 404 }),
    );
    const writeDataPoint = vi.fn();

    const env = {
      MAIN_APP_URL: "https://camelai.dev",
      DISPATCHER: { get: () => ({ fetch: wfpFetch }) },
      USER_APP_LOADER: { get: loaderGet },
      APP_USAGE_AE: { writeDataPoint },
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === "script:demo--acme85"
            ? JSON.stringify({
                org_id: "org-1",
                org_slug: "acme85",
                is_public: true,
                runtime_mode: "dynamic",
                bundle_r2_key: bundleKey,
                bundle_sha: "abcdef0123456789",
                has_assets: true,
              })
            : null,
        ),
      },
      R2_BUCKET: {
        get: vi.fn(async (key: string) =>
          key === bundleKey
            ? { text: async () => JSON.stringify(bundleRecord) }
            : null,
        ),
      },
    };

    const ctx = {
      waitUntil: vi.fn(),
      exports: {
        AssetsVirtualBinding: () => ({ fetch: assetFetch }),
        OutboundGate: () => ({ fetch: vi.fn() }),
        TenantDoRouter: () => ({}),
        UserLogsTail: () => ({}),
      },
    };

    // 1. Static asset hits edge AssetsVirtualBinding directly — zero USER_APP_LOADER or WfP calls!
    const assetResp = await handleWorkerRequest(
      new Request("https://demo-acme85.camelai.app/assets/app.js"),
      env as never,
      ctx as unknown as ExecutionContext,
      "demo",
      "demo--acme85",
    );
    expect(assetResp.status).toBe(200);
    await expect(assetResp.text()).resolves.toBe("console.log('asset')");
    expect(loaderGet).not.toHaveBeenCalled();
    expect(wfpFetch).not.toHaveBeenCalled();

    // 2. API request loads R2 bundle and dispatches through USER_APP_LOADER — zero WfP calls!
    const apiResp = await handleWorkerRequest(
      new Request("https://demo-acme85.camelai.app/api/ping"),
      env as never,
      ctx as unknown as ExecutionContext,
      "demo",
      "demo--acme85",
    );
    expect(apiResp.status).toBe(200);
    await expect(apiResp.text()).resolves.toBe("from-dynamic-worker");
    expect(loaderGet).toHaveBeenCalledOnce();
    expect(dynamicFetch).toHaveBeenCalledOnce();
    expect(wfpFetch).not.toHaveBeenCalled();
  });
});
