import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { UIMessage } from 'ai';
import { ChatThreadDO } from '../src/chat-thread-do';
import {
  formatAiChatCreatedAt,
  pageDerivedUiMessages,
  prependOlderRenderMessages,
  RENDER_FOLD_PARTIAL_METADATA_KEY,
  type ChatRenderHistoryPage,
} from '../../../src/lib/chat-render-history';
import {
  deriveUiMessagesFromParsedPiCore,
  overlayLiveUiMessages,
} from '../../../src/lib/derive-ui-messages-from-pi-core';
import {
  PI_DERIVE_BOUNDARY_LOOKAHEAD_ROWS,
  PI_DERIVE_EMPTY_SCAN_MAX_ROWS,
  PI_DERIVE_MAX_WINDOW_BYTE_FACTOR,
} from '../src/chat-thread/derived-render-page';
import { uiMessageCreatedAtMs } from '../../../src/lib/ui-message-adapter';

// Storage-boundary derive pagination (plans/sse-migration/DERIVE-PAGINATION-FIX.md).
//
// The GOLDEN test in this file is the contract: `legacyDerivedWalk` is the
// pre-change algorithm — materialize every pi_core row, derive every UIMessage,
// walk the whole ai-chat archive table, overlay the resident window, then page the
// resulting array — composed from the same pure helpers the shipped path still
// uses. A walk of the new pager must yield the SAME transcript, message for
// message, byte for byte. Cursors are opaque and now live in pi_core row space
// rather than settled-array index space, so the walks are compared by the
// transcript they reconstruct (and, for pi-only threads, page by page).

type AnyRecord = Record<string, unknown>;

async function newChatThreadStub(threadId: string) {
  const id = (env as any).CHAT_THREAD.idFromName(threadId);
  return (env as any).CHAT_THREAD.get(id);
}

function seedPiCoreRow(instance: any, idx: number, message: AnyRecord): void {
  instance.ctx.storage.sql.exec(
    'INSERT INTO pi_core_messages (idx, payload, created_at) VALUES (?, ?, ?)',
    idx,
    JSON.stringify(message),
    typeof message.timestamp === 'number' ? message.timestamp : Date.now(),
  );
  const revision = instance['piCoreStore'].getPiCoreRevision();
  instance['piCoreStore'].markPiCoreChanged(revision.count + 1);
}

// --- the pre-change pager, kept here as the golden reference -----------------

function dedupeKey(message: UIMessage): string {
  const createdAt = uiMessageCreatedAtMs(message);
  if (createdAt !== undefined) return `${message.role}:${createdAt}`;
  return `${message.role}:${message.id}`;
}

function legacyArchive(instance: any, derived: UIMessage[]): UIMessage[] {
  if (derived.length === 0) return [];
  const derivedIds = new Set(derived.map((message) => message.id));
  const derivedKeys = new Set(derived.map(dedupeKey));
  const firstDerivedAt = uiMessageCreatedAtMs(derived[0]) ?? 0;
  const archived: UIMessage[] = [];
  const seenIds = new Set<string>();
  const seenCursors = new Set<string>();
  let beforeCursor: string | null = null;
  for (;;) {
    const page: ChatRenderHistoryPage = instance.getRenderHistoryPage(
      beforeCursor ? { beforeCursor } : {},
    );
    for (const message of page.messages) {
      if (!message?.id || derivedIds.has(message.id) || seenIds.has(message.id)) {
        continue;
      }
      const createdAt = uiMessageCreatedAtMs(message);
      if (createdAt === undefined) continue;
      if (derivedKeys.has(dedupeKey(message))) continue;
      if (createdAt >= firstDerivedAt) continue;
      seenIds.add(message.id);
      archived.push(message);
    }
    if (!page.hasMore || !page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) break;
    seenCursors.add(page.nextCursor);
    beforeCursor = page.nextCursor;
  }
  archived.sort(
    (left, right) =>
      (uiMessageCreatedAtMs(left) ?? 0) - (uiMessageCreatedAtMs(right) ?? 0),
  );
  return archived;
}

