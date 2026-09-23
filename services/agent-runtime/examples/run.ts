import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import assert from "node:assert/strict";

const root = await mkdtemp(join(tmpdir(), "camelai-client-demos-"));
const token = randomBytes(32).toString("hex");
const runtimeArgs = process.versions.bun ? [] : ["--experimental-strip-types"];
const env = { PATH: process.env.PATH, HOME: root, AGENT_RUNTIME_TOKEN: token, AGENT_DATA_DIR: root, AGENT_CLIENT_STATE_DIR: join(root, "sdk"), PORT: "0", AGENT_RUNTIME: process.env.AGENT_RUNTIME };
const server = spawn(process.execPath, [...runtimeArgs, fileURLToPath(new URL("../src/server.ts", import.meta.url))], { env, stdio: ["ignore", "pipe", "inherit"] });
const clients = new Set<ChildProcess>();
async function run(command: string, args: string[], base: string) {
  const child = spawn(command, args, { env: { ...env, AGENT_URL: base }, stdio: ["ignore", "pipe", "inherit"] });
  clients.add(child);
  let output = "";
  child.stdout.on("data", data => { output += data; process.stdout.write(data); });
  const [code] = await once(child, "close");
  clients.delete(child);
  if (code !== 0) throw new Error(`${command} demo exited ${code}`);
  return output;
}
try {
  const ready = Promise.withResolvers<number>();
  let output = "";
  const timeout = setTimeout(() => ready.reject(new Error("Demo server startup timed out")), 15_000);
  server.on("error", ready.reject);
  server.on("exit", code => ready.reject(new Error(`Demo server exited ${code}`)));
  server.stdout.on("data", data => {
    output += data;
    if (output.includes("\n")) ready.resolve(JSON.parse(output.split("\n")[0]).address.port);
  });
  let port: number;
  try { port = await ready.promise; } finally { clearTimeout(timeout); }
  const base = `http://127.0.0.1:${port}`;
  console.log("One host, two stacks, two independent agents. Scripted mode: no model credentials needed.");
  const [typescript, python] = await Promise.all([
    run(process.execPath, [...runtimeArgs, fileURLToPath(new URL("./release-board.ts", import.meta.url))], base),
    run(process.env.PYTHON ?? "python3", [fileURLToPath(new URL("./inventory.py", import.meta.url))], base),
  ]);
  assert.match(typescript, /HOLD release: APP-41/);
  assert.match(python, /"quantity": 32/);
  assert.match(python, /"quantity": 24/);
  console.log("\nBoth client-owned applications updated through QuickJS → SSE + HTTP → local functions.");
} finally {
  for (const child of clients) child.kill("SIGTERM");
  if (server.exitCode === null) {
    const stopped = once(server, "close");
    server.kill("SIGTERM");
    await stopped;
  }
  await rm(root, { recursive: true, force: true });
}
