import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { createOrg, createUser, type TestEnv } from './test-helpers';

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
});
