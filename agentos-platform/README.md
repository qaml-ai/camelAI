# camelAI agentOS platform (rewrite)

Experimental next-generation chat plane for camelAI: **Rivet Actors** + **agentOS** on a single VPS, replacing the Cloudflare Workers + Durable Objects + Pi harness stack for the core agent runtime.

Production camelAI still runs on Workers (`ChatThreadDO`, `WorkspaceFilesystemDO`, sandbox containers). This tree is the self-hosted rewrite path.

## What this is

| Today (production) | This rewrite |
| --- | --- |
| `ChatThreadDO` per thread | `chatThread` Rivet actor per thread |
| `@cloudflare/ai-chat` UIMessage stream | `ChatEvent` websocket bus (`src/shared/events.ts`) |
| `WorkspaceFilesystemDO` + R2 | Local `ProjectFilesystem` under `DATA_DIR/projects/` |
| `UserDO` / `OrgDO` identity | `IdentityService` (JSON store; future Rivet actors) |
| Cloudflare sandbox containers | agentOS runtime sidecars (from `node_modules`) |
| Workers deploy | Docker image on a VPS |

Rivetkit runs in **embedded mode**: the Rivet engine is in-process inside the Bun server — no separate `rivet-engine` container is required.

## Architecture

```text
Browser (Vite SPA, web/)
        |
        |  HTTP /api/*  +  WS /ws
        v
Bun server (src/server/index.ts)
        |
        +-- Rivetkit registry (embedded engine)
        |       |
        |       +-- chatThread actor  (per thread: turns, state, WS)
        |       +-- (future) org / workspace actors
        |
        +-- Platform services (src/server/platform/)
        |       Store, IdentityService, BillingService, ProjectFilesystem
        |
        +-- agentOS harness (AGENT_RUNTIME=agentos)
                native sidecars from node_modules
                (@rivet-dev/agentos-sidecar-*, agentos-runtime-sidecar-*)

Shared volume: DATA_DIR  (.data/ locally, /data in Docker)
  store.json          — org / workspace / thread metadata
  projects/{ws}/{id}/ — project source trees
```

## Dev

The server boots Rivetkit with `registry.start()` (embedded engine on `:6420`).
elopment

