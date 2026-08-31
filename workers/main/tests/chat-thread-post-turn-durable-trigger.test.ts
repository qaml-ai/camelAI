/**
 * STAGE 2e (BOUNDED-MEMORY-BY-CONSTRUCTION): the post-turn durable cut must be
 * triggered by the TRANSCRIPT, not only by provider-reported usage.
 *
 * The bug this suite pins is a masking loop the worker builds itself:
 *
 *   1. `transformPiProviderContext` compacts the context of every provider
 *      request once it crosses the threshold, so the request the provider bills
 *      is the SHRUNK one.
 *   2. Usage therefore comes back comfortable, and
 *      `shouldCompactPiAfterAssistantUsage` — the only thing that used to gate
 *      the post-turn DURABLE cut — never fires.
 *   3. The mid-turn cut itself keeps the newest ~20k tokens, which on a real
 *      turn lands above `piMainBaselineIndex`, i.e. in the tail that maps to no
 *      committed `pi_core_messages.idx`. So it can only be memoized, never
 *      persisted.
 *
 * Every turn the thread grows; nothing durable ever records a cut. 607 turns
 * later the visible window is 29.4 MB with zero compaction rows, which is the
 * production thread stage 1c exists to make conversable again. 2e is the
 * prevention at the source, and `masking scenario, end to end` below drives all
 * three steps against a real Durable Object rather than asserting them apart.
 */

import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';

import { ChatThreadDO } from '../src/chat-thread-do';
import {
  createPiSummaryMessage,
  piTranscriptCompactionTrigger,
  shouldCompactPiAfterAssistantUsage,
  PI_CONTEXT_MAX_WORKING_SET_BYTES,
} from '../src/chat-thread/pi-compaction';
import {
  PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
  PI_SESSION_LOAD_MAX_CHARS,
} from '../src/chat-thread/pi-core-store';
import { buildWhaleThreadFixture } from './helpers/whale-thread-fixture';

/** 200k window, 20k reserve => the ephemeral path compacts at 180_000 tokens. */
const MODEL = {
  id: 'test-model',
  contextWindow: 200_000,
  maxTokens: 8_000,
} as any;

const TOKEN_THRESHOLD = 180_000;

/** Roughly `tokens` worth of prose, at the estimator's 4 chars/token rule. */
const prose = (tokens: number): string => 'word turn body '.repeat(Math.ceil(tokens / 4));

/**
 * A completed turn whose provider usage is COMFORTABLE — the whole point: this
 * is what the provider reports after the per-request path shrank the context.
 */
const comfortableAssistant = (timestamp = 2) => ({
  role: 'assistant',
  content: [{ type: 'text', text: 'done' }],
  stopReason: 'stop',
  usage: { input: 24_000, output: 400, cacheRead: 0, cacheWrite: 0, totalTokens: 24_400 },
  timestamp,
}) as any;

