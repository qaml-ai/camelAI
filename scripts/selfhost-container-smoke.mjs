#!/usr/bin/env node

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { readSelfhostEnv } from "./selfhost-common.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const selfhostEnv = await readSelfhostEnv(false);
const workerdPath = path.join(repoRoot, "node_modules/workerd/bin/workerd");
const egressImage =
  process.env.SELFHOST_CONTAINER_EGRESS_IMAGE ||
  selfhostEnv.SELFHOST_CONTAINER_EGRESS_IMAGE ||
  "camelai-selfhost-container-egress:0.12.0";
const socketUri =
  process.env.SELFHOST_DOCKER_SOCKET_URI ||
  selfhostEnv.SELFHOST_DOCKER_SOCKET_URI ||
  "unix:///var/run/docker.sock";
const notebook = Buffer.from(
  JSON.stringify({
    cells: [
      {
        cell_type: "code",
        execution_count: null,
        metadata: {},
        outputs: [],
        source: ["print(6 * 7)"],
      },
    ],
    metadata: {
      kernelspec: {
        display_name: "Python 3",
        language: "python",
        name: "python3",
      },
      language_info: { name: "python" },
    },
    nbformat: 4,
    nbformat_minor: 5,
  }),
).toString("base64");
const archive =
  "UEsDBBQAAAAAAK9kCV0kaUB3GwAAABsAAAAJAAAAcHJvYmUudHh0Y2FtZWxhaS1hbmFseXNpcy1hcmNoaXZlLW9rUEsBAhQDFAAAAAAAr2QJXSRpQHcbAAAAGwAAAAkAAAAAAAAAAAAAAIABAAAAAHByb2JlLnR4dFBLBQYAAAAAAQABADcAAABCAAAAAAA=";
const analysisImage =
  process.env.SELFHOST_ANALYSIS_IMAGE ||
  selfhostEnv.SELFHOST_ANALYSIS_IMAGE ||
  "camelai-selfhost-analysis:1.0.0";
const runtimes = {
  // The real AnalysisContainer against the analysis image, through its
  // self-host sync mounts only: R2 -> container on prepare(), container -> R2
  // (writes and deletes) on flushMounts(), and a refresh that picks up a new
  // upload.
  mount: {
    className: "AnalysisContainer",
    native: "analysis",
    imageName: "analysis",
    image: analysisImage,
    marker: "camelai-local-r2-sync-ok",
    needsR2: true,
  },
  // The real ProjectBuildContainer (native ctx.container) against the
  // project-build image, through the calls a build makes.
  project: {
    className: "ProjectBuildContainer",
    native: "project",
    imageName: "project-build",
    image:
      process.env.SELFHOST_PROJECT_BUILD_IMAGE ||
      selfhostEnv.SELFHOST_PROJECT_BUILD_IMAGE ||
      "camelai-selfhost-project-build:1.0.0",
    marker: "camelai-project-build-ok",
  },
  // The same class and image through a whole analysis run: sync mounts,
  // notebook execution, the archive tool, egress (PyPI allowed, any other host
  // refused, connections.internal served in the Worker) and the exec timeout.
  analysis: {
    className: "AnalysisContainer",
    native: "analysis",
    imageName: "analysis",
    image: analysisImage,
    marker: "camelai-analysis-notebook-ok",
    needsR2: true,
    full: true,
  },
  // The real DbQueryContainer against the db-query image: drivers, the
  // background forwarder, the exec timeout, and a self-host export copied into
  // the R2 binding. SELFHOST_SMOKE_PUBLIC_DB=1 also runs a real query against
  // a public Postgres through runDbQuery (needs Internet from the container).
  "db-query": {
    className: "DbQueryContainer",
    native: "db-query",
    imageName: "db-query",
    image:
      process.env.SELFHOST_DB_QUERY_IMAGE ||
      selfhostEnv.SELFHOST_DB_QUERY_IMAGE ||
      "camelai-selfhost-db-query:1.0.0",
    marker: "camelai-db-query-ok",
    needsR2: true,
  },
};
const runtimeName = process.argv[2] || "project";
const runtime = runtimes[runtimeName];
if (!runtime) {
  throw new Error(
    `Unknown runtime ${runtimeName}; expected ${Object.keys(runtimes).join(", ")}`,
  );
}
const smokeRoot = path.join(repoRoot, ".selfhost");
await fs.mkdir(smokeRoot, { recursive: true });
const tempDir = await fs.mkdtemp(
  path.join(smokeRoot, "container-smoke-"),
);
const sourcePath = path.join(tempDir, "smoke.ts");
const bundlePath = path.join(tempDir, "smoke.js");
const configPath = path.join(tempDir, "smoke.capnp");
const statePath = path.join(tempDir, "state");
const r2StatePath = path.join(tempDir, "r2-state");
let child;

