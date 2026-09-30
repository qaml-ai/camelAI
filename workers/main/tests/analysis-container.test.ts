import { describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_BASE_ENV,
  ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE,
  ANALYSIS_IMAGE,
  ANALYSIS_OUTPUT_CAP_BYTES,
  AnalysisConnectionsGateway,
  AnalysisContainer,
  analysisEgressAllows,
  type AnalysisAccess,
} from "../src/analysis-container";
import { ANALYSIS_IDLE_TIMEOUT_MS, ANALYSIS_INSTANCE_TYPE } from "../src/container-sizing";
import type { BucketMount, SandboxBucketMounts } from "../src/sandbox-mounts";
import type { Env } from "../src/types";

// The runtime's DurableObject / WorkerEntrypoint bases only accept real state;
// the classes under test only need `ctx` and `env` set.
vi.mock("cloudflare:workers", async (importOriginal) => {
  const original = await importOriginal<typeof import("cloudflare:workers")>();
  class DurableObject {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  }
  class WorkerEntrypoint {
    constructor(
      protected ctx: unknown,
      protected env: unknown,
    ) {}
  }
  return { ...original, DurableObject, WorkerEntrypoint };
});

const IMAGE = "registry.cloudflare.com/acct/analysis@sha256:current";
const AGENT: AnalysisAccess = { mode: "agent", orgId: "org-1", workspaceId: "ws-1" };
const APP: AnalysisAccess = { mode: "app", workspaceId: "ws-1" };
const encoder = new TextEncoder();

interface FakeRun {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Pretend the command took this long (drives the elapsed-time check). */
  delayMs?: number;
  /** The container stops under the command. */
  stops?: boolean;
}

type ExecHandler = (argv: string[], options: ContainerExecOptions | undefined) => FakeRun;

