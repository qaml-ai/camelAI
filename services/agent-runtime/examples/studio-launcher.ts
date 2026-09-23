/** Optional sample applications. Studio itself has no knowledge of their tools or data. */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, copyFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export interface Example { script: string; suggestions: string[] }
export async function startExamples(root: string, env: NodeJS.ProcessEnv, children: Set<ChildProcess>) {
  const here = fileURLToPath(new URL('.', import.meta.url));
  const definitions = [
    { alias: 'release', session: 'typescript-session.json', command: process.execPath, args: [join(here, 'studio-release.ts')],
      suggestions: ['Are we ready to ship? Inspect the board and save a release note.', 'Which open issue needs attention first?'],
      script: `const issues = await tools.list_issues({}); const blockers = issues.filter(i => i.severity === "high" && i.status !== "resolved"); return await tools.save_release_note({note: blockers.length ? "HOLD release: " + blockers.map(i => i.id + " — " + i.title + " (" + i.owner + ")").join("; ") : "Ready to ship. No high-severity blockers."});` },
    { alias: 'inventory', session: 'python-session.json', command: process.env.PYTHON ?? (existsSync(resolve('.agent-runtime/python/bin/python')) ? resolve('.agent-runtime/python/bin/python') : 'python3'), args: [join(here, 'studio-inventory.py')],
      suggestions: ['Check stock and plan restocks for everything below target.', 'How much oat milk do we need?'],
      script: `const rows = await tools.read_inventory({}); return await Promise.all(rows.filter(r => r.stock < r.target).map(r => tools.plan_restock({sku:r.sku, quantity:r.target-r.stock})));` },
  ];
  const examples = new Map<string, Example>(), aliases = new Map<string, string>();
  for (const sample of definitions) {
    const child = spawn(sample.command, sample.args, { env, stdio: ['pipe', 'ignore', 'inherit'] });
    children.add(child);
    child.on('error', error => console.error(`Example application: ${error.message}`));
    const deadline = Date.now() + 15000;
    while (!existsSync(join(root, sample.session)) && child.exitCode === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
    if (!existsSync(join(root, sample.session))) continue;
    const { id } = JSON.parse(readFileSync(join(root, sample.session), 'utf8'));
    examples.set(id, { script: sample.script, suggestions: sample.suggestions });
    aliases.set(sample.alias, id);
    // Preserve old demo permalinks and reviews while migrating to real agent IDs.
    if (!existsSync(join(root, `${id}-runs.json`)) && existsSync(join(root, `${sample.alias}-runs.json`))) copyFileSync(join(root, `${sample.alias}-runs.json`), join(root, `${id}-runs.json`));
  }
  return { examples, aliases };
}
