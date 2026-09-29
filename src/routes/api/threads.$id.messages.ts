import type { ActionFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import { waitUntil } from "@/lib/wait-until";
import { RUNTIME_REQUEST_ID } from "@/lib/agent-runtime-shared";
import { startRuntimeTurn } from "../../../workers/main/src/agent-runtime/thread-runtime";
import { RuntimeApiError } from "../../../workers/main/src/agent-runtime/runtime-api";
import { recordRuntimeSendFailure } from "../../../workers/main/src/agent-runtime/runtime-thread-telemetry";
import { actionOnlyLoader } from '@/lib/method-not-allowed';

export const loader = actionOnlyLoader('POST');

/**
 * POST /api/threads/:id/messages {text, clientMessageId}: send a message to a
 * runtime thread. Answers Chat.tsx's SendMessageResult shape
 * ({status: "accepted" | "busy" | "error"}); a retry with the same
 * clientMessageId is the same request.
 */
export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const body = (await request.json().catch(() => null)) as
    | { text?: unknown; clientMessageId?: unknown; workspaceId?: unknown }
    | null;
  const text = typeof body?.text === "string" ? body.text : "";
  const clientMessageId = typeof body?.clientMessageId === "string" ? body.clientMessageId.trim() : "";
  if (!text.trim()) return Response.json({ status: "error", error: "Empty message" }, { status: 400 });
  // The runtime takes it as the request id, which must match its format.
  if (!RUNTIME_REQUEST_ID.test(clientMessageId)) {
    return Response.json(
      { status: "error", error: "clientMessageId must be 1-80 letters, digits, _ or -" },
      { status: 400 },
    );
  }
  const { env, context: threadContext, sender, row } = await requireRuntimeThread(
    request,
    context,
    params.id,
    requestWorkspaceId(request, body),
  );
  try {
    const result = await startRuntimeTurn(env, {
      context: threadContext,
      row,
      sender,
      text,
      clientMessageId,
      source: "web",
      waitUntil,
    });
    recordRuntimeSendFailure(env, threadContext, "send", { result });
    return Response.json(result);
  } catch (error) {
    console.error("[runtime-thread] send failed", error);
    recordRuntimeSendFailure(env, threadContext, "send", { error });
    const message = error instanceof Error ? error.message : "Failed to send message";
    // The runtime refused the request itself: a resend would be refused too.
    if (error instanceof RuntimeApiError && error.status >= 400 && error.status < 500) {
      return Response.json({ status: "error", error: message });
    }
    // The runtime or the network failed: the message may or may not have been
    // taken. Chat retries it under the same clientMessageId, which the runtime
    // deduplicates, as it does on the DO path.
    return Response.json({ error: message, retryable: true }, { status: 503 });
  }
}