function streamOf(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      if (text) controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** Everything the container was asked to do, in order. */
type Step = string;

function fakeContainer(options: { running?: boolean; runningImage?: string; handler?: ExecHandler } = {}) {
  let running = options.running ?? false;
  let runningImage = options.runningImage ?? IMAGE;
  const steps: Step[] = [];
  const execCalls: Array<{ argv: string[]; options: ContainerExecOptions | undefined }> = [];
  const handler: ExecHandler = options.handler ?? (() => ({ exitCode: 0 }));
  const container = {
    get running() {
      return running;
    },
    get images() {
      return { [ANALYSIS_IMAGE]: IMAGE };
    },
    start: vi.fn((start?: ContainerStartupOptions) => {
      if (running) throw new Error("already running");
      running = true;
      runningImage = start?.image ?? "";
      steps.push(`start internet=${String(start?.enableInternet)}`);
    }),
    destroy: vi.fn(async () => {
      running = false;
      steps.push("destroy");
    }),
    setInactivityTimeout: vi.fn(async (_ms: number | bigint) => {}),
    inspect: vi.fn(async () => (running ? { image: runningImage, labels: {} } : null)),
    interceptOutboundHttp: vi.fn(async (host: string, fetcher: { props?: unknown }) => {
      steps.push(`http ${host} ${JSON.stringify(fetcher.props)}`);
    }),
    interceptAllOutboundHttp: vi.fn(async (fetcher: { props?: unknown }) => {
      steps.push(`http * ${JSON.stringify(fetcher.props)}`);
    }),
    interceptOutboundHttps: vi.fn(async (host: string, fetcher: { props?: unknown }) => {
      steps.push(`https ${host} ${JSON.stringify(fetcher.props)}`);
    }),
    exec: vi.fn(async (argv: string[], execOptions?: ContainerExecOptions) => {
      execCalls.push({ argv, options: execOptions });
      if (!running) throw new Error("container is not running");
      if (argv[0] === "sh" && argv[2]?.includes("cloudflare-containers-ca.crt")) steps.push("trust");
      const run = handler(argv, execOptions);
      if (run.stops) {
        running = false;
        throw new Error("Network connection lost.");
      }
      const exitCode = run.delayMs
        ? new Promise<number>((resolve) => setTimeout(() => resolve(run.exitCode ?? 0), run.delayMs))
        : Promise.resolve(run.exitCode ?? 0);
      return {
        stdin: null,
        stdout: streamOf(run.stdout ?? ""),
        stderr: streamOf(run.stderr ?? ""),
        pid: 1,
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
    }),
  };
  return { container, steps, execCalls };
}

function fakeMounts(steps: Step[], failing: (mount: BucketMount) => boolean = () => false) {
  const mounts: SandboxBucketMounts & { mounted: BucketMount[]; flushed: BucketMount[] } = {
    kind: "live",
    mounted: [],
    flushed: [],
    async mount(mount) {
      if (failing(mount)) throw new Error(`mount ${mount.mountPath} failed`);
      mounts.mounted.push(mount);
      steps.push(`mount ${mount.mountPath} ${mount.access} ${mount.keyPrefix}`);
    },
    async flush(mount) {
      mounts.flushed.push(mount);
    },
  };
  return mounts;
}

function fakeFiles() {
  const written = new Map<string, unknown>();
  return {
    written,
    mkdir: vi.fn(async () => {}),
    writeFile: vi.fn(async (path: string, content: unknown) => {
      written.set(path, content);
    }),
    readFile: vi.fn(async () => new Response("body")),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    stat: vi.fn(async () => ({ type: "file", size: 4n }) as never),
  };
}

function build(options: {
  name?: string;
  running?: boolean;
  runningImage?: string;
  stored?: Record<string, unknown>;
  handler?: ExecHandler;
  failingMount?: (mount: BucketMount) => boolean;
  env?: Record<string, unknown>;
} = {}) {
  const { container, steps, execCalls } = fakeContainer(options);
  const mounts = fakeMounts(steps, options.failingMount);
  const files = fakeFiles();
  const storage = new Map<string, unknown>(Object.entries(options.stored ?? {}));
  const events: string[] = [];
  const ctx = {
    container,
    id: { name: options.name ?? "ws-1", toString: () => "id" },
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, value: unknown) => {
        storage.set(key, value);
      }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
    },
    blockConcurrencyWhile: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    waitUntil: vi.fn(),
    exports: {
      AnalysisEgress: ({ props }: { props: unknown }) => ({ props }),
      AnalysisConnectionsGateway: ({ props }: { props: unknown }) => ({ props }),
    },
  };
  const env = {
    WAREHOUSE_EXPORT_BUCKET: {},
    R2_BUCKET: {},
    OBSERVABILITY_EVENTS: {
      writeDataPoint: (point: { blobs: string[] }) => events.push(`${point.blobs[0]}:${point.blobs[4]}`),
    },
    ...options.env,
  } as unknown as Env;
  const sandbox = new AnalysisContainer(ctx as unknown as DurableObjectState, env, { files, mounts });
  return { sandbox, container, steps, execCalls, mounts, files, storage, events, ctx };
}

