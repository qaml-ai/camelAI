import { describe, expect, it, vi } from "vitest";

import {
  __testing as projectBuildTesting,
  buildLogTail,
  projectBuildSandboxKey,
  runProjectAddDependency,
  runProjectBuild,
} from "../src/project-build-service";
import type { ProjectBuildSandboxLike } from "../src/project-worker-bundle";
import type { WorkspaceFileStoreLike, WorkspaceListEntry } from "../src/workspace-filesystem-do";

function fakeFileStore(files: Record<string, string>): WorkspaceFileStoreLike {
  const entries: WorkspaceListEntry[] = Object.entries(files).map(([path, content]) => {
    const absolutePath = path.startsWith("/") ? path : `/${path}`;
    return {
      name: absolutePath.split("/").filter(Boolean).pop() || "",
      type: "file",
      size: content.length,
      modifiedAt: new Date(0).toISOString(),
      relativePath: absolutePath.replace(/^\/+/, ""),
      absolutePath,
    };
  });
  return {
    exists: vi.fn(async () => ({ exists: true })),
    readFile: vi.fn(async (path: string) => {
      const content = files[path] ?? files[path.replace(/^\/+/, "")];
      return content == null
        ? { success: false, error: "File not found" }
        : { success: true, content, encoding: "utf8" as const, isBinary: false, size: content.length };
    }),
    readFileStream: vi.fn(async () => ({ success: false })),
    writeFile: vi.fn(async () => ({ success: true })),
    writeBinaryFile: vi.fn(async () => ({ success: true })),
    listFiles: vi.fn(async () => ({ success: true, files: entries, count: entries.length, path: "/" })),
    mkdir: vi.fn(async () => ({ success: true })),
    deleteFile: vi.fn(async () => ({ success: true })),
  };
}

function fakeSandbox(): ProjectBuildSandboxLike & {
  exec: ReturnType<typeof vi.fn>;
  mkdir: ReturnType<typeof vi.fn>;
  writeFile: ReturnType<typeof vi.fn>;
  exists: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
} {
  return {
    exec: vi.fn(async (command: string) => command.includes("bun run build")
      ? { success: true, stdout: "built", stderr: "", exitCode: 0 }
      : { success: true, stdout: "", stderr: "", exitCode: 0 }),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    exists: vi.fn(async () => ({ exists: false })),
    readFile: vi.fn(async () => {
      throw new Error("not found");
    }),
  };
}

