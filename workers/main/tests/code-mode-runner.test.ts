import { describe, expect, it, vi } from "vitest";
import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  codeModeWorkerModule,
  CODE_MODE_MAX_NESTED_TOOL_CALLS,
  prepareCodeModeUserCode,
  stripTypeScriptFromUserCode,
} from "../src/code-mode-runner";
import { CODE_MODE_MAX_OUTPUT_CHARACTERS } from "../src/code-mode-tools";

function createConnectionsFacade(binding: any): Record<string, unknown> {
  const legacyInvokeMethod = ["_", "_", "invoke"].join("");
  const invokeConnectionMethod = (request: unknown) => {
    if (typeof binding.invoke === "function") {
      return binding.invoke(request);
    }
    if (typeof binding[legacyInvokeMethod] === "function") {
      return binding[legacyInvokeMethod](request);
    }
    throw new Error("CONNECTIONS method invocation is not configured");
  };

  const findConnection = async (query: unknown) => {
    const result = await binding.find(query);
    if (!result || typeof result !== "object" || Array.isArray(result))
      return result;
    const connection = (result as any).connection;
    const verificationQuery =
      typeof connection?.name === "string" && connection.name
        ? connection.name
        : String(query || (result as any).alias || "");
    return {
      ...result,
      recommendedVerificationCall: `await env.CONNECTIONS.verify(${JSON.stringify(verificationQuery)})`,
      verificationNote:
        "Run the recommended verification call when verification is requested; inspecting status alone does not perform verification.",
    };
  };

  return new Proxy(
    {},
    {
      get(_target, connectionName) {
        if (connectionName === "then") return undefined;
        if (connectionName === "$methods") return () => binding.methods();
        if (connectionName === "$find")
          return (query: unknown) => findConnection(query);
        if (connectionName === "$test")
          return (query: unknown) => binding.test(query);
        if (connectionName === "$verify")
          return (query: unknown) => binding.verify(query);
        if (connectionName === "$list") return () => binding.list();
        if (connectionName === "$get")
          return (connection: unknown) => binding.get(connection);
        if (connectionName === "$tools")
          return (connection: unknown) => binding.tools(connection);
        if (typeof connectionName !== "string") return binding[connectionName];
        if (
          [
            "list",
            "get",
            "tools",
            "methods",
            "find",
            "test",
            "verify",
            "invoke",
            legacyInvokeMethod,
          ].includes(connectionName)
        ) {
          if (connectionName === "find")
            return (query: unknown) => findConnection(query);
          const value = binding[connectionName];
          return typeof value === "function"
            ? (...args: unknown[]) => value.apply(binding, args)
            : value;
        }

        return new Proxy(
          {},
          {
            get(_connectionTarget, methodName) {
              if (methodName === "then") return undefined;
              if (typeof methodName !== "string") return undefined;
              return async (...args: unknown[]) => {
                if (methodName === "verify")
                  return binding.verify(connectionName);
                if (methodName === "test") return binding.test(connectionName);
                const input = args[0] ?? {};
                try {
                  return await invokeConnectionMethod({
                    connection: connectionName,
                    method: methodName,
                    input,
                  });
                } catch (error) {
                  const message =
                    error instanceof Error ? error.message : String(error);
                  throw new Error(
                    `${message} Use await env.CONNECTIONS.find("${connectionName}") to inspect callable methods, or await env.CONNECTIONS.verify("${connectionName}") for normalized verification.`,
                  );
                }
              };
            },
          },
        );
      },
    },
  );
}

function createToolHelp() {
  return (input?: unknown) => {
    const runtime =
      typeof input === "object" && input !== null
        ? (input as { runtime?: unknown }).runtime
        : null;
    if (runtime === "text/store/load") {
      return {
        runtime: {
          name: "text/store/load",
          category: "runtime",
        },
      };
    }
    return null;
  };
}

function loadGeneratedCodeModeRunner(userCode: string): new (
  context: unknown,
  env: Record<string, unknown>,
) => {
  run(
    timeoutMs: number,
    maxTimeoutMs: number,
    maxOutputCharacters: number,
    maxNestedToolCalls: number,
  ): Promise<{ text: string }>;
} {
  let source = codeModeWorkerModule(userCode)
    .replace(
      'import { WorkerEntrypoint } from "cloudflare:workers";',
      "class WorkerEntrypoint { constructor(_context, env) { this.env = env; } }",
    )
    .replace("export class CodeModeRunner", "class CodeModeRunner");
  const hardenStart = source.indexOf("function hardenTimingSurface() {");
  const hardenEnd = source.indexOf(
    "\n\nconst TOOL_CATEGORY_DESCRIPTIONS",
    hardenStart,
  );
  if (hardenStart < 0 || hardenEnd < 0) {
    throw new Error("Generated code-mode timing surface was not found");
  }
  source =
    source.slice(0, hardenStart) +
    "function hardenTimingSurface() {}" +
    source.slice(hardenEnd);
  return new Function(`${source}; return CodeModeRunner;`)() as ReturnType<
    typeof loadGeneratedCodeModeRunner
  >;
}

