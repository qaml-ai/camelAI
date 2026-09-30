import { S3Mount, SandboxFileError, type Files, type S3GatewayBinding } from "@cloudflare/sandbox";

import { isSelfhostRuntime, type SelfhostRuntimeEnv } from "../../../src/lib/selfhost-runtime.js";

/**
 * R2 prefixes exposed as directories inside a native (Sandbox SDK 1.0)
 * container. The only part of a container class that differs between
 * Cloudflare and self-host:
 *
 * - Cloudflare (`S3BucketMounts`, kind "live"): an s3fs FUSE mount through
 *   `S3Mount`. 1.0 cannot mount through an R2 binding, so the exported
 *   `S3Gateway` entrypoint signs each request with an R2 API token. The
 *   credentials stay in the Worker and the gateway only serves the mount's own
 *   key prefix with the mount's access, so a container can reach nothing else.
 * - Self-host (`SyncBucketMounts`, kind "sync"): workerd's local R2 has no S3
 *   endpoint and self-host containers get no /dev/fuse, so `mount()` copies the
 *   prefix into the container through the R2 binding and `flush()` copies
 *   container-side changes of a read-write mount back. This is what 0.12's
 *   `localBucket` sync did, done by the Worker instead of the sandbox server.
 *
 * Contract for callers: after `mount(m)`, an object at `<m.keyPrefix>/a/b`
 * reads at `<m.mountPath>/a/b` (not for write-only). For a read-write or
 * write-only mount, a file written at `<m.mountPath>/a/b` is in the bucket at
 * `<m.keyPrefix>/a/b` once the file is closed (live) or once `flush(m)` returns
 * (sync).
 */
export interface SandboxBucketMounts {
  /**
   * "live" mounts register a per-host outbound intercept each time a path is
   * mounted fresh: mount them before any catch-all intercept, which would
   * otherwise take their traffic (a repair after the catch-all fails).
   */
  readonly kind: "live" | "sync";
  /**
   * Exposes the prefix at `mountPath`. Safe to call again on a running
   * container: a live mount is reused (or repaired), a sync mount refreshed.
   */
  mount(mount: BucketMount): Promise<void>;
  /** Copies container-side changes under a read-write mount to the bucket. Live: nothing to do. */
  flush(mount: BucketMount): Promise<void>;
}

/** R2 bindings a container can mount. The bucket name is the `<binding>_NAME` var. */
export type BucketMountBinding = "R2_BUCKET" | "WAREHOUSE_EXPORT_BUCKET";

export interface BucketMount {
  readonly binding: BucketMountBinding;
  /** Object-key prefix, without leading or trailing slash. */
  readonly keyPrefix: string;
  /** Absolute directory in the container. */
  readonly mountPath: string;
  /**
   * "write-only" is for a container that only adds objects (e.g. export
   * files): live, it is a read-write mount; sync, nothing is copied in and
   * `flush()` MOVES each written file to the bucket (the local copy is
   * removed, and a missing local file never deletes an object).
   */
  readonly access: "read-only" | "read-write" | "write-only";
}

export interface BucketMountEnv extends SelfhostRuntimeEnv {
  /** The R2 S3 endpoint is `https://<account>.r2.cloudflarestorage.com` unless R2_S3_ENDPOINT is set. */
  CF_ACCOUNT_ID?: string;
  /** Optional endpoint override (e.g. a local S3-compatible server). */
  R2_S3_ENDPOINT?: string;
  /** R2 API token id (the S3 access key id). Secret. */
  R2_S3_ACCESS_KEY_ID?: string;
  /** SHA-256 hex of the R2 API token value (the S3 secret access key). Secret. */
  R2_S3_SECRET_ACCESS_KEY?: string;
  R2_BUCKET?: R2Bucket;
  R2_BUCKET_NAME?: string;
  WAREHOUSE_EXPORT_BUCKET?: R2Bucket;
  WAREHOUSE_EXPORT_BUCKET_NAME?: string;
}

/** Mount configuration is missing; the message names what to set. */
export class BucketMountConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BucketMountConfigError";
  }
}

/** The container surface both implementations use. */
export type BucketMountContainer = Pick<Container, "exec" | "interceptOutboundHttp">;

/** Picks the platform's implementation. */
export function createSandboxBucketMounts(options: {
  container: BucketMountContainer;
  files: Pick<Files, "mkdir" | "writeFile" | "readFile" | "rename" | "remove" | "stat">;
  gateway: () => S3GatewayBinding;
  env: BucketMountEnv;
}): SandboxBucketMounts {
  if (isSelfhostRuntime(options.env)) {
    return new SyncBucketMounts(options.container, options.files, options.env);
  }
  return new S3BucketMounts(options.container, options.gateway(), options.env);
}

