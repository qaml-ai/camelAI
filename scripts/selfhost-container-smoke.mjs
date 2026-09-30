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
const runtimes = {
  // Local R2 sync (mountBucket localBucket) is a 0.12 sandbox-server feature,
  // so it runs on the analysis image, whose 0.12 class still uses it.
  mount: {
    className: "AnalysisSandbox",
    image:
      process.env.SELFHOST_ANALYSIS_IMAGE ||
      selfhostEnv.SELFHOST_ANALYSIS_IMAGE ||
      "camelai-selfhost-analysis:0.12.0",
    marker: "camelai-local-r2-sync-ok",
    mountTest: true,
  },
  // The real ProjectBuildSandboxV1 (native ctx.container) against the
  // project-build image, through the calls a build makes.
  project: {
    className: "ProjectBuildSandboxV1",
    native: true,
    imageName: "project-build",
    image:
      process.env.SELFHOST_PROJECT_BUILD_IMAGE ||
      selfhostEnv.SELFHOST_PROJECT_BUILD_IMAGE ||
      "camelai-selfhost-project-build:1.0.0",
    marker: "camelai-project-build-ok",
  },
  analysis: {
    className: "AnalysisSandbox",
    image:
      process.env.SELFHOST_ANALYSIS_IMAGE ||
      selfhostEnv.SELFHOST_ANALYSIS_IMAGE ||
      "camelai-selfhost-analysis:0.12.0",
    command:
      `printf '%s' '${notebook}' | base64 -d > /tmp/smoke.ipynb ` +
      "&& python /usr/local/bin/execute-notebook /tmp/smoke.ipynb " +
      `&& python -c "import json; d=json.load(open('/tmp/smoke.ipynb')); ` +
      `assert ''.join(d['cells'][0]['outputs'][0]['text']) == '42\\\\n'; ` +
      `print('camelai-analysis-notebook-ok')"`,
    marker: "camelai-analysis-notebook-ok",
    archiveTest: true,
  },
  "db-query": {
    className: "DbQuerySandbox",
    image:
      process.env.SELFHOST_DB_QUERY_IMAGE ||
      selfhostEnv.SELFHOST_DB_QUERY_IMAGE ||
      "camelai-selfhost-db-query:0.12.0",
    command:
      "cd /opt/db-query-runner && node -e " +
      `"for (const m of ['pg','pg-cursor','mysql2','tedious','@dsnp/parquetjs','socks']) ` +
      `require.resolve(m); console.log('camelai-db-query-drivers-ok')"`,
    marker: "camelai-db-query-drivers-ok",
  },
};
const runtimeName = process.argv[2] || "project";
const runtime = runtimes[runtimeName];
if (!runtime) {
  throw new Error(
    `Unknown runtime ${runtimeName}; expected ${Object.keys(runtimes).join(", ")}`,
  );
}
if (runtimeName === "analysis") {
  const dockerInfo = await capture("docker", [
    "info",
    "--format",
    "{{.Architecture}}",
  ]);
  const architecture = dockerInfo.stdout.trim();
  if (architecture !== "x86_64" && architecture !== "amd64") {
    console.log(
      `SKIP self-host analysis container smoke on ${architecture}: ` +
        "Cloudflare's analysis sandbox base is amd64-only and Jupyter is " +
        "unreliable under emulation; x86_64 CI is authoritative.",
    );
    process.exit(0);
  }
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
  const needsR2 = runtime.mountTest || runtime.archiveTest;
  const fetchBody = runtime.mountTest
    ? `
      await env.SMOKE_BUCKET.put("smoke/input.txt", "from-r2");
      await sandbox.mountBucket("SMOKE_BUCKET", "/workspace/smoke", {
        localBucket: true,
        prefix: "/smoke",
        readOnly: false,
      });
      const alias = await sandbox.exec(
        "rm -rf /smoke && ln -s /workspace/smoke /smoke",
      );
      if (!alias.success) throw new Error("Could not create sandbox mount alias");
      const seeded = await sandbox.exec("cat /smoke/input.txt");
      if (!seeded.success || seeded.stdout.trim() !== "from-r2") {
        throw new Error("R2 to container synchronization failed");
      }
      let persisted = null;
      for (let attempt = 0; attempt < 8 && !persisted; attempt += 1) {
        await sandbox.exec(
          "printf 'from-container-" + attempt + "' > /smoke/output.txt",
        );
        await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
        persisted = await env.SMOKE_BUCKET.get("smoke/output.txt");
      }
      if (!persisted || !(await persisted.text()).startsWith("from-container-")) {
        throw new Error("Container to R2 synchronization failed");
      }
      return Response.json({ success: true, stdout: ${JSON.stringify(runtime.marker)} });
    `
    : runtime.archiveTest
    ? `
      const archiveBytes = Uint8Array.from(
        atob(${JSON.stringify(archive)}),
        (character) => character.charCodeAt(0),
      );
      await env.SMOKE_BUCKET.put("uploads/source.zip", archiveBytes);
      await sandbox.mountBucket("SMOKE_BUCKET", "/uploads", {
        localBucket: true,
        prefix: "/uploads",
        readOnly: true,
      });
      const archiveResult = await sandbox.exec(
        "rm -rf /tmp/camelai-archive-smoke " +
        "&& mkdir -p /tmp/camelai-archive-smoke " +
        "&& cd /tmp/camelai-archive-smoke " +
        "&& CAMELAI_ARCHIVE_ACTION=list CAMELAI_ARCHIVE_PATH=/uploads/source.zip " +
        "python /usr/local/bin/camelai-archive > /tmp/camelai-archive-list.json " +
        "&& grep -q 'extractable.*true' /tmp/camelai-archive-list.json " +
        "&& CAMELAI_ARCHIVE_ACTION=extract CAMELAI_ARCHIVE_PATH=/uploads/source.zip " +
        "CAMELAI_ARCHIVE_DESTINATION=imported python /usr/local/bin/camelai-archive " +
        "> /tmp/camelai-archive-extract.json " +
        "&& grep -qx camelai-analysis-archive-ok imported/probe.txt " +
        "&& echo camelai-analysis-archive-ok",
      );
      if (!archiveResult.success) {
        throw new Error(
          "Analysis archive smoke failed: " +
          (archiveResult.stderr || archiveResult.stdout),
        );
      }
      const result = await sandbox.exec(${JSON.stringify(runtime.command)});
      return Response.json({
        ...result,
        stdout: (archiveResult.stdout || "") + "\\n" + (result.stdout || ""),
      });
    `
    : `
      const result = await sandbox.exec(${JSON.stringify(runtime.command)});
      return Response.json(result);
    `;
  const nativeSource = `
import { ProjectBuildSandboxV1 } from ${JSON.stringify(path.join(repoRoot, "workers/main/src/project-build-sandbox-v1.ts"))};

export { ProjectBuildSandboxV1 };

export default {
  async fetch(_request, env) {
    const sandbox = env.SANDBOX.getByName("org-selfhost-smoke");
    try {
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
      const missing = await sandbox.exists(workdir + "/missing");
      const timedOut = await sandbox.exec("sleep 30", { timeout: 1000 });
      const checks = [
        listed.files.some((file) => file.relativePath === "index.js"),
        bundle.byteLength > 0,
        streamed.content === "streamed",
        missing.exists === false,
        timedOut.exitCode === 124,
      ];
      if (checks.includes(false)) {
        return Response.json({ success: false, stdout: build.stdout, checks });
      }
      return Response.json({ success: true, stdout: build.stdout });
    } finally {
      await sandbox.restartZombieContainer({ operation: "smoke", trigger: "cleanup" });
    }
  },
};
`;
  await fs.writeFile(
    sourcePath,
    runtime.native ? nativeSource : `
import { ContainerProxy, getSandbox, Sandbox } from "@cloudflare/sandbox";

export { ContainerProxy };
export class ${runtime.className} extends Sandbox {}

export default {
  async fetch(_request, env) {
    const sandbox = getSandbox(
      env.SANDBOX,
      "selfhost-local-docker-smoke-${runtimeName}",
    );
    try {
      ${fetchBody}
    } finally {
      await sandbox.destroy();
    }
  },
};
`,
  );

  await run("bun", [
    "build",
    sourcePath,
    "--target=browser",
    "--format=esm",
    "--external=cloudflare:workers",
    "--external=node:*",
    `--outfile=${bundlePath}`,
  ]);

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
        ))${needsR2 ? ',\n        (name = "SMOKE_BUCKET", r2Bucket = (name = "r2:bucket:smoke"))' : ""}
      ],
      globalOutbound = "internet",
      durableObjectNamespaces = [(
        className = ${JSON.stringify(runtime.className)},
        uniqueKey = ${JSON.stringify(`camelai-selfhost-container-smoke-${runtimeName}`)},
        enableSql = true,
        container = ${runtime.native
          ? `(images = [(name = ${JSON.stringify(runtime.imageName)}, image = ${JSON.stringify(runtime.image)})])`
          : `(imageName = ${JSON.stringify(runtime.image)})`}
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
    `Self-host ${runtimeName} localDocker smoke passed with ${runtime.image}.`,
  );
} finally {
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await new Promise((resolve) => child.once("exit", resolve));
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
