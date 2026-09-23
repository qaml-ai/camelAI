import { Agent, type AgentOptions, type AgentEvent, type AgentMessage, type AgentState, type AgentToolResult } from '@earendil-works/pi-agent-core';
import type { ImageContent, AssistantMessage } from '@earendil-works/pi-ai';
import { AgentRuntime, type AgentClient, type Tools, type JournalStore, type SessionCredentials } from '../../../../services/agent-runtime/clients/typescript.ts';

export interface ServiceAgentOptions {
  url: string;
  token: string;
  id: string;
  journalStore: JournalStore;
  loadCredentials(): SessionCredentials | undefined;
  saveCredentials(value: SessionCredentials): void;
  loadRequestId?(): string | undefined;
  saveRequestId?(id: string | undefined): void;
  additionalTools(): Promise<Tools>;
  authorize(): Promise<void>;
}

/** camelAI compatibility surface. The SDK/service owns execution and model history;
 * this Agent-shaped view exists only for the existing UI event encoder. */
export class ServiceAgent extends Agent {
  private client?: AgentClient;
  private serviceListeners = new Set<(event: AgentEvent, signal: AbortSignal) => void | Promise<void>>();
  private controller?: AbortController;
  private running?: Promise<void>;
  private requestId?: string;
  private commands: Promise<unknown> = Promise.resolve();
  private remote: ServiceAgentOptions;
  private get mirror() { return this.state as { -readonly [K in keyof AgentState]: AgentState[K] } & { pendingToolCalls: Set<string> }; }
  constructor(options: AgentOptions, remote: ServiceAgentOptions) {
    super(options); this.remote = remote;
  }
  override subscribe(listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>) {
    this.serviceListeners.add(listener); return () => { this.serviceListeners.delete(listener); };
  }
  override get signal() { return this.controller?.signal; }
  override waitForIdle() { return this.running?.catch(() => {}) ?? Promise.resolve(); }

  private async tools(): Promise<Tools> {
    const tools = await this.remote.additionalTools();
    for (const definition of this.state.tools) {
      if (definition.name === 'js_exec') continue; // Always executed by the service's WASM sandbox.
      // Names in both catalogs use the native tool result for direct model calls.
      tools[definition.name] = {
        description: definition.description, input: definition.parameters,
        exposure: tools[definition.name] ? 'both' : 'direct',
        executionMode: definition.executionMode, resultFormat: 'content',
        execute: async (args, { signal, callId, toolCallId }) => {
          const nativeId = toolCallId ?? callId;
          await this.remote.authorize();
          const assistantMessage = [...this.state.messages].reverse().find(message => message.role === 'assistant') as AssistantMessage;
          const context = { assistantMessage, toolCall: { type: 'toolCall' as const, id: nativeId, name: definition.name, arguments: args }, args,
            context: { systemPrompt: this.state.systemPrompt, messages: this.state.messages, tools: this.state.tools } };
          const policy = await this.beforeToolCall?.(context, signal);
          if (policy?.block) throw new Error(policy.reason ?? 'Tool call blocked');
          let result: AgentToolResult<unknown>; let isError = false;
          try { result = await definition.execute(nativeId, args, signal); }
          catch (error) { isError = true; result = { content: [{ type: 'text', text: String(error) }], details: {} }; }
          const transformed = await this.afterToolCall?.({ ...context, result, isError }, signal);
          return { ...result, ...transformed, ...(isError ? { isError: true } : {}) };
        },
      };
    }
    return tools;
  }

  async connectService() {
    this.requestId = this.remote.loadRequestId?.();
    if (this.requestId) this.controller = new AbortController();
    const runtime = new AgentRuntime({ url: this.remote.url, apiKey: this.remote.token, journalStore: this.remote.journalStore });
    const options = { tools: await this.tools(), onEvent: (event: any, requestId?: string) => this.receive(event, requestId) };
    const credentials = this.remote.loadCredentials();
    // Provider credentials live on the runtime host, never in agent configuration.
    const { headers: _headers, ...model } = this.state.model;
    this.client = credentials ? await runtime.connectAgent(credentials, options) : await runtime.createAgent({ ...options,
      idempotencyKey: `camelai-${this.remote.id}`, name: this.remote.id, type: 'camelai',
      systemPrompt: this.state.systemPrompt, model,
      thinkingLevel: this.state.thinkingLevel, initialMessages: this.state.messages,
    });
    this.remote.saveCredentials(this.client.session);
    const history = await this.client.history();
    this.mirror.messages = history.messages;
    return history;
  }