async function legacyDerivedWalk(
  instance: any,
  limits: { maxMessages: number; maxBytes: number },
): Promise<ChatRenderHistoryPage[]> {
  const parsed = await instance.getPiCoreParsedMessages(
    instance.chatContext?.threadId ?? '',
  );
  const derived = deriveUiMessagesFromParsedPiCore(parsed);
  const pages: ChatRenderHistoryPage[] = [];
  if (derived.length === 0) {
    let cursor: string | null = null;
    for (let guard = 0; guard < 200; guard += 1) {
      const page: ChatRenderHistoryPage = instance.getRenderHistoryPage({
        ...(cursor ? { beforeCursor: cursor } : {}),
        ...limits,
      });
      pages.push(page);
      if (!page.hasMore || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return pages;
  }
  const archived = legacyArchive(instance, derived);
  const settled = archived.length === 0 ? derived : [...archived, ...derived];
  const activeTurnId =
    instance.activePiStreamTurnId ?? instance.readPiActiveTurn()?.turnId ?? null;
  const overlaid = overlayLiveUiMessages(settled, instance.messages, {
    activeTurnId,
  });
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = pageDerivedUiMessages(overlaid, {
      beforeCursor: cursor,
      ...limits,
    });
    pages.push(page);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return pages;
}

async function derivedWalk(
  instance: any,
  limits: { maxMessages: number; maxBytes: number },
): Promise<ChatRenderHistoryPage[]> {
  const pages: ChatRenderHistoryPage[] = [];
  let cursor: string | null = null;
  for (let guard = 0; guard < 200; guard += 1) {
    const page: ChatRenderHistoryPage = await instance.getDerivedUiMessagePage({
      ...(cursor ? { beforeCursor: cursor } : {}),
      ...limits,
    });
    pages.push(page);
    if (!page.hasMore || !page.nextCursor) break;
    cursor = page.nextCursor;
  }
  return pages;
}

/** Newest-page-first walk flattened into one oldest→newest transcript. */
function transcript(pages: ChatRenderHistoryPage[]): UIMessage[] {
  return pages
    .slice()
    .reverse()
    .flatMap((page) => page.messages);
}

function ids(messages: UIMessage[]): string[] {
  return messages.map((message) => message.id);
}

// --- synthetic thread shapes -------------------------------------------------

interface SeedOptions {
  turns: number;
  /** Stamp rows with uiMetadata.renderMessageId (modern) or not (legacy). */
  stamped?: boolean;
  /** Fold two assistant commits per turn with a steer user row between them. */
  steerEvery?: number;
  /** Emit a tool call + toolResult row inside each turn. */
  tools?: boolean;
  startTimestamp?: number;
}

function seedSyntheticThread(instance: any, options: SeedOptions): number {
  const stamped = options.stamped !== false;
  const startTimestamp = options.startTimestamp ?? 100_000;
  let idx = 0;
  let timestamp = startTimestamp;
  const push = (message: AnyRecord) => {
    seedPiCoreRow(instance, idx, message);
    idx += 1;
  };
  for (let turn = 0; turn < options.turns; turn += 1) {
    const turnId = `turn-${turn}`;
    timestamp += 10;
    push({
      role: 'user',
      content: `question ${turn}`,
      timestamp,
      ...(stamped ? { uiMetadata: { renderMessageId: `client-user-${turn}` } } : {}),
    });
    timestamp += 10;
    push({
      role: 'assistant',
      content: options.tools
        ? [
            { type: 'text', text: `working on ${turn}` },
            {
              type: 'toolCall',
              id: `call-${turn}`,
              name: 'read_file',
              arguments: { path: `f${turn}.txt` },
            },
          ]
        : [{ type: 'text', text: `answer ${turn} part 1` }],
      timestamp,
      responseId: `resp-${turn}-a`,
      ...(stamped ? { uiMetadata: { renderMessageId: turnId } } : {}),
    });
    if (options.tools) {
      timestamp += 10;
      push({
        role: 'toolResult',
        toolCallId: `call-${turn}`,
        toolName: 'read_file',
        content: [{ type: 'text', text: `contents of f${turn}.txt` }],
        timestamp,
      });
    }
    if (options.steerEvery && turn % options.steerEvery === 0) {
      timestamp += 10;
      push({
        role: 'user',
        content: `steer ${turn}`,
        timestamp,
        sentDuringStreaming: true,
        ...(stamped
          ? { uiMetadata: { renderMessageId: `client-steer-${turn}` } }
          : {}),
      });
    }
    timestamp += 10;
    push({
      role: 'assistant',
      content: [{ type: 'text', text: `answer ${turn} part 2` }],
      timestamp,
      responseId: `resp-${turn}-b`,
      ...(stamped ? { uiMetadata: { renderMessageId: turnId } } : {}),
    });
  }
  return idx;
}

describe('storage-boundary derive pagination — golden equivalence', () => {
  it('walks a stamped, folded, tool-carrying thread exactly like the full-thread pager', async () => {
    const stub = await newChatThreadStub('derive-page-golden-modern');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-golden-modern' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, {
        turns: 12,
        stamped: true,
        steerEvery: 4,
        tools: true,
      });
      const limits = { maxMessages: 7, maxBytes: 4 * 1024 * 1024 };

      const legacy = await legacyDerivedWalk(instance, limits);
      const next = await derivedWalk(instance, limits);

      expect(next.length).toBeGreaterThan(2);
      expect(transcript(next)).toEqual(transcript(legacy));
      // Page SPLITS may shift by the one message a fold's atomicity requires:
      // this thread steers, so a boundary between a turn and the steer bubble
      // sitting inside its row span pulls the turn into the same page (see
      // extendPageToFoldBoundary). Nothing is duplicated or dropped, and the
      // overshoot is bounded.
      const pageIds = next.map((page) => ids(page.messages));
      expect(new Set(pageIds.flat()).size).toBe(pageIds.flat().length);
      for (const page of pageIds) {
        expect(page.length).toBeGreaterThanOrEqual(1);
        expect(page.length).toBeLessThanOrEqual(limits.maxMessages + 2);
      }
      expect(next.length).toBeLessThanOrEqual(legacy.length + 1);
      expect(next.at(-1)?.hasMore).toBe(false);
    });
  });

  it('matches the full-thread pager page for page when no fold is interposed', async () => {
    const stub = await newChatThreadStub('derive-page-golden-contiguous');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-golden-contiguous' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, { turns: 11, stamped: true, tools: true });
      const limits = { maxMessages: 6, maxBytes: 4 * 1024 * 1024 };

      const legacy = await legacyDerivedWalk(instance, limits);
      const next = await derivedWalk(instance, limits);

      expect(transcript(next)).toEqual(transcript(legacy));
      expect(next.map((page) => ids(page.messages))).toEqual(
        legacy.map((page) => ids(page.messages)),
      );
      expect(next.map((page) => page.hasMore)).toEqual(
        legacy.map((page) => page.hasMore),
      );
    });
  });

  it('walks a legacy unstamped thread exactly like the full-thread pager', async () => {
    const stub = await newChatThreadStub('derive-page-golden-legacy');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-golden-legacy' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, { turns: 9, stamped: false, tools: true });
      const limits = { maxMessages: 5, maxBytes: 4 * 1024 * 1024 };

      const legacy = await legacyDerivedWalk(instance, limits);
      const next = await derivedWalk(instance, limits);

      expect(transcript(next)).toEqual(transcript(legacy));
      expect(next.map((page) => ids(page.messages))).toEqual(
        legacy.map((page) => ids(page.messages)),
      );
      // Position-derived legacy ids survive windowing (same-content-same-id).
      expect(ids(transcript(next)).some((id) => id.startsWith('pi_user_'))).toBe(
        true,
      );
    });
  });

  it('matches the full-thread pager with a live resident overlay and an open turn', async () => {
    const stub = await newChatThreadStub('derive-page-golden-overlay');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-golden-overlay' };
      instance.ensurePiCoreTables();
      const rows = seedSyntheticThread(instance, {
        turns: 8,
        stamped: true,
        tools: false,
      });
      // The live stream persisted the newest turn's row plus a just-sent user
      // skeleton that has no pi_core row yet.
      await instance.persistMessages([
        {
          id: 'turn-7',
          role: 'assistant',
          parts: [{ type: 'text', text: 'live streamed answer', state: 'done' }],
          metadata: { pi: { forkEntryId: 'resp-7-b', createdAtMs: 100_400 } },
        },
        {
          id: 'client-user-live',
          role: 'user',
          parts: [{ type: 'text', text: 'newest question', state: 'done' }],
          metadata: { piCoreMessageKey: '900000' },
        },
      ]);
      instance.ctx.storage.kv.put('piActiveTurn', {
        turnId: 'turn-7',
        openedAt: Date.now(),
      });
      const limits = { maxMessages: 6, maxBytes: 4 * 1024 * 1024 };

      const legacy = await legacyDerivedWalk(instance, limits);
      const next = await derivedWalk(instance, limits);

      expect(rows).toBeGreaterThan(0);
      expect(transcript(next)).toEqual(transcript(legacy));
      // The live row wins for the open turn, and the skeleton lands last.
      const flat = transcript(next);
      expect(ids(flat).at(-1)).toBe('client-user-live');
      expect(
        (flat.find((message) => message.id === 'turn-7')?.parts[0] as AnyRecord)
          .text,
      ).toBe('live streamed answer');
      instance.ctx.storage.kv.delete('piActiveTurn');
    });
  });

  it('matches the full-thread pager across a compaction archive seam', async () => {
    const stub = await newChatThreadStub('derive-page-golden-archive');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-golden-archive' };
      instance.ensurePiCoreTables();
      // Pre-compaction rows kept visible in the ai-chat table (uiRender:
      // "preserve" materializes them with pi chronology).
      const archiveMessages: AnyRecord[] = [];
      for (let index = 0; index < 9; index += 1) {
        archiveMessages.push({
          id: `archive-${index}`,
          role: index % 2 === 0 ? 'user' : 'assistant',
          parts: [{ type: 'text', text: `archived ${index}`, state: 'done' }],
          metadata: { pi: { createdAtMs: 1_000 + index * 10 } },
        });
      }
      await instance.persistMessages(archiveMessages);
      for (const message of archiveMessages) {
        instance._setRenderHistoryChronology(
          message.id,
          formatAiChatCreatedAt(
            ((message.metadata as AnyRecord).pi as AnyRecord).createdAtMs as number,
          ),
        );
      }
      instance.reloadAiChatMessagesOrdered();
      // The post-compaction pi_core tail: a summary row plus kept turns.
      seedSyntheticThread(instance, {
        turns: 6,
        stamped: true,
        tools: false,
        startTimestamp: 50_000,
      });
      const limits = { maxMessages: 5, maxBytes: 4 * 1024 * 1024 };

      const legacy = await legacyDerivedWalk(instance, limits);
      const next = await derivedWalk(instance, limits);

      // Same transcript, archive included; page splits differ at the seam by
      // design (the archive is paged lazily instead of prepended).
      expect(ids(transcript(next))).toEqual(ids(transcript(legacy)));
      expect(transcript(next)).toEqual(transcript(legacy));
      expect(ids(transcript(next)).slice(0, 3)).toEqual([
        'archive-0',
        'archive-1',
        'archive-2',
      ]);
    });
  });
});

