import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  AGENT_RUNTIME_ENV_DEFAULTS,
  AGENT_RUNTIME_PRIVATE_KEYS,
  AGENT_RUNTIME_VOLUMES,
  refuseStatefulSecretRegeneration,
} from "./selfhost-agent-runtime.mjs";

function decodeEnvValue(value) {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function definitionsOf(lines, key) {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=(.*)$`);
  return lines.flatMap((line, index) => {
    const match = line.match(pattern);
    return match ? [{ index, value: decodeEnvValue(match[1]) }] : [];
  });
}

function replaceEnvDefinition(lines, definitions, line) {
  if (definitions.length > 0) {
    const definitionIndexes = new Set(definitions.map((definition) => definition.index));
    const firstIndex = definitions[0].index;
    return lines.flatMap((existingLine, index) => {
      if (index === firstIndex) return [line];
      return definitionIndexes.has(index) ? [] : [existingLine];
    });
  }
  while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
  lines.push(line, "");
  return lines;
}

/**
 * Give an existing .env.selfhost every value in `defaults` ([key, generate]
 * pairs) it lacks (absent, or empty in its last definition), in one atomic
 * write. A value it has is never rotated or rewritten; duplicate definitions
 * of a key that is filled in are collapsed to one. The file ends up 0600.
 * `beforeCreate(keys, values)`, given the keys about to be generated and the
 * file's current values, may throw to write nothing.
 */
export async function ensureSelfhostEnvValues(envPath, defaults, { beforeCreate } = {}) {
  let lines = (await fs.readFile(envPath, "utf8")).split(/\r?\n/);
  if (beforeCreate) {
    const missing = defaults.map(([key]) => key).filter((key) => !definitionsOf(lines, key).at(-1)?.value);
    if (missing.length > 0) {
      const value = (key) => definitionsOf(lines, key).at(-1)?.value ?? "";
      await beforeCreate(missing, value);
    }
  }
  const created = [];
  for (const [key, generate] of defaults) {
    const definitions = definitionsOf(lines, key);
    if (definitions.at(-1)?.value) continue;
    const line = `${key}=${generate()}`;
    lines = replaceEnvDefinition(lines, definitions, line);
    created.push(key);
  }
  if (created.length === 0) {
    await fs.chmod(envPath, 0o600);
    return { created };
  }
  let text = lines.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  await atomicWritePrivateFile(envPath, text);
  return { created };
}

const ADMIN_API_KEY_DEFAULT = ["ADMIN_API_KEY", () => randomBytes(32).toString("base64url")];
export const SELFHOST_SECRET_DEFAULTS = Object.freeze([ADMIN_API_KEY_DEFAULT, ...AGENT_RUNTIME_ENV_DEFAULTS]);

/**
 * Put a release snapshot's .env.selfhost back at `envPath`, except that every
 * SELFHOST_SECRET_DEFAULTS value the snapshot lacks (absent, or empty in its
 * last definition) keeps the current definition, verbatim. A value the
 * snapshot sets wins. The snapshot may come from an older release's upgrader,
 * which never knew these keys, while the data they guard (the agent runtime's
 * volumes) outlives the rollback, and the next upgrade refuses to generate new
 * ones over it. Returns the keys kept; the file ends up 0600.
 */
export async function restoreSelfhostEnvSnapshot(snapshotPath, envPath) {
  const snapshotText = await fs.readFile(snapshotPath, "utf8");
  const currentText = await fs.readFile(envPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  let lines = snapshotText.split(/\r?\n/);
  const currentLines = currentText.split(/\r?\n/);
  const kept = [];
  for (const [key] of SELFHOST_SECRET_DEFAULTS) {
    const definitions = definitionsOf(lines, key);
    if (definitions.at(-1)?.value) continue;
    const currentDefinition = definitionsOf(currentLines, key).at(-1);
    if (!currentDefinition?.value) continue;
    const line = currentLines[currentDefinition.index].trim();
    lines = replaceEnvDefinition(lines, definitions, line);
    kept.push(key);
  }
  let text = kept.length > 0 ? lines.join("\n") : snapshotText;
  if (kept.length > 0 && !text.endsWith("\n")) text += "\n";
  await atomicWritePrivateFile(envPath, text);
  return { kept };
}

export async function ensureSelfhostAdminApiKey(envPath) {
  const { created } = await ensureSelfhostEnvValues(envPath, [ADMIN_API_KEY_DEFAULT]);
  return { created: created.length > 0 };
}

/**
 * Every secret and default a release needs that an older install may lack:
 * ADMIN_API_KEY, and the bundled agent runtime's image, tenant, operator
 * token, session secret, secrets key and database password. Run before
 * snapshots, doctor and Compose (selfhost:up, selfhost:upgrade,
 * selfhost:migrate-secrets), so the values are generated once and kept.
 */
export async function ensureSelfhostSecrets(envPath, { existingVolumes = existingDockerVolumes } = {}) {
  return await ensureSelfhostEnvValues(envPath, SELFHOST_SECRET_DEFAULTS, {
    // Never a new database password, secrets key or session secret over the
    // runtime's existing data: it would lock the install out of it.
    beforeCreate: async (keys, value) => {
      if (!keys.some((key) => AGENT_RUNTIME_PRIVATE_KEYS.includes(key))) return;
      const project = value("COMPOSE_PROJECT_NAME") || process.env.COMPOSE_PROJECT_NAME || "camelai-selfhost";
      refuseStatefulSecretRegeneration(keys, await existingVolumes(AGENT_RUNTIME_VOLUMES.map((name) => `${project}_${name}`)));
    },
  });
}

/**
 * Which of `names` exist as Docker volumes on this host. Without the Docker
 * CLI, none can: the stack cannot have run here.
 */
export async function existingDockerVolumes(names) {
  const exists = (name) => new Promise((resolve) => {
    const child = spawn("docker", ["volume", "inspect", name], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
  const found = [];
  for (const name of names) if (await exists(name)) found.push(name);
  return found;
}

async function atomicWritePrivateFile(filePath, contents) {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  let handle;
  try {
    handle = await fs.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporaryPath, filePath);
    const directoryHandle = await fs.open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    await handle?.close().catch(() => {});
    await fs.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}
