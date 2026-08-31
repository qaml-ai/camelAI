/**
 * CORRECTNESS of the two bounded write paths
 * (BOUNDED-MEMORY-BY-CONSTRUCTION stages 2a and 2b).
 *
 * chat-thread-working-set-invariants.test.ts proves these paths are cheap. This
 * file proves they still do their job — which is the harder half, because both
 * of them exist to keep history: 2a snapshots the rows a compaction is about to
 * delete, and 2b mirrors pi_core into the durable render table. A bounded
 * version that quietly drops rows would pass every budget in the suite.
 *
 * The method is equivalence, not inspection: the same thread is driven through
 * the bounded implementation and through the pre-change one (restored here) and
 * the OBSERVABLE result — the transcript a client pages, the rows in the render
 * table — must match.
 */

import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { UIMessage } from 'ai';

import { createPiSummaryMessage } from '../src/chat-thread/pi-compaction';
import { deriveUiMessagesFromParsedPiCore } from '../../../src/lib/derive-ui-messages-from-pi-core';
import { formatAiChatCreatedAt } from '../../../src/lib/chat-render-history';
import { uiMessageCreatedAtMs } from '../../../src/lib/ui-message-adapter';
import { buildWhaleThreadFixture } from './helpers/whale-thread-fixture';
import { PI_PRESERVE_ARCHIVE_BATCH_MESSAGES } from '../src/chat-thread/render-archive-preserve';

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

/** A small, fully-featured thread: folds, tool answers, steers, one image. */
const seedSmallThread = (instance: any) =>
  buildWhaleThreadFixture(instance, {
    rows: 80,
    totalChars: 240_000,
    images: 1,
    imageChars: 20_000,
    steerEvery: 5,
    legacyEvery: 7,
  });

/** Identity of a durable render row, independent of which thread wrote it. */
function renderTableShape(instance: any): Array<{ id: string; parts: string }> {
  return (
    instance.ctx.storage.sql
      .exec('SELECT id, message FROM cf_ai_chat_agent_messages ORDER BY chronology_key')
      .toArray() as Array<{ id: string; message: string }>
  ).map((row) => {
    const parsed = JSON.parse(row.message) as UIMessage;
    return { id: parsed.id, parts: JSON.stringify(parsed.parts) };
  });
}

/** Walk every settled page and flatten it oldest → newest. */
async function fullTranscript(instance: any): Promise<UIMessage[]> {
  const pages: UIMessage[][] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 100; guard += 1) {
    const page: { messages: UIMessage[]; nextCursor: string | null; hasMore: boolean } =
      await instance.getDerivedUiMessagePage(cursor ? { beforeCursor: cursor } : {});
    pages.push(page.messages);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return pages.reverse().flat();
}

/** The pre-change preserve path, restored verbatim for the control thread. */
async function legacyPreserve(instance: any): Promise<void> {
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
  instance.messages = instance.getRenderHistoryPage().messages;
}

/**
 * Wall clock the synthetic compaction stamps its summary with. Fixed rather than
 * `Date.now()` so the two control threads produce byte-identical ids, but still
 * NEWER than every fixture row — production stamps the compaction time, and the
 * archive seam is placed off the window's oldest pi timestamp, so an
 * artificially old summary would close the archive to everything.
 */
const COMPACTED_AT = 1_800_000_000_000;

/** Compact to `[summary, ...newest keptTailRows]` and rewrite pi_core. */
async function compactPreserving(
  instance: any,
  keptTailRows: number,
): Promise<void> {
  const all = await instance.loadFullPiCoreTranscriptUnbounded({
    imagePolicy: 'reference',
  });
  const compacted = [
    createPiSummaryMessage('everything before this was summarized', COMPACTED_AT),
    ...all.slice(-keptTailRows),
  ];
  await instance.replacePiCoreMessages(compacted, { uiRender: 'preserve' });
  instance.clearPiCoreCompaction();
}

describe('2a — bounded preserve keeps the history it is there to keep', () => {
  it('produces the same visible transcript as the full-materialization path', async () => {
    const bounded = 'bounded-preserve-equivalence-new';
    const control = 'bounded-preserve-equivalence-legacy';
    const keptTailRows = 12;

    const boundedTranscript: UIMessage[] = await runInDurableObject(
      threadStub(bounded),
      async (instance: any) => {
        seedChatContext(instance, bounded);
        seedSmallThread(instance);
        await compactPreserving(instance, keptTailRows);
        return fullTranscript(instance);
      },
    );

    const controlTranscript: UIMessage[] = await runInDurableObject(
      threadStub(control),
      async (instance: any) => {
        seedChatContext(instance, control);
        seedSmallThread(instance);
        instance.materializeSettledRenderArchiveFromPiCore = () =>
          legacyPreserve(instance);
        await compactPreserving(instance, keptTailRows);
        return fullTranscript(instance);
      },
    );

    expect(boundedTranscript.length).toBeGreaterThan(keptTailRows);
    expect(boundedTranscript.map((message) => message.id)).toEqual(
      controlTranscript.map((message) => message.id),
    );
    expect(
      boundedTranscript.map((message) => JSON.stringify(message.parts)),
    ).toEqual(controlTranscript.map((message) => JSON.stringify(message.parts)));
  }, 120_000);

  it('still shows pre-compaction turns that pi_core no longer holds', async () => {
    // The point of the whole path: after the rewrite those rows exist ONLY in
    // the render table, so if the archive snapshot missed them they are gone.
    const thread = 'bounded-preserve-archive-visible';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      const fixture = seedSmallThread(instance);
      const before = await fullTranscript(instance);

      await compactPreserving(instance, 12);

      const remainingRows = instance.ctx.storage.sql
        .exec('SELECT COUNT(*) AS count FROM pi_core_messages')
        .toArray()[0] as { count: number };
      expect(Number(remainingRows.count)).toBeLessThan(fixture.rows / 2);

      const after = await fullTranscript(instance);
      const afterIds = new Set(after.map((message) => message.id));
      // Every turn visible before the compaction is still visible after it.
      const missing = before
        .map((message) => message.id)
        .filter((id) => !afterIds.has(id));
      expect(missing).toEqual([]);
    }, 120_000);
  });
});

