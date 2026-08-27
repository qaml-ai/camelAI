# Self-hosting camelAI

The supported self-host target is a single Linux VM running Docker Compose. The
application runs under workerd, and workerd starts isolated Docker containers
for project builds, notebook analysis, and database queries.

## Release images and source builds

Production installations should use the release Compose file with immutable
image references. At minimum, `.env.selfhost` must set `SELFHOST_APP_IMAGE` to
the camelAI application image published for the selected release. The
local-artifacts, project-build, analysis, database-query, and container-egress
image variables must refer to the matching release as well. Prefer
digest-pinned values:

```dotenv
SELFHOST_APP_IMAGE=ghcr.io/your-org/camelai-selfhost-app@sha256:...
SELFHOST_LOCAL_ARTIFACTS_IMAGE=ghcr.io/your-org/camelai-selfhost-local-artifacts@sha256:...
SELFHOST_PROJECT_BUILD_IMAGE=ghcr.io/your-org/camelai-selfhost-project-build@sha256:...
SELFHOST_ANALYSIS_IMAGE=ghcr.io/your-org/camelai-selfhost-analysis@sha256:...
SELFHOST_DB_QUERY_IMAGE=ghcr.io/your-org/camelai-selfhost-db-query@sha256:...
SELFHOST_CONTAINER_EGRESS_IMAGE=ghcr.io/your-org/camelai-selfhost-container-egress@sha256:...
SELFHOST_CADDY_IMAGE=ghcr.io/your-org/camelai-selfhost-caddy@sha256:...
SELFHOST_POMERIUM_IMAGE=pomerium/pomerium@sha256:...
```

Pin all eight dependency references from the same release manifest. Seven are
camelAI images; Pomerium is the tested upstream image. The container-egress
wrapper is required for the known Docker 29 bridge-interception bug and is
covered by the attached-container functional smoke.

Release mode does not build application code on the VM and does not mount a
mutable repository checkout into the application container. This is the
recommended enterprise deployment mode.

For development or release validation from a checkout, set:

```dotenv
SELFHOST_DEPLOYMENT_MODE=source
```

The self-host scripts then add `docker-compose.selfhost.source.yml`, which
builds the application and sandbox images from the current checkout. Source
mode is slower, consumes substantially more disk, CPU, and memory, and should
not be used as a production update strategy.

Initialize and validate the installation with:

```bash
bun run selfhost:init
# Edit .env.selfhost with identity, TLS, DNS, and AI settings.
bun run selfhost:configure
bun run selfhost:doctor
bun run selfhost:up
```

`SELFHOST_AUTH_MODE=bundled-pomerium` is the default production path.
`selfhost:up` automatically adds the Caddy front door, the Pomerium overlay,
and, when HTTPS terminates on the VM, its loopback-JWKS overlay.
External Pomerium and Cloudflare Access remain supported for enterprises that
already operate an identity-aware proxy.

The application container has read-write access to the Docker socket so workerd
can manage sandbox containers. Anyone who can control that container should be
treated as having root-equivalent control of the VM.

On Linux the app service intentionally uses host networking. workerd's
`localDocker` engine assigns loopback addresses to the sandbox egress
sidecars, which are unreachable through a nested Compose bridge. The app still
listens on `SELFHOST_BIND_ADDRESS` (default `127.0.0.1`), so keep that loopback
default and put the deployment behind the documented reverse proxy.

## Per-user LLM usage limits

`selfhost:init` generates a distinct `ADMIN_API_KEY` in `.env.selfhost`. The
operator API accepts it as a bearer token; keep it on the host and never pass it
to project containers, sandbox code, or deployed apps. The CloudFormation and
Terraform single-node installers also run `selfhost:init`, so they generate and
retain the same separate secret in the installation's `0600` environment file.
Upgrades preserve that file. Backups intentionally exclude it along with the
other operator-owned secrets, so retain the environment file in your normal
secret backup system.

For an existing source-mode installation created before this key existed, run
`bun run selfhost:migrate-secrets` once. `selfhost:up` also performs that
idempotent migration automatically.