describe('storage-boundary derive pagination — turn integrity', () => {
  it('never splits a folded turn and keeps ids unique across pages', async () => {
    const stub = await newChatThreadStub('derive-page-turn-integrity');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-turn-integrity' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, {
        turns: 10,
        stamped: true,
        steerEvery: 1,
        tools: true,
      });

      // Page size 1 forces a boundary between EVERY pair of messages.
      const pages = await derivedWalk(instance, {
        maxMessages: 1,
        maxBytes: 4 * 1024 * 1024,
      });
      const flat = transcript(pages);
      expect(new Set(ids(flat)).size).toBe(flat.length);

      // Each turn appears exactly once, carrying both commits, its steer marker
      // and its tool answer — i.e. no page cut the fold.
      for (let turn = 0; turn < 10; turn += 1) {
        const folded = flat.filter((message) => message.id === `turn-${turn}`);
        expect(folded).toHaveLength(1);
        const parts = folded[0].parts as AnyRecord[];
        const texts = parts
          .filter((part) => part.type === 'text')
          .map((part) => part.text);
        expect(texts).toContain(`working on ${turn}`);
        expect(texts).toContain(`answer ${turn} part 2`);
        expect(
          parts.some((part) => String(part.type).includes('pi-steer-marker')),
        ).toBe(true);
        expect(
          parts.some(
            (part) =>
              String(part.type).startsWith('tool-') &&
              part.toolCallId === `call-${turn}`,
          ),
        ).toBe(true);
      }
    });
  });
});

