import { describe, expect, it, vi } from "vitest";

import {
  collectWorkerBundleFromSandbox,
  findUnexportedDurableObjectClasses,
  PROJECT_BUILD_ASSET_READ_CONCURRENCY,
  PROJECT_BUILD_ASSET_READ_MAX_IN_FLIGHT_BYTES,
  PROJECT_BUILD_ASSET_MAX_BYTES,
  PROJECT_BUILD_ASSET_MAX_TOTAL_BYTES,
  PROJECT_BUILD_MODULE_READ_CONCURRENCY,
  PROJECT_BUILD_MODULE_READ_MAX_IN_FLIGHT_BYTES,
  PROJECT_BUILD_MODULE_MAX_TOTAL_BYTES,
  readSandboxFileBytes,
  type ProjectBuildSandboxLike,
} from "../src/project-worker-bundle";
import type { ProjectWorkerBundle } from "../src/project-worker-bundle";

function fakeBundleSandbox(
  files: Map<string, string>,
): ProjectBuildSandboxLike {
  return {
    exec: vi.fn(async (_command, options) => {
      const root = options?.env?.CAMELAI_BOUNDED_LIST_ROOT;
      if (!root) return { success: true, exitCode: 0 };
      return {
        success: true,
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          files: Array.from(files.keys())
            .filter((absolutePath) => absolutePath.startsWith(`${root}/`))
            .map((absolutePath) => ({
              name: absolutePath.split("/").pop() || "",
              type: "file" as const,
              relativePath: absolutePath.slice(root.length + 1),
              size: Buffer.byteLength(files.get(absolutePath) ?? ""),
            })),
        }),
      };
    }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content == null) throw new Error(`missing ${path}`);
      return { content: Buffer.from(content).toString("base64") };
    }),
    readFileStream: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content == null) throw new Error(`missing ${path}`);
      const bytes = new TextEncoder().encode(content);
      const midpoint = Math.ceil(bytes.byteLength / 2);
      const events = [
        {
          type: "metadata",
          mimeType: "application/octet-stream",
          size: bytes.byteLength,
          isBinary: true,
          encoding: "base64",
        },
        {
          type: "chunk",
          data: Buffer.from(bytes.slice(0, midpoint)).toString("base64"),
        },
        {
          type: "chunk",
          data: Buffer.from(bytes.slice(midpoint)).toString("base64"),
        },
        { type: "complete" },
      ]
        .map((event) => `data: ${JSON.stringify(event)}\n\n`)
        .join("");
      const encoded = new TextEncoder().encode(events);
      const wireMidpoint = Math.ceil(encoded.byteLength / 2);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, wireMidpoint));
          controller.enqueue(encoded.slice(wireMidpoint));
          controller.close();
        },
      });
    }),
    listFiles: vi.fn(async (root: string) => ({
      files: Array.from(files.keys())
        .filter((absolutePath) => absolutePath.startsWith(`${root}/`))
        .map((absolutePath) => ({
          name: absolutePath.split("/").pop() || "",
          type: "file" as const,
          absolutePath,
          relativePath: absolutePath.slice(root.length + 1),
          size: Buffer.byteLength(files.get(absolutePath) ?? ""),
        })),
    })),
  };
}

