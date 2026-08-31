# Chat runtime complexity report

Status: **PASS. The replacement production surface is 41.9% smaller than the
frozen pre-migration surface.**

The frozen baseline is the pre-migration dirty working tree documented in
[`BASELINE.md`](./BASELINE.md). The final measurement uses the exact checked-in
[`runtime-source-manifest.json`](./runtime-source-manifest.json). Tests, plans,
and the TLA+ model are excluded.

## Final measurement

Measured 2026-08-27 after the bounded provider, tool-schema, prompt, and legacy
migration paths were included.

| Metric                                |              Lines |
| ------------------------------------- | -----------------: |
| Frozen dirty-tree baseline            |             28,448 |
| Final declared production surface     |         **16,536** |
| Net lines removed                     | **11,912 (41.9%)** |
| Hard final maximum                    |             18,000 |
| Margin below maximum                  |          **1,464** |
| Lifecycle/store/alarm/transport core  |  **2,700 / 3,000** |
| Largest runtime-owned non-shared file |  **1,480 / 1,500** |

| Acceptance item                                       | Result                      |
| ----------------------------------------------------- | --------------------------- |
| Final surface at or below 18,000                      | **PASS: 1,464 lines below** |
| Net reduction from 28,448                             | **PASS: 11,912 lines**      |
| Core at or below 3,000                                | **PASS: 300 lines below**   |
| Every runtime-owned non-shared file at or below 1,500 | **PASS**                    |
| Manifest has no missing or unlisted owned source      | **PASS**                    |

The total deliberately counts the entire 4,554-line shared `Chat.tsx` UI file,
the Worker composition/authentication roots, and the complete prompt/self-host
skill helpers. Only `Chat.tsx` is exempt from the per-file cap because most of it
is shared application UI; none of its lines are exempt from the aggregate. This
is conservative relative to the frozen baseline, which did not count those
shared files.

The four-file server lifecycle/store/alarm/transport core is only 2,700 lines.
The largest non-shared replacement file is the 1,480-line bounded legacy-session
importer. The Pi adapter, including strict provider output and tool-schema
normalization, is 981 lines.

The gate and complete per-file report are reproducible with:

```bash
bun run check:chat-runtime-size
bun run report:chat-runtime-complexity
```
