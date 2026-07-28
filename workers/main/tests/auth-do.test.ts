/**
 * Full-stack auth tests using Cloudflare Vitest pool
 *
 * These tests run in the Workers runtime with real Durable Objects,
 * testing the complete auth flow through direct DO calls.
 *
 * Run with: npm run test:workers
 */

import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { createNewSession, type SessionData } from '../src/session-kv';
import { getAppIndexDatabase } from '../src/app-index-db';
import {
  createUser,
  getUserByEmail,
  verifyUserPassword,
  createOrg,
  isOrgMember,
  isOrgAdmin,
  getUserOrgs,
  tryRemoveOrgMember,
  getOrgMembers,
  tryUpdateOrgMemberRole,
  createInvitation,
  getOrgInvitations,
  getInvitation,
  acceptInvitation,
  deleteInvitation,
  listOrgWorkspaces,
  createWorkspace,
  getSessionData,
  destroySessionData,
  switchSessionOrg,
  switchSessionWorkspace,
  type TestEnv,
} from './test-helpers';

async function waitForCondition(
  predicate: () => Promise<boolean>,
  timeoutMs = 10_000,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for condition');
}

describe('Auth flow (full-stack with DOs)', () => {
  const testEnv = env as unknown as TestEnv;
  const sessionsKV = env.SESSIONS as KVNamespace;

  // Helper to create a session with the org's default workspace
  async function createTestSession(
    userId: string,
    orgId: string
  ): Promise<{ sessionId: string; sessionData: SessionData }> {
    const workspaces = await listOrgWorkspaces(testEnv, orgId);
    const workspaceId = workspaces[0]?.id ?? null;
    return createNewSession(sessionsKV, userId, orgId, workspaceId);
  }

  // Generate unique email for each test to avoid conflicts
  const testEmail = () => `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

  describe('User creation and retrieval', () => {
    it('should create a new user', async () => {
      const email = testEmail();
      const result = await createUser(testEnv, email, 'password123', 'Test User');

      expect(result.userId).toBeDefined();
      expect(result.user.email).toBe(email);
      expect(result.user.name).toBe('Test User');
      expect(result.user.created_at).toBeTypeOf('number');
    });

    it('should retrieve user by email', async () => {
      const email = testEmail();
      await createUser(testEnv, email, 'password123', 'Test User');

      const result = await getUserByEmail(testEnv, email);

      expect(result).not.toBeNull();
      expect(result!.user.email).toBe(email);
    });

    it('should return null for non-existent email', async () => {
      const result = await getUserByEmail(testEnv, 'nonexistent@example.com');
      expect(result).toBeNull();
    });

    it('should verify correct password', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'correctPassword', 'Test');

      const isValid = await verifyUserPassword(testEnv, userId, 'correctPassword');
      expect(isValid).toBe(true);
    });

    it('should reject incorrect password', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'correctPassword', 'Test');

      const isValid = await verifyUserPassword(testEnv, userId, 'wrongPassword');
      expect(isValid).toBe(false);
    });

    it('requires email verification for password users', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Needs Verify');
      const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));

      const before = await userStub.getEmailVerificationStatus();
      expect(before.required).toBe(true);
      expect(before.verified).toBe(false);

      const updatedProfile = await userStub.markEmailVerified();
      expect(updatedProfile?.email_verified_at).toBeTypeOf('number');

      const after = await userStub.getEmailVerificationStatus();
      expect(after.required).toBe(true);
      expect(after.verified).toBe(true);
    });

    it('marks OAuth users as already verified', async () => {
      const userId = crypto.randomUUID();
      const email = testEmail();
      const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));

      await userStub.createUserFromOAuth(
        userId,
        email,
        'OAuth User',
        'google',
        `google-${crypto.randomUUID()}`
      );

      const status = await userStub.getEmailVerificationStatus();
      expect(status.required).toBe(false);
      expect(status.verified).toBe(true);
      expect(status.email_verified_at).toBeTypeOf('number');
    });

    it('claims new-camel activation exactly once per user', async () => {
      const email = testEmail();
      const { userId } = await createUser(
        testEnv,
        email,
        'password123',
        'Activation User',
      );
      const userStub = testEnv.USER.get(testEnv.USER.idFromName(userId));

      const first = await userStub.claimNewCamelActivation(1_700_000_000_000);
      const repeated = await userStub.claimNewCamelActivation(1_800_000_000_000);

      expect(first).toMatchObject({
        activatedAt: 1_700_000_000_000,
        isFirst: true,
      });
      expect(first.eventId).toBeTypeOf('string');
      expect(repeated).toEqual({ ...first, isFirst: false });
    });
  });

  describe('Organization creation and membership', () => {
    it('should create an org and add creator as owner', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');

      const { org } = await createOrg(testEnv, 'Test Workspace', userId);

      expect(org.id).toBeDefined();
      expect(org.name).toBe('Test Workspace');
      expect(org.created_by).toBe(userId);

      // Creator should be a member
      const isMember = await isOrgMember(testEnv, userId, org.id);
      expect(isMember).toBe(true);

      // Creator should be an admin (owners are admins)
      const isAdmin = await isOrgAdmin(testEnv, userId, org.id);
      expect(isAdmin).toBe(true);
    });

    it('should list user orgs', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'My Workspace', userId);

      const orgs = await getUserOrgs(testEnv, userId);

      expect(orgs).toHaveLength(1);
      expect(orgs[0].org_id).toBe(org.id);
      expect(orgs[0].org_name).toBe('My Workspace');
      expect(orgs[0].role).toBe('owner');
      expect(orgs[0].last_workspace_id).toBeTypeOf('string');
    });

    it('assigns a 6-char hash-based slug on org creation', async () => {
      const ownerEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
      const { org } = await createOrg(testEnv, 'Hash Slug Org', ownerId);

      expect(org.slug).toMatch(/^[a-z0-9]{6,}$/);
      expect(org.slug.length).toBeGreaterThanOrEqual(6);
    });

    it('stores new org custom domains with pending status', async () => {
      const ownerEmail = testEmail();
      const { userId: ownerId } = await createUser(testEnv, ownerEmail, 'password123', 'Owner');
      const { org } = await createOrg(testEnv, 'Custom Domain Org', ownerId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const created = await orgStub.setCustomDomain('apps.example.com', ownerId);
      const stored = await orgStub.getCustomDomain();

      expect(created.status).toBe('pending');
      expect(stored?.status).toBe('pending');
    });
  });

  describe('Organization ownership invariants', () => {
    it('prevents removing the org owner', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Owner');
      const { org } = await createOrg(testEnv, 'Owner Org', userId);

      const result = await tryRemoveOrgMember(testEnv, org.id, userId, userId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Cannot remove organization owner');

      const members = await getOrgMembers(testEnv, org.id);
      expect(members.some((member) => member.user.id === userId && member.role === 'owner')).toBe(
        true
      );
    });

    it('prevents demoting the org owner without transfer', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Owner');
      const { org } = await createOrg(testEnv, 'Owner Org', userId);

      const result = await tryUpdateOrgMemberRole(testEnv, org.id, userId, 'member', userId);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toBe('Cannot change the owner role. Transfer ownership first.');

      const members = await getOrgMembers(testEnv, org.id);
      const owner = members.find((member) => member.user.id === userId);
      expect(owner?.role).toBe('owner');
    });
  });

  describe('Thread creation', () => {
    it('stores explicit fallback titles without setting first_user_message', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Working on my-todo-app', userId);
      const stored = await orgStub.getThread(thread.id);

      expect(thread.title).toBe('Working on my-todo-app');
      expect(thread.first_user_message).toBeNull();
      expect(thread.last_user_message).toBeNull();
      expect(thread.last_user_message_at).toBeNull();
      expect(thread.model).toBe('sonnet');
      expect(stored?.title).toBe('Working on my-todo-app');
      expect(stored?.first_user_message).toBeNull();
      expect(stored?.last_user_message).toBeNull();
      expect(stored?.last_user_message_at).toBeNull();
      expect(stored?.model).toBe('sonnet');
      expect(stored?.last_assistant_summary_status).toBeNull();
    });

    it('seeds channel_kinds for channel-created threads', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Channel Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        'Email thread',
        userId,
        undefined,
        undefined,
        undefined,
        { source: 'channel', channelKind: 'email' },
      );
      const stored = await orgStub.getThread(thread.id);

      expect(thread.channel_kind).toBe('email');
      expect(thread.channel_kinds).toBe(JSON.stringify(['email']));
      expect(stored?.channel_kinds).toBe(JSON.stringify(['email']));
    });

    it('backfills channel_kinds from channel_kind during V31 migration when stored version is 30', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Channel Migration Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        'Slack thread',
        userId,
        undefined,
        undefined,
        undefined,
        { source: 'channel', channelKind: 'slack' },
      );

      await orgStub.downgradeThreadChannelKindsSchemaForTest(30);
      await orgStub.remigrate();

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.channel_kind).toBe('slack');
      expect(stored?.channel_kinds).toBe(JSON.stringify(['slack']));
    });

    it('preserves non-empty channel_kinds during V31 migration', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Channel Preserve Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        'Email thread',
        userId,
        undefined,
        undefined,
        undefined,
        { source: 'channel', channelKind: 'email' },
      );
      await orgStub.recordThreadUserMessage(thread.id, '[slack message from Jane]: First', 'slack');
      await orgStub.setSchemaVersionForTest(30);
      await orgStub.remigrate();

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.channel_kinds).toBe(JSON.stringify(['email', 'slack']));
    });

    it('self-heals legacy thread schema during migration before creating new threads', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Legacy Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Legacy Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      await orgStub.downgradeThreadSchemaForTest();
      await orgStub.remigrate();

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        'Recovered thread',
        userId,
        'hello',
        'gpt-5.6-terra'
      );
      expect(thread.model).toBe('gpt-5.6-terra');
      expect(thread.first_user_message).toBe('hello');
      expect(thread.last_user_message).toBe('hello');
      expect(thread.last_user_message_at).toEqual(expect.any(Number));

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.model).toBe('gpt-5.6-terra');
      expect(stored?.first_user_message).toBe('hello');
      expect(stored?.last_user_message).toBe('hello');
      expect(stored?.last_user_message_at).toEqual(expect.any(Number));
      expect(stored?.last_assistant_completed_at).toBeNull();
      expect(stored?.last_assistant_summary).toBeNull();
      expect(stored?.last_assistant_summary_status).toBeNull();
    });

    it('self-heals missing thread columns even when the stored schema version is current', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Current Version Owner');
      const { org } = await createOrg(testEnv, 'Current Version Repair Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      await orgStub.downgradeThreadSchemaForTest();
      await orgStub.setSchemaVersionForTest(999);
      await orgStub.remigrate();

      await expect(orgStub.getMember(userId)).resolves.toMatchObject({ user_id: userId });
    });

    it('stores and preserves the first user message separately from the thread title', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'First Message Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        undefined,
        userId,
        'Please keep this first prompt',
      );

      expect(thread.title).toBe('New Chat');
      expect(thread.first_user_message).toBe('Please keep this first prompt');
      expect(thread.last_user_message).toBe('Please keep this first prompt');
      expect(thread.last_user_message_at).toEqual(expect.any(Number));

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.title).toBe('New Chat');
      expect(stored?.first_user_message).toBe('Please keep this first prompt');
      expect(stored?.last_user_message).toBe('Please keep this first prompt');
      expect(stored?.last_user_message_at).toEqual(expect.any(Number));

      await orgStub.setThreadFirstUserMessage(thread.id, 'Do not overwrite it');
      const afterBackfill = await orgStub.getThread(thread.id);
      expect(afterBackfill?.first_user_message).toBe('Please keep this first prompt');
      expect(afterBackfill?.last_user_message).toBe('Please keep this first prompt');
    });

    it('normalizes initial first user messages for preview surfaces', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Normalized First Message Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        undefined,
        userId,
        '[Thread Owner (owner@example.com)]: <camelai system message>hidden</camelai system message>\n\nBuild the welcome preview',
      );
      const stored = await orgStub.getThread(thread.id);

      expect(thread.first_user_message).toBe('Build the welcome preview');
      expect(thread.last_user_message).toBe('Build the welcome preview');
      expect(stored?.first_user_message).toBe('Build the welcome preview');
      expect(stored?.last_user_message).toBe('Build the welcome preview');
    });

    it('stores full first user messages for initial transcript hydration', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Long First Message Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const longMessage = `Please keep all of this prompt ${'x'.repeat(900)}`;

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        undefined,
        userId,
        longMessage,
      );
      const stored = await orgStub.getThread(thread.id);

      expect(thread.first_user_message).toBe(longMessage);
      expect(thread.last_user_message).toBe(longMessage);
      expect(stored?.first_user_message).toBe(longMessage);
      expect(stored?.last_user_message).toBe(longMessage);

      const backfilled = await orgStub.createThread(defaultWorkspaceId, undefined, userId);
      await orgStub.setThreadFirstUserMessage(backfilled.id, longMessage);
      const storedBackfill = await orgStub.getThread(backfilled.id);

      expect(storedBackfill?.first_user_message).toBe(longMessage);
    });

    it('records normalized latest user messages and increments the user message count', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Latest Message Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Latest message', userId);
      const updated = await orgStub.recordThreadUserMessage(
        thread.id,
        '[Thread Owner (owner@example.com)]: <camelai system message>hidden</camelai system message>\n\nBuild the hover card',
      );

      expect(updated?.user_message_count).toBe(1);
      expect(updated?.last_user_message).toBe('Build the hover card');
      expect(updated?.last_user_message_at).toEqual(expect.any(Number));

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.user_message_count).toBe(1);
      expect(stored?.last_user_message).toBe('Build the hover card');
      expect(stored?.last_user_message_at).toEqual(expect.any(Number));
      expect(stored?.first_user_message).toBeNull();
    });

    it('records full latest user messages after normalization', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Long Latest Message Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const longMessage = `Please keep this latest message ${'z'.repeat(900)}`;

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Latest long message', userId);
      const updated = await orgStub.recordThreadUserMessage(
        thread.id,
        `[Thread Owner (owner@example.com)]: ${longMessage}`,
      );

      expect(updated?.last_user_message).toBe(longMessage);
      expect(updated?.last_user_message?.length).toBeGreaterThan(500);

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.last_user_message).toBe(longMessage);
    });

    it('merges and dedupes channel_kinds while recording user messages', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Channel Merge Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        'Channel merge',
        userId,
        undefined,
        undefined,
        undefined,
        { source: 'channel', channelKind: 'email' },
      );

      const first = await orgStub.recordThreadUserMessage(
        thread.id,
        '[slack message from Jane]: First message',
        'slack',
      );
      const second = await orgStub.recordThreadUserMessage(
        thread.id,
        '[slack message from Jane]: Second message',
        'SLACK',
      );

      expect(first?.channel_kinds).toBe(JSON.stringify(['email', 'slack']));
      expect(second?.channel_kinds).toBe(JSON.stringify(['email', 'slack']));
      expect(second?.user_message_count).toBe(2);
      expect(second?.last_user_message).toBe('Second message');
    });

    it('records outbound channel usage without touching activity metadata', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Outbound Channel Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Outbound', userId);
      const before = await orgStub.getThread(thread.id);
      const updated = await orgStub.recordThreadChannelUsed(thread.id, 'telegram');
      const afterDuplicate = await orgStub.recordThreadChannelUsed(thread.id, 'telegram');
      const afterIgnored = await orgStub.recordThreadChannelUsed(thread.id, 'web');

      expect(updated?.channel_kinds).toBe(JSON.stringify(['telegram']));
      expect(afterDuplicate?.channel_kinds).toBe(JSON.stringify(['telegram']));
      expect(afterIgnored?.channel_kinds).toBe(JSON.stringify(['telegram']));
      expect(updated?.updated_at).toBe(before?.updated_at);
      expect(updated?.user_message_count).toBe(before?.user_message_count);
    });

    it('syncs first-message previews and channel badges to the admin index', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Explorer Metadata Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
      const appIndex = getAppIndexDatabase(testEnv)!;

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Explorer metadata', userId);
      await appIndex.ensureSchema();
      await testEnv.APP_DB!.prepare('DELETE FROM threads WHERE id = ?').bind(thread.id).run();

      await orgStub.setThreadFirstUserMessage(thread.id, 'Explorer preview prompt');
      await waitForCondition(async () => {
        const row = await appIndex.getThreadContextById(thread.id);
        return row?.first_user_message === 'Explorer preview prompt';
      });

      await orgStub.recordThreadChannelUsed(thread.id, 'telegram');
      await waitForCondition(async () => {
        const row = await appIndex.getThreadContextById(thread.id);
        return row?.channel_kinds === JSON.stringify(['telegram']);
      });
    });

    it('records thread chat errors idempotently by normalized event id', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Error Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Errored thread', userId);
      const createdAt = Date.now();
      const input = {
        message: 'Provider returned 429 for request req_abc123',
        source: 'runner_send',
        errorKind: 'rate_limit',
        status: 429,
        provider: 'openai',
        model: 'sonnet',
        userId,
        createdAt,
      };

      const first = await orgStub.recordThreadError(thread.id, input);
      const duplicate = await orgStub.recordThreadError(thread.id, input);
      const afterDuplicate = await orgStub.getThread(thread.id);

      expect(first?.chat_error_count).toBe(1);
      expect(duplicate?.chat_error_count).toBe(1);
      expect(afterDuplicate?.chat_error_count).toBe(1);
      expect(afterDuplicate?.last_chat_error_status).toBe(429);
      expect(afterDuplicate?.last_chat_error_source).toBe('runner_send');

      const next = await orgStub.recordThreadError(thread.id, {
        ...input,
        createdAt: createdAt + 1,
      });
      expect(next?.chat_error_count).toBe(2);
    });

    it('loads multiple threads for one workspace in a single batch call', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Batch Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const first = await orgStub.createThread(defaultWorkspaceId, 'First thread', userId);
      const second = await orgStub.createThread(defaultWorkspaceId, 'Second thread', userId);
      const otherWorkspace = await createWorkspace(testEnv, org.id, 'Other workspace', userId);
      const otherThread = await orgStub.createThread(otherWorkspace.id, 'Other thread', userId);

      const threads = await orgStub.getThreadsByIds(defaultWorkspaceId, [
        first.id,
        second.id,
        first.id,
        otherThread.id,
      ]);

      expect(threads.map((thread) => thread.id).sort()).toEqual(
        [first.id, second.id].sort(),
      );
    });

    it('records assistant completion metadata without incrementing user messages', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Completion Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Completion thread', userId);
      await orgStub.recordThreadUserMessage(thread.id, 'First prompt');
      const afterUserMessage = await orgStub.getThread(thread.id);
      const completedAt = (afterUserMessage?.updated_at ?? Date.now()) + 10;

      await expect(
        orgStub.recordThreadAssistantCompletion(thread.id, {
          completedAt,
          summary: 'Summary:\n\nFound the issue.',
        }),
      ).resolves.toEqual(expect.any(Number));
      const afterCompletion = await orgStub.getThread(thread.id);

      expect(afterCompletion?.user_message_count).toBe(1);
      expect(afterCompletion?.last_assistant_completed_at).toBeGreaterThanOrEqual(
        completedAt,
      );
      expect(afterCompletion?.last_assistant_summary).toBe('Found the issue.');
      expect(afterCompletion?.last_assistant_summary_status).toBe('ready');
    });

    it('returns the stored assistant completion timestamp when coercing stale inputs', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Returned Completion Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Completion thread', userId);
      await orgStub.recordThreadUserMessage(thread.id, 'First prompt');
      const afterUserMessage = await orgStub.getThread(thread.id);
      const staleCompletionAt = (afterUserMessage?.updated_at ?? Date.now()) - 1_000;

      const storedCompletedAt = await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: staleCompletionAt,
        summary: null,
        summaryStatus: 'pending',
      });
      const afterCompletion = await orgStub.getThread(thread.id);

      expect(storedCompletedAt).toBe(afterCompletion?.last_assistant_completed_at);
      expect(storedCompletedAt).toBeGreaterThan(afterUserMessage?.updated_at ?? 0);
    });

    it('stores monotonic assistant completion timestamps for stale inputs', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Stale Completion Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Completion thread', userId);
      await orgStub.recordThreadUserMessage(thread.id, 'First prompt');
      const afterUserMessage = await orgStub.getThread(thread.id);
      const staleCompletionAt = (afterUserMessage?.updated_at ?? Date.now()) - 1_000;

      await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: staleCompletionAt,
        summary: null,
        summaryStatus: 'pending',
      });
      const afterCompletion = await orgStub.getThread(thread.id);

      expect(afterCompletion?.last_assistant_completed_at ?? 0).toBeGreaterThan(
        afterUserMessage?.updated_at ?? 0,
      );
      expect(afterCompletion?.updated_at ?? 0).toBe(
        afterCompletion?.last_assistant_completed_at,
      );
      expect(afterCompletion?.last_assistant_summary).toBeNull();
      expect(afterCompletion?.last_assistant_summary_status).toBe('pending');
      expect(afterCompletion?.user_message_count).toBe(1);
    });

    it('fills in a late assistant summary without moving the completion timestamp', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Late Summary Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Completion thread', userId);
      await orgStub.recordThreadUserMessage(thread.id, 'First prompt');
      await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: Date.now(),
        summary: null,
        summaryStatus: 'pending',
      });
      const beforeSummary = await orgStub.getThread(thread.id);

      await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: beforeSummary?.last_assistant_completed_at ?? Date.now(),
        summary: 'Final answer: Finished the work.',
      });
      const afterSummary = await orgStub.getThread(thread.id);

      expect(afterSummary?.last_assistant_completed_at).toBe(
        beforeSummary?.last_assistant_completed_at,
      );
      expect(afterSummary?.updated_at).toBe(beforeSummary?.updated_at);
      expect(afterSummary?.last_assistant_summary).toBe('Finished the work.');
      expect(afterSummary?.last_assistant_summary_status).toBe('ready');
    });

    it('marks empty or failed assistant summaries as failed without moving the completion timestamp', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Failed Summary Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Completion thread', userId);
      await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: Date.now(),
        summary: null,
        summaryStatus: 'pending',
      });
      const beforeFailure = await orgStub.getThread(thread.id);

      await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: beforeFailure?.last_assistant_completed_at ?? Date.now(),
        summary: null,
        summaryStatus: 'failed',
      });
      const afterFailure = await orgStub.getThread(thread.id);

      expect(afterFailure?.last_assistant_completed_at).toBe(
        beforeFailure?.last_assistant_completed_at,
      );
      expect(afterFailure?.updated_at).toBe(beforeFailure?.updated_at);
      expect(afterFailure?.last_assistant_summary).toBeNull();
      expect(afterFailure?.last_assistant_summary_status).toBe('failed');
    });

    it('ignores stale summaries from older assistant completions', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Stale Summary Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Completion thread', userId);
      await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: Date.now(),
        summary: null,
        summaryStatus: 'pending',
      });
      const firstCompletion = await orgStub.getThread(thread.id);
      await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: (firstCompletion?.last_assistant_completed_at ?? Date.now()) + 10,
        summary: null,
        summaryStatus: 'pending',
      });
      const secondCompletion = await orgStub.getThread(thread.id);

      await orgStub.recordThreadAssistantCompletion(thread.id, {
        completedAt: firstCompletion?.last_assistant_completed_at ?? Date.now(),
        summary: 'Old turn summary',
      });
      const afterStaleSummary = await orgStub.getThread(thread.id);

      expect(afterStaleSummary?.last_assistant_completed_at).toBe(
        secondCompletion?.last_assistant_completed_at,
      );
      expect(afterStaleSummary?.last_assistant_summary).toBeNull();
      expect(afterStaleSummary?.last_assistant_summary_status).toBe('pending');
    });

    it('persists per-thread model changes after creation', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Model thread', userId, undefined, 'opus-4.8');
      expect(thread.model).toBe('opus-4.8');

      const updated = await orgStub.updateThreadModel(thread.id, 'sonnet', userId);
      expect(updated?.model).toBe('sonnet');

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.model).toBe('sonnet');
    });

    it('touches assistant thread activity without incrementing user message count', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Activity thread', userId);
      await orgStub.touchThread(thread.id);
      const afterUserMessage = await orgStub.getThread(thread.id);
      expect(afterUserMessage?.user_message_count).toBe(1);
      expect(afterUserMessage?.last_user_message_at).toEqual(expect.any(Number));

      await new Promise((resolve) => setTimeout(resolve, 1));
      await expect(orgStub.touchThreadActivity(thread.id)).resolves.toBe(true);
      const afterAssistantActivity = await orgStub.getThread(thread.id);

      expect(afterAssistantActivity?.user_message_count).toBe(1);
      expect(afterAssistantActivity?.updated_at ?? 0).toBeGreaterThan(
        afterUserMessage?.updated_at ?? 0,
      );
      expect(afterAssistantActivity?.last_user_message_at).toBe(
        afterUserMessage?.last_user_message_at,
      );
    });

    it('clamps assistant activity after stale completion timestamps', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Activity thread', userId);
      await orgStub.touchThread(thread.id);
      const afterUserMessage = await orgStub.getThread(thread.id);
      const staleCompletionAt = (afterUserMessage?.updated_at ?? Date.now()) - 1_000;

      await expect(
        orgStub.touchThreadActivity(thread.id, staleCompletionAt),
      ).resolves.toBe(true);
      const afterAssistantActivity = await orgStub.getThread(thread.id);

      expect(afterAssistantActivity?.user_message_count).toBe(1);
      expect(afterAssistantActivity?.updated_at ?? 0).toBeGreaterThan(
        afterUserMessage?.updated_at ?? 0,
      );
    });

    it('persists model family changes on the active thread', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Model thread', userId, undefined, 'opus-4.8');
      const updated = await orgStub.updateThreadModel(thread.id, 'gpt-5.6-terra', userId);

      expect(updated?.model).toBe('gpt-5.6-terra');

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.model).toBe('gpt-5.6-terra');
    });

    it('maps retired Codex models when creating a thread without an explicit provider', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        'Codex model thread',
        userId,
        undefined,
        'gpt-5.4',
      );

      expect(thread.model).toBe('gpt-5.6-terra');
      const stored = await orgStub.getThread(thread.id);
      expect(stored?.model).toBe('gpt-5.6-terra');
    });

    it('preserves the custom provider model marker when creating a thread', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(
        defaultWorkspaceId,
        'Custom model thread',
        userId,
        undefined,
        'custom',
      );

      expect(thread.model).toBe('custom');
      expect(thread.model_history).toBe(JSON.stringify(['custom']));

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.model).toBe('custom');
      expect(stored?.model_history).toBe(JSON.stringify(['custom']));
    });

    it('preserves the custom provider model marker when updating a thread model', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Thread Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Thread Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const thread = await orgStub.createThread(defaultWorkspaceId, 'Model thread', userId);
      const updated = await orgStub.updateThreadModel(thread.id, 'custom', userId);

      expect(updated?.model).toBe('custom');
      expect(updated?.model_history).toBe(JSON.stringify(['sonnet', 'custom']));

      const stored = await orgStub.getThread(thread.id);
      expect(stored?.model).toBe('custom');
      expect(stored?.model_history).toBe(JSON.stringify(['sonnet', 'custom']));
    });
  });

  describe('BYOK refresh fan-out', () => {
    it('targets all recently active threads when BYOK settings change', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'BYOK Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'BYOK Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      const now = Date.now();
      const dateNowSpy = vi.spyOn(Date, 'now');

      try {
        dateNowSpy.mockReturnValue(now - 31 * 60 * 1000);
        await orgStub.createThread(defaultWorkspaceId, 'stale codex', userId, undefined, 'gpt-5.4');

        dateNowSpy.mockReturnValue(now);
        await orgStub.createThread(defaultWorkspaceId, 'recent codex', userId, undefined, 'gpt-5.4');
        await orgStub.createThread(defaultWorkspaceId, 'recent claude', userId, undefined, 'sonnet');
      } finally {
        dateNowSpy.mockRestore();
      }

      expect(await orgStub.getActiveThreadIdsForByokChange()).toHaveLength(2);
    });

    it('does not cap matching active threads at 100', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'BYOK Owner');
      const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Large BYOK Org', userId);
      const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));

      // Create all 101 threads inside one DO context. Calling createThread over
      // RPC 101 times pays a round trip and a storage commit per thread (~65ms
      // each); the real createThread logic still runs for every thread.
      await runInDurableObject(
        orgStub,
        async (instance: {
          createThread(
            workspaceId: string,
            title: string,
            userId: string,
            parentId: undefined,
            model: string,
          ): Promise<unknown>;
        }) => {
          for (let index = 0; index < 101; index += 1) {
            await instance.createThread(
              defaultWorkspaceId,
              `codex thread ${index}`,
              userId,
              undefined,
              'gpt-5.4',
            );
          }
        },
      );

      expect(await orgStub.getActiveThreadIdsForByokChange()).toHaveLength(101);
    });
  });

  describe('Invitations', () => {
    it('should create an invitation', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      const invitation = await createInvitation(
        testEnv,
        org.id,
        'invitee@example.com',
        'member',
        userId
      );

      expect(invitation.id).toBeDefined();
      expect(invitation.expires_at).toBeGreaterThan(Date.now());
    });

    it('should persist invitations across requests', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      await createInvitation(testEnv, org.id, 'invitee@example.com', 'member', userId);

      const invitations = await getOrgInvitations(testEnv, org.id);

      expect(invitations).toHaveLength(1);
      expect(invitations[0].email).toBe('invitee@example.com');
    });

    it('should retrieve invitation details', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      const { id } = await createInvitation(
        testEnv,
        org.id,
        'invitee@example.com',
        'admin',
        userId
      );

      const invitation = await getInvitation(testEnv, org.id, id);

      expect(invitation).not.toBeNull();
      expect(invitation!.email).toBe('invitee@example.com');
      expect(invitation!.role).toBe('admin');
      expect(invitation!.org.id).toBe(org.id);
    });

    it('should accept invitation and add user to org', async () => {
      const inviterEmail = testEmail();
      const { userId: inviterId } = await createUser(
        testEnv,
        inviterEmail,
        'password123',
        'Inviter'
      );
      const { org } = await createOrg(testEnv, 'Test Org', inviterId);

      const inviteeEmail = testEmail();
      const { id: invitationId } = await createInvitation(
        testEnv,
        org.id,
        inviteeEmail,
        'member',
        inviterId
      );

      const { userId: inviteeId } = await createUser(
        testEnv,
        inviteeEmail,
        'password123',
        'Invitee'
      );

      const accepted = await acceptInvitation(testEnv, org.id, invitationId, inviteeId);

      expect(accepted).toBe(true);

      const isMember = await isOrgMember(testEnv, inviteeId, org.id);
      expect(isMember).toBe(true);
    });

    it('should delete an invitation', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Test Org', userId);

      const { id } = await createInvitation(
        testEnv,
        org.id,
        'invitee@example.com',
        'member',
        userId
      );
      await deleteInvitation(testEnv, org.id, id);

      const invitations = await getOrgInvitations(testEnv, org.id);
      expect(invitations).toHaveLength(0);
    });
  });

  describe('Session management', () => {
    it('should create and retrieve a session', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Workspace', userId);

      const { sessionId, sessionData } = await createTestSession(userId, org.id);

      expect(sessionId).toBeDefined();
      expect(sessionData.user_id).toBe(userId);
      expect(sessionData.org_id).toBe(org.id);
      expect(sessionData.workspace_id).toBeTypeOf('string');

      // Should be able to retrieve session
      const retrieved = await getSessionData(testEnv, sessionId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.user_id).toBe(userId);
      expect(retrieved!.workspace_id).toBeTypeOf('string');
    });

    it('should destroy a session', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Workspace', userId);
      const { sessionId } = await createTestSession(userId, org.id);

      await destroySessionData(testEnv, sessionId);

      const retrieved = await getSessionData(testEnv, sessionId);
      expect(retrieved).toBeNull();
    });

    it('should switch session org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org: org1 } = await createOrg(testEnv, 'Workspace 1', userId);
      const { org: org2 } = await createOrg(testEnv, 'Workspace 2', userId);
      const { sessionId } = await createTestSession(userId, org1.id);

      await switchSessionOrg(testEnv, sessionId, org2.id);

      const session = await getSessionData(testEnv, sessionId);
      expect(session!.org_id).toBe(org2.id);
      expect(session!.workspace_id).toBeTypeOf('string');
    });

    it('persists last workspace per org when switching workspace', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Test User');
      const { org } = await createOrg(testEnv, 'Workspace Org', userId);
      const { sessionId } = await createTestSession(userId, org.id);

      const workspace = await createWorkspace(testEnv, org.id, 'Secondary', userId);
      await switchSessionWorkspace(testEnv, sessionId, workspace.id);

      const orgs = await getUserOrgs(testEnv, userId);
      const membership = orgs.find((entry) => entry.org_id === org.id);
      expect(membership?.last_workspace_id).toBe(workspace.id);
    });

    it('switching to workspace in different org also switches session org', async () => {
      const email = testEmail();
      const { userId } = await createUser(testEnv, email, 'password123', 'Cross-Org User');

      // Create two orgs
      const { org: org1 } = await createOrg(testEnv, 'First Org', userId);
      const { org: org2, defaultWorkspaceId: ws2Id } = await createOrg(testEnv, 'Second Org', userId);

      // Start session in org1
      const { sessionId } = await createTestSession(userId, org1.id);
      let session = await getSessionData(testEnv, sessionId);
      expect(session!.org_id).toBe(org1.id);

      // Switch to workspace in org2 - this should also switch the org
      await switchSessionOrg(testEnv, sessionId, org2.id, ws2Id);

      session = await getSessionData(testEnv, sessionId);
      expect(session!.org_id).toBe(org2.id);
      expect(session!.workspace_id).toBe(ws2Id);
    });
  });

  describe('Full signup flow', () => {
    it('should complete signup: create user → create org → create session', async () => {
      const email = testEmail();

      // 1. Create user
      const { userId, user } = await createUser(testEnv, email, 'password123', 'New User');
      expect(user.email).toBe(email);

      // 2. Create org
      const { org } = await createOrg(testEnv, `New User's Workspace`, userId);
      expect(org.created_by).toBe(userId);

      // 3. Create session
      const { sessionId, sessionData } = await createTestSession(userId, org.id);
      expect(sessionData.user_id).toBe(userId);
      expect(sessionData.org_id).toBe(org.id);

      // 4. Get user orgs
      const orgs = await getUserOrgs(testEnv, userId);
      expect(orgs).toHaveLength(1);

      // All objects should be serializable (plain objects)
      expect(Object.getPrototypeOf(user)).not.toBeNull();
      expect(Object.getPrototypeOf(org)).not.toBeNull();
    });
  });
});