Run the following commands on the installation host. They read only the two
needed values with the self-host dotenv parser (without sourcing or exporting
the rest of the environment) and use the loopback app URL, which bypasses the
interactive Pomerium login protecting the public URL:

```bash
ADMIN_API_KEY="$(bun -e 'const {readSelfhostEnv}=await import("./scripts/selfhost-common.mjs"); process.stdout.write((await readSelfhostEnv(true)).ADMIN_API_KEY || "")')"
BASE_URL="$(bun -e 'const {readSelfhostEnv}=await import("./scripts/selfhost-common.mjs"); process.stdout.write((await readSelfhostEnv(true)).SELFHOST_INTERNAL_APP_URL || "http://127.0.0.1:3001")')"
curl -fsS -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  "${BASE_URL}/api/admin/orgs?limit=100"
curl -fsS -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  "${BASE_URL}/api/admin/users?limit=100"
```

Inspect one rolling report and its exact provider/model pricing discovery. The
report range is inclusive at `from` and exclusive at `to`:

```bash
NOW_MS=$(date +%s000)
FROM_MS=$((NOW_MS - 30 * 24 * 60 * 60 * 1000))
curl -fsS -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  "${BASE_URL}/api/admin/orgs/${ORG_ID}/usage/users?from=${FROM_MS}&to=${NOW_MS}"
curl -fsS -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  "${BASE_URL}/api/admin/orgs/${ORG_ID}/usage/pricing"
```

Custom model IDs must have exact pricing before a limited member can use them.
An all-zero override is valid for an operator-owned model that is genuinely
free. Pricing `PUT` is a full replacement, not an upsert: first `GET` the
current list, merge the change, and send the complete desired `prices` array.
The following is safe only when this is the complete desired list:

```bash
curl -fsS -X PUT -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"prices":[{"provider":"custom","model":"acme-code-70b","input_usd_per_million":0.8,"output_usd_per_million":2.4,"cache_creation_usd_per_million":1,"cache_read_usd_per_million":0.08}]}' \
  "${BASE_URL}/api/admin/orgs/${ORG_ID}/usage/pricing"
```

Set simultaneous rolling limits, or clear them with an empty list:

```bash
curl -fsS -X PUT -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  -H 'Content-Type: application/json' \
  --data '{"limits":[{"window_hours":24,"limit_usd":5,"label":"daily"},{"window_hours":720,"limit_usd":50,"label":"30-day"}]}' \
  "${BASE_URL}/api/admin/orgs/${ORG_ID}/usage/users/${USER_ID}/limits"

curl -fsS -X PUT -H "Authorization: Bearer ${ADMIN_API_KEY}" \
  -H 'Content-Type: application/json' --data '{"limits":[]}' \
  "${BASE_URL}/api/admin/orgs/${ORG_ID}/usage/users/${USER_ID}/limits"
```

Limits are rolling stop-new-pull soft caps. A pull already accepted can cross a
cap, and concurrent pulls can settle afterward; the next pull is denied. With
an active limit, an unknown requested model or any unpriced LLM row still in an
active window fails closed. Adding an override makes future pulls for that exact
provider/model eligible, but historical rows are never repriced: an existing
unpriced row continues to block until it ages out of every configured window or
the operator clears the affected user's policy. Main/child agents, context
compaction, and attributable virtual-AI calls count. Auxiliary title,
completion-summary, and chat-group icon generation is not covered in this
version.

When finished, remove the key from the shell:

```bash
unset ADMIN_API_KEY BASE_URL
```

Within a live chat-thread isolate, a failed accounting write is retained and
retried with the same idempotency key before another model pull. That pending
retry queue is currently isolate-local; eviction during an accounting outage is
the remaining recovery boundary.

## Capability contract

`GET /api/selfhost/health` is both the readiness endpoint and the
machine-readable self-host capability contract. The response contains a
versioned `capabilities` object:

