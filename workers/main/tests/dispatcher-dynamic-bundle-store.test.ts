import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearBundleStoreCachesForTest,
  loadDynamicEnvOverlay,
  loadDynamicUserWorker,
  type BundleStoreEnv,
  type ManagedAppEnvVar,
} from "../../dispatcher/src/dynamic/bundle-store";
import {
  dynamicSecretsR2Key,
  encryptSecretsPayload,
} from "../../dispatcher/src/dynamic/secret-crypto";
import type { DynamicWorkerBundleRecord } from "../src/dynamic-worker-registry";

const SCRIPT = "demo--acme85";
const WORKSPACE = "ws-1";
const ORG = "org-1";
const KEY = "INT_STRIPE_BILLING_SECRET_KEY";
const SECOND_KEY = "INT_SLACK_MESSAGES_BOT_TOKEN";
const CACHE_TTL_MS = 5 * 60_000;

function secret(key: string, value: string) {
  return { key, value, isSecret: true as const };
}

function redacted(name: string) {
  return { name, type: "secret_text" };
}

function makeRecord(bindings: DynamicWorkerBundleRecord["bindings"]): DynamicWorkerBundleRecord {
  return {
    schemaVersion: 2,
    appId: SCRIPT,
    scriptName: "demo",
    dispatchScriptName: SCRIPT,
    orgId: ORG,
    orgSlug: "acme85",
    workspaceId: WORKSPACE,
    bundleSha: "abcdef0123456789",
    createdAt: "2026-11-26T00:00:00Z",
    compatibilityDate: "2026-07-13",
    compatibilityFlags: [],
    mainModule: "index.js",
    modules: { "index.js": { name: "index.js", type: "js", content: "export default {};" } },
    bindings,
    doBindings: {},
    doClasses: [],
    hasAssets: false,
    hasCodemodeLoader: false,
  };
}

function captureWorkerConfig(
  record: DynamicWorkerBundleRecord,
  { vars, envHash }: { vars: ManagedAppEnvVar[]; envHash: string },
  supervisorKey?: string,
): { isolateId: string; code: WorkerLoaderWorkerCode } {
  const result = {} as { isolateId: string; code: WorkerLoaderWorkerCode };
  const get = (isolateId: string, makeCode: () => WorkerLoaderWorkerCode) => {
    result.isolateId = isolateId;
    result.code = makeCode();
    return {};
  };
  loadDynamicUserWorker({
    loader: { get } as unknown as WorkerLoader,
    record,
    exports: {},
    managedOverlay: vars,
    envHash,
    quotaTier: "free",
    supervisorKey,
  });
  return result;
}

describe("dispatcher migrated secrets overlay", () => {
  beforeEach(clearBundleStoreCachesForTest);
  afterEach(() => vi.restoreAllMocks());

  it("keeps HTTP and facet keys stable for reordered secrets and changes both after a same-count rotation", async () => {
    const epoch = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
    const masterSecret = "test-migration-key";
    const name = "APP_SECRET";
    const secondName = "OTHER_SECRET";
    let envelope = await encryptSecretsPayload(masterSecret, { [name]: "original", [secondName]: "unchanged" });
    const get = vi.fn(async () => ({ json: async () => envelope }));
    const env = {
      MIGRATION_HMAC_SECRET: masterSecret,
      R2_BUCKET: { get } as unknown as R2Bucket,
    };
    const record = makeRecord([redacted(name), redacted(secondName)]);

    const original = await loadDynamicEnvOverlay(env, record);
    envelope = await encryptSecretsPayload(masterSecret, { [secondName]: "unchanged", [name]: "original" });
    clock.mockReturnValue(epoch + CACHE_TTL_MS);
    expect((await loadDynamicEnvOverlay(env, record)).envHash).toBe(original.envHash);

    envelope = await encryptSecretsPayload(masterSecret, { [secondName]: "unchanged", [name]: "rotation" });
    clock.mockReturnValue(epoch + 2 * CACHE_TTL_MS);
    const rotated = await loadDynamicEnvOverlay(env, record);
    expect(rotated.vars).toEqual([secret(secondName, "unchanged"), secret(name, "rotation")]);
    for (const supervisorKey of [undefined, "facet-1"]) {
      const before = captureWorkerConfig(record, original, supervisorKey);
      const after = captureWorkerConfig(record, rotated, supervisorKey);
      expect(after.isolateId).not.toBe(before.isolateId);
      expect(after.code.env).toHaveProperty(name, "rotation");
    }
  });
});

