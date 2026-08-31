/**
 * THE CLASS NET (plans/sse-migration/BOUNDED-MEMORY-BY-CONSTRUCTION.md §2c).
 *
 * Four production OOMs this month shared one shape: a Durable Object surface
 * materialized the WHOLE thread before any bound applied. They were fixed one at
 * a time. This suite exists so the fifth one fails CI instead of prod.
 *
 * How it works, and why it is not a decoration:
 *
 *  1. A REAL Durable Object with a REAL SQLite database holding a whale thread
 *     (~6_400 rows / ~42 MB, no compaction row, stamped folds, tool answers,
 *     steer messages, inline screenshots — see helpers/whale-thread-fixture).
 *  2. Instrumentation installed on `ctx.storage.sql` itself — the storage seam,
 *     not an app-level wrapper — so every read is counted whoever issued it and
 *     whatever helper it went through (see helpers/instrumented-do-storage).
 *  3. Every major DO surface driven against that fixture under a per-surface
 *     budget derived from the SHIPPED bound (see helpers/working-set-budgets).
 *  4. And — the part that makes the other three mean something — the historical
 *     bugs REINTRODUCED at the end of this file and asserted to blow the very
 *     same budgets. A net nobody has thrown a fish at is a decoration.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { UIMessage } from 'ai';

import {
  instrumentDurableObjectStorage,
  type StorageUsage,
} from './helpers/instrumented-do-storage';
import {
  buildWhaleThreadFixture,
  type WhaleFixture,
} from './helpers/whale-thread-fixture';
import {
  budgetViolations,
  WORKING_SET_BUDGETS,
  type WorkingSetBudget,
} from './helpers/working-set-budgets';
import { deriveUiMessagesFromParsedPiCore } from '../../../src/lib/derive-ui-messages-from-pi-core';
import {
  pageDerivedUiMessages,
  formatAiChatCreatedAt,
} from '../../../src/lib/chat-render-history';
import { uiMessageCreatedAtMs } from '../../../src/lib/ui-message-adapter';
import { createSseCaptureConnection } from '../src/chat-thread/sse-connection';
import {
  PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
  PI_SESSION_LOAD_MAX_CHARS,
} from '../src/chat-thread/pi-core-store';

const threadStub = (threadId: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(threadId));
};

const seedChatContext = (instance: any, threadId: string) => {
  instance.chatContext = {
    threadId,
    workspaceId: 'workspace-1',
    orgId: 'org-1',
    userId: 'user-1',
    userName: 'User One',
    userEmail: 'user-1@example.com',
  };
};

/** Assert a surface stayed inside its budget, naming every line it broke. */
function expectWithinBudget(usage: StorageUsage, budget: WorkingSetBudget): void {
  const violations = budgetViolations(usage, budget);
  expect(
    violations,
    `${budget.surface} exceeded its working-set budget.\n` +
      `Why this budget exists: ${budget.why}\n` +
      `Measured: ${JSON.stringify(usage)}`,
  ).toEqual([]);
}

/**
 * The mutation assertion. A reintroduced O(thread) implementation must break the
 * SAME budget object the shipped path is held to — that, and only that, is what
 * proves the net catches the class.
 */
function expectBudgetCaught(
  usage: StorageUsage,
  budget: WorkingSetBudget,
): string[] {
  const violations = budgetViolations(usage, budget);
  expect(
    violations.length,
    `${budget.surface}: the reintroduced unbounded implementation was NOT caught. ` +
      `The budget is too loose or measures the wrong thing. Measured: ${JSON.stringify(usage)}`,
  ).toBeGreaterThan(0);
  return violations;
}

const FAKE_MODEL = {
  id: 'test-model',
  contextWindow: 200_000,
  maxTokens: 8_000,
} as any;

/** A summarizer that never calls a provider. */
const stubCompleteSimple = (async () => ({
  content: [{ type: 'text', text: 'summary of the omitted work' }],
})) as any;

/**
 * The post-turn cut resolves its summarizer through the DO's own
 * `loadPiCompleteSimple` seam. Override that rather than `vi.mock`-ing
 * `@earendil-works/pi-ai/compat`: the mock would be file-scoped and hoisted
 * above every import, and pi-agent-core imports `EventStream`, `streamSimple`
 * and `validateToolArguments` from that module — so a whole-module factory
 * leaves this suite unable to host a real turn at all, and a partial
 * (`importOriginal`) factory cannot even resolve, because the lazy import runs
 * inside a Durable Object and Workers refuses the cross-object I/O.
 */
