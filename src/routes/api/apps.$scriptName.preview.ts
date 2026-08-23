import type { Route } from './+types/apps.$scriptName.preview';
import { getEnv, type CloudflareEnv } from '@/lib/cloudflare.server';
import { type AuthEnv } from '@/lib/auth-helpers';
import { getSession } from '@/lib/auth.server';
import { isOrgMember } from '@/lib/auth-do';
import { resolveObjectStore } from '../../../workers/main/src/binding-facades/object-store';

interface R2Env extends AuthEnv {
  R2_BUCKET?: R2Bucket;
  OBJECT_STORE_SERVICE?: Fetcher;
}

function getR2Env(env: CloudflareEnv): R2Env {
  return {
    USER: env.USER as AuthEnv['USER'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
    R2_BUCKET: env.R2_BUCKET,
    OBJECT_STORE_SERVICE: env.OBJECT_STORE_SERVICE,
  };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  try {
    const scriptName = params.scriptName;
    const normalized = decodeURIComponent(scriptName ?? '').trim();
    if (!normalized) {
      return Response.json({ error: 'App not found' }, { status: 404 });
    }

    const rawEnv = getEnv(context);
    const env = getR2Env(rawEnv);
    const sessionContext = await getSession(request, context);
    if (!sessionContext) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const session = sessionContext.session;

    const isMember = await isOrgMember(env, session.user_id, session.org_id);
    if (!isMember) {
      return Response.json({ error: 'Forbidden' }, { status: 403 });
    }

    const script = await env.ORG.get(env.ORG.idFromName(session.org_id)).getWorkerScript(normalized);
    if (!script || script.preview_status !== 'ready' || !script.preview_key) {
      return Response.json({ error: 'Preview not available' }, { status: 404 });
    }

    const object = await resolveObjectStore(env).get(script.preview_key);
    if (!object) {
      return Response.json({ error: 'Preview not available' }, { status: 404 });
    }

    const etag = object.etag;
    if (etag && request.headers.get('if-none-match') === etag) {
      return new Response(null, {
        status: 304,
        headers: {
          'Cache-Control': object.httpMetadata?.cacheControl ?? 'public, max-age=300',
          ...(etag ? { ETag: etag } : {}),
        },
      });
    }

    return new Response(object.body, {
      headers: {
        'Content-Type': object.httpMetadata?.contentType ?? 'image/jpeg',
        'Cache-Control': object.httpMetadata?.cacheControl ?? 'public, max-age=300',
        ...(object.size > 0 ? { 'Content-Length': object.size.toString() } : {}),
        ...(etag ? { ETag: etag } : {}),
      },
    });
  } catch (error) {
    if (error instanceof Response) return error;
    console.error('Error loading app preview:', error);
    return Response.json({ error: 'Failed to load app preview' }, { status: 500 });
  }
}
