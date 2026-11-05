/** Local export machinery: safe names, atomic checkpoints, retries, streaming files and checksums. */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';

export const EXPORT_USAGE = 'bun run org-export -- --env staging|prod --org <orgId> --out <dir> [--concurrency 4]';
export type Row = Record<string, any>;
export function parseExportArgs(args: string[]) {
  const values: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') continue;
    const [key, inline] = args[i].split('=', 2);
    if (!['--env', '--org', '--out', '--concurrency'].includes(key)) throw new Error('Unknown export argument');
    const value = inline ?? args[++i];
    if (!value || value.startsWith('--')) throw new Error(`Missing ${key}`);
    values[key] = value;
  }
  if (values['--env'] !== 'prod' && values['--env'] !== 'staging') throw new Error('--env staging|prod is required');
  if (!values['--org'] || !values['--out']) throw new Error('--org and --out are required');
  const concurrency = Number(values['--concurrency'] ?? 4);
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) throw new Error('--concurrency must be 1..16');
  return { env: values['--env'] as 'prod' | 'staging', orgId: values['--org'], out: path.resolve(values['--out']), concurrency };
}
export const digest = (text: string) => createHash('sha256').update(text).digest('hex');
/** Add a short hash before the extension, preserving whole UTF-8 characters within the disk limit. */
function hashedSegment(value: string, original: string): string {
  const match = /\.[A-Za-z0-9]{1,16}$/.exec(value);
  const extension = match && match.index > 0 ? match[0] : '';
  const stem = (extension ? value.slice(0, -extension.length) : value) || 'name';
  const suffix = `~${digest(original).slice(0, 12)}${extension}`;
  const budget = 255 - Buffer.byteLength(suffix);
  let truncated = '', bytes = 0;
  for (const character of stem) {
    bytes += Buffer.byteLength(character);
    if (bytes > budget) break;
    truncated += character;
  }
  return `${truncated}${suffix}`;
}
/** Preserve customer names unless a segment cannot be safely represented on every supported disk. */
export function portableSegment(value: string): string {
  // oxlint-disable-next-line no-control-regex -- Disk names must exclude controls and Windows-invalid characters.
  let sanitized = value.replace(/[/\\<>:"|?*\x00-\x1f\x7f]/g, '_').replace(/[. ]+$/, ending => '_'.repeat(ending.length));
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(value)) sanitized = `_${sanitized}`;
  if (value && sanitized === value && Buffer.byteLength(value) <= 255) return value;
  return hashedSegment(sanitized, value);
}
export function redactError(error: unknown, secrets: Iterable<string> = []): string {
  let text = error instanceof Error ? error.message : String(error);
  for (const secret of secrets) if (secret) {
    for (const variant of [secret, encodeURIComponent(secret), Buffer.from(secret).toString('base64')]) text = text.split(variant).join('[REDACTED]');
  }
  return text.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/((?:token|api[_-]?key|password|secret)\s*[=:]\s*)[^\s&,;"']+/gi, '$1[REDACTED]');
}
export class ExportHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs = 0) { super(`Export API HTTP ${status}`); }
}
export async function retry<T>(fn: () => Promise<T>, options: { attempts?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<T> {
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= (options.attempts ?? 5) - 1 || (error instanceof ExportHttpError && error.status !== 429 && error.status < 500)) throw error;
      await sleep(Math.min(30_000, Math.max(500 * 2 ** attempt, error instanceof ExportHttpError ? error.retryAfterMs : 0)));
    }
  }
}
export async function boundedMap<T>(items: T[], concurrency: number, fn: (item: T) => Promise<void>) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) { const item = items[index++]; await fn(item); }
  }));
}

export interface ExportState {
  version: 2; orgId: string; baseUrl: string; started: string;
  finished: Record<string, { outputs: string[]; count: number }>;
  warnings: Record<string, string>; mappings: Record<string, string>; claims: Record<string, string>; excluded: string[];
}
// Customer-facing: written into the backup's README.md and manifest.json.
export const EXCLUSIONS = [
  'Passwords, API keys, connection credentials, sign-in sessions, invitation links and SSO secrets. Connection settings are included, with any secret-looking field replaced by [REDACTED].',
  'Data your deployed apps keep in their own Durable Object storage, which can only be read from inside each app.',
  'Data in the databases and services your connections point to. It stays with those providers.',
  "camelAI's saved project versions and revert points. Each project's current files are included, and its git history where it has one.",
  'Warehouse data saved from database queries (Parquet files).',
  'Content types and custom metadata of stored objects. Their contents are included.',
  "Your organization's model provider settings, per-member usage limits and pricing overrides.",
  'Anything deleted or expired before the export ran.',
  'Platform data shared across customers, such as agent runtime snapshots and billing records.',
  'Logs: app logs, audit logs, per-request usage records and automation run history. Your organization\'s usage totals and your automation definitions are included.',
];