describe('storage-boundary derive pagination — allocation bounds', () => {
  const WHALE_TURNS = 120;

  async function seedWhale(instance: any, threadId: string): Promise<void> {
    instance.chatContext = { threadId };
    instance.ensurePiCoreTables();
    // ~4KB of tool output per turn: 480 rows, several megabytes of transcript.
    const filler = 'x'.repeat(4_000);
    let idx = 0;
    let timestamp = 1_000_000;
    const push = (message: AnyRecord) => {
      seedPiCoreRow(instance, idx, message);
      idx += 1;
    };
    for (let turn = 0; turn < WHALE_TURNS; turn += 1) {
      timestamp += 10;
      push({
        role: 'user',
        content: `question ${turn}`,
        timestamp,
        uiMetadata: { renderMessageId: `client-user-${turn}` },
      });
      timestamp += 10;
      push({
        role: 'assistant',
        content: [
          { type: 'text', text: `thinking about ${turn}` },
          {
            type: 'toolCall',
            id: `call-${turn}`,
            name: 'read_file',
            arguments: { path: `f${turn}.txt` },
          },
        ],
        timestamp,
        responseId: `resp-${turn}-a`,
        uiMetadata: { renderMessageId: `turn-${turn}` },
      });
      timestamp += 10;
      push({
        role: 'toolResult',
        toolCallId: `call-${turn}`,
        toolName: 'read_file',
        content: [{ type: 'text', text: filler }],
        timestamp,
      });
      timestamp += 10;
      push({
        role: 'assistant',
        content: [{ type: 'text', text: `answer ${turn}` }],
        timestamp,
        responseId: `resp-${turn}-b`,
        uiMetadata: { renderMessageId: `turn-${turn}` },
      });
    }
  }

  it('derives the first page from a whale thread without reading the whole transcript', async () => {
    const stub = await newChatThreadStub('derive-page-whale-first');
    await runInDurableObject(stub, async (instance: any) => {
      await seedWhale(instance, 'derive-page-whale-first');
      const totalRows = instance.ctx.storage.sql
        .exec<{ count: number }>('SELECT COUNT(*) AS count FROM pi_core_messages')
        .one().count;
      expect(totalRows).toBe(WHALE_TURNS * 4);

      const archiveSpy = vi.spyOn(instance, 'getRenderHistoryPage');
      const page = await instance.getUiMessagePage();
      const stats = instance['lastDerivedRenderPageStats'];

      expect(page.messages).toHaveLength(50);
      expect(page.hasMore).toBe(true);
      // The allocation proxy: rows materialized must scale with the PAGE, not the
      // thread (50 messages ≈ 25 turns ≈ 100 rows, plus lookahead/boundary rows).
      expect(stats.rowsRead).toBeLessThan(160);
      expect(stats.rowsRead).toBeLessThan(totalRows / 2);
      expect(stats.boundaryUnresolved).toBe(false);
      expect(stats.droppedToolResults).toBe(0);
      // The archive is not consulted while the derived tail still has rows.
      expect(archiveSpy).not.toHaveBeenCalled();
      archiveSpy.mockRestore();
    });
  });

  it('keeps the onConnect reconcile page bounded on a whale thread', async () => {
    const stub = await newChatThreadStub('derive-page-whale-connect');
    await runInDurableObject(stub, async (instance: any) => {
      await seedWhale(instance, 'derive-page-whale-connect');
      const frames: AnyRecord[] = [];
      const connection = {
        id: 'c1',
        send: (raw: string) => frames.push(JSON.parse(raw) as AnyRecord),
      } as any;

      await instance.sendRenderHistoryToConnection(connection);
      const stats = instance['lastDerivedRenderPageStats'];

      expect(frames).toHaveLength(1);
      expect((frames[0].messages as UIMessage[]).length).toBe(50);
      expect(stats.rowsRead).toBeLessThan(160);
    });
  });

  it('walks older whale pages with bounded reads and no duplicate messages', async () => {
    const stub = await newChatThreadStub('derive-page-whale-older');
    await runInDurableObject(stub, async (instance: any) => {
      await seedWhale(instance, 'derive-page-whale-older');

      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      for (;;) {
        const page: ChatRenderHistoryPage = cursor
          ? await instance.getOlderUiMessages(cursor)
          : await instance.getUiMessagePage();
        pages += 1;
        seen.unshift(...ids(page.messages));
        const stats = instance['lastDerivedRenderPageStats'];
        if (stats) expect(stats.rowsRead).toBeLessThan(200);
        if (!page.hasMore || !page.nextCursor) break;
        cursor = page.nextCursor;
        expect(pages).toBeLessThan(20);
      }

      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).toHaveLength(WHALE_TURNS * 2);
      expect(seen[0]).toBe('client-user-0');
      expect(seen.at(-1)).toBe(`turn-${WHALE_TURNS - 1}`);
    });
  });
});

