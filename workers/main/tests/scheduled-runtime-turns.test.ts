/**
 * Scheduled prompts on the direct runtime path (agent-runtime/scheduled-turns.ts)
 * and the run bookkeeping WorkspaceCronDO keeps for them.
 *
 * Run with: bun run test:workers
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

const { startRuntimeTurnMock, directEnabledMock, directRowMock, moveOnSendMock, runtimeApiMock } = vi.hoisted(() => ({
  startRuntimeTurnMock: vi.fn(),
  directEnabledMock: vi.fn(() => true),
  directRowMock: vi.fn(),
  moveOnSendMock: vi.fn(),
  runtimeApiMock: vi.fn(),
}));

vi.mock("../src/agent-runtime/thread-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  startRuntimeTurn: startRuntimeTurnMock,
  runtimeDirectThreadsEnabled: directEnabledMock,
}));
vi.mock("../src/agent-runtime/thread-migration.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  directRuntimeRow: directRowMock,
  moveThreadForSend: moveOnSendMock,
}));
vi.mock("../src/agent-runtime/runtime-api.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runtimeApi: runtimeApiMock,
}));

import { RUNTIME_AUTOMATION_OUTCOME_INSTRUCTION, startScheduledRuntimeTurn } from "../src/agent-runtime/scheduled-turns";
import type { ChatEnv } from "../src/chat-thread/types";
import type { WorkspaceCronDO } from "../src/workspace-cron";
import { createOrg, createUser, listUserWorkspaces, type TestEnv } from "./test-helpers";

const ROW = { threadId: "t1", agentId: "agt_1", model: "m", keyScope: "hosted", configured: null, createdAt: 1, updatedAt: 1 };
const request = { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "creator-1", runId: "run-1", message: "Summarize the week." };

beforeEach(() => {
  vi.clearAllMocks();
  directEnabledMock.mockReturnValue(true);
  directRowMock.mockResolvedValue(ROW);
  moveOnSendMock.mockResolvedValue({ row: null, outcome: { state: "retrying", retryAt: null, error: "HTTP 503" } });
  runtimeApiMock.mockResolvedValue({ requests: [] });
  startRuntimeTurnMock.mockResolvedValue({ status: "accepted", requestId: "run-1", agentId: "agt_1", fallback: null });
});

describe("startScheduledRuntimeTurn", () => {
  it("starts nothing where the runtime is not configured, or when the thread cannot move there", async () => {
    directEnabledMock.mockReturnValue(false);
    expect(await startScheduledRuntimeTurn({} as ChatEnv, request)).toBeNull();
    directEnabledMock.mockReturnValue(true);
    directRowMock.mockResolvedValue(null);
    expect(await startScheduledRuntimeTurn({} as ChatEnv, request)).toBeNull();
    expect(moveOnSendMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ threadId: "t1", userId: "creator-1" }));
    expect(startRuntimeTurnMock).not.toHaveBeenCalled();
  });

  it("moves a thread still on ChatThreadDO first, then starts the run there", async () => {
    directRowMock.mockResolvedValue(null);
    moveOnSendMock.mockResolvedValue({ row: ROW });
    expect(await startScheduledRuntimeTurn({} as ChatEnv, request)).toEqual({ status: "accepted" });
    expect(startRuntimeTurnMock.mock.calls[0][1]).toMatchObject({ row: ROW });
  });

  it("says a thread that can never move is unmovable, so the scheduler gives the prompt a new one", async () => {
    directRowMock.mockResolvedValue(null);
    moveOnSendMock.mockResolvedValue({ row: null, outcome: { state: "readonly", reason: "too_large" } });
    expect(await startScheduledRuntimeTurn({} as ChatEnv, request)).toEqual({ status: "unmovable", reason: "too_large" });
    expect(startRuntimeTurnMock).not.toHaveBeenCalled();
  });

  it("starts the run as its creator, with the outcome instruction and the run's id", async () => {
    expect(await startScheduledRuntimeTurn({} as ChatEnv, request)).toEqual({ status: "accepted" });
    expect(directRowMock).toHaveBeenCalledWith(expect.anything(), "org1", "t1", { adopt: true });
    const input = startRuntimeTurnMock.mock.calls[0][1];
    expect(input).toMatchObject({
      row: ROW,
      sender: { userId: "creator-1", userName: "Scheduler" },
      clientMessageId: "run-1",
      source: "scheduled prompt",
    });
    expect(input.text).toContain(RUNTIME_AUTOMATION_OUTCOME_INSTRUCTION);
    // The outcome tool as the runtime names it, never the in-DO name.
    expect(input.text).toContain("tools.camel__report_automation_outcome(");
    expect(input.text).not.toMatch(/`report_automation_outcome`/);
    expect(input.text).toContain("Summarize the week.");
  });

  it("is busy while the agent is in a turn, rather than steer into it", async () => {
    runtimeApiMock.mockResolvedValue({ requests: [{ state: "running", method: "prompt" }] });
    expect(await startScheduledRuntimeTurn({} as ChatEnv, request)).toEqual({ status: "busy", error: "Thread is busy with another run" });
    expect(startRuntimeTurnMock).not.toHaveBeenCalled();
  });
});

/** A DO call's rejection, awaited in place (a `.rejects` on a stub call leaves the remote error unhandled). */
async function rejection(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return String(error);
  }
  return "resolved";
}

