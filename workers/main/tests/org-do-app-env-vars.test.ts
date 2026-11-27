import { describe, expect, it, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { createOrg, createUser, type TestEnv } from './test-helpers';
import { agentMcpTools, agentToolServer } from '../src/routes/agent-mcp';
import type { Env } from '../src/types';

const testEnv = env as unknown as TestEnv;
const testEmail = () => `secrets-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

describe('OrgDO app runtime secrets & environment variables', () => {
  it('encrypts secrets at rest, hides secret values in listAppEnvVars, decrypts for deploy, and bumps KV env_version', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password', 'Secrets User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Secrets Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    await orgStub.registerWorkerScript('inventreetracker', defaultWorkspaceId as string, userId);

    // Seed the dispatcher KV registry entry so env_version bumps can be verified.
    const kvKey = `script:inventreetracker--${org.slug}`;
    await testEnv.APP_KV.put(
      kvKey,
      JSON.stringify({
        org_id: org.id,
        org_slug: org.slug,
        is_public: true,
        runtime_mode: 'dynamic',
        env_version: 2,
      }),
    );

    const saved = await orgStub.setAppEnvVars(
      'inventreetracker',
      [
        { key: 'SESSION_SECRET', value: 'super-secret-session-token', isSecret: true },
        { key: 'ADMIN_API_KEY', value: 'admin-key-123', isSecret: true },
        { key: 'PUBLIC_APP_LABEL', value: 'InvTree Prod', isSecret: false },
      ],
      userId,
    );

    expect(saved.envVersion).toBe(3);
    expect(saved.vars).toHaveLength(3);

    // listAppEnvVars must NEVER expose secret values, but returns plain values.
    const listed = await orgStub.listAppEnvVars('inventreetracker');
    const sessionMeta = listed.find((v) => v.key === 'SESSION_SECRET');
    const adminMeta = listed.find((v) => v.key === 'ADMIN_API_KEY');
    const labelMeta = listed.find((v) => v.key === 'PUBLIC_APP_LABEL');

    expect(sessionMeta).toMatchObject({ key: 'SESSION_SECRET', isSecret: true, updatedBy: userId });
    expect(sessionMeta).not.toHaveProperty('value');
    expect(adminMeta).toMatchObject({ key: 'ADMIN_API_KEY', isSecret: true });
    expect(adminMeta).not.toHaveProperty('value');
    expect(labelMeta).toMatchObject({
      key: 'PUBLIC_APP_LABEL',
      isSecret: false,
      value: 'InvTree Prod',
    });

    // getAppEnvVarsForDeploy decrypts all vars for chiridion-dispatcher overlay.
    const forDeploy = await orgStub.getAppEnvVarsForDeploy('inventreetracker');
    expect(forDeploy).toEqual([
      { key: 'ADMIN_API_KEY', value: 'admin-key-123', isSecret: true },
      { key: 'PUBLIC_APP_LABEL', value: 'InvTree Prod', isSecret: false },
      { key: 'SESSION_SECRET', value: 'super-secret-session-token', isSecret: true },
    ]);

    // KV env_version was incremented to bust dispatcher cache immediately.
    const kvAfterSave = JSON.parse((await testEnv.APP_KV.get(kvKey))!);
    expect(kvAfterSave.env_version).toBe(3);

    // Rotate SESSION_SECRET and verify updated value + bumped env_version.
    const rotated = await orgStub.setAppEnvVars(
      'inventreetracker',
      [{ key: 'SESSION_SECRET', value: 'rotated-secret-value', isSecret: true }],
      userId,
    );
    expect(rotated.envVersion).toBe(4);
    const forDeployAfterRotate = await orgStub.getAppEnvVarsForDeploy('inventreetracker');
    expect(forDeployAfterRotate.find((v) => v.key === 'SESSION_SECRET')?.value).toBe('rotated-secret-value');

    // Delete ADMIN_API_KEY and verify removal + KV bump.
    const deleted = await orgStub.deleteAppEnvVar('inventreetracker', 'ADMIN_API_KEY', userId);
    expect(deleted.deleted).toBe(true);
    expect(deleted.envVersion).toBe(5);
    expect(deleted.vars.map((v) => v.key)).toEqual(['PUBLIC_APP_LABEL', 'SESSION_SECRET']);

    // Deleting the worker script purges its env vars.
    expect(await orgStub.deleteWorkerScript('inventreetracker', userId)).toBe(true);
    expect(await orgStub.getAppEnvVarsForDeploy('inventreetracker')).toEqual([]);
  });

  it('rejects invalid variable names and unknown apps', async () => {
    const { userId } = await createUser(testEnv, testEmail(), 'password', 'Secrets User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Validation Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

    await runInDurableObject(orgStub, async (instance) => {
      await expect(
        instance.setAppEnvVars('missing-app', [{ key: 'FOO', value: 'bar' }], userId),
      ).rejects.toThrow('App not found');

      await instance.registerWorkerScript('my-app', defaultWorkspaceId as string, userId);
      await expect(
        instance.setAppEnvVars('my-app', [{ key: '123-INVALID', value: 'bar' }], userId),
      ).rejects.toThrow('Invalid variable name');
    });
  });

  it('exposes prompt_app_secrets as direct MCP tool and returns only key names after blind save', async () => {
    const toolMeta = agentMcpTools().find((t) => t.name === 'prompt_app_secrets') as
      | { name: string; _meta?: Record<string, unknown> }
      | undefined;
    expect(toolMeta?.name).toBe('prompt_app_secrets');
    expect(toolMeta?._meta?.['agent-runtime/exposure']).toBe('direct');

    const { userId } = await createUser(testEnv, testEmail(), 'password', 'Builder User');
    const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Builder Org', userId);
    const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
    const thread = await orgStub.createThread(defaultWorkspaceId as string, 'Build thread', userId);
    await orgStub.registerWorkerScript('inventreetracker', defaultWorkspaceId as string, userId);

    const server = agentToolServer(
      testEnv as unknown as Env,
      () => ({
        describeDestructiveConfirmation: vi.fn(async () => null),
        callToolEnvelope: vi.fn(async () => ({ ok: true as const, data: {} })),
      }),
    );

    const askedSchemas: Record<string, unknown>[] = [];
    const result = await server.callTool(
      'prompt_app_secrets',
      {
        app_name: 'inventreetracker',
        message: 'Configure signing and push secrets',
        keys: [
          { key: 'SESSION_SECRET', description: 'Cookie signing secret' },
          { key: 'ADMIN_API_KEY', description: 'Admin API auth key' },
        ],
      },
      {
        signal: new AbortController().signal,
        idempotencyKey: 'idem-1',
        callId: 'call-1',
        progress: () => {},
        identity: {
          tenant: '',
          user: userId,
          context: {
            org: org.id,
            workspace: defaultWorkspaceId as string,
            thread: thread.id,
          },
        },
        confirm: vi.fn(async () => true),
        requireUrl: vi.fn(async () => true),
        ask: vi.fn(async (_msg, schema) => {
          askedSchemas.push(schema);
          // Simulate browser saving secrets directly to OrgDO (never passing values in answer!)
          await orgStub.setAppEnvVars(
            'inventreetracker',
            [
              { key: 'SESSION_SECRET', value: 'TOP_SECRET_VALUE_999', isSecret: true },
              { key: 'ADMIN_API_KEY', value: 'ADMIN_SECRET_VALUE_888', isSecret: true },
            ],
            userId,
          );
          return { saved: true };
        }),
      } as never,
    );

    expect(askedSchemas).toHaveLength(1);
    expect(askedSchemas[0]?.['x-camelai-kind']).toBe('app_secrets');

    const serialized = JSON.stringify(result);
    // Secret values MUST NEVER appear anywhere in the agent-visible tool result!
    expect(serialized).not.toContain('TOP_SECRET_VALUE_999');
    expect(serialized).not.toContain('ADMIN_SECRET_VALUE_888');
    expect(result.structuredContent).toMatchObject({
      ok: true,
      app_name: 'inventreetracker',
      cancelled: false,
      configured_keys: ['SESSION_SECRET', 'ADMIN_API_KEY'],
      missing_keys: [],
    });
  });
});