describe('2a — a truncated archive refuses to become history loss', () => {
  it('abandons the rewrite rather than delete rows it could not archive', async () => {
    // The ceilings are runtime guards, not licences. When one stops the walk the
    // rows below `lowestRowIdx` have no copy anywhere — the mirror is a lagging,
    // per-call-bounded cursor, not a safety net — so a `DELETE FROM
    // pi_core_messages` here is unrecoverable. The bound the thread actually
    // needs (the pi_core_compaction watermark) is durable either way, which is
    // what makes refusing cheap.
    const thread = 'bounded-preserve-truncated';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      const fixture = seedSmallThread(instance);

      const real = instance.materializeSettledRenderArchiveFromPiCore.bind(instance);
      instance.materializeSettledRenderArchiveFromPiCore = async (options: any) => {
        const result = await real(options);
        return { ...result, truncated: true };
      };

      const all = await instance.loadFullPiCoreTranscriptUnbounded({
        imagePolicy: 'reference',
      });
      const compacted = [
        createPiSummaryMessage('summarized', COMPACTED_AT),
        ...all.slice(-12),
      ];
      const outcome = await instance.replacePiCoreMessages(compacted, {
        uiRender: 'preserve',
      });

      expect(outcome).toEqual({ status: 'skipped_archive_truncated' });
      const rows = instance.ctx.storage.sql
        .exec('SELECT COUNT(*) AS count FROM pi_core_messages')
        .toArray()[0] as { count: number };
      expect(Number(rows.count)).toBe(fixture.rows);
    }, 120_000);
  });

  it('archives an ordinary thread whole, with truncation reported false', async () => {
    // The other half: refusing must be the exception. If the ceilings bound in
    // practice on a normal thread, every compaction would silently stop working.
    const thread = 'bounded-preserve-untruncated';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      seedSmallThread(instance);

      const result = await instance.materializeSettledRenderArchiveFromPiCore({
        keptTailRows: 12,
      });

      expect(result.truncated).toBe(false);
      expect(result.messagesPersisted).toBeGreaterThan(0);
      // Residency, which no storage counter can see. This thread fits in one
      // window, so the interesting assertion — that the peak does not grow with
      // batch count — lives in chat-thread-render-archive-preserve.test.ts; what
      // is pinned here is that the walk reports it at all, over a real DO.
      expect(result.peakRetainedMessages).toBeLessThanOrEqual(
        PI_PRESERVE_ARCHIVE_BATCH_MESSAGES + 2,
      );
    }, 120_000);
  });
});

