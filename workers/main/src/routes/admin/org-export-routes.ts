/** One-org backup reads. Ownership precedes every storage/runtime read; errors never echo upstream credentials. */
import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { openApi } from 'hono-zod-openapi';
import { z } from 'zod';
import type { Env } from '../../types.js';
import type { OrgDO } from '../../identity/org-do.js';
import type { UserDO } from '../../identity/user-do.js';
import type { WorkspaceFilesystemDO } from '../../workspace-filesystem-do.js';
import type { ChatThreadDO } from '../../chat-thread-do.js';
import type { WorkspaceCronDO } from '../../workspace-cron.js';
import { runtimeUrl } from '../../agent-runtime/runtime-api.js';
import { normalizeGlobalProjectId } from '../../project-vm-protocol.js';
import { allowedExportR2Key, exportCursor, readExportCursor, ORG_EXPORT_SETS, safeExportKey, type ExportRow, type OrgExportSet } from '../../org-export.js';

type HonoEnv = { Bindings: Env; Variables: { exportManifest: ExportRow } };
type Ctx = Pick<Context<HonoEnv>, 'env' | 'req'>;
const base = '/org-export/:orgId';
const pageQuery = z.object({ cursor: z.string().max(8192).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const responseSchema = { 200: { schema: z.record(z.string(), z.unknown()), mediaType: 'application/json' }, 404: z.object({ error: z.string() }) };
const binaryResponseSchema = { 200: { schema: z.string(), mediaType: 'application/octet-stream' }, 404: z.object({ error: z.string() }) };
export const orgExportRoutes = new Hono<HonoEnv>();
const notFound = (reason = 'Not found') => new HTTPException(404, { message: reason });
const org = (c: Ctx) => c.env.ORG.get(c.env.ORG.idFromName(c.req.param('orgId')!)) as unknown as Pick<OrgDO, 'readOrgExportManifest' | 'readOrgExportOwnership' | 'readOrgExportPage'>;
const filesystem = (c: Ctx, id: string) => c.env.WORKSPACE_FS.get(c.env.WORKSPACE_FS.idFromName(id)) as unknown as Pick<WorkspaceFilesystemDO, 'readOrgExportProjects' | 'readOrgExportProject' | 'readOrgExportFiles' | 'readOrgExportFile' | 'mintProjectArtifactReadToken'>;
function segment(value: string): string {
  if (!value || !safeExportKey(value) || value.includes('/')) throw notFound();
  return value;
}
async function workspace(c: Ctx, id: string) {
  segment(id);
  const row = await org(c).readOrgExportOwnership('workspace', id);
  if (!row) throw notFound();
  return row;
}
async function project(c: Ctx, workspaceId: string, projectId: string) {
  await workspace(c, workspaceId); segment(projectId);
  const row = await filesystem(c, workspaceId).readOrgExportProject(projectId);
  if (!row) throw notFound();
  return row;
}
async function thread(c: Ctx) {
  const id = segment(c.req.param('threadId')!);
  const row = await org(c).readOrgExportOwnership('thread', id);
  if (!row) throw notFound();
  await workspace(c, String(row.workspace_id));
  return row;
}
async function app(c: Ctx) {
  const workspaceId = c.req.param('workspaceId')!;
  await workspace(c, workspaceId);
  const row = await org(c).readOrgExportOwnership('app', segment(c.req.param('scriptName')!));
  if (!row || row.workspace_id !== workspaceId) throw notFound();
  return row;
}
function cursor(scope: string, value?: string) {
  try { return readExportCursor(scope, value); } catch { throw new HTTPException(400, { message: 'Invalid export cursor' }); }
}
function filePath(value: string) {
  if (value !== '/' && (!value.startsWith('/') || !safeExportKey(value.slice(1)))) throw notFound();
  return value;
}
async function runtimeRead(c: Ctx, path: string): Promise<Response> {
  const result = await fetch(`${runtimeUrl(c.env)}${path}`, { headers: { Authorization: `Bearer ${c.env.AGENT_RUNTIME_API_TOKEN ?? ''}` }, redirect: 'error' });
  if (!result.ok) {
    await result.body?.cancel();
    throw new HTTPException(result.status === 404 ? 404 : result.status === 429 ? 429 : 502, { message: 'Runtime export read failed' });
  }
  return result;
}
function stream(body: ReadableStream | null) {
  return new Response(body, { headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
}

orgExportRoutes.use(`${base}/*`, async (c, next) => {
  try {
    segment(c.req.param('orgId')!);
    const manifest = await org(c).readOrgExportManifest();
    if (!manifest || (manifest.org as ExportRow)?.id !== c.req.param('orgId')) throw notFound();
    c.set('exportManifest', manifest);
    c.header('Cache-Control', 'no-store');
    await next();
  } catch (error) {
    if (error instanceof HTTPException) return c.json({ error: error.message }, error.status);
    return c.json({ error: 'Export read failed' }, 500);
  }
});
// Hono catches handler errors before middleware resumes. Keep export errors local and generic.
orgExportRoutes.onError((error, c) => error instanceof HTTPException
  ? c.json({ error: error.message }, error.status) : c.json({ error: 'Export read failed' }, 500));

orgExportRoutes.get(`${base}/manifest`, openApi({ summary: 'Organization settings and export record-set index', responses: responseSchema }), c => c.json(c.get('exportManifest')));
orgExportRoutes.get(`${base}/records/:set`, openApi({ summary: 'One bounded page of organization records', request: { query: pageQuery }, responses: responseSchema }), async c => {
  const set = c.req.param('set');
  if (!Object.hasOwn(ORG_EXPORT_SETS, set) || set === 'threads') throw notFound();
  const q = c.req.valid('query'); cursor(set, q.cursor);
  const page = await org(c).readOrgExportPage(set as OrgExportSet, q.cursor, q.limit);
  if (set === 'members') for (const member of page.items) {
    const profile = await (c.env.USER.get(c.env.USER.idFromName(String(member.user_id))) as unknown as Pick<UserDO, 'readOrgExportProfile'>).readOrgExportProfile();
    member.profile = profile;
  }
  return c.json(page);
});
orgExportRoutes.get(`${base}/threads`, openApi({ summary: 'Thread metadata and runtime placement', request: { query: pageQuery }, responses: responseSchema }), async c => {
  const q = c.req.valid('query'); cursor('threads', q.cursor);
  return c.json(await org(c).readOrgExportPage('threads', q.cursor, q.limit));
});
orgExportRoutes.get(`${base}/threads/:threadId/history`, openApi({ summary: 'Raw Pi history, ascending within each newest-first page', request: { query: z.object({ before: z.coerce.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }) }, responses: responseSchema }), async c => {
  const row = await thread(c), q = c.req.valid('query');
  const placement = row.runtime as ExportRow | null;
  if (placement) {
    if (!placement.agent_id) return c.json({ entries: [], next: null });
    const query = new URLSearchParams({ limit: String(q.limit), maxBytes: '2000000' });
    if (q.before !== undefined) query.set('before', String(q.before));
    return c.json(await (await runtimeRead(c, `/v1/agents/${encodeURIComponent(String(placement.agent_id))}/history?${query}`)).json());
  }
  return c.json(await (c.env.CHAT_THREAD.get(c.env.CHAT_THREAD.idFromName(String(row.id))) as unknown as Pick<ChatThreadDO, 'readOrgExportHistory'>).readOrgExportHistory(q.before, q.limit));
});

type Mount = { volumeId: string; path: string; mode: string; subpath?: string };
async function mounts(c: Ctx): Promise<Mount[]> {
  const row = await thread(c), agentId = segment(c.req.param('agentId')!);
  if ((row.runtime as ExportRow | null)?.agent_id !== agentId) throw notFound();
  return await (await runtimeRead(c, `/v1/agents/${encodeURIComponent(agentId)}/mounts`)).json() as Mount[];
}
const agentBase = `${base}/threads/:threadId/agents/:agentId/volumes`;
orgExportRoutes.get(agentBase, openApi({ summary: 'Volumes mounted by this thread agent', request: { query: pageQuery }, responses: responseSchema }), async c => {
  const q = c.req.valid('query'), scope = `mounts:${c.req.param('agentId')}`;
  const after = cursor(scope, q.cursor) ?? '';
  const all = (await mounts(c)).sort((a, b) => a.path < b.path ? -1 : 1).filter(m => m.path > after);
  const items = all.slice(0, q.limit).map(m => ({ volumeId: m.volumeId, path: m.path, mode: m.mode, subpath: m.subpath ?? '/' }));
  return c.json({ items, cursor: all.length > items.length ? exportCursor(scope, items.at(-1)!.path) : null });
});
async function volume(c: Ctx, path: string) {
  const id = segment(c.req.param('volumeId')!);
  const found = (await mounts(c)).filter(m => m.volumeId === id);
  if (!found.some(m => { const root = filePath(m.subpath ?? '/'); return root === '/' || path === root || path.startsWith(`${root}/`); })) throw notFound();
  return id;
}
orgExportRoutes.get(`${agentBase}/:volumeId/files`, openApi({ summary: 'One page of mounted volume files', request: { query: pageQuery.extend({ path: z.string().default('/') }) }, responses: responseSchema }), async c => {
  const q = c.req.valid('query'), path = filePath(q.path), id = await volume(c, path);
  const scope = `volume:${id}:${path}`, after = cursor(scope, q.cursor);
  const query = new URLSearchParams({ prefix: path, limit: String(q.limit) });
  if (after) query.set('after', after);
  const page = await (await runtimeRead(c, `/v1/volumes/${encodeURIComponent(id)}/files?${query}`)).json() as { files: ExportRow[]; next?: string };
  if (page.files.some(file => typeof file.path !== 'string' || (path !== '/' && file.path !== path && !file.path.startsWith(`${path}/`)))) throw new Error('Invalid runtime file scope');
  return c.json({ items: page.files, cursor: page.next ? exportCursor(scope, page.next) : null });
});
orgExportRoutes.get(`${agentBase}/:volumeId/files/content`, openApi({ summary: 'Stream one mounted volume file', request: { query: z.object({ path: z.string() }) }, responses: binaryResponseSchema }), async c => {
  const path = filePath(c.req.valid('query').path), id = await volume(c, path);
  return stream((await runtimeRead(c, `/v1/volumes/${encodeURIComponent(id)}/files/${path.slice(1).split('/').map(encodeURIComponent).join('/')}`)).body);
});

orgExportRoutes.get(`${base}/workspaces/:workspaceId/projects`, openApi({ summary: 'Flat project registry including clones', request: { query: pageQuery }, responses: responseSchema }), async c => {
  const id = c.req.param('workspaceId'); await workspace(c, id);
  const q = c.req.valid('query'); cursor('projects', q.cursor);
  return c.json(await filesystem(c, id).readOrgExportProjects(q.cursor, q.limit));
});
orgExportRoutes.get(`${base}/workspaces/:workspaceId/automations/:kind`, openApi({ summary: 'Scheduled prompts, deterministic automations or source versions', request: { query: pageQuery }, responses: responseSchema }), async c => {
  const id = c.req.param('workspaceId'); await workspace(c, id);
  const kind = c.req.param('kind'); if (kind !== 'prompts' && kind !== 'automations' && kind !== 'versions') throw notFound();
  const q = c.req.valid('query'); cursor(kind, q.cursor);
  return c.json(await (c.env.WORKSPACE_CRON!.get(c.env.WORKSPACE_CRON!.idFromName(id)) as unknown as Pick<WorkspaceCronDO, 'readOrgExportAutomations'>).readOrgExportAutomations(kind, q.cursor, q.limit));
});
for (const projectFiles of [false, true]) {
  const route = `${base}/workspaces/:workspaceId${projectFiles ? '/projects/:projectId' : ''}/fs`;
  async function ownedFs(c: Ctx) {
    const id = c.req.param('workspaceId')!;
    if (!projectFiles) { await workspace(c, id); return filesystem(c, id); }
    const projectId = c.req.param('projectId')!; await project(c, id, projectId);
    return filesystem(c, normalizeGlobalProjectId(projectId));
  }
  orgExportRoutes.get(route, openApi({ summary: 'Page existing filesystem rows, including hidden files and symlink metadata', request: { query: pageQuery.extend({ path: z.string().default('/') }) }, responses: responseSchema }), async c => {
    const fs = await ownedFs(c), q = c.req.valid('query'), path = filePath(q.path); cursor(`files:${path}`, q.cursor);
    return c.json(await fs.readOrgExportFiles(path, q.cursor, q.limit));
  });
  orgExportRoutes.get(`${route}/content`, openApi({ summary: 'Stream file bytes without initializing the filesystem', request: { query: z.object({ path: z.string() }) }, responses: binaryResponseSchema }), async c => {
    const fs = await ownedFs(c), path = filePath(c.req.valid('query').path);
    const file = await fs.readOrgExportFile(path, projectFiles ? 'project' : 'workspace');
    if (!file) throw notFound();
    return stream(file.stream);
  });
}
orgExportRoutes.post(`${base}/workspaces/:workspaceId/projects/:projectId/git-token`, openApi({ summary: 'Five-minute read-only token for an existing Artifacts repository', responses: responseSchema }), async c => {
  const workspaceId = c.req.param('workspaceId'), projectId = c.req.param('projectId');
  await project(c, workspaceId, projectId);
  const token = await filesystem(c, workspaceId).mintProjectArtifactReadToken(projectId);
  if (!token) throw notFound('Project has no existing Artifacts repository');
  return c.json(token);
});

// Scope one workspace (and optionally one of its projects) per request; never enumerate an org inside an R2 read.
const r2Query = pageQuery.extend({ bucket: z.string().default('R2_BUCKET'), workspaceId: z.string(), projectId: z.string().optional() });
async function r2Prefixes(c: Ctx, workspaceId: string, projectId?: string) {
  await workspace(c, workspaceId);
  const orgId = c.req.param('orgId')!;
  const prefixes = [`${orgId}/${workspaceId}/`, `workspace-fs/${c.env.WORKSPACE_FS.idFromName(workspaceId)}/`, `deploy-artifacts/${encodeURIComponent(orgId)}/${encodeURIComponent(workspaceId)}/`, `app-previews/${orgId}/${workspaceId}/`, `user-data/${workspaceId}/`];
  if (projectId) {
    await project(c, workspaceId, projectId);
    prefixes.push(`project-fs/${c.env.WORKSPACE_FS.idFromName(normalizeGlobalProjectId(projectId))}/default/`);
  }
  return prefixes;
}
orgExportRoutes.get(`${base}/r2-prefixes`, openApi({ summary: 'Server-derived prefixes for one owned workspace/project', request: { query: r2Query }, responses: responseSchema }), async c => {
  const q = c.req.valid('query');
  if (q.bucket !== 'R2_BUCKET') throw notFound();
  return c.json({ bucket: q.bucket, prefixes: await r2Prefixes(c, q.workspaceId, q.projectId) });
});
orgExportRoutes.get(`${base}/r2`, openApi({ summary: 'List one page of scoped R2 objects', request: { query: r2Query.extend({ prefix: z.string() }) }, responses: responseSchema }), async c => {
  const q = c.req.valid('query');
  if (q.bucket !== 'R2_BUCKET') throw notFound();
  const prefixes = await r2Prefixes(c, q.workspaceId, q.projectId);
  if (!allowedExportR2Key(q.prefix, prefixes, true)) throw notFound();
  const after = cursor(`r2:${q.prefix}`, q.cursor);
  const page = await c.env.R2_BUCKET.list({ prefix: q.prefix, limit: q.limit, ...(after ? { cursor: after } : {}) });
  if (page.objects.some(object => !allowedExportR2Key(object.key, prefixes))) throw notFound('Unsafe stored R2 key');
  return c.json({ items: page.objects.map(object => ({ key: object.key, size: object.size, etag: object.etag, uploaded: object.uploaded })), cursor: page.truncated ? exportCursor(`r2:${q.prefix}`, page.cursor) : null });
});
orgExportRoutes.get(`${base}/r2/object`, openApi({ summary: 'Stream one scoped R2 object', request: { query: r2Query.extend({ key: z.string() }) }, responses: binaryResponseSchema }), async c => {
  const q = c.req.valid('query');
  if (q.bucket !== 'R2_BUCKET') throw notFound();
  const prefixes = await r2Prefixes(c, q.workspaceId, q.projectId);
  if (!allowedExportR2Key(q.key, prefixes)) throw notFound();
  const object = await c.env.R2_BUCKET.get(q.key);
  if (!object) throw notFound();
  return stream(object.body);
});
orgExportRoutes.get(`${base}/workspaces/:workspaceId/apps/:scriptName/kv`, openApi({ summary: 'App virtual KV values, base64 encoded (one value per page to bound memory)', request: { query: z.object({ cursor: z.string().max(8192).optional() }) }, responses: responseSchema }), async c => {
  const row = await app(c), q = c.req.valid('query');
  const slug = segment(String((c.get('exportManifest').org as ExportRow).slug));
  const prefix = `selfhost:user-kv/${row.workspace_id}/${row.script_name}--${slug}/`;
  const after = cursor(`kv:${prefix}`, q.cursor);
  const page = await c.env.APP_KV.list({ prefix, limit: 1, ...(after ? { cursor: after } : {}) });
  const next = page.list_complete ? null : exportCursor(`kv:${prefix}`, page.cursor);
  const key = page.keys[0];
  if (!key) return c.json({ items: [], cursor: next });
  if (!key.name.startsWith(prefix)) throw notFound();
  const value = await c.env.APP_KV.get(key.name, 'stream');
  if (!value) throw new Error('KV value disappeared during export');
  // KV permits a 25 MiB value. Encode as a stream so JSON/base64 copies never fill the isolate.
  const reader = value.getReader(), encoder = new TextEncoder();
  async function* chunks() {
    yield encoder.encode(`{"items":[{"key":${JSON.stringify(key.name.slice(prefix.length))},"expiration":${key.expiration ?? 'null'},"metadata":${JSON.stringify(key.metadata ?? null)},"value_base64":"`);
    let tail = new Uint8Array(0);
    try {
      for (;;) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const bytes = new Uint8Array(tail.length + chunk.length); bytes.set(tail); bytes.set(chunk, tail.length);
        const end = bytes.length - bytes.length % 3;
        // Each encoded chunk ends at a base64 triple, so only the final tail carries padding.
        for (let i = 0; i < end; i += 12_288) yield encoder.encode(btoa(String.fromCharCode(...bytes.subarray(i, Math.min(i + 12_288, end)))));
        tail = bytes.slice(end);
      }
      if (tail.length) yield encoder.encode(btoa(String.fromCharCode(...tail)));
      yield encoder.encode(`"}],"cursor":${JSON.stringify(next)}}`);
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  const iterator = chunks();
  return new Response(new ReadableStream({
    async pull(controller) { try { const chunk = await iterator.next(); if (chunk.done) controller.close(); else controller.enqueue(chunk.value); } catch (error) { controller.error(error); } },
    async cancel() { await iterator.return(undefined); },
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
});