```json
{
  "ok": true,
  "mode": "selfhost",
  "status": "ok",
  "checks": [],
  "capabilities": {
    "version": 3,
    "features": {
      "project_builds": {
        "state": "configured",
        "available": null,
        "configured": true,
        "implementation": "workerd-local-docker",
        "verification": {
          "status": "not_checked",
          "command": "bun run selfhost:container:smoke:project"
        }
      },
      "project_deploys": {
        "state": "configured",
        "available": null,
        "configured": true,
        "implementation": "workerd-local-docker",
        "verification": {
          "status": "not_checked",
          "command": "bun run selfhost:container:smoke:mount && bun run selfhost:container:smoke:project"
        }
      },
      "notebooks": {
        "state": "configured",
        "available": null,
        "configured": true,
        "implementation": "workerd-local-docker",
        "verification": {
          "status": "not_checked",
          "command": "bun run selfhost:container:smoke:analysis"
        }
      },
      "sql": {
        "state": "configured",
        "available": null,
        "configured": true,
        "implementation": "workerd-local-docker",
        "verification": {
          "status": "not_checked",
          "command": "bun run selfhost:container:smoke:db-query"
        }
      },
      "connections_binding": {
        "state": "configured",
        "available": true,
        "configured": true,
        "implementation": "ConnectionsService"
      },
      "outbound_email": {
        "state": "disabled",
        "available": false,
        "reason": "Outbound email is disabled in self-host mode. No SMTP transport is implemented."
      },
      "smtp": {
        "state": "disabled",
        "available": false,
        "reason": "SMTP is reserved as a future self-host transport and is not implemented."
      }
    }
  }
}
```

Self-hosted sandbox storage uses the Sandbox SDK's local R2 synchronization
mode. It does not require `/dev/fuse`, `SYS_ADMIN`, or an unconfined AppArmor
profile. `selfhost:doctor` runs a bidirectional mount smoke whenever the images
are already local; it must pass before treating app build/deploy as healthy.

Intentionally disabled capabilities do not make the service unhealthy. Failed
runtime checks still return HTTP 503 and `status: "fail"`. In particular,
`PROJECT_BUILD_SANDBOX`, `ANALYSIS_SANDBOX`, and `DB_QUERY_SANDBOX` are required
bindings. If one is missing, its dependent features report
`state: "unavailable"` instead of claiming local-Docker parity.
For a present binding, `configured` means the namespace and image were wired;
it does not claim Docker execution was tested by the lightweight HTTP probe.
Run the named deep-smoke command in `verification.command` for that evidence.

### Disable CONNECTIONS bindings for deployed apps

Deployed apps normally receive an `env.CONNECTIONS` service binding that can
list and invoke workspace connections (credentials stay platform-side; results
can still return connection-backed data into the app). For on-prem installs that
must keep that broker off:

```dotenv
CONNECTIONS_BINDING_ENABLED=false
```

When disabled:

- new deploys do not rewrite or inject a `CONNECTIONS` binding
- `ConnectionsService` (and deployed-app `ANALYSIS`/`WAREHOUSE` connection
  catalog methods) fail closed, covering already-published apps
- the health capability reports `connections_binding.state: "disabled"`
- the agent system prompt and relevant `read_skill` results tell the model not
  to build apps that call `env.CONNECTIONS` (chat/`js_exec` connection guidance
  stays)
- chat-agent tools, `js_exec`, and the Connections settings UI remain available

Redeploy apps after flipping the flag so stored self-host worker records drop
the binding. Runtime fail-closed still protects apps that were not redeployed.

## TLS front door

Caddy is the ingress service for every supported Compose installation.
In automatic and provided modes it is the public TLS front door; in external
mode it is a private origin behind the enterprise TLS terminator. Pomerium and
the camelAI application remain on loopback. The default mode automatically
obtains and renews certificates with ACME DNS validation, which is required
because deployed applications use a wildcard hostname.

Choose exactly one mode in `.env.selfhost`:

### Automatic certificates (recommended)

For a DNS zone hosted by Cloudflare:

