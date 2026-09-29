import type { AgentMessage } from "../../../../src/lib/agent-messages";
import { describe, expect, it } from "vitest";

import { piMessagesToParsedMessages } from "../../src/pi-message-export";
import {
  buildResultEventCriterion,
  buildRuntimeEventsCriterion,
  buildSessionCompletedCriterion,
} from "./eval-criteria";
import { evaluateAgentEvalSignal } from "./eval-signal";
import { usedTool } from "./project-eval-helpers";
import { runtimeEvalTimeoutMs } from "./runtime-eval";
import {
  latestAssistantReply,
  localizeRuntimeHistory,
  runtimeEvalEvents,
  runtimeRunOutcome,
  waitForRuntimeRequest,
  type RuntimeRequestRecord,
} from "./runtime-eval-shape";

const history = [
  { role: "user", content: "Write the file", timestamp: 1 },
  {
    role: "assistant",
    content: [
      { type: "text", text: "Writing it." },
      { type: "toolCall", id: "call_1", name: "camel__write", arguments: { location: "project", project: "p", path: "/a.txt", content: "ok" } },
      { type: "toolCall", id: "call_2", name: "js_exec", arguments: { code: "return await tools.camel__list_commits({ project: 'p' });" } },
    ],
    usage: { input: 100, output: 20, cacheRead: 50, cacheWrite: 0, totalTokens: 170, cost: { total: 0.01 } },
    stopReason: "toolUse",
    timestamp: 2,
  },
  { role: "toolResult", toolCallId: "call_1", toolName: "camel__write", content: [{ type: "text", text: "Wrote /a.txt" }], details: { success: true }, isError: false, timestamp: 3 },
  { role: "toolResult", toolCallId: "call_2", toolName: "js_exec", content: [{ type: "text", text: "boom" }], isError: true, timestamp: 4 },
  {
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    usage: { input: 200, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 205 },
    stopReason: "stop",
    timestamp: 5,
  },
] as unknown as AgentMessage[];

describe("runtime eval history", () => {
  it("names chiridion's tools as the in-DO loop did", () => {
    const localized = localizeRuntimeHistory(history) as unknown as Array<Record<string, any>>;
    expect(localized[1].content[1].name).toBe("write");
    expect(localized[1].content[2].name).toBe("js_exec");
    expect(localized[2].toolName).toBe("write");
    // The input is left alone.
    expect((history[1] as unknown as { content: Array<{ name?: string }> }).content[1].name).toBe("camel__write");
  });

  it("rebuilds the chat events the graders and the signal read", () => {
    const messages = localizeRuntimeHistory(history);
    const events = runtimeEvalEvents({
      threadId: "t1",
      messages: messages.slice(1),
      status: "completed",
      reply: "ok",
      startedAtMs: 1_000,
      completedAtMs: 4_000,
    });
    const methods = events.map((event) => (event.event as { method?: string } | undefined)?.method ?? event.type);
    expect(methods).toEqual([
      "sdk/turn/started",
      "item/completed",
      "item/completed",
      "item/completed",
      "sdk/turn/completed",
      "sdk/turn/started",
      "item/completed",
      "sdk/turn/completed",
      "turn/completed",
      "result",
    ]);
    const write = (events[1].event as { params: { item: Record<string, unknown> } }).params.item;
    expect(write).toMatchObject({
      id: "call_1",
      type: "dynamicToolCall",
      tool: "write",
      status: "completed",
      isError: false,
      result: { content: [{ type: "text", text: "Wrote /a.txt" }], details: { success: true } },
    });
    const failed = (events[2].event as { params: { item: Record<string, unknown> } }).params.item;
    expect(failed).toMatchObject({ tool: "js_exec", status: "failed", isError: true });
    expect(events.at(-2)).toMatchObject({
      event: { params: { turnDurationMs: 3_000, sdkTurnCount: 2, usage: { input: 300, output: 25, totalTokens: 375 } } },
    });
    expect(events.at(-1)).toMatchObject({ type: "result", result: "ok", threadId: "t1" });

    const result = {
      status: "completed" as const,
      result: "ok",
      events,
      messages: piMessagesToParsedMessages(messages, "t1"),
    };
    expect(buildSessionCompletedCriterion(result).status).toBe("passed");
    expect(buildRuntimeEventsCriterion(result).status).toBe("passed");
    expect(buildResultEventCriterion(result).status).toBe("passed");
    // Code on the runtime calls tools.camel__<name>: still the tool.
    expect(usedTool(events, "list_commits")).toBe(true);
    const signal = evaluateAgentEvalSignal(result);
    expect(signal.assistantTurnCount).toBe(2);
    expect(signal.sdkTurnStartCount).toBe(2);
    expect(signal.tokenUsage).toMatchObject({ inputTokens: 300, outputTokens: 25, totalTokens: 375 });
  });

  it("marks a call without a result failed and a failed run without a result event", () => {
    const events = runtimeEvalEvents({
      threadId: "t1",
      messages: [history[1]],
      status: "error",
      error: "Agent eval timed out after 1000ms",
      startedAtMs: 0,
      completedAtMs: 1,
    });
    const items = events.flatMap((event) => {
      const item = (event.event as { params?: { item?: Record<string, unknown> } } | undefined)?.params?.item;
      return item ? [item] : [];
    });
    expect(items.filter((item) => item.type === "dynamicToolCall").every((item) => item.status === "failed")).toBe(true);
    expect(events.some((event) => event.type === "result")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "error", message: "Agent eval timed out after 1000ms" });
  });

  it("finds the last thing the agent said", () => {
    expect(latestAssistantReply(history)).toBe("ok");
    expect(latestAssistantReply(history.slice(0, 2))).toBe("Writing it.");
    expect(latestAssistantReply(history.slice(0, 1))).toBeUndefined();
  });
});

