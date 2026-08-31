import { streamFile } from "@cloudflare/sandbox";
import type {
  DirectDeployAsset,
  DirectWorkerMetadata,
  DirectWorkerModule,
} from "./direct-dispatch-deploy.js";
import type { WorkerBinding } from "./cf-api-proxy.js";
import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  parseJsonBounded,
  runtimeJsonLimits,
} from "./chat-thread/bounded-json-parse.js";
import { utf8ByteLength } from "./chat-thread/utf8-byte-length.js";

const SANDBOX_FILE_MAX_WIRE_CHUNKS = 4_096;
const SANDBOX_LIST_TIMEOUT_MS = 30_000;
const SANDBOX_LIST_MAX_STDOUT_BYTES = 1024 * 1024;
const BUNDLE_COLLECTION_CLEANUP_MS = 1_000;
const BUNDLE_COLLECTION_RESET_MS = 10_000;
export const PROJECT_BUILD_BUNDLE_COLLECTION_RESERVE_MS = 15_000;
export const PROJECT_BUILD_ASSET_READ_CONCURRENCY = 8;
export const PROJECT_BUILD_MODULE_READ_CONCURRENCY = 4;
const PROJECT_BUILD_MODULE_MAX_RULES = 128;
const PROJECT_BUILD_MODULE_MAX_GLOB_BYTES = 64 * 1024;
export const PROJECT_BUILD_MANIFEST_MAX_BYTES =
  CHAT_RUNTIME_BOUNDS.providerStateBytes;
export const PROJECT_BUILD_MODULE_MAX_FILES =
  CHAT_RUNTIME_BOUNDS.toolTransferFilesPerCall;
export const PROJECT_BUILD_MODULE_MAX_FILE_BYTES =
  CHAT_RUNTIME_BOUNDS.toolTransferFileBytes;
export const PROJECT_BUILD_MODULE_MAX_TOTAL_BYTES =
  CHAT_RUNTIME_BOUNDS.toolTransferFileBytes;
export const PROJECT_BUILD_MODULE_READ_MAX_IN_FLIGHT_BYTES =
  PROJECT_BUILD_MODULE_MAX_TOTAL_BYTES;
export const PROJECT_BUILD_SOURCE_MAX_TOTAL_BYTES =
  2 * CHAT_RUNTIME_BOUNDS.toolTransferFileBytes;
export const PROJECT_BUILD_SOURCE_LIST_MAX_PATH_BYTES = 256 * 1024;
export const PROJECT_BUILD_OUTPUT_MAX_ENTRIES =
  CHAT_RUNTIME_BOUNDS.providerJsonEntries;
export const PROJECT_BUILD_OUTPUT_MAX_PATH_BYTES =
  CHAT_RUNTIME_BOUNDS.selfhostAgentPathChars;
export const PROJECT_BUILD_ASSET_MAX_BYTES =
  CHAT_RUNTIME_BOUNDS.toolTransferFileBytes;
export const PROJECT_BUILD_ASSET_MAX_TOTAL_BYTES =
  2 * CHAT_RUNTIME_BOUNDS.toolTransferFileBytes;
export const PROJECT_BUILD_ASSET_READ_MAX_IN_FLIGHT_BYTES =
  2 * PROJECT_BUILD_ASSET_MAX_BYTES;

