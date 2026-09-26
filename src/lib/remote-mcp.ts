
export const REMOTE_MCP_AUTH_TYPES = ['none', 'bearer', 'custom_header', 'oauth'] as const;

const LOCAL_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
]);

function parseIPv4(hostname: string): number[] | null {
  const parts = hostname.split('.');
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d+$/.test(part)) return Number.NaN;
    return Number.parseInt(part, 10);
  });
  if (octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets;
}

function isPrivateIPv4(octets: number[]): boolean {
  const [a, b] = octets;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function isLocalHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/\.$/, '');
  return (
    LOCAL_HOSTNAMES.has(normalized) ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local') ||
    normalized.endsWith('.internal')
  );
}

function isBlockedIPv6(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    normalized === '::1' ||
    normalized === '::' ||
    normalized.startsWith('::ffff:') ||
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe80:')
  );
}

export function validateRemoteMcpUrl(rawUrl: unknown): string[] {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return ['Server URL is required'];
  }

  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    return ['Server URL must be a valid URL'];
  }

  if (url.protocol !== 'https:') {
    return ['Remote MCP server URL must use HTTPS'];
  }
  if (url.username || url.password) {
    return ['Server URL must not include embedded credentials'];
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isLocalHostname(hostname)) {
    return ['Remote MCP server URL must not point to a local hostname'];
  }

  const ipv4 = parseIPv4(hostname);
  if (ipv4 && isPrivateIPv4(ipv4)) {
    return ['Remote MCP server URL must not point to a private, loopback, or link-local IP address'];
  }
  if (hostname.includes(':') && isBlockedIPv6(hostname)) {
    return ['Remote MCP server URL must not point to a private, loopback, or link-local IP address'];
  }

  return [];
}

export function validateRemoteMcpConnection(
  config: Record<string, unknown>,
  credentials: Record<string, unknown> = {}
): string[] {
  const errors = validateRemoteMcpUrl(config.server_url);
  const authType = typeof config.auth_type === 'string' ? config.auth_type : 'none';

  if (!REMOTE_MCP_AUTH_TYPES.includes(authType as (typeof REMOTE_MCP_AUTH_TYPES)[number])) {
    errors.push('Authentication type is invalid');
  }
  if (authType === 'custom_header') {
    const header = typeof config.auth_header === 'string' ? config.auth_header.trim() : '';
    if (!header) {
      errors.push('Custom auth header name is required');
    } else if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) {
      errors.push('Custom auth header name is invalid');
    }
  }
  if (
    (authType === 'bearer' || authType === 'custom_header') &&
    (typeof credentials.token !== 'string' || !credentials.token.trim())
  ) {
    errors.push('Token is required');
  }

  return errors;
}

export function normalizeRemoteMcpUrl(rawUrl: string): string {
  const url = new URL(rawUrl.trim());
  url.hash = '';
  return url.toString();
}
