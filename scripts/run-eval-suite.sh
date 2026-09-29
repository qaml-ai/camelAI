#!/bin/bash
# Run the camelAI agent eval suite in THIS checkout and write results to a local $RUN_DIR.
#
# Cloud-agnostic by design: this script assumes `.dev.vars` is already present in the working tree
# (repo root) and never touches any cloud API — no Secrets Manager, no S3, no instance management.
# The caller is responsible for having `.dev.vars` in place and for whatever happens to $RUN_DIR
# afterwards (e.g. reporting artifacts via scripts/report-eval-run.mjs). Run from the repo root.
#
# Inputs (env): RUN_DIR (required, where status.json + artifacts/ are written), EVAL_TARGET
# (required: an eval id, comma-separated list, "all", "hard", or "standard"), EVAL_ARGS_JSON,
# INSTALL_COMMAND, AGENT_RUNTIME_DIR / AGENT_RUNTIME_REF / AGENT_RUNTIME_IMAGE (the local agent
# runtime the evals run on; see scripts/runtime-eval-harness.mjs), plus the
# usual EVAL_*/CUSTOM_EVAL_* knobs which flow through to vitest via the environment.
set -uo pipefail

: "${RUN_DIR:?RUN_DIR is required}"
: "${EVAL_TARGET:?EVAL_TARGET is required}"
: "${EVAL_ARGS_JSON:=[]}"
: "${INSTALL_COMMAND:=bun install --frozen-lockfile}"
RUN_ID="${RUN_ID:-local}"
if [ -z "${EVAL_BATCH_ID:-}" ]; then
  if command -v node >/dev/null 2>&1; then
    EVAL_BATCH_ID="batch-$(date -u +%Y%m%d-%H%M%SZ)-$(node -e 'process.stdout.write(Math.random().toString(36).slice(2,10))')"
  else
    EVAL_BATCH_ID="batch-$(date -u +%Y%m%d-%H%M%SZ)-$(od -An -N4 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  fi
fi
export EVAL_BATCH_ID
export EVAL_BATCH_LABEL="${EVAL_BATCH_LABEL:-suite: ${EVAL_TARGET}}"

mkdir -p "$RUN_DIR/artifacts"
GIT_COMMIT="$(git rev-parse HEAD 2>/dev/null || echo "")"
GIT_REF="${GIT_REF:-$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")}"

write_status() {
  local status="$1"
  local extra="${2:-}"
  cat > "$RUN_DIR/status.json" <<JSON
{"runId":"$RUN_ID","status":"$status","timestamp":"$(date -Is)","ref":"$GIT_REF","commit":"$GIT_COMMIT","evalTarget":"$EVAL_TARGET","evalBatchId":"$EVAL_BATCH_ID"$extra}
JSON
}

fail() {
  local phase="$1" code="$2"
  echo "[$(date -Is)] $phase failed (exit $code)"
  write_status failed ',"exitCode":'"$code"',"finishedAt":"'"$(date -Is)"'","phase":"'"$phase"'"'
  exit "$code"
}

install_prereqs() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "[$(date -Is)] Installing Docker"
    dnf install -y docker
  fi
  systemctl enable --now docker
  usermod -aG docker ec2-user || true
  chmod 666 /var/run/docker.sock || true
  docker pull --platform linux/amd64 'cloudflare/proxy-everything:3cb1195@sha256:0ef6716c52430096900b150d84a3302057d6cd2319dae7987128c85d0733e3c8'

  local node_version=22.21.1
  local node_dir="/opt/node-v${node_version}-linux-x64"
  if ! command -v node >/dev/null 2>&1 || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 22 ]; then
    echo "[$(date -Is)] Installing Node.js $node_version"
    curl -fsSL "https://nodejs.org/dist/v${node_version}/node-v${node_version}-linux-x64.tar.xz" -o /tmp/node.tar.xz
    tar -xJf /tmp/node.tar.xz -C /opt
    ln -sf "$node_dir/bin/node" /usr/local/bin/node
    ln -sf "$node_dir/bin/npm" /usr/local/bin/npm
    ln -sf "$node_dir/bin/npx" /usr/local/bin/npx
  fi
  export PATH="/usr/local/bin:${node_dir}/bin:$PATH"

  if ! command -v bun >/dev/null 2>&1; then
    curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash
    ln -sf /usr/local/bin/bun /usr/local/bin/bunx /usr/bin/ || true
  fi
}

