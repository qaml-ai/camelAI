import { AgentRuntime, tool, schema, type AgentClient } from '../clients/node.ts';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const root = await mkdtemp(join(tmpdir(), 'agent-studio-test-'));
let child: ChildProcess | undefined;
let origin = '', cookie = '', runtimeUrl = '';
let third: AgentClient | undefined;
async function until<T>(fn: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 40000;
  while (Date.now() < deadline) {
    const value = await fn(); if (value !== undefined) return value;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Timed out waiting for studio');
}
async function start() {
  const env = { ...process.env, STUDIO_DATA_DIR: root, STUDIO_PORT: '0', AGENT_API_KEY: '', OPENROUTER_API_KEY: '' };
  child = spawn(process.execPath, [fileURLToPath(new URL('./server.ts', import.meta.url))], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  let output = ''; child.stdout!.on('data', b => { output += b; });
  await until(async () => {
    if (child!.exitCode !== null) throw new Error('Studio exited during startup');
    return output.includes('Developer:') ? true : undefined;
  });
  const state = JSON.parse(await readFile(join(root, 'studio.json'), 'utf8'));
  origin = state.origin; runtimeUrl = state.runtimeUrl;
  const token = new URL(state.developerUrl).hash.slice('#token='.length);
  const response = await request('/api/unlock', { token }, false);
  assert.equal(response.status, 200); cookie = response.headers.get('set-cookie')!.split(';')[0];
  await until(async () => { const state = await (await request('/api/agents')).json(); return state.agents.filter((a: any) => ['release-reviewer', 'inventory-planner'].includes(a.type)).length >= 2 && state.agents.filter((a: any) => ['release-reviewer', 'inventory-planner'].includes(a.type)).every((a: any) => a.connected) ? true : undefined; });
}
async function stop() { if (child && child.exitCode === null) { const done = once(child, 'close'); child.kill('SIGTERM'); await done; } }
function request(path: string, body?: unknown, owner = true, requestOrigin = origin) {
  return fetch(origin + path, { method: body === undefined ? 'GET' : 'POST', headers: { ...(owner ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { Origin: requestOrigin, 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
}
try {
  await start();
  const registry = await (await request('/api/agents')).json();
  const release = registry.agents.find((a: any) => a.type === 'release-reviewer').id;
  const inventory = registry.agents.find((a: any) => a.type === 'inventory-planner').id;
  const legacy = await fetch(origin + '/inspect/release', { redirect: 'manual' });
  assert.equal(legacy.status, 302);
  assert.equal(legacy.headers.get('location'), `/studio/agents/${release}/runs`);
  for (const path of ['/studio/agents', `/a/${release}`, `/a/${inventory}`, `/studio/agents/${release}/runs`, `/studio/agents/${inventory}/configuration`, `/studio/agents/${release}/chat`]) assert.equal((await fetch(origin + path)).status, 200);
  assert.equal((await fetch(origin + '/a/missing')).status, 404);
  assert.equal((await request('/api/agents', undefined, false)).status, 403);
  for (const [suffix, target] of [['', 'chat'], ['/application', 'configuration']]) {
    const redirect = await fetch(origin + `/studio/agents/${release}${suffix}`, { redirect: 'manual' });
    assert.equal(redirect.status, 302); assert.equal(redirect.headers.get('location'), `/studio/agents/${release}/${target}`);
  }
  assert.equal((await request(`/api/agents/${release}/run`, { mode: 'scripted', prompt: 'test' }, false)).status, 403);
  assert.equal((await request(`/api/inspect/${release}`, undefined, false)).status, 403);
  assert.equal((await request(`/api/agents/${release}/run`, { mode: 'scripted', prompt: 'test' }, false, 'https://evil.example')).status, 403);
  const ids: Record<string, string> = {};
  for (const id of [release, inventory]) {
    const response = await request(`/api/agents/${id}/run`, { mode: 'scripted', prompt: 'test' });
    assert.equal(response.status, 202); ids[id] = (await response.json()).id;
  }
  for (const id of [release, inventory]) {
    const board: any = await until(async () => { const b = await (await request(`/api/inspect/${id}`)).json(); return b.runs.find((r: any) => r.id === ids[id])?.status !== 'running' ? b : undefined; });
    const run = board.runs.find((r: any) => r.id === ids[id]);
    assert.equal(run.status, 'completed', JSON.stringify(run));
    assert.ok(run.traces.some((t: any) => t.kind === 'tool'));
    if (id === release) assert.match(JSON.stringify(run.traces), /HOLD release/);
    else assert.deepEqual(run.traces.filter((t: any) => t.name === 'plan_restock').map((t: any) => t.result.quantity).sort(), [24, 32]);
    const publicBoard = await (await request(`/api/agents/${id}`, undefined, false)).json();
    assert.equal(publicBoard.systemPrompt, undefined); assert.equal(publicBoard.toolDefinitions, undefined);
    assert.deepEqual(publicBoard.runs, []); // Developer code executions are not chat messages.
    assert.equal(publicBoard.tools, undefined); assert.equal(publicBoard.type, undefined);
    assert.equal(publicBoard.chatEnabled, false);
    assert.deepEqual(await (await request(`/api/agents/${id}`)).json(), publicBoard); // Same public contract even with an owner cookie.
  }
  assert.equal((await request(`/api/inspect/${release}/review`, { id: ids[release], verdict: 'good', note: 'Verified state update' })).status, 200);
  assert.equal((await request(`/api/inspect/${release}/review`, { id: ids[release], verdict: 'good', note: '' }, false)).status, 403);
  // An unrelated SDK client appears with no changes to the dashboard or launcher.
  const secrets = JSON.parse(await readFile(join(root, 'secrets.json'), 'utf8'));
  const runtime = new AgentRuntime({ url: runtimeUrl, apiKey: secrets.operator, stateDirectory: join(root, 'third-client') });
  third = await runtime.createAgent({ name: 'Docs launch', type: 'release-reviewer', tools: { echo: tool({ description: 'Echo a number', input: schema.Object({ value: schema.Number() }), execute: ({ value }) => ({ value }) }) } });
  await third.execute('return await tools.echo({value:42});');
  const extra = await (await request(`/api/inspect/${third.session.id}`)).json();
  assert.equal(extra.name, 'Docs launch'); assert.equal(extra.type, 'release-reviewer');
  assert.equal(extra.runs[0].traces.find((t: any) => t.name === 'echo').result.value, 42);
  assert.equal((await fetch(origin + `/a/${third.session.id}`)).status, 200);
  assert.equal((await fetch(origin + `/studio/agents/${third.session.id}/runs/${extra.runs[0].id}`)).status, 200);
  await third.setMetadata({ name: 'Documentation review', type: 'docs-reviewer' });
  const renamed = await (await request('/api/agents')).json();
  assert.equal(renamed.agents.find((a: any) => a.id === third!.session.id).type, 'docs-reviewer');
  await third.close();
  await stop(); await start();
  const resumed = await (await request(`/api/inspect/${release}`)).json();
  assert.equal(resumed.runs[0].id, ids[release]);
  assert.equal(resumed.runs[0].review.note, 'Verified state update');
  const extraResumed = await (await request(`/api/inspect/${third.session.id}`)).json();
  assert.equal(extraResumed.name, 'Documentation review'); assert.equal(extraResumed.connected, false);
  assert.equal(extraResumed.runs[0].traces.find((t: any) => t.name === 'echo').result.value, 42);
  console.log('Studio smoke passed: TS + Python tools, dynamic SDK discovery, rename/regroup, private traces, reviews, and restart persistence.');
} finally { await third?.close(); await stop(); await rm(root, { recursive: true, force: true }); }
