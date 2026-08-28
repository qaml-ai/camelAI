import { describe, expect, it, vi } from "vitest";

import { CHAT_RUNTIME_BOUNDS } from "../../../src/lib/chat-runtime-bounds";
import {
  CODE_MODE_MOVE_MAX_FILES,
  CODE_MODE_MOVE_MAX_FILE_BYTES,
  CODE_MODE_MOVE_MAX_TOTAL_BYTES,
  CodeModeToolsBinding,
} from "../src/code-mode-tools";

type PrivateCodeModeMethods = {
  moveFile(
    this: unknown,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  readR2File(
    this: unknown,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
};

const methods = CodeModeToolsBinding.prototype as unknown as PrivateCodeModeMethods;

function r2Metadata(key: string, size: number) {
  return {
    key,
    size,
    httpMetadata: { contentType: "application/octet-stream" },
  };
}

function createBinding(bucket: Record<string, unknown>): Record<string, unknown> {
  const binding = Object.create(CodeModeToolsBinding.prototype) as Record<string, unknown>;
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
  it("rejects an oversized move file before fetching or copying it", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const bucket = {
      head: vi.fn(async (key: string) =>
        r2Metadata(key, CODE_MODE_MOVE_MAX_FILE_BYTES + 1)),
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

  it("stops an R2 directory listing at the move file-count limit", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const list = vi.fn(async (options: { prefix: string; limit: number }) => ({
      objects: Array.from(
        { length: options.limit },
        (_, index) => r2Metadata(`${options.prefix}file-${index}`, 1),
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
    expect(list).toHaveBeenCalledWith(expect.objectContaining({
      limit: CODE_MODE_MOVE_MAX_FILES + 1,
    }));
    expect(get).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("rejects aggregate move bytes during listing before any object fetch", async () => {
    const get = vi.fn();
    const put = vi.fn();
    const fileCount = Math.floor(
      CODE_MODE_MOVE_MAX_TOTAL_BYTES / CODE_MODE_MOVE_MAX_FILE_BYTES,
    ) + 1;
    const list = vi.fn(async (options: { prefix: string }) => ({
      objects: Array.from(
        { length: fileCount },
        (_, index) =>
          r2Metadata(`${options.prefix}file-${index}`, CODE_MODE_MOVE_MAX_FILE_BYTES),
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

    await expect(methods.readR2File.call(binding, {
      path: "outputs/large.txt",
    })).rejects.toThrow("R2 object is too large for text read");
    expect(arrayBuffer).not.toHaveBeenCalled();
    expect(text).not.toHaveBeenCalled();
  });
});
