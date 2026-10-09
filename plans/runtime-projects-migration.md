# camelAI project and workspace files on camelRun projects

Status: plan, not built. Base: camelAI `main` 7bab3a0a4; camelRun `main` 8499c82 plus the open Projects PRs #87 (volume gaps), #88 (`readAll`, snapshot reads), #89 (keyed volumes, `runtime.projects`; branch `feat/projects` e90ee9a) and #92 (files in tool calls; `feat/file-arguments` 1006140).

This supersedes `plans/agent-runtime-migration.md` §5 and the `design/runtime-thread-files` branch. Both keep WorkspaceFilesystemDO as the source of truth. This plan moves it to camelRun.

**Recommendation.**
- Each camelAI workspace gets one keyed camelRun volume, and each project gets one more.
- Thread agents mount them and use the runtime's own file tools (`fileTools: true`).
- Project snapshots become the version handle for deploy, `list_commits` and `revert_project`. Builds read a snapshot instead of copying files out of the DO.
- Deploy artifacts and rollback, uploads and outputs in R2, and the analysis sandbox stay. The sandbox reads and writes volumes through an adapter.
- Workspaces move one at a time behind a flag: freeze, copy, verify, flip. The old data stays read-only until a later, signed-off delete.
- Old source snapshots are not copied.
- About 4,500 source lines go, and about 1,100 are added.
- Two small camelRun features are needed first: restore a snapshot in place, and download a snapshot as an archive (§6).

---

## 1. Target model

### 1.1 Volumes

