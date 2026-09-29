import type { LoaderFunctionArgs } from "react-router";
import { requireRuntimeThread } from "@/lib/runtime-threads.server";
import { RUNTIME_BROWSER_READS } from "@/lib/agent-runtime-shared";
import { runtimeUrl } from "../../../workers/main/src/agent-runtime/runtime-api";

/** Request headers a read passes on: the browser token, and what the event stream resumes by. */
const FORWARDED = ["authorization", "accept", "last-event-id"];

/**
 * GET /api/threads/:id/runtime/:workspaceId/v1/agents/:agentId/{events,history,state,inputs}:
 * a runtime thread's agent read through chiridion, for a private runtime the
 * browser cannot reach (self-host: the runtime's AGENT_BROWSER_URL is empty,
 * so the token route hands the browser this base instead of a runtime URL;
 * runtimeReadProxyBase). The hosted runtime names its own URL and browsers
 * read it directly, never through here.
 *
 * Two checks, as a direct read has one: the session may use the thread and
 * the path names the thread's own agent, then the runtime checks the browser
 * token the watcher sends (scopes, subject, redaction), which chiridion
 * minted for this user. The body streams through as it arrives, and a
 * browser that goes away cancels the read upstream.
 */
export async function loader({ request, context, params }: LoaderFunctionArgs) {
  const { env, row } = await requireRuntimeThread(request, context, params.id, params.workspaceId);
  const read = params.read ?? "";
  if (!RUNTIME_BROWSER_READS.has(read) || !row.agentId || params.agentId !== row.agentId) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  if (!/^Bearer\s+\S+$/i.test(request.headers.get("authorization") ?? "")) {
    return Response.json({ error: "A browser token is required" }, { status: 401 });
  }
  const headers = new Headers();
  for (const name of FORWARDED) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  const target = `${runtimeUrl(env)}/v1/agents/${encodeURIComponent(row.agentId)}/${read}${new URL(request.url).search}`;
  let upstream: Response;
  try {
    upstream = await fetch(target, { headers, signal: request.signal, redirect: "manual" });
  } catch (error) {
    if (request.signal.aborted) return new Response(null, { status: 499 });
    console.error("[runtime-thread] read proxy could not reach the runtime", error);
    return Response.json({ error: "Can't reach the agent service" }, { status: 502 });
  }
  const passed = new Headers({ "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" });
  const type = upstream.headers.get("content-type");
  if (type) passed.set("Content-Type", type);
  return new Response(upstream.body, { status: upstream.status, headers: passed });
}
