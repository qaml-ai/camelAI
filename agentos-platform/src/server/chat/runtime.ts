export type AgentRuntimeEvent =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input: Record<string, unknown>;
    }
  | { type: "tool_result"; id: string; content: string; isError?: boolean }
  | { type: "tool_stream"; id: string; text: string }
  | {
      type: "ask_user";
      questionId: string;
      questions: Array<{
        question: string;
        options: Array<{ label: string; description?: string }>;
      }>;
    }
  | { type: "done" }
  | { type: "error"; error: string };

export interface AgentRuntime {
  prompt(input: {
    content: string;
    signal?: AbortSignal;
    onEvent: (event: AgentRuntimeEvent) => void | Promise<void>;
  }): Promise<void>;
  cancel(): Promise<void>;
}

export type AgentRuntimePrompt = AgentRuntime["prompt"];

function throwIfCancelled(cancelled: boolean, signal?: AbortSignal): void {
  if (cancelled || signal?.aborted) {
    throw new DOMException("Agent turn was cancelled", "AbortError");
  }
}

/**
 * Small deterministic runtime used by unit tests and local development.
 */
export class MockAgentRuntime implements AgentRuntime {
  private cancelled = false;

  async prompt({
    content,
    signal,
    onEvent,
  }: Parameters<AgentRuntime["prompt"]>[0]): Promise<void> {
    this.cancelled = false;
    throwIfCancelled(this.cancelled, signal);

    if (content.toLowerCase().includes("tool")) {
      await onEvent({
        type: "tool_call",
        id: "mock-tool-1",
        name: "read",
        input: { path: "README.md" },
      });
      throwIfCancelled(this.cancelled, signal);
      await onEvent({
        type: "tool_result",
        id: "mock-tool-1",
        content: "Mock file contents",
      });
    }

    const askIndex = content.toLowerCase().indexOf("ask:");
    if (askIndex !== -1) {
      const question =
        content.slice(askIndex + "ask:".length).trim() || "What should I do next?";
      await onEvent({
        type: "ask_user",
        questionId: "mock-question-1",
        questions: [
          {
            question,
            options: [
              { label: "Continue" },
              { label: "Cancel", description: "Stop this task" },
            ],
          },
        ],
      });
    }

    throwIfCancelled(this.cancelled, signal);
    const normalized = content.trim().replace(/\s+/g, " ").slice(0, 80);
    await onEvent({
      type: "text_delta",
      text: normalized ? `Mock reply: ${normalized}` : "Mock reply.",
    });
    throwIfCancelled(this.cancelled, signal);
    await onEvent({ type: "done" });
  }

  async cancel(): Promise<void> {
    this.cancelled = true;
  }
}

export type AgentOsRuntimeOptions = {
  promptFn?: AgentRuntimePrompt;
  cancelFn?: () => void | Promise<void>;
};

/**
 * Injection seam for the live actor-owned agentOS session.
 */
export class AgentOsRuntime implements AgentRuntime {
  constructor(private readonly options: AgentOsRuntimeOptions = {}) {}

  async prompt(input: Parameters<AgentRuntime["prompt"]>[0]): Promise<void> {
    if (!this.options.promptFn) {
      throw new Error(
        "AgentOsRuntime requires chatThread actor with live agentOS session — use mock in unit tests",
      );
    }
    await this.options.promptFn(input);
  }

  async cancel(): Promise<void> {
    await this.options.cancelFn?.();
  }
}

export type CreateAgentRuntimeOptions =
  | { mode: "mock" }
  | ({ mode: "agentos" } & AgentOsRuntimeOptions);

export function createAgentRuntime(
  options: CreateAgentRuntimeOptions,
): AgentRuntime {
  if (options.mode === "mock") {
    return new MockAgentRuntime();
  }
  return new AgentOsRuntime(options);
}
