export interface BindingFacadeFetcher {
  fetch(request: Request): Promise<Response>;
}

export class BindingFacadeError extends Error {
  readonly status: number;
  readonly capability: string;

  constructor(capability: string, status: number, message: string) {
    super(message);
    this.name = "BindingFacadeError";
    this.status = status;
    this.capability = capability;
  }
}

const FACADE_ORIGIN = "https://camelai-binding-facade.invalid";

export function bindingFacadeUrl(
  capability: string,
  path = "",
  search?: Record<string, string | number | boolean | undefined>,
): URL {
  const normalizedCapability = normalizeSegment(capability, "capability");
  const normalizedPath = path
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  const url = new URL(
    `/v1/${normalizedCapability}${normalizedPath ? `/${normalizedPath}` : ""}`,
    FACADE_ORIGIN,
  );
  for (const [name, value] of Object.entries(search ?? {})) {
    if (value !== undefined) url.searchParams.set(name, String(value));
  }
  return url;
}

export async function bindingFacadeFetch(
  fetcher: BindingFacadeFetcher,
  capability: string,
  path: string,
  init?: RequestInit,
  search?: Record<string, string | number | boolean | undefined>,
): Promise<Response> {
  const response = await fetcher.fetch(
    new Request(bindingFacadeUrl(capability, path, search), init),
  );
  if (response.ok) return response;
  throw await bindingFacadeResponseError(capability, response);
}

export async function bindingFacadeJson<T>(
  fetcher: BindingFacadeFetcher,
  capability: string,
  path: string,
  init?: RequestInit,
  search?: Record<string, string | number | boolean | undefined>,
): Promise<T> {
  const response = await bindingFacadeFetch(
    fetcher,
    capability,
    path,
    init,
    search,
  );
  return readJsonResponse<T>(capability, response);
}

export async function readJsonResponse<T>(
  capability: string,
  response: Response,
): Promise<T> {
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new BindingFacadeError(
      capability,
      502,
      `${capability} facade returned invalid JSON`,
    );
  }
}

export async function bindingFacadeResponseError(
  capability: string,
  response: Response,
): Promise<BindingFacadeError> {
  const text = await response.text().catch(() => "");
  let message = text.trim();
  if (message) {
    try {
      const parsed = JSON.parse(message) as { error?: unknown; message?: unknown };
      message =
        (typeof parsed.error === "string" && parsed.error) ||
        (typeof parsed.message === "string" && parsed.message) ||
        message;
    } catch {
      // The plain response text is already the most useful error.
    }
  }
  return new BindingFacadeError(
    capability,
    response.status,
    message || `${capability} facade returned ${response.status}`,
  );
}

export function jsonRequest(value: unknown, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json");
  return { ...init, headers, body: JSON.stringify(value) };
}

function normalizeSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || !/^[a-z0-9][a-z0-9-]*$/i.test(normalized)) {
    throw new TypeError(`Invalid binding facade ${label}: ${value}`);
  }
  return normalized;
}
