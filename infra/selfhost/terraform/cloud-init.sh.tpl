#!/usr/bin/env bash
set -euo pipefail
exec > >(tee -a /var/log/camelai-bootstrap.log) 2>&1
export DEBIAN_FRONTEND=noninteractive

BOOTSTRAP_STATUS_DIR=/var/lib/camelai-selfhost
install -d -m 0755 "$BOOTSTRAP_STATUS_DIR"
rm -f "$BOOTSTRAP_STATUS_DIR/ready" "$BOOTSTRAP_STATUS_DIR/failed"
BOOTSTRAP_SUCCEEDED=0
trap 'status=$?; if [ "$BOOTSTRAP_SUCCEEDED" -ne 1 ]; then touch "$BOOTSTRAP_STATUS_DIR/failed"; fi; exit "$status"' EXIT

decode() {
  printf '%s' "$1" | base64 --decode
}

AWS_REGION="$(decode "${aws_region_b64}")"
DATA_VOLUME_ID="$(decode "${data_volume_id_b64}")"
REPOSITORY_URL="$(decode "${repository_url_b64}")"
REPOSITORY_REF="$(decode "${repository_ref_b64}")"
APP_IMAGE="$(decode "${app_image_b64}")"
LOCAL_ARTIFACTS_IMAGE="$(decode "${local_artifacts_image_b64}")"
PROJECT_BUILD_IMAGE="$(decode "${project_build_image_b64}")"
ANALYSIS_IMAGE="$(decode "${analysis_image_b64}")"
DB_QUERY_IMAGE="$(decode "${db_query_image_b64}")"
CONTAINER_EGRESS_IMAGE="$(decode "${container_egress_image_b64}")"
CADDY_IMAGE="$(decode "${caddy_image_b64}")"
MAIN_HOSTNAME="$(decode "${main_hostname_b64}")"
APP_VANITY_DOMAIN="$(decode "${app_vanity_domain_b64}")"
APP_IFRAME_DOMAIN="$(decode "${app_iframe_domain_b64}")"
TLS_MODE="$(decode "${tls_mode_b64}")"
TLS_CERTIFICATE_SECRET_ARN="$(decode "${tls_certificate_secret_arn_b64}")"
TLS_PRIVATE_KEY_SECRET_ARN="$(decode "${tls_private_key_secret_arn_b64}")"
ROUTE53_ZONE_ID="$(decode "${route53_zone_id_b64}")"
AUTH_PROVIDER="$(decode "${auth_provider_b64}")"
AUTH_DEFAULT_ORG_NAME="$(decode "${auth_default_org_name_b64}")"
CLOUDFLARE_ACCESS_TEAM_DOMAIN="$(decode "${cloudflare_access_team_domain_b64}")"
CLOUDFLARE_ACCESS_AUD="$(decode "${cloudflare_access_aud_b64}")"
POMERIUM_AUTHENTICATE_URL="$(decode "${pomerium_authenticate_url_b64}")"
POMERIUM_AUTHENTICATE_HOSTNAME="$(decode "${pomerium_authenticate_hostname_b64}")"
POMERIUM_IMAGE="$(decode "${pomerium_image_b64}")"
POMERIUM_JWKS_URL="$(decode "${pomerium_jwks_url_b64}")"
POMERIUM_IDP_PROVIDER="$(decode "${pomerium_idp_provider_b64}")"
POMERIUM_IDP_PROVIDER_URL="$(decode "${pomerium_idp_provider_url_b64}")"
POMERIUM_IDP_CLIENT_ID="$(decode "${pomerium_idp_client_id_b64}")"
POMERIUM_IDP_CLIENT_SECRET_ARN="$(decode "${pomerium_idp_client_secret_arn_b64}")"
POMERIUM_ISSUER="$(decode "${pomerium_issuer_b64}")"
POMERIUM_AUDIENCE="$(decode "${pomerium_audience_b64}")"
SELFHOST_AI_PROVIDER="$(decode "${selfhost_ai_provider_b64}")"
SELFHOST_AI_API_KEY_SECRET_ARN="$(decode "${selfhost_ai_api_key_secret_arn_b64}")"
SELFHOST_AI_AWS_REGION="$(decode "${selfhost_ai_aws_region_b64}")"
SELFHOST_AI_BASE_URL="$(decode "${selfhost_ai_base_url_b64}")"
SELFHOST_AI_MODEL="$(decode "${selfhost_ai_model_b64}")"
SELFHOST_AI_NAME="$(decode "${selfhost_ai_name_b64}")"
SELFHOST_AI_API="$(decode "${selfhost_ai_api_b64}")"
SELFHOST_AI_AUTH_TYPE="$(decode "${selfhost_ai_auth_type_b64}")"