function readFilePaths(sandbox: ProjectBuildSandboxLike): string[] {
  return (
    sandbox.readFile as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.map((call) => call[0] as string);
}

function readFileStreamPaths(sandbox: ProjectBuildSandboxLike): string[] {
  return (
    sandbox.readFileStream as unknown as { mock: { calls: unknown[][] } }
  ).mock.calls.map((call) => call[0] as string);
}

describe("collectWorkerBundleFromSandbox", () => {
  it("reads the build manifest and module files from build/server", async () => {
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "index.js",
          no_bundle: true,
          compatibility_date: "2026-06-01",
          bindings: [{ type: "plain_text", name: "GREETING", text: "hi" }],
          assets: { directory: "../client" },
        }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
      ["/workspace/demo/build/server/chunk.js", "export const chunk = 1;"],
      ["/workspace/demo/build/server/index.js.map", "ignored"],
      ["/workspace/demo/build/client/index.html", "<html></html>"],
      ["/workspace/demo/build/client/assets/app.css", "body{}"],
    ]);

    const sandbox = fakeBundleSandbox(files);
    const bundle = await collectWorkerBundleFromSandbox(
      sandbox,
      "/workspace/demo",
    );

    expect(bundle.metadata).toMatchObject({ main_module: "index.js" });
    expect(bundle.modules.map((module) => module.name)).toEqual([
      "chunk.js",
      "index.js",
    ]);
    expect(bundle.modules.map((module) => module.contentType)).toEqual([
      "application/javascript+module",
      "application/javascript+module",
    ]);
    expect(
      bundle.assets.map((asset) => ({
        path: asset.path,
        contentType: asset.contentType,
        size: asset.size,
      })),
    ).toEqual([
      {
        path: "assets/app.css",
        contentType: "text/css; charset=utf-8",
        size: 6,
      },
      { path: "index.html", contentType: "text/html; charset=utf-8", size: 13 },
    ]);

    // Collection owns every sandbox read. Asset bytes are admitted under the
    // strict aggregate and retained independently so no lazy sandbox capability
    // can outlive this attempt.
    const streamReadsAfterCollect = readFileStreamPaths(sandbox);
    expect(streamReadsAfterCollect).toContain(
      "/workspace/demo/build/server/index.js",
    );
    expect(streamReadsAfterCollect).toContain(
      "/workspace/demo/build/client/index.html",
    );
    expect(streamReadsAfterCollect).toContain(
      "/workspace/demo/build/client/assets/app.css",
    );
    expect(readFilePaths(sandbox)).toEqual([]);

    // The stable handle no longer touches the sandbox.
    const cssAsset = bundle.assets.find(
      (asset) => asset.path === "assets/app.css",
    )!;
    expect(new TextDecoder().decode(await cssAsset.read())).toBe("body{}");
    expect(readFileStreamPaths(sandbox)).toEqual(streamReadsAfterCollect);
    expect(readFilePaths(sandbox)).not.toContain(
      "/workspace/demo/build/client/assets/app.css",
    );
    expect(sandbox.listFiles).not.toHaveBeenCalled();
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining("opendirSync"),
      expect.objectContaining({
        env: {
          CAMELAI_BOUNDED_LIST_ROOT: "/workspace/demo/build/server",
        },
        timeout: 30_000,
      }),
    );
  });

  it("overlaps small asset reads up to the lane cap without exceeding the byte budget", async () => {
    const assetFiles = Array.from(
      { length: 12 },
      (_, index) =>
        [`/workspace/demo/build/client/file-${index}.txt`, "x"] as const,
    );
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({ main: "index.js", assets: "../client" }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
      ...assetFiles,
    ]);
    const sandbox = fakeBundleSandbox(files);
    const originalReadFileStream = sandbox.readFileStream.bind(sandbox);
    let readsInFlight = 0;
    let bytesInFlight = 0;
    let maximumReadsInFlight = 0;
    let maximumBytesInFlight = 0;
    sandbox.readFileStream = vi.fn(async (path: string) => {
      if (!path.startsWith("/workspace/demo/build/client/")) {
        return originalReadFileStream(path);
      }
      const size = Buffer.byteLength(files.get(path) ?? "");
      readsInFlight += 1;
      bytesInFlight += size;
      maximumReadsInFlight = Math.max(maximumReadsInFlight, readsInFlight);
      maximumBytesInFlight = Math.max(maximumBytesInFlight, bytesInFlight);
      await Promise.resolve();
      const stream = await originalReadFileStream(path);
      readsInFlight -= 1;
      bytesInFlight -= size;
      return stream;
    });

    const bundle = await collectWorkerBundleFromSandbox(
      sandbox,
      "/workspace/demo",
    );

    expect(bundle.assets).toHaveLength(assetFiles.length);
    expect(maximumReadsInFlight).toBe(PROJECT_BUILD_ASSET_READ_CONCURRENCY);
    expect(maximumBytesInFlight).toBeLessThanOrEqual(
      PROJECT_BUILD_ASSET_READ_MAX_IN_FLIGHT_BYTES,
    );
  });

  it("stops asset-read admission after failure and drains started streams", async () => {
    const assetFiles = Array.from(
      { length: 10 },
      (_, index) =>
        [`/workspace/demo/build/client/file-${index}.txt`, "x"] as const,
    );
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({ main: "index.js", assets: "../client" }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
      ...assetFiles,
    ]);
    const sandbox = fakeBundleSandbox(files);
    const originalReadFileStream = sandbox.readFileStream.bind(sandbox);
    let startedAssetReads = 0;
    let resolveAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    sandbox.readFileStream = vi.fn(async (path: string) => {
      if (!path.startsWith("/workspace/demo/build/client/")) {
        return originalReadFileStream(path);
      }
      startedAssetReads += 1;
      if (startedAssetReads === PROJECT_BUILD_ASSET_READ_CONCURRENCY) {
        resolveAllStarted();
      }
      if (startedAssetReads === 1) {
        await allStarted;
        throw new Error("asset stream failed");
      }
      await drain;
      return originalReadFileStream(path);
    });

    const collection = collectWorkerBundleFromSandbox(
      sandbox,
      "/workspace/demo",
    );
    await allStarted;
    let settled = false;
    void collection.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(startedAssetReads).toBe(PROJECT_BUILD_ASSET_READ_CONCURRENCY);

    releaseDrain();
    await expect(collection).rejects.toThrow("asset stream failed");
    expect(startedAssetReads).toBe(PROJECT_BUILD_ASSET_READ_CONCURRENCY);
  });

  it("rejects aggregate module metadata before opening any module stream", async () => {
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "index.js",
          rules: [{ type: "ESModule", globs: ["**/*.js"] }],
        }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
      ["/workspace/demo/build/server/chunk.js", "export const x = 1;"],
    ]);
    const sandbox = fakeBundleSandbox(files);
    const originalExec = sandbox.exec.bind(sandbox);
    sandbox.exec = vi.fn(async (command, options) => {
      const result = await originalExec(command, options);
      const parsed = JSON.parse(result.stdout ?? "{}") as {
        files?: Array<{ type: string; size: number }>;
      };
      if (parsed.files) {
        for (const file of parsed.files) {
          if (file.type === "file") {
            file.size =
              Math.floor(PROJECT_BUILD_MODULE_MAX_TOTAL_BYTES / 2) + 1;
          }
        }
      }
      return { ...result, stdout: JSON.stringify(parsed) };
    });

    await expect(
      collectWorkerBundleFromSandbox(sandbox, "/workspace/demo"),
    ).rejects.toThrow(
      `${PROJECT_BUILD_MODULE_MAX_TOTAL_BYTES} aggregate byte limit`,
    );
    expect(readFileStreamPaths(sandbox)).toEqual([
      "/workspace/demo/build/server/wrangler.json",
    ]);
  });

  it("rejects aggregate asset metadata without opening any asset stream", async () => {
    const assets = Array.from(
      { length: 9 },
      (_, index) =>
        [`/workspace/demo/build/client/asset-${index}.bin`, "x"] as const,
    );
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({ main: "index.js", assets: "../client" }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
      ...assets,
    ]);
    const sandbox = fakeBundleSandbox(files);
    const originalExec = sandbox.exec.bind(sandbox);
    sandbox.exec = vi.fn(async (command, options) => {
      const result = await originalExec(command, options);
      const parsed = JSON.parse(result.stdout ?? "{}") as {
        files?: Array<{ type: string; size: number }>;
      };
      if (
        options?.env?.CAMELAI_BOUNDED_LIST_ROOT ===
          "/workspace/demo/build/client" &&
        parsed.files
      ) {
        for (const file of parsed.files) {
          if (file.type === "file") file.size = PROJECT_BUILD_ASSET_MAX_BYTES;
        }
      }
      return { ...result, stdout: JSON.stringify(parsed) };
    });

    await expect(
      collectWorkerBundleFromSandbox(sandbox, "/workspace/demo"),
    ).rejects.toThrow(
      `${PROJECT_BUILD_ASSET_MAX_TOTAL_BYTES} aggregate byte limit`,
    );
    for (const [path] of assets) {
      expect(readFileStreamPaths(sandbox)).not.toContain(path);
    }
  });

  it("rejects excessive module globs before listing build output", async () => {
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "index.js",
          rules: [
            {
              type: "ESModule",
              globs: Array.from(
                { length: 129 },
                (_, index) => `file-${index}.js`,
              ),
            },
          ],
        }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);
    const sandbox = fakeBundleSandbox(files);

    await expect(
      collectWorkerBundleFromSandbox(sandbox, "/workspace/demo"),
    ).rejects.toThrow("128 module glob limit");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("fails a zero-byte wire-chunk flood without waiting for hung cancellation", async () => {
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const sandbox = {
      readFileStream: vi.fn(
        async () =>
          new ReadableStream<Uint8Array>({
            pull(controller) {
              controller.enqueue(new Uint8Array());
            },
            cancel,
          }),
      ),
    } as unknown as ProjectBuildSandboxLike;

    const result = await Promise.race([
      readSandboxFileBytes(sandbox, "/flood", 8).then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("timed-out"), 1_500),
      ),
    ]);
    expect(result).toBe("rejected");
    expect(cancel).toHaveBeenCalled();
  });

  it("resets the owning sandbox when manifest stream acquisition hangs", async () => {
    const files = new Map<string, string>();
    const sandbox = fakeBundleSandbox(files);
    sandbox.readFileStream = vi.fn(() => new Promise(() => {}));
    const reset = vi.fn(async () => undefined);

    await expect(
      collectWorkerBundleFromSandbox(
        sandbox,
        "/workspace/demo",
        "build/server/wrangler.json",
        { timeoutMs: 10, onTimeout: reset },
      ),
    ).rejects.toThrow("owning sandbox was reset");
    expect(reset).toHaveBeenCalledOnce();
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("resets the owning sandbox when the manifest stream stops producing events", async () => {
    const files = new Map<string, string>();
    const sandbox = fakeBundleSandbox(files);
    sandbox.readFileStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          pull: () => new Promise(() => {}),
        }),
    );
    const reset = vi.fn(async () => undefined);

    await expect(
      collectWorkerBundleFromSandbox(
        sandbox,
        "/workspace/demo",
        "build/server/wrangler.json",
        { timeoutMs: 10, onTimeout: reset },
      ),
    ).rejects.toThrow("owning sandbox was reset");
    expect(reset).toHaveBeenCalledOnce();
  });

  it("fails explicitly when destructive timeout cleanup cannot be confirmed", async () => {
    const files = new Map<string, string>();
    const sandbox = fakeBundleSandbox(files);
    sandbox.readFileStream = vi.fn(() => new Promise(() => {}));

    await expect(
      collectWorkerBundleFromSandbox(
        sandbox,
        "/workspace/demo",
        "build/server/wrangler.json",
        {
          timeoutMs: 5,
          resetTimeoutMs: 5,
          onTimeout: () => new Promise(() => {}),
        },
      ),
    ).rejects.toThrow("sandbox reset could not be confirmed");
  });

  it("wraps a rejected destructive reset as terminal unconfirmed ownership", async () => {
    const sandbox = fakeBundleSandbox(new Map());
    sandbox.readFileStream = vi.fn(() => new Promise(() => {}));

    await expect(
      collectWorkerBundleFromSandbox(
        sandbox,
        "/workspace/demo",
        "build/server/wrangler.json",
        {
          timeoutMs: 5,
          onTimeout: async () => {
            throw new Error("RPCTransportError: Network connection lost");
          },
        },
      ),
    ).rejects.toThrow("sandbox reset could not be confirmed");
  });

  it("confirms reset before surfacing a stream whose cancellation rejects", async () => {
    const reset = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed");
    });
    const sandbox = fakeBundleSandbox(new Map());
    sandbox.readFileStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            controller.enqueue(new Uint8Array());
          },
          cancel,
        }),
    );

    await expect(
      collectWorkerBundleFromSandbox(
        sandbox,
        "/workspace/demo",
        "build/server/wrangler.json",
        { timeoutMs: 1_000, onTimeout: reset },
      ),
    ).rejects.toThrow("finite transport limits");
    expect(cancel).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
  });

  it("confirms reset when cleanup after a complete SSE event rejects", async () => {
    const manifest = JSON.stringify({ main: "index.js" });
    const events = [
      {
        type: "metadata",
        mimeType: "application/json",
        size: manifest.length,
        isBinary: false,
        encoding: "utf8",
      },
      { type: "chunk", data: manifest },
      { type: "complete" },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const cancel = vi.fn(async () => {
      throw new Error("cancel failed after complete");
    });
    const reset = vi.fn(async () => undefined);
    const sandbox = fakeBundleSandbox(new Map());
    sandbox.readFileStream = vi.fn(
      async () =>
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(events));
            // Deliberately remain open: the SDK must cancel after `complete`.
          },
          cancel,
        }),
    );

    await expect(
      collectWorkerBundleFromSandbox(
        sandbox,
        "/workspace/demo",
        "build/server/wrangler.json",
        { timeoutMs: 1_000, onTimeout: reset },
      ),
    ).rejects.toThrow("owning sandbox was reset");
    expect(cancel).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("does not reset or dispatch when the deadline expires between operations", async () => {
    let clockReads = 0;
    const reset = vi.fn(async () => undefined);
    const sandbox = fakeBundleSandbox(
      new Map([
        [
          "/workspace/demo/build/server/wrangler.json",
          JSON.stringify({ main: "index.js" }),
        ],
        ["/workspace/demo/build/server/index.js", "export default {}"],
      ]),
    );

    await expect(
      collectWorkerBundleFromSandbox(
        sandbox,
        "/workspace/demo",
        "build/server/wrangler.json",
        {
          timeoutMs: 10,
          onTimeout: reset,
          // create, acquire, two chunks, complete, then the listing preflight.
          now: () => (++clockReads >= 6 ? 20 : 0),
        },
      ),
    ).rejects.toThrow("before the next sandbox operation started");
    expect(sandbox.readFileStream).toHaveBeenCalledOnce();
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(reset).not.toHaveBeenCalled();
  });

  it("reads modules at width four within the aggregate byte cap", async () => {
    const moduleFiles = Array.from(
      { length: 6 },
      (_, index) =>
        [
          `/workspace/demo/build/server/module-${index}.js`,
          `export const value${index} = ${index}`,
        ] as const,
    );
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "module-0.js",
          rules: [{ type: "ESModule", globs: ["**/*.js"] }],
        }),
      ],
      ...moduleFiles,
    ]);
    const sandbox = fakeBundleSandbox(files);
    const originalRead = sandbox.readFileStream!.bind(sandbox);
    let readsInFlight = 0;
    let bytesInFlight = 0;
    let maximumReadsInFlight = 0;
    let maximumBytesInFlight = 0;
    sandbox.readFileStream = vi.fn(async (path: string) => {
      if (!path.endsWith(".js")) return originalRead(path);
      const size = Buffer.byteLength(files.get(path) ?? "");
      readsInFlight += 1;
      bytesInFlight += size;
      maximumReadsInFlight = Math.max(maximumReadsInFlight, readsInFlight);
      maximumBytesInFlight = Math.max(maximumBytesInFlight, bytesInFlight);
      await Promise.resolve();
      const stream = await originalRead(path);
      readsInFlight -= 1;
      bytesInFlight -= size;
      return stream;
    });

    const bundle = await collectWorkerBundleFromSandbox(
      sandbox,
      "/workspace/demo",
    );

    expect(bundle.modules).toHaveLength(moduleFiles.length);
    expect(maximumReadsInFlight).toBe(PROJECT_BUILD_MODULE_READ_CONCURRENCY);
    expect(maximumBytesInFlight).toBeLessThanOrEqual(
      PROJECT_BUILD_MODULE_READ_MAX_IN_FLIGHT_BYTES,
    );
  });

  it("stops module admission after failure and drains every started stream", async () => {
    const moduleFiles = Array.from(
      { length: 6 },
      (_, index) =>
        [
          `/workspace/demo/build/server/module-${index}.js`,
          `export const value${index} = ${index}`,
        ] as const,
    );
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "module-0.js",
          rules: [{ type: "ESModule", globs: ["**/*.js"] }],
        }),
      ],
      ...moduleFiles,
    ]);
    const sandbox = fakeBundleSandbox(files);
    const originalRead = sandbox.readFileStream!.bind(sandbox);
    let startedModuleReads = 0;
    let resolveAllStarted!: () => void;
    const allStarted = new Promise<void>((resolve) => {
      resolveAllStarted = resolve;
    });
    let releaseDrain!: () => void;
    const drain = new Promise<void>((resolve) => {
      releaseDrain = resolve;
    });
    sandbox.readFileStream = vi.fn(async (path: string) => {
      if (!path.endsWith(".js")) return originalRead(path);
      startedModuleReads += 1;
      if (startedModuleReads === PROJECT_BUILD_MODULE_READ_CONCURRENCY) {
        resolveAllStarted();
      }
      if (startedModuleReads === 1) {
        await allStarted;
        throw new Error("module read failed");
      }
      await drain;
      return originalRead(path);
    });

    const collection = collectWorkerBundleFromSandbox(
      sandbox,
      "/workspace/demo",
    );
    await allStarted;
    let settled = false;
    void collection.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(startedModuleReads).toBe(PROJECT_BUILD_MODULE_READ_CONCURRENCY);

    releaseDrain();
    await expect(collection).rejects.toThrow("module read failed");
    expect(startedModuleReads).toBe(PROJECT_BUILD_MODULE_READ_CONCURRENCY);
  });

  it("converts wrangler durable object config into upload bindings", async () => {
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "index.js",
          no_bundle: true,
          durable_objects: {
            bindings: [{ name: "TASK_STORE", class_name: "TaskStore" }],
          },
          migrations: [{ tag: "v1", new_sqlite_classes: ["TaskStore"] }],
        }),
      ],
      [
        "/workspace/demo/build/server/index.js",
        "export class TaskStore {}; export default {};",
      ],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(
      fakeBundleSandbox(files),
      "/workspace/demo",
    );

    expect(bundle.metadata).toMatchObject({
      main_module: "index.js",
      migrations: [{ tag: "v1", new_sqlite_classes: ["TaskStore"] }],
      bindings: [
        {
          type: "durable_object_namespace",
          name: "TASK_STORE",
          class_name: "TaskStore",
        },
      ],
    });
    expect(bundle.metadata.durable_objects).toBeUndefined();
  });

  it("lifts wrangler kv_namespaces and r2_buckets into upload bindings", async () => {
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "index.js",
          no_bundle: true,
          kv_namespaces: [
            { binding: "SESSIONS", id: "kv-abc123" },
            { binding: "CACHE" },
          ],
          r2_buckets: [{ binding: "UPLOADS", bucket_name: "my-uploads" }],
        }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(
      fakeBundleSandbox(files),
      "/workspace/demo",
    );

    expect(bundle.metadata.bindings).toEqual([
      { type: "kv_namespace", name: "SESSIONS", namespace_id: "kv-abc123" },
      { type: "kv_namespace", name: "CACHE" },
      { type: "r2_bucket", name: "UPLOADS", bucket_name: "my-uploads" },
    ]);
    // The idiomatic top-level arrays are consumed, not passed through raw
    // (the deploy metadata only reads `bindings`).
    expect(bundle.metadata.kv_namespaces).toBeUndefined();
    expect(bundle.metadata.r2_buckets).toBeUndefined();
  });

  it("lifts a wrangler AI binding into upload bindings", async () => {
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "index.js",
          no_bundle: true,
          ai: { binding: "AI" },
        }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(
      fakeBundleSandbox(files),
      "/workspace/demo",
    );

    expect(bundle.metadata.bindings).toEqual([{ type: "ai", name: "AI" }]);
    expect(bundle.metadata.ai).toBeUndefined();
  });

  it("lifts wrangler service bindings into upload bindings", async () => {
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "index.js",
          no_bundle: true,
          services: [
            {
              binding: "CAMELAI",
              service: "demo",
              entrypoint: "LocalCamelAiService",
              props: { local: true },
            },
          ],
        }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(
      fakeBundleSandbox(files),
      "/workspace/demo",
    );

    expect(bundle.metadata.bindings).toEqual([
      {
        type: "service",
        name: "CAMELAI",
        service: "demo",
        entrypoint: "LocalCamelAiService",
        props: { local: true },
      },
    ]);
    expect(bundle.metadata.services).toBeUndefined();
  });

  it("does not duplicate a binding already present in manifest.bindings", async () => {
    const files = new Map<string, string>([
      [
        "/workspace/demo/build/server/wrangler.json",
        JSON.stringify({
          main: "index.js",
          no_bundle: true,
          bindings: [
            {
              type: "kv_namespace",
              name: "SESSIONS",
              namespace_id: "explicit",
            },
          ],
          kv_namespaces: [{ binding: "SESSIONS", id: "duplicate" }],
        }),
      ],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(
      fakeBundleSandbox(files),
      "/workspace/demo",
    );

    expect(bundle.metadata.bindings).toEqual([
      { type: "kv_namespace", name: "SESSIONS", namespace_id: "explicit" },
    ]);
  });
});