/** Refuses prefixes and paths a mount must never take. */
export function assertBucketMount(mount: BucketMount): void {
  const { keyPrefix, mountPath } = mount;
  if (!keyPrefix || keyPrefix.startsWith("/") || keyPrefix.endsWith("/") || keyPrefix.split("/").includes("..")) {
    throw new Error(`Invalid mount key prefix: ${keyPrefix}`);
  }
  if (!/^\/[A-Za-z0-9._/-]+$/.test(mountPath) || mountPath.split("/").includes("..") || mountPath.endsWith("/")) {
    throw new Error(`Invalid mount path: ${mountPath}`);
  }
}

// ---------------------------------------------------------------------------
// Cloudflare: s3fs through S3Mount + S3Gateway
// ---------------------------------------------------------------------------

export class S3BucketMounts implements SandboxBucketMounts {
  readonly kind = "live" as const;
  private readonly s3: Pick<S3Mount, "mount">;

  constructor(
    container: BucketMountContainer,
    gateway: S3GatewayBinding,
    private readonly env: BucketMountEnv,
    s3?: Pick<S3Mount, "mount">,
  ) {
    this.s3 = s3 ?? new S3Mount(container, gateway);
  }

  async mount(mount: BucketMount): Promise<void> {
    assertBucketMount(mount);
    const source = s3MountSource(this.env, mount.binding);
    await this.s3.mount({
      mountPath: mount.mountPath,
      source,
      keyPrefix: mount.keyPrefix,
      access: mount.access === "write-only" ? "read-write" : mount.access,
      // Shrink the s3fs stat cache (default 60s plus negative caching) so an
      // object staged by another container (an export, an upload) is visible
      // on the next read instead of a stale or missing entry.
      s3fsOptions: { stat_cache_expire: 1 },
    });
  }

  /** s3fs uploads a file when it is closed. */
  async flush(): Promise<void> {}
}

