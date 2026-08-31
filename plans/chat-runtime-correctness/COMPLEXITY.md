# Chat runtime complexity report

Status: **PASS, with a narrow margin. The checked-in replacement production
surface is 36.8% smaller than the frozen pre-migration surface.**

The frozen baseline is the pre-migration dirty working tree documented in
[`BASELINE.md`](./BASELINE.md). The final measurement uses the exact checked-in
[`runtime-source-manifest.json`](./runtime-source-manifest.json). Tests, plans,
and the TLA+ model are excluded.

## Current measurement

Measured 2026-08-30 after bounded migration-on-open, live presentation,
provider/tool memory hardening, and the regression audit fixes were included.

| Metric                                |              Lines |
| ------------------------------------- | -----------------: |
| Frozen dirty-tree baseline            |             28,448 |
| Current declared production surface   |         **17,989** |
| Net lines removed                     | **10,459 (36.8%)** |
| Hard final maximum                    |             18,000 |
| Margin below maximum                  |             **11** |
| Lifecycle/store/alarm/transport core  |  **2,988 / 3,000** |
| Largest runtime-owned non-shared file |  **1,469 / 1,500** |

| Acceptance item                                       | Result                      |
| ----------------------------------------------------- | --------------------------- |
| Final surface at or below 18,000                      | **PASS: 11 lines below**    |
| Net reduction from 28,448                             | **PASS: 10,459 lines**      |
| Core at or below 3,000                                | **PASS: 12 lines below**    |
| Every runtime-owned non-shared file at or below 1,500 | **PASS**                    |
| Manifest has no missing or unlisted owned source      | **PASS**                    |

The total deliberately counts the entire 4,554-line shared `Chat.tsx` UI file,
the Worker composition/authentication roots, and the complete prompt/self-host
skill helpers. Only `Chat.tsx` is exempt from the per-file cap because most of it
is shared application UI; none of its lines are exempt from the aggregate. This
is conservative relative to the frozen baseline, which did not count those
shared files.

The four-file server lifecycle/store/alarm/transport core is 2,988 lines. The
largest non-shared replacement file is the 1,469-line runtime DO facade. The Pi
adapter, including strict provider output and tool-schema normalization, is
1,260 lines; the legacy-session importer is 1,095 lines.

Line count is not sufficient evidence by itself. The current declared manifest
is 609,851 bytes versus 1,121,992 bytes for the frozen file list at the closest
clean historical commit (45.6% smaller). Formatting every current file with the
repository's installed Prettier would yield 18,671 lines: still 34.4% smaller
than the frozen 28,448-line source, but 682 lines above the checked-in count.
This demonstrates a genuine byte/source reduction while also exposing that the
hard line gate has encouraged dense formatting and now has almost no headroom.

This report covers the declared replacement chat surface only. The wider memory
hardening work in workspace, analysis, code-mode, build, and deploy is not
globally smaller: it is currently about 11,544 net new production lines versus
`origin/main`. That broader growth is documented as a complexity/cold-start
risk in `PERFORMANCE-REGRESSION-AUDIT.md` and must not be conflated with the
chat-lifecycle reduction.

The gate and complete per-file report are reproducible with:

```bash
bun run check:chat-runtime-size
bun run report:chat-runtime-complexity
```
