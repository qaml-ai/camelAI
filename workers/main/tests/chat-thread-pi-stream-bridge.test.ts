import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { ChatThreadDO } from '../src/chat-thread-do';
import { PiChunkEncoder } from '../../../src/lib/pi-chunk-encoder';

// Server bridge (commit 6): onChatMessage OWNS the Pi turn — its stream execute
// runs the model (a fresh prompt or the resume branch) and relays the turn's Pi
// runtime events through the encoder into native UIMessage chunks. Render content
// reaches the client only through this stream + ai-chat render history. These tests
// pin the relay (encoder → writer), the owner stream (head + streamed prompt), the
// eval-collector feed, and the pi_core → ai-chat top-up backfill.
//
// Scope note: onChatMessage + the encoder relay need no Durable Object — they only
// touch instance fields and pure `ai` stream helpers, so they run as cheap
// prototype-fakes (the turn body is a faked prompt that streams events). The
// backfill tests use a real DO for real SQLite but never drive ai-chat's
// `saveMessages`/`_reply` transport (that is ai-chat's own, third-party-tested code;
// our surface is the stream we hand it, asserted via the SSE parse below).

type AnyRecord = Record<string, unknown>;

function runtimeEvent(method: string, params: AnyRecord): AnyRecord {
  return { type: 'runtime_event', event: { method, params } };
}

// A short recorded agentMessage turn: start (empty) → deltas → completed →
// turn/completed. Mirrors the encoder's part-transition state machine.
const AGENT_TURN_EVENTS: AnyRecord[] = [
  runtimeEvent('item/started', {
    item: { id: 'a1', type: 'agentMessage', text: '' },
  }),
  runtimeEvent('item/agentMessage/delta', { itemId: 'a1', delta: 'Hello ' }),
  runtimeEvent('item/agentMessage/delta', { itemId: 'a1', delta: 'world' }),
  runtimeEvent('item/completed', {
    item: { id: 'a1', type: 'agentMessage', text: 'Hello world' },
  }),
  runtimeEvent('turn/completed', {
    forkEntryId: 'fork-1',
    turnDurationMs: 5,
    completedAtMs: 10,
  }),
];

/** Parse an SSE `text/event-stream` UIMessage response body into chunk objects. */
async function readSseChunks(response: Response): Promise<AnyRecord[]> {
  const text = await response.text();
  const chunks: AnyRecord[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice('data:'.length).trim();
    if (!payload || payload === '[DONE]') continue;
    chunks.push(JSON.parse(payload) as AnyRecord);
  }
  return chunks;
}

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

