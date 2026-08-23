import type { OrgDO } from './auth.js';
import {
  captureAppScreenshotBuffer,
} from './app-screenshot-capture.js';
import {
  buildWorkspaceAppUrl,
  shouldUseDispatchInterceptionForScreenshot,
  type WorkspaceAppFetcherEnv,
} from './workspace-app-fetcher.js';
import { resolveObjectStore } from './binding-facades/object-store.js';

export interface AppScreenshotJob {
  script_name: string;
  org_id: string;
  org_slug?: string;
  workspace_id: string;
  deploy_ts: number;
  env_prefix: string;
  is_public: boolean;
}

export interface ScreenshotEnv extends WorkspaceAppFetcherEnv {
  BROWSER?: Fetcher;
  R2_BUCKET?: R2Bucket;
  OBJECT_STORE_SERVICE?: Fetcher;
  ORG: DurableObjectNamespace<OrgDO>;
}

const PREVIEW_PREFIX = 'app-previews';
const MAX_SCREENSHOT_RETRIES = 3;

function buildPreviewKeys(job: AppScreenshotJob): { currentKey: string; versionedKey: string } {
  const base = `${PREVIEW_PREFIX}/${job.org_id}/${job.workspace_id}/${job.script_name}`;
  return {
    currentKey: `${base}/current.jpg`,
    versionedKey: `${base}/${job.deploy_ts}.jpg`,
  };
}

function truncateError(err: unknown, maxLength = 500): string {
  const message = err instanceof Error ? err.message : String(err);
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength)}...`;
}

export async function captureScreenshot(
  env: ScreenshotEnv,
  job: AppScreenshotJob,
): Promise<{ success: boolean; error?: string }> {
  const orgStub = env.ORG.get(env.ORG.idFromName(job.org_id));

  if (!env.BROWSER) {
    const errorMessage = 'Missing BROWSER binding for screenshot capture.';
    await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'failed',
      preview_key: null,
      preview_error: errorMessage,
      deploy_ts: job.deploy_ts,
    });
    return { success: false, error: errorMessage };
  }

  const targetUrl = await buildWorkspaceAppUrl(
    env,
    { orgId: job.org_id, workspaceId: job.workspace_id },
    job.script_name,
  );
  const useDispatchInterception = shouldUseDispatchInterceptionForScreenshot(job.is_public, env);

  try {
    const image = await captureAppScreenshotBuffer(
      env.BROWSER,
      env,
      { orgId: job.org_id, workspaceId: job.workspace_id },
      {
        targetUrl,
        logContext: {
          scriptName: job.script_name,
          orgId: job.org_id,
        },
        useDispatchInterception,
      },
    );

    const { currentKey, versionedKey } = buildPreviewKeys(job);
    const bucket = resolveObjectStore(env);
    await bucket.put(versionedKey, image, {
      httpMetadata: {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=31536000, immutable',
      },
      customMetadata: {
        script_name: job.script_name,
        org_id: job.org_id,
        workspace_id: job.workspace_id,
        deploy_ts: String(job.deploy_ts),
      },
    });
    await bucket.put(currentKey, image, {
      httpMetadata: {
        contentType: 'image/jpeg',
        cacheControl: 'public, max-age=300',
      },
      customMetadata: {
        script_name: job.script_name,
        org_id: job.org_id,
        workspace_id: job.workspace_id,
        deploy_ts: String(job.deploy_ts),
      },
    });

    const updateResult = await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'ready',
      preview_key: currentKey,
      preview_error: null,
      deploy_ts: job.deploy_ts,
    });

    if (updateResult.stale) {
      console.log('[app-screenshot] preview update skipped (stale)', {
        scriptName: job.script_name,
        orgId: job.org_id,
      });
    } else if (!updateResult.updated) {
      console.warn('[app-screenshot] preview update skipped (columns missing or script not found)', {
        scriptName: job.script_name,
        orgId: job.org_id,
        scriptExists: !!updateResult.script,
      });
    }

    console.log('[app-screenshot] captured preview', {
      scriptName: job.script_name,
      orgId: job.org_id,
      targetUrl,
    });

    return { success: true };
  } catch (err) {
    const errorMessage = truncateError(err);
    console.error('[app-screenshot] capture failed', {
      scriptName: job.script_name,
      orgId: job.org_id,
      error: errorMessage,
    });

    await orgStub.updateWorkerScriptPreview(job.script_name, {
      status: 'failed',
      preview_key: null,
      preview_error: errorMessage,
      deploy_ts: job.deploy_ts,
    });

    return { success: false, error: errorMessage };
  }
}

export async function handleScreenshotQueue(
  batch: MessageBatch<AppScreenshotJob>,
  env: ScreenshotEnv,
): Promise<void> {
  for (const message of batch.messages) {
    const job = message.body;
    const attempt = message.attempts ?? 1;

    if (!job?.script_name || !job.org_id || !job.workspace_id) {
      console.warn('[app-screenshot] invalid job payload', { job });
      message.ack();
      continue;
    }

    try {
      const orgStub = env.ORG.get(env.ORG.idFromName(job.org_id));
      const script = await orgStub.getWorkerScript(job.script_name);

      if (!script) {
        console.warn('[app-screenshot] script not found, skipping', {
          scriptName: job.script_name,
          orgId: job.org_id,
        });
        message.ack();
        continue;
      }

      if (job.deploy_ts < script.updated_at) {
        console.log('[app-screenshot] stale job, skipping', {
          scriptName: job.script_name,
          orgId: job.org_id,
          deployTs: job.deploy_ts,
          updatedAt: script.updated_at,
        });
        message.ack();
        continue;
      }

      if (!job.org_slug) {
        try {
          const slug = await orgStub.getSlug();
          if (slug) {
            job.org_slug = slug;
          }
        } catch {
          // Continue without org_slug - buildWorkspaceAppUrl resolves slug from OrgDO.
        }
      }

      console.log('[app-screenshot] processing job', {
        scriptName: job.script_name,
        orgId: job.org_id,
        orgSlug: job.org_slug ?? '(legacy)',
        envPrefix: job.env_prefix,
        attempt,
      });

      const result = await captureScreenshot(env, job);

      if (result.success) {
        message.ack();
      } else if (attempt >= MAX_SCREENSHOT_RETRIES) {
        console.warn('[app-screenshot] max retries reached, acking', {
          scriptName: job.script_name,
          orgId: job.org_id,
          attempts: attempt,
        });
        message.ack();
      } else {
        message.retry();
      }
    } catch (err) {
      console.error('[app-screenshot] unexpected error', {
        scriptName: job.script_name,
        orgId: job.org_id,
        error: String(err),
      });

      if ((message.attempts ?? 1) >= MAX_SCREENSHOT_RETRIES) {
        message.ack();
      } else {
        message.retry();
      }
    }
  }
}