describe('2b — bounded mirror top-up mirrors everything, one batch at a time', () => {
  it('never ends a range on a tool answer, however long the turn is', async () => {
    // The escape hatch used to break on whatever row the count ran out on. When
    // that was a toolResult the range ended between an assistant and its answer:
    // the next call started with an empty `parsed`, the attach helper found no
    // assistant and returned having mutated nothing, and the row was consumed
    // anyway — that tool output was silently and permanently absent from the
    // durable mirror. A single-stamp turn longer than the extension allowance is
    // exactly the shape that triggers it, and the file exists for whale turns.
    const thread = 'bounded-topup-fold-boundary';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      instance.ensurePiCoreTables();
      instance.ctx.storage.sql.exec('DELETE FROM pi_core_messages');

      const pairs = 20;
      let idx = 0;
      const push = (message: Record<string, unknown>) => {
        instance.ctx.storage.sql.exec(
          'INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)',
          idx,
          JSON.stringify(message),
          1_700_000_000_000 + idx,
        );
        idx += 1;
      };
      push({ role: 'user', content: 'do the whole thing', timestamp: 1 });
      for (let call = 0; call < pairs; call += 1) {
        push({
          role: 'assistant',
          content: [
            { type: 'text', text: `step ${call}` },
            { type: 'toolCall', id: `call-${call}`, name: 'read_file', arguments: {} },
          ],
          responseId: `resp-${call}`,
          timestamp: 2 + call,
          // ONE stamp for the entire turn: every commit folds into one render id.
          uiMetadata: { renderMessageId: 'one-long-turn' },
        });
        push({
          role: 'toolResult',
          toolCallId: `call-${call}`,
          toolName: 'read_file',
          content: [{ type: 'text', text: `answer ${call}` }],
          isError: false,
          timestamp: 2 + call,
        });
      }
      instance.piCoreStore.markPiCoreChanged(idx);

      // Small budgets, same shape as production's larger ones: the hard cap is
      // reached long before the turn ends.
      const parsedAll: any[] = [];
      let fromIdx = 0;
      for (let pass = 0; pass < 200; pass += 1) {
        const range = instance.readParsedPiCoreRowRange({
          fromIdx,
          maxRows: 4,
          maxChars: 1_000_000,
          maxBoundaryExtraRows: 1,
        });
        // Rows re-read after a retreat are re-emitted, so keep the LAST copy of
        // each parsed position rather than concatenating blindly.
        for (let offset = 0; offset < range.parsed.length; offset += 1) {
          parsedAll[range.parsedStartIndex + offset] = range.parsed[offset];
        }
        expect(range.nextIdx).toBeGreaterThan(fromIdx);
        fromIdx = range.nextIdx;
        if (range.reachedEnd) break;
      }

      const flat = JSON.stringify(parsedAll.filter(Boolean));
      for (let call = 0; call < pairs; call += 1) {
        // Every call the walk emitted has its answer with it.
        expect(flat).toContain(`answer ${call}`);
      }
    }, 120_000);
  });


  it('converges on the same render table the single-pass mirror produced', async () => {
    const bounded = 'bounded-topup-equivalence-new';
    const control = 'bounded-topup-equivalence-legacy';

    const boundedRows: Array<{ id: string; parts: string }> = await runInDurableObject(
      threadStub(bounded),
      async (instance: any) => {
        seedChatContext(instance, bounded);
        // Force many small batches so the boundary logic (folds, tool answers)
        // is exercised at every cut rather than being one big pass.
        const realRange = instance.readParsedPiCoreRowRange.bind(instance);
        instance.readParsedPiCoreRowRange = (options: any) =>
          realRange({ ...options, maxRows: 3, maxChars: 1_000 });
        seedSmallThread(instance);

        let passes = 0;
        for (; passes < 200; passes += 1) {
          const cursorBefore = instance.ctx.storage.kv.get(
            'uiMessagesPiCoreRowCursorV1',
          );
          await instance.topUpUiMessagesFromPiCore();
          const cursorAfter = instance.ctx.storage.kv.get(
            'uiMessagesPiCoreRowCursorV1',
          );
          if (cursorAfter === cursorBefore) break;
        }
        // It really did take many resumed passes, not one disguised as many.
        expect(passes).toBeGreaterThan(5);
        return renderTableShape(instance);
      },
    );

    const controlRows: Array<{ id: string; parts: string }> = await runInDurableObject(
      threadStub(control),
      async (instance: any) => {
        seedChatContext(instance, control);
        // The pre-change reader: the whole visible transcript, in one range.
        instance.readParsedPiCoreRowRange = () => ({
          parsed: [] as unknown[],
          parsedStartIndex: 0,
          nextIdx: 0,
          reachedEnd: true,
          rowsRead: 0,
          payloadChars: 0,
        });
        seedSmallThread(instance);
        const parsed = await instance.getPiCoreParsedMessages(control);
        instance.readParsedPiCoreRowRange = ({ fromIdx }: { fromIdx: number }) => ({
          parsed: fromIdx > 0 ? [] : parsed,
          parsedStartIndex: fromIdx > 0 ? parsed.length : 0,
          nextIdx: 10_000,
          reachedEnd: true,
          rowsRead: 0,
          payloadChars: 0,
        });
        await instance.topUpUiMessagesFromPiCore();
        return renderTableShape(instance);
      },
    );

    expect(boundedRows.length).toBeGreaterThan(10);
    expect(boundedRows).toEqual(controlRows);
  }, 120_000);

  it('does not re-convert rows a completed pass already mirrored', async () => {
    const thread = 'bounded-topup-idempotent';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      seedChatContext(instance, thread);
      seedSmallThread(instance);

      for (let pass = 0; pass < 8; pass += 1) {
        await instance.topUpUiMessagesFromPiCore();
      }
      const first = renderTableShape(instance);

      // A settled revision short-circuits; a forced pass walks it all again and
      // must upsert onto the same ids rather than duplicating history.
      await instance.topUpUiMessagesFromPiCore();
      expect(renderTableShape(instance)).toEqual(first);

      instance.ctx.storage.kv.delete('uiMessagesPiCoreRowCursorV1');
      instance.ctx.storage.kv.delete('uiMessagesPiCoreRevisionV1');
      for (let pass = 0; pass < 8; pass += 1) {
        await instance.topUpUiMessagesFromPiCore();
      }
      expect(renderTableShape(instance).map((row) => row.id)).toEqual(
        first.map((row) => row.id),
      );
    });
  }, 120_000);
});
