/**
 * Unified cookie utilities for session management.
 */

import {
  createSignedSession,
  parseSignedSession,
  createSignedOAuthState,
  parseSignedOAuthState,
  type SignedSessionData,
  type SignedOAuthStateData,
} from './signed-session.js';

export const SESSION_HEADER = 'X-Chiridion-Session-Id';
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
export const OAUTH_STATE_COOKIE_NAME = 'chiridion_oauth_state';
export const OAUTH_STATE_MAX_AGE = 5 * 60; // 5 minutes

/**
 * Get the session cookie name for the current environment.
 * Handles subdomains like asdf.apps.staging.camelai.dev
 */
export function getSessionCookieName(hostname: string | undefined): string {
  if (!hostname) return 'chiridion_session_v3';

  const host = hostname.split(':')[0];

  if (host === 'localhost' || host === '127.0.0.1') return 'chiridion_session_local';
  if (host.endsWith('.staging.camelai.dev') || host === 'staging.camelai.dev') return 'chiridion_session_staging';
  if (host.endsWith('.dev-illiana.camelai.dev') || host === 'dev-illiana.camelai.dev') return 'chiridion_session_illiana';
  if (host.endsWith('.dev-miguel.camelai.dev') || host === 'dev-miguel.camelai.dev') return 'chiridion_session_miguel';
  if (host.endsWith('.camelai.dev') || host === 'camelai.dev') return 'chiridion_session_v3';

  return 'chiridion_session_v3';
}

/**
 * Get the cookie domain for subdomain sharing.
 */
export function getCookieDomain(hostname: string | undefined): string | undefined {
  if (!hostname) return undefined;
  const host = hostname.split(':')[0];

  if (host === 'localhost' || host === '127.0.0.1') return undefined;
  if (host.endsWith('.staging.camelai.dev') || host === 'staging.camelai.dev') return '.staging.camelai.dev';
  if (host.endsWith('.dev-illiana.camelai.dev') || host === 'dev-illiana.camelai.dev') return '.dev-illiana.camelai.dev';
  if (host.endsWith('.dev-miguel.camelai.dev') || host === 'dev-miguel.camelai.dev') return '.dev-miguel.camelai.dev';
  if (host.endsWith('.camelai.dev') || host === 'camelai.dev') return '.camelai.dev';

  return undefined;
}

function isSecure(request: Request): boolean {
  const host = request.headers.get('host')?.split(':')[0];
  if (host === 'localhost' || host === '127.0.0.1') return false;

  const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
  if (proto) return proto === 'https';
  try {
    const cf = JSON.parse(request.headers.get('cf-visitor') || '{}');
    if (cf.scheme) return cf.scheme === 'https';
  } catch {}
  return true;
}

function getHostname(request: Request): string | undefined {
  return request.headers.get('host')?.split(':')[0];
}

function buildCookie(name: string, value: string, maxAge: number, secure: boolean, domain?: string): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  let result: string | null = null;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) result = rest.join('=') || '';
  }
  return result;
}

export function getSessionIdFromRequest(request: Request): string | null {
  const header = request.headers.get(SESSION_HEADER);
  if (header) return header;

  const hostname = getHostname(request);
  return parseCookie(request.headers.get('Cookie'), getSessionCookieName(hostname));
}

export function createSessionCookie(
  sessionId: string,
  request: Request,
  maxAge: number = SESSION_MAX_AGE,
): string {
  const hostname = getHostname(request);
  return buildCookie(
    getSessionCookieName(hostname),
    sessionId,
    maxAge,
    isSecure(request),
    getCookieDomain(hostname)
  );
}

export function createDeleteSessionCookie(request: Request): string {
  const hostname = getHostname(request);
  return buildCookie(getSessionCookieName(hostname), '', 0, isSecure(request), getCookieDomain(hostname));
}

// --- Signed session cookie ---

export async function getSignedSessionFromRequest(
  request: Request,
  secret: string
): Promise<SignedSessionData | null> {
  const token = getSessionIdFromRequest(request);
  if (!token) return null;
  return parseSignedSession(secret, token);
}

export async function createSignedSessionCookie(
  sessionData: SignedSessionData,
  secret: string,
  request: Request
): Promise<string> {
  const token = await createSignedSession(secret, sessionData);
  return createSessionCookie(token, request);
}

// --- OAuth state cookie ---

export async function createOAuthStateCookie(
  stateData: SignedOAuthStateData,
  secret: string,
  request: Request
): Promise<string> {
  const token = await createSignedOAuthState(secret, stateData);
  const hostname = getHostname(request);
  return buildCookie(
    OAUTH_STATE_COOKIE_NAME,
    token,
    OAUTH_STATE_MAX_AGE,
    isSecure(request),
    getCookieDomain(hostname)
  );
}

export async function getOAuthStateFromRequest(
  request: Request,
  secret: string
): Promise<SignedOAuthStateData | null> {
  const token = parseCookie(request.headers.get('Cookie'), OAUTH_STATE_COOKIE_NAME);
  if (!token) return null;
  return parseSignedOAuthState(secret, token);
}

export function createDeleteOAuthStateCookie(request: Request): string {
  const hostname = getHostname(request);
  return buildCookie(OAUTH_STATE_COOKIE_NAME, '', 0, isSecure(request), getCookieDomain(hostname));
}

// Re-export types for convenience
export type { SignedSessionData, SignedOAuthStateData };
