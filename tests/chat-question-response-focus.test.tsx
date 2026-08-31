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
import { BYOK_PROVIDERS } from "@/lib/byok-providers";
import { CHAT_SSE_CLOSE_UNAUTHORIZED } from "@/lib/chat-sse-close";

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

// Chat connects through the SSE transport (`useSseAgent`). Mock the hook so tests
// can drive the connection directly instead of scripting fetch/SSE frames.
const agentRuntime = vi.hoisted(() => {
  type AgentOptions = {
    agent: string;
    name: string;
    enabled?: boolean;
    query?: Record<string, string | null | undefined>;
    onOpen?: () => void;
    onMessage?: (event: { data: string }) => void;
    onClose?: (event?: unknown) => void;
    onConnectionError?: (error: {
      code?: number;
      reason?: string;
      wasClean?: boolean;
    }) => void;
    onStateUpdate?: (state: unknown) => void;
  };

  class MockAgentClient {
    static instances: MockAgentClient[] = [];

    options: AgentOptions;
    // 0 = CONNECTING, 1 = OPEN, 3 = CLOSED (SseAgentClient keeps the numbers).
    readyState = 0;
    send = vi.fn();
    call = vi.fn(
      async (
        _method: string,
        _args?: unknown[],
        _options?: { timeout?: number },
      ): Promise<unknown> => undefined,
    );
    reconnect = vi.fn();
    start = vi.fn();
    close = vi.fn();

    constructor(options: AgentOptions) {
      this.options = options;
      MockAgentClient.instances.push(this);
    }

    emitOpen() {
      this.readyState = 1;
      this.options.onOpen?.();
    }

    emitMessage(payload: unknown) {
      this.options.onMessage?.({ data: JSON.stringify(payload) });
    }

    emitStateUpdate(state: unknown) {
      this.options.onStateUpdate?.(state);
    }

    emitClose(event?: unknown) {
      this.readyState = 3;
      this.options.onClose?.(event);
    }

    /** Server parked the stream (`bye {"reason":"idle"}`): still OPEN for sends. */
    emitIdlePark() {
      this.readyState = 1;
      this.options.onClose?.({
        byeReason: "idle",
        status: null,
        reason: "idle",
        aborted: false,
        wasClean: true,
      });
    }

    emitConnectionError(error: {
      code?: number;
      reason?: string;
      wasClean?: boolean;
    }) {
      this.readyState = 3;
      this.options.onConnectionError?.(error);
    }
  }

  const registry = new Map<string, MockAgentClient>();

  function useSseAgent(options: AgentOptions) {
    const key = `${options.agent}:${options.name}`;
    let instance = registry.get(key);
    if (!instance) {
      instance = new MockAgentClient(options);
      registry.set(key, instance);
    } else {
      // Refresh the captured callbacks so emits run the latest handlers.
      instance.options = options;
    }
    return instance;
  }

  function reset() {
    registry.clear();
    MockAgentClient.instances = [];
  }

  return { useSseAgent, reset, MockAgentClient };
});

vi.mock("@/lib/use-sse-agent", () => ({
  useSseAgent: agentRuntime.useSseAgent,
}));

// Chat owns its transcript through ai-chat (useAgentChat) now; this test drives
// pendingQuestion via Agent state, not the live stream, so stub the projection
// hook to keep the real ai-chat client out of the render.
vi.mock("@/lib/use-pi-chat-stream", () => ({
  usePiChatStream: () => ({
    messages: [],
    uiMessages: [],
    status: "ready",
    isStreaming: false,
    streamingMessageId: null,
    setUiMessages: vi.fn(),
  }),
}));

import Chat from "@/components/Chat";

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

  it("uses worker provider metadata for BYOK rate-limit errors via agent state", async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        llmProvider={null}
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

    expect(
      await screen.findByText("Your Bedrock API key is rate limited"),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: /Open the AWS Bedrock console/,
    });
    expect(link).toHaveAttribute("href", BYOK_PROVIDERS.bedrock.getKeyUrl);
  });

  it("falls back to the current provider when error provider metadata is absent", async () => {
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
          id: "error-2",
          error: RATE_LIMIT_ERROR,
          billingSource: "byok",
          provider: null,
          status: null,
          errorType: null,
        },
      });
    });

    expect(
      await screen.findByText("Your Anthropic API key is rate limited"),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", {
      name: /Open Anthropic API settings/,
    });
    expect(link).toHaveAttribute("href", BYOK_PROVIDERS.anthropic.getKeyUrl);
  });

  it("mounts the SSE transport for the thread without the WebSocket timing knobs", () => {
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );

    const agent = getMainAgent();
    expect(agent.options.enabled).toBe(true);
    expect(agent.options.query).toEqual({
      threadId: "thread-1",
      workspaceId: "ws-1",
    });
    // PartySocket knobs have no meaning for fetch+SSE; passing them through
    // would silently do nothing.
    expect(agent.options).not.toHaveProperty("connectionTimeout");
    expect(agent.options).not.toHaveProperty("minReconnectionDelay");
    expect(agent.options).not.toHaveProperty("maxReconnectionDelay");
  });

  it("still dispatches a send while the server has parked the stream as idle", async () => {
    const user = userEvent.setup();

    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );

    const agent = getMainAgent();
    agent.call.mockResolvedValue({ status: "accepted" });
    act(() => {
      agent.emitOpen();
      agent.emitIdlePark();
    });

    await user.type(screen.getByLabelText("Prompt"), "wake the stream");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(agent.call).toHaveBeenCalledWith(
      "sendMessage",
      ["wake the stream", expect.stringMatching(/^client_/)],
      { timeout: 15_000 },
    );
  });

  it("surfaces the SSE terminal-close copy when the transport gives up", () => {
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );

    const agent = getMainAgent();
    act(() => {
      agent.emitOpen();
      agent.emitConnectionError({
        code: CHAT_SSE_CLOSE_UNAUTHORIZED,
        reason: "Unauthorized",
        wasClean: false,
      });
    });

    expect(mockToast.error).toHaveBeenCalledWith(
      expect.stringMatching(/session expired/i),
      expect.objectContaining({ id: "chat-sse-terminal-close" }),
    );
  });
});
