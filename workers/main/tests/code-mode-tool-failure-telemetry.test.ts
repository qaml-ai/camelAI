import { describe, expect, it, vi } from "vitest";

import {
  CodeModeToolsBinding,
  CODE_MODE_TOOL_FAILURE_EVENT_BUDGET,
  CODE_MODE_VALUE_FAILURE_MESSAGE_MAX,
  toolValueFailureMessage,
} from "../src/code-mode-tools";

/**
 * The failure telemetry seam is `callToolEnvelope` — the boundary every
 * js_exec `tools.<name>()` call crosses. Production lost a whole class of
 * failures here: deploy_project reported `{ success: false }` as a VALUE, which
 * never reached the catch block, so `code_mode_project_tool_call_failed` showed
 * nothing while every attempt of a gated deploy failed.
 */
function createBinding(callTool: (name: string, args: unknown) => Promise<unknown>) {
  const binding = Object.create(CodeModeToolsBinding.prototype) as {
    callToolEnvelope(name: string, args?: unknown): Promise<{ ok: boolean; data?: unknown }>;
    [key: string]: unknown;
  };
  const observability = vi.fn();
  const errors = vi.fn();
  Object.assign(binding, {
    ctx: { props: { orgId: "org1", workspaceId: "ws1", threadId: "thread1", userId: "user1" } },
    env: {
      OBSERVABILITY_EVENTS: { writeDataPoint: observability },
      ERROR_ANALYTICS: { writeDataPoint: errors },
    },
    callTool: vi.fn(callTool),
  });
  return { binding, observability, errors };
}

/** The failure rows this binding wrote, as their AE blob arrays. */
function failureEvents(writeDataPoint: ReturnType<typeof vi.fn>): string[][] {
  return writeDataPoint.mock.calls
    .map((call) => (call[0] as { blobs?: unknown[] }).blobs as string[])
    .filter((blobs) => blobs?.[0] === "code_mode_project_tool_call_failed");
}

describe("toolValueFailureMessage", () => {
  it("recognizes both value-failure shapes and prefers the most specific message", () => {
    expect(toolValueFailureMessage({ success: false, errorSummary: "build failed" }))
      .toBe("build failed");
    expect(toolValueFailureMessage({ ok: false, error: "notebook blew up" }))
      .toBe("notebook blew up");
    expect(toolValueFailureMessage({ success: false })).toBe("tool reported an unsuccessful outcome");
  });

  it("leaves successes (and non-objects) alone", () => {
    expect(toolValueFailureMessage({ success: true })).toBeNull();
    expect(toolValueFailureMessage({ ok: true, error: "" })).toBeNull();
    expect(toolValueFailureMessage([{ success: false }])).toBeNull();
    expect(toolValueFailureMessage("deployed")).toBeNull();
    expect(toolValueFailureMessage(null)).toBeNull();
  });

  it("is not a failure when the payload is a SHELL outcome", () => {
    // analysis_exec/run_code/run_notebook/add_python_dependency report `ok:false`
    // for any non-zero exit of user code, and their `error` is the container's
    // RAW stderr (or stdout). A `grep` that matched nothing is not a tool
    // failure, and program output must never become an error-analytics blob.
    expect(toolValueFailureMessage({
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "grep: no match",
      error: "grep: no match",
    })).toBeNull();
    expect(toolValueFailureMessage({
      ok: false,
      stdout: "row: password=hunter2",
      error: "row: password=hunter2",
    })).toBeNull();
  });

  it("still records deploy_project, whose build detail is NESTED, not top-level", () => {
    // The shape deploy_project actually returns for a failed build: exit code and
    // log excerpt live under `build`, so the shell-outcome rule must not swallow
    // the one case this event was created for.
    expect(toolValueFailureMessage({
      success: false,
      stage: "build",
      project: "acme",
      errorSummary: "bun install failed",
      build: { success: false, exitCode: 1, logExcerpt: "…" },
    })).toBe("bun install failed");
  });

  it("is not a failure when the user declined a confirmation", () => {
    expect(toolValueFailureMessage({ success: false, cancelled: true })).toBeNull();
  });

  it("bounds the message, so it cannot inflate the dedupe key or the AE blob", () => {
    const message = toolValueFailureMessage({ success: false, error: "x".repeat(5_000) });
    expect(message).toHaveLength(CODE_MODE_VALUE_FAILURE_MESSAGE_MAX);
  });
});

