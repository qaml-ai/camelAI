import { afterEach, describe, expect, it, vi } from "vitest";

import { DB_QUERY_IDLE_TIMEOUT_MS } from "../src/container-sizing";
import type { BucketMount, SandboxBucketMounts } from "../src/sandbox-mounts";
import {
  DB_QUERY_IMAGE,
  DbQueryContainer,
  RELAY_FORWARDER_DIR,
  type DbQueryContainerDeps,
} from "../src/db-query-container";
import { DbQueryContainerUnavailableError, dbQueryContainerKey, getDbQueryContainer } from "../src/db-query-contracts";
import { isTransientDbContainerError } from "../src/db-query-service";
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

const IMAGE = "registry.cloudflare.com/acct/db-query@sha256:current";
const encoder = new TextEncoder();

interface FakeRun {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  delayMs?: number;
}

type ExecHandler = (argv: string[], options: ContainerExecOptions | undefined) => FakeRun;

function fakeProcess(run: FakeRun, pid: number): ExecProcess {
  const exitCode = new Promise<number>((resolve) => {
    if (run.delayMs) setTimeout(() => resolve(run.exitCode ?? 0), run.delayMs);
    else resolve(run.exitCode ?? 0);
  });
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

function fakeContainer(options: { running?: boolean; runningImage?: string; handler?: ExecHandler; startError?: Error } = {}) {
  let running = options.running ?? false;
  let runningImage = options.runningImage ?? IMAGE;
  let nextPid = 100;
  const execCalls: Array<{ argv: string[]; options: ContainerExecOptions | undefined }> = [];
  const handler: ExecHandler = options.handler ?? (() => ({ exitCode: 0 }));
  const container = {
    get running() {
      return running;
    },
    get images() {
      return { [DB_QUERY_IMAGE]: IMAGE };
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
      return fakeProcess(handler(argv, execOptions), nextPid++);
    }),
  };
  return { container, execCalls };
}

function fakeMounts() {
  return {
    kind: "sync" as const,
    mount: vi.fn(async (_mount: BucketMount) => {}),
    flush: vi.fn(async (_mount: BucketMount) => {}),
  } satisfies SandboxBucketMounts;
}

function createContainer(options: {
  container?: ReturnType<typeof fakeContainer>["container"];
  deps?: DbQueryContainerDeps;
  env?: Partial<Env>;
} = {}) {
  const ctx = {
    container: options.container,
    id: { name: "ws-acme", toString: () => "id" },
    exports: {},
    storage: {},
    blockConcurrencyWhile: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
    waitUntil: vi.fn(),
  };
  const mounts = fakeMounts();
  const instance = new DbQueryContainer(
    ctx as unknown as DurableObjectState,
    (options.env ?? {}) as Env,
    { files: {} as never, mounts, ...options.deps },
  );
  return { instance, ctx, mounts };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DbQueryContainer lifecycle", () => {
  it("starts the container lazily, once, with internet and the 2m idle window", async () => {
    const { container } = fakeContainer();
    const { instance } = createContainer({ container });
    expect(container.start).not.toHaveBeenCalled();

    await instance.start();
    await instance.relayForwarderReady();

    expect(container.start).toHaveBeenCalledTimes(1);
    expect(container.start).toHaveBeenCalledWith({ image: IMAGE, instance: "standard-1", enableInternet: true });
    expect(container.setInactivityTimeout).toHaveBeenCalledWith(DB_QUERY_IDLE_TIMEOUT_MS);
  });

  it("re-applies the inactivity timeout when a restarted DO finds its container running", async () => {
    const { container } = fakeContainer({ running: true });
    const { ctx } = createContainer({ container });
    await vi.waitFor(() => expect(container.setInactivityTimeout).toHaveBeenCalledWith(DB_QUERY_IDLE_TIMEOUT_MS));
    expect(ctx.blockConcurrencyWhile).toHaveBeenCalled();
  });

  it("moves a running container from an older image to the current one", async () => {
    const { container } = fakeContainer({ running: true, runningImage: "registry.cloudflare.com/acct/db-query@sha256:old" });
    const { instance } = createContainer({ container });
    await instance.start();
    expect(container.destroy).toHaveBeenCalledTimes(1);
    expect(container.start).toHaveBeenCalledWith(expect.objectContaining({ image: IMAGE }));
  });

  it("reports a container that failed to start as a retryable failure", async () => {
    const { container } = fakeContainer({ startError: new Error("no capacity") });
    const { instance } = createContainer({ container });
    const error = await instance.start().catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(DbQueryContainerUnavailableError);
    expect(String(error)).toContain("DB query container is not running (start): no capacity");
    expect(isTransientDbContainerError(error)).toBe(true);
    // Across the DO RPC hop it arrives as a plain Error with the name in the message.
    const hopped = new Error(`DbQueryContainerUnavailableError: ${(error as Error).message}`);
    expect(DbQueryContainerUnavailableError.is(hopped)).toBe(true);
    expect(isTransientDbContainerError(hopped)).toBe(true);
    expect(DbQueryContainerUnavailableError.is(new Error("DB query container is not running"))).toBe(false);
  });

  it("fails permanently when the image is missing from the container images", async () => {
    const { container } = fakeContainer();
    Object.defineProperty(container, "images", { get: () => ({}) });
    const { instance } = createContainer({ container });
    await expect(instance.start()).rejects.toThrow(/no such image: db-query/);
  });

  it("destroys a running container and says whether there was one", async () => {
    const { container } = fakeContainer();
    const { instance } = createContainer({ container });
    await expect(instance.destroy({ operation: "db_query_setup" })).resolves.toEqual({ destroyed: false });
    await instance.start();
    await expect(instance.destroy({ operation: "db_query_setup", error: "deadline" })).resolves.toEqual({ destroyed: true });
    expect(container.destroy).toHaveBeenCalledTimes(1);
    // The next call starts a fresh container.
    await instance.start();
    expect(container.start).toHaveBeenCalledTimes(2);
  });
});

