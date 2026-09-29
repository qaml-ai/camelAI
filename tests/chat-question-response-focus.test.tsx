import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import React from "react";

const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();
const mockSubmit = vi.fn();

function createFetcher() {
  return {
    state: "idle" as const,
    data: undefined,
    formData: undefined,
    submit: vi.fn(),
  };
}

vi.mock("react-router", async () => {
  const actual =
    await vi.importActual<typeof import("react-router")>("react-router");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useLocation: () => ({
      pathname: "/chat/thread-1",
      search: "",
      hash: "",
      state: null,
      key: "default",
    }),
    useRevalidator: () => ({
      state: "idle" as const,
      revalidate: mockRevalidate,
    }),
    useNavigation: () => ({ state: "idle", formData: undefined }),
    useFetcher: () => createFetcher(),
    useSubmit: () => mockSubmit,
  };
});

const mockToast = vi.hoisted(() => Object.assign(vi.fn(), { error: vi.fn() }));

vi.mock("sonner", () => ({
  toast: mockToast,
}));

vi.mock("@/hooks/use-auth-data", () => ({
  useAuthData: () => ({
    user: { id: "user-1", name: "Illiana" },
    currentWorkspace: { id: "ws-1", name: "Workspace 1" },
    currentOrg: { id: "org-1", name: "Org 1" },
    orgs: [{ org_id: "org-1", role: "owner" }],
  }),
}));

vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => false,
}));

vi.mock("@/components/page-header", () => ({
  PageHeader: () => null,
}));

vi.mock("@/components/prompt-input", () => ({
  PromptInput: ({
    value,
    onChange,
    onSubmit,
    textareaRef,
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  }) => (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <textarea
        aria-label="Prompt"
        ref={textareaRef}
        value={value}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <button type="submit">Send message</button>
    </form>
  ),
}));

vi.mock("@/components/ask-user-question", () => ({
  AskUserQuestion: ({
    onSubmit,
  }: {
    onSubmit: (answers: Record<string, string>) => void;
  }) => (
    <button
      type="button"
      onClick={() => onSubmit({ "Which framework do you want?": "Remix" })}
    >
      Answer question
    </button>
  ),
}));

vi.mock("@/components/message-bubble", () => ({
  MessageBubble: () => null,
  isInterruptMessage: () => false,
  parseSlashCommand: () => null,
  parseLocalCommandStdout: () => null,
}));

vi.mock("@/components/loading-dots", () => ({
  LoadingDots: () => null,
}));

vi.mock("@/components/welcome-screen", () => ({
  WelcomeScreen: () => null,
}));

vi.mock("@/components/floating-todo", () => ({
  FloatingTodoList: () => null,
}));

