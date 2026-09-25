export const SELFHOST_ASSETS_PREFIX = "selfhost:assets:";
export const SELFHOST_ASSET_OBJECT_PREFIX = "selfhost-assets";

export interface SelfhostAssetManifestEntry {
  hash: string;
  size?: number;
  contentType?: string;
}

export interface SelfhostAssetsRecord {
  schemaVersion: 1;
  appId: string;
  createdAt: string;
  manifest: Record<string, SelfhostAssetManifestEntry>;
}

export function selfhostAssetsKey(appId: string): string {
  return `${SELFHOST_ASSETS_PREFIX}${appId}`;
}

export function selfhostAssetObjectKey(appId: string, hash: string): string {
  return `${SELFHOST_ASSET_OBJECT_PREFIX}/${appId}/${hash}`;
}

export function normalizeSelfhostAssetPath(path: string): string {
  return path.replace(/^\/+/, "") || "index.html";
}
