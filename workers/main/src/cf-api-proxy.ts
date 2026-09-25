/**
 * Cloudflare API helpers for user-app deploys
 *
 * Binding validation and virtualization for deployed apps, dispatch-script
 * deletion, custom hostnames, and the deploy env/side-effect types used by
 * direct-dispatch-deploy.ts and services/deploy.ts. (The file name is from the
 * retired wrangler-deploy proxy that used to live here.)
 */

import type { OrgDO } from "./auth.js";
import type { WorkspaceDO } from "./workspace.js";
import type { WorkspaceFilesystemDO } from "./workspace-filesystem-do.js";

const VIRTUAL_DATA_PROXY_BINDING_NAME = "DATA_PROXY";
const VIRTUAL_CONNECTIONS_BINDING_NAME = "CONNECTIONS";
const VIRTUAL_CAMELAI_BINDING_NAME = "CAMELAI";
const VIRTUAL_WAREHOUSE_BINDING_NAME = "WAREHOUSE";
const VIRTUAL_ANALYSIS_BINDING_NAME = "ANALYSIS";
const ALLOWED_VIRTUAL_SERVICE_BINDINGS = new Set([
  VIRTUAL_DATA_PROXY_BINDING_NAME,
  VIRTUAL_CONNECTIONS_BINDING_NAME,
  VIRTUAL_CAMELAI_BINDING_NAME,
  VIRTUAL_WAREHOUSE_BINDING_NAME,
  VIRTUAL_ANALYSIS_BINDING_NAME,
]);

// =============================================================================
// Binding Security Filter
// =============================================================================
// Users can only use bindings that are safe, self-contained, or explicitly
// virtualized by the platform. For Durable Objects, they can only use DOs
// defined in their own script.

/** Binding types that are completely forbidden */
const FORBIDDEN_BINDING_TYPES = new Set([
  "d1", // D1 database
  // r2_bucket is NOT forbidden — it's transparently replaced with a virtual R2 service binding
  "queue", // Queue producer
  "analytics_engine", // Analytics Engine
  "hyperdrive", // Hyperdrive database connections
  "vectorize", // Vectorize vector indexes
  "browser", // Browser Rendering API
  "mtls_certificate", // mTLS certificates
  "dispatch_namespace", // Workers for Platforms dispatch
  "send_email", // Email sending
  "version_metadata", // Version metadata (internal)
]);

/** Binding types that pass validation but are transformed before forwarding to CF API */
const TRANSFORMED_BINDING_TYPES = new Set([
  "kv_namespace", // Replaced with virtual KV service binding
  "r2_bucket", // Replaced with virtual R2 service binding
  "assets", // Replaced with virtual assets service binding
  "ai", // Replaced with virtual AI binding
]);

/** Binding types that are always allowed (safe, self-contained) */
const ALLOWED_BINDING_TYPES = new Set([
  "plain_text", // Plain text env vars
  "secret_text", // User-provided secret text bindings.
  "json", // JSON env vars
  "wasm_module", // WASM modules (bundled with script)
  "text_blob", // Text blobs (bundled)
  "data_blob", // Data blobs (bundled)
  "worker_loader", // Worker loaders for codemode (ephemeral isolates, no external resource access)
]);

export interface WorkerBinding {
  type: string;
  name: string;
  // For durable_object_namespace bindings
  class_name?: string;
  script_name?: string;
  // For other binding types (not all fields used by all types)
  namespace_id?: string;
  database_id?: string;
  bucket_name?: string;
  [key: string]: unknown;
}

export interface BindingValidationResult {
  valid: boolean;
  forbiddenBindings: Array<{ name: string; type: string; reason: string }>;
}

/**
 * Validate bindings in worker metadata.
 * Returns which bindings are forbidden and why.
 */
