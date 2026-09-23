import { describe, expect, it } from 'vitest';
import { PiTurnJournal, type SyncKvStorage } from '../src/chat-thread/pi-turn-journal';

function fixture() {
  const entries = new Map<string, unknown>();
  const kv: SyncKvStorage = {
    get: <T>(key: string) => entries.get(key) as T | undefined,
    put: (key, value) => { entries.set(key, value); },
    delete: (key) => entries.delete(key),
  };
  return { entries, marker: new PiTurnJournal({ kv: () => kv }) };
}

describe('application active turn marker', () => {
  it('keeps the same UI identity across adapter recreation', () => {
    const { entries, marker } = fixture();
    marker.openActiveTurnIfAbsent();
    const first = marker.readActiveTurn();
    marker.openActiveTurnIfAbsent();
    expect(marker.readActiveTurn()).toEqual(first);
    expect(first?.turnId).toEqual(expect.any(String));
    expect(first?.openedAt).toBeGreaterThan(0);
    expect(entries.size).toBe(1);
  });

  it('discards legacy retry counters and clears pending steering without replay', async () => {
    const { entries, marker } = fixture();
    entries.set('piActiveTurn', {
      turnId: 'existing', openedAt: 42, resumeAttempts: 15,
      isolateDeathResumeAttempts: 3, benignInterruption: true,
    });
    entries.set('piSteerJournal', ['legacy message']);
    expect(marker.readActiveTurn()).toEqual({ turnId: 'existing', openedAt: 42 });
    await marker.clearActiveTurnAndJournal();
    expect(marker.readActiveTurn()).toBeNull();
    expect(entries.has('piSteerJournal')).toBe(false);
    marker.openActiveTurnIfAbsent();
    expect(marker.readActiveTurn()?.turnId).not.toBe('existing');
  });
});
