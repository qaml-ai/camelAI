import { describe, expect, it, vi } from "vitest";

import { ChatThreadDO } from "../src/chat-thread-do";

describe("ChatThreadDO collaborator lifecycle", () => {
  it("memoizes every collaborator for the lifetime of the DO instance", () => {
    const fake = Object.create(ChatThreadDO.prototype) as Record<string, unknown>;
    fake.env = {};
    const collaboratorKeys = [
      "codeModeArtifacts",
      "projectActivity",
      "automationRun",
      "piCoreStore",
      "uiMirror",
      "piTurnJournal",
      "chatAccess",
      "channelTools",
      "piModelMapping",
      "chatErrors",
      "previewState",
      "streamingActivity",
      "threadMetadata",
    ];

    for (const key of collaboratorKeys) {
      expect(fake[key], key).toBe(fake[key]);
    }
  });

  it("keeps dependency callbacks bound to live owner methods", async () => {
    const get = vi.fn(() => []);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      storage: {
        kv: { get, delete: vi.fn() },
      },
    };

    const collaborator = fake.codeModeArtifacts;
    fake.codeModeArtifactsKey = vi.fn(() => "dynamic-key");

    await collaborator.consumeCodeModeArtifacts("tool-call");

    expect(fake.codeModeArtifactsKey).toHaveBeenCalledWith("tool-call");
    expect(get).toHaveBeenCalledWith("dynamic-key");
  });
});
