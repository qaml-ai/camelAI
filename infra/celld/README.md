# AWS celld pilot

This directory tracks the AWS side of the active
[celld port](../../plans/celld-port.md). It is intentionally parallel to
`infra/selfhost/`; the working workerd deployment remains the rollback path.

## Current pilot inventory

The first real durability smoke uses:

- region: `us-west-2`
- state bucket: `camelai-celld-pilot-904534089871-us-west-2`
- deployed camelAI version: `e10dde736f9177a0`
- deployed KV service version: `9c8655bbae108f2b`
- runtime fork branch: `qaml-ai/celld:camelai/pilot-v0.3.0`
- runtime fork commit: `6536e1f`

The bucket has Block Public Access, bucket-owner-enforced ownership,
versioning, default SSE-KMS encryption, an HTTPS-only bucket policy, and
staff-only tags. It contains pilot data only. Do not put workspace R2 objects
or artifacts in it.

The tested node ran locally against AWS S3. No EC2, load balancer, NAT
gateway, or public DNS resources have been created yet.

## Binding facade boundary

The application now has provider-neutral service-binding facades for object
storage, artifacts, project/analysis/query compute, Code Mode execution, AI,
email, browser automation, images, queues, pipelines, and observability. The
celld manifest binds every one to the internal `chiridion-celld-facades`
Worker, which forwards only allowlisted `/v1/<capability>/...` requests to the
loopback gateway on port 7002. The bearer token is a celld secret and must not
be placed in the checked-in manifest. The deploy command requires
`FACADE_GATEWAY_TOKEN`, injects it through a mode-0600 temporary manifest, and
removes that manifest after deployment.

The request retains the original logical binding name. This lets one gateway
map `R2_BUCKET`, `R2_OUTPUTS_BUCKET`, and `WAREHOUSE_EXPORT_BUCKET` to separate
S3 buckets while Cloudflare production continues using its native bindings.
The same application adapter is used in both cases.

Durable Objects, D1, assets, workflows, and Fetcher-shaped internal services
remain celld-native. The existing DO-backed KV service stays as a compatibility
service until celld provides KV directly.

## Why compute is not provisioned yet

Provisioning an upstream celld EC2 node now would knowingly fail to load the
camelAI bundle and would expose an alpha runtime before the required security
patches exist. The next AWS compute gate is a digest-pinned image containing:

1. side-effect builtin import registration
2. the temporary v0.3.0 workflow export shim (or upstream v0.3.1)
3. an outbound IMDS/link-local denylist

Only then should the existing single-node self-host Terraform be factored into
a celld prototype module.

## EC2 prototype shape

- one on-demand x86_64 instance, initially `m7a.xlarge`
- encrypted 200 GB gp3 volume for `CELLD_WATCH`, Docker, caches, and artifacts
- instance profile scoped only to the celld state bucket
- IMDSv2 required
- SSM Session Manager; no SSH ingress by default
- authenticated Caddy/Pomerium ingress
- celld public listener on loopback
- celld internal/operator listener on loopback for the one-node pilot
- `CELLD_DURABILITY=bucket`
- `CELLD_OUTPUT_GATE=1`
- `CELLD_STORAGE_PROBE=1`
- no idle eviction

Build, analysis, query, and Code Mode execution run through the loopback-only
facade gateway. The gateway owns the container runner; the celld process and
Worker isolates do not receive the Docker socket.

## Three-node target

After the binding suite passes, move to three private EC2 nodes across AZs
behind an ALB. Port 8081 is permitted only between the celld node security
group members. Each node advertises its private address; peer discovery and
ownership remain in S3. Keep bucket durability until the complete-fleet-loss
test establishes the desired risk envelope for write-behind fleet durability.

Pomerium must use a shared PostgreSQL databroker before authentication scales
past one node.

## Cleanup

The pilot bucket is intentionally retained because it contains the deployment
and durability proof. Before deleting it, stop every celld node using it and
confirm no migration or restore test still references it. Versioning means an
ordinary object delete does not immediately erase prior versions.
