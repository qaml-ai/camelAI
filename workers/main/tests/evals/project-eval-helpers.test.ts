import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { WorkspaceFilesystemDO } from "../../src/workspace-filesystem-do";
import {
  capabilityChildUsedTools,
  completedToolDetails,
  countNotebookErrorOutputs,
  diffProjectFileSnapshots,
  hasSuccessfulNotebookRun,
  jsExecCodeMentionsTool,
  legacyDeployPathEvidence,
  readSkillWithTool,
  runtimeItemSucceeded,
  runtimeToolMentionOrder,
  runtimeToolReferenceOrder,
  seedDoProjectFiles,
  snapshotProjectFiles,
  succeededWithTool,
  toolCallReferences,
  toolProgressText,
  usedTool,
} from "./project-eval-helpers";

const testEnv = env as unknown as {
  WORKSPACE_FS: DurableObjectNamespace<WorkspaceFilesystemDO>;
  R2_BUCKET: R2Bucket;
};

describe("project eval runtime evidence extraction", () => {
  it("extracts completed capability details and child tool evidence", () => {
    const events = [{
      type: "runtime_event",
      event: {
        method: "item/completed",
        params: {
          item: {
            tool: "Oracle",
            status: "completed",
            result: {
              content: [{ type: "text", text: "done" }],
              details: { status: "completed", childToolsUsed: ["read", "edit", "write"] },
            },
          },
        },
      },
    }];

    expect(completedToolDetails(events, "Oracle")).toMatchObject({ status: "completed" });
    expect(capabilityChildUsedTools(events, "Oracle")).toEqual(["read", "edit", "write"]);
  });

  it("associates streamed progress text with its parent capability call", () => {
    const events = [
      {
        type: "runtime_event",
        event: {
          method: "item/started",
          params: { item: { id: "oracle-1", tool: "Oracle", status: "running" } },
        },
      },
      {
        type: "runtime_event",
        event: {
          method: "item/commandExecution/outputDelta",
          params: { itemId: "oracle-1", delta: "Oracle started." },
        },
      },
      {
        type: "runtime_event",
        event: {
          method: "item/commandExecution/outputDelta",
          params: { itemId: "research-1", delta: "Research started." },
        },
      },
    ];

    expect(toolProgressText(events, "Oracle")).toEqual(["Oracle started."]);
  });

  it("does not treat bare tool-name mentions as tool calls", () => {
    expect(jsExecCodeMentionsTool('const next = "list_apps";', "list_apps")).toBe(false);
    expect(jsExecCodeMentionsTool("list_apps;", "list_apps")).toBe(false);
  });

  it("accepts explicit tool call expressions", () => {
    expect(jsExecCodeMentionsTool("await tools.list_apps({});", "list_apps")).toBe(true);
    expect(jsExecCodeMentionsTool("await tools['set_preview']({});", "set_preview")).toBe(true);
    expect(jsExecCodeMentionsTool('await callTool("list_apps", {});', "list_apps")).toBe(true);
  });

  it("sees a skill read with read_skill, directly or from code", () => {
    const item = (fields: Record<string, unknown>) => ({
      type: "runtime_event",
      event: { method: "item/completed", params: { item: { status: "completed", ...fields } } },
    });
    expect(readSkillWithTool([item({ tool: "read_skill", arguments: { skill: "developing-software" } })], "developing-software")).toBe(true);
    expect(readSkillWithTool([item({ tool: "read_skill", arguments: { skill: "developing-software", file: "VANILLA-APPS.md" } })], "developing-software")).toBe(false);
    expect(readSkillWithTool([item({ tool: "js_exec", arguments: { code: 'return await tools.camel__read_skill({skill:"developing-software"});' } })], "developing-software")).toBe(true);
    expect(readSkillWithTool([item({ tool: "js_exec", arguments: { code: 'await tools.camel__read_skill({skill:"developing-software", file:"CRUD.md"});' } })], "developing-software")).toBe(false);
    expect(readSkillWithTool([item({ tool: "read_skill", status: "failed", isError: true, arguments: { skill: "developing-software" } })], "developing-software")).toBe(false);
  });

  it("accepts the agent runtime's server-prefixed tool names in code", () => {
    expect(jsExecCodeMentionsTool("await tools.camel__list_commits({ project: 'p' });", "list_commits")).toBe(true);
    expect(jsExecCodeMentionsTool("await tools['camel__set_preview']({});", "set_preview")).toBe(true);
    expect(jsExecCodeMentionsTool("await tools.camel__list_commits_all({});", "list_commits")).toBe(false);
  });

  it("matches direct and js_exec tool calls that reference the expected path", () => {
    const eventFor = (item: Record<string, unknown>) => ({
      type: "runtime_event",
      event: { method: "item/completed", params: { item: { status: "completed", ...item } } },
    });
    expect(toolCallReferences([
      eventFor({ tool: "set_preview", arguments: { path: "analysis.ipynb" } }),
    ], "set_preview", "analysis.ipynb")).toBe(true);
    expect(toolCallReferences([
      eventFor({ tool: "js_exec", arguments: { code: "await tools['set_preview']({ path: 'analysis.ipynb' });" } }),
    ], "set_preview", "analysis.ipynb")).toBe(true);
    expect(toolCallReferences([
      eventFor({ tool: "js_exec", arguments: { code: 'await callTool("set_preview", { path: "analysis.ipynb" });' } }),
    ], "set_preview", "analysis.ipynb")).toBe(true);
    expect(toolCallReferences([
      eventFor({ tool: "js_exec", arguments: { code: 'const note = "set_preview analysis.ipynb";' } }),
    ], "set_preview", "analysis.ipynb")).toBe(false);
    expect(toolCallReferences([
      eventFor({ tool: "js_exec", arguments: { code: "await tools.set_preview({ path: 'other.ipynb' });" } }),
    ], "set_preview", "analysis.ipynb")).toBe(false);
    expect(toolCallReferences([
      eventFor({
        tool: "js_exec",
        arguments: {
          code: [
            "await tools.set_preview({ path: 'wrong.ipynb' });",
            "const expectedPath = 'analysis.ipynb';",
          ].join("\n"),
        },
      }),
    ], "set_preview", "analysis.ipynb")).toBe(false);
    expect(toolCallReferences([
      eventFor({
        tool: "js_exec",
        arguments: {
          code: [
            "await tools.set_preview({ path: 'wrong.ipynb' });",
            "await callTool('set_preview', { path: 'analysis.ipynb' });",
          ].join("\n"),
        },
      }),
    ], "set_preview", "analysis.ipynb")).toBe(true);
    expect(toolCallReferences([
      eventFor({
        tool: "set_preview",
        status: "completed",
        arguments: { path: "analysis.ipynb" },
        result: { ok: false, error: "preview failed" },
      }),
    ], "set_preview", "analysis.ipynb")).toBe(false);
  });

  it("ignores tool-call text inside comments and strings", () => {
    expect(jsExecCodeMentionsTool("// await tools.set_preview({});", "set_preview")).toBe(false);
    expect(jsExecCodeMentionsTool("const example = 'tools.set_preview({})';", "set_preview")).toBe(false);
  });

  it("requires completed clean run_notebook result evidence", () => {
    const notebookResult = {
      ok: true,
      data: {
        ok: true,
        executed: true,
        validation: { clean: true, issues: [] },
        exitCode: 0,
      },
    };
    const eventFor = (overrides: Record<string, unknown> = {}) => ({
      type: "runtime_event",
      event: {
        method: "item/completed",
        params: {
          item: {
            tool: "js_exec",
            status: "completed",
            isError: false,
            arguments: { code: "return tools.run_notebook({ path: 'analysis.ipynb' });" },
            result: { details: { text: JSON.stringify(notebookResult) } },
            ...overrides,
          },
        },
      },
    });

    expect(hasSuccessfulNotebookRun([eventFor()], "analysis.ipynb")).toBe(true);
    expect(hasSuccessfulNotebookRun([
      eventFor({
        arguments: {
          code: [
            "const path = 'analysis.ipynb';",
            "return tools.run_notebook({ path });",
          ].join("\n"),
        },
        result: {
          details: {
            text: JSON.stringify({
              ...notebookResult,
              data: { ...notebookResult.data, changedFiles: ["analysis.ipynb"] },
            }),
          },
        },
      }),
    ], "analysis.ipynb")).toBe(true);
    expect(hasSuccessfulNotebookRun([
      eventFor({
        arguments: {
          code: [
            "const result = await tools.run_notebook({ path: 'wrong.ipynb' });",
            "const expectedPath = 'analysis.ipynb';",
            "return result;",
          ].join("\n"),
        },
      }),
    ], "analysis.ipynb")).toBe(false);
    expect(hasSuccessfulNotebookRun([
      eventFor({ status: "failed", isError: true }),
    ], "analysis.ipynb")).toBe(false);
    expect(hasSuccessfulNotebookRun([
      eventFor({
        result: {
          details: {
            text: JSON.stringify({
              ...notebookResult,
              data: { ...notebookResult.data, validation: { clean: false, issues: ["cell error"] } },
            }),
          },
        },
      }),
    ], "analysis.ipynb")).toBe(false);
    expect(hasSuccessfulNotebookRun([
      eventFor({ result: { ok: false, data: notebookResult.data } }),
    ], "analysis.ipynb")).toBe(false);
  });

  it("detects persisted Jupyter error outputs", () => {
    expect(countNotebookErrorOutputs([
      { cell_type: "code", outputs: [{ output_type: "stream", text: "ok" }] },
      {
        cell_type: "code",
        outputs: [{ output_type: "error", ename: "ValueError", traceback: ["boom"] }],
      },
    ])).toBe(1);
  });

  it("excludes explicitly failed runtime items from tool ordering", () => {
    const eventFor = (item: Record<string, unknown>) => ({
      type: "runtime_event",
      event: { method: "item/completed", params: { item } },
    });
    const events = [
      eventFor({
        tool: "js_exec",
        status: "completed",
        arguments: { code: "await tools.deploy_project({ project: 'demo' });" },
        result: { success: false },
      }),
      eventFor({
        tool: "set_preview",
        status: "failed",
        isError: true,
        arguments: { app_name: "demo" },
      }),
    ];

    expect(runtimeItemSucceeded({ status: "completed", result: { ok: false } })).toBe(false);
    expect(runtimeToolMentionOrder(events, ["deploy_project", "set_preview"]))
      .toEqual([]);
  });

  it("reports actual legacy scaffold and deploy commands directly", () => {
    const events = [{
      type: "runtime_event",
      event: {
        method: "item/completed",
        params: {
          item: {
            type: "commandExecution",
            command: "create-worker app && bun run deploy",
          },
        },
      },
    }];

    expect(legacyDeployPathEvidence(events)).toEqual([
      "used legacy deploy command(s): create-worker app && bun run deploy",
    ]);
  });

  it("associates file paths with writes and reads in call order", () => {
    const eventFor = (item: Record<string, unknown>) => ({
      type: "runtime_event",
      event: { method: "item/completed", params: { item } },
    });
    const references = [
      { id: "write-dashboard", toolName: "write", expectedText: "/index.html" },
      { id: "read-dashboard", toolName: "read", expectedText: "/index.html" },
    ];
    const unrelatedReads = [
      eventFor({ tool: "read", arguments: { path: "/README.md" } }),
      eventFor({ tool: "write", arguments: { path: "/index.html", content: "dashboard" } }),
      eventFor({ tool: "read", arguments: { path: "/SKILL.md" } }),
    ];
    expect(runtimeToolReferenceOrder(unrelatedReads, references))
      .toEqual(["write-dashboard"]);
    expect(runtimeToolReferenceOrder([
      ...unrelatedReads,
      eventFor({ tool: "read", arguments: { path: "/index.html" } }),
    ], references)).toEqual(["write-dashboard", "read-dashboard"]);
  });

  it("diffs added, removed, and modified paths across complete snapshots", () => {
    expect(diffProjectFileSnapshots(
      {
        "/README.md": "before",
        "/app/routes/home.tsx": "before",
        "/removed.ts": "before",
      },
      {
        "/README.md": "after",
        "/app/routes/home.tsx": "before",
        "/added.ts": "after",
      },
    )).toEqual({
      addedPaths: ["/added.ts"],
      removedPaths: ["/removed.ts"],
      modifiedPaths: ["/README.md"],
      changedPaths: ["/README.md", "/added.ts", "/removed.ts"],
    });
  });

  it("seeds scaffold and override files in a DO-backed project", async () => {
    const workspaceId = crypto.randomUUID();
    const workspaceFs = testEnv.WORKSPACE_FS.get(
      testEnv.WORKSPACE_FS.idFromName(workspaceId),
    );
    const { project, files } = await seedDoProjectFiles(workspaceFs, testEnv, {
      workspaceId,
      name: `seed-helper-${crypto.randomUUID().slice(0, 8)}`,
      description: "Seed helper test project.",
      files: { "/README.md": "overridden readme\n", "/fixture.txt": "fixture\n" },
    });

    expect(project.backend).toBe("do-r2");
    expect(await files.readFile("/README.md")).toMatchObject({
      success: true,
      content: "overridden readme\n",
    });
    expect(await files.readFile("/fixture.txt")).toMatchObject({
      success: true,
      content: "fixture\n",
    });
    expect(await files.exists("/package.json")).toMatchObject({ exists: true });

    const before = await snapshotProjectFiles(files);
    expect((await files.writeFile("/package.json", '{"changed":true}\n')).success).toBe(true);
    expect((await files.writeFile("/extra.ts", "export {};\n")).success).toBe(true);
    const diff = diffProjectFileSnapshots(before, await snapshotProjectFiles(files));
    expect(diff.modifiedPaths).toContain("/package.json");
    expect(diff.addedPaths).toContain("/extra.ts");
  });

  it("can seed a data-analysis scaffold with all execution state cleared", async () => {
    const workspaceId = crypto.randomUUID();
    const workspaceFs = testEnv.WORKSPACE_FS.get(
      testEnv.WORKSPACE_FS.idFromName(workspaceId),
    );
    const { files } = await seedDoProjectFiles(workspaceFs, testEnv, {
      workspaceId,
      name: `unexecuted-notebook-${crypto.randomUUID().slice(0, 8)}`,
      description: "Unexecuted notebook fixture.",
      template: "data-analysis",
      resetNotebookExecution: true,
      files: {},
    });

    const read = await files.readFile("/analysis.ipynb");
    expect(read.success).toBe(true);
    const notebook = JSON.parse(read.content ?? "{}") as {
      cells?: Array<{ cell_type?: string; execution_count?: number | null; outputs?: unknown[] }>;
    };
    const codeCells = notebook.cells?.filter((cell) => cell.cell_type === "code") ?? [];
    expect(codeCells.length).toBeGreaterThan(0);
    expect(codeCells.every((cell) => cell.execution_count === null)).toBe(true);
    expect(codeCells.every((cell) => Array.isArray(cell.outputs) && cell.outputs.length === 0)).toBe(true);
  });
});