describe("AnalysisContainer setup", () => {
  it("starts with the internet off, then mounts, connections, the catch-all and the CA, in that order", async () => {
    const { sandbox, container, steps, storage } = build();

    await sandbox.prepare(AGENT);

    expect(container.start).toHaveBeenCalledWith({
      image: IMAGE,
      instance: ANALYSIS_INSTANCE_TYPE,
      enableInternet: false,
    });
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(ANALYSIS_IDLE_TIMEOUT_MS);
    expect(steps).toEqual([
      "start internet=false",
      "mount /warehouse/ws-1 read-only warehouse/ws-1",
      "mount /uploads read-only org-1/ws-1/user-uploads",
      "mount /outputs read-write org-1/ws-1/user-outputs",
      'http connections.internal {"orgId":"org-1","workspaceId":"ws-1"}',
      'http * {"allowPypi":true}',
      'https * {"allowPypi":true}',
      "trust",
    ]);
    expect(storage.get("analysis-container-setup")).toEqual({
      access: AGENT,
      mounts: ["/warehouse/ws-1", "/uploads", "/outputs"],
    });
  });

  it("gives the app container only the export mount, no connections and no PyPI", async () => {
    const { sandbox, steps } = build({ name: "app-ws-1" });

    await sandbox.prepare(APP);

    expect(steps).toEqual([
      "start internet=false",
      "mount /warehouse/ws-1 read-only warehouse/ws-1",
      'http * {"allowPypi":false}',
      'https * {"allowPypi":false}',
      "trust",
    ]);
  });

  it("refuses access that does not match the container's name", async () => {
    const agentNamed = build({ name: "ws-1" });
    await expect(agentNamed.sandbox.prepare(APP)).rejects.toThrow(/cannot serve app access/);
    const otherWorkspace = build({ name: "ws-2" });
    await expect(otherWorkspace.sandbox.prepare(AGENT)).rejects.toThrow(/cannot serve agent access/);
    expect(agentNamed.container.start).not.toHaveBeenCalled();
    expect(otherWorkspace.container.start).not.toHaveBeenCalled();
  });

  it("fails the setup, and stops the container, when a required mount fails", async () => {
    const { sandbox, container, storage } = build({ failingMount: (mount) => mount.mountPath === "/uploads" });

    await expect(sandbox.prepare(AGENT)).rejects.toThrow("mount /uploads failed");

    expect(container.destroy).toHaveBeenCalledTimes(1);
    expect(container.running).toBe(false);
    expect(storage.has("analysis-container-setup")).toBe(false);
  });

  it("carries on without /outputs when only that mount fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { sandbox, storage, events } = build({ failingMount: (mount) => mount.mountPath === "/outputs" });

      await sandbox.prepare(AGENT);

      expect((storage.get("analysis-container-setup") as { mounts: string[] }).mounts)
        .toEqual(["/warehouse/ws-1", "/uploads"]);
      expect(events).toContain("analysis_mount_failed:");
    } finally {
      error.mockRestore();
    }
  });

  it("fails the setup when the container never trusts the intercept CA", async () => {
    const { sandbox, container } = build({
      handler: (argv) => (argv[0] === "sh" ? { exitCode: 124, stderr: "timed out" } : { exitCode: 0 }),
    });
    await expect(sandbox.prepare(AGENT)).rejects.toThrow(/did not trust the intercept CA/);
    expect(container.destroy).toHaveBeenCalled();
  });

  it("reuses a running container set up for the same access, re-checking its mounts", async () => {
    const { sandbox, container, mounts } = build({
      running: true,
      stored: { "analysis-container-setup": { access: AGENT, mounts: ["/warehouse/ws-1", "/uploads"] } },
    });

    await sandbox.prepare(AGENT);
    await sandbox.prepare(AGENT);

    expect(container.start).not.toHaveBeenCalled();
    expect(container.destroy).not.toHaveBeenCalled();
    // Only the mounts the container was set up with, once per prepare.
    expect(mounts.mounted.map((mount) => mount.mountPath)).toEqual([
      "/warehouse/ws-1", "/uploads", "/warehouse/ws-1", "/uploads",
    ]);
  });

  it("replaces a running container it cannot vouch for", async () => {
    const unknown = build({ running: true });
    await unknown.sandbox.prepare(AGENT);
    expect(unknown.steps.slice(0, 2)).toEqual(["destroy", "start internet=false"]);

    const oldImage = build({
      running: true,
      runningImage: "registry.cloudflare.com/acct/analysis@sha256:old",
      stored: { "analysis-container-setup": { access: AGENT, mounts: [] } },
    });
    await oldImage.sandbox.prepare(AGENT);
    expect(oldImage.steps.slice(0, 2)).toEqual(["destroy", "start internet=false"]);
  });

  it("replaces the container once when a mount cannot be repaired in place", async () => {
    let broken = true;
    const { sandbox, container, steps } = build({
      running: true,
      stored: { "analysis-container-setup": { access: AGENT, mounts: ["/warehouse/ws-1", "/uploads", "/outputs"] } },
      failingMount: (mount) => {
        if (mount.mountPath !== "/uploads" || !broken) return false;
        broken = false;
        return true;
      },
    });

    await sandbox.prepare(AGENT);

    expect(container.destroy).toHaveBeenCalledTimes(1);
    expect(container.start).toHaveBeenCalledTimes(1);
    expect(steps.filter((step) => step.startsWith("http *"))).toHaveLength(1);
  });

  it("shares one setup between concurrent callers", async () => {
    const { sandbox, container } = build();
    await Promise.all([sandbox.prepare(AGENT), sandbox.prepare(AGENT), sandbox.prepare(AGENT)]);
    expect(container.start).toHaveBeenCalledTimes(1);
  });

  it("re-applies the inactivity timeout when a DO restarts onto a running container", () => {
    const { container, ctx } = build({ running: true });
    expect(ctx.blockConcurrencyWhile).toHaveBeenCalledTimes(1);
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(ANALYSIS_IDLE_TIMEOUT_MS);
  });
});

