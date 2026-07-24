import { WorkerEntrypoint } from "cloudflare:workers";

import { getWorkspaceR2Prefix } from "../../../src/lib/workspace-r2-paths";
import { ANALYSIS_CONNECTIONS_HOST, type AnalysisConnectionsParams } from "./analysis-sandbox.js";
import { listConnections, type ConnectionsRuntimeEnv } from "./connections-runtime.js";
import { annotateWarehouseConnections, withWarehouseParams, type WarehouseConnection } from "./warehouse-service.js";
import { warehouseWorkspacePrefix } from "./warehouse-export.js";
import { ProjectFilesystemClient, type WorkspaceFileStoreLike } from "./workspace-filesystem-do.js";

/**
 * Unified analysis compute service — the successor to (and absorption of)
 * WarehouseService.
 *
 * Runs on one warm AnalysisSandbox container per workspace (see analysis-sandbox.ts).
 * Provides the stateless data-analysis surface that used to require a persistent
 * project VM:
 *   - runNotebook: execute + validate a project notebook, persist changed files back
 *   - exec:        ad-hoc shell in a project working dir
 *   - runCode:     Python string (warehouse-compatible; DuckDB over mounted exports)
 *   - addDependency: `uv add`, persist pyproject.toml + uv.lock back
 *   - listConnections: exportable-connection catalog (same as the warehouse)
 *
 * Truth lives in the project filesystem (WorkspaceFilesystemDO, DO+R2); the
 * container is a disposable cache. Files are materialized in before a run and the
 * changed set is persisted out after — a content-addressed diff, size-guarded.
 * See plans/stateless-data-analysis-architecture.md.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Where materialized project trees live in the container (persisted warm). */
export const ANALYSIS_PROJECT_ROOT = "/projects";
/** Ephemeral scratch root for no-project runs; never persisted. */
export const ANALYSIS_SCRATCH_ROOT = "/scratch";
/** R2 binding names the container's s3fs mounts route to. */
export const ANALYSIS_EXPORT_BUCKET_BINDING = "WAREHOUSE_EXPORT_BUCKET";
export const ANALYSIS_UPLOADS_BUCKET_BINDING = "R2_BUCKET";
/**
 * Where workspace uploads mount inside the container. The agent references
 * uploads as `uploads/<name>` (R2-relative), so the in-container path is that
 * same reference with a leading slash — the raw `<org>/<ws>/user-uploads` R2
 * prefix is never shown to the agent and can't be derived inside the container.
 */
export const ANALYSIS_UPLOADS_MOUNT_PATH = "/uploads";
/**
 * Where workspace outputs mount inside the container, writable. This is how a
 * run hands a generated file back to the user: anything written to
 * `/outputs/<name>` is the `outputs/<name>` R2 reference the file tools read
 * and the chat links as `/api/workspaces/<id>/outputs/<name>`.
 *
 * Without it a generated binary was effectively trapped. Production agents hit
 * this repeatedly on "export this to Excel": the file existed in the sandbox
 * and every route out was a dead end — `shutil` to a project path (not mounted),
 * base64 through the text-only `write` tool (corrupts), and finally deploying a
 * whole Worker just to serve one spreadsheet.
 */
export const ANALYSIS_OUTPUTS_MOUNT_PATH = "/outputs";
/** Files larger than this are NOT auto-persisted back to the project FS. */
export const ANALYSIS_MAX_PERSIST_BYTES = 25 * 1024 * 1024;
/**
 * Where the baked `camelai` helper package lives (analysis-sandbox.Dockerfile
 * COPYs it there and sets the same PYTHONPATH as an image ENV). Also set
 * per-run so helper importability never depends on how the container server
 * propagates image ENV to exec'd processes.
 */
export const ANALYSIS_PYTHONPATH = "/opt/camelai-python";
const DEFAULT_NOTEBOOK_TIMEOUT_MS = 300_000;
const MAX_NOTEBOOK_TIMEOUT_MS = 900_000;
const DEFAULT_EXEC_TIMEOUT_MS = 300_000;
const DEFAULT_DEP_TIMEOUT_MS = 300_000;

async function r2PrefixHasObjects(bucket: R2Bucket, prefix: string): Promise<boolean> {
  const normalizedPrefix = prefix.replace(/\/+$/, "");
  const listed = await bucket.list({ prefix: `${normalizedPrefix}/`, limit: 1 });
  return listed.objects.length > 0;
}

// ---------------------------------------------------------------------------
// Sandbox interface (minimal, for testability)
// ---------------------------------------------------------------------------

export interface AnalysisSandboxLike {
  exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string | undefined>; timeout?: number },
  ): Promise<{ success?: boolean; stdout?: string; stderr?: string; exitCode?: number }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  writeFile(path: string, content: string, options?: { encoding?: "base64" | "utf8" }): Promise<unknown>;
  readFile(path: string, options?: { encoding?: "base64" | "utf8" }): Promise<{ content: string }>;
}

