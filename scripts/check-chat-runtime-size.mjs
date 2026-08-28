import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath =
  "plans/chat-runtime-correctness/runtime-source-manifest.json";
const reportOnly = process.argv.slice(2).includes("--report");
const unknown = process.argv.slice(2).filter((arg) => arg !== "--report");
if (unknown.length) throw new Error(`Unknown option: ${unknown.join(", ")}`);

const manifest = JSON.parse(readFileSync(join(root, manifestPath), "utf8"));
const {
  baselineLines,
  hardMaximumLines,
  hardMaximumFileLines,
  coreMaximumLines,
} = manifest;
const files = manifest.files;
const sharedIntegrationFiles = manifest.sharedIntegrationFiles ?? [];
const coreFiles = manifest.coreFiles ?? [];
const errors = [];

// V2 authorization and route dispatch live in the shared Worker composition
// root. Counting the whole file is intentionally conservative and prevents a
// manifest edit from hiding that integration seam outside chat-thread/.
const requiredIntegrationFiles = [
  "src/components/Chat.tsx",
  "src/hooks/use-chat-transcript.ts",
  "workers/main/src/helpers/auth.ts",
  "workers/main/src/index.ts",
  "workers/main/src/pi-system-prompt.ts",
  "workers/main/src/selfhost-agent-pack.ts",
];

const sorted = (values) =>
  [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const unique = new Set(files);
if (unique.size !== files.length)
  errors.push("manifest contains duplicate files");
if (JSON.stringify(files) !== JSON.stringify(sorted(files))) {
  errors.push("manifest files must be sorted");
}
for (const path of requiredIntegrationFiles) {
  if (!files.includes(path)) {
    errors.push(`required shared integration source is uncounted: ${path}`);
  }
  if (!manifest.watchedFiles.includes(path)) {
    errors.push(`required shared integration source is unwatched: ${path}`);
  }
}
for (const key of [
  "baselineLines",
  "hardMaximumLines",
  "hardMaximumFileLines",
  "coreMaximumLines",
]) {
  if (!Number.isSafeInteger(manifest[key]) || manifest[key] <= 0) {
    errors.push(`${key} must be a positive integer`);
  }
}
for (const [key, values] of [
  ["sharedIntegrationFiles", sharedIntegrationFiles],
  ["coreFiles", coreFiles],
]) {
  if (new Set(values).size !== values.length) {
    errors.push(`${key} contains duplicate files`);
  }
  if (JSON.stringify(values) !== JSON.stringify(sorted(values))) {
    errors.push(`${key} must be sorted`);
  }
  for (const path of values) {
    if (!files.includes(path))
      errors.push(`${key} source is uncounted: ${path}`);
  }
}

function sourceFiles(directory) {
  const absolute = join(root, directory);
  if (!existsSync(absolute)) return [];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const path = join(absolute, entry.name);
    if (entry.isDirectory()) return sourceFiles(relative(root, path));
    return [".ts", ".tsx"].includes(extname(entry.name))
      ? [relative(root, path)]
      : [];
  });
}

const owned = new Set(
  manifest.ownedDirectories
    .flatMap(sourceFiles)
    .concat(
      manifest.watchedFiles.filter((path) => existsSync(join(root, path))),
    ),
);
for (const path of sorted(owned)) {
  if (!unique.has(path))
    errors.push(`runtime-owned source is unlisted: ${path}`);
}
for (const path of files) {
  if (!existsSync(join(root, path))) {
    errors.push(`manifest source is missing: ${path}`);
  }
}

const physicalLines = (source) => {
  if (source.length === 0) return 0;
  const lines = source.split(/\r\n|\r|\n/).length;
  return /(?:\r\n|\r|\n)$/.test(source) ? lines - 1 : lines;
};
const rows = files
  .filter((path) => existsSync(join(root, path)))
  .map((path) => ({
    path,
    lines: physicalLines(readFileSync(join(root, path), "utf8")),
  }));
