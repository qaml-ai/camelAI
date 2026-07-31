# agentOS full rewrite plan

Cross-cutting architecture plan for replacing camelAI's Cloudflare Workers chat plane with a **Rivet Actors + agentOS** stack on a VPS. Implementation lives in [`agentos-platform/README.md`](../agentos-platform/README.md).

## Goals

1. **Self-hosted chat runtime** — one (or few) VPS instances instead of per-thread Durable Objects for agent turns.
2. **agentOS harness** — run Pi (and future agent software) via `@rivet-dev/agentos` with native sidecars, not CF sandbox containers.
3. **Graceful deploys** — version-tagged Rivet actors, dual runners, `keepAwake` on in-flight turns.
4. **Incremental port** — shared types and platform services first; wire production auth/billing/dispatcher later.

## Non-goals (phase 1)

- Feature parity with production billing, SSO, admin MCP, email/Slack ingress.
- Workers for Platforms user-app dispatcher.
- Cloudflare R2 / D1 / Analytics Engine bindings.

## Target architecture

```text
                    +------------------+
                    |  Reverse proxy   |
                    | (TLS, routing)   |
                    +--------+---------+
                             |
              +--------------+--------------+
              |                             |
       +------v------+               +------v------+
       |  web (SPA)  |               | app runner  |
       | nginx/vite  |               | Bun+Rivetkit|
       +-------------+               +------+------+
                                            |
                                     +------v------+
                                     | chatThread  |
                                     |   actors    |
                                     +------+------+
                                            |
                              +-------------+-------------+
                              |                           |
                       +------v------+             +------v------+
                       |  agentOS    |             | DATA_DIR    |
                       |  Pi harness |             | store+proj  |
                       +-------------+             +-------------+
```

Rivetkit **embedded mode** — engine in-process, no separate `rivet-engine` service. Optional second runner (`app-canary`) for drain testing; both mount the same `DATA_DIR` volume.

## Phases

### Phase 0 — Scaffold (current)

- [x] `agentos-platform/` package with shared chat types
- [x] Platform services: `Store`, `IdentityService`, `BillingService`, `ProjectFilesystem`
- [x] Vitest + typecheck
- [x] Docker / Compose VPS layout, `.env.example`, smoke script
- [ ] `src/server/index.ts` — Bun HTTP + Rivetkit registry bootstrap
- [ ] `web/` — minimal chat UI

### Phase 1 — Chat actor MVP

- [ ] `chatThread` Rivet actor: websocket, `sendMessage`, turn status
- [ ] `AGENT_RUNTIME=mock` — deterministic fake turns for UI dev
- [ ] `ChatEvent` encoder mirroring `src/lib/pi-chunk-encoder.ts` semantics
- [ ] Thread state patches (`StateEvent`) aligned with `src/shared/thread-state.ts`
- [ ] Demo tenant bootstrap (`ensureDemoTenant`)

### Phase 2 — Real agentOS / Pi

- [ ] `AGENT_RUNTIME=agentos` — wire `@rivet-dev/agentos` Pi software
- [ ] File tools backed by `ProjectFilesystem`
- [ ] Tool permission gates + `AskUserQuestion`
- [ ] `c.keepAwake` around full turn lifecycle
- [ ] Context compaction + slash commands

### Phase 3 — Platform hardening

- [ ] Session auth (password + OAuth); optional proxy-auth providers
- [ ] Stripe billing parity with `src/lib/billing-plans.ts`
- [ ] Usage metering and credit enforcement on inference path
- [ ] Structured logging / metrics (replace Analytics Engine)

### Phase 4 — Production adjacency

- [ ] Project build + deploy (replace `ProjectBuildSandbox` or hybrid)
- [ ] Notebook analysis runner
- [ ] SQL / data proxy path (relay or embedded runner)
- [ ] Import/migration tooling from production DO exports
- [ ] Dual-run or cutover strategy vs existing Workers plane

## Graceful deploy design

Rivet actor versioning uses `RIVET_ENVOY_VERSION` (integer, monotonic per release). See [Rivet docs — actor versions](https://rivet.dev/docs/actors/versions).

### Build

- Pass `RIVET_ENVOY_VERSION` as Docker `ARG` / `ENV` (see `agentos-platform/Dockerfile`).
- Each production image gets a new version number.

### Runtime

| Mechanism | Purpose |
| --- | --- |
| `RIVET_ENVOY_VERSION` | Tags new actor placements on the updated runner |
| Old runner | Stops accepting new actors; existing actors drain |
| `c.keepAwake(promise)` | Blocks actor sleep/finalize until turn completes |
| Shared `DATA_DIR` | Project files + JSON store visible to both runners during transition |

### Rolling procedure

1. Build image with `RIVET_ENVOY_VERSION=N+1`.
2. Start `app-canary` (or scale second replica) on the new version.
3. Configure proxy / Rivet pool routing so **new** `chatThread` actors land on `N+1`.
4. Wait for version `N` actors to finalize (monitor actor counts / logs).
5. Stop version `N` runner; promote canary to primary if needed.
6. Increment stored version for the next release.

`docker-compose.yml` includes `app` + `app-canary` (`--profile canary`) on ports `6420` / `6421` for local drain drills.

## Key migration surfaces

| Production | Rewrite target |
| --- | --- |
| `workers/main/src/chat-thread-do.ts` | `chatThread` actor module |
| `workers/main/src/chat-thread/*` | Actor collaborators (recovery, tools, preview) |
| `src/lib/pi-chunk-encoder.ts` | Server-side `ChatEvent` emission |
| `src/lib/ui-message-adapter.ts` | Web client adapter |
| `WorkspaceFilesystemDO` | `ProjectFilesystem` |
| `UserDO` / `OrgDO` | Identity actors or expanded `IdentityService` |

Detailed row-by-row map: [`agentos-platform/README.md`](../agentos-platform/README.md#migration-map-chatthreaddo--chatthread-actor).

## Verification

```bash
# From repo root
bun run test:agentos
bun run typecheck:agentos
agentos-platform/scripts/smoke.sh

# VPS integration (when server exists)
docker compose -f agentos-platform/docker-compose.yml up --build -d
curl -f http://localhost:6420/health
```

## Open questions

- **Object storage** — local disk only vs S3/R2 for uploads and artifacts.
- **Multi-tenant isolation** — single VPS vs sharded runners per org.
- **Build/deploy for user apps** — retain CF dispatcher or embed in agentOS runtime.
- **Cutover** — blue/green at DNS vs gradual thread migration export.

## Links

- Implementation README: [`agentos-platform/README.md`](../agentos-platform/README.md)
- Production agent guide: [`AGENTS.md`](../AGENTS.md)
- Chat transcript invariants (reference): `docs/chat-transcript-simplification.md`
