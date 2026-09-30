import { describe, expect, it, vi } from "vitest";

import {
  assertBucketMount,
  BucketMountConfigError,
  createSandboxBucketMounts,
  S3BucketMounts,
  SyncBucketMounts,
  type BucketMount,
} from "../src/sandbox-mounts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const S3_ENV = {
  CF_ACCOUNT_ID: "acct",
  R2_BUCKET_NAME: "chiridion-sandbox",
  WAREHOUSE_EXPORT_BUCKET_NAME: "chiridion-warehouse-exports",
  R2_S3_ACCESS_KEY_ID: "key-id",
  R2_S3_SECRET_ACCESS_KEY: "secret",
};

const UPLOADS: BucketMount = {
  binding: "R2_BUCKET",
  keyPrefix: "org/ws/user-uploads",
  mountPath: "/uploads",
  access: "read-only",
};
const OUTPUTS: BucketMount = {
  binding: "R2_BUCKET",
  keyPrefix: "org/ws/user-outputs",
  mountPath: "/outputs",
  access: "read-write",
};

describe("assertBucketMount", () => {
  it("refuses prefixes and paths that could escape", () => {
    expect(() => assertBucketMount({ ...UPLOADS, keyPrefix: "/org/ws" })).toThrow();
    expect(() => assertBucketMount({ ...UPLOADS, keyPrefix: "org/ws/" })).toThrow();
    expect(() => assertBucketMount({ ...UPLOADS, keyPrefix: "org/../ws" })).toThrow();
    expect(() => assertBucketMount({ ...UPLOADS, mountPath: "uploads" })).toThrow();
    expect(() => assertBucketMount({ ...UPLOADS, mountPath: "/up/../etc" })).toThrow();
    expect(() => assertBucketMount(UPLOADS)).not.toThrow();
  });
});

describe("S3BucketMounts (Cloudflare)", () => {
  it("mounts the binding's bucket over the account's R2 S3 endpoint, scoped to the prefix", async () => {
    const s3 = { mount: vi.fn(async () => {}) };
    const mounts = new S3BucketMounts({} as never, (() => ({})) as never, S3_ENV, s3);

    await mounts.mount(UPLOADS);
    await mounts.mount({ ...OUTPUTS, binding: "WAREHOUSE_EXPORT_BUCKET", keyPrefix: "warehouse/ws", mountPath: "/warehouse/ws" });

    expect(s3.mount).toHaveBeenNthCalledWith(1, {
      mountPath: "/uploads",
      source: {
        type: "s3",
        endpoint: "https://acct.r2.cloudflarestorage.com",
        region: "auto",
        bucket: "chiridion-sandbox",
        credentials: { type: "static", accessKeyId: "key-id", secretAccessKey: "secret" },
      },
      keyPrefix: "org/ws/user-uploads",
      access: "read-only",
      s3fsOptions: { stat_cache_expire: 1 },
    });
    expect(s3.mount).toHaveBeenNthCalledWith(2, expect.objectContaining({
      mountPath: "/warehouse/ws",
      keyPrefix: "warehouse/ws",
      access: "read-write",
      source: expect.objectContaining({ bucket: "chiridion-warehouse-exports" }),
    }));
  });

  it("names every missing setting instead of mounting", async () => {
    const s3 = { mount: vi.fn(async () => {}) };
    const mounts = new S3BucketMounts({} as never, (() => ({})) as never, { CF_ACCOUNT_ID: "acct" }, s3);
    const failure = await mounts.mount(UPLOADS).catch((error) => error as Error);
    expect(failure).toBeInstanceOf(BucketMountConfigError);
    expect(failure.message).toContain("R2_BUCKET_NAME");
    expect(failure.message).toContain("R2_S3_ACCESS_KEY_ID");
    expect(failure.message).toContain("R2_S3_SECRET_ACCESS_KEY");
    expect(failure.message).not.toContain("secret");
    expect(s3.mount).not.toHaveBeenCalled();
  });

  it("honors an endpoint override (a local S3 server)", async () => {
    const s3 = { mount: vi.fn(async () => {}) };
    const mounts = new S3BucketMounts({} as never, (() => ({})) as never, { ...S3_ENV, R2_S3_ENDPOINT: "http://minio:9000" }, s3);
    await mounts.mount(UPLOADS);
    expect(s3.mount).toHaveBeenCalledWith(expect.objectContaining({
      source: expect.objectContaining({ endpoint: "http://minio:9000" }),
    }));
  });

  it("has nothing to flush: s3fs uploads on close", async () => {
    const mounts = new S3BucketMounts({} as never, (() => ({})) as never, S3_ENV, { mount: vi.fn() });
    expect(mounts.kind).toBe("live");
    await expect(mounts.flush(OUTPUTS)).resolves.toBeUndefined();
  });
});

describe("createSandboxBucketMounts", () => {
  it("syncs on self-host and mounts over S3 elsewhere", () => {
    const common = { container: {} as never, files: {} as never, gateway: () => ({}) as never };
    expect(createSandboxBucketMounts({ ...common, env: { CF_ACCOUNT_ID: "selfhost" } }).kind).toBe("sync");
    expect(createSandboxBucketMounts({ ...common, env: S3_ENV }).kind).toBe("live");
  });
});

