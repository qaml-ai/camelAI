import { describe, expect, it, vi } from 'vitest';
import {
  buildRemoteMcpAuthorizationUrl,
  discoverRemoteMcpOAuth,
  exchangeRemoteMcpOAuthCode,
  registerRemoteMcpOAuthClient,
  RemoteMcpOAuthError,
  refreshRemoteMcpOAuthToken,
} from '../src/remote-mcp-oauth';

describe('remote MCP OAuth flow', () => {
  it('discovers metadata, registers dynamically, and exchanges the code with the resource parameter', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const target = String(url);
      if (target === 'https://mcp.example.com/mcp') {
        return new Response('', {
          status: 401,
          headers: {
            'www-authenticate': 'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource/mcp", scope="wiki:read"',
          },
        });
      }
      if (target === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return Response.json({
          resource: 'https://mcp.example.com/mcp',
          authorization_servers: ['https://auth.example.com/tenant'],
          scopes_supported: ['wiki:read'],
        });
      }
      if (target === 'https://auth.example.com/.well-known/oauth-authorization-server/tenant') {
        return Response.json({
          issuer: 'https://auth.example.com/tenant',
          authorization_endpoint: 'https://auth.example.com/tenant/authorize',
          token_endpoint: 'https://auth.example.com/tenant/token',
          registration_endpoint: 'https://auth.example.com/tenant/register',
        });
      }
      if (target === 'https://auth.example.com/tenant/register') {
        expect(init?.method).toBe('POST');
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          redirect_uris: ['https://app.example.com/api/integrations/remote_mcp/callback'],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          token_endpoint_auth_method: 'none',
          scope: 'wiki:read',
        });
        return Response.json({
          client_id: 'client-1',
          token_endpoint_auth_method: 'none',
        });
      }
      if (target === 'https://auth.example.com/tenant/token') {
        expect(init?.method).toBe('POST');
        const body = new URLSearchParams(String(init?.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('client_id')).toBe('client-1');
        expect(body.get('code')).toBe('code-1');
        expect(body.get('code_verifier')).toBe('verifier-1');
        expect(body.get('resource')).toBe('https://mcp.example.com/mcp');
        return Response.json({
          access_token: 'access-1',
          refresh_token: 'refresh-1',
          expires_in: 3600,
          token_type: 'Bearer',
        });
      }
      return new Response('not found', { status: 404 });
    });

    const discovery = await discoverRemoteMcpOAuth('https://mcp.example.com/mcp', fetchMock as typeof fetch);
    expect(discovery).toMatchObject({
      authorizationServer: 'https://auth.example.com/tenant',
      resource: 'https://mcp.example.com/mcp',
      scope: 'wiki:read',
    });

    const client = await registerRemoteMcpOAuthClient(
      discovery,
      'https://app.example.com/api/integrations/remote_mcp/callback',
      fetchMock as typeof fetch
    );
    expect(client.client_id).toBe('client-1');

    const authorizationUrl = new URL(buildRemoteMcpAuthorizationUrl({
      discovery,
      client,
      redirectUri: 'https://app.example.com/api/integrations/remote_mcp/callback',
      state: 'state-1',
      codeChallenge: 'challenge-1',
    }));
    expect(authorizationUrl.searchParams.get('resource')).toBe('https://mcp.example.com/mcp');
    expect(authorizationUrl.searchParams.get('code_challenge_method')).toBe('S256');

    await expect(exchangeRemoteMcpOAuthCode({
      tokenEndpoint: 'https://auth.example.com/tenant/token',
      clientId: 'client-1',
      tokenEndpointAuthMethod: 'none',
      code: 'code-1',
      redirectUri: 'https://app.example.com/api/integrations/remote_mcp/callback',
      codeVerifier: 'verifier-1',
      resource: 'https://mcp.example.com/mcp',
    }, fetchMock as typeof fetch)).resolves.toMatchObject({
      access_token: 'access-1',
      refresh_token: 'refresh-1',
    });
  });

  it('omits untrusted registration error bodies from diagnostics', async () => {
    const discovery = {
      authorizationServer: 'https://auth.example.com',
      resource: 'https://mcp.example.com/mcp',
      scope: null,
      metadata: {
        authorization_endpoint: 'https://auth.example.com/authorize',
        token_endpoint: 'https://auth.example.com/token',
        registration_endpoint: 'https://auth.example.com/register',
      },
      resourceMetadata: null,
    };
    const fetchMock = vi.fn(async () => Response.json(
      { error: 'invalid_redirect_uri' },
      { status: 400 },
    ));

    await expect(registerRemoteMcpOAuthClient(
      discovery,
      'https://app.example.com/api/integrations/remote_mcp/callback',
      fetchMock as typeof fetch,
    )).rejects.toMatchObject({
      name: 'RemoteMcpOAuthError',
      code: 'registration_failed',
      message: 'OAuth dynamic client registration failed with HTTP 400',
    });
  });

  it('includes protected resource discovery attempts when no authorization server is advertised', async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const target = String(url);
      if (target === 'https://mcp.example.com/mcp') {
        return new Response('', { status: 404, headers: { 'content-type': 'text/html' } });
      }
      if (target === 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp') {
        return new Response('<html>not found</html>', { status: 404, headers: { 'content-type': 'text/html' } });
      }
      if (target === 'https://mcp.example.com/.well-known/oauth-protected-resource') {
        return Response.json({ resource: 'https://mcp.example.com/api/ext' });
      }
      return new Response('not found', { status: 404 });
    });

    let error: unknown;
    try {
      await discoverRemoteMcpOAuth(
        'https://mcp.example.com/mcp',
        fetchMock as typeof fetch,
      );
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(RemoteMcpOAuthError);
    const remoteError = error as RemoteMcpOAuthError;
    expect(remoteError.code).toBe('discovery_failed');
    expect(remoteError.details).toMatchObject({
      serverUrl: 'https://mcp.example.com/mcp',
      candidates: [
        'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
        'https://mcp.example.com/.well-known/oauth-protected-resource',
      ],
      attempts: [
        {
          url: 'https://mcp.example.com/.well-known/oauth-protected-resource/mcp',
          status: 404,
          contentType: 'text/html',
        },
        {
          url: 'https://mcp.example.com/.well-known/oauth-protected-resource',
          status: 200,
          contentType: expect.stringContaining('application/json'),
        },
      ],
      resourceMetadata: {
        resource: 'https://mcp.example.com/api/ext',
      },
    });
  });
});

