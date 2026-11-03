# Export one hosted organization

This operator workflow produces a standalone backup in JSON, JSONL, ordinary files
and Git bundles. It does not create a self-host restore image or upload anything.
The worker checks ownership for every requested object. The script handles walking,
retries, local files and packaging. Never use a camelRun tenant/account export for
this job: hosted organizations share a runtime tenant.

## Prerequisites

- Deploy the organization-export routes through the usual reviewed release process.
- Use Bun, Git and tar on a machine with enough private disk space for the exported
  data, temporary Git mirrors and the compressed archive. No AWS credentials are
  needed to generate the backup.
- Obtain the target environment's `ADMIN_API_KEY` through the team's secret store.
  Supply it as an environment variable. Do not put it in shell command arguments,
  logs, shared terminals or files inside the export directory.
- Confirm the exact organization ID and environment. The script reads
  `WORKER_BASE_URL` from `wrangler.prod.jsonc` or `wrangler.staging.jsonc`.
- Ask the customer to pause changes while exporting. Reads are not a transactional
  snapshot: metadata, messages and object bytes can change between requests.

## Run and resume

```sh
bun run org-export -- --env prod --org <orgId> --out <private-directory> --concurrency 4
```

The output directory is `camelai-export-<orgId>-<YYYYMMDD>` under `--out`, using a
UTC date. Unsafe names are encoded; `path-mapping.json` records each change.
The script creates `.tar.gz` and `.tar.gz.sha256` files beside that directory.
A `.org-export-state.json` checkpoint records completed items. Re-run the same
command to skip completed items and retry failed ones, even across midnight.
Already finished metadata and file contents remain from the original run. Use a
fresh `--out` for a new backup. Use only one process per output directory.

429, 5xx and network failures retry up to five attempts with exponential backoff,
capped at 30 seconds. The concurrency limit is 1–16. A failed item is recorded in
`manifest.json.warnings`; other items continue. An incomplete archive is still
packaged for inspection and the command exits non-zero. Do not deliver an archive
until its warnings are resolved or its incompleteness is explicitly accepted.

## Contents and verification

- `org/`: organization settings, members with names/emails, invitations without
  identifiers that can redeem invitations, archived and active workspaces, access
  rows, integrations, definitions, apps and deploy versions, SSO settings, stored
  model-picker settings and the aggregate spend summary.
- `org/automations.json`: index of the per-workspace automation record sets and counts.
- `workspaces/<name>-<id>/`: filesystem contents and metadata; per-workspace
  scheduled prompts, deterministic automation definitions and source versions;
  project working trees and Git bundles; per-app KV JSONL with base64 values.
- Thread `.json` files describe placement. Thread `.jsonl` files contain raw Pi
  messages, oldest first. `threads/<id>/files/<volumeId>/` holds agent volume files.
  `volumes.json` records the mounts/subpaths. Migration copies such as
  `uploads/camel-migration/original-transcript.jsonl` remain in those files.
- `r2/R2_BUCKET/`: scoped R2 objects. `R2_BUCKET` is the logical binding; both
  hosted configs currently bind it to `chiridion-sandbox`. This includes workspace
  uploads/outputs, spilled filesystem bytes, deploy artifacts, previews and app R2
  data. Some files deliberately appear both here and in the friendly file tree.
- `filesystem.json` preserves directories, timestamps and symlink targets. Symlinks
  are represented as metadata, never created as executable filesystem links.
- `manifest.json`: format version, identity, start/finish times, completion status,
  counts, exclusions and warnings. Counts use record-set filenames plus `messages`,
  `files`, `r2_objects`, `git_bundles` and `kv_entries` where applicable.
- `SHA256SUMS`: hashes of every other file, including the checkpoint and manifest.

Check that the organization ID/name is correct, `complete` is true and `warnings`
is empty. Compare record counts with the JSON arrays, message counts with JSONL
line counts, and app/project counts with the customer's expected inventory.
Verify the outer archive before extraction, then every extracted file:

