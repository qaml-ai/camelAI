/**
 * Shared registry schema and R2/KV key helpers for hosted Dynamic Workers.
 *
 * Used by both `chiridion-app` (deploy / rollback / promote / env updates)
 * and `chiridion-dispatcher` (edge dispatch / TenantObjectSupervisorDO).
 */

export type AppRuntimeMode = "wfp" | "dynamic" | "dynamic_migrating";
export type AppQuotaTier = "free" | "pro" | "enterprise" | "exempt";

export function billingPlanToQuotaTier(billingPlan: string | null | undefined): AppQuotaTier {
  const normalized = billingPlan?.trim().toLowerCase();
  if (normalized === "enterprise") return "enterprise";
  if (normalized === "pro" || normalized === "team" || normalized === "starter") return "pro";
  return "free";
}

export const DYNAMIC_BUNDLE_OBJECT_PREFIX = "dynamic-bundles";
export const DYNAMIC_DO_ALIAS_PREFIX = "do_alias:";

export interface DynamicWorkerRegistryFields {
  runtime_mode?: AppRuntimeMode;
  bundle_r2_key?: string;
  bundle_sha?: string;
  env_version?: number;
  quota_tier?: AppQuotaTier;
  do_classes?: string[];
  has_assets?: boolean;
  migrated_at?: string;
}

export interface DynamicWorkerModule {
  name: string;
  type: "js" | "text" | "data" | "json" | "wasm";
  content: string;
}

/**
 * Immutable R2 bundle artifact executed by `chiridion-dispatcher`'s
 * `USER_APP_LOADER` and `TenantObjectSupervisorDO` facets.
 *
 * Platform-managed secrets from `OrgDO` are deliberately excluded from this
 * artifact when `OrgDO` managed env vars are used, and injected at isolate
 * load time instead.
 */
export interface DynamicWorkerBundleRecord {
  schemaVersion: 2;
  appId: string;
  scriptName: string;
  dispatchScriptName: string;
  orgId: string;
  orgSlug: string;
  workspaceId: string;
  bundleSha: string;
  createdAt: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: Record<string, DynamicWorkerModule>;
  bindings: Array<Record<string, unknown>>;
  doBindings: Record<string, string>;
  doClasses: string[];
  hasAssets: boolean;
  hasCodemodeLoader: boolean;
  cpuMs?: number;
}

export function dynamicBundleObjectKey(
  dispatchScriptName: string,
  bundleSha: string,
): string {
  return `${DYNAMIC_BUNDLE_OBJECT_PREFIX}/${encodeURIComponent(dispatchScriptName)}/${bundleSha}.json`;
}

export function dynamicDoAliasKey(
  appId: string,
  className: string,
  hexId: string,
): string {
  return `${DYNAMIC_DO_ALIAS_PREFIX}${appId}:${className}:${hexId}`;
}

export function isDynamicRuntimeMode(
  mode: string | undefined,
): mode is "dynamic" | "dynamic_migrating" {
  return mode === "dynamic" || mode === "dynamic_migrating";
}

export function extractLocalDoBindings(
  bindings: ReadonlyArray<Record<string, unknown>>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const binding of bindings) {
    if (
      binding.type === "durable_object_namespace" &&
      typeof binding.name === "string" &&
      typeof binding.class_name === "string" &&
      !binding.script_name
    ) {
      result[binding.name] = binding.class_name;
    }
  }
  return result;
}

export function extractHasAssetsBinding(
  bindings: ReadonlyArray<Record<string, unknown>>,
): boolean {
  return bindings.some(
    (binding) =>
      binding.type === "assets" ||
      (binding.type === "service" && binding.entrypoint === "AssetsVirtualBinding"),
  );
}

export function extractHasCodemodeLoaderBinding(
  bindings: ReadonlyArray<Record<string, unknown>>,
): boolean {
  return bindings.some((binding) => binding.type === "worker_loader");
}

export function extractCodemodeLoaderBindingNames(
  bindings: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const names: string[] = [];
  for (const binding of bindings) {
    if (binding.type === "worker_loader" && typeof binding.name === "string") {
      names.push(binding.name);
    }
  }
  return names;
}
