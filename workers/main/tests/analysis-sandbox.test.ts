import { describe, expect, it, vi } from 'vitest';
import { getSandbox, InvalidMountConfigError, S3FSMountError } from '@cloudflare/sandbox';
import {
  AnalysisSandbox,
  createSingleFlight,
  forceUnmountCommand,
  isMountSessionTimeout,
  isMountAlreadyPresent,
  mountAllowsList,
  mountOrRecover,
  sandboxR2MountOptions,
  sandboxR2MountPath,
  SandboxMountSessionTimeoutError,
  SANDBOX_SESSIONLESS_TOKEN,
  UnreadableR2MountError,
  waitForWritableLocalMount,
  type MountRecoverTarget,
} from '../src/analysis-sandbox.js';
import { ANALYSIS_SANDBOX_OPTIONS } from '../src/analysis-service.js';
import { DbQuerySandbox } from '../src/db-query-sandbox.js';
import {
  createSandboxZombieHealState,
  SandboxSessionDeathTracker,
} from '../src/sandbox-zombie-recovery.js';

describe('sandboxR2MountOptions', () => {
  const options = {
    prefix: '/warehouse/ws-1',
    readOnly: false,
    s3fsOptions: ['stat_cache_expire=1'],
  };

  it('uses FUSE-free local R2 synchronization for self-host', () => {
    expect(sandboxR2MountOptions({ CF_ACCOUNT_ID: 'selfhost' }, options)).toEqual({
      localBucket: true,
      prefix: '/warehouse/ws-1',
      readOnly: false,
    });
  });

  it('keeps credential-less s3fs options on Cloudflare', () => {
    expect(sandboxR2MountOptions({ CF_ACCOUNT_ID: 'cloudflare-account' }, options)).toEqual(options);
  });

  it('uses local R2 synchronization through the actual AnalysisSandbox mount path', async () => {
    const sandbox = Object.create(AnalysisSandbox.prototype) as any;
    sandbox.env = { CF_ACCOUNT_ID: 'selfhost' };
    sandbox.mountedPaths = new Set<string>();
    sandbox.mountGates = new Map();
    sandbox.mountBucket = vi.fn(async () => undefined);
    sandbox.unmountBucket = vi.fn(async () => undefined);
    sandbox.exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await AnalysisSandbox.prototype.ensureMounted.call(
      sandbox,
      'R2_BUCKET',
      'org1/workspace1/uploads',
      '/uploads',
      { readOnly: true },
    );

    expect(sandbox.mountBucket).toHaveBeenCalledWith('R2_BUCKET', '/uploads', {
      localBucket: true,
      prefix: '/org1/workspace1/uploads',
      readOnly: true,
    });
  });
});

describe('AnalysisSandbox sessionless exec', () => {
  /**
   * The DO-side override passes the SDK's sessionless token by value, because
   * 0.12.x does not export it. Pin it against what `getSandbox` actually sends
   * for `enableDefaultSession: false`, so an SDK rename fails here instead of
   * silently creating a session literally named "__DISABLE_SESSION__".
   */
  it('uses the same token getSandbox sends for enableDefaultSession: false', async () => {
    const stub = {
      exec: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
      execWithSessionToken: vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' })),
    };
    const namespace = {
      idFromName: (name: string) => ({ name, toString: () => name }),
      get: () => stub,
    };
    const sandbox = getSandbox(namespace as never, 'ws-1', ANALYSIS_SANDBOX_OPTIONS);

    await sandbox.exec('python main.py', { cwd: '/scratch/x', timeout: 1_000 });

    expect(stub.exec).not.toHaveBeenCalled();
    expect(stub.execWithSessionToken).toHaveBeenCalledWith(
      'python main.py',
      SANDBOX_SESSIONLESS_TOKEN,
      { cwd: '/scratch/x', timeout: 1_000 },
    );
  });

  it('runs DO-side execs (mount probe, forced unmount) sessionless', async () => {
    const { sandbox } = healableSandbox();
    sandbox.execWithSessionToken = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await AnalysisSandbox.prototype.exec.call(sandbox, 'ls -la -- /uploads >/dev/null', { timeout: 15_000 });

    expect(sandbox.execWithSessionToken).toHaveBeenCalledWith(
      'ls -la -- /uploads >/dev/null',
      SANDBOX_SESSIONLESS_TOKEN,
      { timeout: 15_000 },
    );
  });
});

