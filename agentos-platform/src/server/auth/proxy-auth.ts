export type ProxyIdentity = {
  email: string;
  name: string;
  groups?: string[];
};

export type ProxyAuthMode = "cloudflare-access" | "pomerium" | "off";
export type ProxyAuthHeaders =
  | Headers
  | Record<string, string | string[] | undefined>;

export interface ProxyAuthProvider {
  name: string;
  extractIdentity(headers: ProxyAuthHeaders): ProxyIdentity | null;
}

function headerValue(headers: ProxyAuthHeaders, name: string): string | null {
  if (headers instanceof Headers) {
    return headers.get(name);
  }
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== target || value === undefined) {
      continue;
    }
    return Array.isArray(value) ? (value[0] ?? null) : value;
  }
  return null;
}

function normalizeIdentity(
  emailValue: string | null,
  nameValue?: string | null,
  groups?: string[],
): ProxyIdentity | null {
  const email = emailValue?.trim().toLowerCase();
  if (!email) {
    return null;
  }
  const name =
    nameValue?.trim() || email.split("@")[0]?.trim() || "camelAI User";
  return groups?.length ? { email, name, groups } : { email, name };
}

function parseJwtIdentity(token: string | null): ProxyIdentity | null {
  if (!token) {
    return null;
  }
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(
      Buffer.from(parts[1], "base64url").toString("utf8"),
    );
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return null;
    }
    const claims = payload as Record<string, unknown>;
    const email = typeof claims.email === "string" ? claims.email : null;
    const name =
      typeof claims.name === "string"
        ? claims.name
        : typeof claims.common_name === "string"
          ? claims.common_name
          : null;
    const groups = Array.isArray(claims.groups)
      ? claims.groups.filter(
          (group): group is string =>
            typeof group === "string" && group.length > 0,
        )
      : undefined;
    return normalizeIdentity(email, name, groups);
  } catch {
    return null;
  }
}

function parseGroups(value: string | null): string[] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      const groups = parsed.filter(
        (group): group is string =>
          typeof group === "string" && group.trim().length > 0,
      );
      return groups.length > 0 ? groups : undefined;
    }
  } catch {
    // Pomerium may send a comma-delimited claim instead of JSON.
  }
  const groups = value
    .split(",")
    .map((group) => group.trim())
    .filter(Boolean);
  return groups.length > 0 ? groups : undefined;
}

export const cloudflareAccessProxyAuth: ProxyAuthProvider = {
  name: "cloudflare-access",
  extractIdentity(headers) {
    const email = headerValue(
      headers,
      "CF-Access-Authenticated-User-Email",
    );
    if (email) {
      return normalizeIdentity(
        email,
        headerValue(headers, "CF-Access-Authenticated-User-Name"),
      );
    }
    return parseJwtIdentity(headerValue(headers, "CF_Authorization"));
  },
};

export const pomeriumProxyAuth: ProxyAuthProvider = {
  name: "pomerium",
  extractIdentity(headers) {
    return normalizeIdentity(
      headerValue(headers, "X-Pomerium-Claim-Email") ??
        headerValue(headers, "X-Pomerium-Email"),
      headerValue(headers, "X-Pomerium-Claim-Name") ??
        headerValue(headers, "X-Pomerium-Name"),
      parseGroups(headerValue(headers, "X-Pomerium-Claim-Groups")),
    );
  },
};

export function resolveProxyAuth(
  headers: ProxyAuthHeaders,
  mode: ProxyAuthMode,
): ProxyIdentity | null {
  switch (mode) {
    case "off":
      return null;
    case "cloudflare-access":
      return cloudflareAccessProxyAuth.extractIdentity(headers);
    case "pomerium":
      return pomeriumProxyAuth.extractIdentity(headers);
    default: {
      const exhaustive: never = mode;
      throw new Error(`Unsupported proxy auth mode: ${String(exhaustive)}`);
    }
  }
}