/** The full DO-RPC stub surface the service drives (custom AnalysisSandbox methods). */
export type AnalysisSandboxStub = AnalysisSandboxLike & {
  ensureMounted(
    bucketBinding: string,
    prefix: string,
    mountPath?: string,
    options?: { readOnly?: boolean },
  ): Promise<void>;
  ensureConnectionsRpc(params: AnalysisConnectionsParams): Promise<void>;
  sealAppEgress(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Result shapes
// ---------------------------------------------------------------------------

export interface AnalysisNotebookResult {
  ok: boolean;
  executed: boolean;
  validation: { clean: boolean; issues: string[] };
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles: string[];
  removedFiles: string[];
  skippedOversize: string[];
  durationMs: number;
  error?: string;
}

export interface AnalysisExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  changedFiles: string[];
  removedFiles: string[];
  skippedOversize: string[];
  durationMs: number;
  error?: string;
}

export interface AnalysisDependencyResult {
  ok: boolean;
  packages: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  pyprojectPersisted: boolean;
  lockPersisted: boolean;
  durationMs: number;
  error?: string;
}

export interface AnalysisRunCodeResult {
  ok: boolean;
  stdout?: string;
  stderr?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for tests)
// ---------------------------------------------------------------------------

/** A materialized source file, path relative to the project root. */
export interface AnalysisSourceFile {
  path: string;
  bytes: Uint8Array;
}

/**
 * Derived/ephemeral paths that are never materialized in or persisted out. The
 * venv is reconstituted, caches are container-local, notebook checkpoints are
 * junk, and the git/node stores don't belong in a project source tree.
 */
export function shouldIgnoreAnalysisPath(path: string): boolean {
  const parts = path.split("/").filter(Boolean);
  return parts.some(
    (part) =>
      part === ".venv" ||
      part === "venv" ||
      part === "__pycache__" ||
      part === ".ipynb_checkpoints" ||
      part === ".cache" ||
      part === ".uv-cache" ||
      part === "node_modules" ||
      part === ".git" ||
      part === ".pytest_cache" ||
      part === ".mypy_cache",
  );
}

export function normalizeAnalysisRelPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

/**
 * Parse the `sha256sum` output of the container's post-run tree into a
 * path → hash map. sha256sum prints `<64hex>  <path>` (two spaces, path may start
 * `./`). Ignored paths are dropped so they never count as changes.
 */
export function parseSha256Manifest(stdout: string): Map<string, string> {
  const manifest = new Map<string, string>();
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (!line) continue;
    const match = /^([0-9a-f]{64})\s+(.+)$/i.exec(line);
    if (!match) continue;
    const rel = normalizeAnalysisRelPath(match[2]);
    if (!rel || shouldIgnoreAnalysisPath(rel)) continue;
    manifest.set(rel, match[1].toLowerCase());
  }
  return manifest;
}

/**
 * Content-addressed diff of two path→hash manifests. `changed` = present in
 * `next` with a different (or new) hash vs `before`; `removed` = present in
 * `before` but gone from `next`.
 */
export function diffManifests(
  before: Map<string, string>,
  next: Map<string, string>,
): { changed: string[]; removed: string[] } {
  const changed: string[] = [];
  for (const [path, hash] of next) {
    if (before.get(path) !== hash) changed.push(path);
  }
  const removed: string[] = [];
  for (const path of before.keys()) {
    if (!next.has(path)) removed.push(path);
  }
  return { changed: changed.sort(), removed: removed.sort() };
}

/** SHA-256 hex of bytes, matching `sha256sum` output. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Inline caps for notebook run outputs, applied at the TOOL layer (see
 * clampAnalysisRunOutputs in code-mode-tools.ts), keeping the TAIL: nbconvert
 * writes the failing cell's source and the Python traceback at the END of
 * stderr, after progress noise, while the model-side tool-result cap truncates
 * head-first over the whole JSON result. The service itself returns FULL
 * stdout/stderr so the tool layer can spill the untruncated log to R2 as the
 * escape hatch before clamping.
 */
export const ANALYSIS_NOTEBOOK_STDOUT_MAX_CHARS = 8_000;
export const ANALYSIS_NOTEBOOK_STDERR_MAX_CHARS = 20_000;

/** Clamp text to its last `maxChars` characters, marking what was dropped. */
export function clampOutputTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `[... ${omitted} earlier characters truncated ...]\n${text.slice(-maxChars)}`;
}

/**
 * Extract the Python traceback from nbconvert stderr, so the run's `error`
 * field leads with the actual exception instead of whatever nbconvert printed
 * first. Matches the LAST traceback (nested/chained failures end with the one
 * that killed the run) and returns it tail-clamped.
 */
export function extractNotebookTraceback(stderr: string): string | undefined {
  const markers = ["Traceback (most recent call last)", "CellExecutionError"];
  let start = -1;
  for (const marker of markers) {
    const index = stderr.lastIndexOf(marker);
    if (index >= 0 && (start === -1 || index < start)) {
      // Prefer the earliest marker of the final error block so the cell
      // context nbconvert prints between the two markers is retained.
      start = index;
    }
  }
  if (start === -1) return undefined;
  // Back up to the start of the marker's line so the excerpt is line-aligned.
  const lineStart = stderr.lastIndexOf("\n", start) + 1;
  const traceback = stderr.slice(lineStart).trim();
  return traceback ? clampOutputTail(traceback, 6_000) : undefined;
}

/** validate-notebook prints "OK" (exit 0) or newline-joined issues (exit 1). */
export function parseValidateNotebookOutput(
  stdout: string,
  exitCode: number,
): { clean: boolean; issues: string[] } {
  const trimmed = stdout.trim();
  if (exitCode === 0 && (trimmed === "OK" || trimmed === "")) {
    return { clean: true, issues: [] };
  }
  const issues = trimmed
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && line !== "OK");
  return { clean: issues.length === 0 && exitCode === 0, issues };
}

/**
 * The default analysis stack, mirrored from analysis-sandbox.Dockerfile (keep
 * the two lists in sync). Used to seed a project's pyproject.toml the first
 * time add_python_dependency initializes one, so "default stack + extras"
 * stays true once a project declares its own environment.
 */
export const ANALYSIS_DEFAULT_STACK = [
  "pandas",
  "numpy",
  "polars",
  "duckdb",
  "pyarrow",
  "altair",
  "plotly",
  "matplotlib",
  "seaborn",
  "scipy",
  "scikit-learn",
  "statsmodels",
  "openpyxl",
  "xlsxwriter",
  "pdfplumber",
  "python-docx",
  "python-pptx",
  "sqlalchemy",
  "psycopg[binary]",
  "pymysql",
  "jupyter",
  "nbconvert",
  "ipykernel",
];

