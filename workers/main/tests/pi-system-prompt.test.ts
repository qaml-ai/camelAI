import { describe, expect, it, vi } from "vitest";
import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";

import {
  DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT,
  createPiSystemPrompt,
  createPiSubagentSystemPrompt,
} from "../src/pi-system-prompt";

const context = {
  threadId: "thread_1",
  workspaceId: "workspace_1",
  orgId: "org_1",
};

describe("createPiSystemPrompt deployed CONNECTIONS binding", () => {
  it("keeps js_exec CONNECTIONS guidance and omits the disable caveat by default", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
    });

    expect(prompt).toContain('await env.CONNECTIONS.find("provider-or-type")');
    expect(prompt).toContain(
      "`integration-dashboard` for apps centered on workspace connections",
    );
    expect(prompt).not.toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
    expect(prompt).toContain("Use top-level `delete_app`");
    expect(prompt).toContain("Use top-level `delete_project`");
    expect(prompt).toContain("always deletes every linked deployed app first");
  });

  it("adds a deployed-app CONNECTIONS disable caveat and softens the integration-dashboard template", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
      deployedConnectionsBindingEnabled: false,
    });

    expect(prompt).toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
    expect(prompt).toContain('await env.CONNECTIONS.find("provider-or-type")');
    expect(prompt).toContain(
      "`integration-dashboard` only when the UI is local/mock and never calls CONNECTIONS",
    );
    expect(prompt).not.toContain(
      "`integration-dashboard` for apps centered on workspace connections",
    );
  });

  it("propagates the caveat to subagent prompts", () => {
    const prompt = createPiSubagentSystemPrompt(context, "agent", {
      skillNames: ["developing-software"],
      deployedConnectionsBindingEnabled: false,
    });

    expect(prompt).toContain(DEPLOYED_CONNECTIONS_BINDING_DISABLED_PROMPT);
    expect(prompt).toContain("## Subagent Mode");
  });
});

describe("createPiSystemPrompt bounds", () => {
  it("rejects a huge description before regex normalization", () => {
    const replace = vi.spyOn(String.prototype, "replace");
    let thrown: unknown;
    try {
      createPiSystemPrompt(context, {
        skillNames: ["oversized"],
        skillDescriptions: {
          oversized: "x".repeat(CHAT_RUNTIME_BOUNDS.systemPromptBytes + 1),
        },
        maxBytes: CHAT_RUNTIME_BOUNDS.systemPromptBytes,
      });
    } catch (error) {
      thrown = error;
    } finally {
      replace.mockRestore();
    }

    expect(thrown).toMatchObject({
      message: "Skill description exceeds the system-prompt byte limit",
    });
    expect(replace).not.toHaveBeenCalled();
  });

  it("rejects aggregate prompt overflow before the final join", () => {
    const join = vi.spyOn(Array.prototype, "join");
    let thrown: unknown;
    try {
      createPiSystemPrompt(context, {
        skillNames: Array.from(
          { length: 10_000 },
          (_, index) => `skill-${index}`,
        ),
        maxBytes: CHAT_RUNTIME_BOUNDS.systemPromptBytes,
      });
    } catch (error) {
      thrown = error;
    } finally {
      join.mockRestore();
    }

    expect(thrown).toMatchObject({
      message: "System prompt exceeds its runtime byte limit",
    });
    expect(join).not.toHaveBeenCalled();
  });

  it("never invokes a skill-description accessor", () => {
    const getter = vi.fn(() => "leaked");
    const descriptions: Record<string, string | undefined> = {};
    Object.defineProperty(descriptions, "unsafe", {
      get: getter,
      enumerable: true,
    });

    expect(() =>
      createPiSystemPrompt(context, {
        skillNames: ["unsafe"],
        skillDescriptions: descriptions,
        maxBytes: CHAT_RUNTIME_BOUNDS.systemPromptBytes,
      }),
    ).toThrow("Skill description contains an accessor");
    expect(getter).not.toHaveBeenCalled();
  });

  it("returns a prompt inside the exact UTF-8 ceiling", () => {
    const prompt = createPiSystemPrompt(context, {
      skillNames: ["developing-software"],
      maxBytes: CHAT_RUNTIME_BOUNDS.systemPromptBytes,
    });
    expect(new TextEncoder().encode(prompt).byteLength).toBeLessThanOrEqual(
      CHAT_RUNTIME_BOUNDS.systemPromptBytes,
    );
  });
});