describe('piTranscriptCompactionTrigger', () => {
  it('stays quiet for a transcript inside both budgets', () => {
    const messages = [
      { role: 'user', content: prose(1_000), timestamp: 1 },
      comfortableAssistant(),
    ] as any;

    expect(piTranscriptCompactionTrigger(messages, MODEL)).toBeNull();
    expect(piTranscriptCompactionTrigger([], MODEL)).toBeNull();
  });

  it('fires on estimated tokens at the same threshold the per-request path uses', () => {
    const under = [{ role: 'user', content: prose(120_000), timestamp: 1 }] as any;
    const over = [{ role: 'user', content: prose(220_000), timestamp: 1 }] as any;

    expect(piTranscriptCompactionTrigger(under, MODEL)).toBeNull();
    const trigger = piTranscriptCompactionTrigger(over, MODEL);
    expect(trigger?.reason).toBe('tokens');
    expect(trigger?.thresholdTokens).toBe(TOKEN_THRESHOLD);
    expect(trigger!.tokens).toBeGreaterThanOrEqual(TOKEN_THRESHOLD);
  });

  it('fires on bytes for an image transcript that is token-cheap', () => {
    // Images are charged PI_IMAGE_CONTEXT_TOKENS flat (what a provider bills for
    // pixel area), so a screenshot thread sits far under any token threshold
    // while holding tens of megabytes resident. That asymmetry is exactly what a
    // token-only trigger cannot see.
    const bigWindowModel = { id: 'wide', contextWindow: 1_000_000, maxTokens: 8_000 } as any;
    const base64 = 'A'.repeat(600_000);
    const messages = Array.from({ length: 30 }, (_unused, index) => ({
      role: 'toolResult',
      toolCallId: `call-${index}`,
      toolName: 'take_screenshot',
      content: [
        { type: 'text', text: 'screenshot' },
        { type: 'image', mimeType: 'image/png', data: base64 },
      ],
      timestamp: index,
    })) as any;

    const trigger = piTranscriptCompactionTrigger(messages, bigWindowModel);
    expect(trigger?.reason).toBe('bytes');
    expect(trigger!.bytes).toBeGreaterThanOrEqual(PI_CONTEXT_MAX_WORKING_SET_BYTES);
    // ... and it is genuinely token-cheap, or this test proves nothing.
    expect(trigger!.tokens).toBeLessThan(trigger!.thresholdTokens);
  });

  /**
   * The dimension the other two cannot express. Both of them measure the
   * in-memory ESTIMATE; whether the next cold load is CAPPED is decided by
   * stored chars, and the units are not comparable — an inline image is bigger
   * in its stored row than in the estimate. So a thread can sit under 16 MB
   * estimated and over 12 MB stored, which is precisely the population the byte
   * ceiling was written for.
   */
  describe('stored-char dimension', () => {
    const bigWindowModel = { id: 'wide', contextWindow: 1_000_000, maxTokens: 8_000 } as any;
    /** ~7 MB estimated: under BOTH in-memory ceilings, over the stored one. */
    const inlineImageThread = () => {
      const base64 = 'A'.repeat(500_000);
      return Array.from({ length: 14 }, (_unused, index) => ({
        role: 'toolResult',
        toolCallId: `call-${index}`,
        toolName: 'take_screenshot',
        content: [
          { type: 'text', text: 'screenshot' },
          { type: 'image', mimeType: 'image/png', data: base64 },
        ],
        timestamp: index,
      })) as any;
    };

    it('fires on stored chars for a thread both estimate dimensions call small', () => {
      const messages = inlineImageThread();
      // Neither in-memory dimension can see this thread...
      expect(piTranscriptCompactionTrigger(messages, bigWindowModel)).toBeNull();

      // ...but its stored rows are already three quarters of the load cap.
      const trigger = piTranscriptCompactionTrigger(messages, bigWindowModel, {
        storedCharCeiling: PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
        storedChars: () => PI_DURABLE_CUT_MAX_VISIBLE_CHARS + 1,
      });
      expect(trigger?.reason).toBe('stored_chars');
      expect(trigger!.storedChars).toBe(PI_DURABLE_CUT_MAX_VISIBLE_CHARS + 1);
      expect(trigger!.tokens).toBeLessThan(trigger!.thresholdTokens);
      expect(trigger!.bytes).toBeLessThan(trigger!.byteCeiling);
      // Below the ceiling it stays quiet rather than cutting a thread that is
      // nowhere near being capped.
      expect(
        piTranscriptCompactionTrigger(messages, bigWindowModel, {
          storedCharCeiling: PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
          storedChars: () => PI_DURABLE_CUT_MAX_VISIBLE_CHARS - 1,
        }),
      ).toBeNull();
    });

    it('fires BEFORE the load cap, in the load cap own units', () => {
      // The whole point of the third dimension: the durable cut must land while
      // the window is still loadable, not after stage 1c has already capped it.
      expect(PI_DURABLE_CUT_MAX_VISIBLE_CHARS).toBeLessThan(PI_SESSION_LOAD_MAX_CHARS);
      const trigger = piTranscriptCompactionTrigger(inlineImageThread(), bigWindowModel, {
        storedCharCeiling: PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
        storedChars: () => PI_SESSION_LOAD_MAX_CHARS - 1,
      });
      expect(trigger?.reason).toBe('stored_chars');
    });

    it('does not pay for the probe on an ordinary thread', () => {
      // The probe is a SQL aggregate over the visible window and it runs at the
      // end of every turn. An ordinary thread must never touch storage for it.
      const probe = vi.fn(() => PI_DURABLE_CUT_MAX_VISIBLE_CHARS * 10);
      const ordinary = [
        { role: 'user', content: prose(2_000), timestamp: 1 },
        comfortableAssistant(),
      ] as any;

      expect(
        piTranscriptCompactionTrigger(ordinary, MODEL, {
          storedCharCeiling: PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
          storedChars: probe,
        }),
      ).toBeNull();
      expect(probe).not.toHaveBeenCalled();
    });

    it('treats an unreadable probe as unmeasured, never as small', () => {
      const trigger = piTranscriptCompactionTrigger(inlineImageThread(), bigWindowModel, {
        storedCharCeiling: PI_DURABLE_CUT_MAX_VISIBLE_CHARS,
        storedChars: () => null,
      });
      expect(trigger).toBeNull();
    });
  });
});

