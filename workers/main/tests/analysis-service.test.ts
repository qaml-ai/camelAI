import { describe, expect, it, vi } from "vitest";

import {
  ANALYSIS_CONNECTIONS_HANDLER,
  ANALYSIS_CONNECTIONS_HOST,
  AnalysisSandbox,
} from "../src/analysis-sandbox.js";
import {
  AnalysisAppService,
  AnalysisExecutionBusyError,
  ANALYSIS_EXECUTION_QUEUE_MAX_WAITERS,
  AnalysisOperationDeadlineError,
  AnalysisService,
} from "../src/analysis-service.js";
import {
  ANALYSIS_MAX_CODE_BYTES,
  ANALYSIS_MAX_COMMAND_BYTES,
  ANALYSIS_MAX_DEPENDENCY_BYTES,
  ANALYSIS_MAX_DEPENDENCY_SPECS,
  ANALYSIS_MAX_ENV_BYTES,
  ANALYSIS_MAX_PARAMS_BYTES,
  ANALYSIS_MAX_PERSIST_BYTES,
  ANALYSIS_MAX_PERSIST_TOTAL_BYTES,
  ANALYSIS_MANIFEST_MAX_ENTRIES,
  ANALYSIS_MANIFEST_MAX_FILES,
  ANALYSIS_MANIFEST_MAX_PATH_BYTES,
  ANALYSIS_SESSION_RESTARTED_MESSAGE,
  isSandboxSessionDeathError,
  sandboxSessionExitCode,
  clampOutputTail,
  diffManifests,
  extractNotebookTraceback,
  normalizeAnalysisRelPath,
  notebookExecuteCommand,
  parseSha256Manifest,
  parseValidateNotebookOutput,
  runAnalysisCode,
  runAnalysisAddDependency,
  runAnalysisExec,
  runAnalysisNotebook,
  shouldIgnoreAnalysisPath,
  treeManifestCommand,
  validateNotebookCommand,
  __testing as analysisTesting,
  type AnalysisSandboxLike,
  type AnalysisSandboxStub,
} from "../src/analysis-service.js";
import type { WorkspaceFileStoreLike } from "../src/workspace-filesystem-do.js";

function fakeExecutionAdmission() {
  let owner: string | undefined;
  return {
    async acquireExecutionLease(request: { token: string; operation: string }) {
      if (owner) {
        return {
          acquired: false as const,
          reason: "busy" as const,
          retryAfterMs: 60_000,
        };
      }
      owner = request.token;
      return { acquired: true as const, deadlineAt: Date.now() + 60_000 };
    },
    async releaseExecutionLease(token: string) {
      if (owner !== token) return false;
      owner = undefined;
      return true;
    },
  };
}

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
  it("parses a complete producer-counted manifest", () => {
    const stdout = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa  ./analysis.ipynb",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  ./data/x.csv",
      "CAMELAI_MANIFEST_V1 2",
    ].join("\n");
    const manifest = parseSha256Manifest(stdout);
    expect(manifest.get("analysis.ipynb")).toBe("a".repeat(64));
    expect(manifest.get("data/x.csv")).toBe("b".repeat(64));
    expect(manifest.size).toBe(2);
  });

  it.each([
    [
      "malformed row",
      `${"a".repeat(64)}  ./a.py\ngarbage\nCAMELAI_MANIFEST_V1 1`,
    ],
    [
      "duplicate path",
      `${"a".repeat(64)}  ./a.py\n${"b".repeat(64)}  ./a.py\nCAMELAI_MANIFEST_V1 2`,
    ],
    ["wrong footer count", `${"a".repeat(64)}  ./a.py\nCAMELAI_MANIFEST_V1 2`],
    ["missing footer", `${"a".repeat(64)}  ./a.py`],
  ])("rejects a %s", (_label, stdout) => {
    expect(() => parseSha256Manifest(stdout)).toThrow(/manifest/);
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
    expect(parseValidateNotebookOutput("OK", 0)).toEqual({
      clean: true,
      issues: [],
    });
    expect(parseValidateNotebookOutput("", 0)).toEqual({
      clean: true,
      issues: [],
    });
  });
  it("collects issues on non-zero exit", () => {
    const out =
      "Cell 3 ERROR: NameError: name 'df' is not defined\nCell 5 WARNING: setup output";
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
    expect(validateNotebookCommand("a b.ipynb")).toBe(
      "validate-notebook 'a b.ipynb'",
    );
  });
  it("prunes heavy dirs in the tree manifest command", () => {
    const cmd = treeManifestCommand();
    expect(cmd).toContain("hashlib.sha256");
    expect(cmd).toContain(".venv");
    expect(cmd).toContain(String(ANALYSIS_MANIFEST_MAX_FILES));
    expect(cmd).toContain(String(ANALYSIS_MANIFEST_MAX_ENTRIES));
    expect(cmd).toContain(String(ANALYSIS_MANIFEST_MAX_PATH_BYTES));
    expect(cmd).toContain(String(ANALYSIS_MAX_PERSIST_BYTES));
    expect(cmd).toContain(String(ANALYSIS_MAX_PERSIST_TOTAL_BYTES));
    expect(cmd).toContain('"oversize:" + str(size)');
    expect(cmd).toContain("source.read(1)");
  });
});

