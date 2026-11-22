import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CamelCodeWelcomeDialog } from "@/components/camel-code-welcome-dialog";

vi.mock("@/components/wave-ribbon", () => ({
  WaveRibbon: () => null,
}));

describe("CamelCodeWelcomeDialog", () => {
  it("renders camelCode throughout the welcome copy", () => {
    render(
      <CamelCodeWelcomeDialog
        open
        onOpenChange={vi.fn()}
        onSeePremiumModels={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("heading", { name: "You're on camelCode" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/our free coding model\. New chats use GPT-6\.1 Terra/),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/priority access to camelCode/),
    ).toBeInTheDocument();
  });
});