/**
 * THE ARGUMENT SHAPE THESE TESTS INSIST ON.
 *
 * `agent_end` hands its listener the run DELTA — pi-agent-core seeds
 * `newMessages` with the prompts and pushes only what THIS run produced — while
 * the accumulated conversation lives in `session.state.messages`. Every case
 * below therefore passes a small delta and puts the oversized list on the
 * session, which is the only shape production ever produces. Handing the full
 * materialized list to `maybeSchedulePiPostTurnCompaction` would make the
 * transcript trigger pass while measuring a question — "was this ONE TURN
 * huge?" — that answers no on every ordinary turn of a 29 MB thread.
 */
const turnDelta = (assistant: any) =>
  [{ role: 'user', content: 'and then?', timestamp: 1 }, assistant] as any;

describe('post-turn compaction scheduling', () => {
  function scheduleFake(sessionMessages: any[] = []) {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { waitUntil: vi.fn() };
    fake.piSession = { state: { model: MODEL, messages: sessionMessages } };
    fake.piCurrentUsageProvider = 'openai';
    fake.activeTurnUserId = 'user-1';
    fake.chatContext = { threadId: 'thread-1' };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.compactPiContextAfterTurn = vi.fn(async () => undefined);
    return fake;
  }

  it('schedules a durable cut for an oversized transcript whose usage stayed low', () => {
    const assistant = comfortableAssistant();
    // The SESSION is oversized; the turn that just ended is unremarkable.
    const transcript = [
      { role: 'user', content: prose(300_000), timestamp: 1 },
      assistant,
    ] as any;
    const fake = scheduleFake(transcript);
    const delta = turnDelta(assistant);

    // The gate that used to be the only one says no — this turn looks fine.
    expect(shouldCompactPiAfterAssistantUsage(assistant, MODEL)).toBe(false);
    // And so does the transcript gate, if you ask it about the delta.
    expect(piTranscriptCompactionTrigger(delta, MODEL)).toBeNull();

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(fake, delta);

    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(assistant, 'user-1');
    expect(fake.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_post_turn_compaction_transcript',
      expect.objectContaining({
        operation: 'compact_context_after_turn',
        status: 'tokens',
      }),
    );
  });

  it('leaves the usage trigger exactly as it was', () => {
    const fake = scheduleFake();
    // A provider overflow on a SHORT transcript: our own estimate says the
    // context is tiny (and the observed-usage floor reports nothing), so the
    // transcript trigger cannot be what fires here — only usage can. This is
    // precisely why the usage trigger is kept: a provider window smaller than
    // the estimate believed is invisible to the transcript.
    const exhausted = {
      role: 'assistant',
      content: [{ type: 'text', text: '' }],
      stopReason: 'error',
      errorMessage: 'Your input exceeds the context window of this model',
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
      timestamp: 2,
    } as any;
    const messages = [{ role: 'user', content: 'hi', timestamp: 1 }, exhausted] as any;
    fake.piSession.state.messages = messages;

    expect(piTranscriptCompactionTrigger(messages, MODEL)).toBeNull();
    expect(shouldCompactPiAfterAssistantUsage(exhausted, MODEL)).toBe(true);

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(fake, messages);

    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(exhausted, 'user-1');
    // A usage-triggered cut is not the masked case and must not claim to be.
    expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalledWith(
      'pi_post_turn_compaction_transcript',
      expect.anything(),
    );
  });

  it('schedules nothing for an ordinary turn on an ordinary thread', () => {
    const assistant = comfortableAssistant();
    const fake = scheduleFake([
      { role: 'user', content: prose(2_000), timestamp: 1 },
      assistant,
    ] as any);

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(
      fake,
      turnDelta(assistant),
    );

    expect(fake.compactPiContextAfterTurn).not.toHaveBeenCalled();
    expect(fake.ctx.waitUntil).not.toHaveBeenCalled();
    expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalled();
  });

  /**
   * SINGLE FLIGHT. The transcript reason is LEVEL-shaped: it stays true on every
   * turn until a cut actually lands, and landing one costs O(transcript/window)
   * sequential provider completions, each of them METERED to the user. So a turn
   * that starts and finishes while a pass is summarizing must not buy a second
   * summarization of the same transcript.
   */
  describe('single flight', () => {
    function gatedFake(sessionMessages: any[]) {
      const fake = scheduleFake(sessionMessages);
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const passes: Array<{ trigger: any; userId: string | null }> = [];
      fake.compactPiContextAfterTurn = vi.fn(async (trigger: any, userId: string | null) => {
        passes.push({ trigger, userId });
        await gate;
      });
      return { fake, passes, release: () => release() };
    }

    const oversized = () => {
      const assistant = comfortableAssistant();
      return {
        assistant,
        transcript: [
          { role: 'user', content: prose(300_000), timestamp: 1 },
          assistant,
        ] as any,
      };
    };

    it('runs one pass for turns that land while a pass is summarizing', async () => {
      const { assistant, transcript } = oversized();
      const { fake, passes, release } = gatedFake(transcript);
      const schedule = () =>
        ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(
          fake,
          turnDelta(assistant),
        );

      schedule();
      schedule();
      schedule();

      // One pass, one scheduled promise — not three concurrent summarizations
      // billed three times to the same user.
      expect(passes).toHaveLength(1);
      expect(fake.ctx.waitUntil).toHaveBeenCalledTimes(1);
      // And the suppressed turns were not silently dropped from telemetry as if
      // the thread had never crossed the threshold: the decision event belongs
      // to the pass that actually runs.
      expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledTimes(1);

      release();
      await fake.ctx.waitUntil.mock.calls[0][0];

      // COALESCED, not dropped: the turns that landed during the pass were not
      // covered by it, and the transcript is still over the line, so exactly one
      // follow-up runs.
      expect(passes).toHaveLength(2);
      expect(fake.ctx.waitUntil).toHaveBeenCalledTimes(2);
      await fake.ctx.waitUntil.mock.calls[1][0];
      expect(passes).toHaveLength(2);
    });

    it('stands the follow-up down when the pass already cut the transcript', async () => {
      const { assistant, transcript } = oversized();
      const { fake, passes, release } = gatedFake(transcript);

      ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(
        fake,
        turnDelta(assistant),
      );
      ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(
        fake,
        turnDelta(assistant),
      );
      expect(passes).toHaveLength(1);

      // What a successful pass does: summary + tail.
      fake.piSession.state.messages = [
        createPiSummaryMessage('post-turn summary', 5),
        assistant,
      ];
      release();
      await fake.ctx.waitUntil.mock.calls[0][0];

      expect(passes).toHaveLength(1);
      expect(fake.ctx.waitUntil).toHaveBeenCalledTimes(1);
    });

    it('releases the flight after a pass throws', async () => {
      const { assistant, transcript } = oversized();
      const fake = scheduleFake(transcript);
      fake.compactPiContextAfterTurn = vi.fn(async () => {
        throw new Error('summarizer exploded');
      });

      ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(
        fake,
        turnDelta(assistant),
      );
      await fake.ctx.waitUntil.mock.calls[0][0];

      ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(
        fake,
        turnDelta(assistant),
      );
      expect(fake.compactPiContextAfterTurn).toHaveBeenCalledTimes(2);
    });
  });
});

