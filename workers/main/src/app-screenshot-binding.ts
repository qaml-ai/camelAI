import { WorkerEntrypoint } from 'cloudflare:workers';
import type { CodeModeToolsProps } from './code-mode-tools.js';
import type { OrgDO } from './auth.js';
import {
  bufferToImageDataUrl,
  captureAppScreenshotBuffer,
  POST_LOAD_DELAY_MS,
} from './app-screenshot-capture.js';
import {
  buildWorkspaceAppUrl,
  type WorkspaceAppFetcherEnv,
} from './workspace-app-fetcher.js';

export interface AppScreenshotBindingEnv extends WorkspaceAppFetcherEnv {
  BROWSER?: Fetcher;
  ORG: DurableObjectNamespace<OrgDO>;
}

export type AppScreenshotBindingProps = Pick<CodeModeToolsProps, 'orgId' | 'workspaceId'>;

export interface AppScreenshotCaptureInput {
  scriptName: string;
  path?: string;
  width?: number;
  height?: number;
  waitMs?: number;
}

export interface AppScreenshotCaptureResult {
  imageDataUrl: string;
  width: number;
  height: number;
}

/**
 * Virtual binding for capturing deployed workspace app screenshots via Browser
 * Rendering. Private apps route through the dispatcher service binding.
 */
export class AppScreenshotBinding extends WorkerEntrypoint<
  AppScreenshotBindingEnv,
  AppScreenshotBindingProps
> {
  private get context(): AppScreenshotBindingProps {
    return this.ctx.props;
  }

  async capture(input: AppScreenshotCaptureInput): Promise<AppScreenshotCaptureResult> {
    const scriptName = input.scriptName?.trim();
    if (!scriptName) {
      throw new Error('scriptName is required');
    }
    if (!this.env.BROWSER) {
      throw new Error('Screenshot capture requires the BROWSER binding');
    }
    if (!this.env.DISPATCHER) {
      throw new Error('Screenshot capture requires the DISPATCHER binding');
    }

    const orgStub = this.env.ORG.get(this.env.ORG.idFromName(this.context.orgId));
    const script = await orgStub.getWorkerScript(scriptName);
    if (!script) {
      throw new Error(`App not found: ${scriptName}`);
    }
    if (script.workspace_id !== this.context.workspaceId) {
      throw new Error(`App ${scriptName} is not in this workspace`);
    }

    const path = input.path?.trim() || '/';
    const targetUrl = await buildWorkspaceAppUrl(
      this.env,
      this.context,
      scriptName,
      path,
    );

    const width = input.width ?? 1280;
    const height = input.height ?? 720;
    const waitMs = input.waitMs ?? POST_LOAD_DELAY_MS;

    const image = await captureAppScreenshotBuffer(
      this.env.BROWSER,
      this.env as WorkspaceAppFetcherEnv & { DISPATCHER: NonNullable<WorkspaceAppFetcherEnv['DISPATCHER']> },
      this.context,
      {
        targetUrl,
        logContext: {
          scriptName,
          orgId: this.context.orgId,
          workspaceId: this.context.workspaceId,
          width,
          height,
        },
        useDispatchInterception: !script.is_public,
        postLoadDelayMs: waitMs,
        width,
        height,
      },
    );

    return {
      imageDataUrl: bufferToImageDataUrl(image),
      width,
      height,
    };
  }
}
