import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import { normalizeBillingPlan } from '../../../src/lib/billing-plans';
import { getAppIndexDatabase } from '../src/app-index-db';
import type { TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;

// Searches use it as a LIKE pattern (`%…%`), and D1 refuses patterns over 50
// bytes ("LIKE or GLOB pattern too complex"): keep it short and fixed-length.
function unique(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8).padEnd(6, "0")}`;
}

async function upsertUser(id: string, email: string, name = 'Explorer User') {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'user_upsert',
    payload: {
      id,
      email,
      name,
      created_at: Date.now(),
      avatar: { color: '#111111', content: 'U' },
    },
  });
}

async function upsertOrg(params: {
  id: string;
  name: string;
  createdBy?: string;
  billingPlan?: string | null;
  billingStatus?: string | null;
}) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'org_upsert',
    payload: {
      id: params.id,
      name: params.name,
      created_at: Date.now(),
      created_by: params.createdBy ?? null,
      billing_plan: params.billingPlan,
      billing_status: params.billingStatus,
      archived: false,
    },
  });
}

async function upsertWorkspace(id: string, orgId: string, name: string) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'workspace_upsert',
    payload: {
      id,
      name,
      org_id: orgId,
      created_at: Date.now(),
      archived: false,
    },
  });
}

async function upsertThread(params: {
  id: string;
  title: string;
  orgId: string;
  workspaceId: string;
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  model?: string | null;
  modelHistory?: string[] | string | null;
  lastModelChangedAt?: number | null;
  firstUserMessage?: string | null;
  userMessageCount?: number | null;
  lastUserMessageAt?: number | null;
  source?: string | null;
  channelKind?: string | null;
  channelKinds?: string[] | string | null;
  chatErrorCount?: number | null;
  lastChatErrorAt?: number | null;
  lastChatErrorMessage?: string | null;
  lastChatErrorSource?: string | null;
  lastChatErrorStatus?: number | null;
  lastChatErrorProvider?: string | null;
  lastChatErrorModel?: string | null;
}) {
  const appIndex = getAppIndexDatabase(testEnv)!;
  await appIndex.applyAdminEvent({
    type: 'thread_upsert',
    payload: {
      id: params.id,
      title: params.title,
      model: params.model ?? 'sonnet',
      org_id: params.orgId,
      workspace_id: params.workspaceId,
      created_by: params.createdBy,
      created_at: params.createdAt,
      updated_at: params.updatedAt,
      model_history: params.modelHistory,
      last_model_changed_at: params.lastModelChangedAt,
      first_user_message: params.firstUserMessage,
      user_message_count: params.userMessageCount,
      last_user_message_at: params.lastUserMessageAt,
      source: params.source,
      channel_kind: params.channelKind,
      channel_kinds: params.channelKinds,
      chat_error_count: params.chatErrorCount,
      last_chat_error_at: params.lastChatErrorAt,
      last_chat_error_message: params.lastChatErrorMessage,
      last_chat_error_source: params.lastChatErrorSource,
      last_chat_error_status: params.lastChatErrorStatus,
      last_chat_error_provider: params.lastChatErrorProvider,
      last_chat_error_model: params.lastChatErrorModel,
    },
  });
}

describe('D1 admin chat explorer index', () => {
  it('persists enriched org and thread fields from admin events', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-fields');
    const userId = `${prefix}-user`;
    const reassignedUserId = `${prefix}-user-reassigned`;
    const orgId = `${prefix}-org`;
    const workspaceId = `${prefix}-workspace`;
    const threadId = `${prefix}-thread`;
    const reassignedEarlierThreadId = `${prefix}-thread-reassigned-earlier`;
    const reassignedTitle = `${prefix}-reassigned`;
    const longMessage = 'x'.repeat(350);

    await upsertUser(userId, `${prefix}@example.com`);
    await upsertUser(reassignedUserId, `${prefix}-reassigned@example.com`);
    await upsertOrg({
      id: orgId,
      name: `${prefix} Org`,
      createdBy: userId,
      billingPlan: 'free',
      billingStatus: 'trialing',
    });
    await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace`);
    await upsertThread({
      id: threadId,
      title: `${prefix} Title`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 2_000,
      firstUserMessage: longMessage,
      userMessageCount: 7,
      lastUserMessageAt: 1_500,
      source: 'channel',
      channelKind: 'slack',
      channelKinds: ['slack', 'email'],
    });

    const initial = await appIndex.getChatExplorerThreads(0, 10, prefix);
    expect(initial.items).toHaveLength(1);
    expect(initial.items[0]).toMatchObject({
      id: threadId,
      user_message_count: 7,
      first_user_message: 'x'.repeat(300),
      last_user_message_at: 1_500,
      source: 'channel',
      channel_kind: 'slack',
      channel_kinds: JSON.stringify(['slack', 'email']),
      org_billing_plan: 'free',
      org_billing_status: 'trialing',
      org_plan: 'payg',
      user_email: `${prefix}@example.com`,
    });

    await upsertThread({
      id: threadId,
      title: `${prefix} Updated`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 3_000,
      firstUserMessage: 'updated preview',
      userMessageCount: 9,
      lastUserMessageAt: 2_500,
      source: 'email',
      channelKind: 'email',
      channelKinds: '["email"]',
    });

    const updated = await appIndex.getChatExplorerThreads(0, 10, prefix);
    expect(updated.items[0]).toMatchObject({
      title: `${prefix} Updated`,
      user_message_count: 9,
      first_user_message: 'updated preview',
      last_user_message_at: 2_500,
      source: 'email',
      channel_kind: 'email',
      channel_kinds: '["email"]',
    });

    await upsertThread({
      id: reassignedEarlierThreadId,
      title: `${prefix} Earlier reassigned user thread`,
      orgId,
      workspaceId,
      createdBy: reassignedUserId,
      createdAt: 500,
      updatedAt: 750,
      firstUserMessage: 'older reassigned user thread',
      userMessageCount: 1,
    });
    await upsertThread({
      id: threadId,
      title: reassignedTitle,
      orgId,
      workspaceId,
      createdBy: reassignedUserId,
      createdAt: 1_000,
      updatedAt: Date.now() + 60_000,
      firstUserMessage: 'reassigned preview',
      userMessageCount: 10,
    });

    const reassigned = await appIndex.getChatExplorerThreads(0, 50);
    const reassignedRow = reassigned.items.find((row) => row.id === threadId);
    expect(reassignedRow).toMatchObject({
      id: threadId,
      user_email: `${prefix}-reassigned@example.com`,
      is_first_thread: false,
    });
  });

  it('searches, filters, sorts, and paginates explorer rows', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-query');
    const emailToken = unique('explorer-email');
    const orgToken = unique('explorer-org');
    const sharedTitleToken = unique('explorer-shared');
    const internalTitleToken = unique('explorer-internal');
    const userId = `${prefix}-user`;
    const internalUserId = `${prefix}-internal-user`;
    const orgId = `${prefix}-org`;
    const workspaceId = `${prefix}-workspace`;
    const firstThreadId = `${prefix}-thread-a`;
    const laterThreadId = `${prefix}-thread-b`;
    const systemThreadId = `${prefix}-thread-system`;
    const internalThreadId = `${prefix}-thread-internal`;
    const scheduledTitleThreadId = `${prefix}-thread-scheduled-title`;
    const missingUserThreadId = `${prefix}-thread-missing-user`;

    await upsertUser(userId, `${emailToken}@example.com`, 'First Human');
    await upsertUser(internalUserId, `${prefix}@camelai.com`, 'Internal Human');
    await upsertOrg({
      id: orgId,
      name: `${orgToken} Search Org`,
      createdBy: userId,
      billingPlan: 'pro',
      billingStatus: 'active',
    });
    await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace`);
    await upsertThread({
      id: firstThreadId,
      title: `${sharedTitleToken} first`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 5_000,
      firstUserMessage: 'first human message',
      userMessageCount: 1,
      source: 'web',
    });
    await upsertThread({
      id: laterThreadId,
      title: `${sharedTitleToken} later`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 2_000,
      updatedAt: 6_000,
      firstUserMessage: 'later human message',
      userMessageCount: 2,
      source: 'web',
    });
    await upsertThread({
      id: systemThreadId,
      title: `${sharedTitleToken} system`,
      orgId,
      workspaceId,
      createdBy: 'system',
      createdAt: 500,
      updatedAt: 7_000,
      firstUserMessage: 'system message',
      userMessageCount: null,
      source: 'scheduled',
    });
    await upsertThread({
      id: internalThreadId,
      title: `${internalTitleToken} Internal`,
      orgId,
      workspaceId,
      createdBy: internalUserId,
      createdAt: 3_000,
      updatedAt: 8_000,
      firstUserMessage: 'internal message',
      userMessageCount: 1,
      source: 'web',
    });
    await upsertThread({
      id: scheduledTitleThreadId,
      title: `Scheduled: ${orgToken} title fallback`,
      orgId,
      workspaceId,
      createdBy: 'system',
      createdAt: 4_000,
      updatedAt: 9_000,
      firstUserMessage: 'scheduled title fallback',
      userMessageCount: 1,
      source: 'web',
    });
    await upsertThread({
      id: missingUserThreadId,
      title: `${orgToken} missing user ordinary`,
      orgId,
      workspaceId,
      createdBy: `${prefix}-missing-user`,
      createdAt: 4_500,
      updatedAt: 10_000,
      firstUserMessage: 'ordinary missing user',
      userMessageCount: 1,
      source: 'web',
    });

    await expect(appIndex.getChatExplorerThreads(0, 10, emailToken)).resolves.toMatchObject({
      total: 2,
    });
    await expect(appIndex.getChatExplorerThreads(0, 10, orgToken)).resolves.toMatchObject({
      total: 6,
    });
    await expect(appIndex.getChatExplorerThreads(0, 10, internalTitleToken)).resolves.toMatchObject({
      total: 1,
    });

    const firstOnly = await appIndex.getChatExplorerThreads(0, 10, sharedTitleToken, {
      first_chats_only: true,
    });
    expect(firstOnly.items.map((row) => row.id)).toEqual([firstThreadId]);
    expect(firstOnly.items[0]?.is_first_thread).toBe(true);

    const excludeInternal = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      exclude_internal: true,
    });
    expect(excludeInternal.items.map((row) => row.id)).toEqual([
      missingUserThreadId,
      scheduledTitleThreadId,
      systemThreadId,
      laterThreadId,
      firstThreadId,
    ]);

    const createdSort = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      exclude_internal: true,
      sort_by: 'created_at',
    });
    expect(createdSort.items.map((row) => row.id)).toEqual([
      missingUserThreadId,
      scheduledTitleThreadId,
      laterThreadId,
      firstThreadId,
      systemThreadId,
    ]);

    const page = await appIndex.getChatExplorerThreads(0, 2, orgToken, {
      exclude_internal: true,
    });
    expect(page.total).toBe(5);
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);

    const proRows = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      plan: 'pro',
    });
    expect(proRows.total).toBe(6);
    const starterRows = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      plan: 'starter',
    });
    expect(starterRows.total).toBe(0);

    const automatedOnly = await appIndex.getChatExplorerThreads(0, 10, orgToken, {
      automated_only: true,
    });
    expect(automatedOnly.items.map((row) => row.id)).toEqual([
      scheduledTitleThreadId,
      systemThreadId,
    ]);
    expect(automatedOnly.items.map((row) => row.id)).not.toContain(missingUserThreadId);
  });

  it('keeps SQL plan normalization aligned with normalizeBillingPlan', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-plan');
    const userId = `${prefix}-user`;
    await upsertUser(userId, `${prefix}@example.com`);

    const cases: Array<[string | null, Parameters<typeof normalizeBillingPlan>[1]]> = [
      [null, null],
      ['free', 'trialing'],
      ['free', null],
      ['payg', 'active'],
      ['starter', 'active'],
      ['pro', null],
      ['team', 'past_due'],
      [null, 'trialing'],
      [null, 'enterprise'],
      ['enterprise', null],
      ['garbage', 'active'],
    ];

    for (const [index, [billingPlan, billingStatus]] of cases.entries()) {
      const orgId = `${prefix}-org-${index}`;
      const workspaceId = `${prefix}-workspace-${index}`;
      const threadId = `${prefix}-thread-${index}`;
      await upsertOrg({
        id: orgId,
        name: `${prefix} Org ${index}`,
        createdBy: userId,
        billingPlan,
        billingStatus,
      });
      await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace ${index}`);
      await upsertThread({
        id: threadId,
        title: `${prefix}-plan-thread-${index}`,
        orgId,
        workspaceId,
        createdBy: userId,
        createdAt: 10_000 + index,
        updatedAt: Date.now() + 1_000_000 + index,
        firstUserMessage: 'plan parity',
        userMessageCount: 1,
      });

      const expectedPlan = normalizeBillingPlan(billingPlan, billingStatus);
      const result = await appIndex.getChatExplorerThreads(0, 100, undefined, {
        plan: expectedPlan === 'free' ? 'payg' : expectedPlan,
      });
      expect(result.items.map((row) => row.id)).toContain(threadId);
      expect(result.items.find((row) => row.id === threadId)?.org_plan).toBe(expectedPlan);
    }
  });

  it('mirrors model history and filters rows with chat errors', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-errors-filter');
    const userId = `${prefix}-user`;
    const orgId = `${prefix}-org`;
    const workspaceId = `${prefix}-workspace`;
    const erroredThreadId = `${prefix}-errored-thread`;
    const ordinaryThreadId = `${prefix}-ordinary-thread`;

    await upsertUser(userId, `${prefix}@example.com`);
    await upsertOrg({
      id: orgId,
      name: `${prefix} Org`,
      createdBy: userId,
      billingPlan: 'starter',
      billingStatus: 'active',
    });
    await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace`);
    await upsertThread({
      id: erroredThreadId,
      title: `${prefix} errored`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 10_000,
      updatedAt: 20_000,
      model: 'gpt-5.4-mini',
      modelHistory: ['sonnet', 'gpt-5.4-mini'],
      lastModelChangedAt: 19_000,
      firstUserMessage: 'please fail',
      userMessageCount: 2,
      chatErrorCount: 3,
      lastChatErrorAt: 19_500,
      lastChatErrorMessage: 'Provider returned 429',
      lastChatErrorSource: 'pi_provider',
      lastChatErrorStatus: 429,
      lastChatErrorProvider: 'openai',
      lastChatErrorModel: 'gpt-5.4-mini',
    });
    await upsertThread({
      id: ordinaryThreadId,
      title: `${prefix} ordinary`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 11_000,
      updatedAt: 21_000,
      model: 'sonnet',
      firstUserMessage: 'ordinary',
      userMessageCount: 1,
    });

    const allRows = await appIndex.getChatExplorerThreads(0, 10, prefix);
    const errored = allRows.items.find((row) => row.id === erroredThreadId);
    expect(errored).toMatchObject({
      chat_error_count: 3,
      last_chat_error_message: 'Provider returned 429',
      last_chat_error_source: 'pi_provider',
      last_chat_error_status: 429,
      last_chat_error_provider: 'openai',
      last_chat_error_model: 'gpt-5.4-mini',
      model_history: JSON.stringify(['sonnet', 'gpt-5.4-mini']),
      last_model_changed_at: 19_000,
    });

    const errorsOnly = await appIndex.getChatExplorerThreads(0, 10, prefix, {
      errors_only: true,
    });
    expect(errorsOnly.items.map((row) => row.id)).toEqual([erroredThreadId]);

    const ordinary = allRows.items.find((row) => row.id === ordinaryThreadId);
    expect(ordinary?.model_history).toBe(JSON.stringify(['sonnet']));
  });

  it('stores chat error events idempotently and returns grouped dashboard rows', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-error-events');
    const userId = `${prefix}-user`;
    const orgId = `${prefix}-org`;
    const workspaceId = `${prefix}-workspace`;
    const firstThreadId = `${prefix}-thread-a`;
    const secondThreadId = `${prefix}-thread-b`;
    const startAt = 50_000;
    const endAt = 70_000;

    await upsertUser(userId, `${prefix}@example.com`);
    await upsertOrg({
      id: orgId,
      name: `${prefix} Org`,
      createdBy: userId,
      billingPlan: 'pro',
      billingStatus: 'active',
    });
    await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace`);
    await upsertThread({
      id: firstThreadId,
      title: `${prefix} first thread`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 60_000,
      firstUserMessage: 'first',
      userMessageCount: 1,
    });
    await upsertThread({
      id: secondThreadId,
      title: `${prefix} second thread`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 2_000,
      updatedAt: 61_000,
      firstUserMessage: 'second',
      userMessageCount: 1,
    });

    const fingerprint = `${prefix}-fingerprint`;
    const eventPayload = {
      id: `${firstThreadId}:60000:${fingerprint}`,
      fingerprint,
      thread_id: firstThreadId,
      org_id: orgId,
      workspace_id: workspaceId,
      user_id: userId,
      created_at: 60_000,
      source: 'pi_provider',
      error_kind: 'rate_limit',
      status: 429,
      provider: 'openai',
      model: 'gpt-5.4-mini',
      message_normalized: 'Provider returned [id]',
      message_sample: 'Provider returned request id abc123',
    };
    await appIndex.applyAdminEvent({
      type: 'thread_error_recorded',
      payload: eventPayload,
    });
    await appIndex.applyAdminEvent({
      type: 'thread_error_recorded',
      payload: eventPayload,
    });
    await appIndex.applyAdminEvent({
      type: 'thread_error_recorded',
      payload: {
        ...eventPayload,
        id: `${secondThreadId}:62000:${fingerprint}`,
        thread_id: secondThreadId,
        created_at: 62_000,
      },
    });

    const summary = await appIndex.getChatErrorSummary({ startAt, endAt });
    expect(summary).toMatchObject({
      total_events: 2,
      affected_threads: 2,
      distinct_groups: 1,
      latest_error_at: 62_000,
    });

    const groups = await appIndex.getChatErrorGroups({ startAt, endAt, limit: 10 });
    expect(groups).toEqual([
      expect.objectContaining({
        fingerprint,
        count: 2,
        affected_thread_count: 2,
        first_seen_at: 60_000,
        last_seen_at: 62_000,
        status: 429,
        provider: 'openai',
        model: 'gpt-5.4-mini',
      }),
    ]);

    const threads = await appIndex.getChatErrorThreads({
      fingerprint,
      startAt,
      endAt,
    });
    expect(threads).toEqual([
      expect.objectContaining({
        thread_id: secondThreadId,
        title: `${prefix} second thread`,
        org_name: `${prefix} Org`,
        workspace_name: `${prefix} Workspace`,
        user_email: `${prefix}@example.com`,
        count: 1,
      }),
      expect.objectContaining({
        thread_id: firstThreadId,
        title: `${prefix} first thread`,
        count: 1,
      }),
    ]);
  });

  it('preserves existing error summary and model history on older partial thread upserts', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-preserve');
    const userId = `${prefix}-user`;
    const orgId = `${prefix}-org`;
    const workspaceId = `${prefix}-workspace`;
    const threadId = `${prefix}-thread`;

    await upsertUser(userId, `${prefix}@example.com`);
    await upsertOrg({
      id: orgId,
      name: `${prefix} Org`,
      createdBy: userId,
      billingPlan: 'pro',
      billingStatus: 'active',
    });
    await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace`);
    await upsertThread({
      id: threadId,
      title: `${prefix} original`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 2_000,
      model: 'gpt-5.4-mini',
      modelHistory: ['sonnet', 'gpt-5.4-mini'],
      lastModelChangedAt: 1_800,
      firstUserMessage: 'hello',
      userMessageCount: 1,
      chatErrorCount: 1,
      lastChatErrorAt: 1_900,
      lastChatErrorMessage: 'Provider returned 429',
      lastChatErrorSource: 'pi_provider',
      lastChatErrorStatus: 429,
      lastChatErrorProvider: 'openai',
      lastChatErrorModel: 'gpt-5.4-mini',
    });

    await appIndex.applyAdminEvent({
      type: 'thread_upsert',
      payload: {
        id: threadId,
        title: `${prefix} stale partial`,
        model: 'gpt-5.4-mini',
        org_id: orgId,
        workspace_id: workspaceId,
        created_by: userId,
        created_at: 1_000,
        updated_at: 3_000,
        first_user_message: 'hello',
        user_message_count: 2,
      },
    });

    await appIndex.applyAdminEvent({
      type: 'thread_upsert',
      payload: {
        id: threadId,
        title: `${prefix} stale explicit`,
        model: 'gpt-5.4-mini',
        org_id: orgId,
        workspace_id: workspaceId,
        created_by: userId,
        created_at: 1_000,
        updated_at: 4_000,
        first_user_message: 'hello',
        user_message_count: 3,
        chat_error_count: 0,
        last_chat_error_at: 1_000,
        last_chat_error_message: 'stale error',
        last_chat_error_source: 'runner_send',
        last_chat_error_status: 500,
        last_chat_error_provider: 'stale-provider',
        last_chat_error_model: 'sonnet',
        model_history: ['gpt-5.4-mini'],
        last_model_changed_at: 500,
      },
    });

    const result = await appIndex.getChatExplorerThreads(0, 10, prefix);
    expect(result.items[0]).toMatchObject({
      id: threadId,
      title: `${prefix} stale explicit`,
      user_message_count: 3,
      chat_error_count: 1,
      last_chat_error_message: 'Provider returned 429',
      last_chat_error_status: 429,
      model_history: JSON.stringify(['sonnet', 'gpt-5.4-mini']),
      last_model_changed_at: 1_800,
    });
  });

  it('returns one affected-thread row when events in a thread have different users', async () => {
    const appIndex = getAppIndexDatabase(testEnv)!;
    const prefix = unique('explorer-thread-dedupe');
    const userId = `${prefix}-user`;
    const otherUserId = `${prefix}-other-user`;
    const orgId = `${prefix}-org`;
    const workspaceId = `${prefix}-workspace`;
    const threadId = `${prefix}-thread`;
    const fingerprint = `${prefix}-fingerprint`;

    await upsertUser(userId, `${prefix}@example.com`);
    await upsertUser(otherUserId, `${prefix}-other@example.com`);
    await upsertOrg({
      id: orgId,
      name: `${prefix} Org`,
      createdBy: userId,
      billingPlan: 'pro',
      billingStatus: 'active',
    });
    await upsertWorkspace(workspaceId, orgId, `${prefix} Workspace`);
    await upsertThread({
      id: threadId,
      title: `${prefix} thread`,
      orgId,
      workspaceId,
      createdBy: userId,
      createdAt: 1_000,
      updatedAt: 6_000,
      firstUserMessage: 'hello',
      userMessageCount: 1,
    });

    for (const [index, eventUserId] of [userId, otherUserId].entries()) {
      await appIndex.applyAdminEvent({
        type: 'thread_error_recorded',
        payload: {
          id: `${threadId}:${6_000 + index}:${fingerprint}`,
          fingerprint,
          thread_id: threadId,
          org_id: orgId,
          workspace_id: workspaceId,
          user_id: eventUserId,
          created_at: 6_000 + index,
          source: 'runner_send',
          error_kind: 'billing',
          status: 402,
          provider: null,
          model: 'sonnet',
          message_normalized: 'Billing failure',
          message_sample: 'Billing failure',
        },
      });
    }

    const groups = await appIndex.getChatErrorGroups({
      startAt: 5_000,
      endAt: 7_000,
      limit: 10,
    });
    expect(groups.find((group) => group.fingerprint === fingerprint)).toMatchObject({
      affected_thread_count: 1,
      count: 2,
    });

    const threads = await appIndex.getChatErrorThreads({
      fingerprint,
      startAt: 5_000,
      endAt: 7_000,
    });
    expect(threads).toEqual([
      expect.objectContaining({
        thread_id: threadId,
        user_id: userId,
        user_email: `${prefix}@example.com`,
        count: 2,
      }),
    ]);
  });
});