apt-get update
apt-get install -y ca-certificates curl git gnupg jq openssl unzip

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
. /etc/os-release
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list

curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin nodejs
npm install --global bun@1.3.14

if ! command -v aws >/dev/null 2>&1; then
  curl -fsSL https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o /tmp/awscliv2.zip
  unzip -q /tmp/awscliv2.zip -d /tmp
  /tmp/aws/install
fi

systemctl stop docker.service docker.socket || true

find_data_device() {
  local serial
  serial="$${DATA_VOLUME_ID//-/}"
  for _ in $(seq 1 120); do
    for candidate in \
      "/dev/disk/by-id/nvme-Amazon_Elastic_Block_Store_$${serial}" \
      /dev/xvdf \
      /dev/sdf; do
      if [ -b "$${candidate}" ]; then
        readlink -f "$${candidate}"
        return 0
      fi
    done
    lsblk -ndo PATH,SERIAL | awk -v serial="$${serial}" '$2 == serial { print $1; exit }' | grep -m1 . && return 0
    sleep 5
  done
  return 1
}

DATA_DEVICE="$(find_data_device)" || {
  echo "Persistent EBS volume $${DATA_VOLUME_ID} did not attach" >&2
  exit 1
}

if ! blkid "$${DATA_DEVICE}" >/dev/null 2>&1; then
  mkfs.ext4 -L camelai-data "$${DATA_DEVICE}"
fi
install -d -m 0750 /srv/camelai
DATA_UUID="$(blkid -s UUID -o value "$${DATA_DEVICE}")"
if ! grep -q "UUID=$${DATA_UUID}" /etc/fstab; then
  echo "UUID=$${DATA_UUID} /srv/camelai ext4 defaults,nofail 0 2" >> /etc/fstab
fi
mountpoint -q /srv/camelai || mount /srv/camelai
install -d -m 0710 /srv/camelai/docker /srv/camelai/releases

cat > /etc/docker/daemon.json <<'JSON'
{
  "data-root": "/srv/camelai/docker",
  "live-restore": true,
  "log-driver": "local"
}
JSON
systemctl enable --now docker
if systemctl list-unit-files amazon-ssm-agent.service --no-legend | grep -q amazon-ssm-agent; then
  systemctl enable --now amazon-ssm-agent
elif systemctl list-unit-files snap.amazon-ssm-agent.amazon-ssm-agent.service --no-legend | grep -q amazon-ssm-agent; then
  systemctl enable --now snap.amazon-ssm-agent.amazon-ssm-agent
fi

if [ ! -d /srv/camelai/repo/.git ]; then
  git clone "$${REPOSITORY_URL}" /srv/camelai/repo
fi
cd /srv/camelai/repo
git remote set-url origin "$${REPOSITORY_URL}"
git fetch --force --tags origin
git checkout --detach "$${REPOSITORY_REF}"
bun install --frozen-lockfile

if [ ! -f .env.selfhost ]; then
  bun run selfhost:init
fi

SELFHOST_AI_API_KEY="$(aws secretsmanager get-secret-value \
  --secret-id "$${SELFHOST_AI_API_KEY_SECRET_ARN}" \
  --query SecretString \
  --output text)"
if [ -z "$${SELFHOST_AI_API_KEY}" ] || [ "$${SELFHOST_AI_API_KEY}" = "None" ]; then
  echo "AI API key secret is empty" >&2
  exit 1
fi
if [[ "$${SELFHOST_AI_API_KEY}" == *$'\n'* ]]; then
  echo "AI API key SecretString must be a single line" >&2
  exit 1
fi

