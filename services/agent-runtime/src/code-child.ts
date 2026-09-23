import { parentRpc } from "./rpc.ts";
import { runSandbox } from "./quickjs-sandbox.ts";

const rpc = parentRpc();
let used = false;
rpc.handler = async (method, params) => {
  if (method !== "execute" || used) throw new Error("Codemode child accepts one execution");
  used = true;
  return runSandbox({
    code: params.code,
    tools: params.tools,
    timeoutMs: params.timeoutMs,
    maxOutputCharacters: params.maxOutputCharacters,
    call: (name, args) => rpc.request("tool", { name, args }),
    onOutput: text => rpc.send({ type: "event", event: { type: "output", text } }),
  });
};
