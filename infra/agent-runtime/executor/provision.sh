#!/usr/bin/env bash
# Create (or confirm) the AWS resources for code executor hosts: their token and
# security groups. Hosts themselves are launched by deploy.sh, which replaces them.
# Safe to re-run. Run infra/agent-runtime/provision.sh first.
# Usage: infra/agent-runtime/executor/provision.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/../config.sh"
aws() { command aws --region "$REGION" "$@"; }
log() { printf '\n==> %s\n' "$*"; }

log "Secret $SECRET_PREFIX/executor-token"
# The only secret an executor host holds. The runtime role may read it (see ../provision.sh);
# executor hosts have no role at all and receive it once, at launch.
if ! aws secretsmanager describe-secret --secret-id "$SECRET_PREFIX/executor-token" >/dev/null 2>&1; then
  aws secretsmanager create-secret --name "$SECRET_PREFIX/executor-token" \
    --description "Bearer token the agent runtime presents to code executor hosts." \
    --secret-string "$(openssl rand -hex 32)" >/dev/null
fi

vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
group() { aws ec2 describe-security-groups --filters Name=group-name,Values="$1" Name=vpc-id,Values="$vpc" --query 'SecurityGroups[0].GroupId' --output text; }
runtime_sg=$(group "$NAME")
[[ "$runtime_sg" != "None" ]] || { echo "No $NAME security group; run infra/agent-runtime/provision.sh first" >&2; exit 1; }

# Adds a rule unless an identical one exists (EC2 reports duplicates as an error).
allow() {
  local output
  if ! output=$(aws ec2 "$@" 2>&1 >/dev/null); then
    [[ "$output" == *InvalidPermission.Duplicate* ]] || { echo "$output" >&2; exit 1; }
  fi
}

log "Security group $EXECUTOR_NAME (in: $EXECUTOR_PORT from the runtime; out: $EXECUTOR_CALLBACK_PORT to the runtime only)"
executor_sg=$(group "$EXECUTOR_NAME")
if [[ "$executor_sg" == "None" ]]; then
  executor_sg=$(aws ec2 create-security-group --group-name "$EXECUTOR_NAME" --vpc-id "$vpc" \
    --description "Code executors: reachable only from the agent runtime, and reach only its callback port" --query GroupId --output text)
  aws ec2 create-tags --resources "$executor_sg" --tags Key=Name,Value="$EXECUTOR_NAME"
  # New groups allow all egress; a compromised executor must not reach anything else.
  aws ec2 revoke-security-group-egress --group-id "$executor_sg" \
    --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
fi
allow authorize-security-group-ingress --group-id "$executor_sg" \
  --ip-permissions "IpProtocol=tcp,FromPort=$EXECUTOR_PORT,ToPort=$EXECUTOR_PORT,UserIdGroupPairs=[{GroupId=$runtime_sg}]"
allow authorize-security-group-egress --group-id "$executor_sg" \
  --ip-permissions "IpProtocol=tcp,FromPort=$EXECUTOR_CALLBACK_PORT,ToPort=$EXECUTOR_CALLBACK_PORT,UserIdGroupPairs=[{GroupId=$runtime_sg}]"

log "Runtime group $NAME accepts callbacks on $EXECUTOR_CALLBACK_PORT from $EXECUTOR_NAME only"
allow authorize-security-group-ingress --group-id "$runtime_sg" \
  --ip-permissions "IpProtocol=tcp,FromPort=$EXECUTOR_CALLBACK_PORT,ToPort=$EXECUTOR_CALLBACK_PORT,UserIdGroupPairs=[{GroupId=$executor_sg}]"

log "Security group $EXECUTOR_NAME-bootstrap (out: HTTPS, while a new host installs Docker, gVisor and the image)"
bootstrap_sg=$(group "$EXECUTOR_NAME-bootstrap")
if [[ "$bootstrap_sg" == "None" ]]; then
  bootstrap_sg=$(aws ec2 create-security-group --group-name "$EXECUTOR_NAME-bootstrap" --vpc-id "$vpc" \
    --description "Code executor first boot only; deploy.sh detaches it once the host is healthy" --query GroupId --output text)
  aws ec2 create-tags --resources "$bootstrap_sg" --tags Key=Name,Value="$EXECUTOR_NAME-bootstrap"
  aws ec2 revoke-security-group-egress --group-id "$bootstrap_sg" \
    --ip-permissions 'IpProtocol=-1,IpRanges=[{CidrIp=0.0.0.0/0}]' >/dev/null
fi
allow authorize-security-group-egress --group-id "$bootstrap_sg" \
  --ip-permissions 'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}]'
allow authorize-security-group-egress --group-id "$bootstrap_sg" \
  --ip-permissions 'IpProtocol=tcp,FromPort=80,ToPort=80,IpRanges=[{CidrIp=0.0.0.0/0}]'

echo "executor group: $executor_sg; bootstrap group: $bootstrap_sg; runtime group: $runtime_sg"
log "Done. Next: infra/agent-runtime/deploy.sh (runtime image + callback port), then infra/agent-runtime/executor/deploy.sh"