describe("code mode runner connection facade", () => {
  it("keeps the per-call generated worker prelude below its compile-size budget", () => {
    // Worker Loader parses this prelude for every js_exec worker. This is a
    // performance budget, not a payload bound: raising it requires a measured
    // cold-start comparison because the prelude has already grown materially.
    expect(
      new TextEncoder().encode(codeModeWorkerModule("")).byteLength,
    ).toBeLessThanOrEqual(84 * 1024);
  });

  it("captures deadline primitives before embedded user code can replace them", () => {
    const source = codeModeWorkerModule(
      "globalThis.Promise = class {};\nglobalThis.setTimeout = () => 0;\nreturn await new Promise(() => {});",
    );

    expect(source.indexOf("const NativePromise")).toBeLessThan(
      source.indexOf("globalThis.Promise = class {}"),
    );
    expect(source.indexOf("const nativeSetTimeout")).toBeLessThan(
      source.indexOf("globalThis.setTimeout = () => 0"),
    );
    expect(source).toContain(
      "const nativePromiseThen = Function.prototype.call.bind(NativePromise.prototype.then)",
    );
    expect(source).toContain("function trustedPromiseRace(values)");
    expect(source).not.toContain("NativePromise.race");
    expect(source).not.toContain("NativePromise.all");
    expect(source).not.toContain("NativePromise.resolve");
    expect(source).toContain("timeoutHandle = nativeSetTimeout(() => {");
    expect(source).toContain(
      "timer = nativeSetTimeout(resolve, MAX_RUNTIME_CLEANUP_MS)",
    );
    expect(source).toContain("nativeClearTimeout(timeoutHandle)");
    expect(source).toContain("nativeClearTimeout(timer)");
  });

  it("wraps global fetch through the secure fetch binding", () => {
    const source = codeModeWorkerModule('await fetch("https://example.com");');

    expect(source).toContain("function installSecureFetch(");
    expect(source).toContain(
      "reserveFetch = (_input, _init, invoke) => invoke()",
    );
    expect(source).toContain("cleanupSecureFetch = installSecureFetch(");
    expect(source).toContain("const response = await reserveFetch(");
    expect(source).toContain(
      "(input, init, invoke) => dispatchNestedTool({ input, init }, invoke)",
    );
    expect(source).toContain("retainNestedToolResult.spendBytes");
    expect(source).toContain(
      'cancelReadableStream(body, "js_exec completed before fetch")',
    );
    expect(source).toContain("cleanupSecureFetch?.();");
    expect(source).toContain(
      'Secure fetch response exceeds the " + MAX_NESTED_TOOL_RESULT_BYTES + " byte limit',
    );
  });

  it("blocks captured secure fetch after completion and cancels a late response", async () => {
    const installSecureFetch = loadGeneratedSecureFetch();
    let active = false;
    const dispatch = vi.fn();
    const cleanupFirst = installSecureFetch({ fetch: dispatch }, () => {
      if (!active) throw new Error("js_exec is no longer active");
    });
    const capturedFetch = globalThis.fetch;
    try {
      await expect(capturedFetch("https://example.com")).rejects.toThrow(
        "js_exec is no longer active",
      );
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      cleanupFirst();
    }

    let resolveResponse!: (response: Response) => void;
    const pendingResponse = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    const cancel = vi.fn();
    active = true;
    const cleanupSecond = installSecureFetch(
      { fetch: vi.fn(() => pendingResponse) },
      () => {
        if (!active) throw new Error("js_exec is no longer active");
      },
    );
    try {
      const pending = globalThis.fetch("https://example.com/slow");
      active = false;
      const response = new Response(new ReadableStream<Uint8Array>({ cancel }));
      const capturedCancel = ReadableStream.prototype.cancel;
      const replacedCancel = vi.fn(() => {
        throw new Error("user-replaced stream cancel was called");
      }) as typeof ReadableStream.prototype.cancel;
      ReadableStream.prototype.cancel = replacedCancel;
      try {
        resolveResponse(response);
        await expect(pending).rejects.toThrow("js_exec is no longer active");
      } finally {
        ReadableStream.prototype.cancel = capturedCancel;
      }
      expect(cancel).toHaveBeenCalledOnce();
      expect(replacedCancel).not.toHaveBeenCalled();
    } finally {
      cleanupSecond();
    }
  });

  it("charges secure fetches to the shared call budget before dispatch", async () => {
    const installSecureFetch = loadGeneratedSecureFetch();
    const dispatch = vi.fn(async () => new Response(null));
    let used = 0;
    const reserve = <T>(
      _input: unknown,
      _init: unknown,
      invoke: () => T,
    ): T => {
      if (used >= 32) throw new Error("Nested tool-call limit reached (32)");
      used += 1;
      return invoke();
    };
    const cleanup = installSecureFetch({ fetch: dispatch }, () => {}, reserve);
    const capturedFetch = globalThis.fetch;
    try {
      for (let index = 0; index < 32; index += 1) {
        await expect(
          capturedFetch("https://example.com"),
        ).resolves.toBeInstanceOf(Response);
      }
      await expect(
        capturedFetch("https://example.com/overflow"),
      ).rejects.toThrow("Nested tool-call limit reached (32)");
      expect(dispatch).toHaveBeenCalledTimes(32);
    } finally {
      cleanup();
    }
  });

  it("rejects oversized secure-fetch input before binding dispatch", async () => {
    const installSecureFetch = loadGeneratedSecureFetch();
    const dispatch = vi.fn(async () => new Response(null));
    const cleanup = installSecureFetch(
      { fetch: dispatch },
      () => {},
      (input, init, invoke) => {
        if (
          JSON.stringify({ input, init }).length >
          CHAT_RUNTIME_BOUNDS.toolInputBytes
        ) {
          throw new Error("Nested tool arguments exceed the byte limit");
        }
        return invoke();
      },
    );
    const capturedFetch = globalThis.fetch;
    try {
      await expect(
        capturedFetch("https://example.com", {
          method: "POST",
          body: "x".repeat(CHAT_RUNTIME_BOUNDS.toolInputBytes + 1),
        }),
      ).rejects.toThrow("Nested tool arguments exceed the byte limit");
      expect(dispatch).not.toHaveBeenCalled();
    } finally {
      cleanup();
    }
  });

  it("uses captured brands when user code replaces Symbol.hasInstance", async () => {
    const installSecureFetch = loadGeneratedSecureFetch();
    const unconsumedCancel = vi.fn();
    const responses = [
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
      ),
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([4]));
          },
          cancel: unconsumedCancel,
        }),
      ),
    ];
    const cleanup = installSecureFetch(
      { fetch: vi.fn(async () => responses.shift()) },
      () => {},
    );
    const capturedFetch = globalThis.fetch;
    const constructors = [Response, ReadableStream, Uint8Array] as Function[];
    const descriptors = constructors.map((constructor) =>
      Object.getOwnPropertyDescriptor(constructor, Symbol.hasInstance),
    );
    for (const constructor of constructors) {
      Object.defineProperty(constructor, Symbol.hasInstance, {
        configurable: true,
        value: () => false,
      });
    }
    try {
      const consumed = await capturedFetch("https://example.com/consumed");
      expect([...new Uint8Array(await consumed.arrayBuffer())]).toEqual([
        1, 2, 3,
      ]);
      await capturedFetch("https://example.com/unconsumed");
      cleanup();
      await Promise.resolve();
      expect(unconsumedCancel).toHaveBeenCalledOnce();
    } finally {
      for (let index = 0; index < constructors.length; index += 1) {
        const descriptor = descriptors[index];
        if (descriptor) {
          Object.defineProperty(
            constructors[index]!,
            Symbol.hasInstance,
            descriptor,
          );
        } else {
          delete (
            constructors[index] as unknown as Record<PropertyKey, unknown>
          )[Symbol.hasInstance];
        }
      }
      try {
        cleanup();
      } catch {
        // The first cleanup already restored fetch.
      }
    }
  });

  it("bounds declared and streaming secure-fetch response bodies", async () => {
    const installSecureFetch = loadGeneratedSecureFetch();
    const limit = CHAT_RUNTIME_BOUNDS.toolResultBytes;

    const declaredCancel = vi.fn();
    const declaredCleanup = installSecureFetch(
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({ cancel: declaredCancel }),
            {
              headers: { "content-length": String(limit + 1) },
            },
          ),
      },
      () => {},
    );
    const declaredFetch = globalThis.fetch;
    try {
      await expect(
        declaredFetch("https://example.com/declared"),
      ).rejects.toThrow(
        `Secure fetch response exceeds the ${limit} byte limit`,
      );
      expect(declaredCancel).toHaveBeenCalledOnce();
    } finally {
      declaredCleanup();
    }

    const streamingCancel = vi.fn();
    const streamingCleanup = installSecureFetch(
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(limit));
                controller.enqueue(new Uint8Array(1));
              },
              cancel: streamingCancel,
            }),
          ),
      },
      () => {},
    );
    const streamingFetch = globalThis.fetch;
    try {
      const response = await streamingFetch("https://example.com/streaming");
      await expect(response.arrayBuffer()).rejects.toThrow(
        `Secure fetch response exceeds the ${limit} byte limit`,
      );
      expect(streamingCancel).toHaveBeenCalledOnce();
    } finally {
      streamingCleanup();
    }
  });

  it("charges multiple secure-fetch bodies to the shared result-byte budget", async () => {
    const installSecureFetch = loadGeneratedSecureFetch();
    const { createNestedToolResultBudget } = loadGeneratedBoundHelpers();
    const retainResult = createNestedToolResultBudget();
    const perResponse = CHAT_RUNTIME_BOUNDS.toolResultBytes;
    const dispatch = vi.fn(async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(perResponse));
            controller.close();
          },
        }),
      ),
    );
    const cleanup = installSecureFetch(
      { fetch: dispatch },
      () => {},
      (_input, _init, invoke) => invoke(),
      retainResult.spendBytes,
    );
    const capturedFetch = globalThis.fetch;
    try {
      const successfulResponses = Math.floor(
        CHAT_RUNTIME_BOUNDS.toolResultsPerTurnBytes / perResponse,
      );
      for (let index = 0; index < successfulResponses; index += 1) {
        const response = await capturedFetch(`https://example.com/${index}`);
        await expect(response.arrayBuffer()).resolves.toHaveProperty(
          "byteLength",
          perResponse,
        );
      }
      const overflow = await capturedFetch("https://example.com/overflow");
      await expect(overflow.arrayBuffer()).rejects.toThrow(
        /Nested tool results exceed the .* byte per-run limit/,
      );
      expect(dispatch).toHaveBeenCalledTimes(successfulResponses + 1);
    } finally {
      cleanup();
    }
  });

  it("cancels an unconsumed secure-fetch body during runner cleanup", async () => {
    const installSecureFetch = loadGeneratedSecureFetch();
    const cancel = vi.fn();
    const cleanup = installSecureFetch(
      {
        fetch: async () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1]));
              },
              cancel,
            }),
          ),
      },
      () => {},
    );
    const capturedFetch = globalThis.fetch;
    await capturedFetch("https://example.com/unconsumed");
    cleanup();
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not inject projects as a standalone user-code binding", () => {
    const source = codeModeWorkerModule(
      'const projects = ["local"]; return projects.length;',
    );

    expect(source).toContain("const PROJECTS = createProjectsFacade(rawTools)");
    expect(source).toContain("projects: env.PROJECTS");
    expect(source).toContain(
      'const projects = ["local"]; return projects.length;',
    );
    expect(source).not.toContain(
      "async function runUserCode(tools, CONNECTIONS, connections, PROJECTS, projects",
    );
    expect(source).not.toContain("const projects = PROJECTS");
  });

  it("generates helpful env.BROWSER errors for unsupported methods", () => {
    const source = codeModeWorkerModule(
      'const b = await env.BROWSER.launch({ scriptName: "app" });\nreturn await b.text();',
    );

    expect(source).toContain("env.BROWSER session has no method");
    expect(source).toContain("Supported session methods");
    expect(source).toContain(
      "use await session.textContent() and then result.text",
    );
    expect(source).toContain('"hasText"');
    expect(source).toContain("env.BROWSER has no method");
    expect(source).toContain(
      "Use await env.BROWSER.launch({ scriptName, path? })",
    );
    expect(source).toContain(
      "function createBrowserFacade(callTool, cleanupTool)",
    );
    expect(source).toContain('this.env.TOOLS.callTool("browser_action", args)');
    expect(source).toContain("await browserRuntime?.cleanup()");
  });

  it("restores setup globals when tool discovery rejects", async () => {
    const Runner = loadGeneratedCodeModeRunner("return 1;");
    const originalConsole = globalThis.console;
    const originalFetch = globalThis.fetch;
    const secureFetch = vi.fn(async () => new Response(null));
    const listTools = vi.fn(async () => {
      throw new Error("discovery failed");
    });
    const runner = new Runner(undefined, {
      SECURE_FETCH: { fetch: secureFetch },
      TOOLS: { listTools },
    });

    await expect(runner.run(100, 100, 10_000, 1)).rejects.toThrow(
      "discovery failed",
    );
    expect(globalThis.console).toBe(originalConsole);
    expect(globalThis.fetch).toBe(originalFetch);
    expect(secureFetch).not.toHaveBeenCalled();
  });

  it("bounds hung tool discovery with the same run deadline and restores setup globals", async () => {
    const Runner = loadGeneratedCodeModeRunner("return 1;");
    const originalConsole = globalThis.console;
    const originalFetch = globalThis.fetch;
    const runner = new Runner(undefined, {
      SECURE_FETCH: { fetch: vi.fn(async () => new Response(null)) },
      TOOLS: { listTools: vi.fn(() => new Promise(() => {})) },
    });

    await expect(runner.run(10, 10, 10_000, 1)).rejects.toMatchObject({
      name: "CodeModeTimeoutError",
    });
    expect(globalThis.console).toBe(originalConsole);
    expect(globalThis.fetch).toBe(originalFetch);
  });

  it("closes browser sessions after the user capability is fenced", async () => {
    const createBrowserFacade = loadGeneratedBrowserFacade(5);
    let active = true;
    const callTool = vi.fn(async (name: string) => {
      if (!active) throw new Error("js_exec is no longer active");
      if (name === "browser_launch") {
        return { sessionId: "session-1", scriptName: "demo" };
      }
      return {};
    });
    const cleanupTool = vi.fn(async () => undefined);
    const runtime = createBrowserFacade(callTool, cleanupTool);
    await runtime.facade.launch({ scriptName: "demo" });

    active = false;
    await expect(runtime.cleanup()).resolves.toBeUndefined();
    expect(cleanupTool).toHaveBeenCalledWith({
      sessionId: "session-1",
      scriptName: "demo",
      method: "close",
      args: [],
    });

    vi.useFakeTimers();
    try {
      const createTimedBrowserFacade = loadGeneratedBrowserFacade(5);
      active = true;
      const hungCleanupPromise = new Promise<void>(() => {});
      const hungCleanup = vi.fn(() => hungCleanupPromise);
      const second = createTimedBrowserFacade(callTool, hungCleanup);
      const capturedMapSet = Map.prototype.set;
      const replacedMapSet = vi.fn(() => {
        throw new Error("user-replaced Map.set was called");
      }) as typeof Map.prototype.set;
      Map.prototype.set = replacedMapSet;
      try {
        await second.facade.launch({ scriptName: "demo" });
      } finally {
        Map.prototype.set = capturedMapSet;
      }
      expect(replacedMapSet).not.toHaveBeenCalled();
      active = false;
      const capturedSetTimeout = globalThis.setTimeout;
      const capturedClearTimeout = globalThis.clearTimeout;
      const capturedPromise = globalThis.Promise;
      const capturedPromiseResolve = Promise.resolve;
      const capturedPromiseThen = Promise.prototype.then;
      const capturedArrayFrom = Array.from;
      const capturedMapValues = Map.prototype.values;
      const capturedMapForEach = Map.prototype.forEach;
      const capturedMapClear = Map.prototype.clear;
      const replacedSetTimeout = vi.fn(() => {
        throw new Error("user-replaced setTimeout was called");
      }) as typeof globalThis.setTimeout;
      const replacedClearTimeout = vi.fn(() => {
        throw new Error("user-replaced clearTimeout was called");
      }) as typeof globalThis.clearTimeout;
      const replacedArrayFrom = vi.fn(() => {
        throw new Error("user-replaced Array.from was called");
      }) as typeof Array.from;
      const replacedMapValues = vi.fn(() => {
        throw new Error("user-replaced Map.values was called");
      }) as typeof Map.prototype.values;
      const replacedMapForEach = vi.fn(() => {
        throw new Error("user-replaced Map.forEach was called");
      }) as typeof Map.prototype.forEach;
      const replacedMapClear = vi.fn(() => {
        throw new Error("user-replaced Map.clear was called");
      }) as typeof Map.prototype.clear;
      const replacedPromiseResolve = vi.fn(() => {
        throw new Error("user-replaced Promise.resolve was called");
      }) as unknown as typeof Promise.resolve;
      const replacedPromiseThen = vi.fn(() => {
        throw new Error("user-replaced Promise.then was called");
      }) as unknown as typeof Promise.prototype.then;
      globalThis.setTimeout = replacedSetTimeout;
      globalThis.clearTimeout = replacedClearTimeout;
      Promise.resolve = replacedPromiseResolve;
      Promise.prototype.then = replacedPromiseThen;
      globalThis.Promise =
        class UserPromise {} as unknown as PromiseConstructor;
      Array.from = replacedArrayFrom;
      Map.prototype.values = replacedMapValues;
      Map.prototype.forEach = replacedMapForEach;
      Map.prototype.clear = replacedMapClear;
      let pending: Promise<void>;
      try {
        pending = second.cleanup();
      } finally {
        globalThis.setTimeout = capturedSetTimeout;
        globalThis.clearTimeout = capturedClearTimeout;
        globalThis.Promise = capturedPromise;
        Promise.resolve = capturedPromiseResolve;
        Promise.prototype.then = capturedPromiseThen;
        Array.from = capturedArrayFrom;
        Map.prototype.values = capturedMapValues;
        Map.prototype.forEach = capturedMapForEach;
        Map.prototype.clear = capturedMapClear;
      }
      await vi.advanceTimersByTimeAsync(5);
      await expect(pending).resolves.toBeUndefined();
      expect(hungCleanup).toHaveBeenCalledOnce();
      expect(replacedSetTimeout).not.toHaveBeenCalled();
      expect(replacedClearTimeout).not.toHaveBeenCalled();
      expect(replacedArrayFrom).not.toHaveBeenCalled();
      expect(replacedMapValues).not.toHaveBeenCalled();
      expect(replacedMapForEach).not.toHaveBeenCalled();
      expect(replacedMapClear).not.toHaveBeenCalled();
      expect(replacedPromiseResolve).not.toHaveBeenCalled();
      expect(replacedPromiseThen).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("restores runtime globals through captured cleanup intrinsics", () => {
    const installRuntimeGlobals = loadGeneratedRuntimeGlobals();
    const key = "__camelai_runtime_cleanup_test__";
    Object.defineProperty(globalThis, key, {
      configurable: true,
      writable: true,
      value: "before",
    });
    const cleanup = installRuntimeGlobals({ [key]: "during" });
    expect((globalThis as Record<string, unknown>)[key]).toBe("during");

    const capturedDefineProperty = Object.defineProperty;
    const capturedMapEntries = Map.prototype.entries;
    const capturedMapForEach = Map.prototype.forEach;
    const replacedDefineProperty = vi.fn(() => {
      throw new Error("user-replaced Object.defineProperty was called");
    }) as typeof Object.defineProperty;
    const replacedMapEntries = vi.fn(() => {
      throw new Error("user-replaced Map.entries was called");
    }) as typeof Map.prototype.entries;
    const replacedMapForEach = vi.fn(() => {
      throw new Error("user-replaced Map.forEach was called");
    }) as typeof Map.prototype.forEach;
    Object.defineProperty = replacedDefineProperty;
    Map.prototype.entries = replacedMapEntries;
    Map.prototype.forEach = replacedMapForEach;
    try {
      cleanup();
    } finally {
      Object.defineProperty = capturedDefineProperty;
      Map.prototype.entries = capturedMapEntries;
      Map.prototype.forEach = capturedMapForEach;
    }

    expect((globalThis as Record<string, unknown>)[key]).toBe("before");
    expect(replacedDefineProperty).not.toHaveBeenCalled();
    expect(replacedMapEntries).not.toHaveBeenCalled();
    expect(replacedMapForEach).not.toHaveBeenCalled();
    delete (globalThis as Record<string, unknown>)[key];
  });

  it("supports workflow-style connection method calls in js_exec", async () => {
    const calls: unknown[] = [];
    const connectionsBinding = {
      list: async () => [],
      get: async () => ({ alias: "remoteMcpAdmin" }),
      tools: async () => [],
      methods: async () => [
        { alias: "remoteMcpAdmin", method: "getDashboardSummary" },
      ],
      find: async () => ({ alias: "remoteMcpAdmin" }),
      test: async () => ({ ok: true }),
      verify: async () => ({ ok: true, status: "ready" }),
      invoke(request: unknown) {
        calls.push(request);
        return { ok: true, request };
      },
    };
    const env = {
      CONNECTIONS: createConnectionsFacade(connectionsBinding) as any,
    };
    const connections = env.CONNECTIONS;
    const context = { cloudflare: { env, connections } };

    const admin = await env.CONNECTIONS.find("admin");
    expect(admin.recommendedVerificationCall).toBe(
      'await env.CONNECTIONS.verify("admin")',
    );
    expect(admin.verificationNote).toContain(
      "inspecting status alone does not perform verification",
    );
    await expect(env.CONNECTIONS.verify("admin")).resolves.toEqual({
      ok: true,
      status: "ready",
    });
    await expect((env.CONNECTIONS as any).$verify("admin")).resolves.toEqual({
      ok: true,
      status: "ready",
    });
    await expect(env.CONNECTIONS[admin.alias].verify()).resolves.toEqual({
      ok: true,
      status: "ready",
    });
    await expect(env.CONNECTIONS[admin.alias].test()).resolves.toEqual({
      ok: true,
    });
    const workflowStyle = await env.CONNECTIONS[
      admin.alias
    ].getDashboardSummary({
      date: "2026-05-29",
    });
    const facadeStyle = await connections[admin.alias].getDashboardSummary({
      date: "2026-05-29",
    });
    const contextStyle = await context.cloudflare.connections[
      admin.alias
    ].getDashboardSummary({
      date: "2026-05-29",
    });

    expect({ workflowStyle, facadeStyle, contextStyle }).toEqual({
      workflowStyle: {
        ok: true,
        request: {
          connection: "remoteMcpAdmin",
          method: "getDashboardSummary",
          input: { date: "2026-05-29" },
        },
      },
      facadeStyle: {
        ok: true,
        request: {
          connection: "remoteMcpAdmin",
          method: "getDashboardSummary",
          input: { date: "2026-05-29" },
        },
      },
      contextStyle: {
        ok: true,
        request: {
          connection: "remoteMcpAdmin",
          method: "getDashboardSummary",
          input: { date: "2026-05-29" },
        },
      },
    });
    expect(calls).toHaveLength(3);
  });

  it("adds catalog and verification guidance to unknown connection method errors", async () => {
    const binding = {
      invoke: async () => {
        throw new Error(
          'No method "verifyWidget" exists on connection "inventory-api"',
        );
      },
    };
    const connections = createConnectionsFacade(binding) as any;

    await expect(connections["inventory-api"].verifyWidget()).rejects.toThrow(
      'Use await env.CONNECTIONS.find("inventory-api")',
    );
    await expect(connections["inventory-api"].verifyWidget()).rejects.toThrow(
      'env.CONNECTIONS.verify("inventory-api")',
    );
  });

  it("does not detach service binding methods when invoking a connection method", () => {
    const source = codeModeWorkerModule(
      'return await connections.remoteMcpAdmin.getDashboardSummary({ date: "2026-05-29" });',
    );

    expect(source).toContain("createToolBackedConnectionsBinding");
    expect(source).toContain(
      "const CONNECTIONS_BINDING = createToolBackedConnectionsBinding(callTool)",
    );
    expect(source).toContain("const CONNECTIONS = connections");
    expect(source).toContain("return binding.invoke(request);");
    expect(source).toContain(
      'invoke: (request) => callTool("connections_invoke", request)',
    );
    expect(source).not.toContain("invoke.call(binding");
  });

  it("rejects forged Request bodies before connection dispatch", async () => {
    const generatedConnections = loadGeneratedConnectionsFacade();
    const invoke = vi.fn(async () => ({ status: 200, bodyText: "ok" }));
    const connections = generatedConnections({ invoke });
    const read = vi.fn(async () => ({
      done: false,
      value: new Uint8Array(0),
    }));
    const getReader = vi.fn(() => ({ read }));
    const forgedRequest = { body: { getReader } };
    const hasInstance = Object.getOwnPropertyDescriptor(
      Request,
      Symbol.hasInstance,
    );
    Object.defineProperty(Request, Symbol.hasInstance, {
      configurable: true,
      value: () => true,
    });
    try {
      await expect(connections.demo.fetch(forgedRequest)).rejects.toThrow(
        "must be a bounded URL string",
      );
    } finally {
      if (hasInstance) {
        Object.defineProperty(Request, Symbol.hasInstance, hasInstance);
      } else {
        delete (Request as unknown as Record<PropertyKey, unknown>)[
          Symbol.hasInstance
        ];
      }
    }
    expect(getReader).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(invoke).not.toHaveBeenCalled();

    await expect(
      connections.demo.fetch("https://example.com", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: "bounded",
      }),
    ).resolves.toBeInstanceOf(Response);
    expect(invoke).toHaveBeenCalledWith({
      connection: "demo",
      method: "fetch",
      input: {
        input: "https://example.com",
        init: {
          method: "POST",
          headers: { "content-type": "text/plain" },
          body: "bounded",
        },
      },
    });
  });
});