const stubPostTurnSummarizer = (instance: any): void => {
  instance.loadPiCompleteSimple = async () => stubCompleteSimple;
};

// ---------------------------------------------------------------------------
// Shared read fixture. One DO, seeded once: these surfaces are reads, and
// re-seeding 42 MB per test would spend the run's memory on the fixture rather
// than on what it is measuring.
// ---------------------------------------------------------------------------

const READ_THREAD = 'working-set-whale-reads';
let readFixture: WhaleFixture;

beforeAll(async () => {
  await runInDurableObject(threadStub(READ_THREAD), async (instance: any) => {
    seedChatContext(instance, READ_THREAD);
    readFixture = buildWhaleThreadFixture(instance);
  });
}, 120_000);

async function withReadThread<T>(
  fn: (instance: any, meter: ReturnType<typeof instrumentDurableObjectStorage>) => Promise<T>,
): Promise<T> {
  return runInDurableObject(threadStub(READ_THREAD), async (instance: any) => {
    seedChatContext(instance, READ_THREAD);
    const meter = instrumentDurableObjectStorage(instance);
    return fn(instance, meter);
  });
}

describe('whale fixture', () => {
  it('is actually a whale (or every budget below is meaningless)', () => {
    expect(readFixture.rows).toBeGreaterThanOrEqual(6_000);
    expect(readFixture.totalChars).toBeGreaterThanOrEqual(40_000_000);
    expect(readFixture.images).toBeGreaterThan(0);
  });
});

describe('bounded read surfaces', () => {
  it('connect + first settled page', async () => {
    await withReadThread(async (instance, meter) => {
      const { result, usage } = await meter.measure(() =>
        instance.getDerivedUiMessagePage({}),
      );
      expect((result as any).messages.length).toBeGreaterThan(0);
      expectWithinBudget(usage, WORKING_SET_BUDGETS.connectFirstPage);
      // A page is a suffix of a 42 MB thread: the bound has to be visible as a
      // RATIO, not just as an absolute that a shrinking fixture could satisfy.
      expect(usage.piCoreBytesMaterialized).toBeLessThan(readFixture.totalChars / 8);
    });
  });

  it('older pages, walked back', async () => {
    await withReadThread(async (instance, meter) => {
      let cursor: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const { result, usage } = await meter.measure(() =>
          instance.getDerivedUiMessagePage(cursor ? { beforeCursor: cursor } : {}),
        );
        expectWithinBudget(usage, WORKING_SET_BUDGETS.olderPage);
        cursor = (result as any).nextCursor;
        expect(cursor).toBeTruthy();
      }
    });
  });

  it('turn start (bounded session load)', async () => {
    await withReadThread(async (instance, meter) => {
      const { result, usage } = await meter.measure(() =>
        instance.loadBoundedPiCoreSessionWindow(),
      );
      const window = (result as any).window;
      // The fixture has no compaction row, so this is the Salix shape: the cap,
      // not a watermark, is what bounds it.
      expect(window.capped).toBe(true);
      expect(window.totalChars).toBeGreaterThan(window.loadedChars);
      expectWithinBudget(usage, WORKING_SET_BUDGETS.sessionLoad);
    });
  });

  it('provider request prepare (transformContext)', async () => {
    await withReadThread(async (instance, meter) => {
      const loaded = await instance.loadBoundedPiCoreSessionWindow();
      instance.piMainBaselineIndex = loaded.messages.length;
      instance.piSessionLoadWindow = {
        firstRowIdx: loaded.window.firstRowIdx,
        summaryOffset: loaded.window.summaryOffset,
        capped: loaded.window.capped,
      };
      try {
        const { usage } = await meter.measure(() =>
          instance.transformPiProviderContext(
            loaded.messages,
            FAKE_MODEL,
            'api-key',
            stubCompleteSimple,
          ),
        );
        // The per-request path runs 25+ times in one turn. Any transcript read
        // here is that number multiplied by the whole thread.
        expectWithinBudget(usage, WORKING_SET_BUDGETS.providerPrepare);
      } finally {
        // This surface WORKS: it persisted a real compaction watermark, which
        // is exactly what stage 1c's capped load is supposed to lead to. That
        // also shrinks the visible window for everything after it, so the shared
        // read fixture is put back the way it was found.
        instance.piCoreStore.clearPiCoreCompaction();
        instance.piSessionLoadWindow = null;
        instance.piMainBaselineIndex = 0;
      }
    });
  });
});

