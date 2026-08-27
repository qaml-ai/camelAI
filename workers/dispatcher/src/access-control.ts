const SCRIPT_PREFIX = 'script:';
export interface WorkerAccessInfo {
  is_public: boolean;
  org_id: string;
  org_slug?: string;
  usage_guard_status?: 'active' | 'warned' | 'suspending' | 'suspended' | 'probation' | 'error' | 'exempt';
  usage_guard_reason?: string | null;
  usage_guard_probation_until?: number | null;
}

interface KvReader {
  get(key: string): Promise<string | null>;
}

export function isSelfhostPublishingMode(env: {
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
}): boolean {
  return (
    env.CF_ACCOUNT_ID?.trim().toLowerCase() === "selfhost" ||
    env.CF_DISPATCH_NAMESPACE?.trim().toLowerCase() === "selfhost"
  );
}

export function isPublicAppRequest(
  accessInfo: Pick<WorkerAccessInfo, "is_public">,
  _env: { CF_ACCOUNT_ID?: string; CF_DISPATCH_NAMESPACE?: string },
): boolean {
  return accessInfo.is_public;
}

/**
 * Get worker script access info from KV index.
 */
export async function getWorkerAccessInfo(
  kv: KvReader,
  dispatchScriptName: string,
): Promise<WorkerAccessInfo | null> {
  const data = await kv.get(`${SCRIPT_PREFIX}${dispatchScriptName}`);
  return data ? JSON.parse(data) as WorkerAccessInfo : null;
}
