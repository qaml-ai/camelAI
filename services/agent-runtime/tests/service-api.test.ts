import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredModel } from '../src/model.ts';
import { assertTrustedEndpoint } from '../src/session-config.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }, env: (root: string) => Record<string, string> = () => ({})) {
  const root = await mkdtemp(join(tmpdir(), 'agent-service-api-'));
  const operator = 'operator-fixture-secret-at-least-24-chars';
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_RUNTIME_TOKEN: operator, AGENT_API_KEY: 'host-fixture-key', PORT: '0', HOST: '127.0.0.1', ...env(root) } as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) { const closed = once(child, 'close'); child.kill('SIGTERM'); await closed; }
    await rm(root, { recursive: true, force: true });
  });
  const ready = Promise.withResolvers<number>();
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; if (output.includes('\n')) ready.resolve(JSON.parse(output.split('\n')[0]).address.port); });
  child.on('error', ready.reject);
  child.on('exit', code => ready.reject(new Error(`Server exited: ${code}`)));
  const base = `http://127.0.0.1:${await ready.promise}`;
  const headers = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
  const post = (path: string, body: unknown, token = operator) => fetch(base + path, { method: 'POST', headers: headers(token), body: JSON.stringify(body) });
  const get = (path: string, token = operator) => fetch(base + path, { headers: headers(token) });
  return { root, post, get, child };
}

test('operator provisioning imports native history once; scoped reads do not journal transcript copies', async t => {
  const f = await fixture(t);
  const initialMessages = [{ role: 'user', content: 'preserve-native-history', timestamp: 1 }];
  const response = await f.post('/client-sessions', { tools: [], model: configuredModel(), thinkingLevel: 'low', initialMessages });
  assert.equal(response.status, 201);
  const session = await response.json() as any;
  const path = `/clients/${session.id}`;
  assert.equal((await f.get(path + '/history')).status, 401, 'operator token is not a scoped credential');
  assert.equal((await f.get(path + '/history', 'wrong-scoped-token')).status, 401);
  const history = await (await f.get(path + '/history', session.token)).json() as any;
  assert.deepEqual(history.messages, initialMessages);
  const saved = JSON.parse(await readFile(join(f.root, 'client-sessions', session.id + '.json'), 'utf8'));
  assert.equal(saved.config.initialMessages, undefined);
  assert.equal('requests' in saved, false);
  // Reads are served from the transcript log; they add nothing to the session journal.
  await assert.rejects(readFile(join(f.root, 'client-sessions', session.id + '.journal.jsonl'), 'utf8'), /ENOENT/);
  assert.equal(JSON.stringify(saved).includes('host-fixture-key'), false);
});

