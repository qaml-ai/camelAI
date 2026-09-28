# Runtime threads: the agent runtime's filesystem as scratch space

Status: design, not built. Base: chiridion `main` 71460cfea; agent-runtime `main` c624f9a (plus `feat/dx-server` d116915, the tool-result spill, not merged).
Scope: threads that run directly on the hosted runtime (`plans/runtime-threads-direct.md`). Old ChatThreadDO threads are out of scope.

**Summary.** Every runtime thread already has a scratch filesystem, but nothing uses it on purpose:
- An agent created without `mounts` gets its own workspace volume at `/workspace`. The volume id is `vol_<sha256("workspace:<agent>")[:24]>` (`src/volumes.ts` `mountsFor`), and it is deleted with the agent (`client-sessions.ts` `releaseVolumes`).
- Chiridion creates agents with `fileTools: false` and no `mounts` (`thread-runtime.ts` `createThreadAgent`), and #59 deletes the agent with the thread. So each runtime thread has a private `/workspace` today that lives and dies with it.
- Three kinds of file already land there: images that `camel__` tools return, saved under `tool-outputs/` (runtime `src/tool-files.ts`); attachments, if chiridion sent any; and, once `feat/dx-server` merges, the spilled large tool results under `tool-results/`.
- Two prompts contradict each other about it:
  - chiridion's preamble says "Workspace, project and uploaded files live in camelAI: use the camel__ file tools … not fs" (`runtime-agent.ts:50`);
  - the runtime's environment section says "/workspace (read-write) … Work on them with fs in js_exec" (`system-prompt.ts` `environmentSummary`).

The recommendation is to adopt that per-thread volume deliberately, as scratch:
- say what it is in the prompt;
- show its files in chat;
- let people (and the agent) promote a file into the camelAI workspace;
- send uploads to the model as native attachments while keeping chiridion's copy.

The camelAI workspace (WorkspaceFilesystemDO, R2, project containers) stays the durable store. The runtime volume should not replace it, even for analysis-only threads (§6).

---

## 1. The per-thread scratch volume

**What exists.** One default workspace volume per agent, mounted read-write at `/workspace`:

