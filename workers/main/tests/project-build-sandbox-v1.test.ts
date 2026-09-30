import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS,
  PROJECT_BUILD_IDLE_TIMEOUT_MS,
} from "../src/container-sizing";
import {
  isProjectBuildPermanentStartupError,
  projectBuildTransientCause,
} from "../src/project-build-readiness";
import { PROJECT_BUILD_SESSION_ACTIVITY_KEY } from "../src/project-build-sandbox-lifecycle";
import {
  getProjectBuildSandbox,
  hasProjectBuildSandbox,
  projectBuildSandboxRuntime,
} from "../src/project-build-sandbox-routing";
import {
  parseFindOutput,
  PROJECT_BUILD_V1_IMAGE,
  ProjectBuildSandboxV1,
  type ProjectBuildFiles,
} from "../src/project-build-sandbox-v1";
import { isSandboxExecTimeoutResult } from "../src/sandbox-exec-deadline";
import { collectWorkerBundleFromSandbox, type ProjectBuildSandboxLike } from "../src/project-worker-bundle";
import type { Env } from "../src/types";

// The runtime's DurableObject base only accepts a real DurableObjectState; the
// class under test only needs `ctx` and `env` set.
vi.mock("cloudflare:workers", async (importOriginal) => {
  const original = await importOriginal<typeof import("cloudflare:workers")>();
  class DurableObject {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  }
  return { ...original, DurableObject };
});

const IMAGE = "registry.cloudflare.com/acct/project-build@sha256:current";
const encoder = new TextEncoder();

interface FakeRun {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Resolve only once `release()` is called (or the process group is killed). */
  hang?: boolean;
  /** Pretend the command took this long (drives the elapsed-time check). */
  delayMs?: number;
}

type ExecHandler = (argv: string[], options: ContainerExecOptions | undefined) => FakeRun;

function fakeProcess(run: FakeRun, pid: number, hung: Map<number, () => void>): ExecProcess {
  let resolveExit!: (code: number) => void;
  const exitCode = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const finish = (code: number) => resolveExit(code);
  if (run.hang) {
    hung.set(pid, () => finish(137));
  } else if (run.delayMs) {
    setTimeout(() => finish(run.exitCode ?? 0), run.delayMs);
  } else {
    finish(run.exitCode ?? 0);
  }
  return {
    stdin: null,
    stdout: null,
    stderr: null,
    pid,
    isPty: false,
    exitCode,
    output: async () => ({
      exitCode: await exitCode,
      stdout: encoder.encode(run.stdout ?? "").buffer as ArrayBuffer,
      stderr: encoder.encode(run.stderr ?? "").buffer as ArrayBuffer,
    }),
    kill: vi.fn(),
    resize: vi.fn(),
  };
}

function fakeContainer(options: {
  running?: boolean;
  runningImage?: string;
  images?: Record<string, string>;
  handler?: ExecHandler;
  startError?: Error;
} = {}) {
  let running = options.running ?? false;
  let runningImage = options.runningImage ?? IMAGE;
  let nextPid = 100;
  const hung = new Map<number, () => void>();
  const execCalls: Array<{ argv: string[]; options: ContainerExecOptions | undefined }> = [];
  const handler: ExecHandler = options.handler ?? (() => ({ exitCode: 0 }));
  const container = {
    get running() {
      return running;
    },
    get images() {
      return options.images ?? { [PROJECT_BUILD_V1_IMAGE]: IMAGE };
    },
    start: vi.fn((start?: ContainerStartupOptions) => {
      if (running) throw new Error("already running");
      running = true;
      runningImage = start?.image ?? "";
    }),
    destroy: vi.fn(async () => {
      running = false;
    }),
    setInactivityTimeout: vi.fn(async (_ms: number | bigint) => {}),
    inspect: vi.fn(async () => (running ? { image: runningImage, labels: {} } : null)),
    exec: vi.fn(async (argv: string[], execOptions?: ContainerExecOptions) => {
      execCalls.push({ argv, options: execOptions });
      if (options.startError) {
        running = false;
        throw options.startError;
      }
      if (!running) throw new Error("container is not running");
      if (argv[0] === "kill" && argv[2] === "--") {
        const pid = Number(argv[3].slice(1));
        hung.get(pid)?.();
        return fakeProcess({ exitCode: 0 }, nextPid++, hung);
      }
      return fakeProcess(handler(argv, execOptions), nextPid++, hung);
    }),
  };
  return { container, execCalls, hung };
}

