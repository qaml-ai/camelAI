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
  const definitionsOf = (key) => {
    const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=(.*)$`);
    return lines.flatMap((line, index) => {
      const match = line.match(pattern);
      return match ? [{ index, value: decodeEnvValue(match[1]) }] : [];
    });
  };
  if (beforeCreate) {
    const missing = defaults.map(([key]) => key).filter((key) => !definitionsOf(key).at(-1)?.value);
    if (missing.length > 0) {
      const value = (key) => definitionsOf(key).at(-1)?.value ?? "";
      await beforeCreate(missing, value);
    }
  }
  const created = [];
  for (const [key, generate] of defaults) {
    const definitions = definitionsOf(key);
    if (definitions.at(-1)?.value) continue;
    const line = `${key}=${generate()}`;
    if (definitions.length > 0) {
      const definitionIndexes = new Set(definitions.map((definition) => definition.index));
      const firstIndex = definitions[0].index;
      lines = lines.flatMap((existingLine, index) => {
        if (index === firstIndex) return [line];
        return definitionIndexes.has(index) ? [] : [existingLine];
      });
    } else {
      while (lines.length > 0 && lines.at(-1).trim() === "") lines.pop();
      lines.push(line, "");
    }
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
  return await ensureSelfhostEnvValues(envPath, [ADMIN_API_KEY_DEFAULT, ...AGENT_RUNTIME_ENV_DEFAULTS], {
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
