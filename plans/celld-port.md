# camelAI on celld

Status: active staff-only pilot. This is not a production cutover plan yet.

## Proven through 2026-08-29

- Rebased the runtime fork onto upstream celld v0.4.0 at
  [`qaml-ai/celld:camelai/pilot-v0.4.0`](https://github.com/qaml-ai/celld/tree/camelai/pilot-v0.4.0)
  (`fcff8f7`). Upstream v0.4 supplies native Workflows and the streaming
  lifecycle fix, so the old workflow shim and response-stream patch retired.
- Ported only three runtime patches: side-effect-only builtin import
  registration (`5d3122b`), scoped `ctx.exports` capabilities in Worker Loader
  env (`54011d2`), and link-local outbound fetch denial (`58a6e0c`).
- The fork's five focused unit tests pass on v0.4.0; the generated camelAI
  deployment also passes the v0.4 config check and dry-run.
- Generated a celld-only camelAI manifest from the production build. celld
  v0.4.0 bundles it as one 29 MB Worker with 415 static assets, 13 SQLite
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
- Added provider-neutral application facades for object storage, artifacts,
  compute, Code Mode, AI, email, browser/images, queues, pipelines, and
  observability. The celld deployment binds them to one allowlisted internal
  proxy, while Cloudflare keeps its native fast paths.

The application health endpoint intentionally remains 503. APP_KV, SESSIONS,
and APP_DB are now green; it still reports the missing R2_BUCKET, ARTIFACTS,
three compute sandboxes, and AI provider instead of hiding them.

## Architecture boundary

celld owns the stateful Worker control plane:

- main React Router Worker and static assets
- Durable Objects, alarms, scalar RPC, and chat HTTP/SSE
- D1
- cron
- Worker Loader with the scoped Code Mode capability adapter

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

Remaining upstream-shaped patches:

1. side-effect builtin import registration
2. Worker Loader capabilities across isolates
3. outbound fetch denial for IMDS and link-local control endpoints

camelAI-specific or fork-only work:

1. the internal facade proxy and signed loopback capability gateway
2. runtime security patches that are not application capabilities
3. dynamic application scheduling and dispatch

Do not change celld ownership, fencing, or replication without coordinating
with upstream. Keep the v0.4 branch rebased and retire each patch when its
upstream equivalent lands.

## Delivery slices

### P0: authenticated durable chat

- [x] Produce and test a celld-only deployment manifest.
- [x] Load the actual camelAI production bundle on celld.
- [x] Prove an S3-backed D1 restore from an empty local cache.
- [x] Add a DO-backed compatibility service for APP_KV and SESSIONS, including
      TTL-aware reads, cursor pagination, and namespace isolation.
- [ ] Add concurrent-session and node-restore integration coverage for the KV
      service.
- [x] Add the R2-compatible application facade, including streaming/range
      transport, metadata, conditionals, list, and multipart operations.
- [ ] Back the object-storage gateway contract with the pilot application-data
      S3 bucket and pass its conformance suite.
- [ ] Route WorkspaceFilesystemDO streaming operations through DO fetch until
      celld supports cross-isolate RPC streams.
- [ ] Run APP_DB migrations through `celld d1 migrations apply`.
- [ ] Configure staff authentication, local artifacts, and Bedrock.
- [ ] Pass login, workspace creation, thread creation, SSE chat, and workspace
      file read/write on the pilot.

### P1: coding

- [x] Add the application-side Code Mode execution facade with a local deadline;
      provider credentials never enter the Worker request.
- [x] Authenticate the internal facade proxy to the loopback gateway with an
      operator-provisioned bearer secret and fail closed when it is absent.
- [ ] Implement per-execution token minting and verification in the loopback
      gateway.
- [ ] Scope tokens to org, workspace, thread, tool use, allowed operations,
      expiry, and replay policy.
- [ ] Pass `js_exec` tool listing and workspace edits.
- [ ] Pass the camelAI SSE reconnect and pressure-handoff suite on the v0.4
      response lifecycle before enabling eviction.

### P2: build and deploy

- [x] Add application adapters for project-build, analysis, and database-query
      compute without giving celld the Docker socket.
- [ ] Implement the host-local authenticated runner behind those contracts.
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

- celld v0.4.0 remains an early runtime and is not treated as a hostile
  multi-tenant boundary.
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
  until the v0.4 response lifecycle passes the camelAI SSE soak.

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
