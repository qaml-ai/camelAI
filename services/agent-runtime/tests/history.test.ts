import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedContext, reconcileMessages, validateInitialMessages } from "../src/history.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

test("context bounds discard whole older turns without mutating durable history", () => {
  const messages = [
    { role: "user", content: "x".repeat(5000), timestamp: 1 },
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }] },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "old result" }], timestamp: 2 },
    { role: "user", content: "Latest instruction", timestamp: 3 },
  ] as AgentMessage[];
  assert.deepEqual(boundedContext(messages, 2000, ""), messages.slice(3));
  assert.equal(messages.length, 4);
  assert.throws(() => boundedContext(messages.slice(0, 3), 2000, ""), /current turn exceeds/);
});

test("reconciliation preserves settled native results and fills only missing tool ids", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "write", arguments: {} }] },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "verified" }], timestamp: 2 },
  ] as AgentMessage[];
  const reconciled = reconcileMessages(messages);
  assert.equal(reconciled.filter(m => m.role === "toolResult").length, 2);
  assert.equal(reconciled[1], messages[1]);
  assert.equal(reconciled[2].role, "toolResult");
  assert.throws(() => validateInitialMessages([{ role: "system" }] as any), /native/);
});