POMERIUM_IDP_CLIENT_SECRET=""
if [ "$${AUTH_PROVIDER}" = "bundled-pomerium" ]; then
  POMERIUM_IDP_CLIENT_SECRET="$(aws secretsmanager get-secret-value \
    --secret-id "$${POMERIUM_IDP_CLIENT_SECRET_ARN}" \
    --query SecretString \
    --output text)"
  if [ -z "$${POMERIUM_IDP_CLIENT_SECRET}" ] || [ "$${POMERIUM_IDP_CLIENT_SECRET}" = "None" ]; then
    echo "Pomerium IdP client secret is empty" >&2
    exit 1
  fi
  if [[ "$${POMERIUM_IDP_CLIENT_SECRET}" == *$'\n'* ]]; then
    echo "Pomerium IdP client SecretString must be a single line" >&2
    exit 1
  fi
fi

export CFG_SELFHOST_APP_IMAGE="$${APP_IMAGE}"
export CFG_SELFHOST_LOCAL_ARTIFACTS_IMAGE="$${LOCAL_ARTIFACTS_IMAGE}"
export CFG_SELFHOST_PROJECT_BUILD_IMAGE="$${PROJECT_BUILD_IMAGE}"
export CFG_SELFHOST_ANALYSIS_IMAGE="$${ANALYSIS_IMAGE}"
export CFG_SELFHOST_DB_QUERY_IMAGE="$${DB_QUERY_IMAGE}"
export CFG_SELFHOST_CONTAINER_EGRESS_IMAGE="$${CONTAINER_EGRESS_IMAGE}"
export CFG_SELFHOST_CADDY_IMAGE="$${CADDY_IMAGE}"
export CFG_SELFHOST_DEPLOYMENT_MODE="release"
export CFG_SELFHOST_PUBLIC_BASE_URL="https://$${MAIN_HOSTNAME}"
export CFG_SELFHOST_MAIN_HOSTNAME="$${MAIN_HOSTNAME}"
export CFG_SELFHOST_AUTH_MODE="$${AUTH_PROVIDER}"
if [ "$${AUTH_PROVIDER}" = "pomerium" ]; then
  export CFG_SELFHOST_AUTH_MODE="external-pomerium"
fi
export CFG_SELFHOST_TLS_MODE="$${TLS_MODE}"
export CFG_SELFHOST_TLS_DNS_PROVIDER=""
export CFG_SELFHOST_TLS_ROUTE53_HOSTED_ZONE_ID=""
export CFG_SELFHOST_TLS_AWS_REGION="$${AWS_REGION}"
export CFG_SELFHOST_TLS_EXTERNAL_BIND_ADDRESS="127.0.0.1"
export CFG_SELFHOST_TLS_EXTERNAL_PORT="8080"
if [ "$${TLS_MODE}" = "automatic" ]; then
  export CFG_SELFHOST_TLS_DNS_PROVIDER="route53"
  export CFG_SELFHOST_TLS_ROUTE53_HOSTED_ZONE_ID="$${ROUTE53_ZONE_ID}"
elif [ "$${TLS_MODE}" = "external" ]; then
  export CFG_SELFHOST_TLS_EXTERNAL_BIND_ADDRESS="0.0.0.0"
  export CFG_SELFHOST_TLS_EXTERNAL_PORT="80"
fi
export CFG_SELFHOST_POMERIUM_IMAGE="$${POMERIUM_IMAGE}"
export CFG_LOCAL_APP_VANITY_DOMAIN="$${APP_VANITY_DOMAIN}"
export CFG_LOCAL_APP_IFRAME_DOMAIN="$${APP_IFRAME_DOMAIN}"
export CFG_SELFHOST_AI_PROVIDER="$${SELFHOST_AI_PROVIDER}"
export CFG_SELFHOST_AI_API_KEY="$${SELFHOST_AI_API_KEY}"
export CFG_SELFHOST_AI_AWS_REGION="$${SELFHOST_AI_AWS_REGION}"
export CFG_SELFHOST_AI_BASE_URL="$${SELFHOST_AI_BASE_URL}"
export CFG_SELFHOST_AI_MODEL="$${SELFHOST_AI_MODEL}"
export CFG_SELFHOST_AI_NAME="$${SELFHOST_AI_NAME}"
export CFG_SELFHOST_AI_API="$${SELFHOST_AI_API}"
export CFG_SELFHOST_AI_AUTH_TYPE="$${SELFHOST_AI_AUTH_TYPE}"
export CFG_CLOUDFLARE_ACCESS_TEAM_DOMAIN=""
export CFG_CLOUDFLARE_ACCESS_AUD=""
export CFG_CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME=""
export CFG_POMERIUM_AUTHENTICATE_URL=""
export CFG_POMERIUM_JWKS_URL=""
export CFG_POMERIUM_ISSUER=""
export CFG_POMERIUM_AUDIENCE=""
export CFG_POMERIUM_DEFAULT_ORG_NAME=""
export CFG_POMERIUM_AUTHENTICATE_HOSTNAME=""
export CFG_POMERIUM_IDP_PROVIDER=""
export CFG_POMERIUM_IDP_PROVIDER_URL=""
export CFG_POMERIUM_IDP_CLIENT_ID=""
export CFG_POMERIUM_IDP_CLIENT_SECRET=""

