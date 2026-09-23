import { createServer, type ServerResponse } from 'node:http';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync, mkdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { build } from 'vite';
import { startExamples } from '../examples/studio-launcher.ts';
import { snapshotAgent, type RegistrySnapshot } from './registry.ts';
import { writeDurableJson } from '../shared/durable-json.ts';
import type { AgentView, Run } from './types.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(process.env.STUDIO_DATA_DIR ?? '.agent-runtime/studio');
mkdirSync(root, { recursive: true, mode: 0o700 });
function stored<T>(name: string, fallback: T): T {
  try { return JSON.parse(readFileSync(join(root, name), 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return fallback; }
}
const secret = stored('secrets.json', { operator: randomBytes(32).toString('hex'), owner: randomBytes(32).toString('hex') });
writeDurableJson(join(root, 'secrets.json'), secret);
const apiKey = process.env.AGENT_API_KEY ?? process.env.OPENROUTER_API_KEY;
const provider = process.env.AGENT_PROVIDER ?? (process.env.OPENROUTER_API_KEY ? 'openrouter' : 'anthropic');
const model = process.env.AGENT_MODEL ?? (provider === 'openrouter' ? 'anthropic/claude-sonnet-4.6' : 'claude-sonnet-4-5');
const viewers = new Set<ServerResponse>();
const boards = new Map<string, AgentView>();
function changed(board?: AgentView, persist = false) {
 if (persist && board) writeDurableJson(join(root, `${board.id}-runs.json`), board.runs);
 for (const res of viewers) if (!res.write('data: changed\n\n')) { viewers.delete(res); res.destroy(); }
}
const children = new Set<ChildProcess>();
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return; shuttingDown = true;
  for (const res of viewers) res.end();
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
process.on('exit', () => { for (const child of children) child.kill('SIGTERM'); });
const env = { ...process.env, AGENT_RUNTIME_TOKEN: secret.operator, AGENT_API_KEY: apiKey, AGENT_PROVIDER: provider, AGENT_MODEL: model, AGENT_SYSTEM_PROMPT: process.env.AGENT_SYSTEM_PROMPT, AGENT_DATA_DIR: join(root, 'runtime'), AGENT_CLIENT_STATE_DIR: join(root, 'clients'), STUDIO_DATA_DIR: root, HOST: '127.0.0.1', PORT: '0' };
const args = process.versions.bun ? [] : ['--experimental-strip-types'];
const host = spawn(process.execPath, [...args, join(here, '../src/server.ts')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
children.add(host);
const ready = Promise.withResolvers<string>();
const hostTimer = setTimeout(() => ready.reject(new Error('Runtime startup timed out')), 15000);
host.on('error', ready.reject);
host.on('exit', () => { ready.reject(new Error('Runtime exited')); if (!shuttingDown) { console.error('Runtime exited; stopping studio'); void shutdown(); } });
createInterface({ input: host.stdout! }).on('line', line => {
  try { const item = JSON.parse(line); if (item.type === 'listening') ready.resolve(`http://127.0.0.1:${item.address.port}`); } catch { /* runtime logging */ }
});
let base: string;
try { base = await ready.promise; } finally { clearTimeout(hostTimer); }

async function runtimeApi(path: string, body?: unknown) {
 const response = await fetch(base + path, { headers: { Authorization: `Bearer ${secret.operator}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, method: body ? 'POST' : 'GET', body: body ? JSON.stringify(body) : undefined });
 const result = await response.json();
 if (!response.ok) throw new Error(result.error ?? `Runtime HTTP ${response.status}`);
 return result;
}
const { examples, aliases } = process.env.STUDIO_EXAMPLES === '0'
 ? { examples: new Map<string, import('../examples/studio-launcher.ts').Example>(), aliases: new Map<string, string>() }
 : await startExamples(root, { ...env, AGENT_URL: base }, children);
let refreshing: Promise<void> | undefined;
function refresh() {
 return refreshing ??= (async () => {
   const registered: { id: string }[] = await runtimeApi('/registry');
   let updated = false;
   for (const { id } of registered) {
     const snapshot: RegistrySnapshot = await runtimeApi(`/registry/${id}`);
     const previous = boards.get(id);
     const next = snapshotAgent(snapshot, previous?.runs ?? stored<Run[]>(`${id}-runs.json`, []));
     const example = examples.get(id);
     if (example) { next.scripted = true; next.suggestions = example.suggestions; }
     if (JSON.stringify(next) !== JSON.stringify(previous)) {
       boards.set(id, next); writeDurableJson(join(root, `${id}-runs.json`), next.runs); updated = true;
     }
   }
   for (const id of boards.keys()) if (!registered.some(a => a.id === id)) { boards.delete(id); updated = true; }
   if (updated) changed();
 })().finally(() => { refreshing = undefined; });
}
await refresh();
const polling = setInterval(() => { if (!shuttingDown) void refresh().catch(error => console.error('Registry refresh:', error.message)); }, 500);
process.on('SIGTERM', () => clearInterval(polling));
await build({ configFile: join(here, 'vite.config.ts'), logLevel: 'warn' });
let origin = '';
function equal(a: string, b: string) { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
const server = createServer(async (req, res) => {
  const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value)); };
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    if (req.headers.host !== new URL(origin).host) return json({ error: 'Invalid host' }, 403);
    if (req.headers.origin && req.headers.origin !== origin) return json({ error: 'Cross-origin access denied' }, 403);
    const url = new URL(req.url!, origin);
    const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('studio_owner='))?.slice(13) ?? '';
    const owner = equal(cookie, secret.owner);
    let body: any = {};
    if (req.method === 'POST') {
      if (req.headers.origin !== origin || !req.headers['content-type']?.startsWith('application/json')) return json({ error: 'Same-origin JSON required' }, 403);
      let data = ''; for await (const chunk of req) { data += chunk; if (Buffer.byteLength(data) > 16000) return json({ error: 'Request too large' }, 413); }
      body = JSON.parse(data || '{}');
    }
    if (url.pathname === '/api/unlock' && req.method === 'POST') {
      if (typeof body.token !== 'string' || !equal(body.token, secret.owner)) return json({ error: 'Invalid developer link' }, 403);
      res.setHeader('Set-Cookie', `studio_owner=${secret.owner}; HttpOnly; SameSite=Strict; Path=/`); return json({ ok: true });
    }
    if (url.pathname === '/api/agents' && req.method === 'GET') {
      if (!owner) return json({ error: 'Open the developer link printed in your terminal to access Studio.' }, 403);
      await refresh();
      return json({ live: !!apiKey, model: apiKey ? `${provider}/${model}` : 'No model configured', owner, agents: [...boards.values()].map(({ id, name, type, connected }) => ({ id, name, type, connected })) });
    }
    if (url.pathname === '/api/events' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Accel-Buffering': 'no' }); res.write('data: connected\n\n'); viewers.add(res);
      const pulse = setInterval(() => res.write(': heartbeat\n\n'), 10000);
      res.on('close', () => { clearInterval(pulse); viewers.delete(res); }); return;
    }
    const match = /^\/api\/(agents|inspect)\/(client_[a-f0-9]{40})(?:\/(run|abort|review))?$/.exec(url.pathname);
    if (match) {
      const [, section, id, action] = match;
      await refresh();
      const board = boards.get(id);
      if (!board) return json({ error: 'Agent not found' }, 404);
      if (section === 'inspect' && !owner) return json({ error: 'Open the developer link printed in your terminal to inspect traces.' }, 403);
      if (req.method === 'GET' && !action) return json(section === 'inspect' ? board : { id: board.id, name: board.name, connected: board.connected, busy: board.busy, suggestions: board.suggestions, chatEnabled: !!apiKey, runs: board.runs.filter(run => run.mode === 'live').map(({ id, prompt, mode, started, ended, status, answer }) => ({ id, prompt, mode, started, ended, status, answer })) });
      if (req.method === 'POST' && action === 'run') {
        if (body.mode === 'scripted' && !owner) return json({ error: 'Developer access required for scripted examples.' }, 403);
        if (board.busy) return json({ error: 'This agent already has a running turn.' }, 409);
        if (!board.connected) return json({ error: 'Application tools are offline.' }, 503);
        if (!['live', 'scripted'].includes(body.mode) || (body.mode === 'live' && !apiKey) || (body.mode === 'scripted' && !examples.has(id))) return json({ error: 'Live mode requires a configured model key.' }, 400);
        if (typeof body.prompt !== 'string' || !body.prompt.trim() || body.prompt.length > 8000) return json({ error: 'Enter a prompt of 1–8000 characters.' }, 400);
        const requestId = randomUUID();
        await runtimeApi(`/registry/${id}/requests`, { id: requestId, method: body.mode === 'live' ? 'prompt' : 'execute', params: body.mode === 'live' ? { text: body.prompt.trim() } : { code: examples.get(id)!.script } });
        await refresh(); return json({ id: requestId }, 202);
      }
      if (req.method === 'POST' && action === 'abort') {
        if (!board.busy) return json({ ok: true });
        await runtimeApi(`/registry/${id}/requests`, { id: randomUUID(), method: 'abort', params: {} });
        const current = board.runs.find(r => r.status === 'running');
        if (current) current.status = 'cancelled';
        changed(board, true); return json({ ok: true });
      }
      if (req.method === 'POST' && section === 'inspect' && action === 'review') {
        const item = board.runs.find(r => r.id === body.id);
        if (!item || !['good', 'needs-work'].includes(body.verdict) || typeof body.note !== 'string' || body.note.length > 2000) return json({ error: 'Invalid review' }, 400);
        item.review = { verdict: body.verdict, note: body.note }; changed(board, true); return json({ ok: true });
      }
      return json({ error: 'Method not allowed' }, 405);
    }
    if (url.pathname.startsWith('/api/')) return json({ error: 'Not found' }, 404);
    if (req.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
    const oldPath = /^\/(?:a|inspect)\/([^/]+)$/.exec(url.pathname) ?? /^\/studio\/agents\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (oldPath && aliases.has(oldPath[1])) {
      const agentId = aliases.get(oldPath[1]);
      const target = url.pathname.startsWith('/a/') ? `/a/${agentId}` : `/studio/agents/${agentId}/${oldPath[2] ?? 'runs'}`;
      res.writeHead(302, { Location: target }).end(); return;
    }
    if (url.pathname === '/') { res.writeHead(302, { Location: '/studio/agents' }).end(); return; }
    const agentHome = /^\/studio\/agents\/(client_[a-f0-9]{40})(?:\/(application))?$/.exec(url.pathname);
    if (agentHome && boards.has(agentHome[1])) {
      res.writeHead(302, { Location: `/studio/agents/${agentHome[1]}/${agentHome[2] ? 'configuration' : 'chat'}` }).end(); return;
    }
    const route = /^\/a\/(client_[a-f0-9]{40})$/.exec(url.pathname)
      ?? /^\/studio\/agents\/(client_[a-f0-9]{40})\/(runs(?:\/[a-zA-Z0-9_-]+)?|chat|configuration)$/.exec(url.pathname);
    const page = url.pathname === '/studio/agents' || (route && boards.has(route[1]));
    if (!page && !/^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname)) return json({ error: 'Page not found' }, 404);
    const asset = /^\/assets\/[a-zA-Z0-9_.-]+$/.test(url.pathname) ? join(here, 'dist', url.pathname) : join(here, 'dist/index.html');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Content-Type', extname(asset) === '.js' ? 'text/javascript' : extname(asset) === '.css' ? 'text/css' : 'text/html');
    res.end(await readFile(asset));
  } catch (error) { if (!res.headersSent) json({ error: error instanceof Error ? error.message : String(error) }, 400); else res.end(); }
});
server.requestTimeout = 15000;
server.listen(Number(process.env.STUDIO_PORT ?? 8789), '127.0.0.1', () => {
  const address = server.address() as { port: number }; origin = `http://127.0.0.1:${address.port}`;
  const developerUrl = `${origin}/studio/agents#token=${secret.owner}`;
  console.log(`\nAgent Studio · ${apiKey ? 'live model enabled' : 'no model key'}\nAgents: ${origin}/studio/agents\nRuntime: ${base}\nDeveloper: ${developerUrl}\nData: ${root}\n`);
  writeDurableJson(join(root, 'studio.json'), { origin, runtimeUrl: base, developerUrl });
});
server.on('error', error => { console.error(error.message); void shutdown(); });
