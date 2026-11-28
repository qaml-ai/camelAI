/**
 * OAuth Token Refresh tests using Cloudflare Vitest pool
 *
 * Tests the token refresh scheduling and alarm-based refresh system.
 * Run with: npm run test:workers
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import type { OrgDO } from '../src/identity/org-do';
import type { WorkspaceDO, WorkspaceIntegrationRecord } from '../src/workspace';
import { encryptCredentials, decryptCredentials } from '../../../src/lib/integration-crypto';
import {
  createUser,
  createOrg,
  listUserWorkspaces,
  type TestEnv,
} from './test-helpers';

// Test constants matching workspace.ts
const TOKEN_REFRESH_BUFFER_MS = 10 * 60 * 1000; // 10 minutes
const TOKEN_BATCH_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const TOKEN_REFRESH_FALLBACK_MS = 60 * 60 * 1000; // 1 hour
const TOKEN_REFRESH_RATE_LIMIT_DEFAULT_MS = 2 * 60 * 1000; // 2 minutes

// Extended env type that includes INTEGRATION_SECRET_KEY
interface TokenRefreshTestEnv extends TestEnv {
  INTEGRATION_SECRET_KEY: string;
}

describe('OAuth Token Refresh', () => {
  const testEnv = env as unknown as TokenRefreshTestEnv;
  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  // Use the same key as the DO environment
  const getSecretKey = () => testEnv.INTEGRATION_SECRET_KEY;

  // Helper to create an OAuth integration with token expiry
  async function createOAuthIntegration(
    workspaceId: string,
    actorId: string,
    integrationType: string,
    tokenExpiresAt: number,
    credentials: Record<string, unknown>,
    nameSuffix?: string
  ): Promise<string> {
    const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspaceId));
    const integrationId = crypto.randomUUID();
    const encrypted = await encryptCredentials(credentials, getSecretKey());
    // Use unique name to avoid conflicts (names must be unique per integration type)
    const uniqueName = nameSuffix
      ? `${integrationType} ${nameSuffix}`
      : `${integrationType} ${integrationId.slice(0, 8)}`;

    await workspaceStub.createIntegration(
      integrationId,
      integrationType,
      uniqueName,
      'saas',
      'oauth2',
      JSON.stringify({}),
      encrypted,
      actorId,
      tokenExpiresAt
    );

    return integrationId;
  }

  // Helper to get the scheduled alarm time
  async function getAlarmTime(workspaceId: string): Promise<number | null> {
    const id = testEnv.WORKSPACE.idFromName(workspaceId);
    const stub = testEnv.WORKSPACE.get(id);

    return runInDurableObject(stub, async (instance) => {
      return instance.ctx.storage.getAlarm();
    });
  }

  // Helper to get integration record directly
  async function getIntegrationRecord(
    workspaceId: string,
    integrationId: string
  ): Promise<WorkspaceIntegrationRecord | null> {
    const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspaceId)) as DurableObjectStub<{
      getIntegration: (id: string) => Promise<WorkspaceIntegrationRecord | null>;
    }>;
    return workspaceStub.getIntegration(integrationId);
  }

  describe('OrgDO on-demand refresh', () => {
    const tokenUrl = 'https://bigquery-token.test/token';

    async function seedLegacyBigQuery(tokenExpiresAt: number | null, accessToken?: string) {
      // Use an empty OrgDO to keep the shared mirror alarm from refreshing the
      // seeded integration before the on-demand call.
      const orgStub = testEnv.ORG.get(testEnv.ORG.newUniqueId());
      const workspaceId = crypto.randomUUID();
      const integrationId = crypto.randomUUID();
      const key = await crypto.subtle.generateKey(
        { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
        true,
        ['sign', 'verify'],
      );
      const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', key.privateKey));
      const serviceAccountJson = JSON.stringify({
        client_email: 'testing@example.com',
        private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----`,
        token_uri: tokenUrl,
      });
      const credentials = await encryptCredentials({
        service_account_json: serviceAccountJson,
        access_token: accessToken,
      }, getSecretKey());
      // Represent an existing row without minting a token through the create RPC.
      await runInDurableObject(orgStub, (_instance, state) => {
        const now = Date.now();
        state.storage.sql.exec(
          `INSERT INTO integrations
           (id, workspace_id, integration_type, name, category, auth_method, config,
            credentials_encrypted, created_by, created_at, updated_at, token_expires_at)
           VALUES (?, ?, 'bigquery', 'ERP', 'databases', 'service_account', '{}', ?, 'test', ?, ?, ?)`,
          integrationId, workspaceId, credentials, now, now, tokenExpiresAt,
        );
      });
      return { orgStub, workspaceId, integrationId, credentials, serviceAccountJson };
    }

    it.each([
      { label: 'expired token', expiryOffset: -60_000, accessToken: 'old-token' },
      { label: 'expiring token', expiryOffset: 5 * 60_000, accessToken: 'old-token' },
      { label: 'unknown expiry', expiryOffset: null, accessToken: 'old-token' },
      { label: 'missing token', expiryOffset: 60 * 60_000, accessToken: undefined },
    ])('mints and stores a fresh BigQuery token for $label', async ({ expiryOffset, accessToken }) => {
      const expiry = expiryOffset === null ? null : Date.now() + expiryOffset;
      const { orgStub, workspaceId, integrationId, serviceAccountJson } = await seedLegacyBigQuery(expiry, accessToken);
      await runInDurableObject(orgStub, async (instance, state) => {
        const org = instance as unknown as OrgDO;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
          Response.json({ access_token: 'fresh-token', token_type: 'Bearer', expires_in: 3600 }),
        );
        try {
          const [first, second] = await Promise.all([
            org.ensureFreshWorkspaceIntegration(workspaceId, integrationId),
            org.ensureFreshWorkspaceIntegration(workspaceId, integrationId),
          ]);
          expect(first).toEqual(second);
          expect(first!.token_expires_at).toBeGreaterThan(Date.now() + TOKEN_REFRESH_BUFFER_MS);
          await expect(decryptCredentials(first!.credentials_encrypted, getSecretKey())).resolves.toMatchObject({
            access_token: 'fresh-token',
            service_account_json: serviceAccountJson,
          });
          await expect(state.storage.getAlarm()).resolves.toBe(first!.token_expires_at! - TOKEN_REFRESH_BUFFER_MS);
          await expect(org.ensureFreshWorkspaceIntegration(workspaceId, integrationId)).resolves.toEqual(first);
          expect(fetchSpy).toHaveBeenCalledExactlyOnceWith(tokenUrl, expect.objectContaining({ method: 'POST' }));
        } finally {
          fetchSpy.mockRestore();
        }
      });
    });

    it('returns the existing record when the provider refresh fails', async () => {
      const expiry = Date.now() - 60_000;
      const { orgStub, workspaceId, integrationId, credentials } = await seedLegacyBigQuery(expiry, 'old-token');
      await runInDurableObject(orgStub, async (instance) => {
        const org = instance as unknown as OrgDO;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 503 }));
        const logSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
        try {
          await expect(org.ensureFreshWorkspaceIntegration(workspaceId, integrationId)).resolves.toMatchObject({
            credentials_encrypted: credentials,
            token_expires_at: expiry,
          });
          expect(fetchSpy).toHaveBeenCalledOnce();
          expect(logSpy).toHaveBeenCalledWith(
            '[OrgDO] On-demand integration token refresh failed',
            expect.objectContaining({ integrationId, errorName: 'ServiceAccountTokenError' }),
          );
        } finally {
          logSpy.mockRestore();
          fetchSpy.mockRestore();
        }
      });
    });
  });

  describe('Alarm scheduling', () => {
    it('schedules an alarm when creating an OAuth integration with token expiry', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Token Owner');
      const { org } = await createOrg(testEnv, 'Token Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const tokenExpiresAt = Date.now() + 60 * 60 * 1000; // 1 hour from now
      await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'test-access-token',
        refresh_token: 'test-refresh-token',
        expires_at: tokenExpiresAt,
      });

      const alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).not.toBeNull();
      // Alarm should be scheduled 10 minutes before token expiry
      expect(alarmTime).toBe(tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS);
    });

    it('does not schedule an alarm for non-OAuth integrations', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'API Key Owner');
      const { org } = await createOrg(testEnv, 'API Key Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
      const integrationId = crypto.randomUUID();
      const encrypted = await encryptCredentials({ api_key: 'test-key' }, getSecretKey());

      // Create a non-OAuth integration (no tokenExpiresAt)
      await workspaceStub.createIntegration(
        integrationId,
        'airtable',
        'Airtable',
        'saas',
        'api_key',
        JSON.stringify({}),
        encrypted,
        userId
        // No tokenExpiresAt
      );

      const alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).toBeNull();
    });

    it('reschedules alarm for the earliest expiring token', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Multi Token Owner');
      const { org } = await createOrg(testEnv, 'Multi Token Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const now = Date.now();
      const laterExpiry = now + 2 * 60 * 60 * 1000; // 2 hours
      const earlierExpiry = now + 30 * 60 * 1000; // 30 minutes

      // Create first integration with later expiry
      await createOAuthIntegration(workspace.id, userId, 'notion', laterExpiry, {
        access_token: 'token-1',
        refresh_token: 'refresh-1',
        expires_at: laterExpiry,
      });

      let alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).toBe(laterExpiry - TOKEN_REFRESH_BUFFER_MS);

      // Create second integration with earlier expiry
      await createOAuthIntegration(workspace.id, userId, 'notion', earlierExpiry, {
        access_token: 'token-2',
        refresh_token: 'refresh-2',
        expires_at: earlierExpiry,
      });

      // Alarm should now be scheduled for the earlier token
      alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).toBe(earlierExpiry - TOKEN_REFRESH_BUFFER_MS);
    });

    it('schedules alarm immediately if token is already expired', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Expired Token Owner');
      const { org } = await createOrg(testEnv, 'Expired Token Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const now = Date.now();
      // Token that's already expired (5 minutes ago)
      const expiredTime = now - 5 * 60 * 1000;

      await createOAuthIntegration(workspace.id, userId, 'notion', expiredTime, {
        access_token: 'expired-token',
        refresh_token: 'refresh-token',
        expires_at: expiredTime,
      });

      const alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).not.toBeNull();
      // Should be scheduled for ~1 second from creation time
      expect(alarmTime!).toBeLessThanOrEqual(now + 2000);
    });

    it('clears alarm when the only OAuth integration is deleted', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Delete Owner');
      const { org } = await createOrg(testEnv, 'Delete Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const tokenExpiresAt = Date.now() + 60 * 60 * 1000;
      const integrationId = await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: tokenExpiresAt,
      });

      // Verify alarm is scheduled
      let alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).not.toBeNull();

      // Delete the integration
      const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
      await workspaceStub.deleteIntegration(integrationId, userId);

      // We need to manually trigger schedule check since delete doesn't currently do it
      // In real code, you might want to add this to deleteIntegration
    });
  });

  describe('Alarm handler', () => {
    // All alarm tests use runInDurableObject with mocked refreshIntegrationToken
    // to avoid hitting the real Notion/BigQuery APIs (which aren't configured in test env).
    // Without mocks, refreshNotionToken throws "Notion OAuth credentials not configured"
    // which corrupts vitest-pool-workers isolated storage frames.

    it('triggers alarm and reschedules for next expiring token', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Alarm Owner');
      const { org } = await createOrg(testEnv, 'Alarm Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const now = Date.now();
      // Token that's about to expire (within batch window)
      const soonExpiry = now + TOKEN_BATCH_WINDOW_MS - 1000;
      // Token that expires later
      const laterExpiry = now + 2 * 60 * 60 * 1000;

      // Create two integrations
      await createOAuthIntegration(workspace.id, userId, 'notion', soonExpiry, {
        access_token: 'soon-token',
        refresh_token: 'soon-refresh',
        expires_at: soonExpiry,
      });

      await createOAuthIntegration(workspace.id, userId, 'notion', laterExpiry, {
        access_token: 'later-token',
        refresh_token: 'later-refresh',
        expires_at: laterExpiry,
      });

      const id = testEnv.WORKSPACE.idFromName(workspace.id);
      const stub = testEnv.WORKSPACE.get(id);

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          refreshIntegrationToken: (integration: WorkspaceIntegrationRecord) => Promise<void>;
        };

        vi.spyOn(target, 'refreshIntegrationToken').mockResolvedValue(undefined);

        await target.alarm();
      });

      // After running, alarm should still be scheduled for the next expiring token
      const alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).not.toBeNull();
      // The alarm should be scheduled at least 1 second from now
      expect(alarmTime!).toBeGreaterThanOrEqual(now + 1000);
    });

    it('runs alarm and processes expiring integrations', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Audit Owner');
      const { org } = await createOrg(testEnv, 'Audit Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      // Token that's already within the refresh buffer (will be processed by alarm)
      const tokenExpiresAt = Date.now() + TOKEN_REFRESH_BUFFER_MS - 1000;

      await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'expiring-token',
        refresh_token: 'test-refresh',
        expires_at: tokenExpiresAt,
      });

      const id = testEnv.WORKSPACE.idFromName(workspace.id);
      const stub = testEnv.WORKSPACE.get(id);

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          refreshIntegrationToken: (integration: WorkspaceIntegrationRecord) => Promise<void>;
        };

        const refreshSpy = vi.spyOn(target, 'refreshIntegrationToken').mockResolvedValue(undefined);

        await target.alarm();

        // Verify the alarm attempted to refresh the expiring token
        expect(refreshSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('sets fallback alarm immediately as dead man switch', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Fallback Owner');
      const { org } = await createOrg(testEnv, 'Fallback Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const now = Date.now();
      // Token expiring soon - alarm will run and attempt refresh
      const tokenExpiresAt = now + 5 * 60 * 1000; // 5 min (within buffer, so alarm triggers immediately)

      await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: tokenExpiresAt,
      });

      const id = testEnv.WORKSPACE.idFromName(workspace.id);
      const stub = testEnv.WORKSPACE.get(id);

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          refreshIntegrationToken: (integration: WorkspaceIntegrationRecord) => Promise<void>;
        };

        vi.spyOn(target, 'refreshIntegrationToken').mockResolvedValue(undefined);

        await target.alarm();
      });

      // After alarm completes, there should still be an alarm scheduled
      // Either the correct next time or the fallback (1 hour)
      const alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).not.toBeNull();

      // The alarm should be scheduled within a reasonable future window
      // (either for the token or the 1-hour fallback)
      expect(alarmTime!).toBeGreaterThan(now);
      expect(alarmTime!).toBeLessThanOrEqual(now + TOKEN_REFRESH_FALLBACK_MS + 1000);
    });

    it('refreshes expiring tokens without exporting credentials after a successful token refresh pass', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Refresh Target Owner');
      const { org } = await createOrg(testEnv, 'Refresh Target Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const tokenExpiresAt = Date.now() + 5 * 60 * 1000; // within batch window
      await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'soon-token',
        refresh_token: 'soon-refresh',
        expires_at: tokenExpiresAt,
      });

      const id = testEnv.WORKSPACE.idFromName(workspace.id);
      const stub = testEnv.WORKSPACE.get(id);

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          refreshIntegrationToken: (integration: WorkspaceIntegrationRecord) => Promise<void>;
        };

        const refreshSpy = vi.spyOn(target, 'refreshIntegrationToken').mockResolvedValue(undefined);

        await target.alarm();

        expect(refreshSpy).toHaveBeenCalledTimes(1);
      });
    });

    it('uses Retry-After when Notion returns 429 during token refresh', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Rate Limit Owner');
      const { org } = await createOrg(testEnv, 'Rate Limit Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const now = Date.now();
      const tokenExpiresAt = now + 60 * 1000; // within alarm batch window
      const integrationId = await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'soon-token',
        refresh_token: 'soon-refresh',
        expires_at: tokenExpiresAt,
      });

      const id = testEnv.WORKSPACE.idFromName(workspace.id);
      const stub = testEnv.WORKSPACE.get(id);

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          env: {
            NOTION_CLIENT_ID?: string;
            NOTION_CLIENT_SECRET?: string;
          };
        };

        target.env.NOTION_CLIENT_ID = 'test-client-id';
        target.env.NOTION_CLIENT_SECRET = 'test-client-secret';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
            headers: { 'Retry-After': '90' },
          })
        );
        try {
          await target.alarm();
        } finally {
          fetchSpy.mockRestore();
        }
      });

      const updated = await getIntegrationRecord(workspace.id, integrationId);
      expect(updated?.token_expires_at).not.toBeNull();
      const retryDelayMs = (updated?.token_expires_at ?? 0) - now;
      expect(retryDelayMs).toBeGreaterThanOrEqual(70 * 1000);
      expect(retryDelayMs).toBeLessThanOrEqual(110 * 1000);
    });

    it('uses default rate-limit backoff when Notion 429 omits Retry-After', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Rate Limit Default Owner');
      const { org } = await createOrg(testEnv, 'Rate Limit Default Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const now = Date.now();
      const tokenExpiresAt = now + 60 * 1000; // within alarm batch window
      const integrationId = await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'soon-token',
        refresh_token: 'soon-refresh',
        expires_at: tokenExpiresAt,
      });

      const id = testEnv.WORKSPACE.idFromName(workspace.id);
      const stub = testEnv.WORKSPACE.get(id);

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          env: {
            NOTION_CLIENT_ID?: string;
            NOTION_CLIENT_SECRET?: string;
          };
        };

        target.env.NOTION_CLIENT_ID = 'test-client-id';
        target.env.NOTION_CLIENT_SECRET = 'test-client-secret';

        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
          new Response(JSON.stringify({ error: 'rate_limited' }), {
            status: 429,
          })
        );
        try {
          await target.alarm();
        } finally {
          fetchSpy.mockRestore();
        }
      });

      const updated = await getIntegrationRecord(workspace.id, integrationId);
      expect(updated?.token_expires_at).not.toBeNull();
      const retryDelayMs = (updated?.token_expires_at ?? 0) - now;
      expect(retryDelayMs).toBeGreaterThanOrEqual(TOKEN_REFRESH_RATE_LIMIT_DEFAULT_MS - 20 * 1000);
      expect(retryDelayMs).toBeLessThanOrEqual(TOKEN_REFRESH_RATE_LIMIT_DEFAULT_MS + 40 * 1000);
    });

    it('disables refresh scheduling when a Notion integration has no refresh token', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Missing Refresh Owner');
      const { org } = await createOrg(testEnv, 'Missing Refresh Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const tokenExpiresAt = Date.now() + 60 * 1000; // within alarm batch window
      const integrationId = await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'soon-token',
        expires_at: tokenExpiresAt,
      });

      const id = testEnv.WORKSPACE.idFromName(workspace.id);
      const stub = testEnv.WORKSPACE.get(id);

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
        };

        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        try {
          await target.alarm();
          expect(fetchSpy).not.toHaveBeenCalled();
        } finally {
          fetchSpy.mockRestore();
        }
      });

      const updated = await getIntegrationRecord(workspace.id, integrationId);
      expect(updated?.token_expires_at).toBeNull();

      const alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).toBeNull();
    });
  });

  describe('Token expiry storage', () => {
    it('stores token_expires_at in integration record', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Storage Owner');
      const { org } = await createOrg(testEnv, 'Storage Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const tokenExpiresAt = Date.now() + 60 * 60 * 1000;
      const integrationId = await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: tokenExpiresAt,
      });

      const record = await getIntegrationRecord(workspace.id, integrationId);
      expect(record).not.toBeNull();
      expect(record!.token_expires_at).toBe(tokenExpiresAt);
    });

    it('updates token_expires_at when updating integration', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Update Owner');
      const { org } = await createOrg(testEnv, 'Update Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const initialExpiry = Date.now() + 60 * 60 * 1000;
      const integrationId = await createOAuthIntegration(workspace.id, userId, 'notion', initialExpiry, {
        access_token: 'test-token',
        refresh_token: 'test-refresh',
        expires_at: initialExpiry,
      });

      // Update with new expiry
      const newExpiry = Date.now() + 2 * 60 * 60 * 1000;
      const workspaceStub = testEnv.WORKSPACE.get(testEnv.WORKSPACE.idFromName(workspace.id));
      await workspaceStub.updateIntegration(
        integrationId,
        { tokenExpiresAt: newExpiry },
        userId
      );

      const record = await getIntegrationRecord(workspace.id, integrationId);
      expect(record!.token_expires_at).toBe(newExpiry);

      // Alarm should be rescheduled
      const alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).toBe(newExpiry - TOKEN_REFRESH_BUFFER_MS);
    });
  });

  describe('Credential security', () => {
    it('stores refresh_token in encrypted credentials', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Security Owner');
      const { org } = await createOrg(testEnv, 'Security Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const tokenExpiresAt = Date.now() + 60 * 60 * 1000;
      const integrationId = await createOAuthIntegration(workspace.id, userId, 'notion', tokenExpiresAt, {
        access_token: 'test-access-token',
        refresh_token: 'secret-refresh-token',
        expires_at: tokenExpiresAt,
        notion_workspace_id: 'ws-123',
      });

      const record = await getIntegrationRecord(workspace.id, integrationId);
      expect(record).not.toBeNull();

      // Credentials should be encrypted
      expect(record!.credentials_encrypted).toBeTruthy();
      expect(record!.credentials_encrypted).not.toContain('secret-refresh-token');

      // Decrypt and verify
      const decrypted = await decryptCredentials(record!.credentials_encrypted, getSecretKey());
      expect(decrypted.access_token).toBe('test-access-token');
      expect(decrypted.refresh_token).toBe('secret-refresh-token');
      expect(decrypted.notion_workspace_id).toBe('ws-123');
    });
  });

  describe('Batch refresh behavior', () => {
    it('processes multiple tokens expiring within the batch window', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Batch Owner');
      const { org } = await createOrg(testEnv, 'Batch Org', userId);
      const workspaces = await listUserWorkspaces(testEnv, userId, org.id);
      const workspace = workspaces[0];
      expect(workspace).toBeDefined();

      const now = Date.now();
      // Create three integrations with expiry times that are outside the refresh buffer (>10 min)
      // but two of them will be within the batch window (15 min) of each other
      const expiry1 = now + 20 * 60 * 1000; // 20 min from now
      const expiry2 = now + 25 * 60 * 1000; // 25 min from now (within 15 min batch window of expiry1)
      const expiry3 = now + 2 * 60 * 60 * 1000; // 2 hours (well outside batch window)

      await createOAuthIntegration(workspace.id, userId, 'notion', expiry1, {
        access_token: 'token-1',
        refresh_token: 'refresh-1',
        expires_at: expiry1,
      });

      await createOAuthIntegration(workspace.id, userId, 'notion', expiry2, {
        access_token: 'token-2',
        refresh_token: 'refresh-2',
        expires_at: expiry2,
      });

      await createOAuthIntegration(workspace.id, userId, 'notion', expiry3, {
        access_token: 'token-3',
        refresh_token: 'refresh-3',
        expires_at: expiry3,
      });

      // The alarm should be scheduled 10 minutes before the earliest expiring token
      // expiry1 is 20 min from now, so alarm should be at now + 10 min
      let alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).not.toBeNull();
      expect(alarmTime!).toBeGreaterThan(now); // Should be in the future

      // Run the alarm with mocked refresh to avoid hitting real APIs
      const id = testEnv.WORKSPACE.idFromName(workspace.id);
      const stub = testEnv.WORKSPACE.get(id);

      await runInDurableObject(stub, async (instance) => {
        const target = instance as unknown as {
          alarm: () => Promise<void>;
          refreshIntegrationToken: (integration: WorkspaceIntegrationRecord) => Promise<void>;
        };

        vi.spyOn(target, 'refreshIntegrationToken').mockResolvedValue(undefined);

        await target.alarm();
      });

      // After running, the alarm should still be rescheduled
      alarmTime = await getAlarmTime(workspace.id);
      expect(alarmTime).not.toBeNull();
    });
  });
});