export function validateBindings(
  bindings: WorkerBinding[],
): BindingValidationResult {
  const forbiddenBindings: Array<{
    name: string;
    type: string;
    reason: string;
  }> = [];

  for (const binding of bindings) {
    const { type, name } = binding;

    // Allow platform-virtualized service bindings that are rewritten at deploy time.
    if (type === "service") {
      if (ALLOWED_VIRTUAL_SERVICE_BINDINGS.has(name)) {
        continue;
      }
      forbiddenBindings.push({
        name,
        type,
        reason: `Service binding "${name}" is not allowed. Only ${Array.from(
          ALLOWED_VIRTUAL_SERVICE_BINDINGS,
        )
          .map((bindingName) => `"${bindingName}"`)
          .join(" and ")} are permitted.`,
      });
      continue;
    }

    // Check completely forbidden types
    if (FORBIDDEN_BINDING_TYPES.has(type)) {
      forbiddenBindings.push({
        name,
        type,
        reason: `Binding type "${type}" is not allowed. User workers cannot access external resources.`,
      });
      continue;
    }

    // Check Durable Object bindings - only allow local DOs (no script_name)
    if (type === "durable_object_namespace") {
      if (binding.script_name) {
        forbiddenBindings.push({
          name,
          type,
          reason: `External Durable Object binding to script "${binding.script_name}" is not allowed. Only Durable Objects defined in your own script are permitted.`,
        });
      }
      // Local DO (no script_name) is allowed
      continue;
    }

    // Check if it's a transformed type (allowed through, rewritten before forwarding)
    if (TRANSFORMED_BINDING_TYPES.has(type)) {
      continue;
    }

    // Check if it's an allowed type
    if (ALLOWED_BINDING_TYPES.has(type)) {
      continue;
    }

    // Unknown binding type - block it for safety
    forbiddenBindings.push({
      name,
      type,
      reason: `Unknown binding type "${type}" is not allowed.`,
    });
  }

  return {
    valid: forbiddenBindings.length === 0,
    forbiddenBindings,
  };
}

export interface CfApiProxyEnv {
  CF_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  CF_WORKER_NAME?: string;
  TAIL_WORKER_NAME?: string;
  TOKEN_SIGNING_SECRET: string;
  INTEGRATION_SECRET_KEY: string;
  /** Deployed-app CONNECTIONS binding kill switch (default enabled). */
  CONNECTIONS_BINDING_ENABLED?: string;
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace;
  APP_DB?: D1Database;
  R2_BUCKET: R2Bucket;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  CHAT_THREAD: DurableObjectNamespace;
  WORKER_BASE_URL?: string;
  CF_ZONE_ID?: string;
  CF_CUSTOM_HOSTNAME_FALLBACK?: string;
  CF_CUSTOM_HOSTNAME_CNAME_TARGET?: string;
}

export interface DeploySideEffectsInfo {
  /** Original script name (user-facing, e.g., "my-app") */
  scriptName: string;
  /** Dispatch namespace script name (e.g., "my-app--acme-85b") */
  dispatchScriptName: string;
  orgId: string;
  orgSlug: string;
  workspaceId: string;
  hostname: string;
  threadId?: string;
  projectId?: string;
  configPath?: string;
  commitSha?: string;
  artifactCacheKey?: string;
  /** Cloudflare deployment/version id returned by the successful upload. */
  scriptVersion?: string;
}

/**
 * Extract environment prefix from hostname.
 * E.g., "staging.camelai.dev" -> "staging", "camelai.dev" -> ""
 */
export function getEnvPrefix(hostname: string): string {
  if (hostname.endsWith(".camelai.dev") || hostname === "camelai.dev") {
    const parts = hostname.split(".");
    if (parts.length <= 2 || parts[0] === "www") {
      return "";
    }
    return parts[0] ?? "";
  }

  if (
    hostname === "localhost" ||
    hostname.startsWith("127.0.0.1") ||
    hostname.endsWith(".local") ||
    hostname === "host.docker.internal"
  ) {
    return "local";
  }

  return "";
}

/**
 * Resolve environment prefix, preferring WORKER_BASE_URL if set.
 */