describe("succeededWithTool", () => {
  function jsExecEvent(code: string, status: string, isError: boolean) {
    return {
      type: "runtime_event",
      event: {
        method: "item/completed",
        params: {
          item: {
            id: "j1",
            type: "dynamicToolCall",
            tool: "js_exec",
            status,
            isError,
            arguments: { code },
            result: { details: {} },
          },
        },
      },
    } as Record<string, unknown>;
  }

  function topLevelEvent(tool: string, status: string, isError: boolean) {
    return {
      type: "runtime_event",
      event: {
        method: "item/completed",
        params: {
          item: { id: "t1", type: "dynamicToolCall", tool, status, isError, result: { details: {} } },
        },
      },
    } as Record<string, unknown>;
  }

  it("accepts a top-level call that succeeded", () => {
    expect(succeededWithTool([topLevelEvent("get_custom_domain", "completed", false)], "get_custom_domain")).toBe(true);
  });

  it("rejects a top-level call that failed", () => {
    // The false green this helper exists to close: "Tool X not found" must not count.
    expect(succeededWithTool([topLevelEvent("get_custom_domain", "failed", true)], "get_custom_domain")).toBe(false);
  });

  it("accepts a lean-mode call nested in a successful js_exec", () => {
    // Lean-mode tools emit no runtime item of their own, so requiring a
    // top-level item would reject the path those evals are built to test.
    const events = [jsExecEvent("const r = await tools.get_custom_domain({});\nreturn r;", "completed", false)];
    expect(succeededWithTool(events, "get_custom_domain")).toBe(true);
  });

  it("rejects a nested call when the js_exec block itself failed", () => {
    // This is the line between succeededWithTool and usedTool: usedTool matches
    // the name in source text even when the block threw.
    const events = [jsExecEvent("await tools.get_custom_domain({});", "failed", true)];
    expect(succeededWithTool(events, "get_custom_domain")).toBe(false);
    expect(usedTool(events, "get_custom_domain")).toBe(true);
  });

  it("does not match an unrelated tool mentioned nowhere", () => {
    const events = [jsExecEvent("await tools.list_apps({});", "completed", false)];
    expect(succeededWithTool(events, "get_custom_domain")).toBe(false);
  });
});
