/**
 * Boots the Rivet registry and exercises sendMessage over the real client.
 * Usage: bun run scripts/live-smoke.mjs
 */
import { createPlatform } from "../src/server/platform/index.ts";
import { registry } from "../src/server/registry.ts";

process.env.AGENT_RUNTIME = "mock";
createPlatform({ ensureDemoTenant: true });
registry.start();

const endpoint = "http://127.0.0.1:6420";
for (let attempt = 0; attempt < 50; attempt++) {
  try {
    const res = await fetch(endpoint);
    if (res.ok || res.status >= 400) break;
  } catch {
    // engine not ready
  }
  await new Promise((r) => setTimeout(r, 100));
}

const { createClient } = await import("rivetkit/client");
const client = createClient(endpoint);
const threadId = `live_smoke_${crypto.randomUUID().slice(0, 8)}`;
const handle = client.chatThread.getOrCreate(threadId, {
  createWithInput: {
    threadId,
    workspaceId: "ws_demo",
    orgId: "org_demo",
    projectId: "app",
    title: "Live smoke",
  },
});

const clientMessageId = crypto.randomUUID();
const send = await Promise.race([
  handle.sendMessage("hello live smoke", clientMessageId),
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error("sendMessage timed out")), 20_000),
  ),
]);
const messages = await handle.getMessages();

const summary = {
  endpoint,
  threadId,
  send,
  messageCount: messages.length,
  roles: messages.map((m) => m.role),
};
console.log(JSON.stringify(summary, null, 2));

if (!send || typeof send !== "object" || send.status !== "completed") {
  console.error("unexpected send status", send);
  process.exit(1);
}
if (messages.length < 2) {
  console.error("expected user+assistant messages");
  process.exit(1);
}

console.log("LIVE_SMOKE_OK");
process.exit(0);