/**
 * Swap the SDK base-class `onStop` for a spy while `run` executes. `super.onStop`
 * resolves through the subclass prototype's own prototype, so that is what gets
 * stubbed — and restored, since it is shared module state.
 */
async function withStubbedSuperOnStop(
  cls: { prototype: object },
  stub: () => Promise<void>,
  run: () => Promise<void>,
): Promise<void> {
  const base = Object.getPrototypeOf(cls.prototype) as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(base, 'onStop');
  Object.defineProperty(base, 'onStop', { value: stub, configurable: true, writable: true });
  try {
    await run();
  } finally {
    if (original) Object.defineProperty(base, 'onStop', original);
    else delete base.onStop;
  }
}

describe('mount bookkeeping across a container stop', () => {
  /**
   * `onStop` fires on the SURVIVING DO instance (that is what the hook is for),
   * and the SDK clears its own `activeMounts` there. The subclass Set tracked
   * the same container-level state but was never cleared, so after a container
   * restart `ensureMounted`/`ensureWarehouseExportMount` short-circuited against
   * empty mount points — a run then read an empty `/exports` and returned exit 0.
   */
  it('AnalysisSandbox forgets its mounts so the next ensureMounted re-mounts', async () => {
    const sandbox = Object.create(AnalysisSandbox.prototype) as any;
    sandbox.mountedPaths = new Set(['/exports', '/uploads']);
    sandbox.mountGates = new Map([['/exports', createSingleFlight()]]);
    sandbox.sessionDeaths = new SandboxSessionDeathTracker();
    const superOnStop = vi.fn(async () => {});
    await withStubbedSuperOnStop(AnalysisSandbox, superOnStop, () =>
      AnalysisSandbox.prototype.onStop.call(sandbox));

    expect(sandbox.mountedPaths.size).toBe(0);
    expect(sandbox.mountGates.size).toBe(0);
    // The SDK's own teardown still runs.
    expect(superOnStop).toHaveBeenCalledTimes(1);
  });

  it('DbQuerySandbox has the identical reset (same pattern, same hazard)', async () => {
    const sandbox = Object.create(DbQuerySandbox.prototype) as any;
    sandbox.mountedPaths = new Set(['/warehouse/ws-1']);
    sandbox.mountGates = new Map([['/warehouse/ws-1', createSingleFlight()]]);
    const superOnStop = vi.fn(async () => {});
    await withStubbedSuperOnStop(DbQuerySandbox, superOnStop, () =>
      DbQuerySandbox.prototype.onStop.call(sandbox));

    expect(sandbox.mountedPaths.size).toBe(0);
    expect(sandbox.mountGates.size).toBe(0);
    expect(superOnStop).toHaveBeenCalledTimes(1);
  });
});

const SESSION_DEATH = () =>
  Object.assign(
    new Error("Session 'sandbox-ws-1' ended because its shell exited (exit code: 128)"),
    { name: 'SessionTerminatedError' },
  );

/** Bare AnalysisSandbox instance with just the DO surface the heal touches. */
/** `[event, status]` of every observability data point the sandbox wrote. */
function recordedEvents(sandbox: any): Array<[string, string]> {
  return sandbox.env.OBSERVABILITY_EVENTS.writeDataPoint.mock.calls.map(
    ([point]: [{ blobs: string[] }]) => [point.blobs[0], point.blobs[4]],
  );
}

