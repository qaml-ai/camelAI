/**
 * Deploy side effects service
 */

import { type Env } from '../types.js';
import type { DeploySideEffectsInfo } from '../cf-api-proxy.js';
import {
  billingPlanToQuotaTier,
  type AppQuotaTier,
  type DynamicWorkerRegistryFields,
} from '../dynamic-worker-registry.js';
import type { AppScreenshotJob } from '../screenshot-queue.js';
import {
  resolveEnvPrefix,
} from '../cf-api-proxy.js';
import { getOrgStub } from '../helpers/stubs.js';
import {
  isUsageGuardRecovery,
  markUsageGuardEligible,
  type UsageGuardRegistryFields,
} from '../usage-guard-state.js';

// KV key prefix for script access info (namespaced by org-slug)
const SCRIPT_PREFIX = 'script:';

export async function handleDeploySideEffects(env: Env, info: DeploySideEffectsInfo): Promise<void> {
  const { scriptName, orgId, orgSlug, workspaceId, hostname, threadId, projectId, configPath, commitSha, artifactCacheKey } = info;
  const orgStub = getOrgStub(env, orgId);

  // Register ownership (stores user-facing scriptName in OrgDO)
  let createdBy = 'system:deploy';
  if (threadId) {
    try {
      const thread = await orgStub.getThread(threadId);
      if (thread?.created_by && thread.workspace_id === workspaceId) {
        createdBy = thread.created_by;
      }
    } catch {}
  }

  const script = await orgStub.registerWorkerScript(scriptName, workspaceId, createdBy, configPath, projectId, commitSha, artifactCacheKey);

  let orgQuotaTier: AppQuotaTier | undefined;
  try {
    const org = await orgStub.getOrganization();
    if (org?.billing_plan) {
      orgQuotaTier = billingPlanToQuotaTier(org.billing_plan);
    }
  } catch {}

  const enrichedInfo: DeploySideEffectsInfo =
    orgQuotaTier && info.dynamicBundle && !info.dynamicBundle.quota_tier
      ? { ...info, dynamicBundle: { ...info.dynamicBundle, quota_tier: orgQuotaTier } }
      : info;

  await refreshAppRegistryAfterDeploy(env, enrichedInfo, script.is_public);

  // Update preview status
  const envPrefix = resolveEnvPrefix(env.WORKER_BASE_URL, hostname);
  const previewResult = await orgStub.updateWorkerScriptPreview(scriptName, {
    status: 'pending',
    preview_key: null,
    preview_error: null,
    deploy_ts: script.updated_at,
  });

  if (previewResult.stale) return;

  // Queue screenshot
  if (!env.APP_SCREENSHOT_QUEUE) return;

  const jobBase: AppScreenshotJob = {
    script_name: scriptName,
    org_id: orgId,
    org_slug: orgSlug,
    workspace_id: workspaceId,
    deploy_ts: script.updated_at,
    env_prefix: envPrefix,
    is_public: script.is_public,
  };

  try {
    const sendOptions = {
      contentType: 'json',
      messageId: `${scriptName}:${script.updated_at}`,
    } as unknown as QueueSendOptions;
    await env.APP_SCREENSHOT_QUEUE.send(jobBase, sendOptions);
  } catch (err) {
    await orgStub.updateWorkerScriptPreview(scriptName, {
      status: 'failed',
      preview_key: null,
      preview_error: String(err),
      deploy_ts: script.updated_at,
    });
  }
}

/**
 * Re-points the dispatcher's KV app registry and the usage guard at the newly
 * uploaded script version. Shared by user deploys and platform re-uploads
 * (the cost-controls backfill), which keep the app's existing visibility.
 */
export async function refreshAppRegistryAfterDeploy(
  env: Env,
  info: DeploySideEffectsInfo,
  isPublic?: boolean,
): Promise<void> {
  const { scriptName, dispatchScriptName, orgId, orgSlug, workspaceId, artifactCacheKey, scriptVersion, dynamicBundle } = info;
  const primaryRegistryKey = `${SCRIPT_PREFIX}${dispatchScriptName}`;
  let existingRegistry: (UsageGuardRegistryFields & DynamicWorkerRegistryFields & { org_id?: string; org_slug?: string; is_public?: boolean }) | null = null;
  try {
    const stored = await env.APP_KV.get(primaryRegistryKey);
    existingRegistry = stored ? JSON.parse(stored) : null;
  } catch (error) {
    console.warn('[deploy] failed to parse existing app registry state', {
      dispatchScriptName,
      error: String(error),
    });
  }

  let usageGuardFields: UsageGuardRegistryFields = existingRegistry?.usage_guard_status
    ? {
        usage_guard_status: existingRegistry.usage_guard_status,
        usage_guard_eligible_version: existingRegistry.usage_guard_eligible_version,
        usage_guard_eligible_at: existingRegistry.usage_guard_eligible_at,
        usage_guard_probation_until: existingRegistry.usage_guard_probation_until,
        usage_guard_reason: existingRegistry.usage_guard_reason,
      }
    : {};
  if (scriptVersion && env.APP_DB) {
    const recovering = isUsageGuardRecovery(existingRegistry?.usage_guard_status);
    const eligibility = await markUsageGuardEligible({
      db: env.APP_DB,
      appId: `${orgId}:${scriptName}`,
      dispatchScriptName,
      orgId,
      workspaceId,
      scriptName,
      scriptVersion,
      artifactCacheKey,
      recovering,
    });
    usageGuardFields = {
      usage_guard_status: eligibility.status,
      usage_guard_eligible_version: scriptVersion,
      usage_guard_eligible_at: Date.now(),
      usage_guard_probation_until: eligibility.probationUntil,
      usage_guard_reason: eligibility.reasonCode,
    };
  }

  const existingDynamicFields: DynamicWorkerRegistryFields = existingRegistry?.runtime_mode
    ? {
        runtime_mode: existingRegistry.runtime_mode,
        ...(existingRegistry.bundle_r2_key ? { bundle_r2_key: existingRegistry.bundle_r2_key } : {}),
        ...(existingRegistry.bundle_sha ? { bundle_sha: existingRegistry.bundle_sha } : {}),
        ...(existingRegistry.env_version !== undefined ? { env_version: existingRegistry.env_version } : {}),
        ...(existingRegistry.quota_tier ? { quota_tier: existingRegistry.quota_tier } : {}),
        ...(existingRegistry.do_classes ? { do_classes: existingRegistry.do_classes } : {}),
        ...(existingRegistry.has_assets !== undefined ? { has_assets: existingRegistry.has_assets } : {}),
        ...(existingRegistry.migrated_at ? { migrated_at: existingRegistry.migrated_at } : {}),
      }
    : {};
  const mergedDynamicFields: DynamicWorkerRegistryFields = dynamicBundle
    ? { ...existingDynamicFields, ...dynamicBundle }
    : existingDynamicFields;

  // Store in KV with namespaced key: script:{script-name}--{org-slug}
  // This allows the dispatcher to look up access info by dispatchScriptName
  await env.APP_KV.put(
    primaryRegistryKey,
    JSON.stringify({
      org_id: orgId,
      org_slug: orgSlug,
      is_public: isPublic ?? existingRegistry?.is_public ?? false,
      ...usageGuardFields,
      ...mergedDynamicFields,
    }),
  );
}