export function resolveEnvPrefix(
  baseUrl: string | undefined,
  hostname: string,
): string {
  if (baseUrl) {
    try {
      return getEnvPrefix(new URL(baseUrl).hostname);
    } catch {
      return getEnvPrefix(hostname);
    }
  }
  return getEnvPrefix(hostname);
}

export function mapVirtualizedBindings(
  bindings: WorkerBinding[],
  workspaceId: string,
  orgId: string,
  userId: string | undefined,
  workerServiceName: string,
  appId: string,
  options?: { connectionsBindingEnabled?: boolean },
): WorkerBinding[] {
  const allowConnectionsBinding = options?.connectionsBindingEnabled !== false;
  const mapped = bindings.flatMap((binding): WorkerBinding[] => {
    if (binding.type === "kv_namespace") {
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "KVVirtualNamespace",
        props: {
          workspaceId,
          appId,
          namespaceId: binding.namespace_id ?? binding.name,
        },
      }];
    }

    if (binding.type === "r2_bucket") {
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "R2VirtualBucket",
        props: { workspaceId, bucketName: binding.bucket_name ?? binding.name },
      }];
    }

    if (binding.type === "assets") {
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "AssetsVirtualBinding",
        props: { appId },
      }];
    }

    if (
      binding.type === "service" &&
      binding.name === VIRTUAL_DATA_PROXY_BINDING_NAME
    ) {
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "DataProxyService",
        props: { workspaceId, orgId },
      }];
    }

    if (
      binding.type === "service" &&
      binding.name === VIRTUAL_WAREHOUSE_BINDING_NAME
    ) {
      // Source-compat: already-deployed apps keep resolving WAREHOUSE to the
      // (still-present) WarehouseService entrypoint. New apps should bind ANALYSIS.
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "WarehouseService",
        props: { workspaceId, orgId },
      }];
    }

    if (
      binding.type === "service" &&
      binding.name === VIRTUAL_ANALYSIS_BINDING_NAME
    ) {
      // Deployed apps get the narrowed entrypoint (runCode + listConnections
      // only) — never the full AnalysisService with project-filesystem access.
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "AnalysisAppService",
        props: { workspaceId, orgId },
      }];
    }

    if (
      binding.type === "service" &&
      binding.name === VIRTUAL_CONNECTIONS_BINDING_NAME
    ) {
      // On-prem installs can disable the deployed-app CONNECTIONS broker so
      // published workers cannot pull connection-backed data.
      if (!allowConnectionsBinding) {
        return [];
      }
      const props: Record<string, string> = { workspaceId, orgId };
      if (userId) {
        props.userId = userId;
      }
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "ConnectionsService",
        props,
      }];
    }

    if (binding.type === "ai") {
      const props: Record<string, string> = { workspaceId, orgId };
      if (userId) {
        props.userId = userId;
      }
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "AIVirtualBinding",
        props,
      }];
    }

    if (
      binding.type === "service" &&
      binding.name === VIRTUAL_CAMELAI_BINDING_NAME
    ) {
      const props: Record<string, string> = { workspaceId, orgId };
      if (userId) {
        props.userId = userId;
      }
      return [{
        type: "service",
        name: binding.name,
        service: workerServiceName,
        entrypoint: "CamelAiService",
        props,
      }];
    }

    return [binding];
  });
  const props: Record<string, string> = { workspaceId, orgId };
  if (userId) {
    props.userId = userId;
  }
  if (
    allowConnectionsBinding &&
    !mapped.some((binding) => binding.name === VIRTUAL_CONNECTIONS_BINDING_NAME)
  ) {
    mapped.push({
      type: "service",
      name: VIRTUAL_CONNECTIONS_BINDING_NAME,
      service: workerServiceName,
      entrypoint: "ConnectionsService",
      props,
    });
  }
  if (!mapped.some((binding) => binding.name === VIRTUAL_CAMELAI_BINDING_NAME)) {
    mapped.push({
      type: "service",
      name: VIRTUAL_CAMELAI_BINDING_NAME,
      service: workerServiceName,
      entrypoint: "CamelAiService",
      props,
    });
  }
  return mapped;
}