| Property | Today |
|---|---|
| **Created** | When the agent is created (`mountsFor` with no `mounts`). The id is deterministic, so re-provisioning finds the same volume. |
| **Visible to** | Only that agent. Only the tenant's own volumes can be mounted, and chiridion never passes `mounts`, so no other agent (thread) mounts it. |
| **Deleted** | With the agent: `DELETE /v1/agents/:id` → `releaseVolumes` → `delete` on the default volume. Chiridion deletes the agent when the thread is deleted (`OrgDO.deleteThread`) and when an org is hard-deleted (#59). |
| **Limits** | 256 MiB per file. Tool outputs: 64 MiB per call and 256 MiB per run (`TOOL_FILE_LIMITS`). Listings suit volumes up to about 100k files. **No quota per volume or per tenant** ("Not yet built", README §Volumes). |
| **Billing** | $0.10 per GB-month of what the tenant's agents and volumes keep, charged daily. Chunks are content-addressed and counted once. **Deleting a volume does not delete its chunks** (there is no GC yet), and "deleted volumes' objects" are still charged. |

**Options considered:**
- **(a) Keep the implicit default volume.** This is the recommendation. It has the right lifetime (the thread's), right isolation (the thread's) and costs nothing to build. The only work is making it explicit: record the volume id on `thread_runtime.configured` when the agent is created (it's in `GET /v1/agents/:id` → `mounts`), so chiridion can use `/v1/volumes/:id/*` without re-deriving the hash.
- **(b) Definition mounts.** A definition's `mounts` are shared volumes, the same for every agent of the definition, so every thread would share one volume. That's wrong for per-thread scratch, and it crosses orgs.
- **(c) Per-agent explicit mounts** (`POST /v1/volumes`, then `mounts` at creation). Only useful if the volume must outlive the agent or be shared, e.g. a per-workspace volume shared by a workspace's threads (§6). That's a later option, not scratch.

**Lifetime.** Scratch lives exactly as long as the thread. If product wants scratch to expire sooner (for example 30 days after the thread was last active, to bound storage), that needs a volume TTL. That's a general runtime feature (§7, gap 7). Chiridion shouldn't delete files on a timer itself.

**Quotas.** Chiridion can't enforce a size limit on a volume it doesn't write to. Until the runtime has per-volume quotas (gap 2), the only bounds are the per-file and per-run limits above. At $0.10/GB-month and those limits, a runaway thread can add at most 256 MiB per run of tool outputs, plus whatever `fs.writeFile` does inside the run's 8 MiB js_exec traffic cap. That's acceptable for staging and should be fixed before production.

## 2. Coexisting with camelAI's workspace tools

There are two stores and one model. The rules:

| Store | Paths the model sees | Tools that reach it | Lifetime |
|---|---|---|---|
| **Scratch** (runtime volume) | `/workspace/...` (absolute, leading slash): `uploads/<request>/`, `tool-outputs/`, `tool-results/`, `tmp/`, anything the agent writes | `fs` in js_exec; `present_file`; attachments; `{"$file": "/workspace/..."}` arguments to MCP tools | The thread |
| **camelAI workspace** (WorkspaceFilesystemDO / R2 / projects) | `location: "workspace" \| "project" \| "r2"` + a relative path (`uploads/…`, `outputs/…`, `tmp/…`) | `camel__read/write/edit/ls/grep/find`, `camel__deploy_project`, notebooks, previews, apps | The workspace (shared by its threads, apps and users) |

The two naming schemes don't collide: scratch paths are absolute and start with `/workspace`, while camelAI paths are relative and always go with a `location`. The confusion is in the prompt, not the paths.

**fileTools stays `false`.** With it on, the model sees the runtime's `read/write/edit/ls/glob/grep` next to `camel__read/write/edit/ls/grep/find`: two near-identical toolsets on different stores. The runtime's docs name exactly this case as the reason for `fileTools: false`. What the model loses is the runtime's direct `read` of a scratch file, which matters mainly for images and PDFs, shown natively. Two ways to cover that:
- The scratch files a model looks at are mostly attachments (shown natively already) and tool outputs (shown as file references natively already).
- For anything else, `fs.readFile` in js_exec returns bytes. If viewing a scratch image directly matters, the general fix is a runtime option to keep only `read` among the file tools (gap 8), not turning all of them on.

**Prompt.** Replace the preamble line at `runtime-agent.ts:50` with a short, explicit contract:
> Two filesystems. `/workspace` is this conversation's scratch space: attachments, tool outputs and your own intermediate files. Read and write it with `fs` in js_exec, and hand a file to the user with `present_file`; it is private to this conversation and deleted with it. The camelAI workspace (location `workspace`, `project` or `r2`) is the user's durable storage, shared with their apps and other chats: use the camel__ file tools for it. To keep a scratch file, copy it there with `camel__import_file`.

This agrees with the runtime's environment section instead of contradicting it. Existing agents only get it if chiridion sends `systemPromptAppend` again. So record a prompt version in `thread_runtime.configured`, and have `ensureConfiguredAgent` PATCH the prompt when the version changes. The runtime appends the change as a system message where the conversation stands, so the provider's cached prefix holds (runtime README §System prompts).

**From scratch into camelAI** (the agent-side "save to workspace"). Add one chiridion tool, `import_file {source: {"$file": "/workspace/..."}, location, path, project?}`:
- Its `source` field is a URL (`format: "uri"`), so the runtime offers the `{"$file"}` marker there and fills in a 15-minute signed GET link (`src/tool-files.ts`).
- The tool streams that link into WorkspaceFilesystemDO, R2 or a project.
- This needs no new runtime feature and moves no bytes through the model.

The reverse direction (a camelAI file into scratch, for `fs` processing) is `camel__read` for text. For binaries, it would be a `camel__export_file` that returns an MCP resource or image, which the runtime saves under `tool-outputs/`. That can wait.

## 3. User uploads as runtime attachments

**Today, on runtime threads:**
- The browser uploads to R2 (`api/workspaces/:id/upload`, key `…/user-uploads/<name>`).
- The message text carries `(user uploaded file to uploads/<name>)` references (`chat-attachment-refs.ts`).
- The model reads the file with `camel__read {location: "r2", path: "uploads/…"}`. Images come back as MCP image blocks, but only after a tool call, and PDFs arrive as text.
- On the DO path, the DO hydrated images into the user message instead. Runtime threads lost that.

**Recommendation: keep R2 as the upload store, and also attach.**
- When `startRuntimeTurn` sends a message that references uploads, the Worker streams each file from R2 into `PUT /v1/agents/:id/uploads/<requestId>/<name>` (requestId = clientMessageId, already idempotent) and adds `files: [{path}]` to the prompt.
- The model then gets native image and PDF blocks, with the runtime's size handling (5 MiB and 8,000 px for images; PDFs within its page and size limits) and its sandboxed inspection.
- The R2 copy stays, so `camel__` tools, apps, projects, previews and other threads keep working exactly as now. The upload text reference stays too, telling the model where the durable copy is.
- Cost: uploads are stored twice (R2 and runtime chunks). Uploads are small next to everything else, and the runtime copy goes with the thread.

**Why not upload straight to the runtime** (a signed PUT link, browser → runtime):
- Every non-runtime consumer (deploys, notebooks, apps, file previews, the workspace file browser) would need a copy anyway.
- Chiridion's file-safety check (`file-safety.ts`) and upload bookkeeping run on its own upload path.
- It would also need CORS on `/v1/links` for browser PUTs (gap 5).
- Revisit it only if large uploads through the Worker become a problem. The Worker only streams, R2 → runtime, so there's no size issue up to the runtime's 256 MiB.

**UI.**
- The composer is unchanged.
- In the transcript, a runtime user message now carries file references (`{type: "file", path, contentType, size, media}` content parts). Today `pi-render` keeps only text parts (`textOf`), so they're dropped.
- `pi-render` should turn them into the existing attachment chips (`chat-file-preview/file-preview-chip.tsx`), pointing at the R2 copy when the upload reference is in the text, otherwise at the scratch file (§4).

## 4. Showing scratch files in chiridion's UI

**Presented files.**
- The model calls `present_file {path, caption?}`. The runtime emits a `file_presented` event with a 15-minute signed `url`, and records the call and result in history.
- **Live:** add `file_presented` to `BROWSER_TOKEN_EVENTS` (`thread-runtime.ts:42`). `useRuntimeThread` gets it through the watcher's `onEvent`.
- **History:** the `present_file` tool call is in history, but links expire, so a reload needs a fresh one:
  - Add `GET /api/threads/:id/files/*path`: access check, then `POST /v1/volumes/<volumeId>/links {path, expiresIn: 300}`, then a `302` to the link.
  - Chiridion never stores links, and the browser never gets a volume id or a tenant token.
  - A `?inline=1` variant proxies the first N KB for text previews, as the existing file-preview routes do.
- **Rendering:** a `present_file` tool call renders as a file card (name, type, size, caption) with Open, Download and Save to workspace.

**Preview panel.**
- Add a `PreviewTarget` file source, `"scratch"`, with `threadId` and `path`. Build its URLs from the route above in `file-preview-urls.ts`.
- Images, PDFs, CSV and text preview inline.
- HTML: the runtime serves it as an attachment with `CSP: sandbox`, so HTML reports won't render inline from the link. Show them through chiridion's existing sandboxed preview (which serves workspace files), after Save to workspace, or via a proxied route with the same sandbox headers chiridion already uses.

**Save to workspace (UI).**
- `POST /api/threads/:id/files/save {path, location, targetPath}`.
- The Worker streams `GET /v1/volumes/<id>/files/<path>` into the workspace store, and returns the workspace path so the card can open the saved copy.
- It shares its implementation with the `camel__import_file` tool (§2).

**Tool outputs** (`tool-outputs/…`, e.g. `camel__generate_image` results) are already file references in the toolResult, and pi-render should render them the same way (chip plus preview). This also fixes images from tool results not being rendered today.

## 5. Large tool results in `/workspace/tool-results`

- `feat/dx-server` d116915 cuts a direct tool's result past 32,000 characters and saves the whole result to `tool-results/<call>.txt`, telling the model to read it in parts. `camel__` tools are direct tools, so this will apply to chiridion's big results (`camel__read` of a large file, `connections_query` rows).
- **Problem:** with `fileTools: false` the model has no runtime `read`, and `camel__read` can't reach `/workspace`. The notice must tell it to use `fs.readFile` (or `tools.read` windows) in js_exec. That's a general runtime fix: the spill notice should follow the agent's `fileTools` (gap 6).
- **UI:** the toolResult shows the cut text plus a file reference; pi-render renders the reference as a chip, so "View full result" opens it through §4's route.
- **Cost:** negligible. These are text, and deleted with the thread.

## 6. Analysis-only threads: the runtime volume as the only workspace?

It's possible for a thread that only reads connections and writes charts or CSVs: `fs`, `present_file` and attachments cover that loop. It breaks everything that treats the workspace as shared and durable:

| What breaks | Why |
|---|---|
| Other threads and teammates can't see the results | The volume is per agent. The workspace file browser and @-mentions of files read chiridion's store. |
| Apps and deploys (`deploy_project`, app bindings) | They read WorkspaceFilesystemDO, R2 or project containers, never the runtime volume. |
| Notebooks (`run_notebook`), project VMs, bash | They run in chiridion's containers against chiridion's filesystem. |
| Previews of HTML reports | Sandboxed as attachments (§4). |
| Retention, export, org deletion, admin views | They are built on chiridion's store. Runtime chunks outlive deletion until the runtime has GC (gap 1). |
| Egress cost | Runtime downloads leave AWS (~$0.09/GB); R2 egress is free. |
| Deciding up front that a thread is "analysis-only" | Threads change purpose mid-conversation ("now make it an app"). |

**Verdict:** no. Scratch plus promote-on-demand gives analysis threads the same speed without the dead ends.

A future variant worth keeping in mind: a **per-workspace runtime volume** mounted read-write at `/shared` in every thread of a workspace (per-agent `mounts` at creation, or `PUT /v1/agents/:id/mounts`). That would make runtime files shared, but it duplicates chiridion's workspace filesystem, and it only makes sense if WorkspaceFilesystemDO itself moves onto runtime volumes. That's a separate, larger decision.

## 7. Security, isolation, costs, runtime gaps

**Isolation.**
- Chiridion is one runtime tenant for all orgs, so isolation between orgs rests on each thread's agent mounting only its own default volume.
- Chiridion never passes `mounts`, never gives a browser a volume id, a tenant token or a link-minting capability, and mints every link after `validateChatWebSocketAccess` for that thread. That keeps a scratch file visible only to the thread's own viewers.
- Browser tokens can't read files (their scopes are events, state, history and inputs), which is right.
- `{"$file"}` arguments only resolve paths inside the calling agent's mounts (`..` and outside paths are refused).

**Signed links.**
- They are bearer URLs: whoever has one can download that one file until it expires, and it can't be revoked.
- Keep them short (5 minutes for opens via chiridion's redirect). `file_presented`'s 15-minute default is acceptable because the event only reaches the thread's watchers.
- Links carry the token in the URL path. That's the runtime's design, unlike browser tokens, which travel in headers. It's acceptable for single-file, short-lived grants, but they will show up in proxy logs.
- The tenant must still own the volume, so deleting a thread kills its links.

**Content safety.**
- Runtime downloads are served with `nosniff`, `CSP: sandbox` for everything but PDFs, and `attachment` for active types.
- The runtime parses uploads (PDF and image inspection) in its sandbox.
- Chiridion keeps its own file-safety pass on uploads, because they still go through R2 first (§3).

**Costs** (chiridion's runtime tenant; check whether it's billed, open question 1):
- Storage: $0.10/GB-month runtime price, against about $0.023 S3 underneath. Chunks aren't collected after deletion (gap 1).
- Downloads: AWS egress, about $0.09/GB, versus free R2 egress.
- Upload attachments: a second copy of each upload.
- At expected scratch sizes (MBs per thread) this is small. The unbounded term is deleted threads' chunks until GC exists.

**Runtime gaps (general-product features, not chiridion-specific):**
1. **Chunk garbage collection.** Deleted volumes, files and snapshots keep their chunks, and keep being charged. Any tenant whose agents create and delete scratch has an ever-growing bill.
2. **Quotas per volume and per tenant** (bytes and file count), with a clear error to the model at the limit.
3. **Tenant-token file routes by agent and mount path:** `GET /v1/agents/:id/files`, `GET /v1/agents/:id/files/<path>`, `POST /v1/agents/:id/links`. These mirror the `/clients/:id` routes, so a relaying server needn't look up volume ids. Nice to have; §4 works with `/v1/volumes/:id/*` today.
4. **`file_presented` for browser tokens.** Confirm it passes the token's `events` allow-list like other event types, and that its `url` isn't redacted for browser tokens.
5. **CORS on `/v1/links`** for browser PUT and GET, if direct browser uploads ever become the chosen path. Not needed for the recommendation.
6. **Spill notice follows `fileTools`.** With `fileTools: false`, point the model at `fs.readFile` / `tools.read` in js_exec, not a `read` tool it doesn't have (d116915).
7. **Volume TTL / idle expiry** for an agent's default workspace, if product wants scratch to expire before its thread.
8. **Finer file-tool selection:** for example `fileTools: ["read"]`, so an app with its own write tools can still let the model *view* a scratch image or PDF natively without a second write toolset.

## 8. Phased plan and recommendation

| Phase | Work | Size |
|---|---|---|
| **1. Make scratch explicit** | Record the default volume id in `thread_runtime.configured` at agent creation. Replace the preamble line with the two-filesystem contract (§2), and add a prompt version so existing agents get it at their next send. `GET /api/threads/:id/files/*` (access check → 5-minute link → 302; `?inline=1` for text). `file_presented` in `BROWSER_TOKEN_EVENTS`. pi-render: `present_file` calls, `file` parts and tool-output references become file cards and chips. | S–M: ~400 lines, 2–3 days |
| **2. Save to workspace** | `camel__import_file` (a `{"$file"}` source → WorkspaceFilesystemDO / R2 / project), with the same code behind `POST /api/threads/:id/files/save` and the card's "Save to workspace". A preview-panel `"scratch"` source. | M: ~500 lines, 3–4 days |
| **3. Uploads as attachments** | In `startRuntimeTurn`, stream referenced R2 uploads to `PUT /v1/agents/:id/uploads/<requestId>/<name>` and add `files: [{path}]`. Chips point at the R2 copy. Tests with image, PDF, CSV and an unsafe type. | S–M: ~300 lines, 2 days |
| **4. Large results** | Once gap 6 lands: pi-render chip for `tool-results/` references, "View full result". | S: ~100 lines |
| **Later** | Production enablement after runtime gaps 1–2. Per-workspace shared volume (§6) only if the workspace filesystem itself moves to the runtime. | — |

**Recommendation.** Do phases 1–3:
- Use the per-thread default volume as private scratch, kept with `fileTools: false`, with a prompt contract that names both filesystems.
- Show presented files and tool outputs in chat through chiridion-minted short links.
- Promote to the camelAI workspace on demand, from the UI or through `camel__import_file`.
- Send uploads as native attachments while R2 stays their home.

Don't make the runtime volume the workspace for any class of thread. Ask the runtime for chunk GC and per-volume quotas (gaps 1–2) before this reaches production.

## Open questions
1. Is chiridion's runtime tenant billed (prepaid) or an unbilled admin tenant? That decides whether scratch storage is a real line item for us today.
2. Should scratch expire before its thread (volume TTL, gap 7), or live exactly as long as the thread?
3. Is a second copy of every upload (R2 + runtime) acceptable, or should attachments go only to the runtime, with R2 written only when a camelAI tool needs the file? The recommendation is to accept the copy.
4. Should scratch files be visible to everyone who can see the thread (the recommendation, matching thread access), or only to the thread's creator?
5. Do HTML reports in scratch need inline preview before Save to workspace? If so, what's the preferred proxied, sandboxed route (§4)?
6. Should the agent promote files itself (`camel__import_file`) without asking, or should saving to the shared workspace always be the user's action?
