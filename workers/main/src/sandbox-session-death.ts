// Session-death classification for @cloudflare/sandbox containers.
//
// Extracted from analysis-service.ts (its original home) so the sandbox DOs'
// self-heal keys off the SAME predicate the analysis recovery path uses. There
// must be exactly one definition of "the container's shell died": two would
// drift (see plans/sse-migration/ZOMBIE-CONTAINER-FIX.md).
//
// analysis-service.ts re-exports everything here, so existing importers are
// unaffected.

/**
 * The sandbox SDK's session/process-death family. A container OOM or restart
 * kills the persistent shell backing the workspace's session, and every one of
 * these reaches the caller as a raw SDK error name — production surfaced
 * `SessionTerminatedError: Session 'sandbox-<ws>' shell exited (exit code: 128)`
 * verbatim to a user.
 *
 * Audited against the full export list of @cloudflare/sandbox 0.12.0
 * (`dist/index.d.ts`): SessionTerminatedError, ProcessExitedBeforeReadyError and
 * ProcessReadyTimeoutError are the whole family; the remaining SandboxError
 * subclasses are backup/mount/transport concerns handled elsewhere.
 *
 * Matched by NAME as well as by message because the error crosses a DO RPC hop
 * on the way here, where the SDK class identity does not survive.
 */
const SANDBOX_SESSION_DEATH_NAMES = [
  "SessionTerminatedError",
  "ProcessExitedBeforeReadyError",
  "ProcessReadyTimeoutError",
] as const;

/**
 * Deliberately tight: these run against RESULT payloads too (runAnalysisCode
 * turns a throw into `{ ok: false, error }`), and a loose "shell exited" would
 * misread a user command's own stderr as an environment death and retry a
 * non-idempotent command.
 */
const SANDBOX_SESSION_DEATH_PATTERNS = [
  /SessionTerminatedError/i,
  /ProcessExitedBeforeReadyError/i,
  /ProcessReadyTimeoutError/i,
  /Session\s+["']?[^"'\n]+["']?\s+(?:ended because its shell exited|shell exited)/i,
] as const;

export function isSandboxSessionDeathError(error: unknown): boolean {
  if (error instanceof Error && (SANDBOX_SESSION_DEATH_NAMES as readonly string[]).includes(error.name)) {
    return true;
  }
  const text = String(error instanceof Error ? `${error.name}: ${error.message}` : error);
  return SANDBOX_SESSION_DEATH_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Session death seen as a RESULT rather than a throw.
 *
 * `runAnalysisCode` converts any exception into `{ ok: false, error }`, so a
 * dead shell reaches the caller as a value — which is how the raw SDK text got
 * in front of a user in the first place. Recovery has to look at both shapes.
 *
 * Keyed on the STRUCTURED `sessionDeath` marker, which only the environment's
 * own catch block sets. Sniffing `error` text would read the user program's
 * stderr — a script printing `SessionTerminatedError` would then be silently
 * re-executed, the exact hazard this classification is supposed to avoid.
 */
export function isSandboxSessionDeathResult(result: unknown): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) return false;
  const record = result as { ok?: unknown; sessionDeath?: unknown };
  return record.ok === false && record.sessionDeath === true;
}

/** Exit code the SDK embeds in the session-death message, when it has one. */
export function sandboxSessionExitCode(error: unknown): number | null {
  const text = String(error instanceof Error ? error.message : error);
  const match = text.match(/exit code:?\s*(-?\d+)/i);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isFinite(parsed) ? parsed : null;
}
