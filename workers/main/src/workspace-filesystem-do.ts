import { DurableObject } from "cloudflare:workers";
import { Workspace, type FileInfo } from "@cloudflare/shell";
import { normalizeGlobalProjectId } from "./project-vm-protocol.js";
import { utf8ByteLength } from "./chat-thread/utf8-byte-length.js";
import { isNotebookPath, normalizeNotebookJson } from "./notebook-normalize";
import {
  applyTextEdits,
  generateTextEditDetails,
  type TextEdit,
  type TextEditDetails,
} from "./text-edit";

const WORKSPACE_ROOT = "/workspace";
const DEFAULT_INLINE_THRESHOLD = 1_500_000;
const WORKSPACE_BUFFERED_FILE_MAX_BYTES = 2 * 1024 * 1024;
const WORKSPACE_BUFFERED_READS = 2;
const WORKSPACE_BUFFERED_READ_MS = 2 * 60_000;
const WORKSPACE_STREAM_READS = 4;
const WORKSPACE_STREAM_READ_MS = 2 * 60_000;
const WORKSPACE_STREAM_CANCEL_MS = 10_000;
const WORKSPACE_LIST_MAX_ENTRIES = 50_000;
const WORKSPACE_LIST_MAX_PATH_BYTES = 4 * 1024 * 1024;
const WORKSPACE_LIST_PAGE_SIZE = 128;
const WORKSPACE_PATH_MAX_BYTES = 4_096;
const WORKSPACE_MUTATION_MS = 5 * 60_000;
const WORKSPACE_INLINE_WRITE_MAX_BYTES = 1024 * 1024;
const WORKSPACE_R2_ADOPT_MS = 2 * 60_000;
const WORKSPACE_R2_DELETE_MS = 10_000;
const WORKSPACE_R2_GC_ALARM_RETRY_MS = 1_000;
const WORKSPACE_R2_LATE_PUT_GRACE_MS = 30_000;
const PROJECT_SNAPSHOT_OPERATION_MS = 5 * 60_000;
const PROJECT_SNAPSHOT_MAX_COUNT = 200;
const PROJECT_SNAPSHOT_MAX_FILES = 4_096;
const PROJECT_SNAPSHOT_MAX_FILE_BYTES = 16 * 1024 * 1024 * 1024;
const PROJECT_SNAPSHOT_MAX_TOTAL_BYTES = 64 * 1024 * 1024 * 1024;
const PROJECT_SNAPSHOT_MAX_MANIFEST_BYTES = 1024 * 1024;
// Keep the restore commit atomic without retaining an unbounded project in the
// isolate. Typical source trees remain SQLite-inline; once this aggregate
// budget is exhausted, later entries stay streamed through R2.
const PROJECT_SNAPSHOT_RESTORE_INLINE_MAX_BYTES = 16 * 1024 * 1024;
const PROJECT_SNAPSHOT_LIST_MAX_COUNT = 20;
const PROJECT_SNAPSHOT_LIST_MAX_BYTES = 2 * 1024 * 1024;
const PROJECT_R2_DELETE_BATCH = 128;
const PROJECT_RECURSIVE_DELETE_MAX_ENTRIES = 4_096;
const WORKSPACE_RECURSIVE_DELETE_MAX_METADATA_BYTES = 4 * 1024 * 1024;
const WORKSPACE_R2_GC_TABLE = "workspace_r2_gc_v1";
const WORKSPACE_R2_GC_MAX_KEYS =
  WORKSPACE_LIST_MAX_ENTRIES + PROJECT_SNAPSHOT_MAX_FILES;

class WorkspaceAdoptTimeoutError extends Error {}
class WorkspaceFileTooLargeError extends Error {}
class WorkspaceReadCapacityError extends Error {}
class WorkspaceMutationBusyError extends Error {}

interface WorkspaceTreeCounters {
  entryCount: number;
  fileCount: number;
  pathBytes: number;
  totalBytes: number;
}

interface NormalizedWorkspaceTreeBounds {
  maxEntries: number;
  maxFiles: number;
  maxPathBytes: number;
  maxFileBytes: number;
  maxTotalBytes: number;
}

interface WorkspaceTreeCollectOptions {
  recursive: boolean;
  includeHidden: boolean;
  limit: number;
  bounds: NormalizedWorkspaceTreeBounds;
  counters: WorkspaceTreeCounters;
  completeForBounds: boolean;
  readPage?: (
    directory: string,
    after: WorkspaceDirectoryCursor | undefined,
    limit: number,
  ) => Promise<FileInfo[]> | FileInfo[];
}

interface WorkspaceDirectoryCursor {
  type: string;
  name: string;
  path: string;
}

interface WorkspaceR2CleanupRow {
  r2_key: string;
  owner: string | null;
  phase: "delete" | "pending-put" | "confirm-delete";
}

/**
 * The @cloudflare/shell Workspace store (v0.3.7) namespaces its SQLite table
 * and R2 object keys. We construct it with no `namespace`, so it defaults to
 * "default": rows live in `cf_workspace_default` and each spilled file's R2
 * key is `${r2Prefix}/default${normalizedPath}` (see Workspace.r2Key). The
 * large-file adopt path stores an immutable, unique R2 key in that same row
 * shape so the store reads adopted objects through its normal `r2_key` path.
 * Uploading a new key before the metadata swap keeps replacement failure-atomic.
 */
const WORKSPACE_STORE_NAMESPACE = "default";
const WORKSPACE_STORE_TABLE = `cf_workspace_${WORKSPACE_STORE_NAMESPACE}`;

export interface WorkspaceFilesystemEnv {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
  ARTIFACTS?: ArtifactsBinding;
  CF_ACCOUNT_ID?: string;
  ARTIFACTS_NAMESPACE?: string;
}

export interface WorkspaceReadFileResponse {
  success: boolean;
  content?: string;
  size?: number;
  isBinary?: boolean;
  encoding?: "utf8" | "base64";
  mimeType?: string;
  error?: string;
  code?: string;
}

export interface WorkspaceReadFileStreamResponse {
  success: boolean;
  stream?: ReadableStream<Uint8Array>;
  size?: number;
  mimeType?: string;
  error?: string;
  code?: string;
}

export interface WorkspaceWriteResponse {
  success: boolean;
  error?: string;
  code?: string;
}

export interface WorkspaceEditFileResponse
  extends WorkspaceWriteResponse, Partial<TextEditDetails> {
  before?: string;
  after?: string;
  replacementCount?: number;
  usedFuzzyMatch?: boolean;
  notice?: string;
}

export interface WorkspaceAdoptR2FileResponse {
  success: boolean;
  /** Bytes actually stored in R2 (authoritative object size). */
  size?: number;
  error?: string;
  code?: string;
}

export interface WorkspaceExistsResponse {
  exists: boolean;
  isFile?: boolean;
  isDirectory?: boolean;
  size?: number;
  mimeType?: string;
}

export interface WorkspaceListEntry {
  name: string;
  type: "file" | "directory";
  size: number;
  modifiedAt: string;
  relativePath: string;
  absolutePath: string;
  mimeType?: string;
}

export interface WorkspaceListResponse {
  success: boolean;
  files: WorkspaceListEntry[];
  count: number;
  path: string;
  timestamp?: string;
  error?: string;
}

export interface WorkspaceTreeBounds {
  maxEntries?: number;
  maxFiles?: number;
  maxPathBytes?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
}

export interface WorkspaceListOptions {
  recursive?: boolean;
  includeHidden?: boolean;
  limit?: number;
  /**
   * Optional strict producer-side limits. Unlike `limit` (a result-window
   * size), crossing one of these fails closed and returns no partial listing.
   */
  bounds?: WorkspaceTreeBounds;
}

