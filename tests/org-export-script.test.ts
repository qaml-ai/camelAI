/** Offline operator-script tests; fake HTTP, local files and local tar only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExportClient, ExportHttpError, ExportWriter, boundedMap, digest, parseExportArgs, redactError, retry, safeRelativePath, safeSegment, writeChecksums } from '../scripts/lib/org-export';
import { exportGit, exportHistory, findExportDirectory, finishExport, walkExport } from '../scripts/lib/org-export-run';

const roots: string[] = [];
async function writer() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'org-export-test-')); roots.push(root);
  return ExportWriter.open(path.join(root, 'camelai-export-org-20260101'), 'org', 'https://api.invalid', ['admin-secret', 'git-secret']);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('portable output paths', () => {
  it('sanitizes traversal, absolute paths, NUL, Windows names and case collisions', () => {
    const names = ['..', '.', '', 'a/b', 'a\\b', 'C:', 'NUL', 'con.txt', 'COM1', 'a?', 'a*', 'a\0b', 'a\nb', 'foo.', 'A', 'a'];
    const result = names.map(safeSegment);
    expect(new Set(result).size).toBe(names.length);
    // oxlint-disable-next-line no-control-regex -- Safe names must not contain control characters.
    for (const name of result) { expect(name).not.toMatch(/[\\/:*?"<>|\x00-\x1f]/); expect(['.', '..', '']).not.toContain(name); }
    for (const input of ['/etc/passwd', '../../a', 'C:\\windows\\a', 'a//b', 'a/../b']) {
      const safe = safeRelativePath(input); expect(path.isAbsolute(safe)).toBe(false); expect(safe.split('/')).not.toContain('..');
      expect(path.resolve('/export', safe).startsWith('/export/')).toBe(true);
    }
    expect(safeRelativePath('src/main.ts')).toBe('src/main.ts');
  });
  it('records renames and refuses existing symlinks and direct traversal', async () => {
    const w = await writer(); w.relative('../A'); expect(Object.keys(w.state.mappings)).toEqual(['../A']);
    await expect(w.write('../outside', 'bad')).rejects.toThrow('Unsafe');
    await symlink(os.tmpdir(), path.join(w.root, 'link'));
    await expect(w.write('link/a', 'bad')).rejects.toThrow('Symlink');
  });
  it('parses the advertised bun invocation', () => {
    expect(parseExportArgs(['--', '--env', 'prod', '--org', 'org', '--out', '/tmp/out'])).toMatchObject({ env: 'prod', orgId: 'org', out: '/tmp/out', concurrency: 4 });
    expect(() => parseExportArgs(['--env', 'dev'])).toThrow();
  });
});

describe('resumption, retries and warnings', () => {
  it('skips completed items, retries failures and recovers missing files', async () => {
    const w = await writer(), action = vi.fn(async () => w.write('file.txt', 'value'));
    await w.item('file', ['file.txt'], action); await w.item('file', ['file.txt'], action); expect(action).toHaveBeenCalledTimes(1);
    const resumed = await ExportWriter.open(w.root, 'org', 'https://api.invalid');
    await resumed.item('file', ['file.txt'], action); expect(action).toHaveBeenCalledTimes(1);
    await rm(path.join(w.root, 'file.txt')); await resumed.item('file', ['file.txt'], action); expect(action).toHaveBeenCalledTimes(2);
    await w.item('bad', ['bad.txt'], async () => { throw new Error('Bearer admin-secret token=git-secret'); });
    await w.item('good', ['good.txt'], () => w.write('good.txt', 'continued'));
    expect(w.state.warnings.bad).not.toMatch(/admin-secret|git-secret/); expect(w.state.finished.good).toBeDefined(); expect(w.state.finished.bad).toBeUndefined();
    await w.item('bad', ['bad.txt'], () => w.write('bad.txt', 'recovered')); expect(w.state.warnings.bad).toBeUndefined();
  });
  it('backs off on 429/5xx/network errors, honors retry-after and refuses permanent errors', async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const work = vi.fn().mockRejectedValueOnce(new ExportHttpError(429, 2000)).mockRejectedValueOnce(new ExportHttpError(503)).mockRejectedValueOnce(new TypeError('network')).mockResolvedValue('ok');
    expect(await retry(work, { sleep })).toBe('ok'); expect(sleep.mock.calls.map(call => call[0])).toEqual([2000, 1000, 2000]);
    const permanent = vi.fn(async () => { throw new ExportHttpError(403); });
    await expect(retry(permanent, { sleep })).rejects.toThrow('403'); expect(permanent).toHaveBeenCalledTimes(1);
  });
  it('bounds concurrency and serializes checkpoints without losing finished entries', async () => {
    const w = await writer(); let active = 0, max = 0;
    await boundedMap(Array.from({ length: 20 }, (_, i) => i), 3, async i => {
      active++; max = Math.max(max, active);
      await w.item(`item-${i}`, [`${i}.txt`], () => w.write(`${i}.txt`, String(i))); active--;
    });
    expect(max).toBe(3); expect(Object.keys(JSON.parse(await readFile(path.join(w.root, '.org-export-state.json'), 'utf8')).finished)).toHaveLength(20);
  });
  it('redacts raw, URL-encoded, base64, bearer and URL-embedded credentials', () => {
    const key = 's/e+c?ret';
    const text = redactError(`${key} ${encodeURIComponent(key)} ${Buffer.from(key).toString('base64')} Bearer unknown https://user:pass@example.com token=unknown`, [key]);
    for (const secret of [key, encodeURIComponent(key), Buffer.from(key).toString('base64'), 'unknown', 'user:pass']) expect(text).not.toContain(secret);
  });
  it('resumes the latest matching directory across dates and rejects a different environment', async () => {
    const w = await writer(); await w.save();
    expect(await findExportDirectory(path.dirname(w.root), 'org', 'https://api.invalid', new Date('2026-02-02'))).toBe(w.root);
    await expect(ExportWriter.open(w.root, 'org', 'https://other.invalid')).rejects.toThrow('different');
  });
});

describe('walking and packaging', () => {
  it('writes raw history oldest first and resumes it', async () => {
    const w = await writer(); const requests: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)); requests.push(url.search);
      const before = url.searchParams.get('before');
      return Response.json(before === null ? { entries: [{ index: 2, message: { role: 'assistant', content: ['last'] } }], next: 2 }
        : { entries: [{ index: 0, message: { role: 'user', content: 'first' } }, { index: 1, message: { role: 'toolResult', details: { raw: true } } }], next: null });
    });
    const client = new ExportClient('https://api.invalid', 'org', 'admin-secret', fetcher);
    await exportHistory(client, w, 'thread', 'thread.jsonl'); await exportHistory(client, w, 'thread', 'thread.jsonl');
    const lines = (await readFile(path.join(w.root, 'thread.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    expect(lines).toEqual([{ role: 'user', content: 'first' }, { role: 'toolResult', details: { raw: true } }, { role: 'assistant', content: ['last'] }]);
    expect(fetcher).toHaveBeenCalledTimes(2); expect(requests[1]).toContain('before=2');
  });
  it('fails one download without aborting its siblings; retries only the failed item on resume', async () => {
    const w = await writer(); let fail = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input)), route = url.pathname.replace('/api/admin/org-export/org', '');
      const page = (items: unknown[]) => Response.json({ items, cursor: null });
      if (route === '/manifest') return Response.json({ org: { id: 'org', name: 'Test' }, record_sets: ['workspaces', 'apps'] });
      if (route === '/records/workspaces') return page([{ id: 'ws', name: 'work' }]);
      if (route === '/records/apps' || route === '/threads' || route.includes('/automations/') || route.endsWith('/projects')) return page([]);
      if (route === '/r2-prefixes') return Response.json({ bucket: 'R2_BUCKET', prefixes: [] });
      if (route.endsWith('/fs')) return page([{ path: '/bad', type: 'file' }, { path: '/good', type: 'file' }]);
      if (route.endsWith('/content')) return url.searchParams.get('path') === '/bad' && fail ? new Response('secret', { status: 503 }) : new Response('bytes');
      throw new Error(`Unexpected fake request: ${route}`);
    });
    const client = new ExportClient('https://api.invalid', 'org', 'admin-secret', fetcher, async () => {});
    await walkExport(client, w, 2);
    expect(Object.keys(w.state.warnings)).toContain('workspaces/work-ws/files/bad');
    expect(await readFile(path.join(w.root, 'workspaces/work-ws/files/good'), 'utf8')).toBe('bytes');
    fail = false; fetcher.mockClear(); await walkExport(client, w, 2);
    expect(w.state.warnings).toEqual({}); expect(fetcher.mock.calls).toHaveLength(2);
    expect(String(fetcher.mock.calls[0][0])).toContain('path=%2Fbad');
  });
  it('keeps Git tokens out of arguments, state and bundles, and removes the mirror', async () => {
    const w = await writer();
    const fetcher = vi.fn(async () => Response.json({ token: 'temporary-git-token', remote: 'https://artifacts.example/repo.git' }));
    const client = new ExportClient('https://api.invalid', 'org', 'admin-secret', fetcher, async () => {});
    const run = vi.fn(async (_exe: string, args: string[], env?: Record<string, string | undefined>) => {
      expect(args.join(' ')).not.toContain('temporary-git-token');
      expect(env?.GIT_CONFIG_VALUE_0).toBe('Authorization: Bearer temporary-git-token');
      expect(env?.GIT_CONFIG_VALUE_1).toBe('');
      if (args.includes('create')) await writeFile(args[4], 'bundle data');
    });
    await exportGit(client, w, '/workspaces/ws/projects/p/git-token', 'project.bundle', run);
    expect(run).toHaveBeenCalledTimes(3);
    expect(await readFile(path.join(w.root, 'project.bundle'), 'utf8')).toBe('bundle data');
    expect(await readFile(path.join(w.root, '.org-export-state.json'), 'utf8')).not.toContain('temporary-git-token');
    await expect(readFile(path.join(path.dirname(run.mock.calls[0][1].at(-1)!), 'project.bundle'))).rejects.toThrow();
    const missing = new ExportClient('https://api.invalid', 'org', 'admin-secret', vi.fn(async () => new Response(null, { status: 404 })));
    await exportGit(missing, w, '/workspaces/ws/projects/missing/git-token', 'missing.bundle', run);
    expect(w.state.warnings).toEqual({}); expect(w.state.excluded.some(reason => reason.startsWith('missing.bundle:'))).toBe(true);
  });
  it('creates exact SHA256SUMS and a tar with a verifiable companion hash', async () => {
    const w = await writer(); await w.write('hello.txt', 'hello\n'); await writeChecksums(w);
    expect(await readFile(path.join(w.root, 'SHA256SUMS'), 'utf8')).toBe(`${digest('hello\n')}  hello.txt\n`);
    const result = await finishExport(w);
    expect(result.warnings).toBe(0);
    expect(await readFile(`${result.archive}.sha256`, 'utf8')).toBe(`${digestBuffer(await readFile(result.archive))}  ${path.basename(result.archive)}\n`);
    const sums = await readFile(path.join(w.root, 'SHA256SUMS'), 'utf8');
    expect(sums).toContain('  manifest.json\n'); expect(sums).not.toContain('  .org-export-state.json\n'); expect(sums).not.toContain('  SHA256SUMS\n');
    for (const line of sums.trim().split('\n')) {
      const [hash, relative] = line.split('  '); expect(digestBuffer(await readFile(path.join(w.root, relative)))).toBe(hash);
    }
  });
});
import { createHash } from 'node:crypto';
const digestBuffer = (data: Buffer) => createHash('sha256').update(data).digest('hex');