export class ExportWriter {
  private checkpoint: Promise<void> = Promise.resolve();
  constructor(readonly root: string, readonly state: ExportState, readonly secrets = new Set<string>()) {}
  static async open(root: string, orgId: string, baseUrl: string, secrets: string[] = []) {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new Error('Export root must not be a symlink');
    let state: ExportState;
    try {
      const checkpoint = path.join(root, '.org-export-state.json');
      if ((await lstat(checkpoint)).isSymbolicLink()) throw new Error('Export checkpoint must not be a symlink');
      state = JSON.parse(await readFile(checkpoint, 'utf8'));
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      state = { version: 2, orgId, baseUrl, started: new Date().toISOString(), finished: {}, warnings: {}, mappings: {}, claims: {}, excluded: [...EXCLUSIONS] };
    }
    if (state.version !== 2 || state.orgId !== orgId || state.baseUrl !== baseUrl) throw new Error('Existing export belongs to a different organization, environment or format');
    return new ExportWriter(root, state, new Set(secrets));
  }
  name(value: string) { return portableSegment(value); }
  tree(base: string, originalPath: string) {
    const segments = originalPath.split('/').filter(Boolean);
    if (!segments.length) throw new Error('Customer file path has no segments');
    let parent = base, prefix = base;
    for (let i = 0; i < segments.length; i++) {
      prefix += `/${segments[i]}`;
      const owner = `${i === segments.length - 1 ? 'file' : 'dir'}:${prefix}`;
      let candidate = portableSegment(segments[i]);
      const claimKey = (name: string) => `${parent}\u0000${name.normalize('NFC').toLowerCase()}`;
      let key = claimKey(candidate);
      if (Object.hasOwn(this.state.claims, key) && this.state.claims[key] !== owner) {
        candidate = hashedSegment(candidate, owner);
        key = claimKey(candidate);
        if (Object.hasOwn(this.state.claims, key) && this.state.claims[key] !== owner) throw new Error('Export path collision after disambiguation');
      }
      this.state.claims[key] = owner;
      parent += `/${candidate}`;
    }
    const original = `${base}/${originalPath.replace(/^\/+/, '')}`;
    if (parent !== original) Object.defineProperty(this.state.mappings, original, { value: parent, enumerable: true, writable: true, configurable: true });
    return parent;
  }
  async target(relative: string) {
    const parts = relative.split('/');
    // oxlint-disable-next-line no-control-regex -- Output paths must reject NUL.
    if (path.isAbsolute(relative) || parts.some(part => !part || part === '.' || part === '..' || /[\\\x00]/.test(part))) throw new Error('Unsafe output path');
    const result = path.resolve(this.root, ...parts);
    if (!result.startsWith(`${path.resolve(this.root)}${path.sep}`)) throw new Error('Output escapes export directory');
    let current = path.resolve(this.root);
    for (const part of parts) {
      current = path.join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Symlink in export destination'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    await mkdir(path.dirname(result), { recursive: true, mode: 0o700 });
    return result;
  }
  async write(relative: string, content: string) {
    const target = await this.target(relative);
    const staging = await mkdtemp(path.join(path.dirname(this.root), '.org-export-write-'));
    try { const temp = path.join(staging, 'content'); await writeFile(temp, content, { mode: 0o600, flag: 'wx' }); await rename(temp, target); }
    finally { await rm(staging, { recursive: true, force: true }); }
  }
  async json(relative: string, value: unknown) { await this.write(relative, `${JSON.stringify(value, null, 2)}\n`); }
  async save() {
    this.checkpoint = this.checkpoint.then(() => this.json('.org-export-state.json', this.state));
    await this.checkpoint;
  }
  async item<T>(id: string, outputs: string[], action: () => Promise<T>, count: (result: T) => number = () => 1): Promise<T | undefined> {
    const done = this.state.finished[id];
    if (done && await Promise.all(done.outputs.map(async relative => {
      try { return (await lstat(await this.target(relative))).isFile(); } catch { return false; }
    })).then(results => results.every(Boolean))) return undefined;
    delete this.state.finished[id];
    try {
      const result = await action();
      this.state.finished[id] = { outputs, count: count(result) };
      delete this.state.warnings[id];
      await this.save(); return result;
    } catch (error) {
      this.state.warnings[id] = redactError(error, this.secrets);
      await this.save(); return undefined;
    }
  }
  async cachedJson<T>(relative: string, load: () => Promise<T>, count?: (result: T) => number): Promise<T | undefined> {
    await this.item(relative, [relative], async () => { const value = await load(); await this.json(relative, value); return value; }, count);
    if (!this.state.finished[relative]) return undefined;
    return JSON.parse(await readFile(await this.target(relative), 'utf8')) as T;
  }
}

export class ExportClient {
  constructor(readonly baseUrl: string, readonly orgId: string, private readonly key: string, readonly fetcher: typeof fetch = fetch, readonly sleep?: (ms: number) => Promise<void>) {}
  async response(endpoint: string, query: Record<string, string | number | undefined> = {}, method = 'GET') {
    const url = new URL(`${this.baseUrl}/api/admin/org-export/${encodeURIComponent(this.orgId)}${endpoint}`);
    for (const [key, value] of Object.entries(query)) if (value !== undefined) url.searchParams.set(key, String(value));
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    let response: Response;
    try { response = await this.fetcher(url, { method, headers: { Authorization: `Bearer ${this.key}` }, redirect: 'error', signal: controller.signal }); }
    finally { clearTimeout(timer); } // Bound response setup, not the transfer time of a large streamed object.
    if (!response.ok) {
      await response.body?.cancel();
      const header = response.headers.get('retry-after');
      const delay = header && /^\d+$/.test(header) ? Number(header) * 1000 : header ? Math.max(0, Date.parse(header) - Date.now()) : 0;
      throw new ExportHttpError(response.status, Number.isFinite(delay) ? delay : 0);
    }
    return response;
  }
  async json<T>(endpoint: string, query: Record<string, string | number | undefined> = {}, method = 'GET'): Promise<T> {
    return retry(async () => await (await this.response(endpoint, query, method)).json() as T, { sleep: this.sleep });
  }
  async *pages(endpoint: string, query: Record<string, string | number | undefined> = {}): AsyncGenerator<Row[]> {
    let cursor: string | undefined;
    const seen = new Set<string>();
    do {
      const page = await this.json<{ items: Row[]; cursor: string | null }>(endpoint, { ...query, cursor });
      if (!Array.isArray(page.items)) throw new Error('Invalid export page');
      yield page.items;
      cursor = page.cursor ?? undefined;
      if (cursor && seen.has(cursor)) throw new Error('Export cursor did not advance');
      if (cursor) seen.add(cursor);
    } while (cursor);
  }
  async all(endpoint: string, query: Record<string, string | number | undefined> = {}): Promise<Row[]> {
    const rows: Row[] = [];
    for await (const page of this.pages(endpoint, query)) rows.push(...page);
    return rows;
  }
  async download(writer: ExportWriter, relative: string, endpoint: string, query: Record<string, string | number | undefined> = {}) {
    await writer.item(relative, [relative], () => retry(async () => {
      const target = await writer.target(relative);
      const staging = await mkdtemp(path.join(path.dirname(writer.root), '.org-export-download-')), temp = path.join(staging, 'content');
      try {
        const response = await this.response(endpoint, query);
        if (!response.body) throw new Error('Export object has no body');
        await pipeline(Readable.fromWeb(response.body as import('node:stream/web').ReadableStream), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        await rename(temp, target);
      } finally { await rm(staging, { recursive: true, force: true }); }
    }, { sleep: this.sleep }));
  }
}

export async function listLocalFiles(root: string, prefix = ''): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(root, prefix), { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('Symlink in export directory');
    if (entry.isDirectory()) files.push(...await listLocalFiles(root, relative));
    else if (entry.isFile()) files.push(relative);
    else throw new Error('Non-regular file in export directory');
  }
  return files.sort();
}
export async function fileSha256(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
export async function writeChecksums(writer: ExportWriter) {
  const entries = [];
  for (const relative of await listLocalFiles(writer.root)) {
    // The resume checkpoint is ours, not the customer's: it is left out of the archive too.
    if (relative === 'SHA256SUMS' || relative === '.org-export-state.json') continue;
    // Names generated by this script never contain newlines or backslashes.
    if (/[\r\n\\]/.test(relative)) throw new Error('Unsafe checksum filename');
    entries.push(`${await fileSha256(path.join(writer.root, relative))}  ${relative}\n`);
  }
  await writer.write('SHA256SUMS', entries.join(''));
}
export async function command(executable: string, args: string[], env: Record<string, string | undefined> = process.env, options: { captureStdout?: boolean } = {}) {
  return new Promise<string>((resolve, reject) => {
    // Child output may contain credentials or remote data; errors report status only.
    const child = spawn(executable, args, { env: env as NodeJS.ProcessEnv, stdio: ['ignore', options.captureStdout ? 'pipe' : 'ignore', 'ignore'] });
    const chunks: Buffer[] = [];
    let bytes = 0;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (bytes >= 64 * 1024) return;
      const captured = chunk.subarray(0, 64 * 1024 - bytes);
      chunks.push(captured);
      bytes += captured.length;
    });
    child.on('error', () => reject(new Error(`${executable} could not start`)));
    child.on('close', code => code === 0 ? resolve(Buffer.concat(chunks).toString('utf8')) : reject(new Error(`${executable} exited with status ${code}`)));
  });
}
