import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createClient } from "rivetkit/client";
import type {
  AnswerQuestionInput,
  ChatEvent,
  SendMessageInput,
  ThreadState,
  TurnStatus,
  UiMessage,
} from "../shared/index.ts";
import { EMPTY_THREAD_STATE } from "../shared/index.ts";
import { applyChatEvent } from "./message-adapter.ts";

export type ChatConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "disconnected";

export type ChatThreadInput = {
  threadId: string;
  workspaceId: string;
  orgId: string;
  projectId?: string;
  initialTitle?: string;
};

export type ChatSnapshot = {
  messages: UiMessage[];
  threadState: ThreadState;
  turnStatus: TurnStatus;
};

export type ChatTransportObserver = {
  onEvent(event: ChatEvent): void;
  onStatus(status: ChatConnectionStatus): void;
  onError(error: Error): void;
};

export interface ChatTransportSession {
  sendMessage(input: SendMessageInput): Promise<void>;
  answerQuestion(input: AnswerQuestionInput): Promise<void>;
  requestStop(): Promise<void>;
  refresh(): Promise<ChatSnapshot>;
  dispose(): Promise<void>;
}

export interface ChatTransport {
  connect(
    input: ChatThreadInput,
    observer: ChatTransportObserver,
  ): Promise<ChatTransportSession>;
}

type LooseRivetConnection = {
  ready: Promise<void>;
  action<T>(options: { name: string; args: unknown[] }): Promise<T>;
  on(
    eventName: string,
    callback: (...args: unknown[]) => void,
  ): () => void;
  onError(callback: (error: unknown) => void): () => void;
  onStatusChange(callback: (status: ChatConnectionStatus) => void): () => void;
  dispose(): Promise<void>;
};

type LooseRivetHandle = {
  connect(): LooseRivetConnection;
};

type LooseRivetClient = {
  chatThread: {
    getOrCreate(
      key: string | string[],
      options: {
        createWithInput: Omit<ChatThreadInput, "initialTitle"> & {
          title?: string;
        };
      },
    ): LooseRivetHandle;
  };
};

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Browser transport for the chatThread Rivet actor. This intentionally keeps
 * the registry loose so the web bundle does not import server actor code.
 */
export function createRivetChatTransport(
  endpoint = "http://localhost:6420",
): ChatTransport {
  const client = createClient({ endpoint }) as unknown as LooseRivetClient;

  return {
    async connect(input, observer) {
      observer.onStatus("connecting");
      // Rivet actor keys are strings (or string arrays for compound keys).
      // Prefer the bare threadId string to match server tests / live smoke.
      const handle = client.chatThread.getOrCreate(input.threadId, {
        createWithInput: {
          threadId: input.threadId,
          workspaceId: input.workspaceId,
          orgId: input.orgId,
          projectId: input.projectId,
          title: input.initialTitle,
        },
      });
      const connection = handle.connect();
      const cleanups = [
        connection.on("chatEvent", (event) => {
          observer.onEvent(event as ChatEvent);
        }),
        connection.onStatusChange(observer.onStatus),
        connection.onError((error) => observer.onError(asError(error))),
      ];

      try {
        await connection.ready;
        observer.onStatus("connected");
      } catch (error) {
        for (const cleanup of cleanups) cleanup();
        await connection.dispose();
        observer.onError(asError(error));
        throw error;
      }

      return {
        sendMessage(payload) {
          return connection.action<void>({
            name: "sendMessage",
            args: [payload.content, payload.clientMessageId],
          });
        },
        answerQuestion(payload) {
          return connection.action<void>({
            name: "answerQuestion",
            args: [payload.questionId, payload.answers],
          });
        },
        requestStop() {
          return connection.action<void>({
            name: "requestStop",
            args: [],
          });
        },
        async refresh() {
          const [messages, state] = await Promise.all([
            connection.action<UiMessage[]>({
              name: "getMessages",
              args: [],
            }),
            connection.action<{
              threadState: ThreadState;
              turnStatus: TurnStatus;
            }>({
              name: "getThreadState",
              args: [],
            }),
          ]);
          return {
            messages,
            threadState: state.threadState,
            turnStatus: state.turnStatus,
          };
        },
        async dispose() {
          for (const cleanup of cleanups) cleanup();
          await connection.dispose();
        },
      };
    },
  };
}

