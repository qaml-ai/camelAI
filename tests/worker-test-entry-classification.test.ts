import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FULL_ENTRY_TESTS } from '../vitest.workers.full-entry-tests';

// Worker tests are split across two entries for speed: most run against the
// slim entry (workers/main/tests/slim-entry.ts), which omits ChatThreadDO and
// its ~9s-per-isolate dependency graph. Tests that need the real worker entry
// are listed in FULL_ENTRY_TESTS.
//
// If a test starts using SELF routing, chat, code-mode, workflows, or a
// container sandbox but stays on the slim entry, it fails with a confusing
// missing-binding error. This test turns that into a clear message instead.

const NEEDS_FULL_ENTRY: RegExp[] = [
  /\bSELF\b/,
  /chat-thread/,
  /ChatThreadDO/,
  /code-mode/,
  /CodeMode/,
  /DeterministicAutomationWorkflow/,
  /\bCHAT_THREAD\b/,
  /\bEVAL_SANDBOX\b/,
  /\bPROJECT_BUILD_SANDBOX\b/,
  /\bANALYSIS_SANDBOX\b/,
  /\bDETERMINISTIC_AUTOMATION_WORKFLOWS\b/,
  /\bCODE_MODE_LOADER\b/,
];

function workerTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) workerTestFiles(full, out);
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}

describe('worker test entry classification', () => {
  const repoRoot = path.resolve(__dirname, '..');
  const files = workerTestFiles(path.join(repoRoot, 'workers'));
  const listed = new Set(FULL_ENTRY_TESTS);

  it('lists every test that needs the full worker entry', () => {
    const missing: string[] = [];

    for (const file of files) {
      const rel = path.relative(repoRoot, file).split(path.sep).join('/');
      if (listed.has(rel)) continue;

      const source = fs.readFileSync(file, 'utf8');
      if (!source.includes('cloudflare:test')) continue;
      if (NEEDS_FULL_ENTRY.some((pattern) => pattern.test(source))) missing.push(rel);
    }

    expect(
      missing,
      `These worker tests need the real worker entry but are not in ` +
        `vitest.workers.full-entry-tests.ts, so they run against the slim ` +
        `entry and will fail with a missing-binding error:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('only lists worker tests that exist', () => {
    const stale = FULL_ENTRY_TESTS.filter(
      (rel) => !fs.existsSync(path.join(repoRoot, rel)),
    );
    expect(stale, `Stale entries in vitest.workers.full-entry-tests.ts`).toEqual([]);
  });
});
