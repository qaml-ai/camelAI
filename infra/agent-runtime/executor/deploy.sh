#!/usr/bin/env bash
# Replace the code executor hosts with $EXECUTOR_COUNT fresh ones running the
# runtime image already in ECR (build it with infra/agent-runtime/deploy.sh),
# point the runtime at them, and terminate the old hosts.
# Usage: infra/agent-runtime/executor/deploy.sh [image-tag]   (default: the runtime's current image)
#
# Executor hosts have no IAM role, no SSH and no SSM. They are never updated in
# place: every deploy launches new ones. Health checks run from the runtime host,
# the only machine allowed to reach them. Pointing the runtime at the new hosts
# restarts it, which interrupts running turns (see ../README.md).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
aws() { command aws --region "$REGION" "$@"; }
log() { printf '\n==> %s\n' "$*"; }

registry="$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com"
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
group() { aws ec2 describe-security-groups --filters Name=group-name,Values="$1" Name=vpc-id,Values="$vpc" --query 'SecurityGroups[0].GroupId' --output text; }
executor_sg=$(group "$EXECUTOR_NAME")
bootstrap_sg=$(group "$EXECUTOR_NAME-bootstrap")
[[ "$executor_sg" != "None" && "$bootstrap_sg" != "None" ]] || { echo "Run infra/agent-runtime/executor/provision.sh first" >&2; exit 1; }

read -r runtime runtime_ip runtime_subnet < <(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=running \
  --query 'Reservations[0].Instances[0].[InstanceId,PrivateIpAddress,SubnetId]' --output text)
[[ "$runtime" != "None" ]] || { echo "No running $NAME instance" >&2; exit 1; }

# Runs a script on the runtime host through SSM and prints its output; fails if the script does.
on_runtime() {
  local params command_id status
  params=$(python3 -c 'import json,sys; print(json.dumps({"commands": [sys.argv[1]]}))' "$(printf 'echo %s | base64 -d | bash' "$(printf '%s' "$1" | base64 | tr -d '\n')")")
  command_id=$(aws ssm send-command --instance-ids "$runtime" --document-name AWS-RunShellScript --comment "$2" --parameters "$params" --query Command.CommandId --output text)
  for _ in $(seq 1 150); do
    status=$(aws ssm get-command-invocation --command-id "$command_id" --instance-id "$runtime" --query Status --output text 2>/dev/null || echo Pending)
    [[ "$status" == Pending || "$status" == InProgress || "$status" == Delayed ]] || break
    sleep 2
  done
  aws ssm get-command-invocation --command-id "$command_id" --instance-id "$runtime" --query '[StandardOutputContent,StandardErrorContent]' --output text
  [[ "$status" == Success ]]
}