describe("findUnexportedDurableObjectClasses", () => {
  const bundleWith = (
    mainSource: string,
    classNames: string[],
  ): ProjectWorkerBundle => ({
    metadata: {
      main_module: "worker.js",
      bindings: classNames.map((class_name) => ({
        type: "durable_object_namespace",
        name: class_name.toUpperCase(),
        class_name,
      })),
    },
    modules: [
      {
        name: "worker.js",
        contentType: "application/javascript+module",
        content: mainSource,
      },
    ],
    assets: [],
    manifestPath: "build/server/wrangler.json",
  });

  it("returns nothing when there are no DO bindings", () => {
    expect(
      findUnexportedDurableObjectClasses(bundleWith("export default {};", [])),
    ).toEqual([]);
  });

  it("accepts a directly-exported class", () => {
    const src = "export class LeaderboardDO { fetch() {} }\nexport default {};";
    expect(
      findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"])),
    ).toEqual([]);
  });

  it("accepts an aliased re-export in a consolidated export clause (esbuild shape)", () => {
    const src = [
      "class LeaderboardDO2 { fetch() {} }",
      "var worker_default = { fetch() {} };",
      "export {",
      "  LeaderboardDO2 as LeaderboardDO,",
      "  worker_default as default",
      "};",
    ].join("\n");
    expect(
      findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"])),
    ).toEqual([]);
  });

  it("flags a declared class that is never exported", () => {
    const src = "class LeaderboardDO {}\nexport default {};";
    expect(
      findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"])),
    ).toEqual(["LeaderboardDO"]);
  });

  it("flags a misspelled/missing class among several", () => {
    const src =
      "export class ScoreDO {}\nexport { X as ChatDO };\nexport default {};";
    expect(
      findUnexportedDurableObjectClasses(
        bundleWith(src, ["ScoreDO", "ChatDO", "PresenceDO"]),
      ),
    ).toEqual(["PresenceDO"]);
  });

  it("does not block when the entry module is absent", () => {
    const bundle = bundleWith("", ["LeaderboardDO"]);
    bundle.modules = [];
    expect(findUnexportedDurableObjectClasses(bundle)).toEqual([]);
  });

  it("skips the check when the entry has a star re-export it can't resolve", () => {
    expect(
      findUnexportedDurableObjectClasses(
        bundleWith('export * from "./do.js";\nexport default {};', [
          "LeaderboardDO",
        ]),
      ),
    ).toEqual([]);
    expect(
      findUnexportedDurableObjectClasses(
        bundleWith('export * as ns from "./do.js";\nexport default {};', [
          "LeaderboardDO",
        ]),
      ),
    ).toEqual([]);
  });
});

