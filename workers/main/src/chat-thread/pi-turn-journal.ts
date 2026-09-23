// The application keeps only a UI turn identity. Model history and run status
// belong to the agent service; this marker never authorizes a model retry.
const PI_ACTIVE_TURN_KEY = "piActiveTurn";

export interface PiActiveTurnMarker {
  turnId: string;
  openedAt: number;
}

/** The synchronous KV surface of a SQLite-backed DO (`ctx.storage.kv`). */
export interface SyncKvStorage {
  get<T = unknown>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): unknown;
}

export interface PiTurnJournalDeps {
  kv(): SyncKvStorage;
}

export class PiTurnJournal {
  constructor(private readonly deps: PiTurnJournalDeps) {}

  readActiveTurn(): PiActiveTurnMarker | null {
    const marker = this.deps.kv().get<PiActiveTurnMarker>(PI_ACTIVE_TURN_KEY);
    // Old markers may contain recovery counters. Never carry those forward.
    return marker ? { turnId: marker.turnId, openedAt: marker.openedAt } : null;
  }

  openActiveTurnIfAbsent(): void {
    if (this.readActiveTurn()) return;
    this.writeActiveTurn({ turnId: crypto.randomUUID(), openedAt: Date.now() });
  }

  writeActiveTurn(marker: PiActiveTurnMarker): void {
    this.deps.kv().put(PI_ACTIVE_TURN_KEY, {
      turnId: marker.turnId,
      openedAt: marker.openedAt,
    });
  }

  async clearActiveTurnAndJournal(): Promise<void> {
    this.deps.kv().delete(PI_ACTIVE_TURN_KEY);
    // Remove legacy pending steering data without replaying it.
    this.deps.kv().delete("piSteerJournal");
  }
}
