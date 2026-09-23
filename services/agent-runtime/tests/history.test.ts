import { test } from "node:test";
import assert from "node:assert/strict";
import { boundedContext, recoverInterruptedTurn, validateInitialMessages, validateUserMessages } from "../src/history.ts";
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

test("interrupted-turn recovery preserves settled native results and marks only missing tool ids unknown", () => {
  const messages = [
    { role: "assistant", content: [{ type: "toolCall", id: "a", name: "read", arguments: {} }, { type: "toolCall", id: "b", name: "write", arguments: {} }] },
    { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "verified" }], timestamp: 2 },
  ] as AgentMessage[];
  const recovered = recoverInterruptedTurn(messages);
  assert.equal(recovered.filter((m: AgentMessage) => m.role === "toolResult").length, 2);
  assert.equal(recovered[1], messages[1]);
  assert.equal(recovered[2].role, "toolResult");
  assert.match(JSON.stringify(recovered[2]), /outcome is unknown/);
  assert.equal(recovered.at(-1)!.role, "user");
  assert.throws(() => validateInitialMessages([{ role: "system" }] as any), /native/);
});

test("scoped callers can submit user text and images but never assistant or tool history", () => {
  validateUserMessages([{ role: "user", content: "hi", timestamp: 1 }, { role: "user", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], timestamp: 2 }] as AgentMessage[]);
  assert.throws(() => validateUserMessages([{ role: "assistant", content: [], timestamp: 1 }] as any), /Only user messages/);
  assert.throws(() => validateUserMessages([{ role: "toolResult", toolCallId: "x", toolName: "y", content: [], timestamp: 1 }] as any), /Only user messages/);
  assert.throws(() => validateUserMessages([{ role: "user", content: [{ type: "toolCall", id: "x", name: "y", arguments: {} }], timestamp: 1 }] as any), /text and images/);
});