if [[ $# -ge 1 ]]; then
  image="$registry/$ECR_REPOSITORY:$1"
else
  image=$(on_runtime 'cat /opt/agent-runtime/image' "read runtime image" | head -1 | cut -f1 | tr -d '[:space:]')
fi
[[ "$image" == "$registry/$ECR_REPOSITORY:"* ]] || { echo "Unexpected image: $image" >&2; exit 1; }
aws ecr describe-images --repository-name "$ECR_REPOSITORY" --image-ids imageTag="${image##*:}" >/dev/null \
  || { echo "$image is not in ECR; run infra/agent-runtime/deploy.sh first" >&2; exit 1; }
echo "image: $image"

old=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$EXECUTOR_NAME" Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[].Instances[].InstanceId' --output text)

log "Launching $EXECUTOR_COUNT $EXECUTOR_INSTANCE_TYPE executor host(s)"
b64() { base64 < "$1" | tr -d '\n'; }
# Rendered into a private file, never a command-line argument, so secrets stay out of `ps`.
user_data=$(umask 077 && mktemp)
trap 'rm -f "$user_data"' EXIT
EXECUTOR_TOKEN="$(aws secretsmanager get-secret-value --secret-id "$SECRET_PREFIX/executor-token" --query SecretString --output text)" \
  ECR_PASSWORD="$(aws ecr get-login-password)" IMAGE="$image" REGISTRY="$registry" GVISOR_RELEASE="$GVISOR_RELEASE" \
  EXECUTOR_SERVICE_B64="$(b64 "$here/agent-executor.service")" \
  python3 -c 'import os, sys
text = open(sys.argv[1]).read()
for key in ["EXECUTOR_TOKEN", "ECR_PASSWORD", "IMAGE", "REGISTRY", "GVISOR_RELEASE", "EXECUTOR_SERVICE_B64"]:
    text = text.replace(f"__{key}__", os.environ[key])
print(text)' "$here/user-data.sh" > "$user_data"
ami=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
# No instance profile. IMDS answers only the host itself (hop limit 1 keeps containers out)
# and is switched off entirely once the host is healthy.
new=$(aws ec2 run-instances --image-id "$ami" --instance-type "$EXECUTOR_INSTANCE_TYPE" --count "$EXECUTOR_COUNT" \
  --subnet-id "$runtime_subnet" --security-group-ids "$executor_sg" "$bootstrap_sg" --associate-public-ip-address \
  --metadata-options HttpTokens=required,HttpEndpoint=enabled,HttpPutResponseHopLimit=1 \
  --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=16,VolumeType=gp3,Encrypted=true,DeleteOnTermination=true}" \
  --user-data "file://$user_data" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$EXECUTOR_NAME},{Key=Image,Value=${image##*:}}]" \
  --query 'Instances[].InstanceId' --output text)
rm -f "$user_data"
echo "new hosts: $new"
aws ec2 wait instance-running --instance-ids $new
ips=$(aws ec2 describe-instances --instance-ids $new --query 'Reservations[].Instances[].PrivateIpAddress' --output text)

log "Waiting for the executors to answer the runtime host"
checks=""
for ip in $ips; do checks+="curl -fsS --max-time 3 http://$ip:$EXECUTOR_PORT/healthz >/dev/null && "; done
if ! on_runtime "for i in \$(seq 1 120); do if ${checks}true; then echo healthy; exit 0; fi; sleep 5; done; exit 1" "executor health"; then
  echo "Executors did not become healthy; terminating them. Nothing on the runtime changed." >&2
  aws ec2 terminate-instances --instance-ids $new >/dev/null
  exit 1
fi

log "Locking the new hosts down: no bootstrap egress, no public address use, no metadata service"
for id in $new; do
  aws ec2 modify-instance-attribute --instance-id "$id" --groups "$executor_sg"
  aws ec2 modify-instance-metadata-options --instance-id "$id" --http-endpoint disabled >/dev/null
done

log "Pointing the runtime at $ips"
urls=$(for ip in $ips; do printf 'http://%s:%s,' "$ip" "$EXECUTOR_PORT"; done)
on_runtime "$(cat <<SH
set -euo pipefail
dir=/opt/agent-runtime
umask 077
printf '%s\n' 'AGENT_EXECUTOR_URL=${urls%,}' 'AGENT_EXECUTOR_CALLBACK_URL=http://$runtime_ip:$EXECUTOR_CALLBACK_PORT' 'AGENT_EXECUTOR_CALLBACK_PORT=$EXECUTOR_CALLBACK_PORT' > \$dir/executor.env
systemctl restart agent-runtime.service
for i in \$(seq 1 30); do
  if docker exec agent-runtime node -e 'fetch("http://127.0.0.1:8790/healthz").then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))'; then
    docker logs agent-runtime 2>&1 | grep -q executor_callbacks_listening && { echo "runtime healthy with executors"; exit 0; }
  fi
  sleep 2
done
echo "runtime did not become healthy with executors" >&2
docker logs --tail 50 agent-runtime >&2
exit 1
SH
)" "use executors"

if [[ -n "$old" ]]; then
  log "Terminating previous executor hosts: $old"
  aws ec2 terminate-instances --instance-ids $old >/dev/null
fi
log "Done: executors $new"