it("accepts a vite-plugin manifest that uses `main` instead of `main_module`", async () => {
  const files = new Map<string, string>([
    [
      "/workspace/demo/build/server/wrangler.json",
      JSON.stringify({
        name: "demo",
        main: "index.js",
        no_bundle: true,
        rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
        compatibility_date: "2026-06-01",
        assets: { directory: "../client", binding: "ASSETS" },
      }),
    ],
    ["/workspace/demo/build/server/index.js", "export default {};"],
    ["/workspace/demo/build/client/index.html", "<html></html>"],
  ]);
  const bundle = await collectWorkerBundleFromSandbox(
    fakeBundleSandbox(files),
    "/workspace/demo",
  );
  expect(bundle.metadata).toMatchObject({ main_module: "index.js" });
  expect(bundle.metadata).not.toHaveProperty("main");
  expect(bundle.metadata).not.toHaveProperty("no_bundle");
  expect(bundle.metadata).not.toHaveProperty("rules");
  expect(bundle.modules.map((module) => module.name)).toContain("index.js");
});

it("allowlists deploy metadata: lifts vars to bindings, drops unknown config keys", async () => {
  const files = new Map<string, string>([
    [
      "/workspace/demo/build/server/wrangler.json",
      JSON.stringify({
        name: "demo",
        main: "index.js",
        compatibility_date: "2026-06-01",
        vars: { GREETING: "hi", COUNT: 3 },
        tail_consumers: [{ service: "user-logs" }],
        // config-only keys the upload API does not accept:
        dev: { port: 8787 },
        site: { bucket: "./public" },
        workers_dev: true,
        migrations: [],
        assets: { directory: "../client" },
      }),
    ],
    ["/workspace/demo/build/server/index.js", "export default {};"],
    ["/workspace/demo/build/client/index.html", "<html></html>"],
  ]);
  const bundle = await collectWorkerBundleFromSandbox(
    fakeBundleSandbox(files),
    "/workspace/demo",
  );
  expect(bundle.metadata.main_module).toBe("index.js");
  expect(bundle.metadata.bindings).toEqual(
    expect.arrayContaining([
      { type: "plain_text", name: "GREETING", text: "hi" },
      { type: "json", name: "COUNT", json: 3 },
    ]),
  );
  expect(bundle.metadata.tail_consumers).toEqual([{ service: "user-logs" }]);
  for (const key of [
    "vars",
    "dev",
    "site",
    "workers_dev",
    "name",
    "main",
    "no_bundle",
  ]) {
    expect(bundle.metadata).not.toHaveProperty(key);
  }
  // migrations passes through here; the deploy path normalizes/omits it later
  expect(bundle.metadata).toHaveProperty("migrations");
});

