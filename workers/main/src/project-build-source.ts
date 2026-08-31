import { mapWithConcurrency } from "../../../src/lib/map-with-concurrency";

import { base64ToBytes } from "./base64-codec.js";
import { sha256Hex } from "./sha256.js";
import type {
  WorkspaceFileStoreLike,
  WorkspaceListEntry,
} from "./workspace-filesystem-do.js";
import type { ProjectBuildSandboxLike } from "./project-worker-bundle.js";

export const PROJECT_BUILD_ROOT = "/workspace";
// A streamed WorkspaceFilesystemDO read occupies an outbound Worker connection
// until its body is consumed. Workers allow six simultaneous connections per
// invocation; using all of them here can strand the Sandbox RPC transport that
// the same build call needs next. Keep two lanes in reserve for control-plane
// traffic and drain every started read before the retry ladder can re-enter.
const SOURCE_STREAM_READ_CONCURRENCY = 4;
// Hashing is isolate-local and does not consume outbound connections.
const SOURCE_HASH_CONCURRENCY = 16;
// Keep parallel Sandbox streams below the Worker connection ceiling while
// giving cold, data-heavy projects enough lanes to overlap transfer latency.
const SOURCE_ARCHIVE_MAX_LANES = 3;
const SOURCE_ARCHIVE_TARGET_LANE_BYTES = 8 * 1024 * 1024;
const SOURCE_ARCHIVE_GZIP_MIN_BYTES = 1024 * 1024;
const SOURCE_ARCHIVE_STREAM_CHUNK_BYTES = 256 * 1024;

export interface ProjectBuildSourceTimings {
  collectSourceMs: number;
  sourceListMs: number;
  sourceReadMs: number;
  sourceHashMs: number;
  materializeMs: number;
  previousManifestReadMs: number;
  archiveCreateMs: number;
  archiveWriteMs: number;
  materializeExecMs: number;
}

export interface ProjectSourceFile {
  path: string;
  bytes: Uint8Array;
  sha256: string;
}

export interface ProjectSourceEntry {
  path: string;
  size: number;
  modifiedAt: string;
  sha256: string;
}

export interface ProjectSourceCollection {
  entries: ProjectSourceEntry[];
  changedFiles: ProjectSourceFile[];
  validationFiles: ProjectSourceFile[];
  previousManifest: SourceManifest | null;
  previousManifestReadMs: number;
  timings: Pick<
    ProjectBuildSourceTimings,
    "collectSourceMs" | "sourceListMs" | "sourceReadMs" | "sourceHashMs"
  >;
  totalBytes: number;
}

export interface SourceManifest {
  schemaVersion: 1 | 2;
  files: Array<{ path: string; size: number; sha256: string; modifiedAt?: string }>;
}