function healableSandbox() {
  const store = new Map<string, number>();
  const deleted: string[] = [];
  const destroy = vi.fn(async () => {});
  const sandbox = Object.create(AnalysisSandbox.prototype) as any;
  sandbox.ctx = {
    container: { running: true },
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: number) => { store.set(key, value); },
      delete: async (key: string) => { deleted.push(key); },
    },
  };
  sandbox.env = {
    CF_ACCOUNT_ID: 'cloudflare-account',
    OBSERVABILITY_EVENTS: { writeDataPoint: vi.fn() },
    ERROR_ANALYTICS: { writeDataPoint: vi.fn() },
  };
  sandbox.destroy = destroy;
  sandbox.sessionDeaths = new SandboxSessionDeathTracker();
  sandbox.zombieHealState = createSandboxZombieHealState();
  sandbox.mountedPaths = new Set<string>();
  sandbox.mountGates = new Map();
  return { sandbox, destroy, deleted };
}

describe('AnalysisSandbox zombie self-heal', () => {
  /**
   * A single stray death must not cost a 30-120s cold boot plus a re-mount;
   * two in a row is zombie evidence.
   */
  it('lets the first session death through and destroys only on the second', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox, destroy } = healableSandbox();
      sandbox.mountedPaths = new Set(['/uploads']);
      sandbox.execWithSessionToken = vi.fn(async () => { throw SESSION_DEATH(); });

      await expect(AnalysisSandbox.prototype.exec.call(sandbox, 'python main.py')).rejects.toThrow();
      expect(destroy).not.toHaveBeenCalled();
      expect(sandbox.mountedPaths.has('/uploads')).toBe(true);

      await expect(AnalysisSandbox.prototype.exec.call(sandbox, 'python main.py')).rejects.toThrow();
      expect(destroy).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * `destroy()` does not synchronously run `onStop`, so without the
   * post-destroy hook `mountedPaths` keeps claiming mounts that died with the
   * container and the very next `ensureMounted` short-circuits — the run then
   * reads an empty `/exports` and exits 0.
   */
  it('drops mount bookkeeping when the heal destroys the container', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox, destroy } = healableSandbox();
      sandbox.mountedPaths = new Set(['/warehouse/ws-1', '/uploads', '/outputs']);
      sandbox.mountGates = new Map([['/uploads', createSingleFlight()]]);

      await AnalysisSandbox.prototype.restartZombieContainer.call(sandbox, {
        operation: 'exec',
        trigger: 'exec_session_death',
      });

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(sandbox.mountedPaths.size).toBe(0);
      expect(sandbox.mountGates.size).toBe(0);

      // Proof of the consequence: the next ensureMounted really mounts again.
      sandbox.mountBucket = vi.fn(async () => undefined);
      sandbox.unmountBucket = vi.fn(async () => undefined);
      sandbox.exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
      await AnalysisSandbox.prototype.ensureMounted.call(
        sandbox,
        'R2_BUCKET',
        'org1/workspace1/uploads',
        '/uploads',
        { readOnly: true },
      );
      expect(sandbox.mountBucket).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('ignores mount bookkeeping recorded under an older container generation', async () => {
    const { sandbox } = healableSandbox();
    sandbox.mountedPaths = new Set(['/uploads']);
    sandbox.mountedContainerGeneration = 0;
    // The SDK bumps this on every container stop.
    sandbox.containerGeneration = 1;
    sandbox.mountBucket = vi.fn(async () => undefined);
    sandbox.unmountBucket = vi.fn(async () => undefined);
    sandbox.exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await AnalysisSandbox.prototype.ensureMounted.call(
      sandbox,
      'R2_BUCKET',
      'org1/workspace1/uploads',
      '/uploads',
      { readOnly: true },
    );

    expect(sandbox.mountBucket).toHaveBeenCalledTimes(1);
  });

  it('remounts an AnalysisSandbox mount when its cached path becomes unreadable', async () => {
    const sandbox = Object.create(AnalysisSandbox.prototype) as any;
    sandbox.env = { CF_ACCOUNT_ID: 'cloudflare-account' };
    sandbox.containerGeneration = 1;
    sandbox.mountedContainerGeneration = 1;
    sandbox.mountedPaths = new Set<string>();
    sandbox.mountGates = new Map();
    sandbox.mountBucket = vi.fn(async () => undefined);
    sandbox.unmountBucket = vi.fn(async () => undefined);
    sandbox.exec = vi.fn(async () => ({
      exitCode: 0,
      stdout: '',
      stderr: 'ls: /uploads: Input/output error',
    }));

    await AnalysisSandbox.prototype.ensureMounted.call(
      sandbox,
      'R2_BUCKET',
      'org1/workspace1/uploads',
      '/uploads',
      { readOnly: true },
    );
    await AnalysisSandbox.prototype.ensureMounted.call(
      sandbox,
      'R2_BUCKET',
      'org1/workspace1/uploads',
      '/uploads',
      { readOnly: true },
    );

    expect(sandbox.exec).toHaveBeenCalledWith('ls -la -- /uploads >/dev/null', { timeout: 15_000 });
    expect(sandbox.mountBucket).toHaveBeenCalledTimes(2);
  });

  it('recreates the container once when unmount/remount cannot clear mount EIO', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox } = healableSandbox();
      sandbox.containerGeneration = 1;
      sandbox.mountedContainerGeneration = 1;
      sandbox.mountedPaths = new Set(['/warehouse/ws-1']);
      sandbox.mountGates = new Map();
      let destroyed = false;
      sandbox.destroy = vi.fn(async () => { destroyed = true; });
      sandbox.unmountBucket = vi.fn(async () => undefined);
      sandbox.mountBucket = vi.fn(async () => {
        if (!destroyed) {
          throw new S3FSMountError(
            'S3FS mount failed: s3fs: MOUNTPOINT directory /warehouse/ws-1 is not empty',
          );
        }
      });
      sandbox.exec = vi.fn(async () => destroyed
        ? { exitCode: 0, stdout: '', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'ls: Input/output error' });

      await AnalysisSandbox.prototype.ensureMounted.call(
        sandbox,
        'WAREHOUSE_EXPORT_BUCKET',
        'warehouse/ws-1',
      );

      expect(sandbox.destroy).toHaveBeenCalledTimes(1);
      // mount, remount (the forced detach fails in this container, so no third
      // attempt there), then the mount on the fresh container.
      expect(sandbox.mountBucket).toHaveBeenCalledTimes(3);
      expect(sandbox.mountedPaths.has('/warehouse/ws-1')).toBe(true);
      // The forced restart, then the mount recovery it produced.
      expect(recordedEvents(sandbox)).toEqual([
        ['build_sandbox_zombie_restart', 'restarted'],
        ['sandbox_mount_recovery', 'restarted'],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('remounts DbQuerySandbox exports after a generation change or failed health check', async () => {
    const sandbox = Object.create(DbQuerySandbox.prototype) as any;
    sandbox.env = { CF_ACCOUNT_ID: 'cloudflare-account' };
    sandbox.containerGeneration = 1;
    sandbox.mountedContainerGeneration = 0;
    sandbox.mountedPaths = new Set(['/warehouse/ws-1']);
    sandbox.mountGates = new Map([['/warehouse/ws-1', createSingleFlight()]]);
    sandbox.mountBucket = vi.fn(async () => undefined);
    sandbox.unmountBucket = vi.fn(async () => undefined);
    sandbox.exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await DbQuerySandbox.prototype.ensureWarehouseExportMount.call(
      sandbox,
      'warehouse/ws-1',
    );
    expect(sandbox.mountBucket).toHaveBeenCalledTimes(1);

    sandbox.exec.mockResolvedValue({
      exitCode: 1,
      stdout: '',
      stderr: 'ls: Input/output error',
    });
    await DbQuerySandbox.prototype.ensureWarehouseExportMount.call(
      sandbox,
      'warehouse/ws-1',
    );
    expect(sandbox.mountBucket).toHaveBeenCalledTimes(2);
  });
});

describe('sandboxR2MountPath', () => {
  it('relocates writable local sync beneath /workspace', () => {
    expect(sandboxR2MountPath('/outputs', {
      localBucket: true,
      prefix: '/outputs',
      readOnly: false,
    })).toBe('/workspace/.camelai-mounts/outputs');
  });

  it('keeps read-only local and Cloudflare mount paths unchanged', () => {
    expect(sandboxR2MountPath('/warehouse/ws', {
      localBucket: true,
      prefix: '/warehouse/ws',
      readOnly: true,
    })).toBe('/warehouse/ws');
    expect(sandboxR2MountPath('/outputs', {
      prefix: '/outputs',
      readOnly: false,
    })).toBe('/outputs');
  });
});

describe('waitForWritableLocalMount', () => {
  it('rewrites until container changes reach R2, then removes its sentinel', async () => {
    const writes: string[] = [];
    const deletedFiles: string[] = [];
    const deletedKeys: string[] = [];
    let heads = 0;
    const target = {
      async writeFile(path: string) { writes.push(path); },
      async deleteFile(path: string) { deletedFiles.push(path); },
    };
    const bucket = {
      async head() { heads += 1; return heads >= 2 ? {} : null; },
      async delete(key: string) { deletedKeys.push(key); },
    };

    await waitForWritableLocalMount(target, bucket, '/outputs', '/workspace/outputs', [0]);

    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatch(/^\/outputs\/\.camelai-mount-ready-/);
    expect(deletedFiles).toEqual([writes[0]]);
    expect(deletedKeys[0]).toMatch(/^workspace\/outputs\/\.camelai-mount-ready-/);
  });
});

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

    await expect(mountOrRecover(target, 'R2_BUCKET', '/uploads', options))
      .rejects.toBeInstanceOf(UnreadableR2MountError);
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

    await expect(mountOrRecover(target, 'R2_BUCKET', '/uploads', options)).resolves.toBe('present_readable');
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

describe('mountOrRecover forced remount', () => {
  const options = { prefix: '/uploads-prefix', readOnly: true as const };
  const busy = () => new S3FSMountError(
    'S3FS mount failed: s3fs: MOUNTPOINT directory /uploads is not empty',
  );

  it('detaches a mount the SDK registry lost and mounts again', async () => {
    let detached = false;
    const forceUnmount = vi.fn(async () => { detached = true; });
    const mountBucket = vi.fn(async () => {
      if (!detached) throw busy();
    });
    const exec = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'ls: Input/output error' }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const outcome = await mountOrRecover(
        {
          mountBucket,
          // What the SDK answers once its registry lost the path.
          unmountBucket: async () => {
            throw new InvalidMountConfigError('No active mount found at path: /uploads');
          },
          exec,
          forceUnmount,
        },
        'R2_BUCKET',
        '/uploads',
        options,
      );
      expect(outcome).toBe('force_remounted');
    } finally {
      warn.mockRestore();
    }
    expect(forceUnmount).toHaveBeenCalledWith('/uploads');
    expect(mountBucket).toHaveBeenCalledTimes(3);
    // Mounted clean, so no probe of the dead mount was needed.
    expect(exec).not.toHaveBeenCalled();
  });

  it('still fails loudly when the forced remount cannot clear the mount', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(mountOrRecover(
        {
          mountBucket: async () => { throw busy(); },
          unmountBucket: async () => undefined,
          exec: async () => ({ exitCode: 2, stdout: '', stderr: 'ls: Input/output error' }),
          forceUnmount: async () => undefined,
        },
        'R2_BUCKET',
        '/uploads',
        options,
      )).rejects.toBeInstanceOf(UnreadableR2MountError);
    } finally {
      warn.mockRestore();
    }
  });

  it('does not tell the agent to recreate a container it cannot reach', () => {
    const message = new UnreadableR2MountError('/uploads').message;
    expect(message).toContain('not readable');
    expect(message).not.toMatch(/recreate/i);
  });
});

