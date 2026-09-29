import { beforeEach, describe, expect, it, vi } from "vitest";

const migrate = vi.fn();
const record = vi.fn();
let env: Record<string, string> = {};
vi.mock("@/lib/cloudflare.server", () => ({ getEnv: () => env }));
vi.mock("../src/agent-runtime/thread-migration", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  migrateThreadToRuntime: migrate,
}));
vi.mock("../src/agent-runtime/runtime-thread-telemetry", () => ({
  recordRuntimeMigration: record,
  recordRuntimeSendFailure: vi.fn(),
  recordRuntimeTokenMintFailure: vi.fn(),
}));

const { openUnmovedThread } = await import("@/lib/runtime-threads.server");

const context = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1", userName: "Ada", userEmail: null };
const CONFIGURED = { AGENT_RUNTIME_API_TOKEN: "operator", AGENT_RUNTIME_TENANT: "chiridion", AGENT_RUNTIME_DEFINITION: "def_1" };
const ROW = { threadId: "t1", agentId: "agt_new", model: null, keyScope: null, configured: null, createdAt: 1, updatedAt: 1 };

describe("openUnmovedThread", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    env = { ...CONFIGURED };
  });

  it("opens a moved thread on the runtime, and records the move", async () => {
    migrate.mockResolvedValue({ status: "migrated", row: ROW, archived: false });
    const waitUntil = vi.fn();
    expect(await openUnmovedThread({} as never, context, waitUntil)).toEqual({ state: "runtime", row: ROW });
    expect(waitUntil).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith(env, context, expect.objectContaining({ status: "migrated" }));
  });

  it("shows the thread moving while its move is under way, failed or backing off", async () => {
    migrate.mockResolvedValueOnce({ status: "busy", reason: "moving" });
    expect(await openUnmovedThread({} as never, context, vi.fn())).toEqual({ state: "moving" });
    migrate.mockResolvedValueOnce({ status: "skipped", reason: "backoff: Agent runtime POST /v1/agents: HTTP 503" });
    expect(await openUnmovedThread({} as never, context, vi.fn())).toEqual({ state: "moving" });
    migrate.mockRejectedValueOnce(new Error("boom"));
    expect(await openUnmovedThread({} as never, context, vi.fn())).toEqual({ state: "moving" });
    expect(record).toHaveBeenLastCalledWith(env, context, { status: "failed", error: "boom" });
  });

  it("shows a thread that cannot move read-only, with the reason", async () => {
    migrate.mockResolvedValueOnce({ status: "skipped", reason: "too_large" });
    expect(await openUnmovedThread({} as never, context, vi.fn())).toEqual({ state: "readonly", reason: "too_large" });
    migrate.mockResolvedValueOnce({ status: "skipped", reason: "backoff: invalid_history: Agent runtime POST /v1/agents: HTTP 400" });
    expect(await openUnmovedThread({} as never, context, vi.fn())).toEqual({ state: "readonly", reason: "invalid_history" });
    migrate.mockResolvedValueOnce({ status: "skipped", reason: "no runtime route for its model" });
    expect(await openUnmovedThread({} as never, context, vi.fn())).toEqual({ state: "readonly", reason: "no_route" });
  });

  it("shows the thread moving when the move takes too long, letting it finish in the background", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    migrate.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const waitUntil = vi.fn();
    const opened = openUnmovedThread({} as never, context, waitUntil);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await opened).toEqual({ state: "moving" });
    finish({ status: "migrated", row: ROW, archived: false });
    await waitUntil.mock.calls[0][0];
    expect(record).toHaveBeenCalledWith(env, context, expect.objectContaining({ status: "migrated" }));
  });
});
