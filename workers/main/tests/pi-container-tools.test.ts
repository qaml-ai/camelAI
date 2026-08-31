import { describe, expect, it, vi } from "vitest";
import { PiContainerTools } from "../src/pi-container-tools";
import type { WorkspaceFilesystemLike } from "../src/workspace-filesystem-do";

describe("PiContainerTools", () => {
  it("uses the store-owned atomic edit operation when available", async () => {
    const editTextFile = vi.fn(async () => ({
      success: true,
      replacementCount: 1,
      diff: "-1 old\n+1 new",
      patch: "@@ patch",
      firstChangedLine: 1,
      usedFuzzyMatch: true,
    }));
    const workspace = { editTextFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    const output = await tools.callTool("edit", {
      path: "/example.txt",
      edits: JSON.stringify([{ oldText: "old", newText: "new" }]),
    });

    expect(editTextFile).toHaveBeenCalledWith("/example.txt", [{ oldText: "old", newText: "new" }]);
    expect(output.details).toMatchObject({ patch: "@@ patch", usedFuzzyMatch: true });
  });

  it("writes files through the workspace filesystem", async () => {
    const writeFile = vi.fn(async () => ({ success: true }));
    const workspace = { writeFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    const result = await tools.callTool("write", {
      path: "/tmp/example.txt",
      content: "hello from container",
    });

    expect(result.text).toBe("Successfully wrote 20 bytes to /tmp/example.txt");
    expect(writeFile).toHaveBeenCalledWith("/tmp/example.txt", "hello from container");
  });

  it("normalizes .ipynb writes and reports the fixes", async () => {
    const writeFile = vi.fn(async () => ({ success: true }));
    const workspace = { writeFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    const result = await tools.callTool("write", {
      path: "/analysis.ipynb",
      content: JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
        cells: [{ cell_type: "code", id: "a", metadata: {}, source: ["import os", "print(1)"] }],
      }),
    });

    expect(result.text).toContain("[Notebook normalized for nbformat:");
    const written = writeFile.mock.calls[0] as unknown as [string, string];
    const parsed = JSON.parse(written[1]) as { cells: Array<{ source: string[]; outputs: unknown[] }> };
    expect(parsed.cells[0].source).toEqual(["import os\n", "print(1)"]);
    expect(parsed.cells[0].outputs).toEqual([]);
  });

  it("rejects unparseable .ipynb writes before persisting", async () => {
    const writeFile = vi.fn(async () => ({ success: true }));
    const workspace = { writeFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    // await in try/catch (not expect().rejects): the write throws before its
    // first await, and the workers pool reports the sync-rejected promise as
    // unhandled before .rejects can attach its handler.
    let error: unknown;
    try {
      await tools.callTool("write", { path: "/analysis.ipynb", content: "{ broken" });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/Invalid \.ipynb notebook/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("lets an edit proceed on a notebook that was already invalid before the edit", async () => {
    // Invalid baseline: cell 1 has a non-string source element. The edit fixes
    // cell 0 only — it must go through (with a notice) so repair can be
    // incremental, instead of failing because cell 1 is still broken.
    const invalidNotebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: "code", id: "a", metadata: {}, source: "print('typo)", outputs: [], execution_count: null },
        { cell_type: "code", id: "b", metadata: {}, source: [42], outputs: [], execution_count: null },
      ],
    });
    const readFile = vi.fn(async () => ({ success: true, content: invalidNotebook, isBinary: false }));
    const writeFile = vi.fn(async () => ({ success: true }));
    const workspace = { readFile, writeFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    const result = await tools.callTool("edit", {
      path: "/analysis.ipynb",
      oldText: "print('typo)",
      newText: "print('fixed')",
    });

    expect(result.text).toContain("Successfully replaced 1 block(s)");
    expect(result.text).toContain("still structurally invalid after this edit");
    const written = writeFile.mock.calls[0] as unknown as [string, string];
    expect(written[1]).toContain("print('fixed')");
  });

  it("rejects an edit that breaks a previously-valid notebook", async () => {
    const validNotebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: "code", id: "a", metadata: {}, source: "print(1)", outputs: [], execution_count: null },
      ],
    });
    const readFile = vi.fn(async () => ({ success: true, content: validNotebook, isBinary: false }));
    const writeFile = vi.fn(async () => ({ success: true }));
    const workspace = { readFile, writeFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    let error: unknown;
    try {
      // Deletes the closing brace of the cells array entry — post-edit JSON no
      // longer parses, and the baseline was valid, so the edit must be rejected.
      await tools.callTool("edit", { path: "/analysis.ipynb", oldText: '"cells":[', newText: '"cells":' });
    } catch (caught) {
      error = caught;
    }
    expect(String(error)).toMatch(/Invalid \.ipynb notebook/);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("reads files through the workspace filesystem", async () => {
    const readFile = vi.fn(async () => ({
      success: true,
      content: "hello",
      size: 5,
      isBinary: false,
      mimeType: "text/plain",
    }));
    const workspace = { readFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace);

    const result = await tools.callTool("read", { path: "notes.txt" });

    expect(result.text).toBe("hello");
    expect(readFile).toHaveBeenCalledWith("/workspace/notes.txt");
  });

  it("sniffs workspace binary image bytes even when mime type and extension are missing", async () => {
    const pngBytes = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d,
      0x49, 0x48, 0x44, 0x52,
      0x00, 0x00, 0x00, 0x01,
      0x00, 0x00, 0x00, 0x01,
    ]);
    const readFile = vi.fn(async () => ({
      success: true,
      content: Buffer.from(pngBytes).toString("base64"),
      size: pngBytes.byteLength,
      isBinary: true,
    }));
    const output = vi.fn(async () => ({
      contentType: () => "image/png",
      image: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("optimized-base64"));
          controller.close();
        },
      }),
    }));
    const transform = vi.fn(() => ({ output }));
    const images = { input: vi.fn(() => ({ transform, output })) };
    const workspace = { readFile } as unknown as WorkspaceFilesystemLike;
    const tools = new PiContainerTools(workspace, { images: images as never });

    const result = await tools.callTool("read", { path: "/workspace/blob" });

    expect(result.text).toContain("Read image file [image/png]");
    expect(result.content).toEqual([
      { type: "text", text: result.text },
      { type: "image", data: "optimized-base64", mimeType: "image/png" },
    ]);
    expect(result.details).toMatchObject({
      image: true,
      inlineImage: true,
      originalMimeType: "image/png",
      maxInlineDimension: 2000,
    });
  });
});
