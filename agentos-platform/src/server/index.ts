import { createPlatform } from "./platform/index.ts";
import { registry } from "./registry.ts";
import { setChatThreadAgentOsPlatform } from "./actors/chat-thread-agentos.ts";

export const platform = createPlatform({ ensureDemoTenant: true });
setChatThreadAgentOsPlatform(platform);

const demo = platform.identity.ensureDemoTenant();
const port = Number(process.env.PORT ?? "6420");

if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

console.log("camelAI agentOS demo tenant", {
  orgId: demo.org.id,
  workspaceId: demo.workspace.id,
  userId: demo.user.id,
});
console.log(`camelAI agentOS server listening at http://localhost:${port}`);

await registry.listen({ port });
