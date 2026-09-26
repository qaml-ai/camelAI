/**
 * Response helper functions
 */

import { SESSION_MAX_AGE, getCookieDomain, getSessionCookieName } from '../cookies.js';

function buildCookie(name: string, value: string, maxAge: number, secure: boolean, domain?: string): string {
  const parts = [`${name}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure) parts.push('Secure');
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export function redirect(url: string, sessionId?: string, secure = true, hostname?: string): Response {
  const headers = new Headers({ Location: url });
  if (sessionId) {
    const domain = getCookieDomain(hostname);
    const cookieName = getSessionCookieName(hostname);
    headers.append('Set-Cookie', buildCookie(cookieName, sessionId, SESSION_MAX_AGE, secure, domain));
  }
  return new Response(null, { status: 302, headers });
}

export const text = (body: string, status = 200) => new Response(body, { status });