describe("runProjectBuild", () => {
  it("materializes source-only files and runs the fixed build pipeline", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "/src/index.ts": "export default {};",
      "/.camelai/tmp/build.log": "previous build log",
      "/node_modules/pkg/index.js": "ignored",
      "/build/server/index.js": "ignored",
      "/.git/config": "ignored",
    });
    const sandbox = fakeSandbox();

    const result = await runProjectBuild({
      projectId: "Demo_Project",
      files,
      sandbox,
      timeoutMs: 15_000,
    });

    expect(result).toMatchObject({
      success: true,
      projectId: "demo-project",
      workdir: "/workspace/demo-project",
      stdout: "built",
      exitCode: 0,
      fileCount: 2,
      sourceBytes: expect.any(Number),
      timings: expect.objectContaining({
        collectSourceMs: expect.any(Number),
        materializeMs: expect.any(Number),
        commandMs: expect.any(Number),
      }),
    });
    expect(sandbox.mkdir).toHaveBeenCalledWith("/workspace/demo-project", { recursive: true });
    expect(sandbox.exists).toHaveBeenCalledWith("/workspace/demo-project.source-manifest.json");
    expect(sandbox.readFile).not.toHaveBeenCalledWith(
      "/workspace/demo-project.source-manifest.json",
      { encoding: "base64" },
    );
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("tar -xf '/workspace/demo-project.source.0.tar'"), { cwd: "/workspace" });
    expect(sandbox.exec).toHaveBeenCalledWith("bun install && bun run build", {
      cwd: "/workspace/demo-project",
      timeout: 15_000,
      env: {
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        CAMELAI_PROJECT_ID: "demo-project",
        CAMELAI_BUILD_TIMEOUT_MS: "15000",
      },
    });
    expect(sandbox.writeFile).toHaveBeenCalledTimes(2);
    expect(sandbox.writeFile.mock.calls.map((call) => call[0])).toEqual([
      "/workspace/demo-project.source.0.tar",
      "/workspace/demo-project.next-source-manifest.json",
    ]);
    expect(files.writeFile).toHaveBeenCalledWith("/.camelai/tmp/build.log", "built");
  });

  it("returns structured failures from the build command", async () => {
    const files = fakeFileStore({ "/package.json": JSON.stringify({ scripts: { build: "vite build" } }) });
    const sandbox = fakeSandbox();
    sandbox.exec.mockResolvedValueOnce({ success: true, exitCode: 0, stdout: "", stderr: "" });
    sandbox.exec.mockResolvedValueOnce({ success: false, exitCode: 1, stdout: "", stderr: "missing build" });

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      buildLogPath: "/.camelai/tmp/build.log",
      buildLogPersisted: true,
      error: "missing build",
    });
    expect(files.writeFile).toHaveBeenCalledWith("/.camelai/tmp/build.log", "missing build");
  });

  it("fails fast when package.json has no build script", async () => {
    const files = fakeFileStore({ "/package.json": "{}" });
    const sandbox = fakeSandbox();

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      lockfilePersisted: false,
      buildLogPath: "/.camelai/tmp/build.log",
      buildLogPersisted: true,
      error: expect.stringContaining("Project package.json must define scripts.build"),
    });
    expect(sandbox.mkdir).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("fails fast when worker source calls D1-style .prepare() on DO SQLite storage", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "/workers/tasks-do.ts": [
        "export class TasksDO {",
        "  listTasks() {",
        '    return this.sql.prepare("SELECT * FROM tasks WHERE owner = ?").bind(1).all();',
        "  }",
        "}",
      ].join("\n"),
    });
    const sandbox = fakeSandbox();

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      buildLogPersisted: true,
      error: expect.stringContaining('workers/tasks-do.ts:3 calls .prepare()'),
    });
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("does not flag sql.exec usage or identifiers like mysql", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "/workers/tasks-do.ts": [
        'const rows = this.sql.exec("SELECT * FROM tasks WHERE owner = ?", ownerId).toArray();',
        "const stmt = mysql.prepare(query);",
      ].join("\n"),
    });
    const sandbox = fakeSandbox();

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: true,
    });
  });

  it("persists bun.lock even when the build command fails", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    });
    const sandbox = {
      ...fakeSandbox(),
      readFile: vi.fn(async () => ({ content: Buffer.from("# lockfile\n").toString("base64") })),
    };
    sandbox.exec = vi.fn(async (command: string) => command.includes("bun run build")
      ? { success: false, stdout: "", stderr: "type error", exitCode: 1 }
      : { success: true, stdout: "", stderr: "", exitCode: 0 });

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      lockfilePersisted: true,
      error: "type error",
    });
    expect(files.writeFile).toHaveBeenCalledWith("/bun.lock", "# lockfile\n");
  });

  it("does not mask a build failure when lockfile persistence errors", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    });
    const sandbox = {
      ...fakeSandbox(),
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith("/bun.lock")) throw new Error("sandbox exploded");
        throw new Error("not found");
      }),
    };
    sandbox.exec = vi.fn(async (command: string) => command.includes("bun run build")
      ? { success: false, stdout: "", stderr: "type error", exitCode: 1 }
      : { success: true, stdout: "", stderr: "", exitCode: 0 });

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      lockfilePersisted: false,
      error: "type error",
    });
  });

  it("persists bun.lock back to the project file store after a successful build", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    });
    const sandbox = {
      ...fakeSandbox(),
      readFile: vi.fn(async () => ({ content: Buffer.from("# lockfile\n").toString("base64") })),
    };

    await expect(runProjectBuild({ projectId: "demo", files, sandbox })).resolves.toMatchObject({
      success: true,
      lockfilePersisted: true,
    });
    expect(files.writeFile).toHaveBeenCalledWith("/bun.lock", "# lockfile\n");
    expect(sandbox.readFile).toHaveBeenCalledWith("/workspace/demo/bun.lock", { encoding: "base64" });
  });

  it("reports build-log persistence failures without changing a successful command result", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
    });
    vi.mocked(files.writeFile).mockImplementation(async (path) => path === "/.camelai/tmp/build.log"
      ? { success: false, error: "storage unavailable" }
      : { success: true });

    await expect(runProjectBuild({ projectId: "demo", files, sandbox: fakeSandbox() }))
      .resolves.toMatchObject({
        success: true,
        buildLogPath: "/.camelai/tmp/build.log",
        buildLogPersisted: false,
        buildLogBytes: 5,
      });
  });
});