/** The notebook toolchain overlaid onto project envs that don't declare it. */
const NOTEBOOK_TOOLCHAIN_WITH = ["jupyter", "nbconvert", "ipykernel"]
  .map((pkg) => `--with ${pkg}`)
  .join(" ");

/**
 * The command that executes a notebook in place, via the baked
 * `execute-notebook` runner (nbclient with save-after-every-cell, so a failing
 * run keeps every completed cell's outputs — nbconvert only wrote on full
 * success). When the project declares a `pyproject.toml`, run through `uv` so
 * the kernel sees the PROJECT env (synced from the seeded cache) — never the
 * baked venv, which would make project packages invisible. The notebook
 * toolchain is overlaid via `--with` so execution works even for user-authored
 * pyprojects that don't declare jupyter. The runner is invoked as
 * `python /usr/local/bin/execute-notebook` so it always runs under the active
 * env's interpreter.
 */
export function notebookExecuteCommand(notebookRelPath: string, hasPyproject: boolean): string {
  const quoted = shellQuote(notebookRelPath);
  const execute = `python /usr/local/bin/execute-notebook ${quoted}`;
  return hasPyproject ? `uv run --project . ${NOTEBOOK_TOOLCHAIN_WITH} ${execute}` : execute;
}

/** validate-notebook is a baked system CLI, independent of the project venv. */
export function validateNotebookCommand(notebookRelPath: string): string {
  return `validate-notebook ${shellQuote(notebookRelPath)}`;
}

/**
 * The command that fingerprints the container's post-run tree with sha256sum.
 * Prunes heavy/derived dirs so the hash pass is fast and never descends `.venv`.
 *
 * The file list is staged through a temp file instead of a pipe so that a
 * mid-stream `find` failure surfaces as a non-zero exit in ANY POSIX shell (no
 * bash-only `pipefail` dependency): a partial manifest must never masquerade as
 * a complete one — persistChangedFiles refuses to diff against a failed
 * manifest, because a truncated listing would make untouched files look removed
 * and delete them from the project store.
 */
export function treeManifestCommand(): string {
  const pruneNames = [
    ".venv",
    "venv",
    "__pycache__",
    ".ipynb_checkpoints",
    ".cache",
    ".uv-cache",
    "node_modules",
    ".git",
    ".pytest_cache",
    ".mypy_cache",
  ];
  const prune = pruneNames.map((name) => `-name ${shellQuote(name)}`).join(" -o ");
  return (
    `__mf=$(mktemp) && find . \\( ${prune} \\) -prune -o -type f -print0 > "$__mf" ` +
    `&& xargs -0 -r sha256sum < "$__mf"; __rc=$?; [ -n "$__mf" ] && rm -f "$__mf"; test "$__rc" -eq 0`
  );
}

// ---------------------------------------------------------------------------
// Core run logic (pure of `this`, testable with fakes)
// ---------------------------------------------------------------------------

interface AnalysisRunDeps {
  sandbox: AnalysisSandboxLike;
  files: WorkspaceFileStoreLike;
  projectId: string;
  newRunId: () => string;
}

/**
 * Per-invocation working directory for a project run. Concurrent runs on the
 * same project (Promise.all in js_exec, overlapping app calls) each materialize
 * into their own tree and persist a diff against their own start manifest, so
 * one run can never clobber or persist another run's intermediate state. The
 * project venv is shared across runs via UV_PROJECT_ENVIRONMENT (uv holds its
 * own lock during sync), so isolation doesn't cost env warmth.
 */
function analysisRunWorkdir(projectId: string, runId: string): string {
  return `${ANALYSIS_PROJECT_ROOT}/${sanitizeSegment(projectId)}/runs/${sanitizeSegment(runId)}`;
}

/**
 * Per-run scratch dir, created by the service before user code runs and removed
 * with the workdir. Exposed to the run as $SCRATCH — the documented home for
 * large intermediates, so they never enter the persist diff and never
 * accumulate in the warm container.
 */
function analysisRunScratchDir(runId: string): string {
  return `${ANALYSIS_SCRATCH_ROOT}/${sanitizeSegment(runId)}`;
}

/** Best-effort removal of a run's workdir; never masks the run result. */
async function cleanupWorkdir(sandbox: AnalysisSandboxLike, workdir: string): Promise<void> {
  try {
    await sandbox.exec(`rm -rf ${shellQuote(workdir)}`, { cwd: "/" });
  } catch {
    /* workdir cleanup is best-effort */
  }
}

