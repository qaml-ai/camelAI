# Infrastructure

Active infrastructure lives in focused subdirectories:

- `db-egress-relay/` — the static-IP database egress relay.
- `selfhost/` — self-host CloudFormation and Terraform templates.
- `codex-egress-proxy/` — the OpenAI subscription transport relay.
- `agent-runtime/` — the hosted agent runtime (agents.camelai.dev) for teammates' agents.

The retired Azure project-runtime and sandbox-host Terraform module has been
removed. Do not add project VM infrastructure back to this directory.
