import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * A tenant owns its operator token, its agents and its model provider keys.
 * Tenants cannot list, inspect or drive each other's agents, and an agent's
 * model calls are billed to its own tenant's key.
 */
export interface Tenant {
  id: string;
  /** SHA-256 (hex) of the operator token; the token itself is never stored. */
  tokenSha256: string;
  /** Provider name (Pi's `model.provider`, e.g. "anthropic") → API key. */
  apiKeys: Record<string, string>;
  /** GitHub login that signs in to the console as this tenant. */
  github?: string;
}

/** The single-token mode used before tenants existed; its agents keep their original IDs. */
export const DEFAULT_TENANT = "default";
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const validTenantId = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,39}$/.test(value);

export class Tenants {
  private byId = new Map<string, Tenant>();
  /** Legacy mode: one operator token from AGENT_RUNTIME_TOKEN, no tenants file. */
  readonly legacy: boolean;
  private readonly file?: string;

  constructor(options: { file?: string; legacyToken?: string; legacyApiKey?: string }) {
    this.file = options.file;
    this.legacy = !options.file;
    if (options.file) this.reload();
    else {
      if (!options.legacyToken || options.legacyToken.length < 24) throw new Error("Set AGENT_TENANTS_FILE, or AGENT_RUNTIME_TOKEN to at least 24 random characters");
      this.set([{ id: DEFAULT_TENANT, tokenSha256: sha256(options.legacyToken), apiKeys: options.legacyApiKey ? { "*": options.legacyApiKey } : {} }]);
    }
  }

  /** Re-read the tenants file (e.g. on SIGHUP after adding a tenant). Invalid files are rejected whole. */
  reload() {
    if (!this.file) return;
    const parsed = JSON.parse(readFileSync(this.file, "utf8")) as { tenants?: Record<string, Omit<Tenant, "id">> };
    if (!parsed.tenants || typeof parsed.tenants !== "object") throw new Error("Tenants file must contain a `tenants` object");
    this.set(Object.entries(parsed.tenants).map(([id, tenant]) => ({ id, ...tenant })));
  }

  private set(tenants: Tenant[]) {
    const next = new Map<string, Tenant>();
    const hashes = new Set<string>();
    for (const tenant of tenants) {
      if (!validTenantId(tenant.id)) throw new Error(`Invalid tenant id: ${tenant.id}`);
      if (typeof tenant.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/.test(tenant.tokenSha256)) throw new Error(`Tenant ${tenant.id} needs a hex tokenSha256`);
      if (hashes.has(tenant.tokenSha256)) throw new Error(`Tenant ${tenant.id} reuses another tenant's token`);
      if (!tenant.apiKeys || typeof tenant.apiKeys !== "object" || Object.values(tenant.apiKeys).some(key => typeof key !== "string" || !key)) throw new Error(`Tenant ${tenant.id} has invalid apiKeys`);
      hashes.add(tenant.tokenSha256);
      if (tenant.github !== undefined && (typeof tenant.github !== "string" || !/^[A-Za-z0-9-]{1,39}$/.test(tenant.github))) throw new Error(`Tenant ${tenant.id} has an invalid github login`);
      next.set(tenant.id, { id: tenant.id, tokenSha256: tenant.tokenSha256, apiKeys: { ...tenant.apiKeys }, ...(tenant.github ? { github: tenant.github } : {}) });
    }
    this.byId = next;
  }

  /** Resolve an `Authorization: Bearer <operator token>` header. Compares every tenant in constant time. */
  authenticate(authorization: string | undefined): Tenant | undefined {
    if (!authorization?.startsWith("Bearer ")) return undefined;
    const digest = Buffer.from(sha256(authorization.slice(7)), "hex");
    let match: Tenant | undefined;
    for (const tenant of this.byId.values()) if (timingSafeEqual(digest, Buffer.from(tenant.tokenSha256, "hex"))) match = tenant;
    return match;
  }

  has(id: string) { return this.byId.has(id); }

  /** The admin-defined tenant a GitHub login signs in as, if any (case-insensitive). */
  byGithub(login: string) {
    for (const tenant of this.byId.values()) if (tenant.github?.toLowerCase() === login.toLowerCase()) return tenant.id;
    return undefined;
  }

  /** Providers an admin configured keys for (`*` covers any provider). Names only. */
  providers(id: string) { return Object.keys(this.byId.get(id)?.apiKeys ?? {}); }

  /** The key an agent of `tenantId` uses for `provider`; `*` is a tenant-wide fallback. */
  apiKey(tenantId: string, provider: string): string | undefined {
    const keys = this.byId.get(tenantId)?.apiKeys;
    return keys?.[provider] ?? keys?.["*"];
  }
}
