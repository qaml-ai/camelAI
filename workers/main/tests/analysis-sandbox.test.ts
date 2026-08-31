import { describe, expect, it, vi } from 'vitest';
import { InvalidMountConfigError, S3FSMountError } from '@cloudflare/sandbox';
import {
  ANALYSIS_CONTAINER_RESET_TIMEOUT_MS,
  ANALYSIS_EXECUTION_LEASE_MS,
  AnalysisSandbox,
  createSingleFlight,
  isMountAlreadyPresent,
  mountAllowsList,
  mountOrRecover,
  sandboxR2MountOptions,
  sandboxR2MountPath,
  UnreadableR2MountError,
  waitForWritableLocalMount,
  type MountRecoverTarget,
} from '../src/analysis-sandbox.js';
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
describe('AnalysisSandbox.resetSession', () => {
  it('clears the SDK session cache (memory + storage) so the next call re-handshakes', async () => {
    // The SDK only clears `defaultSession` on a container STOP, so a shell that
    // dies while the container lives leaves the cached id pointing at a session
    // the container already reaped. This is the coupling point to re-check when
    // @cloudflare/sandbox is upgraded.
    const sandbox = Object.create(AnalysisSandbox.prototype) as any;
    sandbox.defaultSession = 'sandbox-ws-1';
    sandbox.defaultSessionInit = { sessionId: 'sandbox-ws-1' };
    const deleted: string[] = [];
    sandbox.ctx = { storage: { delete: async (key: string) => { deleted.push(key); } } };

    await AnalysisSandbox.prototype.resetSession.call(sandbox);

    expect(sandbox.defaultSession).toBeNull();
    expect(sandbox.defaultSessionInit).toBeNull();
    expect(deleted).toEqual(['defaultSession']);
  });

  it('never throws when storage refuses — the retry works without it', async () => {
    const sandbox = Object.create(AnalysisSandbox.prototype) as any;
    sandbox.defaultSession = 'sandbox-ws-1';
    sandbox.defaultSessionInit = null;
    sandbox.ctx = {
      storage: { delete: async () => { throw new Error('storage unavailable'); } },
    };

    await expect(AnalysisSandbox.prototype.resetSession.call(sandbox)).resolves.toBeUndefined();
    expect(sandbox.defaultSession).toBeNull();
  });
});

function executionLeaseSandbox() {
  const values = new Map<string, unknown>();
  const kv = {
    get: vi.fn((key: string) => values.get(key)),
    put: vi.fn((key: string, value: unknown) => values.set(key, value)),
    delete: vi.fn((key: string) => values.delete(key)),
  };
  const sandbox = Object.create(AnalysisSandbox.prototype) as any;
  sandbox.ctx = { storage: { kv } };
  sandbox.destroyAndForgetContainerGeneration = vi.fn(async () => undefined);
  return { sandbox, values };
}