function fakeState(container: unknown, stored: Record<string, unknown> = {}) {
  const storage = new Map<string, unknown>(Object.entries(stored));
  return {
    storage,
    ctx: {
      container,
      id: { name: "org-acme", toString: () => "id" },
      storage: {
        get: vi.fn(async (key: string) => storage.get(key)),
        put: vi.fn(async (key: string, value: unknown) => {
          storage.set(key, value);
        }),
        delete: vi.fn(async (key: string) => storage.delete(key)),
      },
      blockConcurrencyWhile: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
      waitUntil: vi.fn(),
    },
  };
}

function fileError(code: string, operation: string, path: string): Error {
  return Object.assign(new Error(`${operation} '${path}': ${code}`), {
    name: "SandboxFileError",
    code,
    operation,
    path,
    detail: code,
  });
}

function fakeFiles(initial: Record<string, string | Uint8Array> = {}) {
  const files = new Map<string, Uint8Array>(
    Object.entries(initial).map(([path, value]) => [path, typeof value === "string" ? encoder.encode(value) : value]),
  );
  const dirs = new Set<string>(["/", "/workspace"]);
  const fake = {
    files,
    dirs,
    readFile: vi.fn(async (path: string) => {
      const bytes = files.get(path);
      if (!bytes) throw fileError("ENOENT", "readFile", path);
      return new Response(bytes);
    }),
    writeFile: vi.fn(async (path: string, content: unknown) => {
      const parent = path.slice(0, path.lastIndexOf("/")) || "/";
      if (!dirs.has(parent)) throw fileError("ENOENT", "writeFile", path);
      const bytes = typeof content === "string"
        ? encoder.encode(content)
        : content instanceof ReadableStream
          ? new Uint8Array(await new Response(content).arrayBuffer())
          : new Uint8Array(content as ArrayBuffer);
      files.set(path, bytes);
    }),
    stat: vi.fn(async (path: string) => {
      if (!files.has(path) && !dirs.has(path)) throw fileError("ENOENT", "stat", path);
      return { type: files.has(path) ? "file" : "directory" } as Awaited<ReturnType<ProjectBuildFiles["stat"]>>;
    }),
    mkdir: vi.fn(async (path: string, options?: { recursive?: boolean }) => {
      const parts = path.split("/").filter(Boolean);
      for (let i = 1; i <= parts.length; i += 1) {
        const dir = `/${parts.slice(0, i).join("/")}`;
        if (i < parts.length && !dirs.has(dir) && !options?.recursive) throw fileError("ENOENT", "mkdir", path);
        dirs.add(dir);
      }
    }),
  };
  return fake;
}

