import type { DynamicIntegrationSchema } from "../../../src/lib/integration-registry";
import {
  normalizeAskUserQuestions,
  type NormalizedAskUserQuestion,
} from "../../../src/lib/ask-user-question-normalization";

export interface ConnectionSetupResponse {
  requestId: string;
  cancelled: boolean;
  integration?: {
    type: string;
    name: string;
    config: Record<string, unknown>;
    credentials: Record<string, unknown>;
  };
}

export interface PendingQuestionInfo {
  questionId: string;
  toolUseId?: string;
  questions: NormalizedAskUserQuestion[];
}

interface PendingQuestionWaiter {
  resolve: (answers: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface PendingConnectionSetupPromptInfo {
  createdAt: number;
  integrationId?: string;
  integrationType: string;
  suggestedName?: string;
  message?: string;
  instructions?: string;
  initialConfig?: Record<string, unknown>;
  initialCredentials?: Record<string, unknown>;
  dynamicSchema?: DynamicIntegrationSchema;
}

export interface PendingConnectionSetupPromptData
  extends PendingConnectionSetupPromptInfo {
  requestId: string;
}

interface PendingConnectionSetupWaiter {
  resolve: (response: ConnectionSetupResponse) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
  info: PendingConnectionSetupPromptInfo;
}

interface BrowserPromptCoordinatorOptions {
  hasAvailableBrowserUser: () => boolean;
  broadcast: (message: Record<string, unknown>) => void;
  askUserQuestionUnavailableMessage: string;
  questionTimeoutMs: number;
  connectionSetupTimeoutMs: number;
}

export class BrowserPromptCoordinator {
  private readonly pendingQuestions = new Map<string, PendingQuestionInfo>();
  private readonly pendingQuestionWaiters = new Map<string, PendingQuestionWaiter>();
  private readonly pendingConnectionSetupWaiters =
    new Map<string, PendingConnectionSetupWaiter>();

  constructor(private readonly options: BrowserPromptCoordinatorOptions) {}

  get pendingQuestionCount(): number {
    return this.pendingQuestions.size;
  }

  getOldestPendingQuestion(): PendingQuestionInfo | null {
    const iterator = this.pendingQuestions.values().next();
    return iterator.done ? null : iterator.value;
  }

  pendingQuestionIds(): string[] {
    return [...this.pendingQuestions.keys()];
  }

  pendingQuestionPrompts(): PendingQuestionInfo[] {
    return [...this.pendingQuestions.values()];
  }

  pendingConnectionSetupPrompts(): PendingConnectionSetupPromptData[] {
    return Array.from(this.pendingConnectionSetupWaiters.entries())
      .sort(([, a], [, b]) => a.info.createdAt - b.info.createdAt)
      .map(([requestId, waiter]) => ({ requestId, ...waiter.info }));
  }

  hasPendingConnectionSetup(requestId: string): boolean {
    return Boolean(requestId) && this.pendingConnectionSetupWaiters.has(requestId);
  }

  deletePendingQuestion(questionId: string): void {
    this.pendingQuestions.delete(questionId);
  }

  clearQuestions(): void {
    this.pendingQuestions.clear();
    for (const waiter of this.pendingQuestionWaiters.values()) {
      clearTimeout(waiter.timeoutId);
    }
    this.pendingQuestionWaiters.clear();
  }

  askUserQuestion(input: {
    questions?: unknown[];
    toolUseId?: string;
  }): Promise<Record<string, unknown>> {
    const questions = normalizeAskUserQuestions(input.questions);
    if (questions.length === 0) {
      throw new Error("questions is required");
    }
    if (!this.options.hasAvailableBrowserUser()) {
      return Promise.resolve({
        unavailable_reason: this.options.askUserQuestionUnavailableMessage,
      });
    }
    const questionId = crypto.randomUUID();
    this.pendingQuestions.set(questionId, {
      questionId,
      toolUseId: input.toolUseId,
      questions,
    });
    this.options.broadcast({
      type: "ask_user_question",
      questionId,
      toolUseId: input.toolUseId,
      questions,
    });
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingQuestionWaiters.delete(questionId);
        this.pendingQuestions.delete(questionId);
        this.options.broadcast({
          type: "question_answered",
          questionId,
        });
        reject(new Error("ask_user_question timed out"));
      }, this.options.questionTimeoutMs);
      this.pendingQuestionWaiters.set(questionId, {
        resolve,
        reject,
        timeoutId,
      });
    });
  }

  answerQuestion(input: {
    questionId?: string;
    answers?: unknown;
  }): boolean {
    if (!input.questionId || !input.answers || typeof input.answers !== "object") {
      return false;
    }
    const waiter = this.pendingQuestionWaiters.get(input.questionId);
    if (!waiter) return false;

    this.pendingQuestionWaiters.delete(input.questionId);
    this.pendingQuestions.delete(input.questionId);
    clearTimeout(waiter.timeoutId);
    this.options.broadcast({
      type: "question_answered",
      questionId: input.questionId,
    });
    waiter.resolve(input.answers as Record<string, unknown>);
    return true;
  }

  promptConnectionSetup(input: {
    integrationId?: string;
    integrationType: string;
    suggestedName?: string;
    message?: string;
    instructions?: string;
    initialConfig?: Record<string, unknown>;
    initialCredentials?: Record<string, unknown>;
    dynamicSchema?: DynamicIntegrationSchema;
  }): Promise<ConnectionSetupResponse> {
    const integrationType = input.integrationType?.trim();
    if (!integrationType) {
      throw new Error("integrationType is required");
    }
    if (!this.options.hasAvailableBrowserUser()) {
      return Promise.resolve({ requestId: "", cancelled: true });
    }
    const requestId = crypto.randomUUID();
    const info: PendingConnectionSetupPromptInfo = {
      createdAt: Date.now(),
      integrationId: input.integrationId,
      integrationType,
      suggestedName: input.suggestedName,
      message: input.message,
      instructions: input.instructions,
      initialConfig: input.initialConfig,
      initialCredentials: input.initialCredentials,
      dynamicSchema: input.dynamicSchema,
    };
    const pendingResponse = new Promise<ConnectionSetupResponse>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingConnectionSetupWaiters.delete(requestId);
        this.options.broadcast({
          type: "connection_setup_answered",
          requestId,
        });
        reject(new Error("Connection setup timed out"));
      }, this.options.connectionSetupTimeoutMs);
      this.pendingConnectionSetupWaiters.set(requestId, {
        resolve,
        reject,
        timeoutId,
        info,
      });
    });
    this.options.broadcast({
      type: "connection_setup_prompt",
      requestId,
      integrationId: input.integrationId,
      integrationType,
      suggestedName: input.suggestedName,
      message: input.message,
      instructions: input.instructions,
      initialConfig: input.initialConfig,
      initialCredentials: input.initialCredentials,
      dynamicSchema: input.dynamicSchema,
    });
    return pendingResponse;
  }

  answerConnectionSetup(response: ConnectionSetupResponse): { accepted: boolean } {
    const waiter = this.pendingConnectionSetupWaiters.get(response.requestId);
    if (!response.requestId || !waiter) return { accepted: false };

    this.pendingConnectionSetupWaiters.delete(response.requestId);
    clearTimeout(waiter.timeoutId);
    waiter.resolve(response);
    this.options.broadcast({
      type: "connection_setup_answered",
      requestId: response.requestId,
    });
    return { accepted: true };
  }
}
