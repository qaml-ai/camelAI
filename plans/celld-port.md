# camelAI on celld

Status: active staff-only pilot. This is not a production cutover plan yet.

## Proven on 2026-08-23

- Forked celld v0.3.0 at [`qaml-ai/celld`](https://github.com/qaml-ai/celld).
- Added a generic fix for side-effect-only builtin imports on
  `camelai/scan-side-effect-builtins` (`1d27d2d`).
- Added the v0.3.0-only workflow export loading shim on
  `camelai/pilot-v0.3.0` (`6536e1f`). Remove it when rebasing onto the
  upstream v0.3.1 workflow implementation.
- Generated a celld-only camelAI manifest from the production build. celld
  v0.3.0 bundles it as one 29 MB Worker with 415 static assets, 13 SQLite
  Durable Object classes, D1, and a self service binding.
- Uploaded main version `e10dde736f9177a0` and KV service version
  `9c8655bbae108f2b` to the private AWS pilot fleet bucket.
- Started the real camelAI bundle on the forked runtime. The celld health
  endpoint and camelAI version endpoint returned 200, `/login` completed SSR,
  and `/` performed the expected authentication redirect.
- Wrote D1 state, stopped the node, started a node with an empty local watch
  directory, and read the same state back from S3.
- `celld diagnose` passed S3 conditional create, conditional update,
  stale-write rejection, fleet enumeration, and a signed direct peer probe.
- Added a DO-backed KV compatibility service for APP_KV, EMAIL_TO_USER, and
  SESSIONS. Its real celld smoke passed text, JSON, metadata, binary structured
  clone, cursor pagination, delete, and namespace isolation.

The application health endpoint intentionally remains 503. APP_KV, SESSIONS,
and APP_DB are now green; it still reports the missing R2_BUCKET, ARTIFACTS,
three compute sandboxes, and AI provider instead of hiding them.

## Architecture boundary

celld owns the stateful Worker control plane:

- main React Router Worker and static assets
- Durable Objects, alarms, scalar RPC, and chat HTTP/SSE
- D1
- cron
- Worker Loader after the Code Mode capability adapter lands

Companion AWS services own capabilities that are not Durable Object shapes:

- S3-backed R2 compatibility for workspace and upload blobs
- a narrow container runner for project build, analysis, and database query
- local/EFS-backed Git artifacts during the pilot
- Bedrock or a configured external model provider
- browser automation when it becomes necessary
- ingress, TLS, authentication, email, and observability

The dynamic user-app dispatcher remains a separate control plane. The first
slice supports authenticated chat and coding; it does not mix untrusted user
apps into the trusted main celld process.

## Fork policy

Keep the fork thin and every runtime patch independently testable.

Upstream-shaped patches:

1. side-effect builtin import registration
2. active streaming-response lifecycle / celld issue 159
3. Worker Loader capabilities across isolates
4. outbound fetch denial for IMDS and link-local control endpoints

camelAI-specific or fork-only work:

1. R2-on-S3 binding backed by a separate application-data bucket
2. external compute service binding
3. dynamic application scheduling and dispatch

Do not change celld ownership, fencing, or replication without coordinating
with upstream. Rebase onto v0.3.1 as soon as its workflow code is public.

## Delivery slices

### P0: authenticated durable chat

- [x] Produce and test a celld-only deployment manifest.
- [x] Load the actual camelAI production bundle on celld.
- [x] Prove an S3-backed D1 restore from an empty local cache.
- [x] Add a DO-backed compatibility service for APP_KV and SESSIONS, including
      TTL-aware reads, cursor pagination, and namespace isolation.
- [ ] Add concurrent-session and node-restore integration coverage for the KV
      service.
- [ ] Implement S3-backed R2 in the celld fork, with streaming/range reads,
      metadata, conditionals, list, and multipart upload.
- [ ] Route WorkspaceFilesystemDO streaming operations through DO fetch until
      celld supports cross-isolate RPC streams.
- [ ] Run APP_DB migrations through `celld d1 migrations apply`.
- [ ] Configure staff authentication, local artifacts, and Bedrock.
- [ ] Pass login, workspace creation, thread creation, SSE chat, and workspace
      file read/write on the pilot.

### P1: coding

- [ ] Add a signed Code Mode capability gateway. A child gets only a short
      lived run token and gateway URL, never provider credentials.
- [ ] Scope tokens to org, workspace, thread, tool use, allowed operations,
      expiry, and replay policy.
- [ ] Pass `js_exec` tool listing and workspace edits.
- [ ] Fix and test active SSE response lifecycle before enabling eviction or
      pressure handoff.

### P2: build and deploy

- [ ] Add a host-local authenticated container runner implementing the
      existing ProjectBuildSandboxLike boundary.
- [ ] Add analysis and database-query adapters without giving celld the Docker
      socket.
- [ ] Support static and fetch-only user apps in an isolated dispatcher.
- [ ] Add virtual bindings through the same signed capability gateway.

### P3: AWS fleet

- [ ] Publish a digest-pinned multi-architecture image from the pilot fork.
- [ ] Start with one staff-only EC2 node and `CELLD_DURABILITY=bucket`.
- [ ] Add two more nodes across AZs only after the single-node binding suite
      passes.
- [ ] Put public traffic behind authenticated ingress; never expose the
      internal/operator listener.
- [ ] Run owner kill, whole local-cache loss, S3 outage, peer loss, rolling
      restart, SSE reconnect, and duplicate-side-effect tests.
- [ ] Soak under agent eval traffic for several days before importing user
      data or changing production DNS.

## Security gates

- celld v0.3.0 calls itself alpha and is not a hostile multi-tenant boundary.
  The pilot is staff-only.
- Worker outbound fetch must be unable to reach EC2 IMDS or link-local
  endpoints before the instance role is attached to public or user-authored
  code.
- Fleet state and application blobs use different buckets and IAM policies.
  The fleet bucket contains authentication material and is administrator
  access.
- Instance metadata requires IMDSv2. Workers never receive AWS credentials.
- The internal celld listener is private and security-group restricted.
- Keep `CELLD_OUTPUT_GATE=1`, `CELLD_STORAGE_PROBE=1`, and
  `CELLD_DURABILITY=bucket` during the pilot. Leave idle eviction disabled
  until streaming response issue 159 is fixed.

## Commands

```bash
bun run test:celld:config

# Uses a dummy bucket and writes nothing.
CELLD_BIN=/path/to/patched/celld \
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" \
bun run celld:dry-run

# Writes a deployment; nodes must be restarted to load it.
CELLD_BIN=/path/to/patched/celld \
CELLD_ESBUILD="$PWD/node_modules/.bin/esbuild" \
CELLD_BUCKET=s3://your-private-fleet-bucket \
CELLD_REGION=us-west-2 \
bun run celld:deploy
```

The existing Cloudflare production deployment and the existing workerd
self-host path stay untouched until the complete failover and security gates
pass. They are the rollback targets.
