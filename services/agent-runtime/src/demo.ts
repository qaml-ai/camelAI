import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSupervisor } from "./supervisor.ts";
import { localTools } from "./local-tools.ts";
import { configuredModel } from "./model.ts";

const root = await mkdtemp(join(tmpdir(), "camelai-agent-demo-"));
const supervisor = new AgentSupervisor(join(root, "sessions"), { runtime: process.env.AGENT_RUNTIME });
try {
  const model = configuredModel();
  for (const id of ["alpha", "beta"]) {
    const info = await supervisor.start(id, { model }, await localTools(join(root, "workspaces", id)));
    console.log(`${id}: agent PID ${info.pid}`);
  }
  const results = await Promise.all(["alpha", "beta"].map(id => supervisor.request(id, "execute", { code: `
    await tools.write({path: "hello.txt", content: "Hello from ${id}"});
    const [file, catalog] = await Promise.all([tools.read({path: "hello.txt"}), tools.search("read")]);
    console.log(file.data.text);
    return {processAccess: typeof process, availableTools: catalog.map(t => t.name)};
  ` })));
  console.log(JSON.stringify(results, null, 2));
  try { await supervisor.request("alpha", "execute", { code: "while (true) {}", timeoutMs: 1000 }); }
  catch (error) { console.log(`Hung script contained: ${(error as Error).message}`); }
  console.log("Agent still alive:", await supervisor.request("alpha", "status"));
} finally { await supervisor.close(); await rm(root, { recursive: true, force: true }); }
