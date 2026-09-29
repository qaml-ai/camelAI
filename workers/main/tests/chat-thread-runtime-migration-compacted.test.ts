/**
 * A thread compacted by rewrite moving to the agent runtime (H2): the rows
 * below the cut exist only as ai-chat render rows, and the move brings them.
 *
 * Run with: bun run test:workers
 */
import { describe, expect, it } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";
import { createPiSummaryMessage } from "../src/chat-thread/pi-compaction";
import { convertTranscript } from "../src/agent-runtime/thread-migration";

const threadStub = (threadId: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(threadId));
};

const turn = (index: number) => [
  { role: "user", content: `question ${index}`, timestamp: 1_000 + index * 10 },
  { role: "assistant", content: [{ type: "text", text: `answer ${index}` }], timestamp: 1_000 + index * 10 + 1, responseId: `r${index}` },
];

describe("moving a thread compacted by rewrite", () => {
  it("exports the pre-cut history from the render archive, ahead of the summary, and counts the move as archived", async () => {
    const thread = "runtime-migration-compacted";
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      instance.chatContext = { threadId: thread, workspaceId: "ws1", orgId: "org1", userId: "u1", userName: "Ada", userEmail: null };
      const rows = Array.from({ length: 10 }, (_, index) => turn(index)).flat();
      await instance.appendPiCoreMessages(rows);
      const kept = rows.slice(-4);
      const result = await instance.replacePiCoreMessages(
        [createPiSummaryMessage("Earlier: questions 0 to 7.", 1_079), ...kept],
        { uiRender: "preserve" },
      );
      expect(result.status).toBe("rewritten");

      const archive = [...instance.renderArchivePages()].flat();
      const texts = JSON.stringify(archive);
      expect(texts).toContain("question 0");
      expect(texts).toContain("answer 7");
      expect(texts).not.toContain("question 9");

      const history = await instance.runtimeMigration.history();
      expect(history.archived).toBe(true);
      const converted = convertTranscript(history.messages);
      const roles = converted.messages.map((message: any) => message.role);
      const summaryAt = roles.indexOf("compactionSummary");
      expect(summaryAt).toBeGreaterThan(0);
      const before = JSON.stringify(converted.messages.slice(0, summaryAt));
      expect(before).toContain("question 0");
      expect(before).toContain("answer 7");
      expect(JSON.stringify(converted.messages.slice(summaryAt))).toContain("question 9");
      expect(converted.stats.normalized).toBe(0);
    });
  }, 60_000);
});
