<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/camelAI-fullname-logo-darkmode.svg">
    <source media="(prefers-color-scheme: light)" srcset="public/camelAI-fullname-logo-lightmode.svg">
    <img alt="camelAI" src="public/camelAI-fullname-logo-lightmode.svg" width="360">
  </picture>
</p>

<p align="center">
  An AI coding assistant for persistent workspaces, connected data, and deployable applications.
</p>

<p align="center">
  <a href="https://camelai.com">Website</a> ·
  <a href="https://camelai.dev">Open camelAI</a> ·
  <a href="https://github.com/qaml-ai/camelAI/actions/workflows/ci.yml">CI</a> ·
  <a href="LICENSE">MIT License</a>
</p>

## What camelAI does

camelAI gives teams persistent AI coding workspaces backed by Cloudflare. Each
chat thread runs its own coding agent in a Durable Object. Users can connect
external services and data, build applications, and publish them to managed app
hosts.

The platform includes:

- persistent chat threads and project files
- AI coding agents with workspace-aware tools
- integrations for APIs, databases, email, Slack, Discord, and other services
- isolated application builds, notebook analysis, and SQL execution
- previews and production publishing through Workers for Platforms
- organization, authentication, billing, usage, and administrative controls

## Quick start

### Prerequisites

- Node.js 22 or newer
- [Bun](https://bun.sh/)
- a Cloudflare account with access to the development resources
- Docker for sandbox-backed features and agent evals

Install the project and create a local secrets file:

```bash
git clone https://github.com/qaml-ai/camelAI.git
cd camelAI
bun install --frozen-lockfile
cp .dev.vars.example .dev.vars
```

Replace the placeholder signing and encryption secrets in `.dev.vars`. For
hosted model access, also add a development Cloudflare AI Gateway token. You can
instead configure an Anthropic, OpenAI, OpenRouter, Requesty, Bedrock, or custom
provider from the organization settings after the app starts.

Start the app with local authentication:

```bash
bun run dev:local-auth
```

Open [http://localhost:3001](http://localhost:3001). The local-auth command is
restricted to the Vite development server and seeds a `Local Dev` user,
organization, and workspace.

To exercise the normal OAuth flow, use:

```bash
bun run dev
```

The port defaults to `3001` and can be changed with `VITE_DEV_PORT`.

## Architecture

```text
React Router SSR + browser HTTP/SSE
                  |
                  v
       Cloudflare main Worker
                  |
                  v
       ChatThreadDO (coding agent)
       custom harness built on pi
                  |
       +----------+-----------+----------------+
       |                      |                |
       v                      v                v
Code Mode dynamic     WorkspaceFilesystemDO   Short-lived Cloudflare
Worker / V8 isolate     SQLite + R2 files      sandbox containers
JavaScript tools,       Artifacts history      build / notebook / SQL
data connections

deploy_project: project files -> build sandbox -> Workers for Platforms
                                                   |
                                                   v
                                        Dispatcher Worker -> live app
```

The agent is camelAI's own harness, built from pi's lower-level agent loop and
state-management libraries. It is not Claude Code or Codex. Anthropic, OpenAI,
OpenRouter, Requesty, Bedrock, and custom endpoints can provide the underlying
model, but they do not provide the agent harness.

`ChatThreadDO` owns the agent loop and persistent chat state. The agent uses
native file tools and writes JavaScript instead of bash; Code Mode runs that
JavaScript in fresh V8 isolates with explicit platform and connection methods.
Credentials remain outside the execution sandbox.

Project files live in `WorkspaceFilesystemDO`, with small files in Durable
Object SQLite and larger files in R2. Cloudflare Artifacts provides git history.
Linux is reserved for short-lived jobs that need it: application builds,
notebook analysis, and database queries run in dedicated Cloudflare sandbox
containers. The dispatcher routes requests to published user applications.

Read [Our coding agent runs in a Cloudflare Durable Object, not a
VM](https://camelai.com/blog/our-coding-agent-runs-in-a-cloudflare-durable-object-not-a-vm)
for the design progression and tradeoffs behind this architecture.

For deeper implementation details and repository conventions, see
[AGENTS.md](AGENTS.md).

## Repository structure

| Path | Purpose |
| --- | --- |
| `src/` | React Router application, routes, UI, and shared libraries |
| `workers/main/` | Main Worker, Durable Objects, HTTP/SSE transports, MCP, and sandbox services |
| `workers/dispatcher/` | Routing for published user applications |
| `workers/app-usage-guard/` | Usage monitoring and reversible app quarantine |
| `workers/bedrock-provider/` | Anthropic-to-Bedrock AI Gateway provider |
| `workers/discord-bridge/` | Discord Gateway connection and control Worker |
| `sandbox/` | Agent skills and project scaffold templates |
| `scripts/` | Development, deployment, eval, and maintenance tooling |
| `tests/` | Application and shared-library unit tests |
| `workers/main/tests/` | Worker, Durable Object, Miniflare, and agent eval tests |
| `e2e/` | Playwright end-to-end tests |
| `infra/` | Self-hosting and database egress infrastructure |

## Development commands

Use Bun for JavaScript and TypeScript commands.

| Command | Purpose |
| --- | --- |
| `bun run dev` | Start React Router development with Cloudflare bindings |
| `bun run dev:local-auth` | Start development with a seeded local identity |
| `bun run build` | Create a production build |
| `bun run typecheck` | Generate route types and run TypeScript checks |
| `bun run lint` | Run source and import checks |
| `bun run test` | Run Vitest in watch mode |
| `bun run test:run` | Run application and shared-library tests once |
| `bun run test:workers` | Run Worker and Durable Object tests |
| `bun run test:all` | Run application and Worker test suites |
| `bun run test:e2e` | Run Playwright end-to-end tests |

When changing UI routes or components, run typecheck and the most relevant unit
tests. For Worker or Durable Object behavior, prefer a focused worker test:

```bash
bun run test:workers -- <test-file>
```

Agent evals require Docker and additional credentials. Run a committed eval by
manifest ID:

```bash
bun run test:eval <eval-id>
```

## Self-hosting

camelAI has a supported single-machine Docker Compose target for private
networks and on-premises evaluation:

```bash
bun run selfhost:init
bun run selfhost:doctor
bun run selfhost:up
```

The self-hosted target supports the web application, authentication, model
providers, durable state, project source files and local history, project
builds and deployments, notebooks, SQL execution, and browser rendering.
Outbound email and password-email verification are intentionally unavailable,
as is multi-node failover.

See [SELF_HOSTING.md](SELF_HOSTING.md) for the release-image and source-build
modes, capability contract, authentication, outbound-email policy, and
operator validation. Detailed requirements, Compose and provider
configuration, backup, and upgrade procedures are in
[infra/selfhost/README.md](infra/selfhost/README.md).

## Deployment

Deployment commands are intended for maintainers with access to the relevant
Cloudflare account and environment secrets.

```bash
# Main application
bun run deploy:main:staging
bun run deploy:main:prod

# Published-app dispatcher
bun run deploy:dispatcher:staging
bun run deploy:dispatcher:prod
```

Other Workers have dedicated `deploy:*` scripts in [package.json](package.json).
Environment-specific bindings live in the corresponding `wrangler*.jsonc`
files.

## Contributing

Before opening a pull request:

```bash
bun run typecheck
bun run lint
bun run test:all
```

Add focused tests for behavior changes, especially around authentication,
billing, persistence, file safety, and administrative operations. Follow the
architecture and code conventions in [AGENTS.md](AGENTS.md), and keep
feature-specific documentation close to the code it describes.

## License

camelAI is available under the [MIT License](LICENSE).
