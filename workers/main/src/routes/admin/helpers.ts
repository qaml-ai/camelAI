/**
 * Shared accessors for the admin API.
 */

import type { Env } from '../../types.js';
import type { OrgDO, UserDO } from '../../auth.js';
import {
  getAppIndexDatabase,
  getAppIndexReadDatabase,
} from '../../app-index-db.js';
import { ensureAdminIndexReady } from '../../admin-index-bootstrap.js';
import { parsedThreadTranscript } from '../../agent-runtime/thread-transcript.js';
import type { ChatEnv } from '../../chat-thread/types.js';

// ---------------------------------------------------------------------------
// Shared data access helpers
// ---------------------------------------------------------------------------

type AdminIndexEnv = Pick<Env, 'APP_DB' | 'APP_KV' | 'EMAIL_TO_USER' | 'USER' | 'ORG' | 'WORKSPACE'>;
type OrgEnv = Pick<Env, 'ORG'>;
type UserEnv = Pick<Env, 'USER'>;
type AdminThreadContextLookup = {
  getThreadContextById(threadId: string): Promise<{
    org_id: string;
    workspace_id: string;
  } | null>;
};
type OrgThreadLookup = {
  getThread(threadId: string): Promise<{
    workspace_id: string;
  } | null>;
};

export function getAdminIndexStub(env: AdminIndexEnv) {
  const readIndex = getAppIndexReadDatabase(env);
  const writeIndex = getAppIndexDatabase(env);
  if (!readIndex || !writeIndex) {
    throw new Error('APP_DB binding is not configured');
  }
  const writeMethods = new Set([
    'applyAdminEvent',
    'blockSignupIp',
    'markBootstrapComplete',
    'unblockSignupIp',
  ]);

  return new Proxy(readIndex as unknown as Record<string, unknown>, {
    get(_target, prop, receiver) {
      const target = typeof prop === 'string' && writeMethods.has(prop)
        ? writeIndex
        : readIndex;
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') {
        return value;
      }

      return async (...args: unknown[]) => {
        await ensureAdminIndexReady(env);
        return value.apply(target, args);
      };
    },
  });
}

export function getOrgStub(env: OrgEnv, orgId: string) {
  return env.ORG.get(env.ORG.idFromName(orgId)) as DurableObjectStub<OrgDO>;
}

export function getUserStub(env: UserEnv, userId: string) {
  return env.USER.get(env.USER.idFromName(userId)) as DurableObjectStub<UserDO>;
}

// ---------------------------------------------------------------------------
// Thread message helpers
// ---------------------------------------------------------------------------

export async function loadAdminThreadMessagesResponse(
  env: Env,
  threadId: string,
): Promise<Response> {
  const trimmedThreadId = threadId.trim();
  if (!trimmedThreadId) {
    return Response.json({ error: 'Thread ID required' }, { status: 400 });
  }

  const adminIndex = getAdminIndexStub(env) as unknown as AdminThreadContextLookup;
  const threadContext = await adminIndex.getThreadContextById(trimmedThreadId);
  if (!threadContext) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  const orgStub = getOrgStub(env, threadContext.org_id) as unknown as OrgThreadLookup;
  const thread = await orgStub.getThread(trimmedThreadId);
  if (!thread || thread.workspace_id !== threadContext.workspace_id) {
    return Response.json({ error: 'Thread not found' }, { status: 404 });
  }

  // Wherever the thread runs: a runtime thread's messages are its agent's history.
  const messages: unknown[] = await parsedThreadTranscript(
    env as unknown as ChatEnv,
    threadContext.org_id,
    trimmedThreadId,
  ).catch(() => []);

  return Response.json(
    { success: true, messages },
    {
      headers: {
        'Cache-Control': 'no-cache, no-transform',
      },
    },
  );
}
