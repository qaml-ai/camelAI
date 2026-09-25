/**
 * WebSocket route for real-time log streaming, authenticated by the browser
 * session cookie.
 */

import type { RouteContext } from '../types.js';
import { requireSession } from '../helpers/auth.js';
import { text } from '../helpers/response.js';
import { getOrgStub } from '../helpers/stubs.js';

export async function handleLogsWebSocket({ req, env, url }: RouteContext): Promise<Response> {
  const scriptName = url.searchParams.get('scriptName');
  if (!scriptName) {
    return text('Missing scriptName', 400);
  }

  // Session-based auth (browser)
  const auth = await requireSession(req, env);
  if ('error' in auth) return auth.error;

  const { session } = auth;
  const { org_id: orgId, user_id: userId } = session;

  if (!orgId) return text('No organization selected', 400);

  // Verify user is a member of the org and the script exists
  const orgStub = getOrgStub(env, orgId);
  const isMember = await orgStub.isMember(userId);
  if (!isMember) return text('Forbidden', 403);

  const script = await orgStub.getWorkerScript(scriptName);
  if (!script) return text('Script not found', 404);

  // Get org slug for dispatch script name
  const orgSlug = await orgStub.getSlug();
  if (!orgSlug) return text('Organization not configured', 500);

  const dispatchScriptName = `${scriptName}--${orgSlug}`;

  // Forward WebSocket to the per-script persistent logs DO.
  const logsStub = env.WORKER_LOGS.get(env.WORKER_LOGS.idFromName(dispatchScriptName));
  return logsStub.fetch(req);
}