describe("DbQueryContainer runner and relay forwarder", () => {
  it("pipes the runner into node from the drivers directory under GNU timeout", async () => {
    const { container, execCalls } = fakeContainer({ handler: () => ({ stdout: '{"ok":true}', stderr: "warn" }) });
    const { instance } = createContainer({ container });

    const result = await instance.runRunner({ DB_RUNNER_SRC: "src", DB_QUERY_REQUEST: "{}" }, 45_000);

    expect(result).toEqual({ exitCode: 0, stdout: '{"ok":true}', stderr: "warn", timedOut: false });
    const call = execCalls.at(-1)!;
    expect(call.argv).toEqual([
      "timeout", "--kill-after=5", "45s",
      "bash", "-c", `printf %s "$DB_RUNNER_SRC" | node --input-type=module`,
    ]);
    expect(call.options).toEqual({
      cwd: "/opt/db-query-runner",
      env: { HOME: "/root", LANG: "C.UTF-8", DB_RUNNER_SRC: "src", DB_QUERY_REQUEST: "{}" },
    });
  });

  it("says the bound fired only when the runner ran that long", async () => {
    const slow = fakeContainer({ handler: () => ({ exitCode: 124, delayMs: 30 }) });
    await expect(createContainer({ container: slow.container }).instance.runRunner({}, 20))
      .resolves.toMatchObject({ exitCode: 124, timedOut: true });

    const quick = fakeContainer({ handler: () => ({ exitCode: 124 }) });
    await expect(createContainer({ container: quick.container }).instance.runRunner({}, 60_000))
      .resolves.toMatchObject({ exitCode: 124, timedOut: false });
  });

  it("starts the forwarder through the ensure script with the relay in env, not argv, without waiting", async () => {
    const { container, execCalls } = fakeContainer({ handler: () => ({ delayMs: 60_000 }) });
    const { instance } = createContainer({ container });

    await instance.startRelayForwarder({ hostname: "relay.example", accessClientId: "id", accessClientSecret: "secret" });

    const call = execCalls.at(-1)!;
    expect(call.argv.slice(0, 2)).toEqual(["bash", "-c"]);
    expect(call.argv[2]).toContain("flock 9");
    expect(call.argv[2]).toContain("setsid");
    expect(call.argv.slice(3)).toEqual([
      "ensure-process",
      RELAY_FORWARDER_DIR,
      'exec cloudflared access tcp --hostname "$DB_RELAY_HOSTNAME" --url 127.0.0.1:11080',
    ]);
    expect(call.argv.join(" ")).not.toContain("secret");
    expect(call.options).toMatchObject({
      stdout: "ignore",
      stderr: "ignore",
      env: {
        HOME: "/root",
        LANG: "C.UTF-8",
        DB_RELAY_HOSTNAME: "relay.example",
        TUNNEL_SERVICE_TOKEN_ID: "id",
        TUNNEL_SERVICE_TOKEN_SECRET: "secret",
      },
    });
  });

  it("omits the Access token when the relay has none", async () => {
    const { container, execCalls } = fakeContainer();
    const { instance } = createContainer({ container });
    await instance.startRelayForwarder({ hostname: "relay.example" });
    expect(execCalls.at(-1)!.options?.env).not.toHaveProperty("TUNNEL_SERVICE_TOKEN_ID");
  });

  it("probes the forwarder's local port with a bounded connect", async () => {
    const { container, execCalls } = fakeContainer({ handler: () => ({ exitCode: 1 }) });
    const { instance } = createContainer({ container });
    await expect(instance.relayForwarderReady()).resolves.toBe(false);
    expect(execCalls.at(-1)!.argv).toEqual([
      "timeout", "5s", "bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/11080",
    ]);
  });
});