describe('AnalysisSandbox execution admission', () => {
  it('is durable, fail-fast, and token-fences an old release after stale recovery', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      const { sandbox, values } = executionLeaseSandbox();
      await expect(
        AnalysisSandbox.prototype.acquireExecutionLease.call(sandbox, {
          token: 'owner-a',
          operation: 'run_code',
        }),
      ).resolves.toMatchObject({ acquired: true });

      // A fresh DO instance reading the same durable KV still sees the owner.
      const afterEviction = executionLeaseSandbox().sandbox;
      afterEviction.ctx.storage.kv = sandbox.ctx.storage.kv;
      await expect(
        AnalysisSandbox.prototype.acquireExecutionLease.call(afterEviction, {
          token: 'owner-b',
          operation: 'exec',
        }),
      ).resolves.toMatchObject({ acquired: false, reason: 'busy' });

      vi.setSystemTime(1_000 + ANALYSIS_EXECUTION_LEASE_MS);
      await expect(
        AnalysisSandbox.prototype.acquireExecutionLease.call(sandbox, {
          token: 'owner-b',
          operation: 'exec',
        }),
      ).resolves.toMatchObject({ acquired: true });
      expect(sandbox.destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();

      // owner-a's late finally cannot clear owner-b.
      await expect(
        AnalysisSandbox.prototype.releaseExecutionLease.call(sandbox, 'owner-a'),
      ).resolves.toBe(false);
      expect(values.size).toBe(1);
      await expect(
        AnalysisSandbox.prototype.acquireExecutionLease.call(sandbox, {
          token: 'owner-c',
          operation: 'run_notebook',
        }),
      ).resolves.toMatchObject({ acquired: false, reason: 'busy' });
      await expect(
        AnalysisSandbox.prototype.releaseExecutionLease.call(sandbox, 'owner-b'),
      ).resolves.toBe(true);
      expect(values.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds stale reset and keeps admission closed when reset is unconfirmed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    try {
      const { sandbox } = executionLeaseSandbox();
      await AnalysisSandbox.prototype.acquireExecutionLease.call(sandbox, {
        token: 'owner-a',
        operation: 'run_code',
      });
      sandbox.destroyAndForgetContainerGeneration = vi.fn(
        () => new Promise<never>(() => {}),
      );
      vi.setSystemTime(5_000 + ANALYSIS_EXECUTION_LEASE_MS);

      const replacement = AnalysisSandbox.prototype.acquireExecutionLease.call(
        sandbox,
        { token: 'owner-b', operation: 'exec' },
      );
      await vi.advanceTimersByTimeAsync(ANALYSIS_CONTAINER_RESET_TIMEOUT_MS);
      await expect(replacement).resolves.toMatchObject({
        acquired: false,
        reason: 'stale_reset_unconfirmed',
      });
      await expect(
        AnalysisSandbox.prototype.acquireExecutionLease.call(sandbox, {
          token: 'owner-c',
          operation: 'exec',
        }),
      ).resolves.toMatchObject({ acquired: false, reason: 'busy' });
      expect(sandbox.destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers a durable archive taint with reset then exact R2 deletion before admission', async () => {
    const { sandbox, values } = executionLeaseSandbox();
    const events: string[] = [];
    values.set('analysis:execution-archive-taint:v1', {
      token: 'archive-owner',
      kind: 'archive',
      resource: 'org/ws/user-outputs/tmp/orphan.log',
      createdAt: Date.now(),
    });
    sandbox.destroyAndForgetContainerGeneration = vi.fn(async () => {
      events.push('reset');
    });
    sandbox.env = {
      R2_OUTPUTS_BUCKET: {
        delete: vi.fn(async (key: string) => {
          events.push(`delete:${key}`);
        }),
      },
    };

    await expect(
      AnalysisSandbox.prototype.acquireExecutionLease.call(sandbox, {
        token: 'replacement',
        operation: 'run_code',
      }),
    ).resolves.toMatchObject({ acquired: true });
    expect(events).toEqual([
      'reset',
      'delete:org/ws/user-outputs/tmp/orphan.log',
    ]);
    expect(values.has('analysis:execution-archive-taint:v1')).toBe(false);
    expect(values.get('analysis:execution-lease:v1')).toMatchObject({
      token: 'replacement',
      state: 'active',
    });
  });

  it('keeps archive taint and admission closed when exact R2 deletion fails', async () => {
    const { sandbox, values } = executionLeaseSandbox();
    const taint = {
      token: 'archive-owner',
      kind: 'archive',
      resource: 'org/ws/user-outputs/tmp/orphan.log',
      createdAt: Date.now(),
    };
    values.set('analysis:execution-archive-taint:v1', taint);
    sandbox.env = {
      R2_OUTPUTS_BUCKET: {
        delete: vi.fn(async () => {
          throw new Error('R2 unavailable');
        }),
      },
    };

    await expect(
      AnalysisSandbox.prototype.acquireExecutionLease.call(sandbox, {
        token: 'replacement',
        operation: 'run_code',
      }),
    ).resolves.toMatchObject({
      acquired: false,
      reason: 'stale_reset_unconfirmed',
    });
    expect(sandbox.destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
    expect(values.get('analysis:execution-archive-taint:v1')).toEqual(taint);
    expect(values.get('analysis:execution-lease:v1')).toMatchObject({
      state: 'recovering',
    });
  });

  it('fails closed without deleting R2 when a stale archive marker has an untrusted key', async () => {
    const { sandbox, values } = executionLeaseSandbox();
    const taint = {
      token: 'archive-owner',
      kind: 'archive',
      resource: 'other-prefix/private-object',
      createdAt: Date.now(),
    };
    values.set('analysis:execution-archive-taint:v1', taint);
    const deleteObject = vi.fn(async () => undefined);
    sandbox.env = {
      R2_OUTPUTS_BUCKET: { delete: deleteObject },
    };

    await expect(
      AnalysisSandbox.prototype.acquireExecutionLease.call(sandbox, {
        token: 'replacement',
        operation: 'run_code',
      }),
    ).resolves.toMatchObject({
      acquired: false,
      reason: 'stale_reset_unconfirmed',
    });
    expect(sandbox.destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
    expect(deleteObject).not.toHaveBeenCalled();
    expect(values.get('analysis:execution-archive-taint:v1')).toEqual(taint);
    expect(values.get('analysis:execution-lease:v1')).toMatchObject({
      state: 'recovering',
    });
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

describe('AnalysisSandbox destructive generation reset', () => {
  it('forgets cleanup-destroyed mounts and remounts on the next run', async () => {
    const sandbox = Object.create(AnalysisSandbox.prototype) as any;
    sandbox.env = { CF_ACCOUNT_ID: 'cloudflare-account' };
    sandbox.containerGeneration = 1;
    sandbox.mountedContainerGeneration = 1;
    sandbox.mountedPaths = new Set(['/uploads']);
    sandbox.mountGates = new Map([['/uploads', createSingleFlight()]]);
    sandbox.sessionDeaths = new SandboxSessionDeathTracker();
    sandbox.defaultSession = 'sandbox-ws-1';
    sandbox.defaultSessionInit = { sessionId: 'sandbox-ws-1' };
    sandbox.ctx = { storage: { delete: vi.fn(async () => undefined) } };
    sandbox.destroy = vi.fn(async () => undefined);

    await AnalysisSandbox.prototype.destroyAndForgetContainerGeneration.call(sandbox);

    expect(sandbox.destroy).toHaveBeenCalledOnce();
    expect(sandbox.mountedPaths.size).toBe(0);
    expect(sandbox.mountGates.size).toBe(0);
    expect(sandbox.defaultSession).toBeNull();

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
    expect(sandbox.mountBucket).toHaveBeenCalledOnce();
  });
});

/** Swap ONE inherited SDK method for a spy while `run` executes. */
async function withStubbedSuperMethod(
  cls: { prototype: object },
  name: string,
  stub: (...args: any[]) => unknown,
  run: () => Promise<void>,
): Promise<void> {
  const base = Object.getPrototypeOf(cls.prototype) as Record<string, unknown>;
  const original = Object.getOwnPropertyDescriptor(base, name);
  Object.defineProperty(base, name, { value: stub, configurable: true, writable: true });
  try {
    await run();
  } finally {
    if (original) Object.defineProperty(base, name, original);
    else delete base[name];
  }
}

const SESSION_DEATH = () =>
  Object.assign(
    new Error("Session 'sandbox-ws-1' ended because its shell exited (exit code: 128)"),
    { name: 'SessionTerminatedError' },
  );

/** Bare AnalysisSandbox instance with just the DO surface the heal touches. */
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
   * A single session death is the SDK's self-recovering class, and
   * `AnalysisService.withSessionRecovery` already handles it by re-handshaking a
   * session against the SAME warm container (~1s). Destroying on the first death
   * pre-empts that with a 30-120s cold boot.
   */
  it('lets the first session death through and destroys only on the second', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox, destroy } = healableSandbox();
      sandbox.mountedPaths = new Set(['/uploads']);

      await withStubbedSuperMethod(AnalysisSandbox, 'exec', async () => { throw SESSION_DEATH(); }, async () => {
        await expect(AnalysisSandbox.prototype.exec.call(sandbox, 'python main.py')).rejects.toThrow();
        expect(destroy).not.toHaveBeenCalled();
        // The service's retry still has a warm container (and its mounts).
        expect(sandbox.mountedPaths.has('/uploads')).toBe(true);

        await expect(AnalysisSandbox.prototype.exec.call(sandbox, 'python main.py')).rejects.toThrow();
        expect(destroy).toHaveBeenCalledTimes(1);
      });
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
  it('drops mount bookkeeping and the cached session when the heal destroys the container', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { sandbox, destroy, deleted } = healableSandbox();
      sandbox.mountedPaths = new Set(['/warehouse/ws-1', '/uploads', '/outputs']);
      sandbox.mountGates = new Map([['/uploads', createSingleFlight()]]);
      sandbox.defaultSession = 'sandbox-ws-1';
      sandbox.defaultSessionInit = { sessionId: 'sandbox-ws-1' };

      await AnalysisSandbox.prototype.restartZombieContainer.call(sandbox, {
        operation: 'exec',
        trigger: 'exec_session_death',
      });

      expect(destroy).toHaveBeenCalledTimes(1);
      expect(sandbox.mountedPaths.size).toBe(0);
      expect(sandbox.mountGates.size).toBe(0);
      expect(sandbox.defaultSession).toBeNull();
      expect(deleted).toEqual(['defaultSession']);

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
      expect(sandbox.mountBucket).toHaveBeenCalledTimes(3);
      expect(sandbox.mountedPaths.has('/warehouse/ws-1')).toBe(true);
      expect(sandbox.env.OBSERVABILITY_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
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
