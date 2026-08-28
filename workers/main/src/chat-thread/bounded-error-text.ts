import { CHAT_RUNTIME_BOUNDS } from "../../../../src/lib/chat-runtime-bounds";

const utf8Bytes = (code: number, next: number): { bytes: number; width: number } => {
  if (code < 0x80) return { bytes: 1, width: 1 };
  if (code < 0x800) return { bytes: 2, width: 1 };
  if (code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
    return { bytes: 4, width: 2 };
  }
  return { bytes: 3, width: 1 };
};

/** Truncates without first encoding or copying an attacker-sized string. */
export function boundedUtf8Text(value: string, maximumBytes: number): string {
  const limit = Math.max(0, Math.floor(maximumBytes));
  if (limit === 0 || value.length === 0) return "";
  const suffix = "…";
  const suffixBytes = 3;
  let used = 0;
  let end = 0;
  let endWithSuffix = 0;
  for (let index = 0; index < value.length;) {
    const token = utf8Bytes(value.charCodeAt(index), value.charCodeAt(index + 1));
    if (used + token.bytes > limit) {
      return limit >= suffixBytes
        ? `${value.slice(0, endWithSuffix)}${suffix}`
        : value.slice(0, end);
    }
    used += token.bytes;
    index += token.width;
    end = index;
    if (used <= limit - suffixBytes) endWithSuffix = index;
  }
  return value;
}

function ownDataString(value: object, key: string): string | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && typeof descriptor.value === "string"
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function primitiveErrorText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "Unknown error";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (value === null || value === undefined) return "Unknown error";
  if (typeof value === "bigint") return "[bigint thrown]";
  if (typeof value === "symbol") return "[symbol thrown]";
  if (typeof value === "function") return "[function thrown]";
  return "[object thrown]";
}

/** Reads only own data properties; accessors, toString, and toJSON are ignored. */
export function boundedErrorValue(
  value: unknown,
  maximumMessageBytes = CHAT_RUNTIME_BOUNDS.assistantBytes,
): { name: string; message: string } {
  const object = value !== null && (typeof value === "object" || typeof value === "function")
    ? value as object
    : null;
  const name = object ? ownDataString(object, "name") : undefined;
  const message = object ? ownDataString(object, "message") : undefined;
  return {
    name: boundedUtf8Text(name || "Error", CHAT_RUNTIME_BOUNDS.identifierChars) || "Error",
    message: boundedUtf8Text(message || primitiveErrorText(value), maximumMessageBytes) || "Unknown error",
  };
}

export function boundedErrorText(
  value: unknown,
  maximumBytes = CHAT_RUNTIME_BOUNDS.assistantBytes,
): string {
  return boundedErrorValue(value, maximumBytes).message;
}
