/**
 * SSRF-safe outbound egress gate wired as `globalOutbound` for hosted Dynamic Workers.
 *
 * Blocks loopback, RFC1918 private ranges, cloud metadata IPs (169.254.169.254),
 * IPv6 ULA/link-local/IPv4-mapped private addresses, and non-HTTP(S) schemes,
 * while enforcing per-request outbound budgets and emitting usage telemetry.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';
import type { AppQuotaTier } from '../../../main/src/dynamic-worker-registry';
import { emitAppUsageMetric, quotaLimitsForTier, resolveQuotaTier } from './quota-policy';

export interface OutboundGateEnv {
  APP_USAGE_AE?: AnalyticsEngineDataset;
}

export interface OutboundGateProps {
  dispatchScriptName: string;
  orgId: string;
  quotaTier?: AppQuotaTier;
  maxSubrequests?: number;
}

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
  'metadata.google.internal',
  'metadata.goog',
  'metadata',
  'instance-data',
]);

const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
  '.home.arpa',
];

function parseIpv4Octets(host: string): [number, number, number, number] | null {
  // Handle single integer IPv4 (e.g. 2130706433 or 0x7f000001)
  if (/^(0x[0-9a-f]+|\d+)$/i.test(host)) {
    const num = Number(host);
    if (!Number.isInteger(num) || num < 0 || num > 0xffffffff) return null;
    return [
      (num >>> 24) & 0xff,
      (num >>> 16) & 0xff,
      (num >>> 8) & 0xff,
      num & 0xff,
    ];
  }

  const parts = host.split('.');
  if (parts.length !== 4) return null;
  const octets: number[] = [];
  for (const part of parts) {
    if (!part) return null;
    let value: number;
    if (/^0x[0-9a-f]+$/i.test(part)) {
      value = Number.parseInt(part, 16);
    } else if (/^0[0-7]+$/.test(part)) {
      value = Number.parseInt(part, 8);
    } else if (/^\d+$/.test(part)) {
      value = Number.parseInt(part, 10);
    } else {
      return null;
    }
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    octets.push(value);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isPrivateIpv4(octets: [number, number, number, number]): boolean {
  const [a, b] = octets;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local & cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 benchmark
  if (a >= 224) return true; // multicast & reserved
  return false;
}

function isPrivateIpv6(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host.includes(':')) return false;
  if (host === '::1' || host === '::' || host === '0:0:0:0:0:0:0:1' || host === '0:0:0:0:0:0:0:0') {
    return true;
  }
  // IPv4-mapped IPv6: ::ffff:127.0.0.1 or ::ffff:7f00:1
  const mappedPrefix = '::ffff:';
  if (host.startsWith(mappedPrefix)) {
    const rest = host.slice(mappedPrefix.length);
    const dotted = parseIpv4Octets(rest);
    if (dotted) return isPrivateIpv4(dotted);
    const hexParts = rest.split(':');
    if (hexParts.length === 2) {
      const hi = Number.parseInt(hexParts[0]!, 16);
      const lo = Number.parseInt(hexParts[1]!, 16);
      if (Number.isInteger(hi) && Number.isInteger(lo)) {
        return isPrivateIpv4([(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff]);
      }
    }
  }
  const firstSegment = host.split(':')[0] ?? '';
  if (firstSegment) {
    const firstWord = Number.parseInt(firstSegment, 16);
    if (Number.isInteger(firstWord)) {
      // fc00::/7 ULA
      if ((firstWord & 0xfe00) === 0xfc00) return true;
      // fe80::/10 link-local
      if ((firstWord & 0xffc0) === 0xfe80) return true;
      // ff00::/8 multicast
      if ((firstWord & 0xff00) === 0xff00) return true;
    }
  }
  return false;
}

export function classifyOutboundUrl(rawUrl: string): { allowed: true; url: URL } | { allowed: false; reason: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { allowed: false, reason: 'invalid_url' };
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { allowed: false, reason: `disallowed_scheme:${url.protocol}` };
  }

  const hostname = url.hostname.toLowerCase().replace(/\.+$/, '');
  if (!hostname) {
    return { allowed: false, reason: 'empty_hostname' };
  }

  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { allowed: false, reason: 'blocked_hostname' };
  }
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (hostname.endsWith(suffix)) {
      return { allowed: false, reason: 'blocked_hostname_suffix' };
    }
  }

  if (isPrivateIpv6(hostname)) {
    return { allowed: false, reason: 'private_ipv6' };
  }

  const ipv4 = parseIpv4Octets(hostname);
  if (ipv4 && isPrivateIpv4(ipv4)) {
    return { allowed: false, reason: 'private_ipv4' };
  }

  return { allowed: true, url };
}

export class OutboundGate extends WorkerEntrypoint<OutboundGateEnv, OutboundGateProps> {
  private requestCount = 0;

  async fetch(request: Request): Promise<Response> {
    const quotaTier = resolveQuotaTier(this.ctx.props?.quotaTier);
    const limits = quotaLimitsForTier(quotaTier);
    const maxSubrequests = this.ctx.props?.maxSubrequests ?? limits?.maxSubrequestsPerRequest ?? 0;

    if (maxSubrequests > 0 && this.requestCount >= maxSubrequests) {
      emitAppUsageMetric(this.env.APP_USAGE_AE, {
        dispatchScriptName: this.ctx.props?.dispatchScriptName ?? 'unknown',
        orgId: this.ctx.props?.orgId ?? '',
        eventKind: 'outbound_blocked',
        quotaTier,
        subrequests: this.requestCount,
        quotaTripped: true,
      });
      return new Response(
        JSON.stringify({
          error: 'Outbound subrequest budget exceeded',
          limit: maxSubrequests,
        }),
        { status: 429, headers: { 'Content-Type': 'application/json' } },
      );
    }

    const check = classifyOutboundUrl(request.url);
    if (!check.allowed) {
      emitAppUsageMetric(this.env.APP_USAGE_AE, {
        dispatchScriptName: this.ctx.props?.dispatchScriptName ?? 'unknown',
        orgId: this.ctx.props?.orgId ?? '',
        eventKind: 'outbound_blocked',
        quotaTier,
        subrequests: 1,
        quotaTripped: true,
      });
      return new Response(
        JSON.stringify({
          error: 'Outbound request blocked by platform egress policy',
          reason: check.reason,
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }

    this.requestCount += 1;
    const headers = new Headers(request.headers);
    headers.delete('x-camelai-selfhost-do-bridge');
    headers.delete('x-camelai-migration-sig');
    const init: RequestInit = {
      method: request.method,
      headers,
      redirect: request.redirect,
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = request.body;
    }
    return fetch(new Request(check.url.toString(), init));
  }
}
