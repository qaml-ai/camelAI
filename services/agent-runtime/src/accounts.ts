import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { Storage } from "../shared/storage.ts";
import type { Tenants } from "./tenants.ts";

/**
 * Tenant state that tenants manage themselves: provider keys (encrypted at rest),
 * API tokens, usage, and tenants created by console sign-in. Admin-defined tenants
 * and their operator tokens stay in the Tenants file; both kinds live side by side.
 * Everything is in `Storage`, so any node can serve any tenant:
 *
 *   tenants/<tenant>/tenant             { id, github?, createdAt }   (console-created tenants)
 *   tenants/<tenant>/keys               provider → encrypted key
 *   tenants/<tenant>/tokens             API tokens (SHA-256 only)
 *   tokens/<sha256>                     token hash → tenant, for one-read authentication
 *   tenants/<tenant>/usage/<day>/<node> that node's usage totals per model for the day
 */
export interface Principal { tenant: string; via: "operator" | "token" | "console"; tokenId?: string }
export interface KeyStatus { provider: string; source: "tenant" | "admin"; last4?: string; setAt?: number }
export interface ApiToken { id: string; name: string; sha256: string; prefix: string; createdAt: number }
type StoredKey = { iv: string; tag: string; ciphertext: string; last4: string; setAt: number };
type Totals = { responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
/** A usage record in the single-host log that preceded per-node daily totals. */
interface LegacyUsageRecord extends Omit<Totals, "responses"> { at: number; agent: string; provider: string; model: string }

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validTenant = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);
const zero = (): Totals => ({ responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
const add = (target: Totals, source: Totals) => {
  target.responses += source.responses; target.input += source.input; target.output += source.output;
  target.cacheRead += source.cacheRead; target.cacheWrite += source.cacheWrite; target.cost += source.cost;
};
/** Revocations reach other nodes within this long. */
const TOKEN_CACHE_MS = 10_000;

export class Accounts {
  readonly tenants: Tenants;
  readonly storage: Storage;
  readonly node: string;
  private readonly secretsKey?: Buffer;
  private readonly tokenCache = new Map<string, { principal: Principal; until: number }>();
  /** Usage not yet written: tenant → "day model" → totals. */
  private pendingUsage = new Map<string, Map<string, Totals>>();
  private usageTimer?: ReturnType<typeof setTimeout>;

  constructor(options: { tenants: Tenants; storage: Storage; secretsKey?: string; node?: string }) {
    this.tenants = options.tenants;
    this.storage = options.storage;
    this.node = (options.node ?? "local").replace(/[^A-Za-z0-9_.-]/g, "_");
    if (options.secretsKey !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(options.secretsKey)) throw new Error("AGENT_SECRETS_KEY must be 64 hex characters (32 bytes)");
      this.secretsKey = Buffer.from(options.secretsKey, "hex");
    }
  }

  private key(tenant: string, name: string) {
    if (!validTenant(tenant)) throw new Error(`Invalid tenant id: ${tenant}`);
    return `tenants/${tenant}/${name}`;
  }
  private async read<T>(key: string): Promise<T | undefined> { return (await this.storage.readJson<T>(key))?.value; }

  /** Index tokens minted before the token index existed. Safe to repeat. */
  async init() {
    for (const key of await this.storage.listJson("tenants/")) {
      const match = /^tenants\/([a-z0-9-]+)\/tokens$/.exec(key);
      if (!match) continue;
      for (const token of await this.read<ApiToken[]>(key) ?? []) {
        if (!await this.storage.readJson(`tokens/${token.sha256}`)) await this.storage.writeJson(`tokens/${token.sha256}`, { tenant: match[1], id: token.id });
      }
    }
  }

  /** Admin-defined tenants and tenants created by console sign-in. */
  async exists(tenant: string) {
    return this.tenants.has(tenant) || (validTenant(tenant) && !!await this.storage.readJson(this.key(tenant, "tenant")));
  }

  /** Resolve a bearer operator token or tenant API token. */
  async authenticate(authorization: string | undefined): Promise<Principal | undefined> {
    const operator = this.tenants.authenticate(authorization);
    if (operator) return { tenant: operator.id, via: "operator" };
    if (!authorization?.startsWith("Bearer art_")) return undefined;
    const hash = sha256(authorization.slice(7));
    const cached = this.tokenCache.get(hash);
    if (cached && cached.until > Date.now()) return cached.principal;
    const entry = await this.read<{ tenant: string; id: string }>(`tokens/${hash}`);
    if (!entry || !await this.exists(entry.tenant)) return undefined;
    const principal: Principal = { tenant: entry.tenant, via: "token", tokenId: entry.id };
    this.tokenCache.set(hash, { principal, until: Date.now() + TOKEN_CACHE_MS });
    return principal;
  }

  /**
   * The tenant a GitHub user signs in as: an admin tenant linked to that login,
   * otherwise a tenant named after the login, created on first sign-in.
   */
  async tenantForGithub(login: string): Promise<string> {
    const linked = this.tenants.byGithub(login);
    if (linked) return linked;
    const id = login.toLowerCase();
    if (!validTenant(id)) throw new Error(`GitHub login ${login} cannot be used as a tenant id`);
    if (this.tenants.has(id)) throw new Error(`Tenant ${id} exists but is not linked to GitHub user ${login}; ask an admin to add "github": "${login}" to it`);
    const existing = await this.read<{ github?: string }>(this.key(id, "tenant"));
    if (existing && existing.github?.toLowerCase() !== login.toLowerCase()) throw new Error(`Tenant ${id} belongs to another account`);
    if (!existing) await this.storage.writeJson(this.key(id, "tenant"), { id, github: login, createdAt: Date.now() });
    return id;
  }

  // Provider keys -------------------------------------------------------------

  private async storedKeys(tenant: string) { return await this.read<Record<string, StoredKey>>(this.key(tenant, "keys")) ?? {}; }

  /** The key an agent uses: the tenant's own key, else one an admin configured. */
  async apiKey(tenant: string, provider: string): Promise<string | undefined> {
    const stored = this.secretsKey && validTenant(tenant) ? (await this.storedKeys(tenant))[provider] : undefined;
    if (stored) {
      const decipher = createDecipheriv("aes-256-gcm", this.secretsKey!, Buffer.from(stored.iv, "base64"));
      decipher.setAAD(Buffer.from(`${tenant}:${provider}`));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]).toString("utf8");
    }
    return this.tenants.apiKey(tenant, provider);
  }

  async keyStatus(tenant: string): Promise<KeyStatus[]> {
    const statuses = new Map<string, KeyStatus>();
    for (const provider of this.tenants.providers(tenant)) statuses.set(provider, { provider, source: "admin" });
    for (const [provider, key] of Object.entries(await this.storedKeys(tenant))) statuses.set(provider, { provider, source: "tenant", last4: key.last4, setAt: key.setAt });
    return [...statuses.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** Providers an agent of `tenant` can call (its own key, an admin key, or an admin `*` key). */
  async keyedProviders(tenant: string): Promise<(provider: string) => boolean> {
    const own = this.canStoreKeys && validTenant(tenant) ? new Set(Object.keys(await this.storedKeys(tenant))) : new Set<string>();
    return provider => own.has(provider) || !!this.tenants.apiKey(tenant, provider);
  }

  async hasKey(tenant: string, provider: string) { return (await this.keyedProviders(tenant))(provider); }

  get canStoreKeys() { return !!this.secretsKey; }

  async setKey(tenant: string, provider: string, key: string) {
    if (!this.secretsKey) throw new Error("This runtime has no AGENT_SECRETS_KEY, so it cannot store provider keys");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.secretsKey, iv);
    // Binding tenant and provider stops a stored ciphertext being replayed under another name.
    cipher.setAAD(Buffer.from(`${tenant}:${provider}`));
    const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
    const keys = await this.storedKeys(tenant);
    keys[provider] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"), last4: key.slice(-4), setAt: Date.now() };
    await this.storage.writeJson(this.key(tenant, "keys"), keys);
  }

  async deleteKey(tenant: string, provider: string) {
    const keys = await this.storedKeys(tenant);
    if (!keys[provider]) return false;
    delete keys[provider];
    await this.storage.writeJson(this.key(tenant, "keys"), keys);
    return true;
  }

  // API tokens ----------------------------------------------------------------

  private async tokens(tenant: string) { return await this.read<ApiToken[]>(this.key(tenant, "tokens")) ?? []; }

  async listTokens(tenant: string): Promise<Omit<ApiToken, "sha256">[]> {
    return (await this.tokens(tenant)).map(({ sha256: _hash, ...token }) => token);
  }

  /** Mint a token. The secret is returned once and only its hash is kept. */
  async createToken(tenant: string, name: string) {
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("Token name must contain 1–80 characters");
    const tokens = await this.tokens(tenant);
    if (tokens.length >= 50) throw new Error("A tenant can have at most 50 API tokens");
    const secret = `art_${randomBytes(32).toString("hex")}`;
    const token: ApiToken = { id: randomUUID(), name: name.trim(), sha256: sha256(secret), prefix: secret.slice(0, 8), createdAt: Date.now() };
    await this.storage.writeJson(`tokens/${token.sha256}`, { tenant, id: token.id });
    await this.storage.writeJson(this.key(tenant, "tokens"), [...tokens, token]);
    const { sha256: _hash, ...visible } = token;
    return { token: secret, ...visible };
  }

  async revokeToken(tenant: string, id: string) {
    const tokens = await this.tokens(tenant);
    const revoked = tokens.find(token => token.id === id);
    if (!revoked) return false;
    await this.storage.deleteJson(`tokens/${revoked.sha256}`);
    await this.storage.writeJson(this.key(tenant, "tokens"), tokens.filter(token => token.id !== id));
    this.tokenCache.delete(revoked.sha256);
    return true;
  }

  // Usage ---------------------------------------------------------------------

  /** Count a model response. Totals are written per node and day, a few seconds later. */
  recordUsage(tenant: string, _agent: string, message: { provider?: string; model?: string; usage: any; timestamp?: number }) {
    const usage = message.usage ?? {};
    const day = new Date(message.timestamp ?? Date.now()).toISOString().slice(0, 10);
    const model = `${message.provider ?? "unknown"}/${message.model ?? "unknown"}`;
    const byKey = this.pendingUsage.get(tenant) ?? new Map<string, Totals>();
    const totals = byKey.get(`${day} ${model}`) ?? zero();
    add(totals, { responses: 1, input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost?.total ?? 0 });
    byKey.set(`${day} ${model}`, totals);
    this.pendingUsage.set(tenant, byKey);
    this.usageTimer ??= setTimeout(() => void this.flushUsage().catch(error => console.error(JSON.stringify({ type: "usage_flush_failed", error: String(error) }))), 5_000);
    this.usageTimer.unref?.();
  }

  /** Merge pending usage into this node's daily documents (one writer per document). */
  async flushUsage() {
    if (this.usageTimer) { clearTimeout(this.usageTimer); this.usageTimer = undefined; }
    const pending = this.pendingUsage;
    this.pendingUsage = new Map();
    for (const [tenant, byKey] of pending) {
      const byDay = new Map<string, Map<string, Totals>>();
      for (const [key, totals] of byKey) {
        const [day, model] = [key.slice(0, 10), key.slice(11)];
        byDay.set(day, (byDay.get(day) ?? new Map()).set(model, totals));
      }
      for (const [day, models] of byDay) {
        const key = this.key(tenant, `usage/${day}/${this.node}`);
        const stored = await this.read<{ models: Record<string, Totals> }>(key) ?? { models: {} };
        for (const [model, totals] of models) add(stored.models[model] ??= zero(), totals);
        await this.storage.writeJson(key, stored);
      }
    }
  }

  /** Usage since `since`, summed per UTC day and model across every node. */
  async usage(tenant: string, since: number) {
    await this.flushUsage();
    const rows = new Map<string, { day: string; model: string } & Totals>();
    const totals = zero();
    const count = (day: string, model: string, value: Totals) => {
      const row = rows.get(`${day} ${model}`) ?? { day, model, ...zero() };
      add(row, value); add(totals, value);
      rows.set(`${day} ${model}`, row);
    };
    const firstDay = new Date(since).toISOString().slice(0, 10);
    for (const key of await this.storage.listJson(this.key(tenant, "usage/"))) {
      const day = key.split("/").at(-2)!;
      if (day < firstDay) continue;
      for (const [model, value] of Object.entries((await this.read<{ models: Record<string, Totals> }>(key))?.models ?? {})) count(day, model, value);
    }
    // Records from the single-host log that preceded per-node totals.
    if (await this.storage.hasLog(this.key(tenant, "usage"))) {
      for (const record of await this.storage.log<LegacyUsageRecord>(this.key(tenant, "usage")).read()) {
        if (record.at >= since) count(new Date(record.at).toISOString().slice(0, 10), `${record.provider}/${record.model}`, { responses: 1, input: record.input, output: record.output, cacheRead: record.cacheRead, cacheWrite: record.cacheWrite, cost: record.cost });
      }
    }
    return { since, totals, days: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)) };
  }
}