describe('compactPiContextAfterTurn re-checks', () => {
  function afterTurnFake(messages: any[]) {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const compacted = [
      createPiSummaryMessage('post-turn summary', 5),
      { role: 'user', content: 'kept tail', timestamp: 6 },
    ];
    const session = {
      state: { messages, model: MODEL, isStreaming: false },
      waitForIdle: vi.fn(async () => undefined),
    };
    fake.piSession = session;
    fake.piModelResolver = vi.fn(async () => ({ model: MODEL, apiKey: 'k' }));
    fake.loadPiCompleteSimple = vi.fn(async () => vi.fn());
    fake.chatContext = null;
    fake.piSessionLoadWindow = { firstRowIdx: 0, summaryOffset: 0, capped: false };
    fake.compactPiContext = vi.fn(async () => compacted);
    fake.replacePiCoreMessages = vi.fn(async () => ({ status: 'rewritten' }));
    fake.clearPiCoreCompaction = vi.fn();
    fake.loadPiCoreCompaction = vi.fn(() => null);
    fake.recordChatThreadObservabilityEvent = vi.fn();
    return { fake, session, compacted };
  }

  it('runs the cut on the transcript reason alone', async () => {
    const { fake, session, compacted } = afterTurnFake([
      { role: 'user', content: prose(300_000), timestamp: 1 },
      comfortableAssistant(),
    ]);

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(
      fake,
      session.state.messages[1],
    );

    expect(fake.compactPiContext).toHaveBeenCalled();
    // Forced, so the cut is not re-gated on the threshold it already crossed.
    expect(fake.compactPiContext.mock.calls[0][5]).toEqual(
      expect.objectContaining({ force: true }),
    );
    expect(session.state.messages).toBe(compacted);
    expect(fake.replacePiCoreMessages).toHaveBeenCalledWith(compacted, {
      uiRender: 'preserve',
    });
  });

  it('abandons the cut when the list shrank while it waited', async () => {
    // Another pass landed (or the session was rebuilt) between `agent_end` and
    // this running. The reason is re-derived from the CURRENT list, so a
    // transcript that no longer needs a cut does not get one.
    const { fake, session } = afterTurnFake([
      { role: 'user', content: prose(300_000), timestamp: 1 },
      comfortableAssistant(),
    ]);
    const trigger = session.state.messages[1];
    const shortened = [createPiSummaryMessage('already compacted', 4), trigger];
    session.waitForIdle = vi.fn(async () => {
      session.state.messages = shortened as any;
    });

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(fake, trigger);

    expect(fake.compactPiContext).not.toHaveBeenCalled();
    expect(session.state.messages).toBe(shortened);
  });
});

