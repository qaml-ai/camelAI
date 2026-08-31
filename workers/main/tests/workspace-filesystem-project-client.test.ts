import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

import {
  __testing,
  ProjectFilesystemClient,
  WorkspaceFilesystemClient,
} from "../src/workspace-filesystem-do";

function namespaceFor(stub: Record<string, unknown>) {
  return {
    idFromName: vi.fn((name: string) => `id:${name}`),
    get: vi.fn(() => stub),
  };
}

describe("ProjectFilesystemClient", () => {
  it("uses project-scoped DO instances and project file RPC methods", async () => {
    const stub = {
      projectWriteFile: vi.fn(async () => ({ success: true })),
      projectEditTextFile: vi.fn(async () => ({ success: true, replacementCount: 1 })),
      projectReadFile: vi.fn(async () => ({ success: true, content: "hello", encoding: "utf8" })),
      projectListFiles: vi.fn(async () => ({ success: true, files: [], count: 0, path: "/" })),
      projectCreateSourceSnapshot: vi.fn(async () => ({ id: "snapshot-1", createdAt: "2026-01-01T00:00:00.000Z", fileCount: 1, totalBytes: 5, entries: [] })),
      projectRestoreSourceSnapshot: vi.fn(async () => ({ id: "snapshot-1", createdAt: "2026-01-01T00:00:00.000Z", fileCount: 1, totalBytes: 5, entries: [] })),
      projectListSourceSnapshots: vi.fn(async () => []),
      projectDeleteSourceSnapshots: vi.fn(async () => ({ snapshotsDeleted: 1, blobsDeleted: 1 })),
    };
    const workspaces = namespaceFor(stub);
    const client = new ProjectFilesystemClient(
      { WORKSPACE_FS: workspaces } as never,
      "CA_AAAAAAAA-AAAAAAAA-AAAAAAAA-AAAAAAAA-demo app",
    );

    await expect(client.writeFile("/src/index.ts", "hello")).resolves.toEqual({ success: true });
    await expect(client.editTextFile("/src/index.ts", [{ oldText: "hello", newText: "goodbye" }]))
      .resolves.toMatchObject({ success: true, replacementCount: 1 });
    await expect(client.readFile("/src/index.ts")).resolves.toMatchObject({ content: "hello" });
    await client.listFiles("/", { recursive: true });
    await expect(client.createSourceSnapshot({ message: "deploy" })).resolves.toMatchObject({ id: "snapshot-1" });
    await expect(client.restoreSourceSnapshot("snapshot-1")).resolves.toMatchObject({ id: "snapshot-1" });
    await client.listSourceSnapshots(5);
    await expect(client.deleteSourceSnapshots()).resolves.toEqual({ snapshotsDeleted: 1, blobsDeleted: 1 });

    expect(workspaces.idFromName).toHaveBeenCalledWith("ca-aaaaaaaa-aaaaaaaa-aaaaaaaa-aaaaaaaa-demo-app");
    expect(stub.projectWriteFile).toHaveBeenCalledWith("/src/index.ts", "hello");
    expect(stub.projectEditTextFile).toHaveBeenCalledWith(
      "/src/index.ts",
      [{ oldText: "hello", newText: "goodbye" }],
    );
    expect(stub.projectReadFile).toHaveBeenCalledWith("/src/index.ts");
    expect(stub.projectListFiles).toHaveBeenCalledWith("/", { recursive: true });
    expect(stub.projectCreateSourceSnapshot).toHaveBeenCalledWith({ message: "deploy" });
    expect(stub.projectRestoreSourceSnapshot).toHaveBeenCalledWith("snapshot-1");
    expect(stub.projectListSourceSnapshots).toHaveBeenCalledWith(5);
    expect(stub.projectDeleteSourceSnapshots).toHaveBeenCalled();
    expect(stub).not.toHaveProperty("writeFile.mock");
  });

  it("keeps the workspace client on workspace-scoped file RPC methods", async () => {
    const stub = {
      writeFile: vi.fn(async () => ({ success: true })),
      editTextFile: vi.fn(async () => ({ success: true, replacementCount: 1 })),
      readFile: vi.fn(async () => ({ success: true, content: "workspace", encoding: "utf8" })),
      createProject: vi.fn(async () => ({ id: "project-1", name: "demo", description: "Demo", defaultVmId: "main", backend: "do-r2" })),
    };
    const workspaces = namespaceFor(stub);
    const client = new WorkspaceFilesystemClient({ WORKSPACE_FS: workspaces } as never, "workspace-1");

    await client.writeFile("/notes.md", "workspace");
    await client.editTextFile("/notes.md", [{ oldText: "workspace", newText: "updated" }]);
    await expect(client.readFile("/notes.md")).resolves.toMatchObject({ content: "workspace" });

    expect(workspaces.idFromName).toHaveBeenCalledWith("workspace-1");
    expect(stub.writeFile).toHaveBeenCalledWith("/notes.md", "workspace");
    expect(stub.editTextFile).toHaveBeenCalledWith(
      "/notes.md",
      [{ oldText: "workspace", newText: "updated" }],
    );
    expect(stub.readFile).toHaveBeenCalledWith("/notes.md");
    expect(stub).not.toHaveProperty("projectWriteFile.mock");

    await expect(client.createProject({ name: "demo", description: "Demo" })).resolves.toMatchObject({ backend: "do-r2" });
    expect(stub.createProject).toHaveBeenCalledWith({ name: "demo", description: "Demo", workspaceId: "workspace-1" });
  });

  it("uses a distinct R2 prefix for project source blobs", () => {
    expect(__testing.fileStoreR2Prefix("workspace", "do-123")).toBe("workspace-fs/do-123");
    expect(__testing.fileStoreR2Prefix("project", "do-123")).toBe("project-fs/do-123");
  });

  it("serializes concurrent edits in the owning file Durable Object", async () => {
    const client = new ProjectFilesystemClient(env as never, `project-${crypto.randomUUID()}`);
    await expect(client.writeFile("/src/value.ts", "const one = 1;\nconst two = 2;\n"))
      .resolves.toEqual({ success: true });

    await Promise.all([
      client.editTextFile("/src/value.ts", [{ oldText: "one = 1", newText: "one = 10" }]),
      client.editTextFile("/src/value.ts", [{ oldText: "two = 2", newText: "two = 20" }]),
    ]);

    await expect(client.readFile("/src/value.ts")).resolves.toMatchObject({
      content: "const one = 10;\nconst two = 20;\n",
    });
  });

  it("keeps notebook validation inside the atomic edit mutation", async () => {
    const client = new ProjectFilesystemClient(env as never, `project-${crypto.randomUUID()}`);
    const validNotebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [{
        cell_type: "code",
        id: "a",
        metadata: {},
        source: "print(1)",
        outputs: [],
        execution_count: null,
      }],
    });
    await client.writeFile("/valid.ipynb", validNotebook);

    await expect(client.editTextFile(
      "/valid.ipynb",
      [{ oldText: '"cells":[', newText: '"cells":' }],
    )).resolves.toMatchObject({ success: false, code: "EEDIT" });
    await expect(client.readFile("/valid.ipynb")).resolves.toMatchObject({ content: validNotebook });

    const invalidNotebook = JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        { cell_type: "code", id: "a", metadata: {}, source: "print('typo)", outputs: [], execution_count: null },
        { cell_type: "code", id: "b", metadata: {}, source: [42], outputs: [], execution_count: null },
      ],
    });
    await client.writeFile("/invalid.ipynb", invalidNotebook);
    const repaired = await client.editTextFile(
      "/invalid.ipynb",
      [{ oldText: "print('typo)", newText: "print('fixed')" }],
    );
    expect(repaired).toMatchObject({ success: true });
    expect(repaired.notice).toContain("still structurally invalid");
    await expect(client.readFile("/invalid.ipynb")).resolves.toMatchObject({
      content: expect.stringContaining("print('fixed')"),
    });
  });

  it("recognizes local unavailable Artifacts bindings", () => {
    expect(__testing.isArtifactsBindingUnavailableError("Binding ARTIFACTS needs to be run remotely")).toBe(true);
    expect(__testing.isArtifactsBindingUnavailableError("network timeout")).toBe(false);
  });

  it("adopts a streamed R2 object and reads it back through the store's own path", async () => {
    const client = new ProjectFilesystemClient(env as never, `project-${crypto.randomUUID()}`);

    // A payload larger than the store's inline threshold (1.5 MB) so it truly
    // lives in R2 and exercises the spilled-file read path, without being so
    // large it slows the suite.
    const size = 2 * 1024 * 1024;
    const payload = new Uint8Array(size);
    for (let i = 0; i < size; i += 1) payload[i] = i % 251;
    const source = new Response(payload).body!;

    const adopt = await client.adoptR2File("/assets/model.bin", source, size, "application/octet-stream");
    expect(adopt.success).toBe(true);
    expect(adopt.size).toBe(size);

    // The store must surface the adopted file through its own stat/list/read
    // code — proving the R2 key + metadata row match what the store expects.
    await expect(client.exists("/assets/model.bin")).resolves.toMatchObject({ exists: true, isFile: true, size });
    const listing = await client.listFiles("/assets", {});
    expect(listing.files.map((f) => f.name)).toContain("model.bin");

    const readBack = await client.readFile("/assets/model.bin");
    expect(readBack.success).toBe(true);
    expect(readBack.encoding).toBe("base64");
    const decoded = Uint8Array.from(atob(readBack.content ?? ""), (ch) => ch.charCodeAt(0));
    expect(decoded.byteLength).toBe(size);
    expect(decoded[0]).toBe(payload[0]);
    expect(decoded[size - 1]).toBe(payload[size - 1]);

    // A size mismatch must fail loudly and leave nothing registered.
    const mismatch = await client.adoptR2File(
      "/assets/other.bin",
      new Response(new Uint8Array(10)).body!,
      999,
      "application/octet-stream",
    );
    expect(mismatch.success).toBe(false);
    await expect(client.exists("/assets/other.bin")).resolves.toMatchObject({ exists: false });
  });

  it("creates deterministic project source snapshots from real DO-backed files", async () => {
    const client = new ProjectFilesystemClient(env as never, `project-${crypto.randomUUID()}`);
    await expect(client.writeFile("/package.json", JSON.stringify({ scripts: { build: "vite build" } }))).resolves.toEqual({ success: true });
    await expect(client.writeFile("/src/index.ts", "export const value = 1;\n")).resolves.toEqual({ success: true });
    await expect(client.writeFile("/node_modules/ignored.js", "ignored\n")).resolves.toEqual({ success: true });

    const first = await client.createSourceSnapshot({ message: "deploy" });
    const second = await client.createSourceSnapshot({ message: "deploy again" });

    expect(first.id).toMatch(/^[a-f0-9]{64}$/);
    expect(second.id).toBe(first.id);
    expect(first.message).toBe("deploy");
    expect(first.fileCount).toBe(2);
    expect(first.entries.map((entry) => entry.path)).toEqual(["package.json", "src/index.ts"]);
    expect(first.entries.every((entry) => /^[a-f0-9]{64}$/.test(entry.sha256))).toBe(true);
    expect(first.entries.every((entry) => entry.blobKey.startsWith("project-source-snapshots/"))).toBe(true);
    await expect(client.listSourceSnapshots(10)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, fileCount: 2 }),
    ]));

    await expect(client.writeFile("/src/index.ts", "export const value = 2;\n")).resolves.toEqual({ success: true });
    await expect(client.writeFile("/src/extra.ts", "export const extra = true;\n")).resolves.toEqual({ success: true });
    await expect(client.restoreSourceSnapshot(first.id)).resolves.toMatchObject({ id: first.id, fileCount: 2 });
    await expect(client.readFile("/src/index.ts")).resolves.toMatchObject({ content: "export const value = 1;\n" });
    await expect(client.readFile("/src/extra.ts")).resolves.toMatchObject({ success: false, code: "ENOENT" });

    const firstBlobKey = first.entries[0]?.blobKey;
    expect(firstBlobKey).toBeTruthy();
    await expect((env as never as { R2_BUCKET: R2Bucket }).R2_BUCKET.head(firstBlobKey)).resolves.toBeTruthy();
    await expect(client.deleteSourceSnapshots()).resolves.toEqual({ snapshotsDeleted: 1, blobsDeleted: 2 });
    await expect(client.listSourceSnapshots(10)).resolves.toEqual([]);
    await expect((env as never as { R2_BUCKET: R2Bucket }).R2_BUCKET.head(firstBlobKey)).resolves.toBeNull();
  });
});

it("snapshots R2-spilled files by streaming, entries matching the adopted content", async () => {
  const client = new ProjectFilesystemClient(env as never, `project-${crypto.randomUUID()}`);
  const size = 2 * 1024 * 1024;
  const payload = new Uint8Array(size);
  for (let i = 0; i < size; i += 1) payload[i] = (i * 7) % 251;
  const adopt = await client.adoptR2File("/data/big.bin", new Response(payload).body!, size, "application/octet-stream");
  expect(adopt.success).toBe(true);
  await client.writeFile("/README.md", "hello");

  const snapshot = await client.createSourceSnapshot({ message: "stream test" });
  const big = snapshot.entries.find((e) => e.path === "data/big.bin");
  expect(big).toBeDefined();
  expect(big!.size).toBe(size);
  // digest must match a locally computed SHA-256 of the same payload
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const expected = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  expect(big!.sha256).toBe(expected);
  // restore must round-trip the streamed blob through the store
  await client.deleteFile("/data/big.bin", { recursive: true, force: true });
  await client.restoreSourceSnapshot(snapshot.id);
  const back = await client.exists("/data/big.bin");
  expect(back).toMatchObject({ exists: true, size });
});