export async function collectProjectSourceFiles(
  files: WorkspaceFileStoreLike,
  options?: { sandbox: ProjectBuildSandboxLike; workdir: string },
): Promise<ProjectSourceCollection> {
  const startedAt = Date.now();
  const previousManifestStartedAt = Date.now();
  const previousManifest = options
    ? await readSourceManifestFromSandbox(options.sandbox, options.workdir)
    : null;
  const previousManifestReadMs = Date.now() - previousManifestStartedAt;
  const previousFiles = previousManifest
    ? new Map(previousManifest.files.map((file) => [file.path, file]))
    : null;
  const listStartedAt = Date.now();
  const listing = await files.listFiles("/", { recursive: true, includeHidden: true, limit: 50_000 });
  const sourceListMs = Date.now() - listStartedAt;
  if (!listing.success) throw new Error(listing.error || "Failed to list project files");
  const listedFiles = listing.files
    .filter((entry) => entry.type === "file")
    .map((entry) => ({ entry, relativePath: normalizeRelativeBuildPath(entry.absolutePath) }))
    .filter(({ relativePath }) => Boolean(relativePath) && !shouldIgnoreBuildSourcePath(relativePath));

  const filesToRead = listedFiles.filter(({ entry, relativePath }) => {
    const previous = previousFiles?.get(relativePath);
    const metadataMatches = previous?.modifiedAt != null &&
      previous.size === entry.size && previous.modifiedAt === entry.modifiedAt;
    // Always re-read executable source for admission checks. Large unchanged
    // data/assets can safely reuse the prior content hash and avoid an R2 read.
    return !metadataMatches || shouldReadBuildSourceForValidation(relativePath);
  });

  const readStartedAt = Date.now();
  const readFiles = await readProjectSourceFiles(files, filesToRead);
  const sourceReadMs = Date.now() - readStartedAt;

  const hashStartedAt = Date.now();
  const hashedFiles = await mapWithConcurrency(readFiles, SOURCE_HASH_CONCURRENCY, async (file) => {
    const sha256 = await sha256Hex(file.bytes);
    return {
      ...file,
      sha256,
    };
  });
  const sourceHashMs = Date.now() - hashStartedAt;
  const readByPath = new Map(hashedFiles.map((file) => [file.path, file]));
  const entries: ProjectSourceEntry[] = listedFiles.map(({ entry, relativePath }) => {
    const read = readByPath.get(relativePath);
    if (read) {
      return {
        path: relativePath,
        size: read.bytes.byteLength,
        modifiedAt: entry.modifiedAt,
        sha256: read.sha256,
      };
    }
    const previous = previousFiles?.get(relativePath);
    if (!previous) throw new Error(`Missing source bytes for ${relativePath}`);
    return {
      path: relativePath,
      size: previous.size,
      modifiedAt: entry.modifiedAt,
      sha256: previous.sha256,
    };
  }).sort((a, b) => a.path.localeCompare(b.path));
  const changedFiles = hashedFiles.filter((file) => {
    const previous = previousFiles?.get(file.path);
    return !previous || previous.size !== file.bytes.byteLength || previous.sha256 !== file.sha256;
  }).map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const validationFiles = hashedFiles
    .filter((file) => shouldReadBuildSourceForValidation(file.path))
    .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }));
  const totalBytes = entries.reduce((sum, file) => sum + file.size, 0);
  return {
    entries,
    changedFiles,
    validationFiles,
    previousManifest,
    previousManifestReadMs,
    totalBytes,
    timings: {
      collectSourceMs: Date.now() - startedAt,
      sourceListMs,
      sourceReadMs,
      sourceHashMs,
    },
  };
}

/**
 * Read project files without exceeding the Worker's outbound-connection cap.
 *
 * This intentionally waits for every already-started read to settle after the
 * first failure. `Promise.all()` rejects immediately, which previously let the
 * deploy retry ladder start another 16 streamed reads while the abandoned
 * batch was still holding connections; one transient disconnect could then
 * turn into a permanently failing build session.
 */
async function readProjectSourceFiles(
  files: WorkspaceFileStoreLike,
  filesToRead: Array<{ entry: WorkspaceListEntry; relativePath: string }>,
): Promise<Array<{ path: string; bytes: Uint8Array; modifiedAt: string }>> {
  if (filesToRead.length === 0) return [];

  const results = Array.from<{
    path: string;
    bytes: Uint8Array;
    modifiedAt: string;
  }>({ length: filesToRead.length });
  let nextIndex = 0;
  let failed = false;
  let firstError: unknown;
  const workerCount = Math.min(SOURCE_STREAM_READ_CONCURRENCY, filesToRead.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    for (;;) {
      if (failed) return;
      const index = nextIndex;
      if (index >= filesToRead.length) return;
      nextIndex += 1;
      const { entry, relativePath } = filesToRead[index]!;
      try {
        const bytes = await readWorkspaceSourceBytes(files, entry.absolutePath, entry.size);
        results[index] = { path: relativePath, bytes, modifiedAt: entry.modifiedAt };
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        return;
      }
    }
  }));

  if (failed) throw firstError;
  return results;
}

