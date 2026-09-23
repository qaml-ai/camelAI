import { PreconditionFailed, type Storage } from "./storage.ts";

/**
 * Ownership of an agent: exactly one runtime node serves it at a time. The epoch
 * increases on every change of owner, so a node that lost its lease can tell.
 * Owners renew well before expiry and stop serving (fence themselves) as soon as
 * a renewal fails; others take over only after expiry plus a clock-skew margin.
 */
export interface Lease { agent: string; owner: string; epoch: number; expiresAt: number }
export type Acquired = { lease: Lease } | { heldBy: Lease };

export interface LeaseStore {
  /** Take or extend ownership. Returns the current holder if another live owner has it. */
  acquire(agent: string, owner: string, ttlMs: number): Promise<Acquired>;
  /** Extend a lease this owner holds; undefined means it was lost. */
  renew(lease: Lease, ttlMs: number): Promise<Lease | undefined>;
  /** Give up ownership so another node can take the agent immediately. */
  release(lease: Lease): Promise<void>;
  /** The current lease and whether it is live (unexpired). */
  get(agent: string): Promise<(Lease & { live: boolean }) | undefined>;
}

/** Tolerated difference between node clocks for leases that compare wall-clock times. */
export const CLOCK_SKEW_MS = 2_000;

/** Leases as conditional-write documents, `leases/<agent>`. Works on any Storage (S3, files, memory). */
export function storageLeases(storage: Storage, now = () => Date.now()): LeaseStore {
  const key = (agent: string) => `leases/${agent}`;
  const live = (lease: Lease) => lease.expiresAt + CLOCK_SKEW_MS > now();
  return {
    async acquire(agent, owner, ttlMs) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const current = await storage.readJson<Lease>(key(agent));
        if (current && current.value.owner !== owner && live(current.value)) return { heldBy: current.value };
        const kept = current && current.value.owner === owner && live(current.value);
        const lease: Lease = { agent, owner, epoch: kept ? current.value.epoch : (current?.value.epoch ?? 0) + 1, expiresAt: now() + ttlMs };
        try {
          await storage.writeJson(key(agent), lease, current?.version ?? null);
          return { lease };
        } catch (error) { if (!(error instanceof PreconditionFailed)) throw error; }
      }
      const holder = await storage.readJson<Lease>(key(agent));
      if (holder) return { heldBy: holder.value };
      throw new Error(`Could not acquire lease for ${agent}`);
    },
    async renew(lease, ttlMs) {
      const current = await storage.readJson<Lease>(key(lease.agent));
      if (!current || current.value.owner !== lease.owner || current.value.epoch !== lease.epoch) return undefined;
      const renewed = { ...lease, expiresAt: now() + ttlMs };
      try { await storage.writeJson(key(lease.agent), renewed, current.version); return renewed; }
      catch (error) { if (error instanceof PreconditionFailed) return undefined; throw error; }
    },
    async release(lease) {
      const current = await storage.readJson<Lease>(key(lease.agent));
      if (!current || current.value.owner !== lease.owner || current.value.epoch !== lease.epoch) return;
      // Expire rather than delete, so the next owner's epoch still increases.
      try { await storage.writeJson(key(lease.agent), { ...lease, expiresAt: 0 }, current.version); }
      catch (error) { if (!(error instanceof PreconditionFailed)) throw error; }
    },
    async get(agent) {
      const current = await storage.readJson<Lease>(key(agent));
      return current && { ...current.value, live: current.value.expiresAt > 0 && live(current.value) };
    },
  };
}

/** The subset of `pg.Pool` the Postgres lease store uses. */
export interface SqlPool { query(text: string, values?: unknown[]): Promise<{ rows: any[] }> }

/**
 * Leases in Postgres. Every comparison uses the database's clock, so node clock
 * skew does not matter; each operation is a single atomic statement.
 */
export async function postgresLeases(pool: SqlPool, table = "agent_leases"): Promise<LeaseStore> {
  if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error("Invalid lease table name");
  await pool.query(`create table if not exists ${table} (
    agent text primary key, owner text not null, epoch bigint not null, expires_at timestamptz not null)`);
  const row = (value: any): Lease => ({ agent: value.agent, owner: value.owner, epoch: Number(value.epoch), expiresAt: new Date(value.expires_at).getTime() });
  return {
    async acquire(agent, owner, ttlMs) {
      const { rows } = await pool.query(`
        insert into ${table} as current (agent, owner, epoch, expires_at) values ($1, $2, 1, now() + $3 * interval '1 millisecond')
        on conflict (agent) do update set
          owner = excluded.owner,
          epoch = case when current.owner = excluded.owner and current.expires_at > now() then current.epoch else current.epoch + 1 end,
          expires_at = excluded.expires_at
        where current.owner = excluded.owner or current.expires_at <= now()
        returning agent, owner, epoch, expires_at`, [agent, owner, ttlMs]);
      if (rows[0]) return { lease: row(rows[0]) };
      const holder = await pool.query(`select agent, owner, epoch, expires_at from ${table} where agent = $1`, [agent]);
      return { heldBy: row(holder.rows[0]) };
    },
    async renew(lease, ttlMs) {
      const { rows } = await pool.query(`
        update ${table} set expires_at = now() + $4 * interval '1 millisecond'
        where agent = $1 and owner = $2 and epoch = $3 and expires_at > now()
        returning agent, owner, epoch, expires_at`, [lease.agent, lease.owner, lease.epoch, ttlMs]);
      return rows[0] ? row(rows[0]) : undefined;
    },
    async release(lease) {
      await pool.query(`update ${table} set expires_at = now() where agent = $1 and owner = $2 and epoch = $3`, [lease.agent, lease.owner, lease.epoch]);
    },
    async get(agent) {
      const { rows } = await pool.query(`select agent, owner, epoch, expires_at, expires_at > now() as live from ${table} where agent = $1`, [agent]);
      return rows[0] && { ...row(rows[0]), live: rows[0].live };
    },
  };
}