describe("code mode runner js_exec module", () => {
  it("enforces the wall-clock timeout inside the loaded worker invocation", () => {
    const source = codeModeWorkerModule(
      'await tools.analysis_exec({ command: "sleep 600" });',
    );

    expect(source).toContain(
      "async run(timeoutMs, maxTimeoutMs, maxOutputCharacters, maxNestedToolCalls)",
    );
    expect(source).toContain(
      "const result = await trustedPromiseRace([timeout, userResult])",
    );
    expect(source.indexOf("const timeout = new NativePromise")).toBeLessThan(
      source.indexOf("const userResult = runUserCode()"),
    );
    expect(source).toContain('error.name = "CodeModeTimeoutError"');
    expect(source).toContain("Do not retry this js_exec in the same turn.");
    expect(source).toContain(
      "if (timeoutHandle) nativeClearTimeout(timeoutHandle)",
    );
  });

  it("bounds retained output and nested registered tool calls inside the worker", () => {
    const {
      assertNestedToolArgumentsBounded,
      createOutputBuffer,
      createNestedToolBudget,
      createNestedToolResultBudget,
      stringifyOutput,
    } = loadGeneratedBoundHelpers();
    const output = createOutputBuffer(1_000);
    output.push("x".repeat(2_000));
    output.push("y".repeat(2_000));
    expect(output.text()).toContain("[Truncated: 1000 of 4001 characters]");
    expect(output.text().length).toBeLessThanOrEqual(1_000);
    const consoleOutput = createOutputBuffer(1_000);
    consoleOutput.pushValues(
      ["x".repeat(2_000), "y".repeat(2_000)],
      (value) => value,
    );
    expect(consoleOutput.text()).toContain(
      "[Truncated: 1000 of 4001 characters]",
    );

    let outputAccessorReads = 0;
    const outputAccessor: Record<string, unknown> = {};
    Object.defineProperty(outputAccessor, "payload", {
      enumerable: true,
      get() {
        outputAccessorReads += 1;
        return "unbounded";
      },
    });
    expect(stringifyOutput(outputAccessor)).toContain("Output omitted");
    expect(outputAccessorReads).toBe(0);
    expect(
      stringifyOutput({
        payload: "x".repeat(CODE_MODE_MAX_OUTPUT_CHARACTERS),
      }),
    ).toContain("Output omitted");

    const invoke = vi.fn(() => "ok");
    const nested = createNestedToolBudget(Number.MAX_SAFE_INTEGER);
    for (let index = 0; index < CODE_MODE_MAX_NESTED_TOOL_CALLS; index += 1) {
      expect(nested(invoke)).toBe("ok");
    }
    expect(() => nested(invoke)).toThrow(
      `Nested tool-call limit reached (${CODE_MODE_MAX_NESTED_TOOL_CALLS})`,
    );
    expect(invoke).toHaveBeenCalledTimes(CODE_MODE_MAX_NESTED_TOOL_CALLS);

    const retainResult = createNestedToolResultBudget();
    const resultChunk = {
      value: "x".repeat(
        Math.floor(CHAT_RUNTIME_BOUNDS.toolResultsPerTurnBytes / 4) - 256,
      ),
    };
    for (let index = 0; index < 4; index += 1) {
      expect(retainResult(resultChunk)).toBe(resultChunk);
    }
    expect(() => retainResult(resultChunk)).toThrow(
      /Nested tool results exceed the .* byte per-run limit/,
    );
    expect(() =>
      createNestedToolResultBudget()({
        value: "x".repeat(CHAT_RUNTIME_BOUNDS.toolResultBytes),
      }),
    ).toThrow(
      /Nested tool results exceed the .* byte limit.*may have completed.*do not retry/,
    );

    expect(
      assertNestedToolArgumentsBounded({
        text: "bounded 🐪",
        nested: [true, null, { value: 1 }],
      }),
    ).toBeLessThanOrEqual(CHAT_RUNTIME_BOUNDS.toolInputBytes);

    const accessorArguments: Record<string, unknown> = {};
    let accessorReads = 0;
    Object.defineProperty(accessorArguments, "payload", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "unbounded";
      },
    });
    expect(() => assertNestedToolArgumentsBounded(accessorArguments)).toThrow(
      /accessor property/,
    );
    expect(accessorReads).toBe(0);

    expect(() =>
      assertNestedToolArgumentsBounded({
        payload: "x".repeat(CHAT_RUNTIME_BOUNDS.toolInputBytes),
      }),
    ).toThrow(
      `Nested tool arguments exceed the ${CHAT_RUNTIME_BOUNDS.toolInputBytes} byte limit`,
    );
    const source = codeModeWorkerModule("");
    expect(source).toContain(
      "const argumentBytes = assertNestedToolArgumentsBounded(args)",
    );
    expect(source).toContain(
      "return [tool.name, (args = {}) => dispatchNestedTool(args, () =>",
    );
    expect(source).toContain(
      "retainNestedInvocation(() => this.env.TOOLS.callToolEnvelope(name, args))",
    );
    expect(source).toContain("failureBudget,\n        assertRunActive,");
    expect(source).toContain(
      "const callRuntimeBinding = (args, invoke) => dispatchNestedTool({ args }, () =>",
    );
    expect(source).toContain('failure.name = "NestedToolError"');
    expect(source).toContain('failure.stack = ""');
    expect(source).toContain("input.stream === true");
    expect(source).toContain("isNativeReadableStream(result)");
    expect(source).toContain(
      'cancelReadableStream(\n            lateStream,\n            "Streaming nested results are unavailable",',
    );
    expect(source).toContain("result = undefined");
    expect(source).toContain(
      "const AI = createAiFacade(this.env.AI, callRuntimeBinding)",
    );
    expect(source).toContain(
      "createCamelAiFacade(this.env.CAMELAI, callRuntimeBinding)",
    );
    expect(source).toContain(
      "createScreenshotFacade(this.env.SCREENSHOT, callRuntimeBinding)",
    );
    expect(source).toContain(
      "run: (...args) => callRuntimeBinding(args, () => {",
    );
    expect(source).toContain(
      'throw new NativeError("Streaming env.AI.run is not configured',
    );
    expect(source).toContain("return binding.run.call(binding, ...args)");
    expect(source).not.toContain("const AI = this.env.AI");
    expect(source).not.toContain("await input.text()");
    expect(source).not.toContain("readBoundedRequestText");
    expect(source).not.toContain("input instanceof Request");
    expect(source).not.toContain("input instanceof URL");
    expect(source).not.toContain("input instanceof Headers");
    expect(source).toContain("byte per-run limit");
    expect(source).toContain("const scratch = new Map()");
    expect(source).toContain("nativeMapClear(scratch)");
    expect(source).toContain("scratch.set(key, serialized)");
    expect(source).toContain("nativeJsonParse(serialized)");
    expect(source).toContain("runActive = false");
    expect(source).not.toContain("const store = new Map()");
  });

  it("fences late nested results before retaining or delivering the value", async () => {
    const createRetainer = loadGeneratedNestedInvocationRetainer();
    let active = true;
    let resolveResult!: (value: Record<string, unknown>) => void;
    const deferredResult = new Promise<Record<string, unknown>>((resolve) => {
      resolveResult = resolve;
    });
    let accessorReads = 0;
    let retentionCalls = 0;
    let continuationCalls = 0;
    const lateResult: Record<string, unknown> = {};
    Object.defineProperty(lateResult, "payload", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return "late";
      },
    });
    const retain = vi.fn((value: unknown) => {
      retentionCalls += 1;
      return (value as Record<string, unknown>).payload;
    });
    const pending = createRetainer(retain, () => {
      if (!active) throw new Error("js_exec is no longer active");
    })(() => deferredResult).then(() => {
      continuationCalls += 1;
    });

    active = false;
    resolveResult(lateResult);

    await expect(pending).rejects.toMatchObject({
      name: "NestedToolError",
      stack: "",
    });
    expect(retentionCalls).toBe(0);
    expect(accessorReads).toBe(0);
    expect(continuationCalls).toBe(0);
  });

  it("cancels a late nested result stream after the run becomes inactive", async () => {
    const createRetainer = loadGeneratedNestedInvocationRetainer();
    let active = true;
    let resolveResult!: (value: unknown) => void;
    const deferredResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const cancel = vi.fn();
    const lateStream = new ReadableStream<Uint8Array>({ cancel });
    const retain = vi.fn((value: unknown) => value);
    const pending = createRetainer(retain, () => {
      if (!active) throw new Error("js_exec is no longer active");
    })(() => deferredResult);

    active = false;
    const hasInstance = Object.getOwnPropertyDescriptor(
      ReadableStream,
      Symbol.hasInstance,
    );
    Object.defineProperty(ReadableStream, Symbol.hasInstance, {
      configurable: true,
      value: () => false,
    });
    try {
      resolveResult(lateStream);
      await expect(pending).rejects.toMatchObject({ name: "NestedToolError" });
    } finally {
      if (hasInstance) {
        Object.defineProperty(ReadableStream, Symbol.hasInstance, hasInstance);
      } else {
        delete (ReadableStream as unknown as Record<PropertyKey, unknown>)[
          Symbol.hasInstance
        ];
      }
    }
    expect(cancel).toHaveBeenCalledOnce();
    expect(retain).not.toHaveBeenCalled();
  });

  it("does not await a late stream cancellation that never settles", async () => {
    const createRetainer = loadGeneratedNestedInvocationRetainer();
    let active = true;
    let resolveResult!: (value: unknown) => void;
    const deferredResult = new Promise<unknown>((resolve) => {
      resolveResult = resolve;
    });
    const cancel = vi.fn(() => new Promise<void>(() => {}));
    const lateStream = new ReadableStream<Uint8Array>({ cancel });
    const pending = createRetainer(
      (value) => value,
      () => {
        if (!active) throw new Error("js_exec is no longer active");
      },
    )(() => deferredResult);

    active = false;
    resolveResult(lateStream);

    await expect(pending).rejects.toMatchObject({ name: "NestedToolError" });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("does not pass runtime helper names as runUserCode parameters", () => {
    const source = codeModeWorkerModule(
      "const projects = await tools.list_projects();\nreturn projects;",
    );

    expect(source).toContain("async function runUserCode()");
    expect(source).toContain("installRuntimeGlobals");
    expect(source).not.toContain("async function runUserCode(tools");
  });

  it("installs the documented store helper as a runtime global", () => {
    const source = codeModeWorkerModule(
      'store("lastResult", 42);\nreturn load("lastResult");',
    );

    expect(source).toContain("store: save");
    expect(source).toContain('store("lastResult", 42);');
    expect(source).toContain('load("lastResult")');
  });

  it("keeps names on every runtime help entry so js_exec can initialize", () => {
    const source = codeModeWorkerModule("");
    expect(source).toContain('name: "text/store/load"');
    expect(source).toContain('name: "env.SCREENSHOT"');

    const help = createToolHelp();
    expect(help({ runtime: "text/store/load" })).toEqual({
      runtime: expect.objectContaining({
        name: "text/store/load",
        category: "runtime",
      }),
    });
  });
});

