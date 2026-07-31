import { createPlatform } from "./platform/index.ts";
import { registry } from "./registry.ts";

export const platform = createPlatform({ ensureDemoTenant: true });

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

// Rivetkit embedded mode: start() boots the local engine (default :6420) and
// serves actor RPCs. Prefer start() over listen() — listen() races the engine
// bind when the runner already owns the port.
registry.start();

console.log(
  `camelAI agentOS server ready (Rivetkit client endpoint http://127.0.0.1:6420, PORT hint ${port})`,
);
