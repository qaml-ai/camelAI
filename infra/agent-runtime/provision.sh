#!/usr/bin/env bash
# Create (or confirm) every AWS resource for the hosted agent runtime.
# Safe to re-run: each step looks for its resource before creating it.
# Usage: infra/agent-runtime/provision.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
source "$here/config.sh"
aws() { command aws --region "$REGION" "$@"; }
log() { printf '\n==> %s\n' "$*"; }

log "ECR repository $ECR_REPOSITORY"
if ! aws ecr describe-repositories --repository-names "$ECR_REPOSITORY" >/dev/null 2>&1; then
  aws ecr create-repository --repository-name "$ECR_REPOSITORY" --image-scanning-configuration scanOnPush=true --image-tag-mutability IMMUTABLE >/dev/null
  aws ecr put-lifecycle-policy --repository-name "$ECR_REPOSITORY" --lifecycle-policy-text \
    '{"rules":[{"rulePriority":1,"description":"Keep the last 30 images","selection":{"tagStatus":"any","countType":"imageCountMoreThan","countNumber":30},"action":{"type":"expire"}}]}' >/dev/null
fi

log "Secrets under $SECRET_PREFIX/"
if ! aws secretsmanager describe-secret --secret-id "$SECRET_PREFIX/session-secret" >/dev/null 2>&1; then
  aws secretsmanager create-secret --name "$SECRET_PREFIX/session-secret" \
    --description "Derives agent runtime client session tokens. Rotating it invalidates every session token." \
    --secret-string "$(openssl rand -hex 32)" >/dev/null
fi
if ! aws secretsmanager describe-secret --secret-id "$SECRET_PREFIX/secrets-key" >/dev/null 2>&1; then
  aws secretsmanager create-secret --name "$SECRET_PREFIX/secrets-key" \
    --description "AES-256 key that encrypts tenant-set provider keys at rest. Losing it makes stored keys unreadable." \
    --secret-string "$(openssl rand -hex 32)" >/dev/null
fi
if ! aws secretsmanager describe-secret --secret-id "$SECRET_PREFIX/tenants" >/dev/null 2>&1; then
  aws secretsmanager create-secret --name "$SECRET_PREFIX/tenants" \
    --description "Agent runtime tenants: operator token hashes and provider API keys. Edit with infra/agent-runtime/tenant.sh." \
    --secret-string '{"tenants":{}}' >/dev/null
fi

log "IAM role and instance profile $NAME"
if ! aws iam get-role --role-name "$NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$NAME" --description "Agent runtime EC2 host" \
    --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' >/dev/null
  aws iam attach-role-policy --role-name "$NAME" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
fi
aws iam put-role-policy --role-name "$NAME" --policy-name agent-runtime --policy-document "$(cat <<JSON
{"Version":"2012-10-17","Statement":[
  {"Effect":"Allow","Action":"secretsmanager:GetSecretValue","Resource":[
    "arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:$SECRET_PREFIX/session-secret-*",
    "arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:$SECRET_PREFIX/tenants-*",
    "arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:$SECRET_PREFIX/secrets-key-*",
    "arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:$SECRET_PREFIX/github-oauth-*",
    "arn:aws:secretsmanager:$REGION:$ACCOUNT_ID:secret:$SECRET_PREFIX/executor-token-*"]},
  {"Effect":"Allow","Action":"ecr:GetAuthorizationToken","Resource":"*"},
  {"Effect":"Allow","Action":["ecr:BatchGetImage","ecr:GetDownloadUrlForLayer","ecr:BatchCheckLayerAvailability"],
   "Resource":"arn:aws:ecr:$REGION:$ACCOUNT_ID:repository/$ECR_REPOSITORY"}]}
JSON
)"
if ! aws iam get-instance-profile --instance-profile-name "$NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$NAME" >/dev/null
  aws iam add-role-to-instance-profile --instance-profile-name "$NAME" --role-name "$NAME"
  sleep 10 # Instance profiles take a moment to become usable by EC2.
fi

