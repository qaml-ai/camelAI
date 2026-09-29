import { beforeEach, describe, expect, it, vi } from "vitest";

const requireRuntimeThreadMock = vi.fn();
const threadScratchVolumeMock = vi.fn();
const scratchFileLinkMock = vi.fn();
vi.mock("@/lib/runtime-threads.server", () => ({
  requestWorkspaceId: () => null,
  requireRuntimeThread: requireRuntimeThreadMock,
}));
vi.mock("../workers/main/src/agent-runtime/thread-runtime", () => ({
  threadScratchVolume: threadScratchVolumeMock,
  scratchFileLink: scratchFileLinkMock,
}));

const { action } = await import("@/routes/api/threads.$id.files.save");

const callToolEnvelope = vi.fn();
const CodeModeToolsBinding = vi.fn(() => ({ callToolEnvelope }));

function save(path: unknown, withTools = true) {
  return action({
    request: new Request("https://camelai.test/api/threads/t1/files/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    }),
    context: { cloudflare: { env: {}, ctx: withTools ? { exports: { CodeModeToolsBinding } } : {} } },
    params: { id: "t1" },
  } as never) as Promise<Response>;
}

beforeEach(() => {
  vi.clearAllMocks();
  requireRuntimeThreadMock.mockResolvedValue({
    env: {},
    context: { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1" },
    row: { agentId: "agt_1" },
  });
  threadScratchVolumeMock.mockResolvedValue("vol_1");
  scratchFileLinkMock.mockResolvedValue("https://agents.test/v1/links/tok/chart.png");
  callToolEnvelope.mockResolvedValue({ ok: true, data: {} });
});

describe("POST /api/threads/:id/files/save", () => {
  it("copies the scratch file into outputs/ with import_file, as the thread's user", async () => {
    const response = await save("/workspace/out/chart.png");
    expect(response.status).toBe(200);
    expect(scratchFileLinkMock).toHaveBeenCalledWith({}, "vol_1", "/out/chart.png");
    expect(CodeModeToolsBinding).toHaveBeenCalledWith({
      props: { orgId: "org1", workspaceId: "ws1", threadId: "t1", userId: "u1" },
    });
    expect(callToolEnvelope).toHaveBeenCalledWith("import_file", {
      source: "https://agents.test/v1/links/tok/chart.png",
      destination: { location: "r2", path: "outputs/chart.png" },
    });
    expect(await response.json()).toEqual({
      saved: { location: "r2", path: "outputs/chart.png" },
      previewTarget: { kind: "file", source: "output", workspaceId: "ws1", path: "chart.png", filename: "chart.png" },
    });
  });

  it("refuses paths outside the scratch space, and reports a failed copy", async () => {
    expect((await save("/etc/passwd")).status).toBe(400);
    expect((await save(42)).status).toBe(400);
    callToolEnvelope.mockResolvedValue({ ok: false, error: { message: "The file is too large to import" } });
    const failed = await save("/workspace/big.bin");
    expect(failed.status).toBe(502);
    expect(await failed.json()).toEqual({ error: "The file is too large to import" });
  });
});
