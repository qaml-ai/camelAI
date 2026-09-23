import { parentRpc } from "./rpc.ts";
import { createAgentHost } from "./agent-host.ts";

// One agent in its own process: the host's I/O goes over IPC to the supervisor.
const rpc = parentRpc(() => process.kill(-process.pid, "SIGKILL"));
const host = createAgentHost({
  emit: event => rpc.send({ type: "event", event }),
  tool: (name, args, toolCallId) => rpc.request("tool", { name, args, ...(toolCallId ? { toolCallId } : {}) }),
  cancelTools: () => rpc.request("cancel-tools"),
});
rpc.handler = (method, params) => host.handle(method, params);