async function readWorkspaceSourceBytes(
  files: WorkspaceFileStoreLike,
  absolutePath: string,
  expectedSize: number,
): Promise<Uint8Array> {
  const streamed = await files.readFileStream(absolutePath);
  if (streamed.success && streamed.stream) {
    // Preallocate from list metadata so a large source file never takes the
    // older text/base64 path or accumulates a second set of stream chunks.
    const reader = streamed.stream.getReader();
    let bytes = new Uint8Array(Math.max(0, expectedSize));
    let offset = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value?.byteLength) continue;
        if (offset + value.byteLength > bytes.byteLength) {
          const grown = new Uint8Array(Math.max(offset + value.byteLength, Math.max(1, bytes.byteLength * 2)));
          grown.set(bytes);
          bytes = grown;
        }
        bytes.set(value, offset);
        offset += value.byteLength;
      }
      return offset === bytes.byteLength ? bytes : bytes.slice(0, offset);
    } catch (error) {
      await reader.cancel(error).catch(() => {});
      throw error;
    } finally {
      reader.releaseLock();
    }
  }
  const read = await files.readFile(absolutePath);
  if (!read.success || typeof read.content !== "string") {
    throw new Error(read.error || streamed.error || `Failed to read ${absolutePath}`);
  }
  return read.encoding === "base64"
    ? base64ToBytes(read.content)
    : new TextEncoder().encode(read.content);
}

function shouldReadBuildSourceForValidation(path: string): boolean {
  return path === "package.json" || DO_SQLITE_CHECK_EXTENSIONS.test(path);
}

export function shouldIgnoreBuildSourcePath(path: string): boolean {
  const parts = path.split("/");
  return parts.some((part) =>
    part === "node_modules" ||
    part === ".camelai" ||
    part === ".git" ||
    part === ".wrangler" ||
    part === ".cache" ||
    part === "dist" ||
    part === "build"
  );
}

export function normalizeRelativeBuildPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").split("/").filter((part) => part && part !== "." && part !== "..").join("/");
}

export async function materializeProjectSourceFiles(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
  source: ProjectSourceCollection,
): Promise<Pick<ProjectBuildSourceTimings, "materializeMs" | "previousManifestReadMs" | "archiveCreateMs" | "archiveWriteMs" | "materializeExecMs">> {
  const startedAt = Date.now();
  await sandbox.mkdir(workdir, { recursive: true });
  const manifest = sourceManifestForEntries(source.entries);
  const manifestPath = `${workdir}.next-source-manifest.json`;
  const currentManifestPath = sourceManifestPath(workdir);

  const archiveCreateStartedAt = Date.now();
  const archiveLanes = createArchiveLanes(workdir, source.changedFiles);
  const archiveCreateMs = Date.now() - archiveCreateStartedAt;

  const archiveWriteStartedAt = Date.now();
  await Promise.all([
    ...archiveLanes.map((lane) => sandbox.writeFile(lane.path, lane.stream)),
    sandbox.writeFile(manifestPath, JSON.stringify(manifest), { encoding: "utf8" }),
  ]);
  const archiveWriteMs = Date.now() - archiveWriteStartedAt;

  const materializeExecStartedAt = Date.now();
  await sandbox.exec(materializeCommand({
    workdir,
    currentManifestPath,
    manifestPath,
    archives: archiveLanes.map(({ path, compressed }) => ({ path, compressed })),
    forceClean: source.previousManifest === null,
  }), { cwd: PROJECT_BUILD_ROOT });
  const materializeExecMs = Date.now() - materializeExecStartedAt;

  return {
    materializeMs: Date.now() - startedAt,
    previousManifestReadMs: source.previousManifestReadMs,
    archiveCreateMs,
    archiveWriteMs,
    materializeExecMs,
  };
}

export function validatePackageJsonBuildScript(sourceFiles: ProjectSourceFile[]): string | null {
  const packageJson = sourceFiles.find((file) => file.path === "package.json");
  if (!packageJson) return "Project package.json is required for deploy_project";
  const parsed = parseProjectPackageJson(packageJson);
  if (typeof parsed === "string") return parsed;
  const scripts = (parsed as { scripts?: unknown }).scripts;
  const buildScriptMessage = "Project package.json must define scripts.build. Create a new project to get the standard react-router scaffold, and list every CLI used by scripts.build in dependencies or devDependencies. Data-analysis projects have no build step — use run_notebook to execute the notebook, then deploy_project to publish it as a static report app.";
  if (!scripts || typeof scripts !== "object") return buildScriptMessage;
  const build = (scripts as { build?: unknown }).build;
  return typeof build === "string" && build.trim() ? null : buildScriptMessage;
}