export interface WorkspaceProject {
  id: string;
  name: string;
  description: string;
  defaultVmId: string;
  backend: "do-r2";
  kind?: "project" | "clone";
  clonedFromProjectId?: string;
  cloneSource?: WorkspaceProjectCloneSource;
  clones?: WorkspaceProjectCloneSummary[];
  cloneCount?: number;
  artifactRemoteProjectId?: string;
  artifactRepoName?: string;
  artifactRepoId?: string;
  artifactRemote?: string;
  artifactDefaultBranch?: string;
  artifactStatus?: "ready" | "creating" | "importing" | "forking" | "error";
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceProjectCloneSource {
  id: string;
  name: string;
  description: string;
}

export interface WorkspaceProjectCloneSummary {
  id: string;
  name: string;
  description: string;
  defaultVmId: string;
  backend: "do-r2";
  clonedFromProjectId: string;
  artifactRemote?: string;
  artifactStatus?: WorkspaceProject["artifactStatus"];
  createdAt: string;
  updatedAt: string;
}

export interface WorkspaceFilesystemLike {
  exists(path: string): Promise<WorkspaceExistsResponse>;
  readFile(path: string): Promise<WorkspaceReadFileResponse>;
  readFileStream(path: string): Promise<WorkspaceReadFileStreamResponse>;
  writeFile(path: string, content: string): Promise<WorkspaceWriteResponse>;
  writeBinaryFile(
    path: string,
    base64Content: string,
  ): Promise<WorkspaceWriteResponse>;
  listFiles(
    path: string,
    options?: WorkspaceListOptions,
  ): Promise<WorkspaceListResponse>;
  mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<WorkspaceWriteResponse>;
  deleteFile(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<WorkspaceWriteResponse>;
  listProjects(): Promise<WorkspaceProject[]>;
  listProjectsForMigrationReset(): Promise<WorkspaceProject[]>;
  getProject(projectId: unknown): Promise<WorkspaceProject | null>;
  getProjectByName(project: unknown): Promise<WorkspaceProject | null>;
  deleteProjectsForWorkspace(
    workspaceId?: unknown,
  ): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }>;
  removeProjects(
    projectIds: string[],
  ): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }>;
  createProject(input?: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject>;
  setProjectDescription(input?: {
    project?: unknown;
    projectId?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject>;
  cloneProject(input?: {
    sourceProject?: unknown;
    sourceProjectId?: unknown;
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject>;
  mintProjectArtifactToken(
    projectId: unknown,
    scope?: "read" | "write",
    ttlSeconds?: number,
  ): Promise<ProjectArtifactToken>;
}

export type WorkspaceFileStoreLike = Pick<
  WorkspaceFilesystemLike,
  | "exists"
  | "readFile"
  | "readFileStream"
  | "writeFile"
  | "writeBinaryFile"
  | "listFiles"
  | "mkdir"
  | "deleteFile"
> & {
  editTextFile?: (
    path: string,
    edits: TextEdit[],
  ) => Promise<WorkspaceEditFileResponse>;
  /**
   * Stream a file directly into the project store's R2 backing without
   * materializing the payload in a Worker or Durable Object isolate.
   * ProjectFilesystemClient provides this; it stays optional because generic
   * workspace-file consumers and lightweight test doubles do not persist
   * analysis artifacts.
   */
  adoptR2File?: (
    path: string,
    stream: ReadableStream<Uint8Array>,
    expectedSize: number,
    contentType?: string,
  ) => Promise<WorkspaceAdoptR2FileResponse>;
};

export interface ProjectArtifactToken {
  project: WorkspaceProject;
  token: string;
  expiresAt?: string | number;
  artifactRemote: string;
  artifactRemoteProjectId: string;
}

export interface ProjectSourceSnapshotEntry {
  path: string;
  size: number;
  sha256: string;
  blobKey: string;
}

export interface ProjectSourceSnapshot {
  id: string;
  createdAt: string;
  message?: string;
  fileCount: number;
  totalBytes: number;
  entries: ProjectSourceSnapshotEntry[];
}

const PROJECTS_KEY = "projects:v1";
const PROJECT_SNAPSHOT_INDEX_KEY = "project-source-snapshots:v1";
const PROJECT_SNAPSHOT_PREFIX = "project-source-snapshot:";
const PROJECT_SNAPSHOT_GC_KEY = "project-source-snapshots:gc:v1";
const DEFAULT_PROJECT_VM_ID = "main";
const ARTIFACTS_DEFAULT_BRANCH = "main";
const ARTIFACTS_READY_TIMEOUT_MS = 30_000;
const ARTIFACTS_READY_POLL_MS = 1_000;
export const ARTIFACTS_VANITY_HOST = "artifacts.camelai.internal";
type FileStoreScope = "workspace" | "project";

interface ArtifactsBinding {
  create(
    name: string,
    options?: {
      readOnly?: boolean;
      description?: string;
      setDefaultBranch?: string;
    },
  ): Promise<ArtifactsCreateRepoResult>;
  get(name: string): Promise<ArtifactsRepo>;
}

interface ArtifactsRepoInfo {
  id?: string;
  name: string;
  remote?: string;
  defaultBranch?: string;
  status?: "ready" | "creating" | "importing" | "forking";
}

interface ArtifactsCreateRepoResult extends ArtifactsRepoInfo {
  token?: string;
}

interface ArtifactsCreateTokenResult {
  plaintext: string;
  expiresAt?: string | number;
}

export interface ArtifactsRepo extends ArtifactsRepoInfo {
  createToken(
    scope?: "read" | "write",
    ttl?: number,
  ): Promise<ArtifactsCreateTokenResult>;
}

interface ReadyArtifactsRepoInfo extends ArtifactsRepoInfo {
  remote: string;
}

export class WorkspaceFilesystemDO extends DurableObject<WorkspaceFilesystemEnv> {
  private workspaceFiles?: Workspace;
  private projectFiles?: Workspace;
  private fileMutationActive = false;
  private r2AdoptionActive = false;
  private readonly r2CleanupOwner = crypto.randomUUID();
  private r2GcTableReady = false;
  private r2CleanupAlarmRearmQueued = false;
  private workspaceListIndexReady = false;
  private readonly abortedTimeouts = new WeakSet<object>();
  private activeBufferedReads = 0;
  private activeStreamReads = 0;

  constructor(ctx: DurableObjectState, env: WorkspaceFilesystemEnv) {
    super(ctx, env);
  }

  private get workspace(): Workspace {
    this.workspaceFiles ??= this.createFileStore("workspace");
    return this.workspaceFiles;
  }

  private get projectWorkspace(): Workspace {
    this.projectFiles ??= this.createFileStore("project");
    return this.projectFiles;
  }

  private createFileStore(scope: FileStoreScope): Workspace {
    const durableId = this.ctx.id.toString();
    return new Workspace({
      sql: this.ctx.storage.sql,
      r2: this.env.R2_BUCKET,
      r2Prefix: fileStoreR2Prefix(scope, durableId),
      inlineThreshold: DEFAULT_INLINE_THRESHOLD,
      name: durableId,
    });
  }

  private async withFileMutationQueue<T>(
    _scope: FileStoreScope,
    _path: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const deadlineAt = Date.now() + WORKSPACE_MUTATION_MS;
    // Exactly one file mutation may be retained by an isolate. Overlapping
    // requests fail immediately instead of building an unbounded promise lane.
    if (this.fileMutationActive) {
      throw new WorkspaceMutationBusyError(
        "EBUSY: another workspace file mutation is active",
      );
    }
    this.fileMutationActive = true;
    try {
      return await withOperationDeadline(
        operation,
        deadlineAt,
        "Workspace mutation execution",
      );
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) {
        this.abortTimeoutOnce(error, "Workspace mutation lane timed out");
      }
      throw error;
    } finally {
      this.fileMutationActive = false;
      // A mutation is the settlement-coalescing batch boundary. Late callbacks
      // after this point may schedule one fresh eager wake; the durable pre-arm
      // still fences callbacks that never arrive.
      this.r2CleanupAlarmRearmQueued = false;
    }
  }

  private abortTimeoutOnce(error: object, reason: string): void {
    if (this.abortedTimeouts.has(error)) return;
    this.abortedTimeouts.add(error);
    try {
      this.ctx.abort(reason);
    } catch {
      // Preserve the bounded error for deterministic callers/tests.
    }
  }

  async fetch(_request: Request): Promise<Response> {
    return new Response("Not found", { status: 404 });
  }

  async alarm(): Promise<void> {
    const deadlineAt = Date.now() + WORKSPACE_R2_DELETE_MS;
    try {
      // A future wake is durable before any binding dispatch. If this isolate
      // is aborted by a hung delete, the next instance retains recovery work.
      await withOperationDeadline(
        () =>
          this.ctx.storage.setAlarm(
            Date.now() +
              (this.fileMutationActive
                ? WORKSPACE_MUTATION_MS
                : WORKSPACE_R2_GC_ALARM_RETRY_MS),
          ),
        deadlineAt,
        "Workspace R2 GC retry pre-arm",
      );
      // Never wait behind a legitimate long mutation. The retry was armed
      // above, so a busy alarm invocation can return immediately.
      if (this.fileMutationActive) return;
      this.fileMutationActive = true;
      // Settlement callbacks coalesce to one eager wake between alarm drains.
      // The operation's durable pre-arm remains the crash/failure fallback.
      this.r2CleanupAlarmRearmQueued = false;
      try {
        const empty = await this.drainR2Cleanup(deadlineAt, 1);
        // Clear/reschedule while still owning the mutation lane. A writer
        // cannot enqueue GC between the empty check and alarm update.
        if (empty) {
          await withOperationDeadline(
            () => this.ctx.storage.deleteAlarm(),
            deadlineAt,
            "Workspace R2 GC alarm clear",
          );
        } else {
          await this.scheduleNextR2CleanupAlarm(deadlineAt);
        }
      } finally {
        this.fileMutationActive = false;
      }
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) {
        this.abortTimeoutOnce(error, "Workspace R2 GC alarm timed out");
      }
      throw error;
    }
  }

  async exists(path: string): Promise<WorkspaceExistsResponse> {
    return this.existsIn(this.workspace, path);
  }

  async projectExists(path: string): Promise<WorkspaceExistsResponse> {
    return this.existsIn(this.projectWorkspace, path);
  }

  private async existsIn(
    files: Workspace,
    path: string,
  ): Promise<WorkspaceExistsResponse> {
    const stat = await files.stat(normalizeBoundedWorkspacePath(path));
    if (!stat) return { exists: false };
    return {
      exists: true,
      isFile: stat.type === "file",
      isDirectory: stat.type === "directory",
      size: stat.size,
      mimeType: stat.mimeType,
    };
  }

  async readFile(path: string): Promise<WorkspaceReadFileResponse> {
    return this.readFileFrom(this.workspace, path);
  }

  async projectReadFile(path: string): Promise<WorkspaceReadFileResponse> {
    return this.readFileFrom(this.projectWorkspace, path);
  }

  private async readFileFrom(
    files: Workspace,
    path: string,
  ): Promise<WorkspaceReadFileResponse> {
    try {
      const normalizedPath = normalizeBoundedWorkspacePath(path);
      const result = await this.readBoundedFileBytes(files, normalizedPath);
      if (!result) {
        return { success: false, error: "File not found", code: "ENOENT" };
      }
      const decoded = decodeMaybeText(result.bytes);
      return {
        success: true,
        content: decoded.content,
        size: result.bytes.byteLength,
        isBinary: decoded.isBinary,
        encoding: decoded.isBinary ? "base64" : "utf8",
        mimeType: result.stat.mimeType,
      };
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) throw error;
      return {
        success: false,
        error: errorMessage(error),
        code:
          error instanceof WorkspaceFileTooLargeError
            ? "E2BIG"
            : error instanceof WorkspaceReadCapacityError
              ? "EBUSY"
              : "EREAD",
      };
    }
  }

  private async readBoundedFileBytes(
    files: Workspace,
    path: string,
  ): Promise<{ bytes: Uint8Array; stat: FileInfo } | null> {
    if (this.activeBufferedReads >= WORKSPACE_BUFFERED_READS) {
      throw new WorkspaceReadCapacityError(
        "Workspace buffered-read capacity exceeded",
      );
    }
    this.activeBufferedReads += 1;
    const deadlineAt = Date.now() + WORKSPACE_BUFFERED_READ_MS;
    let timedOut = false;
    try {
      return await withOperationDeadline(
        () => this.readBoundedFileBytesWithin(files, path),
        deadlineAt,
        "Workspace buffered file read",
      );
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) {
        timedOut = true;
        this.abortTimeoutOnce(error, "Workspace buffered file read timed out");
      }
      throw error;
    } finally {
      if (!timedOut) this.activeBufferedReads -= 1;
    }
  }

  private async readBoundedFileBytesWithin(
    files: Workspace,
    path: string,
  ): Promise<{ bytes: Uint8Array; stat: FileInfo } | null> {
    const stat = await files.stat(path);
    if (!stat) return null;
    if (stat.type !== "file") throw new Error(`Path is not a file: ${path}`);
    if (
      !Number.isSafeInteger(stat.size) ||
      stat.size < 0 ||
      stat.size > WORKSPACE_BUFFERED_FILE_MAX_BYTES
    ) {
      throw new WorkspaceFileTooLargeError(
        `File exceeds the ${WORKSPACE_BUFFERED_FILE_MAX_BYTES} byte buffered-read limit`,
      );
    }
    const stream = await files.readFileStream(path);
    if (!stream) return null;
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let complete = false;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) {
          complete = true;
          break;
        }
        const chunk = next.value;
        const nextTotal = total + chunk.byteLength;
        if (
          !Number.isSafeInteger(nextTotal) ||
          nextTotal > WORKSPACE_BUFFERED_FILE_MAX_BYTES ||
          nextTotal > stat.size
        ) {
          throw new WorkspaceFileTooLargeError(
            `File exceeded its bounded ${stat.size} byte read`,
          );
        }
        chunks.push(new Uint8Array(chunk));
        total = nextTotal;
      }
      if (total !== stat.size) {
        throw new Error(`File changed while reading: ${path}`);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, stat };
    } finally {
      if (!complete) {
        try {
          await reader.cancel("bounded file read did not complete");
        } catch {
          // The source may already have errored or been cancelled.
        }
      }
      reader.releaseLock();
    }
  }

  async readFileStream(path: string): Promise<WorkspaceReadFileStreamResponse> {
    return this.readFileStreamFrom(this.workspace, path);
  }

  async projectReadFileStream(
    path: string,
  ): Promise<WorkspaceReadFileStreamResponse> {
    return this.readFileStreamFrom(this.projectWorkspace, path);
  }

  private async readFileStreamFrom(
    files: Workspace,
    path: string,
  ): Promise<WorkspaceReadFileStreamResponse> {
    let normalizedPath: string;
    try {
      normalizedPath = normalizeBoundedWorkspacePath(path);
    } catch (error) {
      return {
        success: false,
        error: errorMessage(error),
        code: "E2BIG",
      };
    }
    if (this.activeStreamReads >= WORKSPACE_STREAM_READS) {
      return {
        success: false,
        error: "Workspace streaming-read capacity exceeded",
        code: "EBUSY",
      };
    }
    this.activeStreamReads += 1;
    let releaseOwned = true;
    const release = () => {
      if (!releaseOwned) return;
      releaseOwned = false;
      this.activeStreamReads -= 1;
    };
    let stream: ReadableStream<Uint8Array> | null = null;
    const deadlineAt = Date.now() + WORKSPACE_STREAM_READ_MS;
    try {
      stream = await withOperationDeadline(
        () => files.readFileStream(normalizedPath),
        deadlineAt,
        "Workspace source stream acquisition",
      );
      if (!stream) {
        release();
        return { success: false, error: "File not found", code: "ENOENT" };
      }
      const stat = await withOperationDeadline(
        () => files.stat(normalizedPath),
        deadlineAt,
        "Workspace source stream metadata",
      );
      if (!stat || stat.type !== "file") {
        await this.cancelOpenedReadStream(
          stream,
          release,
          "streamed path is not a file",
        );
        return {
          success: false,
          error: stat ? "Path is not a file" : "File not found",
          code: stat ? "EISDIR" : "ENOENT",
        };
      }
      if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
        await this.cancelOpenedReadStream(
          stream,
          release,
          "streamed file has an invalid size",
        );
        return {
          success: false,
          error: "Streamed file has an invalid size",
          code: "ESIZE",
        };
      }
      const bounded = this.wrapBoundedReadStream(stream, stat.size, release);
      return {
        success: true,
        stream: bounded,
        size: stat.size,
        mimeType: stat.mimeType,
      };
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) {
        this.abortTimeoutOnce(error, "Workspace source stream setup timed out");
        if (stream) {
          cancelUnreadStream(stream, "workspace stream setup timed out");
        }
        // A timed-out binding remains live; keep its admission slot claimed
        // until the isolate reset requested above.
        return { success: false, error: errorMessage(error), code: "EREAD" };
      }
      let failure = error;
      if (stream && releaseOwned) {
        try {
          await this.cancelOpenedReadStream(
            stream,
            release,
            "stream metadata lookup failed",
          );
        } catch (cancelError) {
          failure = cancelError;
        }
      } else if (releaseOwned) {
        release();
      }
      return { success: false, error: errorMessage(failure), code: "EREAD" };
    }
  }

  private async cancelOpenedReadStream(
    stream: ReadableStream<Uint8Array>,
    release: () => void,
    reason: string,
  ): Promise<void> {
    await this.cancelOwnedStream(
      stream,
      Date.now() + WORKSPACE_STREAM_CANCEL_MS,
      reason,
      release,
    );
  }

  private async cancelOwnedStream(
    stream: ReadableStream<Uint8Array>,
    deadlineAt: number,
    reason: string,
    release?: () => void,
  ): Promise<void> {
    const reader = stream.getReader();
    let timedOut = false;
    try {
      await withOperationDeadline(
        () => reader.cancel(reason),
        Math.min(deadlineAt, Date.now() + WORKSPACE_STREAM_CANCEL_MS),
        "Workspace source stream cancellation",
      );
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) {
        timedOut = true;
        this.abortTimeoutOnce(
          error,
          "Workspace source stream cancellation timed out",
        );
        throw error;
      }
      // A settled rejection no longer retains binding work.
    } finally {
      if (!timedOut) {
        release?.();
        try {
          reader.releaseLock();
        } catch {
          // The source may have errored while cancellation settled.
        }
      }
    }
  }

  private async readOwnedStreamBytes(
    stream: ReadableStream<Uint8Array>,
    expectedSize: number,
    maximumSize: number,
    deadlineAt: number,
    label: string,
  ): Promise<Uint8Array> {
    if (
      !Number.isSafeInteger(expectedSize) ||
      expectedSize < 0 ||
      expectedSize > maximumSize
    ) {
      throw new WorkspaceFileTooLargeError(
        `${label} exceeds its ${maximumSize} byte buffer limit`,
      );
    }
    const reader = stream.getReader();
    const bytes = new Uint8Array(expectedSize);
    let offset = 0;
    let complete = false;
    let failed = false;
    let failure: unknown;
    try {
      await withOperationDeadline(
        async () => {
          for (;;) {
            const next = await reader.read();
            if (next.done) {
              complete = true;
              break;
            }
            if (next.value.byteLength > expectedSize - offset) {
              throw new Error(`${label} exceeded its declared byte size`);
            }
            bytes.set(next.value, offset);
            offset += next.value.byteLength;
          }
        },
        deadlineAt,
        label,
      );
      if (offset !== expectedSize) {
        throw new Error(
          `${label} ended at ${offset} bytes; expected ${expectedSize}`,
        );
      }
    } catch (error) {
      failed = true;
      failure = error;
    }
    let cancellationTimeout: WorkspaceAdoptTimeoutError | undefined;
    if (!complete) {
      try {
        await withOperationDeadline(
          () => reader.cancel(`${label} did not complete`),
          Math.min(deadlineAt, Date.now() + WORKSPACE_STREAM_CANCEL_MS),
          `${label} cancellation`,
        );
      } catch (error) {
        if (error instanceof WorkspaceAdoptTimeoutError) {
          cancellationTimeout = error;
        }
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // A timed-out binding is discarded with the isolate reset.
    }
    if (cancellationTimeout) throw cancellationTimeout;
    if (failed) throw failure;
    return bytes;
  }

  private wrapBoundedReadStream(
    source: ReadableStream<Uint8Array>,
    expectedSize: number,
    release: () => void,
  ): ReadableStream<Uint8Array> {
    const reader = source.getReader();
    let terminal = false;
    let total = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const beginTerminal = () => {
      if (terminal) return false;
      terminal = true;
      clearTimeout(timer);
      return true;
    };
    const releaseLock = () => {
      try {
        reader.releaseLock();
      } catch {
        // A timed-out pending read remains owned until the isolate is reset.
      }
    };
    const cancelSource = async (reason: unknown): Promise<void> => {
      try {
        await withOperationDeadline(
          () => reader.cancel(reason),
          Date.now() + WORKSPACE_STREAM_CANCEL_MS,
          "Workspace source stream cancellation",
        );
        release();
        releaseLock();
      } catch (error) {
        if (error instanceof WorkspaceAdoptTimeoutError) {
          // Keep the admission slot claimed in this poisoned isolate. A reset
          // is the only safe way to discard the still-live binding promise.
          this.abortTimeoutOnce(
            error,
            "Workspace source stream cancellation timed out",
          );
        } else {
          release();
          releaseLock();
        }
        throw error;
      }
    };
    return new ReadableStream<Uint8Array>({
      start: (controller) => {
        timer = setTimeout(() => {
          if (!beginTerminal()) return;
          controller.error(
            new WorkspaceAdoptTimeoutError(
              "Workspace file stream exceeded its bounded lifetime",
            ),
          );
          void cancelSource("workspace stream lifetime expired").catch(
            () => undefined,
          );
        }, WORKSPACE_STREAM_READ_MS);
      },
      pull: async (controller) => {
        if (terminal) return;
        try {
          const next = await reader.read();
          if (terminal) return;
          if (next.done) {
            beginTerminal();
            release();
            releaseLock();
            if (total !== expectedSize) {
              controller.error(
                new Error(
                  `Workspace file stream ended at ${total} bytes; expected ${expectedSize}`,
                ),
              );
            } else {
              controller.close();
            }
            return;
          }
          const nextTotal = total + next.value.byteLength;
          if (!Number.isSafeInteger(nextTotal) || nextTotal > expectedSize) {
            if (!beginTerminal()) return;
            controller.error(
              new Error(
                `Workspace file stream exceeded its declared ${expectedSize} byte size`,
              ),
            );
            await cancelSource("workspace stream exceeded declared size");
            return;
          }
          total = nextTotal;
          controller.enqueue(next.value);
        } catch (error) {
          if (!beginTerminal()) return;
          release();
          releaseLock();
          controller.error(error);
        }
      },
      cancel: async (reason) => {
        if (!beginTerminal()) return;
        await cancelSource(reason);
      },
    });
  }

  async writeFile(
    path: string,
    content: string,
  ): Promise<WorkspaceWriteResponse> {
    return this.withFileMutationQueue("workspace", path, () =>
      this.writeFileTo(this.workspace, path, content),
    );
  }

  async projectWriteFile(
    path: string,
    content: string,
  ): Promise<WorkspaceWriteResponse> {
    return this.withFileMutationQueue("project", path, () =>
      this.writeFileTo(this.projectWorkspace, path, content),
    );
  }

  private async writeFileTo(
    files: Workspace,
    path: string,
    content: string,
  ): Promise<WorkspaceWriteResponse> {
    try {
      const normalized = normalizeBoundedWorkspacePath(path);
      const size = utf8ByteLength(content);
      if (size > WORKSPACE_INLINE_WRITE_MAX_BYTES) {
        throw new WorkspaceFileTooLargeError(
          `Text writes are limited to ${WORKSPACE_INLINE_WRITE_MAX_BYTES} bytes; use streamed adoption for larger files`,
        );
      }
      await this.writeInlineFile(
        files,
        normalized,
        content,
        "utf8",
        "text/plain",
        size,
      );
      return { success: true };
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) throw error;
      return {
        success: false,
        error: errorMessage(error),
        code:
          error instanceof WorkspaceFileTooLargeError
            ? "E2BIG"
            : errorMessage(error).includes("EISDIR")
              ? "EISDIR"
              : "EWRITE",
      };
    }
  }

  async writeBinaryFile(
    path: string,
    base64Content: string,
  ): Promise<WorkspaceWriteResponse> {
    return this.withFileMutationQueue("workspace", path, () =>
      this.writeBinaryFileTo(this.workspace, path, base64Content),
    );
  }

  async projectWriteBinaryFile(
    path: string,
    base64Content: string,
  ): Promise<WorkspaceWriteResponse> {
    return this.withFileMutationQueue("project", path, () =>
      this.writeBinaryFileTo(this.projectWorkspace, path, base64Content),
    );
  }

  private async writeBinaryFileTo(
    files: Workspace,
    path: string,
    base64Content: string,
  ): Promise<WorkspaceWriteResponse> {
    try {
      const normalized = normalizeBoundedWorkspacePath(path);
      const existing = await files.stat(normalized);
      if (existing?.type === "directory") {
        return {
          success: false,
          error: `Cannot replace a directory with a file: ${normalized}`,
          code: "EISDIR",
        };
      }
      const size = boundedBase64DecodedSize(
        base64Content,
        WORKSPACE_INLINE_WRITE_MAX_BYTES,
      );
      await this.writeInlineFile(
        files,
        normalized,
        base64Content,
        "base64",
        "application/octet-stream",
        size,
      );
      return { success: true };
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) throw error;
      return {
        success: false,
        error: errorMessage(error),
        code:
          error instanceof WorkspaceFileTooLargeError
            ? "E2BIG"
            : errorMessage(error).includes("EISDIR")
              ? "EISDIR"
              : "EWRITE",
      };
    }
  }

  private async writeInlineFile(
    files: Workspace,
    normalizedPath: string,
    content: string,
    contentEncoding: "utf8" | "base64",
    mimeType: string,
    size: number,
  ): Promise<void> {
    if (normalizedPath === "/") {
      throw new Error("EISDIR: cannot write to the root directory");
    }
    assertBoundedWorkspacePath(normalizedPath);
    const deadlineAt = Date.now() + WORKSPACE_R2_ADOPT_MS;
    this.assertNoUnsettledR2Effects();
    // Materialize the shared table/root, then perform ancestor creation,
    // pointer replacement, and GC enqueue in one SQLite transaction.
    await files.stat("/");
    const lastSlash = normalizedPath.lastIndexOf("/");
    const parentPath =
      lastSlash === 0 ? "/" : normalizedPath.slice(0, lastSlash);
    const name = normalizedPath.slice(lastSlash + 1);
    const sql = this.ctx.storage.sql;
    const existing = sql
      .exec(
        `SELECT type, storage_backend, r2_key
         FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
        normalizedPath,
      )
      .toArray()[0] as
      | { type: string; storage_backend: string; r2_key?: string }
      | undefined;
    if (existing?.type === "directory") {
      throw new Error(
        `EISDIR: cannot replace a directory with a file: ${normalizedPath}`,
      );
    }
    if (existing?.type === "symlink") {
      throw new Error(`ELOOP: refusing to replace symlink: ${normalizedPath}`);
    }
    const cleanupKey =
      existing?.storage_backend === "r2" && existing.r2_key
        ? existing.r2_key
        : undefined;
    if (cleanupKey) {
      this.assertR2GcCapacity([cleanupKey]);
      await this.prearmR2Cleanup(deadlineAt);
    }
    remainingOperationMs(deadlineAt, "Workspace inline write commit");
    const now = Math.floor(Date.now() / 1000);
    this.ctx.storage.transactionSync(() => {
      let ancestor = parentPath;
      const ancestors: string[] = [];
      while (ancestor !== "/") {
        ancestors.push(ancestor);
        const slash = ancestor.lastIndexOf("/");
        ancestor = slash === 0 ? "/" : ancestor.slice(0, slash);
      }
      for (const directory of ancestors.reverse()) {
        const prior = sql
          .exec(
            `SELECT type FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
            directory,
          )
          .toArray()[0] as { type: string } | undefined;
        if (prior && prior.type !== "directory") {
          throw new Error(
            `ENOTDIR: path component is not a directory: ${directory}`,
          );
        }
        if (prior) continue;
        const slash = directory.lastIndexOf("/");
        sql.exec(
          `INSERT INTO ${WORKSPACE_STORE_TABLE}
             (path, parent_path, name, type, size, created_at, modified_at)
           VALUES (?, ?, ?, 'directory', 0, ?, ?)`,
          directory,
          slash === 0 ? "/" : directory.slice(0, slash),
          directory.slice(slash + 1),
          now,
          now,
        );
      }
      sql.exec(
        `INSERT INTO ${WORKSPACE_STORE_TABLE}
          (path, parent_path, name, type, mime_type, size,
           storage_backend, r2_key, target, content_encoding, content,
           created_at, modified_at)
         VALUES (?, ?, ?, 'file', ?, ?, 'inline', NULL, NULL, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           type = 'file',
           mime_type = excluded.mime_type,
           size = excluded.size,
           storage_backend = 'inline',
           r2_key = NULL,
           target = NULL,
           content_encoding = excluded.content_encoding,
           content = excluded.content,
           modified_at = excluded.modified_at`,
        normalizedPath,
        parentPath,
        name,
        mimeType,
        size,
        contentEncoding,
        content,
        now,
        now,
      );
      if (cleanupKey) {
        sql.exec(
          `INSERT INTO ${WORKSPACE_R2_GC_TABLE}
             (r2_key, owner, phase, eligible_at)
           VALUES (?, NULL, 'delete', ?)
           ON CONFLICT(r2_key) DO UPDATE SET
             owner = NULL, phase = 'delete', eligible_at = excluded.eligible_at`,
          cleanupKey,
          Date.now(),
        );
      }
    });
  }

  async editTextFile(
    path: string,
    edits: TextEdit[],
  ): Promise<WorkspaceEditFileResponse> {
    return this.withFileMutationQueue("workspace", path, () =>
      this.editTextFileIn(this.workspace, path, edits),
    );
  }

  async projectEditTextFile(
    path: string,
    edits: TextEdit[],
  ): Promise<WorkspaceEditFileResponse> {
    return this.withFileMutationQueue("project", path, () =>
      this.editTextFileIn(this.projectWorkspace, path, edits),
    );
  }

  private async editTextFileIn(
    files: Workspace,
    path: string,
    edits: TextEdit[],
  ): Promise<WorkspaceEditFileResponse> {
    try {
      const normalizedPath = normalizeBoundedWorkspacePath(path);
      const result = await this.readBoundedFileBytes(files, normalizedPath);
      if (!result)
        return {
          success: false,
          error: `File not found: ${path}`,
          code: "ENOENT",
        };
      const decoded = decodeMaybeText(result.bytes);
      if (decoded.isBinary) {
        return {
          success: false,
          error: `Cannot edit binary file: ${path}`,
          code: "EBINARY",
        };
      }
      const applied = applyTextEdits(decoded.content, edits, path);
      let after = applied.after;
      let notice = "";
      if (isNotebookPath(path)) {
        try {
          const normalized = normalizeNotebookJson(after);
          after = normalized.content;
          if (normalized.changed) {
            notice = `Notebook normalized for nbformat: ${normalized.fixes.join("; ")}`;
          }
        } catch (afterError) {
          try {
            normalizeNotebookJson(applied.before);
          } catch {
            const message =
              afterError instanceof Error
                ? afterError.message
                : String(afterError);
            notice = `Notebook is still structurally invalid after this edit: ${message}`;
          }
          if (!notice) throw afterError;
        }
      }
      const details =
        after === applied.after
          ? applied
          : generateTextEditDetails(path, applied.before, after);
      const afterSize = utf8ByteLength(after);
      if (afterSize > WORKSPACE_INLINE_WRITE_MAX_BYTES) {
        throw new WorkspaceFileTooLargeError(
          `Edited files are limited to ${WORKSPACE_INLINE_WRITE_MAX_BYTES} bytes; use streamed adoption for larger files`,
        );
      }
      await this.writeInlineFile(
        files,
        normalizedPath,
        after,
        "utf8",
        result.stat.mimeType ?? "text/plain",
        afterSize,
      );
      return {
        success: true,
        before: applied.before,
        after,
        replacementCount: edits.length,
        usedFuzzyMatch: applied.usedFuzzyMatch,
        diff: details.diff,
        patch: details.patch,
        firstChangedLine: details.firstChangedLine,
        notice,
      };
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) throw error;
      return {
        success: false,
        error: errorMessage(error),
        code:
          error instanceof WorkspaceFileTooLargeError
            ? "E2BIG"
            : error instanceof WorkspaceReadCapacityError
              ? "EBUSY"
              : "EEDIT",
      };
    }
  }

  /**
   * Adopt a large file into the project store by streaming it straight into R2
   * and registering the store's spilled-file metadata row — never buffering the
   * payload in DO memory. This is the only path that supports files larger than
   * an RPC/base64 payload can carry (writeBinaryFile whole-buffers + inflates
   * base64, so it caps well below 32 MiB). The bytes flow VM -> R2 through the
   * migrator's RPC-passed ReadableStream; here we only add the SQL row.
   */
  async projectAdoptR2File(
    path: string,
    stream: ReadableStream<Uint8Array>,
    expectedSize: number,
    contentType?: string,
    expectedSha256?: string,
  ): Promise<WorkspaceAdoptR2FileResponse> {
    if (this.r2AdoptionActive) {
      try {
        this.ctx.abort("Concurrent streamed adoption reset the isolate");
      } catch {
        // Tests may preserve the isolate to assert the fail-fast result.
      }
      cancelUnreadStream(stream, "another R2 adoption is active");
      return {
        success: false,
        error: "Another streamed file adoption is active",
        code: "EBUSY",
      };
    }
    this.r2AdoptionActive = true;
    let operationStarted = false;
    let cancellationTimedOut = false;
    try {
      return await this.withFileMutationQueue("project", path, () => {
        operationStarted = true;
        return this.adoptR2FileInto(
          this.projectWorkspace,
          "project",
          path,
          stream,
          expectedSize,
          contentType,
          expectedSha256,
        );
      });
    } catch (error) {
      if (!operationStarted) {
        try {
          await this.cancelOwnedStream(
            stream,
            Date.now() + WORKSPACE_STREAM_CANCEL_MS,
            "R2 adoption was not admitted",
          );
        } catch (cancelError) {
          cancellationTimedOut =
            cancelError instanceof WorkspaceAdoptTimeoutError;
        }
      } else if (error instanceof WorkspaceAdoptTimeoutError) {
        cancellationTimedOut = true;
      }
      return { success: false, error: errorMessage(error), code: "EBUSY" };
    } finally {
      if (!cancellationTimedOut) this.r2AdoptionActive = false;
    }
  }

  private async adoptR2FileInto(
    store: Workspace,
    scope: FileStoreScope,
    path: string,
    stream: ReadableStream<Uint8Array>,
    expectedSize: number,
    contentType?: string,
    expectedSha256?: string,
  ): Promise<WorkspaceAdoptR2FileResponse> {
    let streamStarted = false;
    let stagedKey: string | undefined;
    let committed = false;
    try {
      const normalized = normalizeBoundedWorkspacePath(path);
      if (normalized === "/") {
        return {
          success: false,
          error: "Cannot adopt an R2 object as the root directory",
          code: "EISDIR",
        };
      }
      if (!this.env.R2_BUCKET) {
        return {
          success: false,
          error: "R2 bucket is not configured",
          code: "ENOR2",
        };
      }
      if (
        !Number.isSafeInteger(expectedSize) ||
        expectedSize < 0 ||
        expectedSize > Number.MAX_SAFE_INTEGER
      ) {
        return {
          success: false,
          error: `Adopting a file requires its exact byte size; got ${expectedSize}`,
          code: "ESIZE",
        };
      }
      if (
        expectedSha256 !== undefined &&
        !/^[a-f0-9]{64}$/.test(expectedSha256)
      ) {
        return {
          success: false,
          error: "Adopting a verified file requires a lowercase SHA-256 digest",
          code: "EHASH",
        };
      }
      const deadlineAt = Date.now() + WORKSPACE_R2_ADOPT_MS;
      this.assertNoUnsettledR2Effects();
      const mimeType = normalizeContentType(contentType);
      const lastSlash = normalized.lastIndexOf("/");
      const parentPath = lastSlash === 0 ? "/" : normalized.slice(0, lastSlash);
      const name = normalized.slice(lastSlash + 1);
      const key = `${fileStoreR2Prefix(scope, this.ctx.id.toString())}/adopt/${crypto.randomUUID()}`;
      // Materialize the store's table + ancestor directory rows using the
      // store's own logic (this also runs its lazy ensureInit). We then insert
      // the file row directly so the GB payload is never held in memory.
      if (parentPath === "/") {
        await store.stat("/");
      } else {
        await store.mkdir(parentPath, { recursive: true });
      }

      const sql = this.ctx.storage.sql;
      const existing = sql
        .exec(
          `SELECT type, storage_backend, r2_key FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
          normalized,
        )
        .toArray()[0] as
        | { type?: string; storage_backend?: string; r2_key?: string }
        | undefined;
      if (existing?.type === "directory") {
        return {
          success: false,
          error: `Cannot replace a directory with an adopted file: ${normalized}`,
          code: "EISDIR",
        };
      }
      const priorR2Key =
        existing?.storage_backend === "r2" && existing.r2_key
          ? existing.r2_key
          : undefined;
      this.assertR2GcCapacity(priorR2Key ? [key, priorR2Key] : [key]);

      const copyTimeoutMs = remainingOperationMs(
        deadlineAt,
        "Streamed R2 adoption",
      );
      stagedKey = key;
      const latePutEligibleAt = deadlineAt + WORKSPACE_R2_LATE_PUT_GRACE_MS;
      await this.prearmR2Cleanup(deadlineAt, latePutEligibleAt);
      this.trackR2Cleanup(key, this.r2CleanupOwner, latePutEligibleAt);
      let dispatchTimeoutMs: number;
      try {
        dispatchTimeoutMs = remainingOperationMs(
          deadlineAt,
          "Streamed R2 adoption handoff",
        );
      } catch (error) {
        this.markR2CleanupSettled(key);
        throw error;
      }
      streamStarted = true;
      const measured = await streamToR2(
        this.env.R2_BUCKET,
        key,
        stream,
        mimeType,
        expectedSize,
        expectedSha256,
        undefined,
        Math.min(copyTimeoutMs, dispatchTimeoutMs),
        () => this.markR2CleanupSettled(key),
      );
      if (
        Number.isFinite(expectedSize) &&
        expectedSize >= 0 &&
        measured.size !== expectedSize
      ) {
        await this.drainTargetedR2Cleanup([key], deadlineAt);
        return {
          success: false,
          error: `Adopted object size ${measured.size} does not match the reported source size ${expectedSize}`,
          code: "ESIZE",
        };
      }

      const now = Math.floor(Date.now() / 1000);
      this.ctx.storage.transactionSync(() => {
        sql.exec(
          `INSERT INTO ${WORKSPACE_STORE_TABLE}
              (path, parent_path, name, type, mime_type, size,
               storage_backend, r2_key, content_encoding, content, created_at, modified_at)
            VALUES (?, ?, ?, 'file', ?, ?, 'r2', ?, 'base64', NULL, ?, ?)
            ON CONFLICT(path) DO UPDATE SET
              type              = 'file',
              mime_type         = excluded.mime_type,
              size              = excluded.size,
              storage_backend   = 'r2',
              r2_key            = excluded.r2_key,
              content_encoding  = 'base64',
              content           = NULL,
              modified_at       = excluded.modified_at`,
          normalized,
          parentPath,
          name,
          mimeType,
          measured.size,
          key,
          now,
          now,
        );
        sql.exec(`DELETE FROM ${WORKSPACE_R2_GC_TABLE} WHERE r2_key = ?`, key);
        if (priorR2Key && priorR2Key !== key) {
          sql.exec(
            `INSERT INTO ${WORKSPACE_R2_GC_TABLE}
                 (r2_key, owner, phase, eligible_at)
               VALUES (?, NULL, 'delete', ?)
               ON CONFLICT(r2_key) DO UPDATE SET
                 owner = NULL, phase = 'delete', eligible_at = excluded.eligible_at`,
            priorR2Key,
            Date.now(),
          );
        }
      });
      committed = true;
      return { success: true, size: measured.size };
    } catch (error) {
      let cleanupTimeout: WorkspaceAdoptTimeoutError | undefined;
      if (stagedKey && !committed) {
        try {
          await this.drainTargetedR2Cleanup(
            [stagedKey],
            Date.now() + WORKSPACE_R2_DELETE_MS,
          );
        } catch (cleanupError) {
          if (cleanupError instanceof WorkspaceAdoptTimeoutError) {
            cleanupTimeout = cleanupError;
          }
        }
      }
      if (error instanceof WorkspaceAdoptTimeoutError) {
        this.abortTimeoutOnce(
          error,
          "Streamed R2 adoption exceeded its absolute deadline",
        );
      } else if (cleanupTimeout) {
        this.abortTimeoutOnce(
          cleanupTimeout,
          "Streamed R2 adoption cleanup exceeded its deadline",
        );
      }
      return { success: false, error: errorMessage(error), code: "EADOPT" };
    } finally {
      if (!streamStarted) {
        await this.cancelOwnedStream(
          stream,
          Date.now() + WORKSPACE_STREAM_CANCEL_MS,
          "R2 adoption rejected before streaming",
        );
      }
    }
  }

  async listFiles(
    path: string,
    options: WorkspaceListOptions = {},
  ): Promise<WorkspaceListResponse> {
    return this.listFilesFrom(this.workspace, path, options);
  }

  async projectListFiles(
    path: string,
    options: WorkspaceListOptions = {},
  ): Promise<WorkspaceListResponse> {
    return this.listFilesFrom(this.projectWorkspace, path, options);
  }

  private async listFilesFrom(
    filesStore: Workspace,
    path: string,
    options: WorkspaceListOptions = {},
  ): Promise<WorkspaceListResponse> {
    let root = "/";
    const includeHidden = options.includeHidden === true;
    const limit = Math.max(
      1,
      Math.min(WORKSPACE_LIST_MAX_ENTRIES, Math.floor(options.limit ?? 10_000)),
    );
    const bounds = normalizeWorkspaceTreeBounds(options.bounds);

    try {
      root = normalizeBoundedWorkspacePath(path);
      const stat = await filesStore.stat(root);
      if (!stat) throw new Error(`Path not found: ${root}`);
      const files: WorkspaceListEntry[] = [];
      const counters = emptyWorkspaceTreeCounters();
      if (stat.type === "file") {
        countWorkspaceTreeEntry(stat, root, root, counters, bounds);
        files.push(toListEntry(stat, root, root));
      } else {
        await collectWorkspaceEntries(filesStore, root, root, files, {
          recursive: options.recursive === true,
          includeHidden,
          limit,
          bounds,
          counters,
          completeForBounds: options.bounds !== undefined,
          readPage: (directory, after, pageLimit) =>
            this.readWorkspaceDirectoryPage(directory, after, pageLimit),
        });
      }
      return {
        success: true,
        files,
        count: files.length,
        path: root,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      return {
        success: false,
        files: [],
        count: 0,
        path: root,
        error: errorMessage(error),
      };
    }
  }

  private readWorkspaceDirectoryPage(
    directory: string,
    after: WorkspaceDirectoryCursor | undefined,
    limit: number,
  ): FileInfo[] {
    if (!this.workspaceListIndexReady) {
      this.ctx.storage.sql.exec(
        `CREATE INDEX IF NOT EXISTS ${WORKSPACE_STORE_TABLE}_parent_order
         ON ${WORKSPACE_STORE_TABLE}(parent_path, type, name, path)`,
      );
      this.workspaceListIndexReady = true;
    }
    const rows = (
      after
        ? this.ctx.storage.sql.exec(
            `SELECT path, name, type, mime_type, size, created_at, modified_at
             FROM ${WORKSPACE_STORE_TABLE}
             WHERE parent_path = ?
               AND (type, name, path) > (?, ?, ?)
             ORDER BY type, name, path
             LIMIT ?`,
            directory,
            after.type,
            after.name,
            after.path,
            limit,
          )
        : this.ctx.storage.sql.exec(
            `SELECT path, name, type, mime_type, size, created_at, modified_at
             FROM ${WORKSPACE_STORE_TABLE}
             WHERE parent_path = ?
             ORDER BY type, name, path
             LIMIT ?`,
            directory,
            limit,
          )
    ).toArray() as Array<{
      path: string;
      name: string;
      type: FileInfo["type"];
      mime_type?: string;
      size: number;
      created_at: number;
      modified_at: number;
    }>;
    return rows.map((row) => ({
      path: row.path,
      name: row.name,
      type: row.type,
      mimeType: row.mime_type ?? "application/octet-stream",
      size: row.size,
      createdAt: row.created_at * 1_000,
      updatedAt: row.modified_at * 1_000,
    }));
  }

  async mkdir(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    return this.withFileMutationQueue("workspace", path, () =>
      this.mkdirIn(this.workspace, path, options),
    );
  }

  async projectMkdir(
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    return this.withFileMutationQueue("project", path, () =>
      this.mkdirIn(this.projectWorkspace, path, options),
    );
  }

  private async mkdirIn(
    files: Workspace,
    path: string,
    options: { recursive?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    try {
      const normalized = normalizeBoundedWorkspacePath(path);
      await files.mkdir(normalized, {
        recursive: options.recursive === true,
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: errorMessage(error), code: "EMKDIR" };
    }
  }

  async deleteFile(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    return this.withFileMutationQueue("workspace", path, () =>
      this.deleteFileBounded(this.workspace, path, options),
    );
  }

  async projectDeleteFile(
    path: string,
    options: { recursive?: boolean; force?: boolean } = {},
  ): Promise<WorkspaceWriteResponse> {
    return this.withFileMutationQueue("project", path, () =>
      this.deleteFileBounded(this.projectWorkspace, path, options),
    );
  }

  private async deleteFileBounded(
    files: Workspace,
    path: string,
    options: { recursive?: boolean; force?: boolean },
  ): Promise<WorkspaceWriteResponse> {
    try {
      const normalized = normalizeBoundedWorkspacePath(path);
      const deadlineAt = Date.now() + WORKSPACE_R2_ADOPT_MS;
      this.assertNoUnsettledR2Effects();
      await files.stat("/");
      const target = this.ctx.storage.sql
        .exec(
          `SELECT path, type, storage_backend, r2_key
           FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
          normalized,
        )
        .toArray()[0] as
        | {
            path: string;
            type: string;
            storage_backend?: string;
            r2_key?: string;
          }
        | undefined;
      if (!target) {
        return options.force === true
          ? { success: true }
          : { success: false, error: "Path not found", code: "ENOENT" };
      }

      const pattern = `${escapeSqlLikePattern(normalized)}/%`;
      const descendants = (
        normalized === "/"
          ? this.ctx.storage.sql.exec(
              `SELECT path, type, storage_backend, r2_key
               FROM ${WORKSPACE_STORE_TABLE} WHERE path <> '/'
               ORDER BY path LIMIT ?`,
              PROJECT_RECURSIVE_DELETE_MAX_ENTRIES + 1,
            )
          : this.ctx.storage.sql.exec(
              `SELECT path, type, storage_backend, r2_key
               FROM ${WORKSPACE_STORE_TABLE}
               WHERE path LIKE ? ESCAPE '\\'
               ORDER BY path LIMIT ?`,
              pattern,
              PROJECT_RECURSIVE_DELETE_MAX_ENTRIES + 1,
            )
      ).toArray() as Array<{
        path: string;
        type: string;
        storage_backend?: string;
        r2_key?: string;
      }>;
      const rows = normalized === "/" ? descendants : [target, ...descendants];
      const metadataBytes = rows.reduce(
        (total, row) =>
          total +
          utf8ByteLength(String(row.path)) +
          (row.r2_key ? utf8ByteLength(String(row.r2_key)) : 0),
        0,
      );
      if (
        descendants.length > PROJECT_RECURSIVE_DELETE_MAX_ENTRIES ||
        !Number.isSafeInteger(metadataBytes) ||
        metadataBytes > WORKSPACE_RECURSIVE_DELETE_MAX_METADATA_BYTES
      ) {
        return {
          success: false,
          error: `Recursive delete exceeds its ${PROJECT_RECURSIVE_DELETE_MAX_ENTRIES}-entry or ${WORKSPACE_RECURSIVE_DELETE_MAX_METADATA_BYTES}-byte metadata limit`,
          code: "E2BIG",
        };
      }
      if (descendants.length > 0 && options.recursive !== true) {
        return {
          success: false,
          error: `Directory is not empty: ${normalized}`,
          code: "ENOTEMPTY",
        };
      }
      const cleanupKeys = new Set<string>();
      for (const row of rows) {
        if (row.storage_backend !== "r2" || !row.r2_key) continue;
        if (utf8ByteLength(row.r2_key) > 1_024) {
          return {
            success: false,
            error: "Workspace file has an invalid R2 key",
            code: "EINVAL",
          };
        }
        cleanupKeys.add(row.r2_key);
      }
      if (cleanupKeys.size > 0) {
        this.assertR2GcCapacity(cleanupKeys);
        await this.prearmR2Cleanup(deadlineAt);
      }
      remainingOperationMs(deadlineAt, "Workspace file deletion commit");
      this.ctx.storage.transactionSync(() => {
        for (const key of cleanupKeys) {
          this.ctx.storage.sql.exec(
            `INSERT INTO ${WORKSPACE_R2_GC_TABLE}
               (r2_key, owner, phase, eligible_at)
             VALUES (?, NULL, 'delete', ?)
             ON CONFLICT(r2_key) DO UPDATE SET
               owner = NULL, phase = 'delete', eligible_at = excluded.eligible_at`,
            key,
            Date.now(),
          );
        }
        if (normalized === "/") {
          this.ctx.storage.sql.exec(
            `DELETE FROM ${WORKSPACE_STORE_TABLE} WHERE path <> '/'`,
          );
        } else if (options.recursive === true) {
          this.ctx.storage.sql.exec(
            `DELETE FROM ${WORKSPACE_STORE_TABLE}
             WHERE path = ? OR path LIKE ? ESCAPE '\\'`,
            normalized,
            pattern,
          );
        } else {
          this.ctx.storage.sql.exec(
            `DELETE FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
            normalized,
          );
        }
      });
      return { success: true };
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) {
        this.abortTimeoutOnce(
          error,
          "Workspace file deletion exceeded its absolute deadline",
        );
      }
      return { success: false, error: errorMessage(error), code: "EDELETE" };
    }
  }

  private assertNoSnapshotCleanupPending(): void {
    const pending =
      this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_GC_KEY) ?? [];
    if (pending.length > 0) {
      throw new Error(
        "Project source snapshot cleanup is pending; retry deleting snapshots first",
      );
    }
  }

  private async deleteR2KeysOrAbort(
    keys: Iterable<string>,
    reason: string,
    deadlineAt = Date.now() + PROJECT_SNAPSHOT_OPERATION_MS,
  ): Promise<number> {
    const unique = [...new Set(keys)];
    let deleted = 0;
    for (
      let offset = 0;
      offset < unique.length;
      offset += PROJECT_R2_DELETE_BATCH
    ) {
      const batch = unique.slice(offset, offset + PROJECT_R2_DELETE_BATCH);
      let timeoutMs: number;
      try {
        timeoutMs = Math.min(
          WORKSPACE_R2_DELETE_MS,
          remainingOperationMs(deadlineAt, reason),
        );
      } catch {
        this.ctx.abort(reason);
        throw new Error(reason);
      }
      if (!(await settleR2Delete(this.env.R2_BUCKET, batch, timeoutMs))) {
        this.ctx.abort(reason);
        throw new Error(reason);
      }
      deleted += batch.length;
    }
    return deleted;
  }

  private async snapshotBlobIsValid(
    blobKey: string,
    expectedSize: number,
    expectedSha256: string,
    deadlineAt: number,
  ): Promise<"missing" | "valid" | "invalid"> {
    const metadata = await withOperationDeadline(
      () => this.env.R2_BUCKET.head(blobKey),
      deadlineAt,
      "Project source snapshot blob lookup",
    );
    if (!metadata) return "missing";
    if (metadata.size !== expectedSize) return "invalid";
    // Snapshot blobs are content-addressed and every writer asks R2 to verify
    // the SHA-256 while storing this same digest in immutable object metadata.
    // A HEAD is therefore sufficient for blobs produced by this runtime (and
    // by the previous implementation), avoiding a full-project re-download on
    // every unchanged deploy. Fall back to a streamed hash only for legacy
    // objects that predate the metadata contract.
    if (
      metadata.customMetadata?.type === "project-source-snapshot" &&
      metadata.customMetadata.sha256 === expectedSha256
    ) {
      return "valid";
    }
    const object = await withOperationDeadline(
      () => this.env.R2_BUCKET.get(blobKey),
      deadlineAt,
      "Legacy project source snapshot blob lookup",
    );
    if (!object) return "missing";
    const body = object.body;
    let bodyTransferred = false;
    try {
      if (object.size !== expectedSize) {
        return "invalid";
      }
      const timeoutMs = remainingOperationMs(
        deadlineAt,
        "Project source snapshot hash",
      );
      bodyTransferred = true;
      return (await sha256StreamHex(body, timeoutMs)) === expectedSha256
        ? "valid"
        : "invalid";
    } finally {
      if (!bodyTransferred) {
        await this.cancelOwnedStream(
          body,
          deadlineAt,
          "snapshot blob validation did not consume body",
        );
      }
    }
  }

  private ensureR2GcTable(): void {
    if (this.r2GcTableReady) return;
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS ${WORKSPACE_R2_GC_TABLE} (
         r2_key TEXT PRIMARY KEY,
         owner TEXT,
         phase TEXT NOT NULL DEFAULT 'delete',
         eligible_at INTEGER NOT NULL DEFAULT 0
       ) WITHOUT ROWID`,
    );
    const columns = new Set(
      this.ctx.storage.sql
        .exec(`PRAGMA table_info(${WORKSPACE_R2_GC_TABLE})`)
        .toArray()
        .map((row) => String(row.name)),
    );
    if (!columns.has("phase")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE ${WORKSPACE_R2_GC_TABLE}
         ADD COLUMN phase TEXT NOT NULL DEFAULT 'delete'`,
      );
    }
    if (!columns.has("eligible_at")) {
      this.ctx.storage.sql.exec(
        `ALTER TABLE ${WORKSPACE_R2_GC_TABLE}
         ADD COLUMN eligible_at INTEGER NOT NULL DEFAULT 0`,
      );
    }
    this.r2GcTableReady = true;
  }

  private assertR2GcCapacity(keys: Iterable<string>): void {
    this.ensureR2GcTable();
    const unique = [...new Set(keys)];
    const current = this.r2CleanupCount();
    if (current + unique.length <= WORKSPACE_R2_GC_MAX_KEYS) return;
    let additions = 0;
    for (const key of unique) {
      const exists =
        this.ctx.storage.sql
          .exec(
            `SELECT 1 FROM ${WORKSPACE_R2_GC_TABLE} WHERE r2_key = ? LIMIT 1`,
            key,
          )
          .toArray().length > 0;
      if (!exists) additions += 1;
      if (current + additions > WORKSPACE_R2_GC_MAX_KEYS) {
        throw new Error(
          `Workspace R2 cleanup exceeds its ${WORKSPACE_R2_GC_MAX_KEYS}-key durable limit`,
        );
      }
    }
  }

  private assertR2GcAdditionalCapacity(additionalKeys: number): void {
    if (
      !Number.isSafeInteger(additionalKeys) ||
      additionalKeys < 0 ||
      this.r2CleanupCount() + additionalKeys > WORKSPACE_R2_GC_MAX_KEYS
    ) {
      throw new Error(
        `Workspace R2 cleanup exceeds its ${WORKSPACE_R2_GC_MAX_KEYS}-key durable limit`,
      );
    }
  }

  private trackR2Cleanup(
    key: string,
    owner: string | null,
    eligibleAt?: number,
    capacityChecked = false,
  ): void {
    if (!capacityChecked) this.assertR2GcCapacity([key]);
    const now = Date.now();
    const boundedEligibleAt =
      eligibleAt ??
      (owner === null
        ? now
        : now + WORKSPACE_R2_ADOPT_MS + WORKSPACE_R2_LATE_PUT_GRACE_MS);
    this.ctx.storage.sql.exec(
      `INSERT INTO ${WORKSPACE_R2_GC_TABLE}
         (r2_key, owner, phase, eligible_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(r2_key) DO UPDATE SET
         owner = excluded.owner,
         phase = excluded.phase,
         eligible_at = excluded.eligible_at`,
      key,
      owner,
      owner === null ? "delete" : "pending-put",
      owner === null ? now : boundedEligibleAt,
    );
  }

  private markR2CleanupSettled(key: string): void {
    try {
      const updated = this.ctx.storage.sql.exec(
        `UPDATE ${WORKSPACE_R2_GC_TABLE}
         SET owner = NULL, phase = 'delete', eligible_at = ?
         WHERE r2_key = ? AND owner = ?`,
        Date.now(),
        key,
        this.r2CleanupOwner,
      );
      if (updated.rowsWritten === 0) return;
      if (this.r2CleanupAlarmRearmQueued) return;
      this.r2CleanupAlarmRearmQueued = true;
      this.ctx.waitUntil(
        this.ctx.storage
          .setAlarm(Date.now() + WORKSPACE_R2_GC_ALARM_RETRY_MS)
          .catch(() => undefined),
      );
    } catch {
      // A transaction may already have promoted the staged key to live.
    }
  }

  private async prearmR2Cleanup(
    deadlineAt: number,
    alarmAt = Date.now() + WORKSPACE_R2_GC_ALARM_RETRY_MS,
  ): Promise<void> {
    const existing = await withOperationDeadline(
      () => this.ctx.storage.getAlarm(),
      deadlineAt,
      "Workspace R2 cleanup alarm lookup",
    );
    if (existing !== null && existing <= alarmAt) return;
    await withOperationDeadline(
      () => this.ctx.storage.setAlarm(alarmAt),
      deadlineAt,
      "Workspace R2 cleanup alarm pre-arm",
    );
  }

  private async scheduleNextR2CleanupAlarm(deadlineAt: number): Promise<void> {
    this.ensureR2GcTable();
    const now = Date.now();
    const row = this.ctx.storage.sql
      .exec(
        `SELECT MIN(
           CASE
             WHEN phase = 'pending-put' AND owner = ? AND eligible_at <= ?
               THEN ?
             ELSE eligible_at
           END
         ) AS eligible_at
         FROM ${WORKSPACE_R2_GC_TABLE}`,
        this.r2CleanupOwner,
        now,
        now + WORKSPACE_R2_LATE_PUT_GRACE_MS,
      )
      .toArray()[0] as { eligible_at?: number | null } | undefined;
    const eligibleAt = Number(row?.eligible_at ?? now);
    await withOperationDeadline(
      () =>
        this.ctx.storage.setAlarm(
          Math.max(
            now + WORKSPACE_R2_GC_ALARM_RETRY_MS,
            Number.isSafeInteger(eligibleAt) ? eligibleAt : now,
          ),
        ),
      deadlineAt,
      "Workspace R2 cleanup alarm reschedule",
    );
  }

  private r2CleanupCount(): number {
    this.ensureR2GcTable();
    return Number(
      this.ctx.storage.sql
        .exec(`SELECT COUNT(*) AS count FROM ${WORKSPACE_R2_GC_TABLE}`)
        .toArray()[0]?.count ?? 0,
    );
  }

  private assertNoUnsettledR2Effects(): void {
    this.ensureR2GcTable();
    const unsettled = this.ctx.storage.sql
      .exec(
        `SELECT 1 FROM ${WORKSPACE_R2_GC_TABLE}
         WHERE phase <> 'delete' LIMIT 1`,
      )
      .toArray();
    if (unsettled.length > 0) {
      throw new Error(
        "Workspace R2 cleanup is fencing an unsettled PUT; retry after cleanup",
      );
    }
  }

  private commitR2CleanupRows(rows: WorkspaceR2CleanupRow[]): void {
    this.ctx.storage.transactionSync(() => {
      for (const row of rows) {
        if (row.phase === "pending-put") {
          // A foreign owner may have timed out before its PUT settled. The
          // first confirmed delete fences that late completion; retain the row
          // and require a second delete after a full grace interval.
          this.ctx.storage.sql.exec(
            `UPDATE ${WORKSPACE_R2_GC_TABLE}
             SET owner = NULL, phase = 'confirm-delete', eligible_at = ?
             WHERE r2_key = ? AND phase = 'pending-put' AND owner = ?`,
            Date.now() + WORKSPACE_R2_LATE_PUT_GRACE_MS,
            row.r2_key,
            row.owner,
          );
        } else {
          this.ctx.storage.sql.exec(
            `DELETE FROM ${WORKSPACE_R2_GC_TABLE}
             WHERE r2_key = ? AND phase = ?`,
            row.r2_key,
            row.phase,
          );
        }
      }
    });
  }

  private r2CleanupKeysRemain(keys: string[]): boolean {
    for (
      let offset = 0;
      offset < keys.length;
      offset += PROJECT_R2_DELETE_BATCH
    ) {
      const batch = keys.slice(offset, offset + PROJECT_R2_DELETE_BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      if (
        this.ctx.storage.sql
          .exec(
            `SELECT 1 FROM ${WORKSPACE_R2_GC_TABLE}
             WHERE r2_key IN (${placeholders}) LIMIT 1`,
            ...batch,
          )
          .toArray().length > 0
      ) {
        return true;
      }
    }
    return false;
  }

  /**
   * Best-effort failure cleanup for exactly the keys staged by one operation.
   * Ordinary committed-delete backlog remains alarm-owned, so an unrelated R2
   * outage cannot consume this operation's cleanup deadline or I/O budget.
   */
  private async drainTargetedR2Cleanup(
    keys: Iterable<string>,
    deadlineAt: number,
  ): Promise<boolean> {
    this.ensureR2GcTable();
    const unique = [...new Set(keys)];
    if (unique.length === 0) return true;
    if (unique.length > PROJECT_SNAPSHOT_MAX_FILES) {
      throw new Error("Targeted workspace R2 cleanup exceeds its key bound");
    }

    for (
      let offset = 0;
      offset < unique.length;
      offset += PROJECT_R2_DELETE_BATCH
    ) {
      const batch = unique.slice(offset, offset + PROJECT_R2_DELETE_BATCH);
      const placeholders = batch.map(() => "?").join(", ");
      const now = Date.now();
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT r2_key, owner, phase FROM ${WORKSPACE_R2_GC_TABLE}
           WHERE r2_key IN (${placeholders})
             AND eligible_at <= ?
             AND NOT (phase = 'pending-put' AND owner = ?)
           ORDER BY r2_key`,
          ...batch,
          now,
          this.r2CleanupOwner,
        )
        .toArray() as unknown as WorkspaceR2CleanupRow[];
      if (rows.length === 0) continue;

      let timeoutMs: number;
      try {
        timeoutMs = Math.min(
          WORKSPACE_R2_DELETE_MS,
          remainingOperationMs(deadlineAt, "Targeted workspace R2 cleanup"),
        );
      } catch {
        return false;
      }
      const outcome = await settleR2DeleteOutcome(
        this.env.R2_BUCKET,
        rows.map((row) => row.r2_key),
        timeoutMs,
      );
      if (outcome === "timed-out") {
        throw new WorkspaceAdoptTimeoutError(
          "Targeted workspace R2 cleanup exceeded its deadline",
        );
      }
      if (outcome === "rejected") return false;
      this.commitR2CleanupRows(rows);
    }
    return !this.r2CleanupKeysRemain(unique);
  }

  private async drainR2Cleanup(
    deadlineAt: number,
    maxBatches = Number.MAX_SAFE_INTEGER,
  ): Promise<boolean> {
    this.ensureR2GcTable();
    let batches = 0;
    while (true) {
      const now = Date.now();
      const rows = this.ctx.storage.sql
        .exec(
          `SELECT r2_key, owner, phase FROM ${WORKSPACE_R2_GC_TABLE}
           WHERE eligible_at <= ?
             AND NOT (phase = 'pending-put' AND owner = ?)
           ORDER BY r2_key LIMIT ?`,
          now,
          this.r2CleanupOwner,
          PROJECT_R2_DELETE_BATCH,
        )
        .toArray() as unknown as WorkspaceR2CleanupRow[];
      if (rows.length === 0) {
        return (
          this.ctx.storage.sql
            .exec(`SELECT r2_key FROM ${WORKSPACE_R2_GC_TABLE} LIMIT 1`)
            .toArray().length === 0
        );
      }

      let timeoutMs: number;
      try {
        timeoutMs = Math.min(
          WORKSPACE_R2_DELETE_MS,
          remainingOperationMs(deadlineAt, "Restored project source cleanup"),
        );
      } catch {
        return false;
      }
      const outcome = await settleR2DeleteOutcome(
        this.env.R2_BUCKET,
        rows.map((row) => row.r2_key),
        timeoutMs,
      );
      if (outcome === "timed-out") {
        throw new WorkspaceAdoptTimeoutError(
          "Workspace R2 cleanup exceeded its deadline",
        );
      }
      if (outcome === "rejected") {
        return false;
      }
      this.commitR2CleanupRows(rows);
      batches += 1;
      if (batches >= maxBatches) return this.r2CleanupCount() === 0;
    }
  }

  async projectDrainR2Cleanup(): Promise<{
    success: boolean;
    pending: number;
  }> {
    return this.withFileMutationQueue("project", "/", async () => {
      const deadlineAt = Date.now() + WORKSPACE_R2_ADOPT_MS;
      const success = await this.drainR2Cleanup(deadlineAt);
      const pending = this.r2CleanupCount();
      if (success && pending === 0) {
        await withOperationDeadline(
          () => this.ctx.storage.deleteAlarm(),
          deadlineAt,
          "Workspace R2 cleanup alarm clear",
        );
      } else if (pending > 0) {
        await this.scheduleNextR2CleanupAlarm(deadlineAt);
      }
      return { success: success && pending === 0, pending };
    });
  }

  private async putSnapshotBlob(
    blobKey: string,
    source: ReadableStream<Uint8Array>,
    contentType: string,
    size: number,
    sha256: string,
    timeoutMs: number,
    onSettled: () => void,
  ): Promise<void> {
    const copied = await streamToR2(
      this.env.R2_BUCKET,
      blobKey,
      source,
      contentType,
      size,
      sha256,
      { type: "project-source-snapshot", sha256 },
      timeoutMs,
      onSettled,
    );
    if (copied.size !== size) {
      throw new Error("Project source snapshot copy size mismatch");
    }
  }

  private planSnapshotRetention(
    snapshot: ProjectSourceSnapshot,
    deadlineAt: number,
  ): {
    index: string[];
    evictedIds: string[];
    cleanupKeys: Set<string>;
  } {
    const current =
      this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_INDEX_KEY) ?? [];
    if (current.length > PROJECT_SNAPSHOT_MAX_COUNT) {
      throw new Error(
        "Project source snapshot index exceeds its durable bound",
      );
    }
    for (const id of current) requireSnapshotId(id);
    const ordered = [
      snapshot.id,
      ...current.filter((existing) => existing !== snapshot.id),
    ];
    const index = ordered.slice(0, PROJECT_SNAPSHOT_MAX_COUNT);
    const evictedIds = ordered.slice(PROJECT_SNAPSHOT_MAX_COUNT);
    if (evictedIds.length === 0) {
      return { index, evictedIds, cleanupKeys: new Set() };
    }

    // One new snapshot can evict at most one bounded manifest. Keep only that
    // manifest's candidate keys in memory, then scan retained manifests one at
    // a time. This avoids an unbounded global reference set while preserving
    // content-addressed blobs shared by any retained snapshot.
    const cleanupKeys = new Set<string>();
    for (const evictedId of evictedIds) {
      remainingOperationMs(deadlineAt, "Project snapshot retention planning");
      const stored = this.ctx.storage.kv.get<ProjectSourceSnapshot>(
        `${PROJECT_SNAPSHOT_PREFIX}${evictedId}`,
      );
      if (!stored) continue;
      const evicted = validateProjectSourceSnapshot(
        stored,
        evictedId,
        this.ctx.id.toString(),
      );
      for (const entry of evicted.entries) cleanupKeys.add(entry.blobKey);
    }

    const removeRetainedReferences = (retained: ProjectSourceSnapshot) => {
      for (const entry of retained.entries) cleanupKeys.delete(entry.blobKey);
    };
    if (index.includes(snapshot.id)) removeRetainedReferences(snapshot);
    for (const retainedId of index) {
      if (cleanupKeys.size === 0) break;
      if (retainedId === snapshot.id) continue;
      remainingOperationMs(deadlineAt, "Project snapshot retention scan");
      const stored = this.ctx.storage.kv.get<ProjectSourceSnapshot>(
        `${PROJECT_SNAPSHOT_PREFIX}${retainedId}`,
      );
      if (!stored) continue;
      removeRetainedReferences(
        validateProjectSourceSnapshot(
          stored,
          retainedId,
          this.ctx.id.toString(),
        ),
      );
    }
    return { index, evictedIds, cleanupKeys };
  }

  async projectCreateSourceSnapshot(
    input: { message?: unknown } = {},
  ): Promise<ProjectSourceSnapshot> {
    return this.withFileMutationQueue("project", "/", async () =>
      this.abortOnSnapshotTimeout(
        () => this.createProjectSourceSnapshot(input),
        "Project source snapshot creation timed out",
      ),
    );
  }

  private async abortOnSnapshotTimeout<T>(
    operation: () => Promise<T>,
    reason: string,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof WorkspaceAdoptTimeoutError) {
        this.abortTimeoutOnce(error, reason);
      }
      throw error;
    }
  }

  private async createProjectSourceSnapshot(
    input: { message?: unknown } = {},
  ): Promise<ProjectSourceSnapshot> {
    this.assertNoSnapshotCleanupPending();
    const deadlineAt = Date.now() + PROJECT_SNAPSHOT_OPERATION_MS;
    this.assertNoUnsettledR2Effects();
    const message =
      typeof input.message === "string" && input.message.trim()
        ? input.message.trim().slice(0, 240)
        : undefined;
    const listing = await withOperationDeadline(
      () =>
        this.projectListFiles("/", {
          recursive: true,
          includeHidden: true,
          limit: 50_000,
          bounds: {
            maxEntries: WORKSPACE_LIST_MAX_ENTRIES,
            maxFiles: WORKSPACE_LIST_MAX_ENTRIES,
            maxPathBytes: WORKSPACE_LIST_MAX_PATH_BYTES,
            maxFileBytes: PROJECT_SNAPSHOT_MAX_FILE_BYTES,
            maxTotalBytes: PROJECT_SNAPSHOT_MAX_TOTAL_BYTES,
          },
        }),
      deadlineAt,
      "Project source snapshot listing",
    );
    if (!listing.success)
      throw new Error(listing.error || "Failed to list project files");

    let candidateFileCount = 0;
    for (const entry of listing.files) {
      if (entry.type !== "file") continue;
      const path = normalizeProjectSnapshotPath(entry.absolutePath);
      if (!path || shouldIgnoreProjectSnapshotPath(path)) continue;
      candidateFileCount += 1;
      if (candidateFileCount > PROJECT_SNAPSHOT_MAX_FILES) {
        throw new Error(
          `Project source snapshot exceeds the ${PROJECT_SNAPSHOT_MAX_FILES} file limit`,
        );
      }
    }
    const latePutEligibleAt = deadlineAt + WORKSPACE_R2_LATE_PUT_GRACE_MS;

    const entries: ProjectSourceSnapshotEntry[] = [];
    const createdBlobKeys = new Set<string>();
    const reusedBlobKeysPendingDelete = new Set<string>();
    let stagingCleanupPrearmed = false;
    let totalBytes = 0;
    let committed = false;
    try {
      for (const entry of listing.files) {
        remainingOperationMs(deadlineAt, "Project source snapshot creation");
        if (entry.type !== "file") continue;
        const path = normalizeProjectSnapshotPath(entry.absolutePath);
        if (!path || shouldIgnoreProjectSnapshotPath(path)) continue;
        if (entries.length >= PROJECT_SNAPSHOT_MAX_FILES) {
          throw new Error(
            `Project source snapshot exceeds the ${PROJECT_SNAPSHOT_MAX_FILES} file limit`,
          );
        }

        const nextTotalBytes = totalBytes + entry.size;
        if (
          !Number.isSafeInteger(nextTotalBytes) ||
          nextTotalBytes > PROJECT_SNAPSHOT_MAX_TOTAL_BYTES
        ) {
          throw new Error(
            `Project source snapshot exceeds the ${PROJECT_SNAPSHOT_MAX_TOTAL_BYTES} byte limit`,
          );
        }

        // R2-spilled files (including GB-scale adopted ones) must never be
        // buffered in the isolate: hash and copy them through bounded streams.
        const spilled = this.ctx.storage.sql
          .exec(
            `SELECT storage_backend, r2_key FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
            `/${path}`,
          )
          .toArray()[0] as
          | { storage_backend?: string; r2_key?: string }
          | undefined;
        let size: number;
        let sha256: string;
        let contentType = entry.mimeType;
        let copySource: ReadableStream<Uint8Array> | undefined;
        let spilledSourceKey: string | undefined;

        if (spilled?.storage_backend === "r2" && spilled.r2_key) {
          spilledSourceKey = spilled.r2_key;
          const source = await withOperationDeadline(
            () => this.env.R2_BUCKET.get(spilled.r2_key as string),
            deadlineAt,
            "Project source snapshot source lookup",
          );
          if (!source) {
            throw new Error(`Project source file is missing from R2: ${path}`);
          }
          const sourceBody = source.body;
          let sourceBodyTransferred = false;
          try {
            if (source.size !== entry.size) {
              throw new Error(
                `Project source changed while snapshotting: ${path}`,
              );
            }
            size = source.size;
            contentType = source.httpMetadata?.contentType ?? contentType;
            const hashTimeoutMs = remainingOperationMs(
              deadlineAt,
              "Project source snapshot hash",
            );
            sourceBodyTransferred = true;
            sha256 = await sha256StreamHex(sourceBody, hashTimeoutMs);
          } finally {
            if (!sourceBodyTransferred) {
              await this.cancelOwnedStream(
                sourceBody,
                deadlineAt,
                "snapshot source was not consumed",
              );
            }
          }
        } else {
          const read = await this.readBoundedFileBytes(
            this.projectWorkspace,
            `/${path}`,
          );
          if (!read) {
            throw new Error(`Project source file disappeared: ${path}`);
          }
          const bytes = read.bytes;
          if (bytes.byteLength !== entry.size) {
            throw new Error(
              `Project source changed while snapshotting: ${path}`,
            );
          }
          size = bytes.byteLength;
          sha256 = await sha256Hex(bytes);
          copySource = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              controller.close();
            },
          });
        }

        let copySourceTransferred = false;
        try {
          const blobKey = projectSnapshotBlobKey(
            this.ctx.id.toString(),
            sha256,
          );
          const blobState = await this.snapshotBlobIsValid(
            blobKey,
            size,
            sha256,
            deadlineAt,
          );
          if (blobState === "invalid") {
            throw new Error(
              `Existing project source snapshot blob is corrupt: ${path}`,
            );
          }
          if (blobState === "missing") {
            if (!copySource && spilledSourceKey) {
              const second = await withOperationDeadline(
                () => this.env.R2_BUCKET.get(spilledSourceKey as string),
                deadlineAt,
                "Project source snapshot second source lookup",
              );
              if (!second) {
                throw new Error(
                  `Project source changed while snapshotting: ${path}`,
                );
              }
              if (second.size !== size) {
                await this.cancelOwnedStream(
                  second.body,
                  deadlineAt,
                  "snapshot source changed size",
                );
                throw new Error(
                  `Project source changed size while snapshotting: ${path}`,
                );
              }
              copySource = second.body;
              try {
                contentType = second.httpMetadata?.contentType ?? contentType;
              } catch (error) {
                await this.cancelOwnedStream(
                  copySource,
                  deadlineAt,
                  "snapshot metadata lookup failed",
                );
                copySource = undefined;
                throw error;
              }
            }
            if (!copySource) {
              throw new Error(`Project source stream is unavailable: ${path}`);
            }
            // Compute the handoff deadline before recording ownership. If it
            // has expired, the finally below still owns and cancels the body.
            const copyTimeoutMs = remainingOperationMs(
              deadlineAt,
              "Project source snapshot copy",
            );
            this.assertR2GcCapacity([blobKey]);
            if (!stagingCleanupPrearmed) {
              await this.prearmR2Cleanup(deadlineAt, latePutEligibleAt);
              stagingCleanupPrearmed = true;
            }
            createdBlobKeys.add(blobKey);
            this.trackR2Cleanup(
              blobKey,
              this.r2CleanupOwner,
              latePutEligibleAt,
              true,
            );
            let dispatchTimeoutMs: number;
            try {
              dispatchTimeoutMs = remainingOperationMs(
                deadlineAt,
                "Project source snapshot copy handoff",
              );
            } catch (error) {
              this.markR2CleanupSettled(blobKey);
              throw error;
            }
            copySourceTransferred = true;
            await this.putSnapshotBlob(
              blobKey,
              copySource,
              normalizeContentType(contentType),
              size,
              sha256,
              Math.min(copyTimeoutMs, dispatchTimeoutMs),
              () => this.markR2CleanupSettled(blobKey),
            );
          } else {
            const cleanupRow = this.ctx.storage.sql
              .exec(
                `SELECT phase FROM ${WORKSPACE_R2_GC_TABLE}
                 WHERE r2_key = ? LIMIT 1`,
                blobKey,
              )
              .toArray()[0] as { phase?: string } | undefined;
            if (cleanupRow) {
              if (cleanupRow.phase !== "delete") {
                throw new Error(
                  "Snapshot blob is still fenced by an unsettled R2 write",
                );
              }
              reusedBlobKeysPendingDelete.add(blobKey);
            }
            if (copySource) {
              await this.cancelOwnedStream(
                copySource,
                deadlineAt,
                "snapshot blob already exists",
              );
            }
            copySourceTransferred = true;
          }
          entries.push({ path, size, sha256, blobKey });
          totalBytes = nextTotalBytes;
        } finally {
          if (copySource && !copySourceTransferred) {
            await this.cancelOwnedStream(
              copySource,
              deadlineAt,
              "snapshot copy source was not transferred",
            );
          }
        }
      }

      entries.sort((a, b) => a.path.localeCompare(b.path));
      const digestInput = JSON.stringify(
        entries.map((entry) => [entry.path, entry.size, entry.sha256]),
      );
      const id = await sha256Hex(new TextEncoder().encode(digestInput));
      const snapshot: ProjectSourceSnapshot = {
        id,
        createdAt: new Date().toISOString(),
        ...(message ? { message } : {}),
        fileCount: entries.length,
        totalBytes,
        entries,
      };
      validateProjectSourceSnapshot(snapshot, id, this.ctx.id.toString());
      const retention = this.planSnapshotRetention(snapshot, deadlineAt);
      if (retention.cleanupKeys.size > 0) {
        this.assertR2GcCapacity(retention.cleanupKeys);
        await this.prearmR2Cleanup(deadlineAt);
      }
      remainingOperationMs(deadlineAt, "Project source snapshot commit");
      this.ctx.storage.transactionSync(() => {
        this.assertNoSnapshotCleanupPending();
        this.ctx.storage.kv.put(`${PROJECT_SNAPSHOT_PREFIX}${id}`, snapshot);
        this.ctx.storage.kv.put(PROJECT_SNAPSHOT_INDEX_KEY, retention.index);
        for (const evictedId of retention.evictedIds) {
          this.ctx.storage.kv.delete(`${PROJECT_SNAPSHOT_PREFIX}${evictedId}`);
        }
        for (const key of retention.cleanupKeys) {
          this.ctx.storage.sql.exec(
            `INSERT INTO ${WORKSPACE_R2_GC_TABLE}
               (r2_key, owner, phase, eligible_at)
             VALUES (?, NULL, 'delete', ?)
             ON CONFLICT(r2_key) DO UPDATE SET
               owner = NULL, phase = 'delete', eligible_at = excluded.eligible_at`,
            key,
            Date.now(),
          );
        }
        for (const key of [
          ...createdBlobKeys,
          ...reusedBlobKeysPendingDelete,
        ]) {
          this.ctx.storage.sql.exec(
            `DELETE FROM ${WORKSPACE_R2_GC_TABLE} WHERE r2_key = ?`,
            key,
          );
        }
      });
      committed = true;
      return snapshot;
    } catch (error) {
      if (!committed && createdBlobKeys.size > 0) {
        try {
          await this.drainTargetedR2Cleanup(
            createdBlobKeys,
            Date.now() + WORKSPACE_R2_DELETE_MS,
          );
        } catch (cleanupError) {
          if (cleanupError instanceof WorkspaceAdoptTimeoutError) {
            throw cleanupError;
          }
          // Write-ahead cleanup rows survive for a later bounded drain.
        }
      }
      throw error;
    }
  }

  async projectRestoreSourceSnapshot(
    snapshotId: unknown,
  ): Promise<ProjectSourceSnapshot> {
    return this.withFileMutationQueue("project", "/", () =>
      this.abortOnSnapshotTimeout(async () => {
        this.assertNoSnapshotCleanupPending();
        const deadlineAt = Date.now() + PROJECT_SNAPSHOT_OPERATION_MS;
        this.assertNoUnsettledR2Effects();
        const id = requireSnapshotId(snapshotId);
        const stored = this.ctx.storage.kv.get<ProjectSourceSnapshot>(
          `${PROJECT_SNAPSHOT_PREFIX}${id}`,
        );
        if (!stored)
          throw new Error(`Project source snapshot not found: ${id}`);
        const snapshot = validateProjectSourceSnapshot(
          stored,
          id,
          this.ctx.id.toString(),
        );
        const keep = new Set(snapshot.entries.map((entry) => entry.path));
        const current = await withOperationDeadline(
          () =>
            this.projectListFiles("/", {
              recursive: true,
              includeHidden: true,
              limit: 50_000,
              bounds: {
                maxEntries: WORKSPACE_LIST_MAX_ENTRIES,
                maxFiles: WORKSPACE_LIST_MAX_ENTRIES,
                maxPathBytes: WORKSPACE_LIST_MAX_PATH_BYTES,
                maxFileBytes: PROJECT_SNAPSHOT_MAX_FILE_BYTES,
                maxTotalBytes: PROJECT_SNAPSHOT_MAX_TOTAL_BYTES,
              },
            }),
          deadlineAt,
          "Project source restore listing",
        );
        if (!current.success)
          throw new Error(current.error || "Failed to list project files");

        const extraPaths: string[] = [];
        for (const entry of current.files) {
          if (entry.type !== "file") continue;
          const path = normalizeProjectSnapshotPath(entry.absolutePath);
          if (!path || shouldIgnoreProjectSnapshotPath(path) || keep.has(path))
            continue;
          extraPaths.push(`/${path}`);
        }

        // Reject topology conflicts before opening a copy stream or mutating a
        // live row. In particular, a snapshot file cannot implicitly erase a
        // live directory and its children.
        const requiredDirectories = new Set<string>();
        let requiredDirectoryPathBytes = 0;
        for (const entry of snapshot.entries) {
          const target = `/${entry.path}`;
          const targetRow = this.ctx.storage.sql
            .exec(
              `SELECT type FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
              target,
            )
            .toArray()[0] as { type?: string } | undefined;
          if (targetRow && targetRow.type !== "file") {
            throw new Error(
              `Cannot restore a snapshot file over ${targetRow.type ?? "an invalid row"}: ${entry.path}`,
            );
          }
          let parent = target.slice(0, target.lastIndexOf("/")) || "/";
          while (parent !== "/") {
            // Every ancestor of a known directory was already checked and
            // retained when that directory was first discovered.
            if (requiredDirectories.has(parent)) break;
            const parentBytes = utf8ByteLength(parent);
            if (
              requiredDirectories.size >= WORKSPACE_LIST_MAX_ENTRIES ||
              requiredDirectoryPathBytes + parentBytes >
                WORKSPACE_LIST_MAX_PATH_BYTES
            ) {
              throw new Error(
                "Project source snapshot directory topology exceeds workspace bounds",
              );
            }
            requiredDirectories.add(parent);
            requiredDirectoryPathBytes += parentBytes;
            const row = this.ctx.storage.sql
              .exec(
                `SELECT type FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
                parent,
              )
              .toArray()[0] as { type?: string } | undefined;
            if (row && row.type !== "directory") {
              throw new Error(
                `Cannot restore beneath a non-directory path: ${parent}`,
              );
            }
            parent = parent.slice(0, parent.lastIndexOf("/")) || "/";
          }
        }

        const latePutEligibleAt = deadlineAt + WORKSPACE_R2_LATE_PUT_GRACE_MS;
        let predictedInlineBytes = 0;
        let predictedStagedKeys = 0;
        for (const entry of snapshot.entries) {
          if (
            entry.size <= WORKSPACE_INLINE_WRITE_MAX_BYTES &&
            predictedInlineBytes <=
              PROJECT_SNAPSHOT_RESTORE_INLINE_MAX_BYTES - entry.size
          ) {
            predictedInlineBytes += entry.size;
          } else {
            predictedStagedKeys += 1;
          }
        }
        this.assertR2GcAdditionalCapacity(predictedStagedKeys);

        const staged: Array<
          | {
              entry: ProjectSourceSnapshotEntry;
              storageBackend: "inline";
              content: string;
              contentType: string;
            }
          | {
              entry: ProjectSourceSnapshotEntry;
              storageBackend: "r2";
              key: string;
              contentType: string;
            }
        > = [];
        const stagedKeys = new Set<string>();
        const oldKeys = new Set<string>();
        let retainedInlineBytes = 0;
        let stagingCleanupPrearmed = false;
        let committed = false;
        try {
          // Validate and stage each immutable blob exactly once. Small files are
          // retained under one aggregate memory ceiling for the atomic SQLite
          // commit; larger/excess files stream to unique R2 keys whose PUT is
          // checksum-verified. No live row changes until every entry succeeds.
          for (const entry of snapshot.entries) {
            const copy = await withOperationDeadline(
              () => this.env.R2_BUCKET.get(entry.blobKey),
              deadlineAt,
              "Project source snapshot restore copy lookup",
            );
            if (!copy) {
              throw new Error(
                `Project source snapshot blob missing: ${entry.path}`,
              );
            }
            const body = copy.body;
            let bodyTransferred = false;
            try {
              if (copy.size !== entry.size) {
                throw new Error(
                  `Project source snapshot blob changed during restore: ${entry.path}`,
                );
              }
              const contentType = normalizeContentType(
                copy.httpMetadata?.contentType,
              );
              const retainInline =
                entry.size <= WORKSPACE_INLINE_WRITE_MAX_BYTES &&
                retainedInlineBytes <=
                  PROJECT_SNAPSHOT_RESTORE_INLINE_MAX_BYTES - entry.size;
              if (retainInline) {
                bodyTransferred = true;
                const bytes = await this.readOwnedStreamBytes(
                  body,
                  entry.size,
                  WORKSPACE_INLINE_WRITE_MAX_BYTES,
                  deadlineAt,
                  "Project source snapshot inline restore",
                );
                const actualSha = await sha256Hex(bytes);
                if (actualSha !== entry.sha256) {
                  throw new Error(
                    `Project source snapshot blob hash mismatch: ${entry.path}`,
                  );
                }
                retainedInlineBytes += entry.size;
                staged.push({
                  entry,
                  storageBackend: "inline",
                  content: bytesToBase64(bytes),
                  contentType,
                });
                continue;
              }
              const copyTimeoutMs = remainingOperationMs(
                deadlineAt,
                "Project source snapshot restore copy",
              );
              if (!stagingCleanupPrearmed) {
                await this.prearmR2Cleanup(deadlineAt, latePutEligibleAt);
                stagingCleanupPrearmed = true;
              }
              const key = `${fileStoreR2Prefix("project", this.ctx.id.toString())}/adopt/${crypto.randomUUID()}`;
              stagedKeys.add(key);
              this.trackR2Cleanup(
                key,
                this.r2CleanupOwner,
                latePutEligibleAt,
                true,
              );
              let dispatchTimeoutMs: number;
              try {
                dispatchTimeoutMs = remainingOperationMs(
                  deadlineAt,
                  "Project source snapshot restore copy handoff",
                );
              } catch (error) {
                this.markR2CleanupSettled(key);
                throw error;
              }
              bodyTransferred = true;
              await streamToR2(
                this.env.R2_BUCKET,
                key,
                body,
                contentType,
                entry.size,
                entry.sha256,
                {
                  type: "project-source-snapshot-restore",
                  sha256: entry.sha256,
                },
                Math.min(copyTimeoutMs, dispatchTimeoutMs),
                () => this.markR2CleanupSettled(key),
              );
              staged.push({
                entry,
                storageBackend: "r2",
                key,
                contentType,
              });
            } catch (error) {
              if (error instanceof WorkspaceAdoptTimeoutError) throw error;
              throw new Error(
                `Failed to restore project source snapshot file ${entry.path}: ${errorMessage(error)}`,
              );
            } finally {
              if (!bodyTransferred) {
                await this.cancelOwnedStream(
                  body,
                  deadlineAt,
                  "snapshot restore copy was not transferred",
                );
              }
            }
          }

          for (const path of extraPaths) {
            const row = this.ctx.storage.sql
              .exec(
                `SELECT storage_backend, r2_key FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
                path,
              )
              .toArray()[0] as
              | { storage_backend?: string; r2_key?: string }
              | undefined;
            if (row?.storage_backend === "r2" && row.r2_key)
              oldKeys.add(row.r2_key);
          }
          for (const { entry } of staged) {
            const row = this.ctx.storage.sql
              .exec(
                `SELECT storage_backend, r2_key FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
                `/${entry.path}`,
              )
              .toArray()[0] as
              | { storage_backend?: string; r2_key?: string }
              | undefined;
            if (row?.storage_backend === "r2" && row.r2_key)
              oldKeys.add(row.r2_key);
          }
          if (oldKeys.size > WORKSPACE_R2_GC_MAX_KEYS) {
            throw new Error(
              `Project source restore exceeds the ${WORKSPACE_R2_GC_MAX_KEYS} cleanup-key limit`,
            );
          }
          for (const key of oldKeys) {
            if (!key || utf8ByteLength(key) > 1_024) {
              throw new Error("Project source restore found an invalid R2 key");
            }
          }
          this.assertR2GcAdditionalCapacity(oldKeys.size);

          remainingOperationMs(deadlineAt, "Project source restore commit");
          if (oldKeys.size > 0) {
            await this.prearmR2Cleanup(deadlineAt);
          }
          const now = Math.floor(Date.now() / 1000);
          this.ctx.storage.transactionSync(() => {
            for (const key of stagedKeys) {
              this.ctx.storage.sql.exec(
                `DELETE FROM ${WORKSPACE_R2_GC_TABLE} WHERE r2_key = ?`,
                key,
              );
            }
            for (const key of oldKeys) {
              this.ctx.storage.sql.exec(
                `INSERT INTO ${WORKSPACE_R2_GC_TABLE}
                   (r2_key, owner, phase, eligible_at)
                 VALUES (?, NULL, 'delete', ?)
                 ON CONFLICT(r2_key) DO UPDATE SET
                   owner = NULL, phase = 'delete', eligible_at = excluded.eligible_at`,
                key,
                Date.now(),
              );
            }
            const directories = [...requiredDirectories].sort(
              (a, b) => a.split("/").length - b.split("/").length,
            );
            for (const directory of directories) {
              const slash = directory.lastIndexOf("/");
              const parentPath = slash === 0 ? "/" : directory.slice(0, slash);
              const name = directory.slice(slash + 1);
              this.ctx.storage.sql.exec(
                `INSERT OR IGNORE INTO ${WORKSPACE_STORE_TABLE}
                (path, parent_path, name, type, size, created_at, modified_at)
               VALUES (?, ?, ?, 'directory', 0, ?, ?)`,
                directory,
                parentPath,
                name,
                now,
                now,
              );
            }
            for (const path of extraPaths) {
              this.ctx.storage.sql.exec(
                `DELETE FROM ${WORKSPACE_STORE_TABLE} WHERE path = ?`,
                path,
              );
            }
            for (const stagedEntry of staged) {
              const { entry, contentType } = stagedEntry;
              const target = `/${entry.path}`;
              const slash = target.lastIndexOf("/");
              const parentPath = slash === 0 ? "/" : target.slice(0, slash);
              const name = target.slice(slash + 1);
              this.ctx.storage.sql.exec(
                `INSERT INTO ${WORKSPACE_STORE_TABLE}
                (path, parent_path, name, type, mime_type, size,
                 storage_backend, r2_key, content_encoding, content, created_at, modified_at)
               VALUES (?, ?, ?, 'file', ?, ?, ?, ?, 'base64', ?, ?, ?)
               ON CONFLICT(path) DO UPDATE SET
                 type = 'file', mime_type = excluded.mime_type,
                 size = excluded.size, storage_backend = excluded.storage_backend,
                 r2_key = excluded.r2_key, content_encoding = excluded.content_encoding,
                 content = excluded.content, modified_at = excluded.modified_at`,
                target,
                parentPath,
                name,
                contentType,
                entry.size,
                stagedEntry.storageBackend,
                stagedEntry.storageBackend === "r2" ? stagedEntry.key : null,
                stagedEntry.storageBackend === "inline"
                  ? stagedEntry.content
                  : null,
                now,
                now,
              );
            }
          });
          committed = true;
          // The live pointer swap is the success boundary. Old-key cleanup stays
          // durable for the next admission/teardown drain; do not start a
          // fallible binding operation after committing the user-visible state.
          return snapshot;
        } catch (error) {
          if (!committed && stagedKeys.size > 0) {
            try {
              await this.drainTargetedR2Cleanup(stagedKeys, deadlineAt);
            } catch (cleanupError) {
              if (cleanupError instanceof WorkspaceAdoptTimeoutError) {
                throw cleanupError;
              }
              // The write-ahead GC rows survive for a later bounded retry.
            }
          }
          throw error;
        }
      }, "Project source snapshot restore timed out"),
    );
  }

  async projectListSourceSnapshots(
    limit = 20,
  ): Promise<ProjectSourceSnapshot[]> {
    const safeLimit = Math.max(
      1,
      Math.min(PROJECT_SNAPSHOT_LIST_MAX_COUNT, Math.floor(limit)),
    );
    const index =
      (await this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_INDEX_KEY)) ??
      [];
    const snapshots: ProjectSourceSnapshot[] = [];
    let responseBytes = 2;
    for (const id of index.slice(0, safeLimit)) {
      const stored = await this.ctx.storage.kv.get<ProjectSourceSnapshot>(
        `${PROJECT_SNAPSHOT_PREFIX}${id}`,
      );
      if (!stored) continue;
      const snapshot = validateProjectSourceSnapshot(
        stored,
        requireSnapshotId(id),
        this.ctx.id.toString(),
      );
      const snapshotBytes = utf8ByteLength(JSON.stringify(snapshot));
      if (
        snapshots.length > 0 &&
        responseBytes + 1 + snapshotBytes > PROJECT_SNAPSHOT_LIST_MAX_BYTES
      ) {
        break;
      }
      responseBytes += (snapshots.length > 0 ? 1 : 0) + snapshotBytes;
      snapshots.push(snapshot);
    }
    return snapshots;
  }

  async projectDeleteSourceSnapshots(): Promise<{
    snapshotsDeleted: number;
    blobsDeleted: number;
  }> {
    return this.withFileMutationQueue("project", "/", async () => {
      const deadlineAt = Date.now() + PROJECT_SNAPSHOT_OPERATION_MS;
      const index =
        this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_INDEX_KEY) ?? [];
      const alreadyPending =
        this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_GC_KEY) ?? [];
      const pending = [...new Set([...alreadyPending, ...index])];
      for (const id of pending) requireSnapshotId(id);

      // Hide the snapshots atomically but retain every manifest as durable GC
      // work until all of its content-addressed blobs have been deleted.
      this.ctx.storage.transactionSync(() => {
        this.ctx.storage.kv.put(PROJECT_SNAPSHOT_INDEX_KEY, []);
        if (pending.length > 0)
          this.ctx.storage.kv.put(PROJECT_SNAPSHOT_GC_KEY, pending);
        else this.ctx.storage.kv.delete(PROJECT_SNAPSHOT_GC_KEY);
      });

      let snapshotsDeleted = 0;
      let blobsDeleted = 0;
      for (const id of pending) {
        remainingOperationMs(deadlineAt, "Project source snapshot deletion");
        const stored = this.ctx.storage.kv.get<ProjectSourceSnapshot>(
          `${PROJECT_SNAPSHOT_PREFIX}${id}`,
        );
        if (stored) {
          const snapshot = validateProjectSourceSnapshot(
            stored,
            id,
            this.ctx.id.toString(),
          );
          // Keep deduplication bounded to one finite manifest. Cross-manifest
          // duplicate deletes are safe and avoid retaining the full GC set.
          const keys = [
            ...new Set(snapshot.entries.map((entry) => entry.blobKey)),
          ];
          blobsDeleted += await this.deleteR2KeysOrAbort(
            keys,
            "Project source snapshot blob cleanup did not settle",
            deadlineAt,
          );
        }

        this.ctx.storage.transactionSync(() => {
          if (stored) {
            this.ctx.storage.kv.delete(`${PROJECT_SNAPSHOT_PREFIX}${id}`);
          }
          const remaining =
            this.ctx.storage.kv.get<string[]>(PROJECT_SNAPSHOT_GC_KEY) ?? [];
          const next = remaining.filter((candidate) => candidate !== id);
          if (next.length > 0)
            this.ctx.storage.kv.put(PROJECT_SNAPSHOT_GC_KEY, next);
          else this.ctx.storage.kv.delete(PROJECT_SNAPSHOT_GC_KEY);
        });
        if (stored) snapshotsDeleted += 1;
      }
      return { snapshotsDeleted, blobsDeleted };
    });
  }

  async listProjects(): Promise<WorkspaceProject[]> {
    return nestProjectClones((await this.readProjects()).map(toPublicProject));
  }

  // Flat project list (clones not nested under their source). Used by the
  // project delete paths to resolve targets by id/name.
  async listProjectsForMigrationReset(): Promise<WorkspaceProject[]> {
    return (await this.readProjects()).map(toPublicProject);
  }

  async getProject(projectId: unknown): Promise<WorkspaceProject | null> {
    const id = requireProjectId(projectId, "project");
    const project = (await this.readProjects()).find(
      (candidate) => candidate.id === id,
    );
    return project
      ? toPublicProject(await this.ensureProjectArtifactsReady(project))
      : null;
  }

  async getProjectByName(project: unknown): Promise<WorkspaceProject | null> {
    const nameKey = requireProjectNameKey(project, "project");
    const existing = (await this.readProjects()).find(
      (candidate) => projectNameKey(candidate.name) === nameKey,
    );
    return existing
      ? toPublicProject(await this.ensureProjectArtifactsReady(existing))
      : null;
  }

  async deleteProjectsForWorkspace(
    workspaceId: unknown = this.ctx.id.toString(),
  ): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }> {
    requireWorkspaceId(workspaceId);
    const projects = await this.readProjects();
    if (projects.length > 0) {
      await this.ctx.storage.kv.put(PROJECTS_KEY, []);
    }

    return {
      deleted: projects.map(toPublicProject),
      retained: [],
    };
  }

  async removeProjects(
    projectIds: string[],
  ): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }> {
    const idSet = new Set(
      projectIds
        .map((projectId) =>
          typeof projectId === "string" ? projectId.trim() : "",
        )
        .filter(Boolean),
    );
    if (idSet.size === 0) {
      return {
        deleted: [],
        retained: (await this.readProjects()).map(toPublicProject),
      };
    }
    const projects = await this.readProjects();
    const deleted = projects.filter((project) => idSet.has(project.id));
    const retained = projects.filter((project) => !idSet.has(project.id));
    if (deleted.length > 0) {
      await this.ctx.storage.kv.put(PROJECTS_KEY, retained);
    }
    return {
      deleted: deleted.map(toPublicProject),
      retained: retained.map(toPublicProject),
    };
  }

  async createProject(
    input: {
      id?: unknown;
      name?: unknown;
      description?: unknown;
      workspaceId?: unknown;
    } = {},
  ): Promise<WorkspaceProject> {
    const projects = await this.readProjects();
    const name = requireProjectName(
      input.name ?? input.id ?? `project-${projects.length + 1}`,
    );
    const nameKey = projectNameKey(name);
    if (projects.some((project) => projectNameKey(project.name) === nameKey)) {
      throw new Error(`Project already exists: ${name}`);
    }
    const workspaceId = requireWorkspaceId(input.workspaceId);
    const id = globalProjectId(workspaceId, input.id ?? name);
    if (projects.some((project) => project.id === id)) {
      throw new Error(`Project already exists: ${name}`);
    }

    const now = new Date().toISOString();
    const description = requireProjectDescription(input.description);
    const project = await this.ensureProjectArtifactRepo({
      id,
      name,
      description,
      defaultVmId: DEFAULT_PROJECT_VM_ID,
      backend: "do-r2",
      createdAt: now,
      updatedAt: now,
    });
    projects.push(project);
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
    return toPublicProject(project);
  }

  async setProjectDescription(
    input: {
      project?: unknown;
      projectId?: unknown;
      description?: unknown;
    } = {},
  ): Promise<WorkspaceProject> {
    const projectName = input.project;
    const description = requireProjectDescription(input.description);
    const projects = await this.readProjects();
    const index =
      typeof projectName === "string" && projectName.trim()
        ? projects.findIndex(
            (project) =>
              projectNameKey(project.name) ===
              requireProjectNameKey(projectName, "project"),
          )
        : projects.findIndex(
            (project) =>
              project.id === requireProjectId(input.projectId, "project"),
          );
    if (index === -1) {
      throw new Error(
        `Project not found: ${String(projectName || input.projectId || "")}`,
      );
    }
    const updated: WorkspaceProject = {
      ...projects[index]!,
      description,
      updatedAt: new Date().toISOString(),
    };
    projects[index] = updated;
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
    return toPublicProject(updated);
  }

  async cloneProject(
    input: {
      sourceProject?: unknown;
      sourceProjectId?: unknown;
      id?: unknown;
      name?: unknown;
      description?: unknown;
      workspaceId?: unknown;
    } = {},
  ): Promise<WorkspaceProject> {
    const initialProjects = await this.readProjects();
    const sourceName = input.sourceProject;
    const existingSource =
      typeof sourceName === "string" && sourceName.trim()
        ? initialProjects.find(
            (project) =>
              projectNameKey(project.name) ===
              requireProjectNameKey(sourceName, "source project"),
          )
        : initialProjects.find(
            (project) =>
              project.id ===
              requireProjectId(input.sourceProjectId, "source project"),
          );
    if (!existingSource) {
      throw new Error(
        `Source project not found: ${String(sourceName || input.sourceProjectId || "")}`,
      );
    }

    const source =
      existingSource.artifactRemote && existingSource.artifactStatus !== "error"
        ? existingSource
        : await this.ensureProjectArtifactRepo(existingSource);
    if (!source) {
      throw new Error(
        `Source project not found: ${String(sourceName || input.sourceProjectId || "")}`,
      );
    }
    if (!source.artifactRepoName || source.artifactStatus === "error") {
      throw new Error(
        `Source project ${source.id} is not backed by an Artifacts repo`,
      );
    }

    const projects = await this.readProjects();
    const cloneName =
      typeof input.name === "string" && input.name.trim()
        ? requireProjectName(input.name)
        : nextProjectCopyName(projects, source);
    const cloneNameKey = projectNameKey(cloneName);
    if (
      projects.some((project) => projectNameKey(project.name) === cloneNameKey)
    ) {
      throw new Error(`Project already exists: ${cloneName}`);
    }
    const requestedId = input.id ?? cloneName;
    const workspaceId = requireWorkspaceId(input.workspaceId);
    const id = globalProjectId(workspaceId, requestedId);
    if (projects.some((project) => project.id === id)) {
      throw new Error(`Project already exists: ${cloneName}`);
    }

    const now = new Date().toISOString();
    const description =
      typeof input.description === "string" && input.description.trim()
        ? input.description.trim()
        : `Clone of ${source.name}: ${projectDescription(source)}`;
    const project: WorkspaceProject = {
      id,
      name: cloneName,
      description,
      defaultVmId: DEFAULT_PROJECT_VM_ID,
      backend: "do-r2",
      clonedFromProjectId: source.id,
      artifactRemoteProjectId: source.artifactRemoteProjectId || source.id,
      artifactRepoName: source.artifactRepoName,
      artifactRepoId: source.artifactRepoId,
      artifactRemote: source.artifactRemote,
      artifactDefaultBranch:
        source.artifactDefaultBranch || ARTIFACTS_DEFAULT_BRANCH,
      artifactStatus: source.artifactStatus || "ready",
      createdAt: now,
      updatedAt: now,
    };
    projects.push(project);
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
    return toPublicProject(project);
  }

  async mintProjectArtifactToken(
    projectId: unknown,
    scope: "read" | "write" = "write",
    ttlSeconds = 600,
  ): Promise<ProjectArtifactToken> {
    const id = requireProjectId(projectId, "project");
    const existing = (await this.readProjects()).find(
      (candidate) => candidate.id === id,
    );
    let project = existing ?? null;
    if (!project) {
      throw new Error(`Project not found: ${String(projectId)}`);
    }
    const artifacts = this.env.ARTIFACTS;
    if (!artifacts) {
      throw new Error("ARTIFACTS binding is not configured");
    }
    if (
      !project.artifactRepoName ||
      !project.artifactRemote ||
      project.artifactStatus === "error"
    ) {
      project = await this.ensureProjectArtifactRepo(project);
    }
    if (
      !project.artifactRepoName ||
      !project.artifactRemote ||
      project.artifactStatus === "error"
    ) {
      throw new Error(
        `Project ${project.id} is not backed by an Artifacts repo`,
      );
    }
    let repo: ArtifactsRepo;
    try {
      repo = await artifacts.get(project.artifactRepoName);
    } catch {
      project = await this.ensureProjectArtifactRepo(project);
      if (
        !project.artifactRepoName ||
        !project.artifactRemote ||
        project.artifactStatus === "error"
      ) {
        throw new Error(
          `Project ${project.id} is not backed by an Artifacts repo`,
        );
      }
      repo = await artifacts.get(project.artifactRepoName);
    }
    const result = await repo.createToken(scope, ttlSeconds);
    return {
      project: toPublicProject(project),
      token: result.plaintext,
      expiresAt: result.expiresAt,
      artifactRemote: project.artifactRemote,
      artifactRemoteProjectId: project.artifactRemoteProjectId || project.id,
    };
  }

  private async readProjects(): Promise<WorkspaceProject[]> {
    const value =
      await this.ctx.storage.kv.get<WorkspaceProject[]>(PROJECTS_KEY);
    return Array.isArray(value) ? value.filter(isWorkspaceProject) : [];
  }

  private async ensureProjectArtifactRepo(
    project: WorkspaceProject,
  ): Promise<WorkspaceProject> {
    const artifacts = this.env.ARTIFACTS;
    if (!artifacts) return project;

    const repoName =
      project.artifactRepoName ||
      artifactRepoName(this.ctx.id.toString(), project.id);
    const artifactRemote = this.artifactRemoteForRepo(repoName);
    try {
      const repo = await createOrGetArtifactRepo(
        artifacts,
        repoName,
        project,
        artifactRemote,
      );
      const updated: WorkspaceProject = {
        ...project,
        artifactRepoName: repo.name,
        artifactRepoId: repo.id,
        artifactRemote: repo.remote,
        artifactDefaultBranch: repo.defaultBranch || ARTIFACTS_DEFAULT_BRANCH,
        artifactStatus: repo.status || "ready",
        updatedAt: new Date().toISOString(),
      };
      await this.replaceProject(updated);
      return updated;
    } catch (error) {
      const message = errorMessage(error);
      if (isArtifactsBindingUnavailableError(message)) {
        const updated: WorkspaceProject = {
          ...project,
          artifactRepoName: repoName,
          artifactRemote,
          artifactRemoteProjectId:
            project.artifactRemoteProjectId || project.id,
          artifactDefaultBranch:
            project.artifactDefaultBranch || ARTIFACTS_DEFAULT_BRANCH,
          artifactStatus: "error",
          updatedAt: new Date().toISOString(),
        };
        await this.replaceProject(updated);
        console.warn(
          "[WorkspaceFilesystemDO] Artifacts repo unavailable; continuing without repo",
          {
            projectId: project.id,
            repoName,
            error: message,
          },
        );
        return updated;
      }
      console.error("[WorkspaceFilesystemDO] failed to ensure Artifacts repo", {
        projectId: project.id,
        repoName,
        error: message,
      });
      throw error;
    }
  }

  private artifactRemoteForRepo(repoName: string): string {
    const accountId = this.env.CF_ACCOUNT_ID?.trim();
    const namespace = this.env.ARTIFACTS_NAMESPACE?.trim();
    if (!accountId || !namespace) {
      return `https://artifacts.cloudflare.test/git/${encodeURIComponent(repoName)}.git`;
    }
    return `https://${accountId}.artifacts.cloudflare.net/git/${encodeURIComponent(namespace)}/${encodeURIComponent(repoName)}.git`;
  }

  private async ensureProjectArtifactsReady(
    project: WorkspaceProject,
  ): Promise<WorkspaceProject> {
    if (project.artifactRemote && project.artifactStatus !== "error") {
      return project;
    }
    return this.ensureProjectArtifactRepo(project);
  }

  private async replaceProject(project: WorkspaceProject): Promise<void> {
    const projects = await this.readProjects();
    const index = projects.findIndex(
      (candidate) => candidate.id === project.id,
    );
    if (index === -1) return;
    projects[index] = project;
    await this.ctx.storage.kv.put(PROJECTS_KEY, projects);
  }
}

export class WorkspaceFilesystemClient implements WorkspaceFilesystemLike {
  constructor(
    private readonly env: WorkspaceFilesystemEnv,
    private readonly workspaceId: string,
  ) {}

  private get stub(): DurableObjectStub<WorkspaceFilesystemDO> {
    return this.env.WORKSPACE_FS.get(
      this.env.WORKSPACE_FS.idFromName(this.workspaceId),
    );
  }

  exists(path: string): Promise<WorkspaceExistsResponse> {
    return this.stub.exists(path);
  }

  readFile(path: string): Promise<WorkspaceReadFileResponse> {
    return this.stub.readFile(path);
  }

  readFileStream(path: string): Promise<WorkspaceReadFileStreamResponse> {
    return this.stub.readFileStream(path);
  }

  writeFile(path: string, content: string): Promise<WorkspaceWriteResponse> {
    return this.stub.writeFile(path, content);
  }

  editTextFile(
    path: string,
    edits: TextEdit[],
  ): Promise<WorkspaceEditFileResponse> {
    return this.stub.editTextFile(path, edits);
  }

  writeBinaryFile(
    path: string,
    base64Content: string,
  ): Promise<WorkspaceWriteResponse> {
    return this.stub.writeBinaryFile(path, base64Content);
  }

  listFiles(
    path: string,
    options?: WorkspaceListOptions,
  ): Promise<WorkspaceListResponse> {
    return this.stub.listFiles(path, options);
  }

  mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<WorkspaceWriteResponse> {
    return this.stub.mkdir(path, options);
  }

  deleteFile(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<WorkspaceWriteResponse> {
    return this.stub.deleteFile(path, options);
  }

  listProjects(): Promise<WorkspaceProject[]> {
    return this.stub.listProjects();
  }

  listProjectsForMigrationReset(): Promise<WorkspaceProject[]> {
    return this.stub.listProjectsForMigrationReset();
  }

  getProject(projectId: unknown): Promise<WorkspaceProject | null> {
    return this.stub.getProject(projectId);
  }

  getProjectByName(project: unknown): Promise<WorkspaceProject | null> {
    return this.stub.getProjectByName(project);
  }

  deleteProjectsForWorkspace(
    workspaceId: unknown = this.workspaceId,
  ): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }> {
    return this.stub.deleteProjectsForWorkspace(workspaceId);
  }

  removeProjects(
    projectIds: string[],
  ): Promise<{ deleted: WorkspaceProject[]; retained: WorkspaceProject[] }> {
    return this.stub.removeProjects(projectIds);
  }

  createProject(input?: {
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject> {
    return this.stub.createProject({ ...input, workspaceId: this.workspaceId });
  }

  setProjectDescription(input?: {
    project?: unknown;
    projectId?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject> {
    return this.stub.setProjectDescription(input);
  }

  cloneProject(input?: {
    sourceProject?: unknown;
    sourceProjectId?: unknown;
    id?: unknown;
    name?: unknown;
    description?: unknown;
  }): Promise<WorkspaceProject> {
    return this.stub.cloneProject({ ...input, workspaceId: this.workspaceId });
  }

  mintProjectArtifactToken(
    projectId: unknown,
    scope?: "read" | "write",
    ttlSeconds?: number,
  ): Promise<ProjectArtifactToken> {
    return this.stub.mintProjectArtifactToken(projectId, scope, ttlSeconds);
  }
}

export class ProjectFilesystemClient implements WorkspaceFileStoreLike {
  constructor(
    private readonly env: WorkspaceFilesystemEnv,
    private readonly projectId: string,
  ) {}

  private get stub(): DurableObjectStub<WorkspaceFilesystemDO> {
    const normalizedProjectId = normalizeGlobalProjectId(this.projectId);
    return this.env.WORKSPACE_FS.get(
      this.env.WORKSPACE_FS.idFromName(normalizedProjectId),
    );
  }

  exists(path: string): Promise<WorkspaceExistsResponse> {
    return this.stub.projectExists(path);
  }

  readFile(path: string): Promise<WorkspaceReadFileResponse> {
    return this.stub.projectReadFile(path);
  }

  readFileStream(path: string): Promise<WorkspaceReadFileStreamResponse> {
    return this.stub.projectReadFileStream(path);
  }

  writeFile(path: string, content: string): Promise<WorkspaceWriteResponse> {
    return this.stub.projectWriteFile(path, content);
  }

  editTextFile(
    path: string,
    edits: TextEdit[],
  ): Promise<WorkspaceEditFileResponse> {
    return this.stub.projectEditTextFile(path, edits);
  }

  writeBinaryFile(
    path: string,
    base64Content: string,
  ): Promise<WorkspaceWriteResponse> {
    return this.stub.projectWriteBinaryFile(path, base64Content);
  }

  adoptR2File(
    path: string,
    stream: ReadableStream<Uint8Array>,
    expectedSize: number,
    contentType?: string,
  ): Promise<WorkspaceAdoptR2FileResponse> {
    return this.stub.projectAdoptR2File(
      path,
      stream,
      expectedSize,
      contentType,
    );
  }

  listFiles(
    path: string,
    options?: WorkspaceListOptions,
  ): Promise<WorkspaceListResponse> {
    return this.stub.projectListFiles(path, options);
  }

  mkdir(
    path: string,
    options?: { recursive?: boolean },
  ): Promise<WorkspaceWriteResponse> {
    return this.stub.projectMkdir(path, options);
  }

  deleteFile(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<WorkspaceWriteResponse> {
    return this.stub.projectDeleteFile(path, options);
  }

  createSourceSnapshot(input?: {
    message?: unknown;
  }): Promise<ProjectSourceSnapshot> {
    return this.stub.projectCreateSourceSnapshot(input);
  }

  restoreSourceSnapshot(snapshotId: unknown): Promise<ProjectSourceSnapshot> {
    return this.stub.projectRestoreSourceSnapshot(snapshotId);
  }

  listSourceSnapshots(limit?: number): Promise<ProjectSourceSnapshot[]> {
    return this.stub.projectListSourceSnapshots(limit);
  }

  deleteSourceSnapshots(): Promise<{
    snapshotsDeleted: number;
    blobsDeleted: number;
  }> {
    return this.stub.projectDeleteSourceSnapshots();
  }

  drainR2Cleanup(): Promise<{ success: boolean; pending: number }> {
    return this.stub.projectDrainR2Cleanup();
  }
}

export function normalizeWorkspacePath(value: unknown, fallback = "/"): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  let raw = value.trim().replace(/\\/g, "/");
  if (raw === "~" || raw === WORKSPACE_ROOT) return "/";
  if (raw.startsWith("~/")) raw = raw.slice(2);
  if (raw.startsWith(`${WORKSPACE_ROOT}/`)) {
    raw = raw.slice(WORKSPACE_ROOT.length + 1);
  }
  if (!raw.startsWith("/")) raw = `/${raw}`;

  const parts: string[] = [];
  for (const part of raw.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length > 0 ? `/${parts.join("/")}` : "/";
}

function normalizeBoundedWorkspacePath(value: unknown, fallback = "/"): string {
  if (
    (typeof value === "string" && value.length > WORKSPACE_PATH_MAX_BYTES) ||
    fallback.length > WORKSPACE_PATH_MAX_BYTES
  ) {
    throw new WorkspaceFileTooLargeError(
      `Workspace paths are limited to ${WORKSPACE_PATH_MAX_BYTES} UTF-8 bytes`,
    );
  }
  const normalized = normalizeWorkspacePath(value, fallback);
  assertBoundedWorkspacePath(normalized);
  return normalized;
}

function assertBoundedWorkspacePath(path: string): void {
  if (utf8ByteLength(path) > WORKSPACE_PATH_MAX_BYTES) {
    throw new WorkspaceFileTooLargeError(
      `Workspace paths are limited to ${WORKSPACE_PATH_MAX_BYTES} UTF-8 bytes`,
    );
  }
}

function normalizeRegistryId(value: unknown, fallback: string): string {
  const raw =
    typeof value === "string" && value.trim() ? value.trim() : fallback;
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return normalized || fallback;
}

function requireProjectId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  const id = normalizeGlobalProjectId(value.trim());
  if (!id) throw new Error(`${label} is required`);
  return id;
}

function nextProjectCopyName(
  projects: WorkspaceProject[],
  source: WorkspaceProject,
): string {
  const base = `${source.name || source.id} copy`;
  const used = new Set(projects.map((project) => projectNameKey(project.name)));
  if (!used.has(projectNameKey(base))) return base;

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base} ${index}`;
    if (!used.has(projectNameKey(candidate))) return candidate;
  }

  throw new Error(
    `Unable to allocate a clone name for ${source.name || source.id}`,
  );
}

async function createOrGetArtifactRepo(
  artifacts: ArtifactsBinding,
  repoName: string,
  project: WorkspaceProject,
  artifactRemote: string,
): Promise<ReadyArtifactsRepoInfo> {
  try {
    const created = await artifacts.create(repoName, {
      description: `camelAI project ${project.id}`,
      readOnly: false,
      setDefaultBranch: ARTIFACTS_DEFAULT_BRANCH,
    });
    return normalizeArtifactCreateInfo(created, repoName, artifactRemote);
  } catch (error) {
    if (isArtifactRepoAlreadyExistsError(error)) {
      try {
        const repo = await artifacts.get(repoName);
        return await artifactRepoInfoFromHandle(repo, repoName, artifactRemote);
      } catch {
        return readyArtifactRepoInfo(repoName, artifactRemote);
      }
    }
    try {
      return await waitForArtifactRepoHandleReady(
        artifacts,
        repoName,
        artifactRemote,
      );
    } catch {
      throw error;
    }
  }
}

async function waitForArtifactRepoHandleReady(
  artifacts: ArtifactsBinding,
  repoName: string,
  artifactRemote: string,
): Promise<ReadyArtifactsRepoInfo> {
  const deadline = Date.now() + ARTIFACTS_READY_TIMEOUT_MS;

  while (Date.now() < deadline) {
    try {
      const repo = await artifacts.get(repoName);
      return await artifactRepoInfoFromHandle(repo, repoName, artifactRemote);
    } catch {
      await delay(ARTIFACTS_READY_POLL_MS);
    }
  }

  throw new Error(
    `Artifacts repo ${repoName} was not ready within ${ARTIFACTS_READY_TIMEOUT_MS}ms.`,
  );
}

async function artifactRepoInfoFromHandle(
  repo: ArtifactsRepo,
  repoName: string,
  artifactRemote: string,
): Promise<ReadyArtifactsRepoInfo> {
  return {
    id: await optionalStringValue(repo.id),
    name: repoName,
    remote: (await optionalStringValue(repo.remote)) || artifactRemote,
    defaultBranch:
      (await optionalStringValue(repo.defaultBranch)) ||
      ARTIFACTS_DEFAULT_BRANCH,
    status:
      normalizeArtifactStatus(await optionalStringValue(repo.status)) ||
      "ready",
  };
}

async function normalizeArtifactCreateInfo(
  repo: ArtifactsCreateRepoResult,
  repoName: string,
  artifactRemote: string,
): Promise<ReadyArtifactsRepoInfo> {
  return {
    id: await optionalStringValue(repo.id),
    name: repoName,
    remote: (await optionalStringValue(repo.remote)) || artifactRemote,
    defaultBranch: await optionalStringValue(repo.defaultBranch),
    status:
      normalizeArtifactStatus(await optionalStringValue(repo.status)) ||
      "ready",
  };
}

function isArtifactRepoAlreadyExistsError(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  return (
    message.includes("already exists") || message.includes("already_exist")
  );
}

function readyArtifactRepoInfo(
  repoName: string,
  artifactRemote: string,
): ReadyArtifactsRepoInfo {
  return {
    name: repoName,
    remote: artifactRemote,
    defaultBranch: ARTIFACTS_DEFAULT_BRANCH,
    status: "ready",
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function fileStoreR2Prefix(scope: FileStoreScope, durableId: string): string {
  return `${scope === "project" ? "project-fs" : "workspace-fs"}/${durableId}`;
}

function normalizeContentType(contentType?: string): string {
  const trimmed = typeof contentType === "string" ? contentType.trim() : "";
  return trimmed || "application/octet-stream";
}

function cancelUnreadStream(
  stream: ReadableStream<Uint8Array>,
  reason: string,
): void {
  try {
    void stream.cancel(reason).catch(() => undefined);
  } catch {
    // A transferred or already locked stream cannot be cancelled directly.
  }
}

async function cancelUnreadStreamBounded(
  stream: ReadableStream<Uint8Array>,
  reason: string,
  timeoutMs: number,
): Promise<void> {
  try {
    await withOperationDeadline(
      () => stream.cancel(reason),
      Date.now() +
        Math.min(WORKSPACE_STREAM_CANCEL_MS, normalizeTimeoutMs(timeoutMs)),
      "Workspace source stream cancellation",
    );
  } catch (error) {
    if (error instanceof WorkspaceAdoptTimeoutError) throw error;
    // A settled cancellation rejection no longer retains binding work.
  }
}

/**
 * Stream `source` straight into an R2 object without buffering it, returning
 * R2's authoritative stored size.
 *
 * R2.put requires a *known-length* body. The source here has crossed a DO RPC
 * boundary, which strips any Content-Length the original fetch body carried
 * (production R2 rejects it with "must have a known length"), so re-frame it
 * through a FixedLengthStream sized by the VM-reported length. A byte-count
 * mismatch errors the pipe, which fails the put — so the declared size is
 * enforced, not just trusted.
 */
async function streamToR2(
  bucket: R2Bucket,
  key: string,
  source: ReadableStream<Uint8Array>,
  contentType: string,
  expectedSize: number,
  expectedSha256?: string,
  customMetadata?: Record<string, string>,
  timeoutMs = WORKSPACE_R2_ADOPT_MS,
  onSettled?: () => void,
): Promise<{ size: number }> {
  const abort = new AbortController();
  let pump: Promise<void> | undefined;
  let operation: Promise<[R2Object, void]> | undefined;
  let putOperation: Promise<R2Object> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let notified = false;
  const notifySettled = () => {
    if (notified) return;
    notified = true;
    try {
      onSettled?.();
    } catch {
      // Settlement notification is best-effort; durable callers retain WAL.
    }
  };
  try {
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 0) {
      throw new Error(
        `Streaming to R2 requires an exact safe-integer byte size; got ${expectedSize}`,
      );
    }
    const fixed = new FixedLengthStream(expectedSize);
    pump = source.pipeTo(fixed.writable, { signal: abort.signal });
    putOperation = Promise.resolve()
      .then(() =>
        bucket.put(key, fixed.readable, {
          httpMetadata: { contentType },
          ...(customMetadata ? { customMetadata } : {}),
          ...(expectedSha256 ? { sha256: expectedSha256 } : {}),
        }),
      )
      .catch((error) => {
        if (!abort.signal.aborted) abort.abort(error);
        throw error;
      });
    operation = Promise.allSettled([putOperation, pump]).then(
      ([putResult, pumpResult]) => {
        notifySettled();
        if (putResult.status === "rejected") throw putResult.reason;
        if (pumpResult.status === "rejected") throw pumpResult.reason;
        return [putResult.value, undefined] as [R2Object, void];
      },
    );
    const [stored] = await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new WorkspaceAdoptTimeoutError(
            "Streamed R2 adoption timed out",
          );
          abort.abort(error);
          reject(error);
        }, normalizeTimeoutMs(timeoutMs));
      }),
    ]);
    notifySettled();
    return { size: typeof stored?.size === "number" ? stored.size : 0 };
  } catch (error) {
    if (!abort.signal.aborted) abort.abort(error);
    void operation?.catch(() => undefined);
    if (!putOperation) notifySettled();
    let failure = error;
    if (!source.locked) {
      try {
        await cancelUnreadStreamBounded(
          source,
          "R2 adoption stream setup failed",
          timeoutMs,
        );
      } catch (cancelError) {
        failure = cancelError;
      }
    }
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

/** Bounds cleanup awaits; a caller aborts its DO if an R2 promise stays live. */
async function settleR2Delete(
  bucket: R2Bucket,
  key: string | string[],
  timeoutMs = WORKSPACE_R2_DELETE_MS,
): Promise<boolean> {
  return (await settleR2DeleteOutcome(bucket, key, timeoutMs)) === "deleted";
}

async function settleR2DeleteOutcome(
  bucket: R2Bucket,
  key: string | string[],
  timeoutMs = WORKSPACE_R2_DELETE_MS,
): Promise<"deleted" | "rejected" | "timed-out"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Invoke in a promise continuation so even a synchronous binding/proxy
    // throw is converted into the same bounded false result as a rejection.
    const deletion = Promise.resolve()
      .then(() => bucket.delete(key))
      .then(
        () => "deleted" as const,
        () => "rejected" as const,
      );
    return await Promise.race([
      deletion,
      new Promise<"timed-out">((resolve) => {
        timer = setTimeout(
          () => resolve("timed-out"),
          normalizeTimeoutMs(timeoutMs),
        );
      }),
    ]);
  } catch {
    return "rejected";
  } finally {
    clearTimeout(timer);
  }
}

async function optionalStringValue(
  value: unknown,
): Promise<string | undefined> {
  const resolved = await Promise.resolve(value);
  return typeof resolved === "string" && resolved.trim() ? resolved : undefined;
}

function normalizeArtifactStatus(
  status: string | undefined,
): ArtifactsRepoInfo["status"] {
  return status === "ready" ||
    status === "creating" ||
    status === "importing" ||
    status === "forking"
    ? status
    : undefined;
}

export const __testing = {
  collectWorkspaceEntries,
  createOrGetArtifactRepo,
  fileStoreR2Prefix,
  isArtifactsBindingUnavailableError,
  settleR2Delete,
  sha256StreamHex,
  streamToR2,
  withOperationDeadline,
};

function artifactRepoName(_workspaceKey: string, projectId: string): string {
  return normalizeGlobalProjectId(projectId).slice(0, 63);
}

export function artifactVanityRemote(projectId: string): string {
  const project = normalizeGlobalProjectId(projectId);
  return `https://${ARTIFACTS_VANITY_HOST}/git/${project}.git`;
}

function toPublicProject(project: WorkspaceProject): WorkspaceProject {
  return {
    ...project,
    description: projectDescription(project),
    kind: project.clonedFromProjectId ? "clone" : "project",
    artifactRepoName: undefined,
    artifactRepoId: undefined,
    artifactRemote: project.artifactRemote
      ? artifactVanityRemote(project.artifactRemoteProjectId || project.id)
      : undefined,
  };
}

function nestProjectClones(projects: WorkspaceProject[]): WorkspaceProject[] {
  const byId = new Map(projects.map((project) => [project.id, project]));
  const clonesBySource = new Map<string, WorkspaceProjectCloneSummary[]>();

  for (const project of projects) {
    if (!project.clonedFromProjectId) continue;
    const sourceId =
      project.artifactRemoteProjectId || project.clonedFromProjectId;
    const source = byId.get(sourceId) ?? byId.get(project.clonedFromProjectId);
    project.cloneSource = source
      ? {
          id: source.id,
          name: source.name,
          description: projectDescription(source),
        }
      : {
          id: sourceId,
          name: sourceId,
          description: `Source project ${sourceId}.`,
        };
    const clones = clonesBySource.get(sourceId) ?? [];
    clones.push(toProjectCloneSummary(project));
    clonesBySource.set(sourceId, clones);
  }

  for (const project of projects) {
    const clones = clonesBySource.get(project.id) ?? [];
    clones.sort(
      (a, b) =>
        a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    );
    project.clones = clones;
    project.cloneCount = clones.length;
  }

  return projects.filter((project) => project.kind !== "clone");
}

function toProjectCloneSummary(
  project: WorkspaceProject,
): WorkspaceProjectCloneSummary {
  if (!project.clonedFromProjectId) {
    throw new Error(`Project ${project.id} is not a clone`);
  }
  return {
    id: project.id,
    name: project.name,
    description: projectDescription(project),
    defaultVmId: project.defaultVmId,
    backend: "do-r2",
    clonedFromProjectId: project.clonedFromProjectId,
    artifactRemote: project.artifactRemote,
    artifactStatus: project.artifactStatus,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  };
}

export function globalProjectId(workspaceId: string, value: unknown): string {
  const workspacePart = compactWorkspaceId(workspaceId);
  const slug = normalizeRegistryId(value, "project");
  const slugPart = slug.slice(0, 14) || "project";
  const hash = fnv1a(`${workspaceId}:${slug}`)
    .toString(36)
    .slice(0, 4)
    .padStart(4, "0");
  return normalizeGlobalProjectId(`ca-${workspacePart}-${slugPart}-${hash}`);
}

function compactWorkspaceId(workspaceId: string): string {
  const compact = workspaceId.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (compact.length >= 32) return compact.slice(0, 32);
  return `${compact}${fnv1a(workspaceId).toString(36)}`
    .slice(0, 32)
    .padEnd(32, "0");
}

function requireProjectName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("project name is required");
  }
  return value.trim();
}

function requireProjectNameKey(value: unknown, label: string): string {
  const key = projectNameKey(requireProjectName(value));
  if (!key) throw new Error(`${label} is required`);
  return key;
}

function projectNameKey(value: unknown): string {
  return normalizeRegistryId(value, "project");
}

export { projectNameKey };

function requireWorkspaceId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(
      "workspaceId is required to create a globally unique project id",
    );
  }
  return value.trim();
}

function fnv1a(value: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function isWorkspaceProject(value: unknown): value is WorkspaceProject {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as WorkspaceProject).id === "string" &&
    typeof (value as WorkspaceProject).name === "string" &&
    (value as WorkspaceProject).backend === "do-r2",
  );
}

function projectDescription(
  project: Pick<WorkspaceProject, "id" | "name"> & { description?: unknown },
): string {
  return typeof project.description === "string" && project.description.trim()
    ? project.description.trim()
    : `Project ${project.name || project.id}.`;
}

function requireProjectDescription(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("project description is required");
  }
  const description = value.trim();
  if (!description) {
    throw new Error("project description is required");
  }
  return description;
}

function normalizeProjectSnapshotPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/");
}

function shouldIgnoreProjectSnapshotPath(path: string): boolean {
  return path
    .split("/")
    .some(
      (part) =>
        part === "node_modules" ||
        part === ".git" ||
        part === ".wrangler" ||
        part === ".cache" ||
        part === "dist" ||
        part === "build",
    );
}

function requireSnapshotId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value.trim())) {
    throw new Error("snapshot id is required");
  }
  return value.trim();
}

function validateProjectSourceSnapshot(
  value: unknown,
  expectedId: string,
  durableId: string,
): ProjectSourceSnapshot {
  if (!value || typeof value !== "object") {
    throw new Error("Project source snapshot is malformed");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("Project source snapshot is not serializable");
  }
  if (utf8ByteLength(serialized) > PROJECT_SNAPSHOT_MAX_MANIFEST_BYTES) {
    throw new Error(
      `Project source snapshot exceeds the ${PROJECT_SNAPSHOT_MAX_MANIFEST_BYTES} byte manifest limit`,
    );
  }
  const snapshot = value as Partial<ProjectSourceSnapshot>;
  if (
    snapshot.id !== expectedId ||
    typeof snapshot.createdAt !== "string" ||
    (snapshot.message !== undefined &&
      (typeof snapshot.message !== "string" ||
        snapshot.message.length > 240)) ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.length > PROJECT_SNAPSHOT_MAX_FILES ||
    snapshot.fileCount !== snapshot.entries.length ||
    !Number.isSafeInteger(snapshot.totalBytes) ||
    (snapshot.totalBytes as number) < 0 ||
    (snapshot.totalBytes as number) > PROJECT_SNAPSHOT_MAX_TOTAL_BYTES
  ) {
    throw new Error("Project source snapshot metadata is malformed");
  }

  const paths: string[] = [];
  let totalBytes = 0;
  for (const candidate of snapshot.entries) {
    if (!candidate || typeof candidate !== "object") {
      throw new Error("Project source snapshot entry is malformed");
    }
    const entry = candidate as Partial<ProjectSourceSnapshotEntry>;
    const rawPath = typeof entry.path === "string" ? entry.path : "";
    const path =
      rawPath.length <= WORKSPACE_PATH_MAX_BYTES
        ? normalizeProjectSnapshotPath(rawPath)
        : "";
    if (
      !path ||
      path !== rawPath ||
      utf8ByteLength(path) > WORKSPACE_PATH_MAX_BYTES ||
      !Number.isSafeInteger(entry.size) ||
      (entry.size as number) < 0 ||
      (entry.size as number) > PROJECT_SNAPSHOT_MAX_FILE_BYTES ||
      typeof entry.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(entry.sha256) ||
      entry.blobKey !== projectSnapshotBlobKey(durableId, entry.sha256)
    ) {
      throw new Error("Project source snapshot entry is malformed");
    }
    totalBytes += entry.size as number;
    if (!Number.isSafeInteger(totalBytes)) {
      throw new Error("Project source snapshot byte total is invalid");
    }
    paths.push(path);
  }
  if (totalBytes !== snapshot.totalBytes) {
    throw new Error("Project source snapshot byte total is inconsistent");
  }
  paths.sort((a, b) => a.localeCompare(b));
  for (let index = 0; index < paths.length; index += 1) {
    if (index > 0 && paths[index] === paths[index - 1]) {
      throw new Error(
        `Project source snapshot has a duplicate path: ${paths[index]}`,
      );
    }
    const next = paths[index + 1];
    if (next?.startsWith(`${paths[index]}/`)) {
      throw new Error(
        `Project source snapshot has a file/descendant collision: ${paths[index]}`,
      );
    }
  }
  return snapshot as ProjectSourceSnapshot;
}

