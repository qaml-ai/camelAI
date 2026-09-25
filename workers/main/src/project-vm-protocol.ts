// Residual helper left over from the retired Azure project VM
// runtime. The VM bridge and its protocol are gone; only normalizeGlobalProjectId
// still has consumers: it derives the stable global project id used as the
// WorkspaceFilesystemDO registry key (workspace-filesystem-do.ts). Kept here
// (rather than renamed) to avoid churning those import sites.

export function normalizeGlobalProjectId(projectId: string): string {
  return projectId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}
