import type {
  ChatEvent,
  ThreadState,
  TurnStatus,
  UiMessage,
  UiPart,
} from "../../shared/index.ts";
import type { AgentRuntime, AgentRuntimeEvent } from "./runtime.ts";

export type SendResult =
  | { status: "completed"; messageId: string }
  | { status: "duplicate"; messageId: string }
  | { status: "busy" }
  | { status: "stopped"; messageId: string }
  | { status: "error"; messageId: string; error: string };

export type RunChatTurnInput = {
  messages: UiMessage[];
  broadcast: (event: ChatEvent) => void | Promise<void>;
  updateState: (patch: Partial<ThreadState>) => void | Promise<void>;
  runtime: AgentRuntime;
  content: string;
  clientMessageId: string;
  /** Current status, read before accepting the turn. Defaults to idle. */
  turnStatus?: TurnStatus | (() => TurnStatus);
  updateTurnStatus?: (status: TurnStatus) => void | Promise<void>;
  signal?: AbortSignal;
  keepAwake?: <T>(promise: Promise<T>) => Promise<T>;
};

function snapshot(message: UiMessage): UiMessage {
  return structuredClone(message);
}

function currentStatus(
  status: RunChatTurnInput["turnStatus"],
): TurnStatus {
  return typeof status === "function" ? status() : (status ?? "idle");
}

export async function runChatTurn({
  messages,
  broadcast,
  updateState,
  runtime,
  content,
  clientMessageId,
  turnStatus,
  updateTurnStatus = async () => {},
  signal,
  keepAwake,
}: RunChatTurnInput): Promise<SendResult> {
  const duplicate = messages.find((message) => message.id === clientMessageId);
  if (duplicate) {
    return { status: "duplicate", messageId: duplicate.id };
  }
  if (currentStatus(turnStatus) === "streaming") {
    return { status: "busy" };
  }

  const now = Date.now();
  const userMessage: UiMessage = {
    id: clientMessageId,
    role: "user",
    parts: [{ type: "text", text: content, state: "done" }],
    createdAt: now,
  };
  const assistantMessage: UiMessage = {
    id: `assistant:${clientMessageId}`,
    role: "assistant",
    parts: [],
    createdAt: now,
  };

  messages.push(userMessage, assistantMessage);
  await broadcast({ type: "messageUpsert", message: snapshot(userMessage) });
  await broadcast({ type: "messageUpsert", message: snapshot(assistantMessage) });
  await setTurnStatus("streaming");

  let terminalError: string | undefined;
  const toolStreamSeq = new Map<string, number>();

  const emitAssistantChange = async (
    parts?: UiPart[],
    textDelta?: string,
  ): Promise<void> => {
    await broadcast({
      type: "messageDelta",
      messageId: assistantMessage.id,
      ...(parts ? { parts: structuredClone(parts) } : {}),
      ...(textDelta !== undefined ? { textDelta } : {}),
    });
    await broadcast({
      type: "messageUpsert",
      message: snapshot(assistantMessage),
    });
  };

  const onEvent = async (event: AgentRuntimeEvent): Promise<void> => {
    switch (event.type) {
      case "text_delta": {
        const previous = assistantMessage.parts.at(-1);
        if (previous?.type === "text" && previous.state === "streaming") {
          previous.text += event.text;
        } else {
          assistantMessage.parts.push({
            type: "text",
            text: event.text,
            state: "streaming",
          });
        }
        await emitAssistantChange(undefined, event.text);
        break;
      }
      case "thinking_delta": {
        const previous = assistantMessage.parts.at(-1);
        if (previous?.type === "reasoning" && previous.state === "streaming") {
          previous.text += event.text;
        } else {
          assistantMessage.parts.push({
            type: "reasoning",
            text: event.text,
            state: "streaming",
          });
        }
        await emitAssistantChange([
          {
            type: "reasoning",
            text: event.text,
            state: "streaming",
          },
        ]);
        break;
      }
      case "tool_call": {
        const part: UiPart = {
          type: "tool-call",
          toolCallId: event.id,
          toolName: event.name,
          input: event.input,
          state: "input-available",
        };
        assistantMessage.parts.push(part);
        await emitAssistantChange([part]);
        break;
      }
      case "tool_result": {
        const call = assistantMessage.parts.find(
          (part) =>
            part.type === "tool-call" && part.toolCallId === event.id,
        );
        if (call?.type === "tool-call") {
          call.state = event.isError ? "output-error" : "output-available";
        }
        const part: UiPart = {
          type: "tool-result",
          toolCallId: event.id,
          toolName: call?.type === "tool-call" ? call.toolName : undefined,
          output: event.content,
          isError: event.isError,
        };
        assistantMessage.parts.push(part);
        await emitAssistantChange([part]);
        break;
      }
      case "tool_stream": {
        const seq = (toolStreamSeq.get(event.id) ?? 0) + 1;
        toolStreamSeq.set(event.id, seq);
        const part: UiPart = {
          type: "data-tool-stream",
          data: { toolCallId: event.id, text: event.text, seq },
        };
        assistantMessage.parts.push(part);
        await broadcast({
          type: "toolStream",
          toolCallId: event.id,
          text: event.text,
          seq,
        });
        await emitAssistantChange([part]);
        break;
      }
      case "ask_user": {
        const pendingQuestion = {
          questionId: event.questionId,
          questions: event.questions.map((question) => ({
            ...question,
            header: "Question",
            allowOther: true,
          })),
        };
        await updateState({ pendingQuestion });
        await broadcast({
          type: "state",
          state: { pendingQuestion },
        });
        break;
      }
      case "done": {
        for (const part of assistantMessage.parts) {
          if (part.type === "text" || part.type === "reasoning") {
            part.state = "done";
          }
        }
        if (!terminalError) {
          await setTurnStatus("idle");
        }
        await broadcast({
          type: "messageUpsert",
          message: snapshot(assistantMessage),
        });
        break;
      }
      case "error": {
        terminalError = event.error;
        const errorPart: UiPart = {
          type: "data-error",
          id: `error:${clientMessageId}`,
          data: { error: event.error },
        };
        assistantMessage.parts.push(errorPart);
        const lastError = {
          id: `error:${clientMessageId}`,
          error: event.error,
        };
        await updateState({ lastError });
        await broadcast({ type: "state", state: { lastError } });
        await emitAssistantChange([errorPart]);
        await setTurnStatus("error", event.error);
        break;
      }
    }
  };

  function setTurnStatus(
    status: TurnStatus,
    errorMessage?: string,
  ): Promise<void> {
    return Promise.resolve(updateTurnStatus(status)).then(() =>
      Promise.resolve(
        broadcast({
          type: "turnStatus",
          status,
          ...(errorMessage ? { errorMessage } : {}),
        }),
      ),
    );
  }

  try {
    const prompt = runtime.prompt({ content, signal, onEvent });
    await (keepAwake ? keepAwake(prompt) : prompt);
    if (terminalError) {
      return {
        status: "error",
        messageId: assistantMessage.id,
        error: terminalError,
      };
    }
    if (currentStatus(turnStatus) === "streaming") {
      await setTurnStatus("idle");
    }
    return { status: "completed", messageId: assistantMessage.id };
  } catch (error) {
    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
      await setTurnStatus("idle");
      return { status: "stopped", messageId: assistantMessage.id };
    }
    const message = error instanceof Error ? error.message : String(error);
    await onEvent({ type: "error", error: message });
    return {
      status: "error",
      messageId: assistantMessage.id,
      error: message,
    };
  }
}
