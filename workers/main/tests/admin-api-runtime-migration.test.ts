/**
 * Admin API: a thread's move to the runtime, dry-run and backoff clearing (routes/admin/runtime-migration-routes.ts).
 *
 * Run with: bun run test:workers
 */
import { describe, expect, it, vi } from "vitest";
import { env, runInDurableObject } from "cloudflare:test";

const { migrateMock } = vi.hoisted(() => ({ migrateMock: vi.fn() }));
vi.mock("../src/agent-runtime/thread-migration.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  migrateThreadToRuntime: migrateMock,
}));

import { handleAdminApi } from "../src/routes/admin/index";
import type { Env as WorkerEnv } from "../src/types";
import { RUNTIME_MIGRATION_KEY } from "../src/chat-thread/runtime-migration";
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

describe("POST /api/admin/runtime-migration/clear-backoff", () => {
  it("ends a failed move's backoff, and says so", async () => {
    const { userId } = await createUser(testEnv, `backoff-${crypto.randomUUID()}@example.com`, "password123", "Backoff");
    const { org, defaultWorkspaceId } = await createOrg(testEnv, "Backoff Org", userId);
    const thread = await testEnv.ORG.get(testEnv.ORG.idFromName(org.id)).createThread(defaultWorkspaceId as string, "Old thread", userId);
    const chat = testEnv.CHAT_THREAD.get(testEnv.CHAT_THREAD.idFromName(thread.id));
    await runInDurableObject(chat, async (_instance, state) => {
      state.storage.kv.put(RUNTIME_MIGRATION_KEY, {
        phase: "failed", failures: 1, retryAt: Date.now() + 24 * 60 * 60_000, error: "refused_400: no key", orgId: org.id, threadId: thread.id,
      });
    });

    const response = await post("/api/admin/runtime-migration/clear-backoff", { org_id: org.id, thread_id: thread.id });
    expect(response!.status).toBe(200);
    expect(await response!.json()).toMatchObject({ thread_id: thread.id, cleared: true, status: { state: null } });
    // Nothing left to clear.
    expect(await (await post("/api/admin/runtime-migration/clear-backoff", { org_id: org.id, thread_id: thread.id }))!.json()).toMatchObject({ cleared: false });
    expect((await post("/api/admin/runtime-migration/clear-backoff", { org_id: org.id, thread_id: "missing" }))!.status).toBe(404);
  });
});
