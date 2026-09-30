import { describe, expect, it } from "vitest";

import {
  ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE,
  analysisContainerName,
  type AnalysisAccess,
  type AnalysisCommandResult,
  type AnalysisContainerLike,
  type AnalysisContainerStub,
  type AnalysisExecOptions,
} from "../src/analysis-container.js";
import {
  AnalysisService,
  ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS,
  ANALYSIS_MAX_PERSIST_BYTES,
  clampOutputTail,
  diffManifests,
  extractNotebookTraceback,
  normalizeAnalysisRelPath,
  notebookExecuteCommand,
  parseSha256Manifest,
  parseValidateNotebookOutput,
  runAnalysisCode,
  runAnalysisExec,
  runAnalysisNotebook,
  shouldIgnoreAnalysisPath,
  treeManifestCommand,
  validateNotebookCommand,
} from "../src/analysis-service.js";
import type { WorkspaceFileStoreLike } from "../src/workspace-filesystem-do.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("shouldIgnoreAnalysisPath", () => {
  it("ignores derived/ephemeral trees, keeps source", () => {
    expect(shouldIgnoreAnalysisPath(".venv/lib/python3.13/site.py")).toBe(true);
    expect(shouldIgnoreAnalysisPath("src/__pycache__/mod.pyc")).toBe(true);
    expect(shouldIgnoreAnalysisPath(".ipynb_checkpoints/a.ipynb")).toBe(true);
    expect(shouldIgnoreAnalysisPath("node_modules/x/index.js")).toBe(true);
    expect(shouldIgnoreAnalysisPath("analysis.ipynb")).toBe(false);
    expect(shouldIgnoreAnalysisPath("data/sales.csv")).toBe(false);
    expect(shouldIgnoreAnalysisPath("pyproject.toml")).toBe(false);
  });
});

describe("normalizeAnalysisRelPath", () => {
  it("strips ./ and leading slashes and traversal", () => {
    expect(normalizeAnalysisRelPath("./a/b.ipynb")).toBe("a/b.ipynb");
    expect(normalizeAnalysisRelPath("/a//b")).toBe("a/b");
    expect(normalizeAnalysisRelPath("a/../b")).toBe("a/b");
  });
});

describe("parseSha256Manifest", () => {
  it("parses sha256sum output and drops ignored paths", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ./analysis.ipynb",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ./data/x.csv",
      "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc  ./.venv/lib/foo.py",
      "garbage line",
    ].join("\n");
    const manifest = parseSha256Manifest(stdout);
    expect(manifest.get("analysis.ipynb")).toBe("a".repeat(64));
    expect(manifest.get("data/x.csv")).toBe("b".repeat(64));
    expect(manifest.has(".venv/lib/foo.py")).toBe(false);
    expect(manifest.size).toBe(2);
  });
});

describe("diffManifests", () => {
  it("reports changed (new + modified) and removed", () => {
    const before = new Map([
      ["a.ipynb", "1"],
      ["keep.csv", "2"],
      ["gone.txt", "3"],
    ]);
    const next = new Map([
      ["a.ipynb", "1x"], // modified
      ["keep.csv", "2"], // unchanged
      ["new.png", "9"], // added
    ]);
    const { changed, removed } = diffManifests(before, next);
    expect(changed).toEqual(["a.ipynb", "new.png"]);
    expect(removed).toEqual(["gone.txt"]);
  });
});

describe("parseValidateNotebookOutput", () => {
  it("treats OK / exit 0 as clean", () => {
    expect(parseValidateNotebookOutput("OK", 0)).toEqual({ clean: true, issues: [] });
    expect(parseValidateNotebookOutput("", 0)).toEqual({ clean: true, issues: [] });
  });
  it("collects issues on non-zero exit", () => {
    const out = "Cell 3 ERROR: NameError: name 'df' is not defined\nCell 5 WARNING: setup output";
    const parsed = parseValidateNotebookOutput(out, 1);
    expect(parsed.clean).toBe(false);
    expect(parsed.issues).toHaveLength(2);
    expect(parsed.issues[0]).toContain("NameError");
  });
});

