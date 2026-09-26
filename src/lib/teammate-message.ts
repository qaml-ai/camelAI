import { stripSystemMessageTags } from '@/lib/message-text';

const TEAMMATE_MESSAGE_REGEX = /^<teammate-message\s+teammate_id="([^"]+)">\n?([\s\S]*?)\n?<\/teammate-message>$/;

export interface ParsedTeammateMessage {
  teammateId: string;
  content: string;
}

export function parseTeammateMessage(rawContent: string): ParsedTeammateMessage | null {
  const stripped = stripSystemMessageTags(rawContent).trim();
  const match = stripped.match(TEAMMATE_MESSAGE_REGEX);
  if (!match) return null;
  return {
    teammateId: match[1] ?? '',
    content: (match[2] ?? '').trim(),
  };
}