describe("DbQueryContainer warehouse exports", () => {
  const MOUNT = {
    binding: "WAREHOUSE_EXPORT_BUCKET",
    keyPrefix: "warehouse/ws-1",
    mountPath: "/warehouse/ws-1",
    access: "write-only",
  };

  it("mounts the workspace prefix write-only in a started container and flushes it on publish", async () => {
    const { container } = fakeContainer();
    const { instance, mounts } = createContainer({ container });

    await instance.prepareWarehouseExport("warehouse/ws-1");
    await instance.publishWarehouseExport("warehouse/ws-1", "/warehouse/ws-1/x.parquet");

    expect(container.start).toHaveBeenCalledTimes(1);
    expect(mounts.mount).toHaveBeenCalledWith(MOUNT);
    expect(mounts.flush).toHaveBeenCalledWith(MOUNT);
  });

  it.each(["", "/warehouse/ws-1", "warehouse/ws-1/", "warehouse/../ws-2"])("rejects the prefix %j", async (prefix) => {
    const { instance } = createContainer({ container: fakeContainer().container });
    await expect(instance.prepareWarehouseExport(prefix)).rejects.toThrow(/Invalid warehouse export prefix/);
  });

  it("refuses to publish outside the workspace prefix", async () => {
    const { instance, mounts } = createContainer({ container: fakeContainer().container });
    await expect(instance.publishWarehouseExport("warehouse/ws-1", "/warehouse/ws-2/q.parquet")).rejects.toThrow(/outside/);
    await expect(instance.publishWarehouseExport("warehouse/ws-1", "/warehouse/ws-1/../ws-2/q.parquet")).rejects.toThrow(/outside/);
    expect(mounts.flush).not.toHaveBeenCalled();
  });

  it("uses S3Mount through the exported S3Gateway on Cloudflare and a sync mount on self-host", async () => {
    const { container } = fakeContainer();
    const ctx = { container, id: { name: "ws-1" }, exports: {}, blockConcurrencyWhile: vi.fn() };
    const cloud = new DbQueryContainer(ctx as unknown as DurableObjectState, {} as Env, { files: {} as never });
    await expect(cloud.prepareWarehouseExport("warehouse/ws-1")).rejects.toThrow(/must export S3Gateway/);

    const files = { mkdir: vi.fn(async () => {}), stat: vi.fn(), readFile: vi.fn(), remove: vi.fn(), writeFile: vi.fn(), rename: vi.fn() };
    const selfhost = new DbQueryContainer(
      ctx as unknown as DurableObjectState,
      { CF_ACCOUNT_ID: "selfhost", WAREHOUSE_EXPORT_BUCKET: {} as R2Bucket } as unknown as Env,
      { files },
    );
    await selfhost.prepareWarehouseExport("warehouse/ws-1");
    expect(files.mkdir).toHaveBeenCalledWith("/warehouse/ws-1", { recursive: true });
  });
});

describe("getDbQueryContainer", () => {
  it("opens a workspace's instance by its lowercased key, as 0.12 normalized it", () => {
    const namespace = { getByName: vi.fn(() => ({ id: "stub" })) };
    expect(dbQueryContainerKey("ABC")).toBe("ws-abc");
    expect(getDbQueryContainer({ DB_QUERY_SANDBOX: namespace as never }, "ws-ABC")).toEqual({ id: "stub" });
    expect(namespace.getByName).toHaveBeenCalledWith("ws-abc");
  });

  it("fails loudly when the binding is missing", () => {
    expect(() => getDbQueryContainer({}, "ws-abc")).toThrow(/DB_QUERY_SANDBOX container binding/);
  });
});
