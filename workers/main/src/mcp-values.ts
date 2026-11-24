export const DEFAULT_MCP_HTTP_TIMEOUT_MS = 30_000;
export const ANALYTICS_MCP_HTTP_TIMEOUT_MS = 60_000;
export const DEFAULT_MCP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export function textToolResult(value: unknown): Record<string, unknown> {
  return {
    content: [
      {
        type: "text",
        text:
          typeof value === "string" ? value : JSON.stringify(value, null, 2),
      },
    ],
  };
}

export async function fetchMcpHttp(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = DEFAULT_MCP_HTTP_TIMEOUT_MS,
): Promise<Response> {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = init.signal
    ? AbortSignal.any([init.signal, timeoutSignal])
    : timeoutSignal;
  try {
    return await fetch(input, { ...init, signal });
  } catch (error) {
    if (
      timeoutSignal.aborted ||
      (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError"))
    ) {
      throw Object.assign(
        new Error(`Upstream connection request timed out after ${timeoutMs}ms`),
        { status: 504 },
      );
    }
    throw error;
  }
}

export async function readBoundedResponseText(
  response: Response,
  maxBytes = DEFAULT_MCP_MAX_RESPONSE_BYTES,
): Promise<string> {
  const limit = Math.max(0, Math.floor(maxBytes));
  const contentLength = response.headers?.get("content-length");
  const declared = contentLength === null || contentLength === undefined ? null : Number(contentLength);
  if (declared !== null && Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw Object.assign(
      new Error(`Upstream response exceeded ${limit} byte limit`),
      { status: 502 },
    );
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit) {
      throw Object.assign(
        new Error(`Upstream response exceeded ${limit} byte limit`),
        { status: 502 },
      );
    }
    return text;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  let done = false;
  try {
    while (!done) {
      const chunk = await reader.read();
      done = chunk.done;
      if (done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) {
        await reader.cancel().catch(() => undefined);
        throw Object.assign(
          new Error(`Upstream response exceeded ${limit} byte limit`),
          { status: 502 },
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    if (!done) {
      await reader.cancel().catch(() => undefined);
    }
    reader.releaseLock();
  }
}

export function objectArg(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function parseJsonObject(
  value: string | null | undefined,
): Record<string, unknown> {
  if (!value) return {};
  try {
    return objectArg(JSON.parse(value));
  } catch {
    return {};
  }
}

export function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw Object.assign(new Error(`${field} is required`), { status: 400 });
  }
  return value.trim();
}
