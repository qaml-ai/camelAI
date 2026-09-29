import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/components/message-bubble", () => ({
  MessageBubble: ({ message }: { message: { content: string } }) => (
    <div data-testid="bubble">{message.content}</div>
  ),
}));

const { NewChatPending } = await import("@/components/chat/new-chat-pending");

describe("NewChatPending", () => {
  it("shows the user's message and the working indicator from the click", () => {
    render(
      <NewChatPending
        message={{
          id: "new-chat-pending",
          thread_id: "",
          role: "user",
          content: "Build a dashboard",
          created_at: 1,
        }}
        startedAt={Date.now()}
      />,
    );
    expect(screen.getByTestId("bubble")).toHaveTextContent("Build a dashboard");
    expect(screen.getByLabelText("Agent is working")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Chat messages" })).toHaveAttribute("aria-busy", "true");
  });

  it("shows only the indicator for a chat started without a typed message", () => {
    render(<NewChatPending message={null} startedAt={Date.now()} />);
    expect(screen.queryByTestId("bubble")).toBeNull();
    expect(screen.getByLabelText("Agent is working")).toBeInTheDocument();
  });
});