function createSandbox(options: {
  container?: ReturnType<typeof fakeContainer>["container"] | undefined;
  files?: ReturnType<typeof fakeFiles>;
  stored?: Record<string, unknown>;
} = {}) {
  const state = fakeState(options.container, options.stored);
  const files = options.files ?? fakeFiles();
  const sandbox = new ProjectBuildSandboxV1(
    state.ctx as unknown as DurableObjectState,
    {} as Env,
    { files: files as unknown as ProjectBuildFiles },
  );
  return { sandbox, state, files };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProjectBuildSandboxV1 container lifecycle", () => {
  it("starts the container lazily on the first command, once", async () => {
    const { container } = fakeContainer();
    const { sandbox } = createSandbox({ container });
    expect(container.start).not.toHaveBeenCalled();

    await sandbox.exec("true");
    await sandbox.exec("true");

    expect(container.start).toHaveBeenCalledTimes(1);
    expect(container.start).toHaveBeenCalledWith({
      image: IMAGE,
      instance: "standard-3",
      enableInternet: true,
    });
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(PROJECT_BUILD_IDLE_TIMEOUT_MS);
  });

  it("starts a new container when the previous one stopped", async () => {
    const { container } = fakeContainer();
    const { sandbox } = createSandbox({ container });
    await sandbox.exec("true");
    await container.destroy();
    await sandbox.exec("true");
    expect(container.start).toHaveBeenCalledTimes(2);
  });

  it("re-applies the inactivity timeout when a restarted DO finds its container running", async () => {
    const { container } = fakeContainer({ running: true });
    const until = Date.now() + 5 * 60_000;
    const { state } = createSandbox({ container, stored: { [PROJECT_BUILD_SESSION_ACTIVITY_KEY]: until } });
    await Promise.resolve();
    await vi.waitFor(() => expect(container.setInactivityTimeout).toHaveBeenCalled());
    expect(state.ctx.blockConcurrencyWhile).toHaveBeenCalled();
    const applied = Number(container.setInactivityTimeout.mock.calls[0][0]);
    // The live session window, not the bare 2m idle timeout.
    expect(applied).toBeGreaterThan(4 * 60_000);
    expect(applied).toBeLessThanOrEqual(5 * 60_000);
  });

  it("moves a running container from an older image to the current one", async () => {
    const { container } = fakeContainer({ running: true, runningImage: "registry.cloudflare.com/acct/project-build@sha256:old" });
    const { sandbox } = createSandbox({ container });
    await sandbox.exec("true");
    expect(container.destroy).toHaveBeenCalledTimes(1);
    expect(container.start).toHaveBeenCalledWith(expect.objectContaining({ image: IMAGE }));
  });

  it("keeps a running container that is already on the current image", async () => {
    const { container } = fakeContainer({ running: true });
    const { sandbox } = createSandbox({ container });
    await sandbox.exec("true");
    expect(container.destroy).not.toHaveBeenCalled();
    expect(container.start).not.toHaveBeenCalled();
  });

  it("reports a container that is not running as a transient ContainerUnavailableError", async () => {
    const { container } = fakeContainer({ startError: new Error("container exited before it was ready") });
    const { sandbox } = createSandbox({ container });

    const error = await sandbox.exec("true").catch((cause: unknown) => cause);

    expect(String(error)).toContain("ContainerUnavailableError");
    expect(String(error)).toContain("container exited before it was ready");
    expect(projectBuildTransientCause(error)).toBe("container_unavailable");
    // The next call tries a fresh start instead of reusing the failed setup.
    await sandbox.exec("true").catch(() => {});
    expect(container.start).toHaveBeenCalledTimes(2);
  });

  it("fails permanently when the build image is missing from the deployment", async () => {
    const { container } = fakeContainer({ images: {} });
    const { sandbox } = createSandbox({ container });
    const error = await sandbox.exec("true").catch((cause: unknown) => cause);
    expect(isProjectBuildPermanentStartupError(error)).toBe(true);
    expect(container.start).not.toHaveBeenCalled();
  });

  it("restartZombieContainer destroys a running container", async () => {
    const { container } = fakeContainer();
    const { sandbox } = createSandbox({ container });
    await sandbox.exec("true");
    await expect(sandbox.restartZombieContainer({ operation: "readiness_probe", trigger: "probe_session_death" }))
      .resolves.toEqual({ restarted: true, reason: "destroyed" });
    expect(container.running).toBe(false);
    await expect(sandbox.restartZombieContainer({ operation: "readiness_probe", trigger: "probe_session_death" }))
      .resolves.toEqual({ restarted: false, reason: "not_running" });
  });
});

describe("ProjectBuildSandboxV1 build session window", () => {
  it("stores the deadline and stretches the running container's inactivity timeout", async () => {
    const { container } = fakeContainer();
    const { sandbox } = createSandbox({ container });
    await sandbox.exec("true");
    container.setInactivityTimeout.mockClear();

    await sandbox.noteBuildSessionActivity();

    const applied = Number(container.setInactivityTimeout.mock.calls[0][0]);
    expect(applied).toBeGreaterThan(PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS - 1_000);
    expect(applied).toBeLessThanOrEqual(PROJECT_BUILD_ACTIVE_SESSION_WINDOW_MS);
  });

  it("never starts a container", async () => {
    const { container } = fakeContainer();
    const { sandbox, state } = createSandbox({ container });
    await sandbox.noteBuildSessionActivity(60_000);
    expect(container.start).not.toHaveBeenCalled();
    expect(container.setInactivityTimeout).not.toHaveBeenCalled();
    expect(state.storage.get(PROJECT_BUILD_SESSION_ACTIVITY_KEY)).toBeGreaterThan(Date.now());
  });
});

