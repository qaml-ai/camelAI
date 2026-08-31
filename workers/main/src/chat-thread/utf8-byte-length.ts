const surrogatePair = (code: number, next: number) =>
  code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;

const utf8CodeUnitBytes = (code: number, next: number) =>
  code < 0x80 ? 1 : code < 0x800 ? 2 : surrogatePair(code, next) ? 4 : 3;

/** Counts UTF-8 bytes without allocating an encoded copy of the string. */
export function utf8ByteLength(value: string): number {
  if (!/[\u0080-\uFFFF]/.test(value)) return value.length;
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    const next = value.charCodeAt(index + 1);
    bytes += utf8CodeUnitBytes(code, next);
    if (surrogatePair(code, next)) index += 1;
  }
  return bytes;
}

/** Truncates to a UTF-8 byte budget without first encoding the whole string. */
export function boundedUtf8String(value: string, maximumBytes: number): string {
  const limit = Math.max(0, Math.floor(maximumBytes));
  if (utf8ByteLength(value) <= limit) return value;
  if (limit < 3) return "";
  const contentLimit = limit - 3; // UTF-8 ellipsis.
  let used = 0;
  let end = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    const next = value.charCodeAt(index + 1);
    const bytes = utf8CodeUnitBytes(code, next);
    if (used + bytes > contentLimit) break;
    used += bytes;
    index += surrogatePair(code, next) ? 2 : 1;
    end = index;
  }
  return `${value.slice(0, end)}…`;
}

function jsonCodeUnitBytes(code: number, next: number): number {
  if (code === 0x22 || code === 0x5c) return 2;
  if (code >= 8 && code <= 13 && code !== 11) return 2;
  if (code < 0x20) return 6;
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (surrogatePair(code, next)) return 4;
  return code >= 0xd800 && code <= 0xdfff ? 6 : 3;
}

/** Returns the exact UTF-8 byte size produced by JSON.stringify(string). */
export function jsonStringByteLength(value: string): number {
  if (/^[\u0020-\u0021\u0023-\u005B\u005D-\u007E]*$/.test(value)) {
    return value.length + 2;
  }
  let bytes = 2;
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    const next = code >= 0xd800 && code <= 0xdbff
      ? value.charCodeAt(index + 1) : -1;
    bytes += jsonCodeUnitBytes(code, next);
    index += surrogatePair(code, next) ? 2 : 1;
  }
  return bytes;
}

/** Truncates a string to an exact JSON-string byte budget without probe copies. */
export function boundedJsonString(value: string, maximumBytes: number): string {
  const limit = Math.max(2, Math.floor(maximumBytes));
  if (jsonStringByteLength(value) <= limit) return value;
  if (limit < 5) return "";
  const contentLimit = Math.max(0, limit - 5); // quotes plus UTF-8 ellipsis
  let used = 0;
  let end = 0;
  for (let index = 0; index < value.length; ) {
    const code = value.charCodeAt(index);
    const next = code >= 0xd800 && code <= 0xdbff
      ? value.charCodeAt(index + 1) : -1;
    const bytes = jsonCodeUnitBytes(code, next);
    if (used + bytes > contentLimit) break;
    used += bytes;
    index += surrogatePair(code, next) ? 2 : 1;
    end = index;
  }
  return `${value.slice(0, end)}…`;
}