describe("WorkspaceCronDO scheduled run outcomes for direct threads", () => {
  const testEnv = env as unknown as TestEnv & { WORKSPACE_CRON: DurableObjectNamespace<WorkspaceCronDO> };

  async function startedRun() {
    const { userId } = await createUser(testEnv, `cron-rt-${crypto.randomUUID()}@example.com`, "password123", "Cron Owner");
    const { org } = await createOrg(testEnv, "Cron Org", userId);
    const workspaceId = (await listUserWorkspaces(testEnv, userId, org.id))[0]!.id;
    const cron = testEnv.WORKSPACE_CRON.get(testEnv.WORKSPACE_CRON.idFromName(workspaceId)) as DurableObjectStub<WorkspaceCronDO>;
    const prompt = await cron.createScheduledPrompt({
      workspaceId, name: "Digest", prompt: "Summarize.", cronExpression: "0 9 * * *", createdBy: userId, scheduledByThreadId: "origin",
    });
    const run = await cron.runScheduledPromptNow(workspaceId, prompt.id);
    const runs = await cron.listAutomationRuns(workspaceId, { limitPerAutomation: 5 });
    const runId = runs[`scheduled_prompt:${prompt.id}`]![0]!.id;
    return { cron, workspaceId, promptId: prompt.id, runId, threadId: run!.dispatch.thread_id };
  }

  async function latestRun(cron: DurableObjectStub<WorkspaceCronDO>, workspaceId: string, promptId: string) {
    const runs = await cron.listAutomationRuns(workspaceId, { limitPerAutomation: 5 });
    return runs[`scheduled_prompt:${promptId}`]![0]!;
  }

  it("runs a system prompt on the runtime as the org's owner", async () => {
    const { userId } = await createUser(testEnv, `cron-sys-${crypto.randomUUID()}@example.com`, "password123", "Cron Owner");
    const { org } = await createOrg(testEnv, "Cron Org", userId);
    const workspaceId = (await listUserWorkspaces(testEnv, userId, org.id))[0]!.id;
    const cron = testEnv.WORKSPACE_CRON.get(testEnv.WORKSPACE_CRON.idFromName(workspaceId)) as DurableObjectStub<WorkspaceCronDO>;
    const prompt = await cron.createScheduledPrompt({
      workspaceId, name: "Digest", prompt: "Summarize.", cronExpression: "0 9 * * *", createdBy: "system", scheduledByThreadId: "origin",
    });
    await cron.runScheduledPromptNow(workspaceId, prompt.id);
    expect(startRuntimeTurnMock).toHaveBeenCalledTimes(1);
    expect(startRuntimeTurnMock.mock.calls[0][1]).toMatchObject({ sender: { userId, userName: "Scheduler" } });
  });

  it("gives a prompt whose thread can never move a new thread, and runs it there with a note", async () => {
    const { userId } = await createUser(testEnv, `cron-rehome-${crypto.randomUUID()}@example.com`, "password123", "Cron Owner");
    const { org } = await createOrg(testEnv, "Cron Org", userId);
    const workspaceId = (await listUserWorkspaces(testEnv, userId, org.id))[0]!.id;
    const cron = testEnv.WORKSPACE_CRON.get(testEnv.WORKSPACE_CRON.idFromName(workspaceId)) as DurableObjectStub<WorkspaceCronDO>;
    const prompt = await cron.createScheduledPrompt({
      workspaceId, name: "Digest", prompt: "Summarize.", cronExpression: "0 9 * * *", createdBy: userId, scheduledByThreadId: "origin",
    });
    const oldThreadId = (await cron.listScheduledPrompts(workspaceId)).find((p) => p.id === prompt.id)!.thread_id;
    // The old thread is still on ChatThreadDO and the runtime refuses its history.
    directRowMock.mockResolvedValueOnce(null);
    moveOnSendMock.mockResolvedValueOnce({ row: null, outcome: { state: "readonly", reason: "too_large" } });

    const run = await cron.runScheduledPromptNow(workspaceId, prompt.id);
    const newThreadId = run!.dispatch.thread_id;
    expect(newThreadId).toBeTruthy();
    expect(newThreadId).not.toBe(oldThreadId);
    expect(startRuntimeTurnMock).toHaveBeenCalledTimes(1);
    const input = startRuntimeTurnMock.mock.calls[0][1];
    expect(input.context).toMatchObject({ threadId: newThreadId });
    expect(input.text).toContain(`/chat/${oldThreadId}`);
    expect(input.text).toContain("Summarize.");
    // The prompt runs in the new thread from now on, and the run points at it.
    expect((await cron.listScheduledPrompts(workspaceId)).find((p) => p.id === prompt.id)!.thread_id).toBe(newThreadId);
    expect((await latestRun(cron, workspaceId, prompt.id)).thread_id).toBe(newThreadId);
  });

  it("keeps the reported outcome on the run in progress, once, and finishes the run with it", async () => {
    const { cron, workspaceId, promptId, runId, threadId } = await startedRun();
    expect(await cron.reportScheduledRunOutcome({ workspaceId, threadId, status: "success", summary: "Digest sent" }))
      .toEqual({ status: "success", text: "Automation outcome recorded: success" });
    expect(await rejection(cron.reportScheduledRunOutcome({ workspaceId, threadId, status: "failed", summary: "again" })))
      .toContain("already reported");
    expect(await cron.finishScheduledRun({ workspaceId, runId, completedAt: 5_000 })).toBe(true);
    expect(await latestRun(cron, workspaceId, promptId)).toMatchObject({ status: "success", message: "Digest sent", completed_at: 5_000 });
    // Finished: another end of the same run changes nothing.
    expect(await cron.finishScheduledRun({ workspaceId, runId })).toBe(false);
  });

  it("finishes a run that reported no outcome, or a partial one, or failed, as an error", async () => {
    const silent = await startedRun();
    await silent.cron.finishScheduledRun({ workspaceId: silent.workspaceId, runId: silent.runId });
    expect(await latestRun(silent.cron, silent.workspaceId, silent.promptId)).toMatchObject({
      status: "error", message: "Automation completed without explicitly reporting an outcome",
    });

    const partial = await startedRun();
    await partial.cron.reportScheduledRunOutcome({ workspaceId: partial.workspaceId, threadId: partial.threadId, status: "partial", summary: "2 of 3 sent" });
    await partial.cron.finishScheduledRun({ workspaceId: partial.workspaceId, runId: partial.runId });
    expect(await latestRun(partial.cron, partial.workspaceId, partial.promptId)).toMatchObject({ status: "error", message: "[partial] 2 of 3 sent" });

    const failed = await startedRun();
    await failed.cron.finishScheduledRun({ workspaceId: failed.workspaceId, runId: failed.runId, error: "Provider unavailable" });
    expect(await latestRun(failed.cron, failed.workspaceId, failed.promptId)).toMatchObject({ status: "error", message: "Provider unavailable" });
  });

  it("refuses an outcome when the thread has no scheduled run in progress", async () => {
    const { cron, workspaceId } = await startedRun();
    expect(await rejection(cron.reportScheduledRunOutcome({ workspaceId, threadId: "other-thread", status: "success", summary: "x" })))
      .toContain("No scheduled automation run is active");
  });
});
