/**
 * Allowlisted slash commands — same set as camelAI.
 * Leading slash is part of the command string.
 */

export const SLASH_COMMANDS = [
  "/compact",
  "/context",
  "/debug",
  "/insights",
  "/security-review",
] as const;

export type SlashCommand = (typeof SLASH_COMMANDS)[number];

const SLASH_COMMAND_SET = new Set<string>(SLASH_COMMANDS);

export function isSlashCommand(value: string): value is SlashCommand {
  return SLASH_COMMAND_SET.has(value.trim());
}

/** Manual context compaction. */
export const MANUAL_COMPACT_COMMAND: SlashCommand = "/compact";

export function isManualCompactCommand(value: string): boolean {
  return value.trim() === MANUAL_COMPACT_COMMAND;
}
