import { describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

import {
  __testing,
  ProjectFilesystemClient,
  WorkspaceFilesystemClient,
} from "../src/workspace-filesystem-do";

function namespaceFor(stub: Record<string, unknown>) {
  return {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn(() => stub),
  };
}

function trackedUnreadStream() {
  const pull = vi.fn();
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>(
    { pull, cancel },
    { highWaterMark: 0 },
  );
  return { stream, pull, cancel };
}

function testFileEntry(index: number, type: "file" | "directory" = "file") {
  return {
    path: `/entry-${index}`,
    name: `entry-${index}`,
    type,
    mimeType: "application/octet-stream",
    size: type === "file" ? 1 : 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function strictTraversal(
  readDir: (
    dir: string,
    options: { limit?: number; offset?: number },
  ) => Promise<ReturnType<typeof testFileEntry>[]>,
  maxEntries: number,
  recursive = false,
) {
  const counters = { entryCount: 0, fileCount: 0, pathBytes: 0, totalBytes: 0 };
  const files: Array<Record<string, unknown>> = [];
  const run = __testing.collectWorkspaceEntries(
    { readDir } as never,
    "/",
    "/",
    files as never,
    {
      recursive,
      includeHidden: true,
      limit: maxEntries + 1,
      bounds: {
        maxEntries,
        maxFiles: maxEntries,
        maxPathBytes: 4 * 1024 * 1024,
        maxFileBytes: 1,
        maxTotalBytes: maxEntries,
      },
      counters,
      completeForBounds: true,
    },
  );
  return { counters, files, run };
}

describe("bounded workspace tree traversal", () => {
  it("paginates through a directory larger than one fixed page", async () => {
    const entries = Array.from({ length: 130 }, (_, index) =>
      testFileEntry(index),
    );
    const readDir = vi.fn(
      async (_dir: string, options: { limit?: number; offset?: number }) =>
        entries.slice(
          options.offset ?? 0,
          (options.offset ?? 0) + (options.limit ?? 1_000),
        ),
    );
    const traversal = strictTraversal(readDir, 200);

    await traversal.run;
    expect(traversal.counters).toMatchObject({
      entryCount: 130,
      fileCount: 130,
      totalBytes: 130,
    });
    expect(readDir.mock.calls.map(([, options]) => options.offset)).toEqual([
      0, 128,
    ]);
  });

  it("keeps a 50k flat traversal to 391 keyset queries and never uses OFFSET", async () => {
    const entries = Array.from({ length: 50_000 }, (_, index) => {
      const suffix = index.toString().padStart(5, "0");
      return {
        ...testFileEntry(index),
        path: `/entry-${suffix}`,
        name: `entry-${suffix}`,
      };
    });
    const indexByPath = new Map(
      entries.map((entry, index) => [entry.path, index]),
    );
    const readDir = vi.fn(async () => {
      throw new Error("OFFSET traversal should not be used");
    });
    const readPage = vi.fn(
      async (
        _directory: string,
        after: { type: string; name: string; path: string } | undefined,
        limit: number,
      ) => {
        const start = after ? (indexByPath.get(after.path) ?? -1) + 1 : 0;
        return entries.slice(start, start + limit);
      },
    );
    const counters = {
      entryCount: 0,
      fileCount: 0,
      pathBytes: 0,
      totalBytes: 0,
    };

    await __testing.collectWorkspaceEntries(
      { readDir } as never,
      "/",
      "/",
      null,
      {
        recursive: false,
        includeHidden: true,
        limit: 50_000,
        bounds: {
          maxEntries: 50_000,
          maxFiles: 50_000,
          maxPathBytes: 4 * 1024 * 1024,
          maxFileBytes: 1,
          maxTotalBytes: 50_000,
        },
        counters,
        completeForBounds: true,
        readPage,
      },
    );

    expect(counters).toMatchObject({
      entryCount: 50_000,
      fileCount: 50_000,
      totalBytes: 50_000,
    });
    expect(readPage).toHaveBeenCalledTimes(Math.ceil(50_000 / 128));
    expect(readPage.mock.calls[0]?.[1]).toBeUndefined();
    expect(readPage.mock.calls[1]?.[1]).toEqual({
      type: "file",
      name: "entry-00127",
      path: "/entry-00127",
    });
    expect(readPage.mock.calls.every(([, , limit]) => limit <= 128)).toBe(true);
    expect(readDir).not.toHaveBeenCalled();
  });

  it("proves an exact page-sized boundary with one empty lookahead", async () => {
    const entries = Array.from({ length: 128 }, (_, index) =>
      testFileEntry(index),
    );
    const readDir = vi.fn(
      async (_dir: string, options: { limit?: number; offset?: number }) =>
        entries.slice(
          options.offset ?? 0,
          (options.offset ?? 0) + (options.limit ?? 1_000),
        ),
    );
    const traversal = strictTraversal(readDir, 128);

    await traversal.run;
    expect(traversal.counters.entryCount).toBe(128);
    expect(
      readDir.mock.calls.map(([, options]) => ({
        limit: options.limit,
        offset: options.offset,
      })),
    ).toEqual([
      { limit: 128, offset: 0 },
      { limit: 1, offset: 128 },
    ]);
  });

  it("rejects boundary plus one instead of returning a partial success", async () => {
    const entries = Array.from({ length: 129 }, (_, index) =>
      testFileEntry(index),
    );
    const readDir = vi.fn(
      async (_dir: string, options: { limit?: number; offset?: number }) =>
        entries.slice(
          options.offset ?? 0,
          (options.offset ?? 0) + (options.limit ?? 1_000),
        ),
    );
    const traversal = strictTraversal(readDir, 128);

    await expect(traversal.run).rejects.toThrow(/128 entry limit/);
    expect(readDir.mock.calls.at(-1)?.[1]).toEqual({ limit: 1, offset: 128 });
  });

  it("walks a deeply nested tree with an explicit directory stack", async () => {
    const depth = 5_000;
    const readDir = vi.fn(
      async (dir: string, options: { limit?: number; offset?: number }) => {
        if ((options.offset ?? 0) > 0) return [];
        const current =
          dir === "/" ? 0 : Number(dir.slice("/entry-".length)) + 1;
        return current >= depth ? [] : [testFileEntry(current, "directory")];
      },
    );
    const traversal = strictTraversal(readDir, depth, true);

    await traversal.run;
    expect(traversal.counters).toMatchObject({
      entryCount: depth,
      fileCount: 0,
    });
    expect(readDir).toHaveBeenCalledTimes(depth + 1);
  });
});

describe("ProjectFilesystemClient", () => {
  it("cancels an opened file stream when its stat lookup rejects", async () => {
    const stub = env.WORKSPACE_FS.get(
      env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
    );
    await runInDurableObject(stub, async (instance: any) => {
      const tracked = trackedUnreadStream();
      const files = {
        readFileStream: vi.fn(async () => tracked.stream),
        stat: vi.fn(async () => {
          throw new Error("stat unavailable");
        }),
      };
      await expect(
        instance.readFileStreamFrom(files, "/file.bin"),
      ).resolves.toMatchObject({
        success: false,
        code: "EREAD",
        error: "stat unavailable",
      });
      await vi.waitFor(() => expect(tracked.cancel).toHaveBeenCalledOnce());
      expect(tracked.pull).not.toHaveBeenCalled();
      expect(tracked.stream.locked).toBe(false);
    });
  });

  it("bounds streaming-read admission and releases slots on cancellation", async () => {
    const stub = env.WORKSPACE_FS.get(
      env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
    );
    await runInDurableObject(stub, async (instance: any) => {
      const sources = Array.from({ length: 4 }, () => trackedUnreadStream());
      let index = 0;
      const files = {
        readFileStream: vi.fn(async () => sources[index++]!.stream),
        stat: vi.fn(async () => ({
          type: "file",
          size: 1,
          mimeType: "application/octet-stream",
        })),
      };
      const admitted = await Promise.all(
        Array.from({ length: 4 }, () =>
          instance.readFileStreamFrom(files, "/file.bin"),
        ),
      );
      await expect(
        instance.readFileStreamFrom(files, "/fifth.bin"),
      ).resolves.toMatchObject({ success: false, code: "EBUSY" });
      expect(files.readFileStream).toHaveBeenCalledTimes(4);
      expect(instance.activeStreamReads).toBe(4);

      await admitted[0].stream.cancel("consumer stopped");
      await vi.waitFor(() => expect(sources[0]!.cancel).toHaveBeenCalledOnce());
      expect(instance.activeStreamReads).toBe(3);
      const replacement = await instance.readFileStreamFrom(
        {
          ...files,
          readFileStream: vi.fn(async () => new Response("x").body!),
        },
        "/replacement.bin",
      );
      expect(replacement).toMatchObject({ success: true });

      for (const response of admitted.slice(1)) {
        await response.stream.cancel("test cleanup");
      }
      await replacement.stream.cancel("test cleanup");
      expect(instance.activeStreamReads).toBe(0);
    });
  });

  it("expires an abandoned streaming read and cancels its source", async () => {
    vi.useFakeTimers();
    try {
      const stub = env.WORKSPACE_FS.get(
        env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
      );
      await runInDurableObject(stub, async (instance: any) => {
        const tracked = trackedUnreadStream();
        const response = await instance.readFileStreamFrom(
          {
            readFileStream: vi.fn(async () => tracked.stream),
            stat: vi.fn(async () => ({
              type: "file",
              size: 1,
              mimeType: "application/octet-stream",
            })),
          },
          "/abandoned.bin",
        );
        const reader = response.stream.getReader();
        const rejection = expect(reader.read()).rejects.toThrow(
          /bounded lifetime/,
        );
        await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
        await rejection;
        await vi.waitFor(() => expect(tracked.cancel).toHaveBeenCalledOnce());
        expect(instance.activeStreamReads).toBe(0);
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a streaming slot claimed and aborts when source cancellation hangs", async () => {
    vi.useFakeTimers();
    try {
      const stub = env.WORKSPACE_FS.get(
        env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
      );
      await runInDurableObject(stub, async (instance: any) => {
        const never = new Promise<void>(() => {});
        const files = {
          readFileStream: vi.fn(
            async () =>
              new ReadableStream<Uint8Array>(
                { pull: vi.fn(), cancel: vi.fn(() => never) },
                { highWaterMark: 0 },
              ),
          ),
          stat: vi.fn(async () => ({
            type: "file",
            size: 1,
            mimeType: "application/octet-stream",
          })),
        };
        const admitted = await Promise.all(
          Array.from({ length: 4 }, () =>
            instance.readFileStreamFrom(files, "/hung.bin"),
          ),
        );
        const abort = vi
          .spyOn(instance.ctx, "abort")
          .mockImplementation(() => {});
        const cancellation = expect(
          admitted[0].stream.cancel("consumer stopped"),
        ).rejects.toThrow(/cancellation timed out/);
        await vi.advanceTimersByTimeAsync(10_001);
        await cancellation;
        expect(abort).toHaveBeenCalledOnce();
        expect(instance.activeStreamReads).toBe(4);
        await expect(
          instance.readFileStreamFrom(files, "/fifth.bin"),
        ).resolves.toMatchObject({ success: false, code: "EBUSY" });
        abort.mockRestore();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps all opened-stream slots claimed when stat rejection cancellation hangs", async () => {
    vi.useFakeTimers();
    try {
      const stub = env.WORKSPACE_FS.get(
        env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
      );
      await runInDurableObject(stub, async (instance: any) => {
        const files = {
          readFileStream: vi.fn(
            async () =>
              new ReadableStream<Uint8Array>(
                { cancel: vi.fn(() => new Promise<void>(() => {})) },
                { highWaterMark: 0 },
              ),
          ),
          stat: vi.fn(async () => {
            throw new Error("stat unavailable");
          }),
        };
        const abort = vi
          .spyOn(instance.ctx, "abort")
          .mockImplementation(() => {});
        const pending = Array.from({ length: 4 }, () =>
          instance.readFileStreamFrom(files, "/hung-stat.bin"),
        );
        await vi.waitFor(() => expect(files.stat).toHaveBeenCalledTimes(4));
        await expect(
          instance.readFileStreamFrom(files, "/fifth.bin"),
        ).resolves.toMatchObject({ success: false, code: "EBUSY" });
        await vi.advanceTimersByTimeAsync(10_001);
        await expect(Promise.all(pending)).resolves.toEqual(
          Array.from({ length: 4 }, () =>
            expect.objectContaining({ success: false, code: "EREAD" }),
          ),
        );
        expect(abort).toHaveBeenCalledTimes(4);
        expect(instance.activeStreamReads).toBe(4);
        abort.mockRestore();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces the declared byte size on streamed reads", async () => {
    const stub = env.WORKSPACE_FS.get(
      env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
    );
    await runInDurableObject(stub, async (instance: any) => {
      const overCancel = vi.fn();
      const over = await instance.readFileStreamFrom(
        {
          readFileStream: vi.fn(
            async () =>
              new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(new Uint8Array([1, 2]));
                },
                cancel: overCancel,
              }),
          ),
          stat: vi.fn(async () => ({ type: "file", size: 1 })),
        },
        "/over.bin",
      );
      await expect(over.stream.getReader().read()).rejects.toThrow(
        /exceeded its declared 1 byte size/,
      );
      expect(overCancel).toHaveBeenCalledOnce();

      const under = await instance.readFileStreamFrom(
        {
          readFileStream: vi.fn(
            async () => new Response(new Uint8Array([1])).body!,
          ),
          stat: vi.fn(async () => ({ type: "file", size: 2 })),
        },
        "/under.bin",
      );
      const reader = under.stream.getReader();
      await expect(reader.read()).resolves.toMatchObject({ done: false });
      await expect(reader.read()).rejects.toThrow(
        /ended at 1 bytes; expected 2/,
      );
      expect(instance.activeStreamReads).toBe(0);
    });
  });

  it("rejects huge paths before invoking workspace read, list, or write methods", async () => {
    const stub = env.WORKSPACE_FS.get(
      env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
    );
    await runInDurableObject(stub, async (instance: any) => {
      const files = {
        stat: vi.fn(),
        readFileStream: vi.fn(),
      };
      const path = `/${"x".repeat(4_097)}`;
      await expect(instance.readFileFrom(files, path)).resolves.toMatchObject({
        success: false,
        code: "E2BIG",
      });
      await expect(
        instance.readFileStreamFrom(files, path),
      ).resolves.toMatchObject({ success: false, code: "E2BIG" });
      await expect(instance.listFilesFrom(files, path)).resolves.toMatchObject({
        success: false,
        files: [],
      });
      await expect(
        instance.writeFileTo(files, path, "small"),
      ).resolves.toMatchObject({ success: false, code: "E2BIG" });
      expect(files.stat).not.toHaveBeenCalled();
      expect(files.readFileStream).not.toHaveBeenCalled();
    });
  });

  it("admits at most two buffered reads", async () => {
    const stub = env.WORKSPACE_FS.get(
      env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
    );
    await runInDurableObject(stub, async (instance: any) => {
      const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
      const files = {
        stat: vi.fn(async () => ({ type: "file", size: 0 })),
        readFileStream: vi.fn(
          async () =>
            new ReadableStream<Uint8Array>({
              start(controller) {
                controllers.push(controller);
              },
            }),
        ),
      };
      const first = instance.readBoundedFileBytes(files, "/first");
      const second = instance.readBoundedFileBytes(files, "/second");
      await vi.waitFor(() =>
        expect(files.readFileStream).toHaveBeenCalledTimes(2),
      );
      await expect(
        instance.readBoundedFileBytes(files, "/third"),
      ).rejects.toThrow(/capacity exceeded/);
      controllers.forEach((controller) => controller.close());
      await expect(Promise.all([first, second])).resolves.toHaveLength(2);
      expect(instance.activeBufferedReads).toBe(0);
    });
  });

  it("aborts and retains buffered-read admission when read cancellation never settles", async () => {
    vi.useFakeTimers();
    try {
      const stub = env.WORKSPACE_FS.get(
        env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
      );
      await runInDurableObject(stub, async (instance: any) => {
        const files = {
          stat: vi.fn(async () => ({ type: "file", size: 1 })),
          readFileStream: vi.fn(
            async () =>
              new ReadableStream<Uint8Array>(
                {
                  pull: vi.fn(),
                  cancel: vi.fn(() => new Promise<void>(() => {})),
                },
                { highWaterMark: 0 },
              ),
          ),
        };
        const abort = vi
          .spyOn(instance.ctx, "abort")
          .mockImplementation(() => {});
        const first = expect(
          instance.readBoundedFileBytes(files, "/first"),
        ).rejects.toThrow(/buffered file read timed out/);
        await vi.waitFor(() =>
          expect(files.readFileStream).toHaveBeenCalledOnce(),
        );
        await vi.advanceTimersByTimeAsync(2 * 60_000 + 1);
        await first;
        expect(abort).toHaveBeenCalledOnce();
        expect(instance.activeBufferedReads).toBe(1);

        void instance
          .readBoundedFileBytes(files, "/second")
          .catch(() => undefined);
        await vi.waitFor(() =>
          expect(files.readFileStream).toHaveBeenCalledTimes(2),
        );
        await expect(
          instance.readBoundedFileBytes(files, "/third"),
        ).rejects.toThrow(/capacity exceeded/);
        expect(instance.activeBufferedReads).toBe(2);
        abort.mockRestore();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles and cancels the source when R2 put throws synchronously", async () => {
    const tracked = trackedUnreadStream();
    const bucket = {
      put: vi.fn(() => {
        throw new Error("synchronous put failure");
      }),
    } as unknown as R2Bucket;
    await expect(
      __testing.streamToR2(
        bucket,
        "failed-key",
        tracked.stream,
        "application/octet-stream",
        1,
      ),
    ).rejects.toThrow("synchronous put failure");
    expect(tracked.cancel).toHaveBeenCalledOnce();
    expect(tracked.stream.locked).toBe(false);
  });

  it("keeps the stream timeout authoritative when put rejects but the pump hangs", async () => {
    vi.useFakeTimers();
    try {
      const tracked = trackedUnreadStream();
      Object.defineProperty(tracked.stream, "pipeTo", {
        value: vi.fn(() => new Promise<void>(() => {})),
      });
      const rejection = expect(
        __testing.streamToR2(
          {
            put: vi.fn(async () => {
              throw new Error("put rejected");
            }),
          } as unknown as R2Bucket,
          "put-reject-pump-hang",
          tracked.stream,
          "application/octet-stream",
          1,
          undefined,
          undefined,
          10,
        ),
      ).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      expect(tracked.cancel).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the stream timeout authoritative when the pump rejects but put hangs", async () => {
    vi.useFakeTimers();
    try {
      const source = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("pump rejected"));
        },
      });
      const put = vi.fn(() => new Promise<R2Object>(() => {}));
      const rejection = expect(
        __testing.streamToR2(
          { put } as unknown as R2Bucket,
          "pump-reject-put-hang",
          source,
          "application/octet-stream",
          1,
          undefined,
          undefined,
          10,
        ),
      ).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      expect(put).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an unsafe streamed size before R2 setup and cancels the source", async () => {
    const tracked = trackedUnreadStream();
    const put = vi.fn();
    await expect(
      __testing.streamToR2(
        { put } as unknown as R2Bucket,
        "unsafe-size-key",
        tracked.stream,
        "application/octet-stream",
        Number.MAX_SAFE_INTEGER + 1,
      ),
    ).rejects.toThrow(/safe-integer byte size/);
    await vi.waitFor(() => expect(tracked.cancel).toHaveBeenCalledOnce());
    expect(put).not.toHaveBeenCalled();
    expect(tracked.stream.locked).toBe(false);
  });

  it("keeps setup-failure cancellation owned until its bounded timeout", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const source = new ReadableStream<Uint8Array>(
        { cancel },
        { highWaterMark: 0 },
      );
      const put = vi.fn();
      const rejection = expect(
        __testing.streamToR2(
          { put } as unknown as R2Bucket,
          "unsafe-size-stuck-cancel",
          source,
          "application/octet-stream",
          Number.MAX_SAFE_INTEGER + 1,
          undefined,
          undefined,
          10,
        ),
      ).rejects.toThrow(/source stream cancellation timed out/i);

      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
      expect(put).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds source cancellation when streaming SHA setup throws", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const source = new ReadableStream<Uint8Array>(
        { cancel },
        { highWaterMark: 0 },
      );
      Object.defineProperty(source, "pipeTo", {
        value: vi.fn(() => {
          throw new Error("digest pipe setup failed");
        }),
      });
      const rejection = expect(
        __testing.sha256StreamHex(source, 10),
      ).rejects.toThrow(/source stream cancellation timed out/i);

      await Promise.resolve();
      expect(cancel).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(11);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("turns a synchronous R2 delete throw into a settled cleanup failure", async () => {
    const remove = vi.fn(() => {
      throw new Error("synchronous delete failure");
    });
    await expect(
      __testing.settleR2Delete({ delete: remove } as never, "orphan-key", 50),
    ).resolves.toBe(false);
    expect(remove).toHaveBeenCalledOnce();
  });

  it("does not dispatch an operation whose deadline already expired", async () => {
    const operation = vi.fn(async () => "unreachable");
    await expect(
      __testing.withOperationDeadline(
        operation,
        Date.now() - 1,
        "Expired lookup",
      ),
    ).rejects.toThrow(/Expired lookup timed out/);
    expect(operation).not.toHaveBeenCalled();
  });

  it("cancels a late R2-style response body exactly once", async () => {
    const tracked = trackedUnreadStream();
    let resolveLate!: (value: { body: ReadableStream<Uint8Array> }) => void;
    const operation = vi.fn(
      () =>
        new Promise<{ body: ReadableStream<Uint8Array> }>((resolve) => {
          resolveLate = resolve;
        }),
    );
    const pending = __testing.withOperationDeadline(
      operation,
      Date.now() + 10,
      "Late lookup",
    );

    await expect(pending).rejects.toThrow(/Late lookup timed out/);
    resolveLate({ body: tracked.stream });
    await vi.waitFor(() => expect(tracked.cancel).toHaveBeenCalledOnce());
    expect(tracked.pull).not.toHaveBeenCalled();
  });

  it("uses project-scoped DO instances and project file RPC methods", async () => {
    const stub = {
      projectWriteFile: vi.fn(async () => ({ success: true })),
      projectEditTextFile: vi.fn(async () => ({
        success: true,
        replacementCount: 1,
      })),
      projectReadFile: vi.fn(async () => ({
        success: true,
        content: "hello",
        encoding: "utf8",
      })),
      projectListFiles: vi.fn(async () => ({
        success: true,
        files: [],
        count: 0,
        path: "/",
      })),
      projectCreateSourceSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        fileCount: 1,
        totalBytes: 5,
        entries: [],
      })),
      projectRestoreSourceSnapshot: vi.fn(async () => ({
        id: "snapshot-1",
        createdAt: "2026-01-01T00:00:00.000Z",
        fileCount: 1,
        totalBytes: 5,
        entries: [],
      })),
      projectListSourceSnapshots: vi.fn(async () => []),
      projectDeleteSourceSnapshots: vi.fn(async () => ({
        snapshotsDeleted: 1,
        blobsDeleted: 1,
      })),
    };
    const workspaces = namespaceFor(stub);
    const client = new ProjectFilesystemClient(
      { WORKSPACE_FS: workspaces } as never,
      "CA_AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA-demo app",
    );

    await expect(client.writeFile("/src/index.ts", "hello")).resolves.toEqual({
      success: true,
    });
    await expect(
      client.editTextFile("/src/index.ts", [
        { oldText: "hello", newText: "goodbye" },
      ]),
    ).resolves.toMatchObject({ success: true, replacementCount: 1 });
    await expect(client.readFile("/src/index.ts")).resolves.toMatchObject({
      content: "hello",
    });
    await client.listFiles("/", { recursive: true });
    await expect(
      client.createSourceSnapshot({ message: "deploy" }),
    ).resolves.toMatchObject({ id: "snapshot-1" });
    await expect(
      client.restoreSourceSnapshot("snapshot-1"),
    ).resolves.toMatchObject({ id: "snapshot-1" });
    await client.listSourceSnapshots(5);
    await expect(client.deleteSourceSnapshots()).resolves.toEqual({
      snapshotsDeleted: 1,
      blobsDeleted: 1,
    });

    expect(workspaces.idFromName).toHaveBeenCalledWith(
      "ca-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-demo-app",
    );
    expect(stub.projectWriteFile).toHaveBeenCalledWith(
      "/src/index.ts",
      "hello",
    );
    expect(stub.projectEditTextFile).toHaveBeenCalledWith("/src/index.ts", [
      { oldText: "hello", newText: "goodbye" },
    ]);
    expect(stub.projectReadFile).toHaveBeenCalledWith("/src/index.ts");
    expect(stub.projectListFiles).toHaveBeenCalledWith("/", {
      recursive: true,
    });
    expect(stub.projectCreateSourceSnapshot).toHaveBeenCalledWith({
      message: "deploy",
    });
    expect(stub.projectRestoreSourceSnapshot).toHaveBeenCalledWith(
      "snapshot-1",
    );
    expect(stub.projectListSourceSnapshots).toHaveBeenCalledWith(5);
    expect(stub.projectDeleteSourceSnapshots).toHaveBeenCalled();
    expect(stub).not.toHaveProperty("writeFile.mock");
  });

  it("keeps the workspace client on workspace-scoped file RPC methods", async () => {
    const stub = {
      writeFile: vi.fn(async () => ({ success: true })),
      editTextFile: vi.fn(async () => ({ success: true, replacementCount: 1 })),
      readFile: vi.fn(async () => ({
        success: true,
        content: "workspace",
        encoding: "utf8",
      })),
      createProject: vi.fn(async () => ({
        id: "project-1",
        name: "demo",
        description: "Demo",
        defaultVmId: "main",
        backend: "do-r2",
      })),
    };
    const workspaces = namespaceFor(stub);
    const client = new WorkspaceFilesystemClient(
      { WORKSPACE_FS: workspaces } as never,
      "workspace-1",
    );

    await client.writeFile("/notes.md", "workspace");
    await client.editTextFile("/notes.md", [
      { oldText: "workspace", newText: "updated" },
    ]);
    await expect(client.readFile("/notes.md")).resolves.toMatchObject({
      content: "workspace",
    });

    expect(workspaces.idFromName).toHaveBeenCalledWith("workspace-1");
    expect(stub.writeFile).toHaveBeenCalledWith("/notes.md", "workspace");
    expect(stub.editTextFile).toHaveBeenCalledWith("/notes.md", [
      { oldText: "workspace", newText: "updated" },
    ]);
    expect(stub.readFile).toHaveBeenCalledWith("/notes.md");
    expect(stub).not.toHaveProperty("projectWriteFile.mock");

    await expect(
      client.createProject({ name: "demo", description: "Demo" }),
    ).resolves.toMatchObject({ backend: "do-r2" });
    expect(stub.createProject).toHaveBeenCalledWith({
      name: "demo",
      description: "Demo",
      workspaceId: "workspace-1",
    });
  });

  it("uses a distinct R2 prefix for project source blobs", () => {
    expect(__testing.fileStoreR2Prefix("workspace", "do-123")).toBe(
      "workspace-fs/do-123",
    );
    expect(__testing.fileStoreR2Prefix("project", "do-123")).toBe(
      "project-fs/do-123",
    );
  });

  it("rejects a concurrent edit instead of retaining a waiter queue", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await expect(
      client.writeFile("/src/value.ts", "const one = 1;\nconst two = 2;\n"),
    ).resolves.toEqual({ success: true });

    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      instance.fileMutationActive = true;
      try {
        await expect(
          instance.projectEditTextFile("/src/value.ts", [
            { oldText: "one = 1", newText: "one = 10" },
          ]),
        ).rejects.toThrow(/EBUSY/);
      } finally {
        instance.fileMutationActive = false;
      }
    });

    await expect(client.readFile("/src/value.ts")).resolves.toMatchObject({
      content: "const one = 1;\nconst two = 2;\n",
    });
  });

  it("keeps notebook validation inside the atomic edit mutation", async () => {
    const client = new ProjectFilesystemClient(
      env as never,
      `project-${crypto.randomUUID()}`,
    );
    const validNotebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: "code",
          id: "a",
          metadata: {},
          source: "print(1)",
          outputs: [],
          execution_count: null,
        },
      ],
    });
    await client.writeFile("/valid.ipynb", validNotebook);

    await expect(
      client.editTextFile("/valid.ipynb", [
        { oldText: '"cells":[', newText: '"cells":' },
      ]),
    ).resolves.toMatchObject({ success: false, code: "EEDIT" });
    await expect(client.readFile("/valid.ipynb")).resolves.toMatchObject({
      content: validNotebook,
    });

    const invalidNotebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          cell_type: "code",
          id: "a",
          metadata: {},
          source: "print('typo)",
          outputs: [],
          execution_count: null,
        },
        {
          cell_type: "code",
          id: "b",
          metadata: {},
          source: [42],
          outputs: [],
          execution_count: null,
        },
      ],
    });
    await client.writeFile("/invalid.ipynb", invalidNotebook);
    const repaired = await client.editTextFile("/invalid.ipynb", [
      { oldText: "print('typo)", newText: "print('fixed')" },
    ]);
    expect(repaired).toMatchObject({ success: true });
    expect(repaired.notice).toContain("still structurally invalid");
    await expect(client.readFile("/invalid.ipynb")).resolves.toMatchObject({
      content: expect.stringContaining("print('fixed')"),
    });
  });

  it("fails closed on strict listing bounds", async () => {
    const client = new ProjectFilesystemClient(
      env as never,
      `project-${crypto.randomUUID()}`,
    );
    await client.writeFile("/a.txt", "abc");
    await client.writeFile("/nested/b.txt", "hello");

    const bounded = await client.listFiles("/", {
      recursive: true,
      includeHidden: true,
      limit: 10,
      bounds: { maxTotalBytes: 7 },
    });
    expect(bounded.success).toBe(false);
    expect(bounded.files).toEqual([]);
    expect(bounded.error).toMatch(/aggregate-byte limit/);

    await expect(
      client.listFiles("/", {
        recursive: true,
        includeHidden: true,
        limit: 10,
        bounds: { maxEntries: 2 },
      }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/entry limit/),
    });
    await expect(
      client.listFiles("/", {
        recursive: true,
        includeHidden: true,
        limit: 10,
        bounds: { maxPathBytes: 4 },
      }),
    ).resolves.toMatchObject({
      success: false,
      error: expect.stringMatching(/path-byte limit/),
    });
  });

  it("recognizes local unavailable Artifacts bindings", () => {
    expect(
      __testing.isArtifactsBindingUnavailableError(
        "Binding ARTIFACTS needs to be run remotely",
      ),
    ).toBe(true);
    expect(
      __testing.isArtifactsBindingUnavailableError("network timeout"),
    ).toBe(false);
  });

  it("adopts a streamed R2 object and reads it back through the store's own path", async () => {
    const client = new ProjectFilesystemClient(
      env as never,
      `project-${crypto.randomUUID()}`,
    );

    // A payload larger than the store's inline threshold (1.5 MB) so it truly
    // lives in R2 and exercises the spilled-file read path, without being so
    // large it slows the suite.
    const size = 2 * 1024 * 1024;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) payload[i] = i % 251;
    const source = new Response(payload).body!;

    const adopt = await client.adoptR2File(
      "/assets/model.bin",
      source,
      size,
      "application/octet-stream",
    );
    expect(adopt.success).toBe(true);
    expect(adopt.size).toBe(size);

    // The store must surface the adopted file through its own stat/list/read
    // code — proving the R2 key + metadata row match what the store expects.
    await expect(client.exists("/assets/model.bin")).resolves.toMatchObject({
      exists: true,
      isFile: true,
      size,
    });
    const listing = await client.listFiles("/assets", {});
    expect(listing.files.map((f) => f.name)).toContain("model.bin");

    const readBack = await client.readFile("/assets/model.bin");
    expect(readBack.success).toBe(true);
    expect(readBack.encoding).toBe("base64");
    const decoded = Uint8Array.from(atob(readBack.content ?? ""), (ch) =>
      ch.charCodeAt(0),
    );
    expect(decoded.byteLength).toBe(size);
    expect(decoded[0]).toBe(payload[0]);
    expect(decoded[size - 1]).toBe(payload[size - 1]);

    // A size mismatch must fail loudly and leave nothing registered.
    const mismatch = await client.adoptR2File(
      "/assets/other.bin",
      new Response(new Uint8Array(10)).body!,
      999,
      "application/octet-stream",
    );
    expect(mismatch.success).toBe(false);
    await expect(client.exists("/assets/other.bin")).resolves.toMatchObject({
      exists: false,
    });
  });

  it("cancels unread adoption streams on every pre-stream rejection class", async () => {
    const stub = env.WORKSPACE_FS.get(
      env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
    );
    await runInDurableObject(stub, async (instance: any) => {
      const assertCancelledUnread = async (
        run: (stream: ReadableStream<Uint8Array>) => Promise<unknown>,
      ) => {
        const tracked = trackedUnreadStream();
        await run(tracked.stream);
        await vi.waitFor(() => expect(tracked.cancel).toHaveBeenCalledOnce());
        expect(tracked.pull).not.toHaveBeenCalled();
      };

      await assertCancelledUnread((stream) =>
        instance.projectAdoptR2File("/", stream, 0),
      );
      await assertCancelledUnread((stream) =>
        instance.projectAdoptR2File("/invalid-size.bin", stream, -1),
      );

      const originalBucket = instance.env.R2_BUCKET;
      instance.env.R2_BUCKET = undefined;
      try {
        await assertCancelledUnread((stream) =>
          instance.projectAdoptR2File("/missing-r2.bin", stream, 0),
        );
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }

      instance.r2AdoptionActive = true;
      const abort = vi
        .spyOn(instance.ctx, "abort")
        .mockImplementation(() => {});
      try {
        await assertCancelledUnread((stream) =>
          instance.projectAdoptR2File("/busy.bin", stream, 0),
        );
        expect(abort).toHaveBeenCalledOnce();
      } finally {
        instance.r2AdoptionActive = false;
        abort.mockRestore();
      }

      instance.fileMutationActive = true;
      try {
        await assertCancelledUnread((stream) =>
          instance.projectAdoptR2File("/capacity.bin", stream, 0),
        );
      } finally {
        instance.fileMutationActive = false;
      }

      const originalWorkspace = instance.projectFiles;
      instance.projectFiles = {
        mkdir: vi.fn(async () => {
          throw new Error("preparation failed");
        }),
      };
      try {
        await assertCancelledUnread((stream) =>
          instance.projectAdoptR2File("/parent/file.bin", stream, 0),
        );
      } finally {
        instance.projectFiles = originalWorkspace;
      }
    });
  });

  it("rejects directory adoption before R2 and preserves its children", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.writeFile("/replace-me/child.txt", "keep me");
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET;
      const put = vi.fn((...args: Parameters<R2Bucket["put"]>) =>
        originalBucket.put(...args),
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "put") return put;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        const tracked = trackedUnreadStream();
        await expect(
          instance.projectAdoptR2File(
            "/replace-me",
            tracked.stream,
            0,
            "application/octet-stream",
          ),
        ).resolves.toMatchObject({ success: false, code: "EISDIR" });
        await vi.waitFor(() => expect(tracked.cancel).toHaveBeenCalledOnce());
        expect(tracked.pull).not.toHaveBeenCalled();
        expect(put).not.toHaveBeenCalled();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
    await expect(client.exists("/replace-me")).resolves.toMatchObject({
      exists: true,
      isDirectory: true,
    });
    await expect(
      client.readFile("/replace-me/child.txt"),
    ).resolves.toMatchObject({ success: true, content: "keep me" });
  });

  it("rejects ordinary text and binary writes over a nonempty directory", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.writeFile("/replace-me/child.txt", "keep me");
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET;
      const put = vi.fn((...args: Parameters<R2Bucket["put"]>) =>
        originalBucket.put(...args),
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "put") return put;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(
          instance.projectWriteFile("/replace-me", "replacement"),
        ).resolves.toMatchObject({ success: false, code: "EISDIR" });
        await expect(
          instance.projectWriteBinaryFile("/replace-me", "%%%not-base64%%%"),
        ).resolves.toMatchObject({ success: false, code: "EISDIR" });
        expect(put).not.toHaveBeenCalled();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
    await expect(
      client.readFile("/replace-me/child.txt"),
    ).resolves.toMatchObject({ success: true, content: "keep me" });
  });

  it("keeps the previous object live when the metadata swap fails", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    const original = new TextEncoder().encode("original bytes");
    expect(
      await client.adoptR2File(
        "/safe.bin",
        new Response(original).body!,
        original.byteLength,
      ),
    ).toMatchObject({ success: true });

    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, (instance: any) => {
      instance.ctx.storage.sql.exec(`CREATE TRIGGER reject_adopt_swap
        BEFORE UPDATE OF r2_key ON cf_workspace_default
        WHEN NEW.path = '/safe.bin'
        BEGIN SELECT RAISE(FAIL, 'forced metadata failure'); END`);
    });

    const replacement = new TextEncoder().encode("replacement bytes");
    expect(
      await client.adoptR2File(
        "/safe.bin",
        new Response(replacement).body!,
        replacement.byteLength,
      ),
    ).toMatchObject({ success: false, code: "EADOPT" });
    const read = await client.readFile("/safe.bin");
    expect(read.success).toBe(true);
    expect(read.content).toBe("original bytes");
  });

  it("retains metadata-swap cleanup durably when deletion rejects", async () => {
    const stub = env.WORKSPACE_FS.get(
      env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
    );
    await runInDurableObject(stub, async (instance: any) => {
      await instance.projectExists("/");
      instance.ctx.storage.sql.exec(`CREATE TRIGGER reject_new_adopt
        BEFORE INSERT ON cf_workspace_default
        WHEN NEW.path = '/failed.bin'
        BEGIN SELECT RAISE(FAIL, 'forced metadata failure'); END`);
      const originalBucket = instance.env.R2_BUCKET;
      try {
        instance.env.R2_BUCKET = {
          put: vi.fn(async (_key: string, body: ReadableStream<Uint8Array>) => {
            let size = 0;
            for await (const chunk of body) size += chunk.byteLength;
            return { size };
          }),
          delete: vi.fn(async () => {
            throw new Error("delete unavailable");
          }),
        };
        await expect(
          instance.projectAdoptR2File(
            "/failed.bin",
            new Response(new Uint8Array([1])).body!,
            1,
          ),
        ).resolves.toMatchObject({ success: false, code: "EADOPT" });
        expect(
          instance.ctx.storage.sql
            .exec("SELECT r2_key FROM workspace_r2_gc_v1")
            .toArray(),
        ).toHaveLength(1);
        expect(await instance.ctx.storage.getAlarm()).not.toBeNull();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
      await expect(instance.projectDrainR2Cleanup()).resolves.toEqual({
        success: true,
        pending: 0,
      });
    });
  });

  it("keeps an adopted object live when an inline replacement transaction fails", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await expect(
      client.adoptR2File(
        "/safe.txt",
        new Response("old").body!,
        3,
        "text/plain",
      ),
    ).resolves.toMatchObject({ success: true });
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const oldKey = String(
        instance.ctx.storage.sql
          .exec(
            "SELECT r2_key FROM cf_workspace_default WHERE path = '/safe.txt'",
          )
          .toArray()[0]?.r2_key,
      );
      instance.ctx.storage.sql.exec(`CREATE TRIGGER reject_inline_swap
        BEFORE UPDATE OF storage_backend ON cf_workspace_default
        WHEN NEW.path = '/safe.txt' AND NEW.storage_backend = 'inline'
        BEGIN SELECT RAISE(FAIL, 'forced inline failure'); END`);
      await expect(
        instance.projectWriteFile("/safe.txt", "new"),
      ).resolves.toMatchObject({ success: false, code: "EWRITE" });
      expect(
        instance.ctx.storage.sql
          .exec(
            "SELECT storage_backend, r2_key FROM cf_workspace_default WHERE path = '/safe.txt'",
          )
          .toArray(),
      ).toEqual([{ storage_backend: "r2", r2_key: oldKey }]);
      expect(
        instance.ctx.storage.sql
          .exec("SELECT r2_key FROM workspace_r2_gc_v1")
          .toArray(),
      ).toEqual([]);
      await expect(instance.env.R2_BUCKET.head(oldKey)).resolves.not.toBeNull();
    });
  });

  it("atomically swaps an adopted file inline and retains rejected cleanup for its alarm", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await expect(
      client.adoptR2File(
        "/replace.txt",
        new Response("old").body!,
        3,
        "text/plain",
      ),
    ).resolves.toMatchObject({ success: true });
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET as R2Bucket;
      const oldKey = String(
        instance.ctx.storage.sql
          .exec(
            "SELECT r2_key FROM cf_workspace_default WHERE path = '/replace.txt'",
          )
          .toArray()[0]?.r2_key,
      );
      const remove = vi.fn(async () => {
        throw new Error("delete unavailable");
      });
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "delete") return remove;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(
          instance.projectWriteFile("/replace.txt", "new"),
        ).resolves.toEqual({ success: true });
        expect(remove).not.toHaveBeenCalled();
        await expect(
          instance.projectReadFile("/replace.txt"),
        ).resolves.toMatchObject({
          success: true,
          content: "new",
        });
        await instance.alarm();
        expect(remove).toHaveBeenCalledOnce();
        expect(
          instance.ctx.storage.sql
            .exec("SELECT r2_key FROM workspace_r2_gc_v1")
            .toArray(),
        ).toEqual([{ r2_key: oldKey }]);
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
      await instance.alarm();
      await expect(originalBucket.head(oldKey)).resolves.toBeNull();
      expect(
        instance.ctx.storage.sql
          .exec("SELECT r2_key FROM workspace_r2_gc_v1")
          .toArray(),
      ).toEqual([]);
    });
  });

  it("fences a foreign timed-out PUT with two grace-separated confirmed deletes", async () => {
    const stub = env.WORKSPACE_FS.get(
      env.WORKSPACE_FS.idFromName(`project-${crypto.randomUUID()}`),
    );
    await runInDurableObject(stub, async (instance: any) => {
      await instance.projectExists("/");
      instance.ensureR2GcTable();
      const key = `late-put-${crypto.randomUUID()}`;
      const futureEligibility = Date.now() + 5 * 60_000 + 30_000;
      instance.ctx.storage.sql.exec(
        `INSERT INTO workspace_r2_gc_v1
           (r2_key, owner, phase, eligible_at)
         VALUES (?, 'foreign-owner', 'pending-put', ?)`,
        key,
        futureEligibility,
      );
      const originalBucket = instance.env.R2_BUCKET as R2Bucket;
      const remove = vi.fn((...args: Parameters<R2Bucket["delete"]>) =>
        originalBucket.delete(...args),
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "delete") return remove;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(
          instance.drainR2Cleanup(Date.now() + 10_000),
        ).resolves.toBe(false);
        expect(remove).not.toHaveBeenCalled();
        expect(
          instance.ctx.storage.sql
            .exec(
              "SELECT eligible_at FROM workspace_r2_gc_v1 WHERE r2_key = ?",
              key,
            )
            .toArray(),
        ).toEqual([{ eligible_at: futureEligibility }]);

        instance.ctx.storage.sql.exec(
          "UPDATE workspace_r2_gc_v1 SET eligible_at = ? WHERE r2_key = ?",
          Date.now() - 1,
          key,
        );
        await expect(
          instance.drainR2Cleanup(Date.now() + 10_000),
        ).resolves.toBe(false);
        expect(remove).toHaveBeenCalledOnce();
        expect(
          instance.ctx.storage.sql
            .exec("SELECT phase FROM workspace_r2_gc_v1 WHERE r2_key = ?", key)
            .toArray(),
        ).toEqual([{ phase: "confirm-delete" }]);

        // Model a provider PUT that committed after the first delete.
        await originalBucket.put(key, "late bytes");
        instance.ctx.storage.sql.exec(
          "UPDATE workspace_r2_gc_v1 SET eligible_at = ? WHERE r2_key = ?",
          Date.now() - 1,
          key,
        );
        await expect(
          instance.drainR2Cleanup(Date.now() + 10_000),
        ).resolves.toBe(true);
        expect(remove).toHaveBeenCalledTimes(2);
        await expect(originalBucket.head(key)).resolves.toBeNull();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
  });

  it("rejects oversized buffered writes before decoding or metadata mutation", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const oversizedBase64 = "A".repeat(Math.ceil((1024 * 1024 + 1) / 3) * 4);
      await expect(
        instance.projectWriteBinaryFile("/too-large.bin", oversizedBase64),
      ).resolves.toMatchObject({ success: false, code: "E2BIG" });
      await expect(
        instance.projectWriteFile(
          "/too-large.txt",
          "x".repeat(1024 * 1024 + 1),
        ),
      ).resolves.toMatchObject({ success: false, code: "E2BIG" });
      expect(
        instance.ctx.storage.sql
          .exec(
            "SELECT path FROM cf_workspace_default WHERE path IN ('/too-large.bin', '/too-large.txt')",
          )
          .toArray(),
      ).toEqual([]);
    });
  });

  it("rejects buffered reads and edits of an adopted file over 2 MiB without opening R2", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    const bytes = new Uint8Array(2 * 1024 * 1024 + 1);
    await expect(
      client.adoptR2File(
        "/huge.bin",
        new Response(bytes).body!,
        bytes.byteLength,
        "application/octet-stream",
      ),
    ).resolves.toMatchObject({ success: true });
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET as R2Bucket;
      const get = vi.fn((...args: Parameters<R2Bucket["get"]>) =>
        originalBucket.get(...args),
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "get") return get;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(
          instance.projectReadFile("/huge.bin"),
        ).resolves.toMatchObject({
          success: false,
          code: "E2BIG",
        });
        await expect(
          instance.projectEditTextFile("/huge.bin", [
            { oldText: "a", newText: "b" },
          ]),
        ).resolves.toMatchObject({ success: false, code: "E2BIG" });
        expect(get).not.toHaveBeenCalled();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
  });

  it("admits only one streamed adoption and releases all retained state", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const put = vi.fn(
        async (_key: string, body: ReadableStream<Uint8Array>) => {
          await gate;
          let size = 0;
          for await (const chunk of body) size += chunk.byteLength;
          return { size };
        },
      );
      const abort = vi
        .spyOn(instance.ctx, "abort")
        .mockImplementation(() => {});
      try {
        instance.env.R2_BUCKET = {
          put,
          delete: vi.fn(async () => undefined),
        };

        const first = instance.projectAdoptR2File(
          "/first.bin",
          new Response(new Uint8Array([1])).body!,
          1,
        );
        await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
        const rejected = await instance.projectAdoptR2File(
          "/rejected.bin",
          new Response(new Uint8Array([2])).body!,
          1,
        );
        expect(rejected.code).toBe("EBUSY");
        expect(abort).toHaveBeenCalledOnce();
        expect(put).toHaveBeenCalledOnce();

        release();
        await expect(first).resolves.toMatchObject({ success: true, size: 1 });
        expect(instance.r2AdoptionActive).toBe(false);
        expect(instance.fileMutationActive).toBe(false);
      } finally {
        instance.env.R2_BUCKET = originalBucket;
        abort.mockRestore();
      }
    });
  });

  it("fails a recursive parent delete fast while adoption owns the mutation lane", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.writeFile("/parent/existing.txt", "existing");
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const put = vi.fn(
        async (
          key: string,
          body: ReadableStream<Uint8Array>,
          options?: R2PutOptions,
        ) => {
          await gate;
          return originalBucket.put(key, body, options);
        },
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "put") return put;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        const adoption = instance.projectAdoptR2File(
          "/parent/new.bin",
          new Response(new Uint8Array([1])).body!,
          1,
        );
        await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
        const deletion = instance.projectDeleteFile("/parent", {
          recursive: true,
          force: true,
        });
        await expect(deletion).rejects.toThrow(/EBUSY/);

        release();
        await expect(adoption).resolves.toMatchObject({ success: true });
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
    await expect(client.exists("/parent/new.bin")).resolves.toMatchObject({
      exists: true,
    });
  });

  it("creates deterministic project source snapshots from real DO-backed files", async () => {
    const client = new ProjectFilesystemClient(
      env as never,
      `project-${crypto.randomUUID()}`,
    );
    await expect(
      client.writeFile(
        "/package.json",
        JSON.stringify({ scripts: { build: "vite build" } }),
      ),
    ).resolves.toEqual({ success: true });
    await expect(
      client.writeFile("/src/index.ts", "export const value = 1;\n"),
    ).resolves.toEqual({ success: true });
    await expect(
      client.writeFile("/node_modules/ignored.js", "ignored\n"),
    ).resolves.toEqual({ success: true });

    const first = await client.createSourceSnapshot({ message: "deploy" });
    const second = await client.createSourceSnapshot({
      message: "deploy again",
    });

    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(second.id).toBe(first.id);
    expect(first.message).toBe("deploy");
    expect(first.fileCount).toBe(2);
    expect(first.entries.map((entry) => entry.path)).toEqual([
      "package.json",
      "src/index.ts",
    ]);
    expect(
      first.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256)),
    ).toBe(true);
    expect(
      first.entries.every((entry) =>
        entry.blobKey.startsWith("project-source-snapshots/"),
      ),
    ).toBe(true);
    await expect(client.listSourceSnapshots(10)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.id, fileCount: 2 }),
      ]),
    );

    await expect(
      client.writeFile("/src/index.ts", "export const value = 2;\n"),
    ).resolves.toEqual({ success: true });
    await expect(
      client.writeFile("/src/extra.ts", "export const extra = true;\n"),
    ).resolves.toEqual({ success: true });
    await expect(client.restoreSourceSnapshot(first.id)).resolves.toMatchObject(
      { id: first.id, fileCount: 2 },
    );
    await expect(client.readFile("/src/index.ts")).resolves.toMatchObject({
      content: "export const value = 1;\n",
    });
    await expect(client.readFile("/src/extra.ts")).resolves.toMatchObject({
      success: false,
      code: "ENOENT",
    });

    const firstBlobKey = first.entries[0]?.blobKey;
    expect(firstBlobKey).toBeTruthy();
    await expect(
      (env as never as { R2_BUCKET: R2Bucket }).R2_BUCKET.head(firstBlobKey),
    ).resolves.toBeTruthy();
    await expect(client.deleteSourceSnapshots()).resolves.toEqual({
      snapshotsDeleted: 1,
      blobsDeleted: 2,
    });
    await expect(client.listSourceSnapshots(10)).resolves.toEqual([]);
    await expect(
      (env as never as { R2_BUCKET: R2Bucket }).R2_BUCKET.head(firstBlobKey),
    ).resolves.toBeNull();
  });

  it("reuses a verified snapshot blob with one source GET, one HEAD, and no write", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await expect(
      client.adoptR2File(
        "/source.bin",
        new Response("source bytes").body!,
        12,
        "application/octet-stream",
      ),
    ).resolves.toMatchObject({ success: true });
    const first = await client.createSourceSnapshot();
    const blobKey = first.entries[0]?.blobKey;
    expect(blobKey).toBeTruthy();

    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const sourceKey = String(
        instance.ctx.storage.sql
          .exec(
            "SELECT r2_key FROM cf_workspace_default WHERE path = '/source.bin'",
          )
          .toArray()[0]?.r2_key,
      );
      const originalBucket = instance.env.R2_BUCKET as R2Bucket;
      const get = vi.fn((...args: Parameters<R2Bucket["get"]>) =>
        originalBucket.get(...args),
      );
      const head = vi.fn((...args: Parameters<R2Bucket["head"]>) =>
        originalBucket.head(...args),
      );
      const put = vi.fn((...args: Parameters<R2Bucket["put"]>) =>
        originalBucket.put(...args),
      );
      const setAlarm = vi.spyOn(instance.ctx.storage, "setAlarm");
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "get") return get;
          if (property === "head") return head;
          if (property === "put") return put;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(
          instance.projectCreateSourceSnapshot(),
        ).resolves.toMatchObject({ id: first.id });
        expect(get.mock.calls.map(([key]) => key)).toEqual([sourceKey]);
        expect(head.mock.calls.map(([key]) => key)).toEqual([blobKey]);
        expect(put).not.toHaveBeenCalled();
        expect(setAlarm).not.toHaveBeenCalled();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
        setAlarm.mockRestore();
      }
    });
  });

  it("records only one settled transition and two alarm writes for one snapshot PUT", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.writeFile("/source.txt", "source");
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET as R2Bucket;
      const put = vi.fn((...args: Parameters<R2Bucket["put"]>) =>
        originalBucket.put(...args),
      );
      const settled = vi.spyOn(instance, "markR2CleanupSettled");
      const setAlarm = vi.spyOn(instance.ctx.storage, "setAlarm");
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "put") return put;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(
          instance.projectCreateSourceSnapshot(),
        ).resolves.toMatchObject({ fileCount: 1 });
        await vi.waitFor(() => expect(setAlarm).toHaveBeenCalledTimes(2));
        expect(put).toHaveBeenCalledOnce();
        expect(settled).toHaveBeenCalledOnce();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
        settled.mockRestore();
        setAlarm.mockRestore();
      }
    });
  });

  it("rolls a full 200-snapshot index while retaining shared blobs", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.writeFile("/seed.txt", "first");
    const base = await client.createSourceSnapshot();
    await client.writeFile("/seed.txt", "next");
    const candidate = await client.createSourceSnapshot();
    const sharedBlobKey = base.entries[0]?.blobKey;
    expect(sharedBlobKey).toBeTruthy();

    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const ids = [base.id];
      for (let value = 1; ids.length < 200; value += 1) {
        const id = value.toString(16).padStart(64, "0");
        if (id === base.id || id === candidate.id) continue;
        ids.push(id);
        instance.ctx.storage.kv.put(`project-source-snapshot:${id}`, {
          ...base,
          id,
        });
      }
      instance.ctx.storage.kv.put("project-source-snapshots:v1", ids);
      const evictedId = ids.at(-1)!;

      await expect(
        instance.projectCreateSourceSnapshot(),
      ).resolves.toMatchObject({ id: candidate.id });
      expect(
        instance.ctx.storage.kv.get("project-source-snapshots:v1"),
      ).toEqual([candidate.id, ...ids.slice(0, 199)]);
      expect(
        instance.ctx.storage.kv.get(`project-source-snapshot:${evictedId}`),
      ).toBeUndefined();
      expect(
        instance.ctx.storage.kv.get(`project-source-snapshot:${base.id}`),
      ).toBeTruthy();
      expect(
        instance.ctx.storage.sql
          .exec(
            "SELECT r2_key FROM workspace_r2_gc_v1 WHERE r2_key = ?",
            sharedBlobKey,
          )
          .toArray(),
      ).toEqual([]);
      await expect(
        instance.env.R2_BUCKET.head(sharedBlobKey),
      ).resolves.not.toBeNull();
    });
  });

  it("rejects an oversized deeply segmented snapshot path before any R2 lookup", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.writeFile("/seed.txt", "seed");
    const snapshot = await client.createSourceSnapshot();
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));

    await runInDurableObject(stub, async (instance: any) => {
      const deepPath = `${"a/".repeat(450_000)}file.txt`;
      expect(new TextEncoder().encode(deepPath).byteLength).toBeLessThan(
        1024 * 1024,
      );
      const malformed = {
        ...snapshot,
        entries: [{ ...snapshot.entries[0], path: deepPath }],
      };
      instance.ctx.storage.kv.put(
        `project-source-snapshot:${snapshot.id}`,
        malformed,
      );
      const originalBucket = instance.env.R2_BUCKET as R2Bucket;
      const get = vi.fn((...args: Parameters<R2Bucket["get"]>) =>
        originalBucket.get(...args),
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "get") return get;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(
          instance.projectRestoreSourceSnapshot(snapshot.id),
        ).rejects.toThrow(/snapshot entry is malformed/i);
        expect(get).not.toHaveBeenCalled();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
  });

  it("bounds aggregate snapshot directory prefixes before any R2 lookup", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.writeFile("/seed.txt", "seed");
    const snapshot = await client.createSourceSnapshot();
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));

    await runInDurableObject(stub, async (instance: any) => {
      const entry = snapshot.entries[0]!;
      const pathFor = (root: string) => `${root}/${"x/".repeat(1_490)}file.txt`;
      const paths = [pathFor("a"), pathFor("b")];
      expect(paths.every((path) => path.length < 4_096)).toBe(true);
      const malformed = {
        ...snapshot,
        fileCount: paths.length,
        totalBytes: entry.size * paths.length,
        entries: paths.map((path) => ({ ...entry, path })),
      };
      instance.ctx.storage.kv.put(
        `project-source-snapshot:${snapshot.id}`,
        malformed,
      );
      const originalBucket = instance.env.R2_BUCKET as R2Bucket;
      const get = vi.fn((...args: Parameters<R2Bucket["get"]>) =>
        originalBucket.get(...args),
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "get") return get;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(
          instance.projectRestoreSourceSnapshot(snapshot.id),
        ).rejects.toThrow(/directory topology exceeds workspace bounds/i);
        expect(get).not.toHaveBeenCalled();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
  });

  it("rejects a same-size changed second source read without persisting a snapshot", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.adoptR2File(
      "/race.bin",
      new Response("good").body!,
      4,
      "application/octet-stream",
    );
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET;
      const sourceKey = String(
        instance.ctx.storage.sql
          .exec(
            "SELECT r2_key FROM cf_workspace_default WHERE path = '/race.bin'",
          )
          .toArray()[0]?.r2_key ?? "",
      );
      let sourceGets = 0;
      const get = vi.fn(async (key: string) => {
        const object = await originalBucket.get(key);
        if (!object || key !== sourceKey) return object;
        sourceGets += 1;
        if (sourceGets !== 2) return object;
        const body = new Response("evil").body!;
        return new Proxy(object, {
          get(target, property) {
            if (property === "body") return body;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      const put = vi.fn((...args: Parameters<R2Bucket["put"]>) =>
        originalBucket.put(...args),
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "get") return get;
          if (property === "put") return put;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(instance.projectCreateSourceSnapshot()).rejects.toThrow();
        expect(sourceGets).toBe(2);
        expect(put).toHaveBeenCalledOnce();
        expect(put.mock.calls[0]?.[2]).toMatchObject({
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
          customMetadata: { type: "project-source-snapshot" },
        });
        const attemptedBlobKey = String(put.mock.calls[0]?.[0] ?? "");
        await expect(originalBucket.head(attemptedBlobKey)).resolves.toBeNull();
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
    await expect(client.listSourceSnapshots()).resolves.toEqual([]);
    await expect(client.readFile("/race.bin")).resolves.toMatchObject({
      success: true,
      content: "good",
    });
  });

  it("fails snapshot creation when a listed R2 source is missing", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await expect(
      client.adoptR2File(
        "/missing.bin",
        new Response("source").body!,
        6,
        "application/octet-stream",
      ),
    ).resolves.toMatchObject({ success: true });
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const row = instance.ctx.storage.sql
        .exec(
          "SELECT r2_key FROM cf_workspace_default WHERE path = '/missing.bin'",
        )
        .toArray()[0] as { r2_key?: string } | undefined;
      expect(row?.r2_key).toBeTruthy();
      await instance.env.R2_BUCKET.delete(row!.r2_key!);
      await expect(instance.projectCreateSourceSnapshot()).rejects.toThrow(
        /missing from R2/,
      );
      expect(
        instance.ctx.storage.kv.get("project-source-snapshots:v1"),
      ).toBeUndefined();
    });
  });

  it("cancels the exact snapshot source when its R2 put throws synchronously", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.adoptR2File(
      "/sync.bin",
      new Response("x").body!,
      1,
      "application/octet-stream",
    );
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET;
      const sourceKey = String(
        instance.ctx.storage.sql
          .exec(
            "SELECT r2_key FROM cf_workspace_default WHERE path = '/sync.bin'",
          )
          .toArray()[0]?.r2_key ?? "",
      );
      const tracked = trackedUnreadStream();
      let sourceGets = 0;
      const get = vi.fn(async (key: string) => {
        const object = await originalBucket.get(key);
        if (!object || key !== sourceKey) return object;
        sourceGets += 1;
        if (sourceGets !== 2) return object;
        return new Proxy(object, {
          get(target, property) {
            if (property === "body") return tracked.stream;
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      });
      const put = vi.fn(() => {
        throw new Error("snapshot put failed synchronously");
      });
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "get") return get;
          if (property === "put") return put;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(instance.projectCreateSourceSnapshot()).rejects.toThrow(
          "snapshot put failed synchronously",
        );
        expect(sourceGets).toBe(2);
        expect(put).toHaveBeenCalledOnce();
        expect(tracked.cancel).toHaveBeenCalledOnce();
        expect(tracked.stream.locked).toBe(false);
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
    await expect(client.listSourceSnapshots()).resolves.toEqual([]);
  });

  it("fails concurrent project writes fast while snapshot creation is active", async () => {
    const projectId = `project-${crypto.randomUUID()}`;
    const client = new ProjectFilesystemClient(env as never, projectId);
    await client.adoptR2File(
      "/source.bin",
      new Response("source").body!,
      6,
      "application/octet-stream",
    );
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
    await runInDurableObject(stub, async (instance: any) => {
      const originalBucket = instance.env.R2_BUCKET;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const put = vi.fn(
        async (
          key: string,
          body: ReadableStream<Uint8Array>,
          options?: R2PutOptions,
        ) => {
          if (key.startsWith("project-source-snapshots/")) await gate;
          return originalBucket.put(key, body, options);
        },
      );
      instance.env.R2_BUCKET = new Proxy(originalBucket, {
        get(target, property) {
          if (property === "put") return put;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        const snapshot = instance.projectCreateSourceSnapshot();
        await vi.waitFor(() => expect(put).toHaveBeenCalledOnce());
        await expect(
          instance.projectWriteFile("/after.txt", "after"),
        ).rejects.toThrow(/EBUSY/);

        release();
        await expect(snapshot).resolves.toMatchObject({ fileCount: 1 });
        await expect(
          instance.projectWriteFile("/after.txt", "after"),
        ).resolves.toEqual({ success: true });
      } finally {
        instance.env.R2_BUCKET = originalBucket;
      }
    });
    await expect(client.readFile("/after.txt")).resolves.toMatchObject({
      success: true,
      content: "after",
    });
  });
});

it("snapshots R2-spilled files by streaming, entries matching the adopted content", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const client = new ProjectFilesystemClient(env as never, projectId);
  const size = 2 * 1024 * 1024 + 257;
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) payload[i] = (i * 7) % 251;
  const adopt = await client.adoptR2File(
    "/data/big.bin",
    new Response(payload).body!,
    size,
    "application/octet-stream",
  );
  expect(adopt.success).toBe(true);
  await client.writeFile("/README.md", "hello");

  const snapshot = await client.createSourceSnapshot({
    message: "stream test",
  });
  const big = snapshot.entries.find((e) => e.path === "data/big.bin");
  expect(big).toBeDefined();
  expect(big!.size).toBe(size);
  // digest must match a locally computed SHA-256 of the same payload
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const expected = Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  expect(big!.sha256).toBe(expected);
  // restore must round-trip the streamed blob through the store
  await client.deleteFile("/data/big.bin", { recursive: true, force: true });
  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    const originalBucket = instance.env.R2_BUCKET;
    const wholeRead = vi.fn(async () => {
      throw new Error("restore attempted to whole-buffer an R2 object");
    });
    const get = vi.fn(async (key: string) => {
      const object = await originalBucket.get(key);
      if (!object) return null;
      return new Proxy(object, {
        get(target, property) {
          if (property === "arrayBuffer" || property === "bytes")
            return wholeRead;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    instance.env.R2_BUCKET = new Proxy(originalBucket, {
      get(target, property) {
        if (property === "get") return get;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(
        instance.projectRestoreSourceSnapshot(snapshot.id),
      ).resolves.toMatchObject({
        id: snapshot.id,
        totalBytes: snapshot.totalBytes,
      });
      expect(wholeRead).not.toHaveBeenCalled();
      expect(
        get.mock.calls.filter(([key]) => key === big!.blobKey),
      ).toHaveLength(1);
      expect(
        instance.ctx.storage.sql
          .exec(
            `SELECT storage_backend FROM cf_workspace_default
             WHERE path = '/README.md'`,
          )
          .toArray(),
      ).toEqual([{ storage_backend: "inline" }]);
      expect(
        instance.ctx.storage.sql
          .exec(
            `SELECT storage_backend FROM cf_workspace_default
             WHERE path = '/data/big.bin'`,
          )
          .toArray(),
      ).toEqual([{ storage_backend: "r2" }]);
    } finally {
      instance.env.R2_BUCKET = originalBucket;
    }
  });
  const back = await client.exists("/data/big.bin");
  expect(back).toMatchObject({ exists: true, size });
});

it("rejects a same-size changed restore stream before replacing the live file", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const client = new ProjectFilesystemClient(env as never, projectId);
  await client.writeFile("/same.bin", "snapshot");
  const snapshot = await client.createSourceSnapshot();
  const entry = snapshot.entries.find(
    (candidate) => candidate.path === "same.bin",
  );
  expect(entry).toBeDefined();
  await client.writeFile("/same.bin", "current!");

  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    const originalBucket = instance.env.R2_BUCKET;
    let snapshotGets = 0;
    const get = vi.fn(async (key: string) => {
      const object = await originalBucket.get(key);
      if (!object || key !== entry!.blobKey) return object;
      snapshotGets += 1;
      const corrupt = new TextEncoder().encode("corrupt!");
      expect(corrupt.byteLength).toBe(entry!.size);
      const body = new Response(corrupt).body!;
      return new Proxy(object, {
        get(target, property) {
          if (property === "body") return body;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const put = vi.fn((...args: Parameters<R2Bucket["put"]>) =>
      originalBucket.put(...args),
    );
    instance.env.R2_BUCKET = new Proxy(originalBucket, {
      get(target, property) {
        if (property === "get") return get;
        if (property === "put") return put;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(
        instance.projectRestoreSourceSnapshot(snapshot.id),
      ).rejects.toThrow(/Failed to restore project source snapshot file/);
      expect(snapshotGets).toBe(1);
      expect(put).not.toHaveBeenCalled();
    } finally {
      instance.env.R2_BUCKET = originalBucket;
    }
  });

  await expect(client.readFile("/same.bin")).resolves.toMatchObject({
    success: true,
    content: "current!",
  });
});

it("fails restore before mutation when a snapshot file collides with a live directory", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const client = new ProjectFilesystemClient(env as never, projectId);
  await client.writeFile("/collision", "snapshot bytes");
  const snapshot = await client.createSourceSnapshot();
  await client.deleteFile("/collision", { force: true });
  await client.writeFile("/collision/child.txt", "must survive");

  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    await expect(
      instance.projectRestoreSourceSnapshot(snapshot.id),
    ).rejects.toThrow(/Cannot restore a snapshot file over directory/);
  });
  await expect(client.exists("/collision")).resolves.toMatchObject({
    exists: true,
    isDirectory: true,
  });
  await expect(client.readFile("/collision/child.txt")).resolves.toMatchObject({
    success: true,
    content: "must survive",
  });
});

it("stages the whole restore before atomically replacing any live file", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const client = new ProjectFilesystemClient(env as never, projectId);
  await client.writeFile("/a.txt", "snapshot-a");
  await client.writeFile("/b.txt", "snapshot-b");
  const snapshot = await client.createSourceSnapshot();
  await client.writeFile("/a.txt", "current-a!");
  await client.writeFile("/b.txt", "current-b!");
  const bEntry = snapshot.entries.find((entry) => entry.path === "b.txt");
  expect(bEntry).toBeDefined();

  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    const originalBucket = instance.env.R2_BUCKET as R2Bucket;
    const getCounts = new Map<string, number>();
    const get = vi.fn(async (key: string) => {
      const object = await originalBucket.get(key);
      if (!object || key !== bEntry!.blobKey) return object;
      const count = (getCounts.get(key) ?? 0) + 1;
      getCounts.set(key, count);
      const corrupt = new TextEncoder().encode("corrupted!");
      expect(corrupt.byteLength).toBe(bEntry!.size);
      return new Proxy(object, {
        get(target, property) {
          if (property === "body") return new Response(corrupt).body!;
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    });
    const put = vi.fn((...args: Parameters<R2Bucket["put"]>) =>
      originalBucket.put(...args),
    );
    instance.env.R2_BUCKET = new Proxy(originalBucket, {
      get(target, property) {
        if (property === "get") return get;
        if (property === "put") return put;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(
        instance.projectRestoreSourceSnapshot(snapshot.id),
      ).rejects.toThrow(/Failed to restore project source snapshot file b.txt/);
      expect(getCounts.get(bEntry!.blobKey)).toBe(1);
      expect(put).not.toHaveBeenCalled();
    } finally {
      instance.env.R2_BUCKET = originalBucket;
    }
  });

  await expect(client.readFile("/a.txt")).resolves.toMatchObject({
    content: "current-a!",
  });
  await expect(client.readFile("/b.txt")).resolves.toMatchObject({
    content: "current-b!",
  });
});

it("commits restore while retaining failed old-key cleanup and drains it on retry", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const client = new ProjectFilesystemClient(env as never, projectId);
  await client.writeFile("/file.txt", "snapshot");
  const snapshot = await client.createSourceSnapshot();
  const current = new TextEncoder().encode("current!");
  await expect(
    client.adoptR2File(
      "/file.txt",
      new Response(current).body!,
      current.byteLength,
      "text/plain",
    ),
  ).resolves.toMatchObject({ success: true });

  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    const oldKey = String(
      instance.ctx.storage.sql
        .exec(
          "SELECT r2_key FROM cf_workspace_default WHERE path = '/file.txt'",
        )
        .toArray()[0]?.r2_key,
    );
    expect(oldKey).toContain("/adopt/");
    const originalBucket = instance.env.R2_BUCKET as R2Bucket;
    const remove = vi.fn(() => {
      throw new Error("delete unavailable");
    });
    instance.env.R2_BUCKET = new Proxy(originalBucket, {
      get(target, property) {
        if (property === "delete") return remove;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(
        instance.projectRestoreSourceSnapshot(snapshot.id),
      ).resolves.toMatchObject({ id: snapshot.id });
      expect(remove).not.toHaveBeenCalled();
      expect(
        instance.ctx.storage.sql
          .exec("SELECT r2_key FROM workspace_r2_gc_v1 ORDER BY r2_key")
          .toArray(),
      ).toEqual([{ r2_key: oldKey }]);
      await expect(originalBucket.head(oldKey)).resolves.not.toBeNull();
      await expect(
        instance.projectReadFile("/file.txt"),
      ).resolves.toMatchObject({ success: true, content: "snapshot" });
      await expect(instance.projectDrainR2Cleanup()).resolves.toEqual({
        success: false,
        pending: 1,
      });
      expect(remove).toHaveBeenCalledOnce();
    } finally {
      instance.env.R2_BUCKET = originalBucket;
    }

    await expect(instance.projectDrainR2Cleanup()).resolves.toEqual({
      success: true,
      pending: 0,
    });
    expect(
      instance.ctx.storage.sql
        .exec("SELECT r2_key FROM workspace_r2_gc_v1")
        .toArray(),
    ).toEqual([]);
    await expect(originalBucket.head(oldKey)).resolves.toBeNull();
  });
});

it("retains durable snapshot GC work when deletion fails and resumes it", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const client = new ProjectFilesystemClient(env as never, projectId);
  await client.writeFile("/a.txt", "a");
  await client.writeFile("/b.txt", "b");
  const snapshot = await client.createSourceSnapshot();
  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));

  await runInDurableObject(stub, async (instance: any) => {
    const originalBucket = instance.env.R2_BUCKET;
    const abort = vi.spyOn(instance.ctx, "abort").mockImplementation(() => {});
    instance.env.R2_BUCKET = new Proxy(originalBucket, {
      get(target, property) {
        if (property === "delete") {
          return vi.fn(() => {
            throw new Error("delete unavailable");
          });
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(instance.projectDeleteSourceSnapshots()).rejects.toThrow(
        /cleanup did not settle/,
      );
      expect(abort).toHaveBeenCalledOnce();
      expect(
        instance.ctx.storage.kv.get("project-source-snapshots:v1"),
      ).toEqual([]);
      expect(
        instance.ctx.storage.kv.get("project-source-snapshots:gc:v1"),
      ).toEqual([snapshot.id]);
      expect(
        instance.ctx.storage.kv.get(`project-source-snapshot:${snapshot.id}`),
      ).toBeTruthy();
    } finally {
      instance.env.R2_BUCKET = originalBucket;
      abort.mockRestore();
    }

    await expect(instance.projectDeleteSourceSnapshots()).resolves.toEqual({
      snapshotsDeleted: 1,
      blobsDeleted: 2,
    });
    expect(
      instance.ctx.storage.kv.get("project-source-snapshots:gc:v1"),
    ).toBeUndefined();
    expect(
      instance.ctx.storage.kv.get(`project-source-snapshot:${snapshot.id}`),
    ).toBeUndefined();
  });
});

it("coalesces 4096 settled PUT callbacks to one eager alarm write", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    instance.ensureR2GcTable();
    const keys = Array.from(
      { length: 4_096 },
      (_, index) => `settled/${index.toString().padStart(4, "0")}`,
    );
    instance.ctx.storage.transactionSync(() => {
      for (const key of keys) {
        instance.ctx.storage.sql.exec(
          `INSERT INTO workspace_r2_gc_v1
             (r2_key, owner, phase, eligible_at)
           VALUES (?, ?, 'pending-put', ?)`,
          key,
          instance.r2CleanupOwner,
          Date.now(),
        );
      }
    });
    const setAlarm = vi.spyOn(instance.ctx.storage, "setAlarm");
    try {
      for (const key of keys) instance.markR2CleanupSettled(key);
      await vi.waitFor(() => expect(setAlarm).toHaveBeenCalledOnce());
      expect(
        instance.ctx.storage.sql
          .exec(
            `SELECT COUNT(*) AS count FROM workspace_r2_gc_v1
             WHERE phase = 'delete'`,
          )
          .toArray(),
      ).toEqual([{ count: 4_096 }]);
    } finally {
      instance.ctx.storage.sql.exec("DELETE FROM workspace_r2_gc_v1");
      await instance.ctx.storage.deleteAlarm();
      setAlarm.mockRestore();
    }
  });
});

it("cleans only its failed staged PUT with a 4096-key unrelated backlog", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    instance.ensureR2GcTable();
    instance.ctx.storage.transactionSync(() => {
      for (let index = 0; index < 4_096; index += 1) {
        instance.ctx.storage.sql.exec(
          `INSERT INTO workspace_r2_gc_v1
             (r2_key, owner, phase, eligible_at)
           VALUES (?, NULL, 'delete', ?)`,
          `unrelated/${index.toString().padStart(4, "0")}`,
          Date.now(),
        );
      }
    });

    const originalBucket = instance.env.R2_BUCKET as R2Bucket;
    const put = vi.fn(() => {
      throw new Error("staged put failed");
    });
    const deletedKeys: string[] = [];
    const remove = vi.fn(async (keys: string | string[]) => {
      deletedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
      await originalBucket.delete(keys);
    });
    instance.env.R2_BUCKET = new Proxy(originalBucket, {
      get(target, property) {
        if (property === "put") return put;
        if (property === "delete") return remove;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(
        instance.projectAdoptR2File(
          "/failed.bin",
          new Response("bytes").body!,
          5,
        ),
      ).resolves.toMatchObject({ success: false, code: "EADOPT" });
      const stagedKey = String(put.mock.calls[0]?.[0]);
      expect(stagedKey).toContain("/adopt/");
      expect(deletedKeys).toEqual([stagedKey]);
      expect(remove).toHaveBeenCalledOnce();
      expect(
        instance.ctx.storage.sql
          .exec(
            `SELECT COUNT(*) AS count FROM workspace_r2_gc_v1
             WHERE r2_key LIKE 'unrelated/%'`,
          )
          .toArray(),
      ).toEqual([{ count: 4_096 }]);
      expect(
        instance.ctx.storage.sql
          .exec(
            "SELECT r2_key FROM workspace_r2_gc_v1 WHERE r2_key = ?",
            stagedKey,
          )
          .toArray(),
      ).toEqual([]);
    } finally {
      instance.env.R2_BUCKET = originalBucket;
      instance.ctx.storage.sql.exec("DELETE FROM workspace_r2_gc_v1");
      await instance.ctx.storage.deleteAlarm();
    }
  });
});

it("rejects recursive deletes over the 4096-entry metadata cap", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const client = new ProjectFilesystemClient(env as never, projectId);
  await client.mkdir("/huge", { recursive: true });
  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    const now = Math.floor(Date.now() / 1000);
    instance.ctx.storage.transactionSync(() => {
      for (let index = 0; index < 4_097; index += 1) {
        instance.ctx.storage.sql.exec(
          `INSERT INTO cf_workspace_default
            (path, parent_path, name, type, size, created_at, modified_at)
           VALUES (?, '/huge', ?, 'directory', 0, ?, ?)`,
          `/huge/entry-${index}`,
          `entry-${index}`,
          now,
          now,
        );
      }
    });
    await expect(
      instance.projectDeleteFile("/huge", { recursive: true, force: true }),
    ).resolves.toMatchObject({ success: false, code: "E2BIG" });
    await expect(
      instance.projectDeleteFile("/", { recursive: true, force: true }),
    ).resolves.toMatchObject({ success: false, code: "E2BIG" });
    const count = Number(
      instance.ctx.storage.sql
        .exec(
          "SELECT COUNT(*) AS count FROM cf_workspace_default WHERE parent_path = '/huge'",
        )
        .toArray()[0]?.count ?? 0,
    );
    expect(count).toBe(4_097);
  });
});

