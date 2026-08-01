/**
 * Cloudflare API Proxy
 *
 * Handles proxying wrangler deploy requests to Cloudflare's API.
 * Provides auth, path rewriting, and post-deploy side effects.
 */

import { waitUntil } from "cloudflare:workers";
import { createSignedToken } from "./signed-tokens.js";
import {
  validateSandboxProxy,
} from "./sandbox-auth.js";
import type { OrgDO } from "./auth.js";
import type { WorkspaceDO } from "./workspace.js";
import { getBillingPlanLimits } from "../../../src/lib/billing-plans.js";
import { connectionsBindingEnabled } from "../../../src/lib/connections-binding.js";
import type { WorkspaceFilesystemDO } from "./workspace-filesystem-do.js";
import {
  selfhostWorkerKey,
  type SelfhostWorkerModule,
  type SelfhostWorkerRecord,
} from "./selfhost-worker-registry.js";
import {
  normalizeSelfhostAssetPath,
  selfhostAssetObjectKey,
  selfhostAssetsKey,
  selfhostAssetsSessionKey,
  type SelfhostAssetsRecord,
  type SelfhostAssetsUploadSession,
} from "./selfhost-assets-registry.js";
import { resolveUploadedDispatchScriptVersion, withUsageGuardTracing } from "./usage-guard-config.js";
import {
  acquireUsageGuardOperationLeaseWithRetry,
  releaseUsageGuardOperationLease,
} from "./usage-guard-state.js";

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

const SELFHOST_IGNORED_BINDING_TYPES = new Set(["worker_loader"]);

function isSelfhostIgnoredBinding(binding: WorkerBinding): boolean {
  return SELFHOST_IGNORED_BINDING_TYPES.has(binding.type);
}

function stripSelfhostIgnoredBindings(
  bindings: WorkerBinding[],
): WorkerBinding[] {
  return bindings.filter((binding) => !isSelfhostIgnoredBinding(binding));
}

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

interface WorkerMetadata {
  main_module?: string;
  bindings?: WorkerBinding[];
  config_path?: string;
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

function validateSelfhostBindings(
  bindings: WorkerBinding[],
): BindingValidationResult {
  const supported = new Set([
    "plain_text",
    "secret_text",
    "json",
    "wasm_module",
    "text_blob",
    "data_blob",
    "kv_namespace",
    "r2_bucket",
    "assets",
    "ai",
    "durable_object_namespace",
  ]);
  const supportedVirtualEntrypoints = new Set([
    "AIVirtualBinding",
    "AssetsVirtualBinding",
    "CamelAiService",
    "ConnectionsService",
    "DataProxyService",
    "KVVirtualNamespace",
    "R2VirtualBucket",
    "WarehouseService",
    "AnalysisAppService",
  ]);
  const forbiddenBindings: BindingValidationResult["forbiddenBindings"] = [];

  for (const binding of bindings) {
    if (isSelfhostIgnoredBinding(binding)) {
      continue;
    }
    if (binding.type === "durable_object_namespace" && !binding.script_name) {
      continue;
    }
    if (
      binding.type === "service" &&
      (ALLOWED_VIRTUAL_SERVICE_BINDINGS.has(binding.name) ||
        (typeof binding.entrypoint === "string" &&
          supportedVirtualEntrypoints.has(binding.entrypoint)))
    ) {
      continue;
    }
    if (supported.has(binding.type)) continue;
    forbiddenBindings.push({
      name: binding.name,
      type: binding.type,
      reason: `Binding type "${binding.type}" is not implemented by the self-host dynamic workerd publisher yet.`,
    });
  }

  return { valid: forbiddenBindings.length === 0, forbiddenBindings };
}

const DISPATCH_SCRIPT_UPLOAD =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
const DISPATCH_SCRIPT_CONTENT_UPLOAD =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/content$/;
const DISPATCH_SCRIPT_BASE =
  /^\/client\/v4\/accounts\/([^/]+)\/workers\/dispatch\/namespaces\/([^/]+)\/scripts\/([^/]+)$/;
const DISPATCH_SCRIPT_ANY =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)(?:\/|$)/;
const DISPATCH_ASSETS_UPLOAD_SESSION =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/assets-upload-session$/;
const DISPATCH_SCRIPT_DEPLOYMENTS =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/deployments$/;
const DISPATCH_SCRIPT_VERSIONS_API =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/versions$/;
const DISPATCH_SCRIPT_SECRETS =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/secrets$/;
const DIRECT_SCRIPT_SECRETS =
  /^\/client\/v4\/accounts\/([^/]+)\/workers\/scripts\/([^/]+)\/secrets$/;
const TOKEN_VERIFY = /^\/client\/v4\/(?:user|accounts\/[^/]+)\/tokens\/verify$/;
const ASSETS_UPLOAD =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/assets\/upload$/;

// New prefix with org-slug namespacing: script:{script-name}--{org-slug}
const SCRIPT_PREFIX = "script:";

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
  SANDBOX_PROXY_SECRET?: string;
  PROJECT_RUNTIME_PROXY_SECRET?: string;
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
 * Return a Cloudflare API-formatted error response.
 * Wrangler expects this format to parse errors correctly.
 */
export function cfApiError(
  code: number,
  message: string,
  status: number,
): Response {
  return new Response(
    JSON.stringify({
      success: false,
      errors: [{ code, message }],
      messages: [],
      result: null,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
}

function cfApiSuccess(result: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({
      success: true,
      errors: [],
      messages: [],
      result,
    }),
    {
      status,
      headers: { "Content-Type": "application/json" },
    },
  );
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

/**
 * Extract script name from a dispatch namespace API path.
 */
function extractScriptName(pathname: string): string | null {
  const match = pathname.match(DISPATCH_SCRIPT_ANY);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1] ?? "").trim() || null;
  } catch {
    return match[1]?.trim() || null;
  }
}

// Pattern for tail creation (wrangler tail)
const DISPATCH_SCRIPT_TAILS =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/([^/]+)\/tails$/;

export function isAllowedCloudflareApiProxyRequest(
  pathname: string,
  method: string,
): boolean {
  const m = method.toUpperCase();
  // All paths are rewritten to WFP dispatch namespace format
  // Base pattern: /client/v4/accounts/{account}/workers/dispatch/namespaces/{ns}/scripts/{script}
  const dispatchScript =
    /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+$/;
  const dispatchScriptDeployments =
    /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/deployments$/;
  const dispatchScriptSettings =
    /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/settings$/;
  const dispatchScriptScriptSettings =
    /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/script-settings$/;
  const dispatchAssetsUploadSession =
    /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/assets-upload-session$/;
  const dispatchScriptSecretBinding =
    /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/secrets\/[^/]+$/;
  const dispatchScriptVersions =
    /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/versions$/;

  switch (m) {
    case "GET":
      return (
        dispatchScript.test(pathname) ||
        TOKEN_VERIFY.test(pathname) ||
        dispatchScriptDeployments.test(pathname) ||
        dispatchScriptSettings.test(pathname) ||
        DISPATCH_SCRIPT_SECRETS.test(pathname) ||
        dispatchScriptSecretBinding.test(pathname) ||
        dispatchScriptVersions.test(pathname)
      );
    case "PUT":
      return (
        dispatchScript.test(pathname) ||
        DISPATCH_SCRIPT_CONTENT_UPLOAD.test(pathname) ||
        DISPATCH_SCRIPT_SECRETS.test(pathname)
      );
    case "PATCH":
      return (
        dispatchScriptSettings.test(pathname) ||
        dispatchScriptScriptSettings.test(pathname)
      );
    case "POST":
      return (
        dispatchAssetsUploadSession.test(pathname) ||
        dispatchScriptVersions.test(pathname) ||
        dispatchScriptDeployments.test(pathname) ||
        DISPATCH_SCRIPT_TAILS.test(pathname) ||
        ASSETS_UPLOAD.test(pathname)
      );
    case "DELETE":
      return dispatchScriptSecretBinding.test(pathname);
    default:
      return false;
  }
}

function isUploadRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  return (
    (m === "PUT" && DISPATCH_SCRIPT_UPLOAD.test(pathname)) ||
    (m === "PUT" && DISPATCH_SCRIPT_CONTENT_UPLOAD.test(pathname)) ||
    (m === "POST" && ASSETS_UPLOAD.test(pathname))
  );
}

function stripInternalProxyHeaders(headers: Headers): void {
  headers.delete("x-sandbox-secret");
  headers.delete("x-chiridion-org-id");
  headers.delete("x-chiridion-workspace-id");
  headers.delete("x-chiridion-user-id");
  headers.delete("x-chiridion-thread-id");
  headers.delete("x-chiridion-project-id");
}

// Patterns for requests that may contain bindings in JSON body
const DISPATCH_SCRIPT_SETTINGS =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/settings$/;
const DISPATCH_SCRIPT_SCRIPT_SETTINGS =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/script-settings$/;
const DISPATCH_SCRIPT_VERSIONS =
  /^\/client\/v4\/accounts\/[^/]+\/workers\/dispatch\/namespaces\/[^/]+\/scripts\/[^/]+\/versions$/;

/**
 * Check if this is a request that may contain bindings in JSON body.
 * These need to be validated separately from multipart uploads.
 */
function isBindingsJsonRequest(pathname: string, method: string): boolean {
  const m = method.toUpperCase();
  // PATCH to settings/script-settings can modify bindings
  if (m === "PATCH") {
    return (
      DISPATCH_SCRIPT_SETTINGS.test(pathname) ||
      DISPATCH_SCRIPT_SCRIPT_SETTINGS.test(pathname)
    );
  }
  // POST to versions can include bindings
  if (m === "POST") {
    return DISPATCH_SCRIPT_VERSIONS.test(pathname);
  }
  return false;
}

interface SettingsRequestBody {
  bindings?: WorkerBinding[];
  [key: string]: unknown;
}

function parseMultipartUploads(body: ArrayBuffer, contentType: string) {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  const boundary = boundaryMatch?.[1]?.trim().replace(/^"|"$/g, "");
  if (!boundary) {
    return null;
  }

  const decoder = new TextDecoder("utf-8");
  const text = decoder.decode(body);
  const delimiter = `--${boundary}`;
  const parts = text.split(delimiter);
  const files: string[] = [];
  const wranglerConfigs: Array<{
    filename: string;
    content: string;
    size: number;
    truncated: boolean;
  }> = [];
  const formParts: Array<{
    name: string | null;
    filename: string | null;
    contentType: string | null;
    size: number;
    preview: string;
    truncated: boolean;
  }> = [];
  let configPath: string | undefined;
  let bindings: WorkerBinding[] | undefined;
  let rawMetadataJson: string | undefined;
  const maxConfigLogChars = 20000;
  const maxPartLogChars = 2000;

  for (const part of parts) {
    const trimmed = part.trim();
    if (!trimmed || trimmed === "--") continue;

    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) continue;
    const headerText = part.slice(0, headerEnd);
    const bodyText = part.slice(headerEnd + 4).replace(/\r\n$/, "");

    const dispositionMatch = headerText.match(/Content-Disposition:[^\n]*\n?/i);
    if (!dispositionMatch) continue;

    const nameMatch = headerText.match(/name="([^"]+)"/i);
    const filenameMatch = headerText.match(/filename="([^"]+)"/i);
    const contentTypeMatch = headerText.match(/Content-Type:\s*([^\r\n]+)/i);

    const name = nameMatch?.[1]?.trim() ?? null;
    const filename = filenameMatch?.[1]?.trim() ?? null;
    const partContentType = contentTypeMatch?.[1]?.trim() ?? null;
    const size = bodyText.length;

    if (filename) {
      files.push(filename);
    }

    // Extract config_path and bindings from metadata JSON
    if (name === "metadata" && !filename) {
      try {
        const metadata = JSON.parse(bodyText) as WorkerMetadata;
        if (metadata.config_path) {
          configPath = metadata.config_path;
        }
        if (metadata.bindings) {
          bindings = metadata.bindings;
        }
        rawMetadataJson = bodyText;
      } catch {
        // Ignore JSON parse errors
      }
    }

    const previewTruncated = bodyText.length > maxPartLogChars;
    const preview = previewTruncated
      ? `${bodyText.slice(0, maxPartLogChars)}\n...[truncated]`
      : bodyText;
    formParts.push({
      name,
      filename,
      contentType: partContentType,
      size,
      preview,
      truncated: previewTruncated,
    });

    const wranglerKey = filename ?? name;
    if (wranglerKey === "wrangler.toml" || wranglerKey === "wrangler.jsonc") {
      const truncated = bodyText.length > maxConfigLogChars;
      const content = truncated
        ? `${bodyText.slice(0, maxConfigLogChars)}\n...[truncated]`
        : bodyText;
      wranglerConfigs.push({
        filename: wranglerKey,
        content,
        size,
        truncated,
      });
    }
  }

  return {
    files,
    wranglerConfigs,
    formParts,
    configPath,
    bindings,
    rawMetadataJson,
  };
}

interface LocalMultipartPart {
  name: string | null;
  filename: string | null;
  contentType: string | null;
  body: Uint8Array;
}

function parseMultipartParts(
  body: ArrayBuffer,
  contentType: string,
): LocalMultipartPart[] | null {
  const boundaryMatch = contentType.match(/boundary=([^;]+)/i);
  const boundary = boundaryMatch?.[1]?.trim().replace(/^"|"$/g, "");
  if (!boundary) return null;

  const bytes = new Uint8Array(body);
  const delimiter = asciiBytes(`--${boundary}`);
  const headerSeparator = asciiBytes("\r\n\r\n");
  const parts: LocalMultipartPart[] = [];

  let searchFrom = 0;
  while (searchFrom < bytes.length) {
    const boundaryStart = indexOfBytes(bytes, delimiter, searchFrom);
    if (boundaryStart === -1) break;

    let partStart = boundaryStart + delimiter.length;
    if (bytes[partStart] === 45 && bytes[partStart + 1] === 45) break;
    if (bytes[partStart] === 13 && bytes[partStart + 1] === 10) {
      partStart += 2;
    }

    const headerEnd = indexOfBytes(bytes, headerSeparator, partStart);
    if (headerEnd === -1) break;
    const headerText = new TextDecoder("utf-8").decode(bytes.slice(partStart, headerEnd));
    const bodyStart = headerEnd + headerSeparator.length;
    const nextBoundary = indexOfBytes(bytes, delimiter, bodyStart);
    if (nextBoundary === -1) break;

    let bodyEnd = nextBoundary;
    if (bodyEnd >= 2 && bytes[bodyEnd - 2] === 13 && bytes[bodyEnd - 1] === 10) {
      bodyEnd -= 2;
    }

    const name = headerText.match(/name="([^"]+)"/i)?.[1]?.trim() ?? null;
    const filename =
      headerText.match(/filename="([^"]+)"/i)?.[1]?.trim() ?? null;
    const partContentType =
      headerText.match(/Content-Type:\s*([^\r\n]+)/i)?.[1]?.trim() ?? null;

    parts.push({
      name,
      filename,
      contentType: partContentType,
      body: bytes.slice(bodyStart, bodyEnd),
    });
    searchFrom = nextBoundary;
  }
  return parts;
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = value.charCodeAt(index);
  }
  return bytes;
}

