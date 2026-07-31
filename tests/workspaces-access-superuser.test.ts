import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class {},
}));

const getSessionMock = vi.fn();
const getEnvMock = vi.fn();
const getWorkspaceAccessContextMock = vi.fn();
const getProfileMock = vi.fn();
const userIdFromNameMock = vi.fn((id: string) => id);
const userGetMock = vi.fn(() => ({ getProfile: getProfileMock }));

vi.mock('@/lib/auth.server', () => ({
  getSession: getSessionMock,
}));

vi.mock('@/lib/cloudflare.server', () => ({
  getEnv: getEnvMock,
}));

vi.mock('@/lib/auth-do', () => ({
  getWorkspaceAccessContext: getWorkspaceAccessContextMock,
}));

const { requireWorkspaceAccess } = await import('@/routes/api/workspaces.utils');

describe('requireWorkspaceAccess superuser override', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    getSessionMock.mockResolvedValue({
      session: {
        user_id: 'user_123',
        org_id: 'org_current',
      },
    });
    getEnvMock.mockReturnValue({
      USER: {
        idFromName: userIdFromNameMock,
        get: userGetMock,
      },
    });
  });

  it('allows same-org access via regular workspace membership checks', async () => {
    getWorkspaceAccessContextMock.mockResolvedValue({
      workspace: {
        id: 'ws_123',
        org_id: 'org_current',
      },
      access: 'full',
    });

    const result = await requireWorkspaceAccess(
      new Request('https://camelai.com/api/workspaces/ws_123/fs/content/app/index.html'),
      {} as never,
      'ws_123'
    );

    expect(result.orgId).toBe('org_current');
    expect(result.workspaceId).toBe('ws_123');
    expect(getWorkspaceAccessContextMock).toHaveBeenCalledWith(expect.anything(), 'ws_123', 'user_123');
    expect(getProfileMock).not.toHaveBeenCalled();
  });

  it('allows same-org read access for superusers when workspace access is none', async () => {
    getWorkspaceAccessContextMock.mockResolvedValue({
      workspace: {
        id: 'ws_123',
        org_id: 'org_current',
      },
      access: 'none',
    });
    getProfileMock.mockResolvedValue({
      id: 'user_123',
      is_superuser: true,
      email_verified_at: Date.now(),
    });

    const result = await requireWorkspaceAccess(
      new Request('https://camelai.com/api/workspaces/ws_123/fs/content/app/index.html'),
      {} as never,
      'ws_123'
    );

    expect(result.orgId).toBe('org_current');
    expect(result.workspaceId).toBe('ws_123');
    expect(result.access).toBe('full');
    expect(getWorkspaceAccessContextMock).toHaveBeenCalledWith(expect.anything(), 'ws_123', 'user_123');
  });

  it('rejects same-org write access for superusers when workspace access is none', async () => {
    getWorkspaceAccessContextMock.mockResolvedValue({
      workspace: {
        id: 'ws_123',
        org_id: 'org_current',
      },
      access: 'none',
    });
    getProfileMock.mockResolvedValue({
      id: 'user_123',
      is_superuser: true,
      email_verified_at: Date.now(),
    });

    await expect(
      requireWorkspaceAccess(
        new Request('https://camelai.com/api/workspaces/ws_123/fs/content/app/index.html'),
        {} as never,
        'ws_123',
        { requireWrite: true }
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects same-org access for non-superusers when workspace access is none', async () => {
    getWorkspaceAccessContextMock.mockResolvedValue({
      workspace: {
        id: 'ws_123',
        org_id: 'org_current',
      },
      access: 'none',
    });
    getProfileMock.mockResolvedValue({
      id: 'user_123',
      is_superuser: false,
    });

    await expect(
      requireWorkspaceAccess(
        new Request('https://camelai.com/api/workspaces/ws_123/fs/content/app/index.html'),
        {} as never,
        'ws_123'
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it('allows cross-org read access for superusers', async () => {
    getWorkspaceAccessContextMock.mockResolvedValue({
      workspace: {
        id: 'ws_foreign',
        org_id: 'org_foreign',
      },
      access: 'full',
    });
    getProfileMock.mockResolvedValue({
      id: 'user_123',
      is_superuser: true,
      email_verified_at: Date.now(),
    });

    const result = await requireWorkspaceAccess(
      new Request('https://camelai.com/api/workspaces/ws_foreign/fs/content/app/index.html'),
      {} as never,
      'ws_foreign'
    );

    expect(result.orgId).toBe('org_foreign');
    expect(result.workspaceId).toBe('ws_foreign');
    expect(result.access).toBe('full');
    expect(getWorkspaceAccessContextMock).toHaveBeenCalledWith(expect.anything(), 'ws_foreign', 'user_123');
  });

  it('rejects cross-org write access for superusers', async () => {
    getWorkspaceAccessContextMock.mockResolvedValue({
      workspace: {
        id: 'ws_foreign',
        org_id: 'org_foreign',
      },
      access: 'full',
    });
    getProfileMock.mockResolvedValue({
      id: 'user_123',
      is_superuser: true,
      email_verified_at: Date.now(),
    });

    await expect(
      requireWorkspaceAccess(
        new Request('https://camelai.com/api/workspaces/ws_foreign/fs/content/app/index.html'),
        {} as never,
        'ws_foreign',
        { requireWrite: true }
      )
    ).rejects.toMatchObject({ status: 403 });
  });

  it('rejects cross-org access for non-superusers', async () => {
    getWorkspaceAccessContextMock.mockResolvedValue({
      workspace: {
        id: 'ws_foreign',
        org_id: 'org_foreign',
      },
      access: 'full',
    });
    getProfileMock.mockResolvedValue({
      id: 'user_123',
      is_superuser: false,
    });

    await expect(
      requireWorkspaceAccess(
        new Request('https://camelai.com/api/workspaces/ws_foreign/fs/content/app/index.html'),
        {} as never,
        'ws_foreign'
      )
    ).rejects.toMatchObject({ status: 404 });
  });
});
