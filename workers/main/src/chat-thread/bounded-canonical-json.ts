export interface BoundedJsonTraversalLimits {
  maxDepth: number;
  maxEntries: number;
  maxNodes: number;
}

export const DEFAULT_BOUNDED_JSON_LIMITS: BoundedJsonTraversalLimits =
  Object.freeze({
    maxDepth: 12,
    maxEntries: 1_024,
    maxNodes: 2_048,
  });

interface JsonPiece {
  text: string;
  bytes: number;
  complete: boolean;
}

interface EncodeState {
  limits: BoundedJsonTraversalLimits;
  entries: number;
  nodes: number;
  active: WeakSet<object>;
}

const encoder = new TextEncoder();
const ZERO: JsonPiece = { text: "0", bytes: 1, complete: false };
const BIGINT_TEXT_LIMIT = 10n ** 128n;

function checkedLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  name: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < minimum) {
    throw new RangeError(`${name} must be a finite integer >= ${minimum}`);
  }
  return Math.floor(selected);
}

function quoted(value: string, budget: number): JsonPiece | null {
  if (budget < 2) return null;
  let text = '"';
  let used = 1;
  let complete = true;

  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    let token: string;
    let tokenBytes: number;
    if (code === 0x22) {
      token = '\\"';
      tokenBytes = 2;
    } else if (code === 0x5c) {
      token = "\\\\";
      tokenBytes = 2;
    } else if (code === 0x08) {
      token = "\\b";
      tokenBytes = 2;
    } else if (code === 0x0c) {
      token = "\\f";
      tokenBytes = 2;
    } else if (code === 0x0a) {
      token = "\\n";
      tokenBytes = 2;
    } else if (code === 0x0d) {
      token = "\\r";
      tokenBytes = 2;
    } else if (code === 0x09) {
      token = "\\t";
      tokenBytes = 2;
    } else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
      const next = value.charCodeAt(index + 1);
      if (
        code >= 0xd800 &&
        code <= 0xdbff &&
        next >= 0xdc00 &&
        next <= 0xdfff
      ) {
        token = value.slice(index, index + 2);
        tokenBytes = 4;
        index += 1;
      } else {
        token = `\\u${code.toString(16).padStart(4, "0")}`;
        tokenBytes = 6;
      }
    } else {
      token = value[index];
      tokenBytes = code < 0x80 ? 1 : code < 0x800 ? 2 : 3;
    }

    if (used + tokenBytes + 1 > budget) {
      complete = false;
      if (used + 4 <= budget) {
        text += "…";
        used += 3;
      }
      break;
    }
    text += token;
    used += tokenBytes;
  }

  return { text: `${text}"`, bytes: used + 1, complete };
}

function marker(value: string, budget: number): JsonPiece {
  const result = quoted(value, budget) ?? ZERO;
  return { ...result, complete: false };
}

function scalar(value: unknown, budget: number): JsonPiece | null {
  if (value === null) {
    return budget >= 4 ? { text: "null", bytes: 4, complete: true } : ZERO;
  }
  if (typeof value === "string") return quoted(value, budget) ?? ZERO;
  if (typeof value === "boolean") {
    const text = value ? "true" : "false";
    return budget >= text.length
      ? { text, bytes: text.length, complete: true }
      : ZERO;
  }
  if (typeof value === "number") {
    const text = Number.isFinite(value) ? String(value) : "null";
    return budget >= text.length
      ? { text, bytes: text.length, complete: true }
      : ZERO;
  }
  if (typeof value === "bigint") {
    if (value >= BIGINT_TEXT_LIMIT || value <= -BIGINT_TEXT_LIMIT) {
      return marker("[bigint]", budget);
    }
    return marker(`${value}n`, budget);
  }
  if (typeof value === "undefined") return marker("[undefined]", budget);
  if (typeof value === "function") return marker("[function]", budget);
  if (typeof value === "symbol") return marker("[symbol]", budget);
  return null;
}

function arrayPiece(
  value: unknown[],
  budget: number,
  depth: number,
  state: EncodeState,
): JsonPiece {
  if (budget < 2) return ZERO;
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  const length =
    typeof lengthDescriptor?.value === "number"
      ? Math.max(0, Math.floor(lengthDescriptor.value))
      : 0;
  let text = "[";
  let used = 1;
  let complete = true;
  let processed = 0;

  for (let index = 0; index < length; index += 1) {
    if (state.entries >= state.limits.maxEntries) {
      complete = false;
      break;
    }
    const separator = index === 0 ? 0 : 1;
    const available = budget - used - separator - 1;
    if (available < 1) {
      complete = false;
      break;
    }
    state.entries += 1;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const childValue = !descriptor
      ? null
      : "value" in descriptor
        ? descriptor.value
        : "[Accessor]";
    const child = valuePiece(childValue, available, depth + 1, state);
    if (separator) text += ",";
    text += child.text;
    used += separator + child.bytes;
    processed += 1;
    if (!descriptor || !("value" in descriptor) || !child.complete) complete = false;
  }
  if (processed < length) complete = false;
  return { text: `${text}]`, bytes: used + 1, complete };
}