describe('AnalysisSandbox.forceUnmount', () => {
  function sandboxWith(entry: { mountType: string }) {
    const sandbox = Object.create(AnalysisSandbox.prototype) as any;
    sandbox.activeMounts = new Map([['/uploads', entry]]);
    sandbox.exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    return sandbox;
  }

  it('lazily detaches the FUSE mount and forgets the SDK registry entry', async () => {
    const sandbox = sandboxWith({ mountType: 'r2-egress' });
    await AnalysisSandbox.prototype.forceUnmount.call(sandbox, '/uploads');
    expect(sandbox.exec).toHaveBeenCalledWith(forceUnmountCommand('/uploads'), { timeout: 15_000 });
    expect(forceUnmountCommand('/uploads')).toBe(
      "if mountpoint -q '/uploads'; then fusermount -uz '/uploads' 2>/dev/null || umount -l '/uploads'; fi",
    );
    expect(sandbox.activeMounts.has('/uploads')).toBe(false);
  });

  it('keeps the registry entry when the detach fails', async () => {
    const sandbox = sandboxWith({ mountType: 'r2-egress' });
    sandbox.exec.mockResolvedValue({ exitCode: 1, stdout: '', stderr: 'umount: busy' });
    await expect(AnalysisSandbox.prototype.forceUnmount.call(sandbox, '/uploads')).rejects.toThrow(
      /Forced unmount of \/uploads failed/,
    );
    expect(sandbox.activeMounts.has('/uploads')).toBe(true);
  });

  it('leaves self-host local-sync mounts to the SDK', async () => {
    const sandbox = sandboxWith({ mountType: 'local-sync' });
    await AnalysisSandbox.prototype.forceUnmount.call(sandbox, '/uploads');
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.activeMounts.has('/uploads')).toBe(true);
  });

  it('refuses unexpected paths', async () => {
    const sandbox = sandboxWith({ mountType: 'r2-egress' });
    await expect(AnalysisSandbox.prototype.forceUnmount.call(sandbox, '/uploads/../etc')).rejects.toThrow();
    expect(sandbox.exec).not.toHaveBeenCalled();
  });
});

