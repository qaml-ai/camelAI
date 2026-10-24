import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildAuthorizationUrl, exchangeCodeForTokens, fetchUserInfo } from '../src/lib/oauth-config';

afterEach(() => vi.unstubAllGlobals());
describe('OAuth identity proof', () => {
  it.each([false, undefined, 'true'])('rejects Google verification flag %s', async (verified_email) => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'subject', email: 'victim@example.com', verified_email })));
    await expect(fetchUserInfo('google', 'token')).rejects.toThrow('verified email');
  });
  it('accepts a verified Google identity', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ id: 'subject', email: 'owner@example.com', verified_email: true })));
    await expect(fetchUserInfo('google', 'token')).resolves.toMatchObject({ providerId: 'subject', email: 'owner@example.com' });
  });
  it('does not trust the public GitHub profile email', async () => {
    const mock = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      return Response.json(url.endsWith('/emails')
        ? [{ email: 'unverified@example.com', primary: true, verified: false }, { email: 'verified@example.com', verified: true }]
        : { id: 1, email: 'unverified@example.com', login: 'user' });
    });
    vi.stubGlobal('fetch', mock);
    await expect(fetchUserInfo('github', 'token')).resolves.toMatchObject({ email: 'verified@example.com' });
    expect(mock).toHaveBeenCalledTimes(2);
  });
  it.each(['google', 'github'] as const)('binds %s authorization and token requests with PKCE', async (provider) => {
    const url = new URL(buildAuthorizationUrl(provider, 'client', 'https://app.example/callback', 'state', 'challenge'));
    expect(url.searchParams.get('code_challenge')).toBe('challenge');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      expect(init.redirect).toBe('manual');
      expect(new URLSearchParams(init.body).get('code_verifier')).toBe('verifier');
      return Response.json({ access_token: 'token' });
    }));
    await exchangeCodeForTokens(provider, 'code', 'client', 'secret', 'https://app.example/callback', 1000, 'verifier');
  });
  it('rejects provider redirects instead of following them', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example' } })));
    await expect(exchangeCodeForTokens('google', 'code', 'client', 'secret', 'https://app.example/callback')).rejects.toThrow('redirects are not allowed');
  });
  it('does not expose provider error bodies', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('secret echoed by provider', { status: 400 })));
    await expect(exchangeCodeForTokens('google', 'code', 'client', 'secret', 'https://app.example/callback')).rejects.toThrow('Token exchange failed: HTTP 400');
  });
});