it("skips non-module server build files (fonts, images) instead of uploading them as modules", async () => {
  const files = new Map<string, string>([
    [
      "/workspace/demo/build/server/wrangler.json",
      JSON.stringify({
        main: "index.js",
        compatibility_date: "2026-06-01",
        assets: { directory: "../client" },
      }),
    ],
    ["/workspace/demo/build/server/index.js", "export default {};"],
    [
      "/workspace/demo/build/server/assets/figtree-latin-400.woff2",
      "fontbytes",
    ],
    ["/workspace/demo/build/server/assets/hero.png", "pngbytes"],
    ["/workspace/demo/build/client/index.html", "<html></html>"],
  ]);
  const bundle = await collectWorkerBundleFromSandbox(
    fakeBundleSandbox(files),
    "/workspace/demo",
  );
  expect(bundle.modules.map((module) => module.name)).toEqual(["index.js"]);
});

it("rejects legacy main_module manifests with a remediation error", async () => {
  const files = new Map<string, string>([
    [
      "/workspace/demo/build/server/wrangler.json",
      JSON.stringify({
        main_module: "worker.js",
        compatibility_date: "2026-06-01",
        assets: { directory: "../client" },
      }),
    ],
    ["/workspace/demo/build/server/worker.js", "export default {};"],
  ]);
  await expect(
    collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo"),
  ).rejects.toThrow(/legacy main_module.*build-manifest\.mjs/s);
});

