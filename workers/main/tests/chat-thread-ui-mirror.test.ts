import type { UIMessage } from 'ai';
import { describe, expect, it, vi } from 'vitest';

import { ChatThreadUiMirror } from '../src/chat-thread/ui-mirror';
import type { AgentEvalParsedMessage } from '../src/chat-thread/types';

function uiUser(
  id: string,
  text: string,
  metadata: Record<string, unknown>,
): UIMessage {
  return {
    id,
    role: 'user',
    parts: [{ type: 'text', text, state: 'done' }],
    metadata,
  } as UIMessage;
}

function createHarness(options: {
  messages?: UIMessage[];
  piMessages?: AgentEvalParsedMessage[];
  activeTurn?: boolean;
  activeStream?: boolean;
  /** Ids the durable render table answers `SELECT 1 ... WHERE id = ?` for. */
  durableIds?: string[];
} = {}) {
  let messages = options.messages ?? [];
  let activeTurn = options.activeTurn ?? false;
  let activeStream = options.activeStream ?? false;
  const kvValues = new Map<string, unknown>();
  const persistRenderMessages = vi.fn(async (next: UIMessage[]) => {
    messages = next;
  });
  let piRevision = { generation: 1, count: options.piMessages?.length ?? 0 };
  const getPiCoreParsedMessages = vi.fn(async () => options.piMessages ?? []);
  // The bounded forward reader the top-up now uses. This stand-in serves the
  // whole fixture as ONE range (these fixtures are a handful of rows) and then
  // reports the walk finished, which is exactly what the real reader does when
  // a thread fits inside one budget.
  const readParsedPiCoreRowRange = vi.fn(
    ({ fromIdx }: { fromIdx: number }) => {
      const parsed = options.piMessages ?? [];
      const consumed = fromIdx > 0;
      return {
        parsed: consumed ? [] : parsed,
        parsedStartIndex: consumed ? parsed.length : 0,
        nextIdx: parsed.length,
        reachedEnd: true,
        rowsRead: consumed ? 0 : parsed.length,
        payloadChars: 0,
      };
    },
  );
  const recordChatThreadObservabilityEvent = vi.fn();
  const memoryPhases: string[] = [];
  const durableIds = new Set(options.durableIds ?? []);
  const mirror = new ChatThreadUiMirror({
    sql: () => ({
      exec: (_query: string, ...params: unknown[]) => ({
        toArray: () =>
          durableIds.has(String(params[0])) ? [{ present: 1 }] : [],
      }),
    }) as never,
    kv: () => ({
      get: <T,>(key: string) => kvValues.get(key) as T | undefined,
      put: (key: string, value: unknown) => {
        kvValues.set(key, value);
      },
      delete: (key: string) => {
        kvValues.delete(key);
      },
    }) as never,
    chatContext: () => ({
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      orgId: 'org-1',
      userId: 'user-1',
      userName: 'Illiana Reed',
      userEmail: 'illiana@example.com',
    }),
    getRenderMessages: () => messages,
    setRenderMessages: (next) => {
      messages = next;
    },
    persistRenderMessages,
    getRenderHistoryPage: () => ({
      messages,
      nextCursor: null,
      hasMore: false,
    }),
    clearPersistedRenderCache: vi.fn(),
    readPiActiveTurn: () =>
      activeTurn ? { turnId: 'turn-1', openedAt: 1 } : null,
    activePiStreamTurnId: () => (activeStream ? 'turn-1' : null),
    getPiCoreRevision: () => piRevision,
    getPiCoreParsedMessages,
    readParsedPiCoreRowRange,
    setRenderHistoryChronology: vi.fn(),
    reloadAiChatMessagesOrdered: vi.fn(),
    topUpUiMessagesFromPiCore: vi.fn(async () => {}),
    withMemoryPhase: async (operation, fn) => {
      memoryPhases.push(operation);
      return fn();
    },
    recordChatThreadObservabilityEvent,
  });

  return {
    mirror,
    kvValues,
    get messages() {
      return messages;
    },
    persistRenderMessages,
    getPiCoreParsedMessages,
    readParsedPiCoreRowRange,
    memoryPhases,
    recordChatThreadObservabilityEvent,
    setActiveTurn(value: boolean) {
      activeTurn = value;
    },
    setActiveStream(value: boolean) {
      activeStream = value;
    },
    setPiRevision(value: { generation: number; count: number }) {
      piRevision = value;
    },
  };
}