if [ "$${AUTH_PROVIDER}" = "cloudflare-access" ]; then
  export CFG_CLOUDFLARE_ACCESS_TEAM_DOMAIN="$${CLOUDFLARE_ACCESS_TEAM_DOMAIN}"
  export CFG_CLOUDFLARE_ACCESS_AUD="$${CLOUDFLARE_ACCESS_AUD}"
  export CFG_CLOUDFLARE_ACCESS_DEFAULT_ORG_NAME="$${AUTH_DEFAULT_ORG_NAME}"
elif [ "$${AUTH_PROVIDER}" = "pomerium" ]; then
  export CFG_POMERIUM_AUTHENTICATE_URL="$${POMERIUM_AUTHENTICATE_URL}"
  export CFG_POMERIUM_JWKS_URL="$${POMERIUM_JWKS_URL}"
  export CFG_POMERIUM_ISSUER="$${POMERIUM_ISSUER}"
  export CFG_POMERIUM_AUDIENCE="$${POMERIUM_AUDIENCE}"
  export CFG_POMERIUM_DEFAULT_ORG_NAME="$${AUTH_DEFAULT_ORG_NAME}"
else
  export CFG_POMERIUM_AUTHENTICATE_URL="$${POMERIUM_AUTHENTICATE_URL}"
  export CFG_POMERIUM_AUTHENTICATE_HOSTNAME="$${POMERIUM_AUTHENTICATE_HOSTNAME}"
  export CFG_POMERIUM_JWKS_URL="https://$${MAIN_HOSTNAME}/.well-known/pomerium/jwks.json"
  export CFG_POMERIUM_ISSUER="$${MAIN_HOSTNAME}"
  export CFG_POMERIUM_AUDIENCE="$${MAIN_HOSTNAME}"
  export CFG_POMERIUM_DEFAULT_ORG_NAME="$${AUTH_DEFAULT_ORG_NAME}"
  export CFG_POMERIUM_IDP_PROVIDER="$${POMERIUM_IDP_PROVIDER}"
  export CFG_POMERIUM_IDP_PROVIDER_URL="$${POMERIUM_IDP_PROVIDER_URL}"
  export CFG_POMERIUM_IDP_CLIENT_ID="$${POMERIUM_IDP_CLIENT_ID}"
  export CFG_POMERIUM_IDP_CLIENT_SECRET="$${POMERIUM_IDP_CLIENT_SECRET}"
fi

node <<'NODE'
import fs from "node:fs";

const envPath = ".env.selfhost";
const updates = Object.fromEntries(
  Object.entries(process.env)
    .filter(([key]) => key.startsWith("CFG_"))
    .map(([key, value]) => [key.slice(4), value ?? ""]),
);
updates.COMPOSE_PROJECT_NAME = "camelai-selfhost";
updates.SELFHOST_BIND_ADDRESS = "127.0.0.1";
updates.SELFHOST_APP_PORT = "3001";
updates.SELFHOST_INTERNAL_APP_URL = "http://127.0.0.1:3001";
updates.LOCAL_AUTH_BYPASS = "";
updates.TURNSTILE_SITE_KEY = "";
updates.TURNSTILE_SECRET_KEY = "";

const format = (value) =>
  /^[A-Za-z0-9_./:@-]*$/.test(value) ? value : JSON.stringify(value);
