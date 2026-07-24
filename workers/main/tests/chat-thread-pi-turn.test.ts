import { afterEach, describe, expect, it, vi } from 'vitest';
import { CHAT_RECOVERY_INCIDENT_KEY_PREFIX } from 'agents/chat';
import { ChatThreadDO, CodeModeToolsBinding, prepareCodeModeUserCode } from '../src/chat-thread-do';
import { ChannelTools } from '../src/chat-channels';
import { piCoreMessageToParsedChatMessage, attachPiToolResultToParsedMessages } from '../src/pi-message-export';
import { PiModelMapping } from '../src/pi-model-resolution';
import {
  summarizePiMessages,
  createPiSummaryMessage,
  estimatePiTextTokens,
  estimatePiMessageTokens,
  piCompactionReserveTokens,
  piModelContextWindow,
  capPiMainRequestOutput,
  effectivePiContextTokens,
  observedPiContextTokens,
  estimatePiCompactionTokens,
  isPiLengthStopContextExhaustion,
  isPiContextOverflowMessage,
  shouldCompactPiAfterAssistantUsage,
  PI_MAIN_REQUEST_DEFAULT_OUTPUT_TOKENS,
  PI_MAIN_REQUEST_MAX_OUTPUT_TOKENS,
} from '../src/chat-thread/pi-compaction';
import {
  countPiContextTokensPrecise,
  findLastPricedContextSplit,
  measurePiContextTokens,
  shouldMeasurePiContextPrecisely,
} from '../src/chat-thread/pi-token-count';
import { extractToolContent } from '../src/chat-thread/pi-message-helpers';
import { PiCoreMessageStore } from '../src/chat-thread/pi-core-store';
import {
  HostedModelCreditsExhaustedError,
  HostedModelSubscriptionUnavailableError,
  resolveCurrentByokCredentials,
} from '../src/chat-thread/pi-model-config';
import { BrowserPromptCoordinator } from '../src/chat-thread-browser-prompts';
import { CamelAiService } from '../src/camelai-service';
import { encryptCredentials } from '../../../src/lib/integration-crypto';
import { stripPiUiMetadata } from '../../../src/lib/runtime-artifacts';
import { PiChunkEncoder } from '../../../src/lib/pi-chunk-encoder';
import { CodeModeWebSearch } from '../src/code-mode-web-search';
import {
  capabilityAgentSystemPrompt,
  capabilityAgentToolOptions,
  describeChildAgentActivity,
} from '../src/chat-thread/pi-tools';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/**
 * Deterministic varied prose, for fixtures that need to weigh what real
 * conversation history weighs. `'y'.repeat(n)` does not: a run of one character
 * collapses to roughly n/8 tokens, so padding with it understates a context by
 * several times once token counts are measured rather than estimated.
 */
function syntheticProse(length: number): string {
  const words = [
    'restoration', 'excavator', 'schedule', 'peat', 'dam', 'contractor',
    'estimate', 'linear', 'hectare', 'reprofiling', 'bund', 'plant',
    'labour', 'materials', 'tender', 'rate', 'output', 'ground',
  ];
  let seed = 987_654;
  let out = '';
  while (out.length < length) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    out += `${words[seed % words.length]} `;
  }
  return out.slice(0, length);
}

/**
 * Deterministic high-entropy base64, for fixtures that need to weigh what a real
 * inline image payload weighs. Built from a random block that is then tiled:
 * BPE merges locally, so tiling keeps the per-block token cost instead of
 * collapsing the way a single repeated character does.
 */
function syntheticBase64(length: number): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let seed = 12_345;
  let block = '';
  for (let i = 0; i < 4_096; i++) {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff;
    block += alphabet[seed % 64];
  }
  return block.repeat(Math.ceil(length / block.length)).slice(0, length);
}

describe('child agent progress labels', () => {
  it('keeps concrete child tool names and adds useful arguments', () => {
    expect(describeChildAgentActivity('Read', { path: 'public/main.js' })).toBe('Read · public/main.js');
    expect(describeChildAgentActivity('edit', { path: 'public/styles.css' })).toBe('edit · public/styles.css');
    expect(describeChildAgentActivity('WebSearch', { query: 'Cloudflare Workers limits' })).toBe('WebSearch · Cloudflare Workers limits');
    expect(describeChildAgentActivity('web_fetch', { url: 'https://example.com/docs' })).toBe('web_fetch · https://example.com/docs');
    expect(describeChildAgentActivity('build_project', { project: 'chess-game' })).toBe('build_project · chess-game');
    expect(describeChildAgentActivity('unknown_tool')).toBe('unknown_tool');
  });
});

describe('capability agent tool boundaries', () => {
  it('gives Oracle Research without exposing raw web tools or recursive agents', () => {
    expect(capabilityAgentToolOptions('Oracle')).toEqual({
      includeSubagents: false,
      includeResearch: true,
      includeOracle: false,
      includeWebTools: false,
    });
  });

  it('gives Research only its raw web tools', () => {
    expect(capabilityAgentToolOptions('Research')).toEqual({
      includeSubagents: false,
      includeResearch: false,
      includeOracle: false,
      includeWebTools: true,
    });
  });

  it('keeps capability-agent guidance focused and safe', () => {
    const researchPrompt = capabilityAgentSystemPrompt('Research');
    expect(researchPrompt).toContain('fewest web calls needed');
    expect(researchPrompt).toContain('at most 8 total web requests');
    expect(researchPrompt).not.toContain('Oracle');

    const oraclePrompt = capabilityAgentSystemPrompt('Oracle');
    expect(oraclePrompt).toContain('mutate files only when asked');
    expect(oraclePrompt).toContain('unless the supplied task explicitly requests it');
    expect(oraclePrompt).toContain('If the supplied task references image files');
    expect(oraclePrompt).toContain('describe exactly what you see before advising or implementing');
    expect(oraclePrompt).not.toContain('WebSearch');
    expect(oraclePrompt).not.toContain('WebFetch');
    expect(oraclePrompt).not.toMatch(/gpt|luna/i);
  });
});

function r2Object(content: string, contentType: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    size: bytes.byteLength,
    httpMetadata: { contentType },
    arrayBuffer: async () => bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ),
  };
}

function createChannelOrgNamespace({
  billingPlan = 'starter',
  billingStatus = 'active',
  thread = {
    id: 'thread1',
    source: 'web',
    channel_kind: null,
    channel_connection_id: null,
  },
  recordThreadChannelUsed = vi.fn(async () => null),
  workspaceInfo = {
    id: 'workspace1',
    name: 'Test Workspace',
    email_handle: 'workspace-agent',
    archived: false,
  },
  integrations = [] as any[],
  integration = null as any,
}: {
  billingPlan?: string;
  billingStatus?: string;
  thread?: any;
  recordThreadChannelUsed?: ReturnType<typeof vi.fn>;
  workspaceInfo?: any;
  integrations?: any[];
  integration?: any;
} = {}) {
  const orgStub = {
    getInfo: vi.fn(async () => ({
      billing_plan: billingPlan,
      billing_status: billingStatus,
    })),
    getThread: vi.fn(async () => thread),
    recordThreadChannelUsed,
    getWorkspaceRecord: vi.fn(async () => workspaceInfo),
    getWorkspaceIntegrations: vi.fn(async () => integrations),
    getWorkspaceIntegration: vi.fn(async (_workspaceId: string, integrationId: string) =>
      integration ?? integrations.find((candidate) => candidate.id === integrationId) ?? null,
    ),
  };
  return {
    idFromName: vi.fn((id: string) => id),
    get: vi.fn(() => orgStub),
    _stub: orgStub,
  };
}

function base64(content: string): string {
  return btoa(unescape(encodeURIComponent(content)));
}

function createProjectToolFake({
  deploy = false,
  projectFileEntries,
  backend = 'do-r2',
}: {
  deploy?: boolean;
  projectFileEntries?: Array<[string, string]>;
  backend?: 'do-r2' | 'vm';
} = {}) {
  const project = {
    id: 'project-1',
    workspaceId: 'workspace1',
    name: 'Demo App',
    description: 'Demo project',
    defaultVmId: 'main',
    backend,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const projectsByName = new Map<string, typeof project>([[project.name, project]]);
  const projectFiles = new Map<string, string>(projectFileEntries ?? [
    ['/package.json', '{"scripts":{"build":"vite build"}}'],
    ['/src/index.ts', 'export default { fetch() { return new Response("ok"); } }'],
  ]);
  const workspaceStub = {
    getProjectByName: vi.fn(async (name: string) => projectsByName.get(name) ?? null),
    listProjectsForMigrationReset: vi.fn(async () => [project]),
    removeProjects: vi.fn(async (ids: string[]) => ({
      deleted: ids.includes(project.id) ? [project] : [],
      retained: ids.includes(project.id) ? [] : [project],
    })),
    createProject: vi.fn(async (input: any) => {
      const createdProject = {
        ...project,
        name: input.name,
        description: input.description,
        backend: input.backend,
      };
      projectsByName.set(createdProject.name, createdProject);
      return createdProject;
    }),
  };
  const projectStub = {
    projectExists: vi.fn(async (path: string) => ({
      exists: projectFiles.has(path),
      isFile: projectFiles.has(path),
      isDirectory: false,
      size: projectFiles.get(path)?.length ?? 0,
    })),
    projectListFiles: vi.fn(async () => ({
      success: true,
      files: [...projectFiles.entries()].map(([path, content]) => ({
        name: path.split('/').pop(),
        type: 'file',
        size: content.length,
        modifiedAt: '2026-01-01T00:00:00.000Z',
        absolutePath: path,
        relativePath: path.replace(/^\/+/, ''),
      })),
      count: projectFiles.size,
      path: '/',
    })),
    projectReadFile: vi.fn(async (path: string) => ({
      success: true,
      content: projectFiles.get(path) ?? '',
      encoding: 'utf8',
      isBinary: false,
      size: projectFiles.get(path)?.length ?? 0,
    })),
    projectWriteFile: vi.fn(async (path: string, content: string) => {
      projectFiles.set(path, content);
      return { success: true };
    }),
    projectDeleteFile: vi.fn(async (path: string) => {
      projectFiles.delete(path);
      return { success: true };
    }),
    projectCreateSourceSnapshot: vi.fn(async () => ({
      id: 'snapshot-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      fileCount: projectFiles.size,
      totalBytes: [...projectFiles.values()].reduce((sum, content) => sum + content.length, 0),
      entries: [],
    })),
    projectRestoreSourceSnapshot: vi.fn(async (id: string) => ({
      id,
      createdAt: '2026-01-01T00:00:00.000Z',
      fileCount: 2,
      totalBytes: 96,
      entries: [],
    })),
    projectListSourceSnapshots: vi.fn(async () => [{
      id: 'snapshot-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      message: 'Deploy Demo App',
      fileCount: 2,
      totalBytes: 96,
      entries: [],
    }]),
    projectDeleteSourceSnapshots: vi.fn(async () => ({ snapshotsDeleted: 1, blobsDeleted: 2 })),
  };
  const sandboxFiles = new Map<string, string>();
  const sandbox = {
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (path: string, content: string) => {
      sandboxFiles.set(path, content);
    }),
    exec: vi.fn(async (command: string, options?: { cwd?: string }) => {
      if (command === 'bun install && bun run build' && options?.cwd) {
        sandboxFiles.set(`${options.cwd}/bun.lock`, base64('# lockfile\n'));
        sandboxFiles.set(`${options.cwd}/build/server/wrangler.json`, base64(JSON.stringify({
          name: 'demo-app',
          main: 'index.js',
          no_bundle: true,
          compatibility_date: '2026-06-01',
        })));
        sandboxFiles.set(`${options.cwd}/build/server/index.js`, base64('export default { fetch() { return new Response("ok"); } };'));
      }
      if (command === "bun add -d 'zod@^4'" && options?.cwd) {
        sandboxFiles.set(`${options.cwd}/package.json`, base64(JSON.stringify({
          scripts: { build: 'vite build' },
          devDependencies: { zod: '^4' },
        }, null, 2)));
        sandboxFiles.set(`${options.cwd}/bun.lock`, base64('# zod lockfile\n'));
        return { success: true, stdout: 'added zod', stderr: '', exitCode: 0 };
      }
      return { success: true, stdout: 'built', stderr: '', exitCode: 0 };
    }),
    readFile: vi.fn(async (path: string) => ({ content: sandboxFiles.get(path) ?? base64('') })),
    readFileStream: vi.fn(async (path: string) => {
      const binary = atob(sandboxFiles.get(path) ?? base64(''));
      const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
      const midpoint = Math.ceil(bytes.byteLength / 2);
      const events = [
        { type: 'metadata', mimeType: 'application/octet-stream', size: bytes.byteLength, isBinary: true, encoding: 'base64' },
        { type: 'chunk', data: btoa(String.fromCharCode(...bytes.slice(0, midpoint))) },
        { type: 'chunk', data: btoa(String.fromCharCode(...bytes.slice(midpoint))) },
        { type: 'complete' },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
      const encoded = new TextEncoder().encode(events);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded);
          controller.close();
        },
      });
    }),
    listFiles: vi.fn(async (path: string) => ({
      files: [...sandboxFiles.keys()]
        .filter((file) => file.startsWith(`${path.replace(/\/+$/g, '')}/`))
        .map((file) => ({
          name: file.split('/').pop() ?? '',
          type: 'file' as const,
          absolutePath: file,
          relativePath: file.slice(path.replace(/\/+$/g, '').length + 1),
        })),
    })),
    // Test helper: seed a sandbox file (auto-base64) so a custom exec mock can
    // shape the build output collectWorkerBundleFromSandbox will read back.
    __setFile: (path: string, content: string) => sandboxFiles.set(path, base64(content)),
  };
  const script = {
    script_name: 'demo-app',
    workspace_id: 'workspace1',
    is_public: false,
    custom_domain_hostname: null,
    updated_at: 123,
  };
  const orgStub = {
    getInfo: vi.fn(async () => ({ slug: 'test-org', billing_plan: 'starter', billing_status: 'active' })),
    getThread: vi.fn(async () => ({ id: 'thread1', workspace_id: 'workspace1', created_by: 'user1' })),
    registerWorkerScript: vi.fn(async () => script),
    updateWorkerScriptPreview: vi.fn(async () => ({ stale: false })),
    getWorkerScript: vi.fn(async () => script),
  };
  const chatThreadStub = {
    recordProjectActivity: vi.fn(async () => undefined),
    recordVerifiedWorkEvidence: vi.fn(async () => undefined),
    setPreviewTarget: vi.fn(async () => undefined),
  };
  const env = {
    WORKER_BASE_URL: 'https://staging.camelai.dev',
    LOCAL_APP_VANITY_DOMAIN: 'camelai.app',
    WORKSPACE_FS: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn((id: string) => id === 'workspace1' ? workspaceStub : projectStub),
    },
    ORG: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => orgStub),
    },
    CHAT_THREAD: {
      idFromName: vi.fn((id: string) => id),
      get: vi.fn(() => chatThreadStub),
    },
    APP_KV: {
      put: vi.fn(async () => undefined),
    },
    R2_BUCKET: deploy ? {
      put: vi.fn(async () => undefined),
    } : undefined,
    CF_API_TOKEN: deploy ? 'token' : undefined,
    CF_ACCOUNT_ID: deploy ? 'account' : undefined,
    CF_DISPATCH_NAMESPACE: deploy ? 'namespace' : undefined,
    CF_WORKER_NAME: deploy ? 'main-worker' : undefined,
  };
  const fake = Object.create(CodeModeToolsBinding.prototype) as any;
  fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1', userId: 'user1', parentToolUseId: 'js-exec-1' } };
  fake.env = env;
  fake.projectBuildSandbox = vi.fn(() => sandbox);
  return {
    fake,
    env,
    sandbox,
    workspaceStub,
    projectStub,
    orgStub,
    chatThreadStub,
  };
}

describe('ChatThreadDO Pi turn handling', () => {
  it('routes GPT-5.6 product models to OpenAI', () => {
    const mapping = new PiModelMapping();
    expect(mapping.resolvePiModelReference('gpt-5.6-sol')).toMatchObject({
      provider: 'openai',
      modelId: 'gpt-5.6-sol',
    });
    expect(mapping.resolvePiModelReference('gpt-5.6-terra')).toMatchObject({
      provider: 'openai',
      modelId: 'gpt-5.6-terra',
    });
    expect(mapping.resolvePiModelReference('gpt-5.6-luna')).toMatchObject({
      provider: 'openai',
      modelId: 'gpt-5.6-luna',
    });
  });

  it('routes Bedrock product IDs to their provider model IDs', () => {
    const mapping = new PiModelMapping();
    expect(mapping.resolvePiModelReference('gpt-5.6-sol-bedrock')).toMatchObject({
      provider: 'openai',
      modelId: 'gpt-5.6-sol',
    });
    expect(mapping.resolvePiModelReference('gpt-5.6-terra-bedrock')).toMatchObject({
      provider: 'openai',
      modelId: 'gpt-5.6-terra',
    });
  });
  function createPiEventFake() {
    const events: any[] = [];
    const activityRecords: any[] = [];
    const workspaceStub = {
      recordThreadStreaming: vi.fn(async (...args: any[]) => {
        activityRecords.push(args);
      }),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => workspaceStub),
      },
    };
    fake.ctx = {
      waitUntil: vi.fn(),
      // Pi turn-journal + active-turn marker storage (used by message_end /
      // turn_end / agent_end via recordPiTurnJournalTail / clearPiTurnJournal /
      // clearPiActiveTurnAndJournal). A no-op SQL/KV stub is enough for these
      // unit tests — the durable-resume behavior is covered in pi-turn-journal.test.ts.
      storage: {
        kv: { get: vi.fn(() => undefined), put: vi.fn(), delete: vi.fn() },
        sql: { exec: vi.fn(() => ({ toArray: () => [] })) },
      },
    };
    // The Agents SDK runFiber does real durable bookkeeping (cf_agents_runs
    // INSERT via an iterable SQL cursor); these unit tests only care that the
    // wrapped turn body runs, so invoke the callback directly. Durable-resume
    // semantics are covered separately in pi-turn-journal.test.ts.
    fake.runFiber = vi.fn(async (_name: string, fn: () => unknown) => fn());
    fake.piActiveItemId = null;
    fake.piActiveItemText = '';
    fake.piReasoningItemId = null;
    fake.piToolArgs = new Map();
    fake.piAssistantText = '';
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.appendPiCoreMessagesIfMissing = vi.fn();
    fake.upsertPiCoreMessages = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.completeTodoStateForTurnEnd = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.pushChatEvent = vi.fn((event: any) => events.push(event));
    installAgentStateMocks(fake);
    return { fake, events, activityRecords, workspaceStub };
  }

  async function flushWaitUntil(fake: any) {
    await Promise.all(
      fake.ctx.waitUntil.mock.calls
        .map(([promise]: [Promise<unknown>]) => promise)
        .filter(Boolean),
    );
  }

  function installAgentStateMocks(fake: any) {
    fake.chatIsStreaming ??= false;
    fake.previewTabs ??= [];
    fake.previewActiveTabId ??= null;
    fake.previewVersion ??= 0;
    fake.currentTodos ??= [];
    fake.transientContextUsedPercent ??= null;
    fake.contextUsedPercent ??= null;
    fake.currentTitle ??= null;
    fake.currentTitleUpdatedAt ??= null;
    fake.currentThreadModel ??= null;
    fake.currentThreadModelUpdatedAt ??= null;
    fake.browserPrompts ??= {};
    fake.browserPrompts.getOldestPendingQuestion ??= vi.fn(() => null);
    fake.browserPrompts.pendingConnectionSetupPrompts ??= vi.fn(() => []);
    fake.setState = vi.fn();
    // The live overlay rides the broadcast channel, not setState. Assign
    // unconditionally — broadcastChat exists on the prototype, so ??= is a no-op.
    fake.broadcastChat = vi.fn();
  }

  it('resolves Fable 5 requests to the Claude Fable 5 model', () => {
    const result = new PiModelMapping().resolvePiModelReference('fable-5');

    expect(result).toEqual({
      provider: 'anthropic',
      modelId: 'claude-fable-5',
      hostedGatewayProvider: 'openrouter',
      hostedModelId: 'anthropic/claude-fable-5:nitro',
    });
  });

  it('preserves sentDuringStreaming metadata on parsed Pi user messages', () => {
    const result = piCoreMessageToParsedChatMessage(
      {
        role: 'user',
        content: 'also add dark mode',
        timestamp: 123,
        metadata: { sentDuringStreaming: true },
      },
      0,
      'thread1',
    );

    expect(result).toEqual([
      {
        id: 'pi_user_123_0',
        thread_id: 'thread1',
        role: 'user',
        content: 'also add dark mode',
        created_at: 123,
        forkEntryId: 'pi_user_123_0',
        sentDuringStreaming: true,
      },
    ]);
  });

  // Render content (assistant/tool messages, streamed output, turn-completion
  // re-identity, overlay size bounding) no longer rides a server-built live
  // overlay — it is emitted as native UIMessage chunks by PiChunkEncoder and
  // owned by ai-chat render history. Those behaviors are covered by the encoder
  // golden-transcript test (tests/pi-chunk-encoder.test.ts), the adapter test
  // (tests/ui-message-adapter.test.ts), and the stream-bridge test
  // (chat-thread-pi-stream-bridge.test.ts). What remains DO-side and tested here:
  // the durable badge/error state channel and code-mode artifact stream delivery.

  it('records terminal errors in lastError state and puts no turn event on any socket', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.lastError = null;
    fake.agentEvalEventCollector = [];
    fake.activePiStreamTurnId = null;
    fake.piChunkEncoder = null;
    fake.piStreamWriter = null;
    fake.piPreAttachChunkBuffer = null;
    fake.ctx = { storage: { sql: {} } };
    fake.recordCurrentThreadError = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.broadcastChat = vi.fn();

    // Errors ride Agent state (with a unique id) and are not broadcast, so a
    // reconnect after a disconnected failure can still recover them.
    ChatThreadDO.prototype['pushChatEvent'].call(fake, {
      type: 'error',
      error: 'Boom',
      billingSource: 'byok',
      provider: 'bedrock',
      status: 429,
    });

    // Terminal turn errors are also surfaced in the structured errors dataset so a
    // provider fault is distinguishable from a stall/disconnect in telemetry.
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_turn_error',
      expect.objectContaining({
        status: 'error',
        severity: 'error',
        provider: 'bedrock',
        statusCode: 429,
        error: expect.objectContaining({ message: 'Boom' }),
      }),
    );

    expect(fake.syncAgentState).toHaveBeenCalled();
    expect(typeof fake.lastError.id).toBe('string');
    expect(fake.lastError).toMatchObject({
      error: 'Boom',
      billingSource: 'byok',
      provider: 'bedrock',
      status: 429,
      errorType: null,
    });

    // The result envelope still feeds the eval collector but is no longer put on
    // any socket — the client keys turn-done off the native stream's finish chunk,
    // and error/runtime content rides the stream + state channel, never broadcast.
    ChatThreadDO.prototype['pushChatEvent'].call(fake, {
      type: 'result',
      result: 'done',
    });
    expect(fake.broadcastChat).not.toHaveBeenCalled();
    expect(fake.agentEvalEventCollector.map((e: any) => e.type)).toEqual([
      'error',
      'result',
    ]);
  });

  it('emits the turn-finish observability event on turn/completed with no Agent-state mirror', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.agentEvalEventCollector = null;
    fake.activePiStreamTurnId = 'turn-mint-1';
    fake.piChunkEncoder = null;
    fake.piStreamWriter = null;
    fake.piPreAttachChunkBuffer = null;
    fake.syncAgentState = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();

    ChatThreadDO.prototype['pushChatEvent'].call(fake, {
      type: 'runtime_event',
      event: {
        method: 'turn/completed',
        params: { forkEntryId: 'fork-1', completedAtMs: 1700, turnDurationMs: 4200 },
      },
    });

    // The turn-completed badge (duration/completion) rides message-metadata.pi on
    // the assistant message the encoder emits, so the browser derives it from
    // render history — no Agent-state mirror, no syncAgentState for a runtime event.
    expect(fake.syncAgentState).not.toHaveBeenCalled();
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_turn_finished',
      expect.objectContaining({ status: 'completed', durationMs: 4200 }),
    );
  });

  it('restores the durable error on wake but does not restore streaming (it is derived)', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.durableStateHydrated = false;
    fake.chatIsStreaming = false;
    fake.lastError = null;
    const durableError = {
      id: 'err-1',
      error: 'boom',
      billingSource: null,
      provider: null,
      status: null,
      errorType: null,
    };
    Object.defineProperty(fake, 'state', {
      configurable: true,
      value: {
        isStreaming: true,
        lastError: durableError,
      },
    });

    ChatThreadDO.prototype['hydrateDurableStateOnce'].call(fake);

    // Streaming is derived on read (see isThreadStreaming); hydrate restores only
    // the coarse terminal error, so a cold wake can't strand the spinner and there
    // is no persisted streaming flag to resurrect.
    expect(fake.chatIsStreaming).toBe(false);
    expect(fake.lastError).toEqual(durableError);
  });

  const sampleArtifact = {
    id: 'art-1',
    kind: 'outbound_email',
    toolName: 'send_email',
    status: 'sent',
    title: 'Sent invite',
    createdAt: 1,
    updatedAt: 1,
    summary: {},
  };

  it('delivers code-mode artifacts to the active turn stream as a reconciled data part', () => {
    // Artifacts are recorded mid-js_exec (sometimes after item/completed); they
    // ride a standalone data-pi-artifacts part reconciled by tool call id (the
    // adapter folds them onto the tool_result at read time — see the adapter test).
    const writes: any[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piChunkEncoder = new PiChunkEncoder({ messageId: 'turn-1' });
    fake.piStreamWriter = { write: (chunk: any) => writes.push(chunk) };
    fake.piPreAttachChunkBuffer = null;

    ChatThreadDO.prototype['deliverCodeModeArtifacts'].call(fake, 'tool-1', [sampleArtifact]);

    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      type: 'data-pi-artifacts',
      id: 'pi-artifacts:tool-1',
      data: { toolCallId: 'tool-1', artifacts: [sampleArtifact] },
    });
  });

  it('does not deliver artifacts to the stream when no turn is bridging', () => {
    // Outside a bridged turn (encoder null) the artifact still persisted to KV in
    // the caller (recordCodeModeArtifact) and reaches the client via the top-up
    // backfill — delivery is a no-op that must not throw or buffer into a stale turn.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piChunkEncoder = null;
    fake.piStreamWriter = null;
    fake.piPreAttachChunkBuffer = null;

    expect(() =>
      ChatThreadDO.prototype['deliverCodeModeArtifacts'].call(fake, 'tool-1', [sampleArtifact]),
    ).not.toThrow();
    expect(fake.piPreAttachChunkBuffer).toBeNull();
  });

  it('backfills full first user message metadata while bounding title generation input', async () => {
    const longMessage = `Please keep this entire first prompt ${'x'.repeat(900)}`;
    const attributedMessage = `[Miguel (miguel@example.com)]: ${longMessage}`;
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        workspace_id: 'workspace1',
        title: 'New Chat',
        first_user_message: null,
      })),
      recordThreadUserMessage: vi.fn(async () => null),
      setThreadFirstUserMessage: vi.fn(async () => null),
    };
    const userStub = {
      touchGroupForThread: vi.fn(async () => undefined),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
    };
    fake.titleGenerationInFlight = false;
    fake.generateThreadTitleFromMessage = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['updateThreadMetadataForUserMessage'].call(
      fake,
      attributedMessage,
      'web',
    );

    expect(orgStub.recordThreadUserMessage).toHaveBeenCalledWith(
      'thread1',
      attributedMessage,
      'web',
    );
    expect(userStub.touchGroupForThread).toHaveBeenCalledWith('thread1');
    expect(orgStub.setThreadFirstUserMessage).toHaveBeenCalledWith(
      'thread1',
      longMessage,
    );
    expect(fake.generateThreadTitleFromMessage).toHaveBeenCalledWith(
      'thread1',
      longMessage.slice(0, 500),
    );
  });

  it('generates a placeholder title even when first user message metadata already exists', async () => {
    const userMessage = 'Build a dashboard for sales metrics';
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        workspace_id: 'workspace1',
        title: 'New Chat',
        first_user_message: userMessage,
      })),
      recordThreadUserMessage: vi.fn(async () => null),
      setThreadFirstUserMessage: vi.fn(async () => null),
    };
    const userStub = {
      touchGroupForThread: vi.fn(async () => undefined),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
      USER: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => userStub),
      },
    };
    fake.titleGenerationInFlight = false;
    fake.generateThreadTitleFromMessage = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['updateThreadMetadataForUserMessage'].call(
      fake,
      userMessage,
      'web',
    );

    expect(orgStub.setThreadFirstUserMessage).not.toHaveBeenCalled();
    expect(fake.generateThreadTitleFromMessage).toHaveBeenCalledWith(
      'thread1',
      userMessage,
    );
  });

  it('keeps hosted Claude on Anthropic Messages while routing through OpenRouter AI Gateway', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: true,
      vllmPriority: '0',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      vi.fn(() => ({
        id: 'claude-sonnet-5',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'anthropic/claude-sonnet-5:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'anthropic-messages',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
    });
    expect(model.apiKey).toBe('cf-token');
    expect(model.provider).toBe('anthropic');
    expect(model.billingSource).toBe('hosted');
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it('uses Fable metadata for hosted Fable 5 requests', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: true,
      vllmPriority: '0',
    }));

    const getModel = vi.fn(() => undefined);
    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'fable-5' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('anthropic', 'claude-fable-5');
    expect(model.model).toMatchObject({
      id: 'anthropic/claude-fable-5:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'anthropic-messages',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
      name: 'Claude Fable 5',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
      },
    });
    expect(model.apiKey).toBe('cf-token');
    expect(model.provider).toBe('anthropic');
    expect(model.modelId).toBe('claude-fable-5');
    expect(model.billingSource).toBe('hosted');
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it('sends initial user messages after preparing the Pi session', async () => {
    const sentCommands: any[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = null;
    fake.chatIsStreaming = false;
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.env = {
      APP_KV: { get: vi.fn().mockResolvedValue(null) },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadStreaming: vi.fn(async () => {}) })),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.emitChatError = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => undefined);
    fake.applyMentionsForTurn = vi.fn(async (content: string) => content);
    fake.updateThreadMetadataForUserMessage = vi.fn(async () => {});
    fake.warmWorkspaceContainerForTurn = vi.fn(async () => undefined);
    const persisted: any[] = [];
    fake.appendPiCoreMessagesIfMissing = vi.fn(async (messages: any[]) => {
      persisted.push(...messages);
    });
    fake.sendRunnerCommand = vi.fn((command: any) => {
      sentCommands.push(command);
      return true;
    });

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'Miguel',
      userEmail: 'miguel@example.com',
      messageSource: 'email',
      message: 'hello',
      clientMessageId: 'initial:thread1',
    });

    expect(result).toEqual({ status: 'accepted' });
    expect(fake.ensurePiSessionReady).toHaveBeenCalledTimes(1);
    expect(fake.syncAgentState).toHaveBeenCalled();
    expect(fake.warmWorkspaceContainerForTurn).not.toHaveBeenCalled();
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      type: 'message',
      threadId: 'thread1',
      userId: 'user1',
      clientMessageId: 'initial:thread1',
      authorDisplayName: 'Miguel',
      messageSource: 'email',
    });
    expect(sentCommands[0].content).toBe('[email message from Miguel (miguel@example.com)]: hello');
    // The initial send commits the user's message to the transcript up front so a
    // reader that loads the thread the instant this resolves sees it (no optimistic
    // placeholder). It shares its timestamp with the message Pi is prompted with so
    // the turn-end commit dedups it by piCoreMessageKey instead of double-storing.
    expect(persisted).toHaveLength(1);
    expect(persisted[0]).toMatchObject({
      role: 'user',
      content: '[email message from Miguel (miguel@example.com)]: hello',
    });
    expect(persisted[0].timestamp).toBe(sentCommands[0].timestamp);
    expect(typeof persisted[0].timestamp).toBe('number');
  });

  const makeNewTurnEnqueueFake = (order: string[]) => {
    // A fresh new-chat turn: no live piSession, so startsNewTurn is true and the
    // persistUserMessageImmediately path runs.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'Miguel',
      userEmail: 'miguel@example.com',
    };
    fake.chatIsStreaming = false;
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.env = {
      APP_KV: { get: vi.fn().mockResolvedValue(null) },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadStreaming: vi.fn(async () => {}) })),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.publishRunningUserMessageActivity = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => undefined);
    fake.applyMentionsForTurn = vi.fn(async (content: string) => content);
    fake.updateThreadMetadataForUserMessage = vi.fn(async () => {});
    fake.warmWorkspaceContainerForTurn = vi.fn(async () => undefined);
    fake.appendPiCoreMessagesIfMissing = vi.fn(async () => {
      order.push('persist');
    });
    return fake;
  };

  it('persists the initial user message only AFTER the send is accepted', async () => {
    // Ordering guard: the first-message commit must run after sendRunnerCommand
    // succeeds (the fiber row exists), not before — otherwise a failed/interrupted
    // send strands an orphaned user message with no turn behind it. It must still
    // commit before the enqueue resolves, so a reader that awaits the ack and
    // loads the thread sees the message.
    const order: string[] = [];
    const fake = makeNewTurnEnqueueFake(order);
    fake.sendRunnerCommand = vi.fn(() => {
      order.push('send');
      return true;
    });

    const result = await ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(
      fake,
      { type: 'message', content: 'hello', clientMessageId: 'initial:thread1' },
      { persistUserMessageImmediately: true },
    );

    expect(result).toEqual({ status: 'accepted' });
    expect(order).toEqual(['send', 'persist']);
    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledTimes(1);
  });

  it('does NOT persist the initial user message when the send is rejected (no orphaned first message)', async () => {
    const order: string[] = [];
    const fake = makeNewTurnEnqueueFake(order);
    // The runner refuses the command (e.g. a transient DO reset). Under the old
    // persist-before-send ordering this left an orphaned user message with no
    // turn — the original "user message, no agent response" bug.
    fake.sendRunnerCommand = vi.fn(() => false);

    const result = await ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(
      fake,
      { type: 'message', content: 'hello', clientMessageId: 'initial:thread1' },
      { persistUserMessageImmediately: true },
    );

    expect(result.status).toBe('error');
    expect(order).toEqual([]);
    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenLastCalledWith(null);
  });

  it('makes a fresh turn durably recoverable synchronously, then hands it to ai-chat', async () => {
    const order: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.piSession = {
      state: { isStreaming: false },
      prompt: vi.fn(),
      steer: vi.fn(),
    };
    fake.ctx = { waitUntil: vi.fn() };
    fake.pendingPiPromptQueue = [];
    fake.readPiActiveTurn = vi.fn(() => null);
    // The marker + journal are written SYNCHRONOUSLY (before the ctx.waitUntil body),
    // so an eviction anywhere after this tick is recoverable by chatRecovery.
    fake.openPiActiveTurnIfAbsent = vi.fn(() => order.push('marker'));
    fake.recordPiTurnJournalUserMessage = vi.fn(() => order.push('journal'));
    fake.recordPiTurnJournalSteerMessage = vi.fn();
    fake.buildUserUiSkeleton = vi.fn(() => ({ id: 'u1', role: 'user', parts: [] }));
    fake.saveMessages = vi.fn(async () => {
      order.push('saveMessages');
      return { status: 'completed' };
    });
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
      type: 'message',
      content: 'do the thing',
      rawContent: 'do the thing',
      authorDisplayName: 'Illiana Reed',
      messageSource: 'web',
    });
    expect(accepted).toBe(true);

    // Recoverability is established up front, in the same tick as acceptance.
    expect(fake.openPiActiveTurnIfAbsent).toHaveBeenCalledTimes(1);
    expect(fake.recordPiTurnJournalUserMessage).toHaveBeenCalledTimes(1);
    expect(fake.buildUserUiSkeleton).toHaveBeenCalledWith({
      rawContent: 'do the thing',
      clientMessageId: undefined,
      authorDisplayName: 'Illiana Reed',
      messageSource: 'web',
      piCoreMessageKey: expect.any(Number),
    });
    expect(order.slice(0, 2)).toEqual(['marker', 'journal']);
    // The attributed prompt is queued for onChatMessage's fresh path (the durable
    // copy for a pre-stream eviction lives in the journal above).
    expect(fake.pendingPiPromptQueue).toHaveLength(1);
    expect(fake.pendingPiPromptQueue[0]).toMatchObject({
      userMessage: { role: 'user', content: 'do the thing' },
    });
    // onChatMessage OWNS the prompt now — sendRunnerCommand must NOT run the model.
    expect(fake.piSession.prompt).not.toHaveBeenCalled();
    // The turn is handed to ai-chat via saveMessages (which drives onChatMessage).
    expect(fake.saveMessages).toHaveBeenCalledTimes(1);
    expect(fake.ctx.waitUntil).toHaveBeenCalledTimes(1);

    await flushWaitUntil(fake);
    expect(order).toEqual(['marker', 'journal', 'saveMessages']);
  });

  describe('isThreadStreaming (derived loading state)', () => {
    const makeFake = (opts: { piStreaming?: boolean | null; marker?: boolean }) => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession =
        opts.piStreaming === null || opts.piStreaming === undefined
          ? null
          : { state: { isStreaming: opts.piStreaming } };
      fake.readPiActiveTurn = vi.fn(() =>
        opts.marker ? { turnId: 't1', openedAt: 1 } : null,
      );
      return fake;
    };
    const call = (fake: any): boolean =>
      ChatThreadDO.prototype['isThreadStreaming'].call(fake);

    it('is true while a turn is live in this isolate', () => {
      expect(call(makeFake({ piStreaming: true, marker: false }))).toBe(true);
    });

    it('is true when an active-turn marker exists (cold-wake gap / pending resume, piSession gone)', () => {
      expect(call(makeFake({ piStreaming: null, marker: true }))).toBe(true);
    });

    it('is false when no turn is live and no marker is set', () => {
      expect(call(makeFake({ piStreaming: false, marker: false }))).toBe(false);
    });

    it('reads idle once a terminal path clears the marker', () => {
      // agent_end / resume completion / error cleanup all clear the marker, so a
      // settled turn derives idle with no separate flag to forget.
      expect(call(makeFake({ piStreaming: null, marker: false }))).toBe(false);
    });
  });

  describe('onStart (no heal needed — streaming is derived)', () => {
    it('hydrates and syncs state; never clears streaming or schedules a resume', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.durableStateHydrated = true; // hydrate short-circuits
      fake.markTurnStarted = vi.fn();
      fake.finishTurn = vi.fn();
      fake.setActiveTurnUserId = vi.fn();
      fake.schedule = vi.fn(async () => {});
      fake.pushChatEvent = vi.fn();
      fake.syncAgentState = vi.fn();

      await ChatThreadDO.prototype.onStart.call(fake);

      expect(fake.syncAgentState).toHaveBeenCalledTimes(1);
      expect(fake.finishTurn).not.toHaveBeenCalled();
      expect(fake.markTurnStarted).not.toHaveBeenCalled();
      expect(fake.schedule).not.toHaveBeenCalled();
      expect(fake.pushChatEvent).not.toHaveBeenCalled();
    });
  });

  describe('mid-turn config change', () => {
    it('byokChanged invalidates the provider cache and re-drives the live session with the new config', async () => {
      const calls: string[] = [];
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.cachedLlmProviderConfig = { stale: true };
      fake.piSession = { state: { isStreaming: true } }; // live
      fake.ctx = { waitUntil: (p: Promise<unknown>) => p };
      fake.disposePiSession = vi.fn(() => {
        calls.push('dispose');
        fake.piSession = null;
      });
      fake.driveConfigChangeResume = vi.fn(async () => {
        calls.push('resume');
      });
      fake.withRunnerTransitionLock = vi.fn(
        async (_label: string, fn: () => Promise<void>) => fn(),
      );

      await ChatThreadDO.prototype.byokChanged.call(fake);

      expect(fake.cachedLlmProviderConfig).toBeNull();
      // A rebuild is required: getApiKey can refresh the key on the live loop, but
      // not the captured model / provider routing / base URL the in-flight turn is
      // already streaming with — dispose (aborting the in-flight prompt) + re-drive
      // through ai-chat's recovery entry points picks those up.
      expect(calls).toEqual(['dispose', 'resume']);
      expect(fake.driveConfigChangeResume).toHaveBeenCalledTimes(1);
    });

    it('refreshRunnerConfig disposes a live turn and re-drives it so it continues with the new model', async () => {
      const calls: string[] = [];
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession = { state: { isStreaming: true } }; // live -> isThreadStreaming short-circuits true
      fake.ctx = { waitUntil: (p: Promise<unknown>) => p };
      fake.disposePiSession = vi.fn(() => {
        calls.push('dispose');
        fake.piSession = null;
      });
      fake.driveConfigChangeResume = vi.fn(async () => {
        calls.push('resume');
      });
      fake.withRunnerTransitionLock = vi.fn(
        async (_label: string, fn: () => Promise<void>) => fn(),
      );

      await ChatThreadDO.prototype.refreshRunnerConfig.call(fake);

      // Dispose first (the live turn settles; the spinner is derived so it won't
      // strand), then re-drive the interrupted turn with the new model.
      expect(calls).toEqual(['dispose', 'resume']);
      expect(fake.driveConfigChangeResume).toHaveBeenCalledTimes(1);
    });

    it('refreshRunnerConfig disposes but does not re-drive an idle thread', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession = null; // idle
      fake.ctx = {
        storage: {
          sql: { exec: () => ({ toArray: () => [{ c: 0 }] }) },
        },
      };
      fake.disposePiSession = vi.fn();
      fake.driveConfigChangeResume = vi.fn(async () => {});
      fake.withRunnerTransitionLock = vi.fn(
        async (_label: string, fn: () => Promise<void>) => fn(),
      );

      await ChatThreadDO.prototype.refreshRunnerConfig.call(fake);

      expect(fake.disposePiSession).toHaveBeenCalled();
      expect(fake.driveConfigChangeResume).not.toHaveBeenCalled();
    });

    it('driveConfigChangeResume continues an in-flight partial but retries a pre-stream turn', async () => {
      // continue when THIS turn already persisted a partial assistant (last-assistant
      // id === the marker's stream id); retry from the user message otherwise, so the
      // resumed output never merges into a prior turn's bubble.
      const continueFake = Object.create(ChatThreadDO.prototype) as any;
      continueFake.readPiActiveTurn = vi.fn(() => ({ turnId: 't1', openedAt: 1 }));
      continueFake.messages = [
        { id: 'u1', role: 'user', parts: [] },
        { id: 't1', role: 'assistant', parts: [] },
      ];
      continueFake.continueLastTurn = vi.fn(async () => ({ status: 'completed' }));
      continueFake._retryLastUserTurn = vi.fn(async () => ({ status: 'completed' }));
      await ChatThreadDO.prototype['driveConfigChangeResume'].call(continueFake);
      expect(continueFake.continueLastTurn).toHaveBeenCalledTimes(1);
      expect(continueFake._retryLastUserTurn).not.toHaveBeenCalled();

      const retryFake = Object.create(ChatThreadDO.prototype) as any;
      retryFake.readPiActiveTurn = vi.fn(() => ({ turnId: 't1', openedAt: 1 }));
      // Leaf is the user message — no partial assistant persisted for this turn yet.
      retryFake.messages = [{ id: 'u1', role: 'user', parts: [] }];
      retryFake.continueLastTurn = vi.fn(async () => ({ status: 'completed' }));
      retryFake._retryLastUserTurn = vi.fn(async () => ({ status: 'completed' }));
      await ChatThreadDO.prototype['driveConfigChangeResume'].call(retryFake);
      expect(retryFake._retryLastUserTurn).toHaveBeenCalledTimes(1);
      expect(retryFake.continueLastTurn).not.toHaveBeenCalled();
    });

    it('driveConfigChangeResume clears the stranded marker when recovery reports skipped', async () => {
      // continueLastTurn/_retryLastUserTurn return "skipped" without re-driving
      // the turn (no continuable assistant / no unanswered user leaf). Nothing
      // else observes that status, so the DO must close the turn out itself or
      // the active-turn marker keeps the thread "busy" forever.
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.readPiActiveTurn = vi.fn(() => ({ turnId: 't1', openedAt: 1 }));
      fake.messages = [{ id: 'u1', role: 'user', parts: [] }];
      fake.continueLastTurn = vi.fn(async () => ({ status: 'skipped' }));
      fake._retryLastUserTurn = vi.fn(async () => ({ status: 'skipped' }));
      fake.recordChatThreadObservabilityEvent = vi.fn();
      fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
      fake.finishTurn = vi.fn();
      fake.setActiveTurnUserId = vi.fn();
      fake.syncAgentState = vi.fn();

      await ChatThreadDO.prototype['driveConfigChangeResume'].call(fake);

      expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalledTimes(1);
      expect(fake.finishTurn).toHaveBeenCalledTimes(1);
      expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
      expect(fake.syncAgentState).toHaveBeenCalled();
      expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
        'pi_turn_resume_skipped',
        expect.objectContaining({ status: 'skipped' }),
      );

      // A completed resume must NOT run the cleanup.
      const completedFake = Object.create(ChatThreadDO.prototype) as any;
      completedFake.readPiActiveTurn = vi.fn(() => ({ turnId: 't1', openedAt: 1 }));
      completedFake.messages = [{ id: 'u1', role: 'user', parts: [] }];
      completedFake._retryLastUserTurn = vi.fn(async () => ({ status: 'completed' }));
      completedFake.continueLastTurn = vi.fn(async () => ({ status: 'completed' }));
      completedFake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
      completedFake.finishTurn = vi.fn();
      await ChatThreadDO.prototype['driveConfigChangeResume'].call(completedFake);
      expect(completedFake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
      expect(completedFake.finishTurn).not.toHaveBeenCalled();
    });
  });

  it('publishes initial user message startup failures to chat clients', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const events: any[] = [];
    const error = new Error('Self-host chat requires an AI provider.');

    fake.chatContext = null;
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveAutomationRun = vi.fn();
    fake.pushChatEvent = vi.fn((event: any) => events.push(event));
    fake.enqueueRunnerUserMessage = vi.fn(async () => {
      throw error;
    });

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      message: 'hello',
      clientMessageId: 'initial:thread1',
    });

    expect(result).toEqual({
      status: 'error',
      error: 'Self-host chat requires an AI provider.',
    });
    expect(fake.pushChatEvent).toHaveBeenCalledTimes(1);
    expect(events[0]).toMatchObject({
      type: 'error',
      error: 'Self-host chat requires an AI provider.',
      status: 500,
    });
  });

  it('rejects automation starts while another automation run is active', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const activeAutomationRun = {
      workspaceId: 'workspace1',
      automationId: 'prompt1',
      runId: 'run1',
    };

    fake.chatContext = null;
    fake.activeAutomationRun = activeAutomationRun;
    fake.isThreadStreaming = vi.fn(() => true); // a turn is active in this isolate
    fake.browserPrompts = { pendingQuestionCount: 0 };
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveAutomationRun = vi.fn();
    fake.enqueueRunnerUserMessage = vi.fn(async () => ({ status: 'accepted' }));

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      message: 'run scheduled task',
      automationRun: {
        workspaceId: 'workspace1',
        automationId: 'prompt1',
        runId: 'run2',
      },
    });

    expect(result).toEqual({
      status: 'busy',
      error: 'Thread is busy with another run',
    });
    expect(fake.setActiveAutomationRun).not.toHaveBeenCalled();
    expect(fake.enqueueRunnerUserMessage).not.toHaveBeenCalled();
    expect(fake.activeAutomationRun).toBe(activeAutomationRun);
  });

  it('reconciles inactive automation locks before accepting a new automation start', async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const recordScheduledPromptRunResult = vi.fn(async () => true);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const staleAutomationRun = {
      workspaceId: 'workspace1',
      automationId: 'prompt1',
      runId: 'run1',
    };
    const nextAutomationRun = {
      workspaceId: 'workspace1',
      automationId: 'prompt1',
      runId: 'run2',
    };

    fake.chatContext = null;
    fake.chatIsStreaming = false;
    fake.activeAutomationRun = staleAutomationRun;
    fake.browserPrompts = { pendingQuestionCount: 0 };
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      }),
    };
    fake.env = {
      WORKSPACE_CRON: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordScheduledPromptRunResult })),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.enqueueRunnerUserMessage = vi.fn(async () => ({ status: 'accepted' }));

    const result = await ChatThreadDO.prototype.startInitialUserMessage.call(fake, {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      message: 'run scheduled task',
      automationRun: nextAutomationRun,
    });
    await Promise.all(waitUntilPromises);

    expect(result).toEqual({ status: 'accepted' });
    expect(recordScheduledPromptRunResult).toHaveBeenCalledWith({
      workspaceId: staleAutomationRun.workspaceId,
      promptId: staleAutomationRun.automationId,
      runId: staleAutomationRun.runId,
      status: 'error',
      message: 'Automation run did not finish before the thread restarted',
      completedAt: expect.any(Number),
    });
    expect(fake.activeAutomationRun).toEqual(nextAutomationRun);
    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledTimes(1);
  });

  it('accepts follow-up user messages while the thread is already streaming', async () => {
    const sentCommands: any[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'Miguel',
      userEmail: 'miguel@example.com',
    };
    fake.chatIsStreaming = true;
    fake.ctx = {
      storage: { kv: { put: vi.fn(), delete: vi.fn() } },
      waitUntil: vi.fn(),
    };
    fake.env = {
      APP_KV: { get: vi.fn().mockResolvedValue(null) },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadStreaming: vi.fn(async () => {}) })),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.publishRunningUserMessageActivity = vi.fn();
    fake.broadcastRunnerClients = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => undefined);
    fake.applyMentionsForTurn = vi.fn(async (content: string) => content);
    fake.updateThreadMetadataForUserMessage = vi.fn(async () => {});
    fake.warmWorkspaceContainerForTurn = vi.fn(async () => undefined);
    fake.sendRunnerCommand = vi.fn((command: any) => {
      sentCommands.push(command);
      return true;
    });

    const result = await ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(fake, {
      type: 'message',
      content: 'please also add tests',
      clientMessageId: 'client_followup_1',
    });

    expect(result).toEqual({ status: 'accepted' });
    expect(fake.ensurePiSessionReady).toHaveBeenCalledTimes(1);
    expect(fake.syncAgentState).toHaveBeenCalled();
    expect(fake.publishRunningUserMessageActivity).toHaveBeenCalledWith(
      'please also add tests',
    );
    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      type: 'message',
      threadId: 'thread1',
      userId: 'user1',
      clientMessageId: 'client_followup_1',
      authorDisplayName: 'Miguel',
      messageSource: 'web',
    });
    expect(sentCommands[0].content).toBe('[web message from Miguel (miguel@example.com)]: please also add tests');
  });

  it('keeps render attribution aligned with the context captured before awaits', async () => {
    const sentCommands: any[] = [];
    const fake = makeNewTurnEnqueueFake([]);
    fake.ensurePiSessionReady = vi.fn(async () => {
      fake.chatContext = {
        ...fake.chatContext,
        userId: 'other-user',
        userName: 'Other User',
        userEmail: 'other@example.com',
      };
    });
    fake.sendRunnerCommand = vi.fn((command: any) => {
      sentCommands.push(command);
      return true;
    });

    await ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(
      fake,
      { type: 'message', content: 'hello' },
      { messageSource: 'slack' },
    );

    expect(sentCommands).toHaveLength(1);
    expect(sentCommands[0]).toMatchObject({
      content: '[slack message from Miguel (miguel@example.com)]: hello',
      authorDisplayName: 'Miguel',
      messageSource: 'slack',
      userId: 'user1',
    });
  });

  it('returns acceptance from the sendMessage RPC after enqueue accepts', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let resolveEnqueue: (value: { status: 'accepted' }) => void = () => {};
    const enqueuePromise = new Promise<{ status: 'accepted' }>((resolve) => {
      resolveEnqueue = resolve;
    });
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(() => enqueuePromise);

    const handlePromise = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-1',
    });

    await Promise.resolve();
    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledTimes(1);

    resolveEnqueue({ status: 'accepted' });
    await expect(handlePromise).resolves.toEqual({ status: 'accepted' });

    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledWith(
      expect.objectContaining({ clientMessageId: 'client-msg-1' }),
      expect.objectContaining({
        sendAttemptId: 'client-msg-1',
        startedAt: expect.any(Number),
      }),
    );
    expect(fake.ctx.storage.kv.put).toHaveBeenCalled();
  });

  it('returns thrown browser message send failures to the RPC caller', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const error = new Error('connection dropped');
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(async () => {
      throw error;
    });
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();

    await expect(ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-2',
    })).resolves.toEqual({
      status: 'error',
      error: 'connection dropped',
    });

    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith({
      status: 'error',
      message: 'connection dropped',
      clear: true,
    });
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
  });

  it('returns rejected browser message sends to the RPC caller', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(async () => ({
      status: 'busy',
      error: new Error('Thread is busy with another run'),
    }));

    await expect(ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-rejected',
    })).resolves.toEqual({
      status: 'busy',
      error: new Error('Thread is busy with another run'),
    });
  });

  it('keeps explicit direct-send error sources when provider metadata exists', async () => {
    const waitUntilPromises: Promise<unknown>[] = [];
    const recordThreadError = vi.fn(async () => null);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'User One',
      userEmail: 'user@example.com',
    };
    fake.piCurrentUsageProvider = 'openai';
    fake.piSession = null;
    fake.recordedChatErrors = new Map();
    fake.ctx = {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        waitUntilPromises.push(promise);
      }),
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadError })),
      },
    };
    fake.retryChatDurableObjectRpc = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());

    ChatThreadDO.prototype['recordCurrentThreadError'].call(fake, {
      message: 'Hosted model credit limit reached',
      source: 'runner_send',
      provider: 'openai',
      status: 402,
    });
    await Promise.all(waitUntilPromises);

    expect(recordThreadError).toHaveBeenCalledWith(
      'thread1',
      expect.objectContaining({
        message: 'Hosted model credit limit reached',
        source: 'runner_send',
        provider: 'openai',
        status: 402,
        userId: 'user1',
      }),
    );
  });

  it('re-accepts duplicates of accepted messages without enqueueing again', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      storage: {
        kv: { get: vi.fn(() => ['client-msg-dup']), put: vi.fn() },
      },
    };
    fake.enqueueRunnerUserMessage = vi.fn();

    await expect(ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello again',
      clientMessageId: 'client-msg-dup',
    })).resolves.toEqual({ status: 'accepted' });

    expect(fake.enqueueRunnerUserMessage).not.toHaveBeenCalled();
  });

  it('relays an in-flight enqueue failure to a retransmitted duplicate instead of accepting it', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const error = new Error('runner exploded');
    let rejectEnqueue: (error: Error) => void = () => {};
    const enqueuePromise = new Promise((_resolve, reject) => {
      rejectEnqueue = reject;
    });
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(() => enqueuePromise);
    fake.markTurnStarted = vi.fn();
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();

    const first = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-3',
    });
    await Promise.resolve();

    const second = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-3',
    });
    await Promise.resolve();

    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledTimes(1);

    rejectEnqueue(error);
    await expect(first).resolves.toEqual({
      status: 'error',
      error: 'runner exploded',
    });
    await expect(second).resolves.toEqual({
      status: 'error',
      error: 'runner exploded',
    });

    expect(fake.ctx.storage.kv.put).not.toHaveBeenCalled();
  });

  it('accepts a retransmitted duplicate once the in-flight enqueue accepts', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let resolveEnqueue: (value: { status: 'accepted' }) => void = () => {};
    const enqueuePromise = new Promise<{ status: 'accepted' }>((resolve) => {
      resolveEnqueue = resolve;
    });
    fake.ctx = { storage: { kv: { get: vi.fn(), put: vi.fn() } } };
    fake.enqueueRunnerUserMessage = vi.fn(() => enqueuePromise);

    const first = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-4',
    });
    await Promise.resolve();
    const second = ChatThreadDO.prototype['handleClientUserMessage'].call(fake, {
      content: 'hello',
      clientMessageId: 'client-msg-4',
    });
    await Promise.resolve();

    resolveEnqueue({ status: 'accepted' });
    await expect(first).resolves.toEqual({ status: 'accepted' });
    await expect(second).resolves.toEqual({ status: 'accepted' });

    expect(fake.enqueueRunnerUserMessage).toHaveBeenCalledTimes(1);
    expect(fake.ctx.storage.kv.put).toHaveBeenCalled();
  });

  it('bounds degraded-auth grants to the recent full-auth window', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    let store: unknown;
    fake.ctx = {
      storage: {
        kv: {
          get: vi.fn(() => store),
          put: vi.fn((_key: string, value: unknown) => {
            store = value;
          }),
        },
      },
    };

    // Never authorized: no grant.
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-1'),
    ).toBe(false);

    // Fresh full auth grants degraded access.
    ChatThreadDO.prototype['recordAuthorizedChatUser'].call(fake, 'user-1');
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-1'),
    ).toBe(true);

    // Grants expire after the TTL window.
    store = { 'user-1': Date.now() - 25 * 60 * 60 * 1000 };
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-1'),
    ).toBe(false);

    // Legacy bare-id list format grants nothing.
    store = ['user-1'];
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-1'),
    ).toBe(false);

    // Recording prunes expired grants from the stored map.
    store = { 'user-stale': Date.now() - 25 * 60 * 60 * 1000 };
    ChatThreadDO.prototype['recordAuthorizedChatUser'].call(fake, 'user-2');
    expect(store).not.toHaveProperty('user-stale');
    expect(
      ChatThreadDO.prototype['isPreviouslyAuthorizedChatUser'].call(fake, 'user-2'),
    ).toBe(true);
  });

  it('records enqueue stage exceptions before rethrowing', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const error = new Error('runner unavailable');
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
      userName: 'User One',
      userEmail: 'user@example.com',
    };
    fake.chatIsStreaming = false;
    fake.env = {
      APP_KV: { get: vi.fn().mockResolvedValue(null) },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.ensurePiSessionReady = vi.fn(async () => {
      throw error;
    });

    await expect(
      ChatThreadDO.prototype['enqueueRunnerUserMessage'].call(
        fake,
        {
          type: 'message',
          content: 'hello',
          clientMessageId: 'client-msg-3',
        },
        { sendAttemptId: 'client-msg-3', startedAt: Date.now() },
      ),
    ).rejects.toThrow('runner unavailable');

  });

  it('keeps hosted OpenAI models on Responses while routing through OpenRouter AI Gateway', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: true,
      vllmPriority: '0',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn(() => ({
        id: 'gpt-5.5',
        provider: 'openai',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'openai/gpt-5.6-terra:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-responses',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
    });
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it('runs sponsored capability agents on hosted GPT-5.6 Luna without BYOK or credit charging', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openai',
      apiKey: 'user-key',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => true);

    const model = await ChatThreadDO.prototype['resolvePiCapabilityModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      'gpt-5.6-luna',
      vi.fn(() => ({
        id: 'gpt-5.6-luna',
        provider: 'openai',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model).toMatchObject({
      billingSource: 'hosted',
      creditChargeable: false,
      usageProvider: 'openrouter',
    });
    expect(model.model).toMatchObject({
      id: 'openai/gpt-5.6-luna:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-responses',
    });
    expect(fake.resolveCurrentByokCredentials).not.toHaveBeenCalled();
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses the Responses API shape for Grok while routing through OpenRouter AI Gateway', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: true,
      vllmPriority: '0',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'grok-4.5' },
      vi.fn(() => ({
        id: 'x-ai/grok-4.5',
        provider: 'openrouter',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'x-ai/grok-4.5:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-responses',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
    });
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it('uses local Pi model metadata for Grok 4.5 when the upstream Pi catalog is missing it', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: true,
      vllmPriority: '0',
    }));

    const getModel = vi.fn(() => undefined);
    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'grok-4.5' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openrouter', 'x-ai/grok-4.5');
    expect(model.model).toMatchObject({
      id: 'x-ai/grok-4.5:nitro',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-responses',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
      cost: {
        input: 2,
        output: 6,
        cacheRead: 0.5,
        cacheWrite: 0,
      },
      contextWindow: 500000,
    });
    expect(model.apiKey).toBe('cf-token');
    expect(model.provider).toBe('openrouter');
    expect(model.modelId).toBe('x-ai/grok-4.5');
    expect(model.billingSource).toBe('hosted');
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.piCurrentUsageProvider).toBe('openrouter');
  });

  it('routes hosted deepseek-v4-auto through the AI Gateway dynamic fallback route', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: false,
      vllmPriority: '100',
    }));

    const getModel = vi.fn(() => ({
      id: 'deepseek/deepseek-v4-pro',
      provider: 'openrouter',
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
      reasoning: true,
      compat: { thinkingFormat: 'openrouter' },
      contextWindow: 384_000,
      maxTokens: 384_000,
    }));
    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'deepseek-v4-auto' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openrouter', 'deepseek/deepseek-v4-pro');
    expect(model.model).toMatchObject({
      id: 'dynamic/deepseek-v4-auto',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-completions',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/compat',
    });
    expect(model.model.headers).toMatchObject({
      'x-sticky-key': 'thread1',
      'X-Chiridion-VLLM-Priority': '100',
    });
    // Dynamic routes fan out across RTX/Azure/OpenRouter. Keep high reasoning,
    // but use a conservative working window because Pi's estimate does not
    // include every vLLM chat-template and tool-schema token.
    expect(model.model.compat).toMatchObject({
      supportsReasoningEffort: true,
      thinkingFormat: 'openai',
    });
    expect(model.model.thinkingLevelMap).toEqual({
      minimal: 'high',
      low: 'high',
      medium: 'high',
      high: 'high',
      xhigh: 'high',
    });
    expect(model.model.contextWindow).toBe(220000);
    expect(model.model.maxTokens).toBe(262144);
    expect(model.model.reasoning).toBe(true);
    expect(model.creditChargeable).toBe(false);
    expect(fake.checkHostedPiModelAccess).toHaveBeenCalledWith(
      expect.anything(),
      'deepseek-v4-auto',
    );
    expect(fake.resolveCurrentByokCredentials).not.toHaveBeenCalled();
    expect(fake.piCurrentUsageProvider).toBe('compat');
  });

  it('falls back to camelCode when hosted credits are exhausted', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async (_context: unknown, model: string) => {
      if (model !== 'deepseek-v4-auto') {
        throw new HostedModelCreditsExhaustedError('Hosted model credits are used up.');
      }
      return { creditChargeable: false, vllmPriority: '100' };
    });
    fake.fallbackThreadToFreeModel = vi.fn(async () => undefined);
    const envVars = { CHIRIDION_CODEX_MODEL: 'gpt-5.5' };

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      envVars,
      vi.fn((_provider: string, modelId: string) => ({
        id: modelId,
        provider: modelId === 'gpt-5.5' ? 'openai' : 'openrouter',
        api: modelId === 'gpt-5.5' ? 'openai-responses' : 'openai-completions',
        baseUrl: 'https://example.com',
      })),
    );

    expect(envVars).toMatchObject({
      CHIRIDION_MODEL: 'deepseek-v4-auto',
      CHIRIDION_CODEX_MODEL: 'deepseek-v4-auto',
      CHIRIDION_CLAUDE_MODEL: 'deepseek-v4-auto',
    });
    expect(fake.fallbackThreadToFreeModel).toHaveBeenCalledWith(
      expect.anything(),
      'gpt-5.5',
      'deepseek-v4-auto',
      'hosted_credits_exhausted',
    );
    expect(fake.checkHostedPiModelAccess).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      'deepseek-v4-auto',
    );
    expect(model).toMatchObject({
      billingSource: 'hosted',
      creditChargeable: false,
      model: {
        id: 'dynamic/deepseek-v4-auto',
        provider: 'cloudflare-ai-gateway',
      },
    });
  });

  it('falls back to camelCode when the paid subscription is unavailable', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async (_context: unknown, model: string) => {
      if (model !== 'deepseek-v4-auto') {
        throw new HostedModelSubscriptionUnavailableError('Paid hosted access is inactive.');
      }
      return { creditChargeable: false, vllmPriority: '100' };
    });
    fake.fallbackThreadToFreeModel = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_MODEL: 'gpt-5.5' },
      vi.fn((_provider: string, modelId: string) => ({
        id: modelId,
        provider: modelId === 'gpt-5.5' ? 'openai' : 'openrouter',
        api: modelId === 'gpt-5.5' ? 'openai-responses' : 'openai-completions',
        baseUrl: 'https://example.com',
      })),
    );

    expect(fake.fallbackThreadToFreeModel).toHaveBeenCalledWith(
      expect.anything(),
      'gpt-5.5',
      'deepseek-v4-auto',
      'hosted_subscription_unavailable',
    );
  });

  it('persists and broadcasts a camelCode credit fallback', async () => {
    const updated = {
      model: 'deepseek-v4-auto',
      updated_at: 1234,
    };
    const orgStub = {
      updateThreadModel: vi.fn(async () => updated),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    fake.syncAgentState = vi.fn();

    await ChatThreadDO.prototype['fallbackThreadToFreeModel'].call(
      fake,
      {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
      },
      'gpt-5.5',
      'deepseek-v4-auto',
    );

    expect(orgStub.updateThreadModel).toHaveBeenCalledWith(
      'thread1',
      'deepseek-v4-auto',
      'user1',
      'gpt-5.6-terra',
    );
    expect(fake.currentThreadModel).toBe('deepseek-v4-auto');
    expect(fake.currentThreadModelUpdatedAt).toBe(1234);
    expect(fake.modelFallbackNotice).toMatchObject({
      fromModel: 'gpt-5.5',
      toModel: 'deepseek-v4-auto',
      reason: 'hosted_credits_exhausted',
      createdAt: expect.any(Number),
    });
    expect(fake.syncAgentState).toHaveBeenCalledOnce();
  });

  it('does not overwrite a newer model selection during fallback', async () => {
    const orgStub = { updateThreadModel: vi.fn(async () => null) };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => orgStub),
      },
    };
    fake.currentThreadModel = 'gpt-5.5';
    fake.modelFallbackNotice = null;
    fake.syncAgentState = vi.fn();

    await ChatThreadDO.prototype['fallbackThreadToFreeModel'].call(
      fake,
      { orgId: 'org1', threadId: 'thread1', userId: 'user1' },
      'gpt-5.5',
      'deepseek-v4-auto',
    );

    expect(orgStub.updateThreadModel).toHaveBeenCalledWith(
      'thread1',
      'deepseek-v4-auto',
      'user1',
      'gpt-5.6-terra',
    );
    expect(fake.currentThreadModel).toBe('gpt-5.5');
    expect(fake.modelFallbackNotice).toBeNull();
    expect(fake.syncAgentState).not.toHaveBeenCalled();
  });

  it('routes hosted deepseek-v4-pro through the AI Gateway dynamic fallback route', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: true,
      vllmPriority: '0',
    }));

    const getModel = vi.fn(() => ({
      id: 'deepseek/deepseek-v4-pro',
      provider: 'openrouter',
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
    }));
    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'deepseek-v4-pro' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openrouter', 'deepseek/deepseek-v4-pro');
    expect(model.model).toMatchObject({
      id: 'dynamic/deepseek-v4-pro-fallback',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-completions',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/compat',
    });
    expect(model.model.headers).toMatchObject({
      'X-Chiridion-VLLM-Priority': '0',
    });
    expect(model.model.compat).toMatchObject({ supportsReasoningEffort: true });
    expect(model.model.thinkingLevelMap).toEqual({
      minimal: 'xhigh',
      low: 'xhigh',
      medium: 'xhigh',
      high: 'xhigh',
      xhigh: 'xhigh',
    });
    expect(fake.piCurrentUsageProvider).toBe('compat');
  });

  it('keeps the native OpenRouter model id for deepseek-v4-pro under OpenRouter BYOK', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'deepseek-v4-pro' },
      vi.fn(() => ({
        id: 'deepseek/deepseek-v4-pro',
        provider: 'openrouter',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'deepseek/deepseek-v4-pro',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(model.apiKey).toBe('sk-or-test');
    expect(model.billingSource).toBe('byok');
    expect(model.model.thinkingLevelMap).not.toEqual({
      minimal: 'xhigh',
      low: 'xhigh',
      medium: 'xhigh',
      high: 'xhigh',
      xhigh: 'xhigh',
    });
  });

  it('does not route deepseek-v4-auto through OpenRouter BYOK', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: true,
      vllmPriority: '0',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'deepseek-v4-auto' },
      vi.fn(() => ({
        id: 'deepseek/deepseek-v4-pro',
        provider: 'openrouter',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'dynamic/deepseek-v4-auto',
      provider: 'cloudflare-ai-gateway',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/compat',
    });
    expect(model.apiKey).toBe('cf-token');
    expect(model.billingSource).toBe('hosted');
    expect(model.usageProvider).toBe('compat');
    expect(fake.checkHostedPiModelAccess).toHaveBeenCalledOnce();
  });

  it('routes hosted deepseek-v4-flash through the AI Gateway dynamic fallback route', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'acct_1',
      CF_GATEWAY_NAME: 'gateway_1',
      AI_GATEWAY_AUTH_TOKEN: 'cf-token',
    };
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => null);
    fake.checkHostedPiModelAccess = vi.fn(async () => ({
      creditChargeable: true,
      vllmPriority: '0',
    }));

    const getModel = vi.fn(() => ({
      id: 'deepseek/deepseek-v4-flash',
      provider: 'openrouter',
      api: 'openai-completions',
      baseUrl: 'https://openrouter.ai/api/v1',
    }));
    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'deepseek-v4-flash' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openrouter', 'deepseek/deepseek-v4-flash');
    expect(model.model).toMatchObject({
      id: 'dynamic/deepseek-v4-flash-fallback',
      provider: 'cloudflare-ai-gateway',
      api: 'openai-completions',
      baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/compat',
    });
    expect(model.model.compat).toMatchObject({ supportsReasoningEffort: true });
    expect(model.model.thinkingLevelMap).toEqual({
      minimal: 'xhigh',
      low: 'xhigh',
      medium: 'xhigh',
      high: 'xhigh',
      xhigh: 'xhigh',
    });
    expect(model.model.contextWindow).toBe(220000);
    expect(model.model.maxTokens).toBe(262144);
    expect(fake.piCurrentUsageProvider).toBe('compat');
  });

  it('keeps the native OpenRouter model id for deepseek-v4-flash under OpenRouter BYOK', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'deepseek-v4-flash' },
      vi.fn(() => ({
        id: 'deepseek/deepseek-v4-flash',
        provider: 'openrouter',
        api: 'openai-completions',
        baseUrl: 'https://openrouter.ai/api/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'deepseek/deepseek-v4-flash',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(model.apiKey).toBe('sk-or-test');
    expect(model.billingSource).toBe('byok');
    // The forced-xhigh override is scoped to the hosted gateway model only, so
    // BYOK OpenRouter keeps the upstream catalog reasoning map untouched.
    expect(model.model.thinkingLevelMap).not.toEqual({
      minimal: 'xhigh',
      low: 'xhigh',
      medium: 'xhigh',
      high: 'xhigh',
      xhigh: 'xhigh',
    });
  });

  it.each(['gemini-3.5-flash', 'gemini-3.1-pro-preview'])(
    'uses local Pi model metadata for %s when the upstream Pi catalog is missing Gemini 3.5 Flash',
    async (requestedModel) => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.env = {
        CF_ACCOUNT_ID: 'acct_1',
        CF_GATEWAY_NAME: 'gateway_1',
        AI_GATEWAY_AUTH_TOKEN: 'cf-token',
      };
      fake.chatContext = {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      };
      fake.resolveCurrentByokCredentials = vi.fn(async () => null);
      fake.checkHostedPiModelAccess = vi.fn(async () => ({
        creditChargeable: true,
        vllmPriority: '0',
      }));

      const getModel = vi.fn(() => undefined);
      const model = await ChatThreadDO.prototype['resolvePiModel'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        { CHIRIDION_CODEX_MODEL: requestedModel },
        getModel,
      );

      expect(getModel).toHaveBeenCalledWith(
        'openrouter',
        'google/gemini-3.5-flash',
      );
      expect(model.model).toMatchObject({
        id: 'google/gemini-3.5-flash',
        provider: 'cloudflare-ai-gateway',
        api: 'openai-completions',
        baseUrl: 'https://gateway.ai.cloudflare.com/v1/acct_1/gateway_1/openrouter',
        cost: {
          input: 1.5,
          output: 9,
          cacheRead: 0.15,
          cacheWrite: 0.08333333333333334,
        },
        contextWindow: 1048576,
        maxTokens: 65536,
      });
      expect(model.apiKey).toBe('cf-token');
      expect(model.provider).toBe('openrouter');
      expect(model.modelId).toBe('google/gemini-3.5-flash');
      expect(model.billingSource).toBe('hosted');
      expect(model.usageProvider).toBe('openrouter');
      expect(fake.piCurrentUsageProvider).toBe('openrouter');
    },
  );

  it('uses OpenRouter BYOK for Pi models supported through OpenRouter', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      vi.fn(() => ({
        id: 'claude-sonnet-5',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'anthropic/claude-sonnet-5:nitro',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
    });
    expect(model.apiKey).toBe('sk-or-test');
    expect(model.billingSource).toBe('byok');
    expect(model.creditChargeable).toBe(false);
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses OpenRouter BYOK with Fable 5 when requested', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'fable-5' },
      vi.fn(() => ({
        id: 'claude-fable-5',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'anthropic/claude-fable-5:nitro',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
    });
    expect(model.apiKey).toBe('sk-or-test');
    expect(model.billingSource).toBe('byok');
    expect(model.creditChargeable).toBe(false);
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses self-host OpenRouter env credentials before org BYOK or hosted gateway', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CF_ACCOUNT_ID: 'selfhost',
      SELFHOST_AI_PROVIDER: 'openrouter',
      SELFHOST_AI_API_KEY: 'sk-or-selfhost',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'anthropic',
      apiKey: 'sk-ant-org',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for self-host env provider');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      vi.fn(() => ({
        id: 'claude-sonnet-5',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'anthropic/claude-sonnet-5:nitro',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://openrouter.ai/api',
    });
    expect(model.apiKey).toBe('sk-or-selfhost');
    expect(model.billingSource).toBe('byok');
    expect(model.creditChargeable).toBe(false);
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.resolveCurrentByokCredentials).not.toHaveBeenCalled();
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses Anthropic BYOK directly for Claude Pi models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'anthropic',
      apiKey: 'sk-ant-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      vi.fn(() => ({
        id: 'claude-sonnet-5',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'claude-sonnet-5',
      provider: 'anthropic',
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
    });
    expect(model.apiKey).toBe('sk-ant-test');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('anthropic');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('fails loudly when Pi model metadata is missing', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;

    await expect(
      ChatThreadDO.prototype['resolvePiModel'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        { CHIRIDION_CLAUDE_MODEL: 'unknown/provider-model' },
        vi.fn(),
      ),
    ).rejects.toThrow('Unsupported Pi model unknown/provider-model');
  });

  it('loads the model from the thread record when initializing Pi', async () => {
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        model: 'sonnet',
        workspace_id: 'workspace1',
      })),
      getLlmProviderConfig: vi.fn(async () => null),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => orgStub),
      },
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
    };
    fake.runnerTransitionChain = Promise.resolve();
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['ensurePiSessionReady'].call(fake);

    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread1' }),
      expect.objectContaining({
        CHIRIDION_MODEL: 'sonnet',
        CHIRIDION_CLAUDE_MODEL: 'sonnet',
        CHIRIDION_CODEX_MODEL: 'sonnet',
      }),
    );
  });

  it('preserves a stored custom thread model when initializing Pi', async () => {
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        model: 'custom',
        workspace_id: 'workspace1',
      })),
      getLlmProviderConfig: vi.fn(async () => ({
        provider: 'custom',
        config: {
          api: 'anthropic-messages',
          custom_model_id: 'claude-custom',
        },
      })),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => orgStub),
      },
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
    };
    fake.runnerTransitionChain = Promise.resolve();
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['ensurePiSessionReady'].call(fake);

    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread1' }),
      expect.objectContaining({
        CHIRIDION_MODEL: 'custom',
        CHIRIDION_CLAUDE_MODEL: 'custom',
        CHIRIDION_CODEX_MODEL: 'custom',
      }),
    );
  });

  it('preserves an existing thread model when org BYOK provider is incompatible', async () => {
    const orgStub = {
      getThread: vi.fn(async () => ({
        id: 'thread1',
        model: 'sonnet',
        workspace_id: 'workspace1',
      })),
      getLlmProviderConfig: vi.fn(async () => ({ provider: 'openai' })),
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
      userId: 'user1',
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => orgStub),
      },
    };
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
    };
    fake.runnerTransitionChain = Promise.resolve();
    fake.lastRunnerSeq = 0;
    fake.trace = vi.fn();
    fake.ensurePiSession = vi.fn(async () => undefined);

    await ChatThreadDO.prototype['ensurePiSessionReady'].call(fake);

    expect(fake.ensurePiSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: 'thread1' }),
      expect.objectContaining({
        CHIRIDION_MODEL: 'sonnet',
        CHIRIDION_CLAUDE_MODEL: 'sonnet',
        CHIRIDION_CODEX_MODEL: 'sonnet',
      }),
    );
  });

  it('uses OpenAI BYOK directly for OpenAI Pi models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openai',
      apiKey: 'sk-openai-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn(() => ({
        id: 'gpt-5.5',
        provider: 'openai',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'gpt-5.5',
      provider: 'openai',
      api: 'openai-responses',
      baseUrl: 'https://api.openai.com/v1',
    });
    expect(model.apiKey).toBe('sk-openai-test');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('openai');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('routes OpenAI subscription inference through the ChatGPT Codex backend', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'none',
      openAiSubscription: {
        accessToken: 'chatgpt-access-token',
        accountId: 'chatgpt-account-1',
      },
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for subscription auth');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn(() => ({
        id: 'gpt-5.5',
        provider: 'openai',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://chatgpt.com/backend-api/codex',
    });
    expect(model.apiKey).toBe('chatgpt-access-token');
    expect(model.billingSource).toBe('byok');
    expect(fake.resolveCurrentByokCredentials).toHaveBeenCalledWith(
      expect.anything(),
      { includeOpenAiSubscription: true },
    );
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('does not refresh an unrelated OpenAI subscription for non-OpenAI models', async () => {
    const getFreshOpenAiSubscription = vi.fn(async () => {
      throw new Error('expired OpenAI subscription should not be refreshed');
    });
    const env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => ({ getFreshOpenAiSubscription })),
      },
    } as any;

    const credentials = await resolveCurrentByokCredentials(
      env,
      vi.fn(async () => null),
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } as any,
      { includeOpenAiSubscription: false },
    );

    expect(credentials).toBeNull();
    expect(getFreshOpenAiSubscription).not.toHaveBeenCalled();
    expect(env.ORG.get).not.toHaveBeenCalled();
  });

  it('routes OpenAI subscription inference through the configured authenticated proxy', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      OPENAI_CODEX_PROXY_BASE_URL: 'https://codex-egress.example.com/backend-api/codex',
      OPENAI_CODEX_PROXY_TOKEN: 'proxy-token',
    };
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'none',
      openAiSubscription: {
        accessToken: 'chatgpt-access-token',
        accountId: 'chatgpt-account-1',
      },
    }));
    fake.checkHostedPiModelAccess = vi.fn();

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn(() => ({
        id: 'gpt-5.5',
        provider: 'openai',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      provider: 'openai-codex',
      api: 'openai-codex-responses',
      baseUrl: 'https://codex-egress.example.com/backend-api/codex',
      headers: { 'X-CamelAI-Proxy-Token': 'proxy-token' },
    });
    expect(model.billingSource).toBe('byok');
    expect(model.creditChargeable).toBe(false);
  });

  it('prefixes hosted OpenAI aliases when routing through OpenRouter BYOK', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'openrouter',
      apiKey: 'sk-or-test',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.5' },
      vi.fn((provider, modelId) => ({
        id: modelId,
        provider,
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'openai/gpt-5.6-terra:nitro',
      provider: 'openai',
      api: 'openai-responses',
      baseUrl: 'https://openrouter.ai/api/v1',
    });
    expect(model.apiKey).toBe('sk-or-test');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('openrouter');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('suppresses OpenAI SDK bearer auth for custom OpenAI-compatible x-api-key providers', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example/v1',
      authType: 'x-api-key',
      api: 'openai-completions',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.6-terra' },
      vi.fn(() => ({
        id: 'gpt-5.6-terra',
        provider: 'openai',
        api: 'openai-responses',
        baseUrl: 'https://api.openai.com/v1',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'gpt-5.6-terra',
      provider: 'custom',
      api: 'openai-completions',
      baseUrl: 'https://custom.example/v1',
    });
    expect((model.model as any).headers).toEqual({
      Authorization: null,
      'x-api-key': 'custom-key',
    });
    expect(model.apiKey).toBe('custom-key');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('custom');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('suppresses Anthropic SDK x-api-key auth for custom Anthropic-compatible bearer providers', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example',
      authType: 'bearer',
      api: 'anthropic-messages',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      vi.fn(() => ({
        id: 'claude-sonnet-5',
        provider: 'anthropic',
        api: 'anthropic-messages',
        baseUrl: 'https://api.anthropic.com',
      })),
    );

    expect(model.model).toMatchObject({
      id: 'claude-sonnet-5',
      provider: 'custom',
      api: 'anthropic-messages',
      baseUrl: 'https://custom.example',
    });
    expect((model.model as any).headers).toEqual({
      'x-api-key': null,
      Authorization: 'Bearer custom-key',
    });
    expect(model.apiKey).toBe('custom-key');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('custom');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses an OpenAI-compatible default when custom OpenAI API mode receives a Claude thread model', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example/v1',
      authType: 'bearer',
      api: 'openai-responses',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
      baseUrl: provider === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://api.anthropic.com',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-5.6-terra');
    expect(model.model).toMatchObject({
      id: 'gpt-5.6-terra',
      provider: 'custom',
      api: 'openai-responses',
      baseUrl: 'https://custom.example/v1',
    });
    expect(model.usageProvider).toBe('custom');
  });

  it('sends the configured custom model id for custom provider model selections', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example/v1',
      authType: 'bearer',
      api: 'openai-responses',
      modelId: 'pi-custom-model',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
      baseUrl: provider === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://api.anthropic.com',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'custom' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-5.6-terra');
    expect(model.model).toMatchObject({
      id: 'pi-custom-model',
      provider: 'custom',
      api: 'openai-responses',
      baseUrl: 'https://custom.example/v1',
    });
    expect(model.usageProvider).toBe('custom');
  });

  it('uses an Anthropic-compatible default when custom Anthropic API mode receives an OpenAI thread model', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'custom',
      apiKey: 'custom-key',
      baseUrl: 'https://custom.example',
      authType: 'x-api-key',
      api: 'anthropic-messages',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'anthropic' ? 'anthropic-messages' : 'openai-responses',
      baseUrl: provider === 'anthropic'
        ? 'https://api.anthropic.com'
        : 'https://api.openai.com/v1',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.4' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5');
    expect(model.model).toMatchObject({
      id: 'claude-sonnet-5',
      provider: 'custom',
      api: 'anthropic-messages',
      baseUrl: 'https://custom.example',
    });
    expect(model.usageProvider).toBe('custom');
  });

  it('uses Bedrock BYOK through Mantle for Claude Pi models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'us-west-2',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: 'anthropic-messages',
      baseUrl: 'https://api.anthropic.com',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'sonnet' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-5');
    expect(model.model).toMatchObject({
      id: 'anthropic.claude-sonnet-5',
      provider: 'custom',
      api: 'anthropic-messages',
      baseUrl: 'https://bedrock-mantle.us-west-2.api.aws/anthropic',
    });
    expect(model.apiKey).toBe('bedrock-token');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('bedrock');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses Bedrock Mantle Responses API for supported OpenAI Pi models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'us-east-2',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn((provider: string, id: string) => ({
      id,
      provider,
      api: provider === 'openai' ? 'openai-responses' : 'anthropic-messages',
      baseUrl: provider === 'openai'
        ? 'https://api.openai.com/v1'
        : 'https://api.anthropic.com',
    }));

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'pi', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.6-terra' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('openai', 'gpt-5.6-terra');
    expect(model.model).toMatchObject({
      id: 'openai.gpt-5.6-terra',
      provider: 'custom',
      api: 'openai-responses',
      baseUrl: 'https://bedrock-mantle.us-east-2.api.aws/openai/v1',
    });
    expect(model.apiKey).toBe('bedrock-token');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('bedrock');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('rejects Bedrock OpenAI models in unsupported regions before falling back to hosted', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'eu-west-1',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });

    await expect(ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'pi', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CODEX_MODEL: 'gpt-5.6-sol' },
      vi.fn((provider: string, id: string) => ({ id, provider, api: 'openai-responses' })),
    )).rejects.toThrow('OpenAI gpt-5.6-sol on Amazon Bedrock is not available in eu-west-1');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses Mantle for BYOK Opus 4.8 when Pi catalog lags', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'us-west-2',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn(() => undefined);

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'opus-4.8' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('anthropic', 'claude-opus-4-8');
    expect(model.model).toMatchObject({
      id: 'anthropic.claude-opus-4-8',
      provider: 'custom',
      api: 'anthropic-messages',
      baseUrl: 'https://bedrock-mantle.us-west-2.api.aws/anthropic',
      name: 'Claude Opus 4.8',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(model.apiKey).toBe('bedrock-token');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('bedrock');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('uses Mantle Fable 5 for BYOK Fable requests when Pi catalog lags', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {};
    fake.resolveCurrentByokCredentials = vi.fn(async () => ({
      provider: 'bedrock',
      apiKey: 'bedrock-token',
      awsRegion: 'us-west-2',
    }));
    fake.checkHostedPiModelAccess = vi.fn(async () => {
      throw new Error('hosted billing should not be checked for BYOK');
    });
    const getModel = vi.fn(() => undefined);

    const model = await ChatThreadDO.prototype['resolvePiModel'].call(
      fake,
      { provider: 'claude', orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { CHIRIDION_CLAUDE_MODEL: 'fable-5' },
      getModel,
    );

    expect(getModel).toHaveBeenCalledWith('anthropic', 'claude-fable-5');
    expect(model.model).toMatchObject({
      id: 'anthropic.claude-fable-5',
      provider: 'custom',
      api: 'anthropic-messages',
      baseUrl: 'https://bedrock-mantle.us-west-2.api.aws/anthropic',
      name: 'Claude Fable 5',
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    });
    expect(model.apiKey).toBe('bedrock-token');
    expect(model.billingSource).toBe('byok');
    expect(model.usageProvider).toBe('bedrock');
    expect(fake.checkHostedPiModelAccess).not.toHaveBeenCalled();
  });

  it('streams Bedrock Mantle models through the standard Pi stream function', () => {
    const streamSimple = vi.fn(() => ({ [Symbol.asyncIterator]: vi.fn() }));
    const model = { api: 'anthropic-messages', maxTokens: 1000 };

    ChatThreadDO.prototype['streamPiModel'].call(
      Object.create(ChatThreadDO.prototype),
      model,
      { systemPrompt: '', messages: [] },
      { apiKey: 'bedrock-token' },
      streamSimple,
    );

    expect(streamSimple).toHaveBeenCalledWith(
      model,
      { systemPrompt: '', messages: [] },
      expect.objectContaining({
        apiKey: 'bedrock-token',
      }),
    );
  });

  it('forces proxied Codex subscription streams onto SSE', () => {
    const streamSimple = vi.fn(() => ({ [Symbol.asyncIterator]: vi.fn() }));
    const model = { api: 'openai-codex-responses', maxTokens: 1000 };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      OPENAI_CODEX_PROXY_BASE_URL: 'https://codex-egress.example.com/backend-api/codex',
    };

    ChatThreadDO.prototype['streamPiModel'].call(
      fake,
      model,
      { systemPrompt: '', messages: [] },
      { apiKey: 'subscription-token', transport: 'auto' },
      streamSimple,
    );

    expect(streamSimple).toHaveBeenCalledWith(
      model,
      { systemPrompt: '', messages: [] },
      expect.objectContaining({
        apiKey: 'subscription-token',
        transport: 'sse',
      }),
    );
  });

  it('reserves ten percent of a 1M context window for compaction headroom', () => {
    const model = { contextWindow: 1_000_000, maxTokens: 128_000 } as any;
    const reserveTokens = piCompactionReserveTokens(model);

    expect(reserveTokens).toBe(100_000);
    expect(piModelContextWindow(model) - reserveTokens).toBe(900_000);
  });

  it('preflights Pi context compaction once the usable context is exhausted', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const messages = [
      { role: 'user', content: 'old context', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: `recent context ${syntheticProse(120_000)}` }], timestamp: 2 },
    ];
    fake.loadPiCoreCompaction = vi.fn(() => null);
    fake.persistPiCoreCompaction = vi.fn();
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'compact summary' }],
    }));

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      { contextWindow: 32_000 },
      'bedrock-token',
      completeSimple,
    );

    expect(completeSimple).toHaveBeenCalled();
    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith('compact summary', 1);
    expect(compacted).toEqual([
      expect.objectContaining({ role: 'user', content: '[Context Summary]\n\ncompact summary' }),
      messages[1],
    ]);
  });

  it('preflights compaction for inline base64 tool output before it exhausts the provider context', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    // Genuine base64 entropy, not a repeated character. `'A'.repeat(n)` merges
    // into a handful of BPE tokens, so it understates a real screenshot payload
    // by roughly 6x and only looked large to the character heuristic.
    const screenshot = `data:image/jpeg;base64,${syntheticBase64(1_100_000)}`;
    const messages = [
      { role: 'toolResult', toolCallId: 'shot', toolName: 'take_screenshot', content: [{ type: 'text', text: screenshot }], timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: 'I will fix the game.' }], timestamp: 2 },
    ];
    fake.loadPiCoreCompaction = vi.fn(() => null);
    fake.persistPiCoreCompaction = vi.fn();
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'compact summary' }],
    }));

    expect(estimatePiTextTokens(screenshot)).toBeGreaterThan(180_000);

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      { contextWindow: 220_000, maxTokens: 32_000 },
      'gateway-token',
      completeSimple,
    );

    expect(completeSimple).toHaveBeenCalled();
    expect(compacted).toEqual([
      expect.objectContaining({ content: '[Context Summary]\n\ncompact summary' }),
      messages[1],
    ]);
  });

  it('persists repeated Pi compaction cutoffs in original SQL row index space', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const existing = {
      summary: 'first summary',
      firstKeptIndex: 2,
      updatedAt: 100,
    };
    const messages = [
      createPiSummaryMessage(existing.summary, 100),
      { role: 'user', content: 'raw row 2', timestamp: 200 },
      { role: 'assistant', content: [{ type: 'text', text: `raw row 3 ${syntheticProse(120_000)}` }], timestamp: 300 },
      { role: 'user', content: 'raw row 4', timestamp: 400 },
    ];
    fake.loadPiCoreCompaction = vi.fn(() => existing);
    fake.persistPiCoreCompaction = vi.fn();
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'second summary' }],
    }));

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      { contextWindow: 32_000 },
      'bedrock-token',
      completeSimple,
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith('second summary', 3);
    expect(compacted).toEqual([
      expect.objectContaining({
        role: 'user',
        content: '[Context Summary]\n\nsecond summary',
      }),
      messages[2],
      messages[3],
    ]);
  });

  it('persists a bounded fallback compaction when summary generation fails', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const messages = [
      { role: 'user', content: 'old context', timestamp: 1 },
      { role: 'assistant', content: [{ type: 'text', text: `recent context ${syntheticProse(120_000)}` }], timestamp: 2 },
    ];
    fake.loadPiCoreCompaction = vi.fn(() => null);
    fake.persistPiCoreCompaction = vi.fn();
    const completeSimple = vi.fn(async () => {
      throw new Error('Compaction summary was empty');
    });

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      { contextWindow: 32_000 },
      'bedrock-token',
      completeSimple,
    );

    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith(
      expect.stringContaining('Automatic fallback summary'),
      1,
    );
    expect(compacted).toHaveLength(2);
    expect((compacted[0] as { content: string }).content).toContain('[Context Summary]');
  });

  it('schedules post-turn Pi compaction from assistant usage like the high-level agent', async () => {
    const compaction = Promise.resolve();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { waitUntil: vi.fn() };
    fake.piSession = {
      state: {
        model: { contextWindow: 1_000_000 },
      },
    };
    fake.compactPiContextAfterTurn = vi.fn(() => compaction);

    const assistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      timestamp: 1,
      usage: {
        input: 910_000,
        output: 1_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 911_000,
      },
    };

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(
      fake,
      [{ role: 'user', content: 'hi', timestamp: 0 }, assistantMessage],
    );

    expect(fake.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(assistantMessage);
  });

  it('persists post-turn Pi compaction into live session state and resets baseline', async () => {
    const beforeMessages = [
      { role: 'user', content: 'old', timestamp: 0 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'done' }],
        timestamp: 1,
        usage: { totalTokens: 911_000 },
      },
    ];
    const compactedMessages = [
      { role: 'user', content: '[summary] old', timestamp: 2 },
      beforeMessages[1],
    ];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piModelResolver = vi.fn(async () => ({
      model: { contextWindow: 1_000_000, id: 'anthropic.claude-sonnet-5' },
      apiKey: 'bedrock-token',
      provider: 'bedrock',
      usageProvider: 'bedrock',
      modelId: 'claude-sonnet-5',
    }));
    fake.piSession = {
      state: {
        isStreaming: false,
        model: { contextWindow: 1_000_000 },
        messages: beforeMessages,
      },
      waitForIdle: vi.fn(async () => {}),
    };
    fake.loadPiCompleteSimple = vi.fn(async () => vi.fn());
    fake.compactPiContext = vi.fn(async () => compactedMessages);
    fake.replacePiCoreMessages = vi.fn();
    fake.clearPiCoreCompaction = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.piMainBaselineIndex = beforeMessages.length;

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(
      fake,
      beforeMessages[1],
    );

    expect(fake.piSession.state.messages).toBe(compactedMessages);
    // Compaction preserves the visible render history and re-pins the mark.
    expect(fake.replacePiCoreMessages).toHaveBeenCalledWith(compactedMessages, {
      uiRender: 'preserve',
    });
    expect(fake.clearPiCoreCompaction).toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(compactedMessages.length);
  });

  // Regression cluster for the context-exhaustion wedge. A production camelCode
  // thread stopped answering for five hours across eleven unanswered user
  // messages: every turn came back `stopReason: "length"` with `input: 216149`
  // of a 220000 window and a single reasoning token of output. Nothing was
  // logged (a length stop is not a provider error) and nothing compacted, so
  // the thread could never recover. These numbers are taken from that thread.
  describe('context exhaustion wedge', () => {
    const WEDGED_CONTEXT_WINDOW = 220_000;
    const wedgedAssistantMessage = () => ({
      role: 'assistant',
      content: [{ type: 'thinking', thinking: 'The' }],
      api: 'openai-completions',
      provider: 'cloudflare-ai-gateway',
      model: 'dynamic/deepseek-v4-auto',
      usage: {
        input: 216_149,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 216_150,
      },
      stopReason: 'length',
      timestamp: 1_784_926_541_156,
    }) as any;

    it('treats a length stop with no usable output as context exhaustion', () => {
      const message = wedgedAssistantMessage();

      // Pi's own isContextOverflow misses this by a hair on both axes: it wants
      // output === 0 (this emitted one reasoning token) and input >= 99% of the
      // window (216149 is 98.25%, short by 1651 tokens).
      expect(isPiLengthStopContextExhaustion(message, WEDGED_CONTEXT_WINDOW)).toBe(true);
      expect(isPiContextOverflowMessage(message, WEDGED_CONTEXT_WINDOW)).toBe(true);
      expect(
        shouldCompactPiAfterAssistantUsage(message, {
          contextWindow: WEDGED_CONTEXT_WINDOW,
          maxTokens: 262_144,
        } as any),
      ).toBe(true);
    });

    it('does not mistake an ordinary length stop for exhaustion', () => {
      // A real max-output truncation: plenty of room on the input side.
      expect(
        isPiLengthStopContextExhaustion(
          {
            role: 'assistant',
            content: [{ type: 'text', text: 'a long answer' }],
            usage: { input: 5_000, output: 900, cacheRead: 0 },
            stopReason: 'length',
          } as any,
          WEDGED_CONTEXT_WINDOW,
        ),
      ).toBe(false);

      // Same token counts, but the turn actually completed.
      expect(
        isPiLengthStopContextExhaustion(
          { ...wedgedAssistantMessage(), stopReason: 'stop' },
          WEDGED_CONTEXT_WINDOW,
        ),
      ).toBe(false);
    });

    it('counts raw base64 blobs densely, not as prose', () => {
      // Agents moving a generated file around embed bare base64 in tool args
      // and results, with no data: URL header to key off.
      const blob = 'UEsDBBQAAAAIAAig+FxGx01IlQAAAM0AAAAQAAAAZG9jUHJvcHMv'.repeat(20);
      // Ordinary prose of the same length still uses the 4-chars/token rule;
      // only unbroken high-entropy runs are treated as dense.
      const prose = 'the quick brown fox jumps over the lazy dog '.repeat(
        Math.ceil(blob.length / 44),
      ).slice(0, blob.length);

      expect(estimatePiTextTokens(prose)).toBeCloseTo(blob.length / 4, -1);
      expect(estimatePiTextTokens(blob)).toBeGreaterThan(estimatePiTextTokens(prose) * 2);
    });

    it('floors the character estimate with the provider-reported input count', () => {
      // The estimate cannot see the system prompt or tool schemas, so on its own
      // it undercounts the real request. The last assistant turn reports what the
      // provider actually charged; that is the floor.
      const messages = [
        { role: 'user', content: 'earlier work', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input: 200_000, output: 10, cacheRead: 0 },
          stopReason: 'stop',
          timestamp: 1,
        },
        { role: 'user', content: 'follow up', timestamp: 2 },
      ] as any;

      expect(estimatePiCompactionTokens(messages)).toBeLessThan(200_000);
      expect(observedPiContextTokens(messages)).toBeGreaterThanOrEqual(200_000);
      expect(effectivePiContextTokens(messages)).toBeGreaterThanOrEqual(200_000);
    });

    it('counts context with a real tokenizer inside the Worker runtime', async () => {
      // Also proves the o200k BPE ranks load under workerd, not just in the
      // bundler: the import is dynamic, so a runtime failure would otherwise
      // only show up in production as a silent fall back to the heuristic.
      const messages = [
        { role: 'user', content: 'the quick brown fox jumps over the lazy dog', timestamp: 0 },
      ] as any;

      const precise = await countPiContextTokensPrecise(messages);

      expect(precise).not.toBeNull();
      // Nine short English words tokenize to roughly one token each.
      expect(precise).toBeGreaterThan(5);
      expect(precise).toBeLessThan(20);
    });

    it('identifies the prefix the provider has already priced', () => {
      const messages = [
        { role: 'user', content: 'first', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'older' }],
          usage: { input: 100, output: 5, cacheRead: 0 },
          timestamp: 1,
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'newer' }],
          usage: { input: 900, output: 5, cacheRead: 100 },
          timestamp: 2,
        },
        { role: 'user', content: 'latest', timestamp: 3 },
      ] as any;

      // Most recent priced turn wins, and cacheRead counts as input.
      expect(findLastPricedContextSplit(messages)).toEqual({ index: 2, reported: 1_000 });
      expect(findLastPricedContextSplit([{ role: 'user', content: 'hi' }] as any)).toBeNull();
    });

    it('measures only the unpriced tail rather than re-tokenizing the history', async () => {
      // The CPU guard. transformContext runs once per provider request — 25+
      // times in one agent-loop turn — and a full 560KB context takes ~117ms to
      // tokenize. Only the messages after the last priced turn are measured, so
      // the cost tracks new content instead of total history size.
      const hugePricedPrefix = {
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(400_000) }],
        usage: { input: 150_000, output: 10, cacheRead: 0 },
        stopReason: 'stop',
        timestamp: 1,
      };
      const messages = [
        { role: 'user', content: 'y'.repeat(400_000), timestamp: 0 },
        hugePricedPrefix,
        { role: 'user', content: 'one short follow-up', timestamp: 2 },
      ] as any;

      const measured = await measurePiContextTokens(messages, 220_000);

      // 150k reported + the assistant's own output + a short user message.
      // A full recount of ~800KB of history would land far above this.
      expect(measured).toBeGreaterThan(150_000);
      expect(measured).toBeLessThan(275_000);
    });

    it('only pays for tokenization when the cheap estimate is near the limit', () => {
      expect(shouldMeasurePiContextPrecisely(10_000, 220_000)).toBe(false);
      expect(shouldMeasurePiContextPrecisely(150_000, 220_000)).toBe(true);
      expect(shouldMeasurePiContextPrecisely(10_000, 0)).toBe(false);
    });

    it('never returns less than the provider-reported floor', async () => {
      const messages = [
        { role: 'user', content: 'short', timestamp: 0 },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          usage: { input: 200_000, output: 2, cacheRead: 0 },
          stopReason: 'stop',
          timestamp: 1,
        },
      ] as any;

      await expect(
        measurePiContextTokens(messages, 220_000),
      ).resolves.toBeGreaterThanOrEqual(200_000);
    });

    it('falls back to the character estimate before any turn reports usage', () => {
      const messages = [{ role: 'user', content: 'first message', timestamp: 0 }] as any;

      expect(observedPiContextTokens(messages)).toBe(0);
      expect(effectivePiContextTokens(messages)).toBe(
        estimatePiCompactionTokens(messages),
      );
    });

    it('compacts after a turn even though agent_end fires while isStreaming is still set', async () => {
      // The wedge itself. `agent_end` is emitted from inside the Pi run and
      // `isStreaming` is only cleared afterwards, in the agent's `finally`. The
      // guard used to run before any await, so this method returned on its first
      // check every time and post-turn compaction never executed in production.
      const trigger = wedgedAssistantMessage();
      const beforeMessages = [{ role: 'user', content: 'old', timestamp: 0 }, trigger] as any;
      const compactedMessages = [{ role: 'user', content: '[summary] old', timestamp: 2 }] as any;

      const fake = Object.create(ChatThreadDO.prototype) as any;
      const state = {
        isStreaming: true, // still streaming, exactly as at agent_end
        model: { contextWindow: WEDGED_CONTEXT_WINDOW, maxTokens: 262_144 },
        messages: beforeMessages,
      };
      fake.piSession = {
        state,
        // Resolves once the run settles, which is when finishRun clears the flag.
        waitForIdle: vi.fn(async () => {
          state.isStreaming = false;
        }),
      };
      fake.piModelResolver = vi.fn(async () => ({
        model: { contextWindow: WEDGED_CONTEXT_WINDOW, maxTokens: 262_144, id: 'deepseek-v4-auto' },
        apiKey: 'token',
      }));
      fake.loadPiCompleteSimple = vi.fn(async () => vi.fn());
      fake.compactPiContext = vi.fn(async () => compactedMessages);
      fake.replacePiCoreMessages = vi.fn();
      fake.clearPiCoreCompaction = vi.fn();
      fake.recordChatThreadObservabilityEvent = vi.fn();
      fake.piMainBaselineIndex = beforeMessages.length;

      await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(fake, trigger);

      expect(fake.piSession.waitForIdle).toHaveBeenCalled();
      expect(fake.compactPiContext).toHaveBeenCalled();
      expect(fake.piSession.state.messages).toBe(compactedMessages);
    });

    it('surfaces context exhaustion to the user and to error telemetry', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession = {
        state: { model: { contextWindow: WEDGED_CONTEXT_WINDOW, id: 'deepseek-v4-auto' } },
      };
      fake.piCurrentUsageProvider = 'compat';
      fake.recordChatThreadObservabilityEvent = vi.fn();

      const notice = ChatThreadDO.prototype['piContextExhaustionNotice'].call(fake, [
        { role: 'user', content: 'is it ready yet?', timestamp: 0 },
        wedgedAssistantMessage(),
      ]);

      // The turn must say something rather than render blank.
      expect(notice).not.toBe('');
      expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
        'chat_context_exhausted',
        expect.objectContaining({ status: 'context_exhausted', error: expect.any(Error) }),
      );
    });

    it('stays silent when the turn ended normally', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession = { state: { model: { contextWindow: WEDGED_CONTEXT_WINDOW } } };
      fake.recordChatThreadObservabilityEvent = vi.fn();

      const notice = ChatThreadDO.prototype['piContextExhaustionNotice'].call(fake, [
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'here is your spreadsheet' }],
          usage: { input: 1_000, output: 50, cacheRead: 0 },
          stopReason: 'stop',
          timestamp: 1,
        },
      ]);

      expect(notice).toBe('');
      expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalled();
    });
  });

  it('caps the main Pi request output without mutating catalog metadata', () => {
    const catalogModel = { id: 'large-output', maxTokens: 262_144, contextWindow: 1_000_000 } as any;

    const requestModel = capPiMainRequestOutput(catalogModel);

    expect(requestModel).not.toBe(catalogModel);
    expect(requestModel.maxTokens).toBe(PI_MAIN_REQUEST_MAX_OUTPUT_TOKENS);
    expect(catalogModel.maxTokens).toBe(262_144);
  });

  it('preserves lower provider output limits and supplies a bounded default', () => {
    const lower = { id: 'small-output', maxTokens: 8_192 } as any;
    const missing = { id: 'missing-output' } as any;

    expect(capPiMainRequestOutput(lower)).toBe(lower);
    expect(capPiMainRequestOutput(missing).maxTokens).toBe(PI_MAIN_REQUEST_DEFAULT_OUTPUT_TOKENS);
  });

  it('uses Pi effective output token cap as reserve for post-turn compaction triggers', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { waitUntil: vi.fn() };
    fake.piSession = {
      state: {
        model: { id: 'gpt-test', contextWindow: 128_000, maxTokens: 40_000 },
      },
    };
    fake.compactPiContextAfterTurn = vi.fn(async () => undefined);

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(fake, [
      { role: 'user', content: 'request', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'answer' }],
        usage: { totalTokens: 98_000 },
        timestamp: 2,
      },
    ]);

    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant' }),
    );
    expect(fake.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('treats Pi provider context overflow messages as post-turn compaction triggers', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = { waitUntil: vi.fn() };
    fake.piSession = {
      state: {
        model: { id: 'gpt-test', contextWindow: 128_000, maxTokens: 4096 },
      },
    };
    fake.compactPiContextAfterTurn = vi.fn(async () => undefined);

    ChatThreadDO.prototype['maybeSchedulePiPostTurnCompaction'].call(fake, [
      { role: 'user', content: 'request', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        stopReason: 'error',
        errorMessage: 'Your input exceeds the context window of this model',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
        timestamp: 2,
      },
    ]);

    expect(fake.compactPiContextAfterTurn).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'assistant' }),
    );
    expect(fake.ctx.waitUntil).toHaveBeenCalledWith(expect.any(Promise));
  });

  it('uses Pi compaction reserve to size summary generation output', async () => {
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: 'summary' }],
    }));
    const model = {
      id: 'gpt-test',
      api: 'openai-responses',
      provider: 'openai',
      contextWindow: 128_000,
      maxTokens: 40_000,
      reasoning: true,
    };

    const summary = await summarizePiMessages(
      [{ role: 'user', content: 'older context', timestamp: 1 }] as any,
      model as any,
      'test-key',
      completeSimple as any,
    );

    expect(summary).toBe('summary');
    expect(completeSimple).toHaveBeenCalledWith(
      model,
      expect.any(Object),
      expect.objectContaining({
        apiKey: 'test-key',
        maxTokens: 25_600,
        reasoning: 'high',
      }),
    );
  });

  it('chunks oversized Pi compaction summary input so already-large context can be summarized', async () => {
    let summaryIndex = 0;
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: `summary ${++summaryIndex}` }],
    }));
    const model = {
      id: 'gpt-test',
      api: 'openai-responses',
      provider: 'openai',
      contextWindow: 12_000,
      maxTokens: 1000,
      reasoning: false,
    };
    const messages = Array.from({ length: 4 }, (_, index) => ({
      role: 'user',
      content: `message ${index} ${'x'.repeat(16_000)}`,
      timestamp: index,
    }));

    const summary = await summarizePiMessages(
      messages as any,
      model as any,
      'test-key',
      completeSimple as any,
    );

    expect(summary).toBe(`summary ${summaryIndex}`);
    expect(completeSimple.mock.calls.length).toBeGreaterThan(1);
    expect(completeSimple).toHaveBeenLastCalledWith(
      model,
      expect.objectContaining({
        messages: [
          expect.objectContaining({
            content: expect.stringContaining('<previous-summary>'),
          }),
        ],
      }),
      expect.objectContaining({
        maxTokens: 1000,
      }),
    );
  });

  it('repairs an already oversized Pi transcript by chunking compaction before replay', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreCompaction = vi.fn(() => null);
    fake.persistPiCoreCompaction = vi.fn();
    let summaryIndex = 0;
    const completeSimple = vi.fn(async () => ({
      content: [{ type: 'text', text: `summary ${++summaryIndex}` }],
    }));
    const model = {
      id: 'gpt-test',
      api: 'openai-responses',
      provider: 'openai',
      contextWindow: 30_000,
      maxTokens: 4000,
      reasoning: false,
    };
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: 'user',
      content: `message ${index} ${'x'.repeat(16_000)}`,
      timestamp: index,
    }));

    const compacted = await ChatThreadDO.prototype['compactPiContext'].call(
      fake,
      messages,
      model,
      'test-key',
      completeSimple,
      undefined,
      true,
    );

    expect(compacted).not.toBe(messages);
    expect(compacted.length).toBeLessThan(messages.length);
    expect((compacted[0] as { content?: string }).content).toContain('[Context Summary]');
    expect(fake.persistPiCoreCompaction).toHaveBeenCalledWith(
      `summary ${summaryIndex}`,
      expect.any(Number),
    );
    expect(completeSimple.mock.calls.length).toBeGreaterThan(1);
  });

  it('does not overwrite Pi state when post-turn compaction finishes after another run starts', async () => {
    const before = [
      { role: 'user', content: 'old request', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'old answer' }],
        usage: { totalTokens: 112_000 },
        timestamp: 2,
      },
    ];
    const compacted = [
      { role: 'user', content: '[Context Summary]\n\nsummary', timestamp: 3 },
    ];
    const model = { id: 'gpt-test', contextWindow: 128_000 };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = {
      state: {
        isStreaming: false,
        model,
        messages: before,
      },
      waitForIdle: vi.fn(async () => {}),
    };
    fake.piModelResolver = vi.fn(async () => ({
      model,
      apiKey: 'test-key',
      provider: 'openai',
      modelId: 'gpt-test',
      billingSource: 'hosted',
      creditChargeable: true,
      usageProvider: 'openai',
    }));
    fake.loadPiCompleteSimple = vi.fn(async () => vi.fn());
    fake.compactPiContext = vi.fn(async () => {
      fake.piSession.state.isStreaming = true;
      return compacted;
    });
    fake.replacePiCoreMessages = vi.fn();
    fake.clearPiCoreCompaction = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(fake, before[1]);

    expect(fake.piSession.state.messages).toBe(before);
    expect(fake.replacePiCoreMessages).not.toHaveBeenCalled();
    expect(fake.clearPiCoreCompaction).not.toHaveBeenCalled();
  });

  it('does not overwrite Pi state when messages changed while post-turn compaction was running', async () => {
    const before = [
      { role: 'user', content: 'old request', timestamp: 1 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'old answer' }],
        usage: { totalTokens: 112_000 },
        timestamp: 2,
      },
    ];
    const currentMessages = [
      ...before,
      { role: 'user', content: 'new request', timestamp: 3 },
    ];
    const compacted = [
      { role: 'user', content: '[Context Summary]\n\nsummary', timestamp: 4 },
    ];
    const model = { id: 'gpt-test', contextWindow: 128_000 };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = {
      state: {
        isStreaming: false,
        model,
        messages: before,
      },
      waitForIdle: vi.fn(async () => {}),
    };
    fake.piModelResolver = vi.fn(async () => ({
      model,
      apiKey: 'test-key',
      provider: 'openai',
      modelId: 'gpt-test',
      billingSource: 'hosted',
      creditChargeable: true,
      usageProvider: 'openai',
    }));
    fake.loadPiCompleteSimple = vi.fn(async () => vi.fn());
    fake.compactPiContext = vi.fn(async () => {
      fake.piSession.state.messages = currentMessages;
      return compacted;
    });
    fake.replacePiCoreMessages = vi.fn();
    fake.clearPiCoreCompaction = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();

    await ChatThreadDO.prototype['compactPiContextAfterTurn'].call(fake, before[1]);

    expect(fake.piSession.state.messages).toBe(currentMessages);
    expect(fake.replacePiCoreMessages).not.toHaveBeenCalled();
    expect(fake.clearPiCoreCompaction).not.toHaveBeenCalled();
  });

  it('aborts Pi turns after an inactivity timeout', async () => {
    vi.useFakeTimers();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.disposePiSession = vi.fn();
    const promise = ChatThreadDO.prototype['withPiTurnInactivityTimeout'].call(
      fake,
      () => new Promise<void>(() => undefined),
    );
    const assertion = expect(promise).rejects.toThrow(/inactivity timeout/i);

    await vi.advanceTimersByTimeAsync(10 * 60_000);
    await assertion;

    expect(fake.disposePiSession).toHaveBeenCalledTimes(1);
  });

  it('disposes the hung Pi session and preserves the marker for recovery when the reply stream stalls', async () => {
    const { fake, events } = createPiEventFake();
    fake.updateActiveAutomationRun = vi.fn();
    fake.refreshPiSessionModel = vi.fn(async () => undefined);
    fake.syncAgentState = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.piProviderErrorEvent = vi.fn((m: string) => ({ type: 'error', error: m }));
    // A stalled owner prompt no longer runs a bespoke timeout: ai-chat's
    // chatStreamStallTimeoutMs watchdog cancels the reply stream, and onChatMessage's
    // response wrapper disposes the hung session. Because disposePiSession()
    // unsubscribes handlers before aborting, no terminal error is surfaced and the
    // active-turn marker is LEFT set — ai-chat then routes the turn into bounded
    // recovery. Simulate the watchdog by cancelling the returned response body.
    fake.readPiActiveTurn = vi.fn(() => ({ turnId: 'turn-stall', openedAt: 1 }));
    fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
    fake.pendingPiPromptQueue = [
      { userMessage: { role: 'user', content: 'do the thing' } },
    ];
    fake.piEventHandlerChain = Promise.resolve();
    fake.disposePiSession = vi.fn(() => {
      fake.piSession = null;
    });
    fake.piSession = {
      state: { isStreaming: false, model: { api: 'test', provider: 'test', id: 'test-model' } },
      prompt: vi.fn(() => new Promise<void>(() => undefined)),
      steer: vi.fn(),
      abort: vi.fn(),
    };

    const response = (await ChatThreadDO.prototype['onChatMessage'].call(
      fake,
      () => {},
      {},
    )) as Response;
    // Cancel the reply stream the way the stall watchdog does.
    await response.body!.cancel();

    expect(fake.disposePiSession).toHaveBeenCalledTimes(1);
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_turn_stream_stall_abort',
      expect.objectContaining({ status: 'aborted' }),
    );
    // The marker is preserved (recovery re-drives) and no terminal error fires.
    expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  function makeSweepFake(marker: { turnId: string; openedAt: number }) {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 't1' };
    fake.piSession = null;
    fake.activePiStreamTurnId = null;
    fake.pendingPiPromptQueue = [];
    fake.readPiActiveTurn = vi.fn(() => marker);
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    // hasActiveChatRecovery reads ai-chat's bookkeeping through the sync KV API.
    fake.ctx = {
      storage: {
        kv: {
          get: vi.fn(() => undefined),
          list: vi.fn(() => new Map()),
        },
      },
    };
    return fake;
  }

  it('sweeps an orphaned active-turn marker when ai-chat has no active recovery', async () => {
    const fake = makeSweepFake({ turnId: 'orphan', openedAt: 1 });
    await ChatThreadDO.prototype['sweepOrphanedActiveTurnMarker'].call(fake);
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_turn_marker_swept',
      expect.objectContaining({ status: 'cleared' }),
    );
  });

  it('does NOT sweep while ai-chat has an active recovery incident', async () => {
    const fake = makeSweepFake({ turnId: 'orphan', openedAt: 1 });
    fake.ctx.storage.kv.list = vi.fn(
      () =>
        new Map([
          [`${CHAT_RECOVERY_INCIDENT_KEY_PREFIX}x`, { status: 'scheduled' }],
        ]),
    );
    await ChatThreadDO.prototype['sweepOrphanedActiveTurnMarker'].call(fake);
    expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
    expect(fake.finishTurn).not.toHaveBeenCalled();
  });

  it('does NOT sweep while a non-stale recovering flag is set', async () => {
    const fake = makeSweepFake({ turnId: 'orphan', openedAt: 1 });
    fake.ctx.storage.kv.get = vi.fn(() => ({ at: Date.now() }));
    await ChatThreadDO.prototype['sweepOrphanedActiveTurnMarker'].call(fake);
    expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
  });

  it('does NOT sweep a freshly-opened marker (a turn starting this wake)', async () => {
    const fake = makeSweepFake({ turnId: 'fresh', openedAt: Date.now() });
    await ChatThreadDO.prototype['sweepOrphanedActiveTurnMarker'].call(fake);
    expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
  });

  it.each([
    ['gemini-3.5-flash', 'google/gemini-3.5-flash'],
    ['gemini-3-flash-preview', 'google/gemini-3-flash-preview'],
    ['gemini-3.1-pro-preview', 'google/gemini-3.5-flash'],
  ])('routes %s through OpenRouter chat completions', (model, routeModel) => {
    const result = new PiModelMapping().resolvePiModelReference(model);

    expect(result).toEqual({
      provider: 'openrouter',
      modelId: routeModel,
      hostedGatewayProvider: 'openrouter',
      hostedModelId: routeModel,
    });
  });

  it('resolves deepseek-v4-pro to the AI Gateway dynamic route with an OpenRouter lookup id', () => {
    const result = new PiModelMapping().resolvePiModelReference('deepseek-v4-pro');

    expect(result).toEqual({
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-pro',
      hostedGatewayProvider: 'compat',
      hostedModelId: 'dynamic/deepseek-v4-pro-fallback',
      hostedReasoningEffort: 'xhigh',
    });
  });

  it('resolves deepseek-v4-auto to the AI Gateway dynamic route with an OpenRouter lookup id', () => {
    const result = new PiModelMapping().resolvePiModelReference('deepseek-v4-auto');

    expect(result).toEqual({
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-pro',
      hostedGatewayProvider: 'compat',
      hostedModelId: 'dynamic/deepseek-v4-auto',
      hostedReasoningEffort: 'high',
      byokAllowed: false,
      hostedRequestProfile: {
        name: 'deepseek-v4-flash-rtx',
        contextWindow: 220_000,
        maxTokens: 262_144,
        reasoning: true,
        supportsReasoningEffort: true,
        thinkingFormat: 'openai',
      },
    });
  });

  it('resolves deepseek-v4-flash to the AI Gateway dynamic route with an OpenRouter lookup id', () => {
    const result = new PiModelMapping().resolvePiModelReference('deepseek-v4-flash');

    expect(result).toEqual({
      provider: 'openrouter',
      modelId: 'deepseek/deepseek-v4-flash',
      hostedGatewayProvider: 'compat',
      hostedModelId: 'dynamic/deepseek-v4-flash-fallback',
      hostedReasoningEffort: 'xhigh',
      hostedRequestProfile: {
        name: 'deepseek-v4-flash-rtx',
        contextWindow: 220_000,
        maxTokens: 262_144,
        reasoning: true,
        supportsReasoningEffort: true,
        thinkingFormat: 'openai',
      },
    });
  });

  it('runs code mode JavaScript through the Worker Loader with scoped tools', async () => {
    const toolsBinding = { listTools: vi.fn(), callTool: vi.fn() };
    const aiBinding = { run: vi.fn() };
    let capturedWorkerCode: any;
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.env = {
      CODE_MODE_LOADER: {
        load: vi.fn((workerCode) => {
          capturedWorkerCode = workerCode;
          return {
            getEntrypoint: vi.fn(() => ({
              run: vi.fn(async () => ({ text: 'x'.repeat(1200) })),
            })),
          };
        }),
      },
    };
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => toolsBinding),
        AIVirtualBinding: vi.fn(() => aiBinding),
        CamelAiService: vi.fn(() => aiBinding),
        SecureFetchBinding: vi.fn(() => ({ fetch: vi.fn() })),
        AppScreenshotBinding: vi.fn(() => ({ capture: vi.fn() })),
        AppBrowserBinding: vi.fn(() => ({ launch: vi.fn() })),
      },
    };

    const result = await ChatThreadDO.prototype.runCodeModeJavascript.call(fake, {
      code: 'const methods = await env.CONNECTIONS.methods();\nmethods;',
      orgId: 'org_1',
      workspaceId: 'ws_1',
      threadId: 'thread_1',
      userId: 'user_1',
      maxOutputCharacters: 1000,
    });

    expect(fake.ctx.exports.CodeModeToolsBinding).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
        threadId: 'thread_1',
        userId: 'user_1',
        parentToolUseId: undefined,
        allowWebTools: false,
      },
    });
    expect(fake.ctx.exports.AIVirtualBinding).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
        userId: 'user_1',
      },
    });
    expect(fake.ctx.exports.CamelAiService).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
        userId: 'user_1',
      },
    });
    expect(fake.ctx.exports.SecureFetchBinding).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
      },
    });
    expect(fake.ctx.exports.AppScreenshotBinding).toHaveBeenCalledWith({
      props: {
        orgId: 'org_1',
        workspaceId: 'ws_1',
      },
    });
    expect(capturedWorkerCode.globalOutbound).toBeUndefined();
    expect(capturedWorkerCode.env.TOOLS).toBe(toolsBinding);
    expect(capturedWorkerCode.env.CONNECTIONS).toBeUndefined();
    expect(capturedWorkerCode.env.AI).toBe(aiBinding);
    expect(capturedWorkerCode.env.CAMELAI).toBe(aiBinding);
    expect(capturedWorkerCode.env.SECURE_FETCH).toEqual({ fetch: expect.any(Function) });
    expect(capturedWorkerCode.env.SCREENSHOT).toEqual({ capture: expect.any(Function) });
    expect(capturedWorkerCode.env.BROWSER).toEqual({ launch: expect.any(Function) });
    expect(capturedWorkerCode.modules['index.js'].js).toContain('class CodeModeRunner');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createConnectionsFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$find") return (query) => findConnection(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$test") return (query) => binding.test(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('if (connectionName === "$verify") return (query) => binding.verify(query)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createToolBackedConnectionsBinding');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const CONNECTIONS_BINDING = createToolBackedConnectionsBinding(callTool)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const CONNECTIONS = connections');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('return binding.invoke(request)');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('invoke.call(binding');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createOutputConsole');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('globalThis.console = createOutputConsole(output)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const AI = this.env.AI');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createToolHelp');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createCamelAiFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createWorkspaceFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const WORKSPACE = createWorkspaceFacade(callTool)');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('createProjectsFacade');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const env = Object.freeze({ CONNECTIONS, AI, CAMELAI, SCREENSHOT, BROWSER, WORKSPACE, PROJECTS })');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('const context = Object.freeze({ cloudflare: Object.freeze({ env, connections, projects: env.PROJECTS }) })');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('const projects = PROJECTS');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('PROJECTS, projects, env');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('parameters: tool.parameters');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('await tools.help(\\"communication\\")');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('await env.CAMELAI.help()');
    expect(capturedWorkerCode.modules['index.js'].js).toContain('return methods;');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('AsyncFunction');
    expect(capturedWorkerCode.modules['index.js'].js).not.toContain('new Function');
    expect(result.text).toBe(`${'x'.repeat(1000)}\n\n[Truncated: 1000 of 1200 characters]`);
  });

  it('allows js_exec callers to request a longer wall-clock timeout and explains how to raise it', async () => {
    vi.useFakeTimers();

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CODE_MODE_LOADER: {
        load: vi.fn(() => ({
          getEntrypoint: vi.fn(() => ({
            run: vi.fn((timeoutMs: number, maxTimeoutMs: number) =>
              new Promise((_, reject) => {
                setTimeout(
                  () => reject(new Error(
                    `JavaScript execution timed out after ${timeoutMs}ms. Do not retry this js_exec in the same turn. If a longer run is needed, start a new turn with a timeout up to ${maxTimeoutMs}ms.`,
                  )),
                  timeoutMs,
                );
              }),
            ),
          })),
        })),
      },
    };
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({})),
        ConnectionsService: vi.fn(() => ({})),
        AIVirtualBinding: vi.fn(() => ({})),
        CamelAiService: vi.fn(() => ({})),
        SecureFetchBinding: vi.fn(() => ({ fetch: vi.fn() })),
        AppScreenshotBinding: vi.fn(() => ({ capture: vi.fn() })),
        AppBrowserBinding: vi.fn(() => ({ launch: vi.fn() })),
      },
    };

    const runPromise = ChatThreadDO.prototype.runCodeModeJavascript.call(fake, {
      code: 'await new Promise(() => {})',
      orgId: 'org_1',
      workspaceId: 'ws_1',
      timeoutMs: 150_000,
    });

    const rejection = expect(runPromise).rejects.toThrow(
      'JavaScript execution timed out after 150000ms. Do not retry this js_exec in the same turn. If a longer run is needed, start a new turn with a timeout up to 600000ms.',
    );

    await vi.advanceTimersByTimeAsync(150_000);
    await rejection;
  });

  it('clamps js_exec wall-clock timeouts to the platform maximum', async () => {
    vi.useFakeTimers();

    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = {
      CODE_MODE_LOADER: {
        load: vi.fn(() => ({
          getEntrypoint: vi.fn(() => ({
            run: vi.fn((timeoutMs: number, maxTimeoutMs: number) =>
              new Promise((_, reject) => {
                setTimeout(
                  () => reject(new Error(
                    `JavaScript execution timed out after ${timeoutMs}ms. Do not retry this js_exec in the same turn. If a longer run is needed, start a new turn with a timeout up to ${maxTimeoutMs}ms.`,
                  )),
                  timeoutMs,
                );
              }),
            ),
          })),
        })),
      },
    };
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({})),
        ConnectionsService: vi.fn(() => ({})),
        AIVirtualBinding: vi.fn(() => ({})),
        CamelAiService: vi.fn(() => ({})),
        SecureFetchBinding: vi.fn(() => ({ fetch: vi.fn() })),
        AppScreenshotBinding: vi.fn(() => ({ capture: vi.fn() })),
        AppBrowserBinding: vi.fn(() => ({ launch: vi.fn() })),
      },
    };

    const runPromise = ChatThreadDO.prototype.runCodeModeJavascript.call(fake, {
      code: 'await new Promise(() => {})',
      orgId: 'org_1',
      workspaceId: 'ws_1',
      timeoutMs: 999_999,
    });

    const rejection = expect(runPromise).rejects.toThrow(
      'JavaScript execution timed out after 600000ms. Do not retry this js_exec in the same turn. If a longer run is needed, start a new turn with a timeout up to 600000ms.',
    );

    await vi.advanceTimersByTimeAsync(600_000);
    await rejection;
  });

  it('makes code mode final expressions behave like a short-lived JavaScript REPL', () => {
    expect(prepareCodeModeUserCode('const methods = await env.CONNECTIONS.methods();\nmethods;'))
      .toBe('const methods = await env.CONNECTIONS.methods();\nreturn methods;');
    expect(prepareCodeModeUserCode('JSON.stringify(catalog, null, 2);'))
      .toBe('return JSON.stringify(catalog, null, 2);');
    expect(prepareCodeModeUserCode('return await connections.clickhouse.query({ query: "SELECT 1" });'))
      .toBe('return await connections.clickhouse.query({ query: "SELECT 1" });');
    expect(prepareCodeModeUserCode('const catalog = await env.CONNECTIONS.methods();'))
      .toBe('const catalog = await env.CONNECTIONS.methods();');
  });

  it('transcribes mounted audio files through the CAMELAI service binding', async () => {
    const aiRun = vi.fn(async () => ({ text: 'audio transcript' }));
    const r2Get = vi.fn(async () => r2Object('audio bytes', 'audio/ogg'));
    const fake = Object.create(CamelAiService.prototype) as any;
    fake.env = {
      AI: { run: aiRun },
      R2_BUCKET: { get: r2Get },
    };
    fake.ctx = {
      props: {
        orgId: 'org-1',
        workspaceId: 'workspace-1',
        userId: 'user-1',
      },
    };

    const result = await CamelAiService.prototype.transcribeAudio.call(fake, {
      path: 'uploads/note.ogg',
    });

    expect(r2Get).toHaveBeenCalledWith('org-1/workspace-1/user-uploads/note.ogg');
    expect(aiRun).toHaveBeenCalledWith('@cf/openai/whisper-large-v3-turbo', {
      audio: 'YXVkaW8gYnl0ZXM=',
    });
    expect(result).toEqual({ text: 'audio transcript' });
  });

  it('advertises the js_exec tool catalog through CodeModeToolsBinding', async () => {
    const tools = await CodeModeToolsBinding.prototype.listTools.call({
      ctx: { props: { allowWebTools: true } },
    } as any);
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));

    expect(tools.map((tool: any) => tool.name)).toEqual(expect.arrayContaining([
      'read',
      'write',
      'edit',
      'delete',
      'move',
      'grep',
      'find',
      'TodoWrite',
      'set_preview',
      'list_apps',
      'rollback_deploy',
      'list_deploy_versions',
      'list_scheduled_prompts',
      'list_workflows',
      'list_integrations',
      'create_project',
      'set_project_description',
      'add_dependency',
      'revert_project',
      'list_commits',
      'get_custom_domain',
      'Agent',
      'Explore',
      'WebSearch',
      'WebFetch',
      'connections_methods',
      'read_skill',
    ]));
    // Human-blocking tools stay top-level only: they must not be in the js_exec
    // catalog where tools.search() would advertise them inside the sandbox timeout.
    for (const name of ['AskUserQuestion', 'prompt_connection_setup', 'delete_connection', 'delete_project']) {
      expect(byName.has(name)).toBe(false);
    }
    expect((byName.get('read') as any).parameters.properties.path).toBeDefined();
    expect((byName.get('read') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('build_project') as any).hidden).toBe(true);
    expect((byName.get('deploy_project') as any).parameters.properties.dry_run).toBeDefined();
    expect((byName.get('deploy_project') as any).parameters.properties.publish_intent).toBeDefined();
    expect((byName.get('read_skill') as any).parameters.properties.skill).toBeDefined();
    expect((byName.get('read_skill') as any).parameters.properties.file).toBeDefined();
    expect((byName.get('read_skill') as any).parameters.properties.location).toBeUndefined();
    expect((byName.get('read_skill') as any).parameters.properties.project).toBeUndefined();
    expect((byName.get('create_project') as any).parameters.properties.description).toBeDefined();
    expect((byName.get('create_project') as any).parameters.properties.name).toBeDefined();
    expect((byName.get('create_project') as any).parameters.properties.template).toBeDefined();
    expect(JSON.stringify((byName.get('create_project') as any).parameters.properties.template)).toContain('crud');
    expect(JSON.stringify((byName.get('create_project') as any).parameters.properties.template)).toContain('vanilla');
    expect(JSON.stringify((byName.get('create_project') as any).parameters.properties.template)).toContain('ai-chat');
    expect(JSON.stringify((byName.get('create_project') as any).parameters.properties.template)).toContain('integration-dashboard');
    expect(JSON.stringify((byName.get('create_project') as any).parameters.properties.template)).toContain('data-dashboard');
    expect((byName.get('create_project') as any).description).toContain('developing-software skill');
    expect((byName.get('create_project') as any).description).toContain('REQUIRED PRECONDITION');
    expect((byName.get('create_project') as any).description).toContain("read_skill with skill='developing-software'");
    expect((byName.get('create_project') as any).description).toContain('during the current task');
    expect((byName.get('create_project') as any).parameters.required).toContain('description');
    expect((byName.get('create_project') as any).parameters.required).toContain('name');
    expect((byName.get('set_project_description') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('set_project_description') as any).parameters.properties.projectId).toBeUndefined();
    expect((byName.get('set_project_description') as any).parameters.properties.description).toBeDefined();
    expect((byName.get('add_dependency') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('build_project') as any).description).toContain('Deprecated compatibility alias');
    expect((byName.get('deploy_project') as any).description).toContain('when validation, build, or deploy fails');
    expect((byName.get('deploy_project') as any).description).toContain("publish_intent='user_requested'");
    expect((byName.get('run_notebook') as any).description).toContain('open a clean successful run in preview automatically');
    expect((byName.get('run_notebook') as any).description).toContain("don't drive nbconvert/validate or call set_preview by hand");
    expect((byName.get('run_notebook') as any).description).toContain('current preview is unchanged');
    expect((byName.get('add_dependency') as any).parameters.properties.dependency).toBeDefined();
    expect((byName.get('revert_project') as any).parameters.properties.snapshot_id).toBeDefined();
    expect((byName.get('list_commits') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('set_preview') as any).parameters.properties.location).toBeDefined();
    expect(JSON.stringify((byName.get('set_preview') as any).parameters.properties.location)).toContain('workspace');
    expect(JSON.stringify((byName.get('set_preview') as any).parameters.properties.location)).toContain('project');
    expect(JSON.stringify((byName.get('set_preview') as any).parameters.properties.location)).toContain('r2');
    expect((byName.get('set_preview') as any).parameters.properties.project).toBeDefined();
    expect((byName.get('set_preview') as any).parameters.properties.clear).toBeUndefined();
    expect((byName.get('rollback_deploy') as any).parameters.properties.script_name).toBeDefined();
    expect((byName.get('rollback_deploy') as any).parameters.properties.artifact_cache_key).toBeDefined();
    expect((byName.get('list_deploy_versions') as any).parameters.properties.script_name).toBeDefined();
    expect((byName.get('WebSearch') as any).parameters.properties.query).toBeDefined();
    expect((byName.get('WebFetch') as any).parameters.properties.url).toBeDefined();
    expect((byName.get('read') as any).parameters.properties.key).toBeUndefined();
    expect((byName.get('read') as any).parameters.properties.location).toBeDefined();
    expect((byName.get('read') as any).parameters.required).toEqual(expect.arrayContaining(['location', 'path']));
    expect((byName.get('write') as any).parameters.properties.content_type).toBeDefined();
    expect((byName.get('ls') as any).parameters.properties.cursor).toBeDefined();
    expect((byName.get('delete') as any).parameters.properties.location).toBeDefined();
    expect((byName.get('move') as any).parameters.properties.source).toBeDefined();
    expect((byName.get('move') as any).parameters.properties.destination).toBeDefined();
    expect(byName.has('vm_push')).toBe(false);
    expect(byName.has('vm_pull')).toBe(false);
    expect(byName.has('r2_read')).toBe(false);
    expect(byName.has('r2_write')).toBe(false);
    expect(byName.has('r2_list')).toBe(false);
    expect(byName.has('r2_delete')).toBe(false);
    expect(byName.has('workspace_info')).toBe(false);
    expect((byName.get('connections_get') as any).parameters.properties.connection).toBeDefined();
    expect(byName.get('send_email')).toMatchObject({
      category: 'communication',
      sideEffect: true,
      externalDelivery: true,
      examples: expect.arrayContaining([expect.stringContaining('tools.send_email')]),
    });
    expect(byName.get('send_slack_message')).toMatchObject({
      category: 'communication',
      sideEffect: true,
      externalDelivery: true,
      examples: expect.arrayContaining([expect.stringContaining('tools.send_slack_message')]),
    });
    expect(byName.get('send_telegram_message')).toMatchObject({
      category: 'communication',
      sideEffect: true,
      externalDelivery: true,
      examples: expect.arrayContaining([expect.stringContaining('tools.send_telegram_message')]),
    });
    expect(byName.get('connections_methods')).toMatchObject({
      category: 'connections',
      examples: expect.arrayContaining([expect.stringContaining('env.CONNECTIONS.methods')]),
    });
    expect(byName.has('list_deterministic_automations')).toBe(false);
    expect(byName.has('prompt_connection_setup')).toBe(false);
  });

  it('removes web helpers from main-agent js_exec and rejects direct calls', async () => {
    const mainBinding = Object.create(CodeModeToolsBinding.prototype) as any;
    mainBinding.ctx = { props: { allowWebTools: false } };

    const names = (await CodeModeToolsBinding.prototype.listTools.call(mainBinding))
      .map((tool: any) => tool.name);
    expect(names).not.toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
    await expect(
      CodeModeToolsBinding.prototype.callTool.call(mainBinding, 'WebSearch', { query: 'test' }),
    ).rejects.toThrow('reserved for the Research agent');
  });

  it('requires set_preview to receive an explicit target', async () => {
    const setPreviewTarget = vi.fn();
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });

    await expect((CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'project',
      project: 'menu-app',
    })).rejects.toThrow('set_preview requires app_name/script_name or path');
    await expect((CodeModeToolsBinding.prototype as any).setPreview.call(fake, {}))
      .rejects.toThrow('set_preview requires app_name/script_name or path');
    expect(setPreviewTarget).not.toHaveBeenCalled();
  });

  it('validates workspace file previews before changing preview state', async () => {
    const setPreviewTarget = vi.fn();
    const exists = vi.fn(async () => ({ exists: false }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });
    Object.defineProperty(fake, 'workspaceFs', {
      value: { exists },
    });

    await expect((CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'workspace',
      path: '/missing.html',
    })).rejects.toThrow('Preview file not found: /missing.html');
    expect(exists).toHaveBeenCalledWith('/missing.html');
    expect(setPreviewTarget).not.toHaveBeenCalled();
  });

  it('sets explicit workspace file previews', async () => {
    const setPreviewTarget = vi.fn();
    const exists = vi.fn(async () => ({ exists: true, isDirectory: false }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });
    Object.defineProperty(fake, 'workspaceFs', {
      value: { exists },
    });

    const result = await (CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'workspace',
      path: 'outputs/report.html',
    });

    expect(exists).toHaveBeenCalledWith('/outputs/report.html');
    expect(result).toMatchObject({
      success: true,
      target: {
        kind: 'file',
        source: 'workspace',
        workspaceId: 'workspace1',
        path: '/outputs/report.html',
        filename: 'report.html',
      },
    });
    expect(setPreviewTarget).toHaveBeenCalledWith((result as any).target);
  });

  it('sets explicit R2 file previews', async () => {
    const setPreviewTarget = vi.fn();
    const head = vi.fn(async () => ({ size: 42 }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1' } };
    fake.env = { R2_BUCKET: { head } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });

    const result = await (CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'r2',
      path: 'outputs/report.html',
    });

    expect(head).toHaveBeenCalledWith('org1/workspace1/user-outputs/report.html');
    expect(result).toMatchObject({
      success: true,
      target: {
        kind: 'file',
        source: 'output',
        workspaceId: 'workspace1',
        path: 'report.html',
        filename: 'report.html',
      },
    });
    expect(setPreviewTarget).toHaveBeenCalledWith((result as any).target);
  });

  it('sets explicit DO-backed project file previews', async () => {
    const setPreviewTarget = vi.fn();
    const exists = vi.fn(async () => ({ exists: true, isDirectory: false }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'chatThreadStub', {
      value: { setPreviewTarget },
    });
    fake.projectFileStore = vi.fn(async () => ({ exists }));

    const result = await (CodeModeToolsBinding.prototype as any).setPreview.call(fake, {
      location: 'project',
      project: 'menu-app',
      path: 'index.html',
    });

    expect(fake.projectFileStore).toHaveBeenCalledWith({ project: 'menu-app' });
    expect(exists).toHaveBeenCalledWith('/index.html');
    expect(result).toMatchObject({
      success: true,
      target: {
        kind: 'file',
        source: 'project',
        workspaceId: 'workspace1',
        path: '/index.html',
        project: 'menu-app',
        filename: 'index.html',
      },
    });
    expect(setPreviewTarget).toHaveBeenCalledWith((result as any).target);
  });

  it('exposes current workspace email metadata to js_exec', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        userId: 'user1',
      },
    };
    fake.env = {
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      EMAIL: { send: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Demo Workspace',
            email_handle: 'demo-workspace',
          })),
        })),
      },
    };

    await expect(
      CodeModeToolsBinding.prototype.callTool.call(fake, 'workspace_info', {}),
    ).resolves.toMatchObject({
      id: 'workspace1',
      name: 'Demo Workspace',
      email_address: 'demo-workspace@camelai.dev',
    });
  });

  it('serves bundled skills only through the Pi read_skill tool', async () => {
    const containerTool = vi.fn(async () => {
      throw new Error('workspace tool should not be called for bundled skills');
    });
    const toolsBinding = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(toolsBinding, 'piContainerTools', {
      value: { callTool: containerTool },
    });
    const bindingFactory = vi.fn(() => toolsBinding);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: bindingFactory,
      },
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    });
    const readSkill = tools.find((tool: any) => tool.name === 'read_skill');

    const directSkill = await readSkill.execute('tool1', {
      skill: 'developing-software',
    });
    expect(directSkill.content[0].text).toContain('name: developing-software');
    expect(directSkill.content[0].text).toContain(
      'build, publish, return the live URL, and open the app in preview',
    );
    expect(directSkill.content[0].text).toContain('dry_run: true');
    expect(directSkill.content[0].text).toContain(
      'Do not automatically launch `env.BROWSER` or capture screenshots after every deploy',
    );
    expect(directSkill.content[0].text).not.toContain('tools.build_project');
    expect(directSkill.content[0].text).not.toContain('tools.set_preview({ app_name');
    expect(directSkill.details.details.source).toBe('bundled_skill');

    const directReference = await readSkill.execute('tool2', {
      skill: 'developing-software',
      file: 'VANILLA-APPS.md',
    });
    expect(directReference.content[0].text).toContain('# Vanilla Apps');
    expect(directReference.content[0].text).toContain(
      'Do not automatically launch `env.BROWSER` or capture screenshots after deployment',
    );
    expect(directReference.details.details.source).toBe('bundled_skill');

    const durableObjectsReference = await readSkill.execute('tool3', {
      skill: 'developing-software',
      file: 'DURABLE-OBJECTS.md',
    });
    expect(durableObjectsReference.content[0].text).toContain('# Durable Objects');
    expect(durableObjectsReference.details.details).toMatchObject({
      skill: 'developing-software',
      file: 'DURABLE-OBJECTS.md',
      source: 'bundled_skill',
    });

    await expect(
      CodeModeToolsBinding.prototype.callTool.call(toolsBinding, 'read_skill', {
        skill: 'developing-software',
        file: '../SKILL.md',
      }),
    ).rejects.toThrow('relative path within the skill');
    await expect(
      CodeModeToolsBinding.prototype.callTool.call(toolsBinding, 'read_skill', {
        skill: 'developing-softwar',
      }),
    ).rejects.toThrow('Available skills:');
    expect(bindingFactory).toHaveBeenCalled();
    expect(containerTool).not.toHaveBeenCalled();
  });

  it('does not dispatch a file edit after its tool signal is aborted', async () => {
    const callTool = vi.fn(async () => ({ text: 'edited' }));
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({ callTool })),
      },
    };
    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    });
    const edit = tools.find((tool: any) => tool.name === 'edit');
    const controller = new AbortController();
    controller.abort();

    await expect(edit.execute('edit-1', {
      location: 'workspace',
      path: '/example.txt',
      edits: [{ oldText: 'old', newText: 'new' }],
    }, controller.signal)).rejects.toThrow('Operation aborted');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('leaves bounded Pi tool results unchanged', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_1', name: 'WebFetch' },
      result: {
        content: [{ type: 'text', text: 'small result' }],
        details: { source: 'test' },
      },
    });

    expect(result).toBeUndefined();
    expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalled();
  });

  it('attaches and persists verified completion evidence for operational tools', async () => {
    const values = new Map<string, unknown>();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      storage: {
        kv: {
          get: vi.fn((key: string) => values.get(key)),
          put: vi.fn((key: string, value: unknown) => values.set(key, value)),
        },
      },
    };

    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      args: { project: 'demo' },
      toolCall: { id: 'deploy-1', name: 'deploy_project' },
      isError: false,
      result: {
        content: [{ type: 'text', text: 'deployed' }],
        details: { success: true, url: 'https://demo.camelai.app' },
      },
    });

    expect((result?.content?.at(-1) as { text: string }).text).toContain('Completion evidence');
    expect(result?.details).toMatchObject({
      completionEvidence: {
        status: 'succeeded',
        supportedClaims: ['deployed', 'published'],
        unsupportedClaims: ['feature verified', 'live data verified'],
      },
    });
    expect(fake.ctx.storage.kv.put).toHaveBeenCalled();
  });

  it('warns after a repeated identical failure and blocks the third retry', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const failure = (id: string) => ({
      args: { path: '/missing.txt', location: 'workspace' },
      toolCall: { id, name: 'read' },
      isError: true,
      result: {
        content: [{ type: 'text', text: 'File not found' }],
        details: { success: false },
      },
    });

    expect(await ChatThreadDO.prototype['afterPiToolCall'].call(fake, failure('call_1'))).toBeUndefined();
    const second = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, failure('call_2'));
    expect((second?.content?.at(-1) as { text: string }).text).toContain('after 2 failed attempt');

    const blocked = await ChatThreadDO.prototype['beforePiToolCall'].call(fake, {
      args: { location: 'workspace', path: '/missing.txt' },
      toolCall: { id: 'call_3', name: 'read' },
    });
    expect(blocked).toMatchObject({ block: true });

    const changed = await ChatThreadDO.prototype['beforePiToolCall'].call(fake, {
      args: { location: 'workspace', path: '/different.txt' },
      toolCall: { id: 'call_4', name: 'read' },
    });
    expect(changed).toBeUndefined();
  });

  it('blocks an identical non-retryable billing failure after one attempt', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const failure = {
      args: { project: 'demo' },
      toolCall: { id: 'billing-1', name: 'deploy_project' },
      isError: true,
      result: {
        content: [{ type: 'text', text: '402 billing quota exhausted' }],
        details: { success: false },
      },
    };

    const first = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, failure);
    expect((first?.content?.at(-1) as { text: string }).text).toContain('after 1 failed attempt');

    const blocked = await ChatThreadDO.prototype['beforePiToolCall'].call(fake, {
      args: { project: 'demo' },
      toolCall: { id: 'billing-2', name: 'deploy_project' },
    });
    expect(blocked).toMatchObject({ block: true });
  });

  it('removes inline screenshot data from image-blind tool results before it reaches model context', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = { state: { model: { id: 'dynamic/deepseek-v4-auto', input: ['text'] } } };
    const imageDataUrl = `data:image/jpeg;base64,${'A'.repeat(60 * 1024)}`;

    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_screenshot', name: 'take_screenshot' },
      result: {
        content: [{
          type: 'text',
          text: JSON.stringify({ width: 1280, height: 720, imageDataUrl }),
        }],
        details: { source: 'test' },
      },
    });

    const text = (result?.content?.[0] as { text: string }).text;
    expect(text).not.toContain('base64,');
    expect(text).toContain('inline image omitted');
    expect(text).toContain('"width":1280');
    expect(result?.details).toMatchObject({
      source: 'test',
      imageDataOmitted: {
        inlineDataUrls: 1,
        imageParts: 0,
        reason: 'active_model_cannot_inspect_images',
      },
    });
  });

  it('preserves inline screenshot data for vision-capable models', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = { state: { model: { id: 'vision-model', input: ['text', 'image'] } } };
    const imageDataUrl = 'data:image/jpeg;base64,abcd';

    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_screenshot', name: 'take_screenshot' },
      result: {
        content: [{ type: 'text', text: JSON.stringify({ imageDataUrl }) }],
        details: {},
      },
    });

    expect(result).toBeUndefined();
  });

  it('preserves typed image parts for a vision-capable consumer model on an image-blind thread', async () => {
    // The Oracle-child case: the camelCode thread model is text-only, but the
    // capability child passes its own vision-capable model as the consumer.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = { state: { model: { id: 'dynamic/deepseek-v4-auto', input: ['text'] } } };

    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_read', name: 'read' },
      result: {
        content: [
          { type: 'text', text: 'uploads/screenshot.png (image/png)' },
          { type: 'image', data: 'abcd', mimeType: 'image/png' },
        ],
        details: {},
      },
    }, undefined, { consumerModel: { id: 'vision-capability-model', input: ['text', 'image'] } });

    expect(result).toBeUndefined();
  });

  it('strips typed image parts for an image-blind consumer model without the Oracle redirect off camelCode', async () => {
    // The Research-child case: the consumer model is text-only even though the
    // thread model can see images, and non-camelCode threads get no Oracle nudge.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = { state: { model: { id: 'vision-model', input: ['text', 'image'] } } };

    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_read', name: 'read' },
      result: {
        content: [
          { type: 'text', text: 'uploads/screenshot.png (image/png)' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        details: {},
      },
    }, undefined, { consumerModel: { id: 'text-only-capability-model', input: ['text'] } });

    const text = (result?.content?.[0] as { text: string }).text;
    expect(text).toContain('1 image tool result omitted');
    expect(text).toContain('active model cannot inspect images');
    expect(text).not.toContain('Oracle');
  });

  it('redirects stripped camelCode image reads to the Oracle tool', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.piSession = { state: { model: { id: 'dynamic/deepseek-v4-auto', input: ['text'] } } };
    fake.currentThreadModel = 'deepseek-v4-auto';

    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_read', name: 'read' },
      result: {
        content: [
          { type: 'text', text: 'uploads/screenshot.png (image/png)' },
          { type: 'image', data: 'AAAA', mimeType: 'image/png' },
        ],
        details: {},
      },
    });

    const text = (result?.content?.[0] as { text: string }).text;
    expect(text).toContain('active model cannot inspect images. Delegate image understanding to the `Oracle` tool, passing this file path]');
  });

  it('truncates oversized Pi tool results and stores full text in R2', async () => {
    const puts: Array<{ key: string; value: string; options: unknown }> = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.env = {
      R2_BUCKET: {
        put: vi.fn(async (key: string, value: string, options: unknown) => {
          puts.push({ key, value, options });
        }),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const big = `${'a'.repeat(60 * 1024)}\nfinal-line`;
    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_1', name: 'WebFetch' },
      result: {
        content: [{ type: 'text', text: big }],
        details: { source: 'test' },
      },
    });

    expect(result?.content?.[0]).toMatchObject({ type: 'text' });
    const text = (result?.content?.[0] as any).text as string;
    expect(text.length).toBeLessThan(big.length);
    expect(text).toMatch(/^a+/);
    expect(text).toContain('[Output truncated: showing first');
    expect(text).toContain('Full output stored in R2 at tmp/');
    expect(text).toContain('read({ location: "r2", path: "tmp/');
    expect(text).not.toContain('final-line');
    expect(result?.details).toMatchObject({
      source: 'test',
      originalTextBlockCount: 1,
      truncation: {
        truncated: true,
        direction: 'head',
      },
    });
    expect(puts).toHaveLength(1);
    expect(puts[0].key).toContain('chat-sessions/thread1/pi-tool-results/tmp/');
    expect(puts[0].value).toBe(big);
    const storedPath = (result?.details as any).chiridionR2ToolResult.path;
    expect(storedPath).toMatch(/^tmp\/.+\.txt$/);
    expect(puts[0].key.endsWith(storedPath.replace(/^tmp\//, ''))).toBe(true);
    expect((result?.details as any).chiridionR2ToolResult.key).toBeUndefined();
    expect((result?.details as any).truncation.fullOutput.path).toBe(storedPath);
  });

  it('truncates oversized tool results from the head', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    fake.env = {
      R2_BUCKET: {
        put: vi.fn(async () => undefined),
      },
    };
    fake.recordChatThreadObservabilityEvent = vi.fn();

    const big = Array.from({ length: 2600 }, (_, index) => `line-${index}`).join('\n');
    const result = await ChatThreadDO.prototype['afterPiToolCall'].call(fake, {
      toolCall: { id: 'call_1', name: 'js_exec' },
      result: {
        content: [{ type: 'text', text: big }],
        details: {},
      },
    });

    const text = (result?.content?.[0] as any).text as string;
    expect(text).toContain('line-0');
    expect(text).not.toContain('line-2599');
    expect((result?.details as any).truncation).toMatchObject({
      truncated: true,
      direction: 'head',
      truncatedBy: 'lines',
    });
  });

  it('exposes provider-specific channel send tools only inside js_exec', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          piContainerTools: { callTool: vi.fn() },
        })),
      },
    };
    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
      userName: null,
      userEmail: null,
    };

    const piTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    expect(piTools.find((tool: any) => tool.name === 'list_projects')).toBeTruthy();
    expect(piTools.find((tool: any) => tool.name === 'create_project')).toBeTruthy();
    expect(piTools.find((tool: any) => tool.name === 'scaffold_project')).toBeUndefined();
    expect(piTools.find((tool: any) => tool.name === 'set_project_description')).toBeTruthy();
    expect(piTools.find((tool: any) => tool.name === 'send_email')).toBeUndefined();
    expect(piTools.find((tool: any) => tool.name === 'send_slack_message')).toBeUndefined();
    expect(piTools.find((tool: any) => tool.name === 'send_telegram_message')).toBeUndefined();

    const codeModeTools = await CodeModeToolsBinding.prototype.listTools.call({} as any);
    expect(codeModeTools.find((tool: any) => tool.name === 'send_email')).toBeTruthy();
    expect(codeModeTools.find((tool: any) => tool.name === 'send_slack_message')).toBeTruthy();
    expect(codeModeTools.find((tool: any) => tool.name === 'send_telegram_message')).toBeTruthy();
  });

  it('moves files between explicit locations without vm_push/vm_pull', async () => {
    const get = vi.fn(async () => r2Object('hello from r2', 'text/plain'));
    const head = vi.fn(async () => ({
      size: 13,
      etag: 'etag',
      uploaded: new Date('2026-01-01T00:00:00.000Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: {},
    }));
    const writeBinaryFile = vi.fn(async (path: string) => ({ success: true, path }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.env = { R2_BUCKET: { head, get } };
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    Object.defineProperty(fake, 'workspaceFs', {
      value: { writeBinaryFile },
    });

    const result = await (CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'r2', path: 'outputs/report.txt' },
      destination: { location: 'workspace', path: '/report.txt' },
    });

    expect(head).toHaveBeenCalledWith('org1/workspace1/user-outputs/report.txt');
    expect(get).toHaveBeenCalledWith('org1/workspace1/user-outputs/report.txt');
    expect(writeBinaryFile).toHaveBeenCalled();
    expect(result.text).toBe('Copied 1 file (13 bytes)');
    expect(result.details.files).toEqual([
      { from: 'outputs/report.txt', to: '/report.txt', bytes: 13 },
    ]);
  });

  it('rejects destructive moves with equal or descendant destinations', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    const writeBinaryFile = vi.fn();
    Object.defineProperty(fake, 'workspaceFs', {
      value: {
        exists: vi.fn(async (path: string) => path === '/dir'
          ? { exists: true, isFile: false, isDirectory: true }
          : { exists: true, isFile: true, isDirectory: false, size: 4, mimeType: 'text/plain' }),
        listFiles: vi.fn(async () => ({
          success: true,
          files: [{ type: 'file', absolutePath: '/dir/file.txt', relativePath: 'file.txt', size: 4, mimeType: 'text/plain' }],
        })),
        writeBinaryFile,
      },
    });

    await expect((CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'workspace', path: '/same.txt' },
      destination: { location: 'workspace', path: '/same.txt' },
      deleteSource: true,
    })).rejects.toThrow('equal or descendant destination');

    await expect((CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'workspace', path: '/dir' },
      destination: { location: 'workspace', path: '/dir/nested' },
      deleteSource: true,
    })).rejects.toThrow('equal or descendant destination');

    const r2Delete = vi.fn();
    const r2Get = vi.fn();
    fake.env = {
      R2_BUCKET: {
        head: vi.fn(async () => ({ size: 4, httpMetadata: { contentType: 'text/plain' } })),
        get: r2Get,
        delete: r2Delete,
      },
    };
    await expect((CodeModeToolsBinding.prototype as any).moveFile.call(fake, {
      source: { location: 'r2', path: 'outputs/same.txt' },
      destination: { location: 'r2', path: 'outputs/same.txt' },
      deleteSource: true,
    })).rejects.toThrow('equal or descendant destination');

    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(r2Get).not.toHaveBeenCalled();
    expect(r2Delete).not.toHaveBeenCalled();
  });

  it('requires explicit file locations and rejects legacy R2 paths', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.recordCodeModeArtifactBestEffort = vi.fn();
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      path: 'outputs/report.txt',
    })).rejects.toThrow('read requires an explicit location');
    expect(() => CodeModeToolsBinding.prototype['resolveCodeModeR2Path'].call(fake, {
      location: 'r2',
      path: '/mnt/user-outputs/report.txt',
    })).toThrow('R2 paths must be relative');
    expect(() => CodeModeToolsBinding.prototype['resolveCodeModeR2Path'].call(fake, {
      location: 'r2',
      key: 'org1/workspace1/user-outputs/report.txt',
    })).toThrow('R2 path is required');
  });

  it('reads stored R2 tool result paths with Pi-style line offsets', async () => {
    const raw = Array.from({ length: 3000 }, (_, index) => `line-${index + 1}`).join('\n');
    const bytes = new TextEncoder().encode(raw);
    const key = 'org1/workspace1/chat-sessions/thread1/pi-tool-results/tmp/result.txt';
    const head = {
      key,
      size: bytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'pi-tool-result-text' },
    };
    const get = vi.fn(async () => ({
      ...head,
      async text() {
        return raw;
      },
    }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    fake.env = {
      IMAGES: { input: vi.fn() },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get,
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      location: 'r2',
      path: 'tmp/result.txt',
      offset: 2,
      limit: 3,
    });

    expect(get).toHaveBeenCalledWith(key);
    expect((result as any).text).toContain('line-2\nline-3\nline-4');
    expect((result as any).text).toContain('Use offset=5 to continue');
    expect((result as any).details).toMatchObject({
      location: 'r2',
      path: 'tmp/result.txt',
      offset: 2,
      nextOffset: 5,
      totalLines: 3000,
      truncation: {
        truncated: false,
        outputLines: 3,
      },
    });
  });

  it('returns R2 image objects as Pi image tool content', async () => {
    const key = 'org1/workspace1/user-outputs/chart.png';
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
    ]);
    const head = {
      key,
      size: pngBytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer should not be used for streamed image reads');
    });
    const output = vi.fn(async () => ({
      contentType: () => 'image/png',
      image: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('transformed-base64'));
          controller.close();
        },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    const images = {
      info: vi.fn(),
      input: vi.fn(() => ({ transform, output })),
    };
    fake.env = {
      IMAGES: images,
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(pngBytes);
              controller.close();
            },
          }),
          arrayBuffer,
        })),
      },
    };

    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'outputs/chart.png' });

    expect((result as any).text).toContain('Read R2 image object [image/png]');
    expect((result as any).content).toEqual([
      { type: 'text', text: 'Read R2 image object [image/png]\n[Image optimized for inline model context and may be scaled/compressed from the source.]' },
      {
        type: 'image',
        data: 'transformed-base64',
        mimeType: 'image/png',
      },
    ]);
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(images.input).toHaveBeenCalled();
    expect(transform).toHaveBeenCalledWith({ width: 2000, height: 2000, fit: 'scale-down' });
    expect((result as any).details).toMatchObject({
      location: 'r2',
      path: 'outputs/chart.png',
      image: true,
      mimeType: 'image/png',
      inlineImage: true,
      optimizedForInlineView: true,
      maxInlineDimension: 2000,
      usedImagesBinding: true,
      offset: null,
      nextOffset: null,
      totalLines: null,
      truncation: null,
    });
  });

  it('rejects large non-image R2 objects after sniffing without draining the body', async () => {
    const key = 'org1/workspace1/user-outputs/large.bin';
    const head = {
      key,
      size: 11 * 1024 * 1024,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    let pulls = 0;
    let cancelled = false;
    fake.env = {
      IMAGES: { input: vi.fn() },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          body: new ReadableStream({
            pull(controller) {
              pulls += 1;
              if (pulls === 1) {
                controller.enqueue(new Uint8Array(4100));
                return;
              }
              throw new Error('body should not be drained after non-image sniff');
            },
            cancel() {
              cancelled = true;
            },
          }),
          arrayBuffer: vi.fn(async () => {
            throw new Error('arrayBuffer should not be used for streamed R2 reads');
          }),
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      location: 'r2',
      path: 'outputs/large.bin',
    })).rejects.toThrow('R2 object is too large for text read');

    expect(pulls).toBe(1);
    expect(cancelled).toBe(true);
  });

  it('sniffs large generic R2 images and optimizes streamed image content', async () => {
    const key = 'org1/workspace1/user-outputs/large-chart.png';
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x0b, 0xb8,
      0x00, 0x00, 0x03, 0xe8,
    ]);
    const head = {
      key,
      size: 11 * 1024 * 1024,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'application/octet-stream' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    const arrayBuffer = vi.fn(async () => {
      throw new Error('arrayBuffer should not be used for streamed image reads');
    });
    const output = vi.fn(async () => ({
      contentType: () => 'image/png',
      image: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('large-transformed-base64'));
          controller.close();
        },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    fake.env = {
      IMAGES: {
        input: vi.fn(() => ({ transform, output })),
      },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(pngBytes);
              controller.close();
            },
          }),
          arrayBuffer,
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'outputs/large-chart.png' });

    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(transform).toHaveBeenCalledWith({ width: 2000, height: 2000, fit: 'scale-down' });
    expect((result as any).text).toContain('Read R2 image object [image/png]');
    expect((result as any).text).toContain('optimized for inline model context');
    expect((result as any).text).not.toContain('displayed at');
    expect((result as any).details).toMatchObject({
      image: true,
      inlineImage: true,
      optimizedForInlineView: true,
      maxInlineDimension: 2000,
      usedImagesBinding: true,
    });
  });

  it('does not trust R2 image metadata after sniffing an unsupported image variant', async () => {
    const key = 'org1/workspace1/user-outputs/animated.png';
    const apngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
      0x08, 0x06, 0x00, 0x00, 0x00,
      0x1f, 0x15, 0xc4, 0x89,
      0x00, 0x00, 0x00, 0x08,
      0x61, 0x63, 0x54, 0x4c,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x00,
    ]);
    const head = {
      key,
      size: apngBytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'image/png' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    const images = { input: vi.fn() };
    fake.env = {
      IMAGES: images,
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(apngBytes);
              controller.close();
            },
          }),
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'outputs/animated.png' });

    expect(images.input).not.toHaveBeenCalled();
    expect((result as any).text).not.toContain('Read R2 image object');
    expect((result as any).details?.image).toBeUndefined();
  });

  it('truncates R2 reads by line count with an offset continuation', async () => {
    const raw = Array.from({ length: 2600 }, (_, index) => `line-${index + 1}`).join('\n');
    const key = 'org1/workspace1/chat-sessions/thread1/pi-tool-results/tmp/many-lines.txt';
    const bytes = new TextEncoder().encode(raw);
    const head = {
      key,
      size: bytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'pi-tool-result-text' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    fake.env = {
      IMAGES: { input: vi.fn() },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          async text() {
            return raw;
          },
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'tmp/many-lines.txt' });

    expect((result as any).text).toContain('line-1');
    expect((result as any).text).toContain('line-2000');
    expect((result as any).text).not.toContain('line-2001');
    expect((result as any).text).toContain('Use offset=2001 to continue');
    expect(new TextEncoder().encode((result as any).text).byteLength).toBeLessThanOrEqual(50 * 1024);
    expect((result as any).details).toMatchObject({
      offset: 1,
      nextOffset: 2001,
      totalLines: 2600,
      truncation: {
        truncated: true,
        truncatedBy: 'lines',
        outputLines: 2000,
      },
    });
  });

  it('returns a diagnostic when the first R2 line exceeds the read byte limit', async () => {
    const raw = `${'x'.repeat(60 * 1024)}\nsecond-line`;
    const key = 'org1/workspace1/chat-sessions/thread1/pi-tool-results/tmp/one-long-line.txt';
    const bytes = new TextEncoder().encode(raw);
    const head = {
      key,
      size: bytes.byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'pi-tool-result-text' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    fake.env = {
      IMAGES: { input: vi.fn() },
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          async text() {
            return raw;
          },
        })),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', { location: 'r2', path: 'tmp/one-long-line.txt' });

    expect((result as any).text).toContain('exceeds 50176 byte read budget');
    expect((result as any).text).toContain('tmp/one-long-line.txt');
    expect((result as any).text).not.toContain('second-line');
    expect((result as any).details.truncation).toMatchObject({
      truncated: true,
      truncatedBy: 'bytes',
      firstLineExceedsLimit: true,
    });
  });

  it('validates R2 edits against the original content before writing', async () => {
    const key = 'org1/workspace1/user-outputs/edit.txt';
    const head = {
      key,
      size: 5,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const put = vi.fn();
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    fake.env = {
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({
          ...head,
          text: async () => 'abcde',
        })),
        put,
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'edit', {
      location: 'r2',
      path: 'outputs/edit.txt',
      edits: [
        { oldText: 'a', newText: 'x' },
        { oldText: 'x', newText: 'y' },
      ],
    })).rejects.toThrow('Could not find edits[1] in outputs/edit.txt');

    expect(put).not.toHaveBeenCalled();
  });

  it('conditionally writes R2 edits and returns structured diff details', async () => {
    const key = 'org1/workspace1/user-outputs/edit.txt';
    const head = {
      key,
      size: 12,
      etag: 'etag-before',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const put = vi.fn(async (_key: string, value: string, options: R2PutOptions) => ({
      ...head,
      size: new TextEncoder().encode(value).byteLength,
      etag: 'etag-after',
      httpMetadata: options.httpMetadata as R2HTTPMetadata,
    }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    fake.env = {
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({ ...head, text: async () => 'old\r\nvalue\r\n' })),
        put,
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'edit', {
      location: 'r2',
      path: 'outputs/edit.txt',
      edits: [{ oldText: 'old\nvalue', newText: 'new\nvalue' }],
    });

    expect(put).toHaveBeenCalledWith(
      key,
      'new\r\nvalue\r\n',
      expect.objectContaining({ onlyIf: { etagMatches: 'etag-before' } }),
    );
    expect((result as any).details).toMatchObject({
      replacementCount: 1,
      firstChangedLine: 1,
      patch: expect.stringContaining('@@'),
    });
  });

  it('rejects an R2 edit when the object changes before the conditional write', async () => {
    const key = 'org1/workspace1/user-outputs/edit.txt';
    const head = {
      key,
      size: 3,
      etag: 'etag-before',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { type: 'code-mode-r2-file' },
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' } };
    fake.env = {
      R2_BUCKET: {
        head: vi.fn(async () => head),
        get: vi.fn(async () => ({ ...head, text: async () => 'old' })),
        put: vi.fn(async () => null),
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'edit', {
      location: 'r2',
      path: 'outputs/edit.txt',
      edits: [{ oldText: 'old', newText: 'new' }],
    })).rejects.toThrow('Edit conflict');
  });

  it('writes and deletes R2 output files but keeps uploads read-only', async () => {
    const put = vi.fn(async (key: string, value: string, options: any) => ({
      key,
      size: new TextEncoder().encode(value).byteLength,
      etag: 'etag1',
      uploaded: new Date('2026-01-01T00:00:00Z'),
      httpMetadata: options.httpMetadata,
      customMetadata: options.customMetadata,
    }));
    const del = vi.fn(async () => undefined);
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
      },
    };
    fake.env = {
      R2_BUCKET: {
        put,
        delete: del,
      },
    };
    fake.recordCodeModeArtifactBestEffort = vi.fn();

    const write = await CodeModeToolsBinding.prototype.callTool.call(fake, 'write', {
      location: 'r2',
      path: 'outputs/reports/result.txt',
      content: 'hello',
    });

    expect(put).toHaveBeenCalledWith(
      'org1/workspace1/user-outputs/reports/result.txt',
      'hello',
      expect.objectContaining({
        httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      }),
    );
    expect((write as any).details).toMatchObject({
      location: 'r2',
      path: 'outputs/reports/result.txt',
      namespace: 'outputs',
      publicUrl: '/api/workspaces/workspace1/outputs/reports/result.txt',
      bytesWritten: 5,
    });

    await CodeModeToolsBinding.prototype.callTool.call(fake, 'delete', {
      location: 'r2',
      path: 'outputs/reports/result.txt',
    });
    expect(del).toHaveBeenCalledWith('org1/workspace1/user-outputs/reports/result.txt');
  });

  it('records outbound js_exec artifacts on the parent tool call without exposing metadata to model sanitization', async () => {
    const artifacts: unknown[] = [];
    const chatThreadStub = {
      recordCodeModeArtifact: vi.fn(async (_parentToolUseId: string, artifact: unknown) => {
        artifacts.push(artifact);
      }),
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        parentToolUseId: 'tool_js_exec_1',
      },
    };
    Object.defineProperty(fake, 'chatThreadStub', { value: chatThreadStub });
    fake.sendEmail = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Email sent.' }],
      details: {
        status: 'sent',
        channel: 'email',
        provider: 'cloudflare_email',
        messageId: 'email_1',
        attachmentCount: 0,
      },
    }));

    await CodeModeToolsBinding.prototype.callTool.call(fake, 'send_email', {
      to: 'alice@example.com',
      subject: 'Done',
      text: 'Finished.',
    });

    expect(chatThreadStub.recordCodeModeArtifact).toHaveBeenCalledWith(
      'tool_js_exec_1',
      expect.objectContaining({
        kind: 'outbound_email',
        toolName: 'send_email',
        status: 'sent',
        title: 'Email sent',
        summary: expect.objectContaining({
          to: 'alice@example.com',
          toDomain: 'example.com',
          subject: 'Done',
          hasText: true,
        }),
        result: expect.objectContaining({ messageId: 'email_1' }),
      }),
    );

    const messageWithUiMetadata = {
      role: 'toolResult',
      toolCallId: 'tool_js_exec_1',
      toolName: 'js_exec',
      content: 'ok',
      uiMetadata: { codeModeArtifacts: artifacts },
    } as any;
    expect(stripPiUiMetadata(messageWithUiMetadata)).not.toHaveProperty('uiMetadata');
  });

  it('does not fail a completed outbound tool when artifact recording fails', async () => {
    const recordError = new Error('temporary KV failure');
    const chatThreadStub = {
      recordCodeModeArtifact: vi.fn(async () => {
        throw recordError;
      }),
    };
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        parentToolUseId: 'tool_js_exec_1',
      },
    };
    Object.defineProperty(fake, 'chatThreadStub', { value: chatThreadStub });
    fake.sendEmail = vi.fn(async () => ({
      content: [{ type: 'text', text: 'Email sent.' }],
      details: {
        status: 'sent',
        channel: 'email',
        messageId: 'email_1',
      },
    }));

    try {
      const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'send_email', {
        to: 'alice@example.com',
        subject: 'Done',
        text: 'Finished.',
      });

      expect(result).toMatchObject({
        details: {
          status: 'sent',
          messageId: 'email_1',
        },
      });
      expect(fake.sendEmail).toHaveBeenCalledTimes(1);
      expect(chatThreadStub.recordCodeModeArtifact).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to record code mode artifact',
        expect.objectContaining({
          toolName: 'send_email',
          threadId: 'thread1',
          parentToolUseId: 'tool_js_exec_1',
          error: 'temporary KV failure',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('projects persisted js_exec UI artifacts into parsed tool result blocks', () => {
    const artifact = {
      id: 'artifact_1',
      kind: 'outbound_slack_message',
      toolName: 'send_slack_message',
      status: 'sent',
      title: 'Slack message sent',
      createdAt: 1,
      updatedAt: 2,
      summary: { channelId: 'C123' },
    };
    const messages: any[] = [{
      id: 'assistant_1',
      thread_id: 'thread1',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'tool_js_exec_1', name: 'js_exec', input: {} }],
      created_at: 1,
      forkEntryId: 'assistant_1',
    }];
    attachPiToolResultToParsedMessages(messages, {
      role: 'toolResult',
      toolCallId: 'tool_js_exec_1',
      toolName: 'js_exec',
      content: 'ok',
      isError: true,
      uiMetadata: { codeModeArtifacts: [artifact] },
    });

    expect(messages[0].content[1]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool_js_exec_1',
      is_error: true,
      status: 'failed',
      artifacts: [artifact],
    });
  });

  it('does not advertise outbound channel sends in ordinary chat prompts', () => {
    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
      userName: null,
      userEmail: null,
    };
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(),
        })),
      },
    };

    const prompt = ChatThreadDO.prototype['createPiSystemPrompt'].call(fake, context);
    // The skills section emphasizes not skipping matching skills — models
    // (including DeepSeek flash) tend to improvise past them otherwise.
    expect(prompt).toContain('## Available Skills');
    expect(prompt).toContain('Pay close attention to these skills');
    expect(prompt).toContain('a common and costly mistake');
    expect(prompt).toContain('before the first `create_project` call in a task');
    expect(prompt).toContain('read_skill({ skill: "developing-software" })');
    expect(prompt).toContain('Never use the generic file `read` tool for bundled skills');
    expect(prompt).toContain('Do not create a scaffold first and read the skill afterward');
    expect(prompt).toContain('`vanilla` for dependency-light client-only HTML/CSS/JavaScript experiences');
    expect(prompt).toContain('answer in chat only');
    expect(prompt).toContain('Treat structured tool outcomes as the source of truth');
    expect(prompt).toContain('creating an analysis, notebook, report, or file does not imply publishing');
    expect(prompt).toContain('Never invent missing rows, prompts, campaigns, categories, URLs, fields, or provenance');
    expect(prompt).toContain('User corrections override earlier assumptions');
    expect(prompt).toContain('set_preview({ location: "workspace", path: "/notes.md" })');
    expect(prompt).toContain('set_preview({ location: "r2", path: "outputs/report.html" })');
    expect(prompt).toContain('A clean successful `run_notebook` opens the executed notebook automatically');
    expect(prompt).toContain('a failed run leaves preview unchanged');
    expect(prompt).toContain('deploy_project` returns the live URL and opens successfully deployed apps automatically');
    expect(prompt).toContain('pass `dry_run: true`');
    expect(prompt).toContain('no manual app `set_preview` or `list_apps` call is needed after deploy');
    expect(prompt).toContain('`set_preview` remains available when you explicitly want to reopen or switch');
    expect(prompt).toContain('Browser and screenshot tools are opt-in verification tools');
    expect(prompt).toContain('Do not launch `env.BROWSER` or capture a screenshot merely because an app was deployed');
    expect(prompt).not.toContain('tools.build_project');
    expect(prompt).not.toContain('call `build_project` before');
    expect(prompt).toContain('Use `Research` for current or external information');
    expect(prompt).toContain('Give it one focused question');
    expect(prompt).not.toContain('WebSearch');
    expect(prompt).not.toContain('WebFetch');
    expect(prompt).not.toContain('Oracle');
    // Image routing to Oracle is camelCode-only guidance (asserted below).
    expect(prompt).not.toContain('You cannot see images');
    expect(prompt).not.toContain('tools.send_email');
    expect(prompt).not.toContain('tools.send_slack_message');
    expect(prompt).not.toContain('tools.send_telegram_message');

    fake.currentThreadModel = 'deepseek-v4-auto';
    const camelFreePrompt = ChatThreadDO.prototype['createPiSystemPrompt'].call(fake, context);
    expect(camelFreePrompt).toContain('Use `Oracle` when the user asks for it');
    expect(camelFreePrompt).toContain('stuck after failed attempts');
    expect(camelFreePrompt).toContain('difficult architecture, debugging, planning, or implementation');
    expect(camelFreePrompt).toContain('Handle routine work directly');
    expect(camelFreePrompt).toContain('You cannot see images');
    expect(camelFreePrompt).toContain('do not guess and do not answer generically: call `Oracle`');
    expect(camelFreePrompt).toContain('include the exact image path(s)');
    expect(camelFreePrompt).toContain("Use Oracle's description of the image as ground truth");
    expect(camelFreePrompt).toContain('never claim to have viewed an image yourself');
    expect(camelFreePrompt).not.toContain('WebSearch');
    expect(camelFreePrompt).not.toContain('WebFetch');

    const oracleTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context, { includeOracle: true });
    const oracleTool = oracleTools.find((tool: any) => tool.name === 'Oracle');
    expect(oracleTool?.description).toContain('Oracle can also view and interpret images (screenshots, charts, photos) that you cannot see yourself; give it the image file path.');

    const piTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    expect(piTools.map((tool: any) => tool.description ?? '').join('\n')).not.toContain('WebSearch');
    expect(piTools.map((tool: any) => tool.description ?? '').join('\n')).not.toContain('WebFetch');
    const jsExec = piTools.find((tool: any) => tool.name === 'js_exec');
    // The js_exec description must not advertise outbound channel sends; the opt-in
    // caution itself lives in the system prompt ("answer in chat only", asserted above).
    expect(jsExec?.description).not.toContain('tools.send_email');
    expect(jsExec?.description).not.toContain('tools.send_slack_message');
    expect(jsExec?.description).not.toContain('tools.send_telegram_message');
  });

  it('tells isolated subagents to hand external research back to the primary agent', async () => {
    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };

    const prompt = await ChatThreadDO.prototype['createPiSubagentSystemPrompt'].call(
      Object.create(ChatThreadDO.prototype),
      context,
      false,
    );

    expect(prompt).toContain('If the task needs external research');
    expect(prompt).toContain('the primary agent can handle it');
    expect(prompt).not.toContain('WebSearch');
    expect(prompt).not.toContain('WebFetch');
  });

  it('sends email from any workspace context', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'email_1' }));
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      ORG: createChannelOrgNamespace({ recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };
    const result = await ChannelTools.prototype['sendChannelEmailTool'].call(
      fake,
      {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        userName: null,
        userEmail: null,
      },
      {
        to: 'alice@example.com',
        subject: 'Done',
        text: 'Finished.',
      },
    );

    expect(sendEmailMock).toHaveBeenCalledWith({
      from: 'Camel <workspace-agent@camelai.dev>',
      to: 'alice@example.com',
      subject: 'Done',
      text: 'Finished.',
    });
    expect(result.content[0].text).toBe('Email sent.');
    expect(result.details).toMatchObject({
      provider: 'cloudflare_email',
      messageId: 'email_1',
    });
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_reply_ref:workspace1:email_1',
      'thread1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify(['email_1']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'email');
  });

  it('sends channel email replies with RFC thread headers and extends reference chain', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'camel-reply@example.com' }));
    const kvGetMock = vi.fn(async (key: string) =>
      key === 'email_thread_refs:workspace1:thread1'
        ? JSON.stringify(['first-user@example.com', 'latest-user@example.com'])
        : null
    );
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'channel',
      channel_kind: 'email',
      channel_connection_id: 'workspace-agent@camelai.dev',
      channel_conversation_id: 'message:first-user@example.com',
      channel_message_id: 'first-user@example.com',
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: kvGetMock, put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    await ChannelTools.prototype['sendChannelEmailTool'].call(
      fake,
      {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        userName: null,
        userEmail: null,
      },
      {
        to: 'sender@example.com',
        subject: 'Re: Need help',
        text: 'Here is the answer.',
      },
    );

    expect(sendEmailMock).toHaveBeenCalledWith({
      from: 'Camel <workspace-agent@camelai.dev>',
      to: 'sender@example.com',
      subject: 'Re: Need help',
      text: 'Here is the answer.',
      replyTo: 'workspace-agent@camelai.dev',
      headers: {
        'In-Reply-To': '<latest-user@example.com>',
        References: '<first-user@example.com> <latest-user@example.com>',
      },
    });
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_reply_ref:workspace1:camel-reply@example.com',
      'thread1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify([
        'first-user@example.com',
        'latest-user@example.com',
        'camel-reply@example.com',
      ]),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('sends RFC thread headers for outbound-originated email conversations with stored refs', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'second-camel-reply@example.com' }));
    const kvGetMock = vi.fn(async (key: string) =>
      key === 'email_thread_refs:workspace1:thread1'
        ? JSON.stringify(['first-camel-email@example.com', 'recipient-reply@example.com'])
        : null
    );
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'web',
      channel_kind: null,
      channel_connection_id: null,
      channel_conversation_id: null,
      channel_message_id: null,
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: kvGetMock, put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    await ChannelTools.prototype['sendChannelEmailTool'].call(
      fake,
      {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        userName: null,
        userEmail: null,
      },
      {
        to: 'sender@example.com',
        subject: 'Re: Need help',
        text: 'Here is the follow-up.',
      },
    );

    expect(sendEmailMock).toHaveBeenCalledWith({
      from: 'Camel <workspace-agent@camelai.dev>',
      to: 'sender@example.com',
      subject: 'Re: Need help',
      text: 'Here is the follow-up.',
      headers: {
        'In-Reply-To': '<recipient-reply@example.com>',
        References: '<first-camel-email@example.com> <recipient-reply@example.com>',
      },
    });
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify([
        'first-camel-email@example.com',
        'recipient-reply@example.com',
        'second-camel-reply@example.com',
      ]),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('reports email sent when post-send metadata persistence fails', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'sent-before-kv-failed@example.com' }));
    const kvPutMock = vi.fn(async () => {
      throw new Error('KV unavailable');
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'web',
      channel_kind: null,
      channel_connection_id: null,
      channel_conversation_id: null,
      channel_message_id: null,
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    try {
      const result = await ChannelTools.prototype['sendChannelEmailTool'].call(
        fake,
        {
          orgId: 'org1',
          workspaceId: 'workspace1',
          threadId: 'thread1',
          userId: 'user1',
          userName: null,
          userEmail: null,
        },
        {
          to: 'sender@example.com',
          subject: 'Status',
          text: 'Here is the update.',
        },
      );

      expect(result.details).toMatchObject({
        status: 'sent',
        messageId: 'sent-before-kv-failed@example.com',
      });
      expect(sendEmailMock).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledWith(
        '[send_email] failed to persist email thread metadata',
        expect.objectContaining({
          workspaceId: 'workspace1',
          threadId: 'thread1',
          messageId: 'sent-before-kv-failed@example.com',
          error: 'KV unavailable',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('sends email without RFC thread headers when pre-send metadata read fails', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'sent-without-refs@example.com' }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'web',
      channel_kind: null,
      channel_connection_id: null,
      channel_conversation_id: null,
      channel_message_id: null,
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: {
        get: vi.fn(async () => {
          throw new Error('KV read unavailable');
        }),
        put: vi.fn(async () => undefined),
      },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    try {
      const result = await ChannelTools.prototype['sendChannelEmailTool'].call(
        fake,
        {
          orgId: 'org1',
          workspaceId: 'workspace1',
          threadId: 'thread1',
          userId: 'user1',
          userName: null,
          userEmail: null,
        },
        {
          to: 'sender@example.com',
          subject: 'Status',
          text: 'Here is the update.',
        },
      );

      expect(result.details).toMatchObject({
        status: 'sent',
        messageId: 'sent-without-refs@example.com',
      });
      expect(sendEmailMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
      expect(consoleError).toHaveBeenCalledWith(
        '[send_email] failed to read email thread metadata',
        expect.objectContaining({
          workspaceId: 'workspace1',
          threadId: 'thread1',
          error: 'KV read unavailable',
        }),
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it('does not use non-email channel message ids as email reply headers', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'camel-email@example.com' }));
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'channel',
      channel_kind: 'slack',
      channel_connection_id: 'slack-install-1',
      channel_conversation_id: 'T1:C1:1700000000.000100',
      channel_message_id: '1700000000.000100',
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    await ChannelTools.prototype['sendChannelEmailTool'].call(
      fake,
      {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        userName: null,
        userEmail: null,
      },
      {
        to: 'sender@example.com',
        subject: 'Status',
        text: 'Here is the update.',
      },
    );

    expect(sendEmailMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify(['camel-email@example.com']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('does not send RFC reply headers when an email thread lacks a real message id', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'camel-reply@example.com' }));
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'channel',
      channel_kind: 'email',
      channel_connection_id: 'workspace-agent@camelai.dev',
      channel_conversation_id: 'message:8ad1518c-43e7-4b52-a4f2-80ee74d5b9f8',
      channel_message_id: null,
    };

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    await ChannelTools.prototype['sendChannelEmailTool'].call(
      fake,
      {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        userName: null,
        userEmail: null,
      },
      {
        to: 'sender@example.com',
        subject: 'Re: Need help',
        text: 'Here is the answer.',
      },
    );

    expect(sendEmailMock.mock.calls[0]?.[0]).not.toHaveProperty('headers');
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_thread_refs:workspace1:thread1',
      JSON.stringify(['camel-reply@example.com']),
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
  });

  it('rejects channel email sends for Pay as you go orgs', async () => {
    const sendEmailMock = vi.fn(async () => ({ messageId: 'email_1' }));
    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send: sendEmailMock },
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            billing_plan: 'payg',
            billing_status: 'active',
          })),
        })),
      },
    };

    await expect(
      ChannelTools.prototype['sendChannelEmailTool'].call(
        fake,
        {
          orgId: 'org1',
          workspaceId: 'workspace1',
          threadId: 'thread1',
          userId: 'user1',
          userName: null,
          userEmail: null,
        },
        {
          to: 'alice@example.com',
          subject: 'Done',
          text: 'Finished.',
        },
      ),
    ).rejects.toThrow(
      'Workspace email inbox requires a Starter, Pro, Team, or Enterprise plan.',
    );
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends Telegram from a workspace-scoped code mode tool binding without thread scope', async () => {
    const appendChannelHistoryEvent = vi.fn(async () => ({ status: 'appended' }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/sendMessage$/);
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({ chat_id: '12345', text: 'Hello from workflow' });
      return Response.json({ ok: true, result: { message_id: 29 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        userId: 'user1',
      },
    };
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegration: vi.fn(async () => ({
            id: 'telegram-int',
            integration_type: 'telegram',
            name: 'Product Telegram',
            config: JSON.stringify({
              chat_id: '12345',
              chat_title: 'Product team',
            }),
          })),
        })),
      },
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === 'channel_thread:telegram:workspace1:telegram-int:12345'
            ? 'telegram-thread'
            : null
        ),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      ORG: createChannelOrgNamespace({
        thread: { id: 'telegram-thread', title: 'Product team' },
        integration: {
          id: 'telegram-int',
          integration_type: 'telegram',
          name: 'Product Telegram',
          config: JSON.stringify({
            chat_id: '12345',
            chat_title: 'Product team',
          }),
        },
      }),
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ appendChannelHistoryEvent })),
      },
    };

    const result = await CodeModeToolsBinding.prototype.callTool.call(
      fake,
      'send_telegram_message',
      {
        integration_id: 'telegram-int',
        text: 'Hello from workflow',
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      chatId: '12345',
      integrationId: 'telegram-int',
      messageIds: [29],
      channelHistoryStatus: 'recorded',
    });
    expect(appendChannelHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({
      sourceThreadId: '',
      threadId: 'telegram-thread',
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('serves bundled skills through js_exec tools.read_skill without virtual file paths', async () => {
    const containerTool = vi.fn(async (name: string) => ({ text: `ordinary workspace ${name}` }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(fake, 'piContainerTools', {
      value: { callTool: containerTool },
    });

    const skill = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read_skill', {
      skill: 'data-analysis',
    });
    expect((skill as any).text).toContain('name: data-analysis');
    expect((skill as any).details.source).toBe('bundled_skill');
    expect((skill as any).details).toMatchObject({
      skill: 'data-analysis',
      file: 'SKILL.md',
    });
    expect(containerTool).not.toHaveBeenCalled();

    const ordinaryFileCalls = [
      ['read', '/opt/chiridion-host-pi/skills/data-analysis/SKILL.md'],
      ['read', '.agents/skills/data-analysis/SKILL.md'],
      ['read', '/workspace/.claude/skills/data-analysis/SKILL.md'],
      ['read', '/home/claude/.agents/skills/data-analysis/SKILL.md'],
      ['ls', '/opt/chiridion-host-pi/skills'],
    ] as const;
    for (const [name, path] of ordinaryFileCalls) {
      const result = await CodeModeToolsBinding.prototype.callTool.call(fake, name, {
        location: 'workspace',
        path,
      });
      expect(result).toEqual({ text: `ordinary workspace ${name}` });
      expect(containerTool).toHaveBeenCalledWith(name, {
        location: 'workspace',
        path,
      });
    }
  });

  it('builds a DO-backed project through the project build action', async () => {
    const { fake, sandbox, workspaceStub, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
      timeoutMs: 5000,
    });

    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      project: 'Demo App',
      backend: 'do-r2',
      projectId: 'project-1',
      fileCount: 2,
      stdout: 'built',
    });
    expect(workspaceStub.getProjectByName).toHaveBeenCalledWith('Demo App');
    expect(projectStub.projectListFiles).toHaveBeenCalledWith('/', { recursive: true, includeHidden: true, limit: 50000 });
    expect(sandbox.exec).toHaveBeenCalledWith('bun install && bun run build', expect.objectContaining({
      cwd: '/workspace/project-1',
      env: expect.objectContaining({ CAMELAI_PROJECT_ID: 'project-1', CAMELAI_BUILD_TIMEOUT_MS: '5000' }),
    }));
  });

  it('adds bundled shadcn components to a DO-backed project without npm', async () => {
    const { fake, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'add_shadcn_component', {
      project: 'Demo App',
      components: ['accordion', 'tabs', 'progress'],
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      backend: 'do-r2',
      components: ['accordion', 'tabs', 'progress'],
      filesWritten: [
        '/app/components/ui/accordion.tsx',
        '/app/components/ui/tabs.tsx',
        '/app/components/ui/progress.tsx',
      ],
    });
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith(
      '/app/components/ui/accordion.tsx',
      expect.stringContaining('AccordionPrimitive'),
    );
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith(
      '/app/components/ui/tabs.tsx',
      expect.stringContaining('TabsPrimitive'),
    );
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith(
      '/app/components/ui/progress.tsx',
      expect.stringContaining('ProgressPrimitive'),
    );
    expect(result.packagesAdded).toEqual([expect.stringMatching(/^radix-ui@\^/)]);
    const packageJson = JSON.parse((await projectStub.projectReadFile('/package.json')).content as string);
    expect(packageJson.dependencies['radix-ui']).toMatch(/^\^/);

    const second = await CodeModeToolsBinding.prototype.callTool.call(fake, 'add_shadcn_component', {
      project: 'Demo App',
      component: 'tabs',
    }) as Record<string, unknown>;

    expect(second).toMatchObject({
      success: true,
      filesWritten: [],
      filesSkipped: ['/app/components/ui/tabs.tsx'],
      packagesAdded: [],
    });

    const stringComponents = await CodeModeToolsBinding.prototype.callTool.call(fake, 'add_shadcn_component', {
      project: 'Demo App',
      components: 'progress',
      force: true,
    }) as Record<string, unknown>;

    expect(stringComponents).toMatchObject({
      success: true,
      components: ['progress'],
      filesWritten: ['/app/components/ui/progress.tsx'],
    });
  });

  it('rejects unsupported bundled shadcn components clearly', async () => {
    const { fake } = createProjectToolFake();

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'add_shadcn_component', {
      project: 'Demo App',
      component: 'not-a-real-component',
    })).rejects.toThrow('Unsupported shadcn component "not-a-real-component"');
  });

  it('adds a shadcn block with resolved dependencies to a DO-backed project', async () => {
    const { fake, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'add_shadcn_component', {
      project: 'Demo App',
      component: 'login-03',
    }) as Record<string, unknown>;

    expect(result).toMatchObject({
      success: true,
      components: ['login-03'],
      resolvedItems: ['button', 'card', 'field', 'input', 'label', 'login-03', 'separator'],
    });
    const filesWritten = result.filesWritten as string[];
    expect(filesWritten).toContain('/app/blocks/login-03/page.tsx');
    expect(filesWritten).toContain('/app/components/login-form.tsx');
    expect(filesWritten).toContain('/app/components/ui/button.tsx');
    expect(filesWritten).toContain('/app/components/ui/field.tsx');
    expect(result.packagesAdded).toEqual([expect.stringMatching(/^radix-ui@\^/)]);
    expect(result.message).toContain('app/routes.ts');
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith(
      '/app/blocks/login-03/page.tsx',
      expect.stringContaining('~/components/login-form'),
    );
  });

  it('retries a transient build sandbox 503 RPC failure', async () => {
    vi.useFakeTimers();
    const { fake, sandbox } = createProjectToolFake();
    sandbox.mkdir.mockRejectedValueOnce(new Error('RPCTransportError: WebSocket upgrade failed: 503 Service Unavailable'));

    const resultPromise = CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({ success: true, project: 'Demo App' });
    expect(sandbox.mkdir).toHaveBeenCalledTimes(2);
  });

  it('retries a transient project filesystem network failure before starting a build', async () => {
    vi.useFakeTimers();
    const { fake, projectStub, sandbox } = createProjectToolFake();
    projectStub.projectReadFile.mockRejectedValueOnce(new Error('Network connection lost.'));

    const resultPromise = CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({ success: true, project: 'Demo App' });
    expect(projectStub.projectReadFile).toHaveBeenCalledTimes(4);
    expect(sandbox.mkdir).toHaveBeenCalledTimes(1);
  });

  it('surfaces the last diagnostic line as errorSummary on build failures', async () => {
    const { fake, sandbox } = createProjectToolFake();
    const buildOutput = [
      '$ react-router build && node ./scripts/build-manifest.mjs',
      'vite v8.0.16 building client environment for production...',
      'Error: Transform failed with 1 error:',
      '[PARSE_ERROR] Expected `;` but found `Identifier`',
      // Code-frame furniture referencing an error-named file must not steal
      // the last-diagnostic match.
      '     ╭─[ app/routes/error.tsx:21:30 ]',
      ' 21  │   const failedThing = ;',
      '     ╰────',
      'error: script "build" exited with code 1',
    ].join('\n');
    sandbox.exec.mockImplementation(async (command: string) =>
      command.includes('bun run build')
        ? { success: false, exitCode: 1, stdout: buildOutput, stderr: '' }
        : { success: true, exitCode: 0, stdout: '', stderr: '' });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.errorMessage).toContain('[PARSE_ERROR] Expected `;` but found `Identifier`');
    expect(result.buildLogPath).toBe('/.camelai/tmp/build.log');
    expect(result.buildLogPersisted).toBe(true);
    // The decisive diagnostic plus its location, not bun's command echo,
    // wrapper line, or code-frame furniture.
    expect(result.errorSummary).toContain('[PARSE_ERROR] Expected `;` but found `Identifier`');
    expect(result.errorSummary).toContain('(app/routes/error.tsx:21:30)');
    expect(result.errorSummary).not.toContain('$ react-router build');
    expect(result.logExcerpt).toContain('app/routes/error.tsx:21:30');
  });

  it('anchors errorSummary on the diagnostic block, not stack or error-object tails', async () => {
    const { fake, sandbox } = createProjectToolFake();
    const buildOutput = [
      '$ react-router build && node ./scripts/build-manifest.mjs',
      '✗ Build failed in 261ms',
      'Build failed with 1 error:',
      '',
      '[builtin:vite-transform] Unexpected token',
      '    ╭─[ app/routes/home.tsx?__react-router-build-client-route:20:30 ]',
      '    │',
      ' 20 │   const forcedBuildFailure = ;',
      '    │                              ┬',
      '    │                              ╰──',
      '────╯',
      '    at buildEnvironment (file:///repo/node_modules/vite/dist/node/chunks/node.js:33253:64)',
      '} {',
      '  errors: [Getter/Setter]',
      '}',
      'error: script "build" exited with code 1',
    ].join('\n');
    sandbox.exec.mockImplementation(async (command: string) =>
      command.includes('bun run build')
        ? { success: false, exitCode: 1, stdout: buildOutput, stderr: '' }
        : { success: true, exitCode: 0, stdout: '', stderr: '' });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
    }) as Record<string, unknown>;

    // The regression case: the printed error-object tail must never win.
    expect(result.errorSummary).not.toContain('Getter/Setter');
    expect(result.errorSummary).toContain('[builtin:vite-transform] Unexpected token');
    // Bundler query suffix stripped from the location.
    expect(result.errorSummary).toContain('(app/routes/home.tsx:20:30)');
    expect(result.errorSummary).not.toContain('__react-router-build-client-route');
  });

  it('keeps Tailwind CSS diagnostics relative and strips progress controls', async () => {
    const { fake, sandbox } = createProjectToolFake();
    const workdir = '/workspace/project-1';
    const buildOutput = [
      'vite v8.1.3 building client environment for production...',
      'transforming...\u001b[2K\r✓ 1817 modules transformed.',
      '✗ Build failed in 2.31s',
      'Build failed with 1 error:',
      '',
      `[plugin @tailwindcss/vite:generate:build] ${workdir}/app/app.css`,
      'CssSyntaxError: Missing closing } at',
      `    at Se (file://${workdir}/node_modules/tailwindcss/dist/lib.mjs:1:3926)`,
      '} {',
      '  errors: [Getter/Setter]',
      '}',
      'error: script "build" exited with code 1',
    ].join('\n');
    sandbox.exec.mockImplementation(async (command: string) =>
      command.includes('bun run build')
        ? { success: false, exitCode: 1, stdout: buildOutput, stderr: '' }
        : { success: true, exitCode: 0, stdout: '', stderr: '' });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
    }) as Record<string, unknown>;

    expect(result.errorMessage).toBe('[plugin @tailwindcss/vite:generate:build] app/app.css CssSyntaxError: Missing closing } at');
    expect(result.errorSummary).toBe('[plugin @tailwindcss/vite:generate:build] app/app.css CssSyntaxError: Missing closing } at');
    expect(result.errorSummary).not.toContain('/workspace/project-1');
    expect(result.errorSummary).not.toContain('Getter/Setter');
    expect(result.logExcerpt).not.toContain('[2K');
    expect(result.logExcerpt).not.toContain('\r');
  });

  it('retries a transient deploy sandbox 503 RPC failure', async () => {
    vi.useFakeTimers();
    const { fake, sandbox } = createProjectToolFake({ deploy: true });
    sandbox.mkdir.mockRejectedValueOnce(new Error('RPCTransportError: WebSocket upgrade failed: 503 Service Unavailable'));
    vi.stubGlobal('fetch', vi.fn(async () =>
      Response.json({ success: true, result: { id: 'version-1' } }, { status: 200 })));

    const resultPromise = CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
    });
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(resultPromise).resolves.toMatchObject({ success: true, project: 'Demo App' });
    expect(sandbox.mkdir).toHaveBeenCalledTimes(2);
  });

  it('returns the friendly build service error after transient deploy retries are exhausted', async () => {
    vi.useFakeTimers();
    const { fake, sandbox } = createProjectToolFake({ deploy: true });
    sandbox.mkdir.mockRejectedValue(new Error('Container failed to start'));

    const resultPromise = CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
    });
    const rejection = expect(resultPromise).rejects.toThrow(
      'Build service temporarily unavailable. Please try again in a moment.',
    );
    await vi.advanceTimersByTimeAsync(15_000);

    await rejection;
    expect(sandbox.mkdir).toHaveBeenCalledTimes(5);
  });

  it('returns build diagnostics and the temp build log path on deploy build failures', async () => {
    const { fake, sandbox } = createProjectToolFake({ deploy: true });
    const buildOutput = [
      '$ react-router build && node ./scripts/build-manifest.mjs',
      'Error: Transform failed with 1 error:',
      '[PARSE_ERROR] Expected `;` but found `Identifier`',
      '     ╭─[ app/routes/home.tsx:21:30 ]',
      ' 21  │   const forcedBuildFailure = ;',
      'error: script "build" exited with code 1',
    ].join('\n');
    sandbox.exec.mockImplementation(async (command: string) =>
      command.includes('bun run build')
        ? { success: false, exitCode: 1, stdout: buildOutput, stderr: '' }
        : { success: true, exitCode: 0, stdout: '', stderr: '' });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
    }) as Record<string, any>;

    expect(result).toMatchObject({
      success: false,
      stage: 'build',
      project: 'Demo App',
      errorMessage: expect.stringContaining('[PARSE_ERROR] Expected `;` but found `Identifier`'),
      buildLogPath: '/.camelai/tmp/build.log',
      buildLogPersisted: true,
      build: {
        success: false,
        errorMessage: expect.stringContaining('[PARSE_ERROR] Expected `;` but found `Identifier`'),
        buildLogPath: '/.camelai/tmp/build.log',
        buildLogPersisted: true,
      },
    });
    expect(result.logExcerpt).toContain('app/routes/home.tsx:21:30');
  });

  it('blocks deploy with a clear error when a declared DO class is not exported', async () => {
    const { fake, sandbox } = createProjectToolFake({ deploy: true });
    // Build succeeds but writes a manifest declaring LeaderboardDO while the
    // bundled entry never exports it (agent forgot `export class LeaderboardDO`).
    sandbox.exec.mockImplementation(async (command: string, options?: { cwd?: string }) => {
      if (command === 'bun install && bun run build' && options?.cwd) {
        sandbox.__setFile?.(`${options.cwd}/build/server/wrangler.json`, JSON.stringify({
          main: 'index.js',
          no_bundle: true,
          compatibility_date: '2026-06-01',
          durable_objects: { bindings: [{ name: 'LEADERBOARD', class_name: 'LeaderboardDO' }] },
          migrations: [{ tag: 'v1', new_sqlite_classes: ['LeaderboardDO'] }],
        }));
        sandbox.__setFile?.(`${options.cwd}/build/server/index.js`, 'class LeaderboardDO {}\nexport default {};');
      }
      return { success: true, stdout: 'built', stderr: '', exitCode: 0 };
    });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
    }) as Record<string, unknown>;

    expect(result.success).toBe(false);
    expect(result.stage).toBe('validate');
    expect(result.errorSummary).toContain('"LeaderboardDO"');
    expect(result.errorSummary).toContain('not exported from the worker entry (index.js)');
    expect(result.errorSummary).toContain('export class LeaderboardDO');
  });

  it('rejects DO-only project actions for archived legacy projects', async () => {
    const { fake, sandbox, projectStub } = createProjectToolFake({ backend: 'vm' });

    const archivedError = 'archived when camelAI retired project VMs';
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
    })).rejects.toThrow(archivedError);
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
    })).rejects.toThrow(archivedError);
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'add_dependency', {
      project: 'Demo App',
      dependency: 'zod',
    })).rejects.toThrow(archivedError);
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'list_commits', {
      project: 'Demo App',
    })).rejects.toThrow(archivedError);
    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'revert_project', {
      project: 'Demo App',
      snapshot_id: 'a'.repeat(64),
    })).rejects.toThrow(archivedError);

    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(projectStub.projectListFiles).not.toHaveBeenCalled();
    expect(projectStub.projectWriteFile).not.toHaveBeenCalled();
    expect(projectStub.projectRestoreSourceSnapshot).not.toHaveBeenCalled();
  });

  it('rejects project-location file tools for archived legacy projects', async () => {
    const { fake, projectStub } = createProjectToolFake({ backend: 'vm' });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      location: 'project',
      project: 'Demo App',
      path: '/package.json',
    })).rejects.toThrow('archived when camelAI retired project VMs');

    expect(projectStub.projectReadFile).not.toHaveBeenCalled();
    expect(projectStub.projectListFiles).not.toHaveBeenCalled();
    expect(projectStub.projectWriteFile).not.toHaveBeenCalled();
  });

  it('creates new code-mode projects as DO-backed projects', async () => {
    const { fake, workspaceStub, projectStub, chatThreadStub } = createProjectToolFake({ projectFileEntries: [] });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'create_project', {
      name: 'New App',
      description: 'A new app',
    });

    expect(workspaceStub.createProject).toHaveBeenCalledWith({
      name: 'New App',
      description: 'A new app',
      backend: 'do-r2',
      workspaceId: 'workspace1',
    });
    expect(result).toMatchObject({
      name: 'New App',
      description: 'A new app',
      backend: 'do-r2',
      scaffold: {
        template: 'crud',
        filesSkipped: [],
      },
    });
    expect((result as any).scaffold.filesWritten).toEqual(expect.arrayContaining([
      '/package.json',
      '/wrangler.jsonc',
      '/app/root.tsx',
      '/scripts/build-manifest.mjs',
    ]));
    expect(chatThreadStub.recordProjectActivity).toHaveBeenCalledWith({
      projectId: 'project-1',
      activityType: 'created',
    });
  });

  it('does not require thread scope when project activity bookkeeping is unavailable', async () => {
    const { fake, chatThreadStub } = createProjectToolFake({ projectFileEntries: [] });
    delete fake.ctx.props.threadId;

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'create_project', {
      name: 'New App',
      description: 'A new app',
    })).resolves.toMatchObject({ name: 'New App' });

    expect(chatThreadStub.recordProjectActivity).not.toHaveBeenCalled();
  });

  it('preserves a successful project tool result when activity recording fails', async () => {
    const { fake, env, chatThreadStub } = createProjectToolFake({ projectFileEntries: [] });
    chatThreadStub.recordProjectActivity.mockRejectedValueOnce(
      new Error('temporary activity storage failure'),
    );
    env.OBSERVABILITY_EVENTS = { writeDataPoint: vi.fn() } as any;
    env.ERROR_ANALYTICS = { writeDataPoint: vi.fn() } as any;
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'create_project', {
        name: 'New App',
        description: 'A new app',
      })).resolves.toMatchObject({ name: 'New App' });
      expect(consoleError).toHaveBeenCalledWith(
        'Failed to record thread project activity',
        expect.objectContaining({
          toolName: 'create_project',
          workspaceId: 'workspace1',
          threadId: 'thread1',
          error: 'temporary activity storage failure',
        }),
      );
      expect(env.OBSERVABILITY_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
      expect(env.ERROR_ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it('seeds the notebook-first data-analysis scaffold through create_project', async () => {
    const { fake, workspaceStub, projectStub } = createProjectToolFake({ projectFileEntries: [] });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'create_project', {
      name: 'Demo Analysis',
      description: 'A data analysis project',
      template: 'data-analysis',
    });

    expect(workspaceStub.createProject).toHaveBeenCalledWith({
      name: 'Demo Analysis',
      description: 'A data analysis project',
      template: 'data-analysis',
      backend: 'do-r2',
      workspaceId: 'workspace1',
    });
    expect(result).toMatchObject({
      backend: 'do-r2',
      scaffold: {
        template: 'data-analysis',
        filesSkipped: [],
      },
    });
    expect((result as any).scaffold.filesWritten).toEqual(['/analysis.ipynb', '/README.md']);
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/analysis.ipynb', expect.stringContaining('"nbformat": 4'));
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/README.md', expect.stringContaining('Report mode'));
    const writtenPaths = projectStub.projectWriteFile.mock.calls.map(([path]) => path);
    expect(writtenPaths).not.toContain('/package.json');
    expect(writtenPaths).not.toContain('/app/root.tsx');
  });

  it('seeds the dependency-light vanilla scaffold through create_project', async () => {
    const { fake, workspaceStub, projectStub } = createProjectToolFake({ projectFileEntries: [] });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'create_project', {
      name: 'Tiny Game',
      description: 'A client-only browser game',
      template: 'vanilla',
    });

    expect(workspaceStub.createProject).toHaveBeenCalledWith({
      name: 'Tiny Game',
      description: 'A client-only browser game',
      template: 'vanilla',
      backend: 'do-r2',
      workspaceId: 'workspace1',
    });
    expect(result).toMatchObject({
      backend: 'do-r2',
      scaffold: { template: 'vanilla', filesSkipped: [] },
    });
    expect((result as any).scaffold.filesWritten).toEqual(expect.arrayContaining([
      '/package.json',
      '/public/index.html',
      '/public/main.js',
      '/scripts/build.mjs',
      '/worker.js',
    ]));
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/public/index.html', expect.stringContaining('Vanilla web starter'));
    const writtenPaths = projectStub.projectWriteFile.mock.calls.map(([path]) => path);
    expect(writtenPaths).not.toContain('/app/root.tsx');
    expect(writtenPaths).not.toContain('/components.json');
  });

  it('rejects an invalid create_project template before registering the project', async () => {
    const { fake, workspaceStub } = createProjectToolFake({ projectFileEntries: [] });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'create_project', {
      name: 'New App',
      description: 'A new app',
      template: 'worker',
    })).rejects.toThrow('template must be one of: crud, vanilla, ai-chat, integration-dashboard, data-dashboard, data-analysis');
    // Validation must run first — otherwise the name is burned and a retry
    // with a valid template fails with "Project already exists".
    expect(workspaceStub.createProject).not.toHaveBeenCalled();
  });

  it('adds a dependency to a DO-backed project through the dependency action', async () => {
    const { fake, sandbox, projectStub, chatThreadStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'add_dependency', {
      project: 'Demo App',
      dependency: 'zod@^4',
      dev: true,
    });

    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      backend: 'do-r2',
      projectId: 'project-1',
      dependency: 'zod@^4',
      dev: true,
      stdout: 'added zod',
      packageJsonPersisted: true,
      lockfilePersisted: true,
    });
    expect(sandbox.exec).toHaveBeenCalledWith("bun add -d 'zod@^4'", expect.objectContaining({
      cwd: '/workspace/project-1',
      env: expect.objectContaining({ CAMELAI_PROJECT_ID: 'project-1' }),
    }));
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/package.json', expect.stringContaining('devDependencies'));
    expect(projectStub.projectWriteFile).toHaveBeenCalledWith('/bun.lock', '# zod lockfile\n');
    expect(chatThreadStub.recordProjectActivity).not.toHaveBeenCalled();
  });

  it('opens a clean successful notebook run in preview automatically', async () => {
    const { fake, projectStub, chatThreadStub } = createProjectToolFake({
      projectFileEntries: [['/analysis.ipynb', '{"cells":[]}']],
    });
    const runNotebook = vi.fn(async () => ({
      ok: true,
      executed: true,
      validation: { clean: true, issues: [] },
      stdout: '',
      stderr: '',
      exitCode: 0,
      changedFiles: ['analysis.ipynb'],
      removedFiles: [],
      skippedOversize: [],
      durationMs: 42,
    }));
    fake.ctx.exports = { AnalysisService: vi.fn(() => ({ runNotebook })) };
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'run_notebook', {
      project: 'Demo App',
      path: 'analysis.ipynb',
    });

    expect(runNotebook).toHaveBeenCalledWith({
      projectId: 'project-1',
      path: 'analysis.ipynb',
      timeoutMs: undefined,
    });
    expect(projectStub.projectExists).toHaveBeenCalledWith('/analysis.ipynb');
    expect(result).toMatchObject({
      ok: true,
      project: 'Demo App',
      message: 'Executed and previewed analysis.ipynb',
      preview: {
        success: true,
        target: {
          kind: 'file',
          source: 'project',
          workspaceId: 'workspace1',
          path: '/analysis.ipynb',
          project: 'Demo App',
          filename: 'analysis.ipynb',
          contentType: 'application/x-ipynb+json',
        },
      },
    });
    expect(consoleLog).toHaveBeenCalledWith('Executed and previewed analysis.ipynb');
    expect(chatThreadStub.setPreviewTarget).toHaveBeenCalledWith((result as any).preview.target);
  });

  it('leaves preview unchanged when a notebook run fails', async () => {
    const { fake, chatThreadStub } = createProjectToolFake({
      projectFileEntries: [['/analysis.ipynb', '{"cells":[]}']],
    });
    const runNotebook = vi.fn(async () => ({
      ok: false,
      executed: false,
      validation: { clean: false, issues: ['cell failed'] },
      stdout: '',
      stderr: 'ValueError: bad data',
      exitCode: 1,
      changedFiles: ['analysis.ipynb'],
      removedFiles: [],
      skippedOversize: [],
      durationMs: 42,
      error: 'ValueError: bad data',
    }));
    fake.ctx.exports = { AnalysisService: vi.fn(() => ({ runNotebook })) };

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'run_notebook', {
      project: 'Demo App',
      path: 'analysis.ipynb',
    });

    expect(result).toMatchObject({ ok: false, project: 'Demo App' });
    expect(result).not.toHaveProperty('preview');
    expect(chatThreadStub.setPreviewTarget).not.toHaveBeenCalled();
  });

  it('builds a DO-backed project immediately after dependency changes are persisted', async () => {
    const { fake, sandbox, projectStub } = createProjectToolFake();

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'add_dependency', {
      project: 'Demo App',
      dependency: 'zod@^4',
      dev: true,
    })).resolves.toMatchObject({
      success: true,
      packageJsonPersisted: true,
    });

    const storedPackageJson = await projectStub.projectReadFile('/package.json');
    expect(storedPackageJson.content).toContain('devDependencies');

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'build_project', {
      project: 'Demo App',
    })).resolves.toMatchObject({
      success: true,
      project: 'Demo App',
      backend: 'do-r2',
    });

    const sourceArchives = sandbox.writeFile.mock.calls
      .filter(([path]) => path === '/workspace/project-1.source.tar')
      .map(([, content]) => atob(content));
    expect(sourceArchives).toHaveLength(2);
    expect(sourceArchives.at(-1)).toContain('devDependencies');
  });

  it('restores a DO-backed project from a source snapshot', async () => {
    const { fake, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'revert_project', {
      project: 'Demo App',
      snapshot_id: 'a'.repeat(64),
    });

    expect(projectStub.projectRestoreSourceSnapshot).toHaveBeenCalledWith('a'.repeat(64));
    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      backend: 'do-r2',
      restored: {
        id: 'a'.repeat(64),
        fileCount: 2,
        totalBytes: 96,
      },
    });
  });

  it('lists project source snapshots through the list_commits action', async () => {
    const { fake, projectStub } = createProjectToolFake();

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'list_commits', {
      project: 'Demo App',
      limit: 5,
    });

    expect(projectStub.projectListSourceSnapshots).toHaveBeenCalledWith(5);
    expect(result).toMatchObject({
      project: 'Demo App',
      backend: 'do-r2',
      count: 1,
      commits: [{
        sha: 'snapshot-1',
        message: 'Deploy Demo App',
        file_count: 2,
        total_bytes: 96,
      }],
    });
  });

  it('deletes DO-backed projects by cleaning files and registry', async () => {
    const { fake, workspaceStub, projectStub } = createProjectToolFake();
    const askUserQuestion = vi.fn(async ({ questions }: any) => ({
      [questions[0].question]: 'Delete',
    }));
    fake.askUserQuestion = askUserQuestion;

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'delete_project', {
      project: 'Demo App',
    });

    expect(result).toMatchObject({
      success: true,
      deleted: ['Demo App'],
      deleted_file_entries: 2,
      deleted_source_snapshots: 1,
      deleted_source_snapshot_blobs: 2,
      message: 'Deleted project "Demo App"',
    });
    expect(askUserQuestion).toHaveBeenCalledWith({
      questions: [expect.objectContaining({
        question: expect.stringContaining('project files and metadata'),
        header: 'Delete project?',
      })],
    });
    expect(projectStub.projectDeleteFile).toHaveBeenCalledWith('/package.json', { recursive: true, force: true });
    expect(projectStub.projectDeleteFile).toHaveBeenCalledWith('/src/index.ts', { recursive: true, force: true });
    expect(projectStub.projectListFiles).toHaveBeenCalledWith('/', { recursive: true, includeHidden: true, limit: 50000 });
    expect(projectStub.projectDeleteSourceSnapshots).toHaveBeenCalled();
    expect(workspaceStub.removeProjects).toHaveBeenCalledWith(['project-1']);
  });

  it('includes deploy artifact metadata in list_apps results', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    fake.env = { WORKER_BASE_URL: 'https://staging.camelai.dev', LOCAL_APP_VANITY_DOMAIN: 'camelai.app' };
    Object.defineProperty(fake, 'orgStub', {
      value: {
        getInfo: vi.fn(async () => ({ slug: 'test-org' })),
        listWorkerScriptsByWorkspace: vi.fn(async () => [{
          script_name: 'demo-app',
          workspace_id: 'workspace1',
          created_by: 'user1',
          created_at: 10,
          updated_at: 20,
          is_public: false,
          preview_status: 'ready',
          project_id: 'project-1',
          commit_sha: 'abc123',
          artifact_cache_key: 'deploy-artifacts/key.json',
          custom_domain_hostname: null,
        }]),
      },
    });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'list_apps', {})).resolves.toMatchObject({
      count: 1,
      apps: [{
        name: 'demo-app',
        project_id: 'project-1',
        commit_sha: 'abc123',
        artifact_cache_key: 'deploy-artifacts/key.json',
      }],
    });
  });

  it('filters list_apps by project or name and caps noisy results', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    fake.env = { WORKER_BASE_URL: 'https://staging.camelai.dev', LOCAL_APP_VANITY_DOMAIN: 'camelai.app' };
    const scripts = [
      { script_name: 'older-app', project_id: 'project-old', updated_at: 10 },
      { script_name: 'miguel-simple-site', project_id: 'project-miguel', updated_at: 30 },
      { script_name: 'miguel-simple-site-preview', project_id: 'project-miguel', updated_at: 20 },
    ].map((script) => ({
      workspace_id: 'workspace1',
      created_by: 'user1',
      created_at: 1,
      is_public: false,
      preview_status: 'ready',
      commit_sha: null,
      artifact_cache_key: null,
      custom_domain_hostname: null,
      ...script,
    }));
    Object.defineProperty(fake, 'orgStub', {
      value: {
        getInfo: vi.fn(async () => ({ slug: 'test-org' })),
        listWorkerScriptsByWorkspace: vi.fn(async () => scripts),
      },
    });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'list_apps', {
      project: 'project-miguel',
      limit: 1,
    })).resolves.toMatchObject({
      total: 2,
      count: 1,
      filters: { project: 'project-miguel', limit: 1, sort: 'updated_desc' },
      apps: [{ name: 'miguel-simple-site' }],
    });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'list_apps', {
      name: 'preview',
    })).resolves.toMatchObject({
      total: 1,
      count: 1,
      apps: [{ name: 'miguel-simple-site-preview' }],
    });
  });

  it('lists cached deploy versions for rollback discovery', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'orgStub', {
      value: {
        getWorkerScript: vi.fn(async () => ({ script_name: 'demo-app', workspace_id: 'workspace1' })),
        listWorkerScriptDeployVersions: vi.fn(async (_scriptName: string, workspaceId: string, limit: number) => [{
          id: 'deploy-1',
          script_name: 'demo-app',
          workspace_id: workspaceId,
          created_at: 20,
          created_by: 'user1',
          config_path: 'wrangler.jsonc',
          project_id: 'project-1',
          commit_sha: 'abc123',
          artifact_cache_key: 'deploy-artifacts/key.json',
          limit,
        }]),
      },
    });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'list_deploy_versions', {
      script_name: 'demo-app',
      limit: 5,
    })).resolves.toMatchObject({
      app: 'demo-app',
      count: 1,
      versions: [{
        id: 'deploy-1',
        project_id: 'project-1',
        commit_sha: 'abc123',
        artifact_cache_key: 'deploy-artifacts/key.json',
        config_path: 'wrangler.jsonc',
      }],
    });
    expect(fake.orgStub.listWorkerScriptDeployVersions).toHaveBeenCalledWith('demo-app', 'workspace1', 5);
  });

  it('builds and directly deploys a DO-backed project through the deploy action', async () => {
    const { fake, env, orgStub, chatThreadStub } = createProjectToolFake({ deploy: true });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetchMock = vi.fn(async () => Response.json({ success: true, result: { id: 'version-1' } }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
      script_name: 'Demo App',
    });

    expect(result).toMatchObject({
      success: true,
      project: 'Demo App',
      scriptName: 'demo-app',
      dispatchScriptName: 'demo-app--test-org',
      status: 200,
      buildSuccess: true,
      sourceSnapshot: { id: 'snapshot-1' },
      deploy: {
        scriptName: 'demo-app',
        dispatchScriptName: 'demo-app--test-org',
        status: 200,
      },
    });
    expect((result as any).url).toContain('demo-app--test-org');
    expect((result as any).appUrl).toContain('demo-app--test-org');
    expect((result as any).message).toBe(`Deployed and previewed at ${(result as any).appUrl}`);
    expect(consoleLog).toHaveBeenCalledWith(`Deployed and previewed at ${(result as any).appUrl}`);
    expect((result as any).preview).toMatchObject({
      success: true,
      target: { kind: 'app', scriptName: 'demo-app', isPublic: false },
    });
    expect((result as any).build).not.toHaveProperty('stdout');
    expect((result as any).build).not.toHaveProperty('stderr');
    expect((result as any).deploy).not.toHaveProperty('result');
    // Success results stay compact: no timings blobs or stdout tails for the
    // model to carry (agent-reported friction rendering large deploy results).
    expect((result as any).build).not.toHaveProperty('timings');
    expect((result as any).deploy).not.toHaveProperty('timings');
    expect((result as any).build).not.toHaveProperty('workdir');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account/workers/dispatch/namespaces/namespace/scripts/demo-app--test-org',
      expect.objectContaining({ method: 'PUT', headers: { Authorization: 'Bearer token' } }),
    );
    expect(orgStub.registerWorkerScript).toHaveBeenCalledWith('demo-app', 'workspace1', 'user1', undefined, 'project-1', 'snapshot-1', expect.stringMatching(/^deploy-artifacts\//));
    expect(env.APP_KV.put).toHaveBeenCalledWith('script:demo-app--test-org', JSON.stringify({ org_id: 'org1', org_slug: 'test-org', is_public: false }));
    expect(chatThreadStub.recordProjectActivity).toHaveBeenCalledWith({
      projectId: 'project-1',
      activityType: 'deployed',
    });
    expect(chatThreadStub.recordVerifiedWorkEvidence).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'deploy_project',
        status: 'succeeded',
        supportedClaims: ['deployed', 'published'],
      }),
    );
    expect(chatThreadStub.setPreviewTarget).toHaveBeenCalledWith({
      kind: 'app',
      scriptName: 'demo-app',
      isPublic: false,
    });
  });

  it('requires explicit publication intent before deploying a data-analysis notebook', async () => {
    const { fake } = createProjectToolFake({
      deploy: true,
      projectFileEntries: [['/analysis.ipynb', '{"cells":[],"nbformat":4,"nbformat_minor":5}']],
    });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
      path: 'analysis.ipynb',
    })).rejects.toThrow("publish_intent='user_requested'");
  });

  it('validates through deploy_project dry_run without deploying or changing preview', async () => {
    const { fake, sandbox, orgStub, chatThreadStub } = createProjectToolFake({ deploy: true });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
      dry_run: true,
    });

    expect(result).toMatchObject({
      success: true,
      dryRun: true,
      stage: 'build',
      project: 'Demo App',
    });
    expect(sandbox.exec).toHaveBeenCalledWith('bun install && bun run build', expect.anything());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(orgStub.registerWorkerScript).not.toHaveBeenCalled();
    expect(chatThreadStub.setPreviewTarget).not.toHaveBeenCalled();
    expect(chatThreadStub.recordProjectActivity).not.toHaveBeenCalled();
  });

  it('warns when a local deploy may need the local dispatcher worker for reachability', async () => {
    const { fake } = createProjectToolFake({ deploy: true });
    fake.env = { ...fake.env, WORKER_BASE_URL: 'https://snowboard-owl.exe.xyz:3001' };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: true, result: { id: 'version-1' } }, { status: 200 })));

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
    });

    expect((result as any).warnings).toEqual([
      expect.stringContaining('chiridion-dispatcher-local'),
    ]);
  });

  it('uses a configured remote dispatcher app domain in local dev without local dispatcher warning', async () => {
    const { fake } = createProjectToolFake({ deploy: true });
    fake.env = {
      ...fake.env,
      WORKER_BASE_URL: 'https://snowboard-owl.exe.xyz:3001',
      CF_DISPATCH_NAMESPACE: 'chiridion-platform-evals',
      CF_WORKER_NAME: 'chiridion-app-staging',
      LOCAL_APP_VANITY_DOMAIN: 'evals.camelai.app',
      LOCAL_APP_IFRAME_DOMAIN: 'apps.evals.camelai.dev',
    };
    const fetchMock = vi.fn(async () => Response.json({ success: true, result: { id: 'version-1' } }, { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
    });

    expect((result as any).appUrl).toBe('https://demo-app--test-org.evals.camelai.app');
    expect((result as any).warnings).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.cloudflare.com/client/v4/accounts/account/workers/dispatch/namespaces/chiridion-platform-evals/scripts/demo-app--test-org',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('returns a concise deploy-stage error summary without full build logs', async () => {
    const { fake, chatThreadStub } = createProjectToolFake({ deploy: true });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      success: false,
      errors: [{ message: 'Uncaught Error: Dynamic require of "util" is not supported' }],
    }, { status: 400 })));

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'deploy_project', {
      project: 'Demo App',
      script_name: 'Demo App',
    });

    expect(result).toMatchObject({
      success: false,
      stage: 'deploy',
      project: 'Demo App',
      scriptName: 'demo-app',
      dispatchScriptName: 'demo-app--test-org',
      status: 400,
      errorSummary: 'Uncaught Error: Dynamic require of "util" is not supported',
      build: {
        success: true,
        projectId: 'project-1',
      },
      deploy: {
        success: false,
        status: 400,
        errorSummary: 'Uncaught Error: Dynamic require of "util" is not supported',
      },
    });
    expect((result as any).build).not.toHaveProperty('stdout');
    expect((result as any).build).not.toHaveProperty('stderr');
    expect(chatThreadStub.recordProjectActivity).not.toHaveBeenCalled();
  });

  it('keeps take_screenshot output concise unless inline image data is requested', async () => {
    const capture = vi.fn(async () => ({
      imageDataUrl: 'data:image/png;base64,' + 'a'.repeat(100),
      width: 1280,
      height: 720,
    }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = {
      props: { orgId: 'org1', workspaceId: 'workspace1' },
      exports: {
        AppScreenshotBinding: vi.fn(() => ({ capture })),
        AppBrowserBinding: vi.fn(() => ({ launch: vi.fn() })),
      },
    };

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'take_screenshot', {
      script_name: 'demo-app',
      path: '/',
    })).resolves.toEqual({
      success: true,
      width: 1280,
      height: 720,
      imageDataUrlBytes: 122,
      message: expect.stringContaining('include_image_data_url=true'),
    });

    await expect(CodeModeToolsBinding.prototype.callTool.call(fake, 'take_screenshot', {
      script_name: 'demo-app',
      include_image_data_url: true,
    })).resolves.toMatchObject({
      imageDataUrl: expect.stringContaining('data:image/png;base64,'),
      width: 1280,
      height: 720,
    });
  });

  it('serves deterministic automation virtual files through js_exec file tools', async () => {
    const source = 'import { WorkflowEntrypoint } from "cloudflare:workers";\nexport class AutomationWorkflow extends WorkflowEntrypoint {}\n';
    const updatedSource = source.replace('WorkflowEntrypoint {}', 'WorkflowEntrypoint { async run() { return { ok: true }; } }');
    const cronStub = {
      listDeterministicAutomations: vi.fn(async () => [{
        id: 'automation-1',
        name: 'Automation',
        description: null,
        source,
        source_version: 1,
        cron_expression: '0 9 * * *',
        enabled: true,
        created_by: 'user1',
        created_at: 1,
        updated_at: 1,
        next_run_at: null,
        last_run_at: null,
        last_run_status: null,
        last_run_error: null,
        last_instance_id: null,
        run_count: 0,
      }]),
      getDeterministicAutomationSource: vi.fn(async () => ({
        automation_id: 'automation-1',
        workspace_id: 'workspace1',
        source_version: 1,
        source,
        created_by: 'user1',
      })),
      updateDeterministicAutomation: vi.fn(async (_input) => ({
        id: 'automation-1',
        name: 'Automation',
        description: null,
        source: updatedSource,
        source_version: 2,
        cron_expression: '0 9 * * *',
        enabled: true,
        created_by: 'user1',
        created_at: 1,
        updated_at: 2,
        next_run_at: null,
        last_run_at: null,
        last_run_status: null,
        last_run_error: null,
        last_instance_id: null,
        run_count: 0,
      })),
    };
    const containerTool = vi.fn(async () => {
      throw new Error('workspace tool should not be called for automation virtual files');
    });
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { workspaceId: 'workspace1' } };
    Object.defineProperty(fake, 'cronStub', { value: cronStub });
    Object.defineProperty(fake, 'piContainerTools', {
      value: { callTool: containerTool },
    });

    const listing = await CodeModeToolsBinding.prototype.callTool.call(fake, 'ls', {
      location: 'workspace',
      path: '/workspace/.camelai/automations',
    });
    expect((listing as any).text).toContain('automation-1.js');

    const read = await CodeModeToolsBinding.prototype.callTool.call(fake, 'read', {
      location: 'workspace',
      path: '/workspace/.camelai/automations/automation-1.js',
    });
    expect((read as any).text).toContain('AutomationWorkflow');

    const edit = await CodeModeToolsBinding.prototype.callTool.call(fake, 'edit', {
      location: 'workspace',
      path: '/workspace/.camelai/automations/automation-1.js',
      edits: [{ oldText: 'WorkflowEntrypoint {}', newText: 'WorkflowEntrypoint { async run() { return { ok: true }; } }' }],
    });
    expect((edit as any).text).toContain('source version 2');
    expect(cronStub.updateDeterministicAutomation).toHaveBeenCalledWith({
      workspaceId: 'workspace1',
      id: 'automation-1',
      source: updatedSource,
      expectedSourceVersion: 1,
    });
    expect(containerTool).not.toHaveBeenCalled();
  });

  it('runs the Pi js_exec tool through the DO code mode runner', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => {
            throw new Error('generic tool binding should not handle js_exec');
          }),
        })),
      },
    };
    fake.runCodeModeJavascript = vi.fn(async () => ({
      text: 'done',
      status: 'completed',
      artifacts: [{ id: 'artifact-1', kind: 'email' }],
    }));

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });
    const jsExec = tools.find((tool: any) => tool.name === 'js_exec');

    const result = await jsExec.execute('tool3', {
      description: 'run a short code-mode script',
      code: 'text("hello")',
      timeoutMs: 1234,
      maxOutputCharacters: 4321,
    });

    expect(jsExec.parameters.required).toContain('description');
    expect(fake.runCodeModeJavascript).toHaveBeenCalledWith({
      code: 'text("hello")',
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
      toolUseId: 'tool3',
      timeoutMs: 1234,
      maxOutputCharacters: 4321,
    });
    expect(result.content[0].text).toBe('done');
    expect(result.details).toEqual({
      status: 'completed',
      artifacts: [{ id: 'artifact-1', kind: 'email' }],
      text: '[model-visible tool output omitted from details]',
    });
  });

  it('passes user scope into the shared code mode tools binding', async () => {
    const bindingFactory = vi.fn(() => ({
      callTool: vi.fn(async () => ({ ok: true })),
    }));
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: bindingFactory,
      },
    };

    ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });

    expect(bindingFactory).toHaveBeenCalledWith({
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        allowWebTools: false,
      },
    });
  });

  it('exposes restored legacy Pi tools through the shared code mode binding', async () => {
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      ok: true,
      args,
    }));
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({ callTool })),
      },
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });
    const toolNames = tools.map((tool: any) => tool.name);

    expect(toolNames).toEqual(expect.arrayContaining([
      'edit',
      'AskUserQuestion',
      'TodoWrite',
      'set_preview',
      'list_apps',
      'get_latest_logs',
      'prompt_connection_setup',
    ]));
    expect(toolNames).not.toEqual(expect.arrayContaining(['WebSearch', 'WebFetch']));
    expect(toolNames).not.toContain('grep');
    expect(toolNames).not.toContain('find');
    expect(toolNames).not.toContain('list_deterministic_automations');
    // Long-tail-category tools are reachable via js_exec (tools.<name>()) and
    // tools.search(), not advertised as top-level definitions.
    expect(toolNames).not.toContain('list_scheduled_prompts');
    expect(toolNames).not.toContain('list_workflows');
    expect(toolNames).not.toContain('list_integrations');
    expect(toolNames).not.toContain('get_custom_domain');

    const ask = tools.find((tool: any) => tool.name === 'AskUserQuestion');
    const result = await ask.execute('ask-tool-id', {
      questions: [{ question: 'Proceed?' }],
    });

    expect(callTool).toHaveBeenCalledWith('AskUserQuestion', {
      questions: [{ question: 'Proceed?' }],
      toolUseId: 'ask-tool-id',
    });
    expect(result.content[0].text).toContain('"ok": true');
  });

  it('exposes Pi web tools only when assembling the Research child', async () => {
    const callTool = vi.fn(async (_name: string, args: Record<string, unknown>) => ({
      ok: true,
      args,
    }));
    const bindingFactory = vi.fn(() => ({ callTool }));
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: bindingFactory,
      },
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    }, {
      includeSubagents: false,
      includeResearch: false,
      includeOracle: false,
      includeWebTools: true,
    });
    const webSearch = tools.find((tool: any) => tool.name === 'WebSearch');
    const webFetch = tools.find((tool: any) => tool.name === 'WebFetch');

    expect(webSearch.parameters.properties.query).toBeDefined();
    expect(webSearch.parameters.properties.numResults).toBeDefined();
    expect(webFetch.parameters.properties.url).toBeDefined();

    const result = await webSearch.execute('search-tool-id', {
      query: 'Cloudflare Workers',
      numResults: 3,
    });

    expect(callTool).toHaveBeenCalledWith('WebSearch', {
      query: 'Cloudflare Workers',
      numResults: 3,
      toolUseId: 'search-tool-id',
    });
    expect(result.content[0].text).toContain('"ok": true');
    expect(bindingFactory).toHaveBeenCalledWith({
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
        allowWebTools: true,
      },
    });
  });

  it('runs Worker-side WebSearch through provider round-robin with fallback', async () => {
    const kv = {
      get: vi.fn(async () => '0'),
      put: vi.fn(async () => undefined),
    };
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    const orgStub = {
      consumeCapabilityAllowance: vi.fn(async () => ({
        allowed: true,
        remaining: 99,
        reset_at_ms: Date.now() + 60_000,
      })),
      recordUsage: vi.fn(async () => undefined),
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => orgStub),
      },
      APP_KV: kv,
      FIRECRAWL_API_KEY: 'firecrawl-key',
      PARALLEL_API_KEY: 'parallel-key',
      EXA_API_KEY: 'exa-key',
      WEB_PROVIDER_ORDER: 'firecrawl,parallel,exa',
    };
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === 'https://api.firecrawl.dev/v2/search') {
        expect(init?.headers).toMatchObject({ authorization: 'Bearer firecrawl-key' });
        return new Response(JSON.stringify({ error: 'firecrawl down' }), { status: 500 });
      }
      if (url === 'https://api.parallel.ai/v1/search') {
        expect(init?.headers).toMatchObject({ 'x-api-key': 'parallel-key' });
        const body = JSON.parse(String(init?.body));
        expect(body).toMatchObject({
          objective: 'Cloudflare Workers',
          search_queries: ['Cloudflare Workers'],
          session_id: 'thread1',
        });
        return new Response(JSON.stringify({
          usage: [{ name: 'sku_search', count: 1 }],
          results: [{
            title: 'Workers docs',
            url: 'https://developers.cloudflare.com/workers/',
            description: 'Build serverless applications on Cloudflare.',
          }],
        }));
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'WebSearch', {
        query: 'Cloudflare Workers',
        numResults: 3,
      }) as any;

      expect(kv.get).toHaveBeenCalledWith('code-mode:web-provider:index');
      expect(kv.put).toHaveBeenCalledWith('code-mode:web-provider:index', '1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.provider).toBe('parallel');
      expect(result.costUSD).toBe(0.005);
      expect(result.content[0].text).toContain('Workers docs');
      expect(result.results).toEqual([expect.objectContaining({
        title: 'Workers docs',
        url: 'https://developers.cloudflare.com/workers/',
      })]);
      expect(orgStub.consumeCapabilityAllowance).toHaveBeenCalledWith(
        expect.objectContaining({ capability: 'web_search', user_id: 'user1' }),
      );
      expect(orgStub.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'web_search',
          cost_usd: 0.005,
          credit_chargeable: false,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('runs Worker-side WebFetch through the configured provider API', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    const quickAction = vi.fn(async () => Response.json({
      success: false,
      errors: [{ message: 'Unsupported page' }],
    }, { status: 400, headers: { 'X-Browser-Ms-Used': '55' } }));
    const orgStub = {
      consumeCapabilityAllowance: vi.fn(async () => ({
        allowed: true,
        remaining: 199,
        reset_at_ms: Date.now() + 60_000,
      })),
      recordUsage: vi.fn(async () => undefined),
    };
    fake.env = {
      ORG: {
        idFromName: vi.fn((name: string) => name),
        get: vi.fn(() => orgStub),
      },
      APP_KV: {
        get: vi.fn(async () => '0'),
        put: vi.fn(async () => undefined),
      },
      BROWSER: { quickAction },
      EXA_API_KEY: 'exa-key',
      WEB_PROVIDER_ORDER: 'exa',
    };
    fake.ctx = {
      props: {
        orgId: 'org1',
        workspaceId: 'workspace1',
        threadId: 'thread1',
        userId: 'user1',
      },
    };

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://example.com/article') {
        return new Response('', { status: 403 });
      }
      expect(String(input)).toBe('https://api.exa.ai/contents');
      expect(init?.headers).toMatchObject({ 'x-api-key': 'exa-key' });
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        urls: ['https://example.com/article'],
        livecrawl: 'fallback',
        text: { maxCharacters: 1200 },
      });
      return new Response(JSON.stringify({
        costDollars: { total: 0.002 },
        results: [{
          title: 'Example article',
          url: 'https://example.com/article',
          text: 'Fetched article text.',
        }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'WebFetch', {
        url: 'https://example.com/article',
        maxCharacters: 1200,
      }) as any;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(quickAction).toHaveBeenCalledOnce();
      expect(result.provider).toBe('exa');
      expect(result.costUSD).toBe(0.002);
      expect(result.content[0].text).toContain('Fetched article text.');
      expect(orgStub.consumeCapabilityAllowance).toHaveBeenCalledWith(
        expect.objectContaining({ capability: 'web_fetch', user_id: 'user1' }),
      );
      expect(orgStub.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({ source: 'web_fetch', cost_usd: 0.002 }),
      );
      expect(orgStub.recordUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'web_fetch',
          provider: 'cloudflare',
          duration_ms: 55,
          cost_usd: 0,
        }),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('uses directly served markdown before Browser Run for WebFetch', async () => {
    const quickAction = vi.fn();
    const toMarkdown = vi.fn();
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init).toMatchObject({ redirect: 'manual' });
      expect(init?.headers).toMatchObject({
        accept: expect.stringContaining('text/markdown'),
        'user-agent': expect.stringContaining('Mozilla/5.0'),
      });
      return new Response('# Direct page\n\nServed as Markdown without launching a browser. This additional useful paragraph clears the content-quality threshold.', {
        headers: { 'content-type': 'text/markdown; charset=utf-8' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          AI: { toMarkdown } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
      );

      const result = await client.fetch({ url: 'https://example.com/docs' }) as any;

      expect(result).toMatchObject({
        provider: 'direct',
        costUSD: 0,
        results: [{
          url: 'https://example.com/docs',
          text: '# Direct page\n\nServed as Markdown without launching a browser. This additional useful paragraph clears the content-quality threshold.',
        }],
      });
      expect(toMarkdown).not.toHaveBeenCalled();
      expect(quickAction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('normalizes negotiated MDX and preserves a structured omitted-section outline', async () => {
    const quickAction = vi.fn();
    const sections = Array.from({ length: 20 }, (_value, index) => [
      `## Section ${index + 1} {/*section-${index + 1}*/}`,
      '',
      `Useful documentation paragraph ${index + 1}. ${'Detailed explanation. '.repeat(8)}`,
    ].join('\n')).join('\n\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<Intro>\n\n# Reference {/*reference*/}\n\n<InlineToc />\n\n${sections}\n\n</Intro>`,
      { headers: { 'content-type': 'text/markdown' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
      );

      const result = await client.fetch({
        url: 'https://example.com/reference',
        maxCharacters: 1200,
      }) as any;
      const text = result.results[0].text as string;

      expect(result.provider).toBe('direct');
      expect(text.length).toBeLessThanOrEqual(1200);
      expect(text).not.toContain('<Intro>');
      expect(text).not.toContain('<InlineToc />');
      expect(text).not.toContain('{/*');
      expect(text).toContain('Content shortened: showing structured excerpt');
      expect(text).toContain('Omitted sections:');
      expect(text).toContain('Section 20');
      expect(quickAction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not report heading-like lines inside omitted code fences', async () => {
    const markdown = [
      '# Guide',
      '',
      `Introductory material. ${'Useful explanation. '.repeat(28)}`,
      '',
      '```sh',
      '# not a document section',
      'echo example',
      '```',
      '',
      '## Real omitted section',
      '',
      'More useful documentation.',
    ].join('\n');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(markdown, {
      headers: { 'content-type': 'text/markdown' },
    })));
    try {
      const client = new CodeModeWebSearch(
        { APP_KV: { get: vi.fn(), put: vi.fn() } as any },
        'thread1',
      );
      const result = await client.fetch({
        url: 'https://example.com/guide',
        maxCharacters: 800,
      }) as any;
      const text = result.results[0].text as string;

      expect(text).toContain('Real omitted section');
      expect(text).not.toContain('- not a document section');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back when negotiated MDX normalizes to an empty shell', async () => {
    const browserMarkdown = '# Compact page\n\nA concise but useful rendered answer with enough concrete information for an agent to act on safely.';
    const quickAction = vi.fn(async () => Response.json({
      success: true,
      result: browserMarkdown,
    }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `${'<Intro>\n<InlineToc />\n<Steps>\n</Steps>\n</Intro>\n'.repeat(4)}`,
      { headers: { 'content-type': 'text/markdown' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
      );
      const result = await client.fetch({ url: 'https://example.com/shell' }) as any;

      expect(result.provider).toBe('cloudflare');
      expect(result.results[0].text).toBe(browserMarkdown);
      expect(quickAction).toHaveBeenCalledOnce();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('extracts semantic HTML content without page chrome before Browser Run', async () => {
    const quickAction = vi.fn();
    const chrome = Array.from({ length: 40 }, (_value, index) =>
      `<a href="/navigation-${index}">Navigation item ${index}</a>`).join('');
    const forecast = Array.from({ length: 12 }, (_value, index) =>
      `<section><h2>Forecast period ${index + 1}</h2><p>${'Clear conditions with useful forecast details. '.repeat(5)}</p></section>`).join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<!doctype html><html><body><nav>${chrome}</nav><main><h1>Local forecast</h1><p>Current conditions: sunny and 68 degrees.</p>${forecast}</main><footer>${chrome}</footer></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
      );

      const result = await client.fetch({ url: 'https://example.com/forecast' }) as any;
      const text = result.results[0].text as string;

      expect(result.provider).toBe('direct');
      expect(text).toContain('Current conditions: sunny and 68 degrees.');
      expect(text).toContain('Forecast period 12');
      expect(text).not.toContain('Navigation item');
      expect(quickAction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('removes sequential source gutters and closes an oversized fenced-code excerpt', async () => {
    const quickAction = vi.fn();
    const lineNumbers = Array.from({ length: 180 }, (_value, index) => `<p>${index + 1}</p>`).join('');
    const codeLines = Array.from({ length: 180 }, (_value, index) =>
      `<p>export const value${index + 1} = ${index + 1};</p>`).join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<!doctype html><html><body><main><h1>source.ts</h1><div role="presentation">${lineNumbers}${codeLines}</div></main></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
      );

      const result = await client.fetch({
        url: 'https://example.com/source.ts',
        maxCharacters: 1200,
      }) as any;
      const text = result.results[0].text as string;

      expect(result.provider).toBe('direct');
      expect(text.length).toBeLessThanOrEqual(1200);
      expect(text).toMatch(/^```\nexport const value1 = 1;/);
      expect(text).not.toMatch(/```\n1\n2\n3/);
      expect(text.match(/^```$/gm)).toHaveLength(2);
      expect(text).toContain('Content shortened: showing structured excerpt');
      expect(quickAction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('preserves prose around a guttered code sample', async () => {
    const lineNumbers = Array.from({ length: 120 }, (_value, index) => `<p>${index + 1}</p>`).join('');
    const codeLines = Array.from({ length: 120 }, (_value, index) =>
      `<p>const sample${index + 1} = ${index + 1};</p>`).join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<!doctype html><html><body><article><h1>Integration guide</h1><div role="presentation"><p>${'Important setup prose that must remain. '.repeat(8)}</p>${lineNumbers}${codeLines}<h2>After the example</h2><p>${'Important follow-up prose. '.repeat(8)}</p></div></article></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        { APP_KV: { get: vi.fn(), put: vi.fn() } as any },
        'thread1',
      );
      const result = await client.fetch({
        url: 'https://example.com/integration-guide',
        maxCharacters: 5000,
      }) as any;
      const text = result.results[0].text as string;

      expect(text).toContain('Important setup prose that must remain.');
      expect(text).toContain('```');
      expect(text).toContain('const sample1 = 1;');
      expect(text).not.toMatch(/```\n1\n2\n3/);
      expect(text).toContain('After the example');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('removes row-wise source line-number cells', async () => {
    const rows = Array.from({ length: 40 }, (_value, index) =>
      `<tr><td class="blob-num" data-line-number="${index + 1}"></td><td class="blob-code"><code>const row${index + 1} = ${index + 1};</code></td></tr>`
    ).join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<!doctype html><html><body><main><h1>source.ts</h1><table class="source-code"><tbody>${rows}</tbody></table></main></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        { APP_KV: { get: vi.fn(), put: vi.fn() } as any },
        'thread1',
      );
      const result = await client.fetch({ url: 'https://example.com/source.ts' }) as any;
      const text = result.results[0].text as string;

      expect(text).toContain('const row1 = 1;');
      expect(text).toContain('const row40 = 40;');
      expect(text).not.toMatch(/```\n1\s+const row1/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not treat a legitimate numeric sequence as a source gutter', async () => {
    const timeline = Array.from({ length: 120 }, (_value, index) => `<p>${index + 1}</p>`).join('');
    const prose = Array.from({ length: 30 }, (_value, index) =>
      `<p>Milestone ${index + 1} uses equation x = ${index + 1}; the result is documented.</p>`).join('');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<!doctype html><html><body><main><h1>Numbered timeline</h1><div role="presentation">${timeline}${prose}</div></main></body></html>`,
      { headers: { 'content-type': 'text/html' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        { APP_KV: { get: vi.fn(), put: vi.fn() } as any },
        'thread1',
      );
      const result = await client.fetch({ url: 'https://example.com/timeline' }) as any;
      const text = result.results[0].text as string;

      expect(text).toContain('120');
      expect(text).toContain('Milestone 30 uses equation x = 30;');
      expect(text).not.toContain('```');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('converts directly fetched HTML locally before Browser Run', async () => {
    const quickAction = vi.fn();
    const articleContent = 'Useful article content from the direct HTML response. '.repeat(12);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      `<!doctype html><html><body><main><h1>Converted page</h1><p>${articleContent}</p></main></body></html>`,
      { headers: { 'content-type': 'text/html; charset=utf-8' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
      );

      const result = await client.fetch({ url: 'https://example.com/article' }) as any;

      expect(result).toMatchObject({
        provider: 'direct',
        costUSD: 0,
        results: [{ text: expect.stringContaining(articleContent.trim()) }],
      });
      expect(quickAction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to Browser Run when direct HTML conversion has no useful content', async () => {
    const browserMarkdown = `# Browser page\n\n${'Browser-rendered content survived the quality check. '.repeat(12)}`;
    const quickAction = vi.fn(async () => Response.json({
      success: true,
      result: browserMarkdown,
    }, { headers: { 'X-Browser-Ms-Used': '150' } }));
    const onProviderFailure = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<!doctype html><html><body><div id="app"></div></body></html>',
      { headers: { 'content-type': 'text/html' } },
    )));
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
        { onProviderFailure },
      );

      const result = await client.fetch({ url: 'https://example.com/app' }) as any;

      expect(result).toMatchObject({
        provider: 'cloudflare',
        results: [{ text: browserMarkdown.trim() }],
      });
      expect(quickAction).toHaveBeenCalledOnce();
      expect(onProviderFailure).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'direct',
        durationMs: expect.any(Number),
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back without converting an oversized direct response', async () => {
    const browserFallback = `# Browser fallback\n\n${'The oversized direct response was not treated as complete. '.repeat(12)}`;
    const quickAction = vi.fn(async () => Response.json({
      success: true,
      result: browserFallback,
    }));
    const toMarkdown = vi.fn();
    const onProviderFailure = vi.fn(async () => undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      '<!doctype html><html><body>oversized</body></html>',
      {
        headers: {
          'content-type': 'text/html',
          'content-length': '1900001',
        },
      },
    )));
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          AI: { toMarkdown } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
        { onProviderFailure },
      );

      const result = await client.fetch({ url: 'https://example.com/large' }) as any;

      expect(toMarkdown).not.toHaveBeenCalled();
      expect(quickAction).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ provider: 'cloudflare' });
      expect(onProviderFailure).toHaveBeenCalledWith(expect.objectContaining({ provider: 'direct' }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('follows and resolves validated public direct-fetch redirects', async () => {
    const quickAction = vi.fn();
    const toMarkdown = vi.fn();
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://example.com/start') {
        return new Response(null, { status: 302, headers: { location: '/docs/final' } });
      }
      expect(String(input)).toBe('https://example.com/docs/final');
      return new Response(
        '# Redirected page\n\nThe public relative redirect resolved safely and returned enough useful Markdown content.',
        { headers: { 'content-type': 'text/markdown' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          AI: { toMarkdown } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
      );

      const result = await client.fetch({ url: 'https://example.com/start' }) as any;

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result).toMatchObject({
        provider: 'direct',
        results: [{ url: 'https://example.com/docs/final' }],
      });
      expect(toMarkdown).not.toHaveBeenCalled();
      expect(quickAction).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not follow direct-fetch redirects to private targets', async () => {
    const safeFallback = `# Safe fallback\n\n${'Fetched without following the private redirect. '.repeat(12)}`;
    const quickAction = vi.fn(async () => Response.json({
      success: true,
      result: safeFallback,
    }));
    const toMarkdown = vi.fn();
    const fetchMock = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: 'http://169.254.169.254/latest/meta-data/' },
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.stubGlobal('fetch', fetchMock);
    try {
      const client = new CodeModeWebSearch(
        {
          APP_KV: { get: vi.fn(), put: vi.fn() } as any,
          AI: { toMarkdown } as any,
          BROWSER: { quickAction } as unknown as Fetcher,
        },
        'thread1',
      );

      const result = await client.fetch({ url: 'https://example.com/redirect' }) as any;

      expect(fetchMock).toHaveBeenCalledOnce();
      expect(toMarkdown).not.toHaveBeenCalled();
      expect(quickAction).toHaveBeenCalledOnce();
      expect(result).toMatchObject({ provider: 'cloudflare' });
      expect(warn).toHaveBeenCalledWith(
        'Direct web fetch failed; falling back to hosted fetch providers',
        expect.objectContaining({ hostname: 'example.com', errorName: 'Error' }),
      );
    } finally {
      warn.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('uses the Cloudflare Browser Run Content Quick Action first for WebFetch', async () => {
    const renderedMarkdown = `# Rendered page\n\n${'Rendered by Cloudflare with useful page content. '.repeat(12)}`;
    const quickAction = vi.fn(async () => Response.json({
      success: true,
      result: renderedMarkdown,
    }, { headers: { 'X-Browser-Ms-Used': '142' } }));
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));
    const client = new CodeModeWebSearch(
      {
        APP_KV: { get: vi.fn(), put: vi.fn() } as any,
        BROWSER: { quickAction } as unknown as Fetcher,
        EXA_API_KEY: 'exa-key',
      },
      'thread1',
    );

    const result = await client.fetch({ url: 'https://example.com/article' }) as any;

    expect(quickAction).toHaveBeenCalledWith('content', expect.objectContaining({
      url: 'https://example.com/article',
      cacheTTL: 300,
      actionTimeout: 5_000,
      bestAttempt: true,
      gotoOptions: {
        waitUntil: 'domcontentloaded',
        timeout: 3_000,
      },
      rejectResourceTypes: ['stylesheet', 'image', 'media', 'font'],
      rejectRequestPattern: expect.arrayContaining([
        expect.stringContaining('localhost'),
        expect.stringContaining('169'),
      ]),
    }));
    const quickActionOptions = quickAction.mock.calls[0][1] as {
      rejectRequestPattern: string[];
    };
    const redirectDenyRegexes = quickActionOptions.rejectRequestPattern.map((pattern) => {
      const match = pattern.match(/^\/(.*)\/([a-z]*)$/i);
      if (!match) throw new Error(`Invalid reject request pattern: ${pattern}`);
      return new RegExp(match[1], match[2]);
    });
    for (const redirectUrl of [
      'http://localhost/',
      'http://localhost.localdomain/',
      'http://nested.dev.localhost/',
      'http://service.local/',
      'http://metadata.internal/',
      'http://100.64.0.1/',
      'http://100.127.255.255/',
      'http://224.0.0.1/',
      'http://255.255.255.255/',
      'http://[fe90::1]/',
      'https://user:secret@example.com/',
    ]) {
      expect(
        redirectDenyRegexes.some((pattern) => pattern.test(redirectUrl)),
        `redirect deny policy should cover ${redirectUrl}`,
      ).toBe(true);
    }
    expect(result).toMatchObject({
      provider: 'cloudflare',
      durationMs: 142,
      results: [{ text: renderedMarkdown.trim() }],
    });
    vi.unstubAllGlobals();
  });

  it('rejects local and private WebFetch targets before calling a provider', async () => {
    const quickAction = vi.fn();
    const client = new CodeModeWebSearch(
      {
        APP_KV: { get: vi.fn(), put: vi.fn() } as any,
        BROWSER: { quickAction } as unknown as Fetcher,
      },
      'thread1',
    );

    for (const url of [
      'http://localhost/admin',
      'http://127.0.0.1/',
      'http://10.0.0.1/',
      'http://169.254.169.254/latest/meta-data/',
      'http://192.168.1.1/',
      'http://[::1]/',
      'http://[fe90::1]/',
      'http://[febf::1]/',
      'https://user:secret@example.com/',
    ]) {
      await expect(client.fetch({ url })).rejects.toThrow();
    }
    expect(quickAction).not.toHaveBeenCalled();
  });

  it('surfaces Cloudflare Browser Run errors from the errors array', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('blocked', { status: 403 })));
    const onProviderFailure = vi.fn(async () => undefined);
    const quickAction = vi.fn(async () => Response.json({
      success: false,
      errors: [{ code: 1001, message: 'Quick Action does not support this site' }],
    }, { status: 400, headers: { 'X-Browser-Ms-Used': '77' } }));
    const client = new CodeModeWebSearch(
      {
        APP_KV: { get: vi.fn(), put: vi.fn() } as any,
        BROWSER: { quickAction } as unknown as Fetcher,
      },
      'thread1',
      { onProviderFailure },
    );

    try {
      await expect(client.fetch({ url: 'https://example.com/' })).rejects.toThrow(
        'Quick Action does not support this site (1001)',
      );
      expect(onProviderFailure).toHaveBeenCalledWith(expect.objectContaining({
        provider: 'cloudflare',
        durationMs: 77,
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back from Cloudflare Browser Run to Exa for unsupported pages', async () => {
    const cloudflareFetch = vi.fn(async () => {
      throw new Error('page contained no readable text');
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === 'https://example.com/article') {
        return new Response('', { status: 403 });
      }
      return new Response(JSON.stringify({
        costDollars: { total: 0.002 },
        results: [{
          title: 'Fallback page',
          url: 'https://example.com/article',
          text: 'Fetched through Exa.',
        }],
      }));
    });
    vi.stubGlobal('fetch', fetchMock);
    const client = new CodeModeWebSearch(
      {
        APP_KV: { get: vi.fn(), put: vi.fn() } as any,
        BROWSER: {} as Fetcher,
        EXA_API_KEY: 'exa-key',
        FIRECRAWL_API_KEY: 'firecrawl-key',
        WEB_PROVIDER_ORDER: 'firecrawl,parallel,exa',
      },
      'thread1',
      { cloudflareFetch },
    );

    const result = await client.fetch({ url: 'https://example.com/article' }) as any;

    expect(cloudflareFetch).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.exa.ai/contents',
      expect.any(Object),
    );
    expect(result).toMatchObject({
      provider: 'exa',
      results: [{ text: 'Fetched through Exa.' }],
    });
  });

  it('uses Pi-style schemas for restored file and shell tools', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => ({ text: 'ok' })),
        })),
      },
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    });
    const byName = new Map(tools.map((tool: any) => [tool.name, tool]));

    expect((byName.get('edit') as any).parameters.properties.edits).toBeDefined();
    expect((byName.get('edit') as any).parameters.properties.old_string).toBeUndefined();
    expect(byName.get('bash')).toBeUndefined();
    expect(byName.get('grep')).toBeUndefined();
    expect(byName.get('find')).toBeUndefined();
  });

  it('routes restored search tools through workspace file operations', async () => {
    const callTool = vi.fn(async () => ({
      text: 'app.ts:1: hello',
    }));
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    Object.defineProperty(fake, 'piContainerTools', {
      value: { callTool },
    });

    const result = await CodeModeToolsBinding.prototype.callTool.call(fake, 'grep', {
      location: 'workspace',
      pattern: 'hello',
      path: 'src',
      literal: true,
      limit: 2,
    });

    expect(result.text).toBe('app.ts:1: hello');
    expect(callTool).toHaveBeenCalledWith('grep', {
      location: 'workspace',
      pattern: 'hello',
      path: 'src',
      literal: true,
      limit: 2,
    });
  });

  it('normalizes AskUserQuestion string options before broadcasting to the browser', async () => {
    vi.useFakeTimers();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.broadcastChat = vi.fn();
    fake.browserPrompts = new BrowserPromptCoordinator({
      hasAvailableBrowserUser: () => true,
      broadcast: fake.broadcastChat,
      sendDirect: vi.fn(),
      askUserQuestionUnavailableMessage: 'unavailable',
      questionTimeoutMs: 30 * 60 * 1000,
      connectionSetupTimeoutMs: 30 * 60 * 1000,
    });

    const promise = ChatThreadDO.prototype.askUserQuestion.call(fake, {
      toolUseId: 'tool-ask',
      questions: [{
        question: "What's your favorite programming language?",
        options: ['TypeScript', 'Python', 'Go'],
      }],
    });

    expect(fake.broadcastChat).toHaveBeenCalledWith({
      type: 'ask_user_question',
      questionId: expect.any(String),
      toolUseId: 'tool-ask',
      questions: [{
        question: "What's your favorite programming language?",
        header: '',
        multiSelect: false,
        allowOther: true,
        options: [
          { label: 'TypeScript', description: '' },
          { label: 'Python', description: '' },
          { label: 'Go', description: '' },
        ],
      }],
    });

    const prompt = fake.broadcastChat.mock.calls[0][0];
    fake.browserPrompts.answerQuestion({
      questionId: prompt.questionId,
      answers: { answer: 'TypeScript' },
    });
    await expect(promise).resolves.toEqual({ answer: 'TypeScript' });
    vi.useRealTimers();
  });

  it('normalizes AskUserQuestion multi_select type before broadcasting to the browser', async () => {
    vi.useFakeTimers();
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.broadcastChat = vi.fn();
    fake.browserPrompts = new BrowserPromptCoordinator({
      hasAvailableBrowserUser: () => true,
      broadcast: fake.broadcastChat,
      sendDirect: vi.fn(),
      askUserQuestionUnavailableMessage: 'unavailable',
      questionTimeoutMs: 30 * 60 * 1000,
      connectionSetupTimeoutMs: 30 * 60 * 1000,
    });

    const promise = ChatThreadDO.prototype.askUserQuestion.call(fake, {
      toolUseId: 'tool-ask',
      questions: [{
        id: 'multiselect-test',
        type: 'multi_select',
        question: 'Multi-select rendering test: please select all fruits you like.',
        options: [
          { label: 'Apple', value: 'apple' },
          { label: 'Banana', value: 'banana' },
          { label: 'Mango', value: 'mango' },
          { label: 'Strawberry', value: 'strawberry' },
        ],
        required: false,
      }],
    });

    expect(fake.broadcastChat).toHaveBeenCalledWith({
      type: 'ask_user_question',
      questionId: expect.any(String),
      toolUseId: 'tool-ask',
      questions: [{
        question: 'Multi-select rendering test: please select all fruits you like.',
        header: '',
        multiSelect: true,
        allowOther: true,
        options: [
          { label: 'Apple', description: '' },
          { label: 'Banana', description: '' },
          { label: 'Mango', description: '' },
          { label: 'Strawberry', description: '' },
        ],
      }],
    });

    const prompt = fake.broadcastChat.mock.calls[0][0];
    fake.browserPrompts.answerQuestion({
      questionId: prompt.questionId,
      answers: {
        'Multi-select rendering test: please select all fruits you like.':
          'Apple, Mango',
      },
    });
    await expect(promise).resolves.toEqual({
      'Multi-select rendering test: please select all fruits you like.':
        'Apple, Mango',
    });
    vi.useRealTimers();
  });

  it('does not emit placeholder tool rows for unnamed preliminary Pi toolcall events', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'toolcall_start',
        toolCall: { id: 'tool1' },
      },
    });

    expect(events.filter((event) => event.type === 'runtime_event')).toEqual([]);

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_start',
      toolCallId: 'tool1',
      toolName: 'AskUserQuestion',
      args: {
        questions: [{ question: 'Proceed?', options: ['Yes', 'No'] }],
      },
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    expect(runtimeEvents).toHaveLength(1);
    expect(runtimeEvents[0].event.method).toBe('item/started');
    expect(runtimeEvents[0].event.params.item).toMatchObject({
      id: 'tool1',
      type: 'dynamicToolCall',
      tool: 'AskUserQuestion',
      status: 'running',
    });
  });

  it('exposes shared Research and camelCode-only Oracle without recursive capability agents', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => ({ text: 'ok' })),
        })),
      },
    };

    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };
    const rootTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    expect(rootTools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(['Agent', 'Explore', 'Research']),
    );
    expect(rootTools.map((tool: any) => tool.name)).not.toContain('Oracle');
    expect(rootTools.map((tool: any) => tool.name)).not.toContain('WebSearch');
    expect(rootTools.map((tool: any) => tool.name)).not.toContain('WebFetch');
    const research = rootTools.find((tool: any) => tool.name === 'Research');
    expect(research?.description).toContain('one focused question');
    expect(research?.description).toContain('current or external factual lookup');
    expect(research?.description).not.toContain('Oracle');
    expect(rootTools.map((tool: any) => tool.name)).not.toEqual(
      expect.arrayContaining(['agent', 'explore']),
    );
    expect(rootTools.find((tool: any) => tool.name === 'Agent')?.executionMode).toBe('sequential');

    const childTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context, {
      includeSubagents: false,
    });
    expect(childTools.map((tool: any) => tool.name)).not.toEqual(
      expect.arrayContaining(['Agent', 'Explore']),
    );

    const camelCodeTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context, {
      includeOracle: true,
    });
    expect(camelCodeTools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining(['Research', 'Oracle']),
    );
    const camelCodeResearch = camelCodeTools.find((tool: any) => tool.name === 'Research');
    expect(camelCodeResearch?.description).toBe(research?.description);
    const oracle = camelCodeTools.find((tool: any) => tool.name === 'Oracle');
    expect(oracle?.description).toContain('especially after failed attempts');
    expect(oracle?.description).toContain('inspect, edit, and verify the workspace');
    expect(oracle?.description).toContain('difficult architecture, debugging, planning, or implementation');
    expect(oracle?.description).not.toContain('Research');
    expect(oracle?.description).not.toMatch(/gpt|luna|model/i);

    for (const activeModel of [
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'deepseek-v4-pro',
      'claude-sonnet-4-6',
      'custom',
      null,
    ]) {
      fake.currentThreadModel = activeModel;
      expect(
        ChatThreadDO.prototype['isCamelCodeActive'].call(fake),
        `Oracle policy must be disabled for ${activeModel ?? 'no active model'}`,
      ).toBe(false);
    }
    fake.currentThreadModel = 'deepseek-v4-auto';
    expect(ChatThreadDO.prototype['isCamelCodeActive'].call(fake)).toBe(true);
    expect(ChatThreadDO.prototype['isCamelCodeActive'].call(fake, {
      CHIRIDION_MODEL: 'gpt-5.6-sol',
    })).toBe(false);
    expect(ChatThreadDO.prototype['isCamelCodeActive'].call(fake, {
      CHIRIDION_MODEL: 'deepseek-v4-auto',
    })).toBe(true);

    const capabilityChildTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context, {
      includeSubagents: false,
      includeResearch: false,
      includeOracle: false,
    });
    expect(capabilityChildTools.map((tool: any) => tool.name)).not.toEqual(
      expect.arrayContaining(['Agent', 'Explore', 'Research', 'Oracle']),
    );
    expect(capabilityChildTools.map((tool: any) => tool.name)).not.toContain('WebSearch');
    expect(capabilityChildTools.map((tool: any) => tool.name)).not.toContain('WebFetch');

    const oracleChildTools = ChatThreadDO.prototype['createPiToolDefinitions'].call(
      fake,
      context,
      capabilityAgentToolOptions('Oracle'),
    );
    const oracleChildToolNames = oracleChildTools.map((tool: any) => tool.name);
    expect(oracleChildToolNames).toContain('Research');
    expect(oracleChildToolNames).not.toContain('Agent');
    expect(oracleChildToolNames).not.toContain('Explore');
    expect(oracleChildToolNames).not.toContain('Oracle');
    expect(oracleChildToolNames).not.toContain('WebSearch');
    expect(oracleChildToolNames).not.toContain('WebFetch');
  });

  it('keeps Oracle when refreshing an active camelCode session', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const refreshedModel = { id: 'dynamic/deepseek-v4-auto' };
    fake.piSession = { state: { model: null, tools: [] } };
    fake.piModelResolver = vi.fn(async () => ({ model: refreshedModel }));
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };
    fake.currentThreadModel = 'deepseek-v4-auto';
    fake.createPiToolDefinitions = vi.fn(() => []);

    await ChatThreadDO.prototype['refreshPiSessionModel'].call(fake);

    expect(fake.piSession.state.model).toEqual({
      ...refreshedModel,
      maxTokens: PI_MAIN_REQUEST_DEFAULT_OUTPUT_TOKENS,
    });
    expect(fake.piSession.state.systemPrompt).toContain('Use `Oracle` when the user asks for it');
    expect(fake.createPiToolDefinitions).toHaveBeenCalledWith(
      fake.chatContext,
      { includeOracle: true },
    );
  });

  it('does not mutate a Pi session disposed while its model is resolving', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const session = { state: { model: null, tools: [] } };
    fake.piSession = session;
    fake.piModelResolver = vi.fn(async () => {
      fake.piSession = null;
      return { model: { id: 'dynamic/deepseek-v4-auto' } };
    });
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };
    fake.createPiToolDefinitions = vi.fn(() => []);

    await expect(
      ChatThreadDO.prototype['refreshPiSessionModel'].call(fake),
    ).resolves.toBeUndefined();

    expect(session.state.model).toBeNull();
    expect(fake.createPiToolDefinitions).not.toHaveBeenCalled();
  });

  it('removes Oracle when refreshing any non-camelCode session', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const refreshedModel = { id: 'openai/gpt-5.6-sol' };
    fake.piSession = { state: { model: null, tools: [{ name: 'Oracle' }] } };
    fake.piModelResolver = vi.fn(async () => ({ model: refreshedModel }));
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };
    fake.currentThreadModel = 'gpt-5.6-sol';
    fake.createPiToolDefinitions = vi.fn((_context: unknown, options: any) =>
      options.includeOracle ? [{ name: 'Oracle' }] : []
    );

    await ChatThreadDO.prototype['refreshPiSessionModel'].call(fake);

    expect(fake.piSession.state.model).toEqual({
      ...refreshedModel,
      maxTokens: PI_MAIN_REQUEST_DEFAULT_OUTPUT_TOKENS,
    });
    expect(fake.piSession.state.tools).toEqual([]);
    expect(fake.piSession.state.systemPrompt).not.toContain('Oracle');
    expect(fake.createPiToolDefinitions).toHaveBeenCalledWith(
      fake.chatContext,
      { includeOracle: false },
    );
  });

  it('drops long-tail-category passthrough tools from the top-level list but keeps core + lifecycle + human-input tools', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => ({ text: 'ok' })),
        })),
      },
    };
    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };

    const toolNames = new Set(
      ChatThreadDO.prototype['createPiToolDefinitions']
        .call(fake, context)
        .map((tool: any) => tool.name),
    );

    // Core tools and subagents are always present.
    for (const name of ['read', 'write', 'edit', 'delete', 'ls', 'js_exec', 'Agent', 'Explore', 'Research']) {
      expect(toolNames.has(name)).toBe(true);
    }
    expect(toolNames.has('WebSearch')).toBe(false);
    expect(toolNames.has('WebFetch')).toBe(false);

    // Human-input passthrough tools stay top-level (cannot run inside js_exec).
    for (const name of ['prompt_connection_setup', 'delete_connection', 'delete_project', 'AskUserQuestion']) {
      expect(toolNames.has(name)).toBe(true);
    }

    // App/project-lifecycle tools stay top-level (discovery-sensitive on complex
    // build+deploy tasks).
    for (const name of ['read_skill', 'list_projects', 'create_project', 'list_apps', 'set_preview', 'TodoWrite']) {
      expect(toolNames.has(name)).toBe(true);
    }

    // Long-tail-category passthrough tools are NOT advertised top-level; the agent
    // reaches them via tools.search() / tools.<name>() inside js_exec.
    for (const name of ['list_integrations', 'create_workflow', 'list_scheduled_prompts', 'get_custom_domain']) {
      expect(toolNames.has(name)).toBe(false);
    }
  });

  it('callToolEnvelope returns tool failures as values so no exception crosses the RPC boundary', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.ctx = { props: { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1', userId: 'user1' } };
    fake.env = {
      OBSERVABILITY_EVENTS: { writeDataPoint: vi.fn() },
      ERROR_ANALYTICS: { writeDataPoint: vi.fn() },
    };
    fake.callTool = vi.fn(async (name: string) => {
      if (name === 'deploy_project') throw new Error('Network connection lost.');
      return { created: true };
    });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await expect(fake.callToolEnvelope('list_apps', {})).resolves.toEqual({
        ok: true,
        data: { created: true },
      });
      await expect(fake.callToolEnvelope('deploy_project', { secret: 'do-not-log' })).resolves.toEqual({
        ok: false,
        error: { tool: 'deploy_project', message: 'Network connection lost.', origin: 'tool' },
      });
      expect(consoleError).toHaveBeenCalledWith(
        '[code-mode] project tool call failed',
        expect.objectContaining({
          toolName: 'deploy_project',
          origin: 'tool',
          workspaceId: 'workspace1',
          threadId: 'thread1',
          error: 'Network connection lost.',
        }),
      );
      expect(fake.env.OBSERVABILITY_EVENTS.writeDataPoint).toHaveBeenCalledTimes(1);
      expect(fake.env.ERROR_ANALYTICS.writeDataPoint).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain('do-not-log');
      expect(JSON.stringify(fake.env.OBSERVABILITY_EVENTS.writeDataPoint.mock.calls)).not.toContain('do-not-log');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('returns compact, provider-agnostic WebSearch and WebFetch values to js_exec', async () => {
    const fake = Object.create(CodeModeToolsBinding.prototype) as any;
    fake.callTool = vi.fn(async (name: string) => ({
      content: [{ type: 'text', text: 'formatted legacy content' }],
      costUSD: 0.007,
      provider: 'exa',
      success: true,
      url: 'https://example.com/article',
      results: [{
        title: 'Example',
        url: 'https://example.com/article',
        publishedDate: '2026-07-15',
        author: 'Camel',
        snippet: 'Short result.',
        text: name === 'WebFetch' ? 'Full page text.' : '',
      }],
    }));

    await expect(fake.callToolEnvelope('WebSearch', {})).resolves.toEqual({
      ok: true,
      data: [{
        title: 'Example',
        url: 'https://example.com/article',
        snippet: 'Short result.',
      }],
    });
    await expect(fake.callToolEnvelope('WebFetch', {})).resolves.toEqual({
      ok: true,
      data: 'Full page text.',
    });
  });

  it('keeps the js_exec description lean: help pointer, deploy nudge, and a names-only inventory of js_exec-only tools', () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => ({ text: 'ok' })),
        })),
      },
    };
    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };

    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    const description = (tools.find((tool: any) => tool.name === 'js_exec') as any).description as string;

    // Executor-style: the always-loaded description points at the on-demand guide
    // instead of inlining it, and lists the hidden tools by name (names are cheap;
    // schemas stay behind tools.search()/tools.describe()).
    expect(description).toContain('await tools.help()');
    for (const name of ['list_integrations', 'create_workflow', 'list_scheduled_prompts', 'get_custom_domain', 'send_email']) {
      expect(description).toContain(name);
    }
    // Human-input tools are advertised top-level, so they must not appear in the
    // js_exec-only inventory (they are named only in the cannot-run-here caveat).
    const inventory = description.slice(
      description.indexOf('Tools reachable ONLY here'),
      description.indexOf('`run_notebook` and `deploy_project`'),
    );
    expect(inventory).toContain('send_email');
    expect(inventory).not.toContain('prompt_connection_setup');
    expect(inventory).not.toContain('delete_connection');
    // The eval-critical automatic-preview nudge stays inline.
    expect(description).toContain('`run_notebook` and `deploy_project` open successful results in preview automatically');
    expect(description).toContain('failures leave preview unchanged');
    expect(description).toContain('No follow-up `set_preview` or `list_apps` call is needed');
    expect(description).toContain('use `set_preview` only for an explicit switch');
    // Executor-style calling shape: result envelope and TypeScript acceptance.
    expect(description).toContain('result.ok');
    expect(description).toContain('TypeScript');
    // The long-form guidance moved behind tools.help(): connections examples, file
    // locations, and VM guidance no longer sit in the always-loaded description.
    expect(description).not.toContain('env.CONNECTIONS.find');
    expect(description).not.toContain('vm.exec({ command');
    expect(description.length).toBeLessThan(2200);
  });

  it('runs the Pi subagent tool with child-agent context', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ctx = {
      exports: {
        CodeModeToolsBinding: vi.fn(() => ({
          callTool: vi.fn(async () => ({ text: 'ok' })),
        })),
      },
    };
    fake.runPiSubagentTool = vi.fn(async () => ({
      content: [{ type: 'text', text: 'child done' }],
      details: { status: 'completed' },
    }));

    const context = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
      userId: 'user1',
    };
    const tools = ChatThreadDO.prototype['createPiToolDefinitions'].call(fake, context);
    const agent = tools.find((tool: any) => tool.name === 'Agent');
    const abortController = new AbortController();
    const onUpdate = vi.fn();

    const result = await agent.execute(
      'tool-agent-1',
      { prompt: 'inspect the workspace' },
      abortController.signal,
      onUpdate,
    );

    expect(fake.runPiSubagentTool).toHaveBeenCalledWith(
      context,
      'Agent',
      { prompt: 'inspect the workspace' },
      abortController.signal,
      onUpdate,
    );
    expect(result.content[0].text).toBe('child done');
  });

  it('maps Pi reasoning and tool events to the old host runtime event shapes', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'thinking_delta',
        contentIndex: 0,
        delta: 'thinking',
      },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_start',
      toolCallId: 'tool1',
      toolName: 'js_exec',
      args: { code: 'return 1', description: 'run it' },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_update',
      toolCallId: 'tool1',
      toolName: 'js_exec',
      args: {},
      partialResult: { content: [{ type: 'text', text: 'hi\n' }], details: {} },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_end',
      toolCallId: 'tool1',
      toolName: 'js_exec',
      result: { content: [{ type: 'text', text: 'hi\n' }], details: {} },
      isError: false,
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    expect(runtimeEvents.map((event) => event.event.method)).toEqual([
      'item/reasoning/textDelta',
      'item/started',
      'item/commandExecution/outputDelta',
      'item/completed',
    ]);
    expect(runtimeEvents[0].event.params).toMatchObject({
      threadId: 'thread1',
      contentIndex: 0,
      delta: 'thinking',
    });
    expect(runtimeEvents[0].event.params.itemId).toMatch(/^pi_reasoning_/);
    expect(runtimeEvents[1].event.params.item).toMatchObject({
      id: 'tool1',
      type: 'dynamicToolCall',
      tool: 'js_exec',
      status: 'running',
    });
    expect(runtimeEvents[2].event.params).toEqual({
      threadId: 'thread1',
      itemId: 'tool1',
      delta: 'hi\n',
    });
    expect(runtimeEvents[3].event.params.item).toMatchObject({
      id: 'tool1',
      type: 'dynamicToolCall',
      tool: 'js_exec',
      status: 'completed',
      isError: false,
    });
  });

  it('marks failed Pi runtime tool completion items with isError', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_start',
      toolCallId: 'tool1',
      toolName: 'js_exec',
      args: { code: 'return 1', description: 'validate' },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_end',
      toolCallId: 'tool1',
      toolName: 'js_exec',
      result: { content: [{ type: 'text', text: 'validation failed\n' }], details: {} },
      isError: true,
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    const completedEvent = runtimeEvents.find(
      (event) => event.event.method === 'item/completed',
    );
    expect(completedEvent?.event.params.item).toMatchObject({
      id: 'tool1',
      type: 'dynamicToolCall',
      tool: 'js_exec',
      status: 'failed',
      isError: true,
    });
  });

  it('marks failed Pi runtime dynamic tool completion items with isError', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'tool_execution_end',
      toolCallId: 'tool-validate',
      toolName: 'validate_workflow',
      args: { name: 'daily-sync' },
      result: { content: [{ type: 'text', text: 'invalid workflow' }], details: {} },
      isError: true,
    });

    const completedEvent = events.find(
      (event) =>
        event.type === 'runtime_event' &&
        event.event.method === 'item/completed',
    );
    expect(completedEvent?.event.params.item).toMatchObject({
      id: 'tool-validate',
      type: 'dynamicToolCall',
      tool: 'validate_workflow',
      arguments: { name: 'daily-sync' },
      status: 'failed',
      isError: true,
      result: { content: [{ type: 'text', text: 'invalid workflow' }] },
    });
  });

  it('publishes live Pi running activity for thinking, text, and tools', async () => {
    // Running-activity RPCs are trailing-debounced (one flush per window with
    // the latest text), so advance past the window after each event to assert
    // every event's activity text individually.
    vi.useFakeTimers();
    try {
      const { fake, activityRecords } = createPiEventFake();

      const piEvents = [
        { type: 'agent_start' },
        {
          type: 'message_update',
          message: { role: 'assistant', content: [] },
          assistantMessageEvent: {
            type: 'thinking_start',
            contentIndex: 0,
          },
        },
        {
          type: 'message_update',
          message: { role: 'assistant', content: [] },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: 'Streaming assistant update.',
          },
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-read',
          toolName: 'read',
          args: { file_path: '/workspace/src/App.tsx' },
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-read',
          toolName: 'read',
          args: { file_path: '/workspace/src/App.tsx' },
          result: { content: [{ type: 'text', text: 'ok' }] },
          isError: false,
        },
      ];
      for (const piEvent of piEvents) {
        await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, piEvent);
        await vi.advanceTimersByTimeAsync(5_001);
        await flushWaitUntil(fake);
      }

      expect(
        activityRecords.map(([, isStreaming, options]) => ({
          isStreaming,
          activityText: options.activityText,
        })),
      ).toEqual([
        { isStreaming: true, activityText: 'Thinking' },
        { isStreaming: true, activityText: 'Streaming assistant update.' },
        { isStreaming: true, activityText: 'Reading App.tsx' },
        { isStreaming: true, activityText: 'Read App.tsx' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('renders persisted Pi tool result messages with their assistant tool calls', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'run it', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tool1',
          name: 'bash',
          arguments: { command: 'echo hi' },
        }],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
      {
        role: 'toolResult',
        toolCallId: 'tool1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'hi\n' }],
        isError: false,
        timestamp: 300,
      },
    ]);

    const messages = await ChatThreadDO.prototype.getPiCoreParsedMessages.call(fake, 'thread1');

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      id: 'resp_tool',
      role: 'assistant',
    });
    expect(messages[1].content).toEqual([
      {
        type: 'tool_use',
        id: 'tool1',
        name: 'bash',
        input: { command: 'echo hi' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool1',
        content: 'hi\n',
        is_error: false,
        status: 'succeeded',
        itemId: 'tool1',
        itemKind: 'commandExecution',
      },
    ]);
  });

  it('inserts a tool result after its tool call so trailing answer text stays last', async () => {
    // Pi can persist a turn's final answer in the same assistant record as its
    // tool calls. The tool result must land right after its tool_use, not at the
    // end of the message — otherwise the trailing answer text would render
    // before the tool result and the turn view would fold it into the collapsed
    // tool trace instead of showing it as the turn's final output.
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'run it', timestamp: 100 },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Let me check.' },
          {
            type: 'toolCall',
            id: 'tool1',
            name: 'bash',
            arguments: { command: 'echo hi' },
          },
          { type: 'text', text: 'All done — the output was hi.' },
        ],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
      {
        role: 'toolResult',
        toolCallId: 'tool1',
        toolName: 'bash',
        content: [{ type: 'text', text: 'hi\n' }],
        isError: false,
        timestamp: 300,
      },
    ]);

    const messages = await ChatThreadDO.prototype.getPiCoreParsedMessages.call(fake, 'thread1');

    expect(messages).toHaveLength(2);
    expect(messages[1].content).toEqual([
      { type: 'text', text: 'Let me check.' },
      {
        type: 'tool_use',
        id: 'tool1',
        name: 'bash',
        input: { command: 'echo hi' },
      },
      {
        type: 'tool_result',
        tool_use_id: 'tool1',
        content: 'hi\n',
        is_error: false,
        status: 'succeeded',
        itemId: 'tool1',
        itemKind: 'commandExecution',
      },
      { type: 'text', text: 'All done — the output was hi.' },
    ]);
  });

  it('marks persisted Pi stopped-by-user messages for muted UI rendering', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'stop test', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        responseId: 'pi_user_stop_200',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'aborted',
        metadata: { reason: 'user_stop' },
      },
    ]);

    const messages = await ChatThreadDO.prototype.getPiCoreParsedMessages.call(fake, 'thread1');

    expect(messages[1]).toMatchObject({
      id: 'pi_user_stop_200',
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'Stopped by user',
        itemKind: 'userStop',
      }],
    });
  });

  it('does not mark literal persisted Pi text as stopped-by-user without metadata', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'echo the phrase', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        responseId: 'resp_literal_stop_text',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ]);

    const messages = await ChatThreadDO.prototype.getPiCoreParsedMessages.call(fake, 'thread1');

    expect(messages[1]).toMatchObject({
      id: 'resp_literal_stop_text',
      role: 'assistant',
      content: [{
        type: 'text',
        text: 'Stopped by user',
      }],
    });
    expect(messages[1].content).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ itemKind: 'userStop' })]),
    );
  });

  it('turn_end snapshots agent.state.messages past the baseline into main', async () => {
    const { fake, events: _events } = createPiEventFake();
    void _events;
    const allMessages = [
      { role: 'user', content: 'previous turn', timestamp: 50 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'previous reply' }],
        timestamp: 60,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
      { role: 'user', content: 'current turn', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'current reply' }],
        responseId: 'resp_current',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ];
    fake.piSession = { state: { messages: allMessages } };
    fake.piMainBaselineIndex = 2;
    fake.appendPiCoreMessagesIfMissing = vi.fn();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[3],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
      allMessages[2],
      allMessages[3],
    ]);
    expect(fake.piMainBaselineIndex).toBe(4);
  });

  it('turn_end is a no-op when no new messages are past the baseline', async () => {
    const { fake, events: _events } = createPiEventFake();
    void _events;
    const allMessages = [
      { role: 'user', content: 'old', timestamp: 50 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        timestamp: 60,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ];
    fake.piSession = { state: { messages: allMessages } };
    fake.piMainBaselineIndex = 2;
    fake.appendPiCoreMessagesIfMissing = vi.fn();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[1],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(2);
  });

  // --- Durable resume: onChatMessage's resumeActivePiTurn + failure/exhaustion ---

  function createResumeFake(overrides: Record<string, any> = {}) {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.readPiActiveTurn = vi.fn(() => ({ turnId: 't1', openedAt: 1 }));
    fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
    fake.finishTurn = vi.fn();
    fake.setActiveTurnUserId = vi.fn();
    fake.syncAgentState = vi.fn();
    fake.updateActiveAutomationRun = vi.fn();
    fake.pushChatEvent = vi.fn();
    fake.piProviderErrorEvent = vi.fn((message: string) => ({ type: 'error', message }));
    fake.appendPiCoreMessagesIfMissing = vi.fn();
    fake.attachCodeModeArtifactsToToolResult = vi.fn(async (message: any) => message);
    fake.extractLatestPiAssistantText = vi.fn(() => 'final reply');
    fake.completeTodoStateForTurnEnd = vi.fn(async () => {});
    fake.chatContext = { threadId: 'thread1' };
    fake.ensurePiSessionReady = vi.fn(async () => {});
    fake.withPiTurnInactivityTimeout = vi.fn(async (fn: () => unknown) => fn());
    fake.recordChatThreadObservabilityEvent = vi.fn();
    Object.assign(fake, overrides);
    return fake;
  }

  it('commits a recovered tail that owes no model output, folding Code Mode artifacts', async () => {
    // Evicted after the final assistant message_end but before turn_end snapshotted
    // it: nothing owed, so resumeActivePiTurn commits the tail directly — but it must
    // still fold js_exec/Code Mode artifacts onto tool results the way turn_end does.
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'call_1',
      toolName: 'js_exec',
      content: [{ type: 'text', text: 'output' }],
    };
    const assistantFinal = {
      role: 'assistant',
      content: [{ type: 'text', text: 'done' }],
      stopReason: 'endTurn',
    };
    const messages = [{ role: 'user', content: 'run it' }, toolResult, assistantFinal];
    const withArtifacts = { ...toolResult, _artifactsAttached: true };
    const fake = createResumeFake({
      piSession: { state: { isStreaming: false, messages } },
      piMainBaselineIndex: 1,
      attachCodeModeArtifactsToToolResult: vi.fn(async (message: any) =>
        message === toolResult ? withArtifacts : message,
      ),
    });

    await ChatThreadDO.prototype['resumeActivePiTurn'].call(fake);

    expect(fake.attachCodeModeArtifactsToToolResult).toHaveBeenCalledWith(toolResult, {
      consume: true,
    });
    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
      withArtifacts,
      assistantFinal,
    ]);
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    // Finalizes like the normal agent_end path: markUnread drives completion
    // recording / automation success / summary, not a bare streaming reset.
    expect(fake.finishTurn).toHaveBeenCalledWith(
      expect.objectContaining({ markUnread: true, completedAt: expect.any(Number) }),
    );
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.completeTodoStateForTurnEnd).toHaveBeenCalled();
  });

  it('continues an interrupted turn that still owes model output', async () => {
    // The model owes output (leaf is a toolResult), so continue() drives it. The turn
    // lifecycle (agent_end) clears the marker; resumeActivePiTurn itself does not.
    const messages = [
      { role: 'user', content: 'hi' },
      { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: 'r' }] },
    ];
    const fake = createResumeFake({
      piSession: {
        state: { isStreaming: false, messages },
        continue: vi.fn(async () => {}),
      },
      piMainBaselineIndex: 0,
    });

    await ChatThreadDO.prototype['resumeActivePiTurn'].call(fake);

    expect(fake.piSession.continue).toHaveBeenCalled();
    expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
  });

  it('propagates a resume failure to onChatMessage (it no longer catches its own errors)', async () => {
    // ensurePiSessionReady can throw (e.g. OrgDO/model-provider config retries
    // exhaust). resumeActivePiTurn no longer catches — the error propagates to
    // onChatMessage's handlePiTurnFailure, which owns the cleanup.
    const rebuildError = new Error('model provider config unavailable');
    const fake = createResumeFake({
      ensurePiSessionReady: vi.fn(() => Promise.reject(rebuildError)),
    });

    await expect(
      ChatThreadDO.prototype['resumeActivePiTurn'].call(fake),
    ).rejects.toThrow(rebuildError);
    expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
  });

  it('handlePiTurnFailure releases the thread on a non-eviction (provider) error', async () => {
    const providerError = new Error('Provider exploded');
    const fake = createResumeFake();

    ChatThreadDO.prototype['handlePiTurnFailure'].call(fake, providerError);

    expect(fake.pushChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error', message: 'Provider exploded' }),
    );
    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', clear: true }),
    );
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
  });

  it('handlePiTurnFailure leaves recovery state intact for a benign AbortError', async () => {
    // A user stop (agent_end cleaned up) or a config-change dispose (a pending
    // continueLastTurn will resume) surfaces as AbortError — swallow WITHOUT clearing
    // the marker or surfacing an error.
    const abortError = new Error('The turn was aborted');
    abortError.name = 'AbortError';
    const fake = createResumeFake();

    ChatThreadDO.prototype['handlePiTurnFailure'].call(fake, abortError);

    expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
    expect(fake.finishTurn).not.toHaveBeenCalled();
    expect(fake.pushChatEvent).not.toHaveBeenCalled();
  });

  it('handlePiRecoveryExhausted clears active turn ownership on budget exhaustion', async () => {
    // chatRecovery owns the attempt budget; onExhausted must release the active-turn
    // user like the other terminal paths, or later sandbox MCP calls stay attributed
    // to the abandoned author. The framework delivers the terminal banner itself.
    const fake = createResumeFake();

    ChatThreadDO.prototype['handlePiRecoveryExhausted'].call(fake, {
      terminalMessage:
        'This turn was interrupted and could not be resumed automatically. Please send your message again.',
      reason: 'max_attempts_exceeded',
    } as any);

    expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
      'pi_turn_resume_abandoned',
      expect.objectContaining({ status: 'abandoned' }),
    );
    expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    expect(fake.finishTurn).toHaveBeenCalled();
    expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'error', clear: true }),
    );
    expect(fake.pushChatEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'error' }),
    );
  });

  // --- In-process transient provider-error retry (post-forwarded regeneration) ---

  describe('in-process transient provider-error retry', () => {
    const RETRYABLE_ERROR = 'Upstream idle timeout exceeded';

    function failedAssistantMessage(
      errorMessage: string = RETRYABLE_ERROR,
      overrides: Record<string, unknown> = {},
    ) {
      return {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage,
        responseId: 'resp_fail',
        timestamp: 1,
        model: 'claude-test-model',
        ...overrides,
      };
    }

    function createGateFake() {
      const { fake, events } = createPiEventFake();
      fake.activePiStreamTurnId = 'turn-retry';
      fake.piTurnTransientRetryAttempts = 0;
      fake.piPendingTransientTurnRetry = null;
      fake.piCurrentUsageProvider = 'bedrock';
      fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
      return { fake, events };
    }

    it('agent_end defers a retryable provider error: no terminal surfacing, marker preserved', async () => {
      const { fake, events } = createGateFake();

      await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
      await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
        type: 'agent_end',
        messages: [failedAssistantMessage()],
      });

      // Nothing terminal reached the client and the recovery state survived.
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(events.some((event) => event.type === 'result')).toBe(false);
      expect(fake.finishTurn).not.toHaveBeenCalled();
      expect(fake.setActiveTurnUserId).not.toHaveBeenCalled();
      expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
      // The pending token carries what the retry loop records.
      expect(fake.piPendingTransientTurnRetry).toEqual({
        errorText: RETRYABLE_ERROR,
        provider: 'bedrock',
        model: 'claude-test-model',
      });
    });

    it('agent_end terminal-fails a NON-retryable error immediately (no retry token)', async () => {
      const { fake, events } = createGateFake();

      await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
      await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
        type: 'agent_end',
        messages: [failedAssistantMessage('insufficient_quota: request quota exceeded')],
      });

      expect(fake.piPendingTransientTurnRetry).toBeNull();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'error',
          error: 'insufficient_quota: request quota exceeded',
        }),
      );
      expect(fake.finishTurn).toHaveBeenCalled();
      expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    });

    it('agent_end terminal-fails a retryable error once the attempt budget is spent', async () => {
      const { fake, events } = createGateFake();
      fake.piTurnTransientRetryAttempts = 2;

      await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
      await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
        type: 'agent_end',
        messages: [failedAssistantMessage()],
      });

      expect(fake.piPendingTransientTurnRetry).toBeNull();
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'error', error: RETRYABLE_ERROR }),
      );
      expect(fake.finishTurn).toHaveBeenCalled();
      expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    });

    it('agent_end keeps the terminal path when no ai-chat turn body is attached (eval prompt)', async () => {
      const { fake, events } = createGateFake();
      fake.activePiStreamTurnId = null;

      await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
      await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
        type: 'agent_end',
        messages: [failedAssistantMessage()],
      });

      expect(fake.piPendingTransientTurnRetry).toBeNull();
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'error', error: RETRYABLE_ERROR }),
      );
      expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
    });

    function createRetryLoopFake(overrides: Record<string, any> = {}) {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.chatContext = { threadId: 'thread1' };
      fake.piTurnTransientRetryAttempts = 0;
      fake.piPendingTransientTurnRetry = {
        errorText: RETRYABLE_ERROR,
        provider: 'bedrock',
        model: 'claude-test-model',
      };
      fake.piTransientRetryBackoffAbort = null;
      fake.piUserStopRequestedAtMs = 0;
      fake.piEventHandlerChain = Promise.resolve();
      fake.recordChatThreadObservabilityEvent = vi.fn();
      fake.writePiStreamHeartbeat = vi.fn();
      fake.prunePiTurnJournalFailedAssistantMessages = vi.fn();
      fake.trimIncompleteStreamingReplyParts = vi.fn();
      fake.disposePiSession = vi.fn();
      fake.resumeActivePiTurn = vi.fn(async () => {});
      fake.finishPiTurnStoppedDuringTransientRetry = vi.fn(async () => {});
      fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});
      Object.assign(fake, overrides);
      return fake;
    }

    it('retry loop backs off, prunes the journal, disposes, and re-drives resumeActivePiTurn once', async () => {
      vi.useFakeTimers();
      const fake = createRetryLoopFake();

      const promise = ChatThreadDO.prototype['retryPiTurnWhileTransient'].call(fake);
      await vi.advanceTimersByTimeAsync(500);
      await promise;

      expect(fake.piTurnTransientRetryAttempts).toBe(1);
      expect(fake.resumeActivePiTurn).toHaveBeenCalledTimes(1);
      // Heartbeats keep the stall watchdog fed across the silent backoff.
      expect(fake.writePiStreamHeartbeat).toHaveBeenCalled();
      // The failed error row must be gone and the session rebuilt cold BEFORE
      // the re-drive folds the journal.
      const pruneOrder = fake.prunePiTurnJournalFailedAssistantMessages.mock.invocationCallOrder[0];
      const disposeOrder = fake.disposePiSession.mock.invocationCallOrder[0];
      const resumeOrder = fake.resumeActivePiTurn.mock.invocationCallOrder[0];
      expect(pruneOrder).toBeLessThan(resumeOrder);
      expect(disposeOrder).toBeLessThan(resumeOrder);
      expect(fake.trimIncompleteStreamingReplyParts).toHaveBeenCalledTimes(1);
      // Marker + journal survive the retry; only success/exhaustion clears them.
      expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
      expect(fake.finishPiTurnStoppedDuringTransientRetry).not.toHaveBeenCalled();
      expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
        'pi_turn_transient_retry',
        expect.objectContaining({
          status: 'retrying',
          severity: 'warn',
          count: 1,
          provider: 'bedrock',
          model: 'claude-test-model',
          error: expect.objectContaining({ message: RETRYABLE_ERROR }),
        }),
      );
    });

    it('prunes the failed journal row BEFORE the evictable backoff sleep (eviction during backoff must not commit the error row)', async () => {
      vi.useFakeTimers();
      const fake = createRetryLoopFake();

      // Start the loop but do NOT advance timers yet: it runs up to the first
      // await, which is the backoff sleep. By then the failed-row prune must have
      // already run — so a DO eviction during the sleep folds a journal with no
      // error row and regenerates, instead of cold-load recovery committing the
      // provider error as a "completed" turn (Risk 5).
      const promise = ChatThreadDO.prototype['retryPiTurnWhileTransient'].call(fake);
      await Promise.resolve(); // let the synchronous pre-sleep body run
      expect(fake.prunePiTurnJournalFailedAssistantMessages).toHaveBeenCalledTimes(1);
      expect(fake.resumeActivePiTurn).not.toHaveBeenCalled(); // still sleeping

      await vi.advanceTimersByTimeAsync(500);
      await promise;
      // Not double-pruned: one prune per attempt, ahead of the sleep.
      expect(fake.prunePiTurnJournalFailedAssistantMessages).toHaveBeenCalledTimes(1);
      expect(fake.resumeActivePiTurn).toHaveBeenCalledTimes(1);
    });

    it('a repeatedly failing turn consumes the budget, then the gate declines the third attempt', async () => {
      vi.useFakeTimers();
      const fake = createRetryLoopFake({
        activePiStreamTurnId: 'turn-retry',
        piSession: null,
        piCurrentUsageProvider: 'bedrock',
      });
      // Each re-drive "fails" again: re-arm the pending token through the real
      // gate, exactly like the retried run's deferred agent_end would.
      fake.resumeActivePiTurn = vi.fn(async () => {
        ChatThreadDO.prototype['maybeDeferPiTurnForTransientRetry'].call(fake, [
          failedAssistantMessage(),
        ]);
      });

      const promise = ChatThreadDO.prototype['retryPiTurnWhileTransient'].call(fake);
      await vi.advanceTimersByTimeAsync(500); // attempt 1 backoff
      await vi.advanceTimersByTimeAsync(1000); // attempt 2 backoff (exponential)
      await promise;

      expect(fake.piTurnTransientRetryAttempts).toBe(2);
      expect(fake.resumeActivePiTurn).toHaveBeenCalledTimes(2);
      // The budget is spent: the next agent_end runs the normal terminal path.
      expect(
        ChatThreadDO.prototype['maybeDeferPiTurnForTransientRetry'].call(fake, [
          failedAssistantMessage(),
        ]),
      ).toBe(false);
    });

    it('a user stop that already landed aborts the retry before any attempt', async () => {
      const fake = createRetryLoopFake({ piUserStopRequestedAtMs: 123 });

      await ChatThreadDO.prototype['retryPiTurnWhileTransient'].call(fake);

      expect(fake.finishPiTurnStoppedDuringTransientRetry).toHaveBeenCalledTimes(1);
      expect(fake.resumeActivePiTurn).not.toHaveBeenCalled();
      expect(fake.piTurnTransientRetryAttempts).toBe(0);
    });

    it('a user stop during the backoff sleep wakes it and terminal-stops cleanly', async () => {
      vi.useFakeTimers();
      const fake = createRetryLoopFake();

      const promise = ChatThreadDO.prototype['retryPiTurnWhileTransient'].call(fake);
      // The loop runs synchronously up to the backoff await, so the abort
      // controller is installed by now — this is the hook the stop command uses.
      expect(fake.piTransientRetryBackoffAbort).toBeTruthy();
      fake.piUserStopRequestedAtMs = Date.now();
      fake.piTransientRetryBackoffAbort.abort();
      await promise;

      expect(fake.finishPiTurnStoppedDuringTransientRetry).toHaveBeenCalledTimes(1);
      expect(fake.resumeActivePiTurn).not.toHaveBeenCalled();
    });

    it('finishPiTurnStoppedDuringTransientRetry commits journal work minus the failed row and tears down', async () => {
      const events: any[] = [];
      const fake = Object.create(ChatThreadDO.prototype) as any;
      const userMessage = { role: 'user', content: 'do the thing' };
      const failed = failedAssistantMessage();
      const stopMessage = { role: 'user', content: 'Stopped by user', timestamp: 111 };
      fake.chatContext = { threadId: 'thread1' };
      fake.piUserStopRequestedAtMs = 111;
      fake.piAgentStartedAtMs = 100;
      fake.piTurnStartedAtMs = 100;
      fake.piTurnTransientRetryAttempts = 1;
      fake.recordChatThreadObservabilityEvent = vi.fn();
      fake.loadPiTurnJournalTail = vi.fn(async () => [userMessage, failed]);
      fake.appendPiCoreMessagesIfMissing = vi.fn(async () => {});
      fake.createPiUserStopMessage = vi.fn(() => stopMessage);
      fake.pushPiRuntimeEvent = vi.fn();
      fake.pushChatEvent = vi.fn((event: any) => events.push(event));
      fake.updateActiveAutomationRun = vi.fn();
      fake.finishTurn = vi.fn();
      fake.setActiveTurnUserId = vi.fn();
      fake.completeTodoStateForTurnEnd = vi.fn();
      fake.resetRunningActivityState = vi.fn();
      fake.disposePiSession = vi.fn();
      fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});

      await ChatThreadDO.prototype['finishPiTurnStoppedDuringTransientRetry'].call(fake);

      // The accepted prompt survives; the failed error row does not.
      expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
        userMessage,
        stopMessage,
      ]);
      expect(fake.pushPiRuntimeEvent).toHaveBeenCalledWith(
        'turn/completed',
        expect.objectContaining({ threadId: 'thread1' }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({ type: 'result', result: 'Stopped by user' }),
      );
      expect(fake.finishTurn).toHaveBeenCalledWith(
        expect.objectContaining({ markUnread: true }),
      );
      expect(fake.setActiveTurnUserId).toHaveBeenCalledWith(null);
      expect(fake.clearPiActiveTurnAndJournal).toHaveBeenCalled();
      expect(fake.piUserStopRequestedAtMs).toBe(0);
    });

    it('prunes only failed assistant rows from the turn journal', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      const deletes: any[] = [];
      const journalRows = [
        { seq: 0, payload: JSON.stringify({ role: 'user', content: 'hi' }) },
        {
          seq: 1,
          payload: JSON.stringify({
            role: 'toolResult',
            toolCallId: 'c1',
            content: [{ type: 'text', text: 'r' }],
          }),
        },
        { seq: 2, payload: JSON.stringify(failedAssistantMessage()) },
      ];
      fake.ctx = {
        storage: {
          sql: {
            exec: vi.fn((query: string, ...args: any[]) => {
              if (query.startsWith('SELECT')) return { toArray: () => journalRows };
              if (query.startsWith('DELETE FROM pi_turn_journal WHERE')) deletes.push(args);
              return { toArray: () => [] };
            }),
          },
        },
      };

      ChatThreadDO.prototype['prunePiTurnJournalFailedAssistantMessages'].call(fake);

      expect(deletes).toEqual([[2]]);
    });

    it('trims the failed attempt\'s incomplete trailing parts from the in-flight reply message', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.chatContext = { threadId: 'thread1' };
      fake.recordChatThreadObservabilityEvent = vi.fn();
      const parts = [
        { type: 'text', text: 'settled run', state: 'done' },
        { type: 'tool-bash', toolCallId: 'c1', state: 'output-available' },
        { type: 'text', text: 'half a sen', state: 'streaming' },
      ];
      fake._streamingMessage = { parts };

      ChatThreadDO.prototype['trimIncompleteStreamingReplyParts'].call(fake);

      expect(parts).toEqual([
        { type: 'text', text: 'settled run', state: 'done' },
        { type: 'tool-bash', toolCallId: 'c1', state: 'output-available' },
      ]);
      expect(fake.recordChatThreadObservabilityEvent).toHaveBeenCalledWith(
        'pi_turn_partial_trimmed',
        expect.objectContaining({ count: 1 }),
      );
    });

    it('trim is a no-op when ai-chat has no in-flight reply message', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.recordChatThreadObservabilityEvent = vi.fn();
      fake._streamingMessage = null;

      ChatThreadDO.prototype['trimIncompleteStreamingReplyParts'].call(fake);

      expect(fake.recordChatThreadObservabilityEvent).not.toHaveBeenCalled();
    });

    it('resumeActivePiTurn is safe warm: dispose mid-turn, rebuild, and continue in-process', async () => {
      // The retry re-drives on a WARM isolate (unlike eviction recovery's cold
      // wake): disposePiSession must fully reset the live session so
      // ensurePiSessionReady rebuilds from committed history + journal and
      // continue() regenerates.
      const fake = Object.create(ChatThreadDO.prototype) as any;
      const oldSession = { abort: vi.fn(), state: { messages: [] } };
      fake.piSession = oldSession;
      fake.piUnsubscribe = null;
      fake.piModelResolver = null;
      fake.piSessionPromise = null;
      fake.piMainBaselineIndex = 3;
      fake.piEventHandlerChain = Promise.resolve();
      fake.piActiveItemId = 'stale';
      fake.piAssistantText = 'stale';
      const newSession = {
        state: {
          isStreaming: false,
          messages: [{ role: 'user', content: 'do the thing' }],
        },
        continue: vi.fn(async () => {}),
      };
      fake.ensurePiSessionReady = vi.fn(async () => {
        fake.piSession = newSession;
      });
      fake.recordChatThreadObservabilityEvent = vi.fn();
      fake.trimIncompleteLiveAssistantParts = vi.fn(async () => {});
      fake.clearPiActiveTurnAndJournal = vi.fn(async () => {});

      ChatThreadDO.prototype['disposePiSession'].call(fake);

      expect(oldSession.abort).toHaveBeenCalled();
      expect(fake.piSession).toBeNull();
      expect(fake.piMainBaselineIndex).toBe(0);

      await ChatThreadDO.prototype['resumeActivePiTurn'].call(fake);

      expect(fake.ensurePiSessionReady).toHaveBeenCalled();
      expect(newSession.continue).toHaveBeenCalled();
      // The continuation's own agent_end owns the terminal clear.
      expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
    });
  });

  describe('steer-message journaling', () => {
    it('round-trips steer messages through sync KV and clears them', async () => {
      const store = new Map<string, unknown>();
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.ctx = {
        storage: {
          kv: {
            get: (key: string) => store.get(key),
            put: (key: string, value: unknown) => void store.set(key, value),
            delete: (key: string) => void store.delete(key),
          },
        },
      };
      fake.hydratePiStoredImages = vi.fn(async (message: any) => message);

      ChatThreadDO.prototype['recordPiTurnJournalSteerMessage'].call(fake, {
        role: 'user',
        content: 'steer one',
        timestamp: 1,
      });
      ChatThreadDO.prototype['recordPiTurnJournalSteerMessage'].call(fake, {
        role: 'user',
        content: 'steer two',
        timestamp: 2,
      });

      const loaded = await ChatThreadDO.prototype['loadPiTurnSteerJournal'].call(fake);
      expect(loaded).toHaveLength(2);
      expect(JSON.stringify(loaded)).toContain('steer one');
      expect(JSON.stringify(loaded)).toContain('steer two');

      ChatThreadDO.prototype['clearPiTurnSteerJournal'].call(fake);
      const afterClear = await ChatThreadDO.prototype['loadPiTurnSteerJournal'].call(fake);
      expect(afterClear).toEqual([]);
    });

    it('journals an accepted steering message before handing it to the steer queue', async () => {
      const { fake, events } = createPiEventFake();
      fake.refreshPiSessionModel = vi.fn(async () => undefined);
      fake.recordPiTurnJournalSteerMessage = vi.fn();
      fake.messages = [];
      fake.persistMessages = vi.fn(async () => undefined);
      const steer = vi.fn();
      fake.piSession = {
        state: {
          isStreaming: true,
          model: { api: 'test', provider: 'test', id: 'test-model' },
        },
        prompt: vi.fn(),
        steer,
        abort: vi.fn(),
      };

      const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
        type: 'message',
        content: 'steer me',
      });
      expect(accepted).toBe(true);

      // Acceptance is synchronous through the durable journal + stream marker;
      // no model refresh or persistence await can move the seam later.
      expect(fake.recordPiTurnJournalSteerMessage).toHaveBeenCalledTimes(1);
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'steer-marker',
          steerMessageId: expect.any(String),
          acceptedAtMs: expect.any(Number),
        }),
      );
      const stamped = fake.recordPiTurnJournalSteerMessage.mock.calls[0][0];
      const markerEvent = events.find((event) => event.type === 'steer-marker');
      expect(markerEvent.steerMessageId).toBe(stamped.uiMetadata.renderMessageId);
      expect(fake.refreshPiSessionModel).not.toHaveBeenCalled();
      await flushWaitUntil(fake);

      expect(steer).toHaveBeenCalledTimes(1);
      expect(fake.persistMessages).toHaveBeenCalledTimes(1);
      expect(fake.persistMessages.mock.calls[0][0][0].metadata).toMatchObject({
        sentDuringStreaming: true,
      });
      expect(
        fake.persistMessages.mock.invocationCallOrder[0],
      ).toBeLessThan(fake.refreshPiSessionModel.mock.invocationCallOrder[0]);
      // Same message object, journaled strictly before it reaches the queue.
      expect(fake.recordPiTurnJournalSteerMessage.mock.calls[0][0]).toBe(
        steer.mock.calls[0][0],
      );
      expect(
        fake.recordPiTurnJournalSteerMessage.mock.invocationCallOrder[0],
      ).toBeLessThan(steer.mock.invocationCallOrder[0]);
    });
  });

  it('suppresses failed turn_end persistence and discards unpersisted session messages', async () => {
    const { fake, events: _events } = createPiEventFake();
    void _events;
    const previousMessage = { role: 'user', content: 'previous turn', timestamp: 50 };
    const allMessages = [
      previousMessage,
      { role: 'user', content: 'current turn', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call_1|fc_tmp_1',
          name: 'js_exec',
          arguments: {},
        }],
        stopReason: 'error',
        errorMessage: 'Provider returned error',
        responseId: 'resp_error',
        timestamp: 200,
      },
    ];
    fake.piSession = { state: { messages: allMessages } };
    fake.piMainBaselineIndex = 1;
    fake.appendPiCoreMessagesIfMissing = vi.fn();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[2],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piSession.state.messages).toEqual([previousMessage]);
    expect(fake.piMainBaselineIndex).toBe(1);
  });

  it('suppresses aborted turn_end persistence after a user stop request', async () => {
    const { fake, events: _events } = createPiEventFake();
    void _events;
    const allMessages = [
      { role: 'user', content: 'stop while streaming', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: '' }],
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
        responseId: 'resp_aborted',
        timestamp: 200,
      },
    ];
    fake.piSession = { state: { messages: allMessages } };
    fake.piMainBaselineIndex = 0;
    fake.piUserStopRequestedAtMs = 1234;
    fake.appendPiCoreMessagesIfMissing = vi.fn();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'turn_end',
      message: allMessages[1],
      toolResults: [],
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piMainBaselineIndex).toBe(0);
  });

  it('omits hidden internal messages from the parsed chat view', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'thread1' };
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'first turn', timestamp: 100 },
      {
        role: 'user',
        content: 'hidden context that should not reach the client',
        timestamp: 200,
        visibility: 'hidden',
      },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'reply' }],
        responseId: 'resp_reply',
        timestamp: 210,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
    ]);

    const parsed = await ChatThreadDO.prototype['getPiCoreParsedMessages'].call(
      fake,
      'thread1',
    );

    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({ role: 'user', content: 'first turn' });
    expect(parsed[1]).toMatchObject({ role: 'assistant', id: 'resp_reply' });
    expect(
      parsed.some((message) =>
        String(message.content).includes('hidden context'),
      ),
    ).toBe(false);
  });

  it('sanitizes unsupported persisted Pi image tool results when loading history', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ensurePiCoreTables = vi.fn();
    fake.ctx = {
      storage: {
        sql: {
          exec: vi.fn(() => ({
            toArray: () => [
              {
                payload: JSON.stringify({
                  role: 'toolResult',
                  toolCallId: 'tool1',
                  toolName: 'read',
                  content: [
                    {
                      type: 'image',
                      data: 'AA==',
                      mimeType: 'image/vnd.microsoft.icon',
                    },
                    {
                      type: 'image',
                      data: 'BB==',
                      mimeType: 'image/jpg',
                    },
                  ],
                  isError: false,
                  timestamp: 300,
                }),
              },
            ],
          })),
        },
      },
    };

    const messages = await ChatThreadDO.prototype['loadPiCoreMessages'].call(fake);

    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      {
        type: 'text',
        text: '(image omitted: unsupported MIME type image/vnd.microsoft.icon)',
      },
      {
        type: 'image',
        data: 'BB==',
        mimeType: 'image/jpeg',
      },
    ]);
  });

  it('loads compacted Pi history from the compaction tail instead of every row', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    const exec = vi.fn((sql: string, ...params: unknown[]) => {
      if (
        sql.trimStart().startsWith('CREATE TABLE') ||
        sql.includes('INSERT OR IGNORE INTO pi_core_state')
      ) {
        return { toArray: () => [] };
      }
      if (sql.includes('FROM pi_core_compaction')) {
        return {
          toArray: () => [
            {
              summary: 'earlier work summary',
              first_kept_index: 2,
              updated_at: 1234,
            },
          ],
        };
      }
      expect(sql).toContain('WHERE idx >= ?');
      expect(params).toEqual([2]);
      return {
        toArray: () => [
          {
            payload: JSON.stringify({
              role: 'user',
              content: 'kept user turn',
              timestamp: 200,
            }),
          },
          {
            payload: JSON.stringify({
              role: 'assistant',
              content: [{ type: 'text', text: 'kept assistant turn' }],
              responseId: 'resp_kept',
              timestamp: 210,
            }),
          },
        ],
      };
    });
    fake.ctx = { storage: { sql: { exec } } };

    const messages = await ChatThreadDO.prototype['loadPiCoreMessages'].call(fake);

    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({
      role: 'user',
      content: '[Context Summary]\n\nearlier work summary',
      timestamp: 1234,
    });
    expect(messages[1]).toMatchObject({ role: 'user', content: 'kept user turn' });
    expect(messages[2]).toMatchObject({ role: 'assistant', responseId: 'resp_kept' });
    expect(exec).toHaveBeenCalledWith(
      'SELECT payload FROM pi_core_messages WHERE idx >= ? ORDER BY idx ASC',
      2,
    );
    expect(exec).not.toHaveBeenCalledWith(
      'SELECT payload FROM pi_core_messages ORDER BY idx ASC',
    );
  });

  it('stores oversized image data in R2 before persisting Pi messages to SQLite', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ensurePiCoreTables = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.chatContext = {
      orgId: 'org1',
      workspaceId: 'workspace1',
      threadId: 'thread1',
    };
    const put = vi.fn(async () => undefined);
    fake.env = {
      R2_BUCKET: { put },
    };
    const insertedPayloads: string[] = [];
    fake.ctx = {
      storage: {
        sql: {
          exec: vi.fn((sql: string, ...params: unknown[]) => {
            if (sql.includes('MAX(idx)')) {
              return { toArray: () => [{ next_idx: 0 }] };
            }
            if (sql.includes('INSERT INTO pi_core_messages')) {
              insertedPayloads.push(String(params[1]));
            }
            return { toArray: () => [] };
          }),
        },
      },
    };
    const imageData = 'a'.repeat(600_000);

    await ChatThreadDO.prototype['appendPiCoreMessages'].call(fake, [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'see image' },
          {
            type: 'image',
            mimeType: 'image/png',
            data: imageData,
          },
        ],
        timestamp: 1,
      },
    ]);

    expect(insertedPayloads).toHaveLength(1);
    expect(insertedPayloads[0].length).toBeLessThan(50_000);
    expect(insertedPayloads[0]).toContain('chiridionR2Image');
    expect(insertedPayloads[0]).toContain('"data":""');
    expect(insertedPayloads[0]).not.toContain('a'.repeat(100_000));
    expect(put).toHaveBeenCalledTimes(1);
    expect(put).toHaveBeenCalledWith(
      expect.stringContaining('chat-sessions/thread1/pi-images/'),
      imageData,
      expect.objectContaining({
        customMetadata: expect.objectContaining({
          type: 'pi-message-image-base64',
          mimeType: 'image/png',
          sessionId: 'thread1',
          threadId: 'thread1',
          workspaceId: 'workspace1',
          orgId: 'org1',
        }),
      }),
    );
  });

  it('does not expose raw image storage references through admin Pi rows', () => {
    const privateKey = 'org-secret/workspace-secret/pi-images/private.base64';
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.env = { R2_BUCKET: {} };
    fake.ctx = {
      storage: {
        sql: {
          exec: vi.fn(() => ({
            toArray: () => [{
              idx: 1,
              created_at: 1,
              payload: JSON.stringify({
                role: 'user',
                content: [{
                  type: 'image',
                  mimeType: 'image/png',
                  data: '',
                  metadata: {
                    chiridionR2Image: {
                      key: privateKey,
                      mimeType: 'image/png',
                      size: 100,
                      sha256: 'private-hash',
                      storedAt: 1,
                    },
                  },
                }],
              }),
            }],
          })),
        },
      },
    };

    const rows = ChatThreadDO.prototype.getPiCoreMessageRows.call(fake, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toContain('persisted image omitted from render');
    expect(rows[0].payload).not.toContain(privateKey);
    expect(rows[0].payload).not.toContain('private-hash');
    expect(rows[0].payload).not.toContain('chiridionR2Image');
  });

  it('hydrates oversized Pi image data from R2 when loading history', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.ensurePiCoreTables = vi.fn();
    fake.recordChatThreadObservabilityEvent = vi.fn();
    const imageData = 'b'.repeat(300_000);
    const get = vi.fn(async () => ({
      size: imageData.length,
      text: async () => imageData,
    }));
    fake.env = {
      R2_BUCKET: { get },
    };
    fake.ctx = {
      storage: {
        sql: {
          exec: vi.fn((sql: string) => {
            if (sql.includes('pi_core_compaction')) {
              return { toArray: () => [] };
            }
            return {
              toArray: () => [
                {
                  payload: JSON.stringify({
                    role: 'user',
                    content: [
                      {
                        type: 'image',
                        mimeType: 'image/png',
                        data: '',
                        metadata: {
                          chiridionR2Image: {
                            key: 'org1/workspace1/chat-sessions/thread1/pi-images/abc.base64',
                            mimeType: 'image/png',
                            size: imageData.length,
                            sha256: 'abc',
                            storedAt: 123,
                          },
                        },
                      },
                    ],
                    timestamp: 1,
                  }),
                },
              ],
            };
          }),
        },
      },
    };

    const references = await ChatThreadDO.prototype['loadPiCoreMessages'].call(fake);
    expect((references[0].content as any[])[0].data).toBe('');
    expect(get).not.toHaveBeenCalled();

    const messages = await ChatThreadDO.prototype['loadPiCoreMessages'].call(fake, {
      imagePolicy: 'provider',
    });
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toEqual([
      expect.objectContaining({
        type: 'image',
        mimeType: 'image/png',
        data: imageData,
      }),
    ]);
    expect(get).toHaveBeenCalledWith('org1/workspace1/chat-sessions/thread1/pi-images/abc.base64');
  });

  it('hydrates only recent provider images sequentially under one aggregate budget', async () => {
    const activeReads = { count: 0, max: 0 };
    const get = vi.fn(async (key: string) => ({
      size: 100,
      text: async () => {
        activeReads.count += 1;
        activeReads.max = Math.max(activeReads.max, activeReads.count);
        await Promise.resolve();
        activeReads.count -= 1;
        return `data-for-${key}`;
      },
    }));
    const store = new PiCoreMessageStore({
      sql: () => ({}) as SqlStorage,
      r2: () => ({ get }) as unknown as R2Bucket,
      chatContext: () => null,
    });
    const content = Array.from({ length: 3 }, (_, index) => ({
      type: 'image',
      mimeType: 'image/png',
      data: '',
      metadata: {
        chiridionR2Image: {
          key: `image-${index}`,
          mimeType: 'image/png',
          size: 100,
          sha256: `sha-${index}`,
          storedAt: 1,
        },
      },
    }));

    const hydrated = await store.hydratePiStoredImages(content, {
      maxCount: 2,
      maxDeclaredChars: 1_000,
    }) as Array<Record<string, unknown>>;

    expect(get.mock.calls.map(([key]) => key)).toEqual(['image-2', 'image-1']);
    expect(activeReads.max).toBe(1);
    expect(hydrated[0]).toEqual({
      type: 'text',
      text: '(image omitted from provider context: hydration budget exceeded; image/png, 100 base64 chars)',
    });
    expect(hydrated[1].data).toBe('data-for-image-1');
    expect(hydrated[2].data).toBe('data-for-image-2');
    expect(content.every((part) => part.data === '')).toBe(true);
  });

  it('charges inline and referenced images to pre-provider context estimation', () => {
    const message = {
      role: 'user',
      content: [
        { type: 'image', mimeType: 'image/png', data: 'a'.repeat(4_000) },
        {
          type: 'image',
          mimeType: 'image/png',
          data: '',
          metadata: {
            chiridionR2Image: {
              key: 'private-ref', mimeType: 'image/png', size: 8_000, sha256: 'sha', storedAt: 1,
            },
          },
        },
      ],
    } as any;

    expect(estimatePiMessageTokens(message)).toBeGreaterThanOrEqual(9_000);
  });

  it('sanitizes unsupported image tool outputs before Pi can persist them', () => {
    const content = extractToolContent({
      content: [
        {
          type: 'image',
          data: 'AA==',
          mimeType: 'image/vnd.microsoft.icon',
        },
        {
          type: 'image',
          data: 'BB==',
          mimeType: 'image/png',
        },
      ],
    });

    expect(content).toEqual([
      {
        type: 'text',
        text: '(image omitted: unsupported MIME type image/vnd.microsoft.icon)',
      },
      {
        type: 'image',
        data: 'BB==',
        mimeType: 'image/png',
      },
    ]);
  });

  it('does not emit an extra completed agent message after streamed Pi text', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_update',
      message: { role: 'assistant', content: [] },
      assistantMessageEvent: {
        type: 'text_delta',
        delta: 'Hello',
      },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        responseId: 'resp1',
        timestamp: 123,
      }],
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    expect(runtimeEvents.map((event) => event.event.method)).toEqual([
      'item/agentMessage/delta',
      'turn/completed',
    ]);
    expect(runtimeEvents[0].event.params).toMatchObject({
      threadId: 'thread1',
      delta: 'Hello',
    });
    expect(runtimeEvents[1].event.params).toMatchObject({
      threadId: 'thread1',
      forkEntryId: 'resp1',
      completedAtMs: expect.any(Number),
      turnDurationMs: expect.any(Number),
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      threadId: 'thread1',
      result: 'Hello',
      sessionId: 'thread1',
    }));
    expect(fake.upsertPiCoreMessages).not.toHaveBeenCalled();
  });

  it('emits completed agent messages for non-streamed Pi message_end text', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_end',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Whole reply' }],
      },
    });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [{ type: 'text', text: 'Whole reply' }],
        responseId: 'resp2',
        timestamp: 456,
      }],
    });

    const runtimeEvents = events.filter((event) => event.type === 'runtime_event');
    expect(runtimeEvents.map((event) => event.event.method)).toEqual([
      'item/completed',
      'turn/completed',
    ]);
    expect(runtimeEvents[0].event.params).toMatchObject({
      threadId: 'thread1',
      item: {
        type: 'agentMessage',
        text: 'Whole reply',
      },
    });
    expect(runtimeEvents[0].event.params.item.id).toMatch(/^pi_agent_/);
    expect(runtimeEvents[1].event.params).toMatchObject({
      threadId: 'thread1',
      forkEntryId: 'resp2',
      completedAtMs: expect.any(Number),
      turnDurationMs: expect.any(Number),
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      result: 'Whole reply',
    }));
    expect(fake.upsertPiCoreMessages).not.toHaveBeenCalled();
  });

  it('emits Pi agent_end provider errors', async () => {
    const { fake, events } = createPiEventFake();
    const errorMessage =
      '429 {"error":{"type":"rate_limit_error","message":"Type 2b rate limited. Please try again later."}}';

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [],
        errorMessage,
        responseId: 'resp_error',
        timestamp: 789,
      }],
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      error: errorMessage,
      source: 'chat_thread_do_pi',
      status: 429,
      errorType: 'rate_limit_error',
    }));
  });

  it('records Bedrock 524 assistant errors with structured provider metadata', async () => {
    const { fake, events } = createPiEventFake();
    fake.piCurrentUsageProvider = 'bedrock';
    fake.piCurrentBillingSource = 'byok';
    fake.piSession = {
      state: {
        model: { id: 'us.anthropic.claude-opus-4-8' },
      },
    };
    const errorMessage = 'Bedrock request failed with HTTP 524: error code: 524';

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [],
        errorMessage,
        responseId: 'resp_bedrock_524',
        timestamp: 789,
      }],
    });

    expect(events).toContainEqual(expect.objectContaining({
      type: 'error',
      error: errorMessage,
      source: 'chat_thread_do_pi',
      billingSource: 'byok',
      provider: 'bedrock',
      status: 524,
    }));
  });

  it('does not emit provider errors for user-aborted Pi turns', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [{
        role: 'assistant',
        content: [],
        stopReason: 'aborted',
        errorMessage: 'Request was aborted',
        responseId: 'resp_aborted',
        timestamp: 789,
      }],
    });

    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      result: '',
    }));
  });

  it('emits and persists a final stopped-by-user Pi message after a user stop', async () => {
    const { fake, events } = createPiEventFake();
    fake.updateActiveAutomationRun = vi.fn();
    const inFlight = [
      { role: 'user', content: 'build it', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'tool1',
          name: 'bash',
          arguments: { command: 'sleep 60' },
        }],
        responseId: 'resp_tool',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'toolUse',
      },
    ];

    fake.piUserStopRequestedAtMs = 1234;
    fake.piMainBaselineIndex = 3;
    fake.piSession = {
      state: {
        model: { api: 'test', provider: 'test', id: 'test-model' },
        messages: [
          { role: 'user', content: 'previous', timestamp: 50 },
          ...inFlight,
          {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            stopReason: 'aborted',
            errorMessage: 'Request was aborted',
            responseId: 'resp_aborted',
            timestamp: 789,
          },
        ],
      },
    };

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    fake.piUserStopRequestedAtMs = 1234;
    fake.piMainBaselineIndex = 3;
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [
        ...inFlight,
        {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
          responseId: 'resp_aborted',
          timestamp: 789,
        },
      ],
    });

    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
      ...inFlight,
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        stopReason: 'aborted',
        responseId: 'pi_user_stop_1234',
        timestamp: 1234,
        metadata: { reason: 'user_stop' },
      }),
    ]);
    expect(events).toContainEqual({
      type: 'runtime_event',
      event: {
        method: 'item/agentMessage/delta',
        params: {
          threadId: 'thread1',
          itemId: 'pi_user_stop_1234',
          itemKind: 'userStop',
          delta: 'Stopped by user',
        },
      },
    });
    expect(events).toContainEqual(expect.objectContaining({
      type: 'result',
      result: 'Stopped by user',
    }));
    expect(events.some((event) => event.type === 'error')).toBe(false);
    expect(fake.updateActiveAutomationRun).toHaveBeenCalledWith({
      status: 'error',
      message: 'Stopped by user',
      completedAt: expect.any(Number),
      clear: true,
    });
    expect(fake.piSession.state.messages).toEqual([
      { role: 'user', content: 'previous', timestamp: 50 },
      ...inFlight,
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        responseId: 'pi_user_stop_1234',
      }),
    ]);
    expect(fake.piMainBaselineIndex).toBe(4);
    expect(fake.piUserStopRequestedAtMs).toBe(0);
  });

  it('preserves js_exec artifact metadata when persisting a stopped Pi turn', async () => {
    const { fake } = createPiEventFake();
    fake.updateActiveAutomationRun = vi.fn();
    const artifact = {
      id: 'artifact_1',
      kind: 'outbound_email',
      toolName: 'send_email',
      status: 'sent',
      title: 'Email sent',
      createdAt: 1,
      updatedAt: 2,
      summary: { to: 'alice@example.com' },
    };
    // The stop path consumes buffered artifacts from the live session tail, so
    // the unpersisted tool result carries no UI metadata until it is attached.
    const toolResult = {
      role: 'toolResult',
      toolCallId: 'tool_js_exec_1',
      toolName: 'js_exec',
      content: 'ok',
      timestamp: 200,
    };
    fake.consumeCodeModeArtifacts = vi.fn(async () => [artifact]);

    fake.piUserStopRequestedAtMs = 1234;
    fake.piMainBaselineIndex = 1;
    fake.piSession = {
      state: {
        model: { api: 'test', provider: 'test', id: 'test-model' },
        messages: [
          { role: 'user', content: 'previous', timestamp: 50 },
          toolResult,
          {
            role: 'assistant',
            content: [{ type: 'text', text: '' }],
            stopReason: 'aborted',
            errorMessage: 'Request was aborted',
            responseId: 'resp_aborted',
            timestamp: 789,
          },
        ],
      },
    };

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    fake.piUserStopRequestedAtMs = 1234;
    fake.piMainBaselineIndex = 1;
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: [
        toolResult,
        {
          role: 'assistant',
          content: [{ type: 'text', text: '' }],
          stopReason: 'aborted',
          errorMessage: 'Request was aborted',
          responseId: 'resp_aborted',
          timestamp: 789,
        },
      ],
    });

    expect(fake.consumeCodeModeArtifacts).toHaveBeenCalledWith('tool_js_exec_1', {
      deleteAfterRead: true,
    });
    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledWith([
      expect.objectContaining({
        role: 'toolResult',
        toolCallId: 'tool_js_exec_1',
        toolName: 'js_exec',
        uiMetadata: { codeModeArtifacts: [artifact] },
      }),
      expect.objectContaining({
        role: 'assistant',
        content: [{ type: 'text', text: 'Stopped by user' }],
        metadata: { reason: 'user_stop' },
      }),
    ]);
  });

  it('does not echo non-assistant Pi message_end text into the assistant stream', async () => {
    const { fake, events } = createPiEventFake();

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, { type: 'agent_start' });
    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'message_end',
      message: {
        role: 'user',
        content: 'please do the thing',
      },
    });

    expect(events.filter((event) => event.type === 'runtime_event')).toEqual([]);
  });

  it('prunes unpersisted Pi session messages when agent_end arrives without a successful turn_end', async () => {
    const { fake } = createPiEventFake();
    const previousMessage = { role: 'user', content: 'previous turn', timestamp: 50 };
    const failedTurnMessages = [
      { role: 'user', content: 'current turn', timestamp: 100 },
      {
        role: 'assistant',
        content: [{
          type: 'toolCall',
          id: 'call_1|fc_tmp_1',
          name: 'js_exec',
          arguments: {},
        }],
        stopReason: 'error',
        errorMessage: 'Provider returned error',
        responseId: 'resp_error',
        timestamp: 200,
      },
    ];
    fake.piSession = {
      state: {
        model: { api: 'test', provider: 'test', id: 'test-model' },
        messages: [previousMessage, ...failedTurnMessages],
      },
    };
    fake.piMainBaselineIndex = 1;

    await ChatThreadDO.prototype['handlePiSessionEvent'].call(fake, {
      type: 'agent_end',
      messages: failedTurnMessages,
    });

    expect(fake.appendPiCoreMessagesIfMissing).not.toHaveBeenCalled();
    expect(fake.piSession.state.messages).toEqual([previousMessage]);
    expect(fake.piMainBaselineIndex).toBe(1);
  });

  it('persists and broadcasts todo state from direct runner events', async () => {
    const put = vi.fn();
    const deleteKey = vi.fn();
    const sent: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [];
    fake.ctx = {
      storage: { kv: { put, delete: deleteKey } },
      getWebSockets: vi.fn(() => [{ send: vi.fn((message: string) => sent.push(message)) }]),
    };
    fake.trace = vi.fn();
    installAgentStateMocks(fake);

    await ChatThreadDO.prototype.setTodoState.call(fake, [
      { content: 'Check state', status: 'in_progress' },
    ]);

    expect(put).toHaveBeenCalledWith('chatTodos', [
      { content: 'Check state', status: 'in_progress', activeForm: 'Check state' },
    ]);
    expect(fake.setState).toHaveBeenCalledWith(expect.objectContaining({
      currentTodos: [{ content: 'Check state', status: 'in_progress', activeForm: 'Check state' }],
    }));

    await ChatThreadDO.prototype.setTodoState.call(fake, []);

    expect(deleteKey).toHaveBeenCalledWith('chatTodos');
  });

  it('normalizes todo state aliases before persisting and broadcasting', async () => {
    const put = vi.fn();
    const sent: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [];
    fake.ctx = {
      storage: { kv: { put, delete: vi.fn() } },
      getWebSockets: vi.fn(() => [{ send: vi.fn((message: string) => sent.push(message)) }]),
    };
    fake.trace = vi.fn();
    installAgentStateMocks(fake);

    await ChatThreadDO.prototype.setTodoState.call(fake, [
      { step: 'Inspect logs', status: 'inProgress' },
      { title: 'Patch proxy env', status: 'running', active_form: 'Patching proxy env' },
      'Retry deploy',
    ]);

    const expected = [
      { content: 'Inspect logs', status: 'in_progress', activeForm: 'Inspect logs' },
      { content: 'Patch proxy env', status: 'in_progress', activeForm: 'Patching proxy env' },
      { content: 'Retry deploy', status: 'pending', activeForm: 'Retry deploy' },
    ];
    expect(put).toHaveBeenCalledWith('chatTodos', expected);
    expect(fake.setState).toHaveBeenCalledWith(expect.objectContaining({
      currentTodos: expected,
    }));
  });

  it('hydrates persisted todo state when requested', () => {
    const get = vi.fn(() => [
      { content: 'Stored task', status: 'running', active_form: 'Running stored task' },
      { title: 'Stored pending task' },
    ]);
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [];
    fake.ctx = {
      storage: { kv: { get } },
    };

    const todos = ChatThreadDO.prototype.getTodoState.call(fake);

    const expected = [
      { content: 'Stored task', status: 'in_progress', activeForm: 'Running stored task' },
      { content: 'Stored pending task', status: 'pending', activeForm: 'Stored pending task' },
    ];
    expect(get).toHaveBeenCalledWith('chatTodos');
    expect(todos).toEqual(expected);
    expect(fake.currentTodos).toEqual(expected);
  });

  it('marks todos complete and removes persisted todo state when a turn ends', async () => {
    const deleteKey = vi.fn();
    const sent: string[] = [];
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [
      { content: 'Check state', status: 'in_progress', activeForm: 'Checking state' },
      { content: 'Summarize', status: 'pending', activeForm: 'Summarizing' },
    ];
    fake.ctx = {
      storage: { kv: { delete: deleteKey } },
      getWebSockets: vi.fn(() => [{ send: vi.fn((message: string) => sent.push(message)) }]),
    };
    fake.trace = vi.fn();
    installAgentStateMocks(fake);

    await ChatThreadDO.prototype.completeTodoStateForTurnEnd.call(fake);

    expect(fake.currentTodos).toEqual([]);
    expect(deleteKey).toHaveBeenCalledWith('chatTodos');
    expect(fake.setState).toHaveBeenCalledWith(expect.objectContaining({
      currentTodos: [
        { content: 'Check state', status: 'completed', activeForm: 'Checking state' },
        { content: 'Summarize', status: 'completed', activeForm: 'Summarizing' },
      ],
    }));
  });

  it('clears stale non-streaming todo state when a chat connects', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.chatContext = {
      threadId: 'thread1',
      workspaceId: 'workspace1',
      orgId: 'org1',
    };
    const background: Promise<unknown>[] = [];
    fake.ctx = {
      storage: { kv: { put: vi.fn() } },
      waitUntil: vi.fn((promise: Promise<unknown>) => background.push(promise)),
    };
    fake.maybeGenerateChatGroupAvatarForThread = vi.fn(async () => undefined);
    fake.messages = [];
    fake.chatIsStreaming = false;
    fake.currentTodos = [{ content: 'Old task', status: 'in_progress' }];
    fake.syncAgentState = vi.fn();
    fake.sweepOrphanedActiveTurnMarker = vi.fn(async () => {});
    fake.topUpUiMessagesFromPiCore = vi.fn(async () => {});
    fake.healLegacyUiMessageTimes = vi.fn(async () => {});
    fake.healLegacyUiMessageAuthors = vi.fn(async () => {});
    fake.recordChatThreadObservabilityEvent = vi.fn();
    // Mirror the real method: it clears the todos and syncs an override marking
    // them completed.
    fake.completeTodoStateForTurnEnd = vi.fn(async () => {
      fake.currentTodos = [];
      fake.syncAgentState({
        currentTodos: [{ content: 'Old task', status: 'completed' }],
      });
    });

    const connection = { close: vi.fn(), serializeAttachment: vi.fn() };
    const ctx = {
      request: new Request('https://example.com/ws?threadId=thread1&workspaceId=workspace1&orgId=org1'),
    };

    await ChatThreadDO.prototype.onConnect.call(fake, connection, ctx);
    await Promise.all(background);

    expect(fake.completeTodoStateForTurnEnd).toHaveBeenCalledTimes(1);
    // The immediate handshake sync is followed by the completed-todo override;
    // background reconciliation must not overwrite that final correction.
    expect(fake.syncAgentState).toHaveBeenCalledTimes(2);
    expect(fake.syncAgentState).toHaveBeenCalledWith(
      expect.objectContaining({
        currentTodos: [{ content: 'Old task', status: 'completed' }],
      }),
    );
    expect(connection.close).not.toHaveBeenCalled();
  });

  it('syncs generated thread titles through Agent state', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;

    fake.currentTodos = [];
    fake.trace = vi.fn();
    fake.browserPrompts = {
      sendPendingPromptsToWebSocket: vi.fn(),
      pendingQuestionPrompts: vi.fn(() => []),
      pendingQuestionCount: 0,
    };
    installAgentStateMocks(fake);

    await ChatThreadDO.prototype.setTitle.call(
      fake,
      'Generated title',
      1_710_000_000_000,
    );

    expect(fake.setState).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Generated title',
      titleUpdatedAt: 1_710_000_000_000,
    }));
  });

  it('selects raw Durable Object Pi messages for a fork target', async () => {
    const sourceMessages = [
      { role: 'user', content: 'Build it', timestamp: 100 },
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'Done' }],
        responseId: 'resp1',
        timestamp: 200,
        api: 'test',
        provider: 'test',
        model: 'test',
        usage: {},
        stopReason: 'stop',
      },
      { role: 'user', content: 'Too far', timestamp: 300 },
    ];
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => sourceMessages);

    const result = await ChatThreadDO.prototype.getPiCoreForkMessages.call(fake, {
      forkEntryId: 'resp1',
    });

    expect(result).toMatchObject({
      success: true,
      messageCount: 2,
      messages: [
        expect.objectContaining({ role: 'user', content: 'Build it' }),
        expect.objectContaining({ role: 'assistant', responseId: 'resp1' }),
      ],
    });
    expect(result.messages).not.toBe(sourceMessages);
    expect(result.messages?.[1]).not.toBe(sourceMessages[1]);
  });

  it('reports a missing Durable Object Pi fork target without falling back', async () => {
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.loadPiCoreMessages = vi.fn(() => [
      { role: 'user', content: 'Build it', timestamp: 100 },
    ]);

    const result = await ChatThreadDO.prototype.getPiCoreForkMessages.call(fake, {
      forkEntryId: 'missing',
      renderedMessageId: 'rendered-missing',
    });

    expect(result).toEqual({
      success: false,
      code: 'TARGET_NOT_FOUND',
      error: 'Fork target not found in Durable Object Pi messages',
    });
  });

  it('sends channel email attachments from mounted workspace output paths', async () => {
    const send = vi.fn(async () => ({ messageId: 'email-1' }));
    const kvPutMock = vi.fn(async () => undefined);
    const recordThreadChannelUsed = vi.fn(async () => null);
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/report.pdf'
        ? r2Object('pdf bytes', 'application/pdf')
        : null
    );
    const thread = {
      id: 'thread1',
      workspace_id: 'workspace1',
      source: 'channel',
      channel_kind: 'email',
      channel_connection_id: 'workspace@camelai.dev',
      channel_conversation_id: 'message:email-0',
      channel_message_id: 'email-0',
    };
    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = {
      EMAIL: { send },
      APP_KV: { get: vi.fn(async () => null), put: kvPutMock },
      R2_BUCKET: { get },
      ORG: createChannelOrgNamespace({ thread, recordThreadChannelUsed }),
      WORKSPACE_EMAIL_DOMAIN: 'camelai.dev',
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getInfo: vi.fn(async () => ({
            id: 'workspace1',
            name: 'Test Workspace',
            email_handle: 'workspace-agent',
          })),
        })),
      },
    };

    const result = await ChannelTools.prototype['sendChannelEmailTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        to: 'sender@example.com',
        subject: 'Report',
        text: 'Attached.',
        attachments: [{ path: 'outputs/report.pdf' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      provider: 'cloudflare_email',
      attachmentCount: 1,
    });
    expect(get).toHaveBeenCalledWith('org1/workspace1/user-outputs/report.pdf');
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.from).toBe('Camel <workspace-agent@camelai.dev>');
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]).toMatchObject({
      filename: 'report.pdf',
      type: 'application/pdf',
      disposition: 'attachment',
    });
    expect(message.attachments[0].content).toBeInstanceOf(ArrayBuffer);
    expect(kvPutMock).toHaveBeenCalledWith(
      'email_reply_ref:workspace1:email-1',
      'thread1',
      { expirationTtl: 180 * 24 * 60 * 60 },
    );
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'email');
  });

  it('rejects oversized channel attachments before buffering R2 object content', async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/large.bin'
        ? {
            size: 26 * 1024 * 1024,
            httpMetadata: { contentType: 'application/octet-stream' },
            arrayBuffer,
          }
        : null
    );
    const fake = Object.create(ChannelTools.prototype) as any;
    fake.env = { R2_BUCKET: { get } };

    await expect(
      ChannelTools.prototype['resolveChannelOutboundAttachments'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1' },
        { attachments: [{ path: 'outputs/large.bin' }] },
      ),
    ).rejects.toThrow('Attachment size must be 25 MB or less');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('uploads Slack channel attachments through the external file upload flow', async () => {
    const encrypted = await encryptCredentials(
      { access_token: 'xoxb-token', team_id: 'T1' },
      'secret',
    );
    const recordThreadChannelUsed = vi.fn(async () => null);
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/chart.png'
        ? r2Object('png bytes', 'image/png')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/files.getUploadURLExternal')) {
        return Response.json({
          ok: true,
          upload_url: 'https://files.slack.com/upload/v1/abc',
          file_id: 'F123',
        });
      }
      if (url === 'https://files.slack.com/upload/v1/abc') {
        expect(init?.body).toBeInstanceOf(ArrayBuffer);
        return new Response('OK - 9');
      }
      if (url.endsWith('/files.completeUploadExternal')) {
        const payload = JSON.parse(String(init?.body));
        expect(payload).toMatchObject({
          channel_id: 'C1',
          thread_ts: '1700000000.000100',
          initial_comment: 'Attached.',
          files: [{ id: 'F123', title: 'chart.png' }],
        });
        return Response.json({
          ok: true,
          ts: '1700000001.000200',
          files: [{ id: 'F123' }],
        });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'slack',
      channel_connection_id: 'slack-int',
      channel_conversation_id: 'T1:C1:1700000000.000100',
    }));
    fake.env = {
      INTEGRATION_SECRET_KEY: 'secret',
      ORG: createChannelOrgNamespace({
        recordThreadChannelUsed,
        integration: {
          id: 'slack-int',
          integration_type: 'slack',
          config: JSON.stringify({ team_id: 'T1' }),
          credentials_encrypted: encrypted,
        },
      }),
      R2_BUCKET: { get },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegrations: vi.fn(async () => [{
            id: 'slack-int',
            integration_type: 'slack',
            config: JSON.stringify({ team_id: 'T1' }),
          }]),
          getIntegration: vi.fn(async () => ({
            integration_type: 'slack',
            credentials_encrypted: encrypted,
          })),
        })),
      },
    };

    const result = await ChannelTools.prototype['sendChannelSlackMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        text: 'Attached.',
        attachments: [{ path: 'outputs/chart.png' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'slack',
      attachmentCount: 1,
      fileIds: ['F123'],
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'slack');
  });

  it('sends Telegram channel attachments as documents', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/report.csv'
        ? r2Object('a,b\n1,2\n', 'text/csv')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendMessage')) {
        const payload = JSON.parse(String(init?.body));
        expect(payload).toMatchObject({ chat_id: '12345', text: 'Attached.' });
        return Response.json({ ok: true, result: { message_id: 10 } });
      }
      if (url.endsWith('/sendDocument')) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get('chat_id')).toBe('12345');
        expect(form.get('caption')).toBe('CSV');
        expect(form.get('document')).toBeInstanceOf(File);
        return Response.json({ ok: true, result: { message_id: 11 } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: createChannelOrgNamespace({
        recordThreadChannelUsed,
        integration: {
          id: 'telegram-int',
          integration_type: 'telegram',
          config: JSON.stringify({ chat_id: '12345' }),
        },
      }),
      R2_BUCKET: { get },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        text: 'Attached.',
        attachments: [{ path: 'outputs/report.csv', caption: 'CSV' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      attachmentCount: 1,
      messageIds: [10, 11],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('selects Slack connection by decrypted team id when sending outside Slack threads', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
    const wrongEncrypted = await encryptCredentials(
      { access_token: 'xoxb-wrong', team_id: 'T-wrong' },
      'secret',
    );
    const rightEncrypted = await encryptCredentials(
      { access_token: 'xoxb-right', team_id: 'T-right' },
      'secret',
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://slack.com/api/chat.postMessage');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer xoxb-right');
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        channel: 'C-right',
        thread_ts: '1700000000.000300',
        text: 'Hello',
      });
      return Response.json({ ok: true, ts: '1700000001.000400' });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      INTEGRATION_SECRET_KEY: 'secret',
      ORG: createChannelOrgNamespace({
        recordThreadChannelUsed,
        integrations: [
          { id: 'wrong', integration_type: 'slack', credentials_encrypted: wrongEncrypted },
          { id: 'right', integration_type: 'slack', credentials_encrypted: rightEncrypted },
        ],
      }),
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegrations: vi.fn(async () => [
            { id: 'wrong', integration_type: 'slack', credentials_encrypted: wrongEncrypted },
            { id: 'right', integration_type: 'slack', credentials_encrypted: rightEncrypted },
          ]),
        })),
      },
    };

    const result = await ChannelTools.prototype['sendChannelSlackMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        text: 'Hello',
        team_id: 'T-right',
        channel_id: 'C-right',
        thread_ts: '1700000000.000300',
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'slack',
      teamId: 'T-right',
      channelId: 'C-right',
      ts: '1700000001.000400',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'slack');
  });

  it('rejects raw Telegram chat ids outside Telegram threads without a workspace integration', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: createChannelOrgNamespace({ integrations: [] }),
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegrations: vi.fn(async () => []),
        })),
      },
    };

    await expect(
      ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          chat_id: '12345',
          text: 'Hello',
        },
      ),
    ).rejects.toThrow('No connected Telegram integrations are available');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out stalled Telegram sends', async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
      );
      vi.stubGlobal('fetch', fetchMock);

      const fake = Object.create(ChannelTools.prototype) as any;
      fake.getOriginatingChannelThread = vi.fn(async () => null);
      fake.env = {
        TELEGRAM_BOT_TOKEN: 'bot-token',
        ORG: createChannelOrgNamespace({
          integration: {
            id: 'telegram-int',
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          },
        }),
        R2_BUCKET: { get: vi.fn() },
        WORKSPACE: {
          idFromName: vi.fn((id: string) => id),
          get: vi.fn(() => ({
            getIntegration: vi.fn(async () => ({
              id: 'telegram-int',
              integration_type: 'telegram',
              config: JSON.stringify({ chat_id: '12345' }),
            })),
          })),
        },
      };

      const promise = ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          integration_id: 'telegram-int',
          text: 'Hello',
        },
      );

      const assertion = expect(promise).rejects.toThrow(
        'Telegram sendMessage request timed out after 15000ms',
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-selects the only connected Telegram integration outside Telegram threads', async () => {
    const appendChannelHistoryEvent = vi.fn(async () => ({ status: 'appended' }));
    const recordThreadChannelUsed = vi.fn(async () => null);
    const getIntegration = vi.fn(async () => ({
      id: 'telegram-int',
      integration_type: 'telegram',
      name: 'Product Telegram',
      config: JSON.stringify({
        chat_id: '12345',
        chat_title: 'Product team',
      }),
    }));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/sendMessage$/);
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({ chat_id: '12345', text: 'Hello' });
      return Response.json({ ok: true, result: { message_id: 20 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: createChannelOrgNamespace({
        thread: { id: 'telegram-thread', title: 'Product team' },
        recordThreadChannelUsed,
        integration: {
          id: 'telegram-int',
          integration_type: 'telegram',
          name: 'Product Telegram',
          config: JSON.stringify({
            chat_id: '12345',
            chat_title: 'Product team',
          }),
        },
        integrations: [{
          id: 'telegram-int',
          integration_type: 'telegram',
          config: JSON.stringify({ chat_id: '12345' }),
        }],
      }),
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegrations: vi.fn(async () => [{
            id: 'telegram-int',
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          }]),
          getIntegration,
        })),
      },
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === 'channel_thread:telegram:workspace1:telegram-int:12345'
            ? 'telegram-thread'
            : null
        ),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ appendChannelHistoryEvent })),
      },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      { text: 'Hello' },
    );

    expect(getIntegration).not.toHaveBeenCalled();
    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      chatId: '12345',
      integrationId: 'telegram-int',
      messageIds: [20],
      channelHistoryStatus: 'recorded',
    });
    expect(appendChannelHistoryEvent).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('sends Telegram messages through a configured workspace integration outside Telegram threads', async () => {
    const appendChannelHistoryEvent = vi.fn(async () => ({ status: 'appended' }));
    const recordThreadChannelUsed = vi.fn(async () => null);
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/sendMessage$/);
      const payload = JSON.parse(String(init?.body));
      expect(payload).toMatchObject({
        chat_id: '12345',
        text: '<b>Hello</b> &amp; <i>there</i>',
        parse_mode: 'HTML',
      });
      return Response.json({ ok: true, result: { message_id: 19 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: createChannelOrgNamespace({
        thread: { id: 'telegram-thread', title: 'Product team' },
        recordThreadChannelUsed,
        integration: {
          id: 'telegram-int',
          integration_type: 'telegram',
          name: 'Product Telegram',
          config: JSON.stringify({
            chat_id: '12345',
            chat_title: 'Product team',
          }),
        },
      }),
      R2_BUCKET: { get: vi.fn() },
      WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegration: vi.fn(async () => ({
            id: 'telegram-int',
            integration_type: 'telegram',
            name: 'Product Telegram',
            config: JSON.stringify({
              chat_id: '12345',
              chat_title: 'Product team',
            }),
          })),
        })),
      },
      APP_KV: {
        get: vi.fn(async (key: string) =>
          key === 'channel_thread:telegram:workspace1:telegram-int:12345'
            ? 'telegram-thread'
            : null
        ),
        put: vi.fn(async () => undefined),
        delete: vi.fn(async () => undefined),
      },
      CHAT_THREAD: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ appendChannelHistoryEvent })),
      },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        integration_id: 'telegram-int',
        chat_id: '12345',
        text: '**Hello** & _there_',
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      chatId: '12345',
      integrationId: 'telegram-int',
      messageIds: [19],
      channelHistoryStatus: 'recorded',
    });
    expect(appendChannelHistoryEvent).toHaveBeenCalledWith(expect.objectContaining({
      threadId: 'telegram-thread',
      workspaceId: 'workspace1',
      orgId: 'org1',
      channelKind: 'telegram',
      connectionId: 'telegram-int',
      remoteConversationId: '12345',
      sourceThreadId: 'thread1',
      direction: 'outbound',
      text: '**Hello** & _there_',
      providerMessageIds: [19],
      attachmentCount: 0,
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('appends outbound channel history as persisted Pi context', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
    const fake = Object.create(ChatThreadDO.prototype) as any;
    fake.chatContext = { threadId: 'telegram-thread' };
    fake.env = {
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadChannelUsed })),
      },
    };
    fake.appendPiCoreMessagesIfMissing = vi.fn(async () => undefined);
    fake.recordChatThreadObservabilityEvent = vi.fn();
    fake.piMainBaselineIndex = 0;
    fake.piSession = { state: { messages: [], isStreaming: false } };
    // Commit 3b mirrors the channel event into the linear render history.
    fake.ctx = { waitUntil: vi.fn() };
    fake.messages = [];
    fake.persistMessages = vi.fn(async () => undefined);

    const result = await ChatThreadDO.prototype.appendChannelHistoryEvent.call(fake, {
      threadId: 'telegram-thread',
      orgId: 'org1',
      channelKind: 'telegram',
      connectionId: 'telegram-int',
      remoteConversationId: '12345',
      sourceThreadId: 'scheduler-thread',
      direction: 'outbound',
      text: 'Weekly update.',
      providerMessageIds: [42],
      sentAt: Date.UTC(2026, 4, 29, 16, 0, 0),
    });

    expect(result).toEqual({ status: 'appended' });
    expect(fake.appendPiCoreMessagesIfMissing).toHaveBeenCalledTimes(1);
    const message = fake.appendPiCoreMessagesIfMissing.mock.calls[0][0][0];
    expect(message).toMatchObject({
      role: 'user',
      timestamp: Date.UTC(2026, 4, 29, 16, 0, 0),
    });
    expect(message.content).toContain('already-delivered channel history');
    expect(message.content).toContain('Weekly update.');
    expect(fake.piSession.state.messages).toHaveLength(1);
    expect(fake.piMainBaselineIndex).toBe(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith(
      'telegram-thread',
      'telegram',
    );
    // The render-history mirror is a linear persistMessages append (channelHistory
    // metadata), not a new turn.
    expect(fake.persistMessages).toHaveBeenCalledTimes(1);
    const renderMessages = fake.persistMessages.mock.calls[0][0];
    const mirrored = renderMessages[renderMessages.length - 1];
    expect(mirrored).toMatchObject({
      role: 'user',
      metadata: { channelHistory: true },
    });
    expect(mirrored.parts[0]).toMatchObject({ type: 'text', text: 'Weekly update.' });
  });

  it('rejects mismatched Telegram chat ids for workspace integrations', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => null);
      fake.env = {
        TELEGRAM_BOT_TOKEN: 'bot-token',
        ORG: createChannelOrgNamespace({
          integration: {
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          },
        }),
        R2_BUCKET: { get: vi.fn() },
        WORKSPACE: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({
          getIntegration: vi.fn(async () => ({
            integration_type: 'telegram',
            config: JSON.stringify({ chat_id: '12345' }),
          })),
        })),
      },
    };

    await expect(
      ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          integration_id: 'telegram-int',
          chat_id: '67890',
          text: 'Hello',
        },
      ),
    ).rejects.toThrow('Telegram chat_id does not match the configured workspace integration');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Telegram image attachments as photos', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/chart.png'
        ? r2Object('png bytes', 'image/png')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendPhoto')) {
        expect(init?.body).toBeInstanceOf(FormData);
        const form = init?.body as FormData;
        expect(form.get('chat_id')).toBe('12345');
        expect(form.get('caption')).toBe('Chart');
        expect(form.get('photo')).toBeInstanceOf(File);
        expect(form.get('document')).toBeNull();
        return Response.json({ ok: true, result: { message_id: 20 } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadChannelUsed })),
      },
      R2_BUCKET: { get },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        attachments: [{ path: 'outputs/chart.png', caption: 'Chart' }],
      },
    );

    expect(result.details).toMatchObject({
      status: 'sent',
      channel: 'telegram',
      attachmentCount: 1,
      messageIds: [20],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('falls back to Telegram documents when photo upload is rejected', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/large-photo.png'
        ? r2Object('png bytes', 'image/png')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/sendPhoto')) {
        expect(init?.body).toBeInstanceOf(FormData);
        return Response.json({ ok: false, description: 'PHOTO_INVALID_DIMENSIONS' }, { status: 400 });
      }
      if (url.endsWith('/sendDocument')) {
        const form = init?.body as FormData;
        expect(form.get('chat_id')).toBe('12345');
        expect(form.get('document')).toBeInstanceOf(File);
        return Response.json({ ok: true, result: { message_id: 21 } });
      }
      throw new Error(`Unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadChannelUsed })),
      },
      R2_BUCKET: { get },
    };

    try {
      const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
        fake,
        { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
        {
          attachments: [{ path: 'outputs/large-photo.png' }],
        },
      );

      expect(result.details).toMatchObject({
        status: 'sent',
        channel: 'telegram',
        attachmentCount: 1,
        messageIds: [21],
      });
    } finally {
      warnSpy.mockRestore();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  it('respects explicit Telegram send_as document for image attachments', async () => {
    const recordThreadChannelUsed = vi.fn(async () => null);
    const get = vi.fn(async (key: string) =>
      key === 'org1/workspace1/user-outputs/chart.png'
        ? r2Object('png bytes', 'image/png')
        : null
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      expect(url).toMatch(/\/sendDocument$/);
      const form = init?.body as FormData;
      expect(form.get('document')).toBeInstanceOf(File);
      expect(form.get('photo')).toBeNull();
      return Response.json({ ok: true, result: { message_id: 22 } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const fake = Object.create(ChannelTools.prototype) as any;
    fake.getOriginatingChannelThread = vi.fn(async () => ({
      source: 'channel',
      channel_kind: 'telegram',
      channel_conversation_id: '12345',
    }));
    fake.env = {
      TELEGRAM_BOT_TOKEN: 'bot-token',
      ORG: {
        idFromName: vi.fn((id: string) => id),
        get: vi.fn(() => ({ recordThreadChannelUsed })),
      },
      R2_BUCKET: { get },
    };

    const result = await ChannelTools.prototype['sendChannelTelegramMessageTool'].call(
      fake,
      { orgId: 'org1', workspaceId: 'workspace1', threadId: 'thread1' },
      {
        attachments: [{ path: 'outputs/chart.png', send_as: 'document' }],
      },
    );

    expect(result.details.messageIds).toEqual([22]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordThreadChannelUsed).toHaveBeenCalledWith('thread1', 'telegram');
  });

  describe('agent loop failure & recovery guards', () => {
    // --- sendRunnerCommand: durable recoverability handoff ---

    it('does NOT clear or tear down the in-flight turn when a steer-path refresh throws', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      // A message arrives while a turn is already streaming -> steer branch.
      fake.piSession = { state: { isStreaming: true }, steer: vi.fn() };
      fake.ctx = { waitUntil: vi.fn() };
      fake.messages = [];
      fake.recordPiTurnJournalSteerMessage = vi.fn();
      fake.buildUserUiSkeleton = vi.fn(() => ({ id: 'u', role: 'user', parts: [] }));
      fake.persistMessages = vi.fn(async () => {});
      fake.pushChatEvent = vi.fn();
      fake.emitChatError = vi.fn();
      // The model refresh fails mid-steer (e.g. the BYOK config vanished).
      fake.refreshPiSessionModel = vi.fn(() =>
        Promise.reject(new Error('config gone')),
      );
      fake.clearPiActiveTurnAndJournal = vi.fn();
      fake.finishTurn = vi.fn();

      const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
        type: 'message',
        content: 'also rename the table',
        rawContent: 'also rename the table',
        authorDisplayName: 'Illiana Reed',
        messageSource: 'slack',
      });
      expect(accepted).toBe(true);
      await flushWaitUntil(fake);

      // The steer message was journaled BEFORE the refresh (synchronously), so a
      // later resume re-delivers it. The still-streaming turn is owned by its own
      // onChatMessage — a steer-side failure must NOT erase that turn's
      // marker/journal or tear it down (it is still live).
      expect(fake.recordPiTurnJournalSteerMessage).toHaveBeenCalledTimes(1);
      expect(fake.buildUserUiSkeleton).toHaveBeenCalledWith({
        rawContent: 'also rename the table',
        clientMessageId: undefined,
        authorDisplayName: 'Illiana Reed',
        messageSource: 'slack',
        piCoreMessageKey: expect.any(Number),
        sentDuringStreaming: true,
      });
      expect(fake.persistMessages).toHaveBeenCalledWith([
        { id: 'u', role: 'user', parts: [] },
      ]);
      expect(fake.emitChatError).toHaveBeenCalledWith(
        'Your message could not be delivered to the running turn. Please resend it.',
      );
      expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
      expect(fake.finishTurn).not.toHaveBeenCalled();
    });

    it('keeps a fresh turn recoverable (marker not cleared) when handing it to ai-chat', async () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      // No turn in flight -> this call starts a new (recoverable) turn.
      fake.piSession = { state: { isStreaming: false }, prompt: vi.fn() };
      fake.ctx = { waitUntil: vi.fn() };
      fake.pendingPiPromptQueue = [];
      fake.readPiActiveTurn = vi.fn(() => null);
      fake.openPiActiveTurnIfAbsent = vi.fn();
      fake.recordPiTurnJournalUserMessage = vi.fn();
      fake.buildUserUiSkeleton = vi.fn(() => ({ id: 'u', role: 'user', parts: [] }));
      fake.saveMessages = vi.fn(async () => ({ status: 'completed' }));
      fake.clearPiActiveTurnAndJournal = vi.fn();
      fake.recordChatThreadObservabilityEvent = vi.fn();

      const accepted = ChatThreadDO.prototype['sendRunnerCommand'].call(fake, {
        type: 'message',
        content: 'build the dashboard',
      });
      expect(accepted).toBe(true);
      await flushWaitUntil(fake);

      // The turn is made durable up front and handed to ai-chat; onChatMessage owns
      // any failure teardown, so sendRunnerCommand must NOT clear the marker here —
      // that would race the recovery fiber that wraps the saveMessages turn.
      expect(fake.openPiActiveTurnIfAbsent).toHaveBeenCalledTimes(1);
      expect(fake.recordPiTurnJournalUserMessage).toHaveBeenCalledTimes(1);
      expect(fake.saveMessages).toHaveBeenCalledTimes(1);
      expect(fake.clearPiActiveTurnAndJournal).not.toHaveBeenCalled();
    });

    // --- appendPiCoreMessagesIfMissing: piCoreMessageKey dedup ---

    it('does not double-store the up-front-persisted first user message (dedup by shared key)', async () => {
      const existingUser = { role: 'user', content: 'hello', timestamp: 1234 };
      const appended: any[] = [];
      const unusedDependency = () => {
        throw new Error('unused test dependency');
      };
      const store = new PiCoreMessageStore({
        sql: unusedDependency,
        r2: unusedDependency,
        chatContext: () => null,
      });
      vi.spyOn(store, 'loadPiCoreMessages').mockResolvedValue([existingUser] as any[]);
      vi.spyOn(store, 'appendPiCoreMessages').mockImplementation(async (msgs: any[]) => {
        appended.push(...msgs);
      });

      // The new-chat flow persists the user message up front, then Pi's turn-end
      // commit replays it (same role/content/timestamp -> same piCoreMessageKey)
      // alongside the fresh assistant turn.
      const duplicateUser = { role: 'user', content: 'hello', timestamp: 1234 };
      const newAssistant = {
        role: 'assistant',
        content: 'hi',
        responseId: 'resp_1',
        timestamp: 1235,
      };
      await store.appendPiCoreMessagesIfMissing([
        duplicateUser,
        newAssistant,
      ]);

      // Only the assistant turn is appended; the first user message is not
      // duplicated in the transcript.
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({ role: 'assistant', responseId: 'resp_1' });
    });

    it('dedups an assistant message by responseId even when its content/timestamp changed', async () => {
      const existingAssistant = {
        role: 'assistant',
        content: 'partial',
        responseId: 'resp_9',
        timestamp: 1,
      };
      const appended: any[] = [];
      const unusedDependency = () => {
        throw new Error('unused test dependency');
      };
      const store = new PiCoreMessageStore({
        sql: unusedDependency,
        r2: unusedDependency,
        chatContext: () => null,
      });
      vi.spyOn(store, 'loadPiCoreMessages').mockResolvedValue([existingAssistant] as any[]);
      vi.spyOn(store, 'appendPiCoreMessages').mockImplementation(async (msgs: any[]) => {
        appended.push(...msgs);
      });

      // Same responseId, finalized content + later timestamp — must still dedup.
      const finalizedAssistant = {
        role: 'assistant',
        content: 'partial then more',
        responseId: 'resp_9',
        timestamp: 2,
      };
      await store.appendPiCoreMessagesIfMissing([
        finalizedAssistant,
      ]);

      expect(appended).toHaveLength(0);
      expect(store.appendPiCoreMessages).toHaveBeenCalledWith([]);
    });

    // --- isThreadStreaming: never throws (called on every state sync) ---

    it('isThreadStreaming returns false (never throws) when the active-turn read fails', () => {
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.piSession = null;
      fake.readPiActiveTurn = vi.fn(() => {
        throw new Error('kv unavailable');
      });
      // A throw here would crash syncAgentState / onConnect / todo handling for
      // the whole thread, so the derive must swallow it.
      expect(ChatThreadDO.prototype['isThreadStreaming'].call(fake)).toBe(false);
    });

    // --- error surfacing: stream error chunk + lastError state ---

    it('emits an error chunk on the turn stream so a mid-stream message stops spinning', () => {
      const writes: any[] = [];
      const fake = Object.create(ChatThreadDO.prototype) as any;
      fake.chatContext = { threadId: 'thread1' };
      fake.lastError = null;
      fake.agentEvalEventCollector = null;
      fake.activePiStreamTurnId = 'turn-1';
      fake.ctx = { storage: { sql: {} } };
      fake.recordCurrentThreadError = vi.fn();
      fake.syncAgentState = vi.fn();
      fake.piChunkEncoder = new PiChunkEncoder({ messageId: 'turn-1' });
      fake.piStreamWriter = { write: (chunk: any) => writes.push(chunk) };
      fake.piPreAttachChunkBuffer = null;

      ChatThreadDO.prototype['pushChatEvent'].call(fake, {
        type: 'error',
        error: 'boom',
      });

      // The client finalizes the mid-stream bubble off the stream's error chunk
      // (and recovers the message from lastError state) — no server-built overlay
      // to flip off, so it can't spin forever until reload.
      expect(writes).toContainEqual({ type: 'error', errorText: 'boom' });
      expect(fake.lastError).toMatchObject({ error: 'boom' });
    });
  });

});
