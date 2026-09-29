import { DurableObject } from 'cloudflare:workers';

interface HandleOwnerRecord {
  workspaceId: string;
  claimedAt: number;
}

interface ClaimResult {
  ok: boolean;
  owner: string | null;
}

/**
 * Durable Object keyed by email handle for race-safe handle ownership.
 * Each instance stores exactly one owner record.
 */
export class EmailHandleDO extends DurableObject {
  getOwner(): string | null {
    const record = this.ctx.storage.kv.get<HandleOwnerRecord>('owner');
    return record?.workspaceId ?? null;
  }

  claim(workspaceId: string): ClaimResult {
    if (!workspaceId) {
      throw new Error('workspaceId is required');
    }

    const existing = this.ctx.storage.kv.get<HandleOwnerRecord>('owner');
    if (existing && existing.workspaceId !== workspaceId) {
      return { ok: false, owner: existing.workspaceId };
    }

    if (!existing) {
      this.ctx.storage.kv.put('owner', {
        workspaceId,
        claimedAt: Date.now(),
      } satisfies HandleOwnerRecord);
    }

    return { ok: true, owner: workspaceId };
  }

  release(workspaceId: string): boolean {
    if (!workspaceId) {
      throw new Error('workspaceId is required');
    }

    const existing = this.ctx.storage.kv.get<HandleOwnerRecord>('owner');
    if (!existing || existing.workspaceId !== workspaceId) {
      return false;
    }

    this.ctx.storage.kv.delete('owner');
    return true;
  }
}
