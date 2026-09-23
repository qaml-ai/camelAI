import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeDurableJson } from "../shared/durable-json.ts";
import type { Tenants } from "./tenants.ts";

/**
 * Tenant state that tenants manage themselves: provider keys (encrypted at rest),
 * API tokens, usage, and tenants created by console sign-in. Admin-defined tenants
 * and their operator tokens stay in the Tenants file; both kinds live side by side.
 *
 *   <root>/<tenant>/tenant.json   { id, github?, createdAt }   (console-created tenants)
 *   <root>/<tenant>/keys.json     provider → encrypted key
 *   <root>/<tenant>/tokens.json   API tokens (SHA-256 only)
 *   <root>/<tenant>/usage.jsonl   one line per model response
 */
export interface Principal { tenant: string; via: "operator" | "token" | "console"; tokenId?: string }
export interface KeyStatus { provider: string; source: "tenant" | "admin"; last4?: string; setAt?: number }
export interface ApiToken { id: string; name: string; sha256: string; prefix: string; createdAt: number }
type StoredKey = { iv: string; tag: string; ciphertext: string; last4: string; setAt: number };
export interface UsageRecord {
  at: number; agent: string; provider: string; model: string;
  input: number; output: number; cacheRead: number; cacheWrite: number; cost: number;
}

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validTenant = (id: string) => /^[a-z0-9][a-z0-9-]{0,39}$/.test(id);

export class Accounts {
  readonly tenants: Tenants;
  readonly root: string;
  private readonly secretsKey?: Buffer;
  private readonly tokenIndex = new Map<string, { tenant: string; id: string }>();

  constructor(options: { tenants: Tenants; root: string; secretsKey?: string }) {
    this.tenants = options.tenants;
    this.root = options.root;
    if (options.secretsKey !== undefined) {
      if (!/^[a-f0-9]{64}$/.test(options.secretsKey)) throw new Error("AGENT_SECRETS_KEY must be 64 hex characters (32 bytes)");
      this.secretsKey = Buffer.from(options.secretsKey, "hex");
    }
    if (existsSync(this.root)) for (const tenant of readdirSync(this.root)) {
      for (const token of this.readJsonSync<ApiToken[]>(join(this.root, tenant, "tokens.json")) ?? []) this.tokenIndex.set(token.sha256, { tenant, id: token.id });
    }
  }

