import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  createDeterministicAutomationRuntimeBindings,
  prepareDeterministicAutomationRuntimeSource,
  recordWorkflowRunStatus,
} from "../src/deterministic-automation-workflow";

const WORKFLOW_COMPATIBILITY_DATE = "2026-05-18";

function createWorkflowToolsFacade(binding: any): Record<string, unknown> {
  return new Proxy({}, {
    get(_target, toolName) {
      if (toolName === "then") return undefined;
      if (typeof toolName !== "string") return binding[toolName];
      if (toolName === "callTool") return (name: string, args = {}) => binding.callTool(name, args);
      if (toolName === "listTools") return () => binding.listTools();
      return (args = {}) => binding.callTool(toolName, args);
    },
  });
}

function assertGeneratedWorkflowToolsFacade(): void {
  const source = prepareDeterministicAutomationRuntimeSource(`
import { WorkflowEntrypoint } from "cloudflare:workers";
export class AutomationWorkflow extends WorkflowEntrypoint {
  async run() {}
}
`);
  const start = source.indexOf("function __camelAiCreateToolsFacade(binding)");
  const end = source.indexOf("\n\nfunction __camelAiCreateConnectionsFacade", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
}

describe("DeterministicAutomationWorkflow", () => {
  it("uses exported entrypoint factories when ctx.exports is available", () => {
    const tools = {};
    const ai = {};
    const camelai = {};
    const secureFetch = {};
    const screenshot = {};
    const appBrowser = {};
    const exports = {
      CodeModeToolsBinding: vi.fn(() => tools),
      AIVirtualBinding: vi.fn(() => ai),
      CamelAiService: vi.fn(() => camelai),
      SecureFetchBinding: vi.fn(() => secureFetch),
      AppScreenshotBinding: vi.fn(() => screenshot),
      AppBrowserBinding: vi.fn(() => appBrowser),
    };
    const bindings = createDeterministicAutomationRuntimeBindings({
      ctx: { exports },
      orgId: "org1",
      workspaceId: "workspace1",
      userId: "user1",
      invocationId: "run-1",
    });

    const props = {
      props: {
        orgId: "org1", workspaceId: "workspace1", userId: "user1",
        externalSessionId: "run-1", parentToolUseId: "automation:run-1",
      },
    };
    expect(bindings).toEqual({
      TOOLS: tools,
      AI: ai,
      CAMELAI: camelai,
      SECURE_FETCH: secureFetch,
      SCREENSHOT: screenshot,
      BROWSER: appBrowser,
    });
    expect(exports.CodeModeToolsBinding).toHaveBeenCalledWith(props);
    expect(exports.AIVirtualBinding).toHaveBeenCalledWith(props);
    expect(exports.CamelAiService).toHaveBeenCalledWith(props);
    expect(exports.SecureFetchBinding).toHaveBeenCalledWith({
      props: { orgId: "org1", workspaceId: "workspace1" },
    });
    expect(exports.AppScreenshotBinding).toHaveBeenCalledWith({
      props: { orgId: "org1", workspaceId: "workspace1" },
    });
    expect(exports.AppBrowserBinding).toHaveBeenCalledWith({
      props: { orgId: "org1", workspaceId: "workspace1" },
    });
  });

  it("wraps workflow source with a local connection method facade", () => {
    const source = `
import { WorkflowEntrypoint } from "cloudflare:workers";

export class AutomationWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const admin = await this.env.CONNECTIONS.find("admin");
    return await this.env.CONNECTIONS[admin.alias].getDashboardSummary({
      date: "2026-05-29",
      exclude_spam: true,
    });
  }
}
`;

    const wrapped = prepareDeterministicAutomationRuntimeSource(source);

    expect(wrapped).toContain("function __camelAiCreateToolsFacade(binding)");
    expect(wrapped).toContain("function __camelAiInstallWorkflowSecureFetch(instance)");
    expect(wrapped).toContain("function __camelAiWrapWorkflowStepForSecureFetch(step, secureFetch)");
    expect(wrapped).toContain("function __camelAiCreateConnectionsFacade(binding, tools)");
    expect(wrapped).toContain(
      "class __CamelAiUserAutomationWorkflow extends WorkflowEntrypoint",
    );
    expect(wrapped).toContain(
      "export class AutomationWorkflow extends __CamelAiUserAutomationWorkflow",
    );
    expect(wrapped).toContain("method: methodName");
    expect(wrapped).toContain("connection: connectionName");
    expect(wrapped).toContain("__camelAiWrapWorkflowStepForSecureFetch(step, this.env?.SECURE_FETCH)");
    expect(wrapped).toContain("return binding.invoke(request)");
    expect(wrapped).not.toContain("invoke.call(binding");
    expect(wrapped).toContain("getDashboardSummary");
  });

  it("installs the connection facade inside a dynamic workflow worker", async () => {
    const source = `
import { WorkflowEntrypoint } from "cloudflare:workers";

export class AutomationWorkflow extends WorkflowEntrypoint {
  async run() {
    try {
      await this.env.CONNECTIONS.remoteMcpAdmin.getDashboardSummary({
        date: "2026-05-29",
        exclude_spam: true,
      });
      return { called: true };
    } catch (error) {
      return { called: true, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
`;
    const loader = env.CODE_MODE_LOADER as WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    };
    expect(loader?.load, "CODE_MODE_LOADER binding is required").toBeTypeOf("function");
    const worker = loader.load!({
      compatibilityDate: WORKFLOW_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: {
        "index.js": { js: prepareDeterministicAutomationRuntimeSource(source) },
      },
      env: { CONNECTIONS: {} },
    });
    const runner = worker.getEntrypoint("AutomationWorkflow") as unknown as {
      run(): Promise<unknown>;
    };

    await expect(runner.run()).resolves.toEqual({
      called: true,
      error: "CONNECTIONS method invocation is not configured",
    });
  });

  it("installs the tool facade inside a dynamic workflow worker", async () => {
    const source = `
import { WorkflowEntrypoint } from "cloudflare:workers";

export class AutomationWorkflow extends WorkflowEntrypoint {
  async run() {
    if (!this.env.TOOLS) throw new Error("this.env.TOOLS is missing in workflow runtime");
    if (typeof this.env.TOOLS.send_telegram_message !== "function") {
      throw new Error(\`this.env.TOOLS.send_telegram_message is \${typeof this.env.TOOLS.send_telegram_message}\`);
    }
    return { toolType: typeof this.env.TOOLS.send_telegram_message };
  }
}
`;
    const loader = env.CODE_MODE_LOADER as WorkerLoader & {
      load?: (code: WorkerLoaderWorkerCode) => WorkerStub;
    };
    expect(loader?.load, "CODE_MODE_LOADER binding is required").toBeTypeOf("function");
    const worker = loader.load!({
      compatibilityDate: WORKFLOW_COMPATIBILITY_DATE,
      mainModule: "index.js",
      modules: {
        "index.js": { js: prepareDeterministicAutomationRuntimeSource(source) },
      },
      env: { TOOLS: {} },
    });
    const runner = worker.getEntrypoint("AutomationWorkflow") as unknown as {
      run(): Promise<unknown>;
    };

    await expect(runner.run()).resolves.toEqual({ toolType: "function" });
  });

  it("routes workflow tool facade methods through callTool", async () => {
    const calls: unknown[] = [];
    assertGeneratedWorkflowToolsFacade();
    const tools = createWorkflowToolsFacade({
      callTool: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { ok: true, name, args };
      },
      listTools: async () => [],
    } as any) as any;

    await expect(tools.send_telegram_message({
      integration_id: "telegram-1",
      text: "Workflow Telegram diagnostic",
    })).resolves.toEqual({
      ok: true,
      name: "send_telegram_message",
      args: {
        integration_id: "telegram-1",
        text: "Workflow Telegram diagnostic",
      },
    });
    expect(calls).toEqual([
      {
        name: "send_telegram_message",
        args: {
          integration_id: "telegram-1",
          text: "Workflow Telegram diagnostic",
        },
      },
    ]);
  });

  it("falls back to serializable context without ctx.exports", () => {
    const bindings = createDeterministicAutomationRuntimeBindings({
      ctx: {},
      orgId: "org1",
      workspaceId: "workspace1",
      userId: "user1",
    });

    expect(bindings).toEqual({
      AUTOMATION_CONTEXT: {
        orgId: "org1",
        workspaceId: "workspace1",
        userId: "user1",
      },
    });
  });

  describe("recordWorkflowRunStatus (durable terminal status)", () => {
    function fakeStep() {
      // Mimic WorkflowStep.do(name, config, callback): run the callback so a
      // throw surfaces (the engine would retry; here we just propagate).
      return {
        do: vi.fn(
          async (_name: string, _config: unknown, callback: () => Promise<unknown>) =>
            callback(),
        ),
      };
    }

    function fakeTarget(recordResult: boolean | Error) {
      const recordDeterministicAutomationRunResult = vi.fn(async () => {
        if (recordResult instanceof Error) throw recordResult;
        return recordResult;
      });
      return {
        target: {
          cronStub: { recordDeterministicAutomationRunResult } as never,
          workspaceId: "workspace1",
          automationId: "automation1",
          instanceId: "instance1",
        },
        recordDeterministicAutomationRunResult,
      };
    }

    it("records the terminal status inside a durable step.do", async () => {
      const step = fakeStep();
      const { target, recordDeterministicAutomationRunResult } = fakeTarget(true);

      await recordWorkflowRunStatus(step as never, target, "success");

      expect(step.do).toHaveBeenCalledWith(
        "camelai:record-run-status:success",
        expect.objectContaining({ retries: expect.objectContaining({ limit: 6 }) }),
        expect.any(Function),
      );
      expect(recordDeterministicAutomationRunResult).toHaveBeenCalledWith({
        workspaceId: "workspace1",
        automationId: "automation1",
        instanceId: "instance1",
        status: "success",
        error: null,
      });
    });

    it("passes the error message through on the error path", async () => {
      const step = fakeStep();
      const { target, recordDeterministicAutomationRunResult } = fakeTarget(true);

      await recordWorkflowRunStatus(
        step as never,
        target,
        "error",
        new Error("provider exploded"),
      );

      expect(recordDeterministicAutomationRunResult).toHaveBeenCalledWith(
        expect.objectContaining({ status: "error", error: "provider exploded" }),
      );
    });

    it("does not throw when the run row is missing (recorded === false)", async () => {
      const step = fakeStep();
      const { target } = fakeTarget(false);

      await expect(
        recordWorkflowRunStatus(step as never, target, "success"),
      ).resolves.toBeUndefined();
    });

    it("swallows a step.do failure (retries exhausted) so it never escapes run()", async () => {
      const step = {
        do: vi.fn(async () => {
          throw new Error("step retries exhausted");
        }),
      };
      const { target } = fakeTarget(true);

      await expect(
        recordWorkflowRunStatus(step as never, target, "error", new Error("x")),
      ).resolves.toBeUndefined();
    });

    it("is a no-op without a status target", async () => {
      const step = fakeStep();

      await recordWorkflowRunStatus(step as never, null, "success");

      expect(step.do).not.toHaveBeenCalled();
    });
  });
});
