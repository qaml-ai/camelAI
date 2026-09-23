import { createExecutorServer } from "./executor.ts";

// Executor host entry point. Its environment should hold only AGENT_EXECUTOR_TOKEN
// (plus PORT/HOST); it is read once and then the whole environment is dropped, so a
// guest that escapes into this process finds no secrets there. Children never
// inherit it either: childProcess spawns them with a fixed PATH/HOME/TMPDIR.
const token = process.env.AGENT_EXECUTOR_TOKEN ?? "";
const port = Number(process.env.PORT ?? 8790);
const host = process.env.HOST ?? "127.0.0.1";
const maxConcurrent = Number(process.env.AGENT_EXECUTOR_MAX_CONCURRENCY ?? 8);
if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) throw new Error("AGENT_EXECUTOR_MAX_CONCURRENCY must be a positive integer");
const runtime = process.env.AGENT_RUNTIME;
for (const key of Object.keys(process.env)) if (key !== "PATH") delete process.env[key];

const server = createExecutorServer({ token, maxConcurrent, runtime });
server.listen(port, host, () => {
  console.log(JSON.stringify({ type: "listening", address: server.address(), maxConcurrent }));
});
for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => {
  // Running executions end with their runtime's deadline; stop taking new ones.
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 125_000).unref();
});
