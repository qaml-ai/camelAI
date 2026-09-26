'use client';

import { useCallback, useRef, useState } from 'react';
import { useNavigate, useRevalidator } from 'react-router';

type AuthActionResponse = {
  success?: boolean;
  error?: string;
  redirect?: string;
  accessLogoutUrl?: string | null;
};

async function postJsonAction(
  url: string,
  body?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AuthActionResponse> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
    signal,
  });
  const contentType = response.headers.get('content-type') ?? '';
  const data = contentType.includes('application/json')
    ? ((await response.json()) as AuthActionResponse)
    : {};

  if (!response.ok || data.error) {
    throw new Error(
      data.error ?? `Request failed with status ${response.status}`,
    );
  }

  return data;
}

/**
 * Hook for logging out the current user.
 * After logout, navigates to /login.
 */
export function useLogout() {
  const navigate = useNavigate();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const logout = useCallback(async () => {
    setIsLoggingOut(true);
    setError(undefined);
    try {
      const data = await postJsonAction('/api/auth/logout');
      if (data.accessLogoutUrl) {
        window.location.assign(data.accessLogoutUrl);
        return;
      }
      navigate('/login');
    } catch (caught) {
      const nextError =
        caught instanceof Error ? caught.message : 'Failed to log out';
      setError(nextError);
      console.error('Failed to log out:', caught);
    } finally {
      setIsLoggingOut(false);
    }
  }, [navigate]);

  return {
    logout,
    isLoggingOut,
    error,
  };
}

let activeWorkspaceSwitchController: AbortController | null = null;
let activeOrgSwitchController: AbortController | null = null;

export class WorkspaceSwitchSupersededError extends Error {
  constructor() {
    super('Workspace switch was superseded');
    this.name = 'WorkspaceSwitchSupersededError';
  }
}

export function isWorkspaceSwitchSupersededError(
  error: unknown,
): error is WorkspaceSwitchSupersededError {
  return error instanceof WorkspaceSwitchSupersededError;
}

export class OrgSwitchSupersededError extends Error {
  constructor() {
    super('Organization switch was superseded');
    this.name = 'OrgSwitchSupersededError';
  }
}

export function isOrgSwitchSupersededError(
  error: unknown,
): error is OrgSwitchSupersededError {
  return error instanceof OrgSwitchSupersededError;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * Hook for switching the current workspace.
 * Explicitly revalidates loaders after the session cookie changes.
 * Returns a Promise that resolves when the switch completes successfully.
 */
export function useSwitchWorkspace() {
  const revalidator = useRevalidator();
  const requestIdRef = useRef(0);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const switchWorkspace = useCallback(
    async (workspaceId: string): Promise<void> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsSwitching(true);
      setError(undefined);
      activeWorkspaceSwitchController?.abort();
      const controller = new AbortController();
      activeWorkspaceSwitchController = controller;

      try {
        const response = await fetch('/api/auth/switch-workspace', {
          method: 'POST',
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ workspaceId }),
          credentials: 'same-origin',
          signal: controller.signal,
        });
        const contentType = response.headers.get('content-type') ?? '';
        const data = contentType.includes('application/json')
          ? ((await response.json()) as { error?: string })
          : {};

        if (!response.ok || data.error) {
          throw new Error(data.error ?? 'Failed to switch workspace');
        }

        await revalidator.revalidate();
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          throw new WorkspaceSwitchSupersededError();
        }
      } catch (caught) {
        if (isAbortError(caught)) {
          throw new WorkspaceSwitchSupersededError();
        }
        if (caught instanceof WorkspaceSwitchSupersededError) {
          throw caught;
        }

        const nextError =
          caught instanceof Error
            ? caught
            : new Error('Failed to switch workspace');
        if (requestIdRef.current === requestId) {
          setError(nextError.message);
        }
        throw nextError;
      } finally {
        if (activeWorkspaceSwitchController === controller) {
          activeWorkspaceSwitchController = null;
        }
        if (requestIdRef.current === requestId) {
          setIsSwitching(false);
        }
      }
    },
    [revalidator]
  );

  return {
    switchWorkspace,
    isSwitching,
    error,
  };
}

/**
 * Hook for switching the current organization.
 * Explicitly revalidates loaders after the session cookie changes.
 * Returns a Promise that resolves when the switch completes successfully.
 */
export function useSwitchOrg() {
  const revalidator = useRevalidator();
  const requestIdRef = useRef(0);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const switchOrg = useCallback(
    async (orgId: string): Promise<void> => {
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setIsSwitching(true);
      setError(undefined);
      activeOrgSwitchController?.abort();
      const controller = new AbortController();
      activeOrgSwitchController = controller;

      try {
        await postJsonAction('/api/auth/switch-org', { orgId }, controller.signal);
        await revalidator.revalidate();
        if (controller.signal.aborted || requestIdRef.current !== requestId) {
          throw new OrgSwitchSupersededError();
        }
      } catch (caught) {
        if (isAbortError(caught)) {
          throw new OrgSwitchSupersededError();
        }
        if (caught instanceof OrgSwitchSupersededError) {
          throw caught;
        }

        const nextError =
          caught instanceof Error
            ? caught
            : new Error('Failed to switch organization');
        if (requestIdRef.current === requestId) {
          setError(nextError.message);
        }
        throw nextError;
      } finally {
        if (activeOrgSwitchController === controller) {
          activeOrgSwitchController = null;
        }
        if (requestIdRef.current === requestId) {
          setIsSwitching(false);
        }
      }
    },
    [revalidator]
  );

  return {
    switchOrg,
    isSwitching,
    error,
  };
}