function boundedKeys(
  value: object,
  budget: number,
  state: EncodeState,
): { keys: string[]; complete: boolean } {
  const keys: string[] = [];
  let keyChars = 0;
  let complete = true;
  for (const key in value) {
    if (state.entries >= state.limits.maxEntries) {
      complete = false;
      break;
    }
    state.entries += 1;
    if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
    if (keyChars + key.length > budget) {
      complete = false;
      break;
    }
    keyChars += key.length;
    keys.push(key);
  }
  keys.sort();
  return { keys, complete };
}

function objectPiece(
  value: object,
  budget: number,
  depth: number,
  state: EncodeState,
): JsonPiece {
  if (budget < 2) return ZERO;
  const selected = boundedKeys(value, budget, state);
  let text = "{";
  let used = 1;
  let complete = selected.complete;

  for (const key of selected.keys) {
    const separator = used === 1 ? 0 : 1;
    const available = budget - used - separator - 1;
    if (available < 4) {
      complete = false;
      break;
    }
    const encodedKey = quoted(key, available - 2);
    if (!encodedKey?.complete) {
      complete = false;
      break;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    const childValue = !descriptor
      ? "[Unreadable]"
      : "value" in descriptor
        ? descriptor.value
        : "[Accessor]";
    const child = valuePiece(
      childValue,
      available - encodedKey.bytes - 1,
      depth + 1,
      state,
    );
    if (separator) text += ",";
    text += `${encodedKey.text}:${child.text}`;
    used += separator + encodedKey.bytes + 1 + child.bytes;
    if (!descriptor || !("value" in descriptor) || !child.complete) complete = false;
  }
  return { text: `${text}}`, bytes: used + 1, complete };
}

function valuePiece(
  value: unknown,
  budget: number,
  depth: number,
  state: EncodeState,
): JsonPiece {
  if (budget < 1) return ZERO;
  if (state.nodes >= state.limits.maxNodes) {
    return marker("[MaxNodes]", budget);
  }
  state.nodes += 1;
  const primitive = scalar(value, budget);
  if (primitive) return primitive;
  if (!value || typeof value !== "object") return marker("[unknown]", budget);
  if (state.active.has(value)) return marker("[Circular]", budget);
  if (depth >= state.limits.maxDepth) return marker("[MaxDepth]", budget);

  state.active.add(value);
  try {
    return Array.isArray(value)
      ? arrayPiece(value, budget, depth, state)
      : objectPiece(value, budget, depth, state);
  } catch {
    return marker("[Unserializable]", budget);
  } finally {
    state.active.delete(value);
  }
}

/**
 * Serializes without first materializing an unbounded JSON string or clone.
 * Object keys are sorted, accessors/toJSON are never invoked, and traversal is
 * stopped independently by depth, entry, node, and UTF-8 output-byte limits.
 */
export function boundedCanonicalJsonResult(
  value: unknown,
  maxBytes: number,
  limits: Partial<BoundedJsonTraversalLimits> = {},
): { json: string; complete: boolean } {
  const budget = checkedLimit(maxBytes, 0, 1, "maxBytes");
  const state: EncodeState = {
    limits: {
      maxDepth: checkedLimit(
        limits.maxDepth,
        DEFAULT_BOUNDED_JSON_LIMITS.maxDepth,
        0,
        "maxDepth",
      ),
      maxEntries: checkedLimit(
        limits.maxEntries,
        DEFAULT_BOUNDED_JSON_LIMITS.maxEntries,
        0,
        "maxEntries",
      ),
      maxNodes: checkedLimit(
        limits.maxNodes,
        DEFAULT_BOUNDED_JSON_LIMITS.maxNodes,
        1,
        "maxNodes",
      ),
    },
    entries: 0,
    nodes: 0,
    active: new WeakSet<object>(),
  };
  const result = valuePiece(value, budget, 0, state);
  const fits = result.bytes <= budget && encoder.encode(result.text).byteLength <= budget;
  return { json: fits ? result.text : "0", complete: fits && result.complete };
}

export function boundedCanonicalJson(
  value: unknown,
  maxBytes: number,
  limits: Partial<BoundedJsonTraversalLimits> = {},
): string {
  return boundedCanonicalJsonResult(value, maxBytes, limits).json;
}
