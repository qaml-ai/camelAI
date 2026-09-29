import { WorkerEntrypoint, env as cloudflareEnv } from 'cloudflare:workers';
import type { CodeModeToolsProps } from './code-mode-tools.js';
import {
  buildWorkspaceAppHostIndex,
  performSecureFetch,
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

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return performSecureFetch(this.resolveEnv(), this.context, input, init, {
      getHostIndex: () => this.getHostIndex(),
    });
  }
}
