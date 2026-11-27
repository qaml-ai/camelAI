import type { Route } from './+types/workspaces.$id.apps.$scriptName.env-vars';
import { getEnv } from '@/lib/cloudflare.server';
import type { AuthEnv } from '@/lib/auth-helpers';
import { getWorkerScript } from '@/lib/auth-do';
import { requireWorkspaceAccess } from './workspaces.utils';
import type { AppEnvVarInput } from '../../../workers/main/src/identity/org-do';

function parseEnvVarInputs(body: unknown): AppEnvVarInput[] {
  if (!body || typeof body !== 'object') {
    throw new Error('Request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.vars)) {
    return record.vars.map((entry) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error('Each variable entry must be an object');
      }
      const item = entry as Record<string, unknown>;
      return {
        key: typeof item.key === 'string' ? item.key : '',
        value: typeof item.value === 'string' ? item.value : '',
        isSecret: item.isSecret === undefined ? true : Boolean(item.isSecret),
      };
    });
  }
  return [
    {
      key: typeof record.key === 'string' ? record.key : '',
      value: typeof record.value === 'string' ? record.value : '',
      isSecret: record.isSecret === undefined ? true : Boolean(record.isSecret),
    },
  ];
}

function isValidationErrorMessage(message: string): boolean {
  return (
    message.startsWith('Invalid variable name') ||
    message.startsWith('Variable ') ||
    message.startsWith('At least one') ||
    message.startsWith('Apps can have at most') ||
    message.startsWith('Request body must') ||
    message.startsWith('Each variable entry')
  );
}

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

    const orgStub = env.ORG.get(env.ORG.idFromName(auth.orgId));
    const vars = await orgStub.listAppEnvVars(scriptName);
    return Response.json({
      scriptName: script.script_name,
      vars,
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('Error loading app environment variables:', error);
    return Response.json({ error: 'Failed to load app environment variables' }, { status: 500 });
  }
}

export async function action({ request, context, params }: Route.ActionArgs) {
  try {
    const workspaceId = params.id;
    const scriptName = params.scriptName;
    if (!workspaceId || !scriptName) {
      return Response.json({ error: 'Workspace ID and app name required' }, { status: 400 });
    }

    const auth = await requireWorkspaceAccess(request, context, workspaceId, { requireWrite: true });
    const env = getEnv(context) as unknown as AuthEnv;
    const script = await getWorkerScript(env, auth.orgId, scriptName);
    if (!script || script.workspace_id !== auth.workspaceId) {
      return Response.json({ error: 'App not found' }, { status: 404 });
    }

    const orgStub = env.ORG.get(env.ORG.idFromName(auth.orgId));
    const method = request.method.toUpperCase();

    if (method === 'PUT' || method === 'POST') {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
      }
      const entries = parseEnvVarInputs(body);
      const result = await orgStub.setAppEnvVars(scriptName, entries, auth.userId);
      return Response.json({
        ok: true,
        scriptName: script.script_name,
        envVersion: result.envVersion,
        vars: result.vars,
      });
    }

    if (method === 'DELETE') {
      const url = new URL(request.url);
      let key = url.searchParams.get('key')?.trim() ?? '';
      if (!key) {
        try {
          const body = (await request.json()) as { key?: unknown };
          if (typeof body?.key === 'string') key = body.key.trim();
        } catch {
          // No JSON body provided.
        }
      }
      if (!key) {
        return Response.json({ error: 'Variable name is required' }, { status: 400 });
      }
      const result = await orgStub.deleteAppEnvVar(scriptName, key, auth.userId);
      return Response.json({
        ok: true,
        scriptName: script.script_name,
        deleted: result.deleted,
        envVersion: result.envVersion,
        vars: result.vars,
      });
    }

    return Response.json({ error: 'Method not allowed' }, { status: 405 });
  } catch (error) {
    if (error instanceof Response) return error;
    const message = error instanceof Error ? error.message : 'Failed to update app environment variables';
    if (isValidationErrorMessage(message)) {
      return Response.json({ error: message }, { status: 400 });
    }
    console.error('Error updating app environment variables:', error);
    return Response.json({ error: 'Failed to update app environment variables' }, { status: 500 });
  }
}