Prerequisites: [Bun](https://bun.sh) 1.2+, Node 22-compatible host.

```bash
cd agentos-platform
cp .env.example .env
bun install

bun run test          # vitest unit tests
bun run typecheck     # tsc --noEmit
bun run dev           # Bun watch: src/server/index.ts
bun run dev:web       # Vite dev server (web/)
```

From the monorepo root:

```bash
bun run dev:agentos
bun run test:agentos
bun run typecheck:agentos
```

Smoke script (CI-friendly, no server boot):

```bash
./scripts/smoke.sh
```

### Agent runtime selection

`AGENT_RUNTIME` defaults to `mock`. The deterministic `chatThread` actor stays
available in every mode so unit tests and local UI work do not require model
credentials.

Set `AGENT_RUNTIME=agentos` before starting the server to enable the AgentOS
registry setup (including the actor SQLite runtime socket), then connect to the
separate `chatThreadAgentOs` actor. It opens a durable Pi session on the first
`sendMessage`, streams ACP events through the same `ChatEvent` contract, and
exposes the camel workspace bindings:

```bash
AGENT_RUNTIME=agentos bun run dev
```

Configure the model provider credentials required by Pi in the server
environment. Merely importing the registry or running the default test suite
does not boot the AgentOS sidecar or require API keys.

## VPS deploy

### 1. Prepare the host

- Linux x86_64 (agentOS sidecar optional deps target `linux-x64-gnu`).
- Docker Engine + Compose v2.
- Persistent disk for `DATA_DIR` (bind mount or named volume `agentos-data`).

### 2. Configure environment

```bash
cp .env.example .env
# Edit .env: set RIVET_ENVOY_VERSION, API keys, AGENT_RUNTIME
```

`RIVET_ENVOY_VERSION` must be a monotonically increasing integer per production deploy. Rivet uses it to tag actors so old runners can drain in-flight work during rolling updates.

### 3. Build and start

```bash
export RIVET_ENVOY_VERSION=1   # bump each release
docker compose up --build -d
```

- API + Rivet: `http://<host>:6420`
- Static web (nginx): `http://<host>:8080` (proxies `/api` and `/ws` to `app`)

### 4. Rolling / graceful deploy

Rivetkit embedded mode supports **versioned actor drain** when `RIVET_ENVOY_VERSION` is set (see [Rivet actor versions](https://rivet.dev/docs/actors/versions)).

Recommended two-runner flow:

1. **Bump version** — set `RIVET_ENVOY_VERSION` (and Docker build-arg) to `N+1`.
2. **Start canary** — `docker compose --profile canary up -d --build app-canary` (listens on `:6421` for drain testing).
3. **Shift traffic** — place new actors on the canary runner; existing actors on the old version continue until idle.
4. **Drain in-flight turns** — chat actors call `c.keepAwake(promise)` around active Pi/agentOS turns so shutdown waits for completion.
5. **Retire old runner** — `docker compose stop app` (or swap primary/canary roles) once the old version has no live actors.

`docker-compose.yml` documents this inline. For production, put a reverse proxy (Caddy, nginx, Traefik) in front and route by runner health.

### 5. Data backup

Back up the `agentos-data` volume (or host path bound to `/data`):

- `store.json` — identity and billing metadata
- `projects/` — user project trees

## Graceful deploy notes

- **`RIVET_ENVOY_VERSION`** — required in production; without it Rivet logs a warning and actors are not version-tagged for drain.
- **`keepAwake`** — use `c.keepAwake(promise)` (not deprecated `setPreventSleep`) to hold a `chatThread` actor awake for an active turn.
- **Two runners** — `app` (primary, `:6420`) and `app-canary` (`--profile canary`, `:6421`) share `agentos-data` so project files and store are consistent across replicas during drain practice.
- **Sidecar binaries** — ship inside the image via `bun install`; no separate download step.

## Ported vs TODO

### Ported (initial scaffold)

- Shared chat contracts: messages, events, thread state, slash commands (`src/shared/`)
- Platform services: JSON `Store`, `IdentityService`, `BillingService` (credits stub), `ProjectFilesystem`
- Real `chatThreadAgentOs` actor with Pi sessions, camel bindings, and ACP event mapping
- Vitest coverage for platform layer
- Docker / Compose VPS layout with healthchecks and canary profile

### Still TODO

| Area | Notes |
| --- | --- |
| `chatThread` Rivet actor | Replace `ChatThreadDO` turn loop, Pi session, recovery |
| Web SPA | `web/` Vite client, Rivet React hooks |
| Auth / SSO | Session cookies, OAuth, Cloudflare Access / Pomerium parity |
| Stripe billing | Hosted credits, subscriptions, webhooks |
| Dispatcher / user apps | Workers for Platforms deploy path not in this stack |
| Builds / notebooks / SQL | CF sandbox containers → agentOS or separate runners |
| R2 / uploads | Local disk or S3-compatible object store |
| Admin / MCP | Superuser APIs and moderation |
| Migrations | Import from production OrgDO / thread / project data |

## Migration map: `ChatThreadDO` → `chatThread` actor

| Cloudflare (today) | agentOS rewrite |
| --- | --- |
| `ChatThreadDO` | `chatThread` Rivet actor (`src/server/actors/chat-thread.ts`) |
| `pi_core_*` SQLite (model transcript) | Actor embedded SQLite (`c.db` / `c.sql`) |
| ai-chat UIMessage render table | `ChatEvent` stream + client-side merge |
| `uiMetadata.renderMessageId` invariant | Stable `messageId` on `messageUpsert` / `messageDelta` events |
| `getUiMessages` cold load | Actor state + historical `ChatEvent` replay or snapshot RPC |
| `onChatMessage` / Pi prompt | Actor action: `sendMessage` → agentOS/Pi harness |
| `chatRecovery` / stall timeout | Actor `keepAwake` + recovery journal in actor storage |
| `ThreadState` / agent state payload | `StateEvent` patches (`src/shared/thread-state.ts`) |
| Slash commands (`SLASH_COMMANDS`) | Same allowlist (`src/shared/slash-commands.ts`) |
| `AskUserQuestion` tool | `pendingQuestion` on thread state + `answerQuestion` action |
| Tool permission gates | `permissionRequest` / `permissionResolved` events |
| `WorkspaceFilesystemDO` + R2 | `ProjectFilesystem` at `DATA_DIR/projects/{ws}/{projectId}` |
| `deploy_project` / build sandbox | TBD — agentOS exec or external build runner |
| `run_notebook` / analysis sandbox | TBD |
| `DATA_PROXY` / `DbQuerySandbox` | TBD — db egress relay or embedded query runner |
| WebSocket `/ws/{workspace}` | Rivet actor websocket on `chatThread` |
| `UserDO` / `OrgDO` | `IdentityService` → future `org` / `workspace` actors |
| Stripe / hosted credits | `BillingService` stub → Stripe integration |
| Observability (Analytics Engine) | Structured logs + future metrics backend |

Cross-cutting plan: [`plans/agentos-full-rewrite.md`](../plans/agentos-full-rewrite.md).

## Docker reference

```bash
# App only
docker build --build-arg RIVET_ENVOY_VERSION=1 -t agentos-app .

# Full stack (app + web)
docker compose up --build -d

# Canary drain practice
RIVET_ENVOY_VERSION_NEXT=2 docker compose --profile canary up -d --build
```

The `Dockerfile` copies `package.json`, `bun.lock`, `src/`, and `web/`, runs `bun install --frozen-lockfile`, and starts `bun run src/server/index.ts`. agentOS native sidecars are resolved from `node_modules` at runtime (linux x64 GNU optional dependencies).