describe('ChatThreadUiMirror top-up preflight', () => {
  it('parses zero Pi payload rows on a settled no-op top-up', async () => {
    const harness = createHarness({
      piMessages: [{
        id: 'pi-user-1',
        thread_id: 'thread-1',
        role: 'user',
        content: 'hello',
        created_at: 1,
        forkEntryId: 'pi-user-1',
      }],
    });

    // Simulate the revision/count pinned by a prior successful mirror pass.
    harness.kvValues.set('uiMessagesPiCoreRevisionV1', '7:1');
    harness.setPiRevision({ generation: 7, count: 1 });

    await harness.mirror.topUpUiMessagesFromPiCore();

    expect(harness.getPiCoreParsedMessages).not.toHaveBeenCalled();
    expect(harness.persistRenderMessages).not.toHaveBeenCalled();
    expect(harness.memoryPhases).toEqual(['pi_topup_preflight']);
  });
});

describe('ChatThreadUiMirror author attribution', () => {
  it('stores normalized author/source metadata while preserving raw skeleton text', () => {
    const { mirror } = createHarness();
    const skeleton = mirror.buildUserUiSkeleton({
      rawContent: 'raw visible text',
      clientMessageId: ' client-1 ',
      authorDisplayName: '  Illiana Reed ',
      messageSource: ' slack ',
      piCoreMessageKey: 1234,
      sentDuringStreaming: true,
    });

    expect(skeleton).toEqual({
      id: 'client-1',
      role: 'user',
      parts: [{ type: 'text', text: 'raw visible text', state: 'done' }],
      metadata: {
        authorDisplayName: 'Illiana Reed',
        source: 'slack',
        piCoreMessageKey: '1234',
        sentDuringStreaming: true,
      },
    });
  });

  it('repairs linked raw UI rows once without changing ids, parts, or unknown metadata', async () => {
    const rawParts = [{ type: 'text', text: 'raw visible text', state: 'done' }] as UIMessage['parts'];
    const harness = createHarness({
      messages: [
        {
          id: 'user-1',
          role: 'user',
          parts: rawParts,
          metadata: {
            piCoreMessageKey: '1234',
            channelHistory: true,
            unknown: { preserved: true },
            pi: { createdAtMs: 1234 },
          },
        } as UIMessage,
        {
          id: 'assistant-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'answer', state: 'done' }],
        } as UIMessage,
      ],
      piMessages: [
        {
          id: 'pi-user-1',
          thread_id: 'thread-1',
          role: 'user',
          content: '[email message from Illiana Reed (illiana@example.com)]: model text',
          created_at: 1234,
          forkEntryId: '',
        },
      ],
    });

    await harness.mirror.healLegacyUiMessageAuthors();

    expect(harness.persistRenderMessages).toHaveBeenCalledTimes(1);
    const healed = harness.messages[0];
    expect(healed.id).toBe('user-1');
    expect(healed.parts).toBe(rawParts);
    expect(healed.parts).toEqual([
      { type: 'text', text: 'raw visible text', state: 'done' },
    ]);
    expect(healed.metadata).toEqual({
      piCoreMessageKey: '1234',
      channelHistory: true,
      unknown: { preserved: true },
      pi: { createdAtMs: 1234 },
      authorDisplayName: 'Illiana Reed',
      source: 'email',
    });
    expect(harness.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_ui_message_authors_healed',
      {
        operation: 'heal_legacy_ui_message_authors',
        status: 'healed',
        count: 1,
      },
    );
    expect(harness.kvValues.get('uiMessagesAuthorAttributionHealV1')).toBe(true);

    await harness.mirror.healLegacyUiMessageAuthors();
    expect(harness.getPiCoreParsedMessages).toHaveBeenCalledTimes(1);
    expect(harness.persistRenderMessages).toHaveBeenCalledTimes(1);
  });

  it('preserves independent source attribution without fabricating an author', async () => {
    const harness = createHarness({
      messages: [
        uiUser('source-only', 'raw body', { piCoreMessageKey: '10' }),
        uiUser('unmatched', 'other body', { piCoreMessageKey: '20' }),
      ],
      piMessages: [
        {
          id: 'pi-source-only',
          thread_id: 'thread-1',
          role: 'user',
          content: '[email message]: canonical body',
          created_at: 10,
          forkEntryId: '',
        },
      ],
    });

    await harness.mirror.healLegacyUiMessageAuthors();

    expect(harness.messages[0].metadata).toEqual({
      piCoreMessageKey: '10',
      source: 'email',
    });
    expect(
      (harness.messages[0].metadata as Record<string, unknown>)
        .authorDisplayName,
    ).toBeUndefined();
    expect(harness.messages[1].metadata).toEqual({ piCoreMessageKey: '20' });
    expect(harness.kvValues.get('uiMessagesAuthorAttributionHealV1')).toBe(true);
  });

  it('uses exact render ids to disambiguate colliding Pi timestamps', async () => {
    const harness = createHarness({
      messages: [
        uiUser('render-user-1', 'first raw body', { piCoreMessageKey: '10' }),
        uiUser('render-user-2', 'second raw body', { piCoreMessageKey: '10' }),
      ],
      piMessages: [
        {
          id: 'pi-user-1',
          thread_id: 'thread-1',
          role: 'user',
          content: '[web message from First User]: first canonical body',
          created_at: 10,
          forkEntryId: '',
          renderMessageId: 'render-user-1',
        },
        {
          id: 'pi-user-2',
          thread_id: 'thread-1',
          role: 'user',
          content: '[slack message from Second User]: second canonical body',
          created_at: 10,
          forkEntryId: '',
          renderMessageId: 'render-user-2',
        },
      ],
    });

    await harness.mirror.healLegacyUiMessageAuthors();

    expect(harness.messages[0].metadata).toEqual({
      piCoreMessageKey: '10',
      authorDisplayName: 'First User',
      source: 'web',
    });
    expect(harness.messages[1].metadata).toEqual({
      piCoreMessageKey: '10',
      authorDisplayName: 'Second User',
      source: 'slack',
    });
  });

  it('leaves timestamp collisions without render ids safely unstamped', async () => {
    const harness = createHarness({
      messages: [
        uiUser('ambiguous-user-1', 'first raw body', { piCoreMessageKey: '10' }),
        uiUser('ambiguous-user-2', 'second raw body', { piCoreMessageKey: '10' }),
      ],
      piMessages: [
        {
          id: 'pi-user-1',
          thread_id: 'thread-1',
          role: 'user',
          content: '[web message from First User]: first canonical body',
          created_at: 10,
          forkEntryId: '',
        },
        {
          id: 'pi-user-2',
          thread_id: 'thread-1',
          role: 'user',
          content: '[web message from Second User]: second canonical body',
          created_at: 10,
          forkEntryId: '',
        },
      ],
    });

    await harness.mirror.healLegacyUiMessageAuthors();

    expect(harness.persistRenderMessages).not.toHaveBeenCalled();
    expect(harness.messages[0].metadata).toEqual({ piCoreMessageKey: '10' });
    expect(harness.messages[1].metadata).toEqual({ piCoreMessageKey: '10' });
    expect(harness.kvValues.get('uiMessagesAuthorAttributionHealV1')).toBe(true);
  });

  it('defers without marking during an active turn and retries when idle', async () => {
    const harness = createHarness({
      activeTurn: true,
      messages: [uiUser('user-1', 'raw', { piCoreMessageKey: '1' })],
      piMessages: [
        {
          id: 'pi-user-1',
          thread_id: 'thread-1',
          role: 'user',
          content: '[web message from Illiana Reed]: canonical',
          created_at: 1,
          forkEntryId: '',
        },
      ],
    });

    await harness.mirror.healLegacyUiMessageAuthors();
    expect(harness.kvValues.has('uiMessagesAuthorAttributionHealV1')).toBe(false);
    expect(harness.getPiCoreParsedMessages).not.toHaveBeenCalled();

    harness.setActiveTurn(false);
    await harness.mirror.healLegacyUiMessageAuthors();
    expect(harness.messages[0].metadata).toMatchObject({
      authorDisplayName: 'Illiana Reed',
      source: 'web',
    });
    expect(harness.kvValues.get('uiMessagesAuthorAttributionHealV1')).toBe(true);
  });
});

