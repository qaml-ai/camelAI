export type BanScope = "user" | "org";
export type BanPurgeStatus = "pending" | "running" | "completed" | "failed";

export interface BanRecord {
  scope: BanScope;
  target_id: string;
  email: string | null;
  org_slug: string | null;
  reason: string;
  created_at: number;
  created_by: string;
  status: "active";
  purge_status: BanPurgeStatus;
  purge_job_id: string | null;
  purge_started_at: number | null;
  purge_completed_at: number | null;
  purge_error: string | null;
}

export interface BanListQuery {
  scope?: BanScope;
  limit?: number;
  cursor?: string;
}

export interface BanListResult {
  records: BanRecord[];
  cursor?: string;
}

const USER_ID_PREFIX = "ban:user:id:";
const USER_EMAIL_PREFIX = "ban:user:email:";
const ORG_ID_PREFIX = "ban:org:id:";
const ORG_SLUG_PREFIX = "ban:org:slug:";

export function normalizeBanEmail(
  email: string | null | undefined,
): string | null {
  const normalized = String(email ?? "")
    .trim()
    .toLowerCase();
  return normalized || null;
}

export function normalizeBanSlug(
  slug: string | null | undefined,
): string | null {
  const normalized = String(slug ?? "")
    .trim()
    .toLowerCase();
  return normalized || null;
}

export function getUserBanIdKey(userId: string): string {
  return `${USER_ID_PREFIX}${userId}`;
}

export function getUserBanEmailKey(email: string): string {
  return `${USER_EMAIL_PREFIX}${normalizeBanEmail(email)}`;
}

export function getOrgBanIdKey(orgId: string): string {
  return `${ORG_ID_PREFIX}${orgId}`;
}

export function getOrgBanSlugKey(slug: string): string {
  return `${ORG_SLUG_PREFIX}${normalizeBanSlug(slug)}`;
}

function safeParseBanRecord(raw: string | null): BanRecord | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as BanRecord;
    if (!parsed || (parsed.scope !== "user" && parsed.scope !== "org"))
      return null;
    if (!parsed.target_id || parsed.status !== "active") return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getUserBanById(
  kv: KVNamespace,
  userId: string,
): Promise<BanRecord | null> {
  return safeParseBanRecord(await kv.get(getUserBanIdKey(userId)));
}

export async function getUserBanByEmail(
  kv: KVNamespace,
  email: string | null | undefined,
): Promise<BanRecord | null> {
  const normalized = normalizeBanEmail(email);
  if (!normalized) return null;
  return safeParseBanRecord(await kv.get(getUserBanEmailKey(normalized)));
}

export async function getOrgBanById(
  kv: KVNamespace,
  orgId: string,
): Promise<BanRecord | null> {
  return safeParseBanRecord(await kv.get(getOrgBanIdKey(orgId)));
}

export async function getOrgBanBySlug(
  kv: KVNamespace,
  slug: string | null | undefined,
): Promise<BanRecord | null> {
  const normalized = normalizeBanSlug(slug);
  if (!normalized) return null;
  return safeParseBanRecord(await kv.get(getOrgBanSlugKey(normalized)));
}

export async function isUserBanned(
  kv: KVNamespace,
  identifiers: {
    userId?: string | null;
    email?: string | null;
  },
): Promise<BanRecord | null> {
  // Both keys are read together; a ban by id wins over one by email.
  const [byId, byEmail] = await Promise.all([
    identifiers.userId ? getUserBanById(kv, identifiers.userId) : null,
    identifiers.email ? getUserBanByEmail(kv, identifiers.email) : null,
  ]);
  return byId ?? byEmail ?? null;
}

export async function isOrgBanned(
  kv: KVNamespace,
  identifiers: {
    orgId?: string | null;
    slug?: string | null;
  },
): Promise<BanRecord | null> {
  if (identifiers.orgId) {
    const byId = await getOrgBanById(kv, identifiers.orgId);
    if (byId) return byId;
  }
  if (identifiers.slug) {
    return getOrgBanBySlug(kv, identifiers.slug);
  }
  return null;
}

export async function putUserBan(
  kv: KVNamespace,
  record: BanRecord,
): Promise<void> {
  if (record.scope !== "user") throw new Error("Expected user ban record");
  const writes: Promise<void>[] = [
    kv.put(getUserBanIdKey(record.target_id), JSON.stringify(record)),
  ];
  if (record.email) {
    writes.push(
      kv.put(getUserBanEmailKey(record.email), JSON.stringify(record)),
    );
  }
  await Promise.all(writes);
}

export async function putOrgBan(
  kv: KVNamespace,
  record: BanRecord,
): Promise<void> {
  if (record.scope !== "org") throw new Error("Expected org ban record");
  const writes: Promise<void>[] = [
    kv.put(getOrgBanIdKey(record.target_id), JSON.stringify(record)),
  ];
  if (record.org_slug) {
    writes.push(
      kv.put(getOrgBanSlugKey(record.org_slug), JSON.stringify(record)),
    );
  }
  await Promise.all(writes);
}

export async function putBanRecord(
  kv: KVNamespace,
  record: BanRecord,
): Promise<void> {
  if (record.scope === "user") {
    await putUserBan(kv, record);
    return;
  }
  await putOrgBan(kv, record);
}

export async function listBanRecords(
  kv: KVNamespace,
  query: BanListQuery = {},
): Promise<BanListResult> {
  const prefix =
    query.scope === "org"
      ? ORG_ID_PREFIX
      : query.scope === "user"
        ? USER_ID_PREFIX
        : undefined;

  if (prefix) {
    const page = await kv.list({
      prefix,
      limit: query.limit ?? 100,
      cursor: query.cursor,
    });
    const records = await Promise.all(
      page.keys.map(async (key) => safeParseBanRecord(await kv.get(key.name))),
    );
    return {
      records: records.filter((record): record is BanRecord => Boolean(record)),
      cursor: page.list_complete ? undefined : page.cursor,
    };
  }

  const [users, orgs] = await Promise.all([
    listBanRecords(kv, { scope: "user", limit: query.limit ?? 100 }),
    listBanRecords(kv, { scope: "org", limit: query.limit ?? 100 }),
  ]);

  const records = [...users.records, ...orgs.records].sort(
    (a, b) => b.created_at - a.created_at,
  );
  return { records: records.slice(0, query.limit ?? 100) };
}
