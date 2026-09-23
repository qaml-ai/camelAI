#!/usr/bin/env bash
# Pull secrets into the files the runtime container reads. Runs before every
# start and reload. Writes in place so the container's bind mount sees updates.
set -euo pipefail
REGION=us-west-2
PREFIX=camelai/agent-runtime
DIR=/opt/agent-runtime
secret() { aws secretsmanager get-secret-value --region "$REGION" --secret-id "$PREFIX/$1" --query SecretString --output text; }

umask 077
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
secret tenants > "$tmp"
python3 -c 'import json, sys; t = json.load(open(sys.argv[1]))["tenants"]; assert isinstance(t, dict)' "$tmp"
touch "$DIR/tenants.json"
cat "$tmp" > "$DIR/tenants.json"
chown 1000:1000 "$DIR/tenants.json"
chmod 600 "$DIR/tenants.json"

{
  echo "AGENT_TENANTS_FILE=/etc/agent-runtime/tenants.json"
  echo "AGENT_SESSION_SECRET=$(secret session-secret)"
  echo "AGENT_SECRETS_KEY=$(secret secrets-key)"
  # GitHub console sign-in is optional until the OAuth app exists (see github-oauth.sh).
  if github=$(secret github-oauth 2>/dev/null); then
    python3 -c 'import json, sys; g = json.loads(sys.argv[1]); print("GITHUB_CLIENT_ID=" + g["clientId"]); print("GITHUB_CLIENT_SECRET=" + g["clientSecret"])' "$github"
  fi
  # Code executor hosts are optional until infra/agent-runtime/executor/deploy.sh has run.
  if [[ -f "$DIR/executor.env" ]]; then
    echo "AGENT_EXECUTOR_TOKEN=$(secret executor-token)"
    cat "$DIR/executor.env"
  fi
  cat "$DIR/runtime.defaults.env"
} > "$DIR/runtime.env"
chmod 600 "$DIR/runtime.env"
