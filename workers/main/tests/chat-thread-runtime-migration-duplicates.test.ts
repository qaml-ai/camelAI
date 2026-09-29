/**
 * A thread's history moves to the runtime once: render rows the pi_core
 * export already holds, and the part of a turn a compaction's cut split that
 * the export repeats, are not imported again (review 3 of #89, H-B). The chat
 * page shows each of these messages once; so must the moved thread.
 *
 * Run with: bun run test:workers
 */
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { createPiSummaryMessage } from "../src/chat-thread/pi-compaction";
import { convertTranscript } from "../src/agent-runtime/thread-migration";

const stub = (id: string) => (env as any).CHAT_THREAD.get((env as any).CHAT_THREAD.idFromName(id));
const ctx = (threadId: string) => ({ threadId, workspaceId: "ws1", orgId: "org1", userId: "u1", userName: "Ada", userEmail: null });
const turn = (i: number) => [
  { role: "user", content: `question ${i}`, timestamp: 1_000 + i * 10 },
  { role: "assistant", content: [{ type: "text", text: `answer ${i}` }], timestamp: 1_000 + i * 10 + 1, responseId: `r${i}` },
];
const toolTurn = (i: number) => [
  { role: "user", content: `question ${i}`, timestamp: 1_000 + i * 10 },
  { role: "assistant", content: [{ type: "text", text: `calling ${i}` }, { type: "toolCall", id: `call${i}`, name: "bash", arguments: { cmd: "ls" } }], timestamp: 1_000 + i * 10 + 1, responseId: `r${i}a`, stopReason: "toolUse", uiMetadata: { renderMessageId: `turn${i}` } },
  { role: "toolResult", toolCallId: `call${i}`, toolName: "bash", content: [{ type: "text", text: `result ${i}` }], isError: false, timestamp: 1_000 + i * 10 + 2 },
  { role: "assistant", content: [{ type: "text", text: `answer ${i}` }], timestamp: 1_000 + i * 10 + 3, responseId: `r${i}b`, uiMetadata: { renderMessageId: `turn${i}` } },
];
const count = (messages: unknown[], text: string) => messages.filter((m) => JSON.stringify(m).includes(`"${text}"`)).length;

describe("a moved thread's history, each message once", () => {
  it("watermark compaction (rows kept below the cut, mirrored in the render table)", async () => {
    await runInDurableObject(stub("r3-watermark"), async (instance: any) => {
      instance.chatContext = ctx("r3-watermark");
      await instance.appendPiCoreMessages(Array.from({ length: 10 }, (_, i) => turn(i)).flat());
      await instance.topUpUiMessagesFromPiCore({ force: true });
      instance.piCoreStore.persistPiCoreCompaction("Earlier: 0-7", 16);
      const { messages } = convertTranscript((await instance.runtimeMigration.history()).messages);
      expect(count(messages, "question 0")).toBe(1);
      expect(count(messages, "answer 9")).toBe(1);
    });
  }, 60_000);

  it("rewrite whose cut falls inside a stamped assistant turn", async () => {
    await runInDurableObject(stub("r3-fold"), async (instance: any) => {
      instance.chatContext = ctx("r3-fold");
      const rows = Array.from({ length: 4 }, (_, i) => toolTurn(i)).flat();
      await instance.appendPiCoreMessages(rows);
      await instance.topUpUiMessagesFromPiCore({ force: true });
      await instance.replacePiCoreMessages([createPiSummaryMessage("Earlier.", 1_100), ...rows.slice(-1)], { uiRender: "preserve" });
      const { messages } = convertTranscript((await instance.runtimeMigration.history()).messages);
      expect(count(messages, "answer 3")).toBe(1);
      expect(count(messages, "calling 3")).toBe(1);
      expect(count(messages, "question 0")).toBe(1);
    });
  }, 60_000);
});