vi.mock("@/components/connection-setup-prompt", () => ({
  ConnectionSetupPrompt: () => null,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  TooltipContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("@/components/ui/tabs", () => ({
  Tabs: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsList: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TabsTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ResizablePanel: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  ResizableHandle: () => null,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuRadioGroup: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuRadioItem: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

// Chat reads a thread through the runtime connection (`useRuntimeThread`).
// Mock the hook so tests can drive the connection directly.
const agentRuntime = vi.hoisted(() => {
  type AgentOptions = {
    agent: string;
    name: string;
    enabled?: boolean;
    onOpen?: () => void;
    onStateUpdate?: (state: unknown) => void;
  };

  class MockAgentClient {
    static instances: MockAgentClient[] = [];

    options: AgentOptions;
    // 0 = CONNECTING, 1 = OPEN, 3 = CLOSED.
    readyState = 0;
    readonly transport = "poll" as const;
    send = vi.fn();
    call = vi.fn(
      async (
        _method: string,
        _args?: unknown[],
        _options?: { timeout?: number },
      ): Promise<unknown> => undefined,
    );
    reconnect = vi.fn();

    constructor(options: AgentOptions) {
      this.options = options;
      MockAgentClient.instances.push(this);
    }

    emitOpen() {
      this.readyState = 1;
      this.options.onOpen?.();
    }

    emitStateUpdate(state: unknown) {
      this.options.onStateUpdate?.(state);
    }

    emitClose() {
      this.readyState = 3;
    }
  }

  const registry = new Map<string, MockAgentClient>();
  const chat = {
    messages: [],
    status: "ready",
    isStreaming: false,
    isStallClamped: false,
    streamingMessageId: null,
  };

  function useRuntimeThread(options: {
    threadId?: string;
    enabled: boolean;
    callbacks: { current: { onOpen(): void; onStateUpdate(state: unknown): void } };
  }) {
    const key = options.threadId ?? "none";
    const clientOptions: AgentOptions = {
      agent: "chat-thread",
      name: key,
      enabled: options.enabled,
      onOpen: () => options.callbacks.current.onOpen(),
      onStateUpdate: (state) => options.callbacks.current.onStateUpdate(state),
    };
    let instance = registry.get(key);
    if (!instance) {
      instance = new MockAgentClient(clientOptions);
      registry.set(key, instance);
    } else {
      // Refresh the captured callbacks so emits run the latest handlers.
      instance.options = clientOptions;
    }
    return { client: instance, chat, hasOlder: false, loadOlder: async () => false, reconnecting: false };
  }

  function reset() {
    registry.clear();
    MockAgentClient.instances = [];
  }

  return { useRuntimeThread, reset, MockAgentClient };
});

vi.mock("@/lib/use-runtime-thread", () => ({
  CLIENT_OPEN: 1,
  useRuntimeThread: agentRuntime.useRuntimeThread,
}));

import Chat from "@/components/Chat";
import { readOnlyMoveNotice } from "@/components/chat/chat-moving-notice";

const RATE_LIMIT_ERROR =
  '429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}';

type MockAgentClient = InstanceType<typeof agentRuntime.MockAgentClient>;

function getMainAgent(): MockAgentClient {
  const agent = agentRuntime.MockAgentClient.instances.find(
    (candidate) =>
      candidate.options.agent === "chat-thread" &&
      candidate.options.name === "thread-1",
  );
  if (!agent) {
    throw new Error("Main chat agent was not created");
  }

  return agent;
}

describe("Chat AskUserQuestion composer focus", () => {
  beforeAll(() => {
    if (!HTMLElement.prototype.scrollTo) {
      Object.defineProperty(HTMLElement.prototype, "scrollTo", {
        value: vi.fn(),
        writable: true,
      });
    }

    if (!HTMLElement.prototype.scrollIntoView) {
      Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
        value: vi.fn(),
        writable: true,
      });
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    agentRuntime.reset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("returns focus to the composer after sending a question response", async () => {
    const user = userEvent.setup();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        isLoadingMessages
      />,
    );

    const agent = getMainAgent();
    act(() => {
      agent.emitOpen();
    });

    const prompt = screen.getByLabelText("Prompt");
    prompt.focus();
    expect(prompt).toHaveFocus();

    act(() => {
      agent.emitStateUpdate({
        pendingQuestion: {
          questionId: "question-1",
          questions: [
            {
              header: "Framework",
              question: "Which framework do you want?",
              multiSelect: false,
              options: [
                { label: "Next.js", description: "" },
                { label: "Remix", description: "" },
              ],
            },
          ],
        },
      });
    });

    await user.click(screen.getByRole("button", { name: "Answer question" }));

    expect(agent.call).toHaveBeenCalledWith("answerQuestion", [
      "question-1",
      { "Which framework do you want?": "Remix" },
    ]);

    await waitFor(() => {
      expect(screen.getByLabelText("Prompt")).toHaveFocus();
    });
  });

  it("reconnects and retransmits an unacknowledged send instead of restoring it as failed", async () => {
    const user = userEvent.setup();
    let rejectFirstSend: (error: Error) => void = () => {};

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    const agent = getMainAgent();
    agent.call
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirstSend = reject;
          }),
      )
      .mockResolvedValueOnce({ status: "accepted" });

    act(() => {
      agent.emitOpen();
    });

    const prompt = screen.getByLabelText("Prompt");
    await user.type(prompt, "keep this message");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(agent.call).toHaveBeenCalledWith(
      "sendMessage",
      ["keep this message", expect.stringMatching(/^client_/)],
      { timeout: 15_000 },
    );
    expect(prompt).toHaveValue("keep this message");

    await act(async () => {
      rejectFirstSend(new Error("Connection closed"));
      await Promise.resolve();
    });

    expect(agent.reconnect).toHaveBeenCalledTimes(1);
    expect(prompt).toHaveValue("keep this message");

    act(() => {
      agent.emitClose();
      agent.emitOpen();
    });

    await waitFor(() => {
      const sends = agent.call.mock.calls.filter(
        ([method]) => method === "sendMessage",
      );
      expect(sends).toHaveLength(2);
      expect(sends[1]?.[1]).toEqual(sends[0]?.[1]);
      expect(prompt).toHaveValue("");
    });

    expect(screen.queryByText(/restored your message/i)).not.toBeInTheDocument();
  });

  it("keeps a rejected message in the composer without reconnecting", async () => {
    const user = userEvent.setup();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    const agent = getMainAgent();
    agent.call.mockResolvedValueOnce({
      status: "busy",
      error: "Thread is busy",
    });
    act(() => agent.emitOpen());

    const prompt = screen.getByLabelText("Prompt");
    await user.type(prompt, "try this later");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(prompt).toHaveValue("try this later"));
    expect(agent.reconnect).not.toHaveBeenCalled();
  });

  it("does not restore an accepted message after a later agent error", async () => {
    const user = userEvent.setup();

    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
      />,
    );

    const agent = getMainAgent();
    agent.call.mockResolvedValueOnce({ status: "accepted" });
    act(() => agent.emitOpen());

    const prompt = screen.getByLabelText("Prompt");
    await user.type(prompt, "already accepted");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(prompt).toHaveValue(""));

    act(() => {
      agent.emitStateUpdate({
        lastError: {
          id: "post-accept-error",
          error: "The model failed after accepting the message",
        },
      });
    });

    expect(prompt).toHaveValue("");
  });

  it("sends a new thread's first message from the page, under its initial id, once", async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        initialSend={{ clientMessageId: "initial_thread-1", text: "Build a dashboard" }}
      />,
    );

    const agent = getMainAgent();
    agent.call.mockResolvedValue({ status: "accepted" });
    act(() => agent.emitOpen());

    await waitFor(() => {
      expect(agent.call).toHaveBeenCalledWith(
        "sendMessage",
        ["Build a dashboard", "initial_thread-1"],
        { timeout: 15_000 },
      );
    });
    // A reopen after it was accepted does not send it again.
    act(() => agent.emitOpen());
    expect(agent.call.mock.calls.filter(([method]) => method === "sendMessage")).toHaveLength(1);
    expect(screen.getByLabelText("Prompt")).toHaveValue("");
  });

  it("puts a refused first message back in the composer with its error", async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        initialSend={{ clientMessageId: "initial_thread-1", text: "Build a dashboard" }}
      />,
    );

    const agent = getMainAgent();
    agent.call.mockResolvedValueOnce({ status: "error", error: "Your organization is out of credits." });
    act(() => agent.emitOpen());

    await waitFor(() => expect(screen.getByLabelText("Prompt")).toHaveValue("Build a dashboard"));
    expect(await screen.findByText(/out of credits/)).toBeInTheDocument();
  });

  it("shows the provider message for a rate-limit error via agent state", async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        llmProvider="anthropic"
      />,
    );

    const agent = getMainAgent();
    act(() => {
      agent.emitOpen();
      agent.emitStateUpdate({
        lastError: {
          id: "error-1",
          error: RATE_LIMIT_ERROR,
          billingSource: "byok",
          provider: "bedrock",
          status: null,
          errorType: null,
        },
      });
    });

    // Rate limits are no longer special-cased into a per-provider card, so the
    // provider's own wording reaches the user and no wait is invented.
    expect(await screen.findByText(/rate limited/)).toBeInTheDocument();
    expect(screen.queryByText(/60 seconds/)).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Bedrock console/ })).toBeNull();
  });

  it("shows a thread that could not move read-only: its note, no composer, and no connection", () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[
          { id: "m1", thread_id: "thread-1", role: "user", content: "hello", created_at: 1 },
        ]}
        readOnly
        readOnlyNotice={readOnlyMoveNotice("too_large", true)}
      />,
    );

    expect(
      screen.getByRole("note"),
    ).toHaveTextContent(
      "It is too large to move to camelAI's new chat engine, so it is read-only. Start a new chat to continue. Only its most recent messages are shown.",
    );
    expect(screen.queryByLabelText("Prompt")).not.toBeInTheDocument();
    expect(getMainAgent().options.enabled).toBe(false);
  });
});