  private dir(tenant: string) {
    if (!validTenant(tenant)) throw new Error(`Invalid tenant id: ${tenant}`);
    return join(this.root, tenant);
  }
  private readJsonSync<T>(path: string): T | undefined {
    try { return JSON.parse(readFileSync(path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private write(tenant: string, file: string, value: unknown) { writeDurableJson(join(this.dir(tenant), file), value); }

  /** Admin-defined tenants and tenants created by console sign-in. */
  exists(tenant: string) { return this.tenants.has(tenant) || (validTenant(tenant) && existsSync(join(this.dir(tenant), "tenant.json"))); }

  /** Resolve a bearer operator token or tenant API token. */
  authenticate(authorization: string | undefined): Principal | undefined {
    const operator = this.tenants.authenticate(authorization);
    if (operator) return { tenant: operator.id, via: "operator" };
    if (!authorization?.startsWith("Bearer art_")) return undefined;
    const match = this.tokenIndex.get(sha256(authorization.slice(7)));
    return match && this.exists(match.tenant) ? { tenant: match.tenant, via: "token", tokenId: match.id } : undefined;
  }

  /**
   * The tenant a GitHub user signs in as: an admin tenant linked to that login,
   * otherwise a tenant named after the login, created on first sign-in.
   */
  tenantForGithub(login: string): string {
    const linked = this.tenants.byGithub(login);
    if (linked) return linked;
    const id = login.toLowerCase();
    if (!validTenant(id)) throw new Error(`GitHub login ${login} cannot be used as a tenant id`);
    if (this.tenants.has(id)) throw new Error(`Tenant ${id} exists but is not linked to GitHub user ${login}; ask an admin to add "github": "${login}" to it`);
    const existing = this.readJsonSync<{ github?: string }>(join(this.dir(id), "tenant.json"));
    if (existing && existing.github?.toLowerCase() !== login.toLowerCase()) throw new Error(`Tenant ${id} belongs to another account`);
    if (!existing) this.write(id, "tenant.json", { id, github: login, createdAt: Date.now() });
    return id;
  }

  // Provider keys -------------------------------------------------------------

  private storedKeys(tenant: string) { return this.readJsonSync<Record<string, StoredKey>>(join(this.dir(tenant), "keys.json")) ?? {}; }

  /** The key an agent uses: the tenant's own key, else one an admin configured. */
  apiKey(tenant: string, provider: string): string | undefined {
    const stored = this.secretsKey && validTenant(tenant) ? this.storedKeys(tenant)[provider] : undefined;
    if (stored) {
      const decipher = createDecipheriv("aes-256-gcm", this.secretsKey!, Buffer.from(stored.iv, "base64"));
      decipher.setAAD(Buffer.from(`${tenant}:${provider}`));
      decipher.setAuthTag(Buffer.from(stored.tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(stored.ciphertext, "base64")), decipher.final()]).toString("utf8");
    }
    return this.tenants.apiKey(tenant, provider);
  }

  keyStatus(tenant: string): KeyStatus[] {
    const statuses = new Map<string, KeyStatus>();
    for (const provider of this.tenants.providers(tenant)) statuses.set(provider, { provider, source: "admin" });
    for (const [provider, key] of Object.entries(this.storedKeys(tenant))) statuses.set(provider, { provider, source: "tenant", last4: key.last4, setAt: key.setAt });
    return [...statuses.values()].sort((a, b) => a.provider.localeCompare(b.provider));
  }

  /** Whether an agent of `tenant` can call `provider` (its own key, an admin key, or an admin `*` key). */
  hasKey(tenant: string, provider: string) {
    return (validTenant(tenant) && !!this.storedKeys(tenant)[provider] && this.canStoreKeys) || !!this.tenants.apiKey(tenant, provider);
  }

  get canStoreKeys() { return !!this.secretsKey; }

  setKey(tenant: string, provider: string, key: string) {
    if (!this.secretsKey) throw new Error("This runtime has no AGENT_SECRETS_KEY, so it cannot store provider keys");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.secretsKey, iv);
    // Binding tenant and provider stops a stored ciphertext being replayed under another name.
    cipher.setAAD(Buffer.from(`${tenant}:${provider}`));
    const ciphertext = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
    const keys = this.storedKeys(tenant);
    keys[provider] = { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64"), last4: key.slice(-4), setAt: Date.now() };
    this.write(tenant, "keys.json", keys);
  }

  deleteKey(tenant: string, provider: string) {
    const keys = this.storedKeys(tenant);
    if (!keys[provider]) return false;
    delete keys[provider];
    this.write(tenant, "keys.json", keys);
    return true;
  }

  // API tokens ----------------------------------------------------------------

  listTokens(tenant: string): Omit<ApiToken, "sha256">[] {
    return (this.readJsonSync<ApiToken[]>(join(this.dir(tenant), "tokens.json")) ?? []).map(({ sha256: _hash, ...token }) => token);
  }

  /** Mint a token. The secret is returned once and only its hash is kept. */
  createToken(tenant: string, name: string) {
    if (typeof name !== "string" || !name.trim() || name.length > 80) throw new Error("Token name must contain 1–80 characters");
    const tokens = this.readJsonSync<ApiToken[]>(join(this.dir(tenant), "tokens.json")) ?? [];
    if (tokens.length >= 50) throw new Error("A tenant can have at most 50 API tokens");
    const secret = `art_${randomBytes(32).toString("hex")}`;
    const token: ApiToken = { id: randomUUID(), name: name.trim(), sha256: sha256(secret), prefix: secret.slice(0, 8), createdAt: Date.now() };
    this.write(tenant, "tokens.json", [...tokens, token]);
    this.tokenIndex.set(token.sha256, { tenant, id: token.id });
    const { sha256: _hash, ...visible } = token;
    return { token: secret, ...visible };
  }

  revokeToken(tenant: string, id: string) {
    const tokens = this.readJsonSync<ApiToken[]>(join(this.dir(tenant), "tokens.json")) ?? [];
    const revoked = tokens.find(token => token.id === id);
    if (!revoked) return false;
    this.write(tenant, "tokens.json", tokens.filter(token => token.id !== id));
    this.tokenIndex.delete(revoked.sha256);
    return true;
  }

  // Usage ---------------------------------------------------------------------

  async recordUsage(tenant: string, agent: string, message: { provider?: string; model?: string; usage: any; timestamp?: number }) {
    const usage = message.usage ?? {};
    const record: UsageRecord = {
      at: message.timestamp ?? Date.now(), agent, provider: message.provider ?? "unknown", model: message.model ?? "unknown",
      input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0, cost: usage.cost?.total ?? 0,
    };
    await mkdir(this.dir(tenant), { recursive: true, mode: 0o700 });
    await appendFile(join(this.dir(tenant), "usage.jsonl"), JSON.stringify(record) + "\n", { mode: 0o600 });
  }

  /** Usage since `since`, summed per UTC day and model. */
  async usage(tenant: string, since: number) {
    let text = "";
    try { text = await readFile(join(this.dir(tenant), "usage.jsonl"), "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const rows = new Map<string, { day: string; model: string; responses: number; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }>();
    const totals = { responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    for (const line of text.split("\n")) {
      if (!line) continue;
      let record: UsageRecord;
      try { record = JSON.parse(line); } catch { continue; }
      if (record.at < since) continue;
      const day = new Date(record.at).toISOString().slice(0, 10);
      const model = `${record.provider}/${record.model}`;
      const row = rows.get(`${day} ${model}`) ?? { day, model, responses: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      for (const target of [row, totals]) {
        target.responses++; target.input += record.input; target.output += record.output;
        target.cacheRead += record.cacheRead; target.cacheWrite += record.cacheWrite; target.cost += record.cost;
      }
      rows.set(`${day} ${model}`, row);
    }
    return { since, totals, days: [...rows.values()].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)) };
  }

  /** Tenant ids created by console sign-in (admin tenants come from the Tenants file). */
  async consoleTenants() {
    try { return (await readdir(this.root)).filter(id => validTenant(id) && existsSync(join(this.root, id, "tenant.json"))); }
    catch { return []; }
  }
}
