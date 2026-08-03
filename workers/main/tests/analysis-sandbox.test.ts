import { describe, expect, it, vi } from 'vitest';
import { InvalidMountConfigError, S3FSMountError } from '@cloudflare/sandbox';
import {
  createSingleFlight,
  isMountAlreadyPresent,
  mountAllowsList,
  mountOrRecover,
  type MountRecoverTarget,
} from '../src/analysis-sandbox.js';

describe('isMountAlreadyPresent', () => {
  it('treats nonempty / busy s3fs mount errors as already-mounted', () => {
    // The warm-container remount symptom: the prefix is already mounted at the
    // kernel level and s3fs reports the mountpoint busy / nonempty.
    const error = new S3FSMountError('S3FS mount failed: s3fs: MOUNTPOINT directory /warehouse/ws_1 is not empty');
    expect(isMountAlreadyPresent(error)).toBe(true);
    expect(
      isMountAlreadyPresent(new S3FSMountError('S3FS mount failed: fuse: mountpoint is busy')),
    ).toBe(true);
  });

  it('does NOT swallow unrelated S3FSMountError variants (auth / network)', () => {
    expect(
      isMountAlreadyPresent(new S3FSMountError('S3FS mount failed: 403 AccessDenied')),
    ).toBe(false);
    expect(
      isMountAlreadyPresent(new S3FSMountError('S3FS mount failed: unable to connect')),
    ).toBe(false);
  });

  it('treats the SDK "mount path already in use" config error as already-mounted', () => {
    // A concurrent ensureExportsMounted already registered the path in the SDK's
    // in-memory mount registry, so a second mount of it is rejected.
    const error = new InvalidMountConfigError(
      'Mount path "/warehouse/ws_1" is already in use by bucket "WAREHOUSE_EXPORT_BUCKET". Unmount the existing bucket first or use a different mount path.',
    );
    expect(isMountAlreadyPresent(error)).toBe(true);
  });

  it('does NOT swallow other InvalidMountConfigError variants (different prefix / bad config)', () => {
    expect(isMountAlreadyPresent(new InvalidMountConfigError(
      'R2 binding "WAREHOUSE_EXPORT_BUCKET" is already mounted at /warehouse/ws_1 with a different prefix.',
    ))).toBe(false);
    expect(isMountAlreadyPresent(new InvalidMountConfigError('Invalid bucket name: "Bad Name".'))).toBe(false);
  });

  it('does not swallow other errors (genuine mount/config failures)', () => {
    expect(isMountAlreadyPresent(new Error('R2 binding not found in Worker env'))).toBe(false);
    expect(isMountAlreadyPresent(new Error('permission denied'))).toBe(false);
    expect(isMountAlreadyPresent('not even an error')).toBe(false);
    expect(isMountAlreadyPresent(undefined)).toBe(false);
  });
});

describe('mountOrRecover', () => {
  const options = { prefix: '/uploads-prefix', readOnly: true as const };

  function makeTarget(overrides: Partial<MountRecoverTarget> = {}): MountRecoverTarget & {
    mounts: string[];
    unmounts: string[];
  } {
    const mounts: string[] = [];
    const unmounts: string[] = [];
    return {
      mounts,
      unmounts,
      async mountBucket(_bucket, mountPath) {
        mounts.push(mountPath);
      },
      async unmountBucket(mountPath) {
        unmounts.push(mountPath);
      },
      async exec() {
        return { exitCode: 0, stdout: 'ok', stderr: '' };
      },
      ...overrides,
    };
  }

  it('returns after a clean first mount', async () => {
    const target = makeTarget();
    await mountOrRecover(target, 'R2_BUCKET', '/uploads', options);
    expect(target.mounts).toEqual(['/uploads']);
    expect(target.unmounts).toEqual([]);
  });

  it('unmounts and remounts when the first attempt hits nonempty mountpoint', async () => {
    const target = makeTarget();
    let attempts = 0;
    target.mountBucket = async (_bucket, mountPath) => {
      attempts += 1;
      target.mounts.push(mountPath);
      if (attempts === 1) {
        throw new S3FSMountError(
          'S3FS mount failed: s3fs: MOUNTPOINT directory /uploads is not empty',
        );
      }
    };

    await mountOrRecover(target, 'R2_BUCKET', '/uploads', options);
    expect(target.unmounts).toEqual(['/uploads']);
    expect(attempts).toBe(2);
  });

  it('fails loudly when remount is still blocked and the mount cannot list', async () => {
    const target = makeTarget({
      async mountBucket() {
        throw new S3FSMountError(
          'S3FS mount failed: s3fs: MOUNTPOINT directory /uploads is not empty',
        );
      },
      async exec() {
        return { exitCode: 2, stdout: '', stderr: 'ls: Input/output error' };
      },
    });

    await expect(mountOrRecover(target, 'R2_BUCKET', '/uploads', options)).rejects.toThrow(
      /not readable \(I\/O error\)/,
    );
    expect(target.unmounts).toEqual(['/uploads']);
  });

  it('accepts a still-present mount when directory listing works after remount failure', async () => {
    const target = makeTarget({
      async mountBucket() {
        throw new S3FSMountError(
          'S3FS mount failed: s3fs: MOUNTPOINT directory /uploads is not empty',
        );
      },
      async exec() {
        return { exitCode: 0, stdout: 'drwxr-xr-x 1 root root 0 /uploads', stderr: '' };
      },
    });

    await expect(mountOrRecover(target, 'R2_BUCKET', '/uploads', options)).resolves.toBeUndefined();
  });

  it('rethrows genuine mount failures without attempting recovery', async () => {
    const target = makeTarget({
      async mountBucket() {
        throw new S3FSMountError('S3FS mount failed: 403 AccessDenied');
      },
    });
    await expect(mountOrRecover(target, 'R2_BUCKET', '/uploads', options)).rejects.toBeInstanceOf(
      S3FSMountError,
    );
    expect(target.unmounts).toEqual([]);
  });
});

describe('mountAllowsList', () => {
  it('rejects unsafe mount paths', async () => {
    expect(await mountAllowsList({ exec: vi.fn() }, '/uploads/../etc')).toBe(false);
    expect(await mountAllowsList({ exec: vi.fn() }, 'uploads')).toBe(false);
  });

  it('returns false on I/O errors in ls output', async () => {
    expect(
      await mountAllowsList(
        {
          async exec() {
            return { exitCode: 0, stdout: '', stderr: 'Input/output error' };
          },
        },
        '/uploads',
      ),
    ).toBe(false);
  });
});

describe('createSingleFlight', () => {
  it('coalesces concurrent callers onto a single run', async () => {
    let runs = 0;
    let release!: () => void;
    const gate = createSingleFlight();
    const run = () =>
      new Promise<void>((resolve) => {
        runs++;
        release = resolve;
      });

    // Two callers race before the first run settles.
    const a = gate(run);
    const b = gate(run);
    expect(runs).toBe(1); // only one run actually started
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });

  it('caches success — later callers never re-run', async () => {
    let runs = 0;
    const gate = createSingleFlight();
    const run = async () => { runs++; };
    await gate(run);
    await gate(run);
    await gate(run);
    expect(runs).toBe(1);
  });

  it('does not cache failure — the next call retries', async () => {
    let runs = 0;
    const gate = createSingleFlight();
    const run = async () => {
      runs++;
      if (runs === 1) throw new Error('boom');
    };
    await expect(gate(run)).rejects.toThrow('boom');
    await gate(run); // retries and succeeds
    expect(runs).toBe(2);
    await gate(run); // now cached — no further runs
    expect(runs).toBe(2);
  });
});
