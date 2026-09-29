/**
 * Admin API: a thread's move to the runtime, dry-run (routes/admin/runtime-migration-routes.ts).
 *
 * Run with: bun run test:workers
 */
import { describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";

const { migrateMock } = vi.hoisted(() => ({ migrateMock: vi.fn() }));
vi.mock("../src/agent-runtime/thread-migration.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  migrateThreadToRuntime: migrateMock,
}));

import { handleAdminApi } from "../src/routes/admin/index";
import type { Env as WorkerEnv } from "../src/types";
import { createOrg, createUser, type TestEnv } from "./test-helpers";

const testEnv = env as unknown as TestEnv;

async function post(path: string, body: unknown) {
  const request = new Request(`http://example${path}`, {
    method: "POST",
    headers: { Authorization: "Bearer test-admin-api-key", "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return await handleAdminApi({
    req: request,
    env: { ...testEnv, ADMIN_API_KEY: "test-admin-api-key" } as unknown as WorkerEnv,
    ctx: {} as ExecutionContext,
    url: new URL(request.url),
    match: request.url.match(/^.*$/)!,
  });
}

describe("POST /api/admin/runtime-migration/dry-run", () => {
  it("dry-runs the thread's move as its creator in its own workspace, and says what it would import", async () => {
    const { userId } = await createUser(testEnv, `dry-run-${crypto.randomUUID()}@example.com`, "password123", "Dry Run");
    const { org, defaultWorkspaceId } = await createOrg(testEnv, "Dry Run Org", userId);
    const thread = await testEnv.ORG.get(testEnv.ORG.idFromName(org.id)).createThread(defaultWorkspaceId as string, "Old thread", userId);
    migrateMock.mockResolvedValueOnce({ status: "dry_run", stats: { total: 4, imported: 4 }, lossy: false, bytes: 1234 });

    const response = await post("/api/admin/runtime-migration/dry-run", { org_id: org.id, thread_id: thread.id });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({
      thread: { id: thread.id, title: "Old thread" },
      result: { status: "dry_run", bytes: 1234, lossy: false },
    });
    expect(migrateMock).toHaveBeenCalledWith(expect.anything(), {
      orgId: org.id, workspaceId: defaultWorkspaceId, threadId: thread.id, userId, userName: null, userEmail: null,
    }, { dryRun: true });

    expect((await post("/api/admin/runtime-migration/dry-run", { org_id: org.id, thread_id: "missing" }))!.status).toBe(404);
  });
});
