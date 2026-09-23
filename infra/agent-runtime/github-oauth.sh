#!/usr/bin/env bash
# Store the GitHub OAuth app used for console sign-in, then reload the runtime.
#
# Create the app first (organization owners only):
#   https://github.com/organizations/qaml-ai/settings/applications/new
#   Application name:            camelAI Agent Runtime
#   Homepage URL:                https://agents.camelai.dev
#   Authorization callback URL:  https://agents.camelai.dev/console/auth/callback
#
# Usage: infra/agent-runtime/github-oauth.sh <client-id>   (the client secret is read from stdin)
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

client_id=${1:-}
[[ "$client_id" =~ ^[A-Za-z0-9._-]+$ ]] || { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 2; }
[[ ! -t 0 ]] || echo "Paste the client secret, then press Ctrl-D:" >&2
umask 077
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
CLIENT_ID="$client_id" python3 -c 'import json, os, sys
secret = sys.stdin.read().strip()
if not secret: sys.exit("No client secret on stdin")
json.dump({"clientId": os.environ["CLIENT_ID"], "clientSecret": secret}, open(sys.argv[1], "w"))' "$work/github.json"
id="$SECRET_PREFIX/github-oauth"
if aws secretsmanager describe-secret --secret-id "$id" >/dev/null 2>&1; then
  aws secretsmanager put-secret-value --secret-id "$id" --secret-string "file://$work/github.json" >/dev/null
else
  aws secretsmanager create-secret --name "$id" --description "GitHub OAuth app for agent runtime console sign-in" --secret-string "file://$work/github.json" >/dev/null
fi
echo "Stored $id."
instance=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=running --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [[ "$instance" != "None" ]]; then
  # Environment changes need a restart, not a reload.
  aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript --comment "enable GitHub sign-in" \
    --parameters '{"commands":["systemctl restart agent-runtime.service"]}' >/dev/null
  echo "Runtime restarting with GitHub sign-in enabled."
fi
