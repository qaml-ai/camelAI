/** Read-only export primitives. SQL names are constants, never request input. */
export type ExportRow = Record<string, unknown>;
export interface ExportPage { items: ExportRow[]; cursor: string | null }
export const EXPORT_LIMIT = 100;
export const EXPORT_BYTES = 2_000_000;
const SECRET = /(secret|token|password|passwd|api[_-]?key|private|credential|authorization|cookie)/i;

export function redactExportConfig(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactExportConfig);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, SECRET.test(key) ? '[REDACTED]' : redactExportConfig(child)]));
}
export function pickExport(value: unknown, fields: string): ExportRow {
  const row = value && typeof value === 'object' ? value as ExportRow : {};
  return Object.fromEntries(fields.split(' ').filter(key => key in row).map(key => [key, row[key]]));
}
export function exportJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return null; }
}
export function exportCursor(scope: string, value: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([scope, value]))));
}
export function readExportCursor(scope: string, cursor?: string | null): string | null {
  if (!cursor) return null;
  try {
    const pair = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(atob(cursor), char => char.charCodeAt(0))));
    if (!Array.isArray(pair) || pair.length !== 2 || pair[0] !== scope || typeof pair[1] !== 'string') throw new Error();
    return pair[1];
  } catch { throw new Error('Invalid export cursor'); }
}
export function exportLimit(limit = 50): number {
  return Math.max(1, Math.min(EXPORT_LIMIT, Math.floor(limit) || 1));
}
export function exportTableExists(sql: SqlStorage, table: string): boolean {
  return sql.exec('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'table', table).toArray().length > 0;
}

/** Keyset paging; read one payload at a time so large rows cannot multiply the memory bound. */
export function readExportSqlPage(sql: SqlStorage, table: string, fields: string, scope: string, cursor?: string | null, limit = 50,
  where = '1 = 1', bindings: SqlStorageValue[] = []): ExportPage {
  const after = Number(readExportCursor(scope, cursor) ?? 0);
  if (!Number.isSafeInteger(after) || after < 0) throw new Error('Invalid export cursor');
  if (!exportTableExists(sql, table)) return { items: [], cursor: null };
  const columns = new Set(sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(row => row.name));
  const selected = fields.split(' ').filter(key => columns.has(key)).join(', ');
  const ids = sql.exec<{ rid: number }>(`SELECT rowid AS rid FROM ${table} WHERE rowid > ? AND (${where}) ORDER BY rowid LIMIT ?`, after, ...bindings, exportLimit(limit) + 1).toArray();
  const items: ExportRow[] = [];
  let bytes = 0, last = after;
  for (const { rid } of ids.slice(0, exportLimit(limit))) {
    const row = sql.exec(`SELECT ${selected} FROM ${table} WHERE rowid = ?`, rid).toArray()[0];
    if (!row) continue;
    const size = new TextEncoder().encode(JSON.stringify(row)).byteLength;
    if (items.length && bytes + size > EXPORT_BYTES) break;
    items.push(row); bytes += size; last = rid;
  }
  return { items, cursor: ids.some(row => row.rid > last) ? exportCursor(scope, String(last)) : null };
}

export const ORG_EXPORT_SETS = {
  members: ['members', 'user_id role joined_at workspace_access_default'],
  invitations: ['invitations', 'email role invited_by created_at expires_at workspace_access'],
  workspaces: ['workspaces', 'id name description created_at created_by archived archived_at archived_by avatar_color avatar_content compute_tier email_handle'],
  workspace_access: ['workspace_memberships', 'workspace_id user_id access_level granted_by granted_at'],
  integrations: ['integrations', 'id workspace_id integration_type definition_id name category auth_method config enabled created_by created_at updated_at'],
  integration_definitions: ['integration_definitions', 'id workspace_id slug payload source source_url created_by created_at updated_at'],
  apps: ['worker_scripts', 'script_name workspace_id created_by created_at updated_at is_public preview_key preview_updated_at preview_status config_path project_id commit_sha artifact_cache_key custom_domain_hostname custom_domain_status custom_domain_ssl_status'],
  deploy_versions: ['worker_script_deploys', 'id script_name workspace_id created_at created_by config_path project_id commit_sha artifact_cache_key'],
  threads: ['threads', 'id workspace_id title created_by model created_at updated_at user_message_count first_user_message last_user_message last_user_message_at last_assistant_completed_at last_assistant_summary source channel_kind channel_connection_id channel_conversation_id channel_message_id model_history'],
} as const;
export type OrgExportSet = keyof typeof ORG_EXPORT_SETS;
export function readOrgExportPage(sql: SqlStorage, set: OrgExportSet, cursor?: string | null, limit?: number): ExportPage {
  const [table, fields] = ORG_EXPORT_SETS[set];
  const page = readExportSqlPage(sql, table, fields, set, cursor, limit);
  page.items = page.items.map(row => {
    for (const field of ['config', 'payload', 'workspace_access']) {
      if (field in row) row[field] = redactExportConfig(exportJson(row[field]));
    }
    if (set === 'threads') {
      const runtime = readExportRecord(sql, 'thread_runtime', 'thread_id', String(row.id), 'agent_id model created_at updated_at');
      row.runtime = runtime;
      row.backend = runtime ? 'runtime' : 'chat_thread_do';
    }
    return row;
  });
  return page;
}
export function readExportRecord(sql: SqlStorage, table: string, key: string, id: string, fields: string): ExportRow | null {
  if (!exportTableExists(sql, table)) return null;
  const columns = new Set(sql.exec<{ name: string }>(`PRAGMA table_info(${table})`).toArray().map(row => row.name));
  return sql.exec(`SELECT ${fields.split(' ').filter(field => columns.has(field)).join(', ')} FROM ${table} WHERE ${key} = ? LIMIT 1`, id).toArray()[0] ?? null;
}
export function readOrgExportManifest(sql: SqlStorage): ExportRow | null {
  const read = (key: string) => exportJson(readExportRecord(sql, 'org_info', 'key', key, 'value')?.value);
  const info = read('data');
  if (!info) return null;
  return {
    org: pickExport(info, 'id name slug created_at created_by archived archived_at archived_by billing_status billing_plan billing_seat_count'),
    sso: info && read('enterprise_oidc_config') ? pickExport(read('enterprise_oidc_config'), 'enabled connection_id protocol issuer client_id client_auth_method email_claim email_domains jit_provisioning_enabled config_version session_ttl_seconds updated_at updated_by') : null,
    model_picker: redactExportConfig(read('model_picker_config')),
    custom_domain: exportTableExists(sql, 'custom_domains') ? sql.exec('SELECT domain, cf_hostname_id, status, ssl_status, created_at, updated_at FROM custom_domains LIMIT 1').toArray()[0] ?? null : null,
    usage: readExportRecord(sql, 'usage_spend', 'id', '1', 'total_cost_usd total_input_tokens total_output_tokens total_cache_creation_tokens total_cache_read_tokens total_requests updated_at_ms'),
    record_sets: Object.keys(ORG_EXPORT_SETS).filter(key => key !== 'threads'),
  };
}

/** No normalization: rejecting ambiguous keys keeps prefix checks exact. */
export function safeExportKey(key: string, prefix = false): boolean {
  const value = prefix && key.endsWith('/') ? key.slice(0, -1) : key;
  // oxlint-disable-next-line no-control-regex -- Keys must reject ASCII control characters.
  return !!value && !/[\\\x00-\x1f\x7f]/.test(value) && value.split('/').every(part => !!part && part !== '.' && part !== '..');
}
export function allowedExportR2Key(key: string, prefixes: string[], prefix = false): boolean {
  return safeExportKey(key, prefix) && prefixes.some(allowed => key.startsWith(allowed));
}
