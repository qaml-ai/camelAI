import piSoftware from "@agentos-software/pi";
import { agentOS, type SessionStreamEntry } from "@rivet-dev/agentos";
import { event } from "rivetkit";
import {
  EMPTY_THREAD_STATE,
  type AnswerQuestionInput,
  type ChatEvent,
  type ThreadState,
  type TurnStatus,
  type UiMessage,
  type UiPart,
} from "../../shared/index.ts";
import { createCamelBindings } from "../bindings/camel.ts";
import {
  mapAcpSessionEntry,
  type SessionStreamEntryLike,
} from "../chat/acp-mapper.ts";
import type { SendResult } from "../chat/turn.ts";
import type { Platform } from "../platform/index.ts";
import type {
  ChatThreadConnParams,
  ChatThreadCreateInput,
} from "./chat-thread.ts";

export type ChatThreadAgentOsState = {
  threadId: string;
  workspaceId: string;
  orgId: string;
  projectId: string;
  title: string;
  model: string;
  messages: UiMessage[];
  threadState: ThreadState;
  turnStatus: TurnStatus;
  clientMessageIds: string[];
  sessionId: string | null;
  activeAssistantMessageId: string | null;
};

export type ChatThreadAgentOsFactoryOptions = {
  getPlatform?: () => Platform;
};

type ChatThreadAgentOsContext = {
  state: ChatThreadAgentOsState;
  broadcast: (name: "chatEvent", chatEvent: ChatEvent) => unknown;
  keepAwake: <T>(promise: Promise<T>) => Promise<T>;
};

let configuredPlatform: Platform | undefined;

/** Configure host services before the first AgentOS VM boots. */
export function setChatThreadAgentOsPlatform(platform: Platform): void {
  configuredPlatform = platform;
}

function getConfiguredPlatform(): Platform {
  if (!configuredPlatform) {
    throw new Error(
      "chatThreadAgentOs platform is not configured; call setChatThreadAgentOsPlatform before listening",
    );
  }
  return configuredPlatform;
}

function requireCreateInput(
  input: ChatThreadCreateInput,
): ChatThreadCreateInput {
  if (!input?.threadId?.trim()) {
    throw new Error("chatThreadAgentOs create input requires threadId");
  }
  if (!input.workspaceId?.trim()) {
    throw new Error("chatThreadAgentOs create input requires workspaceId");
  }
  if (!input.orgId?.trim()) {
    throw new Error("chatThreadAgentOs create input requires orgId");
  }
  return input;
}

