import { describe, expect, it, vi } from "vitest";

import {
  collectProjectSourceFiles,
  materializeProjectSourceFiles,
  shellQuote,
  validateDoSqliteApiUsage,
  validatePackageJson,
  validatePackageJsonBuildScript,
  type ProjectSourceCollection,
  type ProjectSourceFile,
} from "../src/project-build-source";
import {
  PROJECT_BUILD_MANIFEST_MAX_BYTES,
  PROJECT_BUILD_MODULE_MAX_FILE_BYTES,
  PROJECT_BUILD_OUTPUT_MAX_ENTRIES,
  PROJECT_BUILD_OUTPUT_MAX_PATH_BYTES,
  PROJECT_BUILD_SOURCE_LIST_MAX_PATH_BYTES,
  PROJECT_BUILD_SOURCE_MAX_TOTAL_BYTES,
  type ProjectBuildSandboxLike,
} from "../src/project-worker-bundle";
import type {
  WorkspaceFileStoreLike,
  WorkspaceListEntry,
} from "../src/workspace-filesystem-do";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function sourceFile(
  path: string,
  content: string,
  sha256 = SHA_A,
): ProjectSourceFile {
  return { path, bytes: new TextEncoder().encode(content), sha256 };
}

function fakeFiles(
  contents: Record<string, { content: string; encoding?: "utf8" | "base64" }>,
): WorkspaceFileStoreLike {
  const entries: WorkspaceListEntry[] = Object.keys(contents).map((path) => ({
    name: path.split("/").at(-1) ?? path,
    type: "file",
    size:
      contents[path]!.encoding === "base64"
        ? Buffer.from(contents[path]!.content, "base64").byteLength
        : new TextEncoder().encode(contents[path]!.content).byteLength,
    modifiedAt: new Date(0).toISOString(),
    relativePath: path.replace(/^\/+/, ""),
    absolutePath: path.startsWith("/") ? path : `/${path}`,
  }));
  return {
    exists: vi.fn(async () => ({ exists: true })),
    readFile: vi.fn(async (path: string) => {
      const value = contents[path] ?? contents[path.replace(/^\/+/, "")];
      return value
        ? {
            success: true,
            content: value.content,
            encoding: value.encoding ?? "utf8",
          }
        : { success: false, error: "missing" };
    }),
    readFileStream: vi.fn(async () => ({ success: false })),
    writeFile: vi.fn(async () => ({ success: true })),
    writeBinaryFile: vi.fn(async () => ({ success: true })),
    listFiles: vi.fn(async () => ({
      success: true,
      files: entries,
      count: entries.length,
      path: "/",
    })),
    mkdir: vi.fn(async () => ({ success: true })),
    deleteFile: vi.fn(async () => ({ success: true })),
  };
}