/** The S3 source for a binding's bucket, or a config error naming what is missing. */
export function s3MountSource(env: BucketMountEnv, binding: BucketMountBinding) {
  const bucketVar = `${binding}_NAME` as const;
  const bucket = env[bucketVar]?.trim();
  const accountId = env.CF_ACCOUNT_ID?.trim();
  const endpoint = env.R2_S3_ENDPOINT?.trim() || (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "");
  const accessKeyId = env.R2_S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_S3_SECRET_ACCESS_KEY?.trim();
  const missing = [
    [bucketVar, bucket],
    ["CF_ACCOUNT_ID (or R2_S3_ENDPOINT)", endpoint],
    ["R2_S3_ACCESS_KEY_ID", accessKeyId],
    ["R2_S3_SECRET_ACCESS_KEY", secretAccessKey],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length > 0) {
    throw new BucketMountConfigError(`R2 bucket mounts are not configured: set ${missing.join(", ")}`);
  }
  return {
    type: "s3" as const,
    endpoint,
    region: "auto",
    bucket: bucket!,
    credentials: { type: "static" as const, accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
  };
}

// ---------------------------------------------------------------------------
// Self-host: copy through the R2 binding
// ---------------------------------------------------------------------------

/** Where a sync mount records what it copied, per container (a new container starts empty). */
export const SYNC_MOUNT_STATE_DIR = "/var/lib/camelai-mounts";

/** Temp-file marker; never synced. */
const SYNC_TEMP_PREFIX = ".camelai-sync-";

/** A prefix beyond this many objects is refused rather than half-copied. */
export const SYNC_MOUNT_MAX_OBJECTS = 50_000;

/** Per-file record: the bucket's etag and the local size/mtime right after the copy. */
interface SyncedFile {
  etag: string;
  size: number;
  mtime: string;
}

interface SyncState {
  version: 1;
  keyPrefix: string;
  files: Record<string, SyncedFile>;
}

interface LocalFile {
  size: number;
  mtime: string;
}

type SyncFiles = Pick<Files, "mkdir" | "writeFile" | "readFile" | "rename" | "remove" | "stat">;

/**
 * Self-host sync mounts. `mount()` makes the directory match the prefix
 * (downloads new or changed objects, removes files whose object was deleted),
 * except files a read-write mount changed locally, which `flush()` uploads
 * (and whose local deletion it propagates). A state file per mount records the
 * etag and local size/mtime of every copied file, so each call moves only what
 * changed. Operations on one mount path are serialized.
 *
 * Read-only is enforced the way 0.12's local sync did: nothing is ever copied
 * back. (Container processes run as root, so the files are not locked.)
 */
export class SyncBucketMounts implements SandboxBucketMounts {
  readonly kind = "sync" as const;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly container: Pick<Container, "exec">,
    private readonly files: SyncFiles,
    private readonly env: BucketMountEnv,
  ) {}

  mount(mount: BucketMount): Promise<void> {
    assertBucketMount(mount);
    if (mount.access === "write-only") {
      return this.serialized(mount.mountPath, () => this.files.mkdir(mount.mountPath, { recursive: true }));
    }
    return this.serialized(mount.mountPath, () => this.pull(mount));
  }

  flush(mount: BucketMount): Promise<void> {
    assertBucketMount(mount);
    if (mount.access === "write-only") return this.serialized(mount.mountPath, () => this.move(mount));
    if (mount.access !== "read-write") return Promise.resolve();
    return this.serialized(mount.mountPath, () => this.push(mount));
  }

  private serialized<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.queues.set(key, next);
    void next.finally(() => {
      if (this.queues.get(key) === next) this.queues.delete(key);
    }).catch(() => {});
    return next;
  }

  private bucket(binding: BucketMountBinding): R2Bucket {
    const bucket = this.env[binding];
    if (!bucket) throw new BucketMountConfigError(`${binding} binding is required for self-host bucket mounts`);
    return bucket;
  }

  private async pull(mount: BucketMount): Promise<void> {
    const bucket = this.bucket(mount.binding);
    const objects = await listPrefix(bucket, mount.keyPrefix);
    const state = await this.readState(mount);
    await this.files.mkdir(mount.mountPath, { recursive: true });
    const local = await this.listLocal(mount.mountPath);
    const next: SyncState = { version: 1, keyPrefix: mount.keyPrefix, files: {} };
    const copied = new Set<string>();

    for (const [rel, object] of objects) {
      const previous = state.files[rel];
      const current = local.get(rel);
      if (previous && current && sameLocal(previous, current)) {
        if (previous.etag === object.etag) {
          next.files[rel] = previous;
          continue;
        }
      } else if (mount.access === "read-write" && current) {
        // Written in the container since the last copy (or never copied):
        // flush() uploads it; the container's version wins.
        if (previous) next.files[rel] = previous;
        continue;
      }
      await this.download(bucket, mount, rel);
      copied.add(rel);
      next.files[rel] = { etag: object.etag, size: object.size, mtime: "" };
    }

    // Objects deleted from the bucket: drop the copy unless the container
    // changed it since (a read-write mount then uploads it again).
    for (const [rel, previous] of Object.entries(state.files)) {
      if (objects.has(rel)) continue;
      const current = local.get(rel);
      if (!current) continue;
      if (mount.access === "read-write" && !sameLocal(previous, current)) continue;
      await this.files.remove(`${mount.mountPath}/${rel}`, { force: true });
    }

    if (copied.size > 0) {
      const after = await this.listLocal(mount.mountPath);
      for (const rel of copied) {
        const file = after.get(rel);
        if (file) next.files[rel] = { ...next.files[rel], size: file.size, mtime: file.mtime };
        else delete next.files[rel];
      }
    }
    await this.writeState(mount, next);
  }

  /** Write-only: upload every file under the mount path, then remove it locally. */
  private async move(mount: BucketMount): Promise<void> {
    const bucket = this.bucket(mount.binding);
    const failures: string[] = [];
    for (const [rel, file] of await this.listLocal(mount.mountPath)) {
      try {
        await this.upload(bucket, mount, rel, file.size);
        await this.files.remove(`${mount.mountPath}/${rel}`, { force: true });
      } catch (error) {
        failures.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Could not copy ${failures.length} file(s) from ${mount.mountPath} to R2: ${failures.join("; ").slice(0, 1000)}`);
    }
  }

  private async push(mount: BucketMount): Promise<void> {
    const bucket = this.bucket(mount.binding);
    const state = await this.readState(mount);
    const local = await this.listLocal(mount.mountPath);
    const next: SyncState = { version: 1, keyPrefix: mount.keyPrefix, files: { ...state.files } };
    const failures: string[] = [];

    for (const [rel, file] of local) {
      const previous = state.files[rel];
      if (previous && sameLocal(previous, file)) continue;
      try {
        const etag = await this.upload(bucket, mount, rel, file.size);
        next.files[rel] = { etag, size: file.size, mtime: file.mtime };
      } catch (error) {
        // Most likely still being written; the next flush retries it.
        failures.push(`${rel}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    for (const rel of Object.keys(state.files)) {
      if (local.has(rel)) continue;
      await bucket.delete(`${mount.keyPrefix}/${rel}`);
      delete next.files[rel];
    }
    await this.writeState(mount, next);
    if (failures.length > 0) {
      throw new Error(`Could not copy ${failures.length} file(s) from ${mount.mountPath} to R2: ${failures.join("; ").slice(0, 1000)}`);
    }
  }

  private async download(bucket: R2Bucket, mount: BucketMount, rel: string): Promise<void> {
    const object = await bucket.get(`${mount.keyPrefix}/${rel}`);
    if (!object) return; // Deleted between the listing and the read.
    const target = `${mount.mountPath}/${rel}`;
    const slash = target.lastIndexOf("/");
    const dir = target.slice(0, slash);
    await this.files.mkdir(dir, { recursive: true });
    // Write beside the target and rename, so a reader never sees half a file.
    const temp = `${dir}/${SYNC_TEMP_PREFIX}${crypto.randomUUID()}`;
    try {
      await this.files.writeFile(temp, object.body);
      await this.files.rename(temp, target);
    } catch (error) {
      await this.files.remove(temp, { force: true }).catch(() => {});
      throw error;
    }
  }

  private async upload(bucket: R2Bucket, mount: BucketMount, rel: string, size: number): Promise<string> {
    const response = await this.files.readFile(`${mount.mountPath}/${rel}`);
    if (!response.body) throw new Error("no body");
    // R2 needs the length up front for a streamed body; a file that changes
    // size while it is read fails the put instead of storing a torn copy.
    const sized = new FixedLengthStream(size);
    const [stored] = await Promise.all([
      bucket.put(`${mount.keyPrefix}/${rel}`, sized.readable),
      response.body.pipeTo(sized.writable),
    ]);
    if (!stored) throw new Error("R2 did not store the object");
    return stored.etag;
  }

  /** Regular files under `dir` (relative path → size, mtime), temp files excluded. */
  private async listLocal(dir: string): Promise<Map<string, LocalFile>> {
    const child = await this.container.exec(
      ["find", dir, "-type", "f", "-printf", "%s\\t%T@\\t%P\\0"],
      { cwd: "/", env: { LANG: "C.UTF-8" } },
    );
    const output = await child.output();
    const files = new Map<string, LocalFile>();
    if (output.exitCode !== 0) {
      const stderr = new TextDecoder().decode(output.stderr);
      if (/No such file or directory/.test(stderr)) return files;
      throw new Error(`Could not list ${dir}: ${stderr.trim().slice(0, 500)}`);
    }
    for (const record of new TextDecoder().decode(output.stdout).split("\0")) {
      const [size, mtime, rel] = record.split("\t");
      if (!rel || rel.split("/").some((part) => part.startsWith(SYNC_TEMP_PREFIX))) continue;
      files.set(rel, { size: Number(size), mtime });
    }
    return files;
  }

  private statePath(mount: BucketMount): string {
    return `${SYNC_MOUNT_STATE_DIR}/${mount.mountPath.slice(1).replaceAll("/", "__")}.json`;
  }

  private async readState(mount: BucketMount): Promise<SyncState> {
    const empty: SyncState = { version: 1, keyPrefix: mount.keyPrefix, files: {} };
    try {
      const state = await (await this.files.readFile(this.statePath(mount))).json<SyncState>();
      return state?.version === 1 && state.keyPrefix === mount.keyPrefix && state.files ? state : empty;
    } catch (error) {
      if (SandboxFileError.is(error) && error.code === "ENOENT") return empty;
      throw error;
    }
  }

  private async writeState(mount: BucketMount, state: SyncState): Promise<void> {
    await this.files.mkdir(SYNC_MOUNT_STATE_DIR, { recursive: true });
    const path = this.statePath(mount);
    const temp = `${path}.${crypto.randomUUID()}.tmp`;
    await this.files.writeFile(temp, JSON.stringify(state));
    await this.files.rename(temp, path);
  }
}

function sameLocal(recorded: SyncedFile, current: LocalFile): boolean {
  return recorded.size === current.size && recorded.mtime === current.mtime;
}

/** Every object under `<prefix>/`, by path relative to the prefix. */
async function listPrefix(bucket: R2Bucket, prefix: string): Promise<Map<string, { etag: string; size: number }>> {
  const objects = new Map<string, { etag: string; size: number }>();
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: `${prefix}/`, cursor, limit: 1000 });
    for (const object of page.objects) {
      const rel = object.key.slice(prefix.length + 1);
      // Directory markers and keys that cannot be a file path in the mount.
      if (!rel || rel.endsWith("/") || rel.split("/").some((part) => !part || part === "." || part === "..")) continue;
      objects.set(rel, { etag: object.etag, size: object.size });
    }
    if (objects.size > SYNC_MOUNT_MAX_OBJECTS) {
      throw new Error(`${prefix}/ holds more than ${SYNC_MOUNT_MAX_OBJECTS} objects; too many to copy into the container`);
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return objects;
}