/**
 * THE PRODUCTION CALL SITE, driven rather than simulated.
 *
 * Everything above hands `maybeSchedulePiPostTurnCompaction` its argument by
 * hand. This drives the shipped `agent_end` listener, so the argument is the one
 * pi-agent-core really produces — the run delta — and the transcript has to be
 * found where it really lives.
 */
describe('agent_end listener', () => {
  function agentEndFake(sessionMessages: any[]) {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread-1',
      workspaceId: 'workspace-1',
      orgId: 'org-1',
      userId: 'user-1',
    };
    fake.ctx = {
      waitUntil: vi.fn(),
      storage: {
        kv: { get: vi.fn(() => undefined), put: vi.fn(), delete: vi.fn() },
        sql: { exec: vi.fn(() => ({ toArray: () => [] })) },
      },
    };
    fake.piSession = {
      state: { messages: sessionMessages, model: MODEL, isStreaming: false },
      waitForIdle: vi.fn(async () => undefined),
    };
    fake.piUserStopRequestedAtMs = 0;
    fake.piAssistantText = 'done';
    fake.activeTurnUserId = 'user-1';
    fake.piCurrentUsageProvider = 'openai';
    fake.piMainBaselineIndex = sessionMessages.length;
    fake.piAgentStartedAtMs = Date.now() - 1_000;
    fake.piTurnStartedAtMs = Date.now() - 1_000;
    fake.piSdkTurnIndex = 0;
    fake.piSdkTurnUsageTotal = null;
    fake.compactPiContextAfterTurn = vi.fn(async () => undefined);
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.pushChatEvent = vi.fn();
    fake.pushPiRuntimeEvent = vi.fn();
    fake.discardUnpersistedPiSessionMessages = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.completeTodoStateForTurnEnd = vi.fn();
    fake.resetRunningActivityState = vi.fn();
    fake.clearPiActiveTurnAndJournal = vi.fn(async () => undefined);
    return fake;
  }

  /** What `agent_end` carries: this run's own messages, nothing older. */
  const runDelta = (assistant: any) => [
    { role: 'user', content: 'and then?', timestamp: 2 },
    assistant,
  ] as any;

  it('finds the transcript on the session, not in the run delta it is handed', async () => {
    const assistant = comfortableAssistant();
    const transcript = [
      { role: 'user', content: prose(300_000), timestamp: 1 },
      assistant,
    ] as any;
    const fake = agentEndFake(transcript);
    const delta = runDelta(assistant);
    // The delta is a handful of messages however big the thread behind it is —
    // measuring the trigger on it can only ever answer "this turn was small".
    expect(piTranscriptCompactionTrigger(delta, MODEL)).toBeNull();
    expect(shouldCompactPiAfterAssistantUsage(assistant, MODEL)).toBe(false);

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: delta,
    });

    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(assistant, 'user-1');
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_post_turn_compaction_transcript',
      expect.objectContaining({ status: 'tokens' }),
    );
  });

  it('still schedules nothing when the session transcript is small', async () => {
    const assistant = comfortableAssistant();
    const fake = agentEndFake([
      { role: 'user', content: prose(2_000), timestamp: 1 },
      assistant,
    ] as any);

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: runDelta(assistant),
    });

    expect(fake.compactPiContextAfterTurn).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// End to end, against a real Durable Object with a real SQLite transcript.