```dotenv
SELFHOST_TLS_MODE=automatic
SELFHOST_TLS_DNS_PROVIDER=cloudflare
SELFHOST_TLS_ACME_EMAIL=platform-ops@example.com
SELFHOST_TLS_CLOUDFLARE_API_TOKEN=...
```

Create a narrowly scoped Cloudflare API token with Zone Read and DNS Edit on
only the zone containing the camelAI, Pomerium authenticate, and app wildcard
hostnames. `selfhost:configure` copies it into a protected, read-only secret
mount for Caddy. It is not passed to the container as an environment variable.

For Route 53:

```dotenv
SELFHOST_TLS_MODE=automatic
SELFHOST_TLS_DNS_PROVIDER=route53
SELFHOST_TLS_ACME_EMAIL=platform-ops@example.com
SELFHOST_TLS_ROUTE53_HOSTED_ZONE_ID=Z0123456789EXAMPLE
SELFHOST_TLS_AWS_REGION=us-east-1
```

On EC2, prefer an instance role and leave the access-key fields blank. The AWS
templates create a role policy restricted to TXT ACME challenge records in the
selected hosted zone. A non-AWS VM may set
`SELFHOST_TLS_AWS_ACCESS_KEY_ID`, `SELFHOST_TLS_AWS_SECRET_ACCESS_KEY`, and an
optional session token; the generator writes them to a protected credentials
file.

### Existing enterprise TLS terminator

If an ingress controller, load balancer, or enterprise reverse proxy already
owns certificates:

```dotenv
SELFHOST_TLS_MODE=external
SELFHOST_TLS_EXTERNAL_BIND_ADDRESS=127.0.0.1
SELFHOST_TLS_EXTERNAL_PORT=8080
```

Point the trusted proxy at that HTTP origin and preserve the original `Host`
header. Keep the origin on loopback when the proxy is on the VM. If it must be
reachable over the network, set the bind address to `0.0.0.0` and restrict the
VM firewall/security group to the proxy addresses. Never expose this plaintext
origin directly to users. External Cloudflare Access or Pomerium authentication
must use this TLS mode because those proxies own the public TLS boundary.

### Operator-provided certificate

Use this fallback when automated DNS credentials are not permitted:

```dotenv
SELFHOST_TLS_MODE=provided
SELFHOST_TLS_CERTIFICATE_FILE=/secure/path/tls.crt
SELFHOST_TLS_PRIVATE_KEY_FILE=/secure/path/tls.key
```

The unencrypted PEM key and certificate chain must cover the main hostname,
Pomerium authenticate hostname, every deployed-app wildcard, and a separate
iframe wildcard when configured. Files installed as
`.selfhost/tls/tls.crt` and `.selfhost/tls/tls.key` are also detected. Existing
deployments with direct Pomerium TLS are migrated automatically from
`.selfhost/pomerium/tls.crt` and `.selfhost/pomerium/tls.key`.

After changing any TLS setting, run:

```bash
bun run selfhost:configure
bun run selfhost:doctor
bun run selfhost:up
```

## Authentication and email-dependent flows

Self-host mode has no outbound email transport. Setting
`EMAIL_FROM_ADDRESS` or `WORKSPACE_EMAIL_DOMAIN` does not enable delivery, and
there is no supported SMTP configuration today.

The recommended Compose deployment includes Pomerium Core in all-in-one mode:

```dotenv
SELFHOST_AUTH_MODE=bundled-pomerium
SELFHOST_MAIN_HOSTNAME=camel.example.com
POMERIUM_AUTHENTICATE_URL=https://authenticate.example.com
POMERIUM_AUTHENTICATE_HOSTNAME=authenticate.example.com
POMERIUM_IDP_PROVIDER=oidc
POMERIUM_IDP_PROVIDER_URL=https://idp.example.com/application/o/camelai/
POMERIUM_IDP_CLIENT_ID=camelai
POMERIUM_IDP_CLIENT_SECRET=...
POMERIUM_DEFAULT_ORG_NAME=Your Organization
POMERIUM_ISSUER=camel.example.com
POMERIUM_AUDIENCE=camel.example.com
```