describe("AnalysisSandbox.execBounded", () => {
  it("streams arbitrary commands through supervised bounded captures", async () => {
    const commands: string[] = [];
    const sessionOptionsSeen: unknown[] = [];
    const execOptionsSeen: unknown[] = [];
    let archived = new Uint8Array();
    const stdout = `${"x".repeat(200_000 - "stdout tail".length)}stdout tail`;
    const events = [
      { type: "start", timestamp: "now" },
      { type: "stdout", timestamp: "now", data: stdout },
      { type: "stderr", timestamp: "now", data: "stderr tail" },
      { type: "complete", timestamp: "now", exitCode: 7 },
    ];
    const execStream = vi.fn(async (command: string, options: unknown) => {
      commands.push(command);
      execOptionsSeen.push(options);
      return streamFromBytes(
        new TextEncoder().encode(
          events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        ),
      );
    });
    const target = {
      zombieHealTarget: {},
      sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
      createSession: vi.fn(async (options: { id: string }) => {
        sessionOptionsSeen.push(options);
        return { id: options.id, execStream };
      }),
      deleteSession: vi.fn(async (sessionId: string) => ({
        success: true,
        sessionId,
      })),
      writeFile: vi.fn(
        async (_path: string, content: ReadableStream<Uint8Array>) => {
          archived = await collectStreamBytes(content);
          return { success: true };
        },
      ),
      deleteFile: vi.fn(async () => ({ success: true })),
    };

    const result = await AnalysisSandbox.prototype.execBounded.call(
      target,
      "true ) >/dev/null; printf noisy #",
      { cwd: "/project", env: { CAPTURE_TEST: "safe" } },
      {
        stdoutBytes: 1_024,
        stderrBytes: 2_048,
        overflowPath: "/outputs/tmp/noisy.log",
        overflowBytes: 8_192,
      },
    );

    expect(result).toMatchObject({
      exitCode: 7,
      outputTruncated: true,
      overflowStored: true,
      overflowComplete: false,
      stdoutBytes: 200_000,
      stderrBytes: 11,
    });
    expect(result.overflowBytes).toBeGreaterThan(0);
    expect(result.overflowBytes).toBeLessThanOrEqual(8_192);
    expect(result.stdout).toContain("stdout tail");
    expect(result.stderr).toBe("stderr tail");
    expect(new TextDecoder().decode(archived)).toContain(
      "middle bytes omitted",
    );
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("/usr/bin/setsid /usr/bin/python3 -I -S -c");
    expect(commands[0]).toContain(
      'os.execve("/bin/bash", ["bash", "-lc", command], os.environ)',
    );
    expect(commands[0]).not.toContain("true ) >/dev/null; printf noisy #");
    expect(sessionOptionsSeen).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^bounded-/),
        cwd: "/project",
        env: expect.not.objectContaining({ CAPTURE_TEST: "safe" }),
        commandTimeoutMs: expect.any(Number),
      }),
    ]);
    const sessionEnvironment = (
      sessionOptionsSeen[0] as { env: Record<string, string> }
    ).env;
    expect(Object.values(sessionEnvironment)).toContain(
      "true ) >/dev/null; printf noisy #",
    );
    expect(
      Object.values(sessionEnvironment).some((value) => {
        try {
          return JSON.parse(value).CAPTURE_TEST === "safe";
        } catch {
          return false;
        }
      }),
    ).toBe(true);
    expect(execOptionsSeen).toEqual([
      expect.objectContaining({
        signal: expect.any(AbortSignal),
      }),
    ]);
    expect(target.deleteSession).toHaveBeenCalledWith(
      expect.stringMatching(/^bounded-/),
    );
    expect(target.writeFile).toHaveBeenCalledWith(
      "/outputs/tmp/noisy.log",
      expect.any(ReadableStream),
    );
  });

  it("keeps caller shell-control variables inside the supervised child", async () => {
    const execStream = vi.fn(async () =>
      streamFromBytes(
        new TextEncoder().encode(
          `data: ${JSON.stringify({ type: "complete", exitCode: 0 })}\n\n`,
        ),
      ),
    );
    let created:
      | { env: Record<string, string>; id: string; commandTimeoutMs: number }
      | undefined;
    const target = {
      zombieHealTarget: {},
      sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
      createSession: vi.fn(
        async (options: {
          env: Record<string, string>;
          id: string;
          commandTimeoutMs: number;
        }) => {
          created = options;
          return { id: options.id, execStream };
        },
      ),
      deleteSession: vi.fn(async (sessionId: string) => ({
        success: true,
        sessionId,
      })),
    };

    await AnalysisSandbox.prototype.execBounded.call(
      target,
      "printf safe",
      {
        env: {
          PATH: "/project/attacker-controlled",
          BASH_ENV: "/project/startup.sh",
          ENV: "/project/other-startup.sh",
        },
      },
      { stdoutBytes: 1024, stderrBytes: 1024 },
    );

    expect(created).toBeDefined();
    expect(created!.env).not.toHaveProperty("PATH");
    expect(created!.env).not.toHaveProperty("BASH_ENV");
    expect(created!.env).not.toHaveProperty("ENV");
    expect(Object.values(created!.env)).toContain("printf safe");
    const decoded = Object.values(created!.env)
      .map((value) => {
        try {
          return JSON.parse(value) as unknown;
        } catch {
          return undefined;
        }
      })
      .find(
        (value): value is Record<string, string> =>
          !!value && typeof value === "object" && !Array.isArray(value),
      );
    expect(decoded).toEqual({
      BASH_ENV: "/project/startup.sh",
      ENV: "/project/other-startup.sh",
      PATH: "/project/attacker-controlled",
    });
    const [supervisor] = execStream.mock.calls[0];
    expect(supervisor).toContain("/usr/bin/setsid /usr/bin/python3 -I -S -c");
    expect(supervisor).toContain("/bin/sleep 0.1");
  });

  it("rejects oversized commands before starting the execution stream", async () => {
    const target = { createSession: vi.fn() };
    await expect(
      AnalysisSandbox.prototype.execBounded.call(
        target,
        "x".repeat(64 * 1024 + 1),
        undefined,
        { stdoutBytes: 1024, stderrBytes: 1024 },
      ),
    ).rejects.toThrow(/65536 byte limit/);
    expect(target.createSession).not.toHaveBeenCalled();
  });

  it("accepts the SDK's real one-megabyte single-event wire shape", async () => {
    const output = `${"A".repeat(1024 * 1024)}\n`;
    const execStream = vi.fn(async () =>
      streamFromBytes(
        new TextEncoder().encode(
          [
            `data: ${JSON.stringify({ type: "start", timestamp: "now" })}\n\n`,
            `data: ${JSON.stringify({ type: "stdout", timestamp: "now", data: output })}\n\n`,
            `data: ${JSON.stringify({ type: "complete", timestamp: "now", exitCode: 0 })}\n\n`,
          ].join(""),
        ),
      ),
    );
    const target = {
      zombieHealTarget: {},
      sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
      createSession: vi.fn(async (options: { id: string }) => ({
        id: options.id,
        execStream,
      })),
      deleteSession: vi.fn(async (sessionId: string) => ({
        success: true,
        sessionId,
      })),
    };

    const result = await AnalysisSandbox.prototype.execBounded.call(
      target,
      "python -c 'print(1)'",
      undefined,
      { stdoutBytes: 1024, stderrBytes: 1024 },
    );

    expect(result).toMatchObject({
      success: true,
      stdoutBytes: 1024 * 1024 + 1,
      outputTruncated: true,
    });
    expect(result.stdout.endsWith(`${"A".repeat(1023)}\n`)).toBe(true);
    expect(target.deleteSession).toHaveBeenCalledOnce();
  });

  it.each([
    ["malformed", "data: {definitely-not-json}\n\n"],
    ["oversized", `data: ${"x".repeat(5 * 1024 * 1024)}\n\n`],
    ["UTF-8-byte-oversized", `data: ${"😀".repeat(1_070_000)}\n\n`],
  ])(
    "rejects a %s SSE frame and still deletes its session",
    async (_label, wire) => {
      const execStream = vi.fn(async () =>
        streamFromBytes(new TextEncoder().encode(wire)),
      );
      const target = {
        zombieHealTarget: {},
        sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
        createSession: vi.fn(async (options: { id: string }) => ({
          id: options.id,
          execStream,
        })),
        deleteSession: vi.fn(async (sessionId: string) => ({
          success: true,
          sessionId,
        })),
      };

      await expect(
        AnalysisSandbox.prototype.execBounded.call(target, "true", undefined, {
          stdoutBytes: 1024,
          stderrBytes: 1024,
        }),
      ).rejects.toThrow(/invalid SSE metadata|frame exceeded/);
      expect(target.deleteSession).toHaveBeenCalledOnce();
    },
  );

  it("bounds a hung session acquisition with immediate confirmed generation reset", async () => {
    vi.useFakeTimers();
    try {
      let resolveCreation!: (session: {
        id: string;
        execStream: ReturnType<typeof vi.fn>;
      }) => void;
      const creation = new Promise<{
        id: string;
        execStream: ReturnType<typeof vi.fn>;
      }>((resolve) => {
        resolveCreation = resolve;
      });
      let requestedId = "";
      const state = new Map<string, unknown>();
      const events: string[] = [];
      const target = {
        ctx: {
          storage: {
            kv: {
              get: (key: string) => state.get(key),
              put: (key: string, value: unknown) => {
                events.push("mark");
                state.set(key, value);
              },
              delete: (key: string) => {
                events.push("clear");
                state.delete(key);
              },
            },
          },
        },
        zombieHealTarget: {},
        sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
        createSession: vi.fn((options: { id: string }) => {
          requestedId = options.id;
          return creation;
        }),
        deleteSession: vi.fn(async (sessionId: string) => ({
          success: true,
          sessionId,
        })),
        destroyAndForgetContainerGeneration: vi.fn(async () => {
          events.push("reset");
        }),
      };

      const pending = AnalysisSandbox.prototype.execBounded.call(
        target,
        "true",
        { timeout: 1000 },
        { stdoutBytes: 1024, stderrBytes: 1024 },
      );
      await vi.advanceTimersByTimeAsync(1000);
      await expect(pending).resolves.toMatchObject({
        exitCode: 124,
        success: false,
      });
      expect(target.destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
      expect(events).toEqual(["mark", "reset", "clear"]);
      expect(state.size).toBe(0);

      const execStream = vi.fn();
      resolveCreation({ id: requestedId, execStream });
      await vi.advanceTimersByTimeAsync(0);
      expect(execStream).not.toHaveBeenCalled();
      // The resolved reset, not an eviction-fragile detached `.then`, fences
      // this wrapper from dispatching through a late acquisition response. The
      // SDK has no cancellation/generation acknowledgement, so this does not
      // claim that the platform cannot later materialize an unused session.
      expect(target.deleteSession).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes the unique session and cancels its stream at the absolute timeout", async () => {
    vi.useFakeTimers();
    try {
      const cancel = vi.fn();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "start", timestamp: "now" })}\n\n`,
            ),
          );
        },
        cancel,
      });
      const execStream = vi.fn(async () => stream);
      const target = {
        zombieHealTarget: {},
        sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
        createSession: vi.fn(async (options: { id: string }) => ({
          id: options.id,
          execStream,
        })),
        deleteSession: vi.fn(async (sessionId: string) => ({
          success: true,
          sessionId,
        })),
      };

      const pending = AnalysisSandbox.prototype.execBounded.call(
        target,
        "sleep forever & wait",
        { timeout: 1000 },
        { stdoutBytes: 1024, stderrBytes: 1024 },
      );
      await vi.advanceTimersByTimeAsync(1000);

      await expect(pending).resolves.toMatchObject({
        exitCode: 124,
        success: false,
      });
      expect(cancel).toHaveBeenCalledOnce();
      expect(target.deleteSession).toHaveBeenCalledWith(
        expect.stringMatching(/^bounded-/),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails explicitly when timeout cleanup cannot confirm process termination", async () => {
    vi.useFakeTimers();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              `data: ${JSON.stringify({ type: "start", timestamp: "now" })}\n\n`,
            ),
          );
        },
      });
      const execStream = vi.fn(async () => stream);
      const target = {
        zombieHealTarget: {},
        sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
        createSession: vi.fn(async (options: { id: string }) => ({
          id: options.id,
          execStream,
        })),
        deleteSession: vi.fn(() => new Promise<never>(() => {})),
      };

      const pending = AnalysisSandbox.prototype.execBounded.call(
        target,
        "sleep forever",
        { timeout: 1000 },
        { stdoutBytes: 1024, stderrBytes: 1024 },
      );
      const rejection = expect(pending).rejects.toThrow(
        /process termination is unconfirmed/,
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(target.deleteSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves the bounded result when timed-out session deletion is followed by a confirmed container reset", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const execStream = vi.fn(async () =>
        streamFromBytes(
          new TextEncoder().encode(
            [
              `data: ${JSON.stringify({ type: "stdout", data: "original output" })}\n\n`,
              `data: ${JSON.stringify({ type: "complete", exitCode: 7 })}\n\n`,
            ].join(""),
          ),
        ),
      );
      const destroyAndForgetContainerGeneration = vi.fn(async () => undefined);
      const target = {
        zombieHealTarget: {},
        sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
        createSession: vi.fn(async (options: { id: string }) => ({
          id: options.id,
          execStream,
        })),
        deleteSession: vi.fn(() => new Promise<never>(() => {})),
        destroyAndForgetContainerGeneration,
      };

      const pending = AnalysisSandbox.prototype.execBounded.call(
        target,
        "exit 7",
        undefined,
        { stdoutBytes: 1024, stderrBytes: 1024 },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(target.deleteSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);

      await expect(pending).resolves.toMatchObject({
        success: false,
        exitCode: 7,
        stdout: "original output",
      });
      expect(destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("preserves the original stream error when failed session deletion is followed by a confirmed container reset", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const execStream = vi.fn(async () =>
        streamFromBytes(
          new TextEncoder().encode("data: {definitely-not-json}\n\n"),
        ),
      );
      const destroyAndForgetContainerGeneration = vi.fn(async () => undefined);
      const target = {
        zombieHealTarget: {},
        sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
        createSession: vi.fn(async (options: { id: string }) => ({
          id: options.id,
          execStream,
        })),
        deleteSession: vi.fn(async () => ({ success: false })),
        destroyAndForgetContainerGeneration,
      };

      await expect(
        AnalysisSandbox.prototype.execBounded.call(target, "true", undefined, {
          stdoutBytes: 1024,
          stderrBytes: 1024,
        }),
      ).rejects.toThrow(/invalid SSE metadata/);
      expect(destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
    } finally {
      warning.mockRestore();
    }
  });

  it("resets an uncertain failed archive writer before exact R2 cleanup", async () => {
    const output = "x".repeat(20_000);
    const execStream = vi.fn(async () =>
      streamFromBytes(
        new TextEncoder().encode(
          [
            `data: ${JSON.stringify({ type: "stdout", data: output })}\n\n`,
            `data: ${JSON.stringify({ type: "complete", exitCode: 0 })}\n\n`,
          ].join(""),
        ),
      ),
    );
    const state = new Map<string, unknown>();
    const deleteObject = vi.fn(async () => undefined);
    const target = {
      ctx: {
        storage: {
          kv: {
            get: (key: string) => state.get(key),
            put: (key: string, value: unknown) => state.set(key, value),
            delete: (key: string) => state.delete(key),
          },
        },
      },
      env: { R2_OUTPUTS_BUCKET: { delete: deleteObject } },
      zombieHealTarget: {},
      sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
      createSession: vi.fn(async (options: { id: string }) => ({
        id: options.id,
        execStream,
      })),
      deleteSession: vi.fn(async (sessionId: string) => ({
        success: true,
        sessionId,
      })),
      writeFile: vi.fn(async () => ({ success: false })),
      destroyAndForgetContainerGeneration: vi.fn(async () => undefined),
    };

    const result = await AnalysisSandbox.prototype.execBounded.call(
      target,
      "true",
      undefined,
      {
        stdoutBytes: 1024,
        stderrBytes: 1024,
        overflowPath: "/outputs/tmp/failed.log",
        overflowObjectKey: "org/ws/user-outputs/tmp/failed.log",
        overflowBytes: 8192,
      },
    );
    await Promise.resolve();

    expect(result).toMatchObject({
      outputTruncated: true,
      overflowStored: false,
    });
    expect(target.destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
    expect(deleteObject).toHaveBeenCalledWith(
      "org/ws/user-outputs/tmp/failed.log",
    );
    expect(state.has("analysis:execution-archive-taint:v1")).toBe(false);
  });

  it("keeps a successful archive tainted until its owning lease acknowledges the reference", async () => {
    const output = "x".repeat(20_000);
    const ownerToken = "11111111-1111-4111-8111-111111111111";
    const state = new Map<string, unknown>([
      [
        "analysis:execution-lease:v1",
        {
          token: ownerToken,
          operation: "exec",
          deadlineAt: Date.now() + 60_000,
          state: "active",
        },
      ],
    ]);
    const target = {
      ctx: {
        storage: {
          kv: {
            get: (key: string) => state.get(key),
            put: (key: string, value: unknown) => state.set(key, value),
            delete: (key: string) => state.delete(key),
          },
        },
      },
      zombieHealTarget: {},
      sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
      createSession: vi.fn(async (options: { id: string }) => ({
        id: options.id,
        execStream: vi.fn(async () =>
          streamFromBytes(
            new TextEncoder().encode(
              [
                `data: ${JSON.stringify({ type: "stdout", data: output })}\n\n`,
                `data: ${JSON.stringify({ type: "complete", exitCode: 0 })}\n\n`,
              ].join(""),
            ),
          ),
        ),
      })),
      deleteSession: vi.fn(async () => ({ success: true })),
      writeFile: vi.fn(async () => ({ success: true })),
    };

    const result = await AnalysisSandbox.prototype.execBounded.call(
      target,
      "true",
      undefined,
      {
        stdoutBytes: 1024,
        stderrBytes: 1024,
        overflowPath: "/outputs/tmp/staged.log",
        overflowObjectKey: "org/ws/user-outputs/tmp/staged.log",
        executionOwnerToken: ownerToken,
        overflowBytes: 8192,
      },
    );
    expect(result).toMatchObject({
      overflowStored: true,
      overflowTaintToken: expect.any(String),
    });
    expect(state.get("analysis:execution-archive-taint:v1")).toMatchObject({
      ownerToken,
      token: result.overflowTaintToken,
      resource: "org/ws/user-outputs/tmp/staged.log",
    });
    await expect(
      AnalysisSandbox.prototype.releaseExecutionLease.call(target, ownerToken),
    ).resolves.toBe(false);

    await expect(
      AnalysisSandbox.prototype.acknowledgeBoundedExecArchive.call(target, {
        ownerToken,
        taintToken: result.overflowTaintToken,
        objectKey: "org/ws/user-outputs/tmp/staged.log",
      }),
    ).resolves.toBe(true);
    expect(state.has("analysis:execution-archive-taint:v1")).toBe(false);
    await expect(
      AnalysisSandbox.prototype.releaseExecutionLease.call(target, ownerToken),
    ).resolves.toBe(true);
  });

  it("fails closed with durable taint when exact cleanup of a failed archive hangs", async () => {
    vi.useFakeTimers();
    try {
      const output = "x".repeat(20_000);
      const execStream = vi.fn(async () =>
        streamFromBytes(
          new TextEncoder().encode(
            [
              `data: ${JSON.stringify({ type: "stdout", data: output })}\n\n`,
              `data: ${JSON.stringify({ type: "complete", exitCode: 0 })}\n\n`,
            ].join(""),
          ),
        ),
      );
      const state = new Map<string, unknown>();
      const deleteObject = vi.fn(() => new Promise<never>(() => {}));
      const target = {
        ctx: {
          storage: {
            kv: {
              get: (key: string) => state.get(key),
              put: (key: string, value: unknown) => state.set(key, value),
              delete: (key: string) => state.delete(key),
            },
          },
        },
        env: { R2_OUTPUTS_BUCKET: { delete: deleteObject } },
        zombieHealTarget: {},
        sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
        createSession: vi.fn(async (options: { id: string }) => ({
          id: options.id,
          execStream,
        })),
        deleteSession: vi.fn(async (sessionId: string) => ({
          success: true,
          sessionId,
        })),
        writeFile: vi.fn(async () => ({ success: false })),
        destroyAndForgetContainerGeneration: vi.fn(async () => undefined),
      };

      const pending = AnalysisSandbox.prototype.execBounded.call(
        target,
        "true",
        undefined,
        {
          stdoutBytes: 1024,
          stderrBytes: 1024,
          overflowPath: "/outputs/tmp/delete-hung.log",
          overflowObjectKey: "org/ws/user-outputs/tmp/delete-hung.log",
          overflowBytes: 8192,
        },
      );
      const rejection = expect(pending).rejects.toThrow(
        /archive object cleanup was unconfirmed/,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(target.destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
      expect(deleteObject).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(5_000);

      await rejection;
      expect(state.has("analysis:execution-archive-taint:v1")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fences a timed-out archive writer before deleting its exact R2 object", async () => {
    vi.useFakeTimers();
    try {
      const output = "x".repeat(20_000);
      const execStream = vi.fn(async () =>
        streamFromBytes(
          new TextEncoder().encode(
            [
              `data: ${JSON.stringify({ type: "stdout", data: output })}\n\n`,
              `data: ${JSON.stringify({ type: "complete", exitCode: 0 })}\n\n`,
            ].join(""),
          ),
        ),
      );
      let resolveWrite!: (result: { success: boolean }) => void;
      const state = new Map<string, unknown>();
      const events: string[] = [];
      const target = {
        ctx: {
          storage: {
            kv: {
              get: (key: string) => state.get(key),
              put: (key: string, value: unknown) => {
                events.push("mark");
                state.set(key, value);
              },
              delete: (key: string) => {
                events.push("clear");
                state.delete(key);
              },
            },
          },
        },
        env: {
          R2_OUTPUTS_BUCKET: {
            delete: vi.fn(async () => {
              events.push("r2-delete");
            }),
          },
        },
        zombieHealTarget: {},
        sessionDeaths: { reset: vi.fn(), record: vi.fn(() => 1) },
        createSession: vi.fn(async (options: { id: string }) => ({
          id: options.id,
          execStream,
        })),
        deleteSession: vi.fn(async (sessionId: string) => ({
          success: true,
          sessionId,
        })),
        writeFile: vi.fn(
          () =>
            new Promise<{ success: boolean }>((resolve) => {
              resolveWrite = resolve;
            }),
        ),
        deleteFile: vi.fn(async () => ({ success: true })),
        destroyAndForgetContainerGeneration: vi.fn(async () => {
          events.push("reset");
        }),
      };

      const pending = AnalysisSandbox.prototype.execBounded.call(
        target,
        "true",
        undefined,
        {
          stdoutBytes: 1024,
          stderrBytes: 1024,
          overflowPath: "/outputs/tmp/late.log",
          overflowObjectKey: "org/ws/user-outputs/tmp/late.log",
          overflowBytes: 8192,
        },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(target.writeFile).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(10_000);
      await expect(pending).resolves.toMatchObject({ overflowStored: false });
      expect(events).toEqual([
        "mark", // session write-ahead marker
        "clear",
        "mark", // archive write-ahead marker
        "reset",
        "r2-delete",
        "clear",
      ]);
      expect(target.deleteFile).not.toHaveBeenCalled();

      resolveWrite({ success: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(events).toEqual([
        "mark",
        "clear",
        "mark",
        "reset",
        "r2-delete",
        "clear",
      ]);
    } finally {
      vi.useRealTimers();
    }
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

async function collectStreamBytes(
  stream: ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
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
  io: {
    bufferedReads: number;
    bufferedWrites: number;
    streamReads: number;
    streamAdoptions: number;
  };
} {
  const store = new Map(Object.entries(initial));
  const io = {
    bufferedReads: 0,
    bufferedWrites: 0,
    streamReads: 0,
    streamAdoptions: 0,
  };
  const norm = (p: string) => p.replace(/^\/+/, "");
  return {
    store,
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
      return {
        success: true,
        content: store.get(rel) as string,
        encoding: "utf8" as const,
      };
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
    async adoptR2File(
      path: string,
      stream: ReadableStream<Uint8Array>,
      expectedSize: number,
    ) {
      io.streamAdoptions += 1;
      const bytes = await collectStreamBytes(stream);
      if (bytes.byteLength !== expectedSize) {
        return { success: false, error: "stream size mismatch" };
      }
      store.set(norm(path), new TextDecoder().decode(bytes));
      return { success: true, size: bytes.byteLength };
    },
    async deleteFile(path: string) {
      if (opts?.failDelete)
        return { success: false, error: "simulated storage failure" };
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
    io: {
      bufferedReads: number;
      bufferedWrites: number;
      streamReads: number;
      streamAdoptions: number;
    };
  };
}

/**
 * Fake AnalysisSandbox: an in-memory filesystem the exec'd commands operate on.
 * It understands just enough — the write/read/mkdir file ops, the wipe glob, the
 * notebook-execute command (mutates the notebook + emits a chart PNG), the
 * validator, and the sha256sum tree manifest — to drive the persist-back path.
 */
function fakeSandbox(opts?: {
  failManifest?: boolean;
  removeOnRun?: string;
  notebookFailure?: { stderr: string };
  createOnRun?: { command: string; path: string; bytes: Uint8Array };
}): AnalysisSandboxLike & { execCwds: string[] } {
  const execCwds: string[] = [];
  const fs = new Map<string, Uint8Array>();
  const sha = async (bytes: Uint8Array) => {
    const digest = await crypto.subtle.digest(
      "SHA-256",
      bytes as unknown as ArrayBuffer,
    );
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  };
  const rel = (workdir: string, abs: string) => abs.slice(workdir.length + 1);
  const sandbox: AnalysisSandboxLike & { execCwds: string[] } = {
    execCwds,
    async mkdir() {
      return {};
    },
    async writeFile(
      path: string,
      content: string | ReadableStream<Uint8Array>,
      options?: { encoding?: string },
    ) {
      const bytes =
        typeof content === "string"
          ? options?.encoding === "base64"
            ? new Uint8Array(Buffer.from(content, "base64"))
            : new TextEncoder().encode(content)
          : await collectStreamBytes(content);
      fs.set(path, bytes);
      return {};
    },
    async readFile(path: string, options?: { encoding?: string }) {
      const bytes = fs.get(path);
      if (!bytes) throw new Error(`missing ${path}`);
      if (options?.encoding === "none") {
        return {
          content: streamFromBytes(bytes),
          size: bytes.byteLength,
          mimeType: "application/octet-stream",
        };
      }
      return { content: Buffer.from(bytes).toString("base64") };
    },
    async exec(command: string, options?: { cwd?: string }) {
      const cwd = options?.cwd ?? "/";
      execCwds.push(cwd);
      // Run-workdir cleanup: drop everything under the removed tree.
      if (command.startsWith("rm -rf ")) {
        const target = command
          .slice("rm -rf ".length)
          .replace(/^-- /, "")
          .replace(/'/g, "");
        for (const key of fs.keys())
          if (key.startsWith(`${target}/`)) fs.delete(key);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Wipe glob before materialize: drop all files under cwd.
      if (command.startsWith("find . -mindepth 1")) {
        for (const key of fs.keys())
          if (key.startsWith(`${cwd}/`)) fs.delete(key);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Notebook execution: mark the notebook executed and emit a chart artifact.
      if (command.includes("execute-notebook")) {
        if (opts?.notebookFailure) {
          return {
            exitCode: 1,
            stdout: "",
            stderr: opts.notebookFailure.stderr,
          };
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
      if (opts?.createOnRun && command === opts.createOnRun.command) {
        fs.set(`${cwd}/${opts.createOnRun.path}`, opts.createOnRun.bytes);
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      // Tree manifest: sha256 over the in-memory fs under cwd (skip ignored).
      if (command.includes("hashlib.sha256")) {
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
        lines.push(`CAMELAI_MANIFEST_V1 ${lines.length}`);
        return { exitCode: 0, stdout: lines.join("\n"), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    async execBounded(command, options, limits) {
      const result = await sandbox.exec(command, options);
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      const stdoutBytes = new TextEncoder().encode(stdout).byteLength;
      const stderrBytes = new TextEncoder().encode(stderr).byteLength;
      const boundedStdout =
        stdoutBytes > limits.stdoutBytes
          ? stdout.slice(-limits.stdoutBytes)
          : stdout;
      const boundedStderr =
        stderrBytes > limits.stderrBytes
          ? stderr.slice(-limits.stderrBytes)
          : stderr;
      return {
        ...result,
        success: result.exitCode === 0,
        stdout: boundedStdout,
        stderr: boundedStderr,
        stdoutBytes,
        stderrBytes,
        outputTruncated:
          stdoutBytes > limits.stdoutBytes || stderrBytes > limits.stderrBytes,
        overflowStored: false,
        overflowComplete: false,
        overflowBytes: 0,
      };
    },
  };
  return sandbox;
}

describe("runAnalysisNotebook", () => {
  it("executes, validates, and persists the changed set back to the project FS", async () => {
    const files = fakeFiles({
      "analysis.ipynb": '{"cells":[]}',
      "data.csv": "a,b\n1,2\n",
    });
    const result = await runAnalysisNotebook(
      { path: "analysis.ipynb" },
      {
        sandbox: fakeSandbox(),
        files,
        projectId: "ca-test-proj",
        newRunId: () => "run1",
      },
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
    expect(
      new TextDecoder().decode(
        new TextEncoder().encode(files.store.get("analysis.ipynb")),
      ),
    ).toContain("executed");
  });

  it("rejects a path that is not a .ipynb", async () => {
    const files = fakeFiles({ "script.py": "print(1)" });
    const result = await runAnalysisNotebook(
      { path: "script.py" },
      {
        sandbox: fakeSandbox(),
        files,
        projectId: "ca-test-proj",
        newRunId: () => "run1",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/\.ipynb/);
  });

  it("fails when the notebook is not in the project", async () => {
    const files = fakeFiles({ "other.ipynb": "{}" });
    const result = await runAnalysisNotebook(
      { path: "missing.ipynb" },
      {
        sandbox: fakeSandbox(),
        files,
        projectId: "ca-test-proj",
        newRunId: () => "run1",
      },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not found/);
  });

  it("gives concurrent runs on the same project isolated per-run workdirs", async () => {
    const sandbox = fakeSandbox();
    const files = fakeFiles({ "analysis.ipynb": '{"cells":[]}' });
    let counter = 0;
    const deps = {
      sandbox,
      files,
      projectId: "ca-test-proj",
      newRunId: () => `run${++counter}`,
    };

    const [a, b] = await Promise.all([
      runAnalysisNotebook({ path: "analysis.ipynb" }, deps),
      runAnalysisNotebook({ path: "analysis.ipynb" }, deps),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);

    const nbconvertCwds = sandbox.execCwds.filter((cwd) =>
      cwd.includes("/runs/"),
    );
    const distinctRunDirs = new Set(
      nbconvertCwds.map((cwd) => cwd.match(/\/runs\/[^/]+/)?.[0]),
    );
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

  it("keeps the traceback in error and the bounded stderr tail on failure", async () => {
    const noise = "progress line\n".repeat(5000); // ~70KB of leading noise
    const stderr =
      `${noise}Traceback (most recent call last):\n` +
      '  File "cell", line 1, in <module>\n' +
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
    expect(result.error).toContain(
      "NameError: name 'undefined_var' is not defined",
    );
    // The producer returns only the bounded tail; the traceback survives.
    expect(result.stderr).not.toBe(stderr);
    expect(result.stderr.length).toBeLessThanOrEqual(20_000);
    expect(result.stderr).toContain(
      "NameError: name 'undefined_var' is not defined",
    );
  });
});

describe("persist safety", () => {
  it.each([
    ["missing", undefined, new Uint8Array([1, 2, 3])],
    ["larger", 3, new Uint8Array([1, 2, 3, 4])],
    ["shorter", 3, new Uint8Array([1, 2])],
  ])(
    "rejects a %s source-stream size instead of trusting the listing",
    async (_label, size, bytes) => {
      const files = fakeFiles({ "a.txt": "abc" });
      files.readFileStream = async () => ({
        success: true,
        stream: streamFromBytes(bytes),
        ...(size === undefined ? {} : { size }),
      });
      await expect(
        analysisTesting.materializeProject(
          fakeSandbox(),
          "/projects/p/runs/unique",
          files,
        ),
      ).rejects.toThrow(/changed size|listed byte size|listed bytes/);
    },
  );

  it("rejects source trees beyond the entry and aggregate-byte ceilings", async () => {
    const entry = (index: number, size: number) => ({
      name: `f${index}`,
      type: "file" as const,
      size,
      modifiedAt: "",
      relativePath: `f${index}`,
      absolutePath: `/f${index}`,
    });
    const storeWith = (entries: ReturnType<typeof entry>[]) =>
      ({
        listFiles: async () => ({
          success: true,
          path: "/",
          count: entries.length,
          files: entries,
        }),
      }) as unknown as WorkspaceFileStoreLike;

    await expect(
      analysisTesting.collectProjectSourceFiles(
        storeWith(
          Array.from({ length: ANALYSIS_MANIFEST_MAX_ENTRIES + 1 }, (_, i) =>
            entry(i, 1),
          ),
        ),
      ),
    ).rejects.toThrow(/entry limit/);
    await expect(
      analysisTesting.collectProjectSourceFiles(
        storeWith(
          Array.from({ length: 11 }, (_, i) =>
            entry(i, ANALYSIS_MAX_PERSIST_BYTES),
          ),
        ),
      ),
    ).rejects.toThrow(/aggregate analysis source byte limit/);
  });

  it("asks the file producer to enforce the source bounds before returning an array", async () => {
    const listFiles = vi.fn(async () => ({
      success: true,
      path: "/",
      count: 0,
      files: [],
    }));
    await analysisTesting.collectProjectSourceFiles({
      listFiles,
    } as unknown as WorkspaceFileStoreLike);
    expect(listFiles).toHaveBeenCalledWith(
      "/",
      expect.objectContaining({
        limit: ANALYSIS_MANIFEST_MAX_ENTRIES + 1,
        bounds: expect.objectContaining({
          maxEntries: ANALYSIS_MANIFEST_MAX_ENTRIES,
          maxFiles: ANALYSIS_MANIFEST_MAX_FILES,
          maxFileBytes: ANALYSIS_MAX_PERSIST_BYTES,
        }),
      }),
    );
  });

  it("enforces one aggregate byte budget across all persisted output files", async () => {
    const changed = Array.from(
      { length: 11 },
      (_, index) => `changed-${index}.bin`,
    );
    const manifest = [
      ...changed.map((path) => `${"a".repeat(64)}  ./${path}`),
      `CAMELAI_MANIFEST_V1 ${changed.length}`,
    ].join("\n");
    const sandbox = {
      execBounded: vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: manifest,
        stderr: "",
        outputTruncated: false,
      })),
      readFile: vi.fn(async () => ({
        content: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        }),
        size: ANALYSIS_MAX_PERSIST_BYTES,
      })),
    } as unknown as AnalysisSandboxLike;
    const adoptR2File = vi.fn(async () => ({ success: true }));
    const files = {
      adoptR2File,
      deleteFile: vi.fn(async () => ({ success: true })),
    } as unknown as WorkspaceFileStoreLike;

    await expect(
      analysisTesting.persistChangedFiles(
        sandbox,
        "/projects/p/runs/one",
        files,
        new Map(),
      ),
    ).rejects.toThrow(
      `${ANALYSIS_MAX_PERSIST_TOTAL_BYTES} aggregate-byte limit`,
    );
    expect(adoptR2File).toHaveBeenCalledTimes(10);
  });

  it("aborts a stalled persistence stream at the absolute persist deadline", async () => {
    const manifest = `${"a".repeat(64)}  ./changed.bin\nCAMELAI_MANIFEST_V1 1`;
    let streamCanceled = false;
    const sandbox = {
      execBounded: vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: manifest,
        stderr: "",
        outputTruncated: false,
      })),
      readFile: vi.fn(async () => ({
        content: new ReadableStream<Uint8Array>({
          pull() {},
          cancel() {
            streamCanceled = true;
          },
        }),
        size: 1,
      })),
    } as unknown as AnalysisSandboxLike;
    const files = {
      adoptR2File: vi.fn(() => new Promise<never>(() => {})),
      deleteFile: vi.fn(async () => ({ success: true })),
    } as unknown as WorkspaceFileStoreLike;

    await expect(
      analysisTesting.persistChangedFiles(
        sandbox,
        "/projects/p/runs/one",
        files,
        new Map(),
        20,
      ),
    ).rejects.toThrow(/persist deadline exceeded/);
    await Promise.resolve();
    expect(streamCanceled).toBe(true);
  });

  it("uses source-bounded execution and surfaces the overflow reference", async () => {
    const sandbox = fakeSandbox();
    const execBounded = vi.fn(async () => ({
      success: true,
      exitCode: 0,
      stdout: "[... earlier bytes truncated ...]\nstdout tail",
      stderr: "stderr tail",
      stdoutBytes: 10_000_000,
      stderrBytes: 11,
      outputTruncated: true,
      overflowStored: true,
      overflowComplete: false,
      overflowBytes: 900_000,
    }));
    sandbox.execBounded = execBounded;

    const result = await runAnalysisExec(
      { command: "produce-lots-of-output" },
      {
        sandbox,
        files: fakeFiles({}),
        projectId: "scratch",
        newRunId: () => "run1",
        hasProject: false,
        scratchId: "scratch1",
        outputCaptureBytes: 1024 * 1024,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain("stdout tail");
    expect(result.fullOutput).toMatchObject({
      path: expect.stringMatching(/^outputs\/tmp\/.*analysis-exec.*\.log$/),
    });
    expect(execBounded).toHaveBeenCalledWith(
      "produce-lots-of-output",
      expect.objectContaining({ cwd: expect.stringContaining("scratch1") }),
      expect.objectContaining({
        stdoutBytes: 96 * 1024,
        stderrBytes: 96 * 1024,
        overflowPath: expect.stringMatching(/^\/outputs\/tmp\//),
        overflowBytes: 1024 * 1024,
      }),
    );
  });

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
    const files = fakeFiles({
      "analysis.ipynb": '{"cells":[]}',
      "keep.csv": "a,b\n",
    });
    await expect(
      runAnalysisNotebook(
        { path: "analysis.ipynb" },
        {
          sandbox: fakeSandbox({ failManifest: true }),
          files,
          projectId: "ca-test-proj",
          newRunId: () => "run1",
        },
      ),
    ).rejects.toThrow(/tree manifest failed/);
    // Nothing was deleted from the project store by the failed run.
    expect(files.store.has("keep.csv")).toBe(true);
    expect(files.store.has("analysis.ipynb")).toBe(true);
  });

  it("never diffs a producer-truncated tree manifest", async () => {
    const files = fakeFiles({
      "analysis.ipynb": '{"cells":[]}',
      "keep.csv": "a,b\n",
    });
    const sandbox = fakeSandbox();
    const bounded = sandbox.execBounded.bind(sandbox);
    sandbox.execBounded = async (command, options, limits) => {
      const result = await bounded(command, options, limits);
      return command.includes("hashlib.sha256")
        ? { ...result, outputTruncated: true }
        : result;
    };

    await expect(
      runAnalysisNotebook(
        { path: "analysis.ipynb" },
        { sandbox, files, projectId: "ca-test-proj", newRunId: () => "run1" },
      ),
    ).rejects.toThrow(/tree manifest exceeds/);
    expect(files.store.has("keep.csv")).toBe(true);
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
      async exec(
        _command: string,
        options?: { env?: Record<string, string | undefined> },
      ) {
        envs.push(options?.env);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
      async execBounded(_command, options) {
        envs.push(options?.env);
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          outputTruncated: false,
          overflowStored: false,
          overflowComplete: false,
          overflowBytes: 0,
        };
      },
    };
    return sandbox;
  }

  it("injects the connections RPC URL and per-run SCRATCH for agent-scoped runs", async () => {
    const sandbox = envRecordingSandbox();
    await runAnalysisCode({ code: "print(1)" }, { sandbox, scratchId: "s1" });
    expect(sandbox.envs.some((env) => env?.CAMELAI_CONNECTIONS_RPC_URL)).toBe(
      true,
    );
    expect(sandbox.envs.some((env) => env?.SCRATCH === "/scratch/s1")).toBe(
      true,
    );
  });

  it("omits the connections RPC URL for app-scoped runs", async () => {
    const sandbox = envRecordingSandbox();
    await runAnalysisCode(
      { code: "print(1)" },
      { sandbox, scratchId: "s1", connections: false },
    );
    expect(sandbox.envs.every((env) => !env?.CAMELAI_CONNECTIONS_RPC_URL)).toBe(
      true,
    );
  });
});

describe("analysis input admission bounds", () => {
  it("rejects dependency count and aggregate bytes before materializing a project", async () => {
    const deps = {
      sandbox: fakeSandbox(),
      files: fakeFiles({}),
      projectId: "ca-test-proj",
      newRunId: () => "run1",
    };
    await expect(
      runAnalysisAddDependency(
        {
          packages: Array.from(
            { length: ANALYSIS_MAX_DEPENDENCY_SPECS + 1 },
            () => "x",
          ),
        },
        deps,
      ),
    ).rejects.toThrow(/at most/);
    const largeSpecs = Array.from(
      { length: Math.ceil(ANALYSIS_MAX_DEPENDENCY_BYTES / 210) + 1 },
      (_, index) =>
        `${String.fromCharCode(97 + (index % 26))}${"x".repeat(209)}`,
    );
    await expect(
      runAnalysisAddDependency({ packages: largeSpecs }, deps),
    ).rejects.toThrow(/aggregate byte limit/);
  });

  it("rejects an oversized shell command and environment before sandbox dispatch", async () => {
    const sandbox = fakeSandbox();
    const execBounded = vi.spyOn(sandbox, "execBounded");
    const oversizedCommand = await runAnalysisExec(
      { command: "x".repeat(ANALYSIS_MAX_COMMAND_BYTES + 1) },
      {
        sandbox,
        files: fakeFiles({}),
        projectId: "scratch",
        newRunId: () => "run1",
        hasProject: false,
        scratchId: "scratch1",
      },
    );
    expect(oversizedCommand).toMatchObject({
      ok: false,
      error: expect.stringContaining("byte limit"),
    });
    expect(execBounded).not.toHaveBeenCalled();

    const oversizedEnvironment = await runAnalysisExec(
      { command: "true", env: { HUGE: "x".repeat(ANALYSIS_MAX_ENV_BYTES) } },
      {
        sandbox,
        files: fakeFiles({}),
        projectId: "scratch",
        newRunId: () => "run2",
        hasProject: false,
        scratchId: "scratch2",
      },
    );
    expect(oversizedEnvironment).toMatchObject({
      ok: false,
      error: expect.stringContaining("bounded JSON limit"),
    });
    expect(execBounded).not.toHaveBeenCalled();
  });

  it("rejects oversized Python source and params before writing a script", async () => {
    const sandbox = fakeSandbox();
    const writeFile = vi.spyOn(sandbox, "writeFile");
    const oversizedCode = await runAnalysisCode(
      { code: "x".repeat(ANALYSIS_MAX_CODE_BYTES + 1) },
      { sandbox, scratchId: "code1" },
    );
    expect(oversizedCode).toMatchObject({
      ok: false,
      error: expect.stringContaining("byte limit"),
    });
    expect(writeFile).not.toHaveBeenCalled();

    const oversizedParams = await runAnalysisCode(
      {
        code: "print(params)",
        params: { huge: "x".repeat(ANALYSIS_MAX_PARAMS_BYTES) },
      },
      { sandbox, scratchId: "code2" },
    );
    expect(oversizedParams).toMatchObject({
      ok: false,
      error: expect.stringContaining("bounded JSON limit"),
    });
    expect(writeFile).not.toHaveBeenCalled();
  });
});

describe("run cleanup after a session death", () => {
  /**
   * The workdir/scratch tree is per-run and lives IN the container, so once the
   * shell is dead the `rm -rf` cleans nothing — and once the zombie self-heal
   * has destroyed the container it is an unconditional 30-120s cold boot,
   * charged to the caller's exec budget, ahead of the session recovery that
   * actually needs that time.
   */
  function deadShellSandbox() {
    const commands: string[] = [];
    const sandbox: AnalysisSandboxLike & { commands: string[] } = {
      commands,
      async mkdir() {
        return {};
      },
      async writeFile() {
        return {};
      },
      async readFile() {
        return { content: "" };
      },
      async exec(command: string) {
        commands.push(command);
        throw Object.assign(
          new Error(
            "Session 'sandbox-ws-1' ended because its shell exited (exit code: 128)",
          ),
          { name: "SessionTerminatedError" },
        );
      },
      async execBounded(command: string) {
        return sandbox.exec(command) as never;
      },
    };
    return sandbox;
  }

  it("skips the workdir rm -rf when runAnalysisExec dies with the shell", async () => {
    const sandbox = deadShellSandbox();

    await expect(
      runAnalysisExec(
        { command: "python main.py" },
        {
          sandbox,
          files: fakeFiles({ "main.py": "print(1)" }),
          projectId: "ca-test-proj",
          newRunId: () => "run1",
          hasProject: true,
          scratchId: "scratch1",
        },
      ),
    ).rejects.toThrow(/SessionTerminated|shell exited/);

    expect(
      sandbox.commands.some((command) => command.startsWith("rm -rf")),
    ).toBe(false);
  });

  it("skips it for runAnalysisCode, whose death is reported as a value", async () => {
    const sandbox = deadShellSandbox();

    const result = await runAnalysisCode(
      { code: "print(1)" },
      { sandbox, scratchId: "s1" },
    );

    expect(result).toMatchObject({ ok: false, sessionDeath: true });
    expect(
      sandbox.commands.some((command) => command.startsWith("rm -rf")),
    ).toBe(false);
  });

  it("still cleans up after an ordinary non-zero exit", async () => {
    const commands: string[] = [];
    const sandbox: AnalysisSandboxLike = {
      async mkdir() {
        return {};
      },
      async writeFile() {
        return {};
      },
      async readFile() {
        return { content: "" };
      },
      async exec(command: string) {
        commands.push(command);
        return { exitCode: 1, stdout: "", stderr: "boom" };
      },
      async execBounded(command: string) {
        commands.push(command);
        const cleanup = command.startsWith("rm -rf");
        return {
          success: cleanup,
          exitCode: cleanup ? 0 : 1,
          stdout: "",
          stderr: cleanup ? "" : "boom",
          stdoutBytes: 0,
          stderrBytes: cleanup ? 0 : 4,
          outputTruncated: false,
          overflowStored: false,
          overflowComplete: false,
          overflowBytes: 0,
        };
      },
    };

    const result = await runAnalysisCode(
      { code: "print(1)" },
      { sandbox, scratchId: "s1" },
    );

    expect(result.ok).toBe(false);
    expect(commands.some((command) => command.startsWith("rm -rf"))).toBe(true);
  });
});

describe("run workdir cleanup reset fallback", () => {
  const cleanupFailure = {
    success: false,
    exitCode: 23,
    stdout: "",
    stderr: "cleanup failed",
    stdoutBytes: 0,
    stderrBytes: 14,
    outputTruncated: false,
    overflowStored: false,
    overflowComplete: false,
    overflowBytes: 0,
  };

  function sandboxWithFailedWorkdirCleanup(
    destroyAndForgetContainerGeneration?: () => Promise<void>,
  ): AnalysisSandboxLike & {
    destroyAndForgetContainerGeneration?: () => Promise<void>;
    execBounded: ReturnType<typeof vi.fn>;
  } {
    const sandbox = fakeSandbox() as AnalysisSandboxLike & {
      destroyAndForgetContainerGeneration?: () => Promise<void>;
      execBounded: ReturnType<typeof vi.fn>;
    };
    const normalExecBounded = sandbox.execBounded.bind(sandbox);
    sandbox.execBounded = vi.fn(
      async (
        command: string,
        options: Parameters<AnalysisSandboxLike["execBounded"]>[1],
        limits: Parameters<AnalysisSandboxLike["execBounded"]>[2],
      ) => {
        if (command.startsWith("rm -rf -- ")) return cleanupFailure;
        return normalExecBounded(command, options, limits);
      },
    );
    if (destroyAndForgetContainerGeneration) {
      sandbox.destroyAndForgetContainerGeneration =
        destroyAndForgetContainerGeneration;
    }
    return sandbox;
  }

  function runWithFailedWorkdirCleanup(sandbox: AnalysisSandboxLike) {
    return runAnalysisExec(
      { command: "true" },
      {
        sandbox,
        files: fakeFiles({ "main.py": "print('ok')" }),
        projectId: "ca-test-proj",
        newRunId: () => "cleanup-run",
        hasProject: true,
        scratchId: "unused",
      },
    );
  }

  it("destroys the disposable container when workdir rm exits nonzero", async () => {
    const destroyAndForgetContainerGeneration = vi.fn(async () => undefined);
    const sandbox = sandboxWithFailedWorkdirCleanup(
      destroyAndForgetContainerGeneration,
    );

    await expect(runWithFailedWorkdirCleanup(sandbox)).resolves.toMatchObject({
      ok: true,
    });

    const cleanupCommand = sandbox.execBounded.mock.calls
      .map(([command]) => String(command))
      .find((command) => command.startsWith("rm -rf -- "));
    expect(cleanupCommand).toContain("/projects/ca-test-proj/runs/cleanup-run");
    expect(cleanupCommand).toContain("/scratch/cleanup-run");
    expect(destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
  });

  it("fails closed when workdir cleanup fails and container reset rejects", async () => {
    const destroyAndForgetContainerGeneration = vi.fn(async () => {
      throw new Error("destroy failed");
    });
    const sandbox = sandboxWithFailedWorkdirCleanup(
      destroyAndForgetContainerGeneration,
    );

    await expect(runWithFailedWorkdirCleanup(sandbox)).rejects.toThrow(
      /container reset was unconfirmed/,
    );
    expect(destroyAndForgetContainerGeneration).toHaveBeenCalledOnce();
  });

  it("fails closed when workdir cleanup fails and container reset is unavailable", async () => {
    const sandbox = sandboxWithFailedWorkdirCleanup();

    await expect(runWithFailedWorkdirCleanup(sandbox)).rejects.toThrow(
      /container reset is unavailable/,
    );
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
    const sandbox: AnalysisSandboxStub & {
      mounts: typeof mounts;
      connections: typeof connections;
    } = {
      ...fakeExecutionAdmission(),
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
      async execBounded() {
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          outputTruncated: false,
          overflowStored: false,
          overflowComplete: false,
          overflowBytes: 0,
        };
      },
    };
    return sandbox;
  }

  function serviceWithUploads(objects: string[]) {
    const sandbox = analysisServiceSandbox();
    const listCalls: unknown[] = [];
    const service = Object.create(
      AnalysisService.prototype,
    ) as AnalysisService & {
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
      // Same bucket, separate binding — the sandbox SDK will not mount one
      // binding at two prefixes, so /outputs cannot reuse the uploads binding.
      R2_OUTPUTS_BUCKET: {},
    };
    service.ctx = { props: { orgId: "org-1", workspaceId: "ws-1" } };
    (
      service as unknown as { sandboxes: Map<string, AnalysisSandboxStub> }
    ).sandboxes = new Map([["agent", sandbox]]);
    return { service, sandbox, listCalls };
  }

  const OUTPUTS_MOUNT = {
    bucketBinding: "R2_OUTPUTS_BUCKET",
    prefix: "org-1/ws-1/user-outputs",
    mountPath: "/outputs",
    options: { readOnly: false },
  };

  it("rejects invalid public inputs before admission or any sandbox side effect", async () => {
    const { service, sandbox, listCalls } = serviceWithUploads([]);
    const acquire = vi.spyOn(sandbox, "acquireExecutionLease");
    const release = vi.spyOn(sandbox, "releaseExecutionLease");
    const ensureMounted = vi.spyOn(sandbox, "ensureMounted");
    const ensureConnections = vi.spyOn(sandbox, "ensureConnectionsRpc");
    const seal = vi.spyOn(sandbox, "sealAppEgress");
    const mkdir = vi.spyOn(sandbox, "mkdir");
    const writeFile = vi.spyOn(sandbox, "writeFile");
    const readFile = vi.spyOn(sandbox, "readFile");
    const exec = vi.spyOn(sandbox, "exec");
    const execBounded = vi.spyOn(sandbox, "execBounded");

    await expect(
      service.runNotebook({ projectId: "project-1", path: "not-a-notebook" }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining(".ipynb"),
    });
    await expect(
      service.exec({ projectId: "project-1", command: "   " }),
    ).resolves.toMatchObject({ ok: false, error: "command is required" });
    await expect(
      service.exec({ command: "printf\0no" }),
    ).resolves.toMatchObject({
      ok: false,
      error: "command contains a NUL byte",
    });
    await expect(
      service.exec({
        command: "true",
        env: { INVALID: 1 } as unknown as Record<string, string>,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("valid string entries"),
    });
    await expect(
      service.runCode({ code: "", params: {} }),
    ).resolves.toMatchObject({ ok: false, error: "code is required" });
    await expect(
      service.runCode({
        code: "print('ok')",
        params: [] as unknown as Record<string, unknown>,
      }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("params must be an object"),
    });
    await expect(
      service.runCodeForApps({ code: " ", params: {} }),
    ).resolves.toMatchObject({ ok: false, error: "code is required" });
    await expect(
      service.addDependency({ projectId: "project-1", packages: ["--flag"] }),
    ).rejects.toThrow("must not be a CLI flag");
    await expect(
      service.addDependency({
        projectId: "project-1",
        packages: ["pandas"],
        dev: "yes" as never,
      }),
    ).rejects.toThrow("dev must be a boolean");

    expect(acquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
    expect(ensureMounted).not.toHaveBeenCalled();
    expect(ensureConnections).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(readFile).not.toHaveBeenCalled();
    expect(exec).not.toHaveBeenCalled();
    expect(execBounded).not.toHaveBeenCalled();
    expect(listCalls).toEqual([]);
  });

  it("rejects invalid app runCode before any sandbox side effect", async () => {
    const { service, sandbox, listCalls } = serviceWithUploads([]);
    const createFullService = vi.fn(() => service);
    const acquire = vi.spyOn(sandbox, "acquireExecutionLease");
    const ensureMounted = vi.spyOn(sandbox, "ensureMounted");
    const ensureConnections = vi.spyOn(sandbox, "ensureConnectionsRpc");
    const seal = vi.spyOn(sandbox, "sealAppEgress");
    const mkdir = vi.spyOn(sandbox, "mkdir");
    const writeFile = vi.spyOn(sandbox, "writeFile");
    const execBounded = vi.spyOn(sandbox, "execBounded");
    const app = Object.create(
      AnalysisAppService.prototype,
    ) as AnalysisAppService & {
      ctx: unknown;
    };
    app.ctx = {
      props: { orgId: "org-1", workspaceId: "ws-1" },
      exports: { AnalysisService: createFullService },
    };

    await expect(
      app.runCode({ code: "print('ok')", params: [] as never }),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("params must be an object"),
    });
    expect(createFullService).toHaveBeenCalledOnce();
    expect(acquire).not.toHaveBeenCalled();
    expect(ensureMounted).not.toHaveBeenCalled();
    expect(ensureConnections).not.toHaveBeenCalled();
    expect(seal).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
    expect(execBounded).not.toHaveBeenCalled();
    expect(listCalls).toEqual([]);
  });

  it("queues bounded concurrent starts without allocating overlapping sandbox work", async () => {
    const { service, sandbox } = serviceWithUploads([]);
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolveStarted) => {
      let calls = 0;
      sandbox.mkdir = vi.fn(async () => {
        calls += 1;
        if (calls !== 1) return {};
        resolveStarted();
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return {};
      });
    });

    const first = service.runCode({ code: "print('first')" });
    await firstStarted;
    const commandCallsBefore =
      (sandbox.execBounded as ReturnType<typeof vi.fn>).mock?.calls?.length ??
      0;

    const queued = Array.from(
      { length: ANALYSIS_EXECUTION_QUEUE_MAX_WAITERS },
      (_, index) => service.runCode({ code: `print('queued-${index}')` }),
    );
    const overflow = service.runCode({ code: "print('overflow')" });
    await expect(overflow).rejects.toBeInstanceOf(AnalysisExecutionBusyError);
    expect(sandbox.mkdir).toHaveBeenCalledOnce();
    expect(
      (sandbox.execBounded as ReturnType<typeof vi.fn>).mock?.calls?.length ??
        0,
    ).toBe(commandCallsBefore);

    releaseFirst();
    await expect(first).resolves.toMatchObject({ ok: true });
    await expect(Promise.all(queued)).resolves.toEqual([
      expect.objectContaining({ ok: true }),
      expect.objectContaining({ ok: true }),
    ]);
  });

  it("resets at the absolute lifecycle deadline and fences the lease until a hung prepare settles", async () => {
    vi.useFakeTimers();
    try {
      const { service, sandbox } = serviceWithUploads([]);
      sandbox.mkdir = vi.fn(async () => ({}));
      let releasePrepare!: () => void;
      let firstMount = true;
      sandbox.ensureMounted = vi.fn(async () => {
        if (!firstMount) return;
        firstMount = false;
        await new Promise<void>((resolve) => {
          releasePrepare = resolve;
        });
      });
      sandbox.destroyAndForgetContainerGeneration = vi.fn(async () => {});

      const first = service.runCode({ code: "print('first')" });
      const firstRejection = expect(first).rejects.toBeInstanceOf(
        AnalysisOperationDeadlineError,
      );
      await vi.advanceTimersByTimeAsync(50_000);
      await firstRejection;
      expect(
        sandbox.destroyAndForgetContainerGeneration,
      ).toHaveBeenCalledOnce();
      expect(sandbox.mkdir).not.toHaveBeenCalled();

      // The caller got its bounded error, but the non-cancellable mount RPC is
      // still live. A bounded waiter must not allocate overlapping sandbox work.
      let overlapSettled = false;
      const overlap = service.runCode({ code: "print('overlap')" });
      void overlap.then(
        () => {
          overlapSettled = true;
        },
        () => {
          overlapSettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(overlapSettled).toBe(false);
      expect(sandbox.mkdir).not.toHaveBeenCalled();

      releasePrepare();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await expect(overlap).resolves.toMatchObject({ ok: true });
      await expect(
        service.runCode({ code: "print('after')" }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps admission closed until a timed-out project persist RPC settles", async () => {
    vi.useFakeTimers();
    try {
      const { service, sandbox } = serviceWithUploads([]);
      sandbox.destroyAndForgetContainerGeneration = vi.fn(async () => {});
      sandbox.execBounded = vi.fn(async () => ({
        success: true,
        exitCode: 0,
        stdout: `${"a".repeat(64)}  ./changed.bin\nCAMELAI_MANIFEST_V1 1`,
        stderr: "",
        outputTruncated: false,
      }));
      sandbox.readFile = vi.fn(async () => ({
        content: streamFromBytes(new Uint8Array([1])),
        size: 1,
      }));
      let settleAdoption!: () => void;
      const files = {
        adoptR2File: vi.fn(
          () =>
            new Promise<{ success: true }>((resolve) => {
              settleAdoption = () => resolve({ success: true });
            }),
        ),
        deleteFile: vi.fn(async () => ({ success: true })),
      } as unknown as WorkspaceFileStoreLike;
      const admit = (
        service as unknown as {
          withExecutionAdmission<T>(
            operation: string,
            scope: "agent" | "app",
            budgetMs: number,
            run: (budget: unknown) => Promise<T>,
          ): Promise<T>;
        }
      ).withExecutionAdmission.bind(service);

      const first = admit("persist_test", "agent", 60_000, (budget) =>
        analysisTesting.persistChangedFiles(
          sandbox,
          "/projects/p/runs/one",
          files,
          new Map(),
          20,
          budget as never,
        ),
      );
      const firstRejection = expect(first).rejects.toBeInstanceOf(
        AnalysisOperationDeadlineError,
      );
      await vi.advanceTimersByTimeAsync(20);
      await firstRejection;
      expect(
        sandbox.destroyAndForgetContainerGeneration,
      ).toHaveBeenCalledOnce();

      let overlapSettled = false;
      const overlap = admit("overlap", "agent", 60_000, async () => "overlap");
      void overlap.then(
        () => {
          overlapSettled = true;
        },
        () => {
          overlapSettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect(overlapSettled).toBe(false);

      settleAdoption();
      await vi.advanceTimersByTimeAsync(1_000);
      await Promise.resolve();
      await expect(overlap).resolves.toBe("overlap");
      await expect(
        admit("after", "agent", 60_000, async () => "after"),
      ).resolves.toBe("after");
    } finally {
      vi.useRealTimers();
    }
  });

  it("discards a staged archive when a later service phase fails", async () => {
    const { service, sandbox } = serviceWithUploads([]);
    const acknowledge = vi.fn(async () => true);
    const discard = vi.fn(async () => true);
    sandbox.acknowledgeBoundedExecArchive = acknowledge;
    sandbox.discardBoundedExecArchive = discard;
    const release = vi.spyOn(sandbox, "releaseExecutionLease");
    const admit = (
      service as unknown as {
        withExecutionAdmission<T>(
          operation: string,
          scope: "agent" | "app",
          budgetMs: number,
          run: (budget: unknown) => Promise<T>,
        ): Promise<T>;
      }
    ).withExecutionAdmission.bind(service);

    await expect(
      admit("archive_failure", "agent", 60_000, async (rawBudget) => {
        const budget = rawBudget as {
          archives: Map<string, string>;
        };
        budget.archives.set(
          "22222222-2222-4222-8222-222222222222",
          "org/ws/user-outputs/tmp/staged.log",
        );
        throw new Error("later persist failed");
      }),
    ).rejects.toThrow("later persist failed");
    expect(discard).toHaveBeenCalledOnce();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(discard.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0],
    );

    await expect(
      admit("archive_success", "agent", 60_000, async (rawBudget) => {
        const budget = rawBudget as {
          archives: Map<string, string>;
        };
        budget.archives.set(
          "33333333-3333-4333-8333-333333333333",
          "org/ws/user-outputs/tmp/accepted.log",
        );
        return "accepted";
      }),
    ).resolves.toBe("accepted");
    expect(acknowledge).toHaveBeenCalledOnce();
    expect(acknowledge.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[1],
    );
  });

  it("caps a hung lease release by the remaining absolute lifecycle budget", async () => {
    vi.useFakeTimers();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const { service, sandbox } = serviceWithUploads([]);
      sandbox.acquireExecutionLease = vi.fn(async () => ({
        acquired: true as const,
        deadlineAt: Date.now() + 20_000,
      }));
      sandbox.releaseExecutionLease = vi.fn(() => new Promise<never>(() => {}));
      sandbox.destroyAndForgetContainerGeneration = vi.fn(async () => {});
      const admit = (
        service as unknown as {
          withExecutionAdmission<T>(
            operation: string,
            scope: "agent" | "app",
            budgetMs: number,
            run: (budget: unknown) => Promise<T>,
          ): Promise<T>;
        }
      ).withExecutionAdmission.bind(service);
      const startedAt = Date.now();
      let settleRun!: () => void;
      const pending = admit("release_test", "agent", 20_000, () => {
        return new Promise<string>((resolve) => {
          settleRun = () => resolve("late");
        });
      });
      const rejection = expect(pending).rejects.toBeInstanceOf(
        AnalysisOperationDeadlineError,
      );

      // Ordinary work stops at 5s, preserving 15s for archive/reset cleanup.
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      expect(sandbox.releaseExecutionLease).not.toHaveBeenCalled();

      // The abandoned continuation settles with only 500ms left. Its deferred
      // release is clamped to that remainder, never another independent 11s.
      await vi.advanceTimersByTimeAsync(14_500);
      settleRun();
      await vi.advanceTimersByTimeAsync(0);
      expect(sandbox.releaseExecutionLease).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(500);
      expect(Date.now() - startedAt).toBe(20_000);
    } finally {
      warning.mockRestore();
      vi.useRealTimers();
    }
  });

  it("bounds the pre-admission project authorization lookup without starting sandbox work", async () => {
    vi.useFakeTimers();
    try {
      const sandbox = analysisServiceSandbox();
      const acquire = vi.spyOn(sandbox, "acquireExecutionLease");
      const execBounded = vi.spyOn(sandbox, "execBounded");
      const getProject = vi.fn(() => new Promise<never>(() => {}));
      const service = Object.create(
        AnalysisService.prototype,
      ) as AnalysisService & { env: unknown; ctx: unknown };
      service.ctx = { props: { orgId: "org-1", workspaceId: "ws-1" } };
      service.env = {
        WORKSPACE_FS: {
          idFromName: vi.fn(() => "workspace-id"),
          get: vi.fn(() => ({ getProject })),
        },
      };
      (
        service as unknown as { sandboxes: Map<string, AnalysisSandboxStub> }
      ).sandboxes = new Map([["agent", sandbox]]);

      const pending = service.runNotebook({
        projectId: "project-1",
        path: "report.ipynb",
      });
      const rejection = expect(pending).rejects.toThrow(
        /authorization RPC deadline exceeded/,
      );
      await vi.advanceTimersByTimeAsync(11_000);
      await rejection;
      expect(getProject).toHaveBeenCalledOnce();
      expect(acquire).not.toHaveBeenCalled();
      expect(execBounded).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips the /uploads mount when the workspace upload prefix is empty", async () => {
    const { service, sandbox, listCalls } = serviceWithUploads([]);
    await expect(
      service.runCode({ code: "print('ok')" }),
    ).resolves.toMatchObject({ ok: true });
    expect(listCalls).toEqual([
      { prefix: "org-1/ws-1/user-uploads/", limit: 1 },
    ]);
    // No uploads to read, but outputs is still mounted: it is the run's only
    // way to hand a generated file back, and it starts empty by definition.
    expect(sandbox.mounts).toEqual([OUTPUTS_MOUNT]);
    expect(sandbox.connections).toHaveLength(1);
  });

  it("mounts /uploads when the workspace upload prefix has objects", async () => {
    const { service, sandbox } = serviceWithUploads([
      "org-1/ws-1/user-uploads/data.csv",
    ]);
    await expect(
      service.runCode({ code: "print('ok')" }),
    ).resolves.toMatchObject({ ok: true });
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
    await expect(
      service.runCode({ code: "print('ok')" }),
    ).resolves.toMatchObject({ ok: true });

    const outputs = sandbox.mounts.find(
      (mount) => mount.mountPath === "/outputs",
    );
    expect(outputs).toBeDefined();
    expect(outputs?.options?.readOnly).toBe(false);
    expect(outputs?.prefix).toBe("org-1/ws-1/user-outputs");
  });

  it("advertises a bounded output archive only after the outputs mount succeeds", async () => {
    const { service, sandbox } = serviceWithUploads([]);
    const execBounded = vi.fn(
      async (
        _command: string,
        _options: unknown,
        limits: {
          overflowPath?: string;
          overflowBytes?: number;
          executionOwnerToken?: string;
        },
      ) => ({
        success: true,
        exitCode: 0,
        stdout: "tail",
        stderr: "",
        stdoutBytes: 2_000_000,
        stderrBytes: 0,
        outputTruncated: true,
        overflowStored: Boolean(limits.overflowPath),
        overflowComplete: false,
        overflowBytes: limits.overflowPath ? 900_000 : 0,
        ...(limits.overflowPath
          ? {
              overflowTaintToken: "44444444-4444-4444-8444-444444444444",
            }
          : {}),
      }),
    );
    sandbox.execBounded = execBounded;
    sandbox.acknowledgeBoundedExecArchive = vi.fn(async () => true);
    sandbox.discardBoundedExecArchive = vi.fn(async () => true);

    const result = await service.runCode({
      code: "print('lots')",
      outputCaptureBytes: 1024 * 1024,
    });

    expect(result.fullOutput).toMatchObject({
      path: expect.stringMatching(/^outputs\/tmp\//),
      bytes: 900_000,
      complete: false,
    });
    expect(execBounded).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({
        overflowPath: expect.stringMatching(/^\/outputs\/tmp\//),
        overflowBytes: 1024 * 1024,
      }),
    );
  });

  it("skips the outputs mount when its binding is missing, and still runs", async () => {
    // An environment without R2_OUTPUTS_BUCKET must not try to mount /outputs
    // from the uploads binding: the SDK rejects a second prefix on the same
    // binding, so that attempt would fail on every run for every workspace.
    const { service, sandbox } = serviceWithUploads([
      "org-1/ws-1/user-uploads/data.csv",
    ]);
    delete (service.env as Record<string, unknown>).R2_OUTPUTS_BUCKET;

    await expect(
      service.runCode({ code: "print('ok')" }),
    ).resolves.toMatchObject({ ok: true });

    expect(sandbox.mounts.some((mount) => mount.mountPath === "/outputs")).toBe(
      false,
    );
    expect(sandbox.mounts.some((mount) => mount.mountPath === "/uploads")).toBe(
      true,
    );
  });

  it("still runs when the outputs mount fails", async () => {
    // Losing the delivery path is bad; taking down notebook and code execution
    // for every workspace would be far worse.
    const { service, sandbox } = serviceWithUploads([]);
    const failing = sandbox as unknown as {
      ensureMounted: (...args: unknown[]) => Promise<void>;
    };
    failing.ensureMounted = async (
      _binding: unknown,
      _prefix: unknown,
      mountPath?: unknown,
    ) => {
      if (mountPath === "/outputs") throw new Error("s3fs mount refused");
    };

    const execBounded = vi.fn(async () => ({
      success: true,
      exitCode: 0,
      stdout: "tail",
      stderr: "",
      stdoutBytes: 2_000_000,
      stderrBytes: 0,
      outputTruncated: true,
      overflowStored: false,
      overflowComplete: false,
      overflowBytes: 0,
    }));
    sandbox.execBounded = execBounded;

    const result = await service.runCode({
      code: "print('ok')",
      outputCaptureBytes: 1024 * 1024,
    });
    expect(result).toMatchObject({ ok: true });
    expect(result.fullOutput).toBeUndefined();
    expect(execBounded).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.not.objectContaining({ overflowPath: expect.anything() }),
    );
  });
});

// ---------------------------------------------------------------------------
// Session death (container OOM / restart under a running command)
// ---------------------------------------------------------------------------

/** The exact SDK shape production surfaced to a user, raw. */
function sessionTerminatedError(exitCode = 128): Error {
  const error = new Error(
    `Session "sandbox-ws-1" ended because its shell exited (exit code: ${exitCode}). ` +
      "Session-local state (env vars, cwd, shell functions) has been lost.",
  );
  error.name = "SessionTerminatedError";
  return error;
}

describe("sandbox session-death classification", () => {
  it("recognizes the whole SDK session/process-death family", () => {
    expect(isSandboxSessionDeathError(sessionTerminatedError())).toBe(true);
    for (const name of [
      "ProcessExitedBeforeReadyError",
      "ProcessReadyTimeoutError",
    ]) {
      const error = new Error("process never became ready");
      error.name = name;
      expect(isSandboxSessionDeathError(error)).toBe(true);
    }
    // Survives an RPC hop that flattened the class into a plain Error.
    expect(
      isSandboxSessionDeathError(
        new Error(
          "SessionTerminatedError: Session 'sandbox-ws-1' shell exited (exit code: 128)",
        ),
      ),
    ).toBe(true);
  });

  it("leaves ordinary command failures alone", () => {
    expect(
      isSandboxSessionDeathError(new Error("python: command not found")),
    ).toBe(false);
    expect(
      isSandboxSessionDeathError(
        new Error("RPCTransportError: Network connection lost"),
      ),
    ).toBe(false);
  });

  it("extracts the exit code the SDK embeds", () => {
    expect(sandboxSessionExitCode(sessionTerminatedError(137))).toBe(137);
    expect(sandboxSessionExitCode(new Error("no code here"))).toBeNull();
  });
});

describe("AnalysisService session recovery", () => {
  function recoveringService(
    execImpl: () => Promise<unknown>,
    prepare: { mkdir?: () => Promise<unknown> } = {},
  ) {
    const events: Array<{ blobs: unknown[]; doubles: unknown[] }> = [];
    const resetSession = vi.fn(async () => undefined);
    const mkdir = vi.fn(prepare.mkdir ?? (async () => ({})));
    const execBounded = vi.fn(async (command: string) => {
      if (command.startsWith("rm -rf")) {
        return {
          success: true,
          exitCode: 0,
          stdout: "",
          stderr: "",
          stdoutBytes: 0,
          stderrBytes: 0,
          outputTruncated: false,
          overflowStored: false,
          overflowComplete: false,
          overflowBytes: 0,
        };
      }
      const result = (await execImpl()) as {
        success?: boolean;
        exitCode?: number;
        stdout?: string;
        stderr?: string;
      };
      const stdout = result.stdout ?? "";
      const stderr = result.stderr ?? "";
      return {
        success: result.success ?? result.exitCode === 0,
        exitCode: result.exitCode ?? (result.success === false ? 1 : 0),
        stdout,
        stderr,
        stdoutBytes: new TextEncoder().encode(stdout).byteLength,
        stderrBytes: new TextEncoder().encode(stderr).byteLength,
        outputTruncated: false,
        overflowStored: false,
        overflowComplete: false,
        overflowBytes: 0,
      };
    });
    const sandbox = {
      ...fakeExecutionAdmission(),
      resetSession,
      async ensureMounted() {},
      async ensureConnectionsRpc() {},
      async sealAppEgress() {},
      mkdir,
      async writeFile() {
        return {};
      },
      async readFile() {
        return { content: "" };
      },
      // Kept for setup calls that still use ordinary exec; command and cleanup
      // output both use execBounded.
      exec: vi.fn((command: string) =>
        command.startsWith("rm -rf")
          ? Promise.resolve({ exitCode: 0, stdout: "", stderr: "" })
          : execImpl(),
      ),
      execBounded,
    } as unknown as AnalysisSandboxStub & {
      exec: ReturnType<typeof vi.fn>;
      execBounded: ReturnType<typeof vi.fn>;
      mkdir: ReturnType<typeof vi.fn>;
    };
    const service = Object.create(
      AnalysisService.prototype,
    ) as AnalysisService & {
      env: unknown;
      ctx: unknown;
    };
    service.env = {
      OBSERVABILITY_EVENTS: {
        writeDataPoint: (point: { blobs: unknown[]; doubles: unknown[] }) =>
          events.push(point),
      },
    };
    service.ctx = { props: { orgId: "org-1", workspaceId: "ws-1" } };
    (
      service as unknown as { sandboxes: Map<string, AnalysisSandboxStub> }
    ).sandboxes = new Map([["agent", sandbox]]);
    return { service, sandbox, events, resetSession };
  }

  const sessionEvents = (events: Array<{ blobs: unknown[] }>) =>
    events.filter(
      (point) => (point.blobs as string[])[0] === "sandbox_session_terminated",
    );

  /** Only agent commands count; bounded cleanup runs unconditionally. */
  const commandRuns = (sandbox: { execBounded: ReturnType<typeof vi.fn> }) =>
    sandbox.execBounded.mock.calls.filter(
      ([command]) => !String(command).startsWith("rm -rf"),
    ).length;

  it("recreates the session and retries when the shell died BEFORE the command ran", async () => {
    let prepares = 0;
    const { service, sandbox, events, resetSession } = recoveringService(
      async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      {
        mkdir: async () => {
          prepares += 1;
          if (prepares === 1) throw sessionTerminatedError();
          return {};
        },
      },
    );

    const result = (await service.runCode({ code: "print('ok')" })) as Record<
      string,
      unknown
    >;
    expect(result).toMatchObject({ ok: true, stdout: "ok" });
    // A retry is never silent: the agent can say the environment restarted.
    expect(result.sessionRecovered).toBe(true);
    expect(String(result.sessionRecoveredNote)).toMatch(/restarted/);

    // The dead session handle is disposed before the retry runs.
    expect(resetSession).toHaveBeenCalledTimes(1);
    // The command itself was dispatched exactly once — the first attempt never
    // got that far.
    expect(commandRuns(sandbox)).toBe(1);
    const recorded = sessionEvents(events);
    expect(recorded).toHaveLength(1);
    expect((recorded[0].blobs as string[])[4]).toBe("retried");
  });

  it("does NOT re-run a command whose shell died UNDER it (non-idempotent double-apply)", async () => {
    const { service, sandbox, events, resetSession } = recoveringService(
      async () => {
        throw sessionTerminatedError();
      },
    );

    // `psql -f migrate.sql` may have applied the migration before the shell
    // died; re-dispatching it would apply it twice, silently.
    await expect(
      service.exec({ command: "psql -f migrate.sql" }),
    ).rejects.toThrow(ANALYSIS_SESSION_RESTARTED_MESSAGE);

    expect(commandRuns(sandbox)).toBe(1);
    expect(resetSession).not.toHaveBeenCalled();
    const recorded = sessionEvents(events);
    expect(recorded).toHaveLength(1);
    expect((recorded[0].blobs as string[])[4]).toBe("failed");
  });

  it("retries a pre-dispatch death at most once", async () => {
    let prepares = 0;
    const { service, sandbox, events } = recoveringService(
      async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      {
        mkdir: async () => {
          prepares += 1;
          throw sessionTerminatedError();
        },
      },
    );

    await expect(
      service.exec({ command: "psql -f migrate.sql" }),
    ).rejects.toThrow(ANALYSIS_SESSION_RESTARTED_MESSAGE);

    expect(prepares).toBe(2);
    expect(commandRuns(sandbox)).toBe(0);
    const recorded = sessionEvents(events);
    expect(recorded).toHaveLength(2);
    expect((recorded[0].blobs as string[])[4]).toBe("retried");
    expect((recorded[1].blobs as string[])[4]).toBe("failed");
  });

  it("never leaks the raw SDK error name to the caller", async () => {
    const { service } = recoveringService(async () => {
      throw sessionTerminatedError();
    });

    // runCode reports failures as a VALUE (deployed apps depend on that shape),
    // so recovery replaces the raw SDK text in place rather than throwing.
    const result = await service.runCode({ code: "print('ok')" });
    expect(result).toMatchObject({
      ok: false,
      error: ANALYSIS_SESSION_RESTARTED_MESSAGE,
    });
    expect(JSON.stringify(result)).not.toContain("SessionTerminatedError");
    expect(JSON.stringify(result)).not.toContain("shell exited");
    // The internal recovery marker never reaches a caller.
    expect(JSON.stringify(result)).not.toContain("sessionDeath");
  });

  it("does not treat a script that PRINTS SessionTerminatedError as an environment death", async () => {
    const { service, sandbox, events } = recoveringService(async () => ({
      exitCode: 1,
      stdout: "",
      stderr:
        "Traceback: RuntimeError: SessionTerminatedError is just a string here",
    }));

    const result = (await service.runCode({ code: "print('boom')" })) as Record<
      string,
      unknown
    >;
    expect(result.ok).toBe(false);
    // The program's own stderr survives verbatim, and nothing was re-executed.
    expect(String(result.error)).toContain("SessionTerminatedError");
    expect(commandRuns(sandbox)).toBe(1);
    expect(sessionEvents(events)).toHaveLength(0);
  });

  it("keeps the throwing shape for operations that throw", async () => {
    const { service } = recoveringService(async () => {
      throw sessionTerminatedError();
    });

    // runAnalysisExec propagates sandbox failures, so the tool boundary sees a
    // rejection — with the user-facing message, not the SDK class name.
    const failure = await service
      .exec({ command: "psql -f migrate.sql" })
      .catch((error) => error as Error);
    expect(failure.message).toBe(ANALYSIS_SESSION_RESTARTED_MESSAGE);
    expect((failure.cause as Error).name).toBe("SessionTerminatedError");
  });

  it("still retries add_dependency after dispatch — `uv add` is idempotent", async () => {
    let installs = 0;
    const { service, sandbox } = recoveringService(async () => ({
      exitCode: 0,
      stdout: "ok",
      stderr: "",
    }));
    // Fail the FIRST `uv add` specifically, i.e. after dispatch.
    sandbox.execBounded.mockImplementation((command: string) => {
      if (String(command).includes("uv add")) {
        installs += 1;
        if (installs === 1) return Promise.reject(sessionTerminatedError());
      }
      return Promise.resolve({
        success: true,
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        stdoutBytes: 2,
        stderrBytes: 0,
        outputTruncated: false,
        overflowStored: false,
        overflowComplete: false,
        overflowBytes: 0,
      });
    });
    (
      service as unknown as { projectFiles: (id: string) => Promise<unknown> }
    ).projectFiles = async () =>
      fakeFiles({ "pyproject.toml": "[project]\nname='x'\n" });

    const result = (await service.addDependency({
      projectId: "ca-test-proj",
      packages: ["tabulate"],
    })) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.sessionRecovered).toBe(true);
    expect(
      sandbox.execBounded.mock.calls.filter(([c]) =>
        String(c).includes("uv add"),
      ),
    ).toHaveLength(2);
  });

  it("does not retry an ordinary command failure", async () => {
    let attempts = 0;
    const { service, events, resetSession } = recoveringService(async () => {
      attempts += 1;
      throw new Error("bash: nope: command not found");
    });

    await expect(service.exec({ command: "nope" })).rejects.toThrow(
      "command not found",
    );
    expect(attempts).toBe(1);
    expect(resetSession).not.toHaveBeenCalled();
    expect(sessionEvents(events)).toHaveLength(0);
  });

  it("survives a sandbox without resetSession (older deployments, fakes)", async () => {
    let prepares = 0;
    const { service, sandbox } = recoveringService(
      async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
      {
        mkdir: async () => {
          prepares += 1;
          if (prepares === 1) throw sessionTerminatedError();
          return {};
        },
      },
    );
    delete (sandbox as unknown as Record<string, unknown>).resetSession;

    await expect(
      service.runCode({ code: "print('ok')" }),
    ).resolves.toMatchObject({ ok: true });
    expect(prepares).toBe(2);
  });
});

describe("persist delete failures", () => {
  it("fails the run loudly when removing a deleted file from the store fails", async () => {
    const files = fakeFiles(
      { "analysis.ipynb": '{"cells":[]}', "obsolete.txt": "old" },
      { failDelete: true },
    );
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
    const service = Object.create(
      AnalysisService.prototype,
    ) as AnalysisService & {
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
      service.runNotebook({
        projectId: "ca-other-workspace-proj",
        path: "analysis.ipynb",
      }),
    ).rejects.toThrow(/not found in this workspace/);
    await expect(
      service.addDependency({
        projectId: "ca-other-workspace-proj",
        packages: ["tabulate"],
      }),
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
  const handler =
    AnalysisSandbox.outboundHandlers?.[ANALYSIS_CONNECTIONS_HANDLER];

  it("is registered on the AnalysisSandbox static registry", () => {
    expect(typeof handler).toBe("function");
  });

  it("fails closed (401) when no workspace scope was attached DO-side", async () => {
    const res = (await handler!(
      new Request(`http://${ANALYSIS_CONNECTIONS_HOST}/`, {
        method: "POST",
        body: "{}",
      }),
      {} as never,
      { containerId: "c1", className: "AnalysisSandbox" } as never,
    )) as Response;
    expect(res.status).toBe(401);
    const body = (await res.json()) as {
      ok: boolean;
      error: { message: string };
    };
    expect(body.ok).toBe(false);
    expect(body.error.message).toMatch(/scope/);
  });

  it("survives the SDK's r2EgressMount registration (registry setter must MERGE)", () => {
    const before =
      AnalysisSandbox.outboundHandlers?.[ANALYSIS_CONNECTIONS_HANDLER];
    expect(typeof before).toBe("function");
    // Simulate @cloudflare/sandbox's configureR2EgressOutbound, which assigns
    // `this.constructor.outboundHandlers = { r2EgressMount: ... }` when mounting
    // R2. The containers setter merges into the registry; if a future SDK
    // version switches to replace semantics, connectionsRpc would vanish and
    // the in-sandbox connections RPC would silently break — this pins it.
    (
      AnalysisSandbox as unknown as {
        outboundHandlers: Record<string, unknown>;
      }
    ).outboundHandlers = {
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
      {
        containerId: "c1",
        className: "AnalysisSandbox",
        params: { orgId: "org1", workspaceId: "ws1" },
      } as never,
    )) as Response;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; actions: string[] };
    expect(body.ok).toBe(true);
    expect(body.actions).toContain("invoke");
  });
});
