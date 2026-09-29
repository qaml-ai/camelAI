// A local agent runtime for chiridion's live evals: the runtime's self-host
// Compose file with its dev override (deploy/selfhost in qaml-ai/agent-runtime),
// one tenant, the camelai-thread definition pointing at the eval relay, and the
// relay itself (scripts/lib/eval-runtime-relay.mjs). State (generated secrets,
// the definition id) lives in .eval-runtime/, which is git-ignored.
//
// Used by scripts/runtime-eval-harness.mjs (up/down/status) and by
// scripts/run-agent-eval.mjs, which brings it up when it is not.
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RELAY_NAME, RELAY_VERSION } from "./eval-runtime-relay.mjs";

export const EVAL_TENANT = "chiridion-eval";
const COMPOSE_PROJECT = "chiridion-eval-runtime";
const DEFINITION_KEY = "chiridion-eval-camelai-thread";
const COMPOSE_FILES = ["docker-compose.yml", "compose.dev.yml"];
const RELAY_SCRIPT = path.resolve("scripts/lib/eval-runtime-relay.mjs");

export function evalRuntimeConfig(env = process.env) {
  const dir = path.resolve(env.EVAL_RUNTIME_STATE_DIR || ".eval-runtime");
  const runtimePort = Number(env.AGENT_RUNTIME_PORT || 18790);
  const relayPort = Number(env.EVAL_RUNTIME_RELAY_PORT || 18791);
  return {
    dir,
    envFile: path.join(dir, ".env"),
    stateFile: path.join(dir, "state.json"),
    relayLog: path.join(dir, "relay.log"),
    runtimeDir: path.resolve(env.AGENT_RUNTIME_DIR || path.join(os.homedir(), "agent-runtime")),
    runtimeRef: env.AGENT_RUNTIME_REF || "origin/main",
    refExplicit: Boolean(env.AGENT_RUNTIME_REF),
    image: env.AGENT_RUNTIME_IMAGE || "",
    runtimePort,
    runtimeUrl: `http://127.0.0.1:${runtimePort}`,
    relayPort,
    maxAgents: Number(env.EVAL_RUNTIME_MAX_AGENTS || 32),
    // Linux Docker reaches the host through the bridge gateway, not loopback.
    relayHost: env.EVAL_RUNTIME_RELAY_HOST || (process.platform === "linux" ? "0.0.0.0" : "127.0.0.1"),
    relayUrlFromRuntime: `http://host.docker.internal:${relayPort}`,
    relayUrlFromHost: `http://127.0.0.1:${relayPort}`,
  };
}

/**
 * The camelai-thread definition as chiridion's staging and production tenants
 * have it (plans/agent-runtime-migration.md §12), with the MCP server at the
 * relay. The model is only a default: chiridion sets each agent's model and
 * key scope.
 */
export function evalDefinitionBody(relayUrlFromRuntime) {
  return {
    name: "camelai-thread",
    model: "openrouter/anthropic/claude-sonnet-5:nitro",
    builtins: ["web_fetch", "web_search", "ask_user"],
    fileTools: false,
    mcpServers: [{
      name: "camel",
      url: `${relayUrlFromRuntime}/mcp/agent`,
      auth: { type: "runtime" },
      exposure: "both",
      timeoutMs: 1_200_000,
    }],
  };
}

function log(message) {
  console.log(`[eval-runtime] ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: options.capture ? "pipe" : "inherit", encoding: "utf8", ...options });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${(result.stderr || result.stdout || "").slice(-2000)}` : "";
    throw new Error(`${command} ${args.slice(0, 3).join(" ")} failed (exit ${result.status})${detail}`);
  }
  return result.stdout ?? "";
}