const original = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
const seen = new Set();
const output = original.map((line) => {
  const match = /^([A-Z][A-Z0-9_]*)=/.exec(line);
  if (!match || !(match[1] in updates)) return line;
  seen.add(match[1]);
  return `$${match[1]}=$${format(updates[match[1]])}`;
});
for (const [key, value] of Object.entries(updates)) {
  if (!seen.has(key)) output.push(`$${key}=$${format(value)}`);
}
fs.writeFileSync(envPath, `$${output.join("\n").replace(/\n+$/, "")}\n`, {
  mode: 0o600,
});
NODE
unset SELFHOST_AI_API_KEY CFG_SELFHOST_AI_API_KEY POMERIUM_IDP_CLIENT_SECRET CFG_POMERIUM_IDP_CLIENT_SECRET
chmod 600 .env.selfhost
if [ "$${TLS_MODE}" = "provided" ]; then
  install -d -m 0700 .selfhost/tls
  aws secretsmanager get-secret-value \
    --secret-id "$${TLS_CERTIFICATE_SECRET_ARN}" \
    --query SecretString \
    --output text > .selfhost/tls/tls.crt
  aws secretsmanager get-secret-value \
    --secret-id "$${TLS_PRIVATE_KEY_SECRET_ARN}" \
    --query SecretString \
    --output text > .selfhost/tls/tls.key
  chmod 600 .selfhost/tls/tls.crt .selfhost/tls/tls.key
fi
bun run selfhost:configure

cat > /usr/local/sbin/camelai-selfhost-compose <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cd /srv/camelai/repo
args=(--env-file .env.selfhost -f docker-compose.selfhost.yml)
args+=(-f docker-compose.selfhost.caddy.yml)
if grep -q '^SELFHOST_AUTH_MODE=bundled-pomerium$' .env.selfhost; then
  args+=(-f docker-compose.selfhost.pomerium.yml)
  if grep -Eq '^SELFHOST_TLS_MODE=(automatic|provided)$' .env.selfhost; then
    args+=(-f docker-compose.selfhost.pomerium-loopback.yml)
  fi
fi
exec /usr/bin/docker compose "$${args[@]}" "$@"
SCRIPT
chmod 0755 /usr/local/sbin/camelai-selfhost-compose

cat > /etc/systemd/system/camelai-selfhost.service <<'EOF'
[Unit]
Description=camelAI self-host Docker Compose release
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/srv/camelai/repo
ExecStartPre=/usr/local/bin/bun run selfhost:configure
ExecStartPre=/usr/local/sbin/camelai-selfhost-compose pull
ExecStart=/usr/local/sbin/camelai-selfhost-compose up --detach --remove-orphans --wait --wait-timeout 900
ExecReload=/usr/local/bin/bun run selfhost:configure
ExecReload=/usr/local/sbin/camelai-selfhost-compose pull
ExecReload=/usr/local/sbin/camelai-selfhost-compose up --detach --remove-orphans --wait --wait-timeout 900
ExecStop=/usr/local/sbin/camelai-selfhost-compose stop
TimeoutStartSec=1200
TimeoutStopSec=120

[Install]
WantedBy=multi-user.target
EOF

cat > /usr/local/sbin/camelai-selfhost-upgrade <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
cd /srv/camelai/repo
exec /usr/local/bin/bun run selfhost:upgrade -- "$@"
SCRIPT
chmod 750 /usr/local/sbin/camelai-selfhost-upgrade

bun run selfhost:doctor
systemctl daemon-reload
systemctl enable --now camelai-selfhost

health_ready=0
for _ in $(seq 1 90); do
  if curl --fail --silent http://127.0.0.1:3001/api/selfhost/health >/dev/null; then
    health_ready=1
    break
  fi
  sleep 10
done

if [ "$health_ready" -ne 1 ]; then
  echo "camelAI health endpoint did not become ready" >&2
  /usr/local/sbin/camelai-selfhost-compose ps >&2 || true
  /usr/local/sbin/camelai-selfhost-compose logs --tail=200 app >&2 || true
  exit 1
fi

# Compose health proves that services are configured and responding. These
# deep smokes prove workerd can create and execute every attached runtime
# through the production localDocker egress path.
bun --env-file=.env.selfhost run selfhost:container:smoke:project
bun --env-file=.env.selfhost run selfhost:container:smoke:analysis
bun --env-file=.env.selfhost run selfhost:container:smoke:db-query

rm -f "$BOOTSTRAP_STATUS_DIR/failed"
touch "$BOOTSTRAP_STATUS_DIR/ready"
BOOTSTRAP_SUCCEEDED=1
trap - EXIT
echo "camelAI self-host bootstrap and attached-runtime smokes completed"
