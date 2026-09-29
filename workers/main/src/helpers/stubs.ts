/**
 * Typed Durable Object stub helpers
 */

import type { Env } from '../types.js';
import type { UserDO, OrgDO } from '../auth.js';
import type { WorkspaceDO } from '../workspace.js';

export const getUserStub = (env: Env, id: string) =>
  env.USER.get(env.USER.idFromName(id)) as unknown as UserDO;

export const getOrgStub = (env: Env, id: string) =>
  env.ORG.get(env.ORG.idFromName(id)) as unknown as OrgDO;

export const getWorkspaceStub = (env: Env, id: string) =>
  env.WORKSPACE.get(env.WORKSPACE.idFromName(id)) as unknown as WorkspaceDO;