async function callCloudflareApi<T>(
  url: string,
  init: RequestInit,
  context: string,
  options?: { suppressMissingWorkerWarning?: boolean },
): Promise<T | null> {
  const isMissingWorkerError = (status: number, errors: unknown[]): boolean =>
    status === 404 &&
    errors.some((error) => {
      if (!error || typeof error !== "object") return false;
      const code = (error as { code?: unknown }).code;
      return code === 10007;
    });

  const resp = await fetch(url, { ...init, redirect: "manual" });
  if (!resp.ok) {
    const bodyText = await resp.text();
    let errors: unknown[] = [];
    try {
      const parsed = JSON.parse(bodyText) as { errors?: unknown };
      errors = Array.isArray(parsed.errors) ? parsed.errors : [];
    } catch {
      // Non-JSON response body: keep default empty errors array
    }

    if (
      options?.suppressMissingWorkerWarning &&
      isMissingWorkerError(resp.status, errors)
    ) {
      return null;
    }

    console.warn(`[cf-api] ${context} failed`, {
      status: resp.status,
      statusText: resp.statusText,
      bodyPreview: bodyText.slice(0, 512),
    });
    return null;
  }
  const data = (await resp.json()) as {
    success?: boolean;
    result?: T;
    errors?: unknown[];
  };
  if (data.success === false) {
    const errors = Array.isArray(data.errors) ? data.errors : [];
    if (
      options?.suppressMissingWorkerWarning &&
      isMissingWorkerError(resp.status, errors)
    ) {
      return null;
    }
    console.warn(`[cf-api] ${context} returned error`, { errors: data.errors });
    return null;
  }
  return data.result ?? null;
}

/**
 * Delete a worker script from the Cloudflare dispatch namespace.
 * Returns true if successful, false if the script didn't exist or deletion failed.
 */
export async function deleteDispatchScript(
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string,
): Promise<boolean> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(scriptName)}`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  const resp = await fetch(url, { method: "DELETE", headers, redirect: "manual" });

  if (!resp.ok) {
    // 404 means script doesn't exist - that's OK for delete
    if (resp.status === 404) {
      console.log(
        "[cf-api] script not found in dispatch namespace (already deleted)",
        {
          accountId,
          dispatchNamespace,
          scriptName,
        },
      );
      return true;
    }
    const bodyText = await resp.text();
    console.error("[cf-api] failed to delete dispatch script", {
      status: resp.status,
      statusText: resp.statusText,
      bodyPreview: bodyText.slice(0, 512),
      accountId,
      dispatchNamespace,
      scriptName,
    });
    return false;
  }

  console.log("[cf-api] deleted dispatch script", {
    accountId,
    dispatchNamespace,
    scriptName,
  });
  return true;
}

// ── Custom Hostnames (Cloudflare for SaaS) ─────────────────────────

export interface CfCustomHostname {
  id: string;
  hostname: string;
  ssl: {
    status: string;
    method: string;
    type: string;
  };
  status: string;
  created_at: string;
}

const CUSTOM_HOSTNAME_SSL_SETTINGS = {
  method: "http",
  type: "dv",
  wildcard: false,
} as const;

interface CustomHostnameOptions {
  customOriginServer?: string;
}

function buildCustomHostnameSslSettings() {
  return CUSTOM_HOSTNAME_SSL_SETTINGS;
}

export async function createCustomHostname(
  zoneId: string,
  apiToken: string,
  hostname: string,
  options: CustomHostnameOptions | string = {},
): Promise<CfCustomHostname | null> {
  const normalizedOptions =
    typeof options === "string" ? { customOriginServer: options } : options;
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  const body: Record<string, unknown> = {
    hostname,
    ssl: buildCustomHostnameSslSettings(),
  };
  if (normalizedOptions.customOriginServer) {
    body.custom_origin_server = normalizedOptions.customOriginServer;
  }
  return callCloudflareApi<CfCustomHostname>(
    url,
    {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    },
    `create custom hostname ${hostname}`,
  );
}

export async function refreshCustomHostnameValidation(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
  options: CustomHostnameOptions | string = {},
): Promise<CfCustomHostname | null> {
  const normalizedOptions =
    typeof options === "string" ? { customOriginServer: options } : options;
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(hostnameId)}`;
  const headers = {
    Authorization: `Bearer ${apiToken}`,
    "Content-Type": "application/json",
  };
  const body: Record<string, unknown> = {
    ssl: buildCustomHostnameSslSettings(),
  };
  if (normalizedOptions.customOriginServer) {
    body.custom_origin_server = normalizedOptions.customOriginServer;
  }
  return callCloudflareApi<CfCustomHostname>(
    url,
    {
      method: "PATCH",
      headers,
      body: JSON.stringify(body),
    },
    `refresh custom hostname validation ${hostnameId}`,
  );
}