// ---------------------------------------------------------------------------

const threadStub = (threadId: string) => {
  const namespace = (env as any).CHAT_THREAD;
  return namespace.get(namespace.idFromName(threadId));
};

/** A summarizer that never calls a provider. */
const stubCompleteSimple = (async () => ({
  content: [{ type: 'text', text: 'durable summary of the omitted work' }],
})) as any;

/**
 * The post-turn cut resolves its summarizer through the DO's own
 * `loadPiCompleteSimple` seam, so the SUCCESS path can be exercised without
 * `vi.mock`-ing `@earendil-works/pi-ai/compat`. Mocking that module is not an
 * option: it is hoisted above every import for the whole file, pi-agent-core
 * imports `EventStream`, `streamSimple` and `validateToolArguments` from it (so
 * no turn could run), and an `importOriginal` factory cannot resolve inside a
 * Durable Object, where the lazy import actually happens.
 */
const stubPostTurnSummarizer = (instance: any): void => {
  instance.loadPiCompleteSimple = async () => stubCompleteSimple;
};

describe('masking scenario, end to end', () => {
  it('acquires a durable cut within one turn while provider usage stays low', async () => {
    const thread = 'post-turn-durable-trigger-masking';
    await runInDurableObject(threadStub(thread), async (instance: any) => {
      stubPostTurnSummarizer(instance);
      instance.chatContext = {
        threadId: thread,
        workspaceId: 'workspace-1',
        orgId: 'org-1',
        userId: 'user-1',
        userName: 'User One',
        userEmail: 'user-1@example.com',
      };

      // A thread that is comfortably UNDER the stage-1c load cap (12 MB) — 2e's
      // job is the earlier prevention, long before a thread is big enough to be
      // loaded capped. Nothing bounds it: no compaction row, no watermark.
      const fixture = buildWhaleThreadFixture(instance, {
        rows: 600,
        totalChars: 4_000_000,
        images: 0,
      });
      expect(fixture.totalChars).toBeLessThan(12_000_000);

      const loaded = await instance.loadBoundedPiCoreSessionWindow();
      expect(loaded.window.capped).toBe(false);
      expect(instance.loadPiCoreCompaction()).toBeNull();

      // ---- step 1+3: the per-request cut, and why it cannot be persisted.
      // `piMainBaselineIndex` is where this turn started; everything above it is
      // the turn's own uncommitted tail. The cut keeps the newest ~20k tokens,
      // so it lands inside that tail and `recordCut` may only memoize it.
      instance.piSessionLoadWindow = {
        firstRowIdx: loaded.window.firstRowIdx,
        summaryOffset: loaded.window.summaryOffset,
        capped: loaded.window.capped,
      };
      instance.piMainBaselineIndex = Math.floor(loaded.messages.length / 2);
      const requestView = await instance.transformPiProviderContext(
        loaded.messages,
        MODEL,
        'api-key',
        stubCompleteSimple,
      );

      expect(requestView.length).toBeLessThan(loaded.messages.length);
      expect(instance.piEphemeralCompaction).not.toBeNull();
      // THE MASK, asserted rather than assumed: the provider saw a small request
      // and storage learned nothing durable from it.
      expect(instance.loadPiCoreCompaction()).toBeNull();

      // ---- step 2: the turn completes with comfortable usage.
      const assistant = comfortableAssistant(Date.now());
      const sessionMessages = [...loaded.messages, assistant];
      expect(shouldCompactPiAfterAssistantUsage(assistant, MODEL)).toBe(false);

      instance.piSession = {
        state: { messages: sessionMessages, model: MODEL, isStreaming: false },
        waitForIdle: async () => undefined,
      };
      instance.piModelResolver = async () => ({ model: MODEL, apiKey: 'api-key' });
      // Idle session: everything the turn produced is committed, which is the
      // one moment a cut has a `pi_core_messages.idx` to name.
      instance.piMainBaselineIndex = sessionMessages.length;

      // ---- 2e: agent_end schedules the durable cut anyway.
      //
      // Scheduled with what `agent_end` actually reports: the run DELTA. Pi
      // builds that array inside the run loop from the prompts plus what this
      // run produced, so it is a handful of messages no matter how big the
      // thread behind it is. Handing the full session list here instead would
      // make this test pass against a gate that measures the wrong thing.
      const turnDelta = [
        { role: 'user', content: 'and then?', timestamp: Date.now() - 1 },
        assistant,
      ] as any;
      expect(piTranscriptCompactionTrigger(turnDelta, MODEL)).toBeNull();

      const scheduled: Promise<unknown>[] = [];
      Object.defineProperty(instance.ctx, 'waitUntil', {
        value: (promise: Promise<unknown>) => { scheduled.push(promise); },
        configurable: true,
        writable: true,
      });
      try {
        instance.maybeSchedulePiPostTurnCompaction(turnDelta);
        expect(scheduled).toHaveLength(1);
        await Promise.all(scheduled);
      } finally {
        delete instance.ctx.waitUntil;
      }

      // The session's own list is now summary + tail — a REAL summary, i.e. the
      // summarizer ran and succeeded rather than falling back.
      const head = instance.piSession.state.messages[0] as { content?: string };
      expect(head.content).toContain('[Context Summary]');
      expect(head.content).toContain('durable summary of the omitted work');
      expect(head.content).not.toContain('Automatic fallback summary');
      expect(instance.piSession.state.messages.length).toBeLessThan(
        sessionMessages.length / 4,
      );
      // It did not FIGHT the per-request memo, it retired it: the durable cut
      // replaces the ephemeral one rather than racing it on the next request.
      expect(instance.piEphemeralCompaction).toBeNull();
      // ...and so is the thread: pi_core was rewritten behind the cut, so the
      // NEXT load is bounded by storage rather than by a cap.
      const reloaded = await instance.loadBoundedPiCoreSessionWindow();
      expect(reloaded.window.capped).toBe(false);
      expect(reloaded.window.totalChars).toBeLessThan(fixture.totalChars / 4);
      expect(reloaded.messages.length).toBeLessThan(loaded.messages.length / 4);

      // And the history is not gone — it was archived into the render mirror
      // before the rewrite (the preserve path), which is the only reason the
      // rewrite is allowed to delete rows at all.
      const archived = instance.ctx.storage.sql
        .exec('SELECT COUNT(*) AS count FROM cf_ai_chat_agent_messages')
        .toArray()[0] as { count: number };
      expect(Number(archived.count)).toBeGreaterThan(0);
    });
  }, 300_000);
});