describe('ChatThreadDO bounded render history', () => {
  it('returns the first derived page without background top-up or legacy heal', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.withChatMemoryPhase = vi.fn(
      async (_operation: string, fn: () => Promise<unknown>) => fn(),
    );
    fake.sweepOrphanedActiveTurnMarker = vi.fn(async () => {});
    fake.getDerivedUiMessagePage = vi.fn(async () => ({
      messages: [{ id: 'resident', role: 'user', parts: [] }],
      nextCursor: 'd:0',
      hasMore: true,
    }));
    fake.ctx = {
      waitUntil: vi.fn(),
    };

    const page = await ChatThreadDO.prototype.getUiMessagePage.call(fake);

    expect(page.messages.map((message: AnyRecord) => message.id)).toEqual([
      'resident',
    ]);
    expect(fake.getDerivedUiMessagePage).toHaveBeenCalledTimes(1);
    expect(fake.ctx.waitUntil).not.toHaveBeenCalled();
  });

  it('keeps only the resident window in memory while retaining and paging every durable row', async () => {
    const stub = await newChatThreadStub('thread-bounded-render-history');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-bounded-render-history' };
      const messages = Array.from({ length: 75 }, (_, index) => ({
        id: `message-${String(index).padStart(3, '0')}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        parts: [{ type: 'text', text: `message ${index}` }],
      }));

      await instance.persistMessages(messages);

      const first = await instance.getUiMessagePage();
      expect(first.messages).toHaveLength(50);
      expect(first.messages[0].id).toBe('message-025');
      expect(first.messages[49].id).toBe('message-074');
      expect(first.hasMore).toBe(true);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(instance.messages).toHaveLength(50);
      expect(
        instance.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages',
          )
          .one().count,
      ).toBe(75);

      // Appending after publishing a cursor cannot move the boundary it names.
      await instance.persistMessages([
        ...instance.messages,
        {
          id: 'message-075',
          role: 'assistant',
          parts: [{ type: 'text', text: 'newest' }],
        },
      ]);
      const older = await instance.getOlderUiMessages(first.nextCursor);
      expect(older.messages.map((message: AnyRecord) => message.id)).toEqual(
        Array.from({ length: 26 }, (_, index) =>
          `message-${String(index).padStart(3, '0')}`,
        ),
      );
      expect(older.hasMore).toBe(false);
      expect(older.nextCursor).toBeNull();
      expect(
        instance.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages',
          )
          .one().count,
      ).toBe(76);
    });
  });

  it('returns one oversized row instead of producing an empty or skipping page', async () => {
    const stub = await newChatThreadStub('thread-render-history-oversized-row');
    await runInDurableObject(stub, async (instance: any) => {
      await instance.persistMessages([
        {
          id: 'older',
          role: 'user',
          parts: [{ type: 'text', text: 'small' }],
        },
        {
          id: 'newer-large',
          role: 'assistant',
          parts: [{ type: 'text', text: 'x'.repeat(2_000) }],
        },
      ]);

      const page = instance.getRenderHistoryPage({ maxBytes: 100 });
      expect(page.messages.map((message: AnyRecord) => message.id)).toEqual([
        'newer-large',
      ]);
      expect(page.hasMore).toBe(true);
      expect(page.nextCursor).toEqual(expect.any(String));
      const older = instance.getRenderHistoryPage({
        beforeCursor: page.nextCursor,
        maxBytes: 100,
      });
      expect(older.messages.map((message: AnyRecord) => message.id)).toEqual([
        'newer-large',
      ]);
      expect(older.hasMore).toBe(true);
      const oldest = instance.getRenderHistoryPage({
        beforeCursor: older.nextCursor,
        maxBytes: 100,
      });
      expect(oldest.messages.map((message: AnyRecord) => message.id)).toEqual([
        'older',
      ]);
      expect(oldest.hasMore).toBe(false);
    });
  });

  it('migrates a genuine pre-column render table idempotently', async () => {
    const stub = await newChatThreadStub('thread-render-history-metadata');
    await runInDurableObject(stub, async (instance: any) => {
      instance.ctx.storage.sql.exec(
        'DROP TABLE cf_ai_chat_render_history_meta',
      );
      instance.ctx.storage.sql.exec('DROP TABLE cf_ai_chat_agent_messages');
      instance.ctx.storage.sql.exec(
        'CREATE TABLE cf_ai_chat_agent_messages (id TEXT PRIMARY KEY, message TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)',
      );
      instance.ctx.storage.sql.exec(
        'INSERT INTO cf_ai_chat_agent_messages (id, message) VALUES (?, ?)',
        'legacy-row',
        JSON.stringify({
          id: 'legacy-row',
          role: 'user',
          parts: [{ type: 'text', text: 'legacy' }],
        }),
      );

      instance._ensureRenderHistoryMetadata();
      const first = instance.ctx.storage.sql
        .exec<{
          render_seq: number | null;
          serialized_bytes: number | null;
          chronology_key: string | null;
        }>(
          'SELECT render_seq, serialized_bytes, chronology_key FROM cf_ai_chat_agent_messages WHERE id = ?',
          'legacy-row',
        )
        .one();
      expect(first.render_seq).toEqual(expect.any(Number));
      expect(first.serialized_bytes).toBeGreaterThan(0);
      expect(first.chronology_key).toEqual(expect.any(String));
      expect(
        instance.ctx.storage.sql
          .exec<{ value: number }>(
            "SELECT value FROM cf_ai_chat_render_history_meta WHERE key = 'metadata_v1'",
          )
          .one().value,
      ).toBe(1);

      instance._ensureRenderHistoryMetadata();
      expect(
        instance.ctx.storage.sql
          .exec(
            'SELECT render_seq, serialized_bytes, chronology_key FROM cf_ai_chat_agent_messages WHERE id = ?',
            'legacy-row',
          )
          .one(),
      ).toEqual(first);
    });
  });

  it('heals timestamps across durable pages before setting the one-shot marker', async () => {
    const stub = await newChatThreadStub('thread-render-history-time-heal-pages');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-render-history-time-heal-pages' };
      await instance.persistMessages(
        Array.from({ length: 60 }, (_, index) => ({
          id: `legacy-time-${String(index).padStart(3, '0')}`,
          role: 'assistant',
          parts: [{ type: 'text', text: `answer ${index}`, state: 'done' }],
        })),
      );

      await instance.healLegacyUiMessageTimes();

      const rows = instance.ctx.storage.sql
        .exec<{ message: string }>(
          'SELECT message FROM cf_ai_chat_agent_messages ORDER BY chronology_key',
        )
        .toArray();
      expect(rows).toHaveLength(60);
      expect(
        rows.every((row: { message: string }) => {
          const message = JSON.parse(row.message) as AnyRecord;
          return typeof (message.metadata as AnyRecord | undefined)?.pi === 'object'
            && typeof ((message.metadata as AnyRecord).pi as AnyRecord).createdAtMs === 'number';
        }),
      ).toBe(true);
      expect(instance.ctx.storage.kv.get('uiMessagesTimeHealDone')).toBe(true);
    });
  });

  it('heals author attribution on rows older than the resident window', async () => {
    const stub = await newChatThreadStub('thread-render-history-author-heal-pages');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = {
        threadId: 'thread-render-history-author-heal-pages',
      };
      instance.ensurePiCoreTables();
      const messages = Array.from({ length: 60 }, (_, index) => {
        const timestamp = 10_000 + index;
        const id = `legacy-author-${String(index).padStart(3, '0')}`;
        seedPiCoreRow(instance, index, {
          role: 'user',
          content: `[web message from User ${index}]: canonical`,
          timestamp,
          uiMetadata: { renderMessageId: id },
        });
        return {
          id,
          role: 'user',
          parts: [{ type: 'text', text: `raw ${index}`, state: 'done' }],
          metadata: {
            piCoreMessageKey: String(timestamp),
            pi: { createdAtMs: timestamp },
          },
        };
      });
      await instance.persistMessages(messages);

      await instance.healLegacyUiMessageAuthors();

      const oldest = instance.ctx.storage.sql
        .exec<{ message: string }>(
          'SELECT message FROM cf_ai_chat_agent_messages WHERE id = ?',
          'legacy-author-000',
        )
        .one();
      expect(JSON.parse(oldest.message).metadata).toMatchObject({
        authorDisplayName: 'User 0',
        source: 'web',
      });
      expect(
        instance.ctx.storage.kv.get('uiMessagesAuthorAttributionHealV1'),
      ).toBe(true);
    });
  });

  it('reports the total durable row count after a rebuild, not resident count', async () => {
    const stub = await newChatThreadStub('thread-render-history-resync-count');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-render-history-resync-count' };
      instance.ensurePiCoreTables();
      for (let index = 0; index < 60; index += 1) {
        seedPiCoreRow(instance, index, {
          role: 'user',
          content: `question ${index}`,
          timestamp: 20_000 + index,
        });
      }

      const result = await instance.resyncUiMessagesFromPiCore();

      expect(result).toEqual({ ok: true, messageCount: 60 });
      expect(instance.messages).toHaveLength(50);
    });
  });
});

describe('ChatThreadDO native stream bridge (commit 3b)', () => {
  it('relays encoder chunks to the attached writer and feeds the eval collector', () => {
    const writes: AnyRecord[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.activePiStreamTurnId = 'turn-1';
    fake.agentEvalEventCollector = [];
    fake.piChunkEncoder = new PiChunkEncoder({ messageId: 'turn-1' });
    fake.piStreamWriter = { write: (chunk: AnyRecord) => writes.push(chunk) };
    fake.piPreAttachChunkBuffer = null;
    fake.syncAgentState = vi.fn();

    for (const event of AGENT_TURN_EVENTS) {
      ChatThreadDO.prototype['pushChatEvent'].call(fake, event);
    }

    // Native stream: the encoder's part-transition chunks reached the writer.
    const types = writes.map((chunk) => chunk.type);
    expect(types).toEqual([
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'message-metadata',
      'finish',
    ]);
    expect(writes[1]).toMatchObject({ type: 'text-delta', delta: 'Hello ' });
    const metadata = writes.find((chunk) => chunk.type === 'message-metadata');
    expect(metadata).toMatchObject({
      messageMetadata: { pi: { forkEntryId: 'fork-1', turnDurationMs: 5 } },
    });

    // The eval collector still consumes every envelope unchanged. The
    // turn-completed badge now rides message-metadata.pi (asserted above), not an
    // Agent-state mirror, so no syncAgentState fires for a runtime event.
    expect(fake.agentEvalEventCollector).toHaveLength(AGENT_TURN_EVENTS.length);
    expect(fake.syncAgentState).not.toHaveBeenCalled();
  });

  it('relays a steer-marker envelope into the active turn stream', () => {
    const writes: AnyRecord[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piChunkEncoder = new PiChunkEncoder({ messageId: 'turn-1' });
    fake.piStreamWriter = { write: (chunk: AnyRecord) => writes.push(chunk) };
    fake.piPreAttachChunkBuffer = null;

    ChatThreadDO.prototype['writePiStreamChunks'].call(
      fake,
      runtimeEvent('item/agentMessage/delta', {
        itemId: 'a1',
        delta: 'before',
      }),
    );
    writes.length = 0;
    ChatThreadDO.prototype['writePiStreamChunks'].call(fake, {
      type: 'steer-marker',
      steerMessageId: 'u2',
      acceptedAtMs: 123,
    });

    expect(writes).toEqual([
      { type: 'text-end' },
      {
        type: 'data-pi-steer-marker',
        id: 'pi:steer:u2',
        data: { steerMessageId: 'u2', acceptedAtMs: 123 },
      },
    ]);
  });

  it('owns a fresh turn: emits the head from the marker id then streams the prompt events', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const turnId = 'turn-buf';
    fake.chatContext = { threadId: 'thread-buffer' };
    // A fresh turn: the marker carries the stable stream id; the attributed prompt
    // is stashed; the session is warm and idle so onChatMessage takes the prompt path.
    fake.readPiActiveTurn = vi.fn(() => ({ turnId, openedAt: 1 }));
    fake.pendingPiPromptQueue = [{ userMessage: { role: 'user', content: 'hi' } }];
    fake.refreshPiSessionModel = vi.fn(async () => {});
    fake.withPiTurnInactivityTimeout = vi.fn(async (fn: () => unknown) => fn());
    fake.piEventHandlerChain = Promise.resolve();
    fake.syncAgentState = vi.fn();
    fake.piSession = {
      state: { isStreaming: false },
      prompt: vi.fn(async () => {
        // The turn body streams the Pi events through the encoder relay (the writer
        // is already attached, so nothing is buffered).
        for (const event of AGENT_TURN_EVENTS) {
          ChatThreadDO.prototype['writePiStreamChunks'].call(fake, event);
        }
      }),
    };

    const response = (await ChatThreadDO.prototype['onChatMessage'].call(
      fake,
      () => {},
      {},
    )) as Response;
    const chunks = await readSseChunks(response);
    const types = chunks.map((chunk) => chunk.type);

    // Head first (with the marker's turnId, which ai-chat adopts as the persisted
    // assistant message id), then the streamed part-transition chunks in order.
    expect(types.slice(0, 2)).toEqual(['start', 'start-step']);
    expect(chunks[0]).toMatchObject({ type: 'start', messageId: turnId });
    expect(fake.piSession.prompt).toHaveBeenCalledTimes(1);
    expect(types.indexOf('text-start')).toBeGreaterThan(types.indexOf('start-step'));
    expect(types.indexOf('text-end')).toBeGreaterThan(types.indexOf('text-start'));
    const textDeltas = chunks
      .filter((chunk) => chunk.type === 'text-delta')
      .map((chunk) => chunk.delta)
      .join('');
    expect(textDeltas).toBe('Hello world');
    const metadata = chunks.find((chunk) => chunk.type === 'message-metadata');
    expect(metadata).toMatchObject({
      messageMetadata: { pi: { forkEntryId: 'fork-1' } },
    });
    expect(types).toContain('finish');
    // The writer + encoder + active id are cleared on close.
    expect(fake.piStreamWriter).toBeNull();
    expect(fake.piChunkEncoder).toBeNull();
    expect(fake.activePiStreamTurnId).toBeNull();
  });

  it('resumes an interrupted turn when no fresh prompt is pending', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const turnId = 'turn-resume';
    fake.chatContext = { threadId: 'thread-resume' };
    fake.readPiActiveTurn = vi.fn(() => ({ turnId, openedAt: 1 }));
    fake.pendingPiPromptQueue = []; // recovery re-drive: no fresh prompt
    fake.piSession = null; // cold/disposed session
    fake.piEventHandlerChain = Promise.resolve();
    fake.syncAgentState = vi.fn();
    fake.resumeActivePiTurn = vi.fn(async () => {});

    const response = (await ChatThreadDO.prototype['onChatMessage'].call(
      fake,
      () => {},
      {},
    )) as Response;
    await readSseChunks(response);

    // No pending prompt → the resume branch runs (rebuilds + continues).
    expect(fake.resumeActivePiTurn).toHaveBeenCalledTimes(1);
    expect(fake.activePiStreamTurnId).toBeNull();
  });

  it('returns undefined (stays inert) when no Pi turn is in flight', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.pendingPiPromptQueue = [];
    fake.readPiActiveTurn = vi.fn(() => null);
    const response = await ChatThreadDO.prototype['onChatMessage'].call(
      fake,
      () => {},
      {},
    );
    expect(response).toBeUndefined();
  });

  it('derives settled UI messages from pi_core on read in pi order', async () => {
    const stub = await newChatThreadStub('thread-backfill');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-backfill' };
      instance.ensurePiCoreTables();
      seedPiCoreRow(instance, 0, {
        role: 'user',
        content: 'first question',
        timestamp: 1000,
      });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'first answer' }],
        timestamp: 1000,
        responseId: 'resp-1',
      });

      const first = await instance.getUiMessages();
      expect(first.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'resp-1',
      ]);
      expect(first.map((m: AnyRecord) => m.role)).toEqual(['user', 'assistant']);
      // Derive-on-read does not require materializing the ai-chat mirror.
      expect(
        instance.ctx.storage.sql
          .exec<{ count: number }>(
            'SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages',
          )
          .one().count,
      ).toBe(0);

      const second = await instance.getUiMessages();
      expect(second.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'resp-1',
      ]);

      seedPiCoreRow(instance, 2, {
        role: 'user',
        content: 'second question',
        timestamp: 2000,
      });
      const third = await instance.getUiMessages();
      expect(third.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'resp-1',
        'pi_user_2000_2',
      ]);
    });
  });

  it('does not duplicate live-written rows on top-up (metadata dedupe)', async () => {
    const stub = await newChatThreadStub('thread-dedupe');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-dedupe' };
      instance.ensurePiCoreTables();

      // Simulate a live turn: the bridge persisted ai-chat rows under the
      // client/minted ids (user skeleton stamped with the pi timestamp as
      // piCoreMessageKey; assistant carrying metadata.pi.forkEntryId) BEFORE the
      // matching pi_core rows were converted by the top-up backfill.
      await instance.persistMessages([
        {
          id: 'client-user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'live question', state: 'done' }],
          metadata: { piCoreMessageKey: '1000' },
        },
        {
          id: 'turn-mint-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'live answer', state: 'done' }],
          metadata: { pi: { forkEntryId: 'resp-live-1' } },
        },
      ]);

      // The same content lands in pi_core (user timestamp 1000; assistant
      // responseId === the forkEntryId that rode message-metadata).
      seedPiCoreRow(instance, 0, {
        role: 'user',
        content: 'live question',
        timestamp: 1000,
      });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'live answer' }],
        timestamp: 1000,
        responseId: 'resp-live-1',
      });

      const messages = await instance.getUiMessages();
      // Derive-on-read overlays live skeletons onto matching pi rows by
      // piCoreMessageKey / forkEntryId so client/minted ids win.
      expect(messages.map((m: AnyRecord) => m.id)).toEqual([
        'client-user-1',
        'turn-mint-1',
      ]);

      seedPiCoreRow(instance, 2, {
        role: 'user',
        content: 'second question',
        timestamp: 2000,
      });
      const afterSecond = await instance.getUiMessages();
      const ids = afterSecond.map((m: AnyRecord) => m.id);
      expect(ids).toContain('client-user-1');
      expect(ids).toContain('turn-mint-1');
      expect(ids).toContain('pi_user_2000_2');
      expect(ids).toHaveLength(3);
    });
  });

  it('deduplicates legacy top-up identities across the full durable archive', async () => {
    const stub = await newChatThreadStub('thread-legacy-archive-dedupe');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-legacy-archive-dedupe' };
      instance.ensurePiCoreTables();

      const renderMessages: AnyRecord[] = [];
      for (let turn = 0; turn < 30; turn += 1) {
        const timestamp = 10_000 + turn;
        renderMessages.push(
          {
            id: `live-user-${turn}`,
            role: 'user',
            parts: [{ type: 'text', text: `question ${turn}`, state: 'done' }],
            metadata: { piCoreMessageKey: String(timestamp) },
          },
          {
            id: `live-assistant-${turn}`,
            role: 'assistant',
            parts: [{ type: 'text', text: `answer ${turn}`, state: 'done' }],
            metadata: { pi: { forkEntryId: `legacy-response-${turn}` } },
          },
        );
        // These rows intentionally predate renderMessageId stamping.
        seedPiCoreRow(instance, turn * 2, {
          role: 'user',
          content: `question ${turn}`,
          timestamp,
        });
        seedPiCoreRow(instance, turn * 2 + 1, {
          role: 'assistant',
          content: [{ type: 'text', text: `answer ${turn}` }],
          timestamp,
          responseId: `legacy-response-${turn}`,
        });
      }
      await instance.persistMessages(renderMessages);
      expect(instance.messages).toHaveLength(50);

      const derived = await instance.getUiMessages();
      // Live skeletons overlay matching derived rows; no duplicate pi_user_*/resp ids.
      expect(derived).toHaveLength(50);
      expect(new Set(derived.map((m: AnyRecord) => m.id)).size).toBe(50);

      const durableRows = instance.ctx.storage.sql
        .exec<{ count: number }>(
          'SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages',
        )
        .one().count;
      // Derive-on-read does not rewrite the live/archive table on read.
      expect(durableRows).toBe(60);
      const durableIds = instance.ctx.storage.sql
        .exec<{ id: string }>(
          'SELECT id FROM cf_ai_chat_agent_messages ORDER BY id',
        )
        .toArray()
        .map((row: { id: string }) => row.id);
      expect(durableIds.some((id: string) => id.startsWith('pi_user_'))).toBe(
        false,
      );
      expect(
        durableIds.some((id: string) => id.startsWith('legacy-response-')),
      ).toBe(false);
    });
  });

  it('backfills a forked thread render history from the seeded pi_core slice', async () => {
    // The fork route (workspaces.$id.chat.$threadId.fork.ts) reads the source
    // thread's pi_core via getPiCoreForkMessages, then seeds a fresh target DO
    // with replacePiCoreForkMessages. This pins that full flow through to the
    // target's ai-chat render history (getUiMessages → top-up backfill).
    const sourceStub = await newChatThreadStub('thread-fork-source');
    let forkMessages: AnyRecord[] = [];
    await runInDurableObject(sourceStub, async (source: any) => {
      source.chatContext = { threadId: 'thread-fork-source' };
      source.ensurePiCoreTables();
      // Two full turns; the fork target is the first assistant turn (resp-1).
      seedPiCoreRow(source, 0, {
        role: 'user',
        content: 'first question',
        timestamp: 1000,
      });
      seedPiCoreRow(source, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'first answer' }],
        timestamp: 1000,
        responseId: 'resp-1',
      });
      seedPiCoreRow(source, 2, {
        role: 'user',
        content: 'second question',
        timestamp: 2000,
      });
      seedPiCoreRow(source, 3, {
        role: 'assistant',
        content: [{ type: 'text', text: 'second answer' }],
        timestamp: 2000,
        responseId: 'resp-2',
      });

      const result = await source.getPiCoreForkMessages({ forkEntryId: 'resp-1' });
      expect(result.success).toBe(true);
      // Sliced through the fork target inclusive: the two later rows are dropped.
      expect(result.messageCount).toBe(2);
      forkMessages = result.messages;
    });

    const targetStub = await newChatThreadStub('thread-fork-target');
    await runInDurableObject(targetStub, async (target: any) => {
      target.chatContext = { threadId: 'thread-fork-target' };
      // Seed the fresh target exactly as the fork route does.
      await target.replacePiCoreForkMessages(forkMessages);

      const messages = await target.getUiMessages();
      // Derive-on-read serves the forked pi_core slice; later source turns are absent.
      expect(messages.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'resp-1',
      ]);
      expect(messages.map((m: AnyRecord) => m.role)).toEqual(['user', 'assistant']);

      const second = await target.getUiMessages();
      expect(second.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'resp-1',
      ]);
    });
  });

  it('does not clobber the live row when reloading after a multi-SDK-turn tool run (REGRESSION)', async () => {
    // A tool-using run commits one pi_core assistant row PER SDK turn, but the
    // whole run streams into ONE live ai-chat row (the minted turnId), whose
    // metadata carries only the LAST assistant's responseId as forkEntryId. On
    // reload the top-up used to re-convert the intermediate assistant rows;
    // ai-chat's resolveToolMergeId then re-ided them onto the live turnId row
    // (shared toolCallIds) and the persist upsert REPLACED it — losing the final
    // answer. The intermediate rows must be recognized as already-rendered via
    // their tool-call identity.
    const stub = await newChatThreadStub('thread-multi-turn-clobber');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-multi-turn-clobber' };
      instance.ensurePiCoreTables();

      // Live render rows exactly as the bridge persists them after the run: one
      // user skeleton, one assistant row with the run's full content (tool part
      // + final text) under the minted turnId, stamped with the LAST responseId.
      await instance.persistMessages([
        {
          id: 'client-user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'run the tool', state: 'done' }],
          metadata: { piCoreMessageKey: '1000' },
        },
        {
          id: 'turn-mint-1',
          role: 'assistant',
          parts: [
            {
              type: 'tool-bash',
              toolCallId: 'tc1',
              toolName: 'bash',
              state: 'output-available',
              input: { command: 'ls' },
              output: { content: 'ok', isError: false },
            },
            { type: 'text', text: 'final answer', state: 'done' },
          ],
          metadata: { pi: { forkEntryId: 'resp-2' } },
        },
      ]);

      // The same run in pi_core: user, first SDK turn (tool call), its result,
      // final SDK turn (text). Only resp-2 is in the live row's metadata.
      seedPiCoreRow(instance, 0, {
        role: 'user',
        content: 'run the tool',
        timestamp: 1000,
      });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc1', name: 'bash', arguments: { command: 'ls' } },
        ],
        timestamp: 1100,
        responseId: 'resp-1',
        uiMetadata: { renderMessageId: 'turn-mint-1' },
      });
      seedPiCoreRow(instance, 2, {
        role: 'toolResult',
        toolCallId: 'tc1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'ok' }],
        timestamp: 1200,
      });
      seedPiCoreRow(instance, 3, {
        role: 'assistant',
        content: [{ type: 'text', text: 'final answer' }],
        timestamp: 1300,
        responseId: 'resp-2',
        uiMetadata: { renderMessageId: 'turn-mint-1' },
      });

      // Reload (the loader path).
      const messages = await instance.getUiMessages();

      expect(messages.map((m: AnyRecord) => m.id)).toEqual([
        'client-user-1',
        'turn-mint-1',
      ]);
      const live = messages.find((m: AnyRecord) => m.id === 'turn-mint-1');
      const texts = (live.parts as AnyRecord[])
        .filter((part) => part.type === 'text')
        .map((part) => part.text);
      // The final answer must survive: the intermediate assistant row (resp-1)
      // was NOT converted and merged over the live row.
      expect(texts).toEqual(['final answer']);
      expect(
        messages.some((m: AnyRecord) => m.id === 'resp-1' || m.id === 'resp-2'),
      ).toBe(false);

      // A second reload stays stable.
      const again = await instance.getUiMessages();
      expect(again.map((m: AnyRecord) => m.id)).toEqual([
        'client-user-1',
        'turn-mint-1',
      ]);
    });
  });

  it('skips rows stamped under metadata.pi.forkEntryIds (recovery commit path)', async () => {
    // resumeActivePiTurn's non-owing branch commits the journal tail without
    // streaming; when the orphan partial was persisted it stamps the tail's
    // assistant responseIds under metadata.pi.forkEntryIds so the top-up skips
    // those rows exactly like the encoder-stamped forkEntryId.
    const stub = await newChatThreadStub('thread-forkentryids');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-forkentryids' };
      instance.ensurePiCoreTables();
      await instance.persistMessages([
        {
          id: 'client-user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'q', state: 'done' }],
          metadata: { piCoreMessageKey: '1000' },
        },
        {
          id: 'turn-mint-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'answer', state: 'done' }],
          metadata: { pi: { forkEntryIds: ['resp-a'] } },
        },
      ]);
      seedPiCoreRow(instance, 0, { role: 'user', content: 'q', timestamp: 1000 });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        timestamp: 1100,
        responseId: 'resp-a',
      });

      const messages = await instance.getUiMessages();
      expect(messages.map((m: AnyRecord) => m.id)).toEqual([
        'client-user-1',
        'turn-mint-1',
      ]);
    });
  });

  it('does not duplicate steered and channel-history user rows on reload', async () => {
    const stub = await newChatThreadStub('thread-steer-channel');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-steer-channel' };
      instance.ensurePiCoreTables();
      await instance.persistMessages([
        {
          id: 'client-user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'first', state: 'done' }],
          metadata: { piCoreMessageKey: '1000' },
        },
        {
          // The steer path persists the bubble directly with the pi timestamp.
          id: 'client-user-2',
          role: 'user',
          parts: [{ type: 'text', text: 'steered', state: 'done' }],
          metadata: { piCoreMessageKey: '1500' },
        },
        {
          // Channel-history mirror (appendChannelHistoryEvent).
          id: 'channel-1',
          role: 'user',
          parts: [{ type: 'text', text: 'delivered mail', state: 'done' }],
          metadata: { channelHistory: true, piCoreMessageKey: '2000' },
        },
        {
          id: 'turn-mint-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'done', state: 'done' }],
          metadata: { pi: { forkEntryId: 'resp-1' } },
        },
      ]);
      seedPiCoreRow(instance, 0, { role: 'user', content: 'first', timestamp: 1000 });
      seedPiCoreRow(instance, 1, {
        role: 'user',
        content: 'steered',
        timestamp: 1500,
        metadata: { sentDuringStreaming: true },
      });
      seedPiCoreRow(instance, 2, {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: 1600,
        responseId: 'resp-1',
      });
      seedPiCoreRow(instance, 3, {
        role: 'user',
        content: '<camelai system message>\nDelivered message:\ndelivered mail\n</camelai system message>',
        timestamp: 2000,
      });

      const messages = await instance.getUiMessages();
      // Derive-on-read follows pi_core sequence: the channel-history user row
      // lands after the assistant in pi_core, so it renders after the turn.
      expect(messages.map((m: AnyRecord) => m.id)).toEqual([
        'client-user-1',
        'client-user-2',
        'turn-mint-1',
        'channel-1',
      ]);
    });
  });

  it('derives settled history while a Pi turn marker is set (no top-up gate)', async () => {
    const stub = await newChatThreadStub('thread-marker-gate');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-marker-gate' };
      instance.ensurePiCoreTables();
      seedPiCoreRow(instance, 0, { role: 'user', content: 'q', timestamp: 1000 });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'mid-run commit' }],
        timestamp: 1100,
        responseId: 'resp-1',
      });

      // A live (or recovering) turn owns the rows beyond the mark.
      instance.ctx.storage.kv.put('piActiveTurn', {
        turnId: 'turn-live',
        openedAt: Date.now(),
      });
      // Derive-on-read serves settled history even while a turn marker is set;
      // the live open-turn row is overlaid when present.
      const during = await instance.getUiMessages();
      expect(during.map((m: AnyRecord) => m.id)).toEqual(['pi_user_1000_0', 'resp-1']);

      instance.ctx.storage.kv.delete('piActiveTurn');
      const after = await instance.getUiMessages();
      expect(after.map((m: AnyRecord) => m.id)).toEqual(['pi_user_1000_0', 'resp-1']);
      const again = await instance.getUiMessages();
      expect(again.map((m: AnyRecord) => m.id)).toEqual(['pi_user_1000_0', 'resp-1']);
    });
  });

  it('skips stamped rows when the live turnId row already landed', async () => {
    const stub = await newChatThreadStub('thread-stamped-skip');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-stamped-skip' };
      instance.ensurePiCoreTables();
      await instance.persistMessages([
        {
          id: 'client-user-1',
          role: 'user',
          parts: [{ type: 'text', text: 'q', state: 'done' }],
          metadata: { piCoreMessageKey: '1000' },
        },
        {
          id: 'turn-live',
          role: 'assistant',
          parts: [{ type: 'text', text: 'streamed answer', state: 'done' }],
          metadata: { pi: { forkEntryId: 'resp-1' } },
        },
      ]);
      seedPiCoreRow(instance, 0, {
        role: 'user',
        content: 'q',
        timestamp: 1000,
        uiMetadata: { renderMessageId: 'client-user-1' },
      });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'streamed answer' }],
        timestamp: 1100,
        responseId: 'resp-1',
        uiMetadata: { renderMessageId: 'turn-live' },
      });

      const after = await instance.getUiMessages();
      expect(after.map((m: AnyRecord) => m.id)).toEqual([
        'client-user-1',
        'turn-live',
      ]);
    });
  });

  it('converts stamped rows under the live id, so a later reply persist upserts into one row', async () => {
    const stub = await newChatThreadStub('thread-stamped-converge');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-stamped-converge' };
      instance.ensurePiCoreTables();
      // The agent_end → `_reply` persist gap (or a rollback): rows are
      // committed and the marker is cleared, but no live render row exists.
      seedPiCoreRow(instance, 0, { role: 'user', content: 'q', timestamp: 1000 });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'streamed answer' }],
        timestamp: 1100,
        responseId: 'resp-1',
        uiMetadata: { renderMessageId: 'turn-live' },
      });

      // A loader hit in the gap converts the rows under the SAME id the live
      // stream persists.
      const during = await instance.getUiMessages();
      expect(during.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'turn-live',
      ]);

      // The delayed `_reply` persist then upserts the same id — one row, no
      // duplicate, regardless of writer order.
      await instance.persistMessages([
        ...instance.messages.filter((m: AnyRecord) => m.id !== 'turn-live'),
        {
          id: 'turn-live',
          role: 'assistant',
          parts: [{ type: 'text', text: 'streamed answer', state: 'done' }],
          metadata: { pi: { forkEntryId: 'resp-1' } },
        },
      ]);
      const after = await instance.getUiMessages();
      expect(after.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'turn-live',
      ]);
    });
  });

  it('folds a multi-SDK-turn run into the one live message id', async () => {
    const stub = await newChatThreadStub('thread-stamped-fold');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-stamped-fold' };
      instance.ensurePiCoreTables();
      seedPiCoreRow(instance, 0, { role: 'user', content: 'q', timestamp: 1000 });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [
          { type: 'text', text: 'step one' },
          { type: 'toolCall', id: 'call-1', name: 'bash', arguments: { cmd: 'ls' } },
        ],
        timestamp: 1100,
        responseId: 'resp-1',
        uiMetadata: { renderMessageId: 'turn-live' },
      });
      seedPiCoreRow(instance, 2, {
        role: 'toolResult',
        toolCallId: 'call-1',
        content: 'file.txt',
        timestamp: 1150,
      });
      seedPiCoreRow(instance, 3, {
        role: 'assistant',
        content: [{ type: 'text', text: 'step two' }],
        timestamp: 1200,
        responseId: 'resp-2',
        uiMetadata: { renderMessageId: 'turn-live' },
      });

      const after = await instance.getUiMessages();
      expect(after.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'turn-live',
      ]);
      const folded = after[1] as AnyRecord;
      const partTypes = (folded.parts as AnyRecord[]).map((p) => p.type);
      expect(partTypes).toEqual(['text', 'tool-bash', 'text']);
      const pi = (folded.metadata as AnyRecord).pi as AnyRecord;
      expect(pi.forkEntryId).toBe('resp-2');
      expect(pi.forkEntryIds).toEqual(['resp-1', 'resp-2']);

      // Idempotent: a second top-up converts nothing new.
      const again = await instance.getUiMessages();
      expect(again.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'turn-live',
      ]);
    });
  });

  it('rebuilds a steered turn as one marked assistant row without clobbering either half', async () => {
    const stub = await newChatThreadStub('thread-stamped-steer-rebuild');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-stamped-steer-rebuild' };
      instance.ensurePiCoreTables();
      seedPiCoreRow(instance, 0, {
        role: 'user',
        content: 'build the app',
        timestamp: 1000,
        uiMetadata: { renderMessageId: 'client-u1' },
      });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'before steer' }],
        timestamp: 1100,
        responseId: 'resp-before',
        uiMetadata: { renderMessageId: 'turn-live' },
      });
      seedPiCoreRow(instance, 2, {
        role: 'user',
        content: 'use sqlite',
        timestamp: 1200,
        metadata: { sentDuringStreaming: true },
        uiMetadata: { renderMessageId: 'client-u2' },
      });
      seedPiCoreRow(instance, 3, {
        role: 'assistant',
        content: [{ type: 'text', text: 'after steer' }],
        timestamp: 1300,
        responseId: 'resp-after',
        uiMetadata: { renderMessageId: 'turn-live' },
      });

      await instance.resyncUiMessagesFromPiCore();
      const messages = await instance.getUiMessages();

      expect(messages.map((message: AnyRecord) => message.id)).toEqual([
        'client-u1',
        'turn-live',
        'client-u2',
      ]);
      expect(
        messages.filter((message: AnyRecord) => message.role === 'assistant'),
      ).toHaveLength(1);
      const turn = messages.find(
        (message: AnyRecord) => message.id === 'turn-live',
      ) as AnyRecord;
      expect(turn.parts).toEqual([
        { type: 'text', text: 'before steer', state: 'done' },
        {
          type: 'data-pi-steer-marker',
          id: 'pi:steer:client-u2',
          data: { steerMessageId: 'client-u2', acceptedAtMs: 1200 },
        },
        { type: 'text', text: 'after steer', state: 'done' },
      ]);
      expect((turn.metadata as AnyRecord).pi).toMatchObject({
        forkEntryId: 'resp-after',
        forkEntryIds: ['resp-before', 'resp-after'],
      });
      const steerBubble = messages.find(
        (message: AnyRecord) => message.id === 'client-u2',
      ) as AnyRecord;
      expect(steerBubble.metadata).toMatchObject({
        sentDuringStreaming: true,
      });
    });
  });

  it('heals legacy rows without time metadata from the created_at column', async () => {
    const stub = await newChatThreadStub('thread-time-heal');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-time-heal' };
      instance.ensurePiCoreTables();
      // A pre-stamp legacy assistant row (only forkEntryId, like rows persisted
      // before the ai-chat streaming migration) plus an already-stamped one.
      await instance.persistMessages([
        {
          id: 'legacy-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'old answer', state: 'done' }],
          metadata: { pi: { forkEntryId: 'resp-old' } },
        },
        {
          id: 'stamped-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'new answer', state: 'done' }],
          metadata: { pi: { forkEntryId: 'resp-new', completedAtMs: 1751931600000 } },
        },
      ]);
      instance.ctx.storage.sql.exec(
        "UPDATE cf_ai_chat_agent_messages SET created_at = '2026-07-08 00:29:19.695' WHERE id = 'legacy-1'",
      );
      instance.reloadAiChatMessagesOrdered();

      await instance.healLegacyUiMessageTimes();
      const messages = await instance.getUiMessages();
      const legacy = messages.find((m: AnyRecord) => m.id === 'legacy-1') as AnyRecord;
      const pi = (legacy.metadata as AnyRecord).pi as AnyRecord;
      expect(pi.createdAtMs).toBe(Date.parse('2026-07-08T00:29:19.695Z'));
      expect(pi.forkEntryId).toBe('resp-old');
      const stamped = messages.find((m: AnyRecord) => m.id === 'stamped-1') as AnyRecord;
      expect((stamped.metadata as AnyRecord).pi).toEqual({
        forkEntryId: 'resp-new',
        completedAtMs: 1751931600000,
      });
      // One-shot: the marker is set and a later legacy-shaped row (mid-turn
      // streaming rows legitimately lack metadata) is not re-healed.
      expect(instance.ctx.storage.kv.get('uiMessagesTimeHealDone')).toBe(true);
    });
  });

  it('defers the time heal while a turn is in flight', async () => {
    const stub = await newChatThreadStub('thread-time-heal-gate');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-time-heal-gate' };
      instance.ensurePiCoreTables();
      await instance.persistMessages([
        {
          id: 'turn-live',
          role: 'assistant',
          parts: [{ type: 'text', text: 'partial', state: 'streaming' }],
        },
      ]);
      instance.ctx.storage.kv.put('piActiveTurn', {
        turnId: 'turn-live',
        openedAt: Date.now(),
      });
      const during = await instance.getUiMessages();
      const live = during.find((m: AnyRecord) => m.id === 'turn-live') as AnyRecord;
      // The in-flight row must NOT be stamped with an insert-time heal.
      expect(live.metadata).toBeUndefined();
      expect(
        instance.ctx.storage.kv.get('uiMessagesTimeHealDone'),
      ).toBeUndefined();
      instance.ctx.storage.kv.delete('piActiveTurn');
    });
  });

  it('post-turn compaction keeps pre-compaction visible history via archive hybrid', async () => {
    const stub = await newChatThreadStub('thread-compaction-mark');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-compaction-mark' };
      instance.ensurePiCoreTables();
      seedPiCoreRow(instance, 0, { role: 'user', content: 'old q', timestamp: 1000 });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'old a' }],
        timestamp: 1100,
        responseId: 'resp-old',
      });
      seedPiCoreRow(instance, 2, { role: 'user', content: 'new q', timestamp: 2000 });
      seedPiCoreRow(instance, 3, {
        role: 'assistant',
        content: [{ type: 'text', text: 'new a' }],
        timestamp: 2100,
        responseId: 'resp-new',
      });
      const before = await instance.getUiMessages();
      expect(before).toHaveLength(4);

      // Compaction rewrites pi_core to a summary + the kept tail. Preserve
      // materializes the prior derive into the ai-chat archive first; reads then
      // derive the tail and prepend archive-only rows (summary stays model-only).
      await instance['replacePiCoreMessages'](
        [
          {
            role: 'user',
            content: 'summary of earlier work',
            timestamp: 1000,
            metadata: { compactSummary: true },
          },
          { role: 'user', content: 'new q', timestamp: 2000 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'new a' }],
            timestamp: 2100,
            responseId: 'resp-new',
          },
        ],
        { uiRender: 'preserve' },
      );
      const preserved = await instance.getUiMessages();
      expect(preserved.map((m: AnyRecord) => m.id)).toEqual(
        before.map((m: AnyRecord) => m.id),
      );

      seedPiCoreRow(instance, 3, { role: 'user', content: 'later q', timestamp: 3000 });
      const after = await instance.getUiMessages();
      expect(after.map((m: AnyRecord) => m.id)).toEqual([
        ...before.map((m: AnyRecord) => m.id),
        'pi_user_3000_3',
      ]);
    });
  });

  it('admin repair rebuilds the render mirror from the rewritten pi_core', async () => {
    const stub = await newChatThreadStub('thread-repair-rebuild');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-repair-rebuild' };
      instance.ensurePiCoreTables();
      seedPiCoreRow(instance, 0, { role: 'user', content: 'q', timestamp: 1000 });
      // A dangling toolCall with no toolResult forces the repair to change history.
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-dangling', name: 'bash', arguments: {} },
        ],
        timestamp: 1100,
        responseId: 'resp-1',
      });
      await instance.getUiMessages();

      const report = await instance.repairPiCoreMessageHistory({ mode: 'repair' });
      expect(report.persisted).toBe(true);

      // The render mirror was rebuilt from the repaired pi_core (the mark is
      // consistent with it), not left pointing at pre-repair indexes.
      const parsed = await instance.getPiCoreParsedMessages('thread-repair-rebuild');
      const messages = await instance.getUiMessages();
      expect(messages.length).toBe(parsed.length);
    });
  });

  it('preserves backfilled rows when a later turn persists a new message (clobber guard)', async () => {
    const stub = await newChatThreadStub('thread-clobber');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-clobber' };
      instance.ensurePiCoreTables();
      seedPiCoreRow(instance, 0, {
        role: 'user',
        content: 'older question',
        timestamp: 500,
      });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'older answer' }],
        timestamp: 600,
        responseId: 'resp-old',
      });

      const derived = await instance.getUiMessages();
      expect(derived.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_500_0',
        'resp-old',
      ]);

      // Materialize the derive into the archive table, then persist a new live
      // row — older archive rows must remain (persist upserts, does not wipe).
      await instance.resyncUiMessagesFromPiCore();
      await instance.persistMessages([
        ...instance.messages,
        {
          id: 'new-assistant',
          role: 'assistant',
          parts: [{ type: 'text', text: 'brand new', state: 'done' }],
        },
      ]);

      const ids = (
        instance.ctx.storage.sql
          .exec('SELECT id FROM cf_ai_chat_agent_messages')
          .toArray() as Array<{ id: string }>
      ).map((row) => row.id);
      expect(ids).toContain('pi_user_500_0');
      expect(ids).toContain('resp-old');
      expect(ids).toContain('new-assistant');
      expect(ids).toHaveLength(3);
    });
  });
});

describe('ChatThreadDO chat-protocol frame guard', () => {
  const seedRenderRows = async (instance: any) => {
    instance.chatContext = { threadId: 'thread-guard' };
    instance.ensurePiCoreTables();
    await instance.persistMessages([
      {
        id: 'u1',
        role: 'user',
        parts: [{ type: 'text', text: 'hello', state: 'done' }],
      },
      {
        id: 'a1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'world', state: 'done' }],
      },
    ]);
  };

  const renderRowCount = (instance: any): number =>
    Number(
      (
        instance.ctx.storage.sql
          .exec('SELECT COUNT(*) AS c FROM cf_ai_chat_agent_messages')
          .toArray() as Array<{ c: number }>
      )[0]?.c ?? 0,
    );

  it.each([
    ['cf_agent_chat_clear', {}],
    ['cf_agent_chat_messages', { messages: [] }],
    [
      'cf_agent_use_chat_request',
      { id: 'req1', init: { method: 'POST', body: '{"messages":[]}' } },
    ],
    ['cf_agent_chat_request_cancel', { id: 'req1' }],
    [
      'cf_agent_tool_result',
      { toolCallId: 'tc1', toolName: 'bash', output: 'x' },
    ],
    ['cf_agent_tool_approval', { toolCallId: 'tc1', approved: true }],
  ])('drops %s frames from clients (history intact, no turn)', async (type, rest) => {
    const stub = await newChatThreadStub(`thread-guard-${type}`);
    await runInDurableObject(stub, async (instance: any) => {
      await seedRenderRows(instance);
      instance.recordChatThreadObservabilityEvent = vi.fn();
      const connection = { id: 'c1', send: vi.fn(), close: vi.fn() } as any;

      await instance.onMessage(connection, JSON.stringify({ type, ...rest }));

      // The frame was dropped before the framework handler ran: render history
      // is intact and no response frame was emitted.
      expect(renderRowCount(instance)).toBe(2);
      expect(connection.send).not.toHaveBeenCalled();
      expect(instance.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
        'chat_ws_frame_blocked',
        expect.objectContaining({ status: 'blocked', operation: type }),
      );
    });
  });

  it('passes non-protocol and unknown frames through to the framework chain', async () => {
    const stub = await newChatThreadStub('thread-guard-passthrough');
    await runInDurableObject(stub, async (instance: any) => {
      await seedRenderRows(instance);
      instance.recordChatThreadObservabilityEvent = vi.fn();
      const connection = {
        id: 'c1',
        send: vi.fn(),
        close: vi.fn(),
        serializeAttachment: vi.fn(),
        deserializeAttachment: vi.fn(() => null),
        setState: vi.fn(),
      } as any;

      // Unknown JSON type and non-JSON strings must not be blocked (and must
      // not throw) — rpc/state/resume frames ride this same pass-through.
      await instance.onMessage(connection, JSON.stringify({ type: 'bogus_type' }));
      await instance.onMessage(connection, 'not json');
      expect(
        instance.recordChatThreadObservabilityEvent,
      ).not.toHaveBeenCalledWith('chat_ws_frame_blocked', expect.anything());
      expect(renderRowCount(instance)).toBe(2);
    });
  });

  it('still answers a stream-resume request frame (reconnect handshake intact)', async () => {
    const stub = await newChatThreadStub('thread-guard-resume');
    await runInDurableObject(stub, async (instance: any) => {
      await seedRenderRows(instance);
      instance.recordChatThreadObservabilityEvent = vi.fn();
      const connection = {
        id: 'c1',
        send: vi.fn(),
        close: vi.fn(),
        serializeAttachment: vi.fn(),
        deserializeAttachment: vi.fn(() => null),
        setState: vi.fn(),
      } as any;

      await instance.onMessage(
        connection,
        JSON.stringify({ type: 'cf_agent_stream_resume_request' }),
      );

      // The handshake frame passed through the guard and got a framework reply
      // (with no live stream, a resume-none response).
      expect(
        instance.recordChatThreadObservabilityEvent,
      ).not.toHaveBeenCalledWith('chat_ws_frame_blocked', expect.anything());
      expect(connection.send).toHaveBeenCalled();
      const replies = connection.send.mock.calls.map((call: unknown[]) =>
        JSON.parse(call[0] as string),
      );
      expect(
        replies.some((frame: AnyRecord) =>
          String(frame.type ?? '').startsWith('cf_agent_stream_'),
        ),
      ).toBe(true);
    });
  });
});

describe('ChatThreadDO onConnect render-history delivery', () => {
  const makeConnectFake = (messages: AnyRecord[]) => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = null;
    fake.messages = messages;
    fake.piSession = null;
    fake.currentTodos = [];
    const background: Promise<unknown>[] = [];
    fake.ctx = {
      storage: { kv: { get: vi.fn(() => undefined), put: vi.fn() } },
      waitUntil: vi.fn((promise: Promise<unknown>) => background.push(promise)),
    };
    fake.sweepOrphanedActiveTurnMarker = vi.fn(async () => {});
    fake.scheduleTranscriptLakeSync = vi.fn();
    fake.getDerivedUiMessagePage = vi.fn(async () => ({
      messages: fake.messages,
      nextCursor: null,
      hasMore: false,
    }));
    fake.isThreadStreaming = vi.fn(() => false);
    fake.syncAgentState = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.maybeGenerateChatGroupAvatarForThread = vi.fn(async () => {});
    fake.background = background;
    return fake;
  };

  it('sends the current message list to a (re)connecting socket', async () => {
    // A headless turn (e.g. email ingress with zero sockets) persisted rows;
    // nothing else replays completed history to a (re)connecting client.
    const fake = makeConnectFake([
      { id: 'u1', role: 'user', parts: [{ type: 'text', text: 'q', state: 'done' }] },
      { id: 'a1', role: 'assistant', parts: [{ type: 'text', text: 'a', state: 'done' }] },
    ]);
    const connection = {
      id: 'c1',
      send: vi.fn(),
      close: vi.fn(),
      serializeAttachment: vi.fn(),
    } as any;

    await ChatThreadDO.prototype.onConnect.call(fake, connection, {
      request: new Request('https://do.test/ws'),
    } as any);

    expect(connection.close).not.toHaveBeenCalled();
    const frames = connection.send.mock.calls.map((call: unknown[]) =>
      JSON.parse(call[0] as string),
    );
    const historyFrame = frames.find(
      (frame: AnyRecord) => frame.type === 'cf_agent_chat_messages',
    );
    expect(historyFrame).toBeDefined();
    expect((historyFrame.messages as AnyRecord[]).map((m) => m.id)).toEqual([
      'u1',
      'a1',
    ]);
    await Promise.all(fake.background);
  });

  it('records background repair failures and still sends best-effort state/history', async () => {
    const fake = makeConnectFake([{ id: 'kept', role: 'user', parts: [] }]);
    fake.sweepOrphanedActiveTurnMarker = vi.fn(async () => {
      throw new Error('repair gate failed');
    });
    const connection = { send: vi.fn(), close: vi.fn(), serializeAttachment: vi.fn() } as any;

    await ChatThreadDO.prototype.onConnect.call(fake, connection, {
      request: new Request('https://do.test/ws'),
    } as any);
    await Promise.all(fake.background);

    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'chat_ws_connect_background_repair',
      expect.objectContaining({ status: 'failed', operation: 'reconcile_connected_client' }),
    );
    expect(fake.syncAgentState).toHaveBeenCalledTimes(2);
    expect(connection.send).toHaveBeenCalledTimes(2);
  });

  it('skips the frame when the render table is empty', async () => {
    const fake = makeConnectFake([]);
    const connection = {
      id: 'c1',
      send: vi.fn(),
      close: vi.fn(),
      serializeAttachment: vi.fn(),
    } as any;
    await ChatThreadDO.prototype.onConnect.call(fake, connection, {
      request: new Request('https://do.test/ws'),
    } as any);
    expect(connection.send).not.toHaveBeenCalled();
    await Promise.all(fake.background);
  });

  it('returns before repair gates resolve, then delivers derived history after sweep', async () => {
    let releaseRepair!: () => void;
    const repairGate = new Promise<void>((resolve) => { releaseRepair = resolve; });
    const fake = makeConnectFake([{ id: 'stale', role: 'user', parts: [] }]);
    fake.sweepOrphanedActiveTurnMarker = vi.fn(() => repairGate);
    fake.getDerivedUiMessagePage = vi.fn(async () => {
      fake.messages = [{ id: 'corrected', role: 'assistant', parts: [] }];
      return { messages: fake.messages, nextCursor: null, hasMore: false };
    });
    const connection = { send: vi.fn(), close: vi.fn(), serializeAttachment: vi.fn() } as any;

    const connected = ChatThreadDO.prototype.onConnect.call(fake, connection, {
      request: new Request('https://do.test/ws'),
    } as any);

    expect(fake.sweepOrphanedActiveTurnMarker).not.toHaveBeenCalled();
    expect(fake.getDerivedUiMessagePage).not.toHaveBeenCalled();
    expect(connection.send).toHaveBeenCalledTimes(1);
    await connected;
    releaseRepair();
    await Promise.all(fake.background);

    expect(fake.getDerivedUiMessagePage).toHaveBeenCalledTimes(1);
    expect(fake.syncAgentState).toHaveBeenCalledTimes(2);
    const corrected = JSON.parse(connection.send.mock.calls.at(-1)?.[0] as string);
    expect(corrected.messages.map((message: AnyRecord) => message.id)).toEqual(['corrected']);
  });
});

describe('ChatThreadDO double-send admission (queue-correct)', () => {
  const journalRows = (instance: any): Array<{ seq: number; payload: string }> =>
    instance.ctx.storage.sql
      .exec('SELECT seq, payload FROM pi_turn_journal ORDER BY seq ASC')
      .toArray() as Array<{ seq: number; payload: string }>;

  it('delivers BOTH rapid fresh sends: first prompted, second steered (REGRESSION)', async () => {
    const stub = await newChatThreadStub('thread-double-send');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-double-send' };
      instance.ensurePiCoreTables();
      instance.syncAgentState = vi.fn();
      instance.saveMessages = vi.fn(async () => ({ status: 'completed' }));
      const session = {
        state: { isStreaming: false, messages: [] as AnyRecord[] },
        prompt: vi.fn(async () => {
          session.state.isStreaming = true;
        }),
        steer: vi.fn(),
      };
      instance.piSession = session;

      // Two sends land back-to-back before prompt() flips isStreaming — both
      // take the fresh-admission path.
      const first = instance['sendRunnerCommand']({
        type: 'message',
        content: 'first message',
        rawContent: 'first message',
        timestamp: 1000,
      });
      const second = instance['sendRunnerCommand']({
        type: 'message',
        content: 'second message',
        rawContent: 'second message',
        timestamp: 1001,
      });
      expect(first).toBe(true);
      expect(second).toBe(true);

      // The journal durably holds BOTH accepted prompts (append, not replace).
      const rows = journalRows(instance);
      expect(rows).toHaveLength(2);
      expect(rows[0].payload).toContain('first message');
      expect(rows[1].payload).toContain('second message');

      // onChatMessage (driven by saveMessages in production) drains the queue.
      const response = (await instance.onChatMessage(() => {}, {})) as Response;
      await response.text();

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(session.prompt.mock.calls[0][0]).toMatchObject({
        content: 'first message',
      });
      expect(session.steer).toHaveBeenCalledTimes(1);
      expect(session.steer.mock.calls[0][0]).toMatchObject({
        content: 'second message',
      });
      // The steered message was steer-journaled for eviction redelivery.
      const steerJournal = instance.ctx.storage.kv.get('piSteerJournal') ?? [];
      expect(steerJournal).toHaveLength(1);
      expect(String(steerJournal[0])).toContain('second message');
      // The turn journal still holds both until turn end commits them.
      expect(journalRows(instance)).toHaveLength(2);
    });
  });

  it('leaves single-send behavior unchanged', async () => {
    const stub = await newChatThreadStub('thread-single-send');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-single-send' };
      instance.ensurePiCoreTables();
      instance.syncAgentState = vi.fn();
      instance.saveMessages = vi.fn(async () => ({ status: 'completed' }));
      const session = {
        state: { isStreaming: false, messages: [] as AnyRecord[] },
        prompt: vi.fn(async () => {
          session.state.isStreaming = true;
        }),
        steer: vi.fn(),
      };
      instance.piSession = session;

      expect(
        instance['sendRunnerCommand']({
          type: 'message',
          content: 'only message',
          rawContent: 'only message',
          timestamp: 1000,
        }),
      ).toBe(true);
      expect(journalRows(instance)).toHaveLength(1);

      const response = (await instance.onChatMessage(() => {}, {})) as Response;
      await response.text();

      expect(session.prompt).toHaveBeenCalledTimes(1);
      expect(session.prompt.mock.calls[0][0]).toMatchObject({
        content: 'only message',
      });
      expect(session.steer).not.toHaveBeenCalled();
      expect(instance.ctx.storage.kv.get('piSteerJournal')).toBeUndefined();
    });
  });

  it('stays inert (and keeps the queue) when no marker is set', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.pendingPiPromptQueue = [
      { userMessage: { role: 'user', content: 'queued' } },
    ];
    fake.readPiActiveTurn = vi.fn(() => null);
    const response = await ChatThreadDO.prototype['onChatMessage'].call(
      fake,
      () => {},
      {},
    );
    expect(response).toBeUndefined();
    expect(fake.pendingPiPromptQueue).toHaveLength(1);
  });
});

describe('ChatThreadDO recovery classification and partial reconciliation', () => {
  it('onChatRecovery declines the orphan-partial persist (persist: false)', async () => {
    const result = await ChatThreadDO.prototype['onChatRecovery'].call(
      Object.create(ChatThreadDO.prototype),
      {} as never,
    );
    expect(result).toEqual({ persist: false });
  });

  it('trims trailing incomplete parts from the live row before a resume continuation', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => {});
    fake.activePiStreamTurnId = 'turn-1';
    fake.piMainBaselineIndex = 0;
    const order: string[] = [];
    fake.piSession = {
      state: { messages: [{ role: 'user', content: 'q' }] },
      continue: vi.fn(async () => order.push('continue')),
    };
    fake.messages = [
      { id: 'u1', role: 'user', parts: [] },
      {
        id: 'turn-1',
        role: 'assistant',
        parts: [
          {
            type: 'tool-bash',
            toolCallId: 'tc1',
            state: 'output-available',
            input: {},
            output: { content: 'ok', isError: false },
          },
          { type: 'text', text: 'half of the ans', state: 'streaming' },
        ],
      },
    ];
    fake.persistMessages = vi.fn(async (messages: AnyRecord[]) => {
      order.push('persist');
      fake.messages = messages;
    });

    await ChatThreadDO.prototype['resumeActivePiTurn'].call(fake);

    // Settled tool work stays; the mid-stream text is dropped BEFORE continue()
    // regenerates the message, so the render row can't end up half+full.
    expect(order).toEqual(['persist', 'continue']);
    const live = fake.messages.find((m: AnyRecord) => m.id === 'turn-1');
    expect(live.parts).toHaveLength(1);
    expect(live.parts[0]).toMatchObject({ toolCallId: 'tc1' });
  });

  it('stamps committed fork ids on the live row when the resume owes no output', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => {});
    fake.activePiStreamTurnId = 'turn-1';
    fake.piMainBaselineIndex = 0;
    fake.piSession = {
      state: {
        messages: [
          { role: 'user', content: 'q', timestamp: 1 },
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'answer' }],
            timestamp: 2,
            responseId: 'resp-x',
          },
        ],
      },
    };
    fake.attachCodeModeArtifactsToToolResult = vi.fn(async (m: unknown) => m);
    fake.appendPiCoreMessagesIfMissing = vi.fn(async () => {});
    fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.completeTodoStateForTurnEnd = vi.fn(async () => {});
    fake.messages = [
      {
        id: 'turn-1',
        role: 'assistant',
        parts: [{ type: 'text', text: 'answer', state: 'done' }],
      },
    ];
    fake.persistMessages = vi.fn(async (messages: AnyRecord[]) => {
      fake.messages = messages;
    });

    await ChatThreadDO.prototype['resumeActivePiTurn'].call(fake);

    // The orphan-persisted partial already displays the committed content; its
    // stamped fork ids keep the top-up from converting the rows again.
    const live = fake.messages.find((m: AnyRecord) => m.id === 'turn-1');
    expect(live.metadata?.pi?.forkEntryIds).toEqual(['resp-x']);
    expect(fake.piSession.continue).toBeUndefined();
    expect(fake.finishTurn).toHaveBeenCalledWith(
      expect.objectContaining({ markUnread: true }),
    );
  });

  it('does NOT dispose the session when the reply stream completes normally', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const turnId = 'turn-clean';
    fake.chatContext = { threadId: 'thread-clean-finish' };
    fake.readPiActiveTurn = vi.fn(() => ({ turnId, openedAt: 1 }));
    fake.pendingPiPromptQueue = [
      { userMessage: { role: 'user', content: 'hi' } },
    ];
    fake.refreshPiSessionModel = vi.fn(async () => {});
    fake.recordPiTurnJournalSteerMessage = vi.fn();
    fake.piEventHandlerChain = Promise.resolve();
    fake.syncAgentState = vi.fn();
    fake.disposePiSession = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.piSession = {
      state: { isStreaming: false },
      prompt: vi.fn(async () => {
        for (const event of AGENT_TURN_EVENTS) {
          ChatThreadDO.prototype['writePiStreamChunks'].call(fake, event);
        }
      }),
      steer: vi.fn(),
    };

    const response = (await ChatThreadDO.prototype['onChatMessage'].call(
      fake,
      () => {},
      {},
    )) as Response;
    // Drain the stream to normal completion — the wrapper's cancel() hook (the
    // stall-watchdog path) must never fire on a clean finish.
    await readSseChunks(response);

    expect(fake.disposePiSession).not.toHaveBeenCalled();
    expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalledWith(
      'pi_turn_stream_stall_abort',
      expect.anything(),
    );
  });

  // The reply reader's cancel() fires on TWO paths: a real mid-turn stall/eviction
  // (turn still in flight, activePiStreamTurnId set) and ai-chat releasing the
  // reader after the terminal finish chunk (turn already settled, id cleared, but
  // the Pi session reused). The discriminator is activePiStreamTurnId, NOT
  // piSession — the reused session stays truthy after a clean finish.
  describe('onPiReplyStreamCancelled discriminates stall from post-finish close', () => {
    it('disposes and raises stall_abort when a turn is still in flight', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.chatContext = { threadId: 'thread-stall' };
      fake.activePiStreamTurnId = 'turn-in-flight';
      fake.piSession = { state: { isStreaming: true } };
      fake.disposePiSession = vi.fn();
      fake.recordChatThreadObservabilityEvent = vi.fn();

      ChatThreadDO.prototype['onPiReplyStreamCancelled'].call(fake);

      expect(fake.disposePiSession).toHaveBeenCalledTimes(1);
      expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
        'pi_turn_stream_stall_abort',
        expect.objectContaining({ status: 'aborted' }),
      );
    });

    it('does NOT dispose the reused session on a post-finish reader release', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.chatContext = { threadId: 'thread-finish-race' };
      // Turn settled: the execute finally cleared the id, but the Pi session is
      // reused for the next turn so it is still present (the case the old
      // `!piSession && !activePiStreamTurnId` guard got wrong).
      fake.activePiStreamTurnId = null;
      fake.piSession = { state: { isStreaming: false } };
      fake.disposePiSession = vi.fn();
      fake.recordChatThreadObservabilityEvent = vi.fn();

      ChatThreadDO.prototype['onPiReplyStreamCancelled'].call(fake);

      expect(fake.disposePiSession).not.toHaveBeenCalled();
      expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalledWith(
        'pi_turn_stream_stall_abort',
        expect.anything(),
      );
      expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
        'pi_turn_stream_closed',
        expect.objectContaining({ severity: 'debug' }),
      );
    });
  });
});

// ai-chat's chatStreamStallTimeoutMs watchdog counts REPLY-STREAM chunks (any
// bytes reaching the SSE reader reset it — verified against agents/chat
// iterateWithStallWatchdog), but a healthy long turn has legitimate wire
// silences: a tool executing with no output deltas, and runtime events the
// encoder maps to zero chunks. These tests pin the transient heartbeat that
// converts that genuine liveness into watchdog resets, so only a truly dead
// session trips the stall.
describe('ChatThreadDO stall-watchdog heartbeat', () => {
  function createHeartbeatFake() {
    const writes: AnyRecord[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread-heartbeat' };
    fake.activePiStreamTurnId = 'turn-hb';
    fake.agentEvalEventCollector = [];
    fake.piChunkEncoder = new PiChunkEncoder({ messageId: 'turn-hb' });
    fake.piStreamWriter = { write: (chunk: AnyRecord) => writes.push(chunk) };
    fake.piPreAttachChunkBuffer = null;
    fake.syncAgentState = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    return { fake, writes };
  }

  it('converts a zero-chunk runtime event into a transient heartbeat', () => {
    const { fake, writes } = createHeartbeatFake();
    ChatThreadDO.prototype['pushChatEvent'].call(
      fake,
      runtimeEvent('sdk/turn/started', {}),
    );
    expect(writes).toEqual([
      {
        type: 'data-pi-heartbeat',
        transient: true,
        data: { at: expect.any(Number) },
      },
    ]);
    // The eval collector still consumes the envelope unchanged.
    expect(fake.agentEvalEventCollector).toHaveLength(1);
  });

  it('does NOT add a heartbeat to an event that already produced chunks', () => {
    const { fake, writes } = createHeartbeatFake();
    ChatThreadDO.prototype['pushChatEvent'].call(
      fake,
      runtimeEvent('item/started', {
        item: { id: 'a1', type: 'agentMessage', text: '' },
      }),
    );
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((chunk) => chunk.type === 'data-pi-heartbeat')).toBe(
      false,
    );
  });

  it('never buffers a heartbeat while no writer is attached', () => {
    const { fake } = createHeartbeatFake();
    fake.piStreamWriter = null;
    ChatThreadDO.prototype['pushChatEvent'].call(
      fake,
      runtimeEvent('sdk/turn/started', {}),
    );
    // A heartbeat is liveness for the CURRENT stream only; buffering one for a
    // future stream could evict real chunks from the bounded pre-attach buffer.
    expect(fake.piPreAttachChunkBuffer).toBeNull();
  });

  it('swallows a heartbeat write racing stream close', () => {
    const { fake } = createHeartbeatFake();
    fake.piStreamWriter = {
      write: () => {
        throw new Error('Invalid state: stream closed');
      },
    };
    expect(() =>
      ChatThreadDO.prototype['writePiStreamHeartbeat'].call(fake),
    ).not.toThrow();
  });

  it('emits heartbeats while a harness tool executes silently, and stops when it settles', async () => {
    vi.useFakeTimers();
    try {
      const { fake, writes } = createHeartbeatFake();
      fake.piTurnLastProgressAtMs = 0;
      fake.piToolKeepAliveInterval = null;
      fake.piAgentStartedAtMs = Date.now();
      fake.piTurnStartedAtMs = Date.now();

      let resolveTool!: (value: string) => void;
      const running = ChatThreadDO.prototype[
        'keepPiTurnToolProgressAliveWhile'
      ].call(
        fake,
        () => new Promise<string>((resolve) => (resolveTool = resolve)),
      ) as Promise<string>;

      // Three 30s progress intervals with zero tool output: each one writes a
      // transient heartbeat so the watchdog never reads the silence as a hang.
      await vi.advanceTimersByTimeAsync(95_000);
      expect(
        writes.filter((chunk) => chunk.type === 'data-pi-heartbeat'),
      ).toHaveLength(3);

      resolveTool('done');
      await expect(running).resolves.toBe('done');

      // The keep-alive stops with the tool: a genuinely hung session (no events,
      // no running tool) emits nothing and the watchdog trips as designed.
      const settledCount = writes.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(writes).toHaveLength(settledCount);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails a hung harness tool as a throw (tool error) without disposing the session', async () => {
    vi.useFakeTimers();
    try {
      const { fake, writes } = createHeartbeatFake();
      fake.piToolKeepAliveInterval = null;
      fake.piAgentStartedAtMs = Date.now();
      fake.piTurnStartedAtMs = Date.now();
      fake.recordChatThreadObservabilityEvent = vi.fn();
      fake.disposePiSession = vi.fn();

      const running = ChatThreadDO.prototype[
        'keepPiTurnToolProgressAliveWhile'
      ].call(
        fake,
        // Never settles — without a ceiling keep-alive would pin the DO forever.
        () => new Promise<string>(() => {}),
      ) as Promise<string>;

      // Just under 20m: heartbeats still flow, tool still pending.
      await vi.advanceTimersByTimeAsync(19 * 60_000);
      expect(
        writes.filter((chunk) => chunk.type === 'data-pi-heartbeat').length,
      ).toBeGreaterThan(0);
      expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalledWith(
        'pi_turn_tool_hard_timeout',
        expect.anything(),
      );

      // Cross the 20m hard ceiling → reject so pi-agent-core records isError
      // tool result; the Pi session must stay alive so the turn can continue.
      const settled = expect(running).rejects.toMatchObject({
        name: 'PiTurnToolHardTimeoutError',
        message: expect.stringContaining('timed out after 20 minutes'),
      });
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;

      expect(fake.disposePiSession).not.toHaveBeenCalled();
      expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
        'pi_turn_tool_hard_timeout',
        expect.objectContaining({
          operation: 'tool_hard_timeout',
          status: 'timeout',
          severity: 'warn',
        }),
      );
      // Interval must not keep firing after the hard timeout.
      const after = writes.length;
      await vi.advanceTimersByTimeAsync(120_000);
      expect(writes).toHaveLength(after);
      expect(fake.piToolKeepAliveInterval).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});



describe('ChatThreadDO.abortTurnForAbsoluteTimeout', () => {
  it('surfaces a user-visible stop before going idle', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread-abs-timeout' };
    fake.piToolKeepAliveInterval = null;
    fake.piTurnAbsoluteTimeoutTimer = setInterval(() => {}, 60_000);
    fake.piUnsubscribe = null;
    fake.piModelResolver = null;
    fake.piSession = { state: { isStreaming: true }, abort: vi.fn() };
    fake.piMainBaselineIndex = 0;
    fake.piSessionPromise = null;
    fake.piEventHandlerChain = Promise.resolve();
    fake.piActiveItemId = null;
    fake.piAssistantText = '';
    fake.activePiStreamTurnId = 'turn-long';
    fake.pendingPiPromptQueue = [];
    fake.piStreamWriter = { write: vi.fn() };
    fake.lastError = null;
    fake.readPiActiveTurn = vi.fn(() => ({ turnId: 'turn-long', openedAt: 1 }));
    fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
    fake.setActiveTurnUserId = vi.fn();
    fake.finishTurn = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.pushChatEvent = vi.fn();
    fake.piProviderErrorEvent = vi.fn((message: string) => ({
      type: 'error',
      error: message,
    }));
    fake.updateActiveAutomationRun = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.stopStreamingLeaseHeartbeat = vi.fn();

    await ChatThreadDO.prototype['abortTurnForAbsoluteTimeout'].call(
      fake,
      60 * 60_000,
    );

    expect(fake.lastError).toEqual(
      expect.objectContaining({
        error: expect.stringContaining('60 minutes'),
        errorType: 'PiTurnAbsoluteTimeout',
      }),
    );
    expect(fake.pushChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'error',
        error: expect.stringContaining('60 minutes'),
      }),
    );
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    expect(fake.finishTurn).toHaveBeenCalledWith({ markUnread: true });
    expect(fake.piSession).toBeNull();
    expect(fake.activePiStreamTurnId).toBeNull();
    expect(fake.piTurnAbsoluteTimeoutTimer).toBeNull();
  });
});

describe('ChatThreadDO.forceClearHungTurn', () => {
  it('clears marker, session, and intervals', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread-force-clear' };
    fake.piToolKeepAliveInterval = setInterval(() => {}, 60_000);
    fake.piTurnAbsoluteTimeoutTimer = setInterval(() => {}, 60_000);
    fake.streamingLeaseRefreshTimer = null;
    fake.pendingStreamingActivity = null;
    fake.streamingActivityFlushTimer = null;
    fake.runningActivityLastText = null;
    fake.runningActivityLastSentAt = 0;
    fake.piUnsubscribe = null;
    fake.piModelResolver = null;
    fake.piSession = { state: { isStreaming: true }, abort: vi.fn() };
    fake.piMainBaselineIndex = 0;
    fake.piSessionPromise = null;
    fake.piEventHandlerChain = Promise.resolve();
    fake.piActiveItemId = null;
    fake.piAssistantText = '';
    fake.activePiStreamTurnId = 'turn-stuck';
    fake.pendingPiPromptQueue = [{ userMessage: {} }];
    fake.piStreamWriter = { write: vi.fn() };
    fake.piPendingTransientTurnRetry = { errorText: 'x' };
    fake.piTransientRetryBackoffAbort = { abort: vi.fn() };
    fake.readPiActiveTurn = vi.fn(() => ({ turnId: 'turn-stuck', openedAt: 1 }));
    fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
    fake.setActiveTurnUserId = vi.fn();
    fake.finishTurn = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const result = await ChatThreadDO.prototype.forceClearHungTurn.call(
      fake,
      'test_clear',
    );

    expect(result).toEqual({
      cleared: true,
      hadMarker: true,
      hadSession: true,
      reason: 'test_clear',
    });
    expect(fake.piSession).toBeNull();
    expect(fake.activePiStreamTurnId).toBeNull();
    expect(fake.pendingPiPromptQueue).toEqual([]);
    expect(fake.piToolKeepAliveInterval).toBeNull();
    expect(fake.piTurnAbsoluteTimeoutTimer).toBeNull();
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_turn_force_cleared',
      expect.objectContaining({ operation: 'force_clear_hung_turn' }),
    );
  });
});

// Page-open healing for a stranded active-turn marker: ai-chat recovery can give
// up SILENTLY (incident marked "skipped": conversation_changed /
// no_unanswered_user_message / continueLastTurn with no assistant) with no app
// callback, leaving the marker set in a warm isolate — onStart's wake-time sweep
// never re-runs, so isThreadStreaming() (and the workspace running row) would
// report the dead turn as busy forever. getUiMessages (the SSR loader, the first
// page-open touch) and onConnect now run the same guarded sweep.
describe('ChatThreadDO stranded-marker healing on page open', () => {
  it('sweeps a stranded marker on getUiMessages and lets the gated top-up run', async () => {
    const stub = await newChatThreadStub('thread-stranded-marker');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-stranded-marker' };
      instance.ensurePiCoreTables();
      seedPiCoreRow(instance, 0, { role: 'user', content: 'q', timestamp: 1000 });
      seedPiCoreRow(instance, 1, {
        role: 'assistant',
        content: [{ type: 'text', text: 'a' }],
        timestamp: 1100,
        responseId: 'resp-1',
      });
      // A dead turn: stale marker (older than the stall window), no live
      // session, no queued prompt, no ai-chat recovery incident/flag.
      instance.ctx.storage.kv.put('piActiveTurn', {
        turnId: 'turn-dead',
        openedAt: Date.now() - 11 * 60_000,
      });
      // setState needs the PartyServer name bootstrap the test harness skips.
      instance.syncAgentState = () => {};
      expect(instance.getRuntimeStatus().isStreaming).toBe(true);

      const messages = await instance.getUiMessages();

      expect(instance.ctx.storage.kv.get('piActiveTurn')).toBeUndefined();
      expect(instance.getRuntimeStatus().isStreaming).toBe(false);
      // With the marker swept the top-up is no longer gated: the dead turn's
      // committed pi_core rows convert into render history on this same load.
      expect(messages.map((m: AnyRecord) => m.id)).toEqual([
        'pi_user_1000_0',
        'resp-1',
      ]);
    });
  });

  it('leaves a live (fresh) marker alone on getUiMessages', async () => {
    const stub = await newChatThreadStub('thread-live-marker');
    await runInDurableObject(stub, async (instance: any) => {
      instance.chatContext = { threadId: 'thread-live-marker' };
      instance.ensurePiCoreTables();
      instance.ctx.storage.kv.put('piActiveTurn', {
        turnId: 'turn-live',
        openedAt: Date.now(),
      });
      instance.syncAgentState = () => {};

      await instance.getUiMessages();

      expect(instance.ctx.storage.kv.get('piActiveTurn')).toMatchObject({
        turnId: 'turn-live',
      });
      expect(instance.getRuntimeStatus().isStreaming).toBe(true);
    });
  });

  it('runs the sweep before the background busy-state correction', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { orgId: 'org1', threadId: 't1' };
    fake.captureChatContextFromRequest = vi.fn();
    fake.sweepOrphanedActiveTurnMarker = vi.fn(async () => {});
    fake.topUpUiMessagesFromPiCore = vi.fn(async () => {});
    fake.healLegacyUiMessageTimes = vi.fn(async () => {});
    fake.healLegacyUiMessageAuthors = vi.fn(async () => {});
    fake.messages = [];
    fake.isThreadStreaming = vi.fn(() => false);
    fake.currentTodos = [];
    fake.syncAgentState = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.maybeGenerateChatGroupAvatarForThread = vi.fn(async () => {});
    const background: Promise<unknown>[] = [];
    fake.ctx = { waitUntil: vi.fn((promise: Promise<unknown>) => background.push(promise)) };
    const connection = { send: vi.fn(), close: vi.fn() };
    const ctx = { request: new Request('https://do/ws?orgId=org1') };

    await ChatThreadDO.prototype.onConnect.call(
      fake,
      connection as never,
      ctx as never,
    );

    expect(connection.close).not.toHaveBeenCalled();
    await Promise.all(background);
    expect(fake.sweepOrphanedActiveTurnMarker).toHaveBeenCalledTimes(1);
    expect(fake.ctx.waitUntil).toHaveBeenCalledTimes(2);
    expect(fake.maybeGenerateChatGroupAvatarForThread).toHaveBeenCalledWith('t1');
    // The sweep ran before the stale-todo/agent-state derivation read the marker.
    expect(
      fake.sweepOrphanedActiveTurnMarker.mock.invocationCallOrder[0],
    ).toBeLessThan(fake.isThreadStreaming.mock.invocationCallOrder[0]);
  });
});
