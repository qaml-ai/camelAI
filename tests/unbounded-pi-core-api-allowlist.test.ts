/**
 * The unbounded-pi_core-API quarantine, enforced in CI
 * (plans/sse-migration/BOUNDED-MEMORY-BY-CONSTRUCTION.md §2d).
 *
 * Lives in the node suite rather than the workers suite because it reads the
 * repository off disk, which workerd cannot do.
 */

import { describe, expect, it } from 'vitest';
import {
  ALLOWLIST,
  GUARDED_IDENTIFIERS,
  checkGuardedCallers,
  checkRepository,
} from '../scripts/check-unbounded-pi-core-callers.mjs';

describe('unbounded pi_core API quarantine', () => {
  it('the repository has no unallowlisted full-transcript callers', () => {
    expect(checkRepository()).toEqual([]);
  });

  it('fails on a synthetic NEW caller in a file that is not allowlisted', () => {
    const violations = checkGuardedCallers({
      'workers/main/src/routes/some-new-request-path.ts': `
        export async function handler(stub: any) {
          const messages = await stub.getPiCoreParsedMessages('thread-1');
          return messages.length;
        }
      `,
    });

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('some-new-request-path.ts');
    expect(violations[0]).toContain('getPiCoreParsedMessages');
    expect(violations[0]).toContain('not allowlisted');
  });

  it('fails on an EXTRA caller inside a file that is already allowlisted', () => {
    // The subtler regression, and the one a file-level allowlist would miss: a
    // path that already legitimately reads the whole transcript once grows a
    // second, unrelated read.
    const violations = checkGuardedCallers(
      {
        'workers/main/src/chat-thread/ui-mirror.ts': [
          'getPiCoreParsedMessages(threadId: string): Promise<unknown[]>;',
          'await this.deps.getPiCoreParsedMessages(threadId);',
          'const everything = await this.deps.getPiCoreParsedMessages(threadId);',
        ].join('\n'),
      },
      { 'workers/main/src/chat-thread/ui-mirror.ts': ALLOWLIST['workers/main/src/chat-thread/ui-mirror.ts'] },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('used 3x');
    expect(violations[0]).toContain('allowlist permits 2');
  });

  it('ratchets: a removed caller must lower the allowlist, not linger', () => {
    const violations = checkGuardedCallers(
      {
        'workers/main/src/chat-thread/ui-mirror.ts':
          'getPiCoreParsedMessages(threadId: string): Promise<unknown[]>;',
      },
      { 'workers/main/src/chat-thread/ui-mirror.ts': ALLOWLIST['workers/main/src/chat-thread/ui-mirror.ts'] },
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('A caller was removed');
  });

  it('ignores mentions in comments, so documentation stays free', () => {
    const violations = checkGuardedCallers({
      'workers/main/src/routes/documented.ts': [
        '// Do not call getPiCoreParsedMessages from a request path.',
        ' * {@link loadFullPiCoreTranscriptUnbounded} is the unbounded read.',
        '/* getPiCoreParsedMessages is the export surface. */',
      ].join('\n'),
    });

    expect(violations).toEqual([]);
  });

  it('guards every unbounded primitive, not just the one that hurt most recently', () => {
    expect(GUARDED_IDENTIFIERS).toEqual(
      expect.arrayContaining([
        'loadFullPiCoreTranscriptUnbounded',
        'loadFullPiCoreParsedTranscriptUnbounded',
        'getPiCoreParsedMessages',
      ]),
    );
  });

  it('every allowlist entry carries a written reason', () => {
    for (const [file, byIdentifier] of Object.entries(ALLOWLIST)) {
      for (const [identifier, entry] of Object.entries(byIdentifier as Record<string, { count: number; why: string }>)) {
        expect(
          typeof entry.why === 'string' && entry.why.length > 40,
          `${file}:${identifier} needs a real justification, not a placeholder`,
        ).toBe(true);
        expect(entry.count).toBeGreaterThan(0);
      }
    }
  });
});
