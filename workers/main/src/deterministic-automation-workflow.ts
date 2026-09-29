import {
  dispatchWorkflow,
  DynamicWorkflowBinding,
  type LoadWorkflowRunnerContext,
  type WorkflowRunner,
} from "@cloudflare/dynamic-workflows";
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { AIVirtualBindingProps } from "./ai-virtual-binding";
import type { CodeModeToolsProps } from "./code-mode-tools";
import type { WorkspaceCronDO } from "./workspace-cron";

const AUTOMATION_WORKFLOW_ENTRYPOINT = "AutomationWorkflow";
const AUTOMATION_COMPATIBILITY_DATE = "2026-05-18";

export { DynamicWorkflowBinding };

interface DeterministicAutomationMetadata {
  workspaceId?: unknown;
  automationId?: unknown;
  sourceVersion?: unknown;
}

interface DeterministicAutomationWorkflowEnv {
  WORKSPACE_CRON?: DurableObjectNamespace<WorkspaceCronDO>;
  CODE_MODE_LOADER?: WorkerLoader;
}

interface AutomationRunStatusTarget {
  cronStub: DurableObjectStub<WorkspaceCronDO>;
  workspaceId: string;
  automationId: string;
  instanceId: string;
}

interface WorkflowExecutionContextLike {
  waitUntil?: (promise: Promise<unknown>) => void;
  exports?: WorkerEntrypointFactories;
}

interface WorkerEntrypointFactories {
  CodeModeToolsBinding?: (options: { props: CodeModeToolsProps }) => unknown;
  AIVirtualBinding?: (options: { props: AIVirtualBindingProps }) => unknown;
  CamelAiService?: (options: { props: AIVirtualBindingProps }) => unknown;
  SecureFetchBinding?: (options: { props: Pick<CodeModeToolsProps, "orgId" | "workspaceId"> }) => unknown;
}

