import { describe, expect, it, vi } from "vitest";

import {
  boundLakeErrorMessage,
  sendToolCallRecords,
  toolBlocksOnHuman,
  type ToolCallLakeRecord,
} from "../src/lake-streams";

function record(index: number): ToolCallLakeRecord {
  return {
    ingested_at_ms: index,
    ts_ms: index,
    thread_id: "thread-1",
    org_id: "org-1",
    workspace_id: "workspace-1",
    user_id: "user-1",
    turn_id: "",
    tool_call_id: `call-${index}`,
    parent_tool_call_id: "js-exec-1",
    tool_name: "deploy_project",
    surface: "code_mode",
    model: "",
    provider: "",
    duration_ms: 10,
    ok: true,
    error_message: "",
    blocks_on_human: false,
    result_chars: 12,
  };
}

describe("tool-call lake writer", () => {
  it("is optional and bounds error metadata", () => {
    expect(() => sendToolCallRecords(undefined, [record(1)])).not.toThrow();
    expect(boundLakeErrorMessage("x".repeat(1_000))).toBe(
      `${"x".repeat(512)}…`,
    );
  });

  it("preserves the human-blocking classification", () => {
    expect(toolBlocksOnHuman("AskUserQuestion")).toBe(true);
    expect(toolBlocksOnHuman("prompt_connection_setup")).toBe(true);
    expect(toolBlocksOnHuman("deploy_project")).toBe(false);
  });

  it("sends finite batches without owning the caller", async () => {
    const batches: ToolCallLakeRecord[][] = [];
    sendToolCallRecords(
      {
        TOOL_CALLS_LAKE: {
          send: async (records) => {
            batches.push(records);
          },
        },
      },
      Array.from({ length: 51 }, (_, index) => record(index)),
    );

    await vi.waitFor(() =>
      expect(batches.map((batch) => batch.length)).toEqual([50, 1]),
    );
  });
});