describe("callToolEnvelope failure telemetry", () => {
  it("records a value-surfaced deploy_project failure that never threw", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { binding, observability, errors } = createBinding(async () => ({
        success: false,
        stage: "build",
        errorSummary: "bun install failed",
      }));

      const envelope = await binding.callToolEnvelope("deploy_project", { secret: "do-not-log" });

      // The agent still sees the operational payload; the platform now sees the
      // failure too.
      expect(envelope.ok).toBe(true);
      expect(envelope.data).toMatchObject({ success: false, stage: "build" });
      const recorded = failureEvents(observability);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toContain("deploy_project");
      // `surfaced` rides the provider column so a dashboard can split value vs throw.
      expect(recorded[0]).toContain("value");
      expect(errors).toHaveBeenCalledTimes(1);
      // Arguments are never logged.
      expect(JSON.stringify(observability.mock.calls)).not.toContain("do-not-log");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("do-not-log");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("covers every tool, not just deploy_project", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { binding, observability } = createBinding(async (name) =>
        name === "run_notebook"
          ? { ok: false, error: "cell 3 raised" }
          : { success: false, error: "domain is already claimed" });

      await binding.callToolEnvelope("run_notebook", {});
      await binding.callToolEnvelope("set_custom_domain", {});

      const recorded = failureEvents(observability);
      expect(recorded.map((blobs) => blobs[3])).toEqual(["run_notebook", "set_custom_domain"]);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("never puts a container's stderr in the error datasets or the logs", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // The exact shape analysis_exec returns for a non-zero exit: `error` is
      // execError(), i.e. the raw stderr of the user's own program.
      const stderr = "Traceback (most recent call last):\n  psycopg2 password=hunter2";
      const { binding, observability, errors } = createBinding(async () => ({
        ok: false,
        exitCode: 1,
        stdout: "",
        stderr,
        error: stderr,
        durationMs: 12,
      }));

      const envelope = await binding.callToolEnvelope("analysis_exec", { command: "psql ..." });

      // The agent still gets the full output; telemetry gets none of it.
      expect(envelope).toMatchObject({ ok: true, data: { ok: false, exitCode: 1 } });
      expect(failureEvents(observability)).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();
      expect(JSON.stringify(observability.mock.calls)).not.toContain("hunter2");
      expect(JSON.stringify(consoleError.mock.calls)).not.toContain("hunter2");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not record a user-declined confirmation as an error", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { binding, observability, errors } = createBinding(async () => ({
        success: false,
        cancelled: true,
        message: "delete_project was declined",
      }));

      await binding.callToolEnvelope("delete_project", {});

      expect(failureEvents(observability)).toHaveLength(0);
      expect(errors).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
  });

  it("records a value failure without fabricating a stack", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { binding, errors } = createBinding(async () => ({
        success: false,
        errorSummary: "bun install failed",
      }));

      await binding.callToolEnvelope("deploy_project", {});

      const blobs = errors.mock.calls[0]?.[0].blobs as string[];
      // errorName column: a value failure is not an exception…
      expect(blobs[4]).toBe("ToolValueFailure");
      // …and its stack blob is empty rather than this recorder's own frames.
      expect(blobs[13]).toBe("");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("keeps the throw path recording exactly once, with surfaced=throw", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { binding, observability } = createBinding(async () => {
        throw new Error("Network connection lost.");
      });

      const envelope = await binding.callToolEnvelope("deploy_project", {});

      expect(envelope).toEqual({
        ok: false,
        error: { tool: "deploy_project", message: "Network connection lost.", origin: "tool" },
      });
      const recorded = failureEvents(observability);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toContain("throw");
    } finally {
      consoleError.mockRestore();
    }
  });

  it("does not double-record when a throw is re-surfaced as a value downstream", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // A throw is caught here and handed to js_exec as { ok: false }; the value
      // branch must not fire for the same call.
      const { binding, observability } = createBinding(async () => {
        throw new Error("build service unavailable");
      });

      await binding.callToolEnvelope("deploy_project", {});

      expect(failureEvents(observability)).toHaveLength(1);
    } finally {
      consoleError.mockRestore();
    }
  });

  it("dedupes a looping script and stops at the per-instance budget", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let call = 0;
      const { binding, observability } = createBinding(async () => {
        call += 1;
        return { success: false, errorSummary: `failure ${call}` };
      });

      // Same failure repeated: one event.
      const { binding: looping, observability: loopingEvents } = createBinding(async () => ({
        success: false,
        errorSummary: "same failure every time",
      }));
      for (let index = 0; index < 25; index += 1) {
        await looping.callToolEnvelope("deploy_project", {});
      }
      expect(failureEvents(loopingEvents)).toHaveLength(1);

      // Distinct failures: capped by the budget.
      for (let index = 0; index < CODE_MODE_TOOL_FAILURE_EVENT_BUDGET + 5; index += 1) {
        await binding.callToolEnvelope("deploy_project", {});
      }
      expect(failureEvents(observability)).toHaveLength(CODE_MODE_TOOL_FAILURE_EVENT_BUDGET);
    } finally {
      consoleError.mockRestore();
    }
  });
});