run_evals() {
  local evals
  if [ "$EVAL_TARGET" = "all" ]; then
    # "all" = every eval in the manifest (the single source of truth), run one after another below.
    mapfile -t evals < <(node -e 'for (const e of JSON.parse(require("fs").readFileSync("workers/main/tests/evals/manifest.json","utf8")).evals) console.log(e.id)')
  elif [ "$EVAL_TARGET" = "hard" ]; then
    mapfile -t evals < <(node -e 'for (const e of JSON.parse(require("fs").readFileSync("workers/main/tests/evals/manifest.json","utf8")).evals) if (e.tier === "hard") console.log(e.id)')
  elif [ "$EVAL_TARGET" = "standard" ]; then
    mapfile -t evals < <(node -e 'for (const e of JSON.parse(require("fs").readFileSync("workers/main/tests/evals/manifest.json","utf8")).evals) if (!e.tier) console.log(e.id)')
  else
    # EVAL_TARGET may be a single eval id or a comma-separated list.
    IFS=',' read -ra evals <<< "$EVAL_TARGET"
  fi

  mapfile -t eval_args < <(node -e 'for (const arg of JSON.parse(process.env.EVAL_ARGS_JSON || "[]")) console.log(arg)')
  local code=0
  for eval_name in "${evals[@]}"; do
    # Eval selection (EVAL_MODEL, EVAL_REAL_DEPLOY, EVAL_MAX_*, EVAL_ENFORCE_SIGNAL) and the
    # custom-prompt inputs (CUSTOM_EVAL_PROMPT/PROJECT/REQUIRED_TRANSCRIPT_SUBSTRINGS) flow through
    # from the environment to vitest.
    EVAL_ARTIFACT_DIR="$RUN_DIR/artifacts" RUN_AGENT_EVALS=1 bun scripts/run-agent-eval.mjs "$eval_name" "${eval_args[@]}"
    eval_code=$?
    if [ "$eval_code" -ne 0 ]; then code="$eval_code"; fi
  done
  return "$code"
}

if [ ! -f .dev.vars ]; then
  echo "[$(date -Is)] ERROR: .dev.vars not found in $(pwd); the orchestrator must deliver it before running"
  fail dev-vars 1
fi

write_status running ',"startedAt":"'"$(date -Is)"'"'
install_prereqs || true
echo "[$(date -Is)] ref=$GIT_REF commit=$GIT_COMMIT node=$(node --version 2>/dev/null) bun=$(bun --version 2>/dev/null) docker=$(docker --version 2>/dev/null)"

if [ -f workers/main/eval-sandbox.Dockerfile ]; then
  echo "[$(date -Is)] Building camelai-eval-sandbox:latest (Docker cache enabled)"
  docker build -t camelai-eval-sandbox:latest -f workers/main/eval-sandbox.Dockerfile . || fail docker-build $?
fi

if [ -f workers/main/analysis-sandbox.Dockerfile ]; then
  echo "[$(date -Is)] Building camelai-analysis-sandbox:latest (analysis stack, native arch)"
  # Builds natively for the host arch; on arm64 hosts it first builds the
  # amd64-only cloudflare/sandbox base from source (Rosetta/QEMU breaks the
  # Jupyter kernel handshake, so an emulated image fails every run_notebook).
  node scripts/build-analysis-sandbox-image.mjs || fail analysis-docker-build $?
fi

# Patched Cloudflare Containers egress interceptor (workerd#6793 workaround): the stock
# proxy-everything sidecar's TPROXY rules intercept docker bridge control traffic on newer hosts
# (e.g. kernel 6.17 / Docker 29.x), so the container never becomes ready and the eval fails with
# "Container failed to start". This wrapper adds a bridge-bypass rule. It's a no-op where the bug
# doesn't trigger, so we build + select it unconditionally. Remove once workerd#6794 is released.
if [ -f workers/main/eval-egress-fix/Dockerfile ]; then
  echo "[$(date -Is)] Building camelai-eval-egress-fixed:latest (workerd#6793 bridge-bypass)"
  docker build -t camelai-eval-egress-fixed:latest workers/main/eval-egress-fix || fail egress-build $?
  export MINIFLARE_CONTAINER_EGRESS_IMAGE=camelai-eval-egress-fixed:latest
fi

echo "[$(date -Is)] Installing dependencies with: $INSTALL_COMMAND"
bash -lc "$INSTALL_COMMAND" || fail install $?

# Every eval's thread runs on a local agent runtime (Docker Compose), which needs a
# qaml-ai/agent-runtime checkout (AGENT_RUNTIME_DIR, default ~/agent-runtime; built at
# AGENT_RUNTIME_REF, default origin/main) or a ready image (AGENT_RUNTIME_IMAGE).
echo "[$(date -Is)] Starting the local agent runtime"
node scripts/runtime-eval-harness.mjs up || fail agent-runtime $?
trap 'node scripts/runtime-eval-harness.mjs down >/dev/null 2>&1 || true' EXIT

echo "[$(date -Is)] Running eval target: $EVAL_TARGET"
run_evals
code=$?
if [ "$code" -eq 0 ]; then status=completed; else status=failed; fi
write_status "$status" ',"exitCode":'"$code"',"finishedAt":"'"$(date -Is)"'"'
echo "[$(date -Is)] Done (exit $code)"
exit "$code"