/** Execute + validate a notebook, persisting the changed set back. */
export async function runAnalysisNotebook(
  request: { path: string; timeoutMs?: number },
  deps: AnalysisRunDeps,
): Promise<AnalysisNotebookResult> {
  const startedAt = Date.now();
  const notebookRel = normalizeAnalysisRelPath(request.path);
  if (!notebookRel || !notebookRel.endsWith(".ipynb")) {
    return emptyNotebookResult(startedAt, "path must be a .ipynb file inside the project");
  }
  const timeoutMs = clampTimeout(request.timeoutMs, DEFAULT_NOTEBOOK_TIMEOUT_MS, MAX_NOTEBOOK_TIMEOUT_MS);

  const runId = deps.newRunId();
  const workdir = analysisRunWorkdir(deps.projectId, runId);
  const scratchDir = analysisRunScratchDir(runId);
  try {
    const before = await materializeProject(deps.sandbox, workdir, deps.files);
    if (!before.some((f) => f.path === notebookRel)) {
      return emptyNotebookResult(startedAt, `notebook ${notebookRel} not found in project`);
    }
    const hasPyproject = before.some((f) => f.path === "pyproject.toml");
    const beforeManifest = await manifestFromSourceFiles(before);
    await deps.sandbox.mkdir(scratchDir, { recursive: true });

    const nb = normalizeExec(
      await deps.sandbox.exec(notebookExecuteCommand(notebookRel, hasPyproject), {
        cwd: workdir,
        timeout: timeoutMs,
        env: { ...analysisRunEnv({ projectId: deps.projectId }), SCRATCH: scratchDir },
      }),
    );

    // Always run the validator (nbconvert can "succeed" while embedding error
    // outputs the report would surface); its stdout is the structured issue list.
    const val = normalizeExec(
      await deps.sandbox.exec(validateNotebookCommand(notebookRel), { cwd: workdir, timeout: 60_000 }),
    );
    const validation = parseValidateNotebookOutput(val.stdout, val.exitCode);

    const persisted = await persistChangedFiles(deps.sandbox, workdir, deps.files, beforeManifest);
    const executed = nb.exitCode === 0;
    const ok = executed && validation.clean;
    return {
      ok,
      executed,
      validation,
      // Full outputs — the tool layer spills them to R2 and clamps for the
      // model (see ANALYSIS_NOTEBOOK_STDOUT_MAX_CHARS).
      stdout: nb.stdout,
      stderr: nb.stderr,
      exitCode: nb.exitCode,
      ...persisted,
      durationMs: Date.now() - startedAt,
      ...(ok ? {} : { error: notebookErrorMessage(nb, validation) }),
    };
  } finally {
    await cleanupWorkdir(deps.sandbox, workdir);
    await cleanupWorkdir(deps.sandbox, scratchDir);
  }
}

/** Ad-hoc shell in a project working dir (or a scratch dir when no project). */
export async function runAnalysisExec(
  request: { command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number },
  deps: AnalysisRunDeps & { hasProject: boolean; scratchId: string },
): Promise<AnalysisExecResult> {
  const startedAt = Date.now();
  if (!request.command || !request.command.trim()) {
    return { ok: false, stdout: "", stderr: "command is required", exitCode: 1, changedFiles: [], removedFiles: [], skippedOversize: [], durationMs: 0, error: "command is required" };
  }
  const timeoutMs = clampTimeout(request.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, MAX_NOTEBOOK_TIMEOUT_MS);

  if (!deps.hasProject) {
    const scratch = `${ANALYSIS_SCRATCH_ROOT}/${sanitizeSegment(deps.scratchId)}`;
    try {
      await deps.sandbox.mkdir(scratch, { recursive: true });
      const cwd = request.cwd ? joinWithin(scratch, request.cwd) : scratch;
      const res = normalizeExec(
        await deps.sandbox.exec(request.command, { cwd, timeout: timeoutMs, env: { ...analysisRunEnv(), SCRATCH: scratch, ...request.env } }),
      );
      return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, changedFiles: [], removedFiles: [], skippedOversize: [], durationMs: Date.now() - startedAt, ...(res.exitCode === 0 ? {} : { error: execError(res) }) };
    } finally {
      // Scratch is per-call; without cleanup a warm container accumulates
      // abandoned scratch trees until its disk fills.
      await cleanupWorkdir(deps.sandbox, scratch);
    }
  }

  const runId = deps.newRunId();
  const workdir = analysisRunWorkdir(deps.projectId, runId);
  const scratchDir = analysisRunScratchDir(runId);
  try {
    const before = await materializeProject(deps.sandbox, workdir, deps.files);
    const beforeManifest = await manifestFromSourceFiles(before);
    await deps.sandbox.mkdir(scratchDir, { recursive: true });
    const cwd = request.cwd ? joinWithin(workdir, request.cwd) : workdir;
    const res = normalizeExec(
      await deps.sandbox.exec(request.command, { cwd, timeout: timeoutMs, env: { ...analysisRunEnv({ projectId: deps.projectId }), SCRATCH: scratchDir, ...request.env } }),
    );
    const persisted = await persistChangedFiles(deps.sandbox, workdir, deps.files, beforeManifest);
    return {
      ok: res.exitCode === 0,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      ...persisted,
      durationMs: Date.now() - startedAt,
      ...(res.exitCode === 0 ? {} : { error: execError(res) }),
    };
  } finally {
    await cleanupWorkdir(deps.sandbox, workdir);
    await cleanupWorkdir(deps.sandbox, scratchDir);
  }
}

/** `uv add` the packages, persisting pyproject.toml + uv.lock back. */
export async function runAnalysisAddDependency(
  request: { packages: string[]; dev?: boolean },
  deps: AnalysisRunDeps,
): Promise<AnalysisDependencyResult> {
  const startedAt = Date.now();
  const packages = normalizeDependencySpecs(request.packages);
  const workdir = analysisRunWorkdir(deps.projectId, deps.newRunId());
  try {
    const before = await materializeProject(deps.sandbox, workdir, deps.files);
    const hasPyproject = before.some((f) => f.path === "pyproject.toml");

    // `uv add` requires a project; init one if the analysis project has no
    // pyproject.toml yet (mirrors the skill's old `uv init` preamble, now
    // implicit). A fresh pyproject is seeded with the DEFAULT STACK alongside
    // the requested packages: once a project declares its own env, uv runs use
    // ONLY that env, so the advertised "preinstalled defaults + extras" flow
    // must be reproduced in the declaration (installs come from the seeded
    // cache, so this is fast).
    const initCmd = hasPyproject
      ? ""
      : `uv init --no-workspace --python 3.13 && uv add ${ANALYSIS_DEFAULT_STACK.map(shellQuote).join(" ")} && `;
    const command = `${initCmd}uv add ${request.dev ? "--dev " : ""}${packages.map(shellQuote).join(" ")}`;
    const res = normalizeExec(
      await deps.sandbox.exec(command, { cwd: workdir, timeout: DEFAULT_DEP_TIMEOUT_MS, env: analysisRunEnv({ projectId: deps.projectId }) }),
    );

    const pyprojectPersisted = res.exitCode === 0 ? await persistSingleFile(deps.sandbox, workdir, deps.files, "pyproject.toml") : false;
    const lockPersisted = res.exitCode === 0 ? await persistSingleFile(deps.sandbox, workdir, deps.files, "uv.lock") : false;
    return {
      ok: res.exitCode === 0,
      packages,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode,
      pyprojectPersisted,
      lockPersisted,
      durationMs: Date.now() - startedAt,
      ...(res.exitCode === 0 ? {} : { error: execError(res) }),
    };
  } finally {
    await cleanupWorkdir(deps.sandbox, workdir);
  }
}