function initialState(
  rawInput: ChatThreadCreateInput,
): ChatThreadAgentOsState {
  const input = requireCreateInput(rawInput);
  const title = input.title?.trim() || "New chat";
  const model = input.model?.trim() || "pi";
  return {
    threadId: input.threadId,
    workspaceId: input.workspaceId,
    orgId: input.orgId,
    projectId: input.projectId?.trim() || input.workspaceId,
    title,
    model,
    messages: [],
    threadState: {
      ...EMPTY_THREAD_STATE,
      title,
      model,
      currentTodos: [],
    },
    turnStatus: "idle",
    clientMessageIds: [],
    sessionId: null,
    activeAssistantMessageId: null,
  };
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function appendMappedParts(message: UiMessage, incoming: UiPart[]): void {
  for (const part of incoming) {
    if (part.type === "reasoning") {
      const previous = message.parts.at(-1);
      if (previous?.type === "reasoning" && previous.state === "streaming") {
        previous.text += part.text;
      } else {
        message.parts.push(part);
      }
      continue;
    }

    if (part.type === "tool-call") {
      const index = message.parts.findIndex(
        (candidate) =>
          candidate.type === "tool-call" &&
          candidate.toolCallId === part.toolCallId,
      );
      if (index === -1) {
        message.parts.push(part);
      } else {
        const previous = message.parts[index];
        message.parts[index] =
          previous?.type === "tool-call"
            ? {
                ...previous,
                ...part,
                input:
                  Object.keys(part.input).length > 0
                    ? part.input
                    : previous.input,
              }
            : part;
      }
      continue;
    }

    if (part.type === "tool-result") {
      const index = message.parts.findIndex(
        (candidate) =>
          candidate.type === "tool-result" &&
          candidate.toolCallId === part.toolCallId,
      );
      if (index === -1) {
        message.parts.push(part);
      } else {
        message.parts[index] = part;
      }
      continue;
    }

    message.parts.push(part);
  }
}

function applyChatEvent(
  state: ChatThreadAgentOsState,
  chatEvent: ChatEvent,
): void {
  if (chatEvent.type === "state") {
    Object.assign(state.threadState, chatEvent.state);
    if (chatEvent.state.title) {
      state.title = chatEvent.state.title;
    }
    if (chatEvent.state.model) {
      state.model = chatEvent.state.model;
    }
    return;
  }
  if (chatEvent.type === "turnStatus") {
    state.turnStatus = chatEvent.status;
    return;
  }
  if (chatEvent.type !== "messageDelta") {
    return;
  }

  const message = state.messages.find(
    (candidate) => candidate.id === chatEvent.messageId,
  );
  if (!message) {
    return;
  }
  if (chatEvent.textDelta) {
    const previous = message.parts.at(-1);
    if (previous?.type === "text" && previous.state === "streaming") {
      previous.text += chatEvent.textDelta;
    } else {
      message.parts.push({
        type: "text",
        text: chatEvent.textDelta,
        state: "streaming",
      });
    }
  }
  if (chatEvent.parts) {
    appendMappedParts(message, chatEvent.parts);
  }
}

type ActorDefinitionReference = {
  config: {
    actions?: Record<string, unknown>;
  };
};

type InternalAction = (...args: unknown[]) => unknown;

async function invokeInternalAction(
  definition: ActorDefinitionReference,
  name: string,
  context: unknown,
  ...args: unknown[]
): Promise<unknown> {
  const action = definition.config.actions?.[name];
  if (typeof action !== "function") {
    throw new Error(`AgentOS internal action is unavailable: ${name}`);
  }
  return await (action as InternalAction)(context, ...args);
}

export function createChatThreadAgentOsActor(
  options: ChatThreadAgentOsFactoryOptions = {},
) {
  const resolvePlatform = options.getPlatform ?? getConfiguredPlatform;
  let definition: ActorDefinitionReference;

  const actorDefinition = agentOS({
    events: {
      chatEvent: event<ChatEvent>(),
    },
    software: [piSoftware],
    resolveOptions: (c) => ({
      bindings: [
        createCamelBindings({
          platform: resolvePlatform(),
          orgId: c.state.orgId,
          workspaceId: c.state.workspaceId,
          projectId: c.state.projectId,
          broadcastAskUser: ({ question, options: questionOptions }) => {
            const pendingQuestion = {
              questionId: crypto.randomUUID(),
              questions: [
                {
                  question,
                  header: "Question",
                  options: questionOptions.map((label) => ({ label })),
                  allowOther: true,
                },
              ],
            };
            c.state.threadState.pendingQuestion = pendingQuestion;
            c.broadcast("chatEvent", {
              type: "state",
              state: { pendingQuestion },
            });
          },
        }),
      ],
    }),
    createState: (
      _c,
      input: ChatThreadCreateInput,
    ): ChatThreadAgentOsState => initialState(input),
    createConnState: (_c, _params: ChatThreadConnParams): undefined =>
      undefined,
    onCreate: (c, input) => {
      const validInput = requireCreateInput(input);
      if (c.state.threadId !== validInput.threadId) {
        throw new Error(
          "chatThreadAgentOs state did not initialize from create input",
        );
      }
    },
    onSessionEvent: async (
      c,
      sessionId: string,
      sessionEvent: SessionStreamEntry,
    ) => {
      const entry = sessionEvent as unknown as SessionStreamEntryLike;
      const messageId =
        c.state.activeAssistantMessageId ??
        (typeof entry.messageId === "string"
          ? entry.messageId
          : `agentos:${sessionId}`);
      const events = mapAcpSessionEntry(
        entry,
        { messageId },
      );
      for (const chatEvent of events) {
        applyChatEvent(c.state, chatEvent);
        c.broadcast("chatEvent", chatEvent);
      }
    },
    actions: {
      async sendMessage(
        c: ChatThreadAgentOsContext,
        content: string,
        clientMessageId: string,
      ): Promise<SendResult> {
        if (!content?.trim()) {
          throw new Error("sendMessage requires non-empty content");
        }
        if (!clientMessageId?.trim()) {
          throw new Error("sendMessage requires clientMessageId");
        }
        if (c.state.clientMessageIds.includes(clientMessageId)) {
          return { status: "duplicate", messageId: clientMessageId };
        }
        if (c.state.turnStatus === "streaming") {
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
        c.state.clientMessageIds.push(clientMessageId);
        c.state.messages.push(userMessage, assistantMessage);
        c.state.activeAssistantMessageId = assistantMessage.id;
        c.state.turnStatus = "streaming";
        c.state.threadState.lastError = null;
        c.broadcast("chatEvent", {
          type: "messageUpsert",
          message: cloneJson(userMessage),
        });
        c.broadcast("chatEvent", {
          type: "messageUpsert",
          message: cloneJson(assistantMessage),
        });
        c.broadcast("chatEvent", {
          type: "turnStatus",
          status: "streaming",
        });

        try {
          if (!c.state.sessionId) {
            await invokeInternalAction(definition, "openSession", c, {
              sessionId: "main",
              agent: "pi",
              cwd: "/workspace",
              permissionPolicy: "ask",
            });
            c.state.sessionId = "main";
          }

          const promptPromise = invokeInternalAction(definition, "prompt", c, {
            sessionId: c.state.sessionId,
            idempotencyKey: clientMessageId,
            content: [{ type: "text", text: content }],
          });
          const result = await c.keepAwake(promptPromise);

          if (assistantMessage.parts.length === 0) {
            const response = result as {
              message?: { content?: unknown };
            };
            const responseContent = response.message?.content;
            if (Array.isArray(responseContent)) {
              const text = responseContent
                .flatMap((block) =>
                  typeof block === "object" &&
                  block !== null &&
                  "text" in block &&
                  typeof block.text === "string"
                    ? [block.text]
                    : [],
                )
                .join("");
              if (text) {
                assistantMessage.parts.push({
                  type: "text",
                  text,
                  state: "done",
                });
              }
            }
          }

          for (const part of assistantMessage.parts) {
            if (part.type === "text" || part.type === "reasoning") {
              part.state = "done";
            }
          }
          c.state.turnStatus = "idle";
          c.broadcast("chatEvent", {
            type: "messageUpsert",
            message: cloneJson(assistantMessage),
          });
          c.broadcast("chatEvent", { type: "turnStatus", status: "idle" });
          return { status: "completed", messageId: assistantMessage.id };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          const errorPart: UiPart = {
            type: "data-error",
            id: `error:${clientMessageId}`,
            data: { error: message },
          };
          assistantMessage.parts.push(errorPart);
          const lastError = {
            id: `error:${clientMessageId}`,
            error: message,
          };
          c.state.threadState.lastError = lastError;
          c.state.turnStatus = "error";
          c.broadcast("chatEvent", {
            type: "state",
            state: { lastError },
          });
          c.broadcast("chatEvent", {
            type: "messageUpsert",
            message: cloneJson(assistantMessage),
          });
          c.broadcast("chatEvent", {
            type: "turnStatus",
            status: "error",
            errorMessage: message,
          });
          return {
            status: "error",
            messageId: assistantMessage.id,
            error: message,
          };
        } finally {
          c.state.activeAssistantMessageId = null;
        }
      },

      getMessages(c: ChatThreadAgentOsContext): UiMessage[] {
        return cloneJson(c.state.messages);
      },

      getThreadState(c: ChatThreadAgentOsContext): {
        threadState: ThreadState;
        turnStatus: TurnStatus;
        title: string;
        model: string;
      } {
        return {
          threadState: cloneJson(c.state.threadState),
          turnStatus: c.state.turnStatus,
          title: c.state.title,
          model: c.state.model,
        };
      },

      async requestStop(
        c: ChatThreadAgentOsContext,
      ): Promise<{ status: "stopped" | "idle" }> {
        if (c.state.turnStatus !== "streaming" || !c.state.sessionId) {
          return { status: "idle" };
        }
        await invokeInternalAction(definition, "cancelPrompt", c, {
          sessionId: c.state.sessionId,
        });
        c.state.turnStatus = "idle";
        c.state.activeAssistantMessageId = null;
        c.broadcast("chatEvent", { type: "turnStatus", status: "idle" });
        return { status: "stopped" };
      },

      answerQuestion(
        c: ChatThreadAgentOsContext,
        questionId: string,
        answers: AnswerQuestionInput["answers"],
      ): { status: "answered" | "not_found"; answers?: Record<string, string> } {
        const pending = c.state.threadState.pendingQuestion;
        if (!pending || pending.questionId !== questionId) {
          return { status: "not_found" };
        }
        c.state.threadState.pendingQuestion = null;
        c.broadcast("chatEvent", {
          type: "state",
          state: { pendingQuestion: null },
        });
        return { status: "answered", answers };
      },
    },
  });

  definition = actorDefinition;
  return actorDefinition;
}

export const chatThreadAgentOs = createChatThreadAgentOsActor();
