import { describe, expect, it } from "vitest";
import {
  ANALYSIS_NOTEBOOK_STDERR_MAX_CHARS,
  ANALYSIS_NOTEBOOK_STDOUT_MAX_CHARS,
} from "../src/analysis-service";
import { clampAnalysisRunOutputs } from "../src/code-mode-tools";

describe("clampAnalysisRunOutputs", () => {
  it("passes small outputs through untouched with no log to spill", () => {
    const input = { ok: true, stdout: "fine", stderr: "", exitCode: 0 };
    const { result, fullLog } = clampAnalysisRunOutputs(input);
    expect(result).toBe(input);
    expect(fullLog).toBeNull();
  });

  it("tail-clamps oversized stderr and returns the full combined log", () => {
    const noise = "progress line\n".repeat(5000);
    const stderr = `${noise}Traceback (most recent call last):\nNameError: nope\n`;
    const { result, fullLog } = clampAnalysisRunOutputs({ ok: false, stdout: "out", stderr, exitCode: 1 });

    const clamped = result.stderr as string;
    expect(clamped.length).toBeLessThanOrEqual(ANALYSIS_NOTEBOOK_STDERR_MAX_CHARS + 100);
    expect(clamped).toContain("NameError: nope"); // tail survives
    expect(clamped).toContain("earlier characters truncated");
    expect(result.stdout).toBe("out"); // under its own cap → untouched

    expect(fullLog).toContain(`=== stderr (${stderr.length} chars) ===`);
    expect(fullLog).toContain(noise.slice(0, 50)); // the clamped-away head is in the log
    expect(fullLog).toContain("NameError: nope");
  });

  it("clamps stdout independently of stderr", () => {
    const stdout = `${"x".repeat(ANALYSIS_NOTEBOOK_STDOUT_MAX_CHARS * 2)}TAIL`;
    const { result, fullLog } = clampAnalysisRunOutputs({ ok: true, stdout, stderr: "", exitCode: 0 });
    expect((result.stdout as string).endsWith("TAIL")).toBe(true);
    expect((result.stdout as string).length).toBeLessThanOrEqual(ANALYSIS_NOTEBOOK_STDOUT_MAX_CHARS + 100);
    expect(fullLog).toContain("TAIL");
  });

  it("tolerates results without string outputs", () => {
    const input = { ok: true, exitCode: 0 } as Record<string, unknown>;
    const { result, fullLog } = clampAnalysisRunOutputs(input);
    expect(result).toBe(input);
    expect(fullLog).toBeNull();
  });
});
