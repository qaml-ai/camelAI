import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/project-build-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/project-build-service")>()),
  runProjectBuild: vi.fn(async () => ({
    success: true, workdir: "/build", durationMs: 10, fileCount: 1, sourceBytes: 20,
  })),
}));
vi.mock("../src/project-worker-bundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/project-worker-bundle")>()),
  collectWorkerBundleFromSandbox: vi.fn(async () => ({
    metadata: { main_module: "index.js" }, modules: [], assets: [],
  })),
}));
vi.mock("../src/notebook-worker-bundle", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/notebook-worker-bundle")>()),
  resolveNotebookDeployPath: vi.fn(async () => null),
}));
vi.mock("../src/direct-dispatch-deploy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/direct-dispatch-deploy")>()),
  deployWorkerModulesDirect: vi.fn(async () => ({
    success: true, scriptName: "demo", dispatchScriptName: "org-demo", status: 200,
  })),
}));

import { CodeModeToolsBinding, type CodeModeToolsProps } from "../src/code-mode-tools";
import { deployWorkerModulesDirect } from "../src/direct-dispatch-deploy";
import { ProjectFilesystemClient } from "../src/workspace-filesystem-do";

function binding(props: Partial<CodeModeToolsProps> = {}, overrides: Record<string, unknown> = {}) {
  const instance = Object.create(CodeModeToolsBinding.prototype) as CodeModeToolsBinding;
  for (const [key, value] of Object.entries({
    ctx: { props: { orgId: "org1", workspaceId: "ws1", ...props } }, env: {}, ...overrides,
  })) {
    Object.defineProperty(instance, key, { value, configurable: true, writable: true });
  }
  return instance;
}

afterEach(() => vi.restoreAllMocks());

