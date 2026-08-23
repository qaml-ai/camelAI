# Infrastructure

Active infrastructure lives in focused subdirectories:

- `db-egress-relay/` — the static-IP database egress relay.
- `selfhost/` — self-host CloudFormation and Terraform templates.
- `celld/` — staff-only AWS celld port and pilot notes.
- `codex-egress-proxy/` — the OpenAI subscription transport relay.

The retired Azure project-runtime and sandbox-host Terraform module has been
removed. Do not add project VM infrastructure back to this directory.
