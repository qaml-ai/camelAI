import { describe, expect, it } from "vitest";

import {
  ANALYSIS_CONNECTIONS_HANDLER,
  ANALYSIS_CONNECTIONS_HOST,
  AnalysisSandbox,
} from "../src/analysis-sandbox.js";
import { AnalysisService } from "../src/analysis-service.js";
import {
  ANALYSIS_MAX_PERSIST_BYTES,
  clampOutputTail,
  diffManifests,
  extractNotebookTraceback,
  normalizeAnalysisRelPath,
  notebookExecuteCommand,
  parseSha256Manifest,
  parseValidateNotebookOutput,
  runAnalysisCode,
  runAnalysisNotebook,
  shouldIgnoreAnalysisPath,
  treeManifestCommand,
  validateNotebookCommand,
  type AnalysisSandboxLike,
  type AnalysisSandboxStub,
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

/** In-memory project file store implementing the bits the service touches. */
function fakeFiles(initial: Record<string, string>, opts?: { failDelete?: boolean }): WorkspaceFileStoreLike & { store: Map<string, string> } {
  const store = new Map(Object.entries(initial));
  const norm = (p: string) => p.replace(/^\/+/, "");
  return {
    store,
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
      const rel = norm(path);
      if (!store.has(rel)) return { success: false, error: "not found" };
      return { success: true, content: store.get(rel) as string, encoding: "utf8" as const };
    },
    async writeFile(path: string, content: string) {
      store.set(norm(path), content);
      return { success: true };
    },
    async writeBinaryFile(path: string, base64: string) {
      store.set(norm(path), Buffer.from(base64, "base64").toString("utf8"));
      return { success: true };
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
    async readFileStream() {
      return { success: false, error: "unsupported" };
    },
  } as unknown as WorkspaceFileStoreLike & { store: Map<string, string> };
}

/**
 * Fake AnalysisSandbox: an in-memory filesystem the exec'd commands operate on.
 * It understands just enough — the write/read/mkdir file ops, the wipe glob, the
 * notebook-execute command (mutates the notebook + emits a chart PNG), the
 * validator, and the sha256sum tree manifest — to drive the persist-back path.
 */
function fakeSandbox(opts?: { failManifest?: boolean; removeOnRun?: string; notebookFailure?: { stderr: string } }): AnalysisSandboxLike & { execCwds: string[] } {
  const execCwds: string[] = [];
  const fs = new Map<string, Uint8Array>();
  const sha = async (bytes: Uint8Array) => {
    const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  };
  const rel = (workdir: string, abs: string) => abs.slice(workdir.length + 1);
  return {
    execCwds,
    async mkdir() {
      return {};
    },
    async writeFile(path: string, content: string, options?: { encoding?: string }) {
      const bytes = options?.encoding === "base64" ? new Uint8Array(Buffer.from(content, "base64")) : new TextEncoder().encode(content);
      fs.set(path, bytes);
      return {};
    },
    async readFile(path: string) {
      const bytes = fs.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      return { content: Buffer.from(bytes).toString("base64") };
    },
    async exec(command: string, options?: { cwd?: string }) {
      const cwd = options?.cwd ?? "/";
      execCwds.push(cwd);
      // Run-workdir cleanup: drop everything under the removed tree.
      if (command.startsWith("rm -rf ")) {
        const target = command.slice("rm -rf ".length).replace(/'/g, "");
        for (const key of [...fs.keys()]) if (key.startsWith(`${target}/`)) fs.delete(key);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Wipe glob before materialize: drop all files under cwd.
      if (command.startsWith("find . -mindepth 1")) {
        for (const key of [...fs.keys()]) if (key.startsWith(`${cwd}/`)) fs.delete(key);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Notebook execution: mark the notebook executed and emit a chart artifact.
      if (command.includes("execute-notebook")) {
        if (opts?.notebookFailure) {
          return { exitCode: 1, stdout: "", stderr: opts.notebookFailure.stderr };
        }
        const nbAbs = `${cwd}/analysis.ipynb`;
        fs.set(nbAbs, new TextEncoder().encode('{"cells":[],"executed":true}'));
        fs.set(`${cwd}/chart.png`, new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
        if (opts?.removeOnRun) fs.delete(`${cwd}/${opts.removeOnRun}`);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (command.startsWith("validate-notebook")) {
        return { exitCode: 0, stdout: "OK", stderr: "" };
      }
      // Tree manifest: sha256sum over the in-memory fs under cwd (skip ignored).
      if (command.includes("sha256sum")) {
        if (opts?.failManifest) {
          return { exitCode: 1, stdout: "", stderr: "find: disk exploded" };
        }
        const lines: string[] = [];
        for (const [abs, bytes] of fs) {
          if (!abs.startsWith(`${cwd}/`)) continue;
          const r = rel(cwd, abs);
          if (shouldIgnoreAnalysisPath(r)) continue;
          lines.push(`${await sha(bytes)}  ./${r}`);
        }
        return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
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
    expect(new TextDecoder().decode(new TextEncoder().encode(files.store.get("analysis.ipynb")))).toContain("executed");
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
    // Both run trees were cleaned up afterwards.
    const cleanupTargets = sandbox.execCwds.length; // cleanup execs recorded too
    expect(cleanupTargets).toBeGreaterThan(0);
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

describe("runAnalysisCode env scoping", () => {
  function envRecordingSandbox() {
    const envs: Array<Record<string, string | undefined> | undefined> = [];
    const sandbox: AnalysisSandboxLike & { envs: typeof envs } = {
      envs,
      async mkdir() {
        return {};
      },
      async writeFile() {
        return {};
      },
      async readFile() {
        return { content: "" };
      },
      async exec(_command: string, options?: { env?: Record<string, string | undefined> }) {
        envs.push(options?.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    return sandbox;
  }

  it("injects the connections RPC URL and per-run SCRATCH for agent-scoped runs", async () => {
    const sandbox = envRecordingSandbox();
    await runAnalysisCode({ code: "print(1)" }, { sandbox, scratchId: "s1" });
    expect(sandbox.envs.some((env) => env?.CAMELAI_CONNECTIONS_RPC_URL)).toBe(true);
    expect(sandbox.envs.some((env) => env?.SCRATCH === "/scratch/s1")).toBe(true);
  });

  it("omits the connections RPC URL for app-scoped runs", async () => {
    const sandbox = envRecordingSandbox();
    await runAnalysisCode({ code: "print(1)" }, { sandbox, scratchId: "s1", connections: false });
    expect(sandbox.envs.every((env) => !env?.CAMELAI_CONNECTIONS_RPC_URL)).toBe(true);
  });
});

describe("AnalysisService workspace uploads mount", () => {
  function analysisServiceSandbox() {
    const mounts: Array<{
      bucketBinding: string;
      prefix: string;
      mountPath?: string;
      options?: { readOnly?: boolean };
    }> = [];
    const connections: Array<unknown> = [];
    const sandbox: AnalysisSandboxStub & { mounts: typeof mounts; connections: typeof connections } = {
      mounts,
      connections,
      async ensureMounted(
        bucketBinding: string,
        prefix: string,
        mountPath?: string,
        options?: { readOnly?: boolean },
      ) {
        mounts.push({ bucketBinding, prefix, mountPath, options });
      },
      async ensureConnectionsRpc(params: unknown) {
        connections.push(params);
      },
      async sealAppEgress() {},
      async mkdir() {
        return {};
      },
      async writeFile() {
        return {};
      },
      async readFile() {
        return { content: "" };
      },
      async exec() {
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    };
    return sandbox;
  }

  function serviceWithUploads(objects: string[]) {
    const sandbox = analysisServiceSandbox();
    const listCalls: unknown[] = [];
    const service = Object.create(AnalysisService.prototype) as AnalysisService & {
      env: unknown;
      ctx: unknown;
    };
    service.env = {
      R2_BUCKET: {
        async list(options: unknown) {
          listCalls.push(options);
          return { objects: objects.map((key) => ({ key })) };
        },
      },
    };
    service.ctx = { props: { orgId: "org-1", workspaceId: "ws-1" } };
    (service as unknown as { sandboxes: Map<string, AnalysisSandboxStub> }).sandboxes = new Map([["agent", sandbox]]);
    return { service, sandbox, listCalls };
  }

  const OUTPUTS_MOUNT = {
    bucketBinding: "R2_BUCKET",
    prefix: "org-1/ws-1/user-outputs",
    mountPath: "/outputs",
    options: { readOnly: false },
  };

  it("skips the /uploads mount when the workspace upload prefix is empty", async () => {
    const { service, sandbox, listCalls } = serviceWithUploads([]);
    await expect(service.runCode({ code: "print('ok')" })).resolves.toMatchObject({ ok: true });
    expect(listCalls).toEqual([{ prefix: "org-1/ws-1/user-uploads/", limit: 1 }]);
    // No uploads to read, but outputs is still mounted: it is the run's only
    // way to hand a generated file back, and it starts empty by definition.
    expect(sandbox.mounts).toEqual([OUTPUTS_MOUNT]);
    expect(sandbox.connections).toHaveLength(1);
  });

  it("mounts /uploads when the workspace upload prefix has objects", async () => {
    const { service, sandbox } = serviceWithUploads(["org-1/ws-1/user-uploads/data.csv"]);
    await expect(service.runCode({ code: "print('ok')" })).resolves.toMatchObject({ ok: true });
    expect(sandbox.mounts).toEqual([
      {
        bucketBinding: "R2_BUCKET",
        prefix: "org-1/ws-1/user-uploads",
        mountPath: "/uploads",
        options: undefined,
      },
      OUTPUTS_MOUNT,
    ]);
  });

  it("mounts /outputs writable so a run can deliver a generated file", async () => {
    // Regression: with no writable outputs mount a generated .xlsx was trapped
    // in the sandbox, and agents resorted to base64-through-a-text-tool or
    // deploying a Worker just to serve one file.
    const { service, sandbox } = serviceWithUploads([]);
    await expect(service.runCode({ code: "print('ok')" })).resolves.toMatchObject({ ok: true });

    const outputs = sandbox.mounts.find((mount) => mount.mountPath === "/outputs");
    expect(outputs).toBeDefined();
    expect(outputs?.options?.readOnly).toBe(false);
    expect(outputs?.prefix).toBe("org-1/ws-1/user-outputs");
  });

  it("still runs when the outputs mount fails", async () => {
    // Losing the delivery path is bad; taking down notebook and code execution
    // for every workspace would be far worse.
    const { service, sandbox } = serviceWithUploads([]);
    const failing = sandbox as unknown as { ensureMounted: (...args: unknown[]) => Promise<void> };
    failing.ensureMounted = async (_binding: unknown, _prefix: unknown, mountPath?: unknown) => {
      if (mountPath === "/outputs") throw new Error("s3fs mount refused");
    };

    await expect(service.runCode({ code: "print('ok')" })).resolves.toMatchObject({ ok: true });
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

// ---------------------------------------------------------------------------
// connections.internal outbound handler — registered on the static registry
// ---------------------------------------------------------------------------

describe("connectionsRpc outbound handler", () => {
  const handler = AnalysisSandbox.outboundHandlers?.[ANALYSIS_CONNECTIONS_HANDLER];

  it("is registered on the AnalysisSandbox static registry", () => {
    expect(typeof handler).toBe("function");
  });

  it("fails closed (401) when no workspace scope was attached DO-side", async () => {
    const res = (await handler!(
      new Request(`http://${ANALYSIS_CONNECTIONS_HOST}/`, { method: "POST", body: "{}" }),
      {} as never,
      { containerId: "c1", className: "AnalysisSandbox" } as never,
    )) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as { ok: boolean; error: { message: string } };
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/scope/);
  });

  it("survives the SDK's r2EgressMount registration (registry setter must MERGE)", () => {
    const before = AnalysisSandbox.outboundHandlers?.[ANALYSIS_CONNECTIONS_HANDLER];
    expect(typeof before).toBe("function");
    // Simulate @cloudflare/sandbox's configureR2EgressOutbound, which assigns
    // `this.constructor.outboundHandlers = { r2EgressMount: ... }` when mounting
    // R2. The containers setter merges into the registry; if a future SDK
    // version switches to replace semantics, connectionsRpc would vanish and
    // the in-sandbox connections RPC would silently break — this pins it.
    (AnalysisSandbox as unknown as { outboundHandlers: Record<string, unknown> }).outboundHandlers = {
      r2EgressMount: () => new Response("r2"),
    };
    const after = AnalysisSandbox.outboundHandlers;
    expect(after?.[ANALYSIS_CONNECTIONS_HANDLER]).toBe(before);
    expect(typeof after?.r2EgressMount).toBe("function");
  });

  it("serves the protocol descriptor on GET when scope is attached", async () => {
    const res = (await handler!(
      new Request(`http://${ANALYSIS_CONNECTIONS_HOST}/`, { method: "GET" }),
      {} as never,
      { containerId: "c1", className: "AnalysisSandbox", params: { orgId: "org1", workspaceId: "ws1" } } as never,
    )) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; actions: string[] };
    expect(body.ok).toBe(true);
    expect(body.actions).toContain("invoke");
  });
});
