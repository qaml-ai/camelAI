import type { Route } from './+types/workspaces.$id.apps.$scriptName.visibility';
import { getEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { getWorkerScript } from '@/lib/auth-do';
import { requireWorkspaceAccess } from './workspaces.utils';

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const workspaceId = params.id;
    const scriptName = params.scriptName;
    if (!workspaceId || !scriptName) {
      return Response.json({ error: 'Workspace ID and app name required' }, { status: 400 });
    }

    const auth = await requireWorkspaceAccess(request, context, workspaceId);
    const env = getEnv(context) as unknown as AuthEnv;
    const script = await getWorkerScript(env, auth.orgId, scriptName);

    if (!script || script.workspace_id !== auth.workspaceId) {
      return Response.json({ error: 'App not found' }, { status: 404 });
    }

    return Response.json({
      script_name: script.script_name,
      is_public: script.is_public,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('Error resolving app visibility:', error);
    return Response.json({ error: 'Failed to resolve app visibility' }, { status: 500 });
  }
}
