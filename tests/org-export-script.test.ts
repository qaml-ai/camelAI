/** Offline operator-script tests; fake HTTP, local files and local tar only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ExportClient, ExportHttpError, ExportWriter, boundedMap, command, digest, listLocalFiles, parseExportArgs, portableSegment, redactError, retry, writeChecksums } from '../scripts/lib/org-export';
import { exportGit, exportHistory, findExportDirectory, finishExport, walkExport } from '../scripts/lib/org-export-run';

const roots: string[] = [];
async function writer() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'org-export-test-')); roots.push(root);
  return ExportWriter.open(path.join(root, 'camelai-export-org-20260101'), 'org', 'https://api.invalid', ['admin-secret', 'git-secret']);
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe('portable output paths', () => {
  it('keeps original portable names, including case, leading dots, spaces and Unicode', () => {
    for (const name of ['App.tsx', 'README.md', '.gitignore', '.env.example', 'My Report.pdf', 'résumé.pdf', 'Makefile', 'é'.repeat(125) + '.txt']) {
      expect(portableSegment(name)).toBe(name);
    }
  });
  it('encodes unsafe names distinctly, preserving extensions and whole UTF-8 characters', () => {
    const names = ['..', '.', '', 'a/b', 'a\\b', 'C:', 'NUL', 'con.txt', 'COM1', 'a?', 'a*', 'a\0b', 'a\nb', 'a\x7fb', 'foo.', 'foo ', 'a'.repeat(300), 'é'.repeat(150), '🙂'.repeat(75) + '.tsx', 'My:File.tsx'];
    const result = names.map(portableSegment);
    expect(new Set(result).size).toBe(names.length);
    for (const [i, name] of result.entries()) {
      expect(name).not.toBe(names[i]); expect(portableSegment(names[i])).toBe(name);
      // oxlint-disable-next-line no-control-regex -- Safe names must not contain control characters.
      expect(name).not.toMatch(/[\\/:*?"<>|\x00-\x1f\x7f]/);
      expect(name).not.toMatch(/[. ]$/); expect(['.', '..', '']).not.toContain(name);
      expect(name).toContain(`~${digest(names[i]).slice(0, 12)}`);
      expect(Buffer.byteLength(name)).toBeLessThanOrEqual(255);
      expect(Buffer.from(name).toString('utf8')).toBe(name);
    }
    expect(portableSegment('My:File.tsx')).toBe(`My_File~${digest('My:File.tsx').slice(0, 12)}.tsx`);
    expect(portableSegment('')).toBe(`name~${digest('').slice(0, 12)}`);
    expect(portableSegment('con.txt')).toBe(`_con~${digest('con.txt').slice(0, 12)}.txt`);
    expect(portableSegment('é'.repeat(150))).toMatch(/^é+~[a-f0-9]{12}$/);
    expect(portableSegment('🙂'.repeat(75) + '.tsx')).toMatch(/^(?:🙂)+~[a-f0-9]{12}\.tsx$/u);
    for (const device of ['CON', 'prn', 'Aux', 'nul', ...Array.from({ length: 10 }, (_, i) => `COM${i}`), ...Array.from({ length: 10 }, (_, i) => `lpt${i}`)]) {
      expect(portableSegment(device)).toMatch(/^_/); expect(portableSegment(`${device}.txt`)).toMatch(/^_/);
    }
  });
  it('disambiguates case and normalization collisions and reuses directory claims', async () => {
    const w = await writer(), base = 'workspaces/work/files';
    expect(w.tree(base, 'README.md')).toBe(`${base}/README.md`);
    const lower = w.tree(base, 'readme.md');
    expect(lower).toBe(`${base}/readme~${digest(`file:${base}/readme.md`).slice(0, 12)}.md`);
    expect(w.tree(base, 'readme.md')).toBe(lower);
    expect(w.tree(base, 'Src/a.ts')).toBe(`${base}/Src/a.ts`);
    const directory = w.tree(base, 'src/b.ts').slice(0, -'/b.ts'.length);
    expect(directory.toLowerCase()).not.toBe(`${base}/src`);
    expect(w.tree(base, 'src/d.ts')).toBe(`${directory}/d.ts`);
    expect(w.tree(base, 'Src/c.ts')).toBe(`${base}/Src/c.ts`);
    const nfc = w.tree(base, 'é.txt'), nfd = w.tree(base, 'e\u0301.txt');
    expect(nfc).toBe(`${base}/é.txt`);
    expect(nfd.normalize('NFC').toLowerCase()).not.toBe(nfc.normalize('NFC').toLowerCase());
    expect(w.tree('workspaces/other/files', 'readme.md')).toBe('workspaces/other/files/readme.md');
    expect(w.tree(base, '__proto__')).toBe(`${base}/__proto__`);
  });
  it.each([['a', 'a/b'], ['a/b', 'a']])('exports file/folder conflicts in order %s, %s', async (first, second) => {
    const w = await writer(), base = 'r2/R2_BUCKET';
    const a = w.tree(base, first), b = w.tree(base, second);
    expect(a).toBe(`${base}/${first}`);
    expect(a.split('/')[2].toLowerCase()).not.toBe(b.split('/')[2].toLowerCase());
    await w.write(a, first); await w.write(b, second);
    expect(await readFile(await w.target(a), 'utf8')).toBe(first);
    expect(await readFile(await w.target(b), 'utf8')).toBe(second);
  });
  it('keeps traversal inputs inside the base without resolving dot segments', async () => {
    const w = await writer(), base = 'workspaces/work/files';
    for (const input of ['/etc/passwd', '../../a', 'C:\\windows\\a', 'a//b', 'a/../b']) {
      const output = w.tree(base, input);
      expect(path.isAbsolute(output)).toBe(false); expect(output.split('/')).not.toContain('..'); expect(output.split('/')).not.toContain('.');
      expect((await w.target(output)).startsWith(`${path.join(w.root, base)}${path.sep}`)).toBe(true);
    }
    expect(w.tree(base, '/etc/passwd')).toBe(`${base}/etc/passwd`);
    expect(w.tree(base, 'a//b')).toBe(`${base}/a/b`);
    expect(w.tree(base, 'a/../b')).toBe(`${base}/a/${portableSegment('..')}/b`);
  });
  it('preserves claims on resume even when paths are reordered, omitted or added', async () => {
    const w = await writer(), base = 'r2/R2_BUCKET';
    const originals = ['README.md', 'readme.md', 'Src/a.ts', 'src/b.ts', 'é.txt', 'e\u0301.txt', 'a', 'a/b'];
    const outputs = originals.map(original => w.tree(base, original));
    await w.save();
    const resumed = await ExportWriter.open(w.root, 'org', 'https://api.invalid');
    expect(resumed.state.version).toBe(2); expect(resumed.state.claims).toEqual(w.state.claims);
    // Its original competitor need not be listed again to keep a disambiguated name.
    expect(resumed.tree(base, 'a/b')).toBe(outputs.at(-1));
    expect(resumed.tree(base, 'Readme.md')).not.toBe(`${base}/Readme.md`);
    for (let i = originals.length - 1; i >= 0; i--) expect(resumed.tree(base, originals[i])).toBe(outputs[i]);
  });
  it('throws if the disambiguated candidate is also claimed', async () => {
    const w = await writer(), base = 'r2/R2_BUCKET';
    w.tree(base, 'README.md');
    w.tree(base, `readme~${digest(`file:${base}/readme.md`).slice(0, 12)}.md`);
    expect(() => w.tree(base, 'readme.md')).toThrow('collision');
  });
  it('records only renamed customer paths in path-mapping.json', async () => {
    const w = await writer(), base = 'workspaces/work/files';
    w.name('My:Workspace-id'); w.name('volume-id-/.json');
    w.tree(base, '/README.md'); w.tree(base, '.gitignore'); w.tree(base, 'résumé.pdf');
    const lower = w.tree(base, 'readme.md'), unsafe = w.tree(base, '/My:File.tsx');
    await finishExport(w);
    expect(JSON.parse(await readFile(path.join(w.root, 'path-mapping.json'), 'utf8'))).toEqual({
      [`${base}/readme.md`]: lower, [`${base}/My:File.tsx`]: unsafe,
    });
  });
  it('refuses existing symlinks and direct traversal', async () => {
    const w = await writer();
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
  it('refuses version-1 checkpoints rather than changing their naming format', async () => {
    const w = await writer();
    await w.json('.org-export-state.json', { ...w.state, version: 1 });
    await expect(ExportWriter.open(w.root, 'org', 'https://api.invalid')).rejects.toThrow('different organization, environment or format');
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
  it('assigns listing names before downloads and keeps them identical across concurrent runs', async () => {
    const snapshots: Array<{ files: string[]; mappings: Record<string, string> }> = [];
    const names = ['/README.md', '/readme.md', '/Src/a.ts', '/src/b.ts', '/.gitignore', '/résumé.pdf'];
    for (const reverse of [false, true]) {
      const w = await writer();
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input)), route = url.pathname.replace('/api/admin/org-export/org', '');
        const page = (items: unknown[], cursor: string | null = null) => Response.json({ items, cursor });
        if (route === '/manifest') return Response.json({ org: { id: 'org', name: 'Test' }, record_sets: ['workspaces', 'apps'] });
        if (route === '/records/workspaces') return page([{ id: 'ws', name: 'Work Space' }]);
        if (route === '/records/apps' || route.includes('/automations/')) return page([]);
        if (route.endsWith('/projects')) return page([{ id: 'p', name: 'My Project' }]);
        if (route.endsWith('/git-token')) return new Response(null, { status: 404 });
        if (route === '/threads') return page([{ id: 'thread', workspace_id: 'ws', runtime: { agent_id: 'agent' } }]);
        if (route.endsWith('/history')) return Response.json({ entries: [], next: null });
        if (route.endsWith('/volumes')) return page([{ volumeId: 'volume', path: '/' }]);
        if (route === '/r2-prefixes') return Response.json({ bucket: 'R2_BUCKET', prefixes: ['objects/'] });
        if (route === '/r2') return url.searchParams.has('cursor')
          ? page([{ key: 'objects/readme.md' }, { key: 'objects/a/b' }])
          : page([{ key: 'objects/README.md' }, { key: 'objects/a' }], 'next');
        if (route.endsWith('/fs') || route.endsWith('/files')) return page(names.map(name => ({ path: name, type: 'file' })));
        if (route.endsWith('/content') || route === '/r2/object') {
          const original = url.searchParams.get('path') ?? url.searchParams.get('key')!;
          await new Promise(resolve => setTimeout(resolve, (original.includes('README') !== reverse) ? 5 : 0));
          return new Response(original);
        }
        throw new Error(`Unexpected fake request: ${route}`);
      });
      const client = new ExportClient('https://api.invalid', 'org', 'admin-secret', fetcher);
      const download = client.download.bind(client);
      const spy = vi.spyOn(client, 'download').mockImplementation(async (outputWriter, relative, endpoint, query) => {
        const checkpoint = JSON.parse(await readFile(path.join(w.root, '.org-export-state.json'), 'utf8'));
        if (endpoint.endsWith('/content')) {
          const base = relative.slice(0, relative.indexOf('/files/') + '/files'.length) + (endpoint.includes('/volumes/') ? '/volume' : '');
          // Even the last listing entry must already have a durable claim before the first download starts.
          expect(checkpoint.claims[`${base}\0résumé.pdf`]).toBe(`file:${base}/résumé.pdf`);
        } else if (query?.key === 'objects/README.md') {
          expect(checkpoint.claims['r2/R2_BUCKET/objects\0a']).toBe('file:r2/R2_BUCKET/objects/a');
        }
        return download(outputWriter, relative, endpoint, query);
      });
      await walkExport(client, w, 4);
      expect(w.state.warnings).toEqual({}); expect(spy).toHaveBeenCalledTimes(22);
      const files = (await listLocalFiles(w.root)).filter(file => file.includes('/files/') || file.startsWith('r2/'));
      expect(files).toHaveLength(22);
      const workspaceBase = 'workspaces/Work Space-ws/files';
      const projectBase = 'workspaces/Work Space-ws/projects/My Project-p/files';
      const volumeBase = 'workspaces/Work Space-ws/threads/thread/files/volume';
      for (const base of [workspaceBase, projectBase, volumeBase]) {
        expect(files).toContain(`${base}/README.md`);
        expect(files).toContain(`${base}/.gitignore`);
        expect(files).toContain(`${base}/résumé.pdf`);
        expect(await readFile(path.join(w.root, `${base}/README.md`), 'utf8')).toBe('/README.md');
        expect(await readFile(path.join(w.root, w.state.mappings[`${base}/readme.md`]), 'utf8')).toBe('/readme.md');
      }
      expect(await readFile(path.join(w.root, 'r2/R2_BUCKET/objects/a'), 'utf8')).toBe('objects/a');
      expect(await readFile(path.join(w.root, w.state.mappings['r2/R2_BUCKET/objects/a/b']), 'utf8')).toBe('objects/a/b');
      snapshots.push({ files, mappings: w.state.mappings });
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
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
      return args.includes('for-each-ref') ? 'refs/heads/main\n' : '';
    });
    await exportGit(client, w, '/workspaces/ws/projects/p/git-token', 'project.bundle', run);
    expect(run).toHaveBeenCalledTimes(4);
    expect(run.mock.calls[1][1].slice(2)).toEqual(['for-each-ref', '--count=1', '--format=%(refname)']);
    expect(await readFile(path.join(w.root, 'project.bundle'), 'utf8')).toBe('bundle data');
    expect(await readFile(path.join(w.root, '.org-export-state.json'), 'utf8')).not.toContain('temporary-git-token');
    await expect(readFile(path.join(path.dirname(run.mock.calls[0][1].at(-1)!), 'project.bundle'))).rejects.toThrow();
    const missing = new ExportClient('https://api.invalid', 'org', 'admin-secret', vi.fn(async () => new Response(null, { status: 404 })));
    await exportGit(missing, w, '/workspaces/ws/projects/missing/git-token', 'missing.bundle', run);
    expect(w.state.warnings).toEqual({}); expect(w.state.excluded.some(reason => reason.startsWith('missing.bundle:'))).toBe(true);
  });
  it('excludes empty git repositories without a bundle, retries or warnings and resumes them', async () => {
    const w = await writer(), sleep = vi.fn(async () => {});
    const fetcher = vi.fn(async () => Response.json({ token: 'temporary-git-token', remote: 'https://artifacts.example/empty.git' }));
    const client = new ExportClient('https://api.invalid', 'org', 'admin-secret', fetcher, sleep);
    const run = vi.fn<typeof command>(async () => '');
    await exportGit(client, w, '/workspaces/ws/projects/p/git-token', 'empty.bundle', run);
    expect(run).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledTimes(1); expect(sleep).not.toHaveBeenCalled();
    expect(run.mock.calls[1][1].slice(2)).toEqual(['for-each-ref', '--count=1', '--format=%(refname)']);
    expect(run.mock.calls[1][3]).toEqual({ captureStdout: true });
    expect(w.state.finished['empty.bundle']).toEqual({ outputs: [], count: 0 });
    expect(w.state.warnings).toEqual({});
    expect(w.state.excluded).toContain('empty.bundle: the project has no git history; its files are exported separately.');
    await expect(readFile(path.join(w.root, 'empty.bundle'))).rejects.toThrow();
    const resumed = await ExportWriter.open(w.root, 'org', 'https://api.invalid');
    await exportGit(client, resumed, '/workspaces/ws/projects/p/git-token', 'empty.bundle', run);
    expect(run).toHaveBeenCalledTimes(2); expect(fetcher).toHaveBeenCalledTimes(1);
    expect((await finishExport(resumed)).warnings).toBe(0);
    const manifest = JSON.parse(await readFile(path.join(w.root, 'manifest.json'), 'utf8'));
    expect(manifest.complete).toBe(true); expect(manifest.counts.git_bundles).toBe(0);
    expect(await readFile(path.join(w.root, 'README.md'), 'utf8')).not.toContain('INCOMPLETE');
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
describe('command output', () => {
  it('captures at most 64 KiB of stdout only when requested, ignoring stderr', async () => {
    const args = ['-e', 'process.stdout.write("x".repeat(70000)); process.stderr.write("private stderr");'];
    expect(await command(process.execPath, args)).toBe('');
    expect(await command(process.execPath, args, process.env, { captureStdout: true })).toBe('x'.repeat(64 * 1024));
  });
  it('reports only status when a command fails, even with capture enabled', async () => {
    await expect(command(process.execPath, ['-e', 'process.stdout.write("private stdout"); process.stderr.write("private stderr"); process.exitCode = 7;'], process.env, { captureStdout: true }))
      .rejects.toThrow(`${process.execPath} exited with status 7`);
  });
});
import { createHash } from 'node:crypto';
const digestBuffer = (data: Buffer) => createHash('sha256').update(data).digest('hex');
