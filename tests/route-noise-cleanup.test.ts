import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

describe('low-noise public routes', () => {
  it('serves a valid robots.txt static asset', async () => {
    const robots = await readFile(`${process.cwd()}/public/robots.txt`, 'utf8');
    expect(robots).toMatch(/^User-agent: \*$/m);
    expect(robots).toMatch(/^Allow: \/$/m);
  });
});