describe("command builders", () => {
  it("routes notebook execution through uv only when a pyproject exists", () => {
    expect(notebookExecuteCommand("a nb.ipynb", false)).toBe(
      "python /usr/local/bin/execute-notebook 'a nb.ipynb'",
    );
    // With a pyproject the kernel must see the PROJECT env, and the notebook
    // toolchain is overlaid so execution never falls back to the baked jupyter.
    expect(notebookExecuteCommand("nb.ipynb", true)).toBe(
      "uv run --project . --with jupyter --with nbconvert --with ipykernel python /usr/local/bin/execute-notebook 'nb.ipynb'",
    );
  });
  it("quotes the notebook path for the validator", () => {
    expect(validateNotebookCommand("a b.ipynb")).toBe("validate-notebook 'a b.ipynb'");
  });
  it("prunes heavy dirs in the tree manifest command", () => {
    const cmd = treeManifestCommand();
    expect(cmd).toContain("sha256sum");
    expect(cmd).toContain("-name '.venv'");
    expect(cmd).toContain("-prune");
    expect(cmd).not.toContain("exit ");
  });
});

// ---------------------------------------------------------------------------
// runAnalysisNotebook — end to end over a fake sandbox + file store
// ---------------------------------------------------------------------------

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collectStreamBytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of stream) {
    chunks.push(chunk);
    size += chunk.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** In-memory project file store implementing the bits the service touches. */
function fakeFiles(
  initial: Record<string, string>,
  opts?: { failDelete?: boolean },
): WorkspaceFileStoreLike & {
  store: Map<string, string>;
  contentTypes: Map<string, string | undefined>;
  io: { bufferedReads: number; bufferedWrites: number; streamReads: number; streamAdoptions: number };
} {
  const store = new Map(Object.entries(initial));
  const contentTypes = new Map<string, string | undefined>();
  const io = { bufferedReads: 0, bufferedWrites: 0, streamReads: 0, streamAdoptions: 0 };
  const norm = (p: string) => p.replace(/^\/+/, "");
  return {
    store,
    contentTypes,
    io,
    async listFiles() {
      return {
        success: true,
        path: "/",
        count: store.size,
        files: [...store.keys()].map((rel) => ({
          name: rel.split("/").pop() as string,
          type: "file" as const,
          size: store.get(rel)?.length ?? 0,
          modifiedAt: "",
          relativePath: rel,
          absolutePath: `/${rel}`,
        })),
      };
    },
    async readFile(path: string) {
      io.bufferedReads += 1;
      const rel = norm(path);
      if (!store.has(rel)) return { success: false, error: "not found" };
      return { success: true, content: store.get(rel) as string, encoding: "utf8" as const };
    },
    async writeFile(path: string, content: string) {
      store.set(norm(path), content);
      return { success: true };
    },
    async writeBinaryFile(path: string, base64: string) {
      io.bufferedWrites += 1;
      store.set(norm(path), Buffer.from(base64, "base64").toString("utf8"));
      return { success: true };
    },
    async adoptR2File(path: string, stream: ReadableStream<Uint8Array>, expectedSize: number, contentType?: string) {
      io.streamAdoptions += 1;
      contentTypes.set(norm(path), contentType);
      const bytes = await collectStreamBytes(stream);
      if (bytes.byteLength !== expectedSize) {
        return { success: false, error: "stream size mismatch" };
      }
      store.set(norm(path), new TextDecoder().decode(bytes));
      return { success: true, size: bytes.byteLength };
    },
    async deleteFile(path: string) {
      if (opts?.failDelete) return { success: false, error: "simulated storage failure" };
      store.delete(norm(path));
      return { success: true };
    },
    async exists(path: string) {
      return { exists: store.has(norm(path)) };
    },
    async mkdir() {
      return { success: true };
    },
    async readFileStream(path: string) {
      io.streamReads += 1;
      const rel = norm(path);
      const content = store.get(rel);
      if (content === undefined) return { success: false, error: "not found" };
      const bytes = new TextEncoder().encode(content);
      return {
        success: true,
        stream: streamFromBytes(bytes),
        size: bytes.byteLength,
        mimeType: "application/octet-stream",
      };
    },
  } as unknown as WorkspaceFileStoreLike & {
    store: Map<string, string>;
    contentTypes: Map<string, string | undefined>;
    io: { bufferedReads: number; bufferedWrites: number; streamReads: number; streamAdoptions: number };
  };
}

/**
 * Fake AnalysisContainer: an in-memory filesystem the exec'd commands operate
 * on. It understands just enough — the write/open/mkdir file ops, the wipe
 * glob, the notebook-execute command (mutates the notebook + emits a chart
 * PNG), the validator, and the sha256sum tree manifest — to drive the
 * persist-back path.
 */
function fakeSandbox(opts?: {
  failManifest?: boolean;
  removeOnRun?: string;
  notebookFailure?: { stderr: string };
  createOnRun?: { command: string; path: string; bytes: Uint8Array };
}): AnalysisContainerLike & { execCwds: string[]; removed: string[][] } {
  const execCwds: string[] = [];
  const removed: string[][] = [];
  const fs = new Map<string, Uint8Array>();
  const sha = async (bytes: Uint8Array) => {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const rel = (workdir: string, abs: string) => abs.slice(workdir.length + 1);
  const ok = (stdout = ""): AnalysisCommandResult => ({ exitCode: 0, stdout, stderr: "", timedOut: false });
  return {
    execCwds,
    removed,
    async mkdir() {},
    async writeFile(path: string, content: string | ReadableStream<Uint8Array>) {
      const bytes = typeof content === "string"
        ? new TextEncoder().encode(content)
        : await collectStreamBytes(content);
      fs.set(path, bytes);
    },
    async openFile(path: string) {
      const bytes = fs.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return { stream: streamFromBytes(bytes), size: bytes.byteLength };
    },
    async removePaths(paths: string[]) {
      removed.push(paths);
      for (const target of paths) {
        for (const key of fs.keys()) if (key.startsWith(`${target}/`)) fs.delete(key);
      }
    },
    async exec(command: string, options: { cwd: string }) {
      const cwd = options.cwd;
      execCwds.push(cwd);
      // Wipe glob before materialize: drop all files under cwd.
      if (command.startsWith("find . -mindepth 1")) {
        for (const key of fs.keys()) if (key.startsWith(`${cwd}/`)) fs.delete(key);
        return ok();
      }
      // Notebook execution: mark the notebook executed and emit a chart artifact.
      if (command.includes("execute-notebook")) {
        if (opts?.notebookFailure) {
          return { exitCode: 1, stdout: "", stderr: opts.notebookFailure.stderr, timedOut: false };
        }
        fs.set(`${cwd}/analysis.ipynb`, new TextEncoder().encode('{"cells":[],"executed":true}'));
        fs.set(`${cwd}/chart.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        if (opts?.removeOnRun) fs.delete(`${cwd}/${opts.removeOnRun}`);
        return ok();
      }
      if (command.startsWith("validate-notebook")) return ok("OK");
      if (opts?.createOnRun && command === opts.createOnRun.command) {
        fs.set(`${cwd}/${opts.createOnRun.path}`, opts.createOnRun.bytes);
        return ok();
      }
      // Tree manifest: sha256sum over the in-memory fs under cwd (skip ignored).
      if (command.includes("sha256sum")) {
        if (opts?.failManifest) {
          return { exitCode: 1, stdout: "", stderr: "find: disk exploded", timedOut: false };
        }
        const lines: string[] = [];
        for (const [abs, bytes] of fs) {
          if (!abs.startsWith(`${cwd}/`)) continue;
          const r = rel(cwd, abs);
          if (shouldIgnoreAnalysisPath(r)) continue;
          lines.push(`${await sha(bytes)}  ./${r}`);
        }
        return ok(lines.join("\n"));
      }
      return ok();
    },
  };
}

describe("runAnalysisNotebook", () => {
  it("executes, validates, and persists the changed set back to the project FS", async () => {
    const files = fakeFiles({ "analysis.ipynb": '{"cells":[]}', "data.csv": "a,b\n1,2\n" });
    const result = await runAnalysisNotebook(
      { path: "analysis.ipynb" },
      { sandbox: fakeSandbox(), files, projectId: "ca-test-proj", newRunId: () => "run1" },
    );

    expect(result.ok).toBe(true);
    expect(result.executed).toBe(true);
    expect(result.validation.clean).toBe(true);
    // The executed notebook (modified) and the new chart persist back; the
    // unchanged data.csv does not appear in the changed set.
    expect(result.changedFiles).toContain("analysis.ipynb");
    expect(result.changedFiles).toContain("chart.png");
    expect(result.changedFiles).not.toContain("data.csv");
    expect(files.store.get("chart.png")).toBeDefined();
    expect(files.store.get("analysis.ipynb")).toContain("executed");
    // The persisted files carry a content type from their name.
    expect(files.contentTypes.get("chart.png")).toBe("image/png");
  });

  it("rejects a path that is not a .ipynb", async () => {
    const files = fakeFiles({ "script.py": "print(1)" });
    const result = await runAnalysisNotebook(
      { path: "script.py" },
      { sandbox: fakeSandbox(), files, projectId: "ca-test-proj", newRunId: () => "run1" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/\.ipynb/);
  });

  it("fails when the notebook is not in the project", async () => {
    const files = fakeFiles({ "other.ipynb": "{}" });
    const result = await runAnalysisNotebook(
      { path: "missing.ipynb" },
      { sandbox: fakeSandbox(), files, projectId: "ca-test-proj", newRunId: () => "run1" },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("gives concurrent runs on the same project isolated per-run workdirs", async () => {
    const sandbox = fakeSandbox();
    const files = fakeFiles({ "analysis.ipynb": '{"cells":[]}' });
    let counter = 0;
    const deps = { sandbox, files, projectId: "ca-test-proj", newRunId: () => `run${++counter}` };

    const [a, b] = await Promise.all([
      runAnalysisNotebook({ path: "analysis.ipynb" }, deps),
      runAnalysisNotebook({ path: "analysis.ipynb" }, deps),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const nbconvertCwds = sandbox.execCwds.filter((cwd) => cwd.includes("/runs/"));
    const distinctRunDirs = new Set(nbconvertCwds.map((cwd) => cwd.match(/\/runs\/[^/]+/)?.[0]));
    expect(distinctRunDirs).toEqual(new Set(["/runs/run1", "/runs/run2"]));
    // Both run trees (workdir + scratch) were cleaned up afterwards.
    expect(sandbox.removed).toEqual(expect.arrayContaining([
      ["/projects/ca-test-proj/runs/run1", "/scratch/run1"],
      ["/projects/ca-test-proj/runs/run2", "/scratch/run2"],
    ]));
  });
});

describe("notebook failure output", () => {
  it("clampOutputTail keeps the tail and marks the omission", () => {
    expect(clampOutputTail("short", 100)).toBe("short");
    const clamped = clampOutputTail(`${"x".repeat(50)}THE END`, 10);
    expect(clamped).toContain("[... 47 earlier characters truncated ...]");
    expect(clamped.endsWith("THE END")).toBe(true);
  });

  it("extractNotebookTraceback pulls the final traceback block from nbconvert stderr", () => {
    const stderr = [
      "[NbConvertApp] Converting notebook analysis.ipynb to notebook",
      "0.00s - Debugger warning: frozen modules",
      "Traceback (most recent call last):",
      '  File "nbclient/client.py", line 1000, in _check_raise_for_error',
      "    raise CellExecutionError.from_cell_and_msg(cell, exec_reply_content)",
      "nbconvert.preprocessors.CellExecutionError: An error occurred while executing the following cell:",
      "------------------",
      "df = pd.read_csv('missing.csv')",
      "------------------",
      "FileNotFoundError: [Errno 2] No such file or directory: 'missing.csv'",
    ].join("\n");
    const traceback = extractNotebookTraceback(stderr);
    expect(traceback).toBeDefined();
    expect(traceback).toContain("Traceback (most recent call last):");
    expect(traceback).toContain("FileNotFoundError: [Errno 2]");
    expect(traceback).not.toContain("[NbConvertApp]");
  });

  it("extractNotebookTraceback returns undefined when there is no traceback", () => {
    expect(extractNotebookTraceback("plain warning noise")).toBeUndefined();
  });

  it("keeps the traceback in error and returns full stderr on a failing run", async () => {
    const noise = "progress line\n".repeat(5000); // ~70KB of leading noise
    const stderr =
      `${noise}Traceback (most recent call last):\n` +
      "  File \"cell\", line 1, in <module>\n" +
      "NameError: name 'undefined_var' is not defined\n";
    const files = fakeFiles({ "analysis.ipynb": '{"cells":[]}' });
    const result = await runAnalysisNotebook(
      { path: "analysis.ipynb" },
      {
        sandbox: fakeSandbox({ notebookFailure: { stderr } }),
        files,
        projectId: "ca-test-proj",
        newRunId: () => "run1",
      },
    );

    expect(result.ok).toBe(false);
    expect(result.executed).toBe(false);
    // error leads with the traceback, not the buried head of stderr
    expect(result.error).toContain("Traceback (most recent call last):");
    expect(result.error).toContain("NameError: name 'undefined_var' is not defined");
    // the service returns FULL stderr — the tool layer spills it to R2 and
    // clamps for the model (clampAnalysisRunOutputs)
    expect(result.stderr).toBe(stderr);
  });
});

describe("persist safety", () => {
  it("streams a 25 MiB changed file without buffered/base64 project RPCs", async () => {
    const largeBytes = new Uint8Array(ANALYSIS_MAX_PERSIST_BYTES).fill(0x61);
    const files = fakeFiles({ "seed.txt": "seed" });
    const result = await runAnalysisExec(
      { command: "create-large-archive-entry" },
      {
        sandbox: fakeSandbox({
          createOnRun: {
            command: "create-large-archive-entry",
            path: "imported/large.bin",
            bytes: largeBytes,
          },
        }),
        files,
        projectId: "ca-test-proj",
        newRunId: () => "run1",
        hasProject: true,
        scratchId: "scratch1",
      },
    );

    expect(result.ok).toBe(true);
    expect(result.changedFiles).toContain("imported/large.bin");
    expect(files.io).toEqual({
      bufferedReads: 0,
      bufferedWrites: 0,
      streamReads: 1,
      streamAdoptions: 1,
    });
    expect(files.store.get("imported/large.bin")).toHaveLength(
      ANALYSIS_MAX_PERSIST_BYTES,
    );
  });

  it("aborts (throws) instead of diffing when the tree manifest fails", async () => {
    const files = fakeFiles({ "analysis.ipynb": '{"cells":[]}', "keep.csv": "a,b\n" });
    await expect(
      runAnalysisNotebook(
        { path: "analysis.ipynb" },
        { sandbox: fakeSandbox({ failManifest: true }), files, projectId: "ca-test-proj", newRunId: () => "run1" },
      ),
    ).rejects.toThrow(/tree manifest failed/);
    // Nothing was deleted from the project store by the failed run.
    expect(files.store.has("keep.csv")).toBe(true);
    expect(files.store.has("analysis.ipynb")).toBe(true);
  });
});

/** A container whose every command answers `answer`, recording what ran. */
function recordingSandbox(answer: () => Promise<AnalysisCommandResult>) {
  const calls: Array<{ command: string; options: AnalysisExecOptions }> = [];
  const removed: string[][] = [];
  const written: Array<{ path: string; content: unknown }> = [];
  const sandbox: AnalysisContainerLike & {
    calls: typeof calls;
    removed: typeof removed;
    written: typeof written;
  } = {
    calls,
    removed,
    written,
    async mkdir() {},
    async writeFile(path, content) {
      written.push({ path, content });
    },
    async openFile() {
      throw new Error("not in this fake");
    },
    async removePaths(paths) {
      removed.push(paths);
    },
    async exec(command, options) {
      calls.push({ command, options });
      return answer();
    },
  };
  return sandbox;
}

const exited = (exitCode: number, stdout = "", stderr = ""): AnalysisCommandResult => ({
  exitCode,
  stdout,
  stderr,
  timedOut: false,
});

describe("runAnalysisCode", () => {
  it("injects the connections RPC URL and per-run SCRATCH for agent-scoped runs", async () => {
    const sandbox = recordingSandbox(async () => exited(0));
    await runAnalysisCode({ code: "print(1)" }, { sandbox, scratchId: "s1" });
    expect(sandbox.calls[0].options.env).toMatchObject({
      CAMELAI_CONNECTIONS_RPC_URL: "http://connections.internal/",
      SCRATCH: "/scratch/s1",
    });
  });

  it("omits the connections RPC URL for app-scoped runs", async () => {
    const sandbox = recordingSandbox(async () => exited(0));
    await runAnalysisCode({ code: "print(1)" }, { sandbox, scratchId: "s1", connections: false });
    expect(sandbox.calls[0].options.env?.CAMELAI_CONNECTIONS_RPC_URL).toBeUndefined();
  });

  it("writes the script as text and runs it from its scratch dir", async () => {
    const sandbox = recordingSandbox(async () => exited(0, "1\n"));
    const result = await runAnalysisCode({ code: "print(n)", params: { n: 1 } }, { sandbox, scratchId: "s1" });
    expect(result).toEqual({ ok: true, stdout: "1\n", stderr: "" });
    expect(sandbox.written).toHaveLength(1);
    expect(sandbox.written[0].path).toBe("/scratch/s1/main.py");
    expect(String(sandbox.written[0].content)).toContain("print(n)");
    expect(sandbox.calls[0]).toMatchObject({
      command: "python '/scratch/s1/main.py'",
      options: { cwd: "/scratch/s1", timeoutMs: ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS },
    });
    expect(sandbox.removed).toEqual([["/scratch/s1"]]);
  });

  it("reports a container failure as a value, with its message", async () => {
    const sandbox = recordingSandbox(async () => {
      throw new Error(ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE);
    });
    const result = await runAnalysisCode({ code: "print(1)" }, { sandbox, scratchId: "s1" });
    expect(result).toEqual({ ok: false, error: ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE });
  });

  it("cleans up after an ordinary non-zero exit", async () => {
    const sandbox = recordingSandbox(async () => exited(1, "", "boom"));
    const result = await runAnalysisCode({ code: "print(1)" }, { sandbox, scratchId: "s1" });
    expect(result).toMatchObject({ ok: false, error: "boom" });
    expect(sandbox.removed).toEqual([["/scratch/s1"]]);
  });
});

// ---------------------------------------------------------------------------
// AnalysisService over a fake container stub
// ---------------------------------------------------------------------------

function fakeStub(answer: () => Promise<AnalysisCommandResult>) {
  const base = recordingSandbox(answer);
  const prepared: AnalysisAccess[] = [];
  const stub = Object.assign(base, {
    prepared,
    flushes: 0,
    async prepare(access: AnalysisAccess) {
      prepared.push(access);
    },
    async flushMounts() {
      stub.flushes += 1;
    },
  });
  return stub as AnalysisContainerStub & typeof stub;
}

function serviceWith(
  answer: () => Promise<AnalysisCommandResult>,
  scope: "agent" | "app" = "agent",
) {
  const events: Array<{ blobs: unknown[]; doubles: unknown[] }> = [];
  const stub = fakeStub(answer);
  const service = Object.create(AnalysisService.prototype) as AnalysisService & {
    env: unknown;
    ctx: unknown;
  };
  service.env = {
    OBSERVABILITY_EVENTS: {
      writeDataPoint: (point: { blobs: unknown[]; doubles: unknown[] }) => events.push(point),
    },
  };
  service.ctx = { props: { orgId: "org-1", workspaceId: "ws-1" } };
  (service as unknown as { sandboxes: Map<string, AnalysisContainerStub> }).sandboxes = new Map([[scope, stub]]);
  return { service, stub, events };
}

const eventsNamed = (events: Array<{ blobs: unknown[] }>, name: string) =>
  events.filter((point) => (point.blobs as string[])[0] === name);

describe("AnalysisService container access", () => {
  it("prepares the agent container with the org/workspace scope before running", async () => {
    const { service, stub } = serviceWith(async () => exited(0));
    await expect(service.runCode({ code: "print('ok')" })).resolves.toMatchObject({ ok: true });
    expect(stub.prepared).toEqual([{ mode: "agent", orgId: "org-1", workspaceId: "ws-1" }]);
    // Writable mounts that are not live are copied back after agent runs.
    expect(stub.flushes).toBe(1);
  });

  it("runs deployed-app code in the app container, with app access and no connections", async () => {
    const { service, stub } = serviceWith(async () => exited(0), "app");
    await expect(service.runCodeForApps({ code: "print('ok')" })).resolves.toMatchObject({ ok: true });
    expect(stub.prepared).toEqual([{ mode: "app", workspaceId: "ws-1" }]);
    expect(stub.calls[0].options.env?.CAMELAI_CONNECTIONS_RPC_URL).toBeUndefined();
    expect(stub.flushes).toBe(0);
  });

  it("names the containers after the workspace (agent) and app-<workspace> (app)", () => {
    expect(analysisContainerName({ mode: "agent", orgId: "o", workspaceId: "ws-1" })).toBe("ws-1");
    expect(analysisContainerName({ mode: "app", workspaceId: "ws-1" })).toBe("app-ws-1");
  });

  it("still flushes writable mounts when the run throws", async () => {
    const { service, stub } = serviceWith(async () => {
      throw new Error(ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE);
    });
    await expect(service.exec({ command: "python main.py" })).rejects.toThrow(ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE);
    expect(stub.flushes).toBe(1);
  });
});

describe("AnalysisService environment failures", () => {
  /** Only the agent's command counts. */
  const commandRuns = (stub: { calls: Array<{ command: string }> }) => stub.calls.length;

  it("does NOT re-run a command whose container stopped UNDER it", async () => {
    const { service, stub } = serviceWith(async () => {
      throw new Error(ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE);
    });

    // `psql -f migrate.sql` may have applied the migration before the
    // container stopped; re-dispatching it would apply it twice, silently.
    const failure = await service.exec({ command: "psql -f migrate.sql" }).catch((error) => error as Error);
    expect(failure.message).toBe(ANALYSIS_ENVIRONMENT_RESTARTED_MESSAGE);
    expect(commandRuns(stub)).toBe(1);
  });

  it("does not retry an ordinary command failure", async () => {
    const { service, stub } = serviceWith(async () => exited(127, "", "bash: nope: command not found"));
    const result = await service.exec({ command: "nope" });
    expect(result).toMatchObject({ ok: false, exitCode: 127, error: "bash: nope: command not found" });
    expect(commandRuns(stub)).toBe(1);
  });

  describe("timeout (exit 124)", () => {
    // What the container returns after `timeout` stopped the process group.
    const killed = async (): Promise<AnalysisCommandResult> => ({
      exitCode: 124,
      stdout: "partial row 1\npartial row 2\n",
      stderr: "still working...\n",
      timedOut: true,
    });

    it("reports the stable timeout message and keeps the partial output", async () => {
      const { service, events } = serviceWith(killed);

      const result = await service.exec({ command: "python slow.py", timeoutMs: 5_000 });

      expect(result).toMatchObject({
        ok: false,
        exitCode: 124,
        error: "Command timed out after 5000ms",
        timedOut: true,
        stdout: "partial row 1\npartial row 2\n",
      });
      const recorded = eventsNamed(events, "sandbox_exec_timeout");
      expect(recorded).toHaveLength(1);
      expect((recorded[0].blobs as string[])[3]).toBe("exec");
      expect((recorded[0].blobs as string[])[4]).toBe("timed_out");
    });

    it("maps run_code's timeout to its fixed budget", async () => {
      const { service, events } = serviceWith(killed);

      const result = await service.runCode({ code: "while True: pass" });

      expect(result).toMatchObject({
        ok: false,
        error: `Command timed out after ${ANALYSIS_DEFAULT_EXEC_TIMEOUT_MS}ms`,
        timedOut: true,
      });
      expect(eventsNamed(events, "sandbox_exec_timeout")).toHaveLength(1);
    });

    it("leaves a program that exits 124 on its own as an ordinary failure", async () => {
      const { service, events } = serviceWith(async () => exited(124, "", "inner step timed out"));

      const result = await service.exec({ command: "timeout 1 sleep 5; exit 124" });

      expect(result).toMatchObject({ ok: false, exitCode: 124, error: "inner step timed out" });
      expect(result.timedOut).toBeUndefined();
      expect(eventsNamed(events, "sandbox_exec_timeout")).toHaveLength(0);
    });
  });

  it("gives every command a timeout and an absolute cwd", async () => {
    const { service, stub } = serviceWith(async () => exited(0));
    (service as unknown as { projectFiles: (id: string) => Promise<unknown> }).projectFiles =
      async () => fakeFiles({ "main.py": "print(1)\n" });

    await service.exec({ projectId: "ca-test-proj", command: "python main.py" });

    expect(stub.calls.length).toBeGreaterThanOrEqual(4);
    for (const { command, options } of stub.calls) {
      expect({ command, timeout: typeof options.timeoutMs, cwd: options.cwd.startsWith("/") })
        .toEqual({ command, timeout: "number", cwd: true });
    }
  });
});

describe("persist delete failures", () => {
  it("fails the run loudly when removing a deleted file from the store fails", async () => {
    const files = fakeFiles({ "analysis.ipynb": '{"cells":[]}', "obsolete.txt": "old" }, { failDelete: true });
    await expect(
      runAnalysisNotebook(
        { path: "analysis.ipynb" },
        {
          sandbox: fakeSandbox({ removeOnRun: "obsolete.txt" }),
          files,
          projectId: "ca-test-proj",
          newRunId: () => "run1",
        },
      ),
    ).rejects.toThrow(/simulated storage failure/);
  });
});

describe("AnalysisService project scoping", () => {
  it("refuses a projectId that is not in the bound workspace's registry", async () => {
    const service = Object.create(AnalysisService.prototype) as AnalysisService & {
      env: unknown;
      ctx: unknown;
    };
    service.env = {
      WORKSPACE_FS: {
        idFromName: (name: string) => name,
        get: () => ({ getProject: async () => null }),
      },
    };
    service.ctx = { props: { workspaceId: "ws-a", orgId: "org-a" } };

    await expect(
      service.runNotebook({ projectId: "ca-other-workspace-proj", path: "analysis.ipynb" }),
    ).rejects.toThrow(/not found in this workspace/);
    await expect(
      service.addDependency({ projectId: "ca-other-workspace-proj", packages: ["tabulate"] }),
    ).rejects.toThrow(/not found in this workspace/);
    await expect(
      service.exec({ projectId: "ca-other-workspace-proj", command: "ls" }),
    ).rejects.toThrow(/not found in this workspace/);
  });
});

describe("constants", () => {
  it("caps auto-persist size at 25 MiB", () => {
    expect(ANALYSIS_MAX_PERSIST_BYTES).toBe(25 * 1024 * 1024);
  });
});