describe('bounded render-mirror top-up', () => {
  const MIRROR_THREAD = 'working-set-whale-mirror';

  it('converts one budgeted batch per invocation and resumes at the next', async () => {
    await runInDurableObject(threadStub(MIRROR_THREAD), async (instance: any) => {
      seedChatContext(instance, MIRROR_THREAD);
      const fixture = buildWhaleThreadFixture(instance);
      const meter = instrumentDurableObjectStorage(instance);

      const first = await meter.measure(() => instance.topUpUiMessagesFromPiCore());
      expectWithinBudget(first.usage, WORKING_SET_BUDGETS.mirrorTopUp);
      const cursorAfterFirst = instance.ctx.storage.kv.get(
        'uiMessagesPiCoreRowCursorV1',
      ) as number;
      expect(cursorAfterFirst).toBeGreaterThan(0);
      expect(cursorAfterFirst).toBeLessThan(fixture.rows);

      // Resumable: the pass did not reach the end, so it deliberately left the
      // revision token unwritten and the NEXT call continues rather than
      // short-circuiting on "this revision is already mirrored".
      const second = await meter.measure(() => instance.topUpUiMessagesFromPiCore());
      expectWithinBudget(second.usage, WORKING_SET_BUDGETS.mirrorTopUp);
      const cursorAfterSecond = instance.ctx.storage.kv.get(
        'uiMessagesPiCoreRowCursorV1',
      ) as number;
      expect(cursorAfterSecond).toBeGreaterThan(cursorAfterFirst);
      expect(second.usage.piCoreBytesMaterialized).toBeGreaterThan(0);

      // And it is a MIRROR, not a sampler: the rows it did convert are durable.
      const rows = instance.ctx.storage.sql
        .exec('SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages')
        .toArray()[0] as { count: number };
      expect(Number(rows.count)).toBeGreaterThan(0);
    });
  }, 120_000);
});

describe('bounded compaction preserve path', () => {
  it('keeps peak residency at one batch while archiving the whole prefix', async () => {
    const thread = 'working-set-whale-preserve';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      const fixture = buildWhaleThreadFixture(instance);
      const meter = instrumentDurableObjectStorage(instance);

      const keptTailRows = 40;
      const { usage, result } = await meter.measure(() =>
        instance.materializeSettledRenderArchiveFromPiCore({ keptTailRows }),
      );

      expectWithinBudget(usage, WORKING_SET_BUDGETS.compactionPreserve);
      // "the whole prefix" is in this test's NAME, so assert it. A flat batch
      // ceiling used to stop the walk at ~3,200 render messages — half this
      // fixture — while spending a tenth of the documented char budget, and the
      // budget lines below all pass on a truncated run.
      expect(result.truncated).toBe(false);
      expect(result.lowestRowIdx).toBe(0);
      // Peak JS residency, which the storage counters structurally cannot see:
      // one derived window plus the single-message fold carry, whatever the
      // batch count. Retaining the pass (the shipped bug) measured 3,268 here.
      expect(result.peakRetainedMessages).toBeLessThanOrEqual(64);
      expect(result.messagesPersisted).toBeGreaterThan(
        result.peakRetainedMessages * 10,
      );
      // Cumulative work is legitimately the prefix — those rows are about to be
      // deleted from pi_core and this is their only archive copy. What must not
      // be the prefix is the PEAK, which the budget above pins.
      expect(usage.piCoreBytesMaterialized).toBeGreaterThan(
        fixture.totalChars / 2,
      );
      const archived = instance.ctx.storage.sql
        .exec('SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages')
        .toArray()[0] as { count: number };
      expect(Number(archived.count)).toBeGreaterThan(100);
    });
  }, 300_000);

  it('reads only the rows the post-compaction derive can no longer see', async () => {
    // Scope, the other half of 2a: a compaction that keeps most of the thread
    // must not re-archive the part it keeps. The pre-change path snapshotted the
    // entire visible window every time, whatever the cut was.
    const thread = 'working-set-whale-preserve-scoped';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      const fixture = buildWhaleThreadFixture(instance, {
        rows: 2_000,
        totalChars: 12_000_000,
        images: 2,
      });
      const meter = instrumentDurableObjectStorage(instance);

      const keptTailRows = Math.floor(fixture.rows * 0.75);
      const prefixRows = fixture.rows - keptTailRows;
      const { usage } = await meter.measure(() =>
        instance.materializeSettledRenderArchiveFromPiCore({ keptTailRows }),
      );

      expectWithinBudget(usage, WORKING_SET_BUDGETS.compactionPreserve);
      // Only the prefix (plus the deliberate over-archive margin) may be read.
      expect(usage.piCoreBytesMaterialized).toBeLessThanOrEqual(
        Math.ceil(fixture.prefixChars(prefixRows + 64) * 1.1),
      );
      expect(usage.piCoreBytesMaterialized).toBeLessThan(fixture.totalChars / 2);
    });
  }, 300_000);
});

