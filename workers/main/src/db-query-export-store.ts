import { S3Mount, type Files, type S3GatewayBinding } from "@cloudflare/sandbox-v1";

/**
 * Where DbQueryContainer's export runner writes Parquet extracts, and how they
 * reach the WAREHOUSE_EXPORT_BUCKET. The only part of the class that differs
 * between Cloudflare and self-host.
 *
 * Contract: after `prepare(prefix)`
 * the runner can write `/<prefix>/...`, and an object written at `/<r2Key>`
 * lands in the bucket at `<r2Key>`. `publish` runs after the runner exits
 * successfully and must leave the object in the bucket before it returns
 * (callers HEAD-verify it next).
 */
export interface WarehouseExportStore {
  prepare(prefix: string): Promise<void>;
  publish(prefix: string, exportPath: string): Promise<void>;
}

/** S3 credentials and location for the warehouse export bucket (Cloudflare). */
export interface WarehouseExportS3Env {
  /** Cloudflare account; the R2 S3 endpoint is `https://<account>.r2.cloudflarestorage.com`. */
  CF_ACCOUNT_ID?: string;
  /** Bucket behind the WAREHOUSE_EXPORT_BUCKET binding. */
  WAREHOUSE_EXPORT_BUCKET_NAME?: string;
  /** R2 API token id (the S3 access key id). */
  R2_S3_ACCESS_KEY_ID?: string;
  /** SHA-256 hex of the R2 API token value (the S3 secret access key). */
  R2_S3_SECRET_ACCESS_KEY?: string;
}

/**
 * Cloudflare: the workspace prefix is an s3fs mount (S3Mount) of the export
 * bucket, so the runner streams straight into R2 and nothing passes through
 * the Worker. 1.0 cannot mount through an R2 binding, so it signs with an R2
 * API token; S3Gateway holds the credentials and the container never sees
 * them. The gateway also pins the key prefix, so a workspace's container can
 * only reach its own prefix.
 */
export class S3MountExportStore implements WarehouseExportStore {
  private readonly mounts: Pick<S3Mount, "mount">;

  constructor(
    container: ConstructorParameters<typeof S3Mount>[0],
    gateway: S3GatewayBinding,
    private readonly env: WarehouseExportS3Env,
    mounts?: Pick<S3Mount, "mount">,
  ) {
    this.mounts = mounts ?? new S3Mount(container, gateway);
  }

  /** Mounts (or reuses the mount of) `/<prefix>`. Safe to call before every export. */
  async prepare(prefix: string): Promise<void> {
    const accountId = this.env.CF_ACCOUNT_ID?.trim();
    const bucket = this.env.WAREHOUSE_EXPORT_BUCKET_NAME?.trim();
    const accessKeyId = this.env.R2_S3_ACCESS_KEY_ID?.trim();
    const secretAccessKey = this.env.R2_S3_SECRET_ACCESS_KEY?.trim();
    const missing = [
      ["CF_ACCOUNT_ID", accountId],
      ["WAREHOUSE_EXPORT_BUCKET_NAME", bucket],
      ["R2_S3_ACCESS_KEY_ID", accessKeyId],
      ["R2_S3_SECRET_ACCESS_KEY", secretAccessKey],
    ].filter(([, value]) => !value).map(([name]) => name);
    if (missing.length > 0) {
      throw new Error(`The warehouse export mount is not configured: set ${missing.join(", ")}`);
    }
    await this.mounts.mount({
      mountPath: `/${prefix}`,
      source: {
        type: "s3",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        region: "auto",
        bucket: bucket!,
        credentials: { type: "static", accessKeyId: accessKeyId!, secretAccessKey: secretAccessKey! },
      },
      keyPrefix: prefix,
      access: "read-write",
      // A re-export of the same key must not read or write through a stale
      // stat cache.
      s3fsOptions: { stat_cache_expire: 1 },
    });
  }

  /** s3fs uploads the file when the runner closes it, before the runner exits. */
  async publish(): Promise<void> {}
}

/**
 * Self-host: workerd has no S3 endpoint for its local R2 buckets, and the 0.12
 * `localBucket` sync mode belonged to the 0.12 sandbox server. The runner
 * writes to a plain directory in the container, and `publish` copies the
 * finished file into the R2 binding, then deletes the local copy. Exports
 * only ever write new files, so nothing is synced the other way.
 */
export class LocalCopyExportStore implements WarehouseExportStore {
  constructor(
    private readonly files: Pick<Files, "mkdir" | "stat" | "readFile" | "remove">,
    private readonly bucket: R2Bucket | undefined,
  ) {}

  async prepare(prefix: string): Promise<void> {
    this.requireBucket();
    await this.files.mkdir(`/${prefix}`, { recursive: true });
  }

  async publish(prefix: string, exportPath: string): Promise<void> {
    const bucket = this.requireBucket();
    const key = exportPath.replace(/^\/+/, "");
    if (!key.startsWith(`${prefix}/`) || key.split("/").includes("..")) {
      throw new Error(`export path "${exportPath}" is outside the warehouse prefix "${prefix}/"`);
    }
    try {
      const size = Number((await this.files.stat(exportPath)).size);
      const file = await this.files.readFile(exportPath);
      if (!file.body) throw new Error(`export file ${exportPath} has no body`);
      // R2 needs the length up front for a streamed body.
      const sized = new FixedLengthStream(size);
      const piped = file.body.pipeTo(sized.writable);
      await Promise.all([bucket.put(key, sized.readable), piped]);
    } finally {
      await this.files.remove(exportPath, { force: true }).catch(() => {});
    }
  }

  private requireBucket(): R2Bucket {
    if (!this.bucket) throw new Error("WAREHOUSE_EXPORT_BUCKET is required for self-host warehouse exports");
    return this.bucket;
  }
}