describe("AnalysisContainer commands", () => {
  async function prepared(handler: ExecHandler) {
    const built = build({ handler });
    await built.sandbox.prepare(AGENT);
    return built;
  }

  it("runs bash -c under GNU timeout with the stack's env, the caller's env and cwd", async () => {
    const { sandbox, execCalls } = await prepared(() => ({ exitCode: 0, stdout: "42\n" }));

    const result = await sandbox.exec("python -c 'print(42)'", {
      cwd: "/scratch/s1",
      timeoutMs: 1500,
      env: { SCRATCH: "/scratch/s1" },
    });

    expect(result).toEqual({ exitCode: 0, stdout: "42\n", stderr: "", timedOut: false });
    const call = execCalls.at(-1)!;
    expect(call.argv).toEqual(["timeout", "--kill-after=5", "1.5s", "bash", "-c", "python -c 'print(42)'"]);
    expect(call.options).toEqual({
      cwd: "/scratch/s1",
      env: { ...ANALYSIS_BASE_ENV, SCRATCH: "/scratch/s1" },
    });
    // What the image's ENV lines set, since exec() does not see them.
    expect(call.options?.env).toMatchObject({
      PATH: expect.stringMatching(/^\/opt\/analysis-venv\/bin:/),
      PYTHONPATH: "/opt/camelai-python",
      UV_CACHE_DIR: "/opt/uv-cache",
      HOME: "/root",
      SSL_CERT_FILE: "/etc/ssl/certs/ca-certificates.crt",
    });
  });

  it("reports a command it stopped at the deadline as timed out", async () => {
    const { sandbox } = await prepared((argv) => (argv[0] === "timeout" ? { exitCode: 124, delayMs: 20, stdout: "partial" } : {}));
    const result = await sandbox.exec("sleep 60", { cwd: "/", timeoutMs: 10 });
    expect(result).toEqual({ exitCode: 124, stdout: "partial", stderr: "", timedOut: true });
  });

  it("leaves a command that exits 124 by itself as an ordinary exit", async () => {
    const { sandbox } = await prepared((argv) => (argv[0] === "timeout" ? { exitCode: 124 } : {}));
    const result = await sandbox.exec("exit 124", { cwd: "/", timeoutMs: 60_000 });
    expect(result.timedOut).toBe(false);
  });

  it("keeps the tail of output past the cap", async () => {
    const big = `${"x".repeat(ANALYSIS_OUTPUT_CAP_BYTES)}THE END`;
    const { sandbox } = await prepared((argv) => (argv[0] === "timeout" ? { stderr: big } : {}));
    const result = await sandbox.exec("noisy", { cwd: "/", timeoutMs: 60_000 });
    expect(result.stderr.startsWith("[... 7 earlier bytes truncated ...]\n")).toBe(true);
    expect(result.stderr.endsWith("THE END")).toBe(true);
  });

  it("turns a container that stopped under a command into the restart message", async () => {
    const { sandbox, events } = await prepared((argv) => (argv[0] === "timeout" ? { stops: true } : {}));
    await expect(sandbox.exec("python oom.py", { cwd: "/", timeoutMs: 60_000 }))
      .rejects.toThrow(ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE);
    expect(events).toContain("analysis_container_stopped:failed");
    // It does not quietly start a fresh container for the rest of the run.
    await expect(sandbox.mkdir("/scratch/x")).rejects.toThrow(ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE);
  });

  it("writes files through Files, creating the parent directory", async () => {
    const { sandbox, files } = await prepared(() => ({}));
    await sandbox.writeFile("/projects/p/runs/r/src/main.py", "print(1)");
    expect(files.mkdir).toHaveBeenCalledWith("/projects/p/runs/r/src", { recursive: true });
    expect(files.written.get("/projects/p/runs/r/src/main.py")).toBe("print(1)");
  });

  it("opens a file as a stream with its size", async () => {
    const { sandbox } = await prepared(() => ({}));
    const opened = await sandbox.openFile("/projects/p/runs/r/out.csv");
    expect(opened.size).toBe(4);
    expect(await new Response(opened.stream).text()).toBe("body");
  });

  it("removes run dirs, never starting a container to do it", async () => {
    const idle = build();
    await idle.sandbox.removePaths(["/scratch/s1"]);
    expect(idle.container.start).not.toHaveBeenCalled();
    expect(idle.execCalls).toHaveLength(0);

    const { sandbox, execCalls } = await prepared(() => ({}));
    await sandbox.removePaths(["/projects/p/runs/r", "/scratch/r"]);
    expect(execCalls.at(-1)!.argv.at(-1)).toBe("rm -rf -- '/projects/p/runs/r' '/scratch/r'");
    await expect(sandbox.removePaths(["/etc"])).rejects.toThrow(/Refusing/);
    await expect(sandbox.removePaths(["/scratch/../etc"])).rejects.toThrow(/Refusing/);
  });

  it("flushes writable mounts only when they are not live", async () => {
    const live = await prepared(() => ({}));
    await live.sandbox.flushMounts();
    expect(live.mounts.flushed).toEqual([]);

    const sync = build();
    (sync.mounts as { kind: string }).kind = "sync";
    await sync.sandbox.prepare(AGENT);
    await sync.sandbox.flushMounts();
    expect(sync.mounts.flushed.map((mount) => mount.mountPath)).toEqual(["/outputs"]);
  });

  it("destroy() stops the container and forgets its setup", async () => {
    const { sandbox, container, storage } = await prepared(() => ({}));
    await sandbox.destroy();
    expect(container.running).toBe(false);
    expect(storage.has("analysis-container-setup")).toBe(false);
  });
});

