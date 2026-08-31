import { collectFile } from "@cloudflare/sandbox";
import type { DirectDeployAsset, DirectWorkerMetadata, DirectWorkerModule } from "./direct-dispatch-deploy.js";
import type { WorkerBinding } from "./cf-api-proxy.js";
import { mapWithConcurrency } from "../../../src/lib/map-with-concurrency";

const BUNDLE_READ_CONCURRENCY = 4;

export interface ProjectBuildSandboxLike {
  // Matches @cloudflare/sandbox ExecOptions: the execution bound is `timeout`
  // (ms). Do not add a `timeoutMs` alias — the SDK silently ignores it.
  exec(command: string, options?: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number }): Promise<{
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
  probeShell?(command: string, options?: { cwd?: string; timeout?: number }): Promise<{
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
  readFile?(path: string, options?: { encoding?: "base64" | "utf8" }): Promise<{ content: string }>;
  readFileStream?(path: string): Promise<ReadableStream<Uint8Array>>;
  listFiles?(path: string, options?: { recursive?: boolean; includeHidden?: boolean }): Promise<{ files: Array<{
    name: string;
    type: "file" | "directory";
    relativePath?: string;
    absolutePath?: string;
    size?: number;
  }> }>;
}

export interface ProjectWorkerBundle {
  metadata: DirectWorkerMetadata;
  modules: DirectWorkerModule[];
  // Assets are lazy handles, not buffered bytes: collection lists them (with
  // sizes) and the deploy path reads each on demand in bounded batches, so an
  // asset-heavy project never materializes every asset in the isolate at once.
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

export async function collectWorkerBundleFromSandbox(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
  manifestPath = "build/server/wrangler.json",
): Promise<ProjectWorkerBundle> {
  if (!sandbox.readFileStream || !sandbox.listFiles) {
    throw new Error("Sandbox does not support streamed build output reads");
  }
  const absoluteManifestPath = joinSandboxPath(workdir, manifestPath);
  const manifestBytes = await readSandboxFileBytes(sandbox, absoluteManifestPath);
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as DirectWorkerMetadata & {
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
    throw new Error(`Build manifest ${manifestPath} is missing a "main" entry module`);
  }
  const mainModule = manifest.main.replace(/^\.\//, "");
  manifest.main_module = mainModule;
  const metadata = normalizeWorkerBundleMetadata(manifest);
  const moduleRules = parseModuleRules(manifest.rules);
  const serverRoot = dirnameSandboxPath(absoluteManifestPath);
  const listed = await sandbox.listFiles(serverRoot, { recursive: true, includeHidden: true });
  const candidateFiles = listed.files.filter((file) => file.type === "file").map((file) => {
    const absolutePath = file.absolutePath || joinSandboxPath(serverRoot, file.relativePath || file.name);
    const relativePath = relativeSandboxPath(serverRoot, absolutePath);
    return { absolutePath, relativePath };
  }).filter(({ relativePath }) => Boolean(relativePath) && relativePath !== basenameSandboxPath(absoluteManifestPath));
  const entryFile = candidateFiles.find(({ relativePath }) => relativePath === mainModule);
  if (!entryFile) {
    throw new Error(`Build manifest ${manifestPath} names main "${mainModule}", but the build output does not contain it`);
  }
  const moduleFiles: Array<{ absolutePath: string; relativePath: string; contentType: string }> = [
    { ...entryFile, contentType: "application/javascript+module" },
  ];
  for (const candidate of candidateFiles) {
    if (candidate.relativePath === mainModule) continue;
    const rule = moduleRules.find(({ pattern }) => pattern.test(candidate.relativePath));
    if (rule) moduleFiles.push({ ...candidate, contentType: rule.contentType });
  }
  const modules = await mapWithConcurrency(moduleFiles, BUNDLE_READ_CONCURRENCY, async ({ absolutePath, relativePath, contentType }) => ({
      name: relativePath,
      contentType,
      content: await readSandboxFileBytes(sandbox, absolutePath),
    }));
  modules.sort((a, b) => a.name.localeCompare(b.name));
  const rawConfigName = (manifest as { name?: unknown }).name;
  const configName = typeof rawConfigName === "string" && rawConfigName ? rawConfigName : undefined;
  return {
    metadata,
    modules,
    assets: await collectAssetsFromManifest(sandbox, serverRoot, metadata),
    manifestPath,
    ...(configName ? { configName } : {}),
  };
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
export function findUnexportedDurableObjectClasses(bundle: ProjectWorkerBundle): string[] {
  const declaredClasses = new Set<string>();
  for (const binding of bundle.metadata.bindings ?? []) {
    if (binding.type === "durable_object_namespace" && typeof binding.class_name === "string") {
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
  return new TextDecoder().decode(content instanceof ArrayBuffer ? new Uint8Array(content) : content);
}

// The set of names an ESM module exports, covering the forms esbuild emits:
// `export class/function/const/let/var NAME`, `export default`, and consolidated
// `export { local as PUBLIC, bare }` clauses (the PUBLIC alias is the export name).
function extractEsmExportNames(source: string): Set<string> {
  const names = new Set<string>();

  const declRe = /\bexport\s+(?:async\s+)?(?:class|function\*?|const|let|var)\s+([A-Za-z_$][\w$]*)/g;
  for (let match = declRe.exec(source); match; match = declRe.exec(source)) {
    names.add(match[1]!);
  }
  if (/\bexport\s+default\b/.test(source)) names.add("default");

  const clauseRe = /\bexport\s*\{([^}]*)\}/g;
  for (let match = clauseRe.exec(source); match; match = clauseRe.exec(source)) {
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
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
      const record = binding as Record<string, unknown>;
      if (typeof record.name !== "string" || typeof record.class_name !== "string") continue;
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
      ...(typeof entry.bucket_name === "string" ? { bucket_name: entry.bucket_name } : {}),
    });
  }
  if (manifest.ai && typeof manifest.ai === "object" && !Array.isArray(manifest.ai)) {
    const name = (manifest.ai as Record<string, unknown>).binding;
    if (typeof name === "string" && name) addBinding({ type: "ai", name });
  }
  for (const entry of asBindingArray(manifest.services)) {
    const name = typeof entry.binding === "string" ? entry.binding : undefined;
    const service = typeof entry.service === "string" ? entry.service : undefined;
    if (!name || !service) continue;
    addBinding({
      type: "service",
      name,
      service,
      ...(typeof entry.entrypoint === "string" ? { entrypoint: entry.entrypoint } : {}),
      ...(entry.props && typeof entry.props === "object" && !Array.isArray(entry.props)
        ? { props: entry.props }
        : {}),
    });
  }

  // Wrangler-style `vars` (vite-plugin manifests spread the full normalized
  // config) become plain_text bindings, exactly as wrangler uploads them.
  const vars = manifest.vars;
  if (vars && typeof vars === "object" && !Array.isArray(vars)) {
    for (const [name, value] of Object.entries(vars as Record<string, unknown>)) {
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
    if (value === undefined || key === "main_module" || key === "bindings") continue;
    if (PASSTHROUGH_METADATA_KEYS.has(key)) {
      (metadata as Record<string, unknown>)[key] = value;
    } else if (!CONSUMED_MANIFEST_KEYS.has(key)) {
      dropped.push(key);
    }
  }
  if (bindings.length > 0) metadata.bindings = bindings;
  if (dropped.length > 0) {
    console.warn("[project-worker-bundle] dropped unsupported build-manifest keys from deploy metadata", {
      keys: dropped.sort(),
    });
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

// List the build's client assets as lazy handles WITHOUT reading their bytes.
// Asset-heavy projects (game textures/models, media) can be far larger than the
// deploy isolate's 128 MB limit, so bytes are only ever read on demand by the
// deploy path, one bounded batch at a time. Each handle's `read()` fetches the
// file from the build sandbox when the deploy needs it.
async function collectAssetsFromManifest(
  sandbox: ProjectBuildSandboxLike,
  serverRoot: string,
  manifest: DirectWorkerMetadata & { assets?: { directory?: string } | string },
): Promise<DirectDeployAsset[]> {
  const rawDirectory = typeof manifest.assets === "string"
    ? manifest.assets
    : typeof manifest.assets?.directory === "string"
      ? manifest.assets.directory
      : "";
  if (!rawDirectory) return [];
  if (!sandbox.listFiles) throw new Error("Sandbox does not support file listing");
  const assetsRoot = joinSandboxPath(serverRoot, rawDirectory);
  const listed = await sandbox.listFiles(assetsRoot, { recursive: true, includeHidden: true });
  const assets = listed.files.filter((file) => file.type === "file").map((file) => {
    const absolutePath = file.absolutePath || joinSandboxPath(assetsRoot, file.relativePath || file.name);
    const relativePath = relativeSandboxPath(assetsRoot, absolutePath);
    return { absolutePath, relativePath, size: file.size ?? 0 };
  }).filter(({ relativePath }) => Boolean(relativePath)).map(({ absolutePath, relativePath, size }) => ({
    path: relativePath,
    contentType: contentTypeForAsset(relativePath),
    size,
    read: () => readSandboxFileBytes(sandbox, absolutePath),
  }));
  return assets.sort((a, b) => a.path.localeCompare(b.path));
}

async function readSandboxFileBytes(sandbox: ProjectBuildSandboxLike, path: string): Promise<Uint8Array> {
  if (!sandbox.readFileStream) throw new Error("Sandbox does not support streamed file reads");
  const { content } = await collectFile(await sandbox.readFileStream(path));
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
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
const DEFAULT_MODULE_RULES = [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }];

function parseModuleRules(rules: unknown): Array<{ pattern: RegExp; contentType: string }> {
  const source = Array.isArray(rules) && rules.length > 0 ? rules : DEFAULT_MODULE_RULES;
  const parsed: Array<{ pattern: RegExp; contentType: string }> = [];
  for (const rule of source) {
    if (!rule || typeof rule !== "object") continue;
    const { type, globs } = rule as { type?: unknown; globs?: unknown };
    const contentType = typeof type === "string" ? MODULE_RULE_CONTENT_TYPES[type] : undefined;
    if (!contentType || !Array.isArray(globs)) continue;
    for (const glob of globs) {
      if (typeof glob !== "string" || !glob) continue;
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
  if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "application/javascript; charset=utf-8";
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
  const joined = cleanRoot === "/" ? `/${cleanChild}` : `${cleanRoot}/${cleanChild}`;
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
  return cleanPath.startsWith(`${cleanRoot}/`) ? cleanPath.slice(cleanRoot.length + 1) : cleanPath.replace(/^\/+/, "");
}