test('scoped configuration persists allowed fields and rejects provider credentials or endpoints', async t => {
  const f = await fixture(t);
  const response = await f.post('/client-sessions', { tools: [] });
  const session = await response.json() as any;
  const path = `/clients/${session.id}`;
  for (const params of [{ model: configuredModel() }, { apiKey: 'secret' }, { initialMessages: [] }]) {
    assert.equal((await f.post(path + '/requests', { id: 'invalid', method: 'configure', params }, session.token)).status, 400);
  }
  const params = { systemPrompt: 'You inspect test fixtures.', thinkingLevel: 'high', tools: [{ name: 'inspect', description: 'Inspect a fixture', parameters: { type: 'object', properties: {} }, exposure: 'direct' }] };
  assert.equal((await f.post(path + '/requests', { id: 'config', method: 'configure', params }, session.token)).status, 202);
  let record: any;
  for (let i = 0; i < 100; i++) {
    record = await (await f.get(path + '/requests/config', session.token)).json();
    if (record.state !== 'running') break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(record.outcome.error, undefined);
  const saved = JSON.parse(await readFile(join(f.root, 'client-sessions', session.id + '.json'), 'utf8'));
  assert.equal(saved.config.systemPrompt, params.systemPrompt);
  assert.equal(saved.config.thinkingLevel, 'high');
  assert.deepEqual(saved.definitions, params.tools);
});

test('operator model configuration accepts endpoints but never persists supplied credentials', async t => {
  const f = await fixture(t);
  for (const extra of [
    { apiKey: 'should-not-persist' },
    { model: { ...configuredModel(), headers: { Authorization: 'Bearer should-not-persist' } } },
    { model: { ...configuredModel(), baseUrl: 'https://user:pass@example.test/v1' } },
    { model: { ...configuredModel(), baseUrl: 'https://example.test/v1?key=secret' } },
    // The host provider key must never be sent to an endpoint the operator did not trust.
    { model: { ...configuredModel(), baseUrl: 'https://collector.example.test/v1' } },
    { model: { ...configuredModel(), maxTokens: -1 } },
    { thinkingLevel: 'invalid' },
  ]) assert.equal((await f.post('/client-sessions', { tools: [], ...extra })).status, 400);
});

test('trusted endpoints are the default model, Pi published endpoints, and the operator allowlist', () => {
  const base = configuredModel();
  assertTrustedEndpoint({ ...base, baseUrl: base.baseUrl + '/' }, base);
  const gateway = { ...base, baseUrl: 'https://gateway.example.test/v1/anthropic' };
  assert.throws(() => assertTrustedEndpoint(gateway, base), /not trusted/);
  assertTrustedEndpoint(gateway, base, ['https://gateway.example.test/v1/anthropic/']);
  assert.throws(() => assertTrustedEndpoint({ ...gateway, baseUrl: 'https://gateway.example.test/v1/other' }, base, ['https://gateway.example.test/v1/anthropic']), /not trusted/);
});

test('tenants provision and see only their own agents, billed to their own provider keys', async t => {
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  const alice = 'alice-operator-token-at-least-24-chars', bob = 'bob-operator-token-at-least-24-chars', carol = 'carol-operator-token-at-least-24-chars';
  const tenantsFile = (root: string) => join(root, 'tenants.json');
  const tenants = (extra = {}) => JSON.stringify({ tenants: {
    alice: { tokenSha256: sha(alice), apiKeys: { [configuredModel().provider]: 'alice-provider-key' } },
    bob: { tokenSha256: sha(bob), apiKeys: {} }, ...extra,
  } });
  let path = '';
  const f = await fixture(t, root => {
    path = tenantsFile(root);
    writeFileSync(path, tenants());
    return { AGENT_TENANTS_FILE: path, AGENT_RUNTIME_TOKEN: '', AGENT_SESSION_SECRET: 'fixture-session-secret-with-32-characters!' };
  });
  assert.equal((await fetch(new URL('/healthz', (await f.get('/registry', alice)).url))).status, 200);
  assert.equal((await f.post('/client-sessions', { tools: [] }, 'operator-fixture-secret-at-least-24-chars')).status, 401, 'legacy token is not a tenant');
  const created = await f.post('/client-sessions', { tools: [], name: 'Alice agent' }, alice);
  assert.equal(created.status, 201);
  const agent = await created.json() as any;
  const missingKey = await f.post('/client-sessions', { tools: [] }, bob);
  assert.equal(missingKey.status, 400);
  assert.match((await missingKey.json() as any).error, /No .* API key is configured for tenant bob/);
  assert.deepEqual((await (await f.get('/registry', alice)).json() as any[]).map(a => a.name), ['Alice agent']);
  assert.deepEqual(await (await f.get('/registry', bob)).json(), []);
  assert.equal((await f.get(`/registry/${agent.id}`, bob)).status, 400);
  assert.equal((await f.post(`/registry/${agent.id}/requests`, { id: 'cross', method: 'status', params: {} }, bob)).status, 401);
  assert.equal((await f.post(`/registry/${agent.id}/requests`, { id: 'own', method: 'status', params: {} }, alice)).status, 202);
  // The same idempotency key in another tenant is a different agent.
  const sameKey = (token: string) => fetch(new URL('/client-sessions', (created as Response).url), { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'shared-key' }, body: JSON.stringify({ tools: [] }) });
  await writeFile(path, tenants({ carol: { tokenSha256: sha(carol), apiKeys: { '*': 'carol-provider-key' } } }));
  f.child.kill('SIGHUP');
  let carolAgent: Response | undefined;
  for (let i = 0; i < 50 && carolAgent?.status !== 201; i++) { carolAgent = await sameKey(carol); if (carolAgent.status !== 201) await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.equal(carolAgent!.status, 201);
  const aliceShared = await sameKey(alice);
  assert.notEqual((await aliceShared.json() as any).id, (await carolAgent!.json() as any).id);
  const header = JSON.parse(await readFile(join(f.root, 'client-sessions', `${agent.id}.json`), 'utf8'));
  assert.equal(header.tenant, 'alice');
  assert.equal(JSON.stringify(header).includes('alice-provider-key'), false);
});
