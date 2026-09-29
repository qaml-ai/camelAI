/**
 * For the channel ingress tests (email, Slack, Telegram, Discord): a channel
 * message's turn starts on the agent runtime (startChannelRuntimeTurn). These
 * tests are about what the ingress hands over, so the turn is recorded
 * through the test env's CHAT_THREAD double instead, in the shape they
 * assert on: the channel's system message and the sender's message as one
 * text, and the channel as `messageSource`.
 *
 *   vi.mock("../src/agent-runtime/channel-turns.js", async (importOriginal) =>
 *     (await import("./helpers/channel-turn-recorder")).recordChannelTurns(await importOriginal()));
 */
import type { ChannelTurnRequest, ChannelTurnResult } from "../../src/agent-runtime/channel-turns";

type Recorder = {
  startInitialUserMessage(request: Record<string, unknown>): Promise<{ status: string; error?: string }>;
};

type RecorderEnv = { CHAT_THREAD: { idFromName(id: string): unknown; get(id: unknown): unknown } };

export function recordChannelTurns<T extends object>(actual: T): T {
  return {
    ...actual,
    async startChannelRuntimeTurn(env: RecorderEnv, request: ChannelTurnRequest): Promise<ChannelTurnResult | null> {
      const recorder = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(request.threadId)) as Recorder;
      const result = await recorder.startInitialUserMessage({
        threadId: request.threadId,
        workspaceId: request.workspaceId,
        orgId: request.orgId,
        ...(request.userId ? { userId: request.userId } : {}),
        ...(request.userName !== undefined ? { userName: request.userName } : {}),
        ...(request.userEmail !== undefined ? { userEmail: request.userEmail } : {}),
        ...(request.clientMessageId !== undefined ? { clientMessageId: request.clientMessageId } : {}),
        messageSource: request.channelKind,
        message: `${request.systemMessage}\n\n${request.message}`,
      });
      if (result.status === "moved") return null;
      return { status: result.status, ...(result.error ? { error: result.error } : {}) } as ChannelTurnResult;
    },
  };
}
