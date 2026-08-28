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

vi.mock("sonner", () => ({ toast: mockToast }));
vi.mock("@/hooks/use-auth-data", () => ({
  useAuthData: () => ({
    user: { id: "user-1", name: "Illiana" },
    currentWorkspace: { id: "ws-1", name: "Workspace 1" },
    currentOrg: { id: "org-1", name: "Org 1" },
    orgs: [{ org_id: "org-1", role: "owner" }],
  }),
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }));
vi.mock("@/components/page-header", () => ({ PageHeader: () => null }));
vi.mock("@/components/prompt-input", () => ({
  PromptInput: ({
    value,
    onChange,
    onSubmit,
    onStop,
    textareaRef,
  }: {
    value: string;
    onChange: (value: string) => void;
    onSubmit: () => void;
    onStop: () => void;
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
      <button type="button" onClick={onStop}>
        Stop
      </button>
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
vi.mock("@/components/loading-dots", () => ({ LoadingDots: () => null }));
vi.mock("@/components/welcome-screen", () => ({ WelcomeScreen: () => null }));
vi.mock("@/components/floating-todo", () => ({ FloatingTodoList: () => null }));
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

const runtime = vi.hoisted(() => {
  const sendMessage = vi.fn();
  const control = vi.fn();
  const reconnect = vi.fn();
  const listeners = new Set<() => void>();
  let options: Record<string, unknown> | null = null;
  let snapshot: Record<string, unknown>;

  const reset = () => {
    sendMessage.mockReset().mockResolvedValue({
      accepted: true,
      duplicate: false,
      turnId: "turn-1",
      status: "queued",
    });
    control.mockReset().mockResolvedValue({ ok: true });
    reconnect.mockReset();
    options = null;
    snapshot = {
      runtimeMessages: [],
      messages: [],
      state: undefined,
      activeTurn: null,
      status: "idle",
      connectionStatus: "ready",
      ready: true,
      connecting: false,
      offline: false,
      reconnect,
      sendMessage,
      control,
    };
  };
  reset();

  return {
    sendMessage,
    control,
    reconnect,
    reset,
    setOptions: (value: Record<string, unknown>) => {
      options = value;
    },
    get options() {
      return options;
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    update: (patch: Record<string, unknown>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    },
  };
});

vi.mock("@/lib/use-chat-runtime", async () => {
  const ReactModule = await vi.importActual<typeof import("react")>("react");
  return {
    useChatRuntime: (options: Record<string, unknown>) => {
      runtime.setOptions(options);
      return ReactModule.useSyncExternalStore(
        runtime.subscribe,
        runtime.getSnapshot,
        runtime.getSnapshot,
      );
    },
  };
});

import Chat from "@/components/Chat";

const RATE_LIMIT_ERROR =
  '429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}';

describe("Chat V2 runtime controls", () => {
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
    runtime.reset();
    localStorage.clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("answers through the control endpoint and restores focus", async () => {
    const user = userEvent.setup();
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );
    const prompt = screen.getByLabelText("Prompt");
    prompt.focus();

    act(() =>
      runtime.update({
        state: {
          pendingQuestion: {
            questionId: "question-1",
            questions: [
              {
                header: "Framework",
                question: "Which framework do you want?",
                multiSelect: false,
                options: [{ label: "Remix", description: "" }],
              },
            ],
          },
        },
      }),
    );
    await user.click(screen.getByRole("button", { name: "Answer question" }));

    expect(runtime.control).toHaveBeenCalledWith("answer_question", {
      questionId: "question-1",
      answers: { "Which framework do you want?": "Remix" },
    });
    await waitFor(() => expect(prompt).toHaveFocus());
  });

  it("posts while the receive stream is offline", async () => {
    const user = userEvent.setup();
    runtime.update({
      connectionStatus: "offline",
      ready: false,
      offline: true,
    });
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );
    await user.type(screen.getByLabelText("Prompt"), "send independently");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(runtime.sendMessage).toHaveBeenCalledWith({
      clientMessageId: expect.stringMatching(/^client_/),
      content: "send independently",
      display: "send independently",
    });
  });

  it("stops the active turn through the bounded control endpoint", async () => {
    const user = userEvent.setup();
    runtime.update({ status: "running" });
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );

    await user.click(screen.getByRole("button", { name: "Stop" }));
    expect(runtime.control).toHaveBeenCalledWith("stop");
  });

  it("restores a message when admission rejects it", async () => {
    const user = userEvent.setup();
    runtime.sendMessage.mockRejectedValueOnce(new Error("Queue is full"));
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );
    const prompt = screen.getByLabelText("Prompt");
    await user.type(prompt, "try this later");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(prompt).toHaveValue("try this later"));
    expect(screen.getByText("Queue is full")).toBeInTheDocument();
  });

  it("reuses the exact client id when every admission ACK is lost", async () => {
    const user = userEvent.setup();
    runtime.sendMessage
      .mockRejectedValueOnce(new TypeError("response lost"))
      .mockResolvedValueOnce({
        accepted: true,
        duplicate: true,
        turnId: "turn-1",
        status: "queued",
      });
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );
    const prompt = screen.getByLabelText("Prompt");
    await user.type(prompt, "deduplicate me");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(prompt).toHaveValue("deduplicate me"));
    const first = runtime.sendMessage.mock.calls[0][0];

    await user.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(runtime.sendMessage).toHaveBeenCalledTimes(2));
    expect(runtime.sendMessage.mock.calls[1][0]).toEqual(first);
    await waitFor(() => expect(prompt).toHaveValue(""));
  });

  it("treats a matching durable snapshot as the lost admission ACK", async () => {
    const user = userEvent.setup();
    runtime.sendMessage.mockRejectedValueOnce(new TypeError("response lost"));
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );
    const prompt = screen.getByLabelText("Prompt");
    await user.type(prompt, "already durable");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(prompt).toHaveValue("already durable"));
    const clientMessageId =
      runtime.sendMessage.mock.calls[0][0].clientMessageId;

    act(() =>
      runtime.update({
        messages: [
          {
            id: clientMessageId,
            clientMessageId,
            role: "user",
            content: "already durable",
            createdAt: 1,
            status: "queued",
          },
        ],
      }),
    );

    await waitFor(() => expect(prompt).toHaveValue(""));
    expect(runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("does not restore a durably accepted message after a later error", async () => {
    const user = userEvent.setup();
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );
    const prompt = screen.getByLabelText("Prompt");
    await user.type(prompt, "already accepted");
    await user.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(prompt).toHaveValue(""));

    act(() =>
      runtime.update({
        state: { lastError: { id: "post-accept", error: "Model failed" } },
      }),
    );
    expect(prompt).toHaveValue("");
  });

  it("surfaces a legacy-history restoration failure without rejecting the queued message", async () => {
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );

    act(() =>
      runtime.update({
        state: {
          legacyMigrationError: {
            id: "legacy-migration:1",
            error:
              "Recent chat history could not be restored. This message will continue without older context.",
          },
        },
      }),
    );

    expect(
      await screen.findByText(
        "Recent chat history could not be restored. This message will continue without older context.",
      ),
    ).toBeInTheDocument();
  });

  it("uses worker provider metadata for BYOK errors", async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        llmProvider={null}
      />,
    );
    act(() =>
      runtime.update({
        state: {
          lastError: {
            id: "error-1",
            error: RATE_LIMIT_ERROR,
            billingSource: "byok",
            provider: "bedrock",
          },
        },
      }),
    );

    expect(
      await screen.findByText("Your Bedrock API key is rate limited"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open the AWS Bedrock console/ }),
    ).toHaveAttribute("href", BYOK_PROVIDERS.bedrock.getKeyUrl);
  });

  it("falls back to the selected provider when error metadata omits it", async () => {
    render(
      <Chat
        threadId="thread-1"
        workspaceId="ws-1"
        initialMessages={[]}
        llmProvider="anthropic"
      />,
    );
    act(() =>
      runtime.update({
        state: {
          lastError: {
            id: "error-2",
            error: RATE_LIMIT_ERROR,
            billingSource: "byok",
          },
        },
      }),
    );

    expect(
      await screen.findByText("Your Anthropic API key is rate limited"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /Open Anthropic API settings/ }),
    ).toHaveAttribute("href", BYOK_PROVIDERS.anthropic.getKeyUrl);
  });

  it("mounts V2 for the thread and exposes reconnect", async () => {
    const user = userEvent.setup();
    runtime.update({
      connectionStatus: "offline",
      ready: false,
      offline: true,
    });
    render(
      <Chat threadId="thread-1" workspaceId="ws-1" initialMessages={[]} />,
    );

    expect(runtime.options).toMatchObject({
      threadId: "thread-1",
      enabled: true,
    });
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(runtime.reconnect).toHaveBeenCalledTimes(1);
  });
});
