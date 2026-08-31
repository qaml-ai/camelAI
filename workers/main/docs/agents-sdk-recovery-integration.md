# Agents SDK durable-resume integration — findings & recommendation

Investigation of the installed `agents` package (v0.16.2) at
`node_modules/agents/dist`, against `ChatThreadDO extends Agent<...>` in
`workers/main/src/chat-thread-do.ts`. Goal: borrow the SDK's durable-resume
engine to auto-resume a pi turn interrupted by a mid-turn DO eviction, **without**
re-platforming onto AIChatAgent / `onChatMessage`, and while keeping
pi-agent-core as the loop, pi's model/provider config, and pi's event shapes.

Line refs below are into the installed dist:
- `index.js` — base `Agent` runtime (bundled).
- `agent-tool-types-CTw3UJUP.d.ts` — base `Agent` class type surface (decl at L2415).
- `chat/index.d.ts` — shared chat primitives + chat-recovery **types**.

---

## TL;DR recommendation

**Wrap each pi turn in `this.runFiber(...)` and implement `onFiberRecovered()`
to re-drive pi.** This is the only SDK path that satisfies the hard constraints.
`chatRecovery` / `chat:recovery:*` is **not usable** — it lives entirely in the
chat subclass (`Think`/`AIChatAgent`, in the separate `@cloudflare/ai-chat`
package which is **not even installed** here) and the base `Agent` has "no
recovery budget" (comment at `agent-tool-types` L3732). The base `Agent` never
evaluates `chatRecovery`; it only reads `this.chatRecovery` defensively to print
a warning (`index.js` L947, L956–960).

Fiber recovery is **re-invoke-from-the-top, NOT replay**. The SDK does not re-run
your original `fn` on wake — it calls `onFiberRecovered(ctx)` once, handing you
the last `stash()` snapshot, and then deletes the orphan row. So **we** re-derive
state and call `this.piSession.continue()` ourselves. That is exactly what our
existing `pi_turn_journal` + `planPiTurnResume` layer already computes — so the
fiber gives us the missing piece (an **automatic wake trigger**) and our journal
gives us the correct **resume content**. Keep the journal; add the fiber.

---

## 1. FIBER API (durable execution primitive)

Public surface on the base `Agent` (`agent-tool-types-CTw3UJUP.d.ts`):

- `runFiber<T>(name: string, fn: (ctx: FiberContext) => Promise<T>): Promise<T>` — L3219
- `startFiber(name, fn, options?: StartFiberOptions): Promise<StartFiberResult>` — L3234 (managed/ledger variant, idempotencyKey, waitForCompletion)
- `onFiberRecovered(ctx: FiberRecoveryContext): Promise<void | FiberRecoveryResult>` — L3258 (override point; default just `console.warn`, `index.js` L2901)
- `stash(data: unknown): void` — L3248 (checkpoint; synchronous SQLite write)
- `inspectFiber` L3198, `listFibers` L3200, `cancelFiber` L3201, `resolveFiber` L3203, `deleteFibers` L3204.

`FiberContext` (L2092): `{ id, signal: AbortSignal, stash(data), snapshot }`.
`FiberRecoveryContext` (L2163): `{ id, name, status?, idempotencyKey?, metadata?,
snapshot, createdAt, recoveryReason: "interrupted", [k]: unknown }`.

**It is a generic "run this async fn durably" primitive**, not pi-specific.
Mechanics (`index.js`):
- `runFiber` → `_runFiberInternal(nanoid(), name, fn)` (L2693).
- `_runFiberInternal` (L2798): `INSERT INTO cf_agents_runs (id,name,snapshot,created_at)` **before** running (L2800), emits `fiber:run:started` (L2805), holds `keepAlive()` for the duration (L2832, prevents idle eviction), runs `fn` inside an `AsyncLocalStorage` so `stash()` maps to the right fiber (L2837–2846). On normal completion it emits `fiber:run:completed` and deletes the row.
- `stash(data)` writes `UPDATE cf_agents_runs SET snapshot=? WHERE id=?` (L2811–2820) — a synchronous checkpoint.