describe('AnalysisSandbox.ensureMounted self-heal', () => {
  const ensureUploads = (sandbox: any) => AnalysisSandbox.prototype.ensureMounted.call(
    sandbox,
    'R2_BUCKET',
    'org1/workspace1/uploads',
    '/uploads',
    { readOnly: true },
  );

  /**
   * Prod 2026-09-29: after a forced restart, the old container's late `onStop`
   * cleared the SDK registry and the r2.internal egress while the new container
   * kept its FUSE mount. Every later call hit "not empty", `unmountBucket`
   * answered "No active mount found", and the restart was rate limited, so the
   * agent saw UnreadableR2MountError five times in a row. The forced detach
   * recovers that without another container restart.
   */
  it('recovers a mount the SDK forgot without restarting the container', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox, destroy } = healableSandbox();
      sandbox.containerGeneration = 2;
      sandbox.mountedContainerGeneration = 2;
      // The SDK's own registry: empty, as the late onStop left it.
      sandbox.activeMounts = new Map();
      let fuseMounted = true;
      sandbox.mountBucket = vi.fn(async (_bucket: string, path: string) => {
        if (fuseMounted) {
          throw new S3FSMountError(`S3FS mount failed: s3fs: MOUNTPOINT directory ${path} is not empty`);
        }
        fuseMounted = true;
        sandbox.activeMounts.set(path, { mountType: 'r2-egress' });
      });
      sandbox.unmountBucket = vi.fn(async (path: string) => {
        throw new InvalidMountConfigError(`No active mount found at path: ${path}`);
      });
      sandbox.exec = vi.fn(async (command: string) => {
        if (command === forceUnmountCommand('/uploads')) fuseMounted = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      await ensureUploads(sandbox);

      expect(destroy).not.toHaveBeenCalled();
      expect(sandbox.mountedPaths.has('/uploads')).toBe(true);
      expect(recordedEvents(sandbox)).toEqual([
        ['sandbox_mount_recovery', 'force_remounted'],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('restarts at most once per cooldown and reports the rate-limited failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox, destroy } = healableSandbox();
      sandbox.containerGeneration = 1;
      sandbox.mountedContainerGeneration = 1;
      sandbox.activeMounts = new Map();
      // A mount that nothing fixes, not even a fresh container.
      sandbox.mountBucket = vi.fn(async () => {
        throw new S3FSMountError('S3FS mount failed: s3fs: MOUNTPOINT directory /uploads is not empty');
      });
      sandbox.unmountBucket = vi.fn(async () => undefined);
      sandbox.exec = vi.fn(async () => ({ exitCode: 1, stdout: '', stderr: 'ls: Input/output error' }));

      // First call: one restart, one retry against the new container, then fail.
      await expect(ensureUploads(sandbox)).rejects.toBeInstanceOf(UnreadableR2MountError);
      expect(destroy).toHaveBeenCalledTimes(1);
      // Second call inside the cooldown: no second restart (the loop guard).
      await expect(ensureUploads(sandbox)).rejects.toBeInstanceOf(UnreadableR2MountError);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(sandbox.mountedPaths.has('/uploads')).toBe(false);

      expect(recordedEvents(sandbox)).toEqual([
        ['build_sandbox_zombie_restart', 'restarted'],
        ['sandbox_mount_recovery', 'failed_after_restart'],
        ['sandbox_mount_recovery', 'restart_rate_limited'],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  /**
   * Prod 2026-09-26: an earlier command kept the workspace's default session
   * busy, so the SDK's own mount steps (`chmod 0600 /tmp/.passwd-s3fs-…`) timed
   * out behind it on every call for 11 minutes. That is not a session death,
   * so nothing restarted the container. A mount-step timeout now does.
   */
  it('restarts a container whose session is too blocked to run the mount steps', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox, destroy } = healableSandbox();
      sandbox.containerGeneration = 1;
      sandbox.mountedContainerGeneration = 1;
      let restarted = false;
      destroy.mockImplementation(async () => { restarted = true; });
      sandbox.mountBucket = vi.fn(async () => {
        if (!restarted) {
          throw new Error(
            "Failed to execute command 'chmod 0600 '/tmp/.passwd-s3fs-173234f4'' in session " +
            "'sandbox-ws-1': Command timeout after 15000ms",
          );
        }
      });
      sandbox.unmountBucket = vi.fn(async () => undefined);
      sandbox.exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

      await ensureUploads(sandbox);

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(sandbox.mountBucket).toHaveBeenCalledTimes(2);
      expect(sandbox.mountedPaths.has('/uploads')).toBe(true);
      expect(recordedEvents(sandbox)).toEqual([
        ['build_sandbox_zombie_restart', 'restarted'],
        ['sandbox_mount_recovery', 'restarted'],
      ]);
      // blob16 carries the restart trigger.
      const lastPoint = sandbox.env.OBSERVABILITY_EVENTS.writeDataPoint.mock.calls.at(-1)[0];
      expect(lastPoint.blobs[15]).toBe('mount_session_timeout');
    } finally {
      warn.mockRestore();
    }
  });

  it('explains a blocked session to the agent when the restart is rate limited', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox, destroy } = healableSandbox();
      sandbox.containerGeneration = 1;
      sandbox.mountedContainerGeneration = 1;
      // A restart already happened inside the cooldown window.
      await sandbox.ctx.storage.put('camelai:zombieRestartAtMs', Date.now());
      sandbox.mountBucket = vi.fn(async () => {
        throw new Error("Failed to execute command 'chmod 0600 x' in session 's': Command timeout after 15000ms");
      });
      sandbox.unmountBucket = vi.fn(async () => undefined);
      sandbox.exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

      const error = await ensureUploads(sandbox).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(SandboxMountSessionTimeoutError);
      expect((error as Error).message).toMatch(/wait a few minutes and retry/);
      expect(destroy).not.toHaveBeenCalled();
      expect(recordedEvents(sandbox)).toEqual([
        ['sandbox_mount_recovery', 'restart_rate_limited'],
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it('leaves genuine mount failures alone (no restart)', async () => {
    const { sandbox, destroy } = healableSandbox();
    sandbox.containerGeneration = 1;
    sandbox.mountedContainerGeneration = 1;
    sandbox.mountBucket = vi.fn(async () => {
      throw new S3FSMountError('S3FS mount failed: 403 AccessDenied');
    });
    sandbox.unmountBucket = vi.fn(async () => undefined);
    sandbox.exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));

    await expect(ensureUploads(sandbox)).rejects.toBeInstanceOf(S3FSMountError);
    expect(destroy).not.toHaveBeenCalled();
    expect(recordedEvents(sandbox)).toEqual([]);
  });

  it('gives the DbQuerySandbox export mount the same self-heal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox: analysis, destroy } = healableSandbox();
      const sandbox = Object.create(DbQuerySandbox.prototype) as any;
      Object.assign(sandbox, {
        ctx: analysis.ctx,
        env: analysis.env,
        destroy,
        zombieHealState: createSandboxZombieHealState(),
        containerGeneration: 1,
        mountedContainerGeneration: 1,
        mountedPaths: new Set<string>(),
        mountGates: new Map(),
        activeMounts: new Map(),
      });
      let fuseMounted = true;
      sandbox.mountBucket = vi.fn(async (_bucket: string, path: string) => {
        if (fuseMounted) {
          throw new S3FSMountError(`S3FS mount failed: s3fs: MOUNTPOINT directory ${path} is not empty`);
        }
      });
      sandbox.unmountBucket = vi.fn(async (path: string) => {
        throw new InvalidMountConfigError(`No active mount found at path: ${path}`);
      });
      sandbox.exec = vi.fn(async (command: string) => {
        if (command === forceUnmountCommand('/warehouse/ws-1')) fuseMounted = false;
        return { exitCode: 0, stdout: '', stderr: '' };
      });

      await DbQuerySandbox.prototype.ensureWarehouseExportMount.call(sandbox, 'warehouse/ws-1');

      expect(destroy).not.toHaveBeenCalled();
      expect(recordedEvents(sandbox)).toEqual([
        ['sandbox_mount_recovery', 'force_remounted'],
      ]);
      const point = sandbox.env.OBSERVABILITY_EVENTS.writeDataPoint.mock.calls[0][0];
      expect(point.blobs[2]).toBe('DbQuerySandbox');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('isMountSessionTimeout', () => {
  it('matches the SDK command-timeout text and nothing broader', () => {
    expect(isMountSessionTimeout(new Error(
      "CommandError: Failed to execute command 'chmod 0600 '/tmp/.passwd-s3fs-x'' in session 'sandbox-ws': Command timeout after 15000ms",
    ))).toBe(true);
    expect(isMountSessionTimeout(new S3FSMountError('S3FS mount failed: 403 AccessDenied'))).toBe(false);
    expect(isMountSessionTimeout(new Error('connect ETIMEDOUT'))).toBe(false);
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

  it('traverses the mounted directory instead of only statting its mountpoint', async () => {
    const exec = vi.fn(async () => ({ exitCode: 0, stdout: '', stderr: '' }));
    await expect(mountAllowsList({ exec }, '/warehouse/ws-1')).resolves.toBe(true);
    expect(exec).toHaveBeenCalledWith(
      'ls -la -- /warehouse/ws-1 >/dev/null',
      { timeout: 15_000 },
    );
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
