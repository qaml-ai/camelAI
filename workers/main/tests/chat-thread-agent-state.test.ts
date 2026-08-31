import { describe, expect, it, vi } from "vitest";

import { ChatThreadDO } from "../src/chat-thread-do";

function createStateSyncFake(): any {
  const fake = Object.create(ChatThreadDO.prototype) as any;
  fake.hydrateDurableStateOnce = vi.fn();
  fake.agentState = vi.fn(() => ({ ready: true }));
  fake.setState = vi.fn();
  return fake;
}

describe("ChatThreadDO agent state sync", () => {
  it("persists agent state through the Agents SDK", () => {
    const fake = createStateSyncFake();

    ChatThreadDO.prototype["syncAgentState"].call(fake);

    expect(fake.hydrateDurableStateOnce).toHaveBeenCalledTimes(1);
    expect(fake.setState).toHaveBeenCalledWith({ ready: true });
  });

  it("does not hide PartyServer setState failures", () => {
    const fake = createStateSyncFake();
    fake.setState.mockImplementation(() => {
      throw new Error("PartyServer name unavailable");
    });

    expect(() => ChatThreadDO.prototype["syncAgentState"].call(fake)).toThrow(
      "PartyServer name unavailable",
    );

    expect(fake.hydrateDurableStateOnce).toHaveBeenCalledTimes(1);
  });

  it("syncs initial state from onStart instead of the constructor", async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.syncAgentState = vi.fn();

    await ChatThreadDO.prototype.onStart.call(fake);

    expect(fake.syncAgentState).toHaveBeenCalledTimes(1);
  });
});
