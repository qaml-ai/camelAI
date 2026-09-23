/**
 * Start the real Cloudflare app with only its Pi loop moved to a local process.
 * The runtime comes from a checkout of qaml-ai/agent-runtime: AGENT_RUNTIME_DIR,
 * default ../agent-runtime next to this repository (run `npm install` there once).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/** Local-disk commit, so a crash never leaves a truncated secrets file. */
function writeDurableJson(path: string, value: unknown) {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temporary, path);
  const parent = openSync(directory, 'r');
  try { fsyncSync(parent); } finally { closeSync(parent); }
}

const repo = fileURLToPath(new URL('..', import.meta.url));
const runtimeDir = resolve(repo, process.env.AGENT_RUNTIME_DIR ?? '../agent-runtime');
const serverEntry = join(runtimeDir, 'src/server.ts');
if (!existsSync(serverEntry)) {
  console.error(`No agent runtime at ${runtimeDir}. Clone qaml-ai/agent-runtime there (and run npm install), or set AGENT_RUNTIME_DIR.`);
  process.exit(1);
}
const root = resolve(repo, '.agent-runtime/application');
mkdirSync(root, { recursive: true, mode: 0o700 });
const path = join(root, 'secrets.json');
const secrets = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { operator: randomBytes(32).toString('hex'), signing: randomBytes(32).toString('hex') };
writeDurableJson(path, secrets);
const children = new Set<ChildProcess>(); let stopping = false;
function stop() { if (stopping) return; stopping = true; for (const child of children) child.kill('SIGTERM'); setTimeout(() => process.exit(0), 1200); }
process.on('SIGINT', stop); process.on('SIGTERM', stop);
process.on('exit', () => { for (const child of children) child.kill('SIGTERM'); });
const key = process.env.SELFHOST_AI_API_KEY ?? process.env.OPENROUTER_API_KEY;
const host = spawn('node', ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', serverEntry], { env: { ...process.env, HOST: '127.0.0.1', PORT: '0', AGENT_API_KEY: key, AGENT_TOOL_TIMEOUT_MS: '300000', AGENT_RUNTIME_TOKEN: secrets.operator, AGENT_DATA_DIR: join(root, 'runtime') }, stdio: ['ignore', 'pipe', 'inherit'] });
children.add(host);
const ready = Promise.withResolvers<string>();
const timeout = setTimeout(() => ready.reject(new Error('Local runtime startup timed out')), 15000);
host.on('error', ready.reject); host.on('exit', () => { ready.reject(new Error('Runtime exited')); stop(); });
createInterface({ input: host.stdout! }).on('line', line => {
  try { const event = JSON.parse(line); if (event.type === 'listening') ready.resolve(`http://127.0.0.1:${event.address.port}`); else console.log(line); } catch { console.log(line); }
});
let url: string;
try { url = await ready.promise; } finally { clearTimeout(timeout); }
const replay = process.env.LOCAL_AGENT_REPLAY === '1';
if (replay) {
  const fake = spawn(process.execPath, ['scripts/fake-llm.mjs'], { env: { ...process.env, FAKE_LLM_PORT: '8788' }, stdio: 'inherit' }); children.add(fake); fake.on('exit', stop);
}
const app = spawn(process.execPath, ['run', 'dev:local-auth', '--host', '127.0.0.1'], { env: {
  ...process.env, LOCAL_AGENT_RUNTIME_URL: url, LOCAL_AGENT_RUNTIME_TOKEN: secrets.operator,
  TOKEN_SIGNING_SECRET: process.env.TOKEN_SIGNING_SECRET ?? secrets.signing,
  // Skip building containers for chat/file-tool trials. Opt in for build/deploy tools.
  ...(process.env.LOCAL_AGENT_CONTAINERS === '1' ? {} : { E2E_LOCAL: '1' }),
  ...(replay ? { TEST_LLM_REPLAY_URL: 'http://127.0.0.1:8788' } : {}),
  ...(!replay && key ? { SELFHOST_AI_PROVIDER: process.env.SELFHOST_AI_PROVIDER ?? 'custom', SELFHOST_AI_API_KEY: key,
    SELFHOST_AI_API: process.env.SELFHOST_AI_API ?? 'openai-completions',
    SELFHOST_AI_BASE_URL: process.env.SELFHOST_AI_BASE_URL ?? 'https://openrouter.ai/api/v1',
    SELFHOST_AI_MODEL: process.env.SELFHOST_AI_MODEL ?? 'anthropic/claude-sonnet-4.6',
    SELFHOST_AI_NAME: process.env.SELFHOST_AI_NAME ?? 'Local runtime trial' } : {}),
}, stdio: 'inherit' });
children.add(app); app.on('exit', stop); app.on('error', error => { console.error(error.message); stop(); });
writeDurableJson(join(root, 'connection.json'), { runtimeUrl: url, appUrl: 'http://localhost:3001/chat' });
console.log(`Local app: http://localhost:3001/chat\nExternal agent loop: ${url}\nModel: ${replay ? 'deterministic replay' : key ? 'configured self-host provider' : 'configure a provider in the app'}\nNo production deployment is changed.`);
