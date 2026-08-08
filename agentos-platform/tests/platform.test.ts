import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  BillingService,
  IdentityService,
  ProjectFilesystem,
  Store,
  createPlatform,
} from "../src/server/platform/index.ts";

const tempDirs: string[] = [];

function tempDataDir(prefix = "agentos-platform-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

describe("Store", () => {
  it("get/set/delete and listByPrefix round-trip through the JSON file", () => {
    const dataDir = tempDataDir();
    const store = new Store({ dataDir });
    store.set("org:a", { id: "a" });
    store.set("org:b", { id: "b" });
    store.set("thread:1", { id: "1" });

    expect(store.get("org:a")).toEqual({ id: "a" });
    expect(store.listByPrefix("org:")).toEqual([
      { key: "org:a", value: { id: "a" } },
      { key: "org:b", value: { id: "b" } },
    ]);
    expect(store.delete("org:b")).toBe(true);
    expect(store.get("org:b")).toBeUndefined();

    const reloaded = new Store({ dataDir });
    expect(reloaded.get("org:a")).toEqual({ id: "a" });
    expect(reloaded.get("org:b")).toBeUndefined();
    expect(reloaded.listByPrefix("thread:")).toHaveLength(1);
  });

  it("rejects empty keys", () => {
    const store = new Store({ dataDir: tempDataDir() });
    expect(() => store.get("")).toThrow(/non-empty/);
    expect(() => store.set("", 1)).toThrow(/non-empty/);
  });
});

describe("IdentityService", () => {
  it("creates org, workspace, thread and lists threads", () => {
    const identity = new IdentityService(new Store({ dataDir: tempDataDir() }));
    const org = identity.createOrg({ name: "Acme" });
    const workspace = identity.createWorkspace({
      orgId: org.id,
      name: "Main",
    });
    const thread = identity.createThread({
      workspaceId: workspace.id,
      title: "Hello",
      model: "anthropic/claude-sonnet-4-5",
    });

    expect(thread.orgId).toBe(org.id);
    expect(thread.workspaceId).toBe(workspace.id);
    expect(identity.getThread(thread.id)?.title).toBe("Hello");
    expect(identity.listThreads(workspace.id)).toEqual([thread]);
  });

  it("ensureDemoTenant is idempotent", () => {
    const identity = new IdentityService(new Store({ dataDir: tempDataDir() }));
    const first = identity.ensureDemoTenant();
    const second = identity.ensureDemoTenant();
    expect(second).toEqual(first);
    expect(first.org.id).toBe("org_demo");
    expect(first.workspace.id).toBe("ws_demo");
    expect(first.user.email).toBe("demo@localhost");
  });

  it("refuses threads for missing workspaces", () => {
    const identity = new IdentityService(new Store({ dataDir: tempDataDir() }));
    expect(() => identity.createThread({ workspaceId: "missing" })).toThrow(
      /workspace not found/,
    );
  });
});

describe("ProjectFilesystem", () => {
  it("reads, writes, edits, lists, and deletes under the project root", () => {
    const dataDir = tempDataDir();
    const fs = new ProjectFilesystem({
      dataDir,
      workspaceId: "ws1",
      projectId: "proj1",
    });

    fs.mkdir("src");
    fs.write("src/index.ts", "export const n = 1;\n");
    expect(fs.read("src/index.ts")).toContain("n = 1");
    expect(fs.exists("src/index.ts")).toBe(true);

    const edited = fs.edit("src/index.ts", "n = 1", "n = 2");
    expect(edited.replacements).toBe(1);
    expect(fs.read("src/index.ts")).toContain("n = 2");

    const entries = fs.ls("src");
    expect(entries).toEqual([
      expect.objectContaining({
        name: "index.ts",
        path: "src/index.ts",
        type: "file",
      }),
    ]);

    fs.delete("src/index.ts");
    expect(fs.exists("src/index.ts")).toBe(false);
    expect(fs.root).toBe(join(dataDir, "projects", "ws1", "proj1"));
  });

  it("blocks path traversal", () => {
    const fs = new ProjectFilesystem({
      dataDir: tempDataDir(),
      workspaceId: "ws1",
      projectId: "proj1",
    });
    expect(() => fs.read("../secret")).toThrow(/escapes project root/);
    expect(() => fs.write("../../etc/passwd", "x")).toThrow(/escapes project root/);
    expect(() => fs.ls("..")).toThrow(/escapes project root/);
  });

  it("fails edit when oldText is missing or ambiguous", () => {
    const fs = new ProjectFilesystem({
      dataDir: tempDataDir(),
      workspaceId: "ws1",
      projectId: "proj1",
    });
    fs.write("a.txt", "one two one");
    expect(() => fs.edit("a.txt", "missing", "x")).toThrow(/not found/);
    expect(() => fs.edit("a.txt", "one", "ONE")).toThrow(/matched 2 times/);
    expect(fs.edit("a.txt", "one", "ONE", { replaceAll: true }).replacements).toBe(
      2,
    );
  });
});

describe("BillingService", () => {
  it("grants, checks hosted access, and consumes credits", () => {
    const billing = new BillingService(new Store({ dataDir: tempDataDir() }));
    expect(billing.canUseHostedModel("org1")).toBe(false);
    billing.grantCredits("org1", 500);
    expect(billing.getCreditBalance("org1")).toBe(500);
    expect(billing.canUseHostedModel("org1")).toBe(true);
    billing.consumeCredits("org1", 200);
    expect(billing.getCreditBalance("org1")).toBe(300);
    expect(() => billing.consumeCredits("org1", 999)).toThrow(/insufficient/);
  });

  it("persists balances across Store reloads", () => {
    const dataDir = tempDataDir();
    new BillingService(new Store({ dataDir })).grantCredits("org1", 100);
    const reloaded = new BillingService(new Store({ dataDir }));
    expect(reloaded.getCreditBalance("org1")).toBe(100);
  });
});

describe("createPlatform", () => {
  it("wires shared services and can seed a demo tenant", () => {
    const dataDir = tempDataDir();
    const platform = createPlatform({
      dataDir,
      ensureDemoTenant: true,
      demoCreditCents: 250,
    });

    const demo = platform.identity.ensureDemoTenant();
    expect(platform.billing.getCreditBalance(demo.org.id)).toBe(250);

    const thread = platform.identity.createThread({
      workspaceId: demo.workspace.id,
      title: "First",
    });
    expect(platform.identity.listThreads(demo.workspace.id)[0]?.id).toBe(
      thread.id,
    );

    const project = platform.projectFilesystem(demo.workspace.id, "app");
    project.write("README.md", "# hi\n");
    expect(project.read("README.md")).toBe("# hi\n");
    expect(platform.store).toBeInstanceOf(Store);
    expect(platform.dataDir).toBe(dataDir);
  });
});