describe("ProjectBuildSandboxV1 exec", () => {
  it("runs the command under bash and GNU timeout with an explicit cwd and env", async () => {
    const { container, execCalls } = fakeContainer({
      handler: () => ({ exitCode: 0, stdout: "built\n", stderr: "warn\n" }),
    });
    const { sandbox } = createSandbox({ container });

    const result = await sandbox.exec("bun install && bun run build", {
      cwd: "/workspace/p1",
      timeout: 120_000,
      env: { CI: "1", SKIPPED: undefined },
    });

    expect(result).toEqual({ success: true, exitCode: 0, stdout: "built\n", stderr: "warn\n" });
    expect(execCalls[0].argv).toEqual([
      "timeout", "--kill-after=5", "120s", "bash", "-c", "bun install && bun run build",
    ]);
    expect(execCalls[0].options).toEqual({
      cwd: "/workspace/p1",
      env: { HOME: "/root", LANG: "C.UTF-8", CI: "1" },
    });
  });

  it("defaults cwd to /workspace and bounds a command that has no timeout", async () => {
    const { container, execCalls } = fakeContainer();
    const { sandbox } = createSandbox({ container });
    await sandbox.exec("true");
    expect(execCalls[0].options?.cwd).toBe("/workspace");
    expect(execCalls[0].argv.slice(0, 3)).toEqual(["timeout", "--kill-after=5", "600s"]);
  });

  it("returns a non-zero exit without throwing", async () => {
    const { container } = fakeContainer({ handler: () => ({ exitCode: 1, stderr: "boom" }) });
    const { sandbox } = createSandbox({ container });
    await expect(sandbox.exec("false")).resolves.toMatchObject({ success: false, exitCode: 1, stderr: "boom" });
  });

  it("reports its own timeout like 0.x's sessionless exec", async () => {
    const { container } = fakeContainer({ handler: () => ({ exitCode: 124, stderr: "partial", delayMs: 20 }) });
    const { sandbox } = createSandbox({ container });
    const result = await sandbox.exec("sleep 60", { timeout: 10 });
    expect(result.exitCode).toBe(124);
    expect(result.stderr).toBe("partial\nCommand timed out after 10ms");
    expect(isSandboxExecTimeoutResult(result)).toBe(true);
  });

  it("does not mistake a command's own quick exit 124 for a timeout", async () => {
    const { container } = fakeContainer({ handler: () => ({ exitCode: 124, stderr: "inner timeout" }) });
    const { sandbox } = createSandbox({ container });
    const result = await sandbox.exec("timeout 1 sleep 5", { timeout: 60_000 });
    expect(result).toMatchObject({ exitCode: 124, stderr: "inner timeout" });
    expect(isSandboxExecTimeoutResult(result)).toBe(false);
  });

  it("kills the process group when the command outlives its timeout", async () => {
    vi.useFakeTimers();
    const { container, execCalls } = fakeContainer({ handler: () => ({ hang: true }) });
    const { sandbox } = createSandbox({ container });

    const pending = sandbox.exec("sleep infinity", { timeout: 1_000 });
    await vi.advanceTimersByTimeAsync(1_000 + 15_000 + 1);
    const result = await pending;

    const kill = execCalls.find((call) => call.argv[0] === "kill");
    expect(kill?.argv).toEqual(["kill", "-KILL", "--", "-100"]);
    expect(result.exitCode).toBe(124);
    expect(isSandboxExecTimeoutResult(result)).toBe(true);
  });

  it("probeShell runs the probe as a plain command", async () => {
    const { container, execCalls } = fakeContainer();
    const { sandbox } = createSandbox({ container });
    await expect(sandbox.probeShell("true", { cwd: "/", timeout: 15_000 })).resolves.toMatchObject({ exitCode: 0 });
    expect(execCalls[0].argv).toEqual(["timeout", "--kill-after=5", "15s", "bash", "-c", "true"]);
  });
});

