/**
 * Binding & `props` hydration for migrating existing WfP dispatch scripts to
 * Dynamic Workers without losing tenant-scoped R2, KV, AI, Connections,
 * Data Proxy, Analysis, or Warehouse prefixes.
 *
 * Why this is critical:
 * Cloudflare's `GET .../workers/dispatch/namespaces/{ns}/scripts/{name}/settings`
 * API strips `props` from service bindings (`R2VirtualBucket`, `KVVirtualNamespace`,
 * `ConnectionsService`, `DataProxyService`, `AIVirtualBinding`, etc.).
 *
 * Strategy:
 * 1. Prefer `DirectDeployArtifactCacheRecord.metadata.bindings` from R2 whenever
 *    an `artifact_cache_key` exists — it preserves exact `props` (`workspaceId`,
 *    `bucketName`, `namespaceId`, `appId`, `orgId`, `userId`).
 * 2. Overlay any bindings present in live WfP `/settings` that aren't in the
 *    cached artifact, reconstructing tenant `props` from D1 (`orgId`, `workspaceId`).
 * 3. Fail closed (`unverified_virtual_storage_props`) if an `R2VirtualBucket` or
 *    `KVVirtualNamespace` binding lacks verified `workspaceId` + `bucketName` /
 *    `namespaceId` props so user R2/KV data can NEVER silently point at the wrong prefix.
 */

const ORG_WORKSPACE_ENTRYPOINTS = new Set([
  'AIVirtualBinding',
  'CamelAiService',
  'ConnectionsService',
  'DataProxyService',
  'AnalysisAppService',
  'WarehouseService',
]);

export interface HydrateMigratedBindingsInput {
  dispatchScriptName: string;
  orgId: string;
  workspaceId: string;
  userId?: string;
  liveSettingsBindings: Array<Record<string, unknown>>;
  artifactCacheBindings?: Array<Record<string, unknown>> | null;
}

export type HydrateMigratedBindingsResult =
  | {
      ok: true;
      bindings: Array<Record<string, unknown>>;
      source: 'artifact_cache' | 'd1_reconstructed';
    }
  | {
      ok: false;
      reason: 'missing_workspace_id' | 'unverified_virtual_storage_props';
      missingBindings: string[];
    };

function hasPropsRecord(binding: Record<string, unknown>): binding is Record<string, unknown> & {
  props: Record<string, unknown>;
} {
  return Boolean(
    binding.props && typeof binding.props === 'object' && !Array.isArray(binding.props),
  );
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

export function hydrateMigratedBindings(
  input: HydrateMigratedBindingsInput,
): HydrateMigratedBindingsResult {
  const {
    dispatchScriptName,
    orgId,
    workspaceId,
    userId,
    liveSettingsBindings,
    artifactCacheBindings,
  } = input;

  const cachedByName = new Map<string, Record<string, unknown>>();
  for (const binding of artifactCacheBindings ?? []) {
    if (typeof binding.name === 'string') {
      cachedByName.set(binding.name, binding);
    }
  }

  const missingWorkspace: string[] = [];
  const unverifiedStorage: string[] = [];
  const hydrated: Array<Record<string, unknown>> = [];

  for (const live of liveSettingsBindings) {
    const name = typeof live.name === 'string' ? live.name : '';
    const cached = name ? cachedByName.get(name) : undefined;

    if (live.type !== 'service') {
      // Preserve live plain_text, json, durable_object_namespace, assets, worker_loader, blobs.
      // For r2_bucket / kv_namespace raw types (rare), require workspaceId.
      if ((live.type === 'r2_bucket' || live.type === 'kv_namespace') && !workspaceId) {
        missingWorkspace.push(name || String(live.type));
      }
      hydrated.push(live);
      continue;
    }

    const entrypoint = typeof live.entrypoint === 'string' ? live.entrypoint : '';

    // 1. If the R2 artifact cache has an identical service binding WITH props, use it verbatim!
    if (
      cached &&
      cached.type === 'service' &&
      cached.entrypoint === entrypoint &&
      hasPropsRecord(cached)
    ) {
      hydrated.push({ ...live, props: { ...cached.props } });
      continue;
    }

    // 2. Reconstruct deterministic props where safe, fail closed for R2/KV without verified props.
    if (entrypoint === 'AssetsVirtualBinding') {
      hydrated.push({ ...live, props: { appId: dispatchScriptName } });
      continue;
    }

    if (ORG_WORKSPACE_ENTRYPOINTS.has(entrypoint)) {
      if (!orgId || !workspaceId) {
        missingWorkspace.push(`${name}:${entrypoint}`);
        continue;
      }
      const props: Record<string, unknown> = {
        orgId,
        workspaceId,
        ...(userId ? { userId } : {}),
      };
      hydrated.push({ ...live, props });
      continue;
    }

    if (entrypoint === 'R2VirtualBucket') {
      // Check if cached artifact had raw r2_bucket with bucket_name before virtualization
      const cachedBucketName =
        cached && cached.type === 'r2_bucket'
          ? nonEmptyString(cached.bucket_name) ?? nonEmptyString(cached.name)
          : null;
      if (workspaceId && cachedBucketName) {
        hydrated.push({
          ...live,
          props: { workspaceId, bucketName: cachedBucketName },
        });
      } else {
        unverifiedStorage.push(`${name}:R2VirtualBucket`);
      }
      continue;
    }

    if (entrypoint === 'KVVirtualNamespace') {
      const cachedNsId =
        cached && cached.type === 'kv_namespace'
          ? nonEmptyString(cached.namespace_id) ?? nonEmptyString(cached.name)
          : null;
      if (workspaceId && cachedNsId) {
        hydrated.push({
          ...live,
          props: { workspaceId, appId: dispatchScriptName, namespaceId: cachedNsId },
        });
      } else {
        unverifiedStorage.push(`${name}:KVVirtualNamespace`);
      }
      continue;
    }

    // Unknown service entrypoint with stripped props — preserve as-is if already has props, otherwise fail safe.
    if (hasPropsRecord(live)) {
      hydrated.push(live);
    } else {
      unverifiedStorage.push(`${name}:${entrypoint || 'unknown'}`);
    }
  }

  if (unverifiedStorage.length > 0) {
    return {
      ok: false,
      reason: 'unverified_virtual_storage_props',
      missingBindings: unverifiedStorage,
    };
  }
  if (missingWorkspace.length > 0) {
    return {
      ok: false,
      reason: 'missing_workspace_id',
      missingBindings: missingWorkspace,
    };
  }

  return {
    ok: true,
    bindings: hydrated,
    source: artifactCacheBindings && artifactCacheBindings.length > 0
      ? 'artifact_cache'
      : 'd1_reconstructed',
  };
}