/**
 * Run a Python string (warehouse-compatible). No project — reads only the mounted
 * exports/uploads. `params` are injected as a Python dict, not interpolated.
 */
export async function runAnalysisCode(
  request: { code: string; params?: Record<string, unknown> },
  deps: { sandbox: AnalysisSandboxLike; scratchId: string; connections?: boolean },
): Promise<AnalysisRunCodeResult> {
  if (!request.code || !request.code.trim()) {
    return { ok: false, error: "code is required" };
  }
  const scratch = `${ANALYSIS_SCRATCH_ROOT}/${sanitizeSegment(deps.scratchId)}`;
  const scriptPath = `${scratch}/main.py`;
  try {
    await deps.sandbox.mkdir(scratch, { recursive: true });
    const code = withWarehouseParams(request.code, request.params);
    await deps.sandbox.writeFile(scriptPath, base64FromString(code), { encoding: "base64" });
    const res = normalizeExec(
      await deps.sandbox.exec(`python ${shellQuote(scriptPath)}`, { cwd: scratch, timeout: DEFAULT_EXEC_TIMEOUT_MS, env: { ...analysisRunEnv({ connections: deps.connections }), SCRATCH: scratch } }),
    );
    if (res.exitCode !== 0) {
      return { ok: false, stdout: res.stdout, stderr: res.stderr, error: execError(res) };
    }
    return { ok: true, stdout: res.stdout, stderr: res.stderr };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "analysis code failed" };
  } finally {
    // Scratch is per-call; without cleanup a warm container accumulates
    // abandoned scratch trees until its disk fills.
    await cleanupWorkdir(deps.sandbox, scratch);
  }
}

// ---------------------------------------------------------------------------
// Materialize / persist
// ---------------------------------------------------------------------------

async function materializeProject(
  sandbox: AnalysisSandboxLike,
  workdir: string,
  files: WorkspaceFileStoreLike,
): Promise<AnalysisSourceFile[]> {
  const sourceFiles = await collectProjectSourceFiles(files);
  await sandbox.mkdir(workdir, { recursive: true });
  // Wipe non-derived files (keep .venv / caches for warm reuse) then write the
  // current source tree. A future optimization diffs against a stamp; v1 is a
  // correct full-source rewrite — cheap for notebooks + small data.
  await sandbox.exec(
    `find . -mindepth 1 \\( -name .venv -o -name venv -o -name .uv-cache -o -name __pycache__ -o -name node_modules -o -name .git \\) -prune -o -type f -print0 | xargs -0 -r rm -f`,
    { cwd: workdir },
  );
  for (const file of sourceFiles) {
    const targetPath = `${workdir}/${file.path}`;
    const parent = dirname(targetPath);
    if (parent && parent !== workdir) await sandbox.mkdir(parent, { recursive: true });
    await sandbox.writeFile(targetPath, base64FromBytes(file.bytes), { encoding: "base64" });
  }
  return sourceFiles;
}

async function manifestFromSourceFiles(files: AnalysisSourceFile[]): Promise<Map<string, string>> {
  const manifest = new Map<string, string>();
  for (const file of files) {
    if (shouldIgnoreAnalysisPath(file.path)) continue;
    manifest.set(file.path, await sha256Hex(file.bytes));
  }
  return manifest;
}

async function persistChangedFiles(
  sandbox: AnalysisSandboxLike,
  workdir: string,
  files: WorkspaceFileStoreLike,
  beforeManifest: Map<string, string>,
): Promise<{ changedFiles: string[]; removedFiles: string[]; skippedOversize: string[] }> {
  const manifest = normalizeExec(await sandbox.exec(treeManifestCommand(), { cwd: workdir }));
  // NEVER diff against a failed/partial manifest: an incomplete listing makes
  // untouched files look removed and the loop below would delete them from the
  // project store. Fail the run loudly instead.
  if (manifest.exitCode !== 0) {
    throw new Error(
      `analysis persist aborted: tree manifest failed with exit code ${manifest.exitCode}` +
        (manifest.stderr ? `: ${manifest.stderr.slice(0, 500)}` : ""),
    );
  }
  const afterManifest = parseSha256Manifest(manifest.stdout);
  const { changed, removed } = diffManifests(beforeManifest, afterManifest);

  const changedFiles: string[] = [];
  const skippedOversize: string[] = [];
  for (const rel of changed) {
    const read = await sandbox.readFile(`${workdir}/${rel}`, { encoding: "base64" });
    const bytes = base64ToBytes(read.content);
    if (bytes.length > ANALYSIS_MAX_PERSIST_BYTES) {
      skippedOversize.push(rel);
      continue;
    }
    const result = await files.writeBinaryFile(`/${rel}`, read.content);
    if (!result.success) throw new Error(result.error || `Failed to persist ${rel}`);
    changedFiles.push(rel);
  }
  const removedFiles: string[] = [];
  for (const rel of removed) {
    // force covers already-gone files; any remaining failure is a genuine
    // storage error — fail loudly like the write path, or the project store
    // silently keeps files the run deleted.
    const result = await files.deleteFile(`/${rel}`, { force: true });
    if (!result.success) throw new Error(result.error || `Failed to remove ${rel} from the project`);
    removedFiles.push(rel);
  }
  return { changedFiles, removedFiles, skippedOversize };
}

