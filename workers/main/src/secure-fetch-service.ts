import { WorkerEntrypoint, env as cloudflareEnv } from 'cloudflare:workers';
import type { CodeModeToolsProps } from './code-mode-tools.js';
import {
  buildWorkspaceAppHostIndex,
  performSecureFetch,
  SECURE_FETCH_REDIRECT_HEADER,
  type SecureFetchEnv,
  type WorkspaceAppHostIndex,
} from './secure-fetch.js';

export type SecureFetchBindingProps = Pick<CodeModeToolsProps, 'orgId' | 'workspaceId'>;

/**
 * Virtual binding used by js_exec and deterministic automations to fetch
 * workspace deployed apps through the dispatcher worker RPC service binding.
 */
export class SecureFetchBinding extends WorkerEntrypoint<
  SecureFetchEnv,
  SecureFetchBindingProps
> {
  private hostIndexPromise?: Promise<WorkspaceAppHostIndex>;

  private get context(): SecureFetchBindingProps {
    return this.ctx.props;
  }

  private getHostIndex(): Promise<WorkspaceAppHostIndex> {
    if (!this.hostIndexPromise) {
      this.hostIndexPromise = buildWorkspaceAppHostIndex(this.env, this.context);
    }
    return this.hostIndexPromise;
  }

  private resolveEnv(): SecureFetchEnv {
    const dispatcher = this.env.DISPATCHER ?? (cloudflareEnv as SecureFetchEnv).DISPATCHER;
    return dispatcher ? { ...this.env, DISPATCHER: dispatcher } : this.env;
  }

  async fetch(request: Request): Promise<Response> {
    // The HTTP binding handler always receives a manual-mode Request. The
    // caller's desired mode travels separately and stays inside the binding.
    const headers = new Headers(request.headers);
    const redirect = headers.get(SECURE_FETCH_REDIRECT_HEADER) === 'follow' ? 'follow' : 'manual';
    headers.delete(SECURE_FETCH_REDIRECT_HEADER);
    return performSecureFetch(this.resolveEnv(), this.context, request, { headers, redirect }, {
      getHostIndex: () => this.getHostIndex(),
    });
  }
}
