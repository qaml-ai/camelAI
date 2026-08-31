import { describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:test';
import { handleAdminApi } from '../src/routes/admin/index';
import type { Env as WorkerEnv } from '../src/types';
import { createOrg, createUser, type TestEnv } from './test-helpers';
import { getAppIndexReadDatabase } from '../src/app-index-db';

const testEnv = env as unknown as TestEnv;

function testEmail() {
  return `admin-api-thread-update-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function waitForAdminIndexThreadPresence(threadId: string): Promise<void> {
  const appIndex = getAppIndexReadDatabase(testEnv)!;

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const threadContext = await appIndex.getThreadContextById(threadId);
    if (threadContext) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  throw new Error(`Timed out waiting for thread ${threadId} to appear in D1 app index`);
}

describe('admin API thread patch route', () => {
  it('finds threads by raw thread id in admin search', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin API Search User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin API Search Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Thread with non-id title', userId);

    await waitForAdminIndexThreadPresence(thread.id);

    const request = new Request(
      `http://example/api/admin/threads?search=${encodeURIComponent(thread.id)}`,
      {
        headers: {
          Authorization: 'Bearer test-admin-api-key',
        },
      },
    );

    const response = await handleAdminApi({
      req: request,
      env: {
        ...testEnv,
        ADMIN_API_KEY: 'test-admin-api-key',
      } as unknown as WorkerEnv,
      ctx: {} as ExecutionContext,
      url: new URL(request.url),
      match: request.url.match(/^.*$/)!,
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: thread.id })],
      total: 1,
    });
  });

  it('rejects per-thread model changes after creation', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin API User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin API Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Patch thread model', userId);

    await waitForAdminIndexThreadPresence(thread.id);

    const request = new Request(`http://example/api/admin/threads/${thread.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-admin-api-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'opus-5' }),
    });

    const response = await handleAdminApi({
      req: request,
      env: {
        ...testEnv,
        ADMIN_API_KEY: 'test-admin-api-key',
      } as unknown as WorkerEnv,
      ctx: {} as ExecutionContext,
      url: new URL(request.url),
      match: request.url.match(/^.*$/)!,
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(400);
    await expect(response!.json()).resolves.toMatchObject({
      error: 'This thread is locked to its original model. Start a new thread to use a different model.',
    });

    const stored = await orgStub.getThread(thread.id);
    expect(stored?.model).toBe('sonnet');
  });

  it('indexes newly created thread model in D1', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin Index Migration User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin Index Migration Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Legacy null model thread', userId);
    const appIndex = getAppIndexReadDatabase(testEnv)!;

    await waitForAdminIndexThreadPresence(thread.id);

    await expect(appIndex.getThreadContextById(thread.id)).resolves.toMatchObject({ model: 'sonnet' });
  });

  it('normalizes legacy thread models from admin list responses', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin API Legacy List User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin API Legacy List Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Legacy indexed model', userId);

    await waitForAdminIndexThreadPresence(thread.id);
    await testEnv.APP_DB!.prepare('UPDATE threads SET model = ? WHERE id = ?')
      .bind('opus-4.7', thread.id)
      .run();

    const request = new Request(
      `http://example/api/admin/threads?search=${encodeURIComponent(thread.id)}`,
      {
        headers: {
          Authorization: 'Bearer test-admin-api-key',
        },
      },
    );

    const response = await handleAdminApi({
      req: request,
      env: {
        ...testEnv,
        ADMIN_API_KEY: 'test-admin-api-key',
      } as unknown as WorkerEnv,
      ctx: {} as ExecutionContext,
      url: new URL(request.url),
      match: request.url.match(/^.*$/)!,
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      items: [expect.objectContaining({ id: thread.id, model: 'opus-5' })],
      total: 1,
    });
  });

  it('normalizes legacy thread models from admin title-only updates', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin API Legacy Patch User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin API Legacy Patch Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId, 'Legacy stored model', userId);
    await waitForAdminIndexThreadPresence(thread.id);
    await (orgStub as unknown as {
      setThreadModelForTest(id: string, model: string): Promise<unknown>;
    }).setThreadModelForTest(thread.id, 'opus-4.7');

    const request = new Request(`http://example/api/admin/threads/${thread.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-admin-api-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Renamed legacy model' }),
    });

    const response = await handleAdminApi({
      req: request,
      env: {
        ...testEnv,
        ADMIN_API_KEY: 'test-admin-api-key',
      } as unknown as WorkerEnv,
      ctx: {} as ExecutionContext,
      url: new URL(request.url),
      match: request.url.match(/^.*$/)!,
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    await expect(response!.json()).resolves.toMatchObject({
      id: thread.id,
      title: 'Renamed legacy model',
      model: 'opus-5',
    });
    await expect(orgStub.getThread(thread.id)).resolves.toMatchObject({
      model: 'opus-5',
    });
  });

  it('forwards updated thread revisions to ChatThreadDO metadata broadcasts', async () => {
    const email = testEmail();
    const { userId } = await createUser(testEnv, email, 'password123', 'Admin API Revision User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Admin API Revision Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(
      defaultWorkspaceId,
      'Patch thread title',
      userId,
      undefined,
      'opus-5',
    );
    await waitForAdminIndexThreadPresence(thread.id);

    const setTitle = vi.fn().mockResolvedValue(undefined);
    const setModel = vi.fn().mockResolvedValue(undefined);
    const refreshRunnerConfig = vi.fn().mockResolvedValue(undefined);
    const chatThreadGet = vi.fn().mockReturnValue({
      setTitle,
      setModel,
      refreshRunnerConfig,
    });
    const chatThreadIdFromName = vi.fn((id: string) => `chat-thread:${id}`);
    const request = new Request(`http://example/api/admin/threads/${thread.id}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer test-admin-api-key',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ title: 'Renamed through admin API', model: 'opus-5' }),
    });

    const response = await handleAdminApi({
      req: request,
      env: {
        ...testEnv,
        ADMIN_API_KEY: 'test-admin-api-key',
        CHAT_THREAD: {
          idFromName: chatThreadIdFromName,
          get: chatThreadGet,
        },
      } as unknown as WorkerEnv,
      ctx: {} as ExecutionContext,
      url: new URL(request.url),
      match: request.url.match(/^.*$/)!,
    });

    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    const result = await response!.json() as { updated_at: number };
    expect(typeof result.updated_at).toBe('number');
    expect(chatThreadIdFromName).toHaveBeenCalledWith(thread.id);
    expect(setTitle).toHaveBeenCalledWith(
      'Renamed through admin API',
      result.updated_at,
    );
    expect(setModel).toHaveBeenCalledWith(
      'opus-5',
      result.updated_at,
    );
    expect(refreshRunnerConfig).toHaveBeenCalledTimes(1);
  });
});
