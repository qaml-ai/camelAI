export interface TextLineWindow {
  content: string;
  totalLines: number;
  outputLines: number;
}

/** Selects a line window without allocating one string/array entry per line. */
export function selectTextLineWindow(
  text: string,
  startLine: number,
  limit?: number,
): TextLineWindow | null {
  let line = 0;
  let start = startLine === 0 ? 0 : -1;
  let end = text.length;
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) !== 10) continue;
    line += 1;
    if (line === startLine) start = index + 1;
    if (limit !== undefined && line === startLine + limit) end = index;
  }
  const totalLines = line + 1;
  if (start < 0 || startLine >= totalLines) return null;
  const outputLines = Math.min(limit ?? totalLines, totalLines - startLine);
  return { content: text.slice(start, end), totalLines, outputLines };
}

export interface TruncatedTextHead {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  firstLineBytes: number;
  firstLineExceedsLimit: boolean;
}

/** Truncates on UTF-8/code-point boundaries without splitting the input. */
export function truncateTextHead(
  text: string,
  maxLines: number,
  maxBytes: number,
): TruncatedTextHead {
  let totalLines = 1;
  let totalBytes = 0;
  let firstLineBytes = 0;
  let outputLines = 1;
  let outputBytes = 0;
  let end = text.length;
  let truncatedBy: TruncatedTextHead["truncatedBy"] = null;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    const pair = code >= 0xd800 && code <= 0xdbff &&
      text.charCodeAt(index + 1) >= 0xdc00 && text.charCodeAt(index + 1) <= 0xdfff;
    const width = pair ? 4 : code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    totalBytes += width;
    if (totalLines === 1) firstLineBytes += code === 10 ? 0 : width;
    if (code === 10) totalLines += 1;
    if (truncatedBy === null) {
      if (code === 10 && outputLines >= maxLines) {
        end = index;
        truncatedBy = "lines";
      } else if (outputBytes + width > maxBytes) {
        end = index;
        truncatedBy = "bytes";
      } else {
        outputBytes += width;
        if (code === 10) outputLines += 1;
      }
    }
    if (pair) index += 1;
  }
  return {
    content: text.slice(0, end),
    truncated: truncatedBy !== null,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines,
    outputBytes,
    firstLineBytes,
    firstLineExceedsLimit: firstLineBytes > maxBytes,
  };
}
