import type { LoaderFunctionArgs } from "react-router";
import { requestWorkspaceId, requireRuntimeThread } from "@/lib/runtime-threads.server";
import { getMimeType, shouldDisplayInline, untrustedFileHeaders } from "@/lib/file-content-headers";
import { FULL_TEXT_PREVIEW_BYTE_LIMIT } from "@/lib/file-preview-limits";
import {
  BinaryTextPreviewError,
  FullTextPreviewTooLargeError,
  normalizeTextPreviewMaxLines,
  readTextPreviewFromStream,
} from "./text-preview-stream";
import { scratchVolumePath } from "@/lib/agent-runtime-shared";
import { fetchScratchFile, threadScratchVolume } from "../../../workers/main/src/agent-runtime/thread-runtime";
import { fetchV2Scratch } from "../../../workers/main/src/agent-runtime/runtime-v2";

/**
 * GET /api/threads/:id/files/workspace/<path>: a file of a runtime thread's
 * scratch space (/workspace/<path> as the agent sees it), for anyone who may
 * see the thread. The Worker reads it from the runtime with chiridion's
 * token and serves it from chiridion's origin as workspace files are served
 * (type by extension, inline or attachment), so previews treat both alike;
 * HTML is additionally sandboxed by CSP when opened directly.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const { env, context: threadContext, row } = await requireRuntimeThread(
    request,
    context,
    params.id,
    requestWorkspaceId(request),
  );
  const shown = `/${(params["*"] ?? "").split("/").map((segment) => decodeURIComponent(segment)).join("/")}`;
  const volumePath = scratchVolumePath(shown);
  if (!volumePath) return Response.json({ error: "Not a scratch file" }, { status: 400 });
  const isV2 = row.runtimeVersion === "v2";
  const volumeId = isV2 ? row.agentId : await threadScratchVolume(env, threadContext, row);
  if (!volumeId) return Response.json({ error: "File not found" }, { status: 404 });
  const range = request.headers.get("range");
  const upstream = isV2
    ? await fetchV2Scratch(env, volumeId, volumePath, range)
    : await fetchScratchFile(env, volumeId, volumePath, range);
  if (upstream.status === 416) return upstream;
  if (upstream.status === 413) return Response.json({ error: "Scratch file exceeds the v2 test limit" }, { status: 413 });
  if (upstream.status === 404 || upstream.status === 400) {
    await upstream.body?.cancel();
    return Response.json({ error: "File not found" }, { status: 404 });
  }
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return Response.json({ error: "Could not read the file" }, { status: 502 });
  }
  const filename = volumePath.split("/").pop() || "file";
  const contentType = getMimeType(filename);
  const query = new URL(request.url).searchParams;
  const text = query.get("text");
  if (text === "initial" || text === "full") {
    // The preview's text view, as the workspace text-preview route answers it.
    const size = Number(upstream.headers.get("content-length") ?? "") || undefined;
    if (text === "full" && size !== undefined && size > FULL_TEXT_PREVIEW_BYTE_LIMIT) {
      await upstream.body?.cancel();
      return Response.json({ error: new FullTextPreviewTooLargeError().message }, { status: 413 });
    }
    try {
      const preview = await readTextPreviewFromStream(upstream.body!, {
        mode: text,
        maxLines: normalizeTextPreviewMaxLines(query.get("maxLines")),
        contentType,
        path: shown,
        size,
      });
      return Response.json(preview, { headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      if (error instanceof BinaryTextPreviewError) return Response.json({ error: error.message }, { status: 415 });
      if (error instanceof FullTextPreviewTooLargeError) return Response.json({ error: error.message }, { status: 413 });
      throw error;
    }
  }
  const download = query.get("download") === "1";
  const inline = !download && shouldDisplayInline(contentType);
  const headers = new Headers({
    "Content-Type": contentType,
    "Cache-Control": "private, no-store",
    ...untrustedFileHeaders(filename, inline),
  });
  for (const name of ["Content-Length", "Content-Range", "Accept-Ranges", "ETag"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
