import { actor, event } from "rivetkit";
import {
  EMPTY_THREAD_STATE,
  type AnswerQuestionInput,
  type ChatEvent,
  type ThreadState,
  type TurnStatus,
  type UiMessage,
} from "../../shared/index.ts";
import {
  createAgentRuntime,
  type AgentRuntime,
} from "../chat/runtime.ts";
import { runChatTurn, type SendResult } from "../chat/turn.ts";

export type ChatThreadCreateInput = {
  threadId: string;
  workspaceId: string;
  orgId: string;
  projectId?: string;
  title?: string;
  model?: string;
};

export type ChatThreadConnParams = {
  userId?: string;
};

export type ChatThreadState = {
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
};

type ChatThreadVars = {
  activeRuntime: AgentRuntime | null;
  abortController: AbortController | null;
};

function requireCreateInput(input: ChatThreadCreateInput): ChatThreadCreateInput {
  if (!input?.threadId?.trim()) {
    throw new Error("chatThread create input requires threadId");
  }
  if (!input.workspaceId?.trim()) {
    throw new Error("chatThread create input requires workspaceId");
  }
  if (!input.orgId?.trim()) {
    throw new Error("chatThread create input requires orgId");
  }
  return input;
}

function initialState(rawInput: ChatThreadCreateInput): ChatThreadState {
  const input = requireCreateInput(rawInput);
  const title = input.title?.trim() || "New chat";
  const model = input.model?.trim() || "mock";
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
  };
}

function runtimeForEnvironment(): AgentRuntime {
  // "echo" is retained as a convenient alias for the deterministic mock.
  return process.env.AGENT_RUNTIME === "agentos"
    ? createAgentRuntime({ mode: "agentos" })
    : createAgentRuntime({ mode: "mock" });
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createChatThreadActor() {
  return actor({
    events: {
      chatEvent: event<ChatEvent>(),
    },
    createState: (_c, input: ChatThreadCreateInput): ChatThreadState =>
      initialState(input),
    createVars: (): ChatThreadVars => ({
      activeRuntime: null,
      abortController: null,
    }),
    createConnState: (_c, _params: ChatThreadConnParams): undefined =>
      undefined,
    onCreate: (c, input) => {
      // createState owns initialization; this validates the persisted identity
      // against the create request before the actor becomes available.
      const validInput = requireCreateInput(input);
      if (c.state.threadId !== validInput.threadId) {
        throw new Error("chatThread state did not initialize from create input");
      }
    },
    actions: {
      async sendMessage(
        c,
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

        c.state.clientMessageIds.push(clientMessageId);
        const runtime = runtimeForEnvironment();
        const abortController = new AbortController();
        c.vars.activeRuntime = runtime;
        c.vars.abortController = abortController;

        const turnPromise = runChatTurn({
          messages: c.state.messages,
          broadcast: (chatEvent) => c.broadcast("chatEvent", chatEvent),
          updateState: (patch) => {
            Object.assign(c.state.threadState, patch);
          },
          runtime,
          content,
          clientMessageId,
          turnStatus: () => c.state.turnStatus,
          updateTurnStatus: (status) => {
            c.state.turnStatus = status;
          },
          signal: abortController.signal,
        });

        try {
          return await c.keepAwake(turnPromise);
        } finally {
          if (c.vars.activeRuntime === runtime) {
            c.vars.activeRuntime = null;
            c.vars.abortController = null;
          }
        }
      },

      getMessages(c): UiMessage[] {
        return cloneJson(c.state.messages);
      },

      getThreadState(c): {
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

      answerQuestion(
        c,
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
        } satisfies ChatEvent);
        return { status: "answered", answers };
      },

      async requestStop(c): Promise<{ status: "stopped" | "idle" }> {
        const runtime = c.vars.activeRuntime;
        if (!runtime) {
          return { status: "idle" };
        }
        c.vars.abortController?.abort();
        await runtime.cancel();
        c.state.turnStatus = "idle";
        c.broadcast("chatEvent", {
          type: "turnStatus",
          status: "idle",
        } satisfies ChatEvent);
        return { status: "stopped" };
      },

      setTitle(c, title: string): string {
        const normalized = title?.trim();
        if (!normalized) {
          throw new Error("setTitle requires non-empty title");
        }
        c.state.title = normalized;
        c.state.threadState.title = normalized;
        c.broadcast("chatEvent", {
          type: "state",
          state: { title: normalized },
        } satisfies ChatEvent);
        return normalized;
      },

      setModel(c, model: string): string {
        const normalized = model?.trim();
        if (!normalized) {
          throw new Error("setModel requires non-empty model");
        }
        c.state.model = normalized;
        c.state.threadState.model = normalized;
        c.broadcast("chatEvent", {
          type: "state",
          state: { model: normalized },
        } satisfies ChatEvent);
        return normalized;
      },
    },
  });
}

export const chatThread = createChatThreadActor();