```sh
cd <private-directory>
sha256sum -c camelai-export-<orgId>-<YYYYMMDD>.tar.gz.sha256
mkdir verification
# Extract only into an empty directory.
tar -xzf camelai-export-<orgId>-<YYYYMMDD>.tar.gz -C verification
cd verification/camelai-export-<orgId>-<YYYYMMDD>
sha256sum -c SHA256SUMS
```

On macOS use `shasum -a 256 -c` instead of `sha256sum -c`. Git bundles are verified
by the script before packaging. A customer can inspect one with
`git clone <project>.bundle <new-directory>`.

## Read API contract

All routes require `Authorization: Bearer <ADMIN_API_KEY>` and start with
`/api/admin/org-export/:orgId`. Ownership mismatches return 404. JSON pages use
`items` and an opaque `cursor`; send it back unchanged. `limit` defaults to 50 and
is capped at 100. Pages are ordered by stable stored row ID or file path; large
SQL/history pages stop near 2 MB, allowing one oversized stored message/row.
The project registry is currently one DO KV value, so its accessor must read that
existing registry value before selecting a bounded page. It does not create or
rewrite the registry.

| Route | Reads |
| --- | --- |
| `GET /manifest` | Allowlisted singleton settings and names of separately paged record sets |
| `GET /records/:set` | `members`, `invitations`, `workspaces`, `workspace_access`, `integrations`, `integration_definitions`, `apps`, `deploy_versions` |
| `GET /threads` | OrgDO thread metadata plus `thread_runtime` placement |
| `GET /threads/:threadId/history?before&limit` | camelRun history with a 2 MB byte bound, or existing ChatThreadDO `pi_core_messages` |
| `GET /threads/:threadId/agents/:agentId/volumes` | This agent's existing mounts |
| `GET /threads/:threadId/agents/:agentId/volumes/:volumeId/files?path&cursor&limit` | File metadata inside a verified mount/subpath |
| `GET /threads/:threadId/agents/:agentId/volumes/:volumeId/files/content?path` | One streamed volume file |
| `GET /workspaces/:workspaceId/projects` | Flat project registry, including clones |
| `GET /workspaces/:workspaceId/automations/:kind` | `prompts`, `automations` or `versions` in WorkspaceCronDO |
| `GET /workspaces/:workspaceId/fs?path&cursor&limit` | Workspace filesystem rows, including hidden files and symlinks |
| `GET /workspaces/:workspaceId/fs/content?path` | Workspace file bytes |
| `GET /workspaces/:workspaceId/projects/:projectId/fs[/content]` | Project working-tree rows or bytes, after checking the workspace registry |
| `POST /workspaces/:workspaceId/projects/:projectId/git-token` | A read token for an existing Artifacts repo; no repo is created |
| `GET /r2-prefixes?workspaceId&projectId` | Allowed prefixes derived on the server; `projectId` is optional |
| `GET /r2?workspaceId&projectId&bucket=R2_BUCKET&prefix&cursor&limit` | A bounded object listing under an allowed prefix |
| `GET /r2/object?workspaceId&projectId&bucket=R2_BUCKET&key` | One streamed object |
| `GET /workspaces/:workspaceId/apps/:scriptName/kv?cursor` | One virtual KV value per page, including its namespace/key |

History entries retain their raw message JSON. Each page is oldest first; pages
are fetched newest first using `next` as the next `before` (null ends the walk).
The script reverses page order, not message order. Runtime file cursors wrap the
runtime's `after` cursor. Volume membership is checked against the live agent
mount list on every request; mounting only a subpath never grants the full volume.

R2 requests require `workspaceId` and optionally `projectId` so authorization is
bounded without loading every workspace/project. Allowed prefixes are:

