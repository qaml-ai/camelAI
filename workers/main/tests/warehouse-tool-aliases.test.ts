import { describe, expect, it, vi } from "vitest";

import { CodeModeToolsBinding } from "../src/code-mode-tools.js";
import { buildJsExecDescription } from "../src/chat-thread/pi-tools.js";

describe("hidden warehouse tool aliases", () => {
  it("keeps the aliases callable but hidden from discovery", async () => {
    const tools = await CodeModeToolsBinding.prototype.listTools.call({} as never);
    const byName = new Map(tools.map((tool) => [tool.name, tool]));

    for (const alias of ["warehouse_run_code", "warehouse_list_connections"]) {
      expect(byName.get(alias)).toMatchObject({ hidden: true });
    }

    expect(tools.filter((tool) => tool.hidden).map((tool) => tool.name).sort()).toEqual([
      "warehouse_list_connections",
      "warehouse_run_code",
    ]);
    expect(buildJsExecDescription(false)).not.toContain("warehouse_run_code");
    expect(buildJsExecDescription(false)).not.toContain("warehouse_list_connections");
  });

  it("delegates both aliases to the canonical implementations", async () => {
    const analysisRunCode = vi.fn(async () => ({ ok: true }));
    const analysisListConnections = vi.fn(async () => []);
    const binding = {
      analysisRunCode,
      analysisListConnections,
      callToolWithArtifactCapture: vi.fn(
        async (_name: string, _args: unknown, operation: () => Promise<unknown>) => operation(),
      ),
    };

    await CodeModeToolsBinding.prototype.callTool.call(
      binding,
      "warehouse_run_code",
      { code: "print(1)" },
    );
    await CodeModeToolsBinding.prototype.callTool.call(
      binding,
      "warehouse_list_connections",
      {},
    );

    expect(analysisRunCode).toHaveBeenCalledWith({ code: "print(1)" });
    expect(analysisListConnections).toHaveBeenCalledOnce();
  });
});
