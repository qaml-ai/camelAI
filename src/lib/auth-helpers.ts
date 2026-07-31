/**
 * Core auth helpers: AuthEnv interface, getAuthEnv, and integration record converter.
 * Keep this file minimal - only pure helpers with no business logic.
 */
import type { Integration } from '@/types';
import type { CloudflareEnv } from './cloudflare.server';
import { UserDO, OrgDO } from '../../workers/main/src/auth';
import { WorkspaceDO } from '../../workers/main/src/workspace';
import type { SignupDO } from '../../workers/main/src/signup-do';

// Re-export types that are only defined in worker modules
export type { OrgThread } from '../../workers/main/src/auth';
export type { SessionData } from '../../workers/main/src/session-kv';
export type { ApiTokenData } from '../../workers/main/src/api-tokens';

// User, Organization, Workspace types should be imported from @/types directly

/**
 * Auth environment bindings required for DO access.
 */
export interface AuthEnv {
  USER: DurableObjectNamespace<UserDO>;
  SIGNUP?: DurableObjectNamespace<SignupDO>;
  ORG: DurableObjectNamespace<OrgDO>;
  WORKSPACE: DurableObjectNamespace<WorkspaceDO>;
  APP_DB?: D1Database;
  SESSIONS: KVNamespace;
  EMAIL_TO_USER: KVNamespace;
  APP_KV: KVNamespace;
  TOKEN_SIGNING_SECRET: string;
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  /** Comma/whitespace-separated bootstrap superuser emails (optional secret). */
  SUPERUSER_EMAILS?: string;
}

/**
 * Extract AuthEnv bindings from CloudflareEnv.
 */
export function getAuthEnv(env: CloudflareEnv): AuthEnv {
  return {
    USER: env.USER as AuthEnv['USER'],
    SIGNUP: env.SIGNUP as AuthEnv['SIGNUP'],
    ORG: env.ORG as AuthEnv['ORG'],
    WORKSPACE: env.WORKSPACE as AuthEnv['WORKSPACE'],
    APP_DB: (env as any).APP_DB as AuthEnv['APP_DB'],
    SESSIONS: env.SESSIONS,
    EMAIL_TO_USER: env.EMAIL_TO_USER,
    APP_KV: env.APP_KV,
    TOKEN_SIGNING_SECRET: env.TOKEN_SIGNING_SECRET,
    CF_ACCOUNT_ID: env.CF_ACCOUNT_ID,
    CF_DISPATCH_NAMESPACE: env.CF_DISPATCH_NAMESPACE,
    SUPERUSER_EMAILS: env.SUPERUSER_EMAILS,
  };
}

// ============================================================================
// Integration Record Converter (DB record → API type)
// ============================================================================

export function integrationRecordToIntegration(r: {
  id: string;
  integration_type: string;
  name: string;
  category: string;
  auth_method: string;
  config: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
  credentials_encrypted: string | null;
}): Integration {
  return {
    id: r.id,
    integration_type: r.integration_type,
    name: r.name,
    category: r.category as Integration['category'],
    auth_method: r.auth_method as Integration['auth_method'],
    config: r.config ? JSON.parse(r.config) : {},
    created_by: r.created_by,
    created_at: r.created_at,
    updated_at: r.updated_at,
    has_credentials: !!r.credentials_encrypted,
  };
}