try {
  await fs.mkdir(statePath);
  await fs.mkdir(r2StatePath);
  const needsR2 = Boolean(runtime.needsR2);
  const nativeSource = `
import { ProjectBuildContainer } from ${JSON.stringify(path.join(repoRoot, "workers/main/src/project-build-container.ts"))};

export { ProjectBuildContainer };

export default {
  async fetch(_request, env) {
    // The container is removed with the others by cleanupSmokeContainers().
    const sandbox = env.SANDBOX.getByName("org-selfhost-smoke");
    const workdir = "/workspace/smoke";
    await sandbox.mkdir(workdir + "/src", { recursive: true });
    await sandbox.writeFile(workdir + "/src/index.ts", 'console.log("' + ${JSON.stringify("camelai-project-build-ok")} + '")');
    await sandbox.writeFile(workdir + "/archive.bin", new Blob(["streamed"]).stream());
    const build = await sandbox.exec(
      "bun build src/index.ts --outfile out/index.js >/dev/null && node out/index.js",
      { cwd: workdir, timeout: 120000, env: { CI: "1" } },
    );
    if (build.exitCode !== 0) return Response.json({ ...build, success: false });
    const listed = await sandbox.listFiles(workdir + "/out", { recursive: true, includeHidden: true });
    const bundle = await sandbox.readFileBytes(workdir + "/out/index.js");
    const streamed = await sandbox.readFile(workdir + "/archive.bin");
    const missing = await sandbox.readFileBytes(workdir + "/missing");
    const timedOut = await sandbox.exec("sleep 30", { timeout: 1000 });
    const checks = [
      listed.files.some((file) => file.relativePath === "index.js"),
      bundle.byteLength > 0,
      streamed.content === "streamed",
      missing === null,
      timedOut.timedOut === true,
    ];
    if (checks.includes(false)) {
      return Response.json({ success: false, stdout: build.stdout, checks });
    }
    return Response.json({ success: true, stdout: build.stdout });
  },
};
`;
  const analysisSource = `
import {
  AnalysisConnectionsGateway,
  AnalysisContainer,
  AnalysisEgress,
} from ${JSON.stringify(path.join(repoRoot, "workers/main/src/analysis-container.ts"))};

export { AnalysisConnectionsGateway, AnalysisContainer, AnalysisEgress };

const ACCESS = { mode: "agent", orgId: "org-smoke", workspaceId: "ws-smoke" };
const UPLOADS = "org-smoke/ws-smoke/user-uploads";
const OUTPUTS = "org-smoke/ws-smoke/user-outputs";
const FULL = ${JSON.stringify(Boolean(runtime.full))};

export default {
  async fetch(_request, env) {
    // The container is removed with the others by cleanupSmokeContainers().
    const bucket = env.R2_BUCKET;
    await bucket.put(UPLOADS + "/input.txt", "from-r2");
    await bucket.put("warehouse/ws-smoke/export.txt", "export-ok");
    if (FULL) {
      const archiveBytes = Uint8Array.from(atob(${JSON.stringify(archive)}), (c) => c.charCodeAt(0));
      await bucket.put(UPLOADS + "/source.zip", archiveBytes);
    }
    const sandbox = env.SANDBOX.getByName("ws-smoke");
    await sandbox.prepare(ACCESS);
    const run = (command, timeoutMs = 120000) => sandbox.exec(command, { cwd: "/root", timeoutMs });
    const checks = {};
    const outputs = [];

    const seeded = await run("cat /uploads/input.txt /warehouse/ws-smoke/export.txt");
    checks.seeded = seeded.stdout === "from-r2export-ok";
    await run("printf from-container > /outputs/result.txt");
    await sandbox.flushMounts();
    const persisted = await bucket.get(OUTPUTS + "/result.txt");
    checks.persisted = Boolean(persisted) && (await persisted.text()) === "from-container";
    await run("rm /outputs/result.txt");
    await sandbox.flushMounts();
    checks.deletedFromR2 = (await bucket.head(OUTPUTS + "/result.txt")) === null;
    await bucket.put(UPLOADS + "/later.txt", "later");
    await sandbox.prepare(ACCESS);
    checks.refreshed = (await run("cat /uploads/later.txt")).stdout === "later";
    outputs.push(${JSON.stringify(runtime.full ? "" : "camelai-local-r2-sync-ok")});

    if (FULL) {
      const archiveResult = await run(
        "rm -rf /tmp/camelai-archive-smoke && mkdir -p /tmp/camelai-archive-smoke && cd /tmp/camelai-archive-smoke " +
        "&& CAMELAI_ARCHIVE_ACTION=list CAMELAI_ARCHIVE_PATH=/uploads/source.zip " +
        "python /usr/local/bin/camelai-archive > /tmp/camelai-archive-list.json " +
        "&& grep -q 'extractable.*true' /tmp/camelai-archive-list.json " +
        "&& CAMELAI_ARCHIVE_ACTION=extract CAMELAI_ARCHIVE_PATH=/uploads/source.zip " +
        "CAMELAI_ARCHIVE_DESTINATION=imported python /usr/local/bin/camelai-archive " +
        "> /tmp/camelai-archive-extract.json " +
        "&& grep -qx camelai-analysis-archive-ok imported/probe.txt && echo camelai-analysis-archive-ok",
      );
      checks.archive = archiveResult.exitCode === 0;
      outputs.push(archiveResult.stdout, archiveResult.stderr);
      const notebook = await run(${JSON.stringify(
        `printf '%s' '${notebook}' | base64 -d > /tmp/smoke.ipynb ` +
        "&& python /usr/local/bin/execute-notebook /tmp/smoke.ipynb " +
        `&& python -c "import json; d=json.load(open('/tmp/smoke.ipynb')); ` +
        `assert ''.join(d['cells'][0]['outputs'][0]['text']) == '42\\\\n'; ` +
        `print('camelai-analysis-notebook-ok')"`,
      )}, 300000);
      checks.notebook = notebook.exitCode === 0;
      outputs.push(notebook.stdout, notebook.stderr);
      const code = (url) => run("curl -sS -m 30 -o /dev/null -w '%{http_code}' " + url + " || true", 60000);
      const pypi = await code("https://pypi.org/simple/tabulate/");
      checks.pypiAllowed = pypi.stdout === "200";
      const blocked = await code("https://example.com/");
      checks.otherHostBlocked = blocked.stdout !== "200";
      const blockedHttp = await code("http://example.com/");
      checks.otherHostBlockedHttp = blockedHttp.stdout !== "200";
      const connections = await run("curl -sS -m 30 http://connections.internal/", 60000);
      checks.connections = connections.stdout.includes("invoke");
      const timedOut = await sandbox.exec("sleep 30", { cwd: "/", timeoutMs: 1000 });
      checks.timeout = timedOut.timedOut === true;
      outputs.push("pypi=" + pypi.stdout, "example.com=" + blocked.stdout + "/" + blockedHttp.stdout);
    }

    const success = !Object.values(checks).includes(false);
    return Response.json({ success, checks, stdout: outputs.join("\\n") });
  },
};
`;
  await fs.writeFile(
    sourcePath,
    runtime.native === "project" ? nativeSource
    : runtime.native === "analysis" ? analysisSource
    : `export * from ${JSON.stringify(path.join(repoRoot, "scripts/selfhost-db-query-smoke-worker.ts"))};\n` +
      `export { default } from ${JSON.stringify(path.join(repoRoot, "scripts/selfhost-db-query-smoke-worker.ts"))};\n`,
  );

  // Bun.build instead of `bun build` for the plugin: db-query-service.ts
  // imports the runner source as a virtual module (as the Worker build does).
  const buildScriptPath = path.join(tempDir, "build.mjs");
  await fs.writeFile(
    buildScriptPath,
    `