const DO_SQLITE_CHECK_EXTENSIONS = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/;
// Matches D1-style `sql.prepare(...)` calls on Durable Object SQLite storage
// (`this.sql.prepare(`, `ctx.storage.sql.prepare(`). `\b` keeps identifiers like
// `mysql`/`libsql` from matching.
const D1_STYLE_PREPARE_PATTERN = /\bsql\s*\.\s*prepare\s*\(/;

// Current scaffolds typecheck during the build, but older projects' build scripts
// (react-router build via esbuild) strip types without checking them, so D1-style
// calls on SqlStorage build cleanly and only crash at runtime after deploy. Catch the
// known footgun here for every project, with a corrective message that names the fix
// (tsc only says the property doesn't exist).
export function validateDoSqliteApiUsage(sourceFiles: ProjectSourceFile[]): string | null {
  const decoder = new TextDecoder();
  for (const file of sourceFiles) {
    if (!DO_SQLITE_CHECK_EXTENSIONS.test(file.path)) continue;
    const content = decoder.decode(file.bytes);
    const match = D1_STYLE_PREPARE_PATTERN.exec(content);
    if (!match) continue;
    const line = content.slice(0, match.index).split("\n").length;
    return [
      `${file.path}:${line} calls .prepare() on Durable Object SQLite storage, which does not exist and will crash at runtime after deploy.`,
      `Durable Object SqlStorage is not the D1 API: there is no .prepare(), .bind(), .all(), .first(), .run(), or .batch().`,
      `Pass parameters directly to exec and read the cursor, e.g. this.ctx.storage.sql.exec("SELECT * FROM items WHERE id = ?", id).toArray() — or .one() for a single row, .raw() for column arrays.`,
    ].join(" ");
  }
  return null;
}

function sourceManifestForEntries(sourceFiles: ProjectSourceEntry[]): SourceManifest {
  return {
    schemaVersion: 2,
    files: sourceFiles.map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      modifiedAt: file.modifiedAt,
    })),
  };
}

async function readSourceManifestFromSandbox(
  sandbox: ProjectBuildSandboxLike,
  workdir: string,
): Promise<SourceManifest | null> {
  if (!sandbox.readFile) return null;
  const manifestPath = sourceManifestPath(workdir);
  // A missing manifest is the normal first-build cache-miss path. Avoid using a
  // rejected readFile RPC as an existence probe: the eval runtime can surface a
  // handled Sandbox RPC rejection as a Vitest unhandled error after the caller
  // has already recovered from it.
  if (sandbox.exists) {
    const existence = await sandbox.exists(manifestPath);
    if (!existence.exists) return null;
  }
  let read: { content: string };
  try {
    read = await sandbox.readFile(manifestPath, { encoding: "utf8" });
  } catch (error) {
    const message = String(error).toLowerCase();
    if (message.includes("missing") || message.includes("not found") || message.includes("enoent")) return null;
    throw error;
  }
  try {
    return validateSourceManifest(JSON.parse(read.content));
  } catch {
    // Treat malformed old state as a cache miss. The materializer will wipe the
    // workdir before extracting the full source archive.
    return null;
  }
}

function validateSourceManifest(value: unknown): SourceManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid source manifest");
  const record = value as SourceManifest;
  if ((record.schemaVersion !== 1 && record.schemaVersion !== 2) || !Array.isArray(record.files)) throw new Error("invalid source manifest");
  const files = record.files.map((file) => {
    if (!file || typeof file !== "object" || Array.isArray(file)) throw new Error("invalid source manifest");
    const entry = file as { path?: unknown; size?: unknown; sha256?: unknown; modifiedAt?: unknown };
    if (typeof entry.path !== "string" || !entry.path || entry.path.includes("\0") || entry.path.startsWith("/")) {
      throw new Error("invalid source manifest");
    }
    if (typeof entry.size !== "number" || entry.size < 0 || !Number.isFinite(entry.size)) throw new Error("invalid source manifest");
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(entry.sha256)) throw new Error("invalid source manifest");
    if (entry.modifiedAt != null && typeof entry.modifiedAt !== "string") throw new Error("invalid source manifest");
    return {
      path: normalizeRelativeBuildPath(entry.path),
      size: entry.size,
      sha256: entry.sha256.toLowerCase(),
      ...(typeof entry.modifiedAt === "string" ? { modifiedAt: entry.modifiedAt } : {}),
    };
  }).filter((file) => file.path);
  return { schemaVersion: record.schemaVersion, files };
}

