import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const defaultLatestReleaseManifestUrl =
  "https://github.com/qaml-ai/camelAI/releases/latest/download/selfhost-release.json";

export const SELFHOST_IMAGE_ENV_BY_MANIFEST_KEY = Object.freeze({
  app: "SELFHOST_APP_IMAGE",
  "local-artifacts": "SELFHOST_LOCAL_ARTIFACTS_IMAGE",
  "project-build": "SELFHOST_PROJECT_BUILD_IMAGE",
  analysis: "SELFHOST_ANALYSIS_IMAGE",
  "db-query": "SELFHOST_DB_QUERY_IMAGE",
  "container-egress": "SELFHOST_CONTAINER_EGRESS_IMAGE",
  caddy: "SELFHOST_CADDY_IMAGE",
  pomerium: "SELFHOST_POMERIUM_IMAGE",
  "agent-runtime": "SELFHOST_AGENT_RUNTIME_IMAGE",
  "agent-runtime-postgres": "SELFHOST_AGENT_RUNTIME_POSTGRES_IMAGE",
});

export async function downloadLatestReleaseManifest({
  fetchImpl = globalThis.fetch,
  manifestUrl = defaultLatestReleaseManifestUrl,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  if (typeof fetchImpl !== "function") {
    throw new Error("This Node runtime does not provide fetch");
  }

  const response = await fetchImpl(manifestUrl, {
    headers: {
      Accept: "application/json, application/octet-stream",
      "User-Agent": "camelAI-selfhost-upgrader",
    },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Unable to download the latest self-host release manifest: HTTP ${response.status}`,
    );
  }

  const contents = await response.text();
  let manifest;
  try {
    manifest = JSON.parse(contents);
  } catch {
    throw new Error("The latest self-host release manifest is not valid JSON");
  }
  if (
    manifest?.schema !== 1 ||
    typeof manifest.release !== "string" ||
    !/^selfhost-v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(
      manifest.release,
    ) ||
    typeof manifest.revision !== "string" ||
    !/^[0-9a-f]{40}$/i.test(manifest.revision)
  ) {
    throw new Error("The latest self-host release manifest is invalid");
  }
  for (const key of Object.keys(SELFHOST_IMAGE_ENV_BY_MANIFEST_KEY)) {
    const image = manifest.images?.[key];
    if (
      typeof image !== "string" ||
      !/@sha256:[0-9a-f]{64}$/i.test(image)
    ) {
      throw new Error(
        `The latest self-host release manifest image ${key} is not pinned by digest`,
      );
    }
  }

  const directory = await fs.mkdtemp(
    path.join(temporaryDirectory, "camelai-selfhost-upgrade-"),
  );
  const manifestPath = path.join(directory, "selfhost-release.json");
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    manifestPath,
    releaseRef: manifest.release,
  };
}