**Recovery trigger:** on wake, the onStart wrapper calls `await this._checkRunFibers()` (`index.js` L945) — **before** the user's `onStart` body runs (the body runs at L952). `_checkRunFibers` (L2913):
1. `SELECT ... FROM cf_agents_runs` — any row still present = a fiber that started but never completed/deleted = interrupted by eviction.
2. Skips fibers currently live in-process (`_runFiberActiveFibers`, L2932).
3. Emits `fiber:recovery:detected` (L2942) and `fiber:run:interrupted` (L2946).
4. Calls `_runFiberRecoveryHook(ctx, managedRow)` (L2973) → emits `fiber:recovery:attempt` (L2504) → `await this.onFiberRecovered(ctx)` (L2508) → emits `fiber:recovery:handled` (L2511).
5. Deletes the orphan `cf_agents_runs` row afterward (L2982).

So: **the SDK auto-runs recovery on the next wake; you do not call anything in
`onStart`.** You only override `onFiberRecovered`. There is no auto re-run of the
original `fn`.

## 2. Can we wrap the pi turn driver in a fiber? Replay or re-invoke?

Yes. Call shape:

```ts
await this.runFiber("pi-turn", async (fiber) => {
  fiber.stash({ kind: "prompt", baseline: this.piMainBaselineIndex });
  await this.piSession!.prompt(userMessage);   // or .continue() on resume
});
```

**Re-invoke-from-the-top, NOT durable replay.** Proof: `_checkRunFibers` never
calls the original `fn` — it only calls `onFiberRecovered(ctx)` (L2508) and then
deletes the row (L2982). Completed steps inside `fn` are gone. `ctx.snapshot` is
only whatever you last `stash()`'d. Therefore **we** re-derive resume state and
call `this.piSession.continue()` ourselves inside `onFiberRecovered`. This is the
"WE re-derive state from pi_core_messages + call continue()" branch — which is
fine and is exactly what `planPiTurnResume(persistedMessages, journalTail)`
already does (`chat-thread-do.ts` L9013).

Note: recovery runs **before** `onStart` body, but `createPiSession()` runs inside
`onStart`. So in `onFiberRecovered` the pi session may not be built yet — schedule
the resume rather than driving pi inline (see sketch).

## 3. CHAT RECOVERY — does `chat:recovery` need AIChatAgent?

**Yes — it is unavailable to us.** Findings:
- `chatRecovery`, `chat:recovery:*`, `recoveryKind`, `continueLastTurn`,
  `onChatRecovery`, `onChatMessage` are **NOT declared on the base `Agent`**
  (none found in `agent-tool-types-CTw3UJUP.d.ts` as members; the only hits are a
  warn-guard field `_warnedChatRecoveryInOnStart` L2459 and doc-comment mentions).
- The base `Agent` runtime only *reads* `this.chatRecovery` to emit a one-time
  warning (`index.js` L947/L956–960). It never evaluates budgets, never seals a
  turn, never calls `continueLastTurn`. Comment confirms: "The base Agent has no
  recovery budget, so this is a no-op" (`agent-tool-types` L3732).
- The actual chat-recovery engine + `AIChatAgent` class live in
  **`@cloudflare/ai-chat`** (`ai-chat-agent.js`: `export * from "@cloudflare/ai-chat"`;
  the deprecation log confirms the move). The chat-recovery driver that calls
  `continueLastTurn()` → `onChatMessage()` is "shared between AIChatAgent and
  Think" (`chat/index.d.ts` L1025/L1097/L1207) — both chat subclasses.
- `@cloudflare/ai-chat` is **not installed** in this repo
  (`node_modules/@cloudflare/` has no `ai-chat`). `agents/dist/chat/index.js`
  ships only shared primitives (sanitize, `StreamAccumulator`, `TurnQueue`,
  `ResumableStream`) and the recovery **types** — not the driver.

