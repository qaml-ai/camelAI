import { isSelfhostRuntime } from "./selfhost-runtime";
import { deleteDispatchScript } from "../../workers/main/src/cf-api-proxy";
import {
  selfhostAssetObjectKey,
  selfhostAssetsKey,
  type SelfhostAssetsRecord,
} from "../../workers/main/src/selfhost-assets-registry";
import { selfhostWorkerKey } from "../../workers/main/src/selfhost-worker-registry";
import { resolveObjectStore } from "../../workers/main/src/binding-facades/object-store";

const R2_DELETE_BATCH_SIZE = 1_000;

export interface DeployedAppDeleteEnv {
  CF_ACCOUNT_ID?: string;
  CF_DISPATCH_NAMESPACE?: string;
  CF_API_TOKEN?: string;
  APP_KV: KVNamespace;
  R2_BUCKET?: R2Bucket;
  OBJECT_STORE_SERVICE?: Fetcher;
}

export function getDispatchScriptName(
  scriptName: string,
  orgSlug: string,
): string {
  const normalizedScriptName = scriptName.trim();
  const normalizedOrgSlug = orgSlug.trim();
  if (!normalizedScriptName) throw new Error("Script name is required");
  if (!normalizedOrgSlug) throw new Error("Organization slug is required");
  return `${normalizedScriptName}--${normalizedOrgSlug}`;
}

function parseSelfhostAssetsRecord(
  value: string,
  expectedAppId: string,
): SelfhostAssetsRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Self-host asset metadata is invalid for ${expectedAppId}`);
  }

  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
    (parsed as { appId?: unknown }).appId !== expectedAppId ||
    !(parsed as { manifest?: unknown }).manifest ||
    typeof (parsed as { manifest?: unknown }).manifest !== "object"
  ) {
    throw new Error(`Self-host asset metadata is invalid for ${expectedAppId}`);
  }

  const record = parsed as SelfhostAssetsRecord;
  for (const entry of Object.values(record.manifest)) {
    if (!entry || typeof entry !== "object" || typeof entry.hash !== "string" || !entry.hash) {
      throw new Error(`Self-host asset metadata is invalid for ${expectedAppId}`);
    }
  }
  return record;
}

async function deleteSelfhostAppRuntime(
  env: DeployedAppDeleteEnv,
  dispatchScriptName: string,
): Promise<void> {
  const assetsKey = selfhostAssetsKey(dispatchScriptName);
  const storedAssets = await env.APP_KV.get(assetsKey);

  if (storedAssets) {
    const bucket = resolveObjectStore(env);
    const record = parseSelfhostAssetsRecord(storedAssets, dispatchScriptName);
    const objectKeys = Array.from(
      new Set(
        Object.values(record.manifest).map((entry) =>
          selfhostAssetObjectKey(dispatchScriptName, entry.hash),
        ),
      ),
    );

    for (let offset = 0; offset < objectKeys.length; offset += R2_DELETE_BATCH_SIZE) {
      await bucket.delete(
        objectKeys.slice(offset, offset + R2_DELETE_BATCH_SIZE),
      );
    }
  }

  await Promise.all([
    env.APP_KV.delete(selfhostWorkerKey(dispatchScriptName)),
    env.APP_KV.delete(assetsKey),
  ]);
}

/**
 * Delete the externally served runtime for an app before its OrgDO metadata is
 * removed. Self-host apps live in APP_KV/R2; hosted apps live in a Cloudflare
 * dispatch namespace. Keeping that distinction here prevents routes from
 * accidentally requiring Cloudflare credentials in self-host installations.
 */
export async function deleteDeployedAppRuntime(
  env: DeployedAppDeleteEnv,
  input: { scriptName: string; orgSlug: string },
): Promise<string> {
  const dispatchScriptName = getDispatchScriptName(
    input.scriptName,
    input.orgSlug,
  );

  if (isSelfhostRuntime(env)) {
    await deleteSelfhostAppRuntime(env, dispatchScriptName);
    return dispatchScriptName;
  }

  const accountId = env.CF_ACCOUNT_ID?.trim();
  const dispatchNamespace = env.CF_DISPATCH_NAMESPACE?.trim();
  const apiToken = env.CF_API_TOKEN?.trim();
  if (!accountId || !dispatchNamespace || !apiToken) {
    throw new Error("Server configuration error: Missing Cloudflare credentials");
  }

  const deleted = await deleteDispatchScript(
    accountId,
    dispatchNamespace,
    dispatchScriptName,
    apiToken,
  );
  if (!deleted) {
    throw new Error("Failed to delete app from Cloudflare. Please try again.");
  }
  return dispatchScriptName;
}