describe('bounded wake + stream surfaces', () => {
  const STREAM_THREAD = 'working-set-stream';

  const seedRestoredStream = (
    instance: any,
    streamId: string,
    requestId: string,
    bodies: string[],
  ) => {
    instance.ctx.storage.sql.exec(
      'insert into cf_ai_chat_stream_metadata (id, request_id, status, created_at, message_id, is_continuation)' +
        ' values (?, ?, ?, ?, ?, ?)',
      streamId,
      requestId,
      'streaming',
      Date.now(),
      null,
      0,
    );
    bodies.forEach((body, index) => {
      instance.ctx.storage.sql.exec(
        'insert into cf_ai_chat_stream_chunks (id, stream_id, body, chunk_index, created_at) values (?, ?, ?, ?, ?)',
        `chunk-${streamId}-${index}`,
        streamId,
        body,
        index,
        Date.now(),
      );
    });
  };

  it('recovery classification never reads the transcript, and pages the buffer', async () => {
    await runInDurableObject(threadStub(STREAM_THREAD), async (instance: any) => {
      seedChatContext(instance, STREAM_THREAD);
      // A whale thread AND a whale replay buffer: the wake-time classification
      // runs before any app code and must touch neither at full size.
      buildWhaleThreadFixture(instance, { rows: 800, totalChars: 6_000_000, images: 1 });
      const streamId = 'stream-working-set-recovery';
      seedRestoredStream(
        instance,
        streamId,
        'request-working-set-recovery',
        Array.from({ length: 400 }, (_unused, index) =>
          JSON.stringify({
            type: 'text-delta',
            id: 'part-1',
            delta: `${index}`.repeat(500),
          }),
        ),
      );
      const meter = instrumentDurableObjectStorage(instance);

      const { usage } = await meter.measure(() =>
        instance._getPartialStreamText(streamId),
      );

      expectWithinBudget(usage, WORKING_SET_BUDGETS.recoveryClassification);
    });
  }, 120_000);

  it('stream replay pages the buffer instead of materializing it', async () => {
    const thread = 'working-set-stream-replay';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      instance.installBoundedStreamReplay();
      const streamId = instance._startStream('request-working-set-replay');
      for (let index = 0; index < 400; index += 1) {
        await instance._storeStreamChunk(
          streamId,
          JSON.stringify({
            type: 'text-delta',
            id: 'part-1',
            delta: `chunk-${index} ${'y'.repeat(2_000)}`,
          }),
        );
      }
      instance._flushChunkBuffer();
      const meter = instrumentDurableObjectStorage(instance);
      const capture = createSseCaptureConnection({
        id: 'capture-working-set',
        uri: null,
        server: 'thread',
      });

      const { usage } = await meter.measure(() =>
        instance._resumableStream.replayChunks(
          capture.connection,
          'request-working-set-replay',
        ),
      );

      expect(capture.frames.length).toBeGreaterThan(400);
      expectWithinBudget(usage, WORKING_SET_BUDGETS.streamReplay);
    });
  }, 120_000);
});

/**
 * STAGE 2e, measured rather than argued: the surfaces above prove a whale can be
 * SERVED inside a budget. This proves a thread does not become one in the first
 * place — the durable trigger fires from the transcript, so a thread that grows
 * turn after turn keeps re-acquiring a cut and its visible window never reaches
 * the size that forces stage 1c's capped load.
 */