  private async receive(event: any, requestId?: string) {
    // Old replay is recoverable via history; never render it into a new turn.
    if (!this.requestId || requestId !== this.requestId) return;
    if (event.type === 'message_end') this.mirror.messages = [...this.state.messages, event.message];
    if (event.type === 'message_start' || event.type === 'message_update') this.mirror.streamingMessage = event.message;
    if (event.type === 'message_end' || event.type === 'agent_end') this.mirror.streamingMessage = undefined;
    if (event.type === 'tool_execution_start') this.mirror.pendingToolCalls.add(event.toolCallId);
    if (event.type === 'tool_execution_end') this.mirror.pendingToolCalls.delete(event.toolCallId);
    if (event.type === 'turn_end' && event.message?.errorMessage) this.mirror.errorMessage = event.message.errorMessage;
    if (!['agent_start', 'agent_end', 'turn_start', 'turn_end', 'message_start', 'message_update', 'message_end', 'tool_execution_start', 'tool_execution_update', 'tool_execution_end'].includes(event.type)) return;
    for (const listener of this.serviceListeners) await listener(event, this.controller!.signal);
  }

  override prompt(input: AgentMessage | AgentMessage[] | string, images?: ImageContent[]) { return this.start('prompt', typeof input === 'string' ? { text: input, images } : { message: input }); }
  override continue() { return this.start('continue', {}); }
  private start(method: 'prompt' | 'continue', params: Record<string, unknown>) {
    if (this.running) return Promise.reject(new Error('Agent is already processing'));
    this.controller = new AbortController(); this.mirror.isStreaming = true; this.mirror.errorMessage = undefined;
    this.running = this.run(method, params).finally(() => {
      this.mirror.isStreaming = false; this.mirror.streamingMessage = undefined; this.mirror.pendingToolCalls.clear();
      this.requestId = undefined; this.running = undefined; this.controller = undefined;
    });
    return this.running;
  }
  private async run(method: 'prompt' | 'continue', params: Record<string, unknown>) {
    if (!this.client) throw new Error('Agent service is not connected');
    if (this.remote.loadRequestId?.()) throw new Error('An existing service request must be observed before starting another run');
    await this.remote.authorize();
    const tools = await this.tools();
    Object.assign(this.client.tools, tools);
    for (const name of Object.keys(this.client.tools)) if (!Object.hasOwn(tools, name)) delete this.client.tools[name];
    await this.client.configure({ systemPrompt: this.state.systemPrompt, tools, thinkingLevel: this.state.thinkingLevel });
    // Refresh from the service, never upload a DO-mutated transcript after import.
    // The service closes an interrupted turn itself when the agent restarts; no gate here.
    this.mirror.messages = (await this.client.history()).messages;
    this.controller!.signal.throwIfAborted();
    this.requestId = crypto.randomUUID();
    // Persist before submission: an uncertain response must never create a second run.
    this.remote.saveRequestId?.(this.requestId);
    const result = await this.client.request(method, params, { idempotencyKey: this.requestId, timeoutMs: 15 * 60_000 });
    await this.commands;
    this.mirror.messages = (await this.client.history()).messages;
    this.remote.saveRequestId?.(undefined);
    this.mirror.errorMessage = result.error ?? undefined;
  }
  /** Reattach to the saved request without submitting another prompt or continuation. */
  async resumeServiceRun(): Promise<boolean> {
    if (this.running) throw new Error('Agent is already processing');
    const id = this.remote.loadRequestId?.() ?? this.requestId;
    if (!id) return false;
    if (!this.client) throw new Error('Agent service is not connected');
    this.requestId = id;
    this.controller ??= new AbortController();
    this.mirror.isStreaming = true;
    this.running = (async () => {
      await this.remote.authorize();
      try {
        const result = await this.client!.waitForRequest(id, { timeoutMs: 15 * 60_000 });
        this.mirror.errorMessage = result?.error ?? undefined;
        this.remote.saveRequestId?.(undefined);
      } finally {
        // History is authoritative even when execution was interrupted.
        this.mirror.messages = (await this.client!.history()).messages;
      }
    })().finally(() => {
      this.mirror.isStreaming = false; this.mirror.streamingMessage = undefined; this.mirror.pendingToolCalls.clear();
      this.requestId = undefined; this.running = undefined; this.controller = undefined;
    });
    await this.running;
    return true;
  }
  private control(method: 'steer' | 'followUp' | 'abort', message?: AgentMessage) {
    if (!this.client) return;
    this.commands = this.commands.then(() => this.client!.request(method, message ? { message } : {})).catch(error => { this.controller?.abort(error); });
  }
  override abort() { this.controller?.abort(); if (this.running) this.control('abort'); }
  override steer(message: AgentMessage) { this.control('steer', message); }
  override followUp(message: AgentMessage) { this.control('followUp', message); }
  // Disposing a UI/DO adapter detaches observation; only explicit abort stops the agent.
  async closeService() { await this.client?.close(); }
}