Register `https://authenticate.example.com/oauth2/callback` with the OIDC
provider. The authenticate hostname must be distinct from the camelAI hostname.
`selfhost:configure` writes Pomerium's Docker-mounted secret files with
restrictive permissions so the client, cookie, and shared secrets are not
visible in `docker inspect`. Pomerium binds only to
`127.0.0.1:5444` behind Caddy and retains only `DAC_OVERRIDE`, which lets it
read operator-owned `0600` mounts on Linux without weakening their host
permissions. Never expose that plaintext listener.

Set `SELFHOST_AUTH_MODE=external-pomerium` or `cloudflare-access` to use an
existing enterprise proxy instead. Password signup is rejected before creating
a user because its verification email cannot be delivered.
Verification-email resend and the email-backed help
form return explicit unavailable errors. Organization invitations are still
created so an administrator can copy and deliver the invitation URL through an
approved channel; the API and UI report that the email itself was not sent.
The coding agent's `send_email` tool is omitted from discovery and rejected at
the server boundary.

### Deployed-app previews and authentication

The chat preview embeds a deployed-app hostname inside the camelAI page, so it
is cross-origin even when `LOCAL_APP_IFRAME_DOMAIN` and
`LOCAL_APP_VANITY_DOMAIN` are the same. Self-host deployments support the same
per-app public/private setting as hosted camelAI. In bundled-Pomerium mode,
deployed-app wildcard routes allow unauthenticated requests to reach the
dispatcher, which serves public apps directly and redirects private apps
through camelAI authentication. `selfhost:configure` also adds this response
policy to both deployed-app wildcard routes:

```http
Content-Security-Policy: frame-ancestors 'self' <SELFHOST_PUBLIC_BASE_URL origin>
```

This intentionally supersedes Pomerium's default
`X-Frame-Options: SAMEORIGIN` for browsers that support CSP `frame-ancestors`.
It preserves same-origin app framing and permits only the configured camelAI
origin as an additional parent. The live `selfhost:doctor` check sends a
synthetic app-host request through Pomerium and verifies that policy whenever
the stack is running. Operators using external Pomerium, Cloudflare Access, or
another ingress must allow both `*.LOCAL_APP_VANITY_DOMAIN` and
`*.LOCAL_APP_IFRAME_DOMAIN` to reach the dispatcher if public apps are required,
and configure the equivalent response policy there. A deployment-wide ingress
authentication rule on either wildcard intentionally overrides camelAI's
per-app public setting.

The preview sandbox lets user-initiated popups escape into a normal top-level
window and permits top-level navigation only after a user gesture. This supports
popup-based OAuth and explicit "continue in this tab" flows without allowing a
deployed app to redirect camelAI automatically. It does not override an identity
provider that refuses to render its login page in an iframe. Browser
third-party-cookie restrictions can also affect embedded sessions. Use **Open
in new tab** when a provider requires an ordinary full-page redirect.

Do not add a fake local SMTP service, silently discard messages, or accept
unencrypted SMTP credentials merely to make these flows appear successful.

### Future internal SMTP transport

A future implementation should add a real, operator-selected transport rather
than reusing the Cloudflare Email Sending binding. A proposed configuration
surface is:

```dotenv
SELFHOST_EMAIL_TRANSPORT=smtp
SELFHOST_SMTP_HOST=smtp.corp.example
SELFHOST_SMTP_PORT=465
SELFHOST_SMTP_TLS=implicit
SELFHOST_SMTP_USERNAME=...
SELFHOST_SMTP_PASSWORD=...
SELFHOST_SMTP_FROM=camelai@corp.example
```

These variables are design placeholders and have no effect today. Before they
become supported, the implementation must provide required TLS with certificate
verification, secret handling that avoids logs and generated config files,
connection and delivery timeouts, recipient/header validation, bounded
attachments, auditable delivery results, and tests for verification,
invitation, support, and agent-originated messages. The health contract should
only mark `smtp` and `outbound_email` available after a live transport check
succeeds.

## Agent customization (skills and prompt)

