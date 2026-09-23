#!/bin/bash
# First boot of a code executor host. deploy.sh fills the __PLACEHOLDERS__.
# The host has no IAM role: the image is pulled with a short-lived ECR password
# baked in here, and both it and the executor token are scrubbed from the
# instance's copies of this script before the executor starts. Never `set -x`.
set -euo pipefail
umask 077

dnf install -y docker
systemctl enable --now docker

# gVisor's runsc, verified against its published checksums.
arch=$(uname -m)
url="https://storage.googleapis.com/gvisor/releases/release/__GVISOR_RELEASE__/$arch"
cd "$(mktemp -d)"
curl -fsSLO "$url/runsc" -O "$url/runsc.sha512" -O "$url/containerd-shim-runsc-v1" -O "$url/containerd-shim-runsc-v1.sha512"
sha512sum -c runsc.sha512 -c containerd-shim-runsc-v1.sha512
install -m 755 runsc containerd-shim-runsc-v1 /usr/local/bin/
/usr/local/bin/runsc install
systemctl restart docker

mkdir -p /opt/agent-executor
echo '__EXECUTOR_SERVICE_B64__' | base64 -d > /etc/systemd/system/agent-executor.service
echo 'AGENT_EXECUTOR_TOKEN=__EXECUTOR_TOKEN__' > /opt/agent-executor/executor.env
chmod 600 /opt/agent-executor/executor.env
echo '__IMAGE__' > /opt/agent-executor/image

# Pull once, then drop the registry credential: restarts use the local image.
export DOCKER_CONFIG=$(mktemp -d)
echo '__ECR_PASSWORD__' | docker login --username AWS --password-stdin '__REGISTRY__' >/dev/null
docker pull --quiet '__IMAGE__'
docker logout '__REGISTRY__' >/dev/null
rm -rf "$DOCKER_CONFIG"
unset DOCKER_CONFIG

rm -f /var/lib/cloud/instance/user-data.txt* /var/lib/cloud/instance/scripts/part-* /var/lib/cloud/instances/*/user-data.txt* /var/lib/cloud/instances/*/scripts/part-*
systemctl daemon-reload
systemctl enable --now agent-executor.service