describe("runtime eval outcome", () => {
  const record = (overrides: Partial<RuntimeRequestRecord>): RuntimeRequestRecord => ({ id: "r1", state: "completed", ...overrides });

  it("reads a reply, an error, a spend stop and a wait on input", () => {
    expect(runtimeRunOutcome(record({ outcome: { result: { reply: "done" } } }))).toEqual({ status: "completed", reply: "done" });
    expect(runtimeRunOutcome(record({ error: "model refused", outcome: { result: { error: "model refused" } } })))
      .toEqual({ status: "error", error: "model refused", reply: undefined });
    expect(runtimeRunOutcome(record({ outcome: { error: "node lost", uncertain: true } })))
      .toEqual({ status: "error", error: "node lost (outcome uncertain)", reply: undefined });
    expect(runtimeRunOutcome(record({ stopped: "spend_limit", outcome: { result: { stopped: "spend_limit" } } })))
      .toMatchObject({ status: "error", error: "The run reached its spend limit" });
    expect(runtimeRunOutcome(record({
      stopped: "input_required",
      outcome: { result: { stopped: "input_required", inputs: [{ id: "in_1", kind: "question" }] } },
    }))).toEqual({ status: "input_required", inputIds: ["in_1"], reply: undefined });
  });

  it("keeps the in-DO eval's timeout arithmetic", () => {
    expect(runtimeEvalTimeoutMs(undefined)).toBe(120_000);
    expect(runtimeEvalTimeoutMs(10)).toBe(1_000);
    expect(runtimeEvalTimeoutMs(90_500.7)).toBe(90_500);
  });
});

describe("waiting on a runtime request", () => {
  function clock() {
    let now = 0;
    return {
      now: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  }

  it("polls until the request settles", async () => {
    const time = clock();
    const states: Array<RuntimeRequestRecord | null> = [
      null,
      { id: "r1", state: "running" },
      { id: "r1", state: "completed", outcome: { result: { reply: "hi" } } },
    ];
    let reads = 0;
    const wait = await waitForRuntimeRequest({
      read: async () => states[reads++] ?? null,
      deadline: 10_000,
      pollMs: 500,
      ...time,
    });
    expect(wait).toEqual({ status: "settled", record: states[2] });
    expect(reads).toBe(3);
    expect(time.now()).toBe(1_000);
  });

  it("gives up at the deadline with the last record seen", async () => {
    const time = clock();
    const wait = await waitForRuntimeRequest({
      read: async () => ({ id: "r1", state: "running" }),
      deadline: 2_300,
      pollMs: 1_000,
      ...time,
    });
    expect(wait).toEqual({ status: "timeout", record: { id: "r1", state: "running" } });
    // It never sleeps past the deadline.
    expect(time.now()).toBe(2_300);
  });

  it("retries a failed read instead of failing the eval", async () => {
    const time = clock();
    let reads = 0;
    const wait = await waitForRuntimeRequest({
      read: async () => {
        reads += 1;
        if (reads === 1) throw new Error("connection reset");
        return { id: "r1", state: "completed" };
      },
      deadline: 5_000,
      pollMs: 100,
      ...time,
    });
    expect(wait.status).toBe("settled");
    expect(reads).toBe(2);
  });
});
