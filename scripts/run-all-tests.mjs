#!/usr/bin/env node
// Runs the unit suite and both worker suites concurrently.
//
// They are separate vitest processes with no shared state, and no single one
// saturates the machine on its own: run back-to-back they leave cores idle
// while each waits on its own slowest file. Overlapping them fills those gaps
// and is worth more than any per-suite tuning we measured (154s -> 105s cold
// on a 16-core box).
//
// Each suite still reports independently; this exits non-zero if any fails.
import { spawn } from 'node:child_process';

const SUITES = [
  { name: 'unit', args: ['run'] },
  { name: 'workers-slim', args: ['run', '--config', 'vitest.workers.slim.config.ts'] },
  { name: 'workers-full', args: ['run', '--config', 'vitest.workers.config.ts'] },
];

const started = Date.now();

const results = await Promise.all(
  SUITES.map(
    (suite) =>
      new Promise((resolve) => {
        const child = spawn('npx', ['vitest', ...suite.args], {
          stdio: ['ignore', 'pipe', 'pipe'],
          env: process.env,
        });

        // Collect chunks and join once: these suites emit a lot of sourcemap
        // noise, and repeated string concatenation over megabytes is quadratic.
        const chunks = [];
        child.stdout.on('data', (chunk) => chunks.push(chunk));
        child.stderr.on('data', (chunk) => chunks.push(chunk));

        child.on('close', (code) => {
          // Print each suite's output as a block so concurrent runs stay readable.
          process.stdout.write(`\n${'='.repeat(70)}\n${suite.name}\n${'='.repeat(70)}\n`);
          process.stdout.write(Buffer.concat(chunks).toString());
          resolve({ name: suite.name, code: code ?? 1 });
        });
      }),
  ),
);

const elapsed = ((Date.now() - started) / 1000).toFixed(1);
const failed = results.filter((r) => r.code !== 0);

process.stdout.write(`\n${'='.repeat(70)}\n`);
for (const r of results) {
  process.stdout.write(`${r.code === 0 ? 'PASS' : 'FAIL'}  ${r.name}\n`);
}
process.stdout.write(`total ${elapsed}s\n`);

process.exit(failed.length > 0 ? 1 : 0);
