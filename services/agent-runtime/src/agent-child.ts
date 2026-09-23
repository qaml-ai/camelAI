import { parentRpc } from "./rpc.ts";
import { createAgentHost } from "./agent-host.ts";
import type { RemoteExecutor, ToolDispatch } from "./executions.ts";

// One agent in its own process: the host's I/O goes over IPC to the supervisor.
const rpc = parentRpc(() => process.kill(-process.pid, "SIGKILL"));

/** Remote executions in flight, by id. This process has no HTTP server, so the supervisor relays their tool callbacks here. */
const executions = new Map<string, ToolDispatch>();
const executor: RemoteExecutor = {
  async register(timeoutMs, dispatch) {
    const grant = await rpc.request("register-execution", { timeoutMs });
    executions.set(grant.id, dispatch);
    return { ...grant, release: () => {
      executions.delete(grant.id);
      rpc.request("release-execution", { id: grant.id }).catch(() => {});
    } };
  },
};

const host = createAgentHost({
  emit: event => rpc.send({ type: "event", event }),
  tool: (name, args, toolCallId) => rpc.request("tool", { name, args, ...(toolCallId ? { toolCallId } : {}) }),
  cancelTools: () => rpc.request("cancel-tools"),
  executor,
});
rpc.handler = (method, params) => {
  if (method !== "execution-tool") return host.handle(method, params);
  const dispatch = executions.get(params.id);
  if (!dispatch) throw new Error("Execution ended");
  return dispatch({ name: params.name, args: params.args });
};
