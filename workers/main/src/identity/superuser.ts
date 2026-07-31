/**
 * Superuser bootstrap allowlist.
 *
 * Configure via the `SUPERUSER_EMAILS` Worker secret (comma or whitespace
 * separated). Explicit admin grants via the admin panel remain the normal path;
 * the env list is only for first-admin bootstrap.
 */

export function parseSuperuserEmails(
  raw: string | null | undefined,
): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isSuperuserEmail(
  email: string | null,
  allowlist: Set<string> | string | null | undefined = undefined,
): boolean {
  if (!email) return false;
  const set =
    allowlist instanceof Set
      ? allowlist
      : parseSuperuserEmails(
          typeof allowlist === "string" ? allowlist : undefined,
        );
  return set.has(email.toLowerCase());
}