function projectSnapshotBlobKey(durableId: string, sha256: string): string {
  return `project-source-snapshots/${durableId}/${sha256}`;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const content = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
  const digest = await crypto.subtle.digest("SHA-256", content);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function sha256StreamHex(
  source: ReadableStream<Uint8Array>,
  timeoutMs = WORKSPACE_R2_ADOPT_MS,
): Promise<string> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pump: Promise<void> | undefined;
  try {
    // workers-runtime global; the ambient Crypto type in this tsconfig
    // predates DigestStream. Setup stays inside ownership cleanup so even a
    // constructor/pipeTo throw cancels an unread source.
    const digestStream = new (
      crypto as unknown as {
        DigestStream: new (
          algorithm: string,
        ) => WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
      }
    ).DigestStream("SHA-256");
    pump = source.pipeTo(digestStream, { signal: abort.signal });
    const digest = await Promise.race([
      Promise.allSettled([pump, digestStream.digest]).then(
        ([pumpResult, digestResult]) => {
          if (pumpResult.status === "rejected") throw pumpResult.reason;
          if (digestResult.status === "rejected") throw digestResult.reason;
          return digestResult.value;
        },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new WorkspaceAdoptTimeoutError(
            "Streaming SHA-256 exceeded its absolute deadline",
          );
          abort.abort(error);
          reject(error);
        }, normalizeTimeoutMs(timeoutMs));
      }),
    ]);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  } catch (error) {
    if (!abort.signal.aborted) abort.abort(error);
    void pump?.catch(() => undefined);
    let failure = error;
    if (!source.locked) {
      try {
        await cancelUnreadStreamBounded(
          source,
          "streaming SHA-256 failed",
          timeoutMs,
        );
      } catch (cancelError) {
        failure = cancelError;
      }
    }
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

function normalizeTimeoutMs(value: number): number {
  return Math.max(
    1,
    Math.min(2_147_483_647, Number.isFinite(value) ? Math.floor(value) : 1),
  );
}

function escapeSqlLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

function remainingOperationMs(deadlineAt: number, operation: string): number {
  const remaining = deadlineAt - Date.now();
  if (!Number.isFinite(remaining) || remaining <= 0) {
    throw new WorkspaceAdoptTimeoutError(`${operation} timed out`);
  }
  return normalizeTimeoutMs(remaining);
}

async function withOperationDeadline<T>(
  operation: () => Promise<T>,
  deadlineAt: number,
  label: string,
): Promise<T> {
  // Validate before creating the operation promise. In particular, an
  // already-expired deadline must not dispatch an R2 binding call at all.
  const timeoutMs = remainingOperationMs(deadlineAt, label);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const pending = Promise.resolve().then(operation);
  void pending.then(
    (value) => {
      if (!timedOut || !value || typeof value !== "object") return;
      try {
        const body =
          value instanceof ReadableStream
            ? value
            : (value as { body?: unknown }).body;
        if (body instanceof ReadableStream) {
          cancelUnreadStream(body, `${label} completed after its deadline`);
        }
      } catch {
        // A late read result is already detached from the failed operation.
      }
    },
    () => undefined,
  );
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new WorkspaceAdoptTimeoutError(`${label} timed out`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    void pending.catch(() => undefined);
  }
}

export function relativeUnderRoot(root: string, path: string): string {
  const normalizedRoot =
    normalizeWorkspacePath(root).replace(/\/+$/, "") || "/";
  const normalizedPath = normalizeWorkspacePath(path);
  if (normalizedRoot === "/") return normalizedPath.replace(/^\/+/, "");
  if (normalizedPath === normalizedRoot) return "";
  if (normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizedPath.slice(normalizedRoot.length + 1);
  }
  return normalizedPath.replace(/^\/+/, "");
}

function emptyWorkspaceTreeCounters(): WorkspaceTreeCounters {
  return { entryCount: 0, fileCount: 0, pathBytes: 0, totalBytes: 0 };
}

function normalizeWorkspaceTreeBound(
  value: number | undefined,
  fallback: number,
): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

function normalizeWorkspaceTreeBounds(
  bounds: WorkspaceTreeBounds | undefined,
): NormalizedWorkspaceTreeBounds {
  return {
    maxEntries: Math.min(
      WORKSPACE_LIST_MAX_ENTRIES,
      normalizeWorkspaceTreeBound(
        bounds?.maxEntries,
        WORKSPACE_LIST_MAX_ENTRIES,
      ),
    ),
    maxFiles: Math.min(
      WORKSPACE_LIST_MAX_ENTRIES,
      normalizeWorkspaceTreeBound(bounds?.maxFiles, WORKSPACE_LIST_MAX_ENTRIES),
    ),
    maxPathBytes: Math.min(
      WORKSPACE_LIST_MAX_PATH_BYTES,
      normalizeWorkspaceTreeBound(
        bounds?.maxPathBytes,
        WORKSPACE_LIST_MAX_PATH_BYTES,
      ),
    ),
    maxFileBytes: normalizeWorkspaceTreeBound(
      bounds?.maxFileBytes,
      Number.MAX_SAFE_INTEGER,
    ),
    maxTotalBytes: normalizeWorkspaceTreeBound(
      bounds?.maxTotalBytes,
      Number.MAX_SAFE_INTEGER,
    ),
  };
}

async function collectWorkspaceEntries(
  filesStore: Workspace,
  root: string,
  initialDirectory: string,
  files: WorkspaceListEntry[] | null,
  options: WorkspaceTreeCollectOptions,
): Promise<void> {
  const pendingDirectories = [initialDirectory];
  let visitedEntries = options.counters.entryCount;
  let visitedPathBytes = options.counters.pathBytes;

  while (pendingDirectories.length > 0) {
    if (files && files.length >= options.limit && !options.completeForBounds)
      return;
    const directory = pendingDirectories.pop() as string;
    const childDirectories: string[] = [];
    let offset = 0;
    let after: WorkspaceDirectoryCursor | undefined;

    for (;;) {
      if (files && files.length >= options.limit && !options.completeForBounds)
        return;
      const remainingEntries = options.bounds.maxEntries - visitedEntries;
      const pageLimit = Math.max(
        1,
        Math.min(WORKSPACE_LIST_PAGE_SIZE, remainingEntries + 1),
      );
      const page = options.readPage
        ? await options.readPage(directory, after, pageLimit)
        : await filesStore.readDir(directory, {
            limit: pageLimit,
            offset,
          });
      if (page.length > pageLimit) {
        throw new Error(
          "File store returned more directory entries than requested",
        );
      }
      if (page.length === 0) break;
      if (options.readPage) {
        const last = page.at(-1) as FileInfo;
        const next = {
          type: last.type,
          name: last.name,
          path: last.path,
        };
        if (
          after &&
          (next.type < after.type ||
            (next.type === after.type && next.name < after.name) ||
            (next.type === after.type &&
              next.name === after.name &&
              next.path <= after.path))
        ) {
          throw new Error("File store keyset pagination did not advance");
        }
        after = next;
      } else {
        offset += page.length;
      }

      for (const entry of page) {
        if (
          files &&
          files.length >= options.limit &&
          !options.completeForBounds
        )
          return;
        if (visitedEntries >= options.bounds.maxEntries) {
          throw new Error(
            `File tree exceeds the ${options.bounds.maxEntries} entry limit`,
          );
        }
        const relativePath = relativeUnderRoot(root, entry.path);
        const nextVisitedPathBytes =
          visitedPathBytes + utf8ByteLength(relativePath);
        if (
          !Number.isSafeInteger(nextVisitedPathBytes) ||
          nextVisitedPathBytes > options.bounds.maxPathBytes
        ) {
          throw new Error(
            `File tree exceeds the ${options.bounds.maxPathBytes} path-byte limit`,
          );
        }
        visitedEntries += 1;
        visitedPathBytes = nextVisitedPathBytes;

        // Hidden entries still consume the traversal budget. Otherwise a tree
        // containing only hidden paths could force unbounded pagination.
        if (!options.includeHidden && isHiddenPath(relativePath)) continue;
        countWorkspaceTreeEntry(
          entry,
          root,
          entry.path,
          options.counters,
          options.bounds,
        );
        if (files && files.length < options.limit) {
          files.push(toListEntry(entry, root, entry.path));
        }
        if (options.recursive && entry.type === "directory") {
          childDirectories.push(entry.path);
        }
      }

      // A short page is exhaustive. A full page requires one lookahead,
      // including at an exact multiple of the fixed page size.
      if (page.length < pageLimit) break;
    }

    // LIFO plus reverse insertion gives deterministic directory order without
    // recursion or retaining a page at every level of a deep tree.
    for (let index = childDirectories.length - 1; index >= 0; index -= 1) {
      pendingDirectories.push(childDirectories[index]);
    }
  }
}

function countWorkspaceTreeEntry(
  entry: FileInfo,
  root: string,
  absolutePath: string,
  counters: WorkspaceTreeCounters,
  bounds: NormalizedWorkspaceTreeBounds,
): void {
  if (counters.entryCount >= bounds.maxEntries) {
    throw new Error(`File tree exceeds the ${bounds.maxEntries} entry limit`);
  }
  const relativePath = relativeUnderRoot(root, absolutePath || entry.path);
  const nextPathBytes = counters.pathBytes + utf8ByteLength(relativePath);
  if (
    !Number.isSafeInteger(nextPathBytes) ||
    nextPathBytes > bounds.maxPathBytes
  ) {
    throw new Error(
      `File tree exceeds the ${bounds.maxPathBytes} path-byte limit`,
    );
  }
  counters.entryCount += 1;
  counters.pathBytes = nextPathBytes;

  if (entry.type === "directory") return;
  if (!Number.isSafeInteger(entry.size) || entry.size < 0) {
    throw new Error(
      `File tree contains an invalid byte size at ${relativePath}`,
    );
  }
  if (entry.size > bounds.maxFileBytes) {
    throw new Error(
      `File ${relativePath} exceeds the ${bounds.maxFileBytes} byte limit`,
    );
  }
  if (counters.fileCount >= bounds.maxFiles) {
    throw new Error(`File tree exceeds the ${bounds.maxFiles} file limit`);
  }
  const nextTotalBytes = counters.totalBytes + entry.size;
  if (
    !Number.isSafeInteger(nextTotalBytes) ||
    nextTotalBytes > bounds.maxTotalBytes
  ) {
    throw new Error(
      `File tree exceeds the ${bounds.maxTotalBytes} aggregate-byte limit`,
    );
  }
  counters.fileCount += 1;
  counters.totalBytes = nextTotalBytes;
}

function toListEntry(
  entry: FileInfo,
  root: string,
  absolutePath: string,
): WorkspaceListEntry {
  return {
    name: entry.name,
    type: entry.type === "directory" ? "directory" : "file",
    size: entry.size,
    modifiedAt: new Date(entry.updatedAt).toISOString(),
    relativePath: relativeUnderRoot(root, absolutePath || entry.path),
    absolutePath: normalizeWorkspacePath(absolutePath || entry.path),
    mimeType: entry.mimeType,
  };
}

function isHiddenPath(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function decodeMaybeText(bytes: Uint8Array): {
  content: string;
  isBinary: boolean;
} {
  if (bytes.includes(0)) {
    return { content: bytesToBase64(bytes), isBinary: true };
  }
  try {
    return {
      content: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      isBinary: false,
    };
  } catch {
    return { content: bytesToBase64(bytes), isBinary: true };
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.slice(i, i + chunkSize));
  }
  return btoa(binary);
}

function boundedBase64DecodedSize(value: string, maxBytes: number): number {
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4;
  if (value.length > maxEncodedLength) {
    throw new WorkspaceFileTooLargeError(
      `Binary writes are limited to ${maxBytes} decoded bytes; use streamed adoption for larger files`,
    );
  }
  if (
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value,
    )
  ) {
    throw new Error("Invalid base64 content");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const size = (value.length / 4) * 3 - padding;
  if (!Number.isSafeInteger(size) || size > maxBytes) {
    throw new WorkspaceFileTooLargeError(
      `Binary writes are limited to ${maxBytes} decoded bytes; use streamed adoption for larger files`,
    );
  }
  return size;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isArtifactsBindingUnavailableError(message: string): boolean {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("binding artifacts needs to be run remotely") ||
    normalized.includes("artifacts binding is not configured")
  );
}
