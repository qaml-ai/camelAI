import type { OrgDO } from './auth.js';
import {
  buildWorkspaceAppHostIndex,
  isWorkspaceAppHostname,
  normalizeWorkspaceAppRequest,
  performWorkspaceAppFetch,
  type WorkspaceAppContext,
  type WorkspaceAppFetcherEnv,
  type WorkspaceAppHostIndex,
} from './workspace-app-fetcher.js';

export type SecureFetchContext = WorkspaceAppContext;
export type SecureFetchEnv = WorkspaceAppFetcherEnv & {
  ORG: DurableObjectNamespace<OrgDO>;
};

export const SECURE_FETCH_REDIRECT_HEADER = 'x-camelai-secure-fetch-redirect';

export type { WorkspaceAppHostIndex };

export {
  buildWorkspaceAppHostIndex,
  isWorkspaceAppHostname,
};

export const normalizeSecureFetchRequest = normalizeWorkspaceAppRequest;

export async function performSecureFetch(
  env: SecureFetchEnv,
  context: SecureFetchContext,
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  deps: {
    getHostIndex: () => Promise<WorkspaceAppHostIndex>;
  },
): Promise<Response> {
  return performWorkspaceAppFetch(env, context, input, init, deps);
}