// ---------------------------------------------------------------------------
// Self-host sync mounts, against an in-memory container filesystem and bucket
// ---------------------------------------------------------------------------

async function bytesOf(content: unknown): Promise<Uint8Array> {
  if (typeof content === "string") return encoder.encode(content);
  return new Uint8Array(await new Response(content as ReadableStream).arrayBuffer());
}

function sandboxFs() {
  const files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  let clock = 1;
  const enoent = (path: string) =>
    Object.assign(new Error(`ENOENT: ${path}`), { name: "SandboxFileError", code: "ENOENT", operation: "readFile", path, detail: "" });
  const api = {
    files,
    /** A process in the container writes a file. */
    write(path: string, text: string) {
      files.set(path, { bytes: encoder.encode(text), mtime: clock++ });
    },
    text(path: string) {
      const file = files.get(path);
      return file ? decoder.decode(file.bytes) : undefined;
    },
    fileApi: {
      mkdir: vi.fn(async () => {}),
      writeFile: vi.fn(async (path: string, content: unknown) => {
        files.set(path, { bytes: await bytesOf(content), mtime: clock++ });
      }),
      readFile: vi.fn(async (path: string) => {
        const file = files.get(path);
        if (!file) throw enoent(path);
        return new Response(file.bytes);
      }),
      rename: vi.fn(async (from: string, to: string) => {
        const file = files.get(from);
        if (!file) throw enoent(from);
        files.delete(from);
        files.set(to, file);
      }),
      remove: vi.fn(async (path: string) => {
        files.delete(path);
      }),
      stat: vi.fn(async () => {
        throw new Error("unused");
      }),
    },
    container: {
      exec: vi.fn(async (argv: string[]) => {
        // find <dir> -type f -printf '%s\t%T@\t%P\0'
        const dir = argv[1];
        const records = [...files.entries()]
          .filter(([path]) => path.startsWith(`${dir}/`))
          .map(([path, file]) => `${file.bytes.byteLength}\t${file.mtime}.0\t${path.slice(dir.length + 1)}\0`);
        const stdout = encoder.encode(records.join(""));
        return {
          output: async () => ({ exitCode: 0, stdout: stdout.buffer as ArrayBuffer, stderr: new ArrayBuffer(0) }),
        };
      }),
    },
  };
  return api;
}

function memoryBucket(initial: Record<string, string> = {}) {
  const objects = new Map<string, { bytes: Uint8Array; etag: string }>();
  let version = 1;
  const put = (key: string, bytes: Uint8Array) => {
    const etag = `etag-${version++}`;
    objects.set(key, { bytes, etag });
    return etag;
  };
  for (const [key, text] of Object.entries(initial)) put(key, encoder.encode(text));
  const bucket = {
    objects,
    text: (key: string) => {
      const object = objects.get(key);
      return object ? decoder.decode(object.bytes) : undefined;
    },
    set: (key: string, text: string) => put(key, encoder.encode(text)),
    list: vi.fn(async ({ prefix }: { prefix: string }) => ({
      objects: [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, object]) => ({ key, etag: object.etag, size: object.bytes.byteLength })),
      truncated: false,
    })),
    get: vi.fn(async (key: string) => {
      const object = objects.get(key);
      return object ? { body: new Response(object.bytes).body } : null;
    }),
    put: vi.fn(async (key: string, body: ReadableStream) => ({ etag: put(key, await bytesOf(body)) })),
    delete: vi.fn(async (key: string) => {
      objects.delete(key);
    }),
  };
  return bucket;
}

function syncMounts(bucket: ReturnType<typeof memoryBucket>) {
  const fs = sandboxFs();
  const mounts = new SyncBucketMounts(
    fs.container as never,
    fs.fileApi as never,
    { CF_ACCOUNT_ID: "selfhost", R2_BUCKET: bucket as unknown as R2Bucket },
  );
  return { fs, mounts };
}

