# Infrastructure

Active infrastructure lives in focused subdirectories:

- `db-egress-relay/` — the static-IP database egress relay.
- `selfhost/` — self-host CloudFormation and Terraform templates.
- `codex-egress-proxy/` — the OpenAI subscription transport relay.

The retired Azure project-runtime and sandbox-host Terraform module has been
removed. Do not add project VM infrastructure back to this directory.

The hosted agent runtime (agents.camelai.dev) and its infrastructure live in
the `qaml-ai/agent-runtime` repository (`infra/`).