describe("code mode runner TypeScript stripping", () => {
  it("strips type annotations, casts, interfaces, and generics from user code", () => {
    const stripped = stripTypeScriptFromUserCode(
      [
        "interface Row { id: number; name: string }",
        "const limit: number = 5;",
        "const rows = (await tools.list_apps({ limit })) as { data: Row[] };",
        "function pick<T>(items: T[]): T | undefined { return items[0]; }",
        "return pick(rows.data)!;",
      ].join("\n"),
    );

    expect(stripped).not.toContain("interface");
    expect(stripped).not.toContain(": number");
    expect(stripped).not.toContain("as {");
    expect(stripped).not.toContain("<T>");
    expect(stripped).toContain("const limit = 5;");
    expect(stripped).toContain("return pick(rows.data);");
  });

  it("leaves plain JavaScript intact, including ternaries and object literals", () => {
    const code = [
      'const config = { mode: enabled ? "on" : "off", retries: 3 };',
      "return await tools.set_preview({ app_name: config.mode });",
    ].join("\n");
    expect(stripTypeScriptFromUserCode(code)).toBe(code);
  });

  it("supports top-level return and await, and falls back on unparseable code", () => {
    expect(stripTypeScriptFromUserCode("return await tools.list_apps();")).toBe(
      "return await tools.list_apps();",
    );
    const broken = "const x = {;";
    expect(stripTypeScriptFromUserCode(broken)).toBe(broken);
  });

  it("is applied by codeModeWorkerModule before embedding user code", () => {
    const source = codeModeWorkerModule("const n: number = 1;\nreturn n;");
    expect(source).toContain("const n = 1;");
    expect(source).not.toContain("const n: number = 1;");
  });
});

