import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import routes from '@/routes';
import { loader as signupDotLoader } from '@/routes/signup-dot';

type RouteNode = {
  path?: string;
  file?: string;
  children?: RouteNode[];
};

function findRoute(nodes: RouteNode[], path: string): RouteNode | undefined {
  for (const node of nodes) {
    if (node.path === path) return node;
    const child = node.children ? findRoute(node.children, path) : undefined;
    if (child) return child;
  }
  return undefined;
}

describe('low-noise public routes', () => {
  it('serves a valid robots.txt static asset', async () => {
    const robots = await readFile(`${process.cwd()}/public/robots.txt`, 'utf8');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
  });

  it('redirects the exact /signup. typo to /signup and preserves the query', async () => {
    expect(findRoute(routes as RouteNode[], 'signup.')).toMatchObject({
      file: 'routes/signup-dot.ts',
    });

    const response = await signupDotLoader({
      request: new Request('https://camelai.dev/signup.?ref=invite'),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('/signup?ref=invite');
  });
});