export function parseEnvFile(source) {
  const values = {};
  for (const line of source.split(/\r?\n/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  return values;
}

function readEnvFile(config) {
  return existsSync(config.envFile) ? parseEnvFile(readFileSync(config.envFile, "utf8")) : {};
}

export function readEvalRuntimeState(config = evalRuntimeConfig()) {
  if (!existsSync(config.stateFile)) return null;
  try {
    return JSON.parse(readFileSync(config.stateFile, "utf8"));
  } catch {
    return null;
  }
}

function composeArgs(config) {
  return [
    "compose",
    "-p", COMPOSE_PROJECT,
    "--project-directory", config.dir,
    ...COMPOSE_FILES.flatMap((file) => ["-f", path.join(config.dir, file)]),
  ];
}

function runtimeCommit(config) {
  if (!existsSync(config.runtimeDir)) {
    throw new Error(
      `No agent-runtime checkout at ${config.runtimeDir}. Clone qaml-ai/agent-runtime there or set AGENT_RUNTIME_DIR.`,
    );
  }
  return run("git", ["-C", config.runtimeDir, "rev-parse", `${config.runtimeRef}^{commit}`], { capture: true }).trim();
}

/** The Compose file and its dev override, from the runtime at AGENT_RUNTIME_REF. */
function writeComposeFiles(config, commit) {
  for (const file of COMPOSE_FILES) {
    const source = run("git", ["-C", config.runtimeDir, "show", `${commit}:deploy/selfhost/${file}`], { capture: true });
    writeFileSync(path.join(config.dir, file), source);
  }
}

function imageExists(image) {
  return spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" }).status === 0;
}

/**
 * The runtime image: AGENT_RUNTIME_IMAGE when given, else one built from the
 * runtime at AGENT_RUNTIME_REF (as its publish-image workflow builds it: the
 * console first, then the Dockerfile), once per commit.
 */
function ensureImage(config, commit) {
  if (config.image) return config.image;
  const image = `chiridion-eval-agent-runtime:${commit.slice(0, 12)}`;
  if (imageExists(image)) return image;
  const buildDir = path.join(config.dir, `build-${commit.slice(0, 12)}`);
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  log(`building ${image} from ${config.runtimeDir} at ${config.runtimeRef} (${commit.slice(0, 12)}); this takes a few minutes once`);
  const archive = spawnSync("git", ["-C", config.runtimeDir, "archive", commit], { maxBuffer: 1 << 30 });
  if (archive.status !== 0) throw new Error(`git archive ${commit} failed`);
  run("tar", ["-x", "-C", buildDir], { input: archive.stdout, stdio: ["pipe", "inherit", "inherit"] });
  run("npm", ["ci", "--no-audit", "--no-fund"], { cwd: buildDir });
  run("npm", ["run", "build:console"], { cwd: buildDir });
  run("docker", ["build", "-t", image, "."], { cwd: buildDir });
  rmSync(buildDir, { recursive: true, force: true });
  return image;
}

const secret = () => randomBytes(32).toString("hex");

/** The runtime's .env: secrets generated once and kept, so a restart keeps its agents readable. */
function writeEnvFile(config, image) {
  const previous = readEnvFile(config);
  const values = {
    AGENT_TENANT: EVAL_TENANT,
    AGENT_OPERATOR_TOKEN: previous.AGENT_OPERATOR_TOKEN || secret(),
    AGENT_SESSION_SECRET: previous.AGENT_SESSION_SECRET || secret(),
    AGENT_SECRETS_KEY: previous.AGENT_SECRETS_KEY || secret(),
    POSTGRES_PASSWORD: previous.POSTGRES_PASSWORD || secret(),
    // chiridion (on this machine) checks identity tokens' issuer against
    // AGENT_RUNTIME_URL, so the runtime must name itself by that URL.
    AGENT_PUBLIC_URL: config.runtimeUrl,
    AGENT_BROWSER_URL: "",
    AGENT_RUNTIME_IMAGE: image,
    AGENT_RUNTIME_PORT: String(config.runtimePort),
    // Every eval runs its own agent, and a matrix runs many at once: the
    // default (4 awake per tenant) refuses the fifth with a 429.
    AGENT_MAX_AGENTS: String(config.maxAgents),
    AGENT_MAX_AGENTS_PER_TENANT: String(config.maxAgents),
  };
  const text = `# Generated by scripts/runtime-eval-harness.mjs for local evals; never production.\n${
    Object.entries(values).map(([key, value]) => `${key}=${value}`).join("\n")
  }\n`;
  const changed = !existsSync(config.envFile) || readFileSync(config.envFile, "utf8") !== text;
  writeFileSync(config.envFile, text);
  chmodSync(config.envFile, 0o600);
  return { values, changed };
}

async function waitFor(check, { timeoutMs, intervalMs = 1000, what }) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`);
}

async function runtimeHealthy(config) {
  const response = await fetch(`${config.runtimeUrl}/healthz`).catch(() => null);
  return Boolean(response?.ok);
}

/** The running relay's health (its version and pid), or null when no relay of ours answers on the port. */
async function relayInfo(config) {
  const response = await fetch(`${config.relayUrlFromHost}/__eval_tunnel/health`).catch(() => null);
  const body = response?.ok ? await response.json().catch(() => null) : null;
  return body?.relay === RELAY_NAME ? body : null;
}

async function relayHealthy(config) {
  return (await relayInfo(config))?.version === RELAY_VERSION;
}

function stopRelay(pid) {
  if (typeof pid !== "number") return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Already gone.
  }
}

/** The relay, as a daemon shared by every eval run until `down`. */
async function ensureRelay(config) {
  const running = await relayInfo(config);
  if (running?.version === RELAY_VERSION) return running.pid ?? null;
  if (running) {
    // An older relay (from before this checkout changed it): replace it.
    stopRelay(running.pid ?? readEvalRuntimeState(config)?.relayPid);
    await waitFor(async () => !(await relayInfo(config)), { timeoutMs: 10_000, intervalMs: 200, what: "the old eval relay to stop" });
  }
  const out = openSync(config.relayLog, "a");
  const child = spawn(process.execPath, [RELAY_SCRIPT, "--port", String(config.relayPort), "--host", config.relayHost], {
    detached: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  closeSync(out);
  await waitFor(() => relayHealthy(config), {
    timeoutMs: 10_000,
    intervalMs: 200,
    what: `the eval relay on port ${config.relayPort} (see ${config.relayLog}; if the port is taken, set EVAL_RUNTIME_RELAY_PORT)`,
  });
  return child.pid;
}

async function operatorCall(config, token, method, pathname, body, headers = {}) {
  const response = await fetch(`${config.runtimeUrl}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`runtime ${method} ${pathname}: HTTP ${response.status} ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) : null;
}

/** The camelai-thread definition, upserted (the same key is the same definition). */
async function ensureDefinition(config, token) {
  const definition = await operatorCall(
    config,
    token,
    "POST",
    "/v1/definitions",
    evalDefinitionBody(config.relayUrlFromRuntime),
    { "Idempotency-Key": DEFINITION_KEY },
  );
  if (typeof definition?.id !== "string") throw new Error("The runtime returned no definition id");
  return definition.id;
}

/** Bring the local runtime up (idempotent) and return its state. */
export async function evalRuntimeUp(config = evalRuntimeConfig(), { rebuild = false } = {}) {
  if (spawnSync("docker", ["info"], { stdio: "ignore" }).status !== 0) {
    throw new Error("Docker is not running; the local agent runtime needs it.");
  }
  mkdirSync(config.dir, { recursive: true });
  const previous = readEvalRuntimeState(config);
  // Keep the runtime this harness last built, so a run does not rebuild
  // whenever the runtime's origin/main moves; `up --rebuild`, AGENT_RUNTIME_REF
  // or AGENT_RUNTIME_IMAGE move it.
  const keep = !rebuild && !config.image && !config.refExplicit &&
    typeof previous?.image === "string" && typeof previous?.runtimeCommit === "string" && imageExists(previous.image);
  const commit = config.image ? null : keep ? previous.runtimeCommit : runtimeCommit(config);
  const image = keep ? previous.image : ensureImage(config, commit);
  if (!previous || previous.image !== image || !existsSync(path.join(config.dir, COMPOSE_FILES[0]))) {
    writeComposeFiles(config, commit ?? runtimeCommit(config));
  }
  const { values, changed: envChanged } = writeEnvFile(config, image);
  if (envChanged || !(await runtimeHealthy(config)) || previous?.image !== image) {
    log(`starting the runtime (${image}) on ${config.runtimeUrl}`);
    run("docker", [...composeArgs(config), "up", "-d", "--wait"]);
    await waitFor(() => runtimeHealthy(config), { timeoutMs: 120_000, what: "the runtime's /healthz" });
  }
  const relayPid = await ensureRelay(config);
  const definitionId = await ensureDefinition(config, values.AGENT_OPERATOR_TOKEN);
  const state = {
    project: COMPOSE_PROJECT,
    image,
    runtimeRef: config.image ? null : config.runtimeRef,
    runtimeCommit: commit,
    runtimeUrl: config.runtimeUrl,
    relayUrl: config.relayUrlFromHost,
    relayUrlFromRuntime: config.relayUrlFromRuntime,
    relayPid,
    tenant: EVAL_TENANT,
    definitionId,
    upAt: new Date().toISOString(),
  };
  writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
  log(`ready: tenant ${EVAL_TENANT}, definition ${definitionId}, relay ${config.relayUrlFromHost}`);
  return state;
}

/** Stop the runtime and the relay; `purge` also drops the runtime's data and the generated secrets. */
export async function evalRuntimeDown(config = evalRuntimeConfig(), { purge = false } = {}) {
  const state = readEvalRuntimeState(config);
  // The pid the relay itself reports: a recorded one may since be another process's.
  stopRelay((await relayInfo(config))?.pid);
  if (existsSync(path.join(config.dir, COMPOSE_FILES[0]))) {
    spawnSync("docker", [...composeArgs(config), "down", "--remove-orphans", ...(purge ? ["-v"] : [])], { stdio: "inherit" });
  }
  if (purge) {
    rmSync(config.dir, { recursive: true, force: true });
  } else if (state) {
    // Kept, so the next `up` starts the same image.
    writeFileSync(config.stateFile, JSON.stringify({ ...state, relayPid: null, stoppedAt: new Date().toISOString() }, null, 2));
  }
  log(purge ? "stopped and purged" : "stopped (data kept; --purge drops it)");
}

export async function evalRuntimeStatus(config = evalRuntimeConfig()) {
  return {
    state: readEvalRuntimeState(config),
    runtimeHealthy: await runtimeHealthy(config),
    relayHealthy: await relayHealthy(config),
  };
}

/**
 * The bindings an eval's vitest run needs to run threads on the local runtime
 * (vitest.workers.config.ts passes exactly these through when RUN_AGENT_EVALS=1).
 * Brings the runtime up first unless it is already.
 */
export async function evalRuntimeVitestEnv(config = evalRuntimeConfig()) {
  let state = readEvalRuntimeState(config);
  if (!state || !(await runtimeHealthy(config)) || !(await relayHealthy(config))) {
    state = await evalRuntimeUp(config);
  }
  const values = readEnvFile(config);
  return {
    AGENT_RUNTIME_URL: state.runtimeUrl,
    AGENT_RUNTIME_TENANT: state.tenant,
    AGENT_RUNTIME_API_TOKEN: values.AGENT_OPERATOR_TOKEN,
    AGENT_RUNTIME_DEFINITION: state.definitionId,
    EVAL_RUNTIME_RELAY_URL: state.relayUrl,
  };
}