async function persistSingleFile(
  sandbox: AnalysisSandboxLike,
  workdir: string,
  files: WorkspaceFileStoreLike,
  rel: string,
): Promise<boolean> {
  let read: { content: string };
  try {
    read = await sandbox.readFile(`${workdir}/${rel}`, { encoding: "base64" });
  } catch {
    return false;
  }
  const content = new TextDecoder().decode(base64ToBytes(read.content));
  const result = await files.writeFile(`/${rel}`, content);
  if (!result.success) throw new Error(result.error || `Failed to persist ${rel}`);
  return true;
}

async function collectProjectSourceFiles(files: WorkspaceFileStoreLike): Promise<AnalysisSourceFile[]> {
  const listing = await files.listFiles("/", { recursive: true, includeHidden: true, limit: 50_000 });
  if (!listing.success) throw new Error(listing.error || "Failed to list project files");
  const out: AnalysisSourceFile[] = [];
  for (const entry of listing.files) {
    if (entry.type !== "file") continue;
    const rel = normalizeAnalysisRelPath(entry.absolutePath);
    if (!rel || shouldIgnoreAnalysisPath(rel)) continue;
    const read = await files.readFile(entry.absolutePath);
    if (!read.success || typeof read.content !== "string") {
      throw new Error(read.error || `Failed to read ${entry.absolutePath}`);
    }
    out.push({
      path: rel,
      bytes: read.encoding === "base64" ? base64ToBytes(read.content) : new TextEncoder().encode(read.content),
    });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// ---------------------------------------------------------------------------
// Small utils
// ---------------------------------------------------------------------------

function analysisRunEnv(options: { projectId?: string; connections?: boolean } = {}): Record<string, string> {
  return {
    CI: "1",
    PYTHONUNBUFFERED: "1",
    // The baked camelai helper package (see ANALYSIS_PYTHONPATH).
    PYTHONPATH: ANALYSIS_PYTHONPATH,
    // Same protocol + variable the project VMs exposed, so the skill's notebook
    // helper code carries over unchanged. The host is intercepted at the sandbox
    // egress layer and served by the connectionsRpc outbound handler with the
    // workspace/org scope the service attached DO-side (see analysis-sandbox.ts).
    // Omitted for app-scoped runs, whose container never registers the
    // interception (see runCodeForApps).
    ...(options.connections === false ? {} : { CAMELAI_CONNECTIONS_RPC_URL: `http://${ANALYSIS_CONNECTIONS_HOST}/` }),
    // Project runs use per-invocation workdirs (analysisRunWorkdir), so point uv
    // at a container-lifetime venv shared per project — env warmth survives run
    // isolation, and the venv never sits inside a persisted tree. uv locks the
    // environment during sync, so concurrent runs on one project are safe.
    ...(options.projectId ? { UV_PROJECT_ENVIRONMENT: `/venvs/project-${sanitizeSegment(options.projectId)}` } : {}),
  };
}

function clampTimeout(value: number | undefined, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.min(Math.floor(value), max);
}

function emptyNotebookResult(startedAt: number, error: string): AnalysisNotebookResult {
  return {
    ok: false,
    executed: false,
    validation: { clean: false, issues: [] },
    stdout: "",
    stderr: error,
    exitCode: 1,
    changedFiles: [],
    removedFiles: [],
    skippedOversize: [],
    durationMs: Date.now() - startedAt,
    error,
  };
}

function notebookErrorMessage(nb: { stderr: string; stdout: string; exitCode: number }, validation: { issues: string[] }): string {
  if (nb.exitCode !== 0) {
    // Lead with the Python traceback when we can find one — it names the
    // failing cell and exception, which is what the caller needs to fix.
    const traceback = extractNotebookTraceback(nb.stderr);
    if (traceback) return traceback;
    return clampOutputTail(nb.stderr || nb.stdout, ANALYSIS_NOTEBOOK_STDERR_MAX_CHARS)
      || `notebook execution failed with exit code ${nb.exitCode}`;
  }
  if (validation.issues.length) return `notebook validation failed:\n${validation.issues.join("\n")}`;
  return "notebook run failed";
}

function execError(res: { stderr: string; stdout: string; exitCode: number }): string {
  return res.stderr || res.stdout || `command failed with exit code ${res.exitCode}`;
}

function normalizeExec(result: { success?: boolean; stdout?: string; stderr?: string; exitCode?: number }): {
  stdout: string;
  stderr: string;
  exitCode: number;
} {
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : result.success === false ? 1 : 0;
  return {
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    exitCode,
  };
}

function normalizeDependencySpecs(value: unknown): string[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const out: string[] = [];
  for (const raw of list) {
    if (typeof raw !== "string") throw new Error("each package must be a string");
    const spec = raw.trim();
    if (!spec) continue;
    if (spec.length > 214) throw new Error("package spec is too long");
    // oxlint-disable-next-line no-control-regex -- Package specs must reject ASCII control characters.
    if (/\s|[\u0000-\u001f\u007f]/.test(spec)) throw new Error("package must be a single spec (no spaces)");
    if (spec.startsWith("-")) throw new Error("package must not be a CLI flag");
    if (spec.includes("://") || /(^|@)(?:file|git|https?):/i.test(spec)) {
      throw new Error("package must be a PyPI package spec");
    }
    out.push(spec);
  }
  if (!out.length) throw new Error("at least one package is required");
  return out;
}

/** Join a user-provided relative subdir under `base`, refusing traversal. */
function joinWithin(base: string, sub: string): string {
  const rel = normalizeAnalysisRelPath(sub);
  return rel ? `${base}/${rel}` : base;
}

function sanitizeSegment(value: string): string {
  const cleaned = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
  if (!cleaned) throw new Error("invalid identifier");
  return cleaned;
}

function dirname(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  return parts.length ? `/${parts.join("/")}` : "/";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function base64FromString(value: string): string {
  return base64FromBytes(new TextEncoder().encode(value));
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

// ---------------------------------------------------------------------------
// WorkerEntrypoint
// ---------------------------------------------------------------------------

interface AnalysisEnv {
  ANALYSIS_SANDBOX?: unknown;
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
  R2_BUCKET?: R2Bucket;
  WORKSPACE_FS?: DurableObjectNamespace<import("./workspace-filesystem-do.js").WorkspaceFilesystemDO>;
}

interface AnalysisServiceProps {
  workspaceId: string;
  orgId: string;
}

export class AnalysisService extends WorkerEntrypoint<AnalysisEnv, AnalysisServiceProps> {
  private readonly sandboxes = new Map<string, AnalysisSandboxStub>();

  /** Test seam (agent-scoped container). */
  setSandbox(sandbox: AnalysisSandboxStub): void {
    this.sandboxes.set("agent", sandbox);
  }

  async runNotebook(request: { projectId: string; path: string; timeoutMs?: number }): Promise<AnalysisNotebookResult> {
    const files = await this.projectFiles(request.projectId);
    const sandbox = await this.resolveSandbox();
    await this.prepareWorkspaceAccess(sandbox);
    return runAnalysisNotebook(
      { path: request.path, timeoutMs: request.timeoutMs },
      { sandbox, files, projectId: request.projectId, newRunId: () => crypto.randomUUID() },
    );
  }

  async exec(request: { projectId?: string; command: string; cwd?: string; env?: Record<string, string>; timeoutMs?: number }): Promise<AnalysisExecResult> {
    const hasProject = Boolean(request.projectId);
    const files = hasProject ? await this.projectFiles(request.projectId as string) : ({} as WorkspaceFileStoreLike);
    const sandbox = await this.resolveSandbox();
    await this.prepareWorkspaceAccess(sandbox);
    return runAnalysisExec(
      { command: request.command, cwd: request.cwd, env: request.env, timeoutMs: request.timeoutMs },
      {
        sandbox,
        files,
        projectId: request.projectId ?? "scratch",
        newRunId: () => crypto.randomUUID(),
        hasProject,
        scratchId: crypto.randomUUID(),
      },
    );
  }

  async addDependency(request: { projectId: string; packages: string[]; dev?: boolean }): Promise<AnalysisDependencyResult> {
    const files = await this.projectFiles(request.projectId);
    const sandbox = await this.resolveSandbox();
    return runAnalysisAddDependency(
      { packages: request.packages, dev: request.dev },
      { sandbox, files, projectId: request.projectId, newRunId: () => crypto.randomUUID() },
    );
  }

  async runCode(request: { code: string; params?: Record<string, unknown> }): Promise<AnalysisRunCodeResult> {
    const sandbox = await this.resolveSandbox();
    await this.prepareWorkspaceAccess(sandbox);
    return runAnalysisCode(request, { sandbox, scratchId: crypto.randomUUID() });
  }

  /**
   * App-scoped runCode — the ONLY compute deployed apps get (via
   * AnalysisAppService / the legacy WarehouseService shim). Runs in a SEPARATE
   * warm container from the agent's (`app-<workspaceId>`): mounts and the
   * connections interception are container-level state, so sharing the agent's
   * container would leak the uploads mount and connections.internal access that
   * agent runs legitimately establish there. The app container only ever gets
   * the export-prefix mount — the pre-merge warehouse contract — and no
   * CAMELAI_CONNECTIONS_RPC_URL is injected (the interception is never
   * registered on this container, so the host is unreachable regardless).
   */
  async runCodeForApps(request: { code: string; params?: Record<string, unknown> }): Promise<AnalysisRunCodeResult> {
    const sandbox = await this.resolveSandbox("app");
    // Seal egress before every app run: app code has no PyPI use case, so the
    // class-level allowlist would only be an exfiltration channel for mounted
    // export data (the override is in-memory DO state, hence per-run).
    await sandbox.sealAppEgress();
    if (this.env.WAREHOUSE_EXPORT_BUCKET) {
      await sandbox.ensureMounted(ANALYSIS_EXPORT_BUCKET_BINDING, warehouseWorkspacePrefix(this.ctx.props.workspaceId));
    }
    return runAnalysisCode(request, { sandbox, scratchId: crypto.randomUUID(), connections: false });
  }

  async listConnections(): Promise<WarehouseConnection[]> {
    const summaries = await listConnections(this.env as unknown as ConnectionsRuntimeEnv, {
      orgId: this.ctx.props.orgId,
      workspaceId: this.ctx.props.workspaceId,
    });
    return annotateWarehouseConnections(summaries);
  }

  /**
   * Prepare the container's workspace-scoped data access before a run:
   * read-only R2 mounts (exports + uploads) and the connections.internal
   * interception with this workspace/org scope attached DO-side. All three are
   * idempotent-cheap on a warm container.
   */
  private async prepareWorkspaceAccess(sandbox: AnalysisSandboxStub): Promise<void> {
    if (this.env.WAREHOUSE_EXPORT_BUCKET) {
      await sandbox.ensureMounted(ANALYSIS_EXPORT_BUCKET_BINDING, warehouseWorkspacePrefix(this.ctx.props.workspaceId));
    }
    if (this.env.R2_BUCKET && this.ctx.props.orgId) {
      // Mounted at the stable /uploads alias — the agent's `uploads/<name>`
      // reference with a leading slash — because the raw org/workspace R2
      // prefix is neither shown to the agent nor derivable in the container.
      const uploadsPrefix = `${getWorkspaceR2Prefix(this.ctx.props.orgId, this.ctx.props.workspaceId)}/user-uploads`;
      if (await r2PrefixHasObjects(this.env.R2_BUCKET, uploadsPrefix)) {
        await sandbox.ensureMounted(ANALYSIS_UPLOADS_BUCKET_BINDING, uploadsPrefix, ANALYSIS_UPLOADS_MOUNT_PATH);
      }
      // Writable, and deliberately NOT gated on the prefix already having
      // objects the way uploads is: outputs starts empty by definition, and the
      // whole point is to let a run create the first file in it.
      //
      // A failure here is logged rather than thrown. Losing the outputs mount
      // costs the run its delivery path, but throwing would take down notebook
      // and code execution entirely — a much larger regression than the one
      // this mount exists to fix.
      const outputsPrefix = `${getWorkspaceR2Prefix(this.ctx.props.orgId, this.ctx.props.workspaceId)}/user-outputs`;
      try {
        await sandbox.ensureMounted(
          ANALYSIS_UPLOADS_BUCKET_BINDING,
          outputsPrefix,
          ANALYSIS_OUTPUTS_MOUNT_PATH,
          { readOnly: false },
        );
      } catch (error) {
        console.error("[AnalysisService] outputs mount failed", error);
      }
    }
    if (this.ctx.props.orgId && this.ctx.props.workspaceId) {
      await sandbox.ensureConnectionsRpc({
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
      });
    }
  }

  /**
   * Resolve a project's file store ONLY after proving the project belongs to
   * this service's bound workspace. Callers of the virtualized binding (and, in
   * principle, any future caller) control `projectId`, and global project ids
   * are guessable/shareable strings — without this check a caller could read or
   * write another workspace's project through this service. The workspace's own
   * project registry is the authority (same check the connections RPC route
   * uses); fail closed on any miss.
   */
  private async projectFiles(projectId: string): Promise<WorkspaceFileStoreLike> {
    if (!this.ctx.props.workspaceId) throw new Error("Analysis service requires workspace scope");
    if (!this.env.WORKSPACE_FS) throw new Error("WORKSPACE_FS binding is not configured");
    const registry = this.env.WORKSPACE_FS.get(this.env.WORKSPACE_FS.idFromName(this.ctx.props.workspaceId));
    const project = await registry.getProject(projectId);
    if (!project) {
      throw new Error(`Project ${projectId} not found in this workspace`);
    }
    return new ProjectFilesystemClient(this.env as never, projectId);
  }

  /**
   * Resolve the workspace's warm container. `scope: "agent"` (default) is the
   * full-capability container the chat agent's runs use; `scope: "app"` is a
   * separate container for deployed-app runCode, so app code never shares the
   * container-level mounts/interception the agent's runs establish.
   */
  private async resolveSandbox(scope: "agent" | "app" = "agent"): Promise<AnalysisSandboxStub> {
    const cached = this.sandboxes.get(scope);
    if (cached) return cached;
    if (!this.env.ANALYSIS_SANDBOX) throw new Error("ANALYSIS_SANDBOX container binding is not configured");
    const { getSandbox } = await import("@cloudflare/sandbox");
    // One warm container per workspace and scope; per-call isolation is via
    // working dirs.
    const sandboxId = scope === "app" ? `app-${this.ctx.props.workspaceId}` : this.ctx.props.workspaceId;
    const sandbox = getSandbox(
      this.env.ANALYSIS_SANDBOX as Parameters<typeof getSandbox>[0],
      sandboxId,
      { normalizeId: true },
    ) as unknown as AnalysisSandboxStub;
    this.sandboxes.set(scope, sandbox);
    return sandbox;
  }
}

/**
 * The deployed-app entrypoint for the virtualized ANALYSIS binding — the
 * code-string + export-mounts capability ONLY. A deployed app has no project
 * working tree and must not reach the project filesystem, notebooks, shell,
 * uploads, or the connections RPC, so this class exposes exactly `runCode` +
 * `listConnections` and delegates to AnalysisService.runCodeForApps, which runs
 * in a separate app-scoped container with only the export-prefix mount (the
 * full AnalysisService stays reachable only via ctx.exports with
 * platform-attached props — never bindable by user workers).
 */
export class AnalysisAppService extends WorkerEntrypoint<AnalysisEnv, AnalysisServiceProps> {
  async runCode(request: { code: string; params?: Record<string, unknown> }): Promise<AnalysisRunCodeResult> {
    return this.full().runCodeForApps(request);
  }

  async listConnections(): Promise<WarehouseConnection[]> {
    return this.full().listConnections();
  }

  private full(): Pick<AnalysisService, "runCodeForApps" | "listConnections"> {
    return (this.ctx.exports as unknown as {
      AnalysisService: (options: { props: AnalysisServiceProps }) => AnalysisService;
    }).AnalysisService({
      props: {
        orgId: this.ctx.props.orgId,
        workspaceId: this.ctx.props.workspaceId,
      },
    });
  }
}

export const __testing = {
  collectProjectSourceFiles,
  materializeProject,
  persistChangedFiles,
  manifestFromSourceFiles,
};
