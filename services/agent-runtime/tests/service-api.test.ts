import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configuredModel } from '../src/model.ts';
import { assertTrustedEndpoint } from '../src/session-config.ts';

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), 'agent-service-api-'));
  const operator = 'operator-fixture-secret-at-least-24-chars';
  const child = spawn(process.execPath, ['--experimental-strip-types', fileURLToPath(new URL('../src/server.ts', import.meta.url))], {
    env: { PATH: process.env.PATH, HOME: root, AGENT_DATA_DIR: root, AGENT_RUNTIME_TOKEN: operator, AGENT_API_KEY: 'host-fixture-key', PORT: '0', HOST: '127.0.0.1' },
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
  return { root, post, get };
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