function requireMetadataString(
  metadata: DeterministicAutomationMetadata,
  key: "workspaceId" | "automationId",
): string {
  const value = metadata[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Dynamic automation metadata is missing ${key}`);
  }
  return value.trim();
}

function requireSourceVersion(metadata: DeterministicAutomationMetadata): number {
  const value = metadata.sourceVersion;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error("Dynamic automation metadata is missing sourceVersion");
  }
  return Math.floor(value);
}

function getWorkspaceCronStub(
  env: DeterministicAutomationWorkflowEnv,
  workspaceId: string,
): DurableObjectStub<WorkspaceCronDO> {
  if (!env.WORKSPACE_CRON) {
    throw new Error("WORKSPACE_CRON binding is not configured");
  }

  return env.WORKSPACE_CRON.get(
    env.WORKSPACE_CRON.idFromName(workspaceId),
  ) as DurableObjectStub<WorkspaceCronDO>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Retry config for the terminal status write. It is a DO RPC that a deploy can
 * disrupt (the WorkspaceCronDO is relocated mid-call), so the Workflows engine
 * must durably retry it rather than dropping it.
 */
const RUN_STATUS_STEP_CONFIG = {
  retries: { limit: 6, delay: "5 seconds", backoff: "exponential" },
  timeout: "1 minute",
} as const;

/**
 * Write the terminal run status to WorkspaceCronDO. THROWS on RPC failure so the
 * enclosing `step.do` retries; a `false` return (the run row is gone/superseded)
 * is terminal and only logged.
 */
async function writeWorkflowRunStatus(
  target: AutomationRunStatusTarget,
  status: "success" | "error",
  error?: unknown,
): Promise<void> {
  const recorded = await target.cronStub.recordDeterministicAutomationRunResult({
    workspaceId: target.workspaceId,
    automationId: target.automationId,
    instanceId: target.instanceId,
    status,
    error: status === "error" ? errorMessage(error) : null,
  });
  if (!recorded) {
    console.warn(
      "[DeterministicAutomationWorkflow] run status row missing; not recorded",
      {
        workspaceId: target.workspaceId,
        automationId: target.automationId,
        instanceId: target.instanceId,
        status,
      },
    );
  }
}

/**
 * Record the terminal status durably, inside a `step.do`, so the Workflows engine
 * retries the DO RPC across transient failures (e.g. a deploy relocating the
 * WorkspaceCronDO) instead of the previous fire-and-forget call that swallowed
 * errors and could strand a run in `started`. Cloudflare already resumes the
 * workflow itself across deploys; this makes the bridge to our run record equally
 * durable.
 */
export async function recordWorkflowRunStatus(
  step: WorkflowStep,
  target: AutomationRunStatusTarget | null,
  status: "success" | "error",
  error?: unknown,
): Promise<void> {
  if (!target) return;
  try {
    await step.do(`camelai:record-run-status:${status}`, RUN_STATUS_STEP_CONFIG, () =>
      writeWorkflowRunStatus(target, status, error),
    );
  } catch (recordError) {
    console.error(
      "[DeterministicAutomationWorkflow] failed to durably record run status",
      {
        workspaceId: target.workspaceId,
        automationId: target.automationId,
        instanceId: target.instanceId,
        status,
        error: errorMessage(recordError),
      },
    );
  }
}

function loadAutomationWorker(input: {
  env: DeterministicAutomationWorkflowEnv;
  workflowEnv: Record<string, unknown>;
  cacheKey: string;
  source: string;
}): WorkerStub {
  const loader = input.env.CODE_MODE_LOADER as
    | (WorkerLoader & { load?: (code: WorkerLoaderWorkerCode) => WorkerStub })
    | undefined;
  if (!loader) {
    throw new Error("CODE_MODE_LOADER binding is not configured");
  }

  const workerCode: WorkerLoaderWorkerCode = {
    compatibilityDate: AUTOMATION_COMPATIBILITY_DATE,
    mainModule: "index.js",
    modules: {
      "index.js": { js: input.source },
    },
    env: input.workflowEnv,
  };

  return typeof loader.load === "function"
    ? loader.load(workerCode)
    : loader.get(input.cacheKey, () => workerCode);
}

const AUTOMATION_WORKFLOW_EXPORT_PATTERN =
  /\bexport\s+class\s+AutomationWorkflow\s+extends\s+WorkflowEntrypoint\b/;

const AUTOMATION_CONNECTIONS_FACADE_SOURCE = String.raw`
function __camelAiCreateToolsFacade(binding) {
  return new Proxy({}, {
    get(_target, toolName) {
      if (toolName === "then") return undefined;
      if (typeof toolName !== "string") return binding[toolName];
      if (toolName === "callTool") return (name, args = {}) => binding.callTool(name, args);
      if (toolName === "listTools") return () => binding.listTools();
      return (args = {}) => binding.callTool(toolName, args);
    },
  });
}

function __camelAiCreateConnectionsFacade(binding, tools) {
  const legacyInvokeMethod = ["_", "_", "invoke"].join("");
  const callConnectionTool = (name, args = {}) => {
    if (tools && typeof tools.callTool === "function") {
      return tools.callTool(name, args);
    }
    return undefined;
  };
  const invokeConnectionMethod = (request) => {
    const toolResult = callConnectionTool("connections_invoke", request);
    if (toolResult !== undefined) {
      return toolResult;
    }
    if (typeof binding.invoke === "function") {
      return binding.invoke(request);
    }
    if (typeof binding[legacyInvokeMethod] === "function") {
      return binding[legacyInvokeMethod](request);
    }
    throw new Error("CONNECTIONS method invocation is not configured");
  };

  function responseFromFetchPayload(payload) {
    if (!payload || typeof payload !== "object" || typeof payload.status !== "number") {
      return payload;
    }
    const headers = new Headers(payload.headers || {});
    if (payload.truncated) headers.set("x-camelai-truncated", "true");
    return new Response(payload.bodyText || "", {
      status: payload.status,
      statusText: payload.statusText || "",
      headers,
    });
  }

  async function serializeFetchInput(input) {
    if (input instanceof Request) {
      return {
        input: input.url,
        init: {
          method: input.method,
          headers: Object.fromEntries(input.headers.entries()),
          body: input.method === "GET" || input.method === "HEAD" ? undefined : await input.text(),
        },
      };
    }
    return { input: String(input ?? ""), init: {} };
  }

  function serializeFetchInit(init) {
    if (!init || typeof init !== "object") return {};
    const output = { ...init };
    if (init.headers) {
      output.headers = Object.fromEntries(new Headers(init.headers).entries());
    }
    return output;
  }

  return new Proxy({}, {
    get(_target, connectionName) {
      if (connectionName === "then") return undefined;
      if (connectionName === "$methods") return () => callConnectionTool("connections_methods") ?? binding.methods();
      if (connectionName === "$find") return (query) => callConnectionTool("connections_find", { query }) ?? binding.find(query);
      if (connectionName === "$test") return (query) => callConnectionTool("connections_test", { query }) ?? binding.test(query);
      if (connectionName === "$verify") return (query) => callConnectionTool("connections_verify", { query }) ?? binding.verify(query);
      if (connectionName === "$list") return () => callConnectionTool("connections_list") ?? binding.list();
      if (connectionName === "$get") return (connection) => callConnectionTool("connections_get", { connection }) ?? binding.get(connection);
      if (connectionName === "$tools") return (connection) => callConnectionTool("connections_tools", { connection }) ?? binding.tools(connection);
      if (typeof connectionName !== "string") return binding[connectionName];
      if ([
        "list",
        "get",
        "tools",
        "methods",
        "find",
        "test",
        "verify",
        "invoke",
        legacyInvokeMethod,
      ].includes(connectionName)) {
        const value = binding[connectionName];
        if (connectionName === "list") return () => callConnectionTool("connections_list") ?? value.apply(binding);
        if (connectionName === "get") return (connection) => callConnectionTool("connections_get", { connection }) ?? value.apply(binding, [connection]);
        if (connectionName === "tools") return (connection) => callConnectionTool("connections_tools", { connection }) ?? value.apply(binding, [connection]);
        if (connectionName === "methods") return () => callConnectionTool("connections_methods") ?? value.apply(binding);
        if (connectionName === "find") return (query) => callConnectionTool("connections_find", { query }) ?? value.apply(binding, [query]);
        if (connectionName === "test") return (query) => callConnectionTool("connections_test", { query }) ?? value.apply(binding, [query]);
        if (connectionName === "verify") return (query) => callConnectionTool("connections_verify", { query }) ?? value.apply(binding, [query]);
        return typeof value === "function" ? (...args) => value.apply(binding, args) : value;
      }

      return new Proxy({}, {
        get(_connectionTarget, methodName) {
          if (methodName === "then") return undefined;
          if (typeof methodName !== "string") return undefined;
          return async (...args) => {
            let input = args[0] ?? {};
            if (methodName === "fetch") {
              const serialized = await serializeFetchInput(args[0]);
              input = {
                ...serialized,
                init: {
                  ...serialized.init,
                  ...serializeFetchInit(args[1]),
                },
              };
            }
            const result = await invokeConnectionMethod({
              connection: connectionName,
              method: methodName,
              input,
            });
            return methodName === "fetch" ? responseFromFetchPayload(result) : result;
          };
        },
      });
    },
  });
}

function __camelAiPatchGlobalFetch(secureFetch) {
  if (!secureFetch || typeof secureFetch.fetch !== "function") {
    return () => {};
  }
  const nativeFetch = typeof globalThis.fetch === "function"
    ? globalThis.fetch.bind(globalThis)
    : undefined;
  globalThis.fetch = (input, init) => secureFetch.fetch(input, init);
  return () => {
    if (nativeFetch) {
      globalThis.fetch = nativeFetch;
    }
  };
}

function __camelAiInstallWorkflowSecureFetch(instance) {
  return __camelAiPatchGlobalFetch(instance.env?.SECURE_FETCH);
}

function __camelAiWrapWorkflowStepForSecureFetch(step, secureFetch) {
  if (!step || typeof step.do !== "function" || !secureFetch || typeof secureFetch.fetch !== "function") {
    return step;
  }
  const wrapCallback = (callback) => {
    if (typeof callback !== "function") return callback;
    return async (...args) => {
      const restoreFetch = __camelAiPatchGlobalFetch(secureFetch);
      try {
        return await callback(...args);
      } finally {
        restoreFetch();
      }
    };
  };
  return new Proxy(step, {
    get(target, prop, receiver) {
      if (prop === "do") {
        return (name, configOrCallback, maybeCallback) => {
          if (typeof configOrCallback === "function") {
            return target.do(name, wrapCallback(configOrCallback));
          }
          if (typeof maybeCallback === "function") {
            return target.do(name, configOrCallback, wrapCallback(maybeCallback));
          }
          return target.do(name, configOrCallback, maybeCallback);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function __camelAiInstallWorkflowConnectionsFacade(instance) {
  const restoreFetch = __camelAiInstallWorkflowSecureFetch(instance);
  const originalEnv = instance.env;
  if (!originalEnv || typeof originalEnv !== "object" || (!originalEnv.CONNECTIONS && !originalEnv.TOOLS)) {
    return restoreFetch;
  }
  const tools = originalEnv.TOOLS ? __camelAiCreateToolsFacade(originalEnv.TOOLS) : undefined;
  const connections = __camelAiCreateConnectionsFacade(originalEnv.CONNECTIONS || {}, tools);
  const wrappedEnv = new Proxy(originalEnv, {
    get(target, property, receiver) {
      if (property === "CONNECTIONS") return connections;
      if (property === "TOOLS" && tools) return tools;
      return Reflect.get(target, property, receiver);
    },
  });
  Object.defineProperty(instance, "env", {
    configurable: true,
    enumerable: true,
    value: wrappedEnv,
  });
  return restoreFetch;
}
`;

export function prepareDeterministicAutomationRuntimeSource(source: string): string {
  if (!AUTOMATION_WORKFLOW_EXPORT_PATTERN.test(source)) return source;
  return [
    AUTOMATION_CONNECTIONS_FACADE_SOURCE,
    source.replace(
      AUTOMATION_WORKFLOW_EXPORT_PATTERN,
      "class __CamelAiUserAutomationWorkflow extends WorkflowEntrypoint",
    ),
    String.raw`
export class AutomationWorkflow extends __CamelAiUserAutomationWorkflow {
  async run(event, step) {
    const restoreFetch = __camelAiInstallWorkflowConnectionsFacade(this);
    const secureStep = __camelAiWrapWorkflowStepForSecureFetch(step, this.env?.SECURE_FETCH);
    try {
      return await super.run(event, secureStep);
    } finally {
      restoreFetch();
    }
  }
}
`,
  ].join("\n");
}

export function createDeterministicAutomationRuntimeBindings(input: {
  ctx: WorkflowExecutionContextLike;
  orgId: string;
  workspaceId: string;
  userId?: string;
  invocationId?: string;
}): Record<string, unknown> {
  const scopedProps = {
    orgId: input.orgId,
    workspaceId: input.workspaceId,
    userId: input.userId,
    parentToolUseId: input.invocationId
      ? `automation:${input.invocationId}`
      : undefined,
  };
  const exports = input.ctx.exports;
  if (!exports) {
    return {
      AUTOMATION_CONTEXT: scopedProps,
    };
  }
  const {
    CodeModeToolsBinding,
    AIVirtualBinding,
    CamelAiService,
    SecureFetchBinding,
    AppScreenshotBinding,
    AppBrowserBinding,
  } = exports;
  if (
    !CodeModeToolsBinding ||
    !AIVirtualBinding ||
    !CamelAiService ||
    !SecureFetchBinding ||
    !AppScreenshotBinding ||
    !AppBrowserBinding
  ) {
    throw new Error("Automation runtime bindings are not exported");
  }
  return {
    TOOLS: CodeModeToolsBinding({ props: scopedProps }),
    AI: AIVirtualBinding({ props: scopedProps }),
    CAMELAI: CamelAiService({ props: scopedProps }),
    SECURE_FETCH: SecureFetchBinding({
      props: {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      },
    }),
    SCREENSHOT: AppScreenshotBinding({
      props: {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      },
    }),
    BROWSER: AppBrowserBinding({
      props: {
        orgId: input.orgId,
        workspaceId: input.workspaceId,
      },
    }),
  };
}

async function loadDeterministicAutomationRunner(
  input: LoadWorkflowRunnerContext<DeterministicAutomationWorkflowEnv> & {
    runtimeInvocationId?: string;
    onStatusTarget?: (
      target: Omit<AutomationRunStatusTarget, "instanceId">,
    ) => void;
  },
): Promise<WorkflowRunner<unknown, unknown>> {
  const typedMetadata = input.metadata as DeterministicAutomationMetadata;
  const workspaceId = requireMetadataString(typedMetadata, "workspaceId");
  const automationId = requireMetadataString(typedMetadata, "automationId");
  const cronStub = getWorkspaceCronStub(input.env, workspaceId);
  input.onStatusTarget?.({ cronStub, workspaceId, automationId });
  const sourceVersion = requireSourceVersion(typedMetadata);

  const snapshot = await cronStub.getDeterministicAutomationSource(
    workspaceId,
    automationId,
    sourceVersion,
  );
  if (!snapshot) {
    throw new Error(
      `Deterministic automation source not found: ${automationId}@${sourceVersion}`,
    );
  }

  const workspace = await cronStub.getWorkspaceInfoForAutomation(workspaceId);
  const worker = loadAutomationWorker({
    env: input.env,
    source: prepareDeterministicAutomationRuntimeSource(snapshot.source),
    cacheKey: `automation-${workspaceId}-${automationId}-${sourceVersion}`,
    workflowEnv: createDeterministicAutomationRuntimeBindings({
      ctx: input.ctx,
      orgId: workspace.org_id,
      workspaceId,
      userId: snapshot.created_by,
      invocationId: input.runtimeInvocationId,
    }),
  });

  return worker.getEntrypoint(
    AUTOMATION_WORKFLOW_ENTRYPOINT,
  ) as unknown as WorkflowRunner<unknown, unknown>;
}

export class DeterministicAutomationWorkflow extends WorkflowEntrypoint<
  DeterministicAutomationWorkflowEnv,
  unknown
> {
  override async run(
    event: WorkflowEvent<unknown>,
    step: WorkflowStep,
  ): Promise<unknown> {
    let statusTarget: AutomationRunStatusTarget | null = null;

    try {
      const result = await dispatchWorkflow<
        DeterministicAutomationWorkflowEnv,
        unknown,
        unknown
      >({ env: this.env, ctx: this.ctx }, event, step, async (context) =>
        loadDeterministicAutomationRunner({
          ...context,
          runtimeInvocationId: event.instanceId,
          onStatusTarget: (target) => {
            statusTarget = {
              ...target,
              instanceId: event.instanceId,
            };
          },
        }),
      );
      await recordWorkflowRunStatus(step, statusTarget, "success");
      return result;
    } catch (error) {
      await recordWorkflowRunStatus(step, statusTarget, "error", error);
      throw error;
    }
  }
}
