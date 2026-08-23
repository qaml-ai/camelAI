# celld binding facade proxy

This Worker is the single internal celld service target for camelAI bindings
that are not implemented natively by celld. It accepts only the capability
prefixes listed in `index.ts` and forwards them to `FACADE_GATEWAY_URL`.

The production pilot sets the gateway URL to a loopback-only host service and
stores `FACADE_GATEWAY_TOKEN` as a secret. Do not expose the gateway port, put
AWS credentials in Worker variables, or give the celld process a Docker
socket.

`bun run celld:deploy` requires `FACADE_GATEWAY_TOKEN` in the operator
environment and injects it into a mode-0600 temporary manifest that is removed
after deployment. The proxy fails readiness and all capability calls when the
token is absent. Its health endpoint also calls the gateway health endpoint, so
the gateway must verify its required S3, runner, and provider backends before
returning 2xx.

The application contracts live in `workers/main/src/binding-facades/`:

- `object-store.ts`: R2-compatible object, list, conditional, range, and
  multipart operations; the `binding` query parameter selects the logical
  bucket.
- `artifacts.ts`: repository create/get and scoped token creation.
- `compute.ts`: project-build, analysis, and database-query RPC plus streaming
  file transfer.
- `code-executor.ts`: scoped Code Mode execution.
- `managed.ts`: AI, email, queues, pipelines, and browser bindings.
- `images.ts`: image inspection/transforms and hosted-image operations. The
  initial contract intentionally rejects the rarely used compositing `draw()`
  operation until the gateway has a multipart conformance test for it.

Cloudflare deployments do not bind these services and therefore keep using
native bindings. The facade contracts are an application portability boundary,
not a reason to duplicate provider behavior in the celld fork.
