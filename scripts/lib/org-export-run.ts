/** Walk the scoped admin API. Failed items stay unfinished; siblings continue and a later run retries them. */
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { boundedMap, command, ExportClient, ExportHttpError, ExportWriter, fileSha256, portableSegment, retry, writeChecksums, type Row } from './org-export';

const enc = encodeURIComponent;
export async function exportHistory(client: ExportClient, writer: ExportWriter, threadId: string, relative: string) {
  await writer.item(relative, [relative], async () => {
    const tempDir = await mkdtemp(path.join(path.dirname(writer.root), '.org-export-history-'));
    let before: number | undefined, count = 0, pages = 0;
    try {
      do {
        const page = await client.json<{ entries: Array<{ index: number; message: unknown }>; next: number | null }>(`/threads/${enc(threadId)}/history`, { before, limit: 100 });
        if (!Array.isArray(page.entries)) throw new Error('Invalid history page');
        if (page.next !== null && (!Number.isSafeInteger(page.next) || page.next < 0 || (before !== undefined && page.next >= before))) throw new Error('History cursor did not advance');
        for (let i = 1; i < page.entries.length; i++) if (page.entries[i].index <= page.entries[i - 1].index) throw new Error('History entries out of order');
        await writeFile(path.join(tempDir, String(pages++)), page.entries.map(entry => JSON.stringify(entry.message) + '\n').join(''), { mode: 0o600 });
        count += page.entries.length;
        before = page.next ?? undefined;
      } while (before !== undefined);
      const target = await writer.target(relative), temp = path.join(tempDir, 'assembled');
      try {
        async function* chunks() {
          for (let i = pages - 1; i >= 0; i--) for await (const chunk of createReadStream(path.join(tempDir, String(i)))) yield chunk;
        }
        await pipeline(Readable.from(chunks()), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
        await rename(temp, target);
      } finally { await rm(temp, { force: true }); }
      return count;
    } finally { await rm(tempDir, { recursive: true, force: true }); }
  }, count => count);
}

export async function exportGit(client: ExportClient, writer: ExportWriter, endpoint: string, relative: string, runCommand: typeof command = command) {
  const outputs: string[] = [];
  await writer.item(relative, outputs, async () => {
    return retry(async () => {
      let auth: { token: string; remote: string };
      try { auth = await client.json(endpoint, {}, 'POST'); }
      catch (error) {
        if (!(error instanceof ExportHttpError && error.status === 404)) throw error;
        const reason = `${relative}: no existing Artifacts repository; the working tree is exported separately.`;
        if (!writer.state.excluded.includes(reason)) writer.state.excluded.push(reason);
        return 0;
      }
      writer.secrets.add(auth.token);
      const remote = new URL(auth.remote);
      if (remote.protocol !== 'https:' || remote.username || remote.password || remote.search || remote.hash) throw new Error('Unsafe Artifacts remote');
      const tempDir = await mkdtemp(path.join(path.dirname(writer.root), '.org-export-git-'));
      try {
        const mirror = path.join(tempDir, 'mirror.git');
        const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_') && key !== 'ADMIN_API_KEY'));
        // Config travels in the environment, not argv, disk, URL or the mirror's config.
        Object.assign(env, { GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_COUNT: '4',
          GIT_CONFIG_KEY_0: `http.${remote.origin}/.extraHeader`, GIT_CONFIG_VALUE_0: `Authorization: Bearer ${auth.token}`,
          GIT_CONFIG_KEY_1: 'credential.helper', GIT_CONFIG_VALUE_1: '', GIT_CONFIG_KEY_2: 'http.followRedirects', GIT_CONFIG_VALUE_2: 'false',
          GIT_CONFIG_KEY_3: 'core.hooksPath', GIT_CONFIG_VALUE_3: '/dev/null' });
        await runCommand('git', ['clone', '--mirror', '--', remote.href, mirror], env);
        const refs = await runCommand('git', ['-C', mirror, 'for-each-ref', '--count=1', '--format=%(refname)'], env, { captureStdout: true });
        if (!refs.trim()) {
          const reason = `${relative}: the project has no git history; its files are exported separately.`;
          if (!writer.state.excluded.includes(reason)) writer.state.excluded.push(reason);
          return 0;
        }
        const bundle = path.join(tempDir, 'project.bundle');
        await runCommand('git', ['-C', mirror, 'bundle', 'create', bundle, '--all'], env);
        await runCommand('git', ['-C', mirror, 'bundle', 'verify', bundle], env);
        await rename(bundle, await writer.target(relative));
        outputs.push(relative);
        return 1;
      } finally { await rm(tempDir, { recursive: true, force: true }); }
    }, { sleep: client.sleep });
  }, count => count);
}

export async function walkExport(client: ExportClient, writer: ExportWriter, concurrency: number) {
  const manifest = await writer.cachedJson<Row>('org/settings.json', () => client.json('/manifest'));
  if (!manifest) return;
  for (const [key, value] of Object.entries(manifest)) {
    if (key === 'record_sets') continue;
    await writer.item(`org/${key}.json`, [`org/${key}.json`], () => writer.json(`org/${key}.json`, value));
  }
  const sets: Record<string, Row[]> = {};
  for (const set of manifest.record_sets as string[]) {
    sets[set] = await writer.cachedJson<Row[]>(`org/${writer.name(`${set}.json`)}`, () => client.all(`/records/${enc(set)}`), rows => rows.length) ?? [];
  }
  const threads = await writer.cachedJson<Row[]>('org/threads.json', () => client.all('/threads'), rows => rows.length) ?? [];

  async function files(endpoint: string, destination: string, metadata: string, query: Record<string, string> = {}) {
    // Keep directory and symlink metadata without creating filesystem symlinks in the backup.
    const rows = await writer.cachedJson<Row[]>(metadata, () => client.all(endpoint, query), rows => rows.length) ?? [];
    // Claim names in listing order and persist them before concurrent downloads can finish.
    const downloads = rows.filter(row => (row.type ?? 'file') === 'file')
      .map(row => ({ row, relative: writer.tree(destination, String(row.path)) }));
    await writer.save();
    await boundedMap(downloads, concurrency, async ({ row, relative }) => {
      await client.download(writer, relative, `${endpoint}/content`, { ...query, path: String(row.path) });
    });
  }
  async function r2(workspaceId: string, projectId?: string) {
    const query = { workspaceId, ...(projectId ? { projectId } : {}) };
    await writer.item(`r2-walk:${workspaceId}:${projectId ?? ''}`, [], async () => {
      const scope = await client.json<{ bucket: string; prefixes: string[] }>('/r2-prefixes', query);
      // A project request also returns workspace prefixes; those are walked once per workspace.
      for (const prefix of scope.prefixes.filter(prefix => !projectId || prefix.startsWith('project-fs/'))) {
        for await (const page of client.pages('/r2', { ...query, bucket: scope.bucket, prefix })) {
          const downloads = page.map(row => ({ row, relative: writer.tree('r2/R2_BUCKET', row.key) }));
          await writer.save();
          await boundedMap(downloads, concurrency, ({ row, relative }) => client.download(writer, relative, '/r2/object', { ...query, bucket: scope.bucket, key: row.key }));
        }
      }
      // Do not mark a walk finished while any discovered object is incomplete.
      if (Object.keys(writer.state.warnings).some(key => key.startsWith('r2/'))) throw new Error('Some R2 objects are incomplete');
    }, () => 0);
    // Re-list R2 on resume so deleted local files and earlier failed objects are retried.
    delete writer.state.finished[`r2-walk:${workspaceId}:${projectId ?? ''}`];
  }

  const automationIndex: Row[] = [];
  for (const ws of sets.workspaces ?? []) {
    const workspaceId = String(ws.id), endpoint = `/workspaces/${enc(workspaceId)}`;
    const directory = `workspaces/${writer.name(`${ws.slug ?? ws.name}-${workspaceId}`)}`;
    const automationFiles: Row = { workspace_id: workspaceId };
    for (const kind of ['prompts', 'automations', 'versions']) {
      const file = `${directory}/automations-${kind}.json`;
      const rows = await writer.cachedJson(file, () => client.all(`${endpoint}/automations/${kind}`), rows => rows.length);
      automationFiles[kind] = { file, count: rows?.length ?? 0, complete: rows !== undefined };
    }
    automationIndex.push(automationFiles);
    await files(`${endpoint}/fs`, `${directory}/files`, `${directory}/filesystem.json`);
    const projects = await writer.cachedJson<Row[]>(`${directory}/projects.json`, () => client.all(`${endpoint}/projects`), rows => rows.length) ?? [];
    for (const project of projects) {
      const projectId = String(project.id), projectEndpoint = `${endpoint}/projects/${enc(projectId)}`;
      const projectDirectory = `${directory}/projects/${writer.name(`${project.name}-${projectId}`)}`;
      await files(`${projectEndpoint}/fs`, `${projectDirectory}/files`, `${projectDirectory}/filesystem.json`);
      // Named after its folder, so the bundle sits beside the project it belongs to.
      await exportGit(client, writer, `${projectEndpoint}/git-token`, `${projectDirectory}.bundle`);
      await r2(workspaceId, projectId);
    }
    await r2(workspaceId);
    for (const app of (sets.apps ?? []).filter(row => row.workspace_id === workspaceId)) {
      const relative = `${directory}/apps/${writer.name(String(app.script_name))}/kv.jsonl`;
      await writer.item(relative, [relative], async () => {
        const target = await writer.target(relative);
        const staging = await mkdtemp(path.join(path.dirname(writer.root), '.org-export-kv-')), temp = path.join(staging, 'content');
        let count = 0;
        try {
          async function* chunks() {
            for await (const page of client.pages(`${endpoint}/apps/${enc(app.script_name)}/kv`)) {
              for (const entry of page) { count++; yield JSON.stringify(entry) + '\n'; }
            }
          }
          await pipeline(Readable.from(chunks()), createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
          await rename(temp, target);
        } finally { await rm(staging, { recursive: true, force: true }); }
        return count;
      }, count => count);
    }
    await boundedMap(threads.filter(row => row.workspace_id === workspaceId), concurrency, async thread => {
      const threadId = String(thread.id), relative = `${directory}/threads/${writer.name(threadId)}`;
      await writer.item(`${relative}.json`, [`${relative}.json`], () => writer.json(`${relative}.json`, thread));
      await exportHistory(client, writer, threadId, `${relative}.jsonl`);
      if (thread.runtime?.agent_id) {
        const volumesEndpoint = `/threads/${enc(threadId)}/agents/${enc(thread.runtime.agent_id)}/volumes`;
        const volumes = await writer.cachedJson<Row[]>(`${relative}/volumes.json`, () => client.all(volumesEndpoint), rows => rows.length) ?? [];
        for (const volume of volumes) {
          // Walk a single thread's files serially, keeping total concurrency at the configured thread limit.
          const rows = await writer.cachedJson<Row[]>(`${relative}/${writer.name(`volume-${volume.volumeId}-${volume.path}.json`)}`, () => client.all(`${volumesEndpoint}/${enc(volume.volumeId)}/files`, { path: volume.subpath ?? '/' }), rows => rows.length) ?? [];
          const downloads = rows.filter(row => (row.type ?? 'file') === 'file')
            .map(row => ({ row, output: writer.tree(`${relative}/files/${writer.name(volume.volumeId)}`, String(row.path)) }));
          await writer.save();
          for (const { row, output } of downloads) {
            await client.download(writer, output, `${volumesEndpoint}/${enc(volume.volumeId)}/files/content`, { path: row.path });
          }
        }
      }
    });
  }
  await writer.json('org/automations.json', automationIndex);
  const workspaceIds = new Set((sets.workspaces ?? []).map(row => row.id));
  for (const thread of threads) if (!workspaceIds.has(thread.workspace_id)) writer.state.warnings[`thread:${thread.id}`] = 'Thread workspace is missing from exported workspace records';
}

export async function findExportDirectory(out: string, orgId: string, baseUrl: string, date = new Date()) {
  const prefix = `camelai-export-${portableSegment(orgId)}-`;
  let entries: string[] = [];
  try { entries = await readdir(out); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  // Resume the most recent matching archive even after midnight. A fresh --out starts a new backup.
  for (const name of entries.filter(name => name.startsWith(prefix) && /-\d{8}$/.test(name)).sort().reverse()) {
    try {
      const state = JSON.parse(await readFile(path.join(out, name, '.org-export-state.json'), 'utf8'));
      if (state.orgId === orgId && state.baseUrl === baseUrl) return path.join(out, name);
    } catch { /* Unrelated/incomplete directories are checked by ExportWriter.open if selected below. */ }
  }
  return path.join(out, `${prefix}${date.toISOString().slice(0, 10).replaceAll('-', '')}`);
}

export async function finishExport(writer: ExportWriter) {
  const warnings = Object.entries(writer.state.warnings).map(([item, error]) => ({ item, error }));
  const counts: Record<string, number> = {};
  for (const [item, record] of Object.entries(writer.state.finished)) {
    const group = item.startsWith('r2/') ? 'r2_objects' : item.endsWith('.bundle') ? 'git_bundles' : item.endsWith('/kv.jsonl') ? 'kv_entries'
      : /\/threads\/[^/]+\.jsonl$/.test(item) ? 'messages' : item.includes('/files/') ? 'files' : item;
    counts[group] = (counts[group] ?? 0) + record.count;
  }
  let org: Row = {};
  try { org = JSON.parse(await readFile(path.join(writer.root, 'org/org.json'), 'utf8')); } catch { /* Already recorded as a warning. */ }
  await writer.json('manifest.json', { format_version: 1, org_id: writer.state.orgId, org_name: org.name ?? null, started: writer.state.started,
    finished: new Date().toISOString(), complete: warnings.length === 0, counts, excluded: writer.state.excluded, warnings });
  await writer.json('path-mapping.json', writer.state.mappings);
  // Customer-facing. The INCOMPLETE line is for us: a backup with warnings is re-run before it is delivered.
  await writer.write('README.md', `# camelAI organization backup

Organization: ${String(org.name ?? writer.state.orgId)} (${writer.state.orgId})
Exported: ${writer.state.started}

A one-time backup of your camelAI organization in open formats: JSON, JSONL, git bundles and your original files. It is a standalone copy and does not load directly into a self-hosted camelAI instance.

## What's inside

- \`org/\`: organization settings, members, workspaces (including archived ones), connections (without credentials), deployed apps and their deploy history, and an index of automations.
- \`workspaces/<workspace>/threads/\`: each chat thread's details (\`<thread>.json\`) and its messages, oldest first, one per line (\`<thread>.jsonl\`). Files the agent kept for a thread are in \`<thread>/files/\`.
- \`workspaces/<workspace>/files/\`: the workspace's files.
- \`workspaces/<workspace>/projects/<project>/files/\`: each project's current files. \`<project>.bundle\` holds its git history, where it has one; restore it with \`git clone <project>.bundle <folder>\`.
- \`workspaces/<workspace>/automations-*.json\`: scheduled prompts, automations and their past versions.
- \`workspaces/<workspace>/apps/<app>/kv.jsonl\`: key-value data your deployed apps stored, one entry per line, values base64-encoded.
- \`r2/R2_BUCKET/\`: uploads, outputs, deployed app code, app previews and app data, under their original storage paths.
- \`manifest.json\`: what was exported, how many of each, and what was left out.
- \`path-mapping.json\`: files keep their original names, except the few listed here. They were renamed to be safe on every disk because they used characters some disks don't allow, differed from another name only in letter case or Unicode form, or named both a file and a folder.
- \`SHA256SUMS\`: a checksum for every file. Check them from this folder with \`sha256sum -c SHA256SUMS\`.

## Good to know

- The export read your data over the course of the run rather than at a single instant, so anything changed while it ran may appear as it was before or after the change.
- Symlinks are listed in \`filesystem.json\` with their targets rather than recreated as links.
- Messages and files are exactly as your team and the agent wrote them, so they may include sensitive business data. Store this backup accordingly.

## Not included

${writer.state.excluded.map(value => `- ${value}`).join('\n')}
${warnings.length ? `\nINCOMPLETE: ${warnings.length} items could not be read. See manifest.json.\n` : ''}`);
  await writer.save();
  await writeChecksums(writer);
  const archive = `${writer.root}.tar.gz`, temp = `${archive}.partial-${crypto.randomUUID()}`;
  try {
    await writeFile(temp, '', { mode: 0o600, flag: 'wx' });
    await command('tar', ['-czf', temp, '--exclude=.org-export-state.json', '-C', path.dirname(writer.root), path.basename(writer.root)]);
    await rename(temp, archive);
  } finally { await rm(temp, { force: true }); }
  const checksumTemp = `${archive}.sha256.partial-${crypto.randomUUID()}`;
  try {
    await writeFile(checksumTemp, `${await fileSha256(archive)}  ${path.basename(archive)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(checksumTemp, `${archive}.sha256`);
  } finally { await rm(checksumTemp, { force: true }); }
  return { archive, warnings: warnings.length };
}
