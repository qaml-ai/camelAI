import { CAMEL_CODE_LLM_MODEL } from "../../../../src/lib/llm-provider-config";
import type { ChatEnv } from "../chat-thread/types";
import type { OrgThread, ThreadRuntimeRecord } from "../identity/org-do";
import { HOSTED_KEY_SCOPE } from "./key-scopes";
import { CAMEL_CODE_RUNTIME_MODEL, isPreviousCamelCodeRuntimeModel, v2HostedModelMatches } from "./model-routes";
import { RuntimeApiError, v2WorkspaceEnabled } from "./runtime-api";
import { RUNTIME_PROMPT_VERSION } from "./runtime-prompt";
import { v2AgentPath, v2Json } from "./runtime-v2";

/** Keep the app placement and transcript. CamelRun changes only the model at an idle boundary. */
export async function moveCamelCodeThreadToSol(
  env: ChatEnv,
  thread: Pick<OrgThread, "model" | "source" | "channel_kind" | "workspace_id"> | null,
  row: ThreadRuntimeRecord | null,
  apply: boolean,
) {
  if (!thread) return { status: "missing" };
  if (thread.model !== CAMEL_CODE_LLM_MODEL) return { status: "ineligible" };
  if (!row) return { status: thread.source === "scheduled" ? "scheduled_handoff" : "needs_legacy_handoff" };
  if (!row.agentId || row.keyScope !== HOSTED_KEY_SCOPE) return { status: "ineligible" };
  if (row.model === CAMEL_CODE_RUNTIME_MODEL) return { status: "already_sol" };
  if (!isPreviousCamelCodeRuntimeModel(row.model)) return { status: "ineligible" };
  if (!row.runtimeVersion) {
    if (thread.source === "scheduled") return { status: "scheduled_handoff" };
    return { status: thread.source === "channel" || thread.channel_kind ? "v1_channel" : "needs_v1_handoff" };
  }
  if (row.pendingFirstMessage) return { status: "pending_first_message" };
  if (!v2WorkspaceEnabled(env, thread.workspace_id) || !v2HostedModelMatches({
    kind: "scope", keyScope: HOSTED_KEY_SCOPE, model: CAMEL_CODE_RUNTIME_MODEL,
  }, env)) return { status: "sol_not_enabled" };
  // A send with stale instructions can still reconfigure the whole agent.
  if (row.configured?.promptVersion !== RUNTIME_PROMPT_VERSION) return { status: "stale_configuration" };
  if (!apply) return { status: "candidate" };

  const path = v2AgentPath(row.agentId) + "/model";
  const patchModel = () => v2Json<{ model: string; changed: boolean }>(env, path, {
    method: "PATCH",
    body: { model: CAMEL_CODE_RUNTIME_MODEL, expectedModel: row.model },
    signal: AbortSignal.timeout(10_000),
  });
  let updated: Awaited<ReturnType<typeof patchModel>>;
  try {
    updated = await patchModel().catch((error: unknown) => {
      // A still-running old Durable Object may not have the method yet.
      // Replay the same compare-and-set. A repeated failure leaves work due.
      if (!(error instanceof RuntimeApiError) || error.status < 500) throw error;
      return patchModel();
    });
  } catch (error) {
    if (error instanceof RuntimeApiError && error.status === 409 &&
        (error.code === "agent_busy" || error.code === "model_changed")) return { status: error.code };
    throw error;
  }
  if (updated.model !== CAMEL_CODE_RUNTIME_MODEL || typeof updated.changed !== "boolean") {
    throw new RuntimeApiError("CamelRun did not confirm the camelCode model change", 502);
  }
  return { status: updated.changed ? "moved" : "reconciled" };
}
