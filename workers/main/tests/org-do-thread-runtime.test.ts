/**
 * OrgDO rows for threads that run directly on the hosted agent runtime
 * (plans/runtime-threads-direct.md): `thread_runtime` and `thread_ui_state`.
 *
 * Run with: bun run test:workers
 */

import { describe, it, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { testRuntime } from '@camelai/run/testing';
import { CAMEL_CODE_LLM_MODEL } from '../../../src/lib/llm-provider-config';
import { CAMEL_CODE_RUNTIME_MODEL, PREVIOUS_AZURE_CAMEL_CODE_RUNTIME_MODEL } from '../src/agent-runtime/model-routes';
import { ChannelTools } from '../src/chat-channels';
import type { ChatEnv } from '../src/chat-thread/types';
import { agentMcpHandler } from '../src/routes/agent-mcp';
import type { Env } from '../src/types';
import { createUser, createOrg, type TestEnv } from './test-helpers';

const testEnv = env as unknown as TestEnv;
const testEmail = () => `rt-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;

async function freshThread(channel?: "discord" | "telegram", conversation = "conversation-1") {
  const { userId } = await createUser(testEnv, testEmail(), 'password', 'Runtime User');
  const { org, defaultWorkspaceId } = await createOrg(testEnv, 'Runtime Org', userId);
  const orgStub = testEnv.ORG.get(testEnv.ORG.idFromName(org.id));
  const thread = await orgStub.createThread(defaultWorkspaceId as string, 'Runtime thread', userId, undefined,
    channel ? CAMEL_CODE_LLM_MODEL : undefined, channel ? {
      source: "channel", channelKind: channel, channelConnectionId: "connection-1", channelConversationId: conversation,
    } : undefined);
  return { orgStub, orgId: org.id, threadId: thread.id, userId };
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

  it.each(["discord", "telegram"] as const)("delivers a signed v2 reply to the original %s conversation after promotion", async (kind) => {
    const conversation = kind === "discord" ? "guild-1:thread-2" : "-123456";
    const { orgStub, orgId, threadId, userId } = await freshThread(kind, conversation);
    const thread = (await orgStub.getThread(threadId))!;
    const source = { agentId: "agt_v1", model: PREVIOUS_AZURE_CAMEL_CODE_RUNTIME_MODEL, keyScope: "hosted", configured: null };
    const replacement = { ...source, agentId: "agt_v2", model: CAMEL_CODE_RUNTIME_MODEL };
    await orgStub.setThreadRuntimeAgent(threadId, source);
    const connectionId = "connection-1";
    const workspaceId = thread.workspace_id;
    const tenant = "chiridion-v2-test";
    const runtime = await testRuntime({ url: "https://run.camelai.com/v2" });
    const mcpUrl = "https://camel.test/mcp/agent/v2";
    const integration = { integration_type: "discord_channel", name: "Synthetic Discord" };
    const outbound = vi.fn(async (message: unknown) => message);
    const bridgeFetch = async (request: Request) => {
      if (request.method === "GET") return Response.json({ ok: true, binding: {
        guildId: "guild-1", parentChannelId: "parent-1", integrationId: connectionId, orgId, workspaceId,
      } });
      await outbound(await request.json());
      return Response.json({ ok: true, integrationId: connectionId, threadId: "thread-2", messageIds: ["reply-1"], chunkCount: 1 });
    };
    const handlerEnv = {
      ...testEnv,
      AGENT_RUNTIME_V2_TENANT: tenant,
      TELEGRAM_BOT_TOKEN: "fixture",
      DISCORD_BRIDGE: { fetch: bridgeFetch },
      ORG: { idFromName: (name: string) => name, get: () => ({
        getThread: (id: string) => orgStub.getThread(id),
        validateChatWebSocketAccess: (user: string, workspace: string, id: string) => orgStub.validateChatWebSocketAccess(user, workspace, id),
        getWorkspaceIntegration: async () => integration,
        recordThreadChannelUsed: async () => {},
      }) },
    } as unknown as Env;
    const handler = agentMcpHandler(handlerEnv, (props) => ({
      describeDestructiveConfirmation: async () => null,
      callToolEnvelope: async (name, args) => {
        const tools = new ChannelTools(handlerEnv as unknown as ChatEnv);
        const context = { ...props, userName: null, userEmail: null };
        const data = name === "send_discord_message" ? await tools.sendChannelDiscordMessageTool(context, args)
          : await tools.sendChannelTelegramMessageTool(context, args);
        return { ok: true, data };
      },
    }), { fetch: runtime.fetch, version: "v2" });
    const original = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input) !== "https://api.telegram.org/botfixture/sendMessage") return original(input, init);
      await outbound(JSON.parse(String(init?.body)));
      return Response.json({ ok: true, result: { message_id: 19 } });
    });
    const signedReply = (agent: string) => runtime.callTool(handler, mcpUrl, `send_${kind}_message`, { text: "Hello" }, {
      tenant, agent, subject: userId, actor: userId, context: { org: orgId, workspace: workspaceId, thread: threadId },
    });
    try {
      expect(await signedReply(replacement.agentId)).toMatchObject({ isError: true });
      expect(outbound).not.toHaveBeenCalled();
      expect(await orgStub.promoteLegacyThreadToV2(threadId, replacement)).toMatchObject({
        runtimeVersion: "v2",
        agentId: replacement.agentId,
      });
      expect(await orgStub.setThreadRuntimeAgent(threadId, source)).toBeNull();
      expect(await signedReply(source.agentId)).toMatchObject({ isError: true });
      expect(await signedReply(replacement.agentId)).toMatchObject({ structuredContent: { status: "sent", channel: kind } });
      expect(outbound).toHaveBeenCalledExactlyOnceWith(expect.objectContaining(kind === "discord"
        ? { integrationId: connectionId, threadId: "thread-2", text: "Hello" }
        : { chat_id: conversation, text: "Hello" }));
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('goes with its thread for both v1 and v2 rows, and allows hardDeleteOrg with v2 threads', async () => {
    const { orgStub, threadId, userId } = await freshThread();
    await orgStub.setThreadRuntimeAgent(threadId, { agentId: 'agt_2', model: 'm', keyScope: null });
    await orgStub.setThreadUiState(threadId, { tabs: [] });
    expect(await orgStub.deleteThread(threadId, userId)).toBe(true);
    expect(await orgStub.getThreadRuntime(threadId)).toBeNull();
    expect(await orgStub.getThreadUiState(threadId)).toBeNull();

    const v2 = await freshThread();
    await v2.orgStub.pinThreadRuntime(v2.threadId, null, 'v2');
    await v2.orgStub.setThreadRuntimeAgent(v2.threadId, { agentId: 'agt_v2_del', model: 'm', keyScope: null });
    const deletedUrls: Array<{ url: string; method?: string; auth: string | null }> = [];
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith('https://run.camelai.com/v2/agents/')) {
        deletedUrls.push({ url, method: init?.method, auth: new Headers(init?.headers).get('authorization') });
        return new Response(null, { status: 204 });
      }
      return originalFetch(input, init);
    });
    try {
      await runInDurableObject(v2.orgStub, async (instance) => {
        (instance as unknown as { env: Record<string, unknown> }).env = {
          ...(instance as unknown as { env: Record<string, unknown> }).env,
          AGENT_RUNTIME_V2_API_TOKEN: 'v2-delete-token',
        };
        expect(instance.deleteThread(v2.threadId, v2.userId)).toBe(true);
      });
    } finally {
      fetchSpy.mockRestore();
    }
    expect(await v2.orgStub.getThreadRuntime(v2.threadId)).toBeNull();
    expect(deletedUrls).toEqual([
      { url: 'https://run.camelai.com/v2/agents/agt_v2_del', method: 'DELETE', auth: 'Bearer v2-delete-token' },
    ]);

    const orgDel = await freshThread();
    await orgDel.orgStub.pinThreadRuntime(orgDel.threadId, null, 'v2');
    await orgDel.orgStub.setThreadRuntimeAgent(orgDel.threadId, { agentId: 'agt_v2_org', model: 'm', keyScope: null });
    await expect(orgDel.orgStub.hardDeleteOrg(orgDel.userId)).resolves.toBeUndefined();
    expect(await orgDel.orgStub.getThreadRuntime(orgDel.threadId)).toBeNull();
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
