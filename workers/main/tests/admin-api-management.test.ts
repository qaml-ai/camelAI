import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

function testEmail(label: string) {
  return `admin-api-mgmt-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function callAdmin(method: string, path: string, body?: unknown) {
  const request = new Request(`http://example/api/admin${path}`, {
    method,
    headers: {
      Authorization: 'Bearer test-admin-api-key',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const response = await handleAdminApi({
    req: request,
    env: { ...testEnv, ADMIN_API_KEY: 'test-admin-api-key' } as unknown as WorkerEnv,
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });
  expect(response).not.toBeNull();
  return response!;
}

describe('admin API management routes', () => {
  it('reads and updates a user', async () => {
    const { userId } = await createUser(testEnv, testEmail('user'), 'password123', 'Before');

    const patched = await callAdmin('PATCH', `/users/${userId}`, { name: '  After  ' });
    expect(patched.status).toBe(200);

    const detail = await callAdmin('GET', `/users/${userId}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      user: { id: userId, name: 'After' },
      ban: null,
    });

    const missing = await callAdmin('GET', `/users/${crypto.randomUUID()}`);
    expect(missing.status).toBe(404);
  });

  it('edits org name, member roles, and ownership', async () => {
    const { userId: ownerId } = await createUser(testEnv, testEmail('owner'), 'password123', 'Owner');
    const { userId: memberId } = await createUser(testEnv, testEmail('member'), 'password123', 'Member');
    const { org } = await createOrg(testEnv, 'Mgmt Org', ownerId);

    expect((await callAdmin('PATCH', `/orgs/${org.id}`, { name: 'Renamed Org', billing_status: 'enterprise' })).status).toBe(200);
    expect((await callAdmin('PATCH', `/orgs/${org.id}`, {})).status).toBe(400);

    expect((await callAdmin('POST', `/orgs/${org.id}/members`, { user_id: memberId, role: 'member' })).status).toBe(201);
    expect((await callAdmin('PATCH', `/orgs/${org.id}/members/${memberId}`, { role: 'admin' })).status).toBe(200);
    expect((await callAdmin('POST', `/orgs/${org.id}/transfer-ownership`, { new_owner_id: memberId })).status).toBe(200);

    const membersResponse = await callAdmin('GET', `/orgs/${org.id}/members`);
    expect(membersResponse.status).toBe(200);
    const { data: members } = (await membersResponse.json()) as {
      data: Array<{ user: { id: string }; role: string }>;
    };
    expect(members.find((m) => m.user.id === memberId)?.role).toBe('owner');
    expect(members.find((m) => m.user.id === ownerId)?.role).toBe('admin');

    const info = await testEnv.ORG.get(testEnv.ORG.idFromName(org.id)).getInfo();
    expect(info?.name).toBe('Renamed Org');

    const auditLog = await callAdmin('GET', `/orgs/${org.id}/audit-log?limit=50`);
    expect(auditLog.status).toBe(200);
    const { data: entries } = (await auditLog.json()) as { data: Array<{ action: string }> };
    expect(entries.length).toBeGreaterThan(0);
  });

  it('updates and archives a workspace', async () => {
    const { userId } = await createUser(testEnv, testEmail('ws'), 'password123', 'WS Owner');
    const { defaultWorkspaceId } = await createOrg(testEnv, 'WS Org', userId);

    expect((await callAdmin('PATCH', `/workspaces/${defaultWorkspaceId}`, { description: 'desc' })).status).toBe(200);

    const detail = await callAdmin('GET', `/workspaces/${defaultWorkspaceId}`);
    expect(detail.status).toBe(200);
    await expect(detail.json()).resolves.toMatchObject({
      workspace: { id: defaultWorkspaceId, description: 'desc' },
    });

    expect((await callAdmin('POST', `/workspaces/${defaultWorkspaceId}/archive`)).status).toBe(200);
    expect((await callAdmin('GET', `/workspaces/${defaultWorkspaceId}`)).status).toBe(404);
  });

  it('lists invitations and chat explorer pages', async () => {
    const invitations = await callAdmin('GET', '/invitations?limit=5');
    expect(invitations.status).toBe(200);
    await expect(invitations.json()).resolves.toMatchObject({ items: expect.any(Array) });

    const explorer = await callAdmin('GET', '/chat-explorer?limit=5&errors_only=true');
    expect(explorer.status).toBe(200);
    await expect(explorer.json()).resolves.toMatchObject({ items: expect.any(Array) });
  });
});