function sourceManifestPath(workdir: string): string {
  return `${workdir}.source-manifest.json`;
}

function materializeCommand(input: {
  workdir: string;
  currentManifestPath: string;
  manifestPath: string;
  archives: Array<{ path: string; compressed: boolean }>;
  forceClean?: boolean;
}): string {
  const commands = [
    ...input.archives.map((archive) => `tar -t${archive.compressed ? "z" : ""}f ${shellQuote(archive.path)} >/dev/null`),
    `CAMELAI_WORKDIR=${shellQuote(input.workdir)} CAMELAI_CURRENT_MANIFEST=${shellQuote(input.currentManifestPath)} CAMELAI_NEXT_MANIFEST=${shellQuote(input.manifestPath)} CAMELAI_FORCE_CLEAN=${input.forceClean ? "1" : "0"} bun -e ${shellQuote(SOURCE_MATERIALIZE_SCRIPT)}`,
  ];
  commands.push(...input.archives.map((archive) =>
    `tar -x${archive.compressed ? "z" : ""}f ${shellQuote(archive.path)} -C ${shellQuote(input.workdir)}`
  ));
  commands.push(`mv ${shellQuote(input.manifestPath)} ${shellQuote(input.currentManifestPath)}`);
  commands.push(`rm -f ${shellQuote(workdirArchivePrefix(input.workdir))}*`);
  commands.push(`find ${shellQuote(input.workdir)} -type d -empty -delete 2>/dev/null || true`);
  return commands.join(" && ");
}

const SOURCE_MATERIALIZE_SCRIPT = String.raw`
const fs = require("fs");
const path = require("path");
const workdir = process.env.CAMELAI_WORKDIR;
const currentManifestPath = process.env.CAMELAI_CURRENT_MANIFEST;
const nextManifestPath = process.env.CAMELAI_NEXT_MANIFEST;
if (!workdir || !currentManifestPath || !nextManifestPath) throw new Error("missing materialize inputs");
fs.mkdirSync(workdir, { recursive: true });
const next = JSON.parse(fs.readFileSync(nextManifestPath, "utf8"));
const nextFiles = Array.isArray(next.files) ? next.files : [];
const forceClean = process.env.CAMELAI_FORCE_CLEAN === "1";
const safeResolve = (relativePath) => {
  const target = path.resolve(workdir, relativePath);
  const root = path.resolve(workdir);
  if (target !== root && target.startsWith(root + path.sep)) return target;
  throw new Error("unsafe source path: " + relativePath);
};
if (forceClean || !fs.existsSync(currentManifestPath)) {
  for (const name of fs.readdirSync(workdir)) {
    fs.rmSync(path.join(workdir, name), { recursive: true, force: true });
  }
} else {
  const current = JSON.parse(fs.readFileSync(currentManifestPath, "utf8"));
  const keep = new Set(nextFiles.map((file) => file.path));
  for (const file of Array.isArray(current.files) ? current.files : []) {
    if (!file || typeof file.path !== "string" || keep.has(file.path)) continue;
    fs.rmSync(safeResolve(file.path), { force: true });
  }
}
`;

interface SourceArchiveLane {
  path: string;
  compressed: boolean;
  stream: ReadableStream<Uint8Array>;
}

function createArchiveLanes(workdir: string, sourceFiles: ProjectSourceFile[]): SourceArchiveLane[] {
  if (sourceFiles.length === 0) return [];
  const totalBytes = sourceFiles.reduce((sum, file) => sum + file.bytes.byteLength, 0);
  const laneCount = Math.min(
    SOURCE_ARCHIVE_MAX_LANES,
    sourceFiles.length,
    Math.max(1, Math.ceil(totalBytes / SOURCE_ARCHIVE_TARGET_LANE_BYTES)),
  );
  const lanes = Array.from({ length: laneCount }, () => ({ bytes: 0, files: [] as ProjectSourceFile[] }));
  for (const file of [...sourceFiles].sort((a, b) => b.bytes.byteLength - a.bytes.byteLength)) {
    const lane = lanes.reduce((smallest, candidate) => candidate.bytes < smallest.bytes ? candidate : smallest);
    lane.files.push(file);
    lane.bytes += file.bytes.byteLength;
  }
  return lanes.map((lane, index) => {
    const compressed = lane.bytes >= SOURCE_ARCHIVE_GZIP_MIN_BYTES;
    const stream = createTarStream(lane.files);
    return {
      path: `${workdirArchivePrefix(workdir)}${index}.tar${compressed ? ".gz" : ""}`,
      compressed,
      stream: compressed
        ? stream.pipeThrough(new CompressionStream("gzip") as unknown as ReadableWritablePair<Uint8Array, Uint8Array>)
        : stream,
    };
  });
}

