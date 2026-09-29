-- Version + tombstone ledger for the DO -> D1 identity mirror.
--
-- One row per mirrored entity row (entity = 'user' | 'org' | 'workspace' |
-- 'thread' | 'app' | 'invitation' | 'org_membership' | ...). The owning Durable
-- Object stamps every outbox drain with a monotonic version; a data write only
-- applies while its version is the one recorded here, so an out-of-order or
-- retried drain can never regress a row, and `deleted = 1` keeps a stale upsert
-- from resurrecting a deleted row.
CREATE TABLE IF NOT EXISTS mirror_rows (
  entity TEXT NOT NULL,
  entity_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (entity, entity_key)
);

CREATE INDEX IF NOT EXISTS idx_mirror_rows_deleted_updated_at ON mirror_rows(deleted, updated_at);
