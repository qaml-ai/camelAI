import { describe, expect, it } from "vitest";
import { PollConnectionSink } from "../src/chat-thread/poll-connection";
import { createSseQueueBudget, SseConnection } from "../src/chat-thread/sse-connection";

describe("poll receive queue", () => {
  it("retains lost responses until acknowledgement and refuses cursors beyond delivered frames", () => {
    const budget = createSseQueueBudget();
    const sink = new PollConnectionSink(budget);
    sink.send("one");
    sink.send("two");
    expect(sink.read(1)).toBeNull(); // Not yet delivered.
    const first = sink.read(-1);
    expect(first).toEqual({ cursor: 1, frames: ["one", "two"] });
    expect(sink.read(-1)).toEqual(first);
    const retained = budget.total;
    sink.send("three");
    expect(sink.read(1)).toEqual({ cursor: 2, frames: ["three"] });
    expect(budget.total).toBeLessThan(retained);
    expect(sink.read(0)).toBeNull();
    expect(sink.read(2)).toEqual({ cursor: 2, frames: [] });
    expect(budget.total).toBe(0);
  });

  it("bounds response batches without splitting protocol frames", () => {
    const sink = new PollConnectionSink(createSseQueueBudget());
    const frame = "x".repeat(300_000);
    sink.send(frame);
    sink.send(frame);
    expect(sink.read(-1)).toEqual({ cursor: 0, frames: [frame] });
    expect(sink.read(0)).toEqual({ cursor: 1, frames: [frame] });
  });

  it("shares the SSE memory limit, releases it on overflow and expires abandoned clients", () => {
    const budget = createSseQueueBudget(180);
    const sink = new PollConnectionSink(budget);
    const other = new PollConnectionSink(budget);
    let closed = 0;
    const connection = new SseConnection({
      id: "poll", uri: null, server: "thread", sink,
      onTeardown: () => { closed += 1; },
    });
    connection.send("first");
    other.send("other");
    expect(() => connection.send("overflow")).toThrow("send() after close");
    expect(closed).toBe(1);
    expect(sink.read(-1)).toBeNull();
    other.close();
    expect(budget.total).toBe(0);
    const idle = new PollConnectionSink(budget);
    const abandoned = new SseConnection({
      id: "abandoned", uri: null, server: "thread", sink: idle,
      onTeardown: () => { closed += 1; },
    });
    // A quiet empty poll queue still needs a liveness lease.
    idle.stalledFor = () => 61_000;
    expect(abandoned.heartbeat()).toBe(true);
    idle.stalledFor = () => 91_000;
    expect(abandoned.heartbeat()).toBe(false);
    expect(closed).toBe(2);
  });
});