type MemoryThread = ChatSnapshot & {
  observers: Set<ChatTransportObserver>;
};

export interface MemoryChatTransport extends ChatTransport {
  emit(threadId: string, event: ChatEvent): void;
  getSnapshot(threadId: string): ChatSnapshot | undefined;
}

function cloneSnapshot(thread: MemoryThread): ChatSnapshot {
  return {
    messages: structuredClone(thread.messages),
    threadState: structuredClone(thread.threadState),
    turnStatus: thread.turnStatus,
  };
}

/** Deterministic in-memory transport used by local demo mode and unit tests. */
export function createMemoryChatTransport(): MemoryChatTransport {
  const threads = new Map<string, MemoryThread>();

  function notifyEvent(thread: MemoryThread, event: ChatEvent) {
    thread.messages = applyChatEvent(thread.messages, event);
    if (event.type === "state") {
      thread.threadState = { ...thread.threadState, ...event.state };
    } else if (event.type === "turnStatus") {
      thread.turnStatus = event.status;
    }
    for (const observer of thread.observers) observer.onEvent(event);
  }

  function notifyStatus(thread: MemoryThread, status: ChatConnectionStatus) {
    for (const observer of thread.observers) observer.onStatus(status);
  }

  return {
    async connect(input, observer) {
      observer.onStatus("connecting");
      let thread = threads.get(input.threadId);
      if (!thread) {
        thread = {
          messages: [],
          threadState: {
            ...EMPTY_THREAD_STATE,
            title: input.initialTitle ?? "New agent session",
            model: "memory/demo",
          },
          turnStatus: "idle",
          observers: new Set(),
        };
        threads.set(input.threadId, thread);
      }
      thread.observers.add(observer);
      observer.onStatus("connected");

      const session: ChatTransportSession = {
        async sendMessage(payload) {
          const createdAt = Date.now();
          notifyEvent(thread, {
            type: "messageUpsert",
            message: {
              id: payload.clientMessageId,
              role: "user",
              createdAt,
              parts: [{ type: "text", text: payload.content, state: "done" }],
            },
          });
          notifyEvent(thread, { type: "turnStatus", status: "streaming" });

          const assistantId = `memory-${payload.clientMessageId}`;
          notifyEvent(thread, {
            type: "messageUpsert",
            message: {
              id: assistantId,
              role: "assistant",
              createdAt: createdAt + 1,
              parts: [],
            },
          });
          notifyEvent(thread, {
            type: "messageDelta",
            messageId: assistantId,
            textDelta: `Memory mode received: ${payload.content}`,
          });
          notifyEvent(thread, {
            type: "messageUpsert",
            message: {
              id: assistantId,
              role: "assistant",
              createdAt: createdAt + 1,
              parts: [
                {
                  type: "text",
                  text: `Memory mode received: ${payload.content}`,
                  state: "done",
                },
              ],
            },
          });
          notifyEvent(thread, { type: "turnStatus", status: "idle" });
        },
        async answerQuestion(payload) {
          const answer = Object.entries(payload.answers)
            .map(([question, value]) => `${question}: ${value}`)
            .join("\n");
          notifyEvent(thread, {
            type: "state",
            state: { pendingQuestion: null },
          });
          await session.sendMessage({
            content: answer,
            clientMessageId: crypto.randomUUID(),
          });
        },
        async requestStop() {
          notifyEvent(thread, { type: "turnStatus", status: "idle" });
        },
        async refresh() {
          return cloneSnapshot(thread);
        },
        async dispose() {
          notifyStatus(thread, "disconnected");
          thread.observers.delete(observer);
        },
      };
      return session;
    },
    emit(threadId, event) {
      const thread = threads.get(threadId);
      if (!thread) throw new Error(`Memory thread not found: ${threadId}`);
      notifyEvent(thread, event);
    },
    getSnapshot(threadId) {
      const thread = threads.get(threadId);
      return thread ? cloneSnapshot(thread) : undefined;
    },
  };
}

export type UseRivetChatOptions = ChatThreadInput & {
  endpoint?: string;
  transport?: ChatTransport;
};