it("honors declared module rules including Text and Data types", async () => {
  const imageBytes = "x".repeat(2 * 1024 * 1024);
  const files = new Map<string, string>([
    [
      "/workspace/demo/build/server/wrangler.json",
      JSON.stringify({
        main: "index.js",
        no_bundle: true,
        rules: [
          { type: "ESModule", globs: ["**/*.js"] },
          { type: "Text", globs: ["**/*.txt"] },
          { type: "Data", globs: ["**/*.png"] },
        ],
        compatibility_date: "2026-06-01",
        assets: { directory: "../client" },
      }),
    ],
    ["/workspace/demo/build/server/index.js", "export default {};"],
    ["/workspace/demo/build/server/prompts/system.txt", "be helpful"],
    ["/workspace/demo/build/server/assets/hero.png", imageBytes],
    ["/workspace/demo/build/server/assets/font.woff2", "fontbytes"],
    ["/workspace/demo/build/client/index.html", "<html></html>"],
  ]);
  const sandbox = fakeBundleSandbox(files);
  const bundle = await collectWorkerBundleFromSandbox(
    sandbox,
    "/workspace/demo",
  );
  expect(
    bundle.modules.map((m) => ({ name: m.name, contentType: m.contentType })),
  ).toEqual([
    { name: "assets/hero.png", contentType: "application/octet-stream" },
    { name: "index.js", contentType: "application/javascript+module" },
    { name: "prompts/system.txt", contentType: "text/plain" },
  ]);
  expect(
    (
      bundle.modules.find((module) => module.name === "assets/hero.png")!
        .content as Uint8Array
    ).byteLength,
  ).toBe(2 * 1024 * 1024);
  expect(readFileStreamPaths(sandbox)).toContain(
    "/workspace/demo/build/server/assets/hero.png",
  );
  expect(readFilePaths(sandbox)).not.toContain(
    "/workspace/demo/build/server/assets/hero.png",
  );
});

it("surfaces the wrangler config name for deploy script-name continuity", async () => {
  const files = new Map<string, string>([
    [
      "/workspace/demo/build/server/wrangler.json",
      JSON.stringify({
        name: "frogger-game",
        main: "index.js",
        no_bundle: true,
        compatibility_date: "2026-06-01",
      }),
    ],
    ["/workspace/demo/build/server/index.js", "export default {};"],
  ]);
  const bundle = await collectWorkerBundleFromSandbox(
    fakeBundleSandbox(files),
    "/workspace/demo",
  );
  expect(bundle.configName).toBe("frogger-game");
  // name still never leaks into the upload metadata
  expect(bundle.metadata).not.toHaveProperty("name");
});