describe('bounded growth (stage 2e)', () => {
  const GROWN_THREAD = 'working-set-2e-grown';
  const GROWN_IMAGE_THREAD = 'working-set-2e-grown-images';
  /** 200k window, 20k reserve => the same 180_000 the per-request path uses. */
  const GROWTH_MODEL = { id: 'test-model', contextWindow: 200_000, maxTokens: 8_000 } as any;
  /** Wide enough that a screenshot thread can never trip the token dimension. */
  const WIDE_MODEL = { id: 'wide-model', contextWindow: 1_000_000, maxTokens: 8_000 } as any;

  /**
   * What `agent_end` hands its listener: the messages THIS run produced, not the
   * conversation behind them. Every round below schedules with one of these and
   * leaves the grown list on `piSession`, because that is the only shape
   * production can produce — a growth test that passes the full list instead
   * would pass against a trigger that measures a single turn.
   */
  const runDelta = (assistant: any) => [
    { role: 'user', content: 'and then?', timestamp: Date.now() },
    assistant,
  ] as any;

  const settledAssistant = () => ({
    role: 'assistant',
    content: [{ type: 'text', text: 'done' }],
    stopReason: 'stop',
    usage: { input: 24_000, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 24_400 },
    timestamp: Date.now(),
  });

  /** Drain the post-turn pass the way `waitUntil` would in production. */
  async function runScheduledPostTurnPass(instance: any, delta: any): Promise<void> {
    const scheduled: Promise<unknown>[] = [];
    Object.defineProperty(instance.ctx, 'waitUntil', {
      value: (promise: Promise<unknown>) => { scheduled.push(promise); },
      configurable: true,
      writable: true,
    });
    try {
      instance.maybeSchedulePiPostTurnCompaction(delta);
      await Promise.all(scheduled);
    } finally {
      delete instance.ctx.waitUntil;
    }
  }

  it('turn start stays in budget for a thread that grew with the durable trigger active', async () => {
    await runInDurableObject(threadStub(GROWN_THREAD), async (instance: any) => {
      seedChatContext(instance, GROWN_THREAD);
      instance.piModelResolver = async () => ({ model: GROWTH_MODEL, apiKey: 'api-key' });
      stubPostTurnSummarizer(instance);

      let written = 0;
      for (let round = 0; round < 5; round += 1) {
        // Each round is a batch of turns landing on the thread: ~4 MB, which on
        // its own is under every cap. Five of them is 20 MB — over the working-set
        // ceiling and heading for the 12 MB load cap — unless something cuts.
        const added = buildWhaleThreadFixture(instance, {
          rows: 400,
          totalChars: 4_000_000,
          images: 0,
          append: round > 0,
          startTimestamp: 1_700_000_000_000 + round * 1_000_000,
        });
        written += added.totalChars;

        const loaded = await instance.loadBoundedPiCoreSessionWindow();
        instance.piSessionLoadWindow = {
          firstRowIdx: loaded.window.firstRowIdx,
          summaryOffset: loaded.window.summaryOffset,
          capped: loaded.window.capped,
        };
        // The turn ends with COMFORTABLE provider usage every single round —
        // which is what the ephemeral per-request compaction guarantees, and
        // what made the usage-gated trigger structurally unreachable.
        const assistant = settledAssistant();
        const settled = [...loaded.messages, assistant];
        instance.piSession = {
          state: { messages: settled, model: GROWTH_MODEL, isStreaming: false },
          waitForIdle: async () => undefined,
        };
        instance.piMainBaselineIndex = settled.length;

        await runScheduledPostTurnPass(instance, runDelta(assistant));
      }

      expect(written).toBeGreaterThan(PI_SESSION_LOAD_MAX_CHARS);

      const meter = instrumentDurableObjectStorage(instance);
      const { result, usage } = await meter.measure(() =>
        instance.loadBoundedPiCoreSessionWindow(),
      );
      const window = (result as any).window;
      // The point: this thread NEVER needed the capped load. 1c is repair for
      // threads that already grew unbounded; 2e is why new ones do not.
      expect(window.capped).toBe(false);
      // In the load cap's OWN units. `totalChars` is stored payload; comparing it
      // against the in-memory byte ceiling would be a unit conflation, and the
      // number that decides whether the next load is capped is this one.
      expect(window.totalChars).toBeLessThan(PI_DURABLE_CUT_MAX_VISIBLE_CHARS);
      expectWithinBudget(usage, WORKING_SET_BUDGETS.sessionLoad);
      // And an order of magnitude under the cap the budget is derived from, not
      // merely inside it.
      expect(usage.piCoreBytesMaterialized).toBeLessThan(PI_SESSION_LOAD_MAX_CHARS / 4);
    });
  }, 300_000);

  /**
   * THE POPULATION TWO DIMENSIONS CANNOT SEE.
   *
   * Images are charged a flat `PI_IMAGE_CONTEXT_TOKENS`, so a screenshot thread
   * is token-cheap; stored inline, its rows are BIGGER than the estimate, so it
   * crosses the 12 MB load cap while the 16 MB working-set ceiling is still
   * comfortably ahead. With only the two estimate dimensions this thread grows
   * to a capped load with no durable cut ever scheduled — and the watermark it
   * eventually acquires there is built on the "earlier messages were NOT loaded"
   * placeholder, i.e. a permanent hole where a real summary belonged.
   */
  it('cuts an image-dominated thread before it can reach the load cap', async () => {
    await runInDurableObject(threadStub(GROWN_IMAGE_THREAD), async (instance: any) => {
      seedChatContext(instance, GROWN_IMAGE_THREAD);
      instance.piModelResolver = async () => ({ model: WIDE_MODEL, apiKey: 'api-key' });
      stubPostTurnSummarizer(instance);

      const reasons: string[] = [];
      const recordEvent = instance.recordChatThreadObservabilityEvent.bind(instance);
      instance.recordChatThreadObservabilityEvent = (name: string, details: any) => {
        if (name === 'pi_post_turn_compaction_transcript') reasons.push(details.status);
        return recordEvent(name, details);
      };

      let written = 0;
      for (let round = 0; round < 5; round += 1) {
        // ~2.5 MB a round, nearly all of it inline base64 under
        // PI_MAX_PERSISTED_IMAGE_DATA_CHARS, so every byte stays in the row.
        const added = buildWhaleThreadFixture(instance, {
          rows: 40,
          totalChars: 2_500_000,
          images: 6,
          imageChars: 400_000,
          append: round > 0,
          startTimestamp: 1_700_000_000_000 + round * 1_000_000,
        });
        written += added.totalChars;

        const loaded = await instance.loadBoundedPiCoreSessionWindow();
        // Never capped, on any round: that is the whole claim.
        expect(loaded.window.capped).toBe(false);
        instance.piSessionLoadWindow = {
          firstRowIdx: loaded.window.firstRowIdx,
          summaryOffset: loaded.window.summaryOffset,
          capped: loaded.window.capped,
        };
        const assistant = settledAssistant();
        const settled = [...loaded.messages, assistant];
        instance.piSession = {
          state: { messages: settled, model: WIDE_MODEL, isStreaming: false },
          waitForIdle: async () => undefined,
        };
        instance.piMainBaselineIndex = settled.length;

        await runScheduledPostTurnPass(instance, runDelta(assistant));
      }

      // The thread wrote well past the durable ceiling, and past the load cap.
      expect(written).toBeGreaterThan(PI_SESSION_LOAD_MAX_CHARS);
      // Neither estimate dimension is what caught it — if either had, this test
      // would be re-proving the case above instead of the one it exists for.
      expect(reasons).toContain('stored_chars');
      expect(reasons).not.toContain('tokens');
      expect(reasons).not.toContain('bytes');

      const window = (await instance.loadBoundedPiCoreSessionWindow()).window;
      expect(window.capped).toBe(false);
      expect(window.totalChars).toBeLessThan(PI_DURABLE_CUT_MAX_VISIBLE_CHARS);
    });
  }, 300_000);
});