describe("ProjectBuildSandboxV1 files", () => {
  it("writes utf8, base64 and streamed content, creating parent directories", async () => {
    const { container } = fakeContainer();
    const { sandbox, files } = createSandbox({ container });

    await sandbox.writeFile("/workspace/p1/a.txt", "héllo", { encoding: "utf8" });
    await sandbox.writeFile("/workspace/p1/b.bin", btoa("\u0000\u0001ÿ"), { encoding: "base64" });
    await sandbox.writeFile("/workspace/p1.lane-0.tar", new Blob(["tar-bytes"]).stream());

    expect(new TextDecoder().decode(files.files.get("/workspace/p1/a.txt"))).toBe("héllo");
    expect(Array.from(files.files.get("/workspace/p1/b.bin") ?? [])).toEqual([0, 1, 255]);
    expect(new TextDecoder().decode(files.files.get("/workspace/p1.lane-0.tar"))).toBe("tar-bytes");
    expect(files.mkdir).toHaveBeenCalledWith("/workspace/p1", { recursive: true });
  });

  it("reads utf8, base64 and raw bytes", async () => {
    const { container } = fakeContainer();
    const { sandbox } = createSandbox({
      container,
      files: fakeFiles({ "/workspace/p1/bun.lock": "lock", "/workspace/p1/x.bin": new Uint8Array([0, 255]) }),
    });
    await expect(sandbox.readFile("/workspace/p1/bun.lock")).resolves.toEqual({ content: "lock" });
    await expect(sandbox.readFile("/workspace/p1/bun.lock", { encoding: "base64" })).resolves.toEqual({ content: btoa("lock") });
    expect(Array.from(await sandbox.readFileBytes("/workspace/p1/x.bin"))).toEqual([0, 255]);
  });

  it("reports a missing file the way callers treat as a cache miss", async () => {
    const { container } = fakeContainer();
    const { sandbox } = createSandbox({ container });
    const error = await sandbox.readFile("/workspace/p1/bun.lock").catch((cause: unknown) => cause);
    expect(String(error).toLowerCase()).toContain("not found");
    await expect(sandbox.exists("/workspace/p1/bun.lock")).resolves.toEqual({ exists: false });
    await expect(sandbox.exists("/workspace")).resolves.toEqual({ exists: true });
  });

  it("mkdir passes recursive through", async () => {
    const { container } = fakeContainer();
    const { sandbox, files } = createSandbox({ container });
    await sandbox.mkdir("/workspace/a/b", { recursive: true });
    expect(files.mkdir).toHaveBeenCalledWith("/workspace/a/b", { recursive: true });
  });

  it("lists files with one find, recursive or not", async () => {
    const listing = [
      "d\t4096\tassets",
      "f\t12\tindex.html",
      "f\t6\tassets/app.css",
      "f\t3\t.vite/manifest.json",
    ].join("\0") + "\0";
    const { container, execCalls } = fakeContainer({ handler: () => ({ exitCode: 0, stdout: listing }) });
    const { sandbox } = createSandbox({ container });

    const recursive = await sandbox.listFiles("/workspace/p1/build/client/", { recursive: true, includeHidden: true });
    expect(execCalls[0].argv).toEqual([
      "find", "/workspace/p1/build/client", "-mindepth", "1",
      "(", "-type", "f", "-o", "-type", "d", ")",
      "-printf", "%y\\t%s\\t%P\\0",
    ]);
    expect(recursive.files).toContainEqual({
      name: "app.css",
      type: "file",
      relativePath: "assets/app.css",
      absolutePath: "/workspace/p1/build/client/assets/app.css",
      size: 6,
    });
    expect(recursive.files).toHaveLength(4);

    const shallow = await sandbox.listFiles("/workspace/p1/build/client", { includeHidden: false });
    expect(execCalls[1].argv).toContain("-maxdepth");
    expect(shallow.files.map((file) => file.relativePath)).not.toContain(".vite/manifest.json");
  });

  it("fails a listing of a missing directory", async () => {
    const { container } = fakeContainer({
      handler: () => ({ exitCode: 1, stderr: "find: '/workspace/nope': No such file or directory" }),
    });
    const { sandbox } = createSandbox({ container });
    await expect(sandbox.listFiles("/workspace/nope", { recursive: true })).rejects.toThrow("Directory not found");
  });

  it("parses file names that contain tabs", () => {
    expect(parseFindOutput("f\t1\ta\tb.txt\0", "/", true)).toEqual([
      { name: "a\tb.txt", type: "file", relativePath: "a\tb.txt", absolutePath: "/a\tb.txt", size: 1 },
    ]);
  });

  it("serves collectWorkerBundleFromSandbox end to end", async () => {
    const manifest = JSON.stringify({ main: "index.js", no_bundle: true, compatibility_date: "2026-06-01", assets: { directory: "../client" } });
    const store = fakeFiles({
      "/workspace/demo/build/server/wrangler.json": manifest,
      "/workspace/demo/build/server/index.js": "export default {};",
      "/workspace/demo/build/client/index.html": "<html></html>",
    });
    const { container } = fakeContainer({
      handler: (argv) => argv[1] === "/workspace/demo/build/server"
        ? { stdout: `f\t${manifest.length}\twrangler.json\0f\t18\tindex.js\0` }
        : { stdout: "f\t13\tindex.html\0" },
    });
    const { sandbox } = createSandbox({ container, files: store });

    const bundle = await collectWorkerBundleFromSandbox(sandbox as unknown as ProjectBuildSandboxLike, "/workspace/demo");

    expect(bundle.modules.map((module) => module.name)).toEqual(["index.js"]);
    expect(bundle.assets.map((asset) => asset.path)).toEqual(["index.html"]);
    expect(new TextDecoder().decode(await bundle.assets[0].read())).toBe("<html></html>");
  });
});