function workdirArchivePrefix(workdir: string): string {
  return `${workdir}.source.`;
}

function createTarStream(sourceFiles: ProjectSourceFile[]): ReadableStream<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for (const file of sourceFiles) {
    chunks.push(tarHeader(file.path, file.bytes.byteLength));
    for (let offset = 0; offset < file.bytes.byteLength; offset += SOURCE_ARCHIVE_STREAM_CHUNK_BYTES) {
      chunks.push(file.bytes.subarray(offset, offset + SOURCE_ARCHIVE_STREAM_CHUNK_BYTES));
    }
    const padding = tarPadding(file.bytes.byteLength);
    if (padding > 0) chunks.push(new Uint8Array(padding));
  }
  chunks.push(new Uint8Array(1024));
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  const { name, prefix } = splitTarPath(path);
  writeTarString(header, 0, 100, name);
  writeTarString(header, 100, 8, "0000644");
  writeTarString(header, 108, 8, "0000000");
  writeTarString(header, 116, 8, "0000000");
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
  for (let index = 148; index < 156; index += 1) header[index] = 0x20;
  header[156] = 0x30;
  writeTarString(header, 257, 6, "ustar");
  writeTarString(header, 263, 2, "00");
  if (prefix) writeTarString(header, 345, 155, prefix);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeTarChecksum(header, checksum);
  return header;
}

function splitTarPath(path: string): { name: string; prefix?: string } {
  // oxlint-disable-next-line no-control-regex -- Tar paths must reject NUL and newline characters.
  if (/[\u0000\r\n]/.test(path)) throw new Error(`Invalid source path for archive: ${path}`);
  const encoded = new TextEncoder().encode(path);
  if (encoded.byteLength <= 100) return { name: path };
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index).join("/");
    const name = parts.slice(index).join("/");
    if (new TextEncoder().encode(prefix).byteLength <= 155 && new TextEncoder().encode(name).byteLength <= 100) {
      return { name, prefix };
    }
  }
  throw new Error(`Source path is too long for archive: ${path}`);
}

function writeTarString(header: Uint8Array, offset: number, length: number, value: string): void {
  const encoded = new TextEncoder().encode(value);
  if (encoded.byteLength > length) throw new Error(`Tar field is too long: ${value}`);
  header.set(encoded, offset);
}

function writeTarOctal(header: Uint8Array, offset: number, length: number, value: number): void {
  const text = value.toString(8).padStart(length - 1, "0").slice(-(length - 1));
  writeTarString(header, offset, length - 1, text);
  header[offset + length - 1] = 0;
}

function writeTarChecksum(header: Uint8Array, value: number): void {
  const text = value.toString(8).padStart(6, "0").slice(-6);
  writeTarString(header, 148, 6, text);
  header[154] = 0;
  header[155] = 0x20;
}

function tarPadding(size: number): number {
  const remainder = size % 512;
  return remainder === 0 ? 0 : 512 - remainder;
}

export function validatePackageJson(sourceFiles: ProjectSourceFile[]): string | null {
  const packageJson = sourceFiles.find((file) => file.path === "package.json");
  if (!packageJson) return "Project package.json is required";
  const parsed = parseProjectPackageJson(packageJson);
  return typeof parsed === "string" ? parsed : null;
}

function parseProjectPackageJson(packageJson: ProjectSourceFile): unknown | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(packageJson.bytes));
  } catch {
    return "Project package.json is not valid JSON";
  }
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed
    : "Project package.json must be an object";
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const __testing = {
  normalizeRelativeBuildPath,
  shouldIgnoreBuildSourcePath,
};
