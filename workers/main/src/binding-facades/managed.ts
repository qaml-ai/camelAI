import {
  bindingFacadeFetch,
  bindingFacadeJson,
  jsonRequest,
  type BindingFacadeFetcher,
} from "./transport.js";

export interface AiBindingLike {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}

export interface EmailBindingLike {
  send(message: unknown): Promise<{ messageId?: string }>;
}

export type QueueBindingLike<T = unknown> = Pick<Queue<T>, "send" | "sendBatch">;

export interface LakeStreamLike<T = unknown> {
  send(records: T[]): Promise<void>;
}

export interface ManagedFacadeEnv {
  AI?: AiBindingLike;
  AI_SERVICE?: BindingFacadeFetcher;
  EMAIL?: EmailBindingLike;
  EMAIL_SERVICE?: BindingFacadeFetcher;
  QUEUE_SERVICE?: BindingFacadeFetcher;
  PIPELINE_SERVICE?: BindingFacadeFetcher;
  BROWSER?: BindingFacadeFetcher;
  BROWSER_SERVICE?: BindingFacadeFetcher;
}

export interface BrowserBindingLike extends BindingFacadeFetcher {
  quickAction?(
    action: "content" | "markdown",
    options: Record<string, unknown>,
  ): Promise<Response>;
}

export function resolveAiBinding(env: ManagedFacadeEnv): AiBindingLike | undefined {
  if (env.AI) return env.AI;
  return env.AI_SERVICE ? new ServiceAiBinding(env.AI_SERVICE) : undefined;
}

export function resolveEmailBinding(env: ManagedFacadeEnv): EmailBindingLike | undefined {
  if (env.EMAIL) return env.EMAIL;
  return env.EMAIL_SERVICE ? new ServiceEmailBinding(env.EMAIL_SERVICE) : undefined;
}

export function resolveQueueBinding<T>(
  env: ManagedFacadeEnv,
  bindingName: string,
  native?: QueueBindingLike<T>,
): QueueBindingLike<T> | undefined {
  if (native) return native;
  if (env.QUEUE_SERVICE) {
    return new ServiceQueueBinding<T>(env.QUEUE_SERVICE, bindingName);
  }
  return undefined;
}

export function resolveLakeStream<T>(
  env: ManagedFacadeEnv,
  bindingName: string,
  native?: LakeStreamLike<T>,
): LakeStreamLike<T> | undefined {
  if (native) return native;
  if (env.PIPELINE_SERVICE) {
    return new ServiceLakeStream<T>(env.PIPELINE_SERVICE, bindingName);
  }
  return undefined;
}

export function resolveBrowserBinding(env: ManagedFacadeEnv): BrowserBindingLike | undefined {
  if (env.BROWSER) return env.BROWSER;
  return env.BROWSER_SERVICE
    ? new ServiceBrowserBinding(env.BROWSER_SERVICE)
    : undefined;
}

class ServiceAiBinding implements AiBindingLike {
  constructor(private readonly service: BindingFacadeFetcher) {}

  run(model: string, input: unknown, options?: unknown): Promise<unknown> {
    return bindingFacadeJson(
      this.service,
      "ai",
      "run",
      jsonRequest({ model, input, options }, { method: "POST" }),
    );
  }
}

class ServiceEmailBinding implements EmailBindingLike {
  constructor(private readonly service: BindingFacadeFetcher) {}

  send(message: unknown): Promise<{ messageId?: string }> {
    return bindingFacadeJson(
      this.service,
      "email",
      "send",
      jsonRequest({ message }, { method: "POST" }),
    );
  }
}

class ServiceQueueBinding<T> implements QueueBindingLike<T> {
  constructor(
    private readonly service: BindingFacadeFetcher,
    private readonly bindingName: string,
  ) {}

  async send(message: T, options?: QueueSendOptions): Promise<void> {
    await bindingFacadeJson(
      this.service,
      "queues",
      "send",
      jsonRequest(
        { binding: this.bindingName, message, options },
        { method: "POST" },
      ),
    );
  }

  async sendBatch(
    messages: Iterable<MessageSendRequest<T>>,
    options?: QueueSendBatchOptions,
  ): Promise<void> {
    await bindingFacadeJson(
      this.service,
      "queues",
      "send-batch",
      jsonRequest(
        { binding: this.bindingName, messages: [...messages], options },
        { method: "POST" },
      ),
    );
  }
}

class ServiceLakeStream<T> implements LakeStreamLike<T> {
  constructor(
    private readonly service: BindingFacadeFetcher,
    private readonly bindingName: string,
  ) {}

  async send(records: T[]): Promise<void> {
    await bindingFacadeJson(
      this.service,
      "pipelines",
      "send",
      jsonRequest(
        { binding: this.bindingName, records },
        { method: "POST" },
      ),
    );
  }
}

class ServiceBrowserBinding implements BrowserBindingLike {
  constructor(private readonly service: BindingFacadeFetcher) {}

  async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const source = input instanceof Request
      ? input
      : new Request(input, init);
    const headers = new Headers(source.headers);
    const body = source.method === "GET" || source.method === "HEAD"
      ? undefined
      : source.body;
    return bindingFacadeFetch(
      this.service,
      "browser",
      "binding",
      {
        method: source.method,
        headers,
        body,
        ...(body ? { duplex: "half" } : {}),
      } as RequestInit,
      { url: source.url },
    );
  }

  quickAction(
    action: "content" | "markdown",
    options: Record<string, unknown>,
  ): Promise<Response> {
    return bindingFacadeFetch(
      this.service,
      "browser",
      "quick-action",
      jsonRequest({ action, options }, { method: "POST" }),
    );
  }
}
