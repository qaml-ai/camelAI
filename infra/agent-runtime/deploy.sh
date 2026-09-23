#!/usr/bin/env bash
# Build the runtime image from this checkout, push it to ECR, install the
# instance configuration from infra/agent-runtime/instance, and restart.
# Usage: infra/agent-runtime/deploy.sh
#
# Restarting interrupts running turns: their requests complete as uncertain and
# the agents close those turns with "outcome unknown" results when they next run.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }

registry="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
tag=$(git -C "$repo" rev-parse --short=12 HEAD)
if [[ -n "$(git -C "$repo" status --porcelain -- services/agent-runtime/src services/agent-runtime/shared services/agent-runtime/package.json services/agent-runtime/Dockerfile)" ]]; then
  tag="$tag-dirty-$(date +%Y%m%d%H%M%S)"
fi
image="$registry/$ECR_REPOSITORY:$tag"

echo "==> Building $image"
aws ecr get-login-password | docker login --username AWS --password-stdin "$registry" >/dev/null
if aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids imageTag="$tag" >/dev/null 2>&1; then
  echo "image already pushed"
else
  docker buildx build --platform linux/arm64 --provenance=false -t "$image" --push "$repo/services/agent-runtime"
fi

instance=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
[[ "$instance" != "None" ]] || { echo "No running $NAME instance; run provision.sh first" >&2; exit 1; }

b64() { base64 < "$1" | tr -d '\n'; }
caddyfile=$(sed "s/RUNTIME_HOSTNAME/$HOSTNAME/" "$here/instance/Caddyfile.template" | base64 | tr -d '\n')
remote=$(cat <<SH
set -euo pipefail
dir=/opt/agent-runtime
mkdir -p \$dir/data \$dir/caddy/data \$dir/caddy/config
chown 1000:1000 \$dir/data
echo '$caddyfile' | base64 -d > \$dir/Caddyfile.next
echo '$(b64 "$here/instance/refresh-config.sh")' | base64 -d > \$dir/refresh-config.sh
chmod 755 \$dir/refresh-config.sh
echo '$(b64 "$here/instance/runtime.defaults.env")' | base64 -d > \$dir/runtime.defaults.env
echo '$(b64 "$here/instance/agent-runtime.service")' | base64 -d > /etc/systemd/system/agent-runtime.service
echo '$(b64 "$here/instance/agent-runtime-caddy.service")' | base64 -d > /etc/systemd/system/agent-runtime-caddy.service
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $registry >/dev/null
docker pull --quiet '$image'
echo '$image' > \$dir/image
systemctl daemon-reload
systemctl enable agent-runtime.service agent-runtime-caddy.service >/dev/null 2>&1
systemctl restart agent-runtime.service
caddy_changed=1
if [[ -f \$dir/Caddyfile ]] && cmp -s \$dir/Caddyfile \$dir/Caddyfile.next; then caddy_changed=0; fi
mv \$dir/Caddyfile.next \$dir/Caddyfile
if [[ \$caddy_changed == 1 ]] || ! systemctl is-active --quiet agent-runtime-caddy.service; then systemctl restart agent-runtime-caddy.service; fi
for i in \$(seq 1 30); do
  if docker exec agent-runtime node -e 'fetch("http://127.0.0.1:8790/healthz").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))'; then echo "runtime healthy: $image"; exit 0; fi
  sleep 2
done
echo "runtime did not become healthy" >&2
docker logs --tail 50 agent-runtime >&2
exit 1
SH
)

echo "==> Installing on $instance"
params=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]]}))' "$(printf 'echo %s | base64 -d | bash' "$(printf '%s' "$remote" | base64 | tr -d '\n')")")
command_id=$(aws ssm send-command --instance-ids "$instance" --document-name AWS-RunShellScript \
  --comment "deploy $tag" --parameters "$params" --query Command.CommandId --output text)
for i in $(seq 1 90); do
  status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" --query Status --output text 2>/dev/null || echo Pending)
  [[ "$status" == Pending || "$status" == InProgress || "$status" == Delayed ]] || break
  sleep 2
done
aws ssm get-command-invocation --command-id "$command_id" --instance-id "$instance" --query '[StandardOutputContent,StandardErrorContent]' --output text
[[ "$status" == Success ]] || { echo "deploy failed: $status" >&2; exit 1; }

echo "==> https://$HOSTNAME/healthz"
for _ in $(seq 1 30); do
  if curl -fsS "https://$HOSTNAME/healthz"; then echo; exit 0; fi
  sleep 5 # The first deploy waits for Caddy to obtain the TLS certificate.
done
echo "public health check failed (is DNS pointing at the Elastic IP?)" >&2
exit 1
