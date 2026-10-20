import { describe, expect, it } from 'vitest';
import { normalizeIntegrationTokens, stripAuthScheme } from '@/lib/integration-token';

describe('pasted MCP tokens', () => {
  it.each([' Bearer   ghp_example ', ' TOKEN\tghp_example ', 'bEaReR token ghp_example', 'ghp_example'])('normalizes %s', (value) => {
    expect(stripAuthScheme(value)).toBe('ghp_example');
  });
  it('preserves opaque custom header values and unrelated credentials', () => {
    const credentials = { token: 'Bearer opaque', client_secret: 'token opaque' };
    expect(normalizeIntegrationTokens('remote_mcp', { auth_type: 'custom_header' }, credentials)).toEqual(credentials);
    expect(normalizeIntegrationTokens('other', {}, credentials)).toEqual(credentials);
  });
});