```text
<orgId>/<workspaceId>/
workspace-fs/<workspaceFsDoId>/
project-fs/<projectFsDoId>/default/
deploy-artifacts/<encodedOrgId>/<encodedWorkspaceId>/
app-previews/<orgId>/<workspaceId>/
user-data/<workspaceId>/
```

App KV uses `selfhost:user-kv/<workspaceId>/<scriptName>--<orgSlug>/`; the remaining
key includes the virtual namespace ID. No other KV or R2 scope is readable.

Artifacts returns its actual remote and a 300-second token with scope `read`.
Git authenticates using `Authorization: Bearer <token>` through Git's environment
configuration (`GIT_CONFIG_COUNT`, URL-scoped `http.<origin>/.extraHeader`), not a
credential in the URL, command line or `.git/config`. The script mirror-clones,
creates `git bundle create --all`, verifies it and removes the mirror. A project
without a repository is listed as excluded, with its working tree still exported.
Git tokens are never persisted. Normal DO schema initialization and migration
alarm recovery are deferred until ordinary access; export reads do not trigger
them, even on a cold or uninitialized object.

## Exclusions

Platform credentials, provider keys, OpenAI subscription tokens, OAuth tokens,
password hashes, sessions and SSO client secrets are not exported. Integration
configurations are recursively redacted for secret-looking keys. User-authored
files and raw transcripts are preserved, so the resulting backup is still
sensitive customer data.

Deployed-app Durable Object storage is inaccessible from outside an app and is
excluded. External databases/services are not queried. Deleted/expired data and
transcript messages already removed by compaction cannot be recovered. Runtime
volume snapshots and tenant-wide runtime settings/billing are excluded because
that tenant is shared. Operational/audit logs, per-request usage, automation run
logs and transient events are outside this archive; spend totals and automation
source versions are included. This backup is not a cross-store point-in-time
snapshot and is not a self-host restoration package.

## Deliver to the customer's S3 bucket

Have the customer provide the bucket, prefix, account ID and (if required) KMS key
ARN. A KMS key must be one they manage: another account cannot encrypt with the
AWS-managed `aws/s3` key, so an upload to a bucket defaulting to it fails.

Our side is the customer-export role in camelRun's Terraform
(`infra/terraform/customer-export.tf` in camelai-run). Add the customer's
destination to `customer_export_destinations` there, apply, and read the ARN from
`tofu output customer_export_role_arn`. The role can only put objects under that
prefix (and use that KMS key). Apply before sending the ARN: S3 refuses a bucket
policy naming a principal that does not exist yet.

The customer adds this statement to their bucket policy, with the prefix ending in
`/`:

```json
{
  "Sid": "AllowCamelAIOrganizationExport",
  "Effect": "Allow",
  "Principal": { "AWS": "<customer_export_role_arn>" },
  "Action": ["s3:PutObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
  "Resource": "arn:aws:s3:::<bucket>/<prefix>*"
}
```

For SSE-KMS they also add this to the key's policy (in a key policy, `"Resource":
"*"` means the key the policy is attached to):

```json
{
  "Sid": "AllowCamelAIExportEncryption",
  "Effect": "Allow",
  "Principal": { "AWS": "<customer_export_role_arn>" },
  "Action": ["kms:GenerateDataKey", "kms:Decrypt"],
  "Resource": "*"
}
```

Upload with a profile that assumes the role, after verifying the archive locally:

```sh
aws s3 cp <tar.gz> s3://<bucket>/<prefix>/ \
  --profile <export-role-profile> \
  --expected-bucket-owner <account>
aws s3 cp <tar.gz.sha256> s3://<bucket>/<prefix>/ \
  --profile <export-role-profile> \
  --expected-bucket-owner <account>
```

When the bucket requires SSE-KMS, add both flags to each upload:

```sh
--sse aws:kms --sse-kms-key-id <arn>
```

Ask the customer to download and verify the companion checksum before accepting
the delivery. The export script never calls S3 or selects an upload destination.