log "Security group $NAME (TCP/443 only)"
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
sg=$(aws ec2 describe-security-groups --filters Name=group-name,Values="$NAME" Name=vpc-id,Values="$vpc" --query 'SecurityGroups[0].GroupId' --output text)
if [[ "$sg" == "None" ]]; then
  sg=$(aws ec2 create-security-group --group-name "$NAME" --description "Agent runtime: HTTPS only, no SSH" --vpc-id "$vpc" --query GroupId --output text)
  aws ec2 authorize-security-group-ingress --group-id "$sg" --ip-permissions \
    'IpProtocol=tcp,FromPort=443,ToPort=443,IpRanges=[{CidrIp=0.0.0.0/0}],Ipv6Ranges=[{CidrIpv6=::/0}]' >/dev/null
  aws ec2 create-tags --resources "$sg" --tags Key=Name,Value="$NAME"
fi

log "EC2 instance $NAME ($INSTANCE_TYPE)"
instance=$(aws ec2 describe-instances --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running,stopping,stopped \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [[ "$instance" == "None" ]]; then
  ami=$(aws ssm get-parameter --name /aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64 --query Parameter.Value --output text)
  user_data=$(cat <<'SH'
#!/bin/bash
set -euo pipefail
dnf install -y docker
systemctl enable --now docker
mkdir -p /opt/agent-runtime/data /opt/agent-runtime/caddy/data /opt/agent-runtime/caddy/config
chown 1000:1000 /opt/agent-runtime/data
SH
)
  instance=$(aws ec2 run-instances --image-id "$ami" --instance-type "$INSTANCE_TYPE" \
    --iam-instance-profile Name="$NAME" --security-group-ids "$sg" \
    --metadata-options HttpTokens=required,HttpEndpoint=enabled \
    --block-device-mappings "DeviceName=/dev/xvda,Ebs={VolumeSize=$ROOT_VOLUME_GB,VolumeType=gp3,Encrypted=true,DeleteOnTermination=false}" \
    --user-data "$user_data" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" "ResourceType=volume,Tags=[{Key=Name,Value=$NAME},{Key=Backup,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)
  aws ec2 modify-instance-attribute --instance-id "$instance" --disable-api-termination
  aws ec2 wait instance-running --instance-ids "$instance"
fi
echo "instance: $instance"

log "Elastic IP"
eip=$(aws ec2 describe-addresses --filters Name=tag:Name,Values="$NAME" --query 'Addresses[0].AllocationId' --output text)
if [[ "$eip" == "None" ]]; then
  eip=$(aws ec2 allocate-address --domain vpc --tag-specifications "ResourceType=elastic-ip,Tags=[{Key=Name,Value=$NAME}]" --query AllocationId --output text)
fi
aws ec2 associate-address --allocation-id "$eip" --instance-id "$instance" >/dev/null
ip=$(aws ec2 describe-addresses --allocation-ids "$eip" --query 'Addresses[0].PublicIp' --output text)
echo "public IP: $ip"

log "EBS snapshots (hourly, 48 kept; daily, 7 kept)"
if ! aws iam get-role --role-name AWSDataLifecycleManagerDefaultRole >/dev/null 2>&1; then
  aws dlm create-default-role --resource-type snapshot >/dev/null
  sleep 10
fi
snapshot_policy="{\"ResourceTypes\":[\"VOLUME\"],\"TargetTags\":[{\"Key\":\"Backup\",\"Value\":\"$NAME\"}],\"Schedules\":[
  {\"Name\":\"hourly\",\"CreateRule\":{\"Interval\":1,\"IntervalUnit\":\"HOURS\"},\"RetainRule\":{\"Count\":48},\"CopyTags\":true},
  {\"Name\":\"daily\",\"CreateRule\":{\"Interval\":24,\"IntervalUnit\":\"HOURS\",\"Times\":[\"09:00\"]},\"RetainRule\":{\"Count\":7},\"CopyTags\":true}]}"
policy=$(aws dlm get-lifecycle-policies --target-tags "Backup=$NAME" --query 'Policies[0].PolicyId' --output text 2>/dev/null || echo None)
if [[ "$policy" == "None" || -z "$policy" ]]; then
  aws dlm create-lifecycle-policy --description "$NAME snapshots" --state ENABLED \
    --execution-role-arn "arn:aws:iam::$ACCOUNT_ID:role/AWSDataLifecycleManagerDefaultRole" --policy-details "$snapshot_policy" >/dev/null
else
  aws dlm update-lifecycle-policy --policy-id "$policy" --description "$NAME snapshots" --state ENABLED --policy-details "$snapshot_policy" >/dev/null
fi

log "Self-healing and alerts"
# The host recovers onto new hardware if AWS's side fails, and reboots if the OS stops responding.
aws cloudwatch put-metric-alarm --alarm-name "$NAME-system-check" --alarm-description "Recover $NAME onto healthy hardware" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed_System --dimensions Name=InstanceId,Value="$instance" \
  --statistic Maximum --period 60 --evaluation-periods 2 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions "arn:aws:automate:$REGION:ec2:recover"
aws cloudwatch put-metric-alarm --alarm-name "$NAME-instance-check" --alarm-description "Reboot $NAME when its OS stops responding" \
  --namespace AWS/EC2 --metric-name StatusCheckFailed_Instance --dimensions Name=InstanceId,Value="$instance" \
  --statistic Maximum --period 60 --evaluation-periods 3 --threshold 1 --comparison-operator GreaterThanOrEqualToThreshold \
  --alarm-actions "arn:aws:automate:$REGION:ec2:reboot"
# Route 53 health checks publish their metric in us-east-1, so the alert topic lives there.
alerts=$(command aws --region us-east-1 sns create-topic --name "$NAME-alerts" --query TopicArn --output text)
check=$(command aws route53 list-health-checks --query "HealthChecks[?HealthCheckConfig.FullyQualifiedDomainName=='$HOSTNAME' && HealthCheckConfig.ResourcePath=='/healthz'].Id | [0]" --output text)
if [[ "$check" == "None" || -z "$check" ]]; then
  check=$(command aws route53 create-health-check --caller-reference "$NAME-$(date +%s)" --health-check-config \
    "Type=HTTPS,FullyQualifiedDomainName=$HOSTNAME,Port=443,ResourcePath=/healthz,RequestInterval=30,FailureThreshold=3,EnableSNI=true" \
    --query HealthCheck.Id --output text)
  command aws route53 change-tags-for-resource --resource-type healthcheck --resource-id "$check" --add-tags Key=Name,Value="$NAME"
fi
command aws --region us-east-1 cloudwatch put-metric-alarm --alarm-name "$NAME-healthz" --alarm-description "Health check of $HOSTNAME/healthz is failing" \
  --namespace AWS/Route53 --metric-name HealthCheckStatus --dimensions Name=HealthCheckId,Value="$check" \
  --statistic Minimum --period 60 --evaluation-periods 3 --threshold 1 --comparison-operator LessThanThreshold \
  --treat-missing-data breaching --alarm-actions "$alerts" --ok-actions "$alerts"
echo "alerts topic: $alerts"
echo "subscribe with: aws sns subscribe --region us-east-1 --topic-arn $alerts --protocol email --notification-endpoint <you@example.com>"

log "DNS $HOSTNAME -> $ip (Cloudflare, DNS-only)"
if [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  cf() { curl -fsS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" -H "Content-Type: application/json" "$@"; }
  zone=$(cf "https://api.cloudflare.com/client/v4/zones?name=$CLOUDFLARE_ZONE" | python3 -c 'import json,sys; print(json.load(sys.stdin)["result"][0]["id"])')
  record=$(cf "https://api.cloudflare.com/client/v4/zones/$zone/dns_records?type=A&name=$HOSTNAME" | python3 -c 'import json,sys; r=json.load(sys.stdin)["result"]; print(r[0]["id"] if r else "")')
  body="{\"type\":\"A\",\"name\":\"$HOSTNAME\",\"content\":\"$ip\",\"ttl\":300,\"proxied\":false,\"comment\":\"$NAME Elastic IP\"}"
  if [[ -n "$record" ]]; then cf -X PUT "https://api.cloudflare.com/client/v4/zones/$zone/dns_records/$record" --data "$body" >/dev/null
  else cf -X POST "https://api.cloudflare.com/client/v4/zones/$zone/dns_records" --data "$body" >/dev/null; fi
  echo "DNS record set"
else
  echo "CLOUDFLARE_API_TOKEN is not set: create a DNS-only A record $HOSTNAME -> $ip yourself."
fi

log "Done. Next: infra/agent-runtime/tenant.sh add <tenant>, then infra/agent-runtime/deploy.sh"
