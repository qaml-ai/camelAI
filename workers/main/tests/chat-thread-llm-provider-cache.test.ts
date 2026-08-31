import { describe, expect, it, vi } from 'vitest';
import { ChatThreadDO } from '../src/chat-thread-do';

const ORG_ID = 'org1';

type ProviderRecord = ReturnType<
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  import('../src/identity/org-do').OrgDO['getLlmProviderConfig']
>;

function makeRecord(provider: string): NonNullable<ProviderRecord> {
  return {
    provider,
    credentials_encrypted: 'enc',
    config: '{}',
    created_by: 'admin',
    created_at: 1,
    updated_at: 2,
  };
}

/**
 * Builds a ChatThreadDO prototype-fake wired with a counting getLlmProviderConfig
 * stub and a retryChatDurableObjectRpc that simply invokes its fn (no real
 * retry/backoff), so tests can assert RPC counts deterministically.
 */
function createFake(getConfig: () => ProviderRecord | Promise<ProviderRecord>) {
  const calls = { getLlmProviderConfig: 0 };
  const orgStub = {
    getLlmProviderConfig: vi.fn(async () => {
      calls.getLlmProviderConfig += 1;
      return getConfig();
    }),
  };
  const fake = Object.create(ChatThreadDO.prototype) as any;
  fake.cachedLlmProviderConfig = null;
  fake.env = {
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
  };
  fake.retryChatDurableObjectRpc = vi.fn(
    (_operation: string, fn: () => Promise<unknown>) => fn(),
  );
  fake.recordChatThreadObservabilityEvent = vi.fn();
  const callCached = (orgId = ORG_ID): Promise<ProviderRecord> =>
    ChatThreadDO.prototype['getCachedLlmProviderConfig'].call(fake, orgId);
  return { fake, orgStub, calls, callCached };
}

describe('ChatThreadDO.getCachedLlmProviderConfig (turn-scoped)', () => {
  it('reads once and serves repeated calls within the turn without a second RPC', async () => {
    const record = makeRecord('anthropic');
    const { calls, callCached } = createFake(() => record);

    const first = await callCached();
    const second = await callCached();
    const third = await callCached();

    expect(first).toBe(record);
    expect(second).toBe(record);
    expect(third).toBe(record);
    expect(calls.getLlmProviderConfig).toBe(1);
  });

  it('caches null config and does not bypass the cache', async () => {
    const { calls, callCached } = createFake(() => null);

    expect(await callCached()).toBeNull();
    expect(await callCached()).toBeNull();
    expect(calls.getLlmProviderConfig).toBe(1);
  });

  it('re-reads on the next turn after agent_start clears the cache', async () => {
    const recordA = makeRecord('anthropic');
    const recordB = makeRecord('openai');
    let current: ProviderRecord = recordA;
    const { fake, calls, callCached } = createFake(() => current);

    expect(await callCached()).toBe(recordA);
    expect(await callCached()).toBe(recordA);
    expect(calls.getLlmProviderConfig).toBe(1);

    // Provider changes between turns; the next agent_start drops the cache.
    current = recordB;
    fake.cachedLlmProviderConfig = null; // what agent_start does

    expect(await callCached()).toBe(recordB);
    expect(calls.getLlmProviderConfig).toBe(2);
  });

  it('is cleared by byokChanged so mid-turn admin changes apply on the next LLM call', async () => {
    const recordA = makeRecord('anthropic');
    const recordB = makeRecord('openai');
    let current: ProviderRecord = recordA;
    const { fake, calls, callCached } = createFake(() => current);
    fake.withRunnerTransitionLock = vi.fn(async (_op: string, fn: () => void) => fn());
    fake.disposePiSession = vi.fn();

    expect(await callCached()).toBe(recordA);
    expect(calls.getLlmProviderConfig).toBe(1);

    current = recordB;
    await ChatThreadDO.prototype['byokChanged'].call(fake);

    expect(await callCached()).toBe(recordB);
    expect(calls.getLlmProviderConfig).toBe(2);
  });

  it('propagates RPC errors when there is no cached value', async () => {
    const { callCached } = createFake(() => {
      throw new Error('Network connection lost.');
    });

    await expect(callCached()).rejects.toThrow('Network connection lost.');
  });

  it("does not serve another org's cached config", async () => {
    const record = makeRecord('anthropic');
    const { calls, callCached } = createFake(() => record);

    await callCached('org1');
    expect(calls.getLlmProviderConfig).toBe(1);

    // Different org id forces a fresh read despite a cache entry.
    await callCached('org2');
    expect(calls.getLlmProviderConfig).toBe(2);
  });
});