There is **no generic overridable `onRecover` / `onChatRecover` on the base
Agent** that we could implement to call `this.piSession.continue()`. The recovery
config types (`ChatRecoveryConfig`, `onExhausted`, `shouldKeepRecovering`,
`onChatRecovery`, `continueLastTurn`) are all AIChatAgent/Think machinery.

## 4. CONFIG shapes

- `chatRecovery: ChatRecoveryConfig` (`chat/index.d.ts` L496) — `boolean | { maxAttempts?, stableTimeoutMs?, terminalMessage?, noProgressTimeoutMs?, maxRecoveryWork?, shouldKeepRecovering?(ctx), onExhausted?(ctx) }`. `true` → defaults `maxAttempts:10, stableTimeoutMs:10_000, noProgressTimeoutMs:300_000, maxRecoveryWork:Infinity`. **Must be a class field / set in constructor — NOT in `onStart`** (it's read on wake before `onStart`; warning at `index.js` L960). **Not applicable to us** (AIChatAgent-only).
- Fiber options: `StartFiberOptions` (L2107) `{ fiberId?, idempotencyKey?, metadata?, waitForCompletion? }` (only for `startFiber`; `runFiber` takes none). Static tuning on `AgentStaticOptions` (L2296+): `fiberRecoveryHookTimeoutMs` (10s — bounds *internal* hooks; user `onFiberRecovered` is NOT timed out by default, see L2346), `fiberRecoveryScanDeadlineMs` (10s), `fiberRecoveryMaxAgeMs` (24h — orphan rows older than this are skipped with `reason:"max_age_exceeded"`, `index.js` L2976). Set via `static options = {...}` on the class.

## 5. GOTCHAS vs. our pi stores

- **No transcript conflict.** Fibers use `cf_agents_runs` (orphan markers) and
  optionally `cf_agents_fibers` (ledger). The SDK does **not** read or own
  `pi_core_messages` or `this.piSession.state.messages`. The chat *message store*
  that would conflict lives in AIChatAgent, which we are not using.
- **No `setState` requirement.** `runFiber` / `onFiberRecovered` do not touch
  `this.setState` / SDK agent state. Our `stash()` payload is freeform JSON.
- **`keepAlive()` during the fiber** (`index.js` L2832) actively prevents idle
  eviction mid-turn — a bonus, but be aware it changes alarm scheduling slightly.
- **Recovery runs before `createPiSession`** (recovery at L945, `onStart` body
  with our session build at L952). `onFiberRecovered` must therefore *schedule* a
  resume, not drive pi inline. Use the SDK's own `schedule(0, "methodName", ...)`
  (`agent-tool-types` L3036) or set a flag consumed at end of `onStart`.
- **Double-resume risk.** We already lazily resume in `createPiSession` when
  `readPiActiveTurn()` is set (`chat-thread-do.ts` L9011). If we add fiber-driven
  resume, gate both through the same `pi_active_turn` marker + attempt counter so
  exactly one resume fires (the journal already tracks `attempt`, L6393).
- **Fiber must not double-count completed turns.** Delete/clear the active-turn
  marker inside the fiber body on success so the row removal and our journal
  commit stay consistent.

## 6. RECOMMENDATION — wrap pi turn in a fiber; keep the journal

Chosen path: **wrap-pi-turn-in-fiber + `onFiberRecovered` that schedules a
`continue()`-style resume**, reusing the existing `pi_turn_journal` /
`planPiTurnResume` machinery for *content*. The fiber supplies the missing
*automatic wake trigger*; our journal supplies the correct resume messages. Do
**not** drop the hand-rolled journal — fiber recovery is re-invoke (not replay),
so the journal is still the source of truth for what to resume. Do **not** pursue
`chatRecovery` (AIChatAgent-only, package not installed).

Concrete sketch for `chat-thread-do.ts` (driver side, ~L8461 and the eval path
~L12526 both call `piSession.prompt`; wrap them the same way):

```ts
// --- turn driver: wrap the existing prompt() call in a durable fiber ---
// (replaces the bare `await this.piSession.prompt(userMessage)` at ~L8461)
this.ensurePiActiveTurn(/* baseline */ this.piMainBaselineIndex); // existing marker
await this.runFiber("pi-turn", async (fiber) => {
  fiber.stash({ baseline: this.piMainBaselineIndex }); // coarse checkpoint
  await this.piSession!.prompt(userMessage);
  this.clearPiActiveTurn(); // success: drop marker so recovery won't re-fire
});

// --- recovery hook: SDK calls this on the next wake, BEFORE onStart body ---
override async onFiberRecovered(ctx: FiberRecoveryContext): Promise<void> {
  if (ctx.name !== "pi-turn") return;                 // ignore other fibers
  if (!this.readPiActiveTurn()) return;               // already committed → no-op
  // Can't touch pi inline (session not built until onStart body). Schedule a
  // resume; the handler rebuilds the session and re-derives state from the
  // journal exactly like the lazy path at L9011-9021.
  await this.schedule(0, "resumeInterruptedPiTurn", { fiberId: ctx.id });
}

// --- scheduled resume handler: re-drive pi via continue() ---
async resumeInterruptedPiTurn(_payload: { fiberId: string }): Promise<void> {
  const marker = this.readPiActiveTurn();
  if (!marker) return;
  await this.ensurePiSession();                        // builds session; createPiSession
                                                        // already folds in journalTail via
                                                        // planPiTurnResume (L9011-9021)
  const persisted = await this.loadPiCoreMessages();
  const plan = planPiTurnResume(persisted, await this.loadPiTurnJournalTail());
  // Re-wrap the resume in a fresh fiber so a second eviction is also covered:
  await this.runFiber("pi-turn", async () => {
    if (plan.owesModelOutput) await this.piSession!.continue();
    this.clearPiActiveTurn();
  });
}
```

`schedule()` (`agent-tool-types` L3036) and `alarm()` are SDK-owned, so the
scheduled `resumeInterruptedPiTurn` runs reliably after `onStart` completes and
the session exists. `planPiTurnResume`'s `owesModelOutput` (L6412) tells us
whether to call `continue()` (partial assistant turn) or treat the turn as
already complete.

### Keep vs. drop the hand-rolled `pi_turn_journal` wiring

**KEEP it.** It is load-bearing in this design:
- Fiber recovery is re-invoke, not replay → the SDK gives us *when* to resume but
  not *what* to resume. `pi_turn_journal` + `planPiTurnResume` is exactly the
  "what" (synthesize interrupted tool results, reorder reasoning, decide
  `owesModelOutput`).
- It also already handles the case the SDK fiber does **not**: lazy resume on the
  next user-initiated `createPiSession` even if no alarm fired.

The fiber is purely additive: it converts our *passive, next-request* resume into
an *active, on-wake* resume, and adds `keepAlive()` protection during the turn.

### Minimal-change alternative (if we want zero new SDK surface)

If touching `runFiber` feels too invasive, replicate the trigger with primitives
we already see are base-Agent-supported: in `onStart`, after building the session,
`if (this.readPiActiveTurn()) await this.schedule(0, "resumeInterruptedPiTurn")`.
This gets on-wake auto-resume using only `schedule()` + our journal, with no fiber
at all. It loses `keepAlive()`-during-turn and the `fiber:*` observability, but is
the smallest possible change and keeps us 100% off the chat-recovery path. Prefer
the fiber version for the eviction-during-turn keepAlive benefit and the built-in
`fiber:recovery:*` telemetry; fall back to this if `runFiber` interacts badly with
our existing inactivity/eval timeouts wrapping `prompt()`.