describe('ChatThreadUiMirror salvage backfill', () => {
  function uiAssistant(id: string, text: string): UIMessage {
    return {
      id,
      role: 'assistant',
      parts: [{ type: 'text', text, state: 'done' }],
      metadata: {},
    } as UIMessage;
  }

  function piRow(
    row: Partial<AgentEvalParsedMessage> & { id: string; role: string },
  ): AgentEvalParsedMessage {
    return {
      thread_id: 'thread-1',
      content: '',
      created_at: 1,
      forkEntryId: '',
      ...row,
    } as AgentEvalParsedMessage;
  }

  const salvagedUser = piRow({
    id: 'pi-1',
    role: 'user',
    content: 'do the thing',
    created_at: 10,
  });
  const salvagedAssistant = piRow({
    id: 'pi-2',
    role: 'assistant',
    content: [{ type: 'text', text: 'half a sentence' }] as never,
    created_at: 11,
    forkEntryId: 'resp_partial',
  });
  const salvageNote = piRow({
    id: 'pi-3',
    role: 'assistant',
    content: [{ type: 'text', text: 'This turn was interrupted' }] as never,
    created_at: 12,
    forkEntryId: 'resp_note',
    renderMessageId: 'turn-1',
  });

  it('backfills unstamped salvaged work and leaves the stamped note alone', async () => {
    // The salvage rung's contract: the note (which DID stream into the turn-1 row)
    // is stamped and therefore skipped, while the work it kept — which never
    // streamed anywhere — converts exactly once and stays visible.
    const harness = createHarness({
      messages: [uiAssistant('turn-1', 'This turn was interrupted')],
      durableIds: ['turn-1'],
      piMessages: [salvagedUser, salvagedAssistant, salvageNote],
    });

    await harness.mirror.topUpUiMessagesFromPiCore({ force: true });

    const rendered = JSON.stringify(harness.messages);
    expect(rendered).toContain('do the thing');
    expect(rendered).toContain('half a sentence');
    // The note is not duplicated: its stamped row is covered by the live one.
    expect(
      harness.messages.filter((message) =>
        JSON.stringify(message.parts).includes('This turn was interrupted'),
      ),
    ).toHaveLength(1);
  });

  it('permanently skips a stamped group whose render row already exists', async () => {
    // The behaviour that makes the stamp a PROMISE rather than a hint, and why a
    // note-only row must never be stamped over work it does not display: the whole
    // group is dropped AND the high-water mark advances past it, so nothing
    // re-walks those rows on a later pass.
    const harness = createHarness({
      messages: [uiAssistant('turn-1', 'This turn was interrupted')],
      durableIds: ['turn-1'],
      piMessages: [
        salvagedUser,
        { ...salvagedAssistant, renderMessageId: 'turn-1' },
        salvageNote,
      ],
    });

    await harness.mirror.topUpUiMessagesFromPiCore({ force: true });

    expect(JSON.stringify(harness.messages)).not.toContain('half a sentence');
    expect(harness.kvValues.get('uiMessagesPiCoreHighWaterIdx')).toBe(3);
  });
});