| camelAI thing | camelRun volume | Key (per tenant, permanent) | Mounted at |
|---|---|---|---|
| Workspace files (today: the workspace DO's file table) | one per workspace | `ws:<workspaceId>` | `/workspace` (rw, first, so relative paths resolve here) |
| Project files (today: one DO per project) | one per project | `proj:<projectId>:<nonce>` | `/projects/<name>` (rw) |
| The thread's scratch (attachments, `tool-outputs/`, `tmp/`) | the agent's own workspace volume, unchanged | (runtime's) | `/scratch` (needs gap G3; until then `{workspace: true}` stays at `/workspace` and the camelAI workspace mounts at `/files`) |

- **The nonce is required.** A project id is `globalProjectId(workspaceId, name)`, so deleting a project and creating one with the same name gives the same id. A deleted keyed volume's key is a 409 forever (#89). The registry row stores the nonce, for example the row's creation time in milliseconds.
- **The registry moves out of the DO.** `projects:v1` in the workspace DO's KV moves to an OrgDO table: `projects(id, workspace_id, name, description, volume_id, volume_key, storage 'do'|'volume', created_at, updated_at)`. The OrgDO already owns `worker_scripts` and `worker_script_deploys`. Everything that lists projects reads this table: `@` mentions, `/connections`, the projects API and code-mode `resolveProjectForAction`.
- **Mounts are computed per send** in `ensureConfiguredAgent`. The set is the workspace, then the projects the thread has used or mentioned, then the most recently changed projects, up to the limit of 16 mounts per agent. `camel__create_project` and a new `camel__open_project {name}` add a project mid-turn with `PUT /v1/agents/:id/mounts`. camel-bots' `open_bot` already does this (§5.1).
- **The tool switch happens at a send boundary.** A migrated workspace's agents get `fileTools: true`, the mounts, and prompt version 5. An unmigrated workspace's agents keep `fileTools: false` and the `camel__*` file tools. `RUNTIME_PROMPT_VERSION` re-sends the prompt to existing threads at their next send (`thread-runtime.ts`).

### 1.2 Tools

| Today (`code-mode-tools.ts`, `pi-container-tools.ts`) | After |
|---|---|
| `camel__read/write/edit/ls/grep/find/delete` with `location: workspace \| project` | Runtime `read/write/edit/ls/glob/grep` on `/workspace/…` and `/projects/<name>/…`, plus `fs` in js_exec. The runtime's version check ("changed since you last read it") applies. |
| Same tools with `location: "r2"` (uploads, outputs, tmp) | Unchanged for now: `camel__read/ls/write/delete` keep only the `r2` location. |
| `camel__move`, `camel__import_file` between locations | Within the mounts: runtime `fs` or `write`. From scratch into R2 outputs: `import_file` keeps only R2 destinations, with `$file` sources (#92). |
| `list_projects`, `create_project`, `set_project_description`, `delete_project` | Same tools, backed by the OrgDO registry and keyed volumes. Create seeds its scaffold with `projects.create({key, template})`. Delete deletes the volume. |
| `list_commits` | `GET /v1/volumes/:id/snapshots`. A snapshot's name carries the message (`deploy: <name>`, `revert: <id>`, `user: …`). |
| `revert_project {snapshot_id, deploy?}` | Restore in place (gap G1). Until G1 ships, the fallback is readAll at the snapshot, write each file, and remove the extras, which takes about 60 lines. |
| `deploy_project`, `rollback_deploy`, `list_deploy_versions` | See §1.3. Rollback is unchanged. |
| `run_notebook`, `analysis_exec`, `add_python_dependency`, `add_dependency` | Unchanged interface. The analysis service gets a volume-backed file store (§1.4). |
| `set_preview` for a project or workspace file | Previews read from the volume (§1.5). |

Some camelAI-specific guards lived in the DO's write path. Notebook JSON normalization on edit (`projectEditTextFile`) and `assertNotBase64IntoBinaryFile` are lost with it. Notebook normalization moves to `run_notebook` and to deploy validation. The base64 guard goes with the `camel__` write path.

### 1.3 Deploy from a snapshot

Today's order is: copy DO source into the ProjectBuildContainer, build, take a source snapshot after the build, upload, then write the OrgDO rows. The snapshot is taken after the build has read live files, so the recorded commit can differ from what was built.

New order:
1. `POST /v1/volumes/:id/snapshots {name: "deploy: <project>"}`. This snapshot is the version.
2. The container fetches the snapshot itself. With gap G2, chiridion signs a link to `GET /v1/volumes/:id/archive?snapshot=…` and the container runs `curl … | tar -xz` into the workdir. No bytes pass through a Worker. Until G2 ships, the Worker pages `readAll({snapshot, prefix})`, which allows 1,000 files and 16 MiB a call, and keeps feeding today's tar lanes into the container.
3. Incremental copy-in stays possible. The container keeps the last manifest's sha256s, and listing a snapshot with `readAll` returns sha256 for every file. The first version fetches everything. Incremental fetching is added only if the measured p95 source size calls for it (§3.2).
4. The build, `collectWorkerBundleFromSandbox`, `deployWorkerModulesDirect` and the R2 artifact cache are unchanged. `commitSha` becomes the snapshot id.
5. A failed build deletes its snapshot, as `project.publish` does, so the commits list shows deploys only.
6. Keep 50 deploy snapshots per project and prune older ones. The cap is 100 per volume. Rollback uses the artifact cache, never source snapshots, so pruning is safe.

`deployNotebookProject` reads the `.ipynb` from the same snapshot.

### 1.4 What stays

- **Deploy artifacts and rollback**: the R2 artifact cache, `worker_scripts` and `worker_script_deploys`.
- **Uploads and outputs** stay in R2 under `{org}/{ws}/user-uploads|user-outputs`. They are mounted live into the analysis sandbox (`sandbox-mounts.ts`) and read by deployed apps (`camelai-service.ts`), so moving them gains nothing now. Revisit after this plan lands.
- **The analysis sandbox** keeps its materialize-and-persist design (`analysis-service.ts`) behind `WorkspaceFileStoreLike`. A new `VolumeFileStore implements WorkspaceFileStoreLike` swaps in for `ProjectFilesystemClient`:
  - Materialize reads at one seq with `readAll`.
  - Persist writes each changed file with the `version` it materialized. A conflict is reported as "changed meanwhile, not overwritten". Today the last writer wins.
  - `adoptR2File`, the large-file path up to the 25 MiB persist cap, becomes a signed PUT link that the container streams to.
  - Mounting volumes into the sandbox would need a FUSE or S3 interface on camelRun. That isn't worth building now; the files decision of 2026-09-29 is "no FS provider unless real sandboxes arrive".

### 1.5 UI previews and listings

- **Listings and text previews** (`workspaces.utils.ts`, `workspace-file-preview-text.server.ts`) call the volume API from the Worker with the API key. The workspace's id comes from the registry, never from the client.
- **File bytes** (`…/fs.content.$`, `…/projects.$project.fs.content.$`) answer with a 302 to a signed GET link (`POST /v1/volumes/:id/links`, which supports Range). The browser fetches from run.camelai.com, and no bytes go through the Worker.

### 1.6 Prompt

`runtime-prompt.ts` loses the "two filesystems" paragraph. It gains a short layout description:
- `/workspace` is the camelAI workspace, shared with the user's other chats and apps.
- `/projects/<name>` are projects. Call `camel__open_project` to mount another one.
- `/scratch` is this conversation's own files.
- Uploads and outputs are under `camel__` location `r2`.

`pi-system-prompt.ts`'s `/workspace/AGENTS.md` line becomes true as written.

---

## 2. Code removed and added

Line counts are from `main` 7bab3a0a4.

**Removed**, after the delete phase (§5, step 6):

| What | Where | Lines |
|---|---|---|
| WorkspaceFilesystemDO, its clients, the registry, source snapshots and Artifacts repos | `workers/main/src/workspace-filesystem-do.ts` | 1,875 |
| Container file tools over the DO | `workers/main/src/pi-container-tools.ts` | 706 |
| DO copy-in for builds (read lanes, hashing, tar writer, manifest) | `workers/main/src/project-build-source.ts` | 614 → ~120 |
| Workspace and project file locations, `move` and cross-location `import_file`, `revert_project`, `list_commits`, `projectFileStore`, `deleteDoBackedProjectFiles` | `workers/main/src/code-mode-tools.ts` | ~650 |
| Byte proxies | `src/routes/api/workspaces.$id.fs.content.$.ts`, `…projects.$project.fs.content.$.ts` | 203 → ~60 |
| Artifacts binding: 5 wrangler files, the self-host config and health check, `scripts/selfhost-artifacts-smoke.mjs` | various | ~300 |
| Self-host `localDisk` DO storage for WORKSPACE_FS | `scripts/selfhost-workerd-config.mjs` | ~20 |
| Tests of the DO, the container tools and the copy-in (`workspace-filesystem-project-client`, `pi-container-tools*`, `project-build-source`, `workspace-projects-api` and others) | `workers/main/tests`, `tests` | ~2,000, partly rewritten |

Source total: about 4,500 lines. `text-edit.ts` stays, because `deterministic-automation-virtual-files.ts` uses it.

**Added:**

| What | Lines |
|---|---|
| `runtime-volumes.ts`: keyed volume create and lookup, mount computation, `open_project`, `VolumeFileStore` | ~350 |
| OrgDO `projects` table and methods, and registry readers switched to it | ~200 |
| Deploy from a snapshot (snapshot, signed archive link, container fetch, prune) | ~120 |
| `revert_project` and `list_commits` on snapshots | ~60 |
| Migration: freeze, copy, verify, flip and reverse copy, lazy trigger, sweep (pattern from `agent-runtime/cloud-sweep.ts` and `selfhost-sweep.ts`) | ~350 |
| UI routes on the volume API and the prompt | ~100 |

Source total: about 1,100 lines, plus tests.

---

## 3. Risks and open questions

### 3.1 Concurrent writers on a shared workspace volume

Many thread agents, the analysis sandbox's persist and UI uploads all write to `/workspace`.

**Recommendation:** no locks.
- The runtime's file tools refuse a write over a version the agent hasn't read, and the API's `write(…, {version})` does the same for chiridion's own writes.
- That is stricter than today, where the DO's writes are last-writer-wins.
- Don't set `notify` on the workspace mount, so agents aren't prompted on every change.

**Measure:** how many workspaces have two or more threads writing files within the same 10 minutes (Q5c).

### 3.2 Latency from Cloudflare to camelRun on AWS

- **Agent file operations get faster.** Today a `camel__read` goes runtime (AWS) → chiridion MCP (Cloudflare) → DO → back. A mount read happens inside the runtime.
- **UI listings and previews get slower.** A DO RPC becomes a call from the Worker to AWS. Byte downloads avoid this with signed-link redirects (§1.5).
- **Builds pull the source from AWS.**
- **Measure:**
  - On staging, p50 and p95 from a Worker for a 200-file listing, a 50 KB text read and a 10 MB archive, against the same through the DO.
  - From Q5a, today's durations for `camel__` file tools.
  - From Q4, the distribution of project source sizes.
- **Thresholds:**
  - A listing over 300 ms p95 means the UI should list once and then follow `changes(since)`.
  - A build fetch over 3 s p95 means adding incremental fetch (§1.3, step 3).

### 3.3 Self-host

- The bundled runtime stores volumes on its `agent-runtime-data` Docker volume (`AGENT_STORAGE=file`) by default. S3 is needed only for multi-node installs, which already need it.
- Self-host therefore needs no new infrastructure.
- Its backups must include the runtime's data volume, which they already do for threads. Update `docs/selfhost` to say workspace files live there now.
- The same lazy migration and sweep run on self-host at boot, as `selfhost-sweep.ts` does for threads.

### 3.4 Consistency between the DO and the volume during cutover

**Rule:** a workspace and its projects are in exactly one store at a time. The registry's `storage` column decides which, and nothing dual-writes.

**Copy steps (per workspace):**
1. Set a write fence in the workspace DO and each project DO. Writes then fail with a retryable `EMIGRATING` ("moving files, try again in a moment").
2. Copy every file. Inline rows come from SQLite and spilled files are streamed from R2. Each write uses `version: 0` and is skipped if the path already has the same sha256, so a cut-off copy resumes.
3. Verify that the DO listing and the volume's `readAll` and listing match on path, size and sha256.
4. Snapshot the volume as `migrated`.
5. Flip `storage` to `volume`.
6. Lift the fence on the volume side. The DO stays read-only and refuses writes for good.

**Notes:**
- The window is the copy time. Q4 gives the p95; the target is under 10 s for the lazy path.
- Larger workspaces are left to the background sweep at a quiet hour, never the lazy path.
- The DO has explicit empty directories. Volumes may not; check this in step 3 and drop empty directories if needed.

### 3.5 Per-org isolation in one tenant

`chiridion-prod` is a single camelRun tenant, so camelRun's tenant boundary doesn't separate orgs. Isolation rests on four things:
1. **chiridion only mounts volumes its registry gives** for the thread's org and workspace. The mount code asserts the row's org equals the thread's org before every mount.
2. **Agent tokens reach only their own mounts.** The browser's direct-thread token is agent-scoped, so a workspace member can read that workspace's files, as they can today.
3. **The API key never leaves chiridion's server.**
4. **Volume labels** for org and workspace (gap G6) let a nightly check list every volume and confirm its owner.

**Recommendation:** don't create a tenant per org. A tenant is camelRun's billing and rate-limit unit, and thousands of them would need operator configuration.

**What one tenant shares:**
- The tenant storage limit: 100 GB by default. The operator raises it for `chiridion-prod` before the sweep, sized from Q3 and Q4.
- Rate limits.

Per-org quotas are enforced by chiridion: `runtime.volumes(ids)` returns bytes, and a write-time per-volume quota would need gap G5.

### 3.6 Cost

| | Today | After |
|---|---|---|
| Storage | DO SQLite (inline files up to 1.5 MB) at $0.20/GB-month, plus R2 (spilled files and snapshot blobs) at $0.015/GB-month | S3 at $0.023/GB-month, with content-addressed chunks counted once, plus Postgres tree rows |
| Requests | DO requests and duration for every file tool call, listing and build read | Runtime-local for the agent. S3 GETs and PUTs. Worker → AWS calls for the UI |
| Egress | none (Cloudflare to Cloudflare) | AWS → Cloudflare at about $0.09/GB for build fetches, analysis materialize and UI byte downloads |

camelRun's $0.10/GB-month storage price is internal for our own tenant, so the real cost is S3 plus egress.

**Open question for Miguel:** whether storage `usage.recorded` events for `chiridion-prod` should reach orgs' bills, or stay platform cost. chiridion bills from those events.

**Measure** (estimates need Q2–Q5):
- Egress per day ≈ deploys per day × median source size, plus analysis materializes × size.
- Storage = R2 bytes from Q3 plus SQLite bytes from Q2.

### 3.7 Other

- **Files over 256 MiB**, camelRun's per-file cap. These are mostly zips imported through `projectRegisterUploadedR2Objects`. Q3 counts them. Recommendation: move them to R2 `outputs/` and leave a `<name>.moved.txt` pointer.
- **Volumes past 100,000 files** (Q4). These are handled by hand.
- **Deleting a workspace or an org** deletes its volumes. Add the deletes to the org hard-delete path next to the agent deletes (#59).
- **Old threads' transcripts** mention `location: "project"` paths. Prompt version 5 and the switch at the send boundary cover them, and the model adapts. There is no history rewrite.

---

## 4. Migrating existing data

### 4.1 What to measure first

These are read-only and are listed here, not run. Running them in prod needs Miguel's sign-off.

- **Q1. DO objects.** Cloudflare API `GET /accounts/{acct}/workers/durable_objects/namespaces/{WORKSPACE_FS namespace}/objects`, paginated. Gives the number of workspace and project DOs with stored data.
- **Q2. DO storage and traffic.** Cloudflare GraphQL `durableObjectsStorageGroups` and `durableObjectsInvocationsAdaptiveGroups`, filtered to the namespace over the last 30 days. Gives stored bytes, requests per day and duration.
- **Q3. R2.** S3 `ListObjectsV2` on `chiridion-sandbox`, with a read-only token, over the prefixes `project-fs/`, `workspace-fs/` and `project-source-snapshots/`. For each prefix: object count, total bytes, the largest object, the count over 256 MiB, and the top 20 DOs by bytes.
- **Q4. Census.** This needs a new admin endpoint, `GET /admin/fs-census?cursor=`. It is read-only and deployed but not run without sign-off. It walks the OrgDO workspace lists, and for each workspace reports:
  - its projects;
  - per DO: file and directory count, inline bytes, spilled bytes, the largest file, snapshot count and the latest `modified_at`;
  - per project: whether it exceeds 1,000 files or 16 MiB (the `readAll` limits).

  Output is NDJSON. It gives:
  - the distribution of projects per workspace, which checks the 16-mount limit;
  - the copy-time distribution for the lazy threshold;
  - the share of inactive workspaces.
- **Q5. Tool usage, last 30 days**, with R2 SQL on the `tool_calls` lake:
  - (a) count and p50/p95 `duration_ms` per `tool_name` for the file, deploy, revert, `list_commits` and analysis tools;
  - (b) distinct workspaces a day using project tools;
  - (c) workspaces where two or more `thread_id`s call write, edit, delete or move within 10 minutes.

### 4.2 Copy

**Lazy path.** A send in a workspace whose org has the flag on, while the workspace is still on the DO, starts the copy (§3.4) when the census size is under the lazy threshold. That send waits for the copy to finish, up to about 10 s. Otherwise the send runs on the old tools and the workspace joins the sweep queue.

**Sweep.**
- A queue-driven job walks the census list, inactive workspaces first.
- It is resumable, with per-workspace state in the OrgDO: `pending`, `copying`, `verified`, `flipped`, `failed`.
- It runs with bounded concurrency.
- It writes through the volume API from a Worker. Spilled R2 objects are streamed from R2 to a signed PUT link.

**Source snapshots are not copied.**
- Deploy rows keep their old `commitSha` ids, and rollback uses the artifact cache, so nothing breaks.
- `revert_project` to a pre-migration id goes through a legacy path for 90 days. The path reads the snapshot's manifest from the read-only DO and the blobs from R2, and writes them into the volume. It is about 60 lines and is deleted with the DO.

### 4.3 Verification

- **Per workspace:** the check in §3.4, step 3, is a precondition for the flip.
- **Global:** a nightly report compares the census to the volumes, covering count, bytes and the paths that differ. The rollout continues only at zero differences.
- **Behavioural:** the project evals (`do-backed-project-deploy-live`, `project-revert-redeploy-live`, `project-update-redeploy-state-live`, `notebook-deploy-live`, `zip-upload-project-import-live`) run against volume workspaces on staging. Their DO-specific helpers are rewritten.

### 4.4 Rollback

- **Until the delete phase**, set a workspace back to `do`. The reverse copy is the same code in the other direction: volume `readAll` to DO writes, then lift the DO fence. It is built and tested in phase 3, not on the day it's needed.
- **After the delete phase**, the only rollback is the volumes' own snapshots.
- **Data deletion** needs Miguel's sign-off. That covers the DO storage (a `deleted_classes` migration in a separate deploy, as with the Sandbox 1.0 migration) and the R2 prefixes from Q3. It waits at least 30 days after the last flip.

---

## 5. Phasing

Each step ships alone, behind the org flag `runtime_project_volumes`, on staging first.

1. **Measure.** Ship the Q4 census endpoint, unused. Run the staging latency probe (§3.2). After sign-off, run Q1–Q5. Adopt the camelRun release with #87–#89 and #92, as the next chiridion SDK bump.
2. **Registry to OrgDO, and drop Artifacts.**
   - Mirror `projects:v1` into the OrgDO table with a per-org sweep, then read from it.
   - `createProject` stops creating Artifacts repos. `cloneProject` and `mintProjectArtifactToken` have no external callers, so they go.
   - No user-visible change.
3. **New workspaces on volumes**, for internal orgs only:
   - `runtime-volumes.ts`, the mounts, prompt v5 and the reduced `camel__` file tools;
   - deploy from a snapshot (with the readAll fallback until G2), revert (with the fallback until G1) and UI routes on the volume API;
   - `VolumeFileStore` for analysis;
   - the migration code with a dry-run mode, plus the reverse copy.
4. **Migrate internal orgs**, lazily and with the sweep. Watch the verification report and the Q5 metrics for a week.
5. **Roll out by percentage of orgs**, then a full prod sweep (sign-off). Self-host gets the same code in its next release, with the sweep at boot.
6. **Delete** (sign-off, 30 days or more after the last flip): the DO class in its own deploy, the R2 prefixes, `pi-container-tools.ts`, the copy-in, the legacy revert path, and the self-host `localDisk` WORKSPACE_FS storage.

### 5.1 Learn from camel-bots first

bots-projects is adopting Projects now, in `camel-bots` `docs/projects.md`. Before phase 3, get answers on:
- **Mid-turn `PUT /v1/agents/:id/mounts`.** `open_bot` swaps `/bot` mid-turn. Does the next tool call see the new mount, including in an open js_exec? `open_project` depends on this.
- **Keyed volumes and environments sharing a tenant.** camel-bots prefixes the key with a host hash outside prod. Confirm which chiridion environments share a tenant, and add an environment part to the keys where they do.
- **How often `readAll`'s limits (1,000 files, 16 MiB) are hit** on real drafts, and the latency of snapshot plus `readAll`.
- **How often the runtime's "changed since you last read it" fires** when a person and the builder edit the same draft, and whether the model recovers by itself.
- **Model behaviour with mounted file tools beside custom tools.** Are there wrong-tool calls?
- **Their restore**, which writes the files after a `before-restore:` snapshot, because there is no in-place restore. If G1 lands first, both products use it.

## 6. camelRun gaps (for camelrun-dx-2)

| # | Need | Why | Without it |
|---|---|---|---|
| G1 | `POST /v1/volumes/:id/restore {snapshot, prefix?}`: in place, atomic, metadata-only, taking a `before-restore` snapshot | `revert_project`, and the camel-bots restore | readAll plus write plus remove from chiridion. Not atomic, and slow on large projects |
| G2 | A snapshot archive, `GET /v1/volumes/:id/archive?snapshot=&prefix=&exclude=` (tar.gz, using #92's `src/tar.ts`) that can be signed through `/links`, with optional `paths` for incremental fetches | Builds fetch source directly into the container with one request | The Worker pages `readAll` (1,000 files and 16 MiB a call) and keeps today's tar lanes |
| G3 | The agent's own workspace at another path, `{workspace: true, path: "/scratch"}`, with uploads, tool outputs and tmp following it | The camelAI workspace can then be `/workspace`, as the existing prompts and AGENTS.md assume | The camelAI workspace mounts at `/files` and the prompts change to match |
| G4 | Document and test that `PUT …/mounts` applies to the next tool call mid-turn | `open_project`, `create_project` | Mount changes wait for the next turn |
| G5 | A per-volume byte quota (507 on write) | Per-org limits inside one tenant | chiridion polls `volumes(ids)` bytes and refuses at the send |
| G6 | Volume labels (`{org, workspace}`), and listing volumes by label | Ownership check, census, garbage collection of orphans | chiridion keeps its own index only (the OrgDO registry) |
| G7 | Snapshot metadata: a message, and file count and bytes in the listing | `list_commits` shows these today | The name carries the message, and counts come from `readAll` |
| G8 | Bulk import: a tar.gz `POST /v1/volumes/:id/import` | The sweep copies workspaces of thousands of small files in one request | One write per file, with bounded concurrency |

G1 and G2 are needed before phase 3 ships to users. G3 and G4 are needed for the cleanest version of phase 3. G5–G8 can follow.