export function useRivetChat(options: UseRivetChatOptions) {
  const {
    endpoint = "http://localhost:6420",
    threadId,
    workspaceId,
    orgId,
    projectId,
    initialTitle,
    transport: suppliedTransport,
  } = options;
  const transport = useMemo(
    () => suppliedTransport ?? createRivetChatTransport(endpoint),
    [endpoint, suppliedTransport],
  );
  const sessionRef = useRef<ChatTransportSession | null>(null);
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [threadState, setThreadState] = useState<ThreadState>({
    ...EMPTY_THREAD_STATE,
    title: initialTitle ?? null,
  });
  const [turnStatus, setTurnStatus] = useState<TurnStatus>("idle");
  const [connStatus, setConnStatus] =
    useState<ChatConnectionStatus>("idle");
  const [error, setError] = useState<Error | null>(null);

  const applySnapshot = useCallback((snapshot: ChatSnapshot) => {
    setMessages(snapshot.messages);
    setThreadState(snapshot.threadState);
    setTurnStatus(snapshot.turnStatus);
  }, []);

  useEffect(() => {
    let active = true;
    let session: ChatTransportSession | null = null;
    setMessages([]);
    setThreadState({ ...EMPTY_THREAD_STATE, title: initialTitle ?? null });
    setTurnStatus("idle");
    setError(null);

    void transport
      .connect(
        { threadId, workspaceId, orgId, projectId, initialTitle },
        {
          onEvent(event) {
            if (!active) return;
            if (
              event.type === "messageUpsert" ||
              event.type === "messageDelta"
            ) {
              setMessages((current) => applyChatEvent(current, event));
            } else if (event.type === "state") {
              setThreadState((current) => ({ ...current, ...event.state }));
            } else if (event.type === "turnStatus") {
              setTurnStatus(event.status);
              if (event.status === "error" && event.errorMessage) {
                setError(new Error(event.errorMessage));
              }
            } else if (event.type === "error") {
              setError(new Error(event.error));
            }
          },
          onStatus(status) {
            if (active) setConnStatus(status);
          },
          onError(nextError) {
            if (active) setError(nextError);
          },
        },
      )
      .then(async (connectedSession) => {
        if (!active) {
          await connectedSession.dispose();
          return;
        }
        session = connectedSession;
        sessionRef.current = connectedSession;
        applySnapshot(await connectedSession.refresh());
      })
      .catch((nextError) => {
        if (active) {
          setError(asError(nextError));
          setConnStatus("disconnected");
        }
      });

    return () => {
      active = false;
      sessionRef.current = null;
      if (session) void session.dispose();
    };
  }, [
    applySnapshot,
    initialTitle,
    orgId,
    projectId,
    threadId,
    transport,
    workspaceId,
  ]);

  const sendMessage = useCallback(async (content: string) => {
    const session = sessionRef.current;
    const trimmed = content.trim();
    if (!session) throw new Error("Chat is not connected");
    if (!trimmed) return;

    const clientMessageId = crypto.randomUUID();
    const optimistic: UiMessage = {
      id: clientMessageId,
      role: "user",
      createdAt: Date.now(),
      parts: [{ type: "text", text: trimmed, state: "done" }],
    };
    setMessages((current) =>
      applyChatEvent(current, {
        type: "messageUpsert",
        message: optimistic,
      }),
    );
    setError(null);

    try {
      await session.sendMessage({ content: trimmed, clientMessageId });
    } catch (nextError) {
      const sendError = asError(nextError);
      setError(sendError);
      setTurnStatus("error");
      throw sendError;
    }
  }, []);

  const answerQuestion = useCallback(
    async (questionId: string, answers: Record<string, string>) => {
      const session = sessionRef.current;
      if (!session) throw new Error("Chat is not connected");
      setError(null);
      await session.answerQuestion({ questionId, answers });
    },
    [],
  );

  const requestStop = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    await session.requestStop();
  }, []);

  const refresh = useCallback(async () => {
    const session = sessionRef.current;
    if (!session) return;
    applySnapshot(await session.refresh());
  }, [applySnapshot]);

  return {
    messages,
    threadState,
    turnStatus,
    connStatus,
    error,
    sendMessage,
    answerQuestion,
    requestStop,
    refresh,
  };
}
