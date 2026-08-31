#!/usr/bin/env node
/**
 * UNBOUNDED pi_core API QUARANTINE
 * (plans/sse-migration/BOUNDED-MEMORY-BY-CONSTRUCTION.md §2d).
 *
 * Three reads materialize an entire chat transcript. They are named for what
 * they cost, and this check pins the exact set of places that may call them.
 * Adding a caller is a deliberate act that fails CI until it is written down
 * here with a reason — which is the point: every one of the four production OOMs
 * this month was a full-transcript read added to a request path by someone who
 * did not know it was one.
 *
 * BOUNDED ALTERNATIVES, so a reviewer never has to guess:
 *   - a render page              → ChatThreadDO#deriveRenderWindow / getDerivedUiMessagePage
 *   - the model's session view    → PiCoreMessageStore#loadBoundedPiCoreSessionWindow
 *   - a forward walk of new rows  → ChatThreadDO#readParsedPiCoreRowRange
 *   - "what is in this window?"   → PiCoreMessageStore#piCoreVisibleWindowTotals / listPiCoreRowMeta*
 *
 * Run: node scripts/check-unbounded-pi-core-callers.mjs
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The reads that materialize a whole transcript. */
export const GUARDED_IDENTIFIERS = [
  // PiCoreMessageStore + its ChatThreadDO delegate: every visible row, parsed,
  // resident.
  "loadFullPiCoreTranscriptUnbounded",
  // The same thing converted to render messages.
  "loadFullPiCoreParsedTranscriptUnbounded",
  // The public RPC over the parsed load. Guarded as well as its implementation,
  // because an RPC name is exactly how a new request path would reach it.
  "getPiCoreParsedMessages",
];

/** Source trees the check governs. Tests are deliberately excluded. */
export const SCANNED_DIRECTORIES = ["workers/main/src", "src"];

/**
 * file → identifier → { count, why }.
 *
 * `count` is exact on purpose. A file already on the list gaining a SECOND call
 * is precisely the regression this exists to catch, so "the file is allowed"
 * is not enough — each call site is.
 */
export const ALLOWLIST = {
  "workers/main/src/chat-thread/pi-core-store.ts": {
    loadFullPiCoreTranscriptUnbounded: {
      count: 3,
      why:
        "1 declaration; 1 use inside loadBoundedPiCoreSessionWindow's UNDER-CAP branch (the " +
        "bounded loader is defined as 'the legacy load when the legacy load is affordable'); " +
        "1 in appendPiCoreMessagesIfMissing. THE LAST ONE IS A KNOWN REMAINING O(thread) READ " +
        "on the turn-end commit path — it reloads the transcript purely to build dedup keys. " +
        "It is bounded in practice by the compaction watermark and is tracked as the next " +
        "target; do not add a fourth.",
    },
  },
  "workers/main/src/chat-thread-do.ts": {
    loadFullPiCoreTranscriptUnbounded: {
      count: 5,
      why:
        "1 declaration + 1 delegate body; getAdminExplorerSummary (admin tooling); " +
        "getPiCoreForkMessages (fork seeding genuinely needs every row); and the parsed " +
        "transcript load below.",
    },
    loadFullPiCoreParsedTranscriptUnbounded: {
      count: 2,
      why: "1 declaration + the public RPC wrapper that is its only caller.",
    },
    getPiCoreParsedMessages: {
      count: 5,
      why:
        "1 RPC declaration; getGroupNewChatRecentSource (group-chat seeding); agentEvalResult " +
        "(eval harness, off the user path); and the uiMirror dep wiring, which names the " +
        "identifier twice on one line (key + delegate) and whose only remaining consumer is " +
        "the one-shot legacy author heal.",
    },
  },
  "workers/main/src/chat-thread/ui-mirror.ts": {
    getPiCoreParsedMessages: {
      count: 2,
      why:
        "1 dep type; healLegacyUiMessageAuthors, a one-shot gated migration for rows written " +
        "before author metadata existed. Delete both when that heal is retired — the top-up " +
        "itself reads ranges now (stage 2b).",
    },
  },
  "workers/main/src/routes/admin-mcp.ts": {
    getPiCoreParsedMessages: {
      count: 3,
      why: "admin MCP transcript export: a stub type, a capability probe, and the call.",
    },
  },
  "workers/main/src/routes/admin/helpers.ts": {
    getPiCoreParsedMessages: {
      count: 3,
      why: "admin thread inspector: a stub type, a capability probe, and the call.",
    },
  },
  "src/lib/chat-do.server.ts": {
    getPiCoreParsedMessages: {
      count: 2,
      why: "server-side admin/export loader: a stub type and the call.",
    },
  },
};