function indexOfBytes(bytes: Uint8Array, needle: Uint8Array, from = 0): number {
  if (needle.length === 0) return from;
  for (let index = from; index <= bytes.length - needle.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (bytes[index + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return index;
  }
  return -1;
}

function multipartPartText(part: LocalMultipartPart): string {
  return new TextDecoder("utf-8").decode(part.body);
}

function base64EncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64DecodeBytes(value: string): ArrayBuffer {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function moduleTypeFromPart(
  moduleName: string,
  contentType: string | null,
): SelfhostWorkerModule["type"] {
  const lowerName = moduleName.toLowerCase();
  const lowerType = contentType?.toLowerCase() ?? "";
  if (lowerName.endsWith(".wasm") || lowerType.includes("application/wasm")) {
    return "wasm";
  }
  if (
    lowerType.startsWith("text/") &&
    !lowerName.endsWith(".js") &&
    !lowerName.endsWith(".mjs")
  ) {
    return "text";
  }
  if (lowerType.includes("application/json") && lowerName.endsWith(".json")) {
    return "json";
  }
  return "js";
}

function moduleTypeFromBindingPart(
  metadata: WorkerMetadata,
  moduleName: string,
  contentType: string | null,
): SelfhostWorkerModule["type"] {
  const binding = metadata.bindings?.find((candidate) => {
    const part = typeof candidate.part === "string" ? candidate.part : null;
    return part === moduleName || (!part && candidate.name === moduleName);
  });
  if (binding?.type === "wasm_module") return "wasm";
  if (binding?.type === "data_blob") return "data";
  if (binding?.type === "text_blob") return "text";
  return moduleTypeFromPart(moduleName, contentType);
}

function parseLocalSelfhostWorkerUpload(
  body: ArrayBuffer,
  contentType: string,
): {
  metadata: WorkerMetadata;
  modules: Record<string, SelfhostWorkerModule>;
} | null {
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    return null;
  }
  const parts = parseMultipartParts(body, contentType);
  if (!parts) return null;

  let metadata: WorkerMetadata | null = null;
  const modules: Record<string, SelfhostWorkerModule> = {};
  const moduleParts: LocalMultipartPart[] = [];

  for (const part of parts) {
    if (part.name === "metadata" && !part.filename) {
      metadata = JSON.parse(multipartPartText(part)) as WorkerMetadata;
      continue;
    }

    const moduleName = part.filename ?? part.name;
    if (!moduleName || moduleName === "metadata") continue;
    moduleParts.push(part);
  }

  if (!metadata?.main_module) return null;

  for (const part of moduleParts) {
    const moduleName = part.filename ?? part.name;
    if (!moduleName) continue;
    const type = moduleTypeFromBindingPart(metadata, moduleName, part.contentType);
    modules[moduleName] = {
      name: moduleName,
      type,
      content:
        type === "data" || type === "wasm"
          ? base64EncodeBytes(part.body)
          : multipartPartText(part),
    };
  }

  return { metadata, modules };
}

function compatibilityDateFromMetadata(metadata: WorkerMetadata): string {
  const value = metadata.compatibility_date;
  return typeof value === "string" && value.trim()
    ? value.trim()
    : "2026-06-09";
}

function compatibilityFlagsFromMetadata(metadata: WorkerMetadata): string[] {
  const value = metadata.compatibility_flags;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

async function storeLocalSelfhostWorker(input: {
  env: CfApiProxyEnv;
  body: ArrayBuffer;
  contentType: string;
  scriptName: string;
  dispatchScriptName: string;
  orgId: string;
  orgSlug: string;
  workspaceId: string;
}): Promise<SelfhostWorkerRecord | null> {
  const upload = parseLocalSelfhostWorkerUpload(input.body, input.contentType);
  if (!upload) return null;

  const bindings = stripSelfhostIgnoredBindings(upload.metadata.bindings ?? []);
  const record: SelfhostWorkerRecord = {
    schemaVersion: 1,
    appId: input.dispatchScriptName,
    scriptName: input.scriptName,
    dispatchScriptName: input.dispatchScriptName,
    orgId: input.orgId,
    orgSlug: input.orgSlug,
    workspaceId: input.workspaceId,
    version: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    compatibilityDate: compatibilityDateFromMetadata(upload.metadata),
    compatibilityFlags: compatibilityFlagsFromMetadata(upload.metadata),
    mainModule: upload.metadata.main_module!,
    modules: upload.modules,
    bindings: bindings as Array<Record<string, unknown>>,
  };

  if (!record.modules[record.mainModule]) {
    throw new Error(
      `Uploaded worker is missing main module "${record.mainModule}"`,
    );
  }

  await input.env.APP_KV.put(
    selfhostWorkerKey(input.dispatchScriptName),
    JSON.stringify(record),
  );
  return record;
}

function localSelfhostWorkerResult(record: SelfhostWorkerRecord) {
  return {
    id: record.dispatchScriptName,
    script_name: record.dispatchScriptName,
    created_on: record.createdAt,
    modified_on: record.createdAt,
    deployment_id: record.version,
    etag: record.version,
    handlers: ["fetch"],
    usage_model: "standard",
  };
}

function getBearerToken(request: Request): string | null {
  const value = request.headers.get("Authorization")?.trim();
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function normalizeAssetsManifest(
  manifest: unknown,
): SelfhostAssetsUploadSession["manifest"] | null {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return null;
  }

  const result: SelfhostAssetsUploadSession["manifest"] = {};
  for (const [path, value] of Object.entries(manifest)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return null;
    }
    const hash = (value as { hash?: unknown }).hash;
    if (typeof hash !== "string" || !hash.trim()) {
      return null;
    }
    const size = (value as { size?: unknown }).size;
    result[normalizeSelfhostAssetPath(path)] = {
      hash,
      ...(typeof size === "number" ? { size } : {}),
    };
  }
  return result;
}

function selfhostAssetUploadBuckets(
  manifest: SelfhostAssetsUploadSession["manifest"],
): string[][] {
  return [[...new Set(Object.values(manifest).map((entry) => entry.hash))]];
}

function base64UrlJson(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return base64UrlBytes(bytes);
}

function base64UrlBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function createLocalSelfhostAssetUploadJwt(manifestEntryCount: number): string {
  const now = Math.floor(Date.now() / 1000);
  const signatureBytes = new Uint8Array(32);
  crypto.getRandomValues(signatureBytes);
  return [
    base64UrlJson({ alg: "HS256", typ: "JWT" }),
    base64UrlJson({
      exp: now + 60 * 60,
      iat: now,
      jti: crypto.randomUUID(),
      max_file_count_allowed: Math.max(manifestEntryCount, 1),
    }),
    base64UrlBytes(signatureBytes),
  ].join(".");
}

async function createLocalSelfhostAssetsUploadSession(input: {
  env: CfApiProxyEnv;
  body: ArrayBuffer | null;
  dispatchScriptName: string;
  orgId: string;
  workspaceId: string;
}): Promise<Response> {
  if (!input.body) {
    return cfApiError(
      10006,
      "Asset upload session is missing a manifest body.",
      400,
    );
  }

  let parsed: { manifest?: unknown };
  try {
    parsed = JSON.parse(new TextDecoder("utf-8").decode(input.body)) as {
      manifest?: unknown;
    };
  } catch {
    return cfApiError(10006, "Asset upload session body must be JSON.", 400);
  }

  const manifest = normalizeAssetsManifest(parsed.manifest);
  if (!manifest) {
    return cfApiError(
      10006,
      "Asset upload session body has an invalid manifest.",
      400,
    );
  }

  const token = createLocalSelfhostAssetUploadJwt(Object.keys(manifest).length);
  const session: SelfhostAssetsUploadSession = {
    schemaVersion: 1,
    token,
    appId: input.dispatchScriptName,
    workspaceId: input.workspaceId,
    orgId: input.orgId,
    createdAt: new Date().toISOString(),
    manifest,
  };

  await input.env.APP_KV.put(
    selfhostAssetsSessionKey(token),
    JSON.stringify(session),
    { expirationTtl: 60 * 60 },
  );

  return cfApiSuccess({
    jwt: token,
    buckets: selfhostAssetUploadBuckets(manifest),
  });
}

async function storeLocalSelfhostUploadedAssets(input: {
  env: CfApiProxyEnv;
  request: Request;
  body: ArrayBuffer | null;
  contentType: string;
}): Promise<Response> {
  if (!input.env.R2_BUCKET) {
    return cfApiError(10006, "Self-host asset upload requires R2_BUCKET.", 500);
  }
  if (!input.body) {
    return cfApiError(10006, "Asset upload body is missing.", 400);
  }

  const token = getBearerToken(input.request);
  if (!token) {
    return cfApiError(
      10006,
      "Asset upload requires a bearer upload token.",
      401,
    );
  }
  const stored = await input.env.APP_KV.get(selfhostAssetsSessionKey(token));
  if (!stored) {
    return cfApiError(
      10006,
      "Asset upload session was not found or expired.",
      401,
    );
  }

  const session = JSON.parse(stored) as SelfhostAssetsUploadSession;
  const parts = parseMultipartParts(input.body, input.contentType);
  if (!parts) {
    return cfApiError(
      10006,
      "Asset upload body must be multipart form-data.",
      400,
    );
  }

  const uploaded = new Set<string>();
  for (const part of parts) {
    const hash = part.name ?? part.filename;
    if (!hash) continue;
    const content = base64DecodeBytes(multipartPartText(part));
    const contentType =
      part.contentType && part.contentType !== "application/null"
        ? part.contentType
        : undefined;
    await input.env.R2_BUCKET.put(
      selfhostAssetObjectKey(session.appId, hash),
      content,
      contentType ? { httpMetadata: { contentType } } : undefined,
    );
    uploaded.add(hash);
  }

  const manifest: SelfhostAssetsRecord["manifest"] = {};
  for (const [path, entry] of Object.entries(session.manifest)) {
    manifest[normalizeSelfhostAssetPath(path)] = {
      hash: entry.hash,
      ...(entry.size !== undefined ? { size: entry.size } : {}),
    };
  }

  const record: SelfhostAssetsRecord = {
    schemaVersion: 1,
    appId: session.appId,
    createdAt: new Date().toISOString(),
    manifest,
  };
  await input.env.APP_KV.put(
    selfhostAssetsKey(session.appId),
    JSON.stringify(record),
  );

  console.log("[cf-api-proxy] stored self-host assets", {
    appId: session.appId,
    manifestEntries: Object.keys(manifest).length,
    uploadedHashes: uploaded.size,
  });

  return cfApiSuccess({ jwt: token });
}

/**
 * Transform virtualized bindings in the multipart upload body by finding the raw
 * metadata JSON (already extracted by parseMultipartUploads) in the body bytes
 * and replacing it with modified metadata. This avoids fragile multipart parsing
 * and works regardless of line ending conventions.
 */
function transformVirtualBindings(
  body: ArrayBuffer,
  rawMetadataJson: string,
  bindings: WorkerBinding[] | undefined,
  workspaceId: string,
  orgId: string,
  userId: string | undefined,
  workerServiceName: string,
  appId: string,
  options?: {
    dropSelfhostIgnoredBindings?: boolean;
    connectionsBindingEnabled?: boolean;
  },
): ArrayBuffer {
  const existingBindings = bindings ?? [];
  const kvBindings = existingBindings.filter((b) => b.type === "kv_namespace");
  const r2Bindings = existingBindings.filter((b) => b.type === "r2_bucket");
  const assetBindings = existingBindings.filter((b) => b.type === "assets");
  const ignoredBindings = options?.dropSelfhostIgnoredBindings
    ? existingBindings.filter(isSelfhostIgnoredBinding)
    : [];
  const dataProxyBindings = existingBindings.filter(
    (b) => b.type === "service" && b.name === VIRTUAL_DATA_PROXY_BINDING_NAME,
  );
  const connectionsBindings = existingBindings.filter(
    (b) => b.type === "service" && b.name === VIRTUAL_CONNECTIONS_BINDING_NAME,
  );
  const aiBindings = existingBindings.filter((b) => b.type === "ai");
  const camelaiBindings = existingBindings.filter(
    (b) => b.type === "service" && b.name === VIRTUAL_CAMELAI_BINDING_NAME,
  );
  // Parse and transform the metadata
  let metadata: WorkerMetadata;
  try {
    metadata = JSON.parse(rawMetadataJson);
  } catch {
    console.warn(
      "[cf-api-proxy] failed to parse metadata JSON for virtual binding transformation",
    );
    return body;
  }

  const normalizedBindings = options?.dropSelfhostIgnoredBindings
    ? stripSelfhostIgnoredBindings(metadata.bindings ?? [])
    : (metadata.bindings ?? []);

  metadata.bindings = mapVirtualizedBindings(
    normalizedBindings,
    workspaceId,
    orgId,
    userId,
    workerServiceName,
    appId,
    {
      connectionsBindingEnabled: options?.connectionsBindingEnabled,
    },
  );
  metadata = withUsageGuardTracing(metadata);

  const newMetadataJson = JSON.stringify(metadata);

  // Find the raw metadata bytes in the body and replace them.
  // Metadata JSON is always ASCII, so text bytes == body bytes for this region.
  const encoder = new TextEncoder();
  const oldBytes = encoder.encode(rawMetadataJson);
  const newBytes = encoder.encode(newMetadataJson);
  const bodyBytes = new Uint8Array(body);

  // Byte-level search for the old metadata
  let matchPos = -1;
  outer: for (let i = 0; i <= bodyBytes.length - oldBytes.length; i++) {
    for (let j = 0; j < oldBytes.length; j++) {
      if (bodyBytes[i + j] !== oldBytes[j]) continue outer;
    }
    matchPos = i;
    break;
  }

  if (matchPos === -1) {
    console.warn(
      "[cf-api-proxy] could not find metadata bytes in body for virtual binding transformation",
      {
        metadataLength: rawMetadataJson.length,
        bodyLength: body.byteLength,
      },
    );
    return body;
  }

  // Reconstruct: before + new metadata + after
  const before = bodyBytes.slice(0, matchPos);
  const after = bodyBytes.slice(matchPos + oldBytes.length);
  const result = new Uint8Array(before.length + newBytes.length + after.length);
  result.set(before, 0);
  result.set(newBytes, before.length);
  result.set(after, before.length + newBytes.length);

  console.log("[cf-api-proxy] transformed virtual bindings", {
    workspaceId,
    orgId,
    workerServiceName,
    kvBindings: kvBindings.map((b) => ({
      name: b.name,
      namespace_id: b.namespace_id,
    })),
    r2Bindings: r2Bindings.map((b) => ({
      name: b.name,
      bucket_name: b.bucket_name,
    })),
    assetBindings: assetBindings.map((b) => ({ name: b.name })),
    dataProxyBindings: dataProxyBindings.map((b) => ({ name: b.name })),
    connectionsBindings: connectionsBindings.map((b) => ({ name: b.name })),
    aiBindings: aiBindings.map((b) => ({ name: b.name })),
    camelaiBindings: camelaiBindings.map((b) => ({ name: b.name })),
    ignoredBindings: ignoredBindings.map((b) => ({
      name: b.name,
      type: b.type,
    })),
    originalSize: body.byteLength,
    newSize: result.length,
  });

  return result.buffer as ArrayBuffer;
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
 * Configure tail_consumers for a dispatch script to enable log capture.
 * This attaches the tail worker to the user's deployed script.
 */
async function syncDispatchScriptSettings(
  accountId: string,
  dispatchNamespace: string,
  scriptName: string,
  apiToken: string,
  tailWorkerName: string,
): Promise<void> {
  const url =
    `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(accountId)}` +
    `/workers/dispatch/namespaces/${encodeURIComponent(dispatchNamespace)}` +
    `/scripts/${encodeURIComponent(scriptName)}/settings`;

  const headers = {
    Authorization: `Bearer ${apiToken}`,
  };

  const settings = {
    tail_consumers: [{ service: tailWorkerName }],
  };

  // Cloudflare expects multipart settings updates with a "settings" JSON part.
  const formData = new FormData();
  formData.set(
    "settings",
    new Blob([JSON.stringify(settings)], { type: "application/json" }),
    "settings.json",
  );

  const resp = await fetch(url, {
    method: "PATCH",
    headers,
    body: formData,
    redirect: "manual",
  });
  if (!resp.ok) {
    const text = await resp.text();
    console.error("[cf-api-proxy] failed to set tail_consumers", {
      status: resp.status,
      scriptName,
      tailWorkerName,
      body: text.slice(0, 500),
    });
    throw new Error(`Failed to set tail_consumers: ${resp.status}`);
  }

  console.log("[cf-api-proxy] configured tail_consumers", {
    scriptName,
    tailWorkerName,
  });
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

export interface ProxyCloudflareApiOptions {
  onDeploySideEffects: (info: DeploySideEffectsInfo) => Promise<void>;
  trustedIdentity?: CloudflareApiProxyIdentity;
}

export interface CloudflareApiProxyIdentity {
  orgId: string;
  orgSlug?: string;
  workspaceId: string;
  userId?: string;
  threadId?: string;
  projectId?: string;
}

function isSelfhostPublishingMode(env: CfApiProxyEnv): boolean {
  const accountId = env.CF_ACCOUNT_ID?.trim().toLowerCase();
  const namespace = env.CF_DISPATCH_NAMESPACE?.trim().toLowerCase();
  return accountId === "selfhost" || namespace === "selfhost";
}

export async function proxyCloudflareApi(
  request: Request,
  env: CfApiProxyEnv,
  options: ProxyCloudflareApiOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const selfhostPublishingMode = isSelfhostPublishingMode(env);

  const upstreamApiToken = env.CF_API_TOKEN?.trim();
  if (!selfhostPublishingMode && !upstreamApiToken) {
    return cfApiError(
      10000,
      "Missing CF_API_TOKEN for Cloudflare API proxy",
      500,
    );
  }

  console.log("[cf-api-proxy] request", {
    method: request.method,
    path: url.pathname,
    search: url.search,
  });

  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();

  // Asset uploads use Cloudflare-issued JWTs from assets-upload-session.
  // Skip our proxy-auth validation and pass through; Cloudflare validates the JWT
  // and the upload session is tied to the script name.
  if (
    !selfhostPublishingMode &&
    ASSETS_UPLOAD.test(url.pathname) &&
    request.method.toUpperCase() === "POST"
  ) {
    let pathname = url.pathname;
    // Rewrite account ID if configured
    if (accountId) {
      const accountMatch = pathname.match(
        /^\/client\/v4\/accounts\/([^/]+)\/(.*)$/,
      );
      if (accountMatch) {
        pathname = `/client/v4/accounts/${encodeURIComponent(accountId)}/${accountMatch[2] ?? ""}`;
      }
    }

    const upstreamUrl = new URL(
      `https://api.cloudflare.com${pathname}${url.search}`,
    );
    const headers = new Headers(request.headers);
    // Keep the original Authorization header (Cloudflare JWT)
    headers.delete("cookie");
    headers.delete("host");
    stripInternalProxyHeaders(headers);

    const resp = await fetch(upstreamUrl, {
      method: "POST",
      headers,
      body: request.body,
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  }

  // Deploys must come from a trusted internal handler or an authenticated
  // proxy that injects org/workspace/project identity headers.
  let orgId: string;
  let orgSlug: string | undefined;
  let workspaceId: string;
  let userId: string | undefined;
  let threadId: string | undefined;
  let projectId: string | undefined;

  const trustedIdentity = options.trustedIdentity;
  if (trustedIdentity) {
    orgId = trustedIdentity.orgId;
    orgSlug = trustedIdentity.orgSlug;
    workspaceId = trustedIdentity.workspaceId;
    userId = trustedIdentity.userId;
    threadId = trustedIdentity.threadId;
    projectId = trustedIdentity.projectId;

    if (!orgSlug) {
      const orgStub = env.ORG.get(
        env.ORG.idFromName(orgId),
      ) as DurableObjectStub<OrgDO>;
      orgSlug = (await orgStub.getSlug()) ?? undefined;
    }
    if (!orgSlug) {
      console.warn("[cf-api-proxy] trusted sandbox proxy: org has no slug", {
        orgId,
      });
      return cfApiError(10003, "Authentication error: Org has no slug", 401);
    }

    console.log("[cf-api-proxy] authenticated via trusted sandbox outbound", {
      orgId,
      workspaceId,
      orgSlug,
    });
  } else {
    const proxyAuth = validateSandboxProxy(request, env);
    if (proxyAuth.valid) {
      orgId = proxyAuth.orgId;
      workspaceId = proxyAuth.workspaceId;
      userId = proxyAuth.userId;
      threadId = proxyAuth.threadId;
      projectId = proxyAuth.projectId;

      // Look up org_slug from OrgDO (needed for script namespacing)
      const orgStub = env.ORG.get(
        env.ORG.idFromName(orgId),
      ) as DurableObjectStub<OrgDO>;
      orgSlug = (await orgStub.getSlug()) ?? undefined;
      if (!orgSlug) {
        console.warn("[cf-api-proxy] sandbox proxy: org has no slug", {
          orgId,
        });
        return cfApiError(10003, "Authentication error: Org has no slug", 401);
      }

      console.log("[cf-api-proxy] authenticated via sandbox proxy", {
        orgId,
        workspaceId,
        orgSlug,
      });
    } else {
      console.warn("[cf-api-proxy] missing trusted deploy proxy identity", {
        method: request.method,
        path: url.pathname,
        hasAuthorizationHeader: !!request.headers.get("Authorization"),
      });
      return cfApiError(
        10001,
        "Authentication error: Trusted deploy proxy identity required",
        401,
      );
    }
  }

  let pathname = url.pathname;

  // Extract original script name before rewriting
  let originalScriptName = extractScriptName(pathname);

  // Rewrite WFP dispatch namespace (and optionally account id) on the fly.
  // Also rewrite script name to include org-slug suffix: {script-name}--{org-slug}
  // /client/v4/accounts/:account_id/workers/dispatch/namespaces/:dispatch_namespace/scripts/:script/...
  const dispatchMatch = pathname.match(
    /^\/client\/v4\/accounts\/([^/]+)\/workers\/dispatch\/namespaces\/([^/]+)\/(.*)$/,
  );
  if (dispatchMatch) {
    let rest = dispatchMatch[3] ?? "";
    const rewrittenAccount = accountId ?? dispatchMatch[1]!;
    const rewrittenNs = dispatchNamespace ?? dispatchMatch[2]!;

    // Rewrite script name to include org-slug suffix
    // rest might be: scripts/{scriptName} or scripts/{scriptName}/settings etc.
    const scriptPathMatch = rest.match(/^scripts\/([^/]+)(\/.*)?$/);
    if (scriptPathMatch && originalScriptName) {
      const suffix = scriptPathMatch[2] ?? "";
      const dispatchScriptName = `${originalScriptName}--${orgSlug}`;
      rest = `scripts/${encodeURIComponent(dispatchScriptName)}${suffix}`;
    }

    pathname = `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}/${rest}`;
  }
  // Wrangler may read secrets through the legacy script endpoint even when the
  // deploy target is a dispatch namespace. Rewrite that preflight request so it
  // is authorized and namespaced like the rest of the dispatch deploy.
  if (!dispatchMatch && request.method.toUpperCase() === "GET") {
    const directSecretsMatch = pathname.match(DIRECT_SCRIPT_SECRETS);
    if (directSecretsMatch) {
      let scriptName = directSecretsMatch[2] ?? "";
      try {
        scriptName = decodeURIComponent(scriptName);
      } catch {
        // Keep the encoded segment for diagnostics and fallback behavior.
      }
      scriptName = scriptName.trim();
      if (scriptName) {
        originalScriptName = originalScriptName ?? scriptName;
        const rewrittenAccount = accountId ?? directSecretsMatch[1]!;
        const rewrittenNs = dispatchNamespace ?? "selfhost";
        const dispatchScriptName = `${scriptName}--${orgSlug}`;
        pathname =
          `/client/v4/accounts/${encodeURIComponent(rewrittenAccount)}` +
          `/workers/dispatch/namespaces/${encodeURIComponent(rewrittenNs)}` +
          `/scripts/${encodeURIComponent(dispatchScriptName)}/secrets`;
      }
    }
  }
  // Block regular worker script/service endpoints - users must use the globally installed wrangler
  // which is configured to deploy to the dispatch namespace directly
  if (!dispatchMatch) {
    const scriptsMatch = pathname.match(
      /^\/client\/v4\/accounts\/[^/]+\/workers\/scripts\/[^/]+/,
    );
    const servicesMatch = pathname.match(
      /^\/client\/v4\/accounts\/[^/]+\/workers\/services\/[^/]+/,
    );

    if (scriptsMatch || servicesMatch) {
      console.warn("[cf-api-proxy] blocked non-dispatch worker endpoint", {
        method: request.method,
        path: pathname,
      });
      return cfApiError(
        10000,
        "Direct worker deployments are not supported. Use `wrangler deploy --dispatch-namespace chiridion` instead.",
        403,
      );
    }
  }

  // Opportunistically rewrite account id for any /accounts/:id/... calls.
  if (accountId) {
    const accountMatch = pathname.match(
      /^\/client\/v4\/accounts\/([^/]+)\/(.*)$/,
    );
    if (accountMatch) {
      pathname = `/client/v4/accounts/${encodeURIComponent(accountId)}/${accountMatch[2] ?? ""}`;
    }
  }

  // Intercept R2 bucket verification requests from wrangler.
  // Wrangler checks if the bucket exists before deploying a worker with r2_bucket bindings.
  // Since we virtualize all R2 buckets, return a synthetic success response.
  const r2BucketMatch = pathname.match(
    /^\/client\/v4\/accounts\/[^/]+\/r2\/buckets\/([^/]+)$/,
  );
  if (r2BucketMatch && request.method === "GET") {
    const bucketName = decodeURIComponent(r2BucketMatch[1]!);
    console.log(
      "[cf-api-proxy] intercepted R2 bucket verification (virtual bucket)",
      {
        bucketName,
        workspaceId,
        orgId,
      },
    );
    return new Response(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: {
          name: bucketName,
          creation_date: new Date().toISOString(),
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  if (
    selfhostPublishingMode &&
    request.method === "GET" &&
    TOKEN_VERIFY.test(pathname)
  ) {
    return cfApiSuccess({
      id: "selfhost",
      status: "active",
    });
  }

  if (!isAllowedCloudflareApiProxyRequest(pathname, request.method)) {
    console.warn("[cf-api-proxy] blocked", {
      method: request.method,
      originalPath: url.pathname,
      rewrittenPath: pathname,
      search: url.search,
      hasToken: true,
    });
    return cfApiError(
      10003,
      "Forbidden: Request blocked by API proxy allowlist",
      403,
    );
  }

  // Script ownership is now enforced by org-slug namespacing in the script name.
  // Scripts are named {script-name}--{org-slug}, so org A cannot deploy to org B's scripts.
  // The org-slug in the token is verified, so the script name prefix is trusted.
  const dispatchScriptName = originalScriptName
    ? `${originalScriptName}--${orgSlug}`
    : null;

  // Intercept tail creation requests (wrangler tail) and return our WebSocket URL
  const tailMatch = pathname.match(DISPATCH_SCRIPT_TAILS);
  if (
    tailMatch &&
    request.method.toUpperCase() === "POST" &&
    originalScriptName &&
    dispatchScriptName
  ) {
    // Generate a tail token for WebSocket auth
    const tailToken = await createSignedToken(env.TOKEN_SIGNING_SECRET, {
      org_id: orgId,
      org_slug: orgSlug,
      scopes: ["tail"],
      exp: Date.now() + 60 * 60 * 1000, // 1 hour
      workspace_id: workspaceId,
      script_name: originalScriptName,
      dispatch_script_name: dispatchScriptName,
      name: `tail-${dispatchScriptName}`,
    });

    // Build WebSocket URL - use WORKER_BASE_URL or derive from request
    const baseUrl = env.WORKER_BASE_URL || `https://${url.hostname}`;
    const wsUrl = `${baseUrl.replace(/^http/, "ws")}/ws/logs?scriptName=${encodeURIComponent(originalScriptName)}&token=${encodeURIComponent(tailToken)}`;

    console.log("[cf-api-proxy] intercepted tail request", {
      scriptName: originalScriptName,
      dispatchScriptName,
      orgId,
    });

    // Return Cloudflare-compatible tail response
    return new Response(
      JSON.stringify({
        success: true,
        errors: [],
        messages: [],
        result: {
          id: crypto.randomUUID(),
          url: wsUrl,
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        },
      }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  const upstreamUrl = new URL(
    `https://api.cloudflare.com${pathname}${url.search}`,
  );
  const headers = new Headers(request.headers);

  // Always use our Worker token when proxying (POC).
  if (upstreamApiToken) {
    headers.set("Authorization", `Bearer ${upstreamApiToken}`);
  }
  headers.delete("cookie");
  headers.delete("host");
  stripInternalProxyHeaders(headers);

  const method = request.method.toUpperCase();
  let body: ArrayBuffer | undefined =
    method === "GET" || method === "HEAD"
      ? undefined
      : await request.arrayBuffer();

  if (selfhostPublishingMode && method === "POST") {
    if (DISPATCH_ASSETS_UPLOAD_SESSION.test(pathname)) {
      if (!dispatchScriptName) {
        return cfApiError(
          10006,
          "Asset upload session is missing a script name.",
          400,
        );
      }
      return createLocalSelfhostAssetsUploadSession({
        env,
        body: body ?? null,
        dispatchScriptName,
        orgId,
        workspaceId,
      });
    }
    if (ASSETS_UPLOAD.test(pathname)) {
      return storeLocalSelfhostUploadedAssets({
        env,
        request,
        body: body ?? null,
        contentType: request.headers.get("Content-Type") ?? "",
      });
    }
  }

  if (
    selfhostPublishingMode &&
    method === "GET" &&
    DISPATCH_SCRIPT_SECRETS.test(pathname)
  ) {
    return cfApiSuccess([]);
  }

  // Extract configPath and validate bindings from metadata if present in upload
  let configPath: string | undefined;
  if (body && isUploadRequest(pathname, method)) {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.toLowerCase().includes("multipart/form-data")) {
      const uploadInfo = parseMultipartUploads(body, contentType);
      if (uploadInfo?.configPath) {
        configPath = uploadInfo.configPath;
      }

      // Validate bindings - block forbidden binding types
      if (uploadInfo?.bindings?.length) {
        const validationResult = validateBindings(uploadInfo.bindings);
        if (!validationResult.valid) {
          const forbiddenList = validationResult.forbiddenBindings
            .map((b) => `${b.name} (${b.type})`)
            .join(", ");
          console.warn("[cf-api-proxy] blocked deploy: forbidden bindings", {
            method,
            path: pathname,
            scriptName: originalScriptName,
            orgId,
            workspaceId,
            forbiddenBindings: validationResult.forbiddenBindings,
          });
          return cfApiError(
            10005,
            `Deploy blocked: Your worker contains forbidden bindings: ${forbiddenList}. ` +
              `User workers can only use environment variables, Durable Objects defined in the same script, and platform-virtualized resources. ` +
              `External resources (D1, Queues, etc.) are not allowed unless virtualized by the platform (KV, R2, ASSETS, DATA_PROXY, CONNECTIONS, AI).`,
            403,
          );
        }
        if (selfhostPublishingMode) {
          const selfhostValidation = validateSelfhostBindings(
            uploadInfo.bindings,
          );
          if (!selfhostValidation.valid) {
            const forbiddenList = selfhostValidation.forbiddenBindings
              .map((b) => `${b.name} (${b.type})`)
              .join(", ");
            return cfApiError(
              10006,
              `Self-host deploy blocked: these bindings are not implemented by the local dynamic publisher yet: ${forbiddenList}. ` +
                `Currently supported self-host app bindings are environment variables, Durable Objects defined in the same script, virtual KV, virtual R2, assets, AI, DATA_PROXY, CONNECTIONS, and CAMELAI.`,
              403,
            );
          }
        }
        console.log("[cf-api-proxy] bindings validated", {
          method,
          path: pathname,
          bindingCount: uploadInfo.bindings.length,
          bindingTypes: [...new Set(uploadInfo.bindings.map((b) => b.type))],
        });
      }

      if (uploadInfo?.files.length) {
        console.log("[cf-api-proxy] upload files", {
          method,
          path: pathname,
          files: uploadInfo.files,
        });
      }
      if (uploadInfo?.formParts.length) {
        console.log("[cf-api-proxy] upload form parts", {
          method,
          path: pathname,
          partCount: uploadInfo.formParts.length,
          parts: uploadInfo.formParts,
        });
      }
      if (uploadInfo?.wranglerConfigs.length) {
        for (const config of uploadInfo.wranglerConfigs) {
          console.log("[cf-api-proxy] wrangler config upload", {
            method,
            path: pathname,
            filename: config.filename,
            size: config.size,
            truncated: config.truncated,
            content: config.content,
          });
        }
      }
    }
  }

  // Validate bindings in JSON body requests (settings PATCH, versions POST)
  if (body && isBindingsJsonRequest(pathname, method)) {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.toLowerCase().includes("application/json")) {
      try {
        const decoder = new TextDecoder("utf-8");
        const jsonBody = JSON.parse(
          decoder.decode(body),
        ) as SettingsRequestBody;
        if (jsonBody.bindings?.length) {
          const validationResult = validateBindings(jsonBody.bindings);
          if (!validationResult.valid) {
            const forbiddenList = validationResult.forbiddenBindings
              .map((b) => `${b.name} (${b.type})`)
              .join(", ");
            console.warn(
              "[cf-api-proxy] blocked settings update: forbidden bindings",
              {
                method,
                path: pathname,
                scriptName: originalScriptName,
                orgId,
                workspaceId,
                forbiddenBindings: validationResult.forbiddenBindings,
              },
            );
            return cfApiError(
              10005,
              `Settings update blocked: Request contains forbidden bindings: ${forbiddenList}. ` +
                `User workers can only use environment variables, Durable Objects defined in the same script, and platform-virtualized resources. ` +
                `External resources (D1, Queues, etc.) are not allowed unless virtualized by the platform (KV, R2, ASSETS, DATA_PROXY, CONNECTIONS, AI).`,
              403,
            );
          }
          if (selfhostPublishingMode) {
            const selfhostValidation = validateSelfhostBindings(
              jsonBody.bindings,
            );
            if (!selfhostValidation.valid) {
              const forbiddenList = selfhostValidation.forbiddenBindings
                .map((b) => `${b.name} (${b.type})`)
                .join(", ");
              return cfApiError(
                10006,
                `Self-host settings update blocked: these bindings are not implemented by the local dynamic publisher yet: ${forbiddenList}. ` +
                  `Currently supported self-host app bindings are environment variables, Durable Objects defined in the same script, virtual KV, virtual R2, assets, AI, DATA_PROXY, CONNECTIONS, and CAMELAI.`,
                403,
              );
            }
          }
          console.log("[cf-api-proxy] settings bindings validated", {
            method,
            path: pathname,
            bindingCount: jsonBody.bindings.length,
            bindingTypes: [...new Set(jsonBody.bindings.map((b) => b.type))],
          });

          if (env.CF_WORKER_NAME) {
            const transformedBindings = mapVirtualizedBindings(
              selfhostPublishingMode
                ? stripSelfhostIgnoredBindings(jsonBody.bindings)
                : jsonBody.bindings,
              workspaceId,
              orgId,
              userId,
              env.CF_WORKER_NAME,
              dispatchScriptName ?? originalScriptName ?? "unknown",
              {
                connectionsBindingEnabled: connectionsBindingEnabled(env),
              },
            );
            const changed =
              transformedBindings.some((binding, idx) => {
                const original = jsonBody.bindings?.[idx];
                return JSON.stringify(binding) !== JSON.stringify(original);
              }) || transformedBindings.length !== jsonBody.bindings.length;
            if (changed) {
              jsonBody.bindings = transformedBindings;
              body = new TextEncoder().encode(JSON.stringify(jsonBody))
                .buffer as ArrayBuffer;
              headers.set("Content-Length", String(body.byteLength));
              console.log(
                "[cf-api-proxy] transformed JSON bindings to virtual bindings",
                {
                  method,
                  path: pathname,
                  scriptName: originalScriptName,
                  orgId,
                  workspaceId,
                },
              );
            }
          }
        }
      } catch (e) {
        // If we can't parse the JSON, let Cloudflare handle the error
        console.warn(
          "[cf-api-proxy] failed to parse JSON body for binding validation",
          {
            method,
            path: pathname,
            error: String(e),
          },
        );
      }
    }
  }

  // Pre-deploy check: prevent cross-workspace name collisions
  // This must happen BEFORE the Cloudflare API call to prevent the deploy
  if (isUploadRequest(pathname, method) && originalScriptName) {
    const orgStub = env.ORG.get(env.ORG.idFromName(orgId)) as unknown as OrgDO;
    const existingScript = await orgStub.getWorkerScript(originalScriptName);
    if (existingScript && existingScript.workspace_id !== workspaceId) {
      console.warn("[cf-api-proxy] blocked deploy: script name collision", {
        scriptName: originalScriptName,
        existingWorkspaceId: existingScript.workspace_id,
        attemptedWorkspaceId: workspaceId,
        orgId,
      });
      return cfApiError(
        10004,
        `Script name "${originalScriptName}" is already in use by another workspace in this organization. Please choose a different name.`,
        409,
      );
    }
    if (!existingScript) {
      const orgInfo = await orgStub.getInfo();
      const appLimit = orgInfo
        ? getBillingPlanLimits(orgInfo.billing_plan, orgInfo.billing_status)
            .maxDeployedAppsPerWorkspace
        : 3;
      if (appLimit !== null) {
        const workspaceScripts =
          await orgStub.listWorkerScriptsByWorkspace(workspaceId);
        if (workspaceScripts.length >= appLimit) {
          return cfApiError(
            10005,
            `Your current billing plan allows ${appLimit} deployed app${appLimit === 1 ? "" : "s"} per workspace.`,
            402,
          );
        }
      }
    }
  }

  // Transform virtualized bindings into internal service bindings.
  if (body && isUploadRequest(pathname, method) && env.CF_WORKER_NAME) {
    const contentType = request.headers.get("Content-Type") ?? "";
    if (contentType.toLowerCase().includes("multipart/form-data")) {
      const uploadInfo2 = parseMultipartUploads(body, contentType);
      if (uploadInfo2?.rawMetadataJson) {
        body = transformVirtualBindings(
          body,
          uploadInfo2.rawMetadataJson,
          uploadInfo2.bindings,
          workspaceId,
          orgId,
          userId,
          env.CF_WORKER_NAME,
          dispatchScriptName ?? originalScriptName ?? "unknown",
          {
            dropSelfhostIgnoredBindings: selfhostPublishingMode,
            connectionsBindingEnabled: connectionsBindingEnabled(env),
          },
        );
        headers.set("Content-Length", String(body.byteLength));
      }
    }
  }

  if (selfhostPublishingMode) {
    if (
      method === "PUT" &&
      isUploadRequest(pathname, method) &&
      body &&
      originalScriptName &&
      dispatchScriptName
    ) {
      const contentType = request.headers.get("Content-Type") ?? "";
      const record = await storeLocalSelfhostWorker({
        env,
        body,
        contentType,
        scriptName: originalScriptName,
        dispatchScriptName,
        orgId,
        orgSlug,
        workspaceId,
      });
      if (!record) {
        return cfApiError(
          10006,
          "Self-host deploy upload did not contain a module Worker bundle.",
          400,
        );
      }

      waitUntil(
        options
          .onDeploySideEffects({
            scriptName: originalScriptName,
            dispatchScriptName,
            orgId,
            orgSlug,
            workspaceId,
            hostname: url.hostname,
            threadId,
            projectId,
            configPath,
          })
          .catch((err) => {
            console.error(
              "[cf-api-proxy] failed to process self-host deploy side effects",
              {
                scriptName: originalScriptName,
                dispatchScriptName,
                orgId,
                workspaceId,
                error: String(err),
              },
            );
          }),
      );

      return cfApiSuccess(localSelfhostWorkerResult(record));
    }

    if (
      method === "GET" &&
      dispatchScriptName &&
      DISPATCH_SCRIPT_BASE.test(pathname)
    ) {
      const stored = await env.APP_KV.get(
        selfhostWorkerKey(dispatchScriptName),
      );
      if (!stored) {
        return cfApiError(10007, "Worker not found", 404);
      }
      const record = JSON.parse(stored) as SelfhostWorkerRecord;
      return cfApiSuccess(localSelfhostWorkerResult(record));
    }

    if (
      method === "PATCH" &&
      (DISPATCH_SCRIPT_SETTINGS.test(pathname) ||
        DISPATCH_SCRIPT_SCRIPT_SETTINGS.test(pathname))
    ) {
      return cfApiSuccess({ script_name: dispatchScriptName, settings: {} });
    }

    if (method === "POST" && DISPATCH_SCRIPT_VERSIONS_API.test(pathname)) {
      return cfApiSuccess({ id: crypto.randomUUID(), number: 1, metadata: {} });
    }

    if (method === "POST" && DISPATCH_SCRIPT_DEPLOYMENTS.test(pathname)) {
      return cfApiSuccess({ id: crypto.randomUUID(), source: "selfhost" });
    }

    return cfApiSuccess({ ok: true });
  }

  const operationAppId = method === "PUT" && isUploadRequest(pathname, method) && originalScriptName
    ? `${orgId}:${originalScriptName}`
    : null;
  const operationLeaseHolder = operationAppId ? crypto.randomUUID() : null;
  if (
    operationAppId &&
    operationLeaseHolder &&
    env.APP_DB &&
    !(await acquireUsageGuardOperationLeaseWithRetry({ db: env.APP_DB, appId: operationAppId, holder: operationLeaseHolder })).acquired
  ) {
    return cfApiError(10008, "App deployment is temporarily busy; retry shortly", 409);
  }
  const releaseOperationLease = async () => {
    if (operationAppId && operationLeaseHolder && env.APP_DB) {
      await releaseUsageGuardOperationLease({ db: env.APP_DB, appId: operationAppId, holder: operationLeaseHolder });
    }
  };
  let resp: Response;
  try {
    resp = await fetch(upstreamUrl, { method, headers, body });
  } catch (error) {
    await releaseOperationLease();
    throw error;
  }
  const respBody = await resp.arrayBuffer();

  if (!resp.ok) {
    const ct = resp.headers.get("Content-Type") ?? "";
    let preview = "";
    if (ct.includes("application/json") || ct.startsWith("text/")) {
      try {
        preview = new TextDecoder().decode(respBody.slice(0, 1024));
      } catch {
        preview = "";
      }
    }
    console.warn("[cf-api-proxy] upstream error", {
      status: resp.status,
      method,
      upstreamPath: upstreamUrl.pathname,
      search: upstreamUrl.search,
      contentType: ct,
      bodyPreview: preview,
    });
    await releaseOperationLease();
    return new Response(respBody, {
      status: resp.status,
      headers: resp.headers,
    });
  }

  if (method === "PUT") {
    const scriptMatch = pathname.match(DISPATCH_SCRIPT_BASE);
    if (scriptMatch && originalScriptName && dispatchScriptName) {
      const account = decodeURIComponent(scriptMatch[1]!);
      const dispatchNs = decodeURIComponent(scriptMatch[2]!);
      let uploadBody: unknown;
      try {
        uploadBody = JSON.parse(new TextDecoder().decode(respBody));
      } catch {}
      let scriptVersion: string | undefined;
      try {
        scriptVersion = upstreamApiToken
          ? await resolveUploadedDispatchScriptVersion({
              uploadBody,
              accountId: account,
              dispatchNamespace: dispatchNs,
              dispatchScriptName,
              apiToken: upstreamApiToken,
            })
          : undefined;
      } catch (error) {
        await releaseOperationLease();
        throw error;
      }

      // Keep the per-app operation lease through canonical D1/KV eligibility.
      try {
        await options.onDeploySideEffects({
          scriptName: originalScriptName,
          dispatchScriptName,
          orgId,
          orgSlug,
          workspaceId,
          hostname: url.hostname,
          threadId,
          projectId,
          configPath,
          scriptVersion,
        });
      } catch (error) {
        console.error("[cf-api-proxy] failed to process deploy side effects", {
          scriptName: originalScriptName,
          dispatchScriptName,
          orgId,
          workspaceId,
          error: String(error),
        });
        await releaseOperationLease();
        throw error;
      }

      // Attach tail worker for log capture
      if (env.TAIL_WORKER_NAME && upstreamApiToken) {
        waitUntil(
          syncDispatchScriptSettings(
            account,
            dispatchNs,
            dispatchScriptName,
            upstreamApiToken,
            env.TAIL_WORKER_NAME,
          ).catch((err) => {
            console.error("[cf-api-proxy] failed to configure tail worker", {
              account,
              dispatchNamespace: dispatchNs,
              dispatchScriptName,
              tailWorkerName: env.TAIL_WORKER_NAME,
              error: String(err),
            });
          }),
        );
      }

      // Auto-set preview when the authenticated proxy identity includes a thread.
      if (threadId) {
        waitUntil(
          (async () => {
            try {
              const threadStub = env.CHAT_THREAD.get(
                env.CHAT_THREAD.idFromName(threadId),
              );
              let isPublic = false;
              try {
                const orgStub = env.ORG.get(env.ORG.idFromName(orgId));
                // Use originalScriptName for OrgDO lookup (stores user-facing name)
                const script =
                  await orgStub.getWorkerScript(originalScriptName);
                if (script) {
                  isPublic = script.is_public;
                } else {
                  const stored = await env.APP_KV.get(
                    `${SCRIPT_PREFIX}${dispatchScriptName}`,
                  );
                  if (stored) {
                    try {
                      const parsed = JSON.parse(stored) as {
                        is_public?: boolean;
                      };
                      if (typeof parsed.is_public === "boolean") {
                        isPublic = parsed.is_public;
                      } else {
                        isPublic = true;
                      }
                    } catch {
                      isPublic = true;
                    }
                  } else {
                    // Default for newly registered scripts
                    isPublic = true;
                  }
                }
              } catch (err) {
                console.error("[cf-api-proxy] failed to load app visibility", {
                  threadId,
                  scriptName: originalScriptName,
                  orgId,
                  error: String(err),
                });
              }
              // Use originalScriptName for preview (user-facing)
              await threadStub.fetch(
                new Request("http://internal/preview", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    target: {
                      kind: "app",
                      scriptName: originalScriptName,
                      isPublic,
                    },
                  }),
                }),
              );
              console.log("[cf-api-proxy] auto-set preview", {
                threadId,
                scriptName: originalScriptName,
                orgId,
              });
            } catch (err) {
              console.error("[cf-api-proxy] failed to auto-set preview", {
                threadId,
                scriptName: originalScriptName,
                orgId,
                error: String(err),
              });
            }
          })(),
        );
      }
    }
  }

  await releaseOperationLease();
  return new Response(respBody, { status: resp.status, headers: resp.headers });
}