Enterprise self-host installs can add skills and append deployment instructions
without rebuilding the application image. On container start,
`selfhost-workerd-config` loads `.selfhost/agent/` (mounted read-only into the
app container) and injects it into the Worker.

```text
.selfhost/agent/
  README.md                 # created by selfhost:init / configure
  prompt.append.md          # added after the stock camelAI system prompt
  prompt.prepend.md         # optional policy text before the stock prompt
  skills/
    acme-runbooks/
      SKILL.md              # same YAML frontmatter format as sandbox/skills/
      references/foo.md     # optional extras; read via read_skill({ skill, file })
```

Example skill:

```markdown
---
name: acme-runbooks
description: Follow ACME internal deploy checklists. Use when shipping internal tools.
---

# ACME runbooks

1. Call `read_skill({ skill: "developing-software" })` before creating projects.
2. Prefer the `crud` template for internal tools.
3. Never invent production URLs; use `deploy_project` results.
```

Example prompt append:

```markdown
Always prefer internal package mirrors. Do not suggest third-party SaaS unless
the user asks. When creating apps for Finance, include an audit log table.
```

Rules:

- Customization is **additive**. Full system-prompt replacement is not
  supported; stock safety, tool, and evidence rules always remain.
- Custom skills appear in `## Available Skills` and are served by `read_skill`.
- A custom skill with the same name as a bundled skill **overrides** it.
- After editing the pack, restart the app (`bun run selfhost:up` or recreate the
  `app` container) so workerd-config regenerates bindings.
- Escape hatches: `SELFHOST_AGENT_PROMPT_APPEND`, `SELFHOST_AGENT_PROMPT_PREPEND`,
  `SELFHOST_AGENT_SKILLS_JSON`, `SELFHOST_AGENT_SKILLS_DIR`, and
  `SELFHOST_AGENT_HOST_DIR` (Compose host mount path).

`GET /api/selfhost/health` reports an `agent-pack` check summarizing what loaded.

## Operational validation

After startup, verify:

```bash
curl --fail --silent http://127.0.0.1:3001/api/selfhost/health
bun run selfhost:doctor
```

Upgrade to the latest published self-host release with:

```bash
bun run selfhost:upgrade
```

The upgrader resolves GitHub's latest release once, then pins the checkout and
all eight dependency images to the immutable revision and digests in that
release's `selfhost-release.json`. `--latest` is also accepted explicitly.

To select a particular version instead, download the durable
`selfhost-release.json` asset from the matching
[GitHub Release](https://github.com/qaml-ai/camelAI/releases). The manifest is
also retained as a workflow artifact for release engineering, but operators
should use the release asset:

```bash
bun run selfhost:upgrade -- \
  --release selfhost-vX.Y.Z \
  --manifest /secure/path/selfhost-release.json
```

For every installation whose current upgrader predates the target-code handoff,
download the `selfhost-upgrade-bootstrap.mjs` asset shipped beside the manifest
and use it once. This includes older upgraders that already recognize
`--release` but do not re-execute the target release:

```bash
node /secure/path/selfhost-upgrade-bootstrap.mjs \
  --repo "$PWD" \
  --release selfhost-vX.Y.Z \
  --manifest /secure/path/selfhost-release.json
```

The helper verifies the manifest against the selected checkout, backs up durable
volumes, and snapshots the previous checkout and `.env.selfhost`. Failures
before the new runtime starts restore that runtime configuration automatically.
Once startup begins, D1 migrations may have run, so failures leave the new
checkout and image configuration in place. Restore the matching pre-upgrade
volume backup before using the printed explicit rollback command. Before
declaring success the helper waits for Compose health, runs the doctor, and
executes the project, analysis, and database-query deep smokes.
Normal upgrades re-exec the target checkout's upgrader before applying images,
so the target release owns its manifest and migration rules.

To back up and reapply the current checkout and its already configured image
references without selecting a newer release, run:

```bash
bun run selfhost:refresh
```

The detailed Compose variables, reverse-proxy examples, backups, and provider
configuration remain in [`infra/selfhost/README.md`](infra/selfhost/README.md).