// ---------------------------------------------------------------------------
// NET HONESTY: the historical bugs, reintroduced.
//
// Each case below monkeypatches the pre-change implementation back onto a live
// DO and asserts it BREAKS the same budget the shipped path is held to. If any
// of these ever starts passing, the corresponding budget has gone slack and the
// suite above has stopped protecting anything.
//
// Reproduce a single one by hand: comment out the `expectBudgetCaught` line and
// call `expectWithinBudget` instead — the failure message prints the measured
// usage next to the budget it broke.
// ---------------------------------------------------------------------------

describe('net honesty — reintroduced historical bugs must fail these budgets', () => {
  it('BUG 1 (derive-then-paginate): full-thread derive before pagination', async () => {
    await withReadThread(async (instance, meter) => {
      // The pre-change pager, restored at the call site: materialize every
      // pi_core row, derive every UIMessage, then apply the 50-message window.
      instance.getDerivedUiMessagePage = async (options: any = {}) => {
        const parsed = await instance.getPiCoreParsedMessages(
          instance.chatContext?.threadId ?? '',
        );
        const derived = deriveUiMessagesFromParsedPiCore(parsed);
        return pageDerivedUiMessages(derived, {
          beforeCursor: options.beforeCursor ?? null,
          maxMessages: 50,
          maxBytes: 4 * 1024 * 1024,
        });
      };
      try {
        const { usage } = await meter.measure(() =>
          instance.getDerivedUiMessagePage({}),
        );
        const violations = expectBudgetCaught(
          usage,
          WORKING_SET_BUDGETS.connectFirstPage,
        );
        // Specifically: it is caught for reading the THREAD, not for some
        // incidental overshoot.
        expect(violations.join('\n')).toContain('piCoreBytesMaterialized');
        expect(usage.piCoreBytesMaterialized).toBeGreaterThan(
          readFixture.totalChars * 0.9,
        );
      } finally {
        delete instance.getDerivedUiMessagePage;
      }
    });
  }, 300_000);

  it('BUG 2 (full preserve-path materialization): derive everything, persist once', async () => {
    const thread = 'working-set-whale-preserve-legacy';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      const fixture = buildWhaleThreadFixture(instance, {
        rows: 2_000,
        totalChars: 12_000_000,
        images: 2,
      });
      const meter = instrumentDurableObjectStorage(instance);

      // The pre-change body of materializeSettledRenderArchiveFromPiCore.
      const legacyPreserve = async (): Promise<void> => {
        const parsed = await instance.getPiCoreParsedMessages(
          instance.chatContext?.threadId ?? '',
        );
        const derived = deriveUiMessagesFromParsedPiCore(parsed);
        if (derived.length === 0) return;
        await instance.persistMessages(derived);
        for (const message of derived as UIMessage[]) {
          const createdAtMs = uiMessageCreatedAtMs(message);
          if (createdAtMs === undefined) continue;
          instance._setRenderHistoryChronology(
            message.id,
            formatAiChatCreatedAt(createdAtMs),
          );
        }
      };

      const { usage } = await meter.measure(legacyPreserve);
      const violations = expectBudgetCaught(
        usage,
        WORKING_SET_BUDGETS.compactionPreserve,
      );
      // The peak is what gives it away: everything was resident before the one
      // persist call, so nothing was read "between render writes" in batches.
      expect(violations.join('\n')).toContain('maxBytesBetweenRenderWrites');
      expect(usage.maxBytesBetweenRenderWrites).toBeGreaterThan(
        fixture.totalChars * 0.9,
      );
    });
  }, 300_000);

  it('BUG 3 (unbounded session load): the whole visible window at turn start', async () => {
    await withReadThread(async (instance, meter) => {
      const { usage } = await meter.measure(() =>
        // Exactly what createPiSession called before stage 1c.
        instance.loadFullPiCoreTranscriptUnbounded({ imagePolicy: 'reference' }),
      );
      const violations = expectBudgetCaught(
        usage,
        WORKING_SET_BUDGETS.sessionLoad,
      );
      expect(violations.join('\n')).toContain('piCoreBytesMaterialized');
      expect(usage.piCoreBytesMaterialized).toBeGreaterThan(
        readFixture.totalChars * 0.9,
      );
    });
  }, 300_000);

  it('BUG 4 (unbounded mirror top-up): full parsed transcript per invocation', async () => {
    await withReadThread(async (instance, meter) => {
      const { usage } = await meter.measure(() =>
        // Exactly what topUpUiMessagesFromPiCore read before stage 2b, on every
        // call, to convert the handful of rows past its high-water mark.
        instance.getPiCoreParsedMessages(instance.chatContext?.threadId ?? ''),
      );
      const violations = expectBudgetCaught(
        usage,
        WORKING_SET_BUDGETS.mirrorTopUp,
      );
      expect(violations.join('\n')).toContain('piCoreBytesMaterialized');
    });
  }, 300_000);
});