describe("dispatcher legacy integration env overlay", () => {
  beforeEach(clearBundleStoreCachesForTest);
  afterEach(() => vi.restoreAllMocks());

  it("skips the broker unless a legacy integration secret is redacted", async () => {
    const resolveLegacyIntegrationEnvVars = vi.fn();
    const env = { MAIN_APP_BROKER: { resolveLegacyIntegrationEnvVars } };
    const record = makeRecord([
      { name: "INT_PLAIN", type: "plain_text" },
      { ...redacted("INT_INLINE_TEXT"), text: "inline-text" },
      { ...redacted("INT_INLINE_VALUE"), value: "inline-value" },
      { ...redacted("INT_EMPTY_TEXT"), text: "" },
      { ...redacted("INT_EMPTY_VALUE"), value: "" },
      redacted("NON_INTEGRATION_SECRET"),
      { name: 42, type: "secret_text" },
    ]);

    await expect(loadDynamicEnvOverlay(env, record)).resolves.toEqual({ vars: [], envHash: "0" });
    expect(resolveLegacyIntegrationEnvVars).not.toHaveBeenCalled();
  });

  it("hydrates the bundle's redacted INT_* keys and leaves unrelated bindings alone", async () => {
    const resolveLegacyIntegrationEnvVars = vi.fn(async () => [
      secret(KEY, "restored-secret"),
      secret("INT_UNREQUESTED", "unrelated-secret"),
    ]);
    const env = { MAIN_APP_BROKER: { resolveLegacyIntegrationEnvVars } };
    const record = makeRecord([
      { ...redacted(KEY), text: null, value: 12 },
      redacted(KEY),
      redacted(SECOND_KEY),
      redacted("UNRELATED_REDACTED"),
      { ...redacted("INT_ALREADY_PRESENT"), text: "in-bundle" },
    ]);

    const overlay = await loadDynamicEnvOverlay(env, record);
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledExactlyOnceWith(ORG, WORKSPACE, [
      SECOND_KEY,
      KEY,
    ]);
    expect(overlay.vars).toEqual([secret(KEY, "restored-secret")]);
    expect(overlay.envHash).not.toBe("0");
    const { code } = captureWorkerConfig(record, overlay);
    expect(code.env).toMatchObject({
      [KEY]: "restored-secret",
      [SECOND_KEY]: "",
      UNRELATED_REDACTED: "",
      INT_ALREADY_PRESENT: "in-bundle",
    });
    expect(code.env).not.toHaveProperty("INT_UNREQUESTED");
  });

  it("prefers managed env and live integration tokens while preserving migrated fallbacks", async () => {
    const bigQueryKey = "INT_BIGQUERY_ERP_ACCESS_TOKEN";
    const deletedKey = "INT_DELETED_API_KEY";
    const customKey = "FIRECRAWLER_API_KEY";
    const unresolvedKey = "INT_OTHER_MISSING_API_KEY";
    const masterSecret = "test-migration-key";
    const encrypted = await encryptSecretsPayload(masterSecret, {
      [KEY]: "migrated-value-overridden-by-managed",
      [bigQueryKey]: "expired-token",
      [deletedKey]: "deleted-integration-snapshot",
      [customKey]: "custom-secret",
    });
    const getAppEnvVarsForDeploy = vi.fn(async () => [secret(KEY, "")]);
    const get = vi.fn(async (key: string) =>
      key === dynamicSecretsR2Key(SCRIPT) ? { json: async () => encrypted } : null,
    );
    const resolveLegacyIntegrationEnvVars = vi.fn(async () => [
      secret(SECOND_KEY, "legacy-value"),
      secret(bigQueryKey, "fresh-token"),
      secret(KEY, "legacy-value-overridden-by-managed"),
    ]);
    const env: BundleStoreEnv = {
      MIGRATION_HMAC_SECRET: masterSecret,
      R2_BUCKET: { get } as unknown as R2Bucket,
      ORG: {
        idFromName: (id: string) => id,
        get: () => ({ getAppEnvVarsForDeploy }),
      } as unknown as BundleStoreEnv["ORG"],
      MAIN_APP_BROKER: { resolveLegacyIntegrationEnvVars },
    };
    const record = makeRecord([
      redacted(KEY),
      redacted(bigQueryKey),
      redacted(deletedKey),
      redacted(customKey),
      redacted(SECOND_KEY),
      redacted(unresolvedKey),
      { name: "PLAIN_VALUE", type: "plain_text", text: "bundle-value" },
    ]);

    const overlay = await loadDynamicEnvOverlay(env, record);
    const { code } = captureWorkerConfig(record, overlay);
    expect(getAppEnvVarsForDeploy).toHaveBeenCalledExactlyOnceWith(record.scriptName);
    expect(get).toHaveBeenCalledExactlyOnceWith(dynamicSecretsR2Key(SCRIPT));
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledExactlyOnceWith(ORG, WORKSPACE, [
      bigQueryKey,
      deletedKey,
      unresolvedKey,
      SECOND_KEY,
    ]);
    expect(code.env).toMatchObject({
      [KEY]: "",
      [bigQueryKey]: "fresh-token",
      [deletedKey]: "deleted-integration-snapshot",
      [customKey]: "custom-secret",
      [SECOND_KEY]: "legacy-value",
      [unresolvedKey]: "",
      PLAIN_VALUE: "bundle-value",
    });

    resolveLegacyIntegrationEnvVars.mockClear();
    const coveredRecord = { ...record, bindings: [redacted(KEY), redacted(customKey)] };
    await loadDynamicEnvOverlay(env, coveredRecord);
    expect(resolveLegacyIntegrationEnvVars).not.toHaveBeenCalled();
  });

  it("shares cached results across key order and partitions them by app, org, workspace, and keys", async () => {
    const resolveLegacyIntegrationEnvVars = vi.fn(async () => [secret(KEY, "restored-secret")]);
    const env = { MAIN_APP_BROKER: { resolveLegacyIntegrationEnvVars } };
    const record = makeRecord([redacted(KEY), redacted(SECOND_KEY)]);

    const original = await loadDynamicEnvOverlay(env, record);
    await expect(loadDynamicEnvOverlay(env, {
      ...record,
      bindings: [redacted(SECOND_KEY), redacted(KEY)],
    })).resolves.toEqual(original);
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledTimes(1);

    await loadDynamicEnvOverlay(env, { ...record, dispatchScriptName: "another-app" });
    await loadDynamicEnvOverlay(env, { ...record, orgId: "another-org" });
    await loadDynamicEnvOverlay(env, { ...record, workspaceId: "another-workspace" });
    await loadDynamicEnvOverlay(env, { ...record, bindings: [redacted(KEY)] });
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledTimes(5);
  });

  it("refreshes cached values after five minutes and invalidates HTTP and DO isolate keys", async () => {
    const epoch = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(epoch);
    const resolveLegacyIntegrationEnvVars = vi.fn(async () => [secret(KEY, "old-value")]);
    const env = { MAIN_APP_BROKER: { resolveLegacyIntegrationEnvVars } };
    const record = makeRecord([redacted(KEY)]);

    const oldOverlay = await loadDynamicEnvOverlay(env, record);
    resolveLegacyIntegrationEnvVars.mockResolvedValue([secret(KEY, "rotated-value")]);
    clock.mockReturnValue(epoch + CACHE_TTL_MS - 1);
    await expect(loadDynamicEnvOverlay(env, record)).resolves.toEqual(oldOverlay);
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledTimes(1);

    clock.mockReturnValue(epoch + CACHE_TTL_MS);
    const newOverlay = await loadDynamicEnvOverlay(env, record);
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledTimes(2);
    expect(newOverlay.vars).toEqual([secret(KEY, "rotated-value")]);
    expect(newOverlay.envHash).not.toEqual(oldOverlay.envHash);
    expect(captureWorkerConfig(record, newOverlay).isolateId).not.toEqual(
      captureWorkerConfig(record, oldOverlay).isolateId,
    );
    expect(captureWorkerConfig(record, newOverlay, "facet-1").isolateId).not.toEqual(
      captureWorkerConfig(record, oldOverlay, "facet-1").isolateId,
    );
  });

  it("caches a successful empty response and drops it when bundle caches are cleared", async () => {
    const resolveLegacyIntegrationEnvVars = vi.fn(async () => [] as ReturnType<typeof secret>[]);
    const env = { MAIN_APP_BROKER: { resolveLegacyIntegrationEnvVars } };
    const record = makeRecord([redacted(KEY)]);

    const empty = await loadDynamicEnvOverlay(env, record);
    expect(empty).toEqual({ vars: [], envHash: "0" });
    resolveLegacyIntegrationEnvVars.mockResolvedValue([secret(KEY, "new-value")]);
    await expect(loadDynamicEnvOverlay(env, record)).resolves.toEqual(empty);
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledTimes(1);

    clearBundleStoreCachesForTest();
    const populated = await loadDynamicEnvOverlay(env, record);
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledTimes(2);
    expect(populated.vars).toEqual([secret(KEY, "new-value")]);
    expect(populated.envHash).not.toEqual(empty.envHash);
  });

  it("logs broker failures, leaves bundle fallbacks usable, and retries on the next request", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const record = makeRecord([redacted(KEY)]);
    const resolveLegacyIntegrationEnvVars = vi.fn(async () => [secret(KEY, "restored-secret")]);
    resolveLegacyIntegrationEnvVars.mockRejectedValueOnce(new Error("broker unavailable"));
    const env = { MAIN_APP_BROKER: { resolveLegacyIntegrationEnvVars } };

    const withoutBinding = await loadDynamicEnvOverlay({}, record);
    const rpcFailure = await loadDynamicEnvOverlay(env, record);
    expect(withoutBinding).toEqual({ vars: [], envHash: "0" });
    expect(rpcFailure).toEqual(withoutBinding);
    expect(captureWorkerConfig(record, rpcFailure).code.env).toHaveProperty(KEY, "");
    expect(errorLog).toHaveBeenCalledTimes(2);

    const recovered = await loadDynamicEnvOverlay(env, record);
    expect(resolveLegacyIntegrationEnvVars).toHaveBeenCalledTimes(2);
    expect(recovered.vars).toEqual([secret(KEY, "restored-secret")]);
  });
});