function loadGeneratedToolHelp(): (
  allTools: unknown[],
) => (input?: unknown) => any {
  const source = codeModeWorkerModule("");
  const start = source.indexOf("const TOOL_CATEGORY_DESCRIPTIONS");
  const end = source.indexOf("\n\nfunction createCamelAiFacade", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const slice = source.slice(start, end);
  return new Function(`${slice}; return createToolHelp;`)();
}

describe("code mode runner tools.help guide", () => {
  it("resolves the connections category over the connections runtime facade for bare keys", () => {
    const createHelp = loadGeneratedToolHelp();
    const help = createHelp([
      {
        name: "analysis_list_connections",
        category: "connections",
        description: "List data connections.",
      },
    ]);

    const result = help("connections");
    expect(result.category).toBe("connections");
    expect(result.tools.map((tool: any) => tool.name)).toContain(
      "analysis_list_connections",
    );
    // The runtime facade still shows up inside the category view...
    expect(result.runtimes.map((entry: any) => entry.name)).toContain(
      "connections",
    );
    // ...and stays directly reachable via an explicit runtime request.
    expect(help({ runtime: "connections" }).runtime.name).toBe("connections");
  });

  it("returns the full usage guide from a no-argument tools.help() call", () => {
    const createHelp = loadGeneratedToolHelp();
    const help = createHelp([
      {
        name: "send_email",
        category: "communication",
        description: "Send an email.",
      },
    ]);

    const result = help();
    expect(Array.isArray(result.guide)).toBe(true);
    const guide = result.guide.join("\n");
    // The long-form guidance moved out of the js_exec tool description lives here.
    expect(guide).toContain(
      "opens successful deploys in preview automatically",
    );
    expect(guide).toContain("env.CONNECTIONS.find");
    expect(guide).toContain("location");
    expect(guide).toContain("file.data.text");
    expect(guide).toContain("env.AI.run");
    expect(guide).not.toContain("WebSearch");
    expect(guide).not.toContain("WebFetch");
    // Executor-style calling shape: envelope semantics and TypeScript acceptance.
    expect(guide).toContain("{ ok: true, data }");
    expect(guide).toContain("type annotations are stripped");
    expect(result.categories.length).toBeGreaterThan(0);
  });

  it("includes a targeted hint for JSON.parse on a tool result envelope", () => {
    const { formatRuntimeError } = loadGeneratedRuntimeErrorHelpers();

    const result = formatRuntimeError(
      new SyntaxError('"[object Object]" is not valid JSON'),
    );

    expect(result).toContain('"[object Object]" is not valid JSON');
    expect(result).toContain("JSON.parse received an object");
    expect(result).toContain("js_exec tools return { ok, data }");
    expect(result).toContain("parse result.data.text");
  });

  it("reports js_exec code locations without leaking generated stack frames", () => {
    const { formatRuntimeError, USER_CODE_START_LINE } =
      loadGeneratedRuntimeErrorHelpers(
        [
          "const before = true;",
          'JSON.parse(await tools.read({ location: "project", project: "app", path: "package.json" }));',
          "const after = true;",
        ].join("\n"),
      );
    const error = new SyntaxError('"[object Object]" is not valid JSON');
    error.stack = [
      'SyntaxError: "[object Object]" is not valid JSON',
      `    at runUserCode (index.js:${USER_CODE_START_LINE + 1}:7)`,
      "    at CodeModeRunner.run (index.js:1101:28)",
    ].join("\n");

    const result = formatRuntimeError(error);

    expect(result).toContain("at js_exec code line 2, column 7");
    expect(result).not.toContain("CodeModeRunner");
    expect(result).not.toContain("runUserCode");
    expect(result).not.toContain("index.js");
  });
});

function loadGeneratedRuntimeErrorHelpers(userCode = ""): {
  formatRuntimeError: (error: unknown) => string;
  USER_CODE_START_LINE: number;
  USER_CODE_END_LINE: number;
} {
  const source = codeModeWorkerModule(userCode);
  const start = source.indexOf("const USER_CODE_START_LINE");
  const end = source.indexOf("\n\nfunction createOutputConsole", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const slice = source.slice(start, end);
  return new Function(
    `${slice}; return { formatRuntimeError, USER_CODE_START_LINE, USER_CODE_END_LINE };`,
  )();
}

function loadGeneratedBoundHelpers(): {
  createOutputBuffer: (limit: number) => {
    push(value: unknown): void;
    pushValues<T>(values: T[], format: (value: T) => string): void;
    empty(): boolean;
    text(): string;
  };
  createNestedToolBudget: (limit: number) => <T>(invoke: () => T) => T;
  createNestedToolResultBudget: () => (<T>(value: T) => T) & {
    spendBytes(bytes: number): void;
  };
  assertNestedToolArgumentsBounded: (
    value: unknown,
    maximumBytes?: number,
  ) => number;
  stringifyOutput: (value: unknown) => string;
} {
  const source = codeModeWorkerModule("");
  const start = source.indexOf("function stringifyOutput");
  const end = source.indexOf("\n\nfunction createOutputConsole", start);
  const constantsStart = source.indexOf("const DEFAULT_MAX_OUTPUT_CHARACTERS");
  const constantsEnd = start;
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(constantsStart).toBeGreaterThanOrEqual(0);
  expect(constantsEnd).toBeGreaterThan(constantsStart);
  return new Function(
    `${source.slice(constantsStart, constantsEnd)}${source.slice(start, end)}; return { createOutputBuffer, createNestedToolBudget, createNestedToolResultBudget, assertNestedToolArgumentsBounded, stringifyOutput };`,
  )();
}

function loadGeneratedNestedInvocationRetainer(): (
  retain: (value: unknown) => unknown,
  assertActive: () => void,
) => (invoke: () => Promise<unknown>) => Promise<unknown> {
  const source = codeModeWorkerModule("");
  const start = source.indexOf("const NON_RETRYABLE_TOOL_ERROR");
  const end = source.indexOf("\n\nfunction stableToolArgs", start);
  const capturesStart = source.indexOf("const NativeError = Error");
  const capturesEnd = source.indexOf(
    "\n\nfunction stringifyOutput",
    capturesStart,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(capturesStart).toBeGreaterThanOrEqual(0);
  expect(capturesEnd).toBeGreaterThan(capturesStart);
  return new Function(
    `${source.slice(capturesStart, capturesEnd)};
const MAX_IDENTIFIER_CHARACTERS = ${CHAT_RUNTIME_BOUNDS.identifierChars};
${source.slice(start, end)};
return createNestedInvocationRetainer;`,
  )();
}

function loadGeneratedSecureFetch(): (
  binding: { fetch: (...args: any[]) => unknown },
  assertActive: () => void,
  reserveFetch?: <T>(input: unknown, init: unknown, invoke: () => T) => T,
  retainBodyBytes?: (bytes: number) => void,
) => () => void {
  const source = codeModeWorkerModule("");
  const start = source.indexOf("function installSecureFetch");
  const end = source.indexOf("\n\nexport class CodeModeRunner", start);
  const capturesStart = source.indexOf("const NativeError = Error");
  const capturesEnd = source.indexOf(
    "\n\nfunction stringifyOutput",
    capturesStart,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(capturesStart).toBeGreaterThanOrEqual(0);
  expect(capturesEnd).toBeGreaterThan(capturesStart);
  return new Function(
    `${source.slice(capturesStart, capturesEnd)};
const MAX_NESTED_TOOL_RESULT_BYTES = ${CHAT_RUNTIME_BOUNDS.toolResultBytes};
${source.slice(start, end)};
return installSecureFetch;`,
  )();
}

function loadGeneratedRuntimeGlobals(): (
  values: Record<string, unknown>,
) => () => void {
  const source = codeModeWorkerModule("");
  const start = source.indexOf("function installRuntimeGlobals");
  const end = source.indexOf("\n\nfunction installSecureFetch", start);
  const capturesStart = source.indexOf("const NativeError = Error");
  const capturesEnd = source.indexOf(
    "\n\nfunction stringifyOutput",
    capturesStart,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(capturesStart).toBeGreaterThanOrEqual(0);
  expect(capturesEnd).toBeGreaterThan(capturesStart);
  return new Function(
    `${source.slice(capturesStart, capturesEnd)};
${source.slice(start, end)};
return installRuntimeGlobals;`,
  )();
}

function loadGeneratedConnectionsFacade(): (
  binding: Record<string, unknown>,
) => any {
  const source = codeModeWorkerModule("");
  const constantsStart = source.indexOf("const MAX_NESTED_TOOL_ARGUMENT_BYTES");
  const capturesEnd = source.indexOf(
    "\n\nfunction stringifyOutput",
    constantsStart,
  );
  const boundsStart = source.indexOf(
    "function assertNestedToolArgumentsBounded",
  );
  const boundsEnd = source.indexOf(
    "\n\nfunction createNestedToolResultBudget",
    boundsStart,
  );
  const facadeStart = source.indexOf("function createConnectionsFacade");
  const facadeEnd = source.indexOf(
    "\n\nfunction createToolBackedConnectionsBinding",
    facadeStart,
  );
  expect(constantsStart).toBeGreaterThanOrEqual(0);
  expect(capturesEnd).toBeGreaterThan(constantsStart);
  expect(boundsStart).toBeGreaterThan(capturesEnd);
  expect(boundsEnd).toBeGreaterThan(boundsStart);
  expect(facadeStart).toBeGreaterThan(boundsEnd);
  expect(facadeEnd).toBeGreaterThan(facadeStart);
  return new Function(
    `${source.slice(constantsStart, capturesEnd)};
${source.slice(boundsStart, boundsEnd)};
${source.slice(facadeStart, facadeEnd)};
return createConnectionsFacade;`,
  )();
}

function loadGeneratedBrowserFacade(cleanupMs: number): (
  callTool: (name: string, args?: unknown) => Promise<unknown>,
  cleanupTool: (args: unknown) => Promise<unknown>,
) => {
  facade: { launch(input?: unknown): Promise<unknown> };
  cleanup(): Promise<void>;
} {
  const source = codeModeWorkerModule("");
  const start = source.indexOf("function createBrowserFacade");
  const end = source.indexOf("\n\nfunction createCamelAiFacade", start);
  const capturesStart = source.indexOf("const NativeError = Error");
  const capturesEnd = source.indexOf(
    "\n\nfunction stringifyOutput",
    capturesStart,
  );
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  expect(capturesStart).toBeGreaterThanOrEqual(0);
  expect(capturesEnd).toBeGreaterThan(capturesStart);
  return new Function(
    `const MAX_NESTED_TOOL_CALLS = ${CODE_MODE_MAX_NESTED_TOOL_CALLS};
const MAX_RUNTIME_CLEANUP_MS = ${cleanupMs};
${source.slice(capturesStart, capturesEnd)};
${source.slice(start, end)};
return createBrowserFacade;`,
  )();
}

function loadGeneratedToolSearch(): {
  createToolSearch: (allTools: unknown[]) => (input?: unknown) => any;
  createToolDescribe: (allTools: unknown[]) => (input?: unknown) => any;
  createEnvelopeToolCall: (
    name: string,
    callTool: (name: string, args?: unknown) => unknown,
    failureBudget?: Map<string, unknown>,
    assertActive?: () => void,
  ) => (args?: unknown) => Promise<any>;
  createToolsFacade: (
    entries: Array<[string, unknown]>,
    search: (input: unknown) => any,
  ) => Record<string, any>;
  schemaToTypeScript: (schema: unknown) => string;
} {
  const source = codeModeWorkerModule("");
  const start = source.indexOf("const RUNTIME_HELP_ENTRIES");
  const end = source.indexOf("\n\nfunction createScreenshotFacade", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  const slice = source.slice(start, end);
  return new Function(
    `const MAX_IDENTIFIER_CHARACTERS = ${CHAT_RUNTIME_BOUNDS.identifierChars}; ${slice}; return { createToolSearch, createToolDescribe, createEnvelopeToolCall, createToolsFacade, schemaToTypeScript };`,
  )();
}

describe("code mode runner tools.search / tools.describe", () => {
  const allTools = [
    {
      name: "send_email",
      category: "communication",
      description: "Send an email message to a recipient.",
      examples: ["await tools.send_email({ to, subject, body })"],
    },
    {
      name: "list_apps",
      category: "apps",
      description: "List deployed apps for the current workspace.",
      examples: [],
    },
    {
      name: "create_workflow",
      category: "workflows",
      description: "Create a deterministic JavaScript workflow.",
      examples: [],
    },
  ];

  it("ranks the most relevant tool first and gates out non-matches", () => {
    const { createToolSearch } = loadGeneratedToolSearch();
    const search = createToolSearch(allTools);

    const result = search("send email");
    expect(result.items[0].name).toBe("send_email");
    expect(result.items.every((item: any) => item.score > 0)).toBe(true);
    // "send email" should not surface unrelated tools (coverage gate).
    expect(result.items.map((item: any) => item.name)).not.toContain(
      "list_apps",
    );
    // Each match advertises how to inspect it next.
    expect(result.items[0].describe).toBe('await tools.describe("send_email")');
  });

  it("accepts a string or { query, limit } and requires a query", () => {
    const { createToolSearch } = loadGeneratedToolSearch();
    const search = createToolSearch(allTools);

    expect(search({ query: "deployed apps", limit: 1 }).items).toHaveLength(1);
    expect(() => search("")).toThrow(/requires a query/);
    expect(() => search({})).toThrow(/requires a query/);
  });

  it("labels runtime hits as globals instead of suggesting tools.<name> calls", () => {
    const { createToolSearch } = loadGeneratedToolSearch();
    const search = createToolSearch(allTools);

    const toolHit = search("send email").items[0];
    expect(toolHit.kind).toBe("tool");
    expect(toolHit.call).toBe('await tools["send_email"](args)');

    const result = search("connections");
    const runtimeHit = result.items.find(
      (item: any) => item.name === "env.CONNECTIONS",
    );
    expect(runtimeHit.kind).toBe("runtime");
    expect(runtimeHit.call).toContain("NOT callable via tools.<name>");
    expect(runtimeHit.call).toContain("await env.CONNECTIONS.list()");
    expect(result.usage).toContain("sandbox globals");
  });

  it("describe returns the full definition for a known tool and suggests for misses", () => {
    const { createToolDescribe } = loadGeneratedToolSearch();
    const describe = createToolDescribe(allTools);

    const known = describe("send_email");
    expect(known.tool.name).toBe("send_email");
    expect(known.tool.description).toContain("Send an email");
    expect(known.usage).toContain("await tools.send_email");

    const miss = describe("totally_unknown_tool");
    expect(miss.error).toContain("totally_unknown_tool");
    expect(Array.isArray(miss.suggestions)).toBe(true);
    expect(() => describe("")).toThrow(/requires a tool name/);
  });

  it("describe replaces the JSON Schema with a compact inputTypeScript shape", () => {
    const { createToolDescribe } = loadGeneratedToolSearch();
    const describe = createToolDescribe([
      {
        name: "create_scheduled_prompt",
        category: "schedules",
        description: "Create a scheduled prompt.",
        parameters: {
          type: "object",
          required: ["name", "prompt", "cron_expression"],
          properties: {
            name: { type: "string" },
            prompt: { type: "string" },
            cron_expression: { type: "string" },
            enabled: { type: "boolean" },
          },
        },
      },
    ]);

    const result = describe("create_scheduled_prompt");
    expect(result.tool.inputTypeScript).toBe(
      "{ name: string, prompt: string, cron_expression: string, enabled?: boolean }",
    );
    expect(result.tool.parameters).toBeUndefined();
    expect(result.usage).toContain("{ ok: true, data }");
  });

  it("renders enums, unions, arrays, and nested objects as TypeScript", () => {
    const { schemaToTypeScript } = loadGeneratedToolSearch();
    expect(
      schemaToTypeScript({
        type: "object",
        required: ["location", "todos"],
        properties: {
          location: { type: "string", enum: ["workspace", "project", "r2"] },
          limit: { type: ["number", "null"] },
          todos: {
            type: "array",
            items: {
              type: "object",
              required: ["content"],
              properties: { content: { type: "string" } },
            },
          },
        },
      }),
    ).toBe(
      '{ location: "workspace" | "project" | "r2", limit?: number | null, todos: { content: string }[] }',
    );
    expect(
      schemaToTypeScript({ type: "array", items: { enum: ["a", "b"] } }),
    ).toBe('("a" | "b")[]');
    expect(schemaToTypeScript(undefined)).toBe("unknown");
  });

  it("passes DO-built envelopes through and normalizes transport failures", async () => {
    const { createEnvelopeToolCall } = loadGeneratedToolSearch();

    const success = createEnvelopeToolCall("list_apps", async () => ({
      ok: true,
      data: { apps: [] },
    }));
    await expect(success({})).resolves.toEqual({
      ok: true,
      data: { apps: [] },
    });

    const toolFailure = createEnvelopeToolCall(
      "create_scheduled_prompt",
      async () => ({
        ok: false,
        error: {
          tool: "create_scheduled_prompt",
          message: "cron_expression is required",
        },
      }),
    );
    await expect(toolFailure({ name: "x" })).resolves.toMatchObject({
      ok: false,
      error: {
        tool: "create_scheduled_prompt",
        message: "cron_expression is required",
      },
      completionEvidence: { status: "failed", supportedClaims: [] },
      recovery: { blocked: false, remainingEquivalentRetries: 1 },
    });

    const deployFailure = createEnvelopeToolCall(
      "deploy_project",
      async () => ({
        ok: true,
        data: { success: false, stage: "build", errorSummary: "Build failed" },
      }),
    );
    await expect(deployFailure({})).resolves.toMatchObject({
      ok: false,
      error: {
        tool: "deploy_project",
        message: "Build failed",
        origin: "tool",
        stage: "build",
      },
      data: { success: false, stage: "build", errorSummary: "Build failed" },
      completionEvidence: { status: "failed", supportedClaims: [] },
    });

    const transportFailure = createEnvelopeToolCall("list_apps", async () => {
      throw new Error("RPC connection lost");
    });
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});
    try {
      await expect(
        transportFailure({ secret: "do-not-log" }),
      ).resolves.toMatchObject({
        ok: false,
        error: {
          tool: "list_apps",
          message: "RPC connection lost",
          origin: "transport",
        },
        completionEvidence: { status: "failed", supportedClaims: [] },
      });
      expect(consoleError).toHaveBeenCalledWith(
        "[code-mode] tools RPC failed",
        {
          toolName: "list_apps",
          origin: "transport",
          error: "RPC connection lost",
        },
      );
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
        "do-not-log",
      );
    } finally {
      consoleError.mockRestore();
    }
  });

  it("fences a late registered-tool envelope before projection or retry mutation", async () => {
    const { createEnvelopeToolCall } = loadGeneratedToolSearch();
    let active = true;
    let resolveEnvelope!: (value: unknown) => void;
    const deferredEnvelope = new Promise<unknown>((resolve) => {
      resolveEnvelope = resolve;
    });
    let accessorReads = 0;
    const lateEnvelope: Record<string, unknown> = {};
    Object.defineProperty(lateEnvelope, "ok", {
      enumerable: true,
      get() {
        accessorReads += 1;
        return true;
      },
    });
    const failureBudget = new Map<string, unknown>();
    const call = createEnvelopeToolCall(
      "list_apps",
      () => deferredEnvelope,
      failureBudget,
      () => {
        if (!active) throw new Error("js_exec is no longer active");
      },
    );
    const pending = call({});

    active = false;
    resolveEnvelope(lateEnvelope);

    await expect(pending).rejects.toThrow("js_exec is no longer active");
    expect(accessorReads).toBe(0);
    expect(failureBudget.size).toBe(0);
  });

  it("returns discovery guidance for guessed tool names", async () => {
    const { createToolSearch, createToolsFacade } = loadGeneratedToolSearch();
    const search = createToolSearch(allTools);
    const tools = createToolsFacade(
      [
        ["search", search],
        ["send_email", vi.fn()],
      ],
      search,
    );

    expect(tools.then).toBeUndefined();
    await expect(
      tools.send_mail({ to: "person@example.com" }),
    ).resolves.toMatchObject({
      ok: false,
      error: {
        tool: "send_mail",
        origin: "discovery",
        suggestions: expect.arrayContaining(["send_email"]),
      },
      recovery: { blocked: true },
      completionEvidence: { status: "failed" },
    });
  });

  it("blocks equivalent failures after a bounded retry budget", async () => {
    const { createEnvelopeToolCall } = loadGeneratedToolSearch();
    const invoke = vi.fn(async () => ({
      ok: false,
      error: {
        tool: "list_apps",
        message: "temporary upstream failure",
        origin: "tool",
      },
    }));
    const call = createEnvelopeToolCall("list_apps", invoke);

    expect((await call({ limit: 5 })).recovery.blocked).toBe(false);
    expect((await call({ limit: 5 })).recovery.blocked).toBe(true);
    const blocked = await call({ limit: 5 });

    expect(blocked.error.origin).toBe("retry_budget");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("blocks non-retryable authorization and billing failures after one attempt", async () => {
    const { createEnvelopeToolCall } = loadGeneratedToolSearch();
    const invoke = vi.fn(async () => ({
      ok: false,
      error: {
        tool: "send_email",
        message: "402 billing quota exhausted",
        origin: "tool",
      },
    }));
    const call = createEnvelopeToolCall("send_email", invoke);

    expect((await call({ to: "person@example.com" })).recovery.blocked).toBe(
      true,
    );
    expect((await call({ to: "person@example.com" })).error.origin).toBe(
      "retry_budget",
    );
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("distinguishes deploy publication evidence from dry-run validation", async () => {
    const { createEnvelopeToolCall } = loadGeneratedToolSearch();
    const published = createEnvelopeToolCall("deploy_project", async () => ({
      ok: true,
      data: { success: true, url: "https://demo-acme85.camelai.app" },
    }));
    const dryRun = createEnvelopeToolCall("deploy_project", async () => ({
      ok: true,
      data: { success: true, dryRun: true },
    }));

    await expect(published({})).resolves.toMatchObject({
      completionEvidence: {
        status: "succeeded",
        supportedClaims: ["deployed", "published"],
        target: "https://demo-acme85.camelai.app",
      },
    });
    await expect(dryRun({})).resolves.toMatchObject({
      completionEvidence: {
        supportedClaims: ["build validated"],
        unsupportedClaims: ["deployed", "published", "live"],
      },
    });
  });

  it("describe on a runtime helper explains it is a global, not a tools.<name> call", () => {
    const { createToolDescribe } = loadGeneratedToolSearch();
    const describe = createToolDescribe(allTools);

    const runtime = describe("env.CONNECTIONS");
    expect(runtime.runtime.name).toBe("env.CONNECTIONS");
    expect(runtime.usage).toContain("NOT callable via tools.<name>");
    expect(runtime.usage).toContain("await env.CONNECTIONS.list()");
  });

  it("describes the project facades advertised in the js_exec guide", () => {
    const { createToolDescribe } = loadGeneratedToolSearch();
    const describe = createToolDescribe(allTools);

    const projects = describe("env.PROJECTS");
    expect(projects.runtime.name).toBe("env.PROJECTS");
    expect(projects.runtime.methods.map((method: any) => method.name)).toEqual([
      "list",
      "create",
      "setDescription",
    ]);
  });
});

describe("js_exec result-shape contracts", () => {
  const source = codeModeWorkerModule("return 1;", {
    orgId: "o",
    workspaceId: "w",
  });

  it("tools.search returns { query, total, items, usage } directly, never { ok, data }", () => {
    // The sandbox search helper's return construction — locked so agents can
    // rely on the documented direct shape (no wrapper).
    expect(source).toMatch(
      /return \{\s*query,\s*total: scored\.length,\s*items,\s*usage/,
    );
    // And the guidance must say exactly that, including the shape.
    expect(source).toContain(
      "tools.search/describe/help return their values directly",
    );
    expect(source).toContain("NO { ok, data } wrapper");
  });

  it("resolves ok: false for build/deploy/notebook operational failures, with the result kept in data", () => {
    expect(source).toContain(
      'OPERATIONAL_OUTCOME_TOOLS = new Set(["deploy_project", "run_notebook"])',
    );
    expect(source).toContain(
      "envelope.data.success === false || envelope.data.ok === false",
    );
    expect(source).toContain(
      "deploy_project and run_notebook resolve ok: false",
    );
  });
});

describe("empty js_exec output", () => {
  it("explains no-output runs instead of returning a silent blank", () => {
    const source = codeModeWorkerModule("return 1;", {
      orgId: "o",
      workspaceId: "w",
    });
    // The blank case must be self-explaining: agents receiving "" invented
    // renderer failures (the "see attached image" incident). The message must
    // name the if/else pitfall since block-final scripts are the common cause.
    expect(source).toContain(
      "js_exec completed: no return value and no console output",
    );
    expect(source).toContain(
      "expressions inside if/else or loop blocks are not",
    );
    expect(source).toMatch(/if \(output\.empty\(\)\)/);
  });

  it("auto-return still skips block-closing final lines (the pitfall the message covers)", () => {
    const prepared = prepareCodeModeUserCode(
      [
        'const r = await tools.deploy_project({ project: "x" });',
        "if (r.ok) {",
        "  r.data;",
        "} else {",
        "  r.error;",
        "}",
      ].join("\n"),
    );
    expect(prepared).not.toContain("return");
  });
});