describe("runProjectAddDependency", () => {
  it("runs a fixed bun add command and persists package.json plus bun.lock", async () => {
    const files = fakeFileStore({
      "/package.json": JSON.stringify({ scripts: { build: "vite build" } }),
      "/src/index.ts": "export default {};",
    });
    const updatedPackageJson = JSON.stringify({
      scripts: { build: "vite build" },
      devDependencies: { "@types/node": "^22" },
    }, null, 2);
    const sandbox = {
      ...fakeSandbox(),
      readFile: vi.fn(async (path: string) => {
        if (path.endsWith("/package.json")) return { content: Buffer.from(updatedPackageJson).toString("base64") };
        if (path.endsWith("/bun.lock")) return { content: Buffer.from("# lockfile\n").toString("base64") };
        throw new Error(`missing ${path}`);
      }),
    };

    const result = await runProjectAddDependency({
      projectId: "Demo_Project",
      files,
      sandbox,
      dependency: "@types/node@^22",
      dev: true,
    });

    expect(result).toMatchObject({
      success: true,
      projectId: "demo-project",
      dependency: "@types/node@^22",
      dev: true,
      packageJsonPersisted: true,
      lockfilePersisted: true,
      fileCount: 2,
    });
    expect(sandbox.exec).toHaveBeenCalledWith("bun add -d '@types/node@^22'", {
      cwd: "/workspace/demo-project",
      timeout: 120_000,
      env: {
        CI: "1",
        WRANGLER_SEND_METRICS: "false",
        CAMELAI_PROJECT_ID: "demo-project",
      },
    });
    expect(files.writeFile).toHaveBeenCalledWith("/package.json", updatedPackageJson);
    expect(files.writeFile).toHaveBeenCalledWith("/bun.lock", "# lockfile\n");
  });

  it("returns structured failures from bun add", async () => {
    const files = fakeFileStore({ "/package.json": "{}" });
    const sandbox = fakeSandbox();
    sandbox.exec.mockResolvedValueOnce({ success: true, exitCode: 0, stdout: "", stderr: "" });
    sandbox.exec.mockResolvedValueOnce({ success: false, exitCode: 1, stdout: "", stderr: "not found" });

    await expect(runProjectAddDependency({
      projectId: "demo",
      files,
      sandbox,
      dependency: "missing-package",
    })).resolves.toMatchObject({
      success: false,
      exitCode: 1,
      error: "not found",
      packageJsonPersisted: false,
      lockfilePersisted: false,
    });
    expect(files.writeFile).not.toHaveBeenCalled();
  });

  it("rejects non-registry or shell-like dependency specs", async () => {
    const files = fakeFileStore({ "/package.json": "{}" });
    const sandbox = fakeSandbox();

    await expect(runProjectAddDependency({
      projectId: "demo",
      files,
      sandbox,
      dependency: "react;rm-rf",
    })).rejects.toThrow("dependency must be an npm package spec");
    await expect(runProjectAddDependency({
      projectId: "demo",
      files,
      sandbox,
      dependency: "file:../local",
    })).rejects.toThrow("dependency must be an npm registry package spec");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});

describe("projectBuildSandboxKey", () => {
  it("isolates build sandboxes by org", () => {
    expect(projectBuildSandboxKey("Org A")).toBe("org-org-a");
    expect(projectBuildSandboxKey("Org B")).toBe("org-org-b");
  });

  it("keeps long org sandbox keys within the Cloudflare container id limit", () => {
    const key = projectBuildSandboxKey(
      "local-dev-org-with-a-very-long-name-that-still-needs-a-stable-build-sandbox-key",
    );

    expect(key.length).toBeLessThanOrEqual(63);
    expect(key).toMatch(/^org-local-dev-org-with-a-very-long-name-that-still-nee-[a-f0-9]{8}$/);
    expect(projectBuildSandboxKey(
      "local-dev-org-with-a-very-long-name-that-still-needs-a-different-stable-build-sandbox-key",
    )).not.toBe(key);
  });
});

describe("project build testing surface", () => {
  it("keeps the exact source-policy helper inventory", () => {
    expect(Object.keys(projectBuildTesting).sort()).toEqual([
      "collectProjectSourceFiles",
      "normalizeRelativeBuildPath",
      "shouldIgnoreBuildSourcePath",
    ]);
  });
});

describe("buildLogTail", () => {
  it("keeps the vite/rolldown diagnostic that appears at the end of the combined output", () => {
    const raw = [
      "$ react-router build && node ./scripts/build-manifest.mjs",
      "vite v8.0.16 building client environment for production...",
      "transforming...",
      "✓ 3048 modules transformed.",
      "✗ Build failed in 8.34s",
      "Build failed with 1 error:",
      "",
      "[plugin react-router:dot-server]",
      'Error: Errored while resolving "@/lib/auxiliary-ai.server" in `this.resolve`.',
      "    Error: Server-only module referenced by client",
      "",
      "        '/opt/repo/src/lib/auxiliary-ai.server' imported by route 'src/routes/api/help.ts'",
      "",
      'error: script "build:cf" exited with code 1',
    ].join("\n");

    const tail = buildLogTail(raw)!;
    expect(tail).toContain("Server-only module referenced by client");
    expect(tail).toContain("src/routes/api/help.ts");
  });

  it("keeps parse errors with their code frame", () => {
    const raw = [
      "$ react-router build && node ./scripts/build-manifest.mjs",
      "Error: Transform failed with 1 error:",
      "[PARSE_ERROR] Expected `;` but found `Identifier`",
      "     ╭─[ app/routes/home.tsx:21:30 ]",
      " 21  │   const forcedBuildFailure = ;",
      'error: script "build" exited with code 1',
    ].join("\n");

    const tail = buildLogTail(raw)!;
    expect(tail).toContain("[PARSE_ERROR] Expected `;` but found `Identifier`");
    expect(tail).toContain("app/routes/home.tsx:21:30");
    expect(tail).toContain("const forcedBuildFailure = ;");
  });

  it("strips ANSI escapes and collapses blank runs", () => {
    const raw = "\u001b[31m✗ Build failed\u001b[0m\n\n\n\n\u001b[1merror TS2339: nope\u001b[22m";
    expect(buildLogTail(raw)).toBe("✗ Build failed\n\nerror TS2339: nope");
  });

  it("strips non-color ANSI controls and normalizes progress carriage returns", () => {
    const raw = "transforming...\u001b[2K\r✓ 1817 modules transformed.\n✗ Build failed";
    const tail = buildLogTail(raw)!;
    expect(tail).toBe("transforming...\n✓ 1817 modules transformed.\n✗ Build failed");
    expect(tail).not.toContain("[2K");
    expect(tail).not.toContain("\r");
  });

  it("returns complete modest output without truncating the beginning", () => {
    const noise = Array.from({ length: 500 }, (_, i) => `progress line ${i}`).join("\n");
    const raw = `${noise}\nError: something exploded at the end`;
    const tail = buildLogTail(raw)!;
    expect(tail).toContain("progress line 0\n");
    expect(tail).toContain("Error: something exploded at the end");
    expect(tail).not.toContain("[truncated");
  });

  it("keeps only the tail of oversized output, where the diagnostic usually lives", () => {
    const noise = Array.from({ length: 1500 }, (_, i) => `progress line ${i}`).join("\n");
    const raw = `${noise}\nError: something exploded at the end`;
    const tail = buildLogTail(raw)!;
    expect(tail.length).toBeLessThan(10100);
    expect(tail).toContain("[truncated");
    expect(tail).toContain("Error: something exploded at the end");
    expect(tail).not.toContain("progress line 0\n");
  });

  it("returns null for empty output", () => {
    expect(buildLogTail("")).toBeNull();
    expect(buildLogTail("\n  \n")).toBeNull();
  });
});

describe("build failure output ordering", () => {
  it("keeps stderr diagnostics visible in the tail even when stdout is huge", async () => {
    const files = fakeFileStore({ "/package.json": JSON.stringify({ scripts: { build: "vite build" } }) });
    const sandbox = fakeSandbox();
    const noisyStdout = Array.from({ length: 1500 }, (_, i) => `progress ${i}`).join("\n");
    sandbox.exec.mockResolvedValueOnce({ success: true, exitCode: 0, stdout: "", stderr: "" });
    sandbox.exec.mockResolvedValueOnce({
      success: false,
      exitCode: 1,
      stdout: noisyStdout,
      stderr: "error TS2339: Property 'x' does not exist on type 'Env'.",
    });

    const result = await runProjectBuild({ projectId: "demo", files, sandbox });
    const tail = buildLogTail(result.error!)!;
    expect(tail).toContain("error TS2339");
    expect(tail).toContain("[truncated");
  });
});
