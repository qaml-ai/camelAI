import { describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  CODE_MODE_MOVE_MAX_FILES,
  CODE_MODE_MOVE_MAX_FILE_BYTES,
  CODE_MODE_MOVE_MAX_TOTAL_BYTES,
  CodeModeToolsBinding,
} from "../src/code-mode-tools";

type PrivateCodeModeMethods = {
  deleteProject(
    this: unknown,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  moveFile(
    this: unknown,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  readR2File(
    this: unknown,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  writeR2File(
    this: unknown,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  readMoveSourceFile(
    this: unknown,
    source: Record<string, unknown>,
    file: Record<string, unknown>,
    preferStream: boolean,
  ): Promise<unknown>;
  writeMoveDestinationFile(
    this: unknown,
    destination: Record<string, unknown>,
    path: string,
    payload: Record<string, unknown>,
  ): Promise<{ path: string; bytes: number }>;
};

const methods =
  CodeModeToolsBinding.prototype as unknown as PrivateCodeModeMethods;

function r2Metadata(key: string, size: number) {
  return {
    key,
    size,
    httpMetadata: { contentType: "application/octet-stream" },
  };
}

function createBinding(
  bucket: Record<string, unknown>,
): Record<string, unknown> {
  const binding = Object.create(CodeModeToolsBinding.prototype) as Record<
    string,
    unknown
  >;
  Object.assign(binding, {
    ctx: {
      props: {
        orgId: "org-memory",
        workspaceId: "workspace-memory",
        threadId: "thread-memory",
      },
    },
    env: { R2_BUCKET: bucket },
  });
  return binding;
}

const moveArgs = {
  source: { location: "r2", path: "uploads/source" },
  destination: { location: "r2", path: "tmp/destination" },
};

describe("code-mode tool source memory bounds", () => {
  it("derives every move admission ceiling from the central runtime bounds", () => {
    expect(CODE_MODE_MOVE_MAX_FILES).toBe(
      CHAT_RUNTIME_BOUNDS.toolTransferFilesPerCall,
    );
    expect(CODE_MODE_MOVE_MAX_FILE_BYTES).toBe(
      CHAT_RUNTIME_BOUNDS.toolTransferFileBytes,
    );
    expect(CODE_MODE_MOVE_MAX_TOTAL_BYTES).toBe(
      CHAT_RUNTIME_BOUNDS.toolTransferBytesPerCall,
    );
  });

  it("rejects an oversized move file before fetching or copying it", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const bucket = {
      head: vi.fn(async (key: string) =>
        r2Metadata(key, CODE_MODE_MOVE_MAX_FILE_BYTES + 1),
      ),
      get,
      put,
    };
    const binding = createBinding(bucket);

    await expect(methods.moveFile.call(binding, moveArgs)).rejects.toThrow(
      `max ${CODE_MODE_MOVE_MAX_FILE_BYTES} bytes`,
    );
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("rechecks R2 size after get and cancels a changed source before reading", async () => {
    const cancel = vi.fn();
    const put = vi.fn();
    const binding = createBinding({
      head: vi.fn(async (key: string) => r2Metadata(key, 1)),
      get: vi.fn(async (key: string) => ({
        ...r2Metadata(key, CODE_MODE_MOVE_MAX_FILE_BYTES + 1),
        body: new ReadableStream<Uint8Array>({ cancel }),
      })),
      put,
    });

    await expect(methods.moveFile.call(binding, moveArgs)).rejects.toThrow(
      "source size changed",
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(put).not.toHaveBeenCalled();
  });

  it("pipes an R2 move into R2 without materializing the file", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.close();
      },
    });
    const arrayBuffer = vi.fn();
    const put = vi.fn(
      async (_key: string, body: ReadableStream<Uint8Array>) => {
        const bytes = new Uint8Array(await new Response(body).arrayBuffer());
        expect([...bytes]).toEqual([1, 2, 3]);
      },
    );
    const binding = createBinding({
      head: vi.fn(async (key: string) => r2Metadata(key, 3)),
      get: vi.fn(async (key: string) => ({
        ...r2Metadata(key, 3),
        body: stream,
        arrayBuffer,
      })),
      put,
    });

    await expect(methods.moveFile.call(binding, moveArgs)).resolves.toEqual(
      expect.objectContaining({
        details: expect.objectContaining({ bytes: 3, count: 1 }),
      }),
    );
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0]?.[1]).toBeInstanceOf(ReadableStream);
    expect(put.mock.calls[0]?.[1]).not.toBe(stream);
  });

  it("aborts a streaming move when the body exceeds its listed size", async () => {
    const put = vi.fn(
      async (_key: string, body: ReadableStream<Uint8Array>) => {
        await new Response(body).arrayBuffer();
      },
    );
    const binding = createBinding({
      head: vi.fn(async (key: string) => r2Metadata(key, 3)),
      get: vi.fn(async (key: string) => ({
        ...r2Metadata(key, 3),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            controller.close();
          },
        }),
      })),
      put,
    });

    await expect(methods.moveFile.call(binding, moveArgs)).rejects.toThrow(
      "exceeded its listed byte size",
    );
    expect(put).toHaveBeenCalledOnce();
  });

  it("pipes a move into the project store's streaming adoption API", async () => {
    const stream = new ReadableStream<Uint8Array>();
    const adoptR2File = vi.fn(async () => ({ success: true, size: 7 }));
    const binding = createBinding({});
    Object.defineProperty(binding, "projectFileStore", {
      value: vi.fn(async () => ({ adoptR2File })),
    });

    await expect(
      methods.writeMoveDestinationFile.call(
        binding,
        { location: "project", project: "report", path: "/" },
        "/artifact.bin",
        {
          kind: "stream",
          body: stream,
          bytes: 7,
          contentType: "application/octet-stream",
        },
      ),
    ).resolves.toEqual({ path: "/artifact.bin", bytes: 7 });
    expect(adoptR2File).toHaveBeenCalledWith(
      "/artifact.bin",
      stream,
      7,
      "application/octet-stream",
    );
  });

  it("rejects a whole-buffer move above the source-read limit before fetching", async () => {
    const get = vi.fn();
    const binding = createBinding({ get });

    await expect(
      methods.readMoveSourceFile.call(
        binding,
        { location: "r2", path: "uploads/source" },
        {
          path: "uploads/source",
          relativePath: "source",
          size: CHAT_RUNTIME_BOUNDS.toolSourceReadBytes + 1,
        },
        false,
      ),
    ).rejects.toThrow(
      `Move source exceeds the ${CHAT_RUNTIME_BOUNDS.toolSourceReadBytes} byte whole-buffer limit`,
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("stops an R2 directory listing at the move file-count limit", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const list = vi.fn(async (options: { prefix: string; limit: number }) => ({
      objects: Array.from({ length: options.limit }, (_, index) =>
        r2Metadata(`${options.prefix}file-${index}`, 1),
      ),
      truncated: false,
      cursor: undefined,
    }));
    const binding = createBinding({
      head: vi.fn(async () => null),
      list,
      get,
      put,
    });

    await expect(methods.moveFile.call(binding, moveArgs)).rejects.toThrow(
      `more than ${CODE_MODE_MOVE_MAX_FILES} files`,
    );
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: CODE_MODE_MOVE_MAX_FILES + 1,
      }),
    );
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects aggregate move bytes during listing before any object fetch", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const fileCount =
      Math.floor(
        CODE_MODE_MOVE_MAX_TOTAL_BYTES / CODE_MODE_MOVE_MAX_FILE_BYTES,
      ) + 1;
    const list = vi.fn(async (options: { prefix: string }) => ({
      objects: Array.from({ length: fileCount }, (_, index) =>
        r2Metadata(
          `${options.prefix}file-${index}`,
          CODE_MODE_MOVE_MAX_FILE_BYTES,
        ),
      ),
      truncated: false,
      cursor: undefined,
    }));
    const binding = createBinding({
      head: vi.fn(async () => null),
      list,
      get,
      put,
    });

    await expect(methods.moveFile.call(binding, moveArgs)).rejects.toThrow(
      `exceeds ${CODE_MODE_MOVE_MAX_TOTAL_BYTES} aggregate bytes`,
    );
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("checks a bodyless R2 object's current size before materializing it", async () => {
    const arrayBuffer = vi.fn(async () => new ArrayBuffer(0));
    const text = vi.fn(async () => "");
    const binding = createBinding({
      head: vi.fn(async (key: string) => r2Metadata(key, 1)),
      get: vi.fn(async (key: string) => ({
        ...r2Metadata(key, CHAT_RUNTIME_BOUNDS.toolSourceReadBytes + 1),
        body: undefined,
        arrayBuffer,
        text,
      })),
    });

    await expect(
      methods.readR2File.call(binding, {
        path: "outputs/large.txt",
      }),
    ).rejects.toThrow("R2 object is too large for text read");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });

  it("rejects an oversized UTF-8 write before handing content to R2", async () => {
    const put = vi.fn();
    const binding = createBinding({ put });
    const oversized = "🐪".repeat(
      Math.floor(CHAT_RUNTIME_BOUNDS.toolSourceReadBytes / 4) + 1,
    );

    await expect(
      methods.writeR2File.call(binding, {
        path: "outputs/oversized.txt",
        content: oversized,
      }),
    ).rejects.toThrow(
      `R2 write content exceeds ${CHAT_RUNTIME_BOUNDS.toolSourceReadBytes} bytes`,
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("keeps project files and metadata when bounded root deletion overflows", async () => {
    const project = {
      id: "project-too-large",
      name: "too-large",
      description: "",
      defaultVmId: "default",
      backend: "do-r2" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let registeredProjects = [project];
    const remainingFiles = new Set(["/first.txt", "/last.txt"]);
    const removeProjects = vi.fn(async (projectIds: string[]) => {
      const deleted = registeredProjects.filter((entry) =>
        projectIds.includes(entry.id),
      );
      registeredProjects = registeredProjects.filter(
        (entry) => !projectIds.includes(entry.id),
      );
      return { deleted };
    });
    const projectDeleteFile = vi.fn(async () => ({
      success: false,
      error: "Recursive delete exceeds its 4096-entry limit",
      code: "E2BIG",
    }));
    const projectDeleteSourceSnapshots = vi.fn(async () => ({
      snapshotsDeleted: 0,
      blobsDeleted: 0,
    }));
    const projectDrainR2Cleanup = vi.fn(async () => ({
      success: true,
      pending: 0,
    }));
    const registryStub = {
      listProjectsForMigrationReset: vi.fn(async () => registeredProjects),
      removeProjects,
    };
    const projectStub = {
      projectDeleteFile,
      projectDeleteSourceSnapshots,
      projectDrainR2Cleanup,
    };
    const workspaceFsNamespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn((id: string) =>
        id === "workspace-memory" ? registryStub : projectStub,
      ),
    };
    const binding = createBinding({});
    Object.assign(binding, {
      env: {
        WORKSPACE_FS: workspaceFsNamespace,
        ORG: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({
            listWorkerScriptsByWorkspace: vi.fn(async () => []),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({
            askUserQuestion: vi.fn(async () => ({ answer: "Delete" })),
          })),
        },
      },
    });

    await expect(
      methods.deleteProject.call(binding, { project: project.name }),
    ).rejects.toThrow("Recursive delete exceeds its 4096-entry limit");

    expect(projectDeleteFile).toHaveBeenCalledOnce();
    expect(projectDeleteFile).toHaveBeenCalledWith("/", {
      recursive: true,
      force: true,
    });
    expect(projectDeleteSourceSnapshots).not.toHaveBeenCalled();
    expect(projectDrainR2Cleanup).not.toHaveBeenCalled();
    expect(removeProjects).not.toHaveBeenCalled();
    expect(remainingFiles).toEqual(new Set(["/first.txt", "/last.txt"]));
    expect(registeredProjects).toEqual([project]);
  });

  it("retains project metadata until queued R2 cleanup drains on retry", async () => {
    const project = {
      id: "project-gc-retry",
      name: "gc-retry",
      description: "",
      defaultVmId: "default",
      backend: "do-r2" as const,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    let registeredProjects = [project];
    let fileCount = 1_001;
    const queuedR2Keys = new Set(["restore-cleanup-key"]);
    const projectDeleteFile = vi.fn(async () => {
      fileCount = 0;
      queuedR2Keys.add("deleted-project-file-key");
      return { success: true };
    });
    const projectDeleteSourceSnapshots = vi.fn(async () => {
      queuedR2Keys.add("deleted-snapshot-key");
      return { snapshotsDeleted: 1, blobsDeleted: 1 };
    });
    const projectDrainR2Cleanup = vi
      .fn()
      .mockResolvedValueOnce({ success: false, pending: 3 })
      .mockImplementationOnce(async () => {
        queuedR2Keys.clear();
        return { success: true, pending: 0 };
      });
    const removeProjects = vi.fn(async (projectIds: string[]) => {
      expect(queuedR2Keys.size).toBe(0);
      const deleted = registeredProjects.filter((entry) =>
        projectIds.includes(entry.id),
      );
      registeredProjects = registeredProjects.filter(
        (entry) => !projectIds.includes(entry.id),
      );
      return { deleted };
    });
    const registryStub = {
      listProjectsForMigrationReset: vi.fn(async () => registeredProjects),
      removeProjects,
    };
    const projectStub = {
      projectDeleteFile,
      projectDeleteSourceSnapshots,
      projectDrainR2Cleanup,
    };
    const workspaceFsNamespace = {
      idFromName: vi.fn((name: string) => name),
      get: vi.fn((id: string) =>
        id === "workspace-memory" ? registryStub : projectStub,
      ),
    };
    const binding = createBinding({});
    Object.assign(binding, {
      env: {
        WORKSPACE_FS: workspaceFsNamespace,
        ORG: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({
            listWorkerScriptsByWorkspace: vi.fn(async () => []),
          })),
        },
        CHAT_THREAD: {
          idFromName: vi.fn((name: string) => name),
          get: vi.fn(() => ({
            askUserQuestion: vi.fn(async () => ({ answer: "Delete" })),
          })),
        },
      },
    });

    await expect(
      methods.deleteProject.call(binding, { project: project.name }),
    ).rejects.toThrow("Project R2 cleanup is still pending");
    expect(fileCount).toBe(0);
    expect(queuedR2Keys.size).toBe(3);
    expect(removeProjects).not.toHaveBeenCalled();
    expect(registeredProjects).toEqual([project]);

    await expect(
      methods.deleteProject.call(binding, { project: project.name }),
    ).resolves.toEqual(expect.objectContaining({ success: true }));
    expect(projectDeleteFile).toHaveBeenCalledTimes(2);
    expect(projectDeleteFile).toHaveBeenNthCalledWith(1, "/", {
      recursive: true,
      force: true,
    });
    expect(projectDeleteFile).toHaveBeenNthCalledWith(2, "/", {
      recursive: true,
      force: true,
    });
    expect(projectDrainR2Cleanup).toHaveBeenCalledTimes(2);
    expect(removeProjects).toHaveBeenCalledOnce();
    expect(queuedR2Keys.size).toBe(0);
    expect(registeredProjects).toEqual([]);
  });
});
