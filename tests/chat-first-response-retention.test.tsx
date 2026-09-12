import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
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

vi.mock("@/components/message-bubble", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/components/message-bubble")>()),
  MessageBubble: ({ message }: { message: import("@/types").Message }) => (
    <div data-testid={`message-${message.id}`}>
      {typeof message.content === "string"
        ? message.content
        : message.content
            .map((part) => (part.type === "text" ? part.text : ""))
            .join("")}
    </div>
  ),
}));

vi.mock("@/components/loading-dots", () => ({
  LoadingDots: () => null,
}));

vi.mock("@/components/camel-loader/camel-loader", () => ({
  CamelLoader: () => null,
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

// Keep Chat, usePiChatStream, useAgentChat, and the WebSocket client real.
// Only the network socket and peripheral presentation/context are replaced.
import type { UIMessage } from "ai";
import Chat from "@/components/Chat";
import { FakeChatSocket } from "./helpers/chat-socket";

const firstUserMessage: UIMessage = {
  id: "first-user-message",
  role: "user",
  parts: [{ type: "text", text: "Say hello" }],
};
// The route's warm thread-record seed has a different ID from durable history.
const seededMessages: UIMessage[] = [
  { ...firstUserMessage, id: "thread-seed:thread-1" },
];

function initialHistory() {
  return structuredClone([firstUserMessage]);
}

function renderNewChat(
  initialUiMessages = seededMessages,
  isLoadingMessages = true,
) {
  return (
    <Chat
      threadId="thread-1"
      workspaceId="ws-1"
      initialUiMessages={initialUiMessages}
      isLoadingMessages={isLoadingMessages}
    />
  );
}

function responseChunk(socket: FakeChatSocket, chunk: unknown, done = false) {
  socket.frame({
    type: "cf_agent_use_chat_response",
    id: "first-turn",
    body: chunk === null ? "" : JSON.stringify(chunk),
    done,
  });
}

describe("first response retention in a new chat", () => {
  beforeAll(() => {
    HTMLElement.prototype.scrollTo ??= vi.fn();
    HTMLElement.prototype.scrollIntoView ??= vi.fn();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    FakeChatSocket.instances = [];
    FakeChatSocket.autoOpen = false;
    vi.stubGlobal("WebSocket", FakeChatSocket);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it.each(["during streaming", "after completion"] as const)(
    "keeps the first response when deferred initial history arrives %s",
    async (arrival) => {
      // The new-chat action starts the first turn server-side before redirecting.
      // The destination route seeds its first user bubble from the thread record
      // while the durable history loader is still pending.
      const { rerender } = render(renderNewChat());
      const socket = FakeChatSocket.instances.find((candidate) =>
        candidate.url.includes("/agents/chat-thread/thread-1"),
      );
      expect(socket).toBeDefined();
      act(() => {
        socket!.open();
        socket!.frame({
          type: "cf_agent_chat_messages",
          messages: initialHistory(),
        });
      });

      await act(async () => {
        responseChunk(socket!, { type: "start", messageId: "first-assistant" });
        responseChunk(socket!, { type: "text-start", id: "text-1" });
        responseChunk(socket!, {
          type: "text-delta",
          id: "text-1",
          delta: "Hello from the first response",
        });
      });
      expect(screen.getByText("Hello from the first response")).toBeVisible();

      if (arrival === "during streaming") {
        rerender(renderNewChat(initialHistory(), false));
        expect(screen.getByText("Hello from the first response")).toBeVisible();
      }

      await act(async () => {
        responseChunk(socket!, { type: "text-end", id: "text-1" });
        responseChunk(socket!, { type: "finish", finishReason: "stop" });
        responseChunk(socket!, null, true);
      });
      // Completion itself must retain the response before any loader update.
      expect(screen.getByText("Hello from the first response")).toBeVisible();

      // A loader read begun during the first turn can return the persisted user
      // message after the live response has finished. It is a newly deserialized
      // array, just like a deferred route result, and contains no assistant yet.
      if (arrival === "after completion") {
        rerender(renderNewChat(initialHistory(), false));
      }

      await waitFor(() => {
        expect(screen.getByText("Hello from the first response")).toBeVisible();
        expect(screen.getAllByTestId("message-first-assistant")).toHaveLength(
          1,
        );
      });
    },
  );

  it("hydrates initial history and accepts a newer window on later revalidation", async () => {
    const { rerender } = render(renderNewChat());
    const historicalResponse: UIMessage = {
      id: "historical-assistant",
      role: "assistant",
      parts: [{ type: "text", text: "Previously saved response" }],
    };

    rerender(renderNewChat([firstUserMessage, historicalResponse], false));
    expect(screen.getByText("Previously saved response")).toBeVisible();

    // A disconnected tab can revalidate into a newer bounded history window
    // that no longer contains the assistant from the initial page.
    const newerResponse: UIMessage = {
      id: "newer-assistant",
      role: "assistant",
      parts: [{ type: "text", text: "Response completed while disconnected" }],
    };
    rerender(renderNewChat([newerResponse], false));
    await waitFor(() => {
      expect(
        screen.getByText("Response completed while disconnected"),
      ).toBeVisible();
      expect(
        screen.queryByText("Previously saved response"),
      ).not.toBeInTheDocument();
    });
  });
});
