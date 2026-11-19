/**
 * OrgDO rows for threads that run directly on the hosted agent runtime
 * (plans/runtime-threads-direct.md): `thread_runtime` and `thread_ui_state`.
 *
 * Run with: bun run test:workers
 */

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import { CAMEL_CODE_LLM_MODEL } from '../../../src/lib/llm-provider-config';
import { CAMEL_CODE_RUNTIME_MODEL, PREVIOUS_AZURE_CAMEL_CODE_RUNTIME_MODEL } from '../src/agent-runtime/model-routes';
import { createUser, createOrg, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;
const testEmail = () => `rt-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function freshThread(channel?: "discord" | "telegram") {
  const { userId } = await createUser(testEnv, testEmail(), 'password', 'Runtime User');
  const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Runtime Org', userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  const thread = await orgStub.createThread(defaultWorkspaceId as string, 'Runtime thread', userId, undefined,
    channel ? CAMEL_CODE_LLM_MODEL : undefined, channel ? {
      source: "channel", channelKind: channel, channelConnectionId: "connection-1", channelConversationId: "conversation-1",
    } : undefined);
  return { orgStub, threadId: thread.id, userId };
}

describe('OrgDO thread_runtime', () => {
  it('has no row for a thread that was never pinned', async () => {
    const { orgStub, threadId } = await freshThread();
    expect(await orgStub.getThreadRuntime(threadId)).toBeNull();
  });

  it('pins a thread without an agent, idempotently', async () => {
    const { orgStub, threadId } = await freshThread();
    expect(await orgStub.pinThreadRuntime(threadId)).toBe(true);
    expect(await orgStub.pinThreadRuntime(threadId)).toBe(true);
    const row = await orgStub.getThreadRuntime(threadId);
    expect(row).toMatchObject({ threadId, agentId: null, model: null, keyScope: null, configured: null });
    expect(await orgStub.pinThreadRuntime('missing-thread')).toBe(false);
  });

  it('keeps a new thread\'s first message until a send clears it, across its agent being recorded', async () => {
    const { orgStub, threadId } = await freshThread();
    expect(await orgStub.pinThreadRuntime(threadId, 'Build me a dashboard')).toBe(true);
    // Pinning again (a retried create) keeps the message it has.
    expect(await orgStub.pinThreadRuntime(threadId, 'something else')).toBe(true);
    expect(await orgStub.getThreadRuntime(threadId)).toMatchObject({ pendingFirstMessage: 'Build me a dashboard' });
    await orgStub.setThreadRuntimeAgent(threadId, { agentId: 'agt_1', model: 'm', keyScope: 'hosted', configured: null });
    expect(await orgStub.getThreadRuntime(threadId)).toMatchObject({ agentId: 'agt_1', pendingFirstMessage: 'Build me a dashboard' });
    await orgStub.clearThreadPendingFirstMessage(threadId);
    expect(await orgStub.getThreadRuntime(threadId)).toMatchObject({ agentId: 'agt_1', pendingFirstMessage: null });
    const blank = await freshThread();
    await blank.orgStub.pinThreadRuntime(blank.threadId, '   ');
    expect(await blank.orgStub.getThreadRuntime(blank.threadId)).toMatchObject({ pendingFirstMessage: null });
  });

  it('claims a moving thread for one agent only (compare-and-set)', async () => {
    const { orgStub, threadId } = await freshThread();
    const first = await orgStub.claimThreadRuntimeAgent(threadId, 'agt_1');
    expect(first).toMatchObject({ claimed: true, row: { threadId, agentId: 'agt_1', model: null, configured: null } });
    // A re-driven commit of the same agent still owns it; another agent never takes it.
    expect(await orgStub.claimThreadRuntimeAgent(threadId, 'agt_1')).toMatchObject({ claimed: true });
    expect(await orgStub.claimThreadRuntimeAgent(threadId, 'agt_2')).toMatchObject({ claimed: false, row: { agentId: 'agt_1' } });
    // A thread pinned before it had an agent takes one, once.
    const pinned = await freshThread();
    await pinned.orgStub.pinThreadRuntime(pinned.threadId);
    expect(await pinned.orgStub.claimThreadRuntimeAgent(pinned.threadId, 'agt_3')).toMatchObject({ claimed: true, row: { agentId: 'agt_3' } });
    expect(await pinned.orgStub.claimThreadRuntimeAgent(pinned.threadId, 'agt_4')).toMatchObject({ claimed: false, row: { agentId: 'agt_3' } });
    expect(await orgStub.claimThreadRuntimeAgent('missing-thread', 'agt_1')).toBeNull();
  });

  it('records the configuration a claimed agent was made with, only on the claim that wins', async () => {
    const configuration = { model: 'openrouter/anthropic/claude-sonnet-5', keyScope: 'hosted', configured: { thinkingLevel: 'medium', promptVersion: 4 } };
    const { orgStub, threadId } = await freshThread();
    expect(await orgStub.claimThreadRuntimeAgent(threadId, 'agt_1', configuration)).toMatchObject({ claimed: true, row: { agentId: 'agt_1', ...configuration } });
    expect(await orgStub.claimThreadRuntimeAgent(threadId, 'agt_2', { model: 'other', keyScope: 'org_x', configured: null }))
      .toMatchObject({ claimed: false, row: { agentId: 'agt_1', ...configuration } });
    const pinned = await freshThread();
    await pinned.orgStub.pinThreadRuntime(pinned.threadId);
    expect(await pinned.orgStub.claimThreadRuntimeAgent(pinned.threadId, 'agt_3', configuration)).toMatchObject({ claimed: true, row: { agentId: 'agt_3', ...configuration } });
  });

  it('records the agent and its configuration, and keeps the first created_at', async () => {
    const { orgStub, threadId } = await freshThread();
    await orgStub.pinThreadRuntime(threadId);
    const pinned = await orgStub.getThreadRuntime(threadId);
    const saved = await orgStub.setThreadRuntimeAgent(threadId, {
      agentId: 'agt_1',
      model: 'openrouter/anthropic/claude-sonnet-5',
      keyScope: 'hosted',
      configured: { thinkingLevel: 'medium' },
    });
    expect(saved).toMatchObject({
      threadId,
      agentId: 'agt_1',
      model: 'openrouter/anthropic/claude-sonnet-5',
      keyScope: 'hosted',
      configured: { thinkingLevel: 'medium' },
      createdAt: pinned!.createdAt,
    });
    const reconfigured = await orgStub.setThreadRuntimeAgent(threadId, { agentId: 'agt_1', model: 'openai/gpt-6', keyScope: null });
    expect(reconfigured).toMatchObject({ model: 'openai/gpt-6', keyScope: null, configured: null });
    expect(await orgStub.setThreadRuntimeAgent('missing-thread', { agentId: 'x', model: null, keyScope: null })).toBeNull();
  });

  it('publishes the v2 copy only from the expected v1 placement and rejects a late v1 write', async () => {
    const { orgStub, threadId } = await freshThread();
    const thread = (await orgStub.getThread(threadId))!;
    const source = { agentId: 'agt_v1', model: 'model/v1', keyScope: 'hosted', configured: { scratchVolumeId: 'vol_v1' } };
    const destination = { agentId: 'agt_v2', model: 'model/v2', keyScope: 'hosted', configured: { promptVersion: 1 } };
    await orgStub.pinThreadRuntime(threadId, 'pending send');
    const saved = (await orgStub.setThreadRuntimeAgent(threadId, source))!;
    const expected = { agentId: source.agentId, workspaceId: thread.workspace_id, threadModel: thread.model ?? null, updatedAt: saved.updatedAt };
    expect(await orgStub.publishV1ThreadInV2(threadId, expected, destination)).toBe(false);
    await orgStub.clearThreadPendingFirstMessage(threadId);
    expect(await orgStub.publishV1ThreadInV2(threadId, { ...expected, agentId: 'other' }, destination)).toBe(false);
    expect(await orgStub.publishV1ThreadInV2(threadId, { ...expected, threadModel: 'other' }, destination)).toBe(false);
    expect(await orgStub.publishV1ThreadInV2(threadId, { ...expected, updatedAt: expected.updatedAt - 1 }, destination)).toBe(false);
    expect(await orgStub.publishV1ThreadInV2(threadId, expected, destination)).toBe(true);
    expect(await orgStub.publishV1ThreadInV2(threadId, expected, destination)).toBe(true);
    expect(await orgStub.publishV1ThreadInV2(threadId, expected, { ...destination, agentId: 'other' })).toBe(false);
    expect(await orgStub.setThreadRuntimeAgent(threadId, source)).toBeNull();
    expect(await orgStub.getThreadRuntime(threadId)).toMatchObject({ runtimeVersion: 'v2', ...destination });
  });

  it.each(["discord", "telegram"] as const)('publishes a fenced free %s chat only with the original channel binding', async (kind) => {
    const { orgStub, threadId } = await freshThread(kind);
    const thread = (await orgStub.getThread(threadId))!;
    const source = { agentId: 'agt_v1', model: PREVIOUS_AZURE_CAMEL_CODE_RUNTIME_MODEL, keyScope: 'hosted', configured: null };
    const replacement = { ...source, agentId: 'agt_v2', model: CAMEL_CODE_RUNTIME_MODEL };
    const saved = (await orgStub.setThreadRuntimeAgent(threadId, source))!;
    const channel = { kind, connectionId: "connection-1", remoteConversationId: "conversation-1" };
    const expected = { agentId: source.agentId, workspaceId: thread.workspace_id, threadModel: thread.model, updatedAt: saved.updatedAt };
    expect(await orgStub.publishV1ThreadInV2(threadId, expected, replacement)).toBe(false);
    expect(await orgStub.publishV1ThreadInV2(threadId, {
      ...expected, channel: { ...channel, remoteConversationId: "different-conversation" },
    }, replacement)).toBe(false);
    expect(await orgStub.publishV1ThreadInV2(threadId, { ...expected, channel }, { ...replacement, model: "other" })).toBe(false);
    expect(await orgStub.publishV1ThreadInV2(threadId, { ...expected, channel }, replacement)).toBe(true);
    expect(await orgStub.getThread(threadId)).toMatchObject({
      id: threadId, source: "channel", channel_kind: kind,
      channel_connection_id: "connection-1", channel_conversation_id: "conversation-1",
    });
    expect(await orgStub.getThreadRuntime(threadId)).toMatchObject({ runtimeVersion: 'v2', ...replacement });
  });

  it('goes with its thread', async () => {
    const { orgStub, threadId, userId } = await freshThread();
    await orgStub.setThreadRuntimeAgent(threadId, { agentId: 'agt_2', model: 'm', keyScope: null });
    await orgStub.setThreadUiState(threadId, { tabs: [] });
    expect(await orgStub.deleteThread(threadId, userId)).toBe(true);
    expect(await orgStub.getThreadRuntime(threadId)).toBeNull();
    expect(await orgStub.getThreadUiState(threadId)).toBeNull();
  });
});

describe('OrgDO thread_ui_state', () => {
  it('saves preview state with a version that goes up', async () => {
    const { orgStub, threadId } = await freshThread();
    expect(await orgStub.getThreadUiState(threadId)).toBeNull();
    const first = await orgStub.setThreadUiState(threadId, { tabs: [{ kind: 'app', scriptName: 'a' }], activeTabId: 'a' });
    expect(first).toMatchObject({ previewVersion: 1, preview: { activeTabId: 'a' } });
    const second = await orgStub.setThreadUiState(threadId, null);
    expect(second).toMatchObject({ previewVersion: 2, preview: null });
    expect(await orgStub.getThreadUiState(threadId)).toMatchObject({ previewVersion: 2, preview: null });
  });

  it('refuses a save for a thread that does not exist', async () => {
    expect(await (await freshThread()).orgStub.setThreadUiState('missing-thread', null)).toBeNull();
  });
});

describe('OrgDO runtime thread previews', () => {
  it('opens set_preview targets as tabs, replacing a tab with the same id, and tracks app visibility', async () => {
    const { orgStub, threadId } = await freshThread();
    const app = { kind: 'app', scriptName: 'shop', isPublic: false } as const;
    const file = { kind: 'file', source: 'workspace', workspaceId: 'ws', path: '/a.md' } as const;
    await orgStub.upsertThreadPreviewTarget(threadId, app);
    await orgStub.upsertThreadPreviewTarget(threadId, file);
    let state = await orgStub.upsertThreadPreviewTarget(threadId, { ...app, isPublic: true });
    expect(state?.preview).toEqual({ tabs: [{ ...app, isPublic: true }, file], activeTabId: 'app:shop' });
    state = await orgStub.setThreadPreviewAppVisibility(threadId, 'shop', false);
    expect(state?.preview).toMatchObject({ tabs: [app, file], activeTabId: 'app:shop' });
    expect(await orgStub.setThreadPreviewAppVisibility(threadId, 'shop', false)).toBeNull();
  });
});
