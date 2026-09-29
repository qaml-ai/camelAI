-- Mirror of OrgDO.workspace_memberships (per-workspace access overrides), so
-- the workspace switcher's per-org fan-out can eventually be served from D1.
-- A member without a row here gets org_memberships.workspace_access_default.
--
-- Columns the fan-out reads need on existing tables (users.email_verified_at,
-- users.orphaned_at, org_memberships.workspace_access_default,
-- workspaces.email_handle and the threads list projection) are added by
-- AppIndexDatabase.ensureSchema: SQLite has no ADD COLUMN IF NOT EXISTS, and
-- that runtime path may already have added them.
CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  access_level TEXT NOT NULL,
  granted_by TEXT,
  granted_at INTEGER NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_user ON workspace_members(user_id, org_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_org ON workspace_members(org_id);