import fs from "node:fs/promises";
const runnerSource = await fs.readFile(${JSON.stringify(path.join(repoRoot, "workers/main/db-query-sandbox-assets/runner/db-query-runner.mjs"))}, "utf8");
const result = await Bun.build({
  entrypoints: [${JSON.stringify(sourcePath)}],
  outdir: ${JSON.stringify(tempDir)},
  naming: ${JSON.stringify(path.basename(bundlePath))},
  target: "browser",
  format: "esm",
  external: ["cloudflare:workers", "node:*"],
  plugins: [{
    name: "db-query-runner-source",
    setup(builder) {
      builder.onResolve({ filter: /^virtual:db-query-runner-source$/ }, () => ({ path: "runner", namespace: "smoke-virtual" }));
      builder.onLoad({ filter: /.*/, namespace: "smoke-virtual" }, () => ({
        contents: "export default " + JSON.stringify(runnerSource) + ";",
        loader: "js",
      }));
    },
  }],
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
`,
  );
  await run("bun", [buildScriptPath]);

  await fs.writeFile(
    configPath,
    `using Workerd = import "/workerd/workerd.capnp";

const smoke :Workerd.Config = (
  services = [
    (name = "smoke", worker = (
      compatibilityDate = "2026-06-09",
      compatibilityFlags = ["nodejs_compat"],
      modules = [(name = "smoke.js", esModule = embed "smoke.js")],
      bindings = [
        (name = "SANDBOX", durableObjectNamespace = (
          className = ${JSON.stringify(runtime.className)}
        ))${needsR2 ? `,
        (name = "R2_BUCKET", r2Bucket = (name = "r2:bucket:smoke")),
        (name = "WAREHOUSE_EXPORT_BUCKET", r2Bucket = (name = "r2:bucket:smoke")),
        (name = "CF_ACCOUNT_ID", text = "selfhost"),
        (name = "SMOKE_PUBLIC_DB", text = ${JSON.stringify(process.env.SELFHOST_SMOKE_PUBLIC_DB === "1" ? "1" : "0")})` : ""}
      ],
      globalOutbound = "internet",
      durableObjectNamespaces = [(
        className = ${JSON.stringify(runtime.className)},
        uniqueKey = ${JSON.stringify(`camelai-selfhost-container-smoke-${runtimeName}`)},
        enableSql = true,
        container = (images = [(name = ${JSON.stringify(runtime.imageName)}, image = ${JSON.stringify(runtime.image)})])
      )],
      durableObjectStorage = (localDisk = "do-storage"),
      containerEngine = (localDocker = (
        socketPath = ${JSON.stringify(socketUri)},
        containerEgressInterceptorImage = ${JSON.stringify(egressImage)}
      ))
    )),
    (name = "do-storage", disk = (
      path = ${JSON.stringify(statePath)},
      writable = true
    )),
${needsR2 ? `    (name = "r2:bucket:smoke", worker = (
      compatibilityDate = "2023-07-24",
      modules = [(name = "object-entry.worker.js", esModule = embed ${JSON.stringify(path.relative(tempDir, path.join(repoRoot, "node_modules/miniflare/dist/src/workers/shared/object-entry.worker.js")))})],
      bindings = [
        (name = "MINIFLARE_NAMESPACE", text = "smoke"),
        (name = "MINIFLARE_OBJECT", durableObjectNamespace = (className = "R2BucketObject", serviceName = "r2:bucket"))
      ]
    )),
    (name = "r2:bucket", worker = (
      compatibilityDate = "2023-07-24",
      compatibilityFlags = ["nodejs_compat", "experimental"],
      modules = [
        (name = "bucket.worker.js", esModule = embed ${JSON.stringify(path.relative(tempDir, path.join(repoRoot, "node_modules/miniflare/dist/src/workers/r2/bucket.worker.js")))}),
        (name = "miniflare:shared", esModule = embed ${JSON.stringify(path.relative(tempDir, path.join(repoRoot, "node_modules/miniflare/dist/src/workers/shared/index.worker.js")))}),
        (name = "miniflare:zod", esModule = embed ${JSON.stringify(path.relative(tempDir, path.join(repoRoot, "node_modules/miniflare/dist/src/workers/shared/zod.worker.js")))}),
        (name = "node-internal:internal_assert", esModule = "import assert from \\"node:assert\\"; export default assert; export * from \\"node:assert\\";"),
        (name = "node-internal:internal_buffer", esModule = "export { Buffer } from \\"node:buffer\\";")
      ],
      durableObjectNamespaces = [(className = "R2BucketObject", uniqueKey = "miniflare-R2BucketObject", enableSql = true)],
      durableObjectStorage = (localDisk = "r2-storage"),
      bindings = [
        (name = "MINIFLARE_BLOBS", service = (name = "r2-storage")),
        (name = "MINIFLARE_LOOPBACK", service = (name = "loopback"))
      ]
    )),
    (name = "r2-storage", disk = (
      path = ${JSON.stringify(r2StatePath)},
      writable = true
    )),
    (name = "loopback", network = (
      allow = ["local"],
      tlsOptions = (trustBrowserCas = true)
    )),
` : ""}
    (name = "internet", network = (
      allow = ["public", "private"],
      tlsOptions = (trustBrowserCas = true)
    ))
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:0", http = (), service = "smoke")
  ]
);
`,
  );

  await run(
    workerdPath,
    ["compile", "--config-only", configPath],
    ["ignore", "ignore", "inherit"],
  );
  const port = await availablePort();
  const logs = [];
  child = spawn(
    workerdPath,
    [
      "serve",
      configPath,
      "smoke",
      "--experimental",
      `--socket-addr=http=127.0.0.1:${port}`,
    ],
    {
      cwd: tempDir,
      stdio: process.env.SELFHOST_SMOKE_DEBUG === "1"
        ? ["ignore", "inherit", "inherit"]
        : ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout?.on("data", (chunk) => logs.push(String(chunk)));
  child.stderr?.on("data", (chunk) => logs.push(String(chunk)));

  const response = await poll(`http://127.0.0.1:${port}/`, child, logs);
  const result = await response.json();
  if (!result.success || !result.stdout.includes(runtime.marker)) {
    throw new Error(`Unexpected sandbox response: ${JSON.stringify(result)}`);
  }
  console.log(
    `Self-host ${runtimeName} localDocker smoke passed with ${runtime.image}.` +
      (result.checks ? ` Checks: ${Object.keys(result.checks).join(", ")}.` : ` (${String(result.stdout ?? "").trim()})`),
  );
} finally {
  if (child && child.exitCode === null) {
    // workerd can keep serving while an attached container is still running,
    // so SIGTERM alone may never end it. Escalate; cleanupSmokeContainers()
    // removes whatever it left behind.
    const exited = new Promise((resolve) => child.once("exit", resolve));
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(killTimer);
  }
  await cleanupSmokeContainers();
  if (process.env.SELFHOST_SMOKE_KEEP === "1") {
    console.log(`Kept smoke files at ${tempDir}`);
  } else {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}

function run(command, args, stdio = "inherit") {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      cwd: repoRoot,
      stdio,
    });
    childProcess.once("error", reject);
    childProcess.once("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function cleanupSmokeContainers() {
  const namePrefix =
    `workerd-camelai-selfhost-container-smoke-${runtimeName}`;
  // workerd can exit just before its egress sidecar appears in Docker. Poll
  // briefly so the smoke never leaks that late-created container into CI.
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const ids = await listSmokeContainerIds(namePrefix);
    if (ids.length > 0) {
      await removeSmokeContainers(ids);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  const remaining = await listSmokeContainerIds(namePrefix);
  if (remaining.length > 0) {
    throw new Error(
      `Failed to clean up smoke containers: ${remaining.join(", ")}`,
    );
  }
}

async function listSmokeContainerIds(namePrefix) {
  try {
    const listed = await capture("docker", [
      "ps",
      "--all",
      "--quiet",
      "--filter",
      `name=${namePrefix}`,
    ]);
    return listed.stdout.trim().split(/\s+/).filter(Boolean);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const containers = await dockerApi(
      "GET",
      `/containers/json?all=1&filters=${encodeURIComponent(
        JSON.stringify({ name: [namePrefix] }),
      )}`,
    );
    return containers.map((container) => container.Id);
  }
}

async function removeSmokeContainers(ids) {
  try {
    await run(
      "docker",
      ["rm", "--force", ...ids],
      ["ignore", "ignore", "inherit"],
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await Promise.all(
      ids.map((id) =>
        dockerApi("DELETE", `/containers/${encodeURIComponent(id)}?force=1`),
      ),
    );
  }
}

function dockerApi(method, requestPath) {
  if (!socketUri.startsWith("unix:///")) {
    throw new Error(
      "Docker CLI is unavailable and SELFHOST_DOCKER_SOCKET_URI is not a unix:/// socket",
    );
  }
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        method,
        path: requestPath,
        socketPath: socketUri.slice("unix://".length),
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          if (
            response.statusCode &&
            response.statusCode >= 200 &&
            response.statusCode < 300
          ) {
            resolve(body ? JSON.parse(body) : null);
            return;
          }
          reject(
            new Error(
              `Docker API ${method} ${requestPath} returned ` +
                `${response.statusCode}: ${body}`,
            ),
          );
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function capture(command, args) {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(command, args, {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    childProcess.stdout.on("data", (chunk) => stdout.push(String(chunk)));
    childProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));
    childProcess.once("error", reject);
    childProcess.once("exit", (code) => {
      if (code === 0) {
        resolve({ stdout: stdout.join(""), stderr: stderr.join("") });
      } else {
        reject(
          new Error(
            `${command} exited with ${code}: ${stderr.join("").trim()}`,
          ),
        );
      }
    });
  });
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolve) => server.close(resolve));
  if (!port) throw new Error("Could not allocate a smoke-test port");
  return port;
}

async function poll(url, workerd, logs) {
  const deadline = Date.now() + 240_000;
  let lastError;
  while (Date.now() < deadline) {
    if (workerd.exitCode !== null) {
      throw new Error(
        `workerd exited with ${workerd.exitCode}\n${logs.join("").slice(-8000)}`,
      );
    }
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(30_000),
      });
      if (response.ok) return response;
      throw new Error(
        `Container smoke returned HTTP ${response.status}: ${await response.text()}\n` +
          logs.join("").slice(-8000),
      );
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(
    `Container smoke timed out: ${lastError?.message ?? "no response"}\n` +
      logs.join("").slice(-8000),
  );
}
