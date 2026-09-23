# Hosted agent runtime

Runs `services/agent-runtime` for teammates' own agents at
`https://agents.camelai.dev`. This is the single-host deployment. It will be
replaced by the distributed runtime (S3 storage, leases, many workers) described
in `plans/agent-runtime-service.md`.

Resources (AWS account `904534089871`, `us-west-2`), all named `camelai-agent-runtime`:

- EC2 `t4g.medium` (Amazon Linux 2023, arm64) with termination protection and a
  40 GB encrypted gp3 root volume that survives termination
- Elastic IP, and a DNS-only Cloudflare A record `agents.camelai.dev`
- Security group: TCP/443 only, no SSH
- IAM role/profile: SSM, read access to its two secrets, and pull access to its ECR repository
- ECR repository `camelai-agent-runtime` (immutable tags, last 30 images kept)
- Secrets Manager:
  - `camelai/agent-runtime/session-secret`: derives client session tokens.
    Rotating it invalidates every issued session token.
  - `camelai/agent-runtime/tenants`: operator token hashes and provider API keys.
  - `camelai/agent-runtime/operator-token/<tenant>`: each tenant's operator
    token, for handing to that person.
  - `camelai/agent-runtime/secrets-key`: the AES-256 key that encrypts
    provider keys tenants set themselves. Losing it makes those keys unreadable.
  - `camelai/agent-runtime/github-oauth`: the console's GitHub OAuth app
    (optional; see below).
- EBS snapshots: hourly (48 kept) and daily at 09:00 UTC (7 kept), via Data Lifecycle Manager
- CloudWatch alarms: the instance recovers onto new hardware when the AWS system
  check fails, and reboots when its instance check fails
- A Route 53 HTTPS health check on `/healthz`, alarming to the SNS topic
  `camelai-agent-runtime-alerts` in us-east-1. Subscribe with
  `aws sns subscribe --region us-east-1 --topic-arn arn:aws:sns:us-east-1:904534089871:camelai-agent-runtime-alerts --protocol email --notification-endpoint <email>`

On the instance, Caddy (`agent-runtime-caddy.service`) terminates TLS and
proxies to the runtime container (`agent-runtime.service`). Agent state lives in
`/opt/agent-runtime/data`. Before every start and reload,
`refresh-config.sh` pulls the secrets into `runtime.env` and `tenants.json`.

## First-time setup

```sh
infra/agent-runtime/provision.sh          # idempotent; needs CLOUDFLARE_API_TOKEN for DNS
infra/agent-runtime/tenant.sh add miguel
infra/agent-runtime/tenant.sh set-key miguel anthropic   # paste the key, then Ctrl-D
infra/agent-runtime/deploy.sh
AGENT_URL=https://agents.camelai.dev \
AGENT_RUNTIME_TOKEN=$(aws secretsmanager get-secret-value --region us-west-2 \
  --secret-id camelai/agent-runtime/operator-token/miguel --query SecretString --output text) \
  node --experimental-strip-types services/agent-runtime/deploy/smoke.ts
```

## Console and self-service

`https://agents.camelai.dev/console` is where people manage their own tenant:
- add or replace provider keys, which are checked with the provider and stored encrypted;
- browse models;
- mint and revoke API tokens;
- inspect and prompt agents;
- see usage.

Everything in the console is also available as the REST API under `/v1`, for
scripts that authenticate with an API token.

Sign-in uses GitHub and is limited to active members of the `qaml-ai` org. A
member's first sign-in creates a tenant named after their GitHub login. An
admin tenant is linked to a GitHub login by adding `"github": "<login>"` to its
entry in the tenants secret. Token sign-in also works: paste an operator token
or an API token.

To enable GitHub sign-in, an org owner creates an OAuth app at
https://github.com/organizations/qaml-ai/settings/applications/new with:
- homepage `https://agents.camelai.dev`
- callback URL `https://agents.camelai.dev/console/auth/callback`

Then run `infra/agent-runtime/github-oauth.sh <client-id>` and paste the client
secret when prompted.

## Tenants (admin)

Each person gets a tenant with its own operator token and provider keys. Their
agents are invisible to other tenants, and their model usage bills to their
own key. The script never prints secrets. Keys are read from stdin, and tokens
go to Secrets Manager.

```sh
infra/agent-runtime/tenant.sh list
infra/agent-runtime/tenant.sh add <tenant>
infra/agent-runtime/tenant.sh set-key <tenant> anthropic      # key on stdin
infra/agent-runtime/tenant.sh rotate-token <tenant>
infra/agent-runtime/tenant.sh remove <tenant>
```

Changes take effect through `systemctl reload`, which sends SIGHUP to the
runtime. No restart is needed, and running agents are unaffected. Share the
operator token through a password manager: it can create, read and drive every
agent in that tenant.

## Deploying changes

`deploy.sh` builds an arm64 image from the current checkout, tagged with the
git commit (plus `-dirty-<time>` for uncommitted runtime changes). It pushes
the image to ECR, installs `instance/` onto the host via SSM, restarts the
runtime, and checks `https://agents.camelai.dev/healthz`.

A restart interrupts running turns. Their requests complete with an
`uncertain` error, and each agent closes the interrupted turn with "outcome
unknown" tool results the next time it runs. Nothing is replayed.

Runtime settings that aren't secret are in `instance/runtime.defaults.env`: the
default model, process cap, idle timeout, and tool timeout. Change them there
and redeploy.

## SDKs

- TypeScript: `services/agent-runtime/sdk`, published as `@qaml-ai/agent-runtime`
  to GitHub Packages. Bump `version` in `sdk/package.json`, then run
  `npm publish` from that directory. Installation instructions are in
  `sdk/README.md`.
- Python: `services/agent-runtime/clients/python` (`pip install <path or git URL>`).

## Operations

Use Session Manager; SSH is not open.

```sh
aws ssm start-session --region us-west-2 --target <instance-id>
sudo systemctl status agent-runtime agent-runtime-caddy
sudo docker logs --tail 100 agent-runtime
sudo ls /opt/agent-runtime/data/client-sessions
curl https://agents.camelai.dev/healthz
```

## Limits of this deployment

- Every agent lives on one host and its EBS volume. Losing the volume means
  restoring from the last hourly snapshot, and up to an hour of work is lost.
- The runtime still runs one process per active agent. Up to 16 run at once,
  and at most 8 per tenant. Idle agents stop after 5 minutes. When a tenant or
  the host is at its limit, the least recently used idle agent is stopped; if
  none is idle, the request is refused (429 for a tenant's limit, 503 for the
  host's).
- Sandboxed code runs on the same host as agent state. That's acceptable for
  trusted teammates, but not for untrusted tenants until the executor tier
  (phase 5) exists.
