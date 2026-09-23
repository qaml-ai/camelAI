# Shared settings for the agent runtime scripts. Sourced, not executed.
REGION=us-west-2
NAME=camelai-agent-runtime
HOSTNAME=agents.camelai.dev
SECRET_PREFIX=camelai/agent-runtime
ECR_REPOSITORY=camelai-agent-runtime
INSTANCE_TYPE=t4g.medium
ROOT_VOLUME_GB=40
ACCOUNT_ID=904534089871
CLOUDFLARE_ZONE=camelai.dev
# Code executor hosts (infra/agent-runtime/executor/).
EXECUTOR_NAME=camelai-agent-executor
EXECUTOR_INSTANCE_TYPE=t4g.small
EXECUTOR_COUNT=1
EXECUTOR_PORT=8790
EXECUTOR_CALLBACK_PORT=8791
# gVisor release for runsc; pin a dated release (e.g. 20250811) once validated on the host.
GVISOR_RELEASE=latest