describe("project build sandbox routing", () => {
  const v0 = { idFromName: vi.fn(), get: vi.fn() };
  const v1 = { getByName: vi.fn((name: string) => ({ name, runtime: "v1" })) };

  it("uses v1 only when the switch says v1 and the binding exists", () => {
    expect(projectBuildSandboxRuntime({ PROJECT_BUILD_SANDBOX_RUNTIME: "v1", PROJECT_BUILD_SANDBOX_V1: v1 } as unknown as Env)).toBe("v1");
    expect(projectBuildSandboxRuntime({ PROJECT_BUILD_SANDBOX_RUNTIME: " V1 ", PROJECT_BUILD_SANDBOX_V1: v1 } as unknown as Env)).toBe("v1");
    expect(projectBuildSandboxRuntime({ PROJECT_BUILD_SANDBOX_RUNTIME: "v1" } as unknown as Env)).toBe("v0");
    expect(projectBuildSandboxRuntime({ PROJECT_BUILD_SANDBOX_RUNTIME: "v0", PROJECT_BUILD_SANDBOX_V1: v1 } as unknown as Env)).toBe("v0");
    expect(projectBuildSandboxRuntime({ PROJECT_BUILD_SANDBOX_V1: v1 } as unknown as Env)).toBe("v0");
  });

  it("addresses the v1 class by the org's sandbox key", () => {
    const stub = getProjectBuildSandbox(
      { PROJECT_BUILD_SANDBOX_RUNTIME: "v1", PROJECT_BUILD_SANDBOX_V1: v1, PROJECT_BUILD_SANDBOX: v0 } as unknown as Env,
      "Org_123",
    );
    expect(v1.getByName).toHaveBeenCalledWith("org-org-123");
    expect(stub).toEqual({ name: "org-org-123", runtime: "v1" });
  });

  it("reports whether any build sandbox is bound", () => {
    expect(hasProjectBuildSandbox({} as Env)).toBe(false);
    expect(hasProjectBuildSandbox({ PROJECT_BUILD_SANDBOX: v0 } as unknown as Env)).toBe(true);
    expect(hasProjectBuildSandbox({ PROJECT_BUILD_SANDBOX_RUNTIME: "v1", PROJECT_BUILD_SANDBOX_V1: v1 } as unknown as Env)).toBe(true);
    expect(() => getProjectBuildSandbox({} as Env, "org")).toThrow("PROJECT_BUILD_SANDBOX container binding is not configured");
  });
});