describe("threadless code-mode tools", () => {
  it("returns a successful deploy without looking up or recording a preview", async () => {
    const snapshot = vi.spyOn(ProjectFilesystemClient.prototype, "createSourceSnapshot")
      .mockResolvedValue({ id: "snapshot-1", fileCount: 1, totalBytes: 20 } as never);
    const getWorkerScript = vi.fn();
    const upsertThreadPreviewTarget = vi.fn();
    const instance = binding({}, {
      orgStub: { getWorkerScript, upsertThreadPreviewTarget },
      resolveDoBackedProjectForAction: vi.fn(async () => ({ id: "project1", name: "demo" })),
      projectBuildReadinessGate: () => ({
        ensureReady: vi.fn(), annotate: (value: unknown) => value,
      }),
      projectBuildSandbox: () => ({ noteBuildSessionActivity: vi.fn() }),
      getOrgSlug: vi.fn(async () => "org"),
      deployHostname: () => "camelai.app",
      appUrlForScriptName: vi.fn(async () => "https://demo.camelai.app"),
      localDeployReachabilityWarnings: () => [],
    });

    await expect(instance.callTool("deploy_project", { project: "demo" })).resolves.toMatchObject({
      success: true, project: "demo", url: "https://demo.camelai.app",
      preview: { skipped: "no_thread" }, message: "Deployed at https://demo.camelai.app",
    });
    expect(snapshot).toHaveBeenCalledOnce();
    expect(deployWorkerModulesDirect).toHaveBeenCalled();
    expect(getWorkerScript).not.toHaveBeenCalled();
    expect(upsertThreadPreviewTarget).not.toHaveBeenCalled();
  });

  it("returns a successful notebook run without reading or recording a preview", async () => {
    const runNotebook = vi.fn(async () => ({ ok: true, executed: true, stdout: "done", exitCode: 0 }));
    const projectFileStore = vi.fn();
    const upsertThreadPreviewTarget = vi.fn();
    const instance = binding({}, {
      orgStub: { upsertThreadPreviewTarget }, projectFileStore,
      resolveDoBackedProjectForAction: vi.fn(async () => ({ id: "project1", name: "demo" })),
      projectIoOverheadMs: vi.fn(async () => 0),
      analysisService: () => ({ runNotebook }),
    });

    await expect(instance.callTool("run_notebook", { project: "demo", path: "report.ipynb" }))
      .resolves.toMatchObject({
        ok: true, executed: true, stdout: "done", project: "demo",
        preview: { skipped: "no_thread" }, message: "Executed report.ipynb",
      });
    expect(runNotebook).toHaveBeenCalledWith({ projectId: "project1", path: "report.ipynb", timeoutMs: undefined });
    expect(projectFileStore).not.toHaveBeenCalled();
    expect(upsertThreadPreviewTarget).not.toHaveBeenCalled();
  });

  it("still records previews for callers with a thread", async () => {
    const upsertThreadPreviewTarget = vi.fn();
    const instance = binding({ threadId: "thread1" }, {
      orgStub: {
        getWorkerScript: vi.fn(async () => ({ workspace_id: "ws1", is_public: false })),
        upsertThreadPreviewTarget,
      },
      getAppUrl: vi.fn(async () => "https://demo.camelai.app"),
    });
    await expect(instance.callTool("set_preview", { app_name: "demo" })).resolves.toMatchObject({ success: true });
    expect(upsertThreadPreviewTarget).toHaveBeenCalledWith("thread1", { kind: "app", scriptName: "demo", isPublic: false });
  });

  it.each([
    [{ externalSessionId: "run/123:attempt" }, "run_123_attempt"],
    [{ threadId: "thread-1", externalSessionId: "run-1" }, "thread-1"],
  ])("scopes tmp writes and reads with %j", async (props, sessionId) => {
    let stored = "";
    const put = vi.fn(async (_key: string, content: string) => { stored = content; return null; });
    const head = vi.fn(async () => ({ size: stored.length }));
    const get = vi.fn(async () => ({ text: async () => stored }));
    const instance = binding(props, { env: { R2_BUCKET: { put, head, get } } });
    await instance.callTool("write", { location: "r2", path: "tmp/result.txt", content: "hello" });
    const key = `org1/ws1/chat-sessions/${sessionId}/pi-tool-results/tmp/result.txt`;
    expect(put.mock.calls[0][0]).toBe(key);
    await expect(instance.callTool("read", { location: "r2", path: "tmp/result.txt" }))
      .resolves.toMatchObject({ text: expect.stringContaining("hello") });
    expect(head).toHaveBeenCalledWith(key);
    expect(get).toHaveBeenCalledWith(key);
  });

  it.each([{}, { externalSessionId: "" }, { externalSessionId: "  " }])(
    "clearly rejects tmp paths with no session (%j)", async (props) => {
      await expect(binding(props).callTool("write", { location: "r2", path: "tmp/result.txt", content: "hello" }))
        .rejects.toThrow("R2 temp paths require threadId or externalSessionId");
    },
  );

  it("records threadless successful and failed calls without breaking telemetry", async () => {
    const send = vi.fn(async (_records: unknown[]) => {});
    const writeDataPoint = vi.fn((_point: { blobs: string[] }) => {});
    const instance = binding({}, {
      env: { TOOL_CALLS_LAKE: { send }, OBSERVABILITY_EVENTS: { writeDataPoint } },
    });
    await expect(instance.callToolEnvelope("set_preview", { app_name: "demo" }))
      .resolves.toEqual({ ok: true, data: { skipped: "no_thread" } });
    await expect(instance.callToolEnvelope("write", { location: "r2", path: "tmp/result.txt" }))
      .resolves.toMatchObject({ ok: false });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls).toEqual([
      [[expect.objectContaining({ thread_id: "", tool_name: "set_preview", ok: true })]],
      [[expect.objectContaining({ thread_id: "", tool_name: "write", ok: false })]],
    ]);
    expect(writeDataPoint).toHaveBeenCalledWith(expect.objectContaining({
      blobs: expect.arrayContaining(["code_mode_project_tool_call_failed"]),
    }));
    expect((writeDataPoint.mock.calls[0][0] as { blobs: string[] }).blobs[8]).toBe("");
  });
});
