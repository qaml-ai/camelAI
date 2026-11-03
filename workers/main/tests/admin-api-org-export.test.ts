/** Organization backup boundaries and read-only RPCs. All runtime/storage calls are local or stubbed. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { env as cloudflareEnv, runInDurableObject } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import { allowedExportR2Key, exportCursor, readExportCursor, redactExportConfig, readOrgExportManifest, readOrgExportPage } from '../src/org-export';
import type { Env } from '../src/types';
import type { WorkspaceFilesystemEnv } from '../src/workspace-filesystem-do';
import { WorkspaceFilesystemDO } from '../src/workspace-filesystem-do';

const env = cloudflareEnv as unknown as Env & { WORKSPACE_CRON: NonNullable<Env['WORKSPACE_CRON']> };

const manifest = { org: { id: 'org-a', name: 'A', slug: 'a' }, record_sets: [] };
function fixture() {
  const ownership = vi.fn(async (kind: string, id: string) => {
    if (kind === 'workspace' && id === 'ws-a') return { id };
    if (kind === 'thread' && ['thread-a', 'thread-do'].includes(id)) return { id, workspace_id: 'ws-a', runtime: id === 'thread-a' ? { agent_id: 'agent-a' } : null };
    if (kind === 'app' && id === 'app-a') return { script_name: id, workspace_id: 'ws-a' };
    return null;
  });
  const org = { readOrgExportManifest: vi.fn(async () => manifest), readOrgExportOwnership: ownership,
    readOrgExportPage: vi.fn(async () => ({ items: [], cursor: null })), getInfo: vi.fn(() => { throw new Error('Mutating accessor'); }) };
  const fs = { readOrgExportProject: vi.fn(async (id: string) => id === 'project-a' ? { id } : null), readOrgExportFiles: vi.fn(async () => ({ items: [], cursor: null })),
    readOrgExportProjects: vi.fn(async () => ({ items: [], cursor: null })), readOrgExportFile: vi.fn(async () => ({ stream: new Response('file').body })),
    mintProjectArtifactReadToken: vi.fn(async () => null), mintProjectArtifactToken: vi.fn(() => { throw new Error('Creating accessor'); }), ensureProjectArtifactRepo: vi.fn() };
  const r2 = { get: vi.fn(async () => ({ body: new Response('object').body })), list: vi.fn(async () => ({ objects: [], truncated: false })) };
  const chat = { readOrgExportHistory: vi.fn(async (before?: number) => before === 2 ? { entries: [{ index: 0, message: { role: 'user', content: 'old' } }], next: null } : { entries: [{ index: 2, message: { role: 'assistant', content: [] } }], next: 2 }) };
  const kv = { list: vi.fn(async () => ({ keys: [{ name: 'selfhost:user-kv/ws-a/app-a--a/default/key' }], list_complete: true })), get: vi.fn(async () => new Response('value').body) };
  const namespace = (stub: object) => ({ idFromName: (id: string) => `do-${id}`, get: vi.fn(() => stub) });
  const testEnv = { ORG: namespace(org), WORKSPACE_FS: namespace(fs), CHAT_THREAD: namespace(chat), APP_KV: kv, R2_BUCKET: r2, ADMIN_API_KEY: 'test-key', AGENT_RUNTIME_URL: 'https://runtime.invalid', AGENT_RUNTIME_API_TOKEN: 'runtime-secret' } as unknown as Env;
  async function request(endpoint: string, method = 'GET', key = 'test-key') {
    const req = new Request(`http://local/api/admin/org-export/org-a${endpoint}`, { method, headers: { Authorization: `Bearer ${key}` } });
    return (await handleAdminApi({ req, env: testEnv, ctx: {} as ExecutionContext, url: new URL(req.url), match: [''] }))!;
  }
  return { request, org, fs, r2, chat, kv, testEnv };
}
afterEach(() => vi.unstubAllGlobals());

describe('org export scope', () => {
  it('requires the normal admin key', async () => {
    const f = fixture(); expect((await f.request('/manifest', 'GET', 'bad')).status).toBe(401); expect(f.org.readOrgExportManifest).not.toHaveBeenCalled();
  });
  it('rejects foreign workspace, project, thread, agent, volume and app before reading storage', async () => {
    const f = fixture(), fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const endpoint of ['/workspaces/ws-b/fs', '/workspaces/ws-b/fs/content?path=/a', '/workspaces/ws-a/projects/project-b/fs', '/workspaces/ws-a/projects/project-b/fs/content?path=/a', '/threads/thread-b/history', '/threads/thread-a/agents/agent-b/volumes', '/workspaces/ws-a/apps/app-b/kv', '/workspaces/ws-b/apps/app-a/kv']) {
      expect((await f.request(endpoint)).status, endpoint).toBe(404);
    }
    expect((await f.request('/workspaces/ws-a/projects/project-b/git-token', 'POST')).status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled(); expect(f.fs.readOrgExportFiles).not.toHaveBeenCalled(); expect(f.fs.readOrgExportFile).not.toHaveBeenCalled(); expect(f.kv.list).not.toHaveBeenCalled();
    fetcher.mockResolvedValue(Response.json([{ volumeId: 'volume-a', path: '/workspace', mode: 'rw', subpath: '/held' }]));
    expect((await f.request('/threads/thread-a/agents/agent-a/volumes/volume-b/files?path=/held')).status).toBe(404);
    fetcher.mockResolvedValue(Response.json([{ volumeId: 'volume-a', path: '/workspace', mode: 'rw', subpath: '/held' }]));
    expect((await f.request('/threads/thread-a/agents/agent-a/volumes/volume-a/files/content?path=/outside')).status).toBe(404);
  });
  it('pages volume files and keeps runtime cursors scoped to the same subpath', async () => {
    const f = fixture(), fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json([{ volumeId: 'v', path: '/workspace', mode: 'rw', subpath: '/uploads' }]))
      .mockResolvedValueOnce(Response.json({ files: [{ path: '/uploads/a', size: 1 }], next: '/uploads/a' }))
      .mockResolvedValueOnce(Response.json([{ volumeId: 'v', path: '/workspace', mode: 'rw', subpath: '/uploads' }]))
      .mockResolvedValueOnce(Response.json({ files: [{ path: '/uploads/b', size: 1 }] }));
    vi.stubGlobal('fetch', fetcher);
    const endpoint = '/threads/thread-a/agents/agent-a/volumes/v/files';
    const first = await (await f.request(`${endpoint}?path=/uploads&limit=1`)).json() as { cursor: string };
    expect(readExportCursor('volume:v:/uploads', first.cursor)).toBe('/uploads/a');
    expect(await (await f.request(`${endpoint}?path=/uploads&limit=1&cursor=${encodeURIComponent(first.cursor)}`)).json()).toMatchObject({ items: [{ path: '/uploads/b' }], cursor: null });
    expect(fetcher.mock.calls[3][0]).toContain('after=%2Fuploads%2Fa');
  });
  it('round-trips Unicode cursors and refuses cursor reuse across scopes', () => {
    const cursor = exportCursor('files:/資料', '/資料/é');
    expect(readExportCursor('files:/資料', cursor)).toBe('/資料/é');
    expect(() => readExportCursor('files:/other', cursor)).toThrow('Invalid export cursor');
  });
  it('uses only the read token RPC, and explains a missing repo', async () => {
    const f = fixture(); const response = await f.request('/workspaces/ws-a/projects/project-a/git-token', 'POST');
    expect(response.status).toBe(404); expect(await response.json()).toEqual({ error: 'Project has no existing Artifacts repository' });
    expect(f.fs.mintProjectArtifactReadToken).toHaveBeenCalledWith('project-a'); expect(f.fs.mintProjectArtifactToken).not.toHaveBeenCalled(); expect(f.fs.ensureProjectArtifactRepo).not.toHaveBeenCalled();
  });
  it('pages runtime history with byte limit and passes raw entries through', async () => {
    const f = fixture(), message = { role: 'toolResult', toolCallId: 't', details: { exact: true }, content: [] };
    const fetcher = vi.fn(async (_url: string) => Response.json({ entries: [{ index: 3, message }], next: 3 })); vi.stubGlobal('fetch', fetcher);
    const response = await f.request('/threads/thread-a/history?before=12&limit=2');
    expect(await response.json()).toEqual({ entries: [{ index: 3, message }], next: 3 });
    expect(String(fetcher.mock.calls[0][0])).toContain('/v1/agents/agent-a/history?limit=2&maxBytes=2000000&before=12');
    expect(f.chat.readOrgExportHistory).not.toHaveBeenCalled();
  });
  it('pages ChatThreadDO history and rejects invalid bounds', async () => {
    const f = fixture(); expect(await (await f.request('/threads/thread-do/history?limit=1')).json()).toMatchObject({ next: 2 });
    expect(await (await f.request('/threads/thread-do/history?limit=1&before=2')).json()).toMatchObject({ next: null, entries: [{ index: 0 }] });
    expect(f.chat.readOrgExportHistory).toHaveBeenLastCalledWith(2, 1);
    expect((await f.request('/threads/thread-do/history?limit=10000')).status).toBe(400);
  });
  it('streams volume files only after checking the live agent mounts', async () => {
    const f = fixture(), fetcher = vi.fn().mockResolvedValueOnce(Response.json([{ volumeId: 'v', path: '/workspace', mode: 'rw' }])).mockResolvedValueOnce(new Response(new Uint8Array([0, 255, 4])));
    vi.stubGlobal('fetch', fetcher);
    const response = await f.request('/threads/thread-a/agents/agent-a/volumes/v/files/content?path=/uploads/a');
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([0, 255, 4]);
    expect(fetcher.mock.calls[1][0]).toBe('https://runtime.invalid/v1/volumes/v/files/uploads/a');
  });
  it('does not echo upstream errors or secrets', async () => {
    const f = fixture(); vi.stubGlobal('fetch', vi.fn(async () => new Response('runtime-secret Bearer credential', { status: 500 })));
    const response = await f.request('/threads/thread-a/history'); expect(response.status).toBe(502);
    expect(await response.text()).not.toContain('runtime-secret');
  });
  it('reads app virtual KV with the dispatch script prefix and includes binary values', async () => {
    const f = fixture(); expect(await (await f.request('/workspaces/ws-a/apps/app-a/kv')).json()).toMatchObject({ items: [{ key: 'default/key', value_base64: btoa('value') }] });
    expect(f.kv.list).toHaveBeenCalledWith({ prefix: 'selfhost:user-kv/ws-a/app-a--a/', limit: 1 });
  });
});

describe('R2 guards', () => {
  const prefixes = ['org-a/ws-a/', 'workspace-fs/do-ws-a/', 'project-fs/do-project-a/default/', 'deploy-artifacts/org-a/ws-a/', 'app-previews/org-a/ws-a/', 'user-data/ws-a/'];
  it('allows all real prefixes and rejects ambiguous, lookalike and foreign keys', () => {
    for (const prefix of prefixes) expect(allowedExportR2Key(`${prefix}file`, prefixes)).toBe(true);
    for (const key of ['org-b/ws-b/file', 'org-ax/ws-a/file', 'org-a/ws-b/file', 'org-a/ws-a/../file', 'org-a/ws-a//file', 'org-a/ws-a/./file', '/org-a/ws-a/file', 'org-a/ws-a/\\file', 'org-a/ws-a/\0file', 'unrelated/file', 'user-data/ws-ax/file']) expect(allowedExportR2Key(key, prefixes), key).toBe(false);
  });
  it('checks ownership before listing or streaming each allowed prefix', async () => {
    const f = fixture();
    for (const prefix of prefixes) {
      const query = new URLSearchParams({ workspaceId: 'ws-a', projectId: 'project-a', bucket: 'R2_BUCKET', key: `${prefix}file` });
      expect((await f.request(`/r2/object?${query}`)).status, prefix).toBe(200);
      query.delete('key'); query.set('prefix', prefix);
      expect((await f.request(`/r2?${query}`)).status, prefix).toBe(200);
    }
    f.r2.get.mockClear(); f.r2.list.mockClear();
    for (const key of ['org-b/ws-b/a', 'org-ax/ws-a/a', 'org-a/ws-a/../a', 'other/a']) {
      expect((await f.request(`/r2/object?workspaceId=ws-a&key=${enc(key)}`)).status).toBe(404);
    }
    expect((await f.request('/r2?workspaceId=ws-b&prefix=org-a/ws-b/')).status).toBe(404);
    expect((await f.request('/r2/object?workspaceId=ws-a&bucket=OTHER&key=org-a/ws-a/a')).status).toBe(404);
    expect((await f.request('/r2/object?workspaceId=ws-a&projectId=project-b&key=project-fs/do-project-b/default/a')).status).toBe(404);
    expect(f.r2.get).not.toHaveBeenCalled(); expect(f.r2.list).not.toHaveBeenCalled();
  });
});
const enc = encodeURIComponent;

describe('read-only storage accessors', () => {
  it('allowlists metadata and recursively redacts integration configuration', async () => {
    const fs = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(`export-sql-${crypto.randomUUID()}`));
    await runInDurableObject(fs, async (_instance, state) => {
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE org_info (key TEXT PRIMARY KEY, value TEXT)');
      sql.exec('INSERT INTO org_info VALUES (?, ?)', 'data', JSON.stringify({ id: 'org-a', name: 'A', provider_api_key: 'bad', password_hash: 'bad', credentials_encrypted: 'bad' }));
      sql.exec('INSERT INTO org_info VALUES (?, ?)', 'enterprise_oidc_config', JSON.stringify({ enabled: true, issuer: 'https://id.example', client_secret_encrypted: 'bad', token: 'bad' }));
      sql.exec('CREATE TABLE integrations (id TEXT, config TEXT, credentials_encrypted TEXT)');
      sql.exec('INSERT INTO integrations VALUES (?, ?, ?)', 'i', JSON.stringify({ host: 'example', api_key: 'bad', nested: [{ accessToken: 'bad', password: 'bad', safe: 1 }] }), 'bad');
      const before = sql.exec('SELECT total_changes() AS changes').one().changes;
      const result = { manifest: readOrgExportManifest(sql), integrations: readOrgExportPage(sql, 'integrations') };
      expect(JSON.stringify(result)).not.toContain('bad'); expect(JSON.stringify(result)).not.toContain('credentials_encrypted'); expect(JSON.stringify(result)).not.toContain('password_hash');
      expect(result.integrations.items[0].config).toEqual({ host: 'example', api_key: '[REDACTED]', nested: [{ accessToken: '[REDACTED]', password: '[REDACTED]', safe: 1 }] });
      expect(sql.exec('SELECT total_changes() AS changes').one().changes).toBe(before);
    });
    expect(redactExportConfig({ privateKey: 'hidden', nested: { passwd: 'hidden' } })).toEqual({ privateKey: '[REDACTED]', nested: { passwd: '[REDACTED]' } });
  });
  // Each object still runs its own startup (schema migration, alarm recovery); the export reads themselves write nothing.
  it('export reads write no rows and set no alarms in org, user, cron, filesystem or chat storage', async () => {
    const id = `empty-${crypto.randomUUID()}`;
    const org = env.ORG.get(env.ORG.idFromName(id));
    const user = env.USER.get(env.USER.idFromName(id));
    const cron = env.WORKSPACE_CRON.get(env.WORKSPACE_CRON.idFromName(id));
    const fs = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(id));
    const chat = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(id));
    const stubs = [org, user, cron, fs, chat];
    const snapshot = () => Promise.all(stubs.map(stub => runInDurableObject(stub as typeof fs, async (_instance, state) => {
      const tables = state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '_cf%' ORDER BY name").toArray();
      const rows = tables.map(({ name }) => [name, state.storage.sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${name}"`).one().n]);
      return { rows, alarm: await state.storage.getAlarm() };
    })));
    const before = await snapshot();
    expect(await org.readOrgExportManifest()).toBeNull(); expect(await user.readOrgExportProfile()).toBeNull();
    expect(await cron.readOrgExportAutomations('prompts')).toEqual({ items: [], cursor: null });
    expect(await fs.readOrgExportFiles()).toEqual({ items: [], cursor: null });
    expect(await chat.readOrgExportHistory()).toEqual({ entries: [], next: null });
    expect(await snapshot()).toEqual(before);
  });
  it('pages actual pi_core rows without modifying tables, metadata or alarms', async () => {
    const stub = env.CHAT_THREAD.get(env.CHAT_THREAD.idFromName(`pi-export-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('CREATE TABLE pi_core_messages (idx INTEGER PRIMARY KEY, payload TEXT, created_at INTEGER)');
      for (const idx of [0, 3, 8]) state.storage.sql.exec('INSERT INTO pi_core_messages VALUES (?, ?, ?)', idx, JSON.stringify({ role: 'user', content: String(idx) }), idx);
    });
    expect(await stub.readOrgExportHistory(undefined, 2)).toMatchObject({ entries: [{ index: 3 }, { index: 8 }], next: 3 });
    expect(await stub.readOrgExportHistory(3, 2)).toMatchObject({ entries: [{ index: 0 }], next: null });
  });
  it('pages stored records, hidden files, symlinks and project clones without creating file tables', async () => {
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(`files-export-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (instance, state) => {
      const sql = state.storage.sql;
      sql.exec('CREATE TABLE workspaces (id TEXT, name TEXT, archived INTEGER)');
      sql.exec("INSERT INTO workspaces VALUES ('old', 'Archived', 1), ('new', 'Current', 0)");
      const first = readOrgExportPage(sql, 'workspaces', undefined, 1);
      expect(first.items).toEqual([{ id: 'old', name: 'Archived', archived: 1 }]);
      expect(readOrgExportPage(sql, 'workspaces', first.cursor, 1)).toEqual({ items: [{ id: 'new', name: 'Current', archived: 0 }], cursor: null });
      sql.exec('CREATE TABLE cf_workspace_default (path TEXT, type TEXT, size INTEGER, mime_type TEXT, target TEXT, created_at INTEGER, modified_at INTEGER)');
      for (const path of ['/a', '/.hidden', '/link']) sql.exec('INSERT INTO cf_workspace_default VALUES (?, ?, 1, ?, ?, 0, 0)', path, path === '/link' ? 'symlink' : 'file', 'text/plain', path === '/link' ? '/a' : null);
      state.storage.kv.put('projects:v1', ['a', 'b'].map(id => ({ id, name: id, description: '', defaultVmId: 'main', backend: 'do-r2', createdAt: 'now', updatedAt: 'now', ...(id === 'b' ? { kind: 'clone', clonedFromProjectId: 'a' } : {}) })));
      const before = sql.exec('SELECT total_changes() AS n').one().n;
      const files = instance.readOrgExportFiles('/', undefined, 2);
      expect(files.items.map(row => row.path)).toEqual(['/.hidden', '/a']);
      expect(instance.readOrgExportFiles('/', files.cursor, 2)).toMatchObject({ items: [{ path: '/link', type: 'symlink', target: '/a' }], cursor: null });
      const projects = await instance.readOrgExportProjects(undefined, 1);
      expect((await instance.readOrgExportProjects(projects.cursor, 1)).items).toMatchObject([{ id: 'b', kind: 'clone' }]);
      expect(sql.exec('SELECT total_changes() AS n').one().n).toBe(before);
    });
  });
  it('mints only read tokens and never invokes Artifacts.create, including for missing metadata', async () => {
    const stub = env.WORKSPACE_FS.get(env.WORKSPACE_FS.idFromName(`git-export-${crypto.randomUUID()}`));
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.kv.put('projects:v1', [{ id: 'p', name: 'P', description: '', defaultVmId: 'main', backend: 'do-r2', createdAt: 'now', updatedAt: 'now', artifactRepoName: 'repo', artifactRemote: 'https://example/repo.git' }]);
      const create = vi.fn(), createToken = vi.fn(async () => ({ plaintext: 'short-token' }));
      const reader = new WorkspaceFilesystemDO(state, { ARTIFACTS: { get: async () => ({ createToken }), create } } as unknown as WorkspaceFilesystemEnv);
      expect(await reader.mintProjectArtifactReadToken('missing')).toBeNull();
      expect(await reader.mintProjectArtifactReadToken('p')).toMatchObject({ token: 'short-token', scope: 'read', ttlSeconds: 300 });
      expect(createToken).toHaveBeenCalledWith('read', 300); expect(create).not.toHaveBeenCalled();
    });
  });
});
