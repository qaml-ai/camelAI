/**
 * Tests for auth action hooks.
 *
 * These hooks perform auth mutations and revalidate app loaders.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock react-router navigation/revalidation hooks.
const mockNavigate = vi.fn();
const mockRevalidate = vi.fn();
const mockFetch = vi.fn();

vi.mock('react-router', () => ({
  useNavigate: vi.fn(() => mockNavigate),
  useRevalidator: vi.fn(() => ({
    revalidate: mockRevalidate,
    state: 'idle',
  })),
}));

// Mock clearWarmupCache
vi.mock('@/hooks/use-workspace-warmup', () => ({
  clearWarmupCache: vi.fn(),
}));

describe('useLogout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevalidate.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mockFetch);
  });

  it('should post logout request to correct endpoint and navigate on success', async () => {
    const { useLogout } = await import('@/hooks/use-auth-actions');
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
    });

    const { result } = renderHook(() => useLogout());

    await act(async () => {
      await result.current.logout();
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/auth/logout', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
      },
      body: undefined,
      credentials: 'same-origin',
      signal: undefined,
    });
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('should report isLoggingOut while the request is pending', async () => {
    const { useLogout } = await import('@/hooks/use-auth-actions');
    let resolveLogout!: (value: unknown) => void;
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveLogout = resolve;
      }),
    );

    const { result } = renderHook(() => useLogout());
    expect(result.current.isLoggingOut).toBe(false);

    let logoutPromise!: Promise<void>;
    act(() => {
      logoutPromise = result.current.logout();
    });
    expect(result.current.isLoggingOut).toBe(true);

    await act(async () => {
      resolveLogout({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true }),
      });
      await logoutPromise;
    });

    expect(result.current.isLoggingOut).toBe(false);
  });
});

describe('useSwitchWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevalidate.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mockFetch);
  });

  it('should post switch request with JSON body and revalidate on success', async () => {
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
    });

    const { result } = renderHook(() => useSwitchWorkspace());

    await act(async () => {
      await result.current.switchWorkspace('workspace-123');
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/auth/switch-workspace', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ workspaceId: 'workspace-123' }),
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
  });

  it('should return a Promise that resolves on success', async () => {
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
    });

    const { result, rerender } = renderHook(() => useSwitchWorkspace());

    let resolved = false;
    let rejected = false;
    await act(async () => {
      await result.current.switchWorkspace('workspace-123').then(
        () => { resolved = true; },
        () => { rejected = true; }
      );
    });

    rerender();
    expect(resolved).toBe(true);
    expect(rejected).toBe(false);
  });

  it('should return a Promise that rejects on error', async () => {
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');
    mockFetch.mockResolvedValue({
      ok: false,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Workspace not found' }),
    });

    const { result } = renderHook(() => useSwitchWorkspace());

    let resolved = false;
    let rejectedError: unknown = null;
    await act(async () => {
      await result.current.switchWorkspace('workspace-123').then(
        () => { resolved = true; },
        (err) => { rejectedError = err; }
      );
    });

    expect(resolved).toBe(false);
    expect(rejectedError).toBeInstanceOf(Error);
    expect((rejectedError as Error).message).toBe('Workspace not found');
  });

  it('should report isSwitching based on fetcher state', async () => {
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');
    let resolveFetch: (value: unknown) => void = () => {};
    mockFetch.mockReturnValue(
      new Promise((resolve) => {
        resolveFetch = resolve;
      })
    );

    const { result } = renderHook(() => useSwitchWorkspace());
    let promise: Promise<void>;
    act(() => {
      promise = result.current.switchWorkspace('workspace-123');
    });

    expect(result.current.isSwitching).toBe(true);

    await act(async () => {
      resolveFetch({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true }),
      });
      await promise!;
    });
    expect(result.current.isSwitching).toBe(false);
  });

  it('keeps isSwitching true until revalidation resolves', async () => {
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');
    let resolveRevalidation!: () => void;
    mockRevalidate.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRevalidation = resolve;
      }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
    });

    const { result } = renderHook(() => useSwitchWorkspace());
    let promise!: Promise<void>;

    act(() => {
      promise = result.current.switchWorkspace('workspace-123');
    });

    await waitFor(() => expect(mockRevalidate).toHaveBeenCalledTimes(1));
    expect(result.current.isSwitching).toBe(true);

    await act(async () => {
      resolveRevalidation();
      await promise;
    });

    expect(result.current.isSwitching).toBe(false);
  });

  it('rejects a workspace switch superseded while revalidation is pending', async () => {
    const {
      isWorkspaceSwitchSupersededError,
      useSwitchWorkspace,
    } = await import('@/hooks/use-auth-actions');
    const revalidationResolvers: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    mockRevalidate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          revalidationResolvers.push(resolve);
        }),
    );
    mockFetch.mockImplementation((_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true }),
      });
    });

    const { result } = renderHook(() => useSwitchWorkspace());
    let firstResolved = false;
    let firstRejectedError: unknown = null;
    let firstSettled!: Promise<void>;

    act(() => {
      firstSettled = result.current.switchWorkspace('workspace-1').then(
        () => {
          firstResolved = true;
        },
        (error) => {
          firstRejectedError = error;
        },
      );
    });

    await waitFor(() => expect(mockRevalidate).toHaveBeenCalledTimes(1));
    expect(signals[0].aborted).toBe(false);

    let secondPromise!: Promise<void>;
    act(() => {
      secondPromise = result.current.switchWorkspace('workspace-2');
    });

    expect(signals[0].aborted).toBe(true);
    await waitFor(() => expect(mockRevalidate).toHaveBeenCalledTimes(2));

    await act(async () => {
      revalidationResolvers[1]();
      await secondPromise;
    });

    await act(async () => {
      revalidationResolvers[0]();
      await firstSettled;
    });

    expect(firstResolved).toBe(false);
    expect(isWorkspaceSwitchSupersededError(firstRejectedError)).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it('should expose error from failed response', async () => {
    const { useSwitchWorkspace } = await import('@/hooks/use-auth-actions');
    mockFetch.mockResolvedValue({
      ok: false,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Workspace not found' }),
    });

    const { result } = renderHook(() => useSwitchWorkspace());

    await act(async () => {
      await result.current.switchWorkspace('workspace-123').catch(() => {});
    });

    expect(result.current.error).toBe('Workspace not found');
  });

  it('should reject a previous in-flight workspace switch as superseded', async () => {
    const {
      isWorkspaceSwitchSupersededError,
      useSwitchWorkspace,
    } = await import('@/hooks/use-auth-actions');
    const pendingResponses: Array<{
      signal: AbortSignal;
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }> = [];

    mockFetch.mockImplementation((_url, init) => {
      const signal = init?.signal as AbortSignal;
      return new Promise((resolve, reject) => {
        pendingResponses.push({ signal, resolve, reject });
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const { result } = renderHook(() => useSwitchWorkspace());
    let firstResolved = false;
    let firstRejectedError: unknown = null;

    act(() => {
      void result.current.switchWorkspace('workspace-1').then(
        () => { firstResolved = true; },
        (error) => { firstRejectedError = error; },
      );
    });

    expect(pendingResponses[0].signal.aborted).toBe(false);

    let secondPromise: Promise<void>;
    act(() => {
      secondPromise = result.current.switchWorkspace('workspace-2');
    });

    expect(pendingResponses[0].signal.aborted).toBe(true);

    await act(async () => {
      pendingResponses[1].resolve({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true }),
      });
      await secondPromise!;
    });

    expect(firstResolved).toBe(false);
    expect(isWorkspaceSwitchSupersededError(firstRejectedError)).toBe(true);
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
  });
});

describe('useSwitchOrg', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRevalidate.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', mockFetch);
  });

  it('should post switch request with JSON body and revalidate on success', async () => {
    const { useSwitchOrg } = await import('@/hooks/use-auth-actions');
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
    });

    const { result } = renderHook(() => useSwitchOrg());

    await act(async () => {
      await result.current.switchOrg('org-456');
    });

    expect(mockFetch).toHaveBeenCalledWith('/api/auth/switch-org', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ orgId: 'org-456' }),
      credentials: 'same-origin',
      signal: expect.any(AbortSignal),
    });
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
  });

  it('should return a Promise that resolves on success', async () => {
    const { useSwitchOrg } = await import('@/hooks/use-auth-actions');
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
    });

    const { result } = renderHook(() => useSwitchOrg());

    let resolved = false;
    let rejected = false;
    await act(async () => {
      await result.current.switchOrg('org-456').then(
        () => { resolved = true; },
        () => { rejected = true; }
      );
    });

    expect(resolved).toBe(true);
    expect(rejected).toBe(false);
  });

  it('should return a Promise that rejects on error', async () => {
    const { useSwitchOrg } = await import('@/hooks/use-auth-actions');
    mockFetch.mockResolvedValue({
      ok: false,
      headers: { get: () => 'application/json' },
      json: async () => ({ error: 'Org not found' }),
    });

    const { result } = renderHook(() => useSwitchOrg());

    let resolved = false;
    let rejectedError: unknown = null;
    await act(async () => {
      await result.current.switchOrg('org-456').then(
        () => { resolved = true; },
        (err) => { rejectedError = err; }
      );
    });

    expect(resolved).toBe(false);
    expect(rejectedError).toBeInstanceOf(Error);
    expect((rejectedError as Error).message).toBe('Org not found');
    expect(result.current.error).toBe('Org not found');
  });

  it('keeps isSwitching true until revalidation resolves', async () => {
    const { useSwitchOrg } = await import('@/hooks/use-auth-actions');
    let resolveRevalidation!: () => void;
    mockRevalidate.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveRevalidation = resolve;
      }),
    );
    mockFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'application/json' },
      json: async () => ({ success: true }),
    });

    const { result } = renderHook(() => useSwitchOrg());
    let promise!: Promise<void>;

    act(() => {
      promise = result.current.switchOrg('org-456');
    });

    await waitFor(() => expect(mockRevalidate).toHaveBeenCalledTimes(1));
    expect(result.current.isSwitching).toBe(true);

    await act(async () => {
      resolveRevalidation();
      await promise;
    });

    expect(result.current.isSwitching).toBe(false);
  });

  it('rejects an org switch superseded while revalidation is pending', async () => {
    const {
      isOrgSwitchSupersededError,
      useSwitchOrg,
    } = await import('@/hooks/use-auth-actions');
    const revalidationResolvers: Array<() => void> = [];
    const signals: AbortSignal[] = [];
    mockRevalidate.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          revalidationResolvers.push(resolve);
        }),
    );
    mockFetch.mockImplementation((_url, init) => {
      signals.push(init?.signal as AbortSignal);
      return Promise.resolve({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true }),
      });
    });

    const { result } = renderHook(() => useSwitchOrg());
    let firstResolved = false;
    let firstRejectedError: unknown = null;
    let firstSettled!: Promise<void>;

    act(() => {
      firstSettled = result.current.switchOrg('org-1').then(
        () => {
          firstResolved = true;
        },
        (error) => {
          firstRejectedError = error;
        },
      );
    });

    await waitFor(() => expect(mockRevalidate).toHaveBeenCalledTimes(1));
    expect(signals[0].aborted).toBe(false);

    let secondPromise!: Promise<void>;
    act(() => {
      secondPromise = result.current.switchOrg('org-2');
    });

    expect(signals[0].aborted).toBe(true);
    await waitFor(() => expect(mockRevalidate).toHaveBeenCalledTimes(2));

    await act(async () => {
      revalidationResolvers[1]();
      await secondPromise;
    });

    await act(async () => {
      revalidationResolvers[0]();
      await firstSettled;
    });

    expect(firstResolved).toBe(false);
    expect(isOrgSwitchSupersededError(firstRejectedError)).toBe(true);
    expect(result.current.error).toBeUndefined();
  });

  it('should reject a previous in-flight org switch as superseded', async () => {
    const {
      isOrgSwitchSupersededError,
      useSwitchOrg,
    } = await import('@/hooks/use-auth-actions');
    const pendingResponses: Array<{
      signal: AbortSignal;
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
    }> = [];

    mockFetch.mockImplementation((_url, init) => {
      const signal = init?.signal as AbortSignal;
      return new Promise((resolve, reject) => {
        pendingResponses.push({ signal, resolve, reject });
        signal.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    const { result } = renderHook(() => useSwitchOrg());
    let firstResolved = false;
    let firstRejectedError: unknown = null;

    act(() => {
      void result.current.switchOrg('org-1').then(
        () => { firstResolved = true; },
        (error) => { firstRejectedError = error; },
      );
    });

    expect(pendingResponses[0].signal.aborted).toBe(false);

    let secondPromise: Promise<void>;
    act(() => {
      secondPromise = result.current.switchOrg('org-2');
    });

    expect(pendingResponses[0].signal.aborted).toBe(true);

    await act(async () => {
      pendingResponses[1].resolve({
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => ({ success: true }),
      });
      await secondPromise!;
    });

    expect(firstResolved).toBe(false);
    expect(isOrgSwitchSupersededError(firstRejectedError)).toBe(true);
    expect(mockRevalidate).toHaveBeenCalledTimes(1);
  });
});