describe('remote OAuth credential boundaries', () => {
  it('rejects issuer substitution in discovered metadata', async () => {
    const mock = vi.fn(async (url: string | URL | Request) => String(url).includes('oauth-authorization-server')
      ? Response.json({ issuer: 'https://attacker.example', token_endpoint: 'https://attacker.example/token' })
      : Response.json({ resource: 'https://mcp.example/mcp', authorization_servers: ['https://auth.example'] }));
    await expect(discoverRemoteMcpOAuth('https://mcp.example/mcp', mock as typeof fetch)).rejects.toThrow('issuer');
  });
  it('does not follow refresh redirects or expose provider error descriptions', async () => {
    const mock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe('manual');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ error_description: 'secret refresh token echoed' }, { status: 307, headers: { location: 'https://attacker.example' } });
    });
    await expect(refreshRemoteMcpOAuthToken({ refresh_token: 'secret', oauth_token_endpoint: 'https://auth.example/token', oauth_client_id: 'client', oauth_resource: 'https://mcp.example' }, mock as typeof fetch)).rejects.toThrow('Remote MCP OAuth token refresh failed');
    expect(mock).toHaveBeenCalledTimes(1);
  });
  it('rejects stored private token endpoints before sending credentials', async () => {
    const mock = vi.fn();
    await expect(refreshRemoteMcpOAuthToken({ refresh_token: 'secret', oauth_token_endpoint: 'https://127.0.0.1/token', oauth_client_id: 'client', oauth_resource: 'https://mcp.example' }, mock)).rejects.toThrow('remote HTTPS');
    expect(mock).not.toHaveBeenCalled();
  });
});

it('bounds untrusted OAuth response bodies', async () => {
  const mock = vi.fn(async () => new Response('x'.repeat(1024 * 1024 + 1)));
  await expect(registerRemoteMcpOAuthClient({
    authorizationServer: 'https://auth.example', resource: 'https://mcp.example', scope: null,
    metadata: { registration_endpoint: 'https://auth.example/register' }, resourceMetadata: null,
  }, 'https://app.example/callback', mock as typeof fetch)).rejects.toThrow('size limit');
});