const total = rows.reduce((sum, row) => sum + row.lines, 0);
const reduction = baselineLines - total;
const reductionPercent = (reduction / baselineLines) * 100;
const sharedIntegration = new Set(sharedIntegrationFiles);
const oversized = rows.filter(
  (row) => !sharedIntegration.has(row.path) && row.lines > hardMaximumFileLines,
);
const core = new Set(coreFiles);
const coreLines = rows
  .filter((row) => core.has(row.path))
  .reduce((sum, row) => sum + row.lines, 0);
for (const path of coreFiles) {
  if (!rows.some((row) => row.path === path)) {
    errors.push(`core source is missing: ${path}`);
  }
}
const passes =
  errors.length === 0 &&
  total <= hardMaximumLines &&
  coreLines <= coreMaximumLines &&
  oversized.length === 0;
const bySize = [...rows].sort(
  (a, b) => b.lines - a.lines || (a.path < b.path ? -1 : 1),
);

if (reportOnly) {
  console.log("# Chat runtime complexity report\n");
  console.log("| Metric | Lines |");
  console.log("| --- | ---: |");
  console.log(
    `| Frozen dirty-tree baseline | ${baselineLines.toLocaleString("en-US")} |`,
  );
  console.log(
    `| Current declared production surface | ${total.toLocaleString("en-US")} |`,
  );
  console.log(
    `| Net reduction | ${reduction.toLocaleString("en-US")} (${reductionPercent.toFixed(1)}%) |`,
  );
  console.log(`| Hard maximum | ${hardMaximumLines.toLocaleString("en-US")} |`);
  console.log(
    `| Server lifecycle/store/alarm/transport core | ${coreLines.toLocaleString("en-US")} / ${coreMaximumLines.toLocaleString("en-US")} |`,
  );
  console.log(`| Status | ${passes ? "PASS" : "IN PROGRESS / FAIL"} |\n`);
  if (!passes) {
    console.log("## Blocking gates\n");
    for (const error of errors) console.log(`- ${error}`);
    if (total > hardMaximumLines) {
      console.log(
        `- Total exceeds the budget by ${(total - hardMaximumLines).toLocaleString("en-US")} lines.`,
      );
    }
    if (coreLines > coreMaximumLines) {
      console.log(
        `- Core exceeds the budget by ${(coreLines - coreMaximumLines).toLocaleString("en-US")} lines.`,
      );
    }
    for (const row of oversized) {
      console.log(
        `- \`${row.path}\` exceeds the per-file cap by ${(row.lines - hardMaximumFileLines).toLocaleString("en-US")} lines.`,
      );
    }
    console.log();
  }
  console.log("| Lines | Production file |");
  console.log("| ---: | --- |");
  for (const row of bySize) {
    const label = sharedIntegration.has(row.path)
      ? `${row.path} (shared integration; counted in total)`
      : row.path;
    console.log(`| ${row.lines.toLocaleString("en-US")} | \`${label}\` |`);
  }
} else {
  console.log("Lines  Production file");
  for (const row of bySize) {
    console.log(`${String(row.lines).padStart(5)}  ${row.path}`);
  }
  console.log(`${String(total).padStart(5)}  TOTAL`);
  console.log(`Baseline: ${baselineLines.toLocaleString("en-US")}`);
  console.log(
    `Reduction: ${reduction.toLocaleString("en-US")} (${reductionPercent.toFixed(1)}%)`,
  );
  console.log(`Hard maximum: ${hardMaximumLines.toLocaleString("en-US")}`);
  console.log(
    `Core: ${coreLines.toLocaleString("en-US")} / ${coreMaximumLines.toLocaleString("en-US")}`,
  );
}

if (!reportOnly && !passes) {
  for (const error of errors) console.error(`ERROR: ${error}`);
  if (total > hardMaximumLines) {
    console.error(
      `ERROR: total exceeds the budget by ${(total - hardMaximumLines).toLocaleString("en-US")} lines`,
    );
  }
  if (coreLines > coreMaximumLines) {
    console.error(
      `ERROR: core exceeds the budget by ${coreLines - coreMaximumLines} lines`,
    );
  }
  for (const row of oversized) {
    console.error(
      `ERROR: ${row.path} exceeds the per-file cap by ${row.lines - hardMaximumFileLines} lines`,
    );
  }
  process.exitCode = 1;
}