/** Comment lines mention these APIs constantly; only CODE counts. */
function isCommentLine(line) {
  const trimmed = line.trim();
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("*") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*/")
  );
}

/**
 * Count guarded identifiers per file. `sources` is `{ [relativePath]: contents }`
 * so the checker can be run against synthetic files (that is how the test proves
 * the check itself has teeth).
 */
export function countGuardedCallers(sources) {
  const counts = {};
  for (const [file, contents] of Object.entries(sources)) {
    const lines = contents.split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index];
      if (isCommentLine(line)) continue;
      for (const identifier of GUARDED_IDENTIFIERS) {
        // Whole-identifier matches only, and count EVERY occurrence on the line.
        const matches = line.match(
          new RegExp(`(?<![A-Za-z0-9_$])${identifier}(?![A-Za-z0-9_$])`, "g"),
        );
        if (!matches) continue;
        counts[file] ??= {};
        counts[file][identifier] ??= { count: 0, lines: [] };
        counts[file][identifier].count += matches.length;
        counts[file][identifier].lines.push(index + 1);
      }
    }
  }
  return counts;
}

/**
 * Human-readable violations: new callers, new files, and stale allowlist rows.
 *
 * @param {Record<string, string>} sources
 * @param {Record<string, Record<string, { count: number, why: string }>>} [allowlist]
 */
export function checkGuardedCallers(sources, allowlist = ALLOWLIST) {
  const counts = countGuardedCallers(sources);
  const violations = [];
  for (const [file, byIdentifier] of Object.entries(counts)) {
    for (const [identifier, found] of Object.entries(byIdentifier)) {
      const allowed = allowlist[file]?.[identifier];
      if (!allowed) {
        violations.push(
          `${file}: ${identifier} used ${found.count}x (lines ${found.lines.join(", ")}) but this ` +
            `file is not allowlisted for it. Use a bounded reader, or add an entry to ` +
            `scripts/check-unbounded-pi-core-callers.mjs explaining why the whole transcript is required.`,
        );
        continue;
      }
      if (found.count > allowed.count) {
        violations.push(
          `${file}: ${identifier} used ${found.count}x (lines ${found.lines.join(", ")}), allowlist ` +
            `permits ${allowed.count}. A NEW unbounded call site was added. Reason on record: ${allowed.why}`,
        );
      } else if (found.count < allowed.count) {
        violations.push(
          `${file}: ${identifier} used ${found.count}x, allowlist still permits ${allowed.count}. ` +
            `A caller was removed — lower the count so the quarantine keeps ratcheting down.`,
        );
      }
    }
  }
  for (const [file, byIdentifier] of Object.entries(allowlist)) {
    // Only files actually scanned can be judged stale — a caller-side check run
    // over a synthetic subset knows nothing about the rest of the repository.
    if (sources[file] === undefined) continue;
    for (const identifier of Object.keys(byIdentifier)) {
      if (counts[file]?.[identifier]) continue;
      violations.push(
        `${file}: allowlisted for ${identifier} but it is no longer used there. Remove the entry.`,
      );
    }
  }
  return violations.sort();
}

function collectSourceFiles(root, directories) {
  const sources = {};
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute)) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      const child = path.join(absolute, entry);
      const stats = statSync(child);
      if (stats.isDirectory()) {
        walk(child);
        continue;
      }
      if (!/\.(ts|tsx|mts|js|mjs)$/.test(entry)) continue;
      sources[path.relative(root, child)] = readFileSync(child, "utf8");
    }
  };
  for (const directory of directories) walk(path.join(root, directory));
  return sources;
}

export function checkRepository(root = REPO_ROOT) {
  return checkGuardedCallers(collectSourceFiles(root, SCANNED_DIRECTORIES));
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const violations = checkRepository();
  if (violations.length > 0) {
    console.error("Unbounded pi_core API quarantine violated:\n");
    for (const violation of violations) console.error(`  - ${violation}`);
    process.exit(1);
  }
  console.log("Unbounded pi_core API quarantine: OK");
}