describe('storage-boundary derive pagination — byte bounds and fallbacks', () => {
  it('serves a mega-row turn without materializing the rest of the thread', async () => {
    const stub = await newChatThreadStub('derive-page-mega-row');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-mega-row' };
      instance.ensurePiCoreTables();
      const rows = seedSyntheticThread(instance, {
        turns: 40,
        stamped: true,
        tools: false,
        startTimestamp: 10_000,
      });
      // The newest turns carry ~1.4MB tool results each (just under
      // PI_SQLITE_STORAGE_SOFT_LIMIT_CHARS, i.e. the largest row production can
      // actually hold), so the page's byte ceiling — not its message count — is
      // what closes the window.
      seedPiCoreRow(instance, rows, {
        role: 'user',
        content: 'huge question',
        timestamp: 900_000,
        uiMetadata: { renderMessageId: 'client-user-huge' },
      });
      seedPiCoreRow(instance, rows + 1, {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-huge',
            name: 'read_file',
            arguments: {},
          },
        ],
        timestamp: 900_010,
        responseId: 'resp-huge',
        uiMetadata: { renderMessageId: 'turn-huge' },
      });
      seedPiCoreRow(instance, rows + 2, {
        role: 'toolResult',
        toolCallId: 'call-huge',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'y'.repeat(1_400_000) }],
        timestamp: 900_020,
      });
      seedPiCoreRow(instance, rows + 3, {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'call-huge-2',
            name: 'read_file',
            arguments: {},
          },
        ],
        timestamp: 900_030,
        responseId: 'resp-huge-2',
        uiMetadata: { renderMessageId: 'turn-huge' },
      });
      seedPiCoreRow(instance, rows + 4, {
        role: 'toolResult',
        toolCallId: 'call-huge-2',
        toolName: 'read_file',
        content: [{ type: 'text', text: 'z'.repeat(1_400_000) }],
        timestamp: 900_040,
      });
      seedPiCoreRow(instance, rows + 5, {
        role: 'assistant',
        content: [{ type: 'text', text: 'huge answer' }],
        timestamp: 900_050,
        responseId: 'resp-huge-3',
        uiMetadata: { renderMessageId: 'turn-huge' },
      });

      const limits = { maxMessages: 50, maxBytes: 2 * 1024 * 1024 };
      const first = await instance.getDerivedUiMessagePage(limits);
      const stats = instance['lastDerivedRenderPageStats'];
      // One oversized turn is served alone rather than as an empty page, and the
      // walk stops there instead of reading the rest of the thread.
      expect(ids(first.messages)).toEqual(['turn-huge']);
      expect(first.hasMore).toBe(true);
      expect(stats.rowsRead).toBeLessThan(20);
      expect(stats.payloadChars).toBeLessThan(4 * 1024 * 1024);
      expect(stats.droppedToolResults).toBe(0);

      const older = await instance.getDerivedUiMessagePage({
        beforeCursor: first.nextCursor,
        ...limits,
      });
      const overlap = ids(older.messages).filter((id) =>
        ids(first.messages).includes(id),
      );
      expect(overlap).toEqual([]);
      expect(ids(older.messages).at(-1)).toBe('client-user-huge');
      expect(rows).toBeGreaterThan(0);
    });
  });

  it('refuses to read an unbounded fold: a giant turn closes the window and says so', async () => {
    const stub = await newChatThreadStub('derive-page-giant-fold');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-giant-fold' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, { turns: 3, stamped: true, startTimestamp: 1_000 });
      // ONE turn committing 10 rows of ~600KB under a single renderMessageId —
      // the shape (a long tool-heavy turn) that would otherwise make "close the
      // fold" read the whole thing into a 128MB isolate.
      let idx = instance.ctx.storage.sql
        .exec<{ next: number }>(
          'SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM pi_core_messages',
        )
        .one().next;
      for (let commit = 0; commit < 10; commit += 1) {
        seedPiCoreRow(instance, idx, {
          role: 'assistant',
          content: [{ type: 'text', text: `${commit}:${'q'.repeat(600_000)}` }],
          timestamp: 500_000 + commit,
          responseId: `resp-giant-${commit}`,
          uiMetadata: { renderMessageId: 'turn-giant' },
        });
        idx += 1;
      }

      const limits = { maxMessages: 50, maxBytes: 1024 * 1024 };
      const page = await instance.getDerivedUiMessagePage(limits);
      const stats = instance['lastDerivedRenderPageStats'];

      expect(ids(page.messages)).toEqual(['turn-giant']);
      // Bounded: at most the window ceiling (2x the page budget) plus one row.
      expect(stats.payloadChars).toBeLessThan(3 * 1024 * 1024);
      expect(stats.rowsRead).toBeLessThan(10);
      // And the truncation is reported rather than pretended away.
      expect(stats.boundaryUnresolved).toBe(true);
      expect(page.hasMore).toBe(true);

      // The walk still terminates and still reaches the thread's start.
      const walk = await derivedWalk(instance, limits);
      expect(walk.length).toBeLessThan(20);
      expect(ids(transcript(walk))[0]).toBe('client-user-0');
    });
  });

  it('ends the walk instead of re-serving the newest rows for a stale older cursor', async () => {
    const stub = await newChatThreadStub('derive-page-stale-cursor');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-stale-cursor' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, { turns: 4, stamped: true });
      const newest = await instance.getUiMessagePage();
      expect(newest.hasMore).toBe(false);

      // A cursor a client held across a compaction that renumbered pi_core: the
      // rows it names are gone. It must not come back as the newest page.
      const stale = await instance.getOlderUiMessages('dp:p:0');
      expect(stale.messages).toEqual([]);
      expect(stale.hasMore).toBe(false);
      expect(stale.nextCursor).toBeNull();
    });
  });

  it('falls back to the render table when no pi_core row derives anything', async () => {
    const stub = await newChatThreadStub('derive-page-hidden-rows');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-hidden-rows' };
      instance.ensurePiCoreTables();
      for (let index = 0; index < 4; index += 1) {
        seedPiCoreRow(instance, index, {
          role: 'user',
          visibility: 'hidden',
          content: `internal ${index}`,
          timestamp: 1_000 + index,
        });
      }
      await instance.persistMessages([
        {
          id: 'render-only',
          role: 'assistant',
          parts: [{ type: 'text', text: 'from the table', state: 'done' }],
        },
      ]);

      const page = await instance.getUiMessagePage();
      expect(ids(page.messages)).toEqual(['render-only']);
      expect(page.hasMore).toBe(false);
    });
  });
});