const BOUNDED_SANDBOX_LIST_SCRIPT = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const root = process.env.CAMELAI_BOUNDED_LIST_ROOT;
const maxEntries = 4096;
const maxPathBytes = 256 * 1024;
const maxOutputBytes = 1024 * 1024;
const fail = (message) => {
  process.stdout.write(JSON.stringify({ success: false, error: message }));
  process.exit(2);
};
try {
  if (!root || Buffer.byteLength(root) > 4096) fail("invalid listing root");
  const pending = [{ absolute: root, relative: "" }];
  const files = [];
  let entries = 0;
  let pathBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    const handle = fs.opendirSync(directory.absolute);
    try {
      for (;;) {
        const item = handle.readSync();
        if (!item) break;
        const relative = directory.relative
          ? directory.relative + "/" + item.name
          : item.name;
        entries += 1;
        pathBytes += Buffer.byteLength(relative);
        if (entries > maxEntries) fail("listing entry limit exceeded");
        if (pathBytes > maxPathBytes) fail("listing path byte limit exceeded");
        const absolute = path.join(directory.absolute, item.name);
        const stat = fs.lstatSync(absolute);
        if (stat.isSymbolicLink()) continue;
        if (stat.isDirectory()) {
          files.push({ name: item.name, type: "directory", relativePath: relative, size: 0 });
          pending.push({ absolute, relative });
        } else if (stat.isFile()) {
          if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
            fail("listing returned an invalid file size");
          }
          files.push({ name: item.name, type: "file", relativePath: relative, size: stat.size });
        }
      }
    } finally {
      handle.closeSync();
    }
  }
  const output = JSON.stringify({ success: true, files });
  if (Buffer.byteLength(output) > maxOutputBytes) fail("listing output limit exceeded");
  process.stdout.write(output);
} catch (error) {
  fail(error instanceof Error ? error.message.slice(0, 512) : "listing failed");
}
`;

export interface ProjectBuildSandboxLike {
  // Matches @cloudflare/sandbox ExecOptions: the execution bound is `timeout`
  // (ms). Do not add a `timeoutMs` alias — the SDK silently ignores it.
  exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string | undefined>;
      timeout?: number;
    },
  ): Promise<{
    success?: boolean;
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
    options?: { encoding?: "base64" | "utf8" },
  ): Promise<unknown>;
  exists?(path: string): Promise<{ exists: boolean }>;
  /**
   * Readiness-probe entry point that runs a command through the session layer
   * WITHOUT the DO-side zombie self-heal, so the gate's consecutive-probe
   * threshold — not the DO's destroy-on-first-death exec wrapper — decides when
   * a zombie is restarted. Optional: shapes without it fall back to `exec`.
   */
  probeShell?(
    command: string,
    options?: { cwd?: string; timeout?: number },
  ): Promise<{
    stdout?: string;
    stderr?: string;
    exitCode?: number;
  }>;
  /**
   * ProjectBuildSandbox-only: defer the idle reaper while the org's build
   * session is active. Optional so plain Sandbox stubs and test fakes still
   * satisfy this interface.
   */
  noteBuildSessionActivity?(windowMs?: number): Promise<void>;
  /**
   * Zombie self-heal (sandbox-zombie-recovery.ts): destroy a container whose
   * shell layer is dead so the next call boots clean. Rate-limited DO-side.
   * Optional for the same reason as above.
   */
  restartZombieContainer?(request: {
    operation: string;
    trigger: "exec_session_death" | "probe_session_death";
    error?: string;
  }): Promise<{ restarted: boolean; reason: string } | undefined>;
  /** Destructive fence used only when a bounded bundle stream is abandoned. */
  resetAfterBundleCollectionTimeout?(): Promise<void>;
  readFile?(
    path: string,
    options?: { encoding?: "base64" | "utf8" },
  ): Promise<{ content: string }>;
  readFileStream?(path: string): Promise<ReadableStream<Uint8Array>>;
  listFiles?(
    path: string,
    options?: { recursive?: boolean; includeHidden?: boolean },
  ): Promise<{
    files: Array<{
      name: string;
      type: "file" | "directory";
      relativePath?: string;
      absolutePath?: string;
      size?: number;
    }>;
  }>;
}

export interface ProjectWorkerBundle {
  metadata: DirectWorkerMetadata;
  modules: DirectWorkerModule[];
  // Asset bytes are collected under the same sandbox ownership deadline as
  // modules, then exposed through stable handles. The aggregate is deliberately
  // small so no sandbox-backed closure can outlive collection or reset a later
  // deploy attempt.
  assets: DirectDeployAsset[];
  manifestPath: string;
  /**
   * The wrangler config `name`, when the manifest declares one. Deploys use it
   * as the default script name so a migrated project keeps the app identity
   * (and URL) its VM-era `wrangler deploy` created, even when the durable
   * project was registered under a different name.
   */
  configName?: string;
}

export interface ProjectWorkerBundleCollectionOptions {
  /** One wall-clock budget shared by manifest, listings, modules and assets. */
  timeoutMs: number;
  /** Must destroy the owning container; resolution is treated as confirmation. */
  onTimeout(): Promise<void>;
  resetTimeoutMs?: number;
  /** Deterministic clock seam for deadline regressions. */
  now?: () => number;
}

interface BundleCollectionDeadline {
  run<T>(start: () => Promise<T>): Promise<T>;
  cleanup(work: Promise<unknown>): Promise<void>;
}

function createBundleCollectionDeadline(
  options: ProjectWorkerBundleCollectionOptions,
): BundleCollectionDeadline {
  const now = options.now ?? (() => Date.now());
  const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
  const deadlineAt = now() + timeoutMs;
  let timedOut = false;
  let fencePromise: Promise<void> | undefined;
  const timeoutError = () =>
    new Error(
      `Build bundle collection exceeded its ${timeoutMs}ms absolute deadline; the owning sandbox was reset`,
    );
  const confirmFence = (): Promise<void> => {
    timedOut = true;
    if (fencePromise) return fencePromise;
    fencePromise = (async () => {
      const reset = Promise.resolve().then(() => options.onTimeout());
      reset.catch(() => {});
      let handle: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<"timeout">((resolve) => {
        handle = setTimeout(
          () => resolve("timeout"),
          options.resetTimeoutMs ?? BUNDLE_COLLECTION_RESET_MS,
        );
      });
      try {
        const outcome = await Promise.race([
          reset.then(
            () => "reset" as const,
            () => "failed" as const,
          ),
          expired,
        ]);
        if (outcome !== "reset") {
          throw new Error(
            "Build bundle collection timed out and its sandbox reset could not be confirmed",
          );
        }
      } finally {
        if (handle !== undefined) clearTimeout(handle);
      }
    })();
    return fencePromise;
  };
  const wait = async <T>(
    start: () => Promise<T>,
    maximumWaitMs: number,
  ): Promise<T> => {
    if (timedOut) {
      await confirmFence();
      throw timeoutError();
    }
    if (maximumWaitMs <= 0) {
      throw new Error(
        `Build bundle collection exceeded its ${timeoutMs}ms absolute deadline before the next sandbox operation started`,
      );
    }
    const work = Promise.resolve().then(start);
    work.catch(() => {});
    let handle: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"timeout">((resolve) => {
      handle = setTimeout(() => resolve("timeout"), maximumWaitMs);
    });
    try {
      const outcome = await Promise.race([
        work.then((value) => ({ kind: "value" as const, value })),
        expired.then(() => ({ kind: "timeout" as const })),
      ]);
      if (outcome.kind === "value") return outcome.value;
      await confirmFence();
      throw timeoutError();
    } finally {
      if (handle !== undefined) clearTimeout(handle);
    }
  };
  return {
    run<T>(start: () => Promise<T>): Promise<T> {
      return wait(start, deadlineAt - now());
    },
    async cleanup(work: Promise<unknown>): Promise<void> {
      work.catch(() => {});
      if (timedOut) return;
      const immediate: {
        state: "pending" | "resolved" | "rejected";
      } = { state: "pending" };
      work.then(
        () => {
          immediate.state = "resolved";
        },
        () => {
          immediate.state = "rejected";
        },
      );
      await Promise.resolve();
      if (immediate.state === "resolved") return;
      if (immediate.state === "rejected") {
        await confirmFence();
        return;
      }
      try {
        await wait(
          () => work,
          Math.min(
            BUNDLE_COLLECTION_CLEANUP_MS,
            Math.max(0, deadlineAt - now()),
          ),
        );
      } catch (error) {
        if (timedOut) throw error;
        // The stream's ownership is uncertain until destructive reset succeeds.
        // Preserve the primary read error only after that fence is confirmed.
        await confirmFence();
      }
    },
  };
}

export async function collectWorkerBundleFromSandbox(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
  manifestPath = "build/server/wrangler.json",
  options?: ProjectWorkerBundleCollectionOptions,
): Promise<ProjectWorkerBundle> {
  if (!sandbox.readFileStream) {
    throw new Error("Sandbox does not support streamed build output reads");
  }
  const deadline = options
    ? createBundleCollectionDeadline(options)
    : undefined;
  const absoluteManifestPath = joinSandboxPath(workdir, manifestPath);
  const manifestBytes = await readSandboxFileBytes(
    sandbox,
    absoluteManifestPath,
    PROJECT_BUILD_MANIFEST_MAX_BYTES,
    undefined,
    deadline,
  );
  const manifest = parseJsonBounded(
    new TextDecoder().decode(manifestBytes),
    runtimeJsonLimits(PROJECT_BUILD_MANIFEST_MAX_BYTES),
  ) as DirectWorkerMetadata & {
    assets?: { directory?: string } | string;
    durable_objects?: { bindings?: unknown };
    kv_namespaces?: unknown;
    r2_buckets?: unknown;
    ai?: unknown;
    services?: unknown;
    main?: unknown;
    no_bundle?: unknown;
    rules?: unknown;
  };
  // Build contract: the manifest is a wrangler-valid config whose build output
  // is final (`no_bundle` semantics) — `main` names the entry module and
  // `rules` globs declare which other files upload as modules. Both producers
  // emit this: @cloudflare/vite-plugin natively, and the scaffold's
  // build-manifest.mjs. Nothing outside the declared rules is uploaded.
  if (typeof manifest.main !== "string" || !manifest.main) {
    if (typeof manifest.main_module === "string" && manifest.main_module) {
      throw new Error(
        `Build manifest ${manifestPath} uses the legacy main_module/bindings shape. ` +
          `Update scripts/build-manifest.mjs to write a wrangler-valid config: ` +
          `main: "worker.js", no_bundle: true, rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }], ` +
          `and wrangler-idiomatic vars/durable_objects/kv_namespaces/r2_buckets/ai/services instead of a bindings array.`,
      );
    }
    throw new Error(
      `Build manifest ${manifestPath} is missing a "main" entry module`,
    );
  }
  const mainModule = manifest.main.replace(/^\.\//, "");
  manifest.main_module = mainModule;
  const metadata = normalizeWorkerBundleMetadata(manifest);
  const moduleRules = parseModuleRules(manifest.rules);
  const serverRoot = dirnameSandboxPath(absoluteManifestPath);
  const listed = await listSandboxFilesBounded(sandbox, serverRoot, deadline);
  if (listed.files.length > PROJECT_BUILD_OUTPUT_MAX_ENTRIES) {
    throw new Error(
      `Build output exceeds the ${PROJECT_BUILD_OUTPUT_MAX_ENTRIES} entry limit`,
    );
  }
  const candidateFiles = listed.files
    .filter((file) => file.type === "file")
    .map((file) => {
      const absolutePath = joinSandboxPath(
        serverRoot,
        file.relativePath || file.name,
      );
      const relativePath = relativeSandboxPath(serverRoot, absolutePath);
      assertBuildOutputPath(absolutePath);
      assertBuildOutputPath(relativePath);
      const size = assertBuildOutputSize(file.size, relativePath);
      return { absolutePath, relativePath, size };
    })
    .filter(
      ({ relativePath }) =>
        Boolean(relativePath) &&
        relativePath !== basenameSandboxPath(absoluteManifestPath),
    );
  const entryFile = candidateFiles.find(
    ({ relativePath }) => relativePath === mainModule,
  );
  if (!entryFile) {
    throw new Error(
      `Build manifest ${manifestPath} names main "${mainModule}", but the build output does not contain it`,
    );
  }
  const moduleFiles: Array<{
    absolutePath: string;
    relativePath: string;
    size: number;
    contentType: string;
  }> = [{ ...entryFile, contentType: "application/javascript+module" }];
  for (const candidate of candidateFiles) {
    if (candidate.relativePath === mainModule) continue;
    const rule = moduleRules.find(({ pattern }) =>
      pattern.test(candidate.relativePath),
    );
    if (rule) moduleFiles.push({ ...candidate, contentType: rule.contentType });
  }
  assertModuleFileBounds(moduleFiles);
  const modules = await mapWithDrainedConcurrency(
    moduleFiles,
    PROJECT_BUILD_MODULE_READ_CONCURRENCY,
    PROJECT_BUILD_MODULE_READ_MAX_IN_FLIGHT_BYTES,
    ({ size }) => size,
    async ({ absolutePath, relativePath, size, contentType }) => ({
      name: relativePath,
      contentType,
      content: await readSandboxFileBytes(
        sandbox,
        absolutePath,
        PROJECT_BUILD_MODULE_MAX_FILE_BYTES,
        size,
        deadline,
      ),
    }),
  );
  modules.sort((a, b) => a.name.localeCompare(b.name));
  const rawConfigName = (manifest as { name?: unknown }).name;
  const configName =
    typeof rawConfigName === "string" && rawConfigName
      ? rawConfigName
      : undefined;
  return {
    metadata,
    modules,
    assets: await collectAssetsFromManifest(
      sandbox,
      serverRoot,
      metadata,
      deadline,
    ),
    manifestPath,
    ...(configName ? { configName } : {}),
  };
}

function assertBuildOutputPath(path: string): void {
  if (
    !path ||
    path.length > PROJECT_BUILD_OUTPUT_MAX_PATH_BYTES ||
    utf8ByteLength(path) > PROJECT_BUILD_OUTPUT_MAX_PATH_BYTES
  ) {
    throw new Error(
      `Build output path exceeds the ${PROJECT_BUILD_OUTPUT_MAX_PATH_BYTES} byte limit`,
    );
  }
}

function assertBuildOutputSize(size: unknown, path: string): number {
  if (!Number.isSafeInteger(size) || (size as number) < 0) {
    throw new Error(`Build output has an invalid listed size: ${path}`);
  }
  return size as number;
}

function assertModuleFileBounds(
  files: Array<{ relativePath: string; size: number }>,
): void {
  if (files.length > PROJECT_BUILD_MODULE_MAX_FILES) {
    throw new Error(
      `Build modules exceed the ${PROJECT_BUILD_MODULE_MAX_FILES} file limit`,
    );
  }
  let totalBytes = 0;
  for (const file of files) {
    if (file.size > PROJECT_BUILD_MODULE_MAX_FILE_BYTES) {
      throw new Error(
        `Build module ${file.relativePath} exceeds the ${PROJECT_BUILD_MODULE_MAX_FILE_BYTES} byte limit`,
      );
    }
    if (file.size > PROJECT_BUILD_MODULE_MAX_TOTAL_BYTES - totalBytes) {
      throw new Error(
        `Build modules exceed the ${PROJECT_BUILD_MODULE_MAX_TOTAL_BYTES} aggregate byte limit`,
      );
    }
    totalBytes += file.size;
  }
}

// A Durable Object namespace binding names a `class_name` that Cloudflare
// requires the worker's entry module to export by that exact name; a migration
// that creates the class needs it too. When the class isn't exported (e.g. the
// agent added the binding to wrangler.jsonc but forgot `export class Foo`, or
// misspelled it), CF rejects the upload with an opaque migration error. Catch it
// pre-upload against the bundled entry module and name the offending class.
//
// Export names are a stable module contract — esbuild preserves them verbatim
// (that's how CF resolves the binding), so scanning the bundled `main_module`
// for its exported names is reliable and can't false-positive on a genuinely
// exported class. Returns the declared class names that are NOT exported.
export function findUnexportedDurableObjectClasses(
  bundle: ProjectWorkerBundle,
): string[] {
  const declaredClasses = new Set<string>();
  for (const binding of bundle.metadata.bindings ?? []) {
    if (
      binding.type === "durable_object_namespace" &&
      typeof binding.class_name === "string"
    ) {
      declaredClasses.add(binding.class_name);
    }
  }
  if (declaredClasses.size === 0) return [];

  const entryName = bundle.metadata.main_module;
  const entry = bundle.modules.find((module) => module.name === entryName);
  // No entry module to inspect — don't block; the deploy path surfaces its own
  // error rather than us guessing.
  if (!entry) return [];

  const entryText = decodeModuleText(entry.content);
  // A star re-export (`export * from "./do.js"`) surfaces another module's named
  // exports that we can't resolve statically. Rather than risk a false positive
  // that blocks a valid deploy, skip the preflight entirely when one is present —
  // the guard is best-effort convenience; a missed check just falls through to
  // the normal deploy path.
  if (/\bexport\s+\*/.test(entryText)) return [];

  const exported = extractEsmExportNames(entryText);
  return [...declaredClasses].filter((className) => !exported.has(className));
}

function decodeModuleText(content: string | Uint8Array | ArrayBuffer): string {
  if (typeof content === "string") return content;
  return new TextDecoder().decode(
    content instanceof ArrayBuffer ? new Uint8Array(content) : content,
  );
}

// The set of names an ESM module exports, covering the forms esbuild emits:
// `export class/function/const/let/var NAME`, `export default`, and consolidated
// `export { local as PUBLIC, bare }` clauses (the PUBLIC alias is the export name).
function extractEsmExportNames(source: string): Set<string> {
  const names = new Set<string>();

  const declRe =
    /\bexport\s+(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (let match = declRe.exec(source); match; match = declRe.exec(source)) {
    names.add(match[1]!);
  }
  if (/\bexport\s+default\b/.test(source)) names.add("default");

  const clauseRe = /\bexport\s*\{([^}]*)\}/g;
  for (
    let match = clauseRe.exec(source);
    match;
    match = clauseRe.exec(source)
  ) {
    for (const rawEntry of match[1]!.split(",")) {
      const entry = rawEntry.trim();
      if (!entry) continue;
      // `local as PUBLIC` exports PUBLIC; a bare `name` exports `name`.
      const asMatch = entry.match(/\bas\s+([A-Za-z_$][\w$]*)\s*$/);
      names.add(asMatch ? asMatch[1]! : entry);
    }
  }
  return names;
}

function normalizeWorkerBundleMetadata(
  manifest: DirectWorkerMetadata & {
    durable_objects?: { bindings?: unknown };
    kv_namespaces?: unknown;
    r2_buckets?: unknown;
    ai?: unknown;
    services?: unknown;
    main?: unknown;
    no_bundle?: unknown;
    rules?: unknown;
  },
): DirectWorkerMetadata {
  const bindings = [...(manifest.bindings ?? [])];
  const addBinding = (binding: WorkerBinding) => {
    if (bindings.some((candidate) => candidate.name === binding.name)) return;
    bindings.push(binding);
  };

  const durableObjectBindings = manifest.durable_objects?.bindings;
  if (Array.isArray(durableObjectBindings)) {
    for (const binding of durableObjectBindings) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding))
        continue;
      const record = binding as Record<string, unknown>;
      if (
        typeof record.name !== "string" ||
        typeof record.class_name !== "string"
      )
        continue;
      addBinding({
        ...record,
        type: "durable_object_namespace",
        name: record.name,
        class_name: record.class_name,
      });
    }
  }

  // Wrangler's idiomatic top-level resource declarations are
  // otherwise dropped by the deploy metadata (which only reads `bindings`), so a
  // resource binding declared the normal way silently never reaches the worker and
  // env.<NAME> is undefined at runtime. Lift them into typed bindings the same
  // way durable_objects are; mapVirtualizedBindings then virtualizes them.
  // Wrangler uses `binding` for the env var name (vs `name` for DOs).
  for (const entry of asBindingArray(manifest.kv_namespaces)) {
    const name = typeof entry.binding === "string" ? entry.binding : undefined;
    if (!name) continue;
    addBinding({
      type: "kv_namespace",
      name,
      ...(typeof entry.id === "string" ? { namespace_id: entry.id } : {}),
    });
  }
  for (const entry of asBindingArray(manifest.r2_buckets)) {
    const name = typeof entry.binding === "string" ? entry.binding : undefined;
    if (!name) continue;
    addBinding({
      type: "r2_bucket",
      name,
      ...(typeof entry.bucket_name === "string"
        ? { bucket_name: entry.bucket_name }
        : {}),
    });
  }
  if (
    manifest.ai &&
    typeof manifest.ai === "object" &&
    !Array.isArray(manifest.ai)
  ) {
    const name = (manifest.ai as Record<string, unknown>).binding;
    if (typeof name === "string" && name) addBinding({ type: "ai", name });
  }
  for (const entry of asBindingArray(manifest.services)) {
    const name = typeof entry.binding === "string" ? entry.binding : undefined;
    const service =
      typeof entry.service === "string" ? entry.service : undefined;
    if (!name || !service) continue;
    addBinding({
      type: "service",
      name,
      service,
      ...(typeof entry.entrypoint === "string"
        ? { entrypoint: entry.entrypoint }
        : {}),
      ...(entry.props &&
      typeof entry.props === "object" &&
      !Array.isArray(entry.props)
        ? { props: entry.props }
        : {}),
    });
  }

  // Wrangler-style `vars` (vite-plugin manifests spread the full normalized
  // config) become plain_text bindings, exactly as wrangler uploads them.
  const vars = manifest.vars;
  if (vars && typeof vars === "object" && !Array.isArray(vars)) {
    for (const [name, value] of Object.entries(
      vars as Record<string, unknown>,
    )) {
      if (value === undefined || value === null) continue;
      addBinding(
        typeof value === "string"
          ? { type: "plain_text", name, text: value }
          : { type: "json", name, json: value },
      );
    }
  }

  // Allowlist what reaches the Cloudflare script-upload metadata. Build
  // manifests (especially vite-plugin ones, which spread the user's entire
  // normalized wrangler config) carry many keys whose config shape differs
  // from the upload API's — each one that leaks through is a user-facing 400
  // (see the migrations: [] incident). Unknown keys are dropped and logged
  // instead.
  const metadata: DirectWorkerMetadata = { main_module: manifest.main_module };
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(manifest)) {
    if (value === undefined || key === "main_module" || key === "bindings")
      continue;
    if (PASSTHROUGH_METADATA_KEYS.has(key)) {
      (metadata as Record<string, unknown>)[key] = value;
    } else if (!CONSUMED_MANIFEST_KEYS.has(key)) {
      dropped.push(key);
    }
  }
  if (bindings.length > 0) metadata.bindings = bindings;
  if (dropped.length > 0) {
    console.warn(
      "[project-worker-bundle] dropped unsupported build-manifest keys from deploy metadata",
      {
        keys: dropped.sort(),
      },
    );
  }
  return metadata;
}

/** Keys forwarded verbatim to the script-upload metadata. */
const PASSTHROUGH_METADATA_KEYS = new Set([
  "compatibility_date",
  "compatibility_flags",
  "migrations",
  "assets",
  "tail_consumers",
  "placement",
  "limits",
  "observability",
  "logpush",
  "usage_model",
  "config_path",
]);

/** Keys consumed by this normalizer (lifted into bindings or build-tool-only). */
const CONSUMED_MANIFEST_KEYS = new Set([
  "durable_objects",
  "kv_namespaces",
  "r2_buckets",
  "ai",
  "services",
  "vars",
  "main",
  "no_bundle",
  "rules",
]);

function asBindingArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
  );
}

// Materialize a deliberately small aggregate while collection still owns the
// sandbox. Returned handles never retain sandbox capability, so deploy retries
// cannot overlap an abandoned read or reset a newer container generation.
async function collectAssetsFromManifest(
  sandbox: ProjectBuildSandboxLike,
  serverRoot: string,
  manifest: DirectWorkerMetadata & { assets?: { directory?: string } | string },
  deadline?: BundleCollectionDeadline,
): Promise<DirectDeployAsset[]> {
  const rawDirectory =
    typeof manifest.assets === "string"
      ? manifest.assets
      : typeof manifest.assets?.directory === "string"
        ? manifest.assets.directory
        : "";
  if (!rawDirectory) return [];
  assertBuildOutputPath(rawDirectory);
  const assetsRoot = joinSandboxPath(serverRoot, rawDirectory);
  const listed = await listSandboxFilesBounded(sandbox, assetsRoot, deadline);
  if (listed.files.length > PROJECT_BUILD_OUTPUT_MAX_ENTRIES) {
    throw new Error(
      `Build assets exceed the ${PROJECT_BUILD_OUTPUT_MAX_ENTRIES} entry limit`,
    );
  }
  let totalBytes = 0;
  const admitted = listed.files
    .filter((file) => file.type === "file")
    .map((file) => {
      const absolutePath = joinSandboxPath(
        assetsRoot,
        file.relativePath || file.name,
      );
      const relativePath = relativeSandboxPath(assetsRoot, absolutePath);
      assertBuildOutputPath(absolutePath);
      assertBuildOutputPath(relativePath);
      const size = assertBuildOutputSize(file.size, relativePath);
      if (size > PROJECT_BUILD_ASSET_MAX_BYTES) {
        throw new Error(
          `Build asset ${relativePath} exceeds the ${PROJECT_BUILD_ASSET_MAX_BYTES} byte limit`,
        );
      }
      if (size > PROJECT_BUILD_ASSET_MAX_TOTAL_BYTES - totalBytes) {
        throw new Error(
          `Build assets exceed the ${PROJECT_BUILD_ASSET_MAX_TOTAL_BYTES} aggregate byte limit`,
        );
      }
      totalBytes += size;
      return {
        absolutePath,
        relativePath,
        size,
      };
    })
    .filter(({ relativePath }) => Boolean(relativePath));
  const assets = await mapWithDrainedConcurrency(
    admitted,
    PROJECT_BUILD_ASSET_READ_CONCURRENCY,
    PROJECT_BUILD_ASSET_READ_MAX_IN_FLIGHT_BYTES,
    ({ size }) => size,
    async ({ absolutePath, relativePath, size }) => {
      const content = await readSandboxFileBytes(
        sandbox,
        absolutePath,
        PROJECT_BUILD_ASSET_MAX_BYTES,
        size,
        deadline,
      );
      return {
        path: relativePath,
        contentType: contentTypeForAsset(relativePath),
        size,
        read: async () => content,
      } satisfies DirectDeployAsset;
    },
  );
  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Small lane pool that stops admitting work after the first failure but waits
 * for every already-started stream to settle. The deploy retry ladder can never
 * overlap an abandoned sandbox read, while latency is not multiplied by the
 * complete asset count.
 */
async function mapWithDrainedConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  maximumWeight: number,
  weightOf: (item: T, index: number) => number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const laneLimit = Math.max(1, Math.floor(concurrency));
  const weightLimit = Math.max(1, Math.floor(maximumWeight));
  const weights = items.map((item, index) => {
    const weight = Math.max(1, Math.floor(weightOf(item, index)));
    if (!Number.isSafeInteger(weight) || weight > weightLimit) {
      throw new Error("Bounded concurrency item exceeds its weight budget");
    }
    return weight;
  });
  const pending = items.map((_item, index) => index);
  const inFlight = new Set<Promise<void>>();
  const results = Array.from<R>({ length: items.length });
  let activeWeight = 0;
  let stopped = false;
  let firstError: unknown;

  while (!stopped && pending.length > 0) {
    for (
      let cursor = 0;
      cursor < pending.length && inFlight.size < laneLimit;
    ) {
      const index = pending[cursor]!;
      const weight = weights[index]!;
      if (weight > weightLimit - activeWeight) {
        cursor += 1;
        continue;
      }
      pending.splice(cursor, 1);
      activeWeight += weight;
      let task!: Promise<void>;
      task = Promise.resolve()
        .then(() => mapper(items[index]!, index))
        .then(
          (value) => {
            results[index] = value;
          },
          (error) => {
            if (!stopped) firstError = error;
            stopped = true;
          },
        )
        .finally(() => {
          activeWeight -= weight;
          inFlight.delete(task);
        });
      inFlight.add(task);
    }
    if (inFlight.size > 0) await Promise.race(inFlight);
  }
  if (inFlight.size > 0) await Promise.allSettled(inFlight);
  if (stopped) throw firstError;
  return results;
}

async function listSandboxFilesBounded(
  sandbox: ProjectBuildSandboxLike,
  root: string,
  deadline?: BundleCollectionDeadline,
): Promise<{
  files: Array<{
    name: string;
    type: "file" | "directory";
    relativePath: string;
    size: number;
  }>;
}> {
  const execution = deadline
    ? await deadline.run(() =>
        sandbox.exec(
          `bun -e ${shellQuoteSandboxArgument(BOUNDED_SANDBOX_LIST_SCRIPT)}`,
          {
            env: { CAMELAI_BOUNDED_LIST_ROOT: root },
            timeout: SANDBOX_LIST_TIMEOUT_MS,
          },
        ),
      )
    : await sandbox.exec(
        `bun -e ${shellQuoteSandboxArgument(BOUNDED_SANDBOX_LIST_SCRIPT)}`,
        {
          env: { CAMELAI_BOUNDED_LIST_ROOT: root },
          timeout: SANDBOX_LIST_TIMEOUT_MS,
        },
      );
  const stdout = execution.stdout ?? "";
  if (!stdout || utf8ByteLength(stdout) > SANDBOX_LIST_MAX_STDOUT_BYTES) {
    throw new Error("Bounded sandbox listing returned invalid output");
  }
  let parsed: unknown;
  try {
    parsed = parseJsonBounded(stdout, {
      maxDepth: 6,
      maxTokens: 100_000,
      maxNodes: 50_000,
      maxEntries: 25_000,
      maxStrings: 25_000,
      maxStringCodeUnits: SANDBOX_LIST_MAX_STDOUT_BYTES,
    });
  } catch {
    throw new Error("Bounded sandbox listing returned invalid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Bounded sandbox listing returned an invalid result");
  }
  const result = parsed as {
    success?: unknown;
    error?: unknown;
    files?: unknown;
  };
  if (result.success !== true) {
    const error =
      typeof result.error === "string" && result.error.length <= 512
        ? result.error
        : "listing failed";
    throw new Error(`Bounded sandbox listing failed: ${error}`);
  }
  if (
    !Array.isArray(result.files) ||
    result.files.length > PROJECT_BUILD_OUTPUT_MAX_ENTRIES
  ) {
    throw new Error("Bounded sandbox listing returned too many entries");
  }
  const files = result.files.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Bounded sandbox listing returned an invalid entry");
    }
    const entry = value as {
      name?: unknown;
      type?: unknown;
      relativePath?: unknown;
      size?: unknown;
    };
    if (
      typeof entry.name !== "string" ||
      (entry.type !== "file" && entry.type !== "directory") ||
      typeof entry.relativePath !== "string" ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0
    ) {
      throw new Error("Bounded sandbox listing returned an invalid entry");
    }
    return {
      name: entry.name,
      type: entry.type as "file" | "directory",
      relativePath: entry.relativePath,
      size: entry.size as number,
    };
  });
  return { files };
}

function shellQuoteSandboxArgument(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export async function readSandboxFileBytes(
  sandbox: ProjectBuildSandboxLike,
  path: string,
  maximumBytes: number,
  expectedSize?: number,
  deadline?: BundleCollectionDeadline,
): Promise<Uint8Array> {
  if (!sandbox.readFileStream) {
    throw new Error("Sandbox does not support streamed file reads");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new Error("Sandbox file byte limit is invalid");
  }
  if (
    expectedSize !== undefined &&
    (!Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > maximumBytes)
  ) {
    throw new Error(
      `Sandbox file ${path} exceeds the ${maximumBytes} byte limit`,
    );
  }

  const raw = deadline
    ? await deadline.run(() => sandbox.readFileStream!(path))
    : await sandbox.readFileStream(path);
  const maximumWireBytes = maximumBytes * 2 + 64 * 1024;
  const boundedWire = boundedSandboxWireStream(raw, maximumWireBytes);
  const generator = streamFile(boundedWire.stream);
  const output = new Uint8Array(expectedSize ?? maximumBytes);
  const encoder = new TextEncoder();
  let offset = 0;
  let completed = false;
  try {
    let result = deadline
      ? await deadline.run(() => generator.next())
      : await generator.next();
    while (!result.done) {
      const chunk = result.value;
      if (typeof chunk === "string") {
        const chunkBytes = utf8ByteLength(chunk);
        if (chunkBytes > output.byteLength - offset) {
          throw new Error(
            `Sandbox file ${path} exceeds the ${maximumBytes} byte limit`,
          );
        }
        const encoded = encoder.encodeInto(chunk, output.subarray(offset));
        if (encoded.read !== chunk.length || encoded.written !== chunkBytes) {
          throw new Error(`Sandbox file ${path} returned invalid UTF-8 data`);
        }
        offset += encoded.written;
      } else {
        if (chunk.byteLength > output.byteLength - offset) {
          throw new Error(
            `Sandbox file ${path} exceeds the ${maximumBytes} byte limit`,
          );
        }
        output.set(chunk, offset);
        offset += chunk.byteLength;
      }
      result = deadline
        ? await deadline.run(() => generator.next())
        : await generator.next();
    }
    const metadataSize = result.value?.size;
    if (
      !Number.isSafeInteger(metadataSize) ||
      metadataSize < 0 ||
      metadataSize > maximumBytes ||
      metadataSize !== offset ||
      (expectedSize !== undefined && metadataSize !== expectedSize)
    ) {
      throw new Error(`Sandbox file ${path} returned an invalid byte size`);
    }
    const cancellation = boundedWire.confirmCancellation();
    if (deadline) {
      await deadline.cleanup(cancellation);
    } else {
      cancellation.catch(() => {});
      let handle: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          cancellation,
          new Promise<void>((resolve) => {
            handle = setTimeout(resolve, BUNDLE_COLLECTION_CLEANUP_MS);
          }),
        ]);
      } catch {
        // Standalone callers have no destructive reset callback.
      } finally {
        if (handle !== undefined) clearTimeout(handle);
      }
    }
    completed = true;
    return offset === output.byteLength ? output : output.slice(0, offset);
  } finally {
    if (!completed) {
      const cleanup = generator
        .return(undefined as never)
        .then(() => boundedWire.confirmCancellation());
      if (deadline) await deadline.cleanup(cleanup);
      else {
        cleanup.catch(() => {});
        let handle: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            cleanup,
            new Promise<void>((resolve) => {
              handle = setTimeout(resolve, BUNDLE_COLLECTION_CLEANUP_MS);
            }),
          ]);
        } catch {
          // Without an owning reset callback this exported helper can only make
          // cancellation best effort; collection always supplies a deadline.
        } finally {
          if (handle !== undefined) clearTimeout(handle);
        }
      }
    }
  }
}

function boundedSandboxWireStream(
  source: ReadableStream<Uint8Array>,
  maximumBytes: number,
): {
  stream: ReadableStream<Uint8Array>;
  confirmCancellation(): Promise<void>;
} {
  const reader = source.getReader();
  let received = 0;
  let chunks = 0;
  let cancellation: Promise<void> | undefined;
  const cancelSource = (reason?: unknown): Promise<void> => {
    if (!cancellation) {
      cancellation = reader.cancel(reason);
      cancellation.catch(() => {});
    }
    return cancellation;
  };
  const fail = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    const error = new Error(
      `Sandbox file wire stream exceeds its finite transport limits`,
    );
    void cancelSource(error);
    controller.error(error);
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const item = await reader.read();
      if (item.done) {
        controller.close();
        return;
      }
      const chunk = item.value;
      chunks += 1;
      if (chunks > SANDBOX_FILE_MAX_WIRE_CHUNKS) {
        fail(controller);
        return;
      }
      if (chunk.byteLength > maximumBytes - received) {
        fail(controller);
        return;
      }
      received += chunk.byteLength;
      controller.enqueue(chunk);
    },
    cancel(reason) {
      return cancelSource(reason);
    },
  });
  return {
    stream,
    confirmCancellation: () => cancellation ?? Promise.resolve(),
  };
}

/** Wrangler module rule types → Cloudflare upload content types. */
const MODULE_RULE_CONTENT_TYPES: Record<string, string> = {
  ESModule: "application/javascript+module",
  CommonJS: "application/javascript",
  CompiledWasm: "application/wasm",
  Text: "text/plain",
  Data: "application/octet-stream",
};

/** The vite-plugin's emitted rules; also the contract default when absent. */
const DEFAULT_MODULE_RULES = [
  { type: "ESModule", globs: ["**/*.js", "**/*.mjs"] },
];

function parseModuleRules(
  rules: unknown,
): Array<{ pattern: RegExp; contentType: string }> {
  const source =
    Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_MODULE_RULES;
  if (source.length > PROJECT_BUILD_MODULE_MAX_RULES) {
    throw new Error(
      `Build manifest exceeds the ${PROJECT_BUILD_MODULE_MAX_RULES} module rule limit`,
    );
  }
  const parsed: Array<{ pattern: RegExp; contentType: string }> = [];
  let globBytes = 0;
  for (const rule of source) {
    if (!rule || typeof rule !== "object") continue;
    const { type, globs } = rule as { type?: unknown; globs?: unknown };
    const contentType =
      typeof type === "string" ? MODULE_RULE_CONTENT_TYPES[type] : undefined;
    if (!contentType || !Array.isArray(globs)) continue;
    for (const glob of globs) {
      if (typeof glob !== "string" || !glob) continue;
      if (parsed.length >= PROJECT_BUILD_MODULE_MAX_RULES) {
        throw new Error(
          `Build manifest exceeds the ${PROJECT_BUILD_MODULE_MAX_RULES} module glob limit`,
        );
      }
      const bytes = utf8ByteLength(glob);
      if (
        bytes > PROJECT_BUILD_OUTPUT_MAX_PATH_BYTES ||
        bytes > PROJECT_BUILD_MODULE_MAX_GLOB_BYTES - globBytes
      ) {
        throw new Error("Build manifest module globs exceed their byte limits");
      }
      globBytes += bytes;
      parsed.push({ pattern: globToRegExp(glob), contentType });
    }
  }
  return parsed;
}

/** Minimal wrangler-style glob: `**` crosses directories, `*` does not. */
function globToRegExp(glob: string): RegExp {
  let pattern = "";
  let index = 0;
  while (index < glob.length) {
    const char = glob[index]!;
    if (char === "*") {
      if (glob[index + 1] === "*") {
        if (glob[index + 2] === "/") {
          pattern += "(?:.*/)?";
          index += 3;
        } else {
          pattern += ".*";
          index += 2;
        }
      } else {
        pattern += "[^/]*";
        index += 1;
      }
      continue;
    }
    pattern += char.replace(/[.+^${}()|[\]\\?]/g, "\\$&");
    index += 1;
  }
  return new RegExp(`^${pattern}$`);
}

export function contentTypeForAsset(path: string): string | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".html")) return "text/html; charset=utf-8";
  if (lower.endsWith(".css")) return "text/css; charset=utf-8";
  if (lower.endsWith(".js") || lower.endsWith(".mjs"))
    return "application/javascript; charset=utf-8";
  if (lower.endsWith(".json")) return "application/json";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".ico")) return "image/x-icon";
  if (lower.endsWith(".wasm")) return "application/wasm";
  return undefined;
}

function joinSandboxPath(root: string, child: string): string {
  const cleanRoot = root.replace(/\/+$/g, "") || "/";
  const cleanChild = child.replace(/^\/+/, "");
  const joined =
    cleanRoot === "/" ? `/${cleanChild}` : `${cleanRoot}/${cleanChild}`;
  const parts: string[] = [];
  for (const part of joined.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `/${parts.join("/")}`;
}

function dirnameSandboxPath(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function basenameSandboxPath(path: string): string {
  return path.split("/").filter(Boolean).pop() || "";
}

function relativeSandboxPath(root: string, path: string): string {
  const cleanRoot = root.replace(/\/+$/g, "") || "/";
  const cleanPath = path.replace(/\\/g, "/");
  if (cleanRoot === "/") return cleanPath.replace(/^\/+/, "");
  if (cleanPath === cleanRoot) return "";
  return cleanPath.startsWith(`${cleanRoot}/`)
    ? cleanPath.slice(cleanRoot.length + 1)
    : cleanPath.replace(/^\/+/, "");
}
