export type RuntimeCallArtifactKind =
  | "outbound_email"
  | "outbound_slack_message"
  | "outbound_telegram_message";

export type RuntimeCallArtifactStatus = "sent" | "failed";

export interface RuntimeCallArtifact {
  id: string;
  kind: RuntimeCallArtifactKind;
  toolName: "send_email" | "send_slack_message" | "send_telegram_message";
  status: RuntimeCallArtifactStatus;
  title: string;
  subtitle?: string;
  createdAt: number;
  updatedAt: number;
  summary: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    name: string;
    message: string;
  };
}

export interface RuntimeArtifactPreviewTarget {
  kind: "runtime_artifact";
  artifact: RuntimeCallArtifact;
}

export interface PiUiMetadata {
  codeModeArtifacts?: RuntimeCallArtifact[];
  /**
   * The ai-chat render-history message id this pi_core row streams into (the
   * minted turnId for assistant rows). Stamped at commit time so the pi_core →
   * render-history backfill is an idempotent upsert: same content, same id,
   * regardless of which writer (live stream persist or backfill) runs first.
   * UI-only — stripPiUiMetadata removes it from model-facing loads.
   */
  renderMessageId?: string;
  /**
   * Wall-clock milliseconds the tool took to execute, stamped on toolResult rows
   * at commit time from the live tool_execution_start/end pair. Pi records no
   * start timestamp of its own, so without this the duration is unrecoverable
   * after the fact: an assistant row's `timestamp` is stamped when the model
   * request opens, making result-minus-previous include model latency.
   * UI-only — stripPiUiMetadata removes it from model-facing loads.
   */
  toolDurationMs?: number;
}

export function isRuntimeCallArtifact(value: unknown): value is RuntimeCallArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === "string" &&
    typeof record.kind === "string" &&
    typeof record.toolName === "string" &&
    typeof record.status === "string" &&
    typeof record.title === "string" &&
    typeof record.createdAt === "number" &&
    typeof record.updatedAt === "number" &&
    !!record.summary &&
    typeof record.summary === "object" &&
    !Array.isArray(record.summary)
  );
}

export function normalizeRuntimeCallArtifacts(value: unknown): RuntimeCallArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRuntimeCallArtifact);
}

export function normalizePiUiMetadata(value: unknown): PiUiMetadata | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const codeModeArtifacts = normalizeRuntimeCallArtifacts(record.codeModeArtifacts);
  const renderMessageId =
    typeof record.renderMessageId === "string" && record.renderMessageId.trim()
      ? record.renderMessageId.trim()
      : undefined;
  const toolDurationMs =
    typeof record.toolDurationMs === "number" &&
    Number.isFinite(record.toolDurationMs) &&
    record.toolDurationMs >= 0
      ? Math.round(record.toolDurationMs)
      : undefined;
  if (codeModeArtifacts.length === 0 && !renderMessageId && toolDurationMs === undefined) {
    return undefined;
  }
  return {
    ...(codeModeArtifacts.length > 0 ? { codeModeArtifacts } : {}),
    ...(renderMessageId ? { renderMessageId } : {}),
    ...(toolDurationMs === undefined ? {} : { toolDurationMs }),
  };
}

export function stripPiUiMetadata<T>(message: T): T {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const record = message as Record<string, unknown>;
  if (!("uiMetadata" in record)) return message;
  const { uiMetadata: _uiMetadata, ...rest } = record;
  return rest as T;
}