export async function createOrRefreshCustomHostname(
  zoneId: string,
  apiToken: string,
  hostname: string,
  options: CustomHostnameOptions | string = {},
): Promise<CfCustomHostname | null> {
  const created = await createCustomHostname(
    zoneId,
    apiToken,
    hostname,
    options,
  );
  if (created) {
    return created;
  }

  const existing = await findCustomHostnameByHostname(
    zoneId,
    apiToken,
    hostname,
  );
  if (!existing) {
    return null;
  }

  return (
    (await refreshCustomHostnameValidation(
      zoneId,
      apiToken,
      existing.id,
      options,
    )) ?? existing
  );
}

export async function getCustomHostnameStatus(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
): Promise<CfCustomHostname | null> {
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(hostnameId)}`;
  const headers = { Authorization: `Bearer ${apiToken}` };
  return callCloudflareApi<CfCustomHostname>(
    url,
    { method: "GET", headers },
    `get custom hostname status ${hostnameId}`,
  );
}

export async function deleteCustomHostname(
  zoneId: string,
  apiToken: string,
  hostnameId: string,
): Promise<boolean> {
  const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames/${encodeURIComponent(hostnameId)}`;
  try {
    const resp = await fetch(url, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: "manual",
    });
    if (resp.ok || resp.status === 404) return true;
    const body = await resp.text();
    console.warn("[cf-api] delete custom hostname failed", {
      hostnameId,
      status: resp.status,
      bodyPreview: body.slice(0, 512),
    });
    return false;
  } catch (err) {
    console.error("[cf-api] delete custom hostname error", err);
    return false;
  }
}

export async function listCustomHostnames(
  zoneId: string,
  apiToken: string,
  hostnameContains: string,
): Promise<CfCustomHostname[]> {
  const results: CfCustomHostname[] = [];
  let page = 1;
  const perPage = 50;
  while (true) {
    const url = `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/custom_hostnames?hostname_contains=${encodeURIComponent(hostnameContains)}&per_page=${perPage}&page=${page}`;
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${apiToken}` },
      redirect: "manual",
    });
    if (!resp.ok) break;
    const data = (await resp.json()) as {
      result?: CfCustomHostname[];
      result_info?: { total_pages: number };
    };
    if (!data.result?.length) break;
    results.push(...data.result);
    if (page >= (data.result_info?.total_pages ?? 1)) break;
    page++;
  }
  return results;
}

export async function findCustomHostnameByHostname(
  zoneId: string,
  apiToken: string,
  hostname: string,
): Promise<CfCustomHostname | null> {
  const normalizedHostname = hostname.trim().toLowerCase();
  const hostnames = await listCustomHostnames(
    zoneId,
    apiToken,
    normalizedHostname,
  );
  return (
    hostnames.find(
      (entry) => entry.hostname.trim().toLowerCase() === normalizedHostname,
    ) ?? null
  );
}
