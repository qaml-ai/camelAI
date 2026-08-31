import { describe, expect, it, vi } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { ChatThreadDO } from "../src/chat-thread-do";
import { summarizeAdminExplorerThread } from "../src/pi-message-export";

describe("summarizeAdminExplorerThread", () => {
  it("counts visible user messages, caps the total, and reports model errors", () => {
    const messages = [
      { role: "user", content: "first", timestamp: 1 },
      {
        role: "user",
        content: "internal",
        visibility: "hidden",
        timestamp: 2,
      },
      {
        role: "user",
        content: "summary",
        metadata: { compactSummary: true },
        timestamp: 3,
      },
      { role: "user", content: "second", timestamp: 4 },
      { role: "user", content: "over the cap", timestamp: 5 },
      {
        role: "assistant",
        content: [],
        responseModel: "gateway-model",
        model: "provider-model",
        stopReason: "error",
        errorMessage: "Provider failed",
        timestamp: 6,
      },
      {
        role: "assistant",
        content: [],
        model: "provider-model",
        stopReason: "aborted",
        errorMessage: "Ignored abort",
        timestamp: 7,
      },
    ] as unknown as AgentMessage[];

    expect(
      summarizeAdminExplorerThread(messages, {
        userMessageCap: 2,
        sessionModelId: "live-model",
      }),
    ).toEqual({
      userMessageCount: 2,
      userMessageCountCapped: true,
      hasError: true,
      errorCount: 1,
      lastErrorAt: 6,
      lastErrorMessage: "Provider failed",
      models: ["gateway-model", "provider-model", "live-model"],
    });
  });

  it("uses the default cap and returns an empty error summary", () => {
    const messages = Array.from({ length: 20 }, (_, index) => ({
      role: "user",
      content: `message ${index}`,
      timestamp: index,
    })) as unknown as AgentMessage[];

    expect(summarizeAdminExplorerThread(messages)).toEqual({
      userMessageCount: 20,
      userMessageCountCapped: false,
      hasError: false,
      errorCount: 0,
      lastErrorAt: null,
      lastErrorMessage: null,
      models: [],
    });
  });

  it("forwards summary options through the ChatThreadDO facade", async () => {
    const messages = [
      { role: "user", content: "first", timestamp: 1 },
      { role: "user", content: "second", timestamp: 2 },
    ] as unknown as AgentMessage[];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadFullPiCoreTranscriptUnbounded = vi.fn(async () => messages);
    fake.piSession = { state: { model: { id: "live-model" } } };

    const summary = await ChatThreadDO.prototype.getAdminExplorerSummary.call(fake, {
      userMessageCap: 1,
    });

    expect(fake.loadFullPiCoreTranscriptUnbounded).toHaveBeenCalledWith({
      includeUiMetadata: true,
      imagePolicy: "render",
    });
    expect(summary).toMatchObject({
      userMessageCount: 1,
      userMessageCountCapped: true,
      models: ["live-model"],
    });
  });
});