describe('storage-boundary derive pagination — cache and cursors', () => {
  it('caches windows per revision, drops oversized ones, and re-derives after a bump', async () => {
    const stub = await newChatThreadStub('derive-page-cache');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-cache' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, { turns: 4, stamped: true });

      await instance.getUiMessagePage();
      const cached = instance['derivedRenderWindowCache'];
      expect(cached).not.toBeNull();
      expect(cached.entries.size).toBe(1);
      // The cache holds a WINDOW, never a full settled array.
      expect(cached.entries.get('newest').messages.length).toBeLessThanOrEqual(50);

      const rowReads = vi.spyOn(
        instance['piCoreStore'],
        'loadPiCoreRenderMessageAt',
      );
      const first = await instance.getUiMessagePage();
      expect(rowReads).not.toHaveBeenCalled();
      expect(ids(first.messages)).toContain('turn-3');
      rowReads.mockRestore();

      seedPiCoreRow(instance, 100, {
        role: 'user',
        content: 'brand new question',
        timestamp: 900_000,
        uiMetadata: { renderMessageId: 'client-user-new' },
      });
      const second = await instance.getUiMessagePage();
      expect(ids(second.messages)).toContain('client-user-new');
      expect(instance['lastDerivedRenderPageStats'].rowsRead).toBeGreaterThan(0);
    });
  });

  it('serves the newest page for a legacy `d:` cursor instead of failing the scroll', async () => {
    const stub = await newChatThreadStub('derive-page-legacy-cursor');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-legacy-cursor' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, { turns: 5, stamped: true });

      const page = await instance.getOlderUiMessages('d:3');
      expect(page.messages.length).toBeGreaterThan(0);
      expect(ids(page.messages).at(-1)).toBe('turn-4');
      // And the cursor it hands back is in the new space, so the next click works.
      expect(page.nextCursor === null || page.nextCursor.startsWith('dp:')).toBe(
        true,
      );
    });
  });

  it('still serves the ai-chat render table natively when nothing derives', async () => {
    const stub = await newChatThreadStub('derive-page-live-only');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-live-only' };
      const messages = Array.from({ length: 12 }, (_, index) => ({
        id: `live-${String(index).padStart(2, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `live ${index}`, state: 'done' }],
      }));
      await instance.persistMessages(messages);

      const first = await instance.getDerivedUiMessagePage({
        maxMessages: 5,
        maxBytes: 4 * 1024 * 1024,
      });
      expect(ids(first.messages)).toEqual([
        'live-07',
        'live-08',
        'live-09',
        'live-10',
        'live-11',
      ]);
      expect(first.hasMore).toBe(true);
      const older = await instance.getDerivedUiMessagePage({
        beforeCursor: first.nextCursor,
        maxMessages: 5,
        maxBytes: 4 * 1024 * 1024,
      });
      // ai-chat's own chronology cursor overlaps its boundary row by one; that
      // passthrough behaviour is unchanged (the client prepends by id).
      expect(ids(older.messages)).toEqual([
        'live-03',
        'live-04',
        'live-05',
        'live-06',
        'live-07',
      ]);
    });
  });
});

// --- regression: preserve-compaction seam (the real compaction path) --------
//
// `compactPiContextAfterTurn` rewrites pi_core as
// `[createPiSummaryMessage(summary), ...keptTail]` with `uiRender: "preserve"`,
// which first mirrors the WHOLE pre-compaction derive (kept tail included) into
// the ai-chat table. The summary row carries no compactSummary marker and is
// stamped with the compaction WALL CLOCK, so it renders as a visible bubble that
// is chronologically NEWER than everything else in the thread. Anchoring the
// archive seam on it (`window.messages[0]`) admitted the entire render table —
// including the kept tail's own mirrors — and every compacted thread's first
// page re-served its newest turns.

async function compactWithRealSummary(
  instance: any,
  rows: AnyRecord[],
  firstKeptIndex: number,
): Promise<void> {
  const { createPiSummaryMessage } = await import(
    '../src/chat-thread/pi-compaction'
  );
  await instance['replacePiCoreMessages'](
    [
      createPiSummaryMessage('summary of the compacted prefix'),
      ...rows.slice(firstKeptIndex),
    ],
    { uiRender: 'preserve' },
  );
}

function duplicateIds(messages: UIMessage[]): string[] {
  const counts = new Map<string, number>();
  for (const message of messages) {
    counts.set(message.id, (counts.get(message.id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id);
}

/** pi_core rows as `compactPiContext` sees them, so the rewrite is realistic. */
function readPiCoreRows(instance: any): AnyRecord[] {
  return instance.ctx.storage.sql
    .exec<{ payload: string }>(
      'SELECT payload FROM pi_core_messages ORDER BY idx ASC',
    )
    .toArray()
    .map((row: { payload: string }) => JSON.parse(row.payload) as AnyRecord);
}

describe('storage-boundary derive pagination — preserve-compaction seam', () => {
  for (const stamped of [true, false]) {
    it(`does not re-serve the kept tail from the archive (${
      stamped ? 'stamped' : 'legacy renumbered'
    } ids)`, async () => {
      const threadId = `derive-page-preserve-${stamped ? 'stamped' : 'legacy'}`;
      const stub = await newChatThreadStub(threadId);
      await runInDurableObject(stub, async (instance: any) => {
        instance.chatContext = { threadId };
        instance.ensurePiCoreTables();
        seedSyntheticThread(instance, { turns: 10, stamped, tools: false });
        // Loading once is what a real thread does before it compacts.
        await instance.getUiMessagePage();

        const rows = readPiCoreRows(instance);
        await compactWithRealSummary(instance, rows, rows.length - 6);

        const limits = { maxMessages: 50, maxBytes: 4 * 1024 * 1024 };
        const first = await instance.getDerivedUiMessagePage(limits);
        expect(duplicateIds(first.messages)).toEqual([]);

        const pages = await derivedWalk(instance, limits);
        const flat = transcript(pages);
        expect(duplicateIds(flat)).toEqual([]);
        // Every turn of the original thread is still readable exactly once.
        for (let turn = 0; turn < 10; turn += 1) {
          const texts = flat.flatMap((message) =>
            (message.parts as AnyRecord[])
              .filter((part) => part.type === 'text')
              .map((part) => String(part.text)),
          );
          expect(
            texts.filter((text) => text === `answer ${turn} part 2`),
          ).toHaveLength(1);
        }
        // And it matches the full-thread pager, dedupe sets and all.
        const legacy = await legacyDerivedWalk(instance, limits);
        expect(ids(flat)).toEqual(ids(transcript(legacy)));
      });
    });
  }

  it('places the seam at the kept tail, not at the summary wall clock', async () => {
    const threadId = 'derive-page-preserve-seam-value';
    const stub = await newChatThreadStub(threadId);
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, { turns: 8, stamped: true, tools: false });
      const rows = readPiCoreRows(instance);
      await compactWithRealSummary(instance, rows, rows.length - 4);

      const keptTailOldest = (rows[rows.length - 4] as AnyRecord)
        .timestamp as number;
      expect(instance['oldestDerivedPiCreatedAtMs']()).toBe(keptTailOldest);
    });
  });
});

// --- regression: parallel tool batches must not read as a clean boundary ----

function seedParallelToolTurn(
  instance: any,
  startIdx: number,
  parallelCalls: number,
  finalTextChars: number,
): void {
  let idx = startIdx;
  let timestamp = 800_000;
  const push = (message: AnyRecord) => {
    seedPiCoreRow(instance, idx, message);
    idx += 1;
  };
  push({
    role: 'user',
    content: 'do many things at once',
    timestamp: (timestamp += 10),
    uiMetadata: { renderMessageId: 'client-user-big' },
  });
  push({
    role: 'assistant',
    content: [
      { type: 'text', text: 'kicking off the batch' },
      ...Array.from({ length: parallelCalls }, (_, call) => ({
        type: 'toolCall',
        id: `call-big-${call}`,
        name: 'read_file',
        arguments: { path: `p${call}.txt` },
      })),
    ],
    timestamp: (timestamp += 10),
    responseId: 'resp-big-head',
    uiMetadata: { renderMessageId: 'turn-big' },
  });
  for (let call = 0; call < parallelCalls; call += 1) {
    push({
      role: 'toolResult',
      toolCallId: `call-big-${call}`,
      toolName: 'read_file',
      content: [{ type: 'text', text: `contents ${call}` }],
      timestamp: (timestamp += 10),
    });
  }
  push({
    role: 'assistant',
    content: [{ type: 'text', text: 'D'.repeat(finalTextChars) }],
    timestamp: (timestamp += 10),
    responseId: 'resp-big-tail',
    uiMetadata: { renderMessageId: 'turn-big' },
  });
}

describe('storage-boundary derive pagination — parallel tool batches', () => {
  // 7 answers fit inside the old 8-row lookahead; 8 and 12 did not, and the
  // window closed declaring `boundaryUnresolved: false` while silently cutting
  // the turn in half.
  for (const parallelCalls of [3, 7, 8, 12, 24]) {
    it(`keeps a turn whole across ${parallelCalls} parallel tool answers`, async () => {
      const threadId = `derive-page-parallel-${parallelCalls}`;
      const stub = await newChatThreadStub(threadId);
      await runInDurableObject(stub, async (instance: any) => {
        instance.chatContext = { threadId };
        instance.ensurePiCoreTables();
        const rows = seedSyntheticThread(instance, {
          turns: 6,
          stamped: true,
          tools: false,
          startTimestamp: 10_000,
        });
        // The final commit alone exceeds the page's byte budget, so phase 1
        // stops on it and the boundary resolver has to reach the fold's head
        // across the whole tool batch.
        seedParallelToolTurn(instance, rows, parallelCalls, 120_000);

        const limits = { maxMessages: 50, maxBytes: 100_000 };
        const page = await instance.getDerivedUiMessagePage(limits);
        const stats = instance['lastDerivedRenderPageStats'];

        const big = page.messages.find(
          (message: UIMessage) => message.id === 'turn-big',
        );
        expect(big).toBeDefined();
        const parts = big.parts as AnyRecord[];
        const texts = parts
          .filter((part) => part.type === 'text')
          .map((part) => String(part.text));
        // BOTH commits of the fold: the head's text and the closing answer.
        expect(texts).toContain('kicking off the batch');
        expect(texts.some((text) => text.startsWith('DDD'))).toBe(true);
        for (let call = 0; call < parallelCalls; call += 1) {
          expect(
            parts.some(
              (part) =>
                String(part.type).startsWith('tool-') &&
                part.toolCallId === `call-big-${call}`,
            ),
          ).toBe(true);
        }
        expect(stats.boundaryUnresolved).toBe(false);
        expect(stats.foldCuts).toBe(0);
        expect(stats.droppedToolResults).toBe(0);

        // And the older pages never re-emit the fold's id.
        const walk = await derivedWalk(instance, limits);
        expect(duplicateIds(transcript(walk))).toEqual([]);
      });
    });
  }
});

// --- regression: an orphaned tool answer must not pin the resolver ----------

describe('storage-boundary derive pagination — orphaned tool answers', () => {
  async function seedOrphan(
    instance: any,
    threadId: string,
    withPlaceholder: boolean,
  ): Promise<void> {
    instance.chatContext = { threadId };
    instance.ensurePiCoreTables();
    const rows = seedSyntheticThread(instance, {
      turns: 40,
      stamped: true,
      tools: false,
      startTimestamp: 10_000,
    });
    if (!withPlaceholder) return;
    // Exactly what serializePiMessageForSqlStorageDetailed persists when a row
    // blows the storage soft limit: content is a STRING, so the row declares no
    // tool_use ids and the answer below it can never be matched.
    seedPiCoreRow(instance, rows, {
      role: 'assistant',
      content:
        '[message omitted from persisted transcript: serialized size 2000000 chars exceeded storage safety limit]',
      timestamp: 900_000,
      metadata: { storageOmitted: true },
    });
    seedPiCoreRow(instance, rows + 1, {
      role: 'toolResult',
      toolCallId: 'call-orphaned',
      toolName: 'read_file',
      content: [{ type: 'text', text: 'an answer with no call' }],
      timestamp: 900_010,
    });
  }

  it('gives up on an unmatchable call instead of spending the full boundary budget', async () => {
    const limits = { maxMessages: 5, maxBytes: 4 * 1024 * 1024 };

    const controlStub = await newChatThreadStub('derive-page-orphan-control');
    let controlRows = 0;
    await runInDurableObject(controlStub, async (instance: any) => {
      await seedOrphan(instance, 'derive-page-orphan-control', false);
      await instance.getDerivedUiMessagePage(limits);
      controlRows = instance['lastDerivedRenderPageStats'].rowsRead;
    });

    const stub = await newChatThreadStub('derive-page-orphan');
    await runInDurableObject(stub, async (instance: any) => {
      await seedOrphan(instance, 'derive-page-orphan', true);
      await instance.getDerivedUiMessagePage(limits);
      const stats = instance['lastDerivedRenderPageStats'];

      expect(stats.orphanedToolResults).toBe(1);
      expect(stats.droppedToolResults).toBe(1);
      // The give-up is NOT a fold cut: the warn signal stays meaningful.
      expect(stats.boundaryUnresolved).toBe(false);
      expect(stats.foldCuts).toBe(0);
      // It costs a bounded search, not the full 64-row budget.
      expect(stats.boundaryExtraRows).toBeLessThanOrEqual(
        PI_DERIVE_BOUNDARY_LOOKAHEAD_ROWS + 2,
      );
      expect(stats.rowsRead).toBeLessThan(controlRows + 16);
    });
  });
});

// --- regression: the "nothing visible yet" scan is bounded by BYTES ---------

describe('storage-boundary derive pagination — empty-scan byte bound', () => {
  it('does not materialize hundreds of megabytes looking for an anchor', async () => {
    const stub = await newChatThreadStub('derive-page-empty-scan-bytes');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-empty-scan-bytes' };
      instance.ensurePiCoreTables();
      // A contiguous run of tool answers whose calls do not exist: no row in it
      // ever produces an anchor, so only a byte budget can stop the scan. The
      // run is longer than PI_DERIVE_EMPTY_SCAN_MAX_ROWS so the row cap alone
      // would have admitted every one of them.
      const filler = 'q'.repeat(5_000);
      const rowChars = JSON.stringify({
        role: 'toolResult',
        toolCallId: 'call-void-0',
        toolName: 'read_file',
        content: [{ type: 'text', text: filler }],
        timestamp: 1_000,
      }).length;
      const rowCount = PI_DERIVE_EMPTY_SCAN_MAX_ROWS + 8;
      for (let index = 0; index < rowCount; index += 1) {
        seedPiCoreRow(instance, index, {
          role: 'toolResult',
          toolCallId: `call-void-${index}`,
          toolName: 'read_file',
          content: [{ type: 'text', text: filler }],
          timestamp: 1_000 + index,
        });
      }

      const limits = { maxMessages: 50, maxBytes: 50_000 };
      await instance.getDerivedUiMessagePage(limits);
      const stats = instance['lastDerivedRenderPageStats'];

      expect(stats.rowsRead).toBeLessThan(PI_DERIVE_EMPTY_SCAN_MAX_ROWS);
      expect(stats.payloadChars).toBeLessThanOrEqual(
        limits.maxBytes * PI_DERIVE_MAX_WINDOW_BYTE_FACTOR + rowChars,
      );
      // The row cap alone would have read the whole run.
      expect(stats.payloadChars).toBeLessThan(rowCount * rowChars * 0.5);
    });
  });
});

// --- regression: a cut fold must not silently lose the turn's opening --------

describe('storage-boundary derive pagination — cut folds are recoverable', () => {
  it('flags the partial half and the client merge reunites the turn', async () => {
    const stub = await newChatThreadStub('derive-page-cut-fold-merge');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'derive-page-cut-fold-merge' };
      instance.ensurePiCoreTables();
      seedSyntheticThread(instance, {
        turns: 3,
        stamped: true,
        startTimestamp: 1_000,
      });
      // ONE turn committing 10 rows of ~600KB under a single renderMessageId:
      // bigger than the window byte ceiling, so the window MUST close mid-fold.
      let idx = instance.ctx.storage.sql
        .exec<{ next: number }>(
          'SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM pi_core_messages',
        )
        .one().next;
      for (let commit = 0; commit < 10; commit += 1) {
        seedPiCoreRow(instance, idx, {
          role: 'assistant',
          content: [{ type: 'text', text: `commit-${commit}:${'q'.repeat(600_000)}` }],
          timestamp: 500_000 + commit,
          responseId: `resp-giant-${commit}`,
          uiMetadata: { renderMessageId: 'turn-giant' },
        });
        idx += 1;
      }

      const limits = { maxMessages: 50, maxBytes: 1024 * 1024 };
      const pages = await derivedWalk(instance, limits);
      const newest = pages[0];
      const giant = newest.messages.find(
        (message: UIMessage) => message.id === 'turn-giant',
      );
      expect(giant).toBeDefined();
      // The server says the half it served is partial.
      expect(
        (giant.metadata as AnyRecord)[RENDER_FOLD_PARTIAL_METADATA_KEY],
      ).toBe(true);
      expect(instance['lastDerivedRenderPageStats']).toBeTruthy();

      // Replay the walk exactly as the client does: newest page resident, older
      // pages prepended by id.
      let archived: UIMessage[] = [];
      for (const page of pages.slice(1)) {
        archived = prependOlderRenderMessages(archived, page.messages);
      }
      const reunited = prependOlderRenderMessages(newest.messages, archived);
      const merged = reunited.find(
        (message: UIMessage) => message.id === 'turn-giant',
      );
      expect(merged).toBeDefined();
      const texts = (merged!.parts as AnyRecord[])
        .filter((part) => part.type === 'text')
        .map((part) => String(part.text).slice(0, 20));
      // Every commit of the split turn is rendered, in order, exactly once.
      for (let commit = 0; commit < 10; commit += 1) {
        expect(
          texts.filter((text) => text.startsWith(`commit-${commit}:`)),
        ).toHaveLength(1);
      }
      expect(texts.map((text) => text.split(':')[0])).toEqual(
        Array.from({ length: 10 }, (_, commit) => `commit-${commit}`),
      );
      // And nothing else in the transcript is duplicated.
      expect(
        duplicateIds(reunited.filter((m: UIMessage) => m.id !== 'turn-giant')),
      ).toEqual([]);
    });
  });
});
