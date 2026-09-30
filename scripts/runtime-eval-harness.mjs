// The local agent runtime chiridion's live evals run on (see AGENTS.md,
// "Agent evals on the local runtime").
//
//   node scripts/runtime-eval-harness.mjs up [--rebuild] build (once) and start it
//   node scripts/runtime-eval-harness.mjs status        is it up, and with what
//   node scripts/runtime-eval-harness.mjs run <eval|all|hard|standard> [run-agent-eval options] [--down]
//   node scripts/runtime-eval-harness.mjs down [--purge]
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  evalRuntimeDown,
  evalRuntimeStatus,
  evalRuntimeUp,
} from "./lib/eval-runtime.mjs";

function usage(code = 0) {
  console.log(`Usage: node scripts/runtime-eval-harness.mjs <command>

Commands:
  up [--rebuild]          Start the local agent runtime (Docker Compose: the runtime's
                          deploy/selfhost files with compose.dev.yml), its tenant, the
                          camelai-thread definition and the eval relay. Idempotent. The
                          image is built once and kept; --rebuild moves it to
                          AGENT_RUNTIME_REF's current commit.
  status                  Print whether the runtime and the relay are up.
  run <target> [options]  Bring it up, then run evals: <target> is an eval id, a
                          comma-separated list, "all", "hard" or "standard". Options are
                          scripts/run-agent-eval.mjs's (e.g. --model sonnet); --down
                          stops the runtime afterwards.
  list                    List the runnable evals.
  down [--purge]          Stop the runtime and the relay; --purge also drops its data
                          and generated secrets (.eval-runtime/).

Environment:
  AGENT_RUNTIME_DIR       qaml-ai/run checkout (default ~/agent-runtime)
  AGENT_RUNTIME_REF       its ref to build and take Compose files from (default origin/main)
  AGENT_RUNTIME_IMAGE     use this image instead of building one
  AGENT_RUNTIME_PORT      host port of the runtime (default 18790)
  EVAL_RUNTIME_RELAY_PORT host port of the eval relay (default 18791)
Model keys come from .dev.vars as for every eval (AI_GATEWAY_AUTH_TOKEN or CF_GATEWAY_TOKEN).
`);
  process.exit(code);
}

function manifestIds(filter = () => true) {
  const manifest = JSON.parse(readFileSync("workers/main/tests/evals/manifest.json", "utf8"));
  return manifest.evals.filter(filter).map((entry) => entry.id);
}

function resolveTargets(target) {
  if (target === "all") return manifestIds();
  if (target === "hard") return manifestIds((entry) => entry.tier === "hard");
  if (target === "standard") return manifestIds((entry) => !entry.tier);
  return target.split(",").map((id) => id.trim()).filter(Boolean);
}

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "up":
      await evalRuntimeUp(undefined, { rebuild: rest.includes("--rebuild") });
      break;
    case "status": {
      const status = await evalRuntimeStatus();
      console.log(JSON.stringify(status, null, 2));
      process.exit(status.runtimeHealthy && status.relayHealthy ? 0 : 1);
      break;
    }
    case "down":
      await evalRuntimeDown(undefined, { purge: rest.includes("--purge") });
      break;
    case "list":
      for (const id of [...manifestIds(), "custom-prompt-live"]) console.log(id);
      break;
    case "run": {
      const [target, ...args] = rest;
      if (!target) usage(1);
      const down = args.includes("--down");
      const passThrough = args.filter((arg) => arg !== "--down");
      await evalRuntimeUp();
      let code = 0;
      for (const evalId of resolveTargets(target)) {
        const result = spawnSync(process.execPath, ["scripts/run-agent-eval.mjs", evalId, ...passThrough], {
          stdio: "inherit",
          env: { ...process.env, RUN_AGENT_EVALS: "1" },
        });
        if (result.status !== 0) code = result.status ?? 1;
      }
      if (down) await evalRuntimeDown();
      process.exit(code);
      break;
    }
    case "--help":
    case "help":
    case undefined:
      usage(command ? 0 : 1);
      break;
    default:
      console.error(`Unknown command "${command}".`);
      usage(1);
  }
} catch (error) {
  console.error(`[eval-runtime] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
