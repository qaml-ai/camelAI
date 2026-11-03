#!/usr/bin/env bun
/**
 * One-time, read-only backup of one hosted organization. No upload or restore.
 * Usage: bun run org-export -- --env staging|prod --org <orgId> --out <dir> [--concurrency 4]
 * Env: ADMIN_API_KEY for that environment. Requires Bun, git and tar.
 * Base URL: WORKER_BASE_URL in wrangler.<env>.jsonc. See ORG_EXPORT.md.
 */
import path from 'node:path';
import { ExportClient, ExportWriter, EXPORT_USAGE, parseExportArgs, redactError } from './lib/org-export';
import { findExportDirectory, finishExport, walkExport } from './lib/org-export-run';

async function main() {
  const args = parseExportArgs(process.argv.slice(2));
  const key = process.env.ADMIN_API_KEY?.trim();
  if (!key) throw new Error('ADMIN_API_KEY is required');
  const config = Bun.JSONC.parse(await Bun.file(path.join(import.meta.dir, '..', `wrangler.${args.env}.jsonc`)).text());
  const baseUrl = String(config.vars?.WORKER_BASE_URL ?? '').replace(/\/+$/, '');
  if (!baseUrl.startsWith('https://')) throw new Error('Missing HTTPS WORKER_BASE_URL');
  const root = await findExportDirectory(args.out, args.orgId, baseUrl);
  const writer = await ExportWriter.open(root, args.orgId, baseUrl, [key]);
  const client = new ExportClient(baseUrl, args.orgId, key);
  console.log(`Exporting ${args.orgId} (${args.env}) to ${root}`);
  delete writer.state.warnings.walk;
  try { await walkExport(client, writer, args.concurrency); }
  catch (error) { writer.state.warnings.walk = redactError(error, writer.secrets); }
  const result = await finishExport(writer);
  console.log(`${result.archive}: ${Object.keys(writer.state.finished).length} completed items; ${result.warnings} warnings. See manifest.json.`);
  return result.warnings ? 1 : 0;
}
main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`${redactError(error, [process.env.ADMIN_API_KEY ?? ''])}\n${EXPORT_USAGE}`);
  process.exitCode = 1;
});
