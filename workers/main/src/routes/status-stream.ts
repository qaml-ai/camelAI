/**
 * Workspace thread-status SSE stream (replaces /ws/workspaces/:id/status).
 */

import type { RouteContext } from '../types.js';
import { requireSession } from '../helpers/auth.js';
import { getOrgStub, getWorkspaceStub } from '../helpers/stubs.js';
import { text } from '../helpers/response.js';
import { ENTERPRISE_OIDC_AUTH_SOURCE } from '../signed-session.js';
import { bridgeWorkspaceStatusStream } from '../workspace-status-stream.js';

export async function handleWorkspaceStatusStream({
  req,
  env,
  match,
}: RouteContext): Promise<Response> {
  const workspaceId = decodeURIComponent(match[1] ?? '').trim();
  if (!workspaceId) {
    return text('Missing workspaceId', 400);
  }

  const auth = await requireSession(req, env);
  if ('error' in auth) return auth.error;
  const { session } = auth;
  const userId = session.user_id;

  // Authorize against the workspace in the URL, not the session-selected one:
  // the selection is a shared per-browser cookie that other tabs mutate, which
  // permanently 403'd the status socket of any tab left on another workspace.
  try {
    const wsStub = getWorkspaceStub(env, workspaceId);
    const wsInfo = await wsStub.getInfo();
    if (!wsInfo || wsInfo.archived) return text('Workspace not found', 404);

    if (
      session.auth_source === ENTERPRISE_OIDC_AUTH_SOURCE &&
      wsInfo.org_id !== session.org_id
    ) {
      return text('Forbidden', 403);
    }

    const orgStub = getOrgStub(env, wsInfo.org_id);
    const orgInfo = await orgStub.getInfo();
    if (!orgInfo || orgInfo.archived) return text('Organization not found', 404);

    if (!(await orgStub.isMember(userId))) return text('Forbidden', 403);
    if ((await orgStub.getWorkspaceAccess(workspaceId, userId)) !== 'full') {
      return text('Forbidden', 403);
    }

    return await bridgeWorkspaceStatusStream(wsStub, req.signal);
  } catch {
    // Not an authoritative denial. The client reconnects with backoff, so a
    // retryable status keeps a DO blip from reading as "you lost access".
    return text('Authorization temporarily unavailable', 503);
  }
}
