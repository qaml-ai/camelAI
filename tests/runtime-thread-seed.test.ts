import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mint, history, tokenFailure, historyFailure } = vi.hoisted(() => ({
  mint: vi.fn(), history: vi.fn(), tokenFailure: vi.fn(), historyFailure: vi.fn(),
}));
vi.mock("@/lib/auth.server", () => ({ requireSession: vi.fn() }));
vi.mock("@/lib/cloudflare.server", () => ({ getEnv: vi.fn() }));
vi.mock("@/lib/auth-helpers", () => ({ getAuthEnv: vi.fn() }));
vi.mock("../workers/main/src/agent-runtime/thread-runtime", () => ({
  mintRuntimeBrowserToken: mint, runtimeHistoryPage: history, pinNewThreadToRuntime: vi.fn(), prewarmThreadAgent: vi.fn(),
}));
vi.mock("../workers/main/src/agent-runtime/thread-migration", () => ({ classifyMove: vi.fn(), migrateThreadToRuntime: vi.fn() }));
vi.mock("../workers/main/src/agent-runtime/runtime-thread-telemetry", () => ({
  recordRuntimeMigration: vi.fn(), recordRuntimeTokenMintFailure: tokenFailure, recordRuntimeSeedHistoryFailure: historyFailure,
}));
import { loadRuntimeThreadSeed } from "@/lib/runtime-threads.server";

const token = { token: "browser-token", expiresAt: 1234, url: "https://runtime.test" };
const page = { entries: [{ index: 0, message: { role: "user", content: "hello" } }], next: null };
const input = { orgId: "o", workspaceId: "w", threadId: "t", userId: "u", row: { agentId: "agent" } };
const env = { ORG: { idFromName: (id: string) => id, get: () => ({ getThreadUiState: async () => null, getThread: async () => null }) } };
const load = () => loadRuntimeThreadSeed(env as never, input as never);
function waitForAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  mint.mockResolvedValue(token);
  history.mockResolvedValue(page);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("runtime thread seed", () => {
  it("keeps successful token and history", async () => {
    expect(await load()).toMatchObject({ seed: { token: token.token, page }, error: null });
  });
  it("retries a timed out GET once immediately within the 12s budget", async () => {
    history.mockImplementationOnce((_env, _id, options) => waitForAbort(options.signal));
    const pending = load();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toMatchObject({ seed: { token: token.token, page }, error: null });
    expect(history).toHaveBeenCalledTimes(2);
    expect(historyFailure).toHaveBeenCalledWith(env, input, expect.objectContaining({ name: "TimeoutError" }));
  });
  it("returns a null page and the successful token after 12s of stalled history", async () => {
    history.mockImplementation((_env, _id, options) => waitForAbort(options.signal));
    const pending = load();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await pending).toMatchObject({ seed: { token: token.token, page: null }, error: null });
    expect(history).toHaveBeenCalledTimes(2);
    expect(historyFailure).toHaveBeenCalledTimes(2);
  });
  it("falls back without retrying non-timeout history failures", async () => {
    history.mockRejectedValue(new Error("503"));
    expect(await load()).toMatchObject({ seed: { token: token.token, page: null }, error: null });
    expect(history).toHaveBeenCalledTimes(1);
  });
  it("does not retry if a delayed timeout leaves less than 1s", async () => {
    history.mockImplementation(async (_env, _id, options) => {
      await waitForAbort(options.signal).catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 3_500));
      throw options.signal.reason;
    });
    const pending = load();
    await vi.advanceTimersByTimeAsync(11_500);
    expect(await pending).toMatchObject({ seed: { token: token.token, page: null }, error: null });
    expect(history).toHaveBeenCalledTimes(1);
  });
  it("preserves the token error behavior and bounds minting to 8s without retry", async () => {
    mint.mockImplementation((_env, _row, _user, _proxy, signal) => waitForAbort(signal));
    const pending = load();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(await pending).toMatchObject({ seed: { token: null }, error: expect.stringContaining("Can't reach") });
    expect(mint).toHaveBeenCalledTimes(1);
    expect(tokenFailure).toHaveBeenCalledWith(env, input, "page_seed", { error: expect.objectContaining({ name: "TimeoutError" }) });
  });
});
