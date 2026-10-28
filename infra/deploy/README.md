# Deploying the main worker from GitHub Actions

Cloudflare Workers Builds cannot start Docker, so it cannot build the
Containers images (`ProjectBuildContainer`, `AnalysisContainer`,
`DbQueryContainer`) that `wrangler deploy` needs. The main worker now deploys
from GitHub Actions, which has Docker:

| Trigger | Workflow | GitHub environment | Runs |
| --- | --- | --- | --- |
| Push to `main` (or manual run) | `Deploy to Staging` (`deploy-staging.yml`) | `staging` | `bun run deploy:main:staging` |
| Manual, type `deploy` | `Deploy to Production` (`deploy-production.yml`) | `production` | pushes `main` to `production`, then `bun run deploy:main:prod` on that commit |

Both call `deploy-worker.yml`: `bun install`, then `scripts/deploy-main.mjs`
(build, `wrangler d1 migrations apply APP_DB --remote`, `wrangler deploy`,
which builds each image with `docker build --platform linux/amd64` and pushes
it to Cloudflare's registry), then a smoke check:

- production: waits until `https://camelai.dev/api/version` reports the
  deployed commit SHA (the build id), then expects 200 from
  `https://camelai.dev/login`, `https://camelai.com` and
  `https://camelai.com/login`.
- staging: sits behind Cloudflare Access. With the optional
  `CF_ACCESS_CLIENT_ID`/`CF_ACCESS_CLIENT_SECRET` secrets it does the same
  build-id wait and expects 200 from `/login`; without them it only checks the
  Access redirect.

One deploy per environment runs at a time (a newer pending run replaces an
older pending one; a running deploy is never cancelled). Timeout: 60 minutes.

If `CLOUDFLARE_API_TOKEN` is missing, nothing is deployed: pushes to `main`
finish green with a warning, manual runs fail with an error.

## Secrets (per GitHub environment)

Settings > Environments > `staging` and `production` (the environments are
created by the first workflow run, or create them by hand first):

| Secret | Environment | Required |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | `staging`, `production` | yes |
| `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` | `staging` | no (Access service token allowed on `staging.camelai.dev`, for the real staging smoke) |

The account id (`85bbd288051330fb51ee1c86031a299b`) is not secret and is set
in the workflow. One token can serve both environments; two tokens (one per
environment) keep a leaked staging token away from prod.

## Cloudflare API token permissions

Custom token, account `85bbd288051330fb51ee1c86031a299b` only:

Account permissions:

- Workers Scripts: Edit (upload, versions/deployments, cron triggers, Durable
  Object migrations, tail consumers, Workflows registration, custom-domain
  attach)
- Containers: Edit (container applications and registry push credentials;
  shown as Cloudchamber: Edit on older dashboards, add it too if listed)
- D1: Edit (`wrangler d1 migrations apply --remote`)
- Queues: Edit (`wrangler deploy` sets the queue consumers)
- Workers KV Storage: Edit
- Workers R2 Storage: Edit
- Account Settings: Read

Zone permissions, zone `camelai.dev`:

- Workers Routes: Edit (custom domains `camelai.dev` and `staging.camelai.dev`)

The other bindings (Analytics Engine, Pipelines stream, Artifacts, AI,
Browser, Images, Email, worker loaders, service bindings) are script
metadata and need no extra permission at deploy time. If a deploy fails with
an authentication error (code 10000), the error names the API path; add the
matching permission.

## Rollout

1. Create the token(s) above and add `CLOUDFLARE_API_TOKEN` to the `staging`
   and `production` environments (and the optional Access pair to `staging`).
2. Actions > Deploy to Staging > Run workflow (on `main`). Check the run is
   green and staging works.
3. Actions > Deploy to Production > Run workflow, type `deploy`. Check the run
   is green (the smoke confirms `camelai.dev` serves the new commit).
4. Only after both are green, turn off Workers Builds (below).

Until step 4 a push to `main` deploys staging twice (Workers Builds and
Actions) and a production run deploys prod twice (Workers Builds reacts to the
`production` push). Same commit both times; D1 migrations are idempotent.

## Turning off Workers Builds

For each of `chiridion-app-staging` and `chiridion-app`, in the Cloudflare
dashboard: Workers & Pages > the worker > Settings > Build > Git repository >
Disconnect. (To keep the connection but stop deploys instead, set Branch
control so neither the production branch nor other branches build.)

API alternative (needs a token with Workers Builds Configuration: Edit):

```bash
# script tag: the worker's "tag" from GET /accounts/$ACCOUNT/workers/scripts
curl -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/builds/workers/$SCRIPT_TAG/triggers"
curl -X DELETE -H "Authorization: Bearer $TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT/builds/triggers/$TRIGGER_UUID"
```

Local deploys (`bun run deploy:main:staging|prod`, wrangler OAuth login) keep
working as a fallback.
