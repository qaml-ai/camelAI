import type { ActionFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import { scratchVolumePath } from "@/lib/agent-runtime-shared";
import { scratchFileLink, threadScratchVolume } from "../../../workers/main/src/agent-runtime/thread-runtime";
import type { CodeModeToolsProps } from "../../../workers/main/src/code-mode-tools";
import { actionOnlyLoader } from "@/lib/method-not-allowed";

type ToolsBinding = {
  callToolEnvelope(name: string, args: unknown): Promise<{ ok: true; data: unknown } | { ok: false; error: { message: string } }>;
};

export const loader = actionOnlyLoader("POST");

/**
 * POST /api/threads/:id/files/save {path}: "Save to workspace" for a runtime
 * thread's scratch file (/workspace/<path>): copied to the workspace's
 * outputs/ (R2) by the same import_file tool the agent uses, from a
 * one-minute link the runtime serves. Answers where it went, as a preview
 * target.
 */
export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }
  const body = (await request.json().catch(() => null)) as { path?: unknown; workspaceId?: unknown } | null;
  const { env, context: threadContext, row } = await requireRuntimeThread(
    request,
    context,
    params.id,
    requestWorkspaceId(request, body),
  );
  const shown = typeof body?.path === "string" ? body.path : "";
  const volumePath = scratchVolumePath(shown);
  if (!volumePath) return Response.json({ error: "Not a scratch file" }, { status: 400 });
  const volumeId = await threadScratchVolume(env, threadContext, row);
  if (!volumeId) return Response.json({ error: "File not found" }, { status: 404 });
  const name = volumePath.split("/").pop() ?? "file";
  const destination = { location: "r2" as const, path: `outputs/${name}` };
  const exports = (context as { cloudflare?: { ctx?: { exports?: { CodeModeToolsBinding?: (init: { props: CodeModeToolsProps }) => ToolsBinding } } } })
    .cloudflare?.ctx?.exports;
  if (!exports?.CodeModeToolsBinding) return Response.json({ error: "Saving files is not available here" }, { status: 503 });
  const tools = exports.CodeModeToolsBinding({
    props: {
      orgId: threadContext.orgId,
      workspaceId: threadContext.workspaceId,
      threadId: threadContext.threadId,
      userId: threadContext.userId ?? undefined,
    },
  });
  const saved = await tools.callToolEnvelope("import_file", {
    source: await scratchFileLink(env, volumeId, volumePath),
    destination,
  });
  if (!saved.ok) return Response.json({ error: saved.error.message }, { status: 502 });
  return Response.json({
    saved: destination,
    previewTarget: { kind: "file", source: "output", workspaceId: threadContext.workspaceId, path: name, filename: name },
  });
}