describe("SyncBucketMounts (self-host)", () => {
  it("copies the prefix into the mount path, then only what changed", async () => {
    const bucket = memoryBucket({
      "org/ws/user-uploads/a.csv": "a",
      "org/ws/user-uploads/dir/b.txt": "b",
      "org/ws/user-uploads/dir/": "",
      "org/ws/other/secret.txt": "not mine",
    });
    const { fs, mounts } = syncMounts(bucket);

    await mounts.mount(UPLOADS);
    expect(fs.text("/uploads/a.csv")).toBe("a");
    expect(fs.text("/uploads/dir/b.txt")).toBe("b");
    expect([...fs.files.keys()].filter((path) => path.startsWith("/uploads/"))).toHaveLength(2);
    expect(bucket.get).toHaveBeenCalledTimes(2);

    // Nothing changed: nothing is copied again.
    await mounts.mount(UPLOADS);
    expect(bucket.get).toHaveBeenCalledTimes(2);

    // Changed and deleted in the bucket: the copy follows.
    bucket.set("org/ws/user-uploads/a.csv", "a2");
    bucket.objects.delete("org/ws/user-uploads/dir/b.txt");
    await mounts.mount(UPLOADS);
    expect(fs.text("/uploads/a.csv")).toBe("a2");
    expect(fs.text("/uploads/dir/b.txt")).toBeUndefined();
    expect(bucket.get).toHaveBeenCalledTimes(3);
  });

  it("never copies a read-only mount back", async () => {
    const bucket = memoryBucket({ "org/ws/user-uploads/a.csv": "a" });
    const { fs, mounts } = syncMounts(bucket);
    await mounts.mount(UPLOADS);
    fs.write("/uploads/new.txt", "local");
    await mounts.flush(UPLOADS);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it("uploads a writable mount's new and changed files, and deletes removed ones", async () => {
    const bucket = memoryBucket({ "org/ws/user-outputs/old.txt": "old", "org/ws/user-outputs/keep.txt": "keep" });
    const { fs, mounts } = syncMounts(bucket);
    await mounts.mount(OUTPUTS);

    fs.write("/outputs/report.xlsx", "xlsx-bytes");
    fs.write("/outputs/keep.txt", "keep v2");
    fs.files.delete("/outputs/old.txt");
    await mounts.flush(OUTPUTS);

    expect(bucket.text("org/ws/user-outputs/report.xlsx")).toBe("xlsx-bytes");
    expect(bucket.text("org/ws/user-outputs/keep.txt")).toBe("keep v2");
    expect(bucket.objects.has("org/ws/user-outputs/old.txt")).toBe(false);

    // A second flush has nothing to do.
    bucket.put.mockClear();
    await mounts.flush(OUTPUTS);
    expect(bucket.put).not.toHaveBeenCalled();

    // Nor does a refresh re-download what the container wrote.
    bucket.get.mockClear();
    await mounts.mount(OUTPUTS);
    expect(bucket.get).not.toHaveBeenCalled();
  });

  it("keeps the container's unflushed changes when refreshing a writable mount", async () => {
    const bucket = memoryBucket({ "org/ws/user-outputs/a.txt": "remote" });
    const { fs, mounts } = syncMounts(bucket);
    await mounts.mount(OUTPUTS);

    fs.write("/outputs/a.txt", "local edit");
    bucket.set("org/ws/user-outputs/a.txt", "remote v2");
    await mounts.mount(OUTPUTS);

    expect(fs.text("/outputs/a.txt")).toBe("local edit");
    await mounts.flush(OUTPUTS);
    expect(bucket.text("org/ws/user-outputs/a.txt")).toBe("local edit");
  });

  it("starts over in a new container (no state file)", async () => {
    const bucket = memoryBucket({ "org/ws/user-uploads/a.csv": "a" });
    const first = syncMounts(bucket);
    await first.mounts.mount(UPLOADS);
    const second = syncMounts(bucket);
    await second.mounts.mount(UPLOADS);
    expect(second.fs.text("/uploads/a.csv")).toBe("a");
  });

  it("moves a write-only mount's files to the bucket without copying anything in", async () => {
    const bucket = memoryBucket({ "warehouse/ws/old.parquet": "old" });
    const fs = sandboxFs();
    const mounts = new SyncBucketMounts(
      fs.container as never,
      fs.fileApi as never,
      { CF_ACCOUNT_ID: "selfhost", WAREHOUSE_EXPORT_BUCKET: bucket as unknown as R2Bucket },
    );
    const mount: BucketMount = { binding: "WAREHOUSE_EXPORT_BUCKET", keyPrefix: "warehouse/ws", mountPath: "/warehouse/ws", access: "write-only" };

    await mounts.mount(mount);
    expect(bucket.get).not.toHaveBeenCalled();
    expect(fs.text("/warehouse/ws/old.parquet")).toBeUndefined();

    fs.write("/warehouse/ws/conn/q.parquet", "PAR1");
    await mounts.flush(mount);
    expect(bucket.text("warehouse/ws/conn/q.parquet")).toBe("PAR1");
    expect(fs.text("/warehouse/ws/conn/q.parquet")).toBeUndefined();
    // The local copy is gone, and that deletes nothing in the bucket.
    await mounts.flush(mount);
    expect(bucket.text("warehouse/ws/old.parquet")).toBe("old");
    expect(bucket.text("warehouse/ws/conn/q.parquet")).toBe("PAR1");
  });

  it("mounts write-only as a read-write S3 mount on Cloudflare", async () => {
    const s3 = { mount: vi.fn(async () => {}) };
    const mounts = new S3BucketMounts({} as never, (() => ({})) as never, S3_ENV, s3);
    await mounts.mount({ ...OUTPUTS, access: "write-only" });
    expect(s3.mount).toHaveBeenCalledWith(expect.objectContaining({ access: "read-write" }));
  });

  it("needs the binding", async () => {
    const fs = sandboxFs();
    const mounts = new SyncBucketMounts(fs.container as never, fs.fileApi as never, { CF_ACCOUNT_ID: "selfhost" });
    await expect(mounts.mount(UPLOADS)).rejects.toBeInstanceOf(BucketMountConfigError);
  });
});