describe("analysis egress", () => {
  const allows = (url: string, allowPypi: boolean) => analysisEgressAllows(new URL(url), { allowPypi });

  it("forwards PyPI over HTTPS for the agent container only", () => {
    expect(allows("https://pypi.org/simple/tabulate/", true)).toBe(true);
    expect(allows("https://files.pythonhosted.org/packages/x.whl", true)).toBe(true);
    expect(allows("https://PyPI.org./simple/", true)).toBe(true);
    expect(allows("https://pypi.org/simple/", false)).toBe(false);
  });

  it("refuses everything else", () => {
    expect(allows("http://pypi.org/simple/", true)).toBe(false);
    expect(allows("https://example.com/", true)).toBe(false);
    expect(allows("https://pypi.org.evil.com/", true)).toBe(false);
    expect(allows("https://evil.com/pypi.org", true)).toBe(false);
    expect(allows("http://connections.internal/", true)).toBe(false);
    expect(analysisEgressAllows(new URL("https://pypi.org/"), undefined)).toBe(false);
  });
});

describe("AnalysisConnectionsGateway", () => {
  it("fails closed (401) without the scope set at registration", async () => {
    const gateway = new AnalysisConnectionsGateway({ props: undefined } as never, {} as never);
    const response = await gateway.fetch(new Request("http://connections.internal/", { method: "POST", body: "{}" }));
    expect(response.status).toBe(401);
    const body = (await response.json()) as { ok: boolean; error: { message: string } };
    expect(body).toMatchObject({ ok: false, error: { message: expect.stringMatching(/scope/) } });
  });

  it("serves the protocol descriptor with the scope set at registration", async () => {
    const gateway = new AnalysisConnectionsGateway(
      { props: { orgId: "org-1", workspaceId: "ws-1" } } as never,
      {} as never,
    );
    const response = await gateway.fetch(new Request("http://connections.internal/", { method: "GET" }));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; actions: string[] };
    expect(body.ok).toBe(true);
    expect(body.actions).toContain("invoke");
  });
});
