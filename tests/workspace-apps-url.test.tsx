import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerScript } from '@/types';

const testState = vi.hoisted(() => ({
  loaderData: { current: undefined as unknown },
  requireAuthContext: vi.fn(),
  requireOrgAdmin: vi.fn(),
  getEnv: vi.fn(),
  listWorkerScripts: vi.fn(),
  refreshWorkerScriptCustomDomainStates: vi.fn(),
  loadUserProfileSummaries: vi.fn(),
  setSearchParams: vi.fn(),
  fetcherSubmit: vi.fn(),
}));

vi.mock('react-router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router')>();
  return {
    ...actual,
    useFetcher: () => ({
      state: 'idle',
      data: undefined,
      submit: testState.fetcherSubmit,
    }),
    useLoaderData: () => testState.loaderData.current,
    useSearchParams: () => [
      new URLSearchParams(),
      testState.setSearchParams,
    ],
  };
});

vi.mock('@/lib/auth.server', () => ({
  requireAuthContext: testState.requireAuthContext,
  requireOrgAdmin: testState.requireOrgAdmin,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: testState.getEnv,
}));

vi.mock('@/lib/auth-do', () => ({
  deleteWorkerScript: vi.fn(),
  getWorkerScript: vi.fn(),
}));

vi.mock('@/lib/custom-domain.server', () => ({
  refreshWorkerScriptCustomDomainStates:
    testState.refreshWorkerScriptCustomDomainStates,
}));

vi.mock('@/lib/deployed-app-delete.server', () => ({
  deleteDeployedAppRuntime: vi.fn(),
}));

vi.mock('@/lib/user-profiles.server', () => ({
  loadUserProfileSummaries: testState.loadUserProfileSummaries,
}));

const { default: WorkspaceAppsPage, loader } = await import(
  '@/routes/_app.settings.workspace.apps'
);

function makeScript(overrides: Partial<WorkerScript> = {}): WorkerScript {
  return {
    script_name: 'planthrive-prod',
    workspace_id: 'workspace_1',
    created_by: 'user_1',
    created_at: 1,
    updated_at: 2,
    is_public: false,
    preview_key: null,
    preview_updated_at: null,
    preview_status: null,
    preview_error: null,
    config_path: null,
    project_id: null,
    custom_domain_hostname: null,
    custom_domain_cf_hostname_id: null,
    custom_domain_status: null,
    custom_domain_ssl_status: null,
    custom_domain_error: null,
    custom_domain_updated_at: null,
    ...overrides,
  };
}

function makeAuthContext(hasWorkspace = true) {
  return {
    user: { id: 'user_1', name: 'Valmark User', email: 'user@valmark.com' },
    currentOrg: { id: 'org_1', slug: 'koy8lw' },
    currentWorkspace: hasWorkspace ? { id: 'workspace_1' } : null,
    workspaces: hasWorkspace
      ? [{ id: 'workspace_1', name: 'Valmark Workspace' }]
      : [],
  };
}

function makeEnv() {
  return {
    CF_ACCOUNT_ID: 'selfhost',
    LOCAL_APP_VANITY_DOMAIN: 'apps.valmark.com',
    LOCAL_APP_IFRAME_DOMAIN: 'preview.valmark.com',
    ORG: {
      idFromName: vi.fn(() => 'org_1'),
      get: vi.fn(() => ({
        listWorkerScripts: testState.listWorkerScripts,
      })),
    },
    USER: {},
    WORKSPACE: {},
  };
}

describe('workspace settings app URLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testState.loaderData.current = undefined;
    testState.requireAuthContext.mockResolvedValue(makeAuthContext());
    testState.requireOrgAdmin.mockResolvedValue(undefined);
    testState.getEnv.mockReturnValue(makeEnv());
    testState.listWorkerScripts.mockResolvedValue([makeScript()]);
    testState.refreshWorkerScriptCustomDomainStates.mockImplementation(
      async (_env: unknown, _orgId: string, scripts: WorkerScript[]) => scripts,
    );
    testState.loadUserProfileSummaries.mockResolvedValue(new Map([
      ['user_1', {
        id: 'user_1',
        name: 'Valmark User',
        email: 'user@valmark.com',
        avatar: null,
      }],
    ]));
  });

  it('uses the configured self-host app domain for both settings links', async () => {
    const result = await loader({
      request: new Request('https://vibe.valmark.com/settings/workspace/apps'),
      context: {},
      params: {},
    } as never);

    expect(result.appUrlContext).toEqual({
      hostname: 'vibe.valmark.com',
      vanityDomain: 'apps.valmark.com',
      iframeDomain: 'preview.valmark.com',
    });

    testState.loaderData.current = result;
    render(<WorkspaceAppsPage />);

    const expectedUrl = 'https://planthrive-prod-koy8lw.apps.valmark.com';
    expect(screen.getByRole('link', { name: 'planthrive-prod' }))
      .toHaveAttribute('href', expectedUrl);
    expect(screen.getByTitle('Open in new tab'))
      .toHaveAttribute('href', expectedUrl);

    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href')).not.toContain('vibe.valmark.com');
    }
  });

  it('retains the app URL context when no workspace is selected', async () => {
    testState.requireAuthContext.mockResolvedValue(makeAuthContext(false));

    const result = await loader({
      request: new Request('https://vibe.valmark.com/settings/workspace/apps'),
      context: {},
      params: {},
    } as never);

    expect(result).toMatchObject({
      hasWorkspace: false,
      appUrlContext: {
        hostname: 'vibe.valmark.com',
        vanityDomain: 'apps.valmark.com',
        iframeDomain: 'preview.valmark.com',
      },
    });
    expect(testState.listWorkerScripts).not.toHaveBeenCalled();
  });
});