describe("project build source owner", () => {
  it("keeps streamed source reads below the Worker connection ceiling", async () => {
    const contents = Object.fromEntries([
      ["/package.json", JSON.stringify({ scripts: { build: "vite build" } })],
      ...Array.from({ length: 24 }, (_, index) => [
        `/src/file-${index}.ts`,
        `export const value${index} = ${index};`,
      ]),
    ]);
    const files = fakeFiles(
      Object.fromEntries(
        Object.entries(contents).map(([path, content]) => [path, { content }]),
      ),
    );
    let activeReads = 0;
    let maxActiveReads = 0;
    files.readFileStream = vi.fn(async (path: string) => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      if (activeReads > 4) {
        activeReads -= 1;
        throw new Error("Network connection lost.");
      }
      const bytes = new TextEncoder().encode(contents[path]!);
      return {
        success: true,
        stream: new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            controller.enqueue(bytes);
            controller.close();
            activeReads -= 1;
          },
        }),
      };
    });

    const collected = await collectProjectSourceFiles(files);

    expect(collected.entries).toHaveLength(25);
    expect(maxActiveReads).toBe(4);
    expect(activeReads).toBe(0);
  });

  it("drains started source streams before surfacing a read failure", async () => {
    const contents = Object.fromEntries(
      Array.from({ length: 12 }, (_, index) => [
        `/src/file-${index}.ts`,
        `export const value${index} = ${index};`,
      ]),
    );
    const files = fakeFiles(
      Object.fromEntries(
        Object.entries(contents).map(([path, content]) => [path, { content }]),
      ),
    );
    let activeReads = 0;
    let startedReads = 0;
    files.readFileStream = vi.fn(async (path: string) => {
      activeReads += 1;
      startedReads += 1;
      const bytes = new TextEncoder().encode(contents[path]!);
      const shouldFail = path === "/src/file-1.ts";
      return {
        success: true,
        stream: new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((resolve) =>
              setTimeout(resolve, shouldFail ? 1 : 5),
            );
            activeReads -= 1;
            if (shouldFail)
              controller.error(new Error("Network connection lost."));
            else {
              controller.enqueue(bytes);
              controller.close();
            }
          },
          cancel() {
            activeReads = Math.max(0, activeReads - 1);
          },
        }),
      };
    });

    await expect(collectProjectSourceFiles(files)).rejects.toThrow(
      "Network connection lost",
    );

    expect(activeReads).toBe(0);
    expect(startedReads).toBeLessThanOrEqual(4);
  });

  it("rejects oversized source metadata before opening any file stream", async () => {
    const files = fakeFiles({ "/large.bin": { content: "x" } });
    files.listFiles = vi.fn(async () => ({
      success: true,
      files: [
        {
          name: "large.bin",
          type: "file" as const,
          size: PROJECT_BUILD_MODULE_MAX_FILE_BYTES + 1,
          modifiedAt: new Date(0).toISOString(),
          relativePath: "large.bin",
          absolutePath: "/large.bin",
        },
      ],
      count: 1,
      path: "/",
    }));
    const readFileStream = vi.fn();
    const readFile = vi.fn();
    files.readFileStream = readFileStream;
    files.readFile = readFile;

    await expect(collectProjectSourceFiles(files)).rejects.toThrow(
      `${PROJECT_BUILD_MODULE_MAX_FILE_BYTES} byte file limit`,
    );
    expect(files.listFiles).toHaveBeenCalledWith("/", {
      recursive: true,
      includeHidden: true,
      limit: PROJECT_BUILD_OUTPUT_MAX_ENTRIES,
      bounds: {
        maxEntries: PROJECT_BUILD_OUTPUT_MAX_ENTRIES,
        maxFiles: PROJECT_BUILD_OUTPUT_MAX_ENTRIES,
        maxPathBytes: PROJECT_BUILD_SOURCE_LIST_MAX_PATH_BYTES,
        maxFileBytes: PROJECT_BUILD_MODULE_MAX_FILE_BYTES,
        maxTotalBytes: PROJECT_BUILD_SOURCE_MAX_TOTAL_BYTES,
      },
    });
    expect(readFileStream).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("cancels a source stream that exceeds its listed size", async () => {
    const files = fakeFiles({ "/source.bin": { content: "x" } });
    const cancel = vi.fn();
    files.readFileStream = vi.fn(async () => ({
      success: true,
      stream: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array([1, 2]));
        },
        cancel,
      }),
    }));

    await expect(collectProjectSourceFiles(files)).rejects.toThrow(
      "exceeded its listed byte size",
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("treats an oversized previous manifest as a bounded cache miss", async () => {
    const files = fakeFiles({ "/package.json": { content: "{}" } });
    const sandbox = {
      exists: vi.fn(async () => ({ exists: true })),
      readFile: vi.fn(async () => ({
        content: " ".repeat(PROJECT_BUILD_MANIFEST_MAX_BYTES + 1),
      })),
    } as unknown as ProjectBuildSandboxLike;

    const collected = await collectProjectSourceFiles(files, {
      sandbox,
      workdir: "/workspace/demo",
    });

    expect(collected.previousManifest).toBeNull();
    expect(files.readFile).toHaveBeenCalledWith("/package.json");
  });

  it("collects, decodes, hashes, sorts, and excludes generated source trees", async () => {
    const files = fakeFiles({
      "/src/z.ts": { content: "z" },
      "/src/a.bin": { content: "AAEC", encoding: "base64" },
      "/package.json": { content: "{}" },
      "/node_modules/pkg/index.js": { content: "ignored" },
      "/.camelai/tmp/build.log": { content: "ignored" },
      "/build/output.js": { content: "ignored" },
    });

    const collected = await collectProjectSourceFiles(files);

    expect(collected.entries.map((file) => file.path)).toEqual([
      "package.json",
      "src/a.bin",
      "src/z.ts",
    ]);
    expect(
      collected.changedFiles.find((file) => file.path === "src/a.bin")?.bytes,
    ).toEqual(new Uint8Array([0, 1, 2]));
    expect(
      collected.entries.every((file) => /^[a-f0-9]{64}$/.test(file.sha256)),
    ).toBe(true);
    expect(collected.totalBytes).toBe(6);
  });

  it("reuses warm manifest hashes without reading unchanged large data files", async () => {
    const baselineFiles = fakeFiles({
      "/package.json": {
        content: JSON.stringify({ scripts: { build: "vite build" } }),
      },
      "/src/index.ts": { content: "export const value = 1;" },
      "/public/data.json": { content: "x".repeat(2_000_000) },
    });
    const baseline = await collectProjectSourceFiles(baselineFiles);
    const manifest = {
      schemaVersion: 2,
      files: baseline.entries,
    };
    const files = fakeFiles({
      "/package.json": {
        content: JSON.stringify({ scripts: { build: "vite build" } }),
      },
      "/src/index.ts": { content: "export const value = 2;" },
      "/public/data.json": { content: "x".repeat(2_000_000) },
    });
    const listing = await files.listFiles("/");
    const sourceEntry = listing.files.find(
      (entry) => entry.absolutePath === "/src/index.ts",
    )!;
    sourceEntry.modifiedAt = new Date(1).toISOString();
    const manifestContent = JSON.stringify(manifest);
    const manifestBytes = new TextEncoder().encode(manifestContent);
    const manifestWire = [
      {
        type: "metadata",
        mimeType: "application/octet-stream",
        size: manifestBytes.byteLength,
        isBinary: true,
        encoding: "base64",
      },
      { type: "chunk", data: Buffer.from(manifestBytes).toString("base64") },
      { type: "complete" },
    ]
      .map((event) => `data: ${JSON.stringify(event)}\n\n`)
      .join("");
    const sandbox = {
      exists: vi.fn(async () => ({ exists: true })),
      readFileStream: vi.fn(async () => new Response(manifestWire).body!),
    } as unknown as ProjectBuildSandboxLike;

    const collected = await collectProjectSourceFiles(files, {
      sandbox,
      workdir: "/workspace/demo",
    });

    expect(files.readFile).toHaveBeenCalledWith("/package.json");
    expect(files.readFile).toHaveBeenCalledWith("/src/index.ts");
    expect(files.readFile).not.toHaveBeenCalledWith("/public/data.json");
    expect(collected.changedFiles.map((file) => file.path)).toEqual([
      "src/index.ts",
    ]);
    expect(collected.totalBytes).toBe(baseline.totalBytes);
  });

  it("owns package and Durable Object SQLite source admission", () => {
    const packageJson = sourceFile(
      "package.json",
      JSON.stringify({ scripts: { build: "vite build" } }),
    );
    expect(validatePackageJson([packageJson])).toBeNull();
    expect(validatePackageJsonBuildScript([packageJson])).toBeNull();
    expect(
      validatePackageJsonBuildScript([sourceFile("package.json", "{}")]),
    ).toContain("must define scripts.build");
    expect(
      validateDoSqliteApiUsage([
        sourceFile(
          "src/tasks.ts",
          [
            "function list() {",
            '  return this.ctx.storage.sql.prepare("SELECT 1").all();',
            "}",
          ].join("\n"),
        ),
      ]),
    ).toContain("src/tasks.ts:2 calls .prepare()");
    expect(
      validateDoSqliteApiUsage([
        sourceFile(
          "src/tasks.ts",
          'this.ctx.storage.sql.exec("SELECT 1").toArray();',
        ),
        sourceFile("src/mysql.ts", "mysql.prepare(query);"),
      ]),
    ).toBeNull();
  });

  it("materializes only changed files against the persisted source manifest", async () => {
    const previousManifest = {
      schemaVersion: 2 as const,
      files: [
        {
          path: "package.json",
          size: 2,
          sha256: SHA_A,
          modifiedAt: new Date(0).toISOString(),
        },
        {
          path: "src/removed.ts",
          size: 3,
          sha256: SHA_A,
          modifiedAt: new Date(0).toISOString(),
        },
      ],
    };
    const sandbox = {
      mkdir: vi.fn(async () => undefined),
      exists: vi.fn(async () => ({ exists: true })),
      readFile: vi.fn(async () => ({
        content: JSON.stringify(previousManifest),
      })),
      writeFile: vi.fn(async () => undefined),
      exec: vi.fn(async () => ({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      })),
    } as unknown as ProjectBuildSandboxLike & {
      writeFile: ReturnType<typeof vi.fn>;
      exec: ReturnType<typeof vi.fn>;
    };

    const source: ProjectSourceCollection = {
      entries: [
        {
          path: "package.json",
          size: 2,
          modifiedAt: new Date(0).toISOString(),
          sha256: SHA_A,
        },
        {
          path: "src/new.ts",
          size: 3,
          modifiedAt: new Date(1).toISOString(),
          sha256: SHA_B,
        },
      ],
      changedFiles: [sourceFile("src/new.ts", "new", SHA_B)],
      validationFiles: [
        sourceFile("package.json", "{}", SHA_A),
        sourceFile("src/new.ts", "new", SHA_B),
      ],
      previousManifest,
      previousManifestReadMs: 1,
      timings: {
        collectSourceMs: 1,
        sourceListMs: 1,
        sourceReadMs: 1,
        sourceHashMs: 1,
      },
      totalBytes: 5,
    };
    const timings = await materializeProjectSourceFiles(
      sandbox,
      "/workspace/demo",
      source,
    );

    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(sandbox.writeFile.mock.calls.map((call) => call[0])).toEqual([
      "/workspace/demo.source.0.tar",
      "/workspace/demo.next-source-manifest.json",
    ]);
    expect(sandbox.exec).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/workspace",
    });
    const command = sandbox.exec.mock.calls[0]?.[0] as string;
    expect(command).toContain("CAMELAI_FORCE_CLEAN=0");
    expect(command).toContain("tar -tf '/workspace/demo.source.0.tar'");
    expect(command).toContain("tar -xf '/workspace/demo.source.0.tar'");
    expect(timings).toEqual(
      expect.objectContaining({
        materializeMs: expect.any(Number),
        archiveCreateMs: expect.any(Number),
        materializeExecMs: expect.any(Number),
      }),
    );
  });

  it("commits deletion-only deltas without creating an archive lane", async () => {
    const previousManifest = {
      schemaVersion: 2 as const,
      files: [
        {
          path: "package.json",
          size: 2,
          sha256: SHA_A,
          modifiedAt: new Date(0).toISOString(),
        },
        {
          path: "public/removed.json",
          size: 4,
          sha256: SHA_B,
          modifiedAt: new Date(0).toISOString(),
        },
      ],
    };
    const source: ProjectSourceCollection = {
      entries: [
        {
          path: "package.json",
          size: 2,
          modifiedAt: new Date(0).toISOString(),
          sha256: SHA_A,
        },
      ],
      changedFiles: [],
      validationFiles: [sourceFile("package.json", "{}", SHA_A)],
      previousManifest,
      previousManifestReadMs: 1,
      timings: {
        collectSourceMs: 1,
        sourceListMs: 1,
        sourceReadMs: 1,
        sourceHashMs: 1,
      },
      totalBytes: 2,
    };
    const sandbox = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async () => undefined),
      exec: vi.fn(async () => ({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      })),
    } as unknown as ProjectBuildSandboxLike;

    await materializeProjectSourceFiles(sandbox, "/workspace/demo", source);

    expect(sandbox.writeFile).toHaveBeenCalledTimes(1);
    expect(sandbox.writeFile).toHaveBeenCalledWith(
      "/workspace/demo.next-source-manifest.json",
      expect.any(String),
      { encoding: "utf8" },
    );
    const command = (sandbox.exec as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(command).toContain("CAMELAI_FORCE_CLEAN=0");
    expect(command).not.toContain("tar -t");
    expect(command).not.toContain("tar -x");
  });

  it("streams a cold 21 MB source over three parallel gzip lanes", async () => {
    const files = [
      sourceFile("public/a.json", "a".repeat(7 * 1024 * 1024)),
      sourceFile("public/b.json", "b".repeat(7 * 1024 * 1024)),
      sourceFile("public/c.json", "c".repeat(7 * 1024 * 1024)),
    ];
    const source: ProjectSourceCollection = {
      entries: files.map((file) => ({
        path: file.path,
        size: file.bytes.byteLength,
        modifiedAt: new Date(0).toISOString(),
        sha256: file.sha256,
      })),
      changedFiles: files,
      validationFiles: [],
      previousManifest: null,
      previousManifestReadMs: 0,
      timings: {
        collectSourceMs: 1,
        sourceListMs: 1,
        sourceReadMs: 1,
        sourceHashMs: 1,
      },
      totalBytes: 21 * 1024 * 1024,
    };
    let activeStreams = 0;
    let maxActiveStreams = 0;
    const transferred = new Map<string, Uint8Array>();
    const writeFile = vi.fn(
      async (path: string, content: string | ReadableStream<Uint8Array>) => {
        if (typeof content === "string") return;
        activeStreams += 1;
        maxActiveStreams = Math.max(maxActiveStreams, activeStreams);
        const reader = content.getReader();
        const chunks: Uint8Array[] = [];
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value);
        }
        const size = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        transferred.set(path, bytes);
        activeStreams -= 1;
      },
    );
    const sandbox = {
      mkdir: vi.fn(async () => undefined),
      writeFile,
      exec: vi.fn(async () => ({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      })),
    } as unknown as ProjectBuildSandboxLike;

    await materializeProjectSourceFiles(sandbox, "/workspace/large", source);

    expect(maxActiveStreams).toBe(3);
    expect(
      writeFile.mock.calls
        .filter(([, content]) => content instanceof ReadableStream)
        .map(([path]) => path),
    ).toEqual([
      "/workspace/large.source.0.tar.gz",
      "/workspace/large.source.1.tar.gz",
      "/workspace/large.source.2.tar.gz",
    ]);
    const command = (sandbox.exec as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0] as string;
    expect(command.match(/tar -tzf/g)).toHaveLength(3);
    expect(command.match(/tar -xzf/g)).toHaveLength(3);
    const firstArchive = transferred.get("/workspace/large.source.0.tar.gz")!;
    const compressedInput = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(firstArchive);
        controller.close();
      },
    });
    const decompressed = compressedInput.pipeThrough(
      new DecompressionStream("gzip") as unknown as ReadableWritablePair<
        Uint8Array,
        Uint8Array
      >,
    );
    expect(
      new TextDecoder().decode(await new Response(decompressed).arrayBuffer()),
    ).toContain("public/a.json");
  });

  it("does not materialize a partial source tree when an archive lane upload fails", async () => {
    const files = [sourceFile("a.txt", "a"), sourceFile("b.txt", "b")];
    const source: ProjectSourceCollection = {
      entries: files.map((file) => ({
        path: file.path,
        size: file.bytes.byteLength,
        modifiedAt: new Date(0).toISOString(),
        sha256: file.sha256,
      })),
      changedFiles: files,
      validationFiles: [],
      previousManifest: null,
      previousManifestReadMs: 0,
      timings: {
        collectSourceMs: 1,
        sourceListMs: 1,
        sourceReadMs: 1,
        sourceHashMs: 1,
      },
      totalBytes: 2,
    };
    const sandbox = {
      mkdir: vi.fn(async () => undefined),
      writeFile: vi.fn(async (path: string) => {
        if (path.endsWith(".tar")) throw new Error("upload failed");
      }),
      exec: vi.fn(async () => ({
        success: true,
        stdout: "",
        stderr: "",
        exitCode: 0,
      })),
    } as unknown as ProjectBuildSandboxLike;

    await expect(
      materializeProjectSourceFiles(sandbox, "/workspace/demo", source),
    ).rejects.toThrow("upload failed");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("quotes shell values without exposing a second command", () => {
    expect(shellQuote("@scope/pkg@^1")).toBe("'@scope/pkg@^1'");
    expect(shellQuote("a'b")).toBe("'a'\\''b'");
  });
});