it("commits file deletion while retaining rejected R2 cleanup for the alarm", async () => {
  const projectId = `project-${crypto.randomUUID()}`;
  const client = new ProjectFilesystemClient(env as never, projectId);
  await expect(
    client.adoptR2File("/delete.bin", new Response("bytes").body!, 5),
  ).resolves.toMatchObject({ success: true });
  const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(projectId));
  await runInDurableObject(stub, async (instance: any) => {
    const originalBucket = instance.env.R2_BUCKET as R2Bucket;
    const oldKey = String(
      instance.ctx.storage.sql
        .exec(
          "SELECT r2_key FROM cf_workspace_default WHERE path = '/delete.bin'",
        )
        .toArray()[0]?.r2_key,
    );
    const remove = vi.fn(async () => {
      throw new Error("delete unavailable");
    });
    instance.env.R2_BUCKET = new Proxy(originalBucket, {
      get(target, property) {
        if (property === "delete") return remove;
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    try {
      await expect(
        instance.projectDeleteFile("/delete.bin", { force: true }),
      ).resolves.toEqual({ success: true });
      expect(remove).not.toHaveBeenCalled();
      await expect(instance.projectExists("/delete.bin")).resolves.toEqual({
        exists: false,
      });
      await expect(
        instance.projectWriteFile("/unrelated.txt", "still writable"),
      ).resolves.toEqual({ success: true });
      expect(remove).not.toHaveBeenCalled();
      await instance.alarm();
      expect(remove).toHaveBeenCalledOnce();
      expect(
        instance.ctx.storage.sql
          .exec("SELECT r2_key FROM workspace_r2_gc_v1")
          .toArray(),
      ).toEqual([{ r2_key: oldKey }]);
      await expect(originalBucket.head(oldKey)).resolves.not.toBeNull();
    } finally {
      instance.env.R2_BUCKET = originalBucket;
    }
    await instance.alarm();
    await expect(originalBucket.head(oldKey)).resolves.toBeNull();
    expect(
      instance.ctx.storage.sql
        .exec("SELECT r2_key FROM workspace_r2_gc_v1")
        .toArray(),
    ).toEqual([]);
  });
});
