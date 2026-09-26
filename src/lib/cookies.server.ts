/**
 * Cookie utilities for React Router routes.
 */

import { parse } from 'cookie';
import {
  SESSION_MAX_AGE,
  getSessionIdFromRequest as getSessionIdFromRequestBase,
  getSignedSessionFromRequest as getSignedSessionFromRequestBase,
  createSignedSessionCookie as createSignedSessionCookieBase,
  createSessionCookie,
  createDeleteSessionCookie,
  type SignedSessionData,
} from '../../workers/main/src/cookies';

export { SESSION_MAX_AGE };
export type { SignedSessionData };

export function getSessionIdFromRequest(request: Request): string | null {
  return getSessionIdFromRequestBase(request);
}

export function parseCookies(request: Request): Record<string, string | undefined> {
  const cookieHeader = request.headers.get('Cookie');
  return cookieHeader ? parse(cookieHeader) : {};
}

export function getCookie(request: Request, name: string): string | null {
  const cookies = parseCookies(request);
  return cookies[name] || null;
}

export function createSessionCookieHeader(
  sessionId: string,
  request: Request,
  maxAge?: number,
): string {
  return createSessionCookie(sessionId, request, maxAge);
}

export function getRemainingSessionCookieMaxAge(
  session: Pick<SignedSessionData, "expires_at">,
): number | undefined {
  if (typeof session.expires_at !== "number") return undefined;
  return Math.max(1, Math.ceil((session.expires_at - Date.now()) / 1000));
}

export function createDeleteSessionCookieHeader(request: Request): string {
  return createDeleteSessionCookie(request);
}

// --- Signed session helpers ---

export async function getSignedSessionFromRequest(
  request: Request,
  secret: string
): Promise<SignedSessionData | null> {
  return getSignedSessionFromRequestBase(request, secret);
}

export async function createSignedSessionCookieHeader(
  sessionData: SignedSessionData,
  secret: string,
  request: Request
): Promise<string> {
  return createSignedSessionCookieBase(sessionData, secret, request);
}
