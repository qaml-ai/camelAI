import { beforeEach, describe, expect, it, vi } from "vitest";

const migrate = vi.fn();
const record = vi.fn();
let env: Record<string, string> = {};
vi.mock("@/lib/cloudflare.server", () => ({ getEnv: () => env }));
vi.mock("../src/agent-runtime/thread-migration", () => ({ migrateThreadToRuntime: migrate }));
vi.mock("../src/agent-runtime/runtime-thread-telemetry", () => ({
  recordRuntimeMigration: record,
  recordRuntimeSendFailure: vi.fn(),
  recordRuntimeTokenMintFailure: vi.fn(),
}));

const { migrateThreadOnOpen } = await import("@/lib/runtime-threads.server");

const context = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
const CONFIGURED = { AGENT_RUNTIME_API_TOKEN: "operator", AGENT_RUNTIME_TENANT: "chiridion", AGENT_RUNTIME_DEFINITION: "def_1", AGENT_RUNTIME_DIRECT_THREADS: "1" };
const ROW = { threadId: "t1", agentId: "agt_new", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };

describe("migrateThreadOnOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    env = { ...CONFIGURED, AGENT_RUNTIME_MIGRATE_DO_THREADS: "1" };
  });

  it("opens a moved thread on the runtime, and records the move", async () => {
    migrate.mockResolvedValue({ status: "migrated", row: ROW, archived: false });
    const waitUntil = vi.fn();
    expect(await migrateThreadOnOpen({} as never, context, waitUntil)).toEqual(ROW);
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(env, context, expect.objectContaining({ status: "migrated" }));
  });

  it("keeps the thread on ChatThreadDO when the move is refused or throws", async () => {
    migrate.mockResolvedValueOnce({ status: "busy", reason: "running" });
    expect(await migrateThreadOnOpen({} as never, context, vi.fn())).toBeNull();
    migrate.mockRejectedValueOnce(new Error("boom"));
    expect(await migrateThreadOnOpen({} as never, context, vi.fn())).toBeNull();
    expect(record).toHaveBeenLastCalledWith(env, context, { status: "failed", error: "boom" });
  });

  it("opens from the DO when the move takes too long, letting it finish in the background", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    migrate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const waitUntil = vi.fn();
    const opened = migrateThreadOnOpen({} as never, context, waitUntil);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await opened).toBeNull();
    finish({ status: "migrated", row: ROW, archived: false });
    await waitUntil.mock.calls[0][0];
    expect(record).toHaveBeenCalledWith(env, context, expect.objectContaining({ status: "migrated" }));
  });

  it("does nothing unless the migration flag is on", async () => {
    env = { ...CONFIGURED };
    expect(await migrateThreadOnOpen({} as never, context, vi.fn())).toBeNull();
    expect(migrate).not.toHaveBeenCalled();
  });
});
