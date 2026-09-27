import { describe, expect, it } from "vitest";

import { CodeModeToolsBinding } from "../src/code-mode-tools";

type Lister = (this: unknown, args: Record<string, unknown>) => Promise<any>;
const listApps = (CodeModeToolsBinding.prototype as unknown as { listApps: Lister }).listApps;
const listDeployVersions = (CodeModeToolsBinding.prototype as unknown as { listDeployVersions: Lister }).listDeployVersions;

const scripts = Array.from({ length: 125 }, (_, index) => ({
  script_name: `app-${String(index).padStart(3, "0")}`,
  workspace_id: "ws1",
  is_public: false,
  created_by: "user1",
  created_at: 1_000 + index,
  updated_at: 2_000 + index,
  preview_status: "ready",
  project_id: `project-${index}`,
  commit_sha: null,
  artifact_cache_key: null,
}));

function fakeBinding(versions: number[] = []) {
  return {
    ctx: { props: { workspaceId: "ws1" } },
    getAppUrl: async (script: { script_name: string }) => `https://${script.script_name}.example`,
    orgStub: {
      listWorkerScriptsByWorkspace: async () => scripts,
      getWorkerScript: async (name: string) => ({ script_name: name, workspace_id: "ws1" }),
      listWorkerScriptDeployVersions: async (_name: string, _workspace: string, limit: number, offset: number) =>
        versions.slice(offset, offset + limit).map((id) => ({ id: `v${id}`, created_at: id, created_by: "user1" })),
    },
  };
}

describe("list_apps pages", () => {
  it("returns every app without a limit, and pages with limit and offset", async () => {
    const all = await listApps.call(fakeBinding(), {});
    expect(all).toMatchObject({ total: 125, count: 125, offset: 0, next_offset: null, status_counts: { ready: 125 }, filters: { fields: "summary" } });
    // Over 50 apps: names and links unless full rows are asked for.
    expect(Object.keys(all.apps[0])).toEqual(["name", "url", "preview_status", "updated_at"]);
    const full = await listApps.call(fakeBinding(), { fields: "full", limit: 1 });
    expect(full.apps[0]).toHaveProperty("project_id");
    expect((await listApps.call(fakeBinding(), { limit: 10 })).apps[0]).toHaveProperty("commit_sha");

    const first = await listApps.call(fakeBinding(), { limit: 100, sort: "name_asc" });
    expect(first).toMatchObject({ total: 125, count: 100, next_offset: 100 });
    const second = await listApps.call(fakeBinding(), { limit: 100, offset: first.next_offset, sort: "name_asc" });
    expect(second).toMatchObject({ total: 125, count: 25, offset: 100, next_offset: null });
    const names = [...first.apps, ...second.apps].map((app: { name: string }) => app.name);
    expect(new Set(names).size).toBe(125);
    expect(names[0]).toBe("app-000");
  });

  it("sorts by name descending and gives a summary per app on request", async () => {
    const result = await listApps.call(fakeBinding(), { sort: "name_desc", limit: 2, fields: "summary" });
    expect(result.apps).toEqual([
      { name: "app-124", url: "https://app-124.example", preview_status: "ready", updated_at: new Date(2_124).toISOString() },
      { name: "app-123", url: "https://app-123.example", preview_status: "ready", updated_at: new Date(2_123).toISOString() },
    ]);
  });
});

describe("list_deploy_versions pages", () => {
  it("says where the next page starts, and null on the last", async () => {
    const versions = Array.from({ length: 30 }, (_, index) => 30 - index);
    const first = await listDeployVersions.call(fakeBinding(versions), { script_name: "app-000" });
    expect(first).toMatchObject({ count: 20, offset: 0, next_offset: 20 });
    const last = await listDeployVersions.call(fakeBinding(versions), { script_name: "app-000", offset: 20 });
    expect(last).toMatchObject({ count: 10, offset: 20, next_offset: null });
    expect(last.versions[0].id).toBe("v10");
  });
});
