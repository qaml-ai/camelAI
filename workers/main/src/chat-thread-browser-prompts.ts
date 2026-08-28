import type { DynamicIntegrationSchema } from "../../../src/lib/integration-registry";
import type { NormalizedAskUserQuestion } from "../../../src/lib/ask-user-question-normalization";

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

export interface PendingConnectionSetupPromptData {
  requestId: string;
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
