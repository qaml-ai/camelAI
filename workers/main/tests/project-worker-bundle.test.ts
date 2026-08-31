import { describe, expect, it, vi } from "vitest";

import { collectWorkerBundleFromSandbox, findUnexportedDurableObjectClasses, type ProjectBuildSandboxLike } from "../src/project-worker-bundle";
import type { ProjectWorkerBundle } from "../src/project-worker-bundle";

function fakeBundleSandbox(files: Map<string, string>): ProjectBuildSandboxLike {
  return {
    exec: vi.fn(async () => ({ success: true, exitCode: 0 })),
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async () => undefined),
    readFile: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content == null) throw new Error(`missing ${path}`);
      return { content: Buffer.from(content).toString("base64") };
    }),
    readFileStream: vi.fn(async (path: string) => {
      const content = files.get(path);
      if (content == null) throw new Error(`missing ${path}`);
      const bytes = new TextEncoder().encode(content);
      const midpoint = Math.ceil(bytes.byteLength / 2);
      const events = [
        { type: "metadata", mimeType: "application/octet-stream", size: bytes.byteLength, isBinary: true, encoding: "base64" },
        { type: "chunk", data: Buffer.from(bytes.slice(0, midpoint)).toString("base64") },
        { type: "chunk", data: Buffer.from(bytes.slice(midpoint)).toString("base64") },
        { type: "complete" },
      ].map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
      const encoded = new TextEncoder().encode(events);
      const wireMidpoint = Math.ceil(encoded.byteLength / 2);
      return new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoded.slice(0, wireMidpoint));
          controller.enqueue(encoded.slice(wireMidpoint));
          controller.close();
        },
      });
    }),
    listFiles: vi.fn(async (root: string) => ({
      files: Array.from(files.keys()).filter((absolutePath) => absolutePath.startsWith(`${root}/`)).map((absolutePath) => ({
        name: absolutePath.split("/").pop() || "",
        type: "file" as const,
        absolutePath,
        relativePath: absolutePath.slice(root.length + 1),
        size: Buffer.byteLength(files.get(absolutePath) ?? ""),
      })),
    })),
  };
}

function readFilePaths(sandbox: ProjectBuildSandboxLike): string[] {
  return (sandbox.readFile as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0] as string);
}

function readFileStreamPaths(sandbox: ProjectBuildSandboxLike): string[] {
  return (sandbox.readFileStream as unknown as { mock: { calls: unknown[][] } }).mock.calls.map((call) => call[0] as string);
}

describe("collectWorkerBundleFromSandbox", () => {
  it("reads the build manifest and module files from build/server", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main: "index.js",
        no_bundle: true,
        compatibility_date: "2026-06-01",
        bindings: [{ type: "plain_text", name: "GREETING", text: "hi" }],
        assets: { directory: "../client" },
      })],
      ["/workspace/demo/build/server/index.js", "export default {};"],
      ["/workspace/demo/build/server/chunk.js", "export const chunk = 1;"],
      ["/workspace/demo/build/server/index.js.map", "ignored"],
      ["/workspace/demo/build/client/index.html", "<html></html>"],
      ["/workspace/demo/build/client/assets/app.css", "body{}"],
    ]);

    const sandbox = fakeBundleSandbox(files);
    const bundle = await collectWorkerBundleFromSandbox(sandbox, "/workspace/demo");

    expect(bundle.metadata).toMatchObject({ main_module: "index.js" });
    expect(bundle.modules.map((module) => module.name)).toEqual(["chunk.js", "index.js"]);
    expect(bundle.modules.map((module) => module.contentType)).toEqual([
      "application/javascript+module",
      "application/javascript+module",
    ]);
    expect(bundle.assets.map((asset) => ({ path: asset.path, contentType: asset.contentType, size: asset.size }))).toEqual([
      { path: "assets/app.css", contentType: "text/css; charset=utf-8", size: 6 },
      { path: "index.html", contentType: "text/html; charset=utf-8", size: 13 },
    ]);

    // Collection must NOT read asset bytes up front — only the manifest and the
    // uploadable modules are read. Client assets stay lazy until deploy asks.
    const streamReadsAfterCollect = readFileStreamPaths(sandbox);
    expect(streamReadsAfterCollect).toContain("/workspace/demo/build/server/index.js");
    expect(streamReadsAfterCollect).not.toContain("/workspace/demo/build/client/index.html");
    expect(streamReadsAfterCollect).not.toContain("/workspace/demo/build/client/assets/app.css");
    expect(readFilePaths(sandbox)).toEqual([]);

    // The lazy handle reads the real bytes on demand.
    const cssAsset = bundle.assets.find((asset) => asset.path === "assets/app.css")!;
    expect(new TextDecoder().decode(await cssAsset.read())).toBe("body{}");
    expect(readFileStreamPaths(sandbox)).toContain("/workspace/demo/build/client/assets/app.css");
    expect(readFilePaths(sandbox)).not.toContain("/workspace/demo/build/client/assets/app.css");
  });

  it("converts wrangler durable object config into upload bindings", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main: "index.js",
        no_bundle: true,
        durable_objects: {
          bindings: [{ name: "TASK_STORE", class_name: "TaskStore" }],
        },
        migrations: [{ tag: "v1", new_sqlite_classes: ["TaskStore"] }],
      })],
      ["/workspace/demo/build/server/index.js", "export class TaskStore {}; export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata).toMatchObject({
      main_module: "index.js",
      migrations: [{ tag: "v1", new_sqlite_classes: ["TaskStore"] }],
      bindings: [{ type: "durable_object_namespace", name: "TASK_STORE", class_name: "TaskStore" }],
    });
    expect(bundle.metadata.durable_objects).toBeUndefined();
  });

  it("lifts wrangler kv_namespaces and r2_buckets into upload bindings", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main: "index.js",
        no_bundle: true,
        kv_namespaces: [
          { binding: "SESSIONS", id: "kv-abc123" },
          { binding: "CACHE" },
        ],
        r2_buckets: [{ binding: "UPLOADS", bucket_name: "my-uploads" }],
      })],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata.bindings).toEqual([
      { type: "kv_namespace", name: "SESSIONS", namespace_id: "kv-abc123" },
      { type: "kv_namespace", name: "CACHE" },
      { type: "r2_bucket", name: "UPLOADS", bucket_name: "my-uploads" },
    ]);
    // The idiomatic top-level arrays are consumed, not passed through raw
    // (the deploy metadata only reads `bindings`).
    expect(bundle.metadata.kv_namespaces).toBeUndefined();
    expect(bundle.metadata.r2_buckets).toBeUndefined();
  });

  it("lifts a wrangler AI binding into upload bindings", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main: "index.js",
        no_bundle: true,
        ai: { binding: "AI" },
      })],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata.bindings).toEqual([{ type: "ai", name: "AI" }]);
    expect(bundle.metadata.ai).toBeUndefined();
  });

  it("lifts wrangler service bindings into upload bindings", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main: "index.js",
        no_bundle: true,
        services: [{
          binding: "CAMELAI",
          service: "demo",
          entrypoint: "LocalCamelAiService",
          props: { local: true },
        }],
      })],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata.bindings).toEqual([{
      type: "service",
      name: "CAMELAI",
      service: "demo",
      entrypoint: "LocalCamelAiService",
      props: { local: true },
    }]);
    expect(bundle.metadata.services).toBeUndefined();
  });

  it("does not duplicate a binding already present in manifest.bindings", async () => {
    const files = new Map<string, string>([
      ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
        main: "index.js",
        no_bundle: true,
        bindings: [{ type: "kv_namespace", name: "SESSIONS", namespace_id: "explicit" }],
        kv_namespaces: [{ binding: "SESSIONS", id: "duplicate" }],
      })],
      ["/workspace/demo/build/server/index.js", "export default {};"],
    ]);

    const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");

    expect(bundle.metadata.bindings).toEqual([
      { type: "kv_namespace", name: "SESSIONS", namespace_id: "explicit" },
    ]);
  });
});

describe("findUnexportedDurableObjectClasses", () => {
  const bundleWith = (mainSource: string, classNames: string[]): ProjectWorkerBundle => ({
    metadata: {
      main_module: "worker.js",
      bindings: classNames.map((class_name) => ({
        type: "durable_object_namespace",
        name: class_name.toUpperCase(),
        class_name,
      })),
    },
    modules: [{ name: "worker.js", contentType: "application/javascript+module", content: mainSource }],
    assets: [],
    manifestPath: "build/server/wrangler.json",
  });

  it("returns nothing when there are no DO bindings", () => {
    expect(findUnexportedDurableObjectClasses(bundleWith("export default {};", []))).toEqual([]);
  });

  it("accepts a directly-exported class", () => {
    const src = "export class LeaderboardDO { fetch() {} }\nexport default {};";
    expect(findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"]))).toEqual([]);
  });

  it("accepts an aliased re-export in a consolidated export clause (esbuild shape)", () => {
    const src = [
      "class LeaderboardDO2 { fetch() {} }",
      "var worker_default = { fetch() {} };",
      "export {",
      "  LeaderboardDO2 as LeaderboardDO,",
      "  worker_default as default",
      "};",
    ].join("\n");
    expect(findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"]))).toEqual([]);
  });

  it("flags a declared class that is never exported", () => {
    const src = "class LeaderboardDO {}\nexport default {};";
    expect(findUnexportedDurableObjectClasses(bundleWith(src, ["LeaderboardDO"]))).toEqual(["LeaderboardDO"]);
  });

  it("flags a misspelled/missing class among several", () => {
    const src = "export class ScoreDO {}\nexport { X as ChatDO };\nexport default {};";
    expect(
      findUnexportedDurableObjectClasses(bundleWith(src, ["ScoreDO", "ChatDO", "PresenceDO"])),
    ).toEqual(["PresenceDO"]);
  });

  it("does not block when the entry module is absent", () => {
    const bundle = bundleWith("", ["LeaderboardDO"]);
    bundle.modules = [];
    expect(findUnexportedDurableObjectClasses(bundle)).toEqual([]);
  });

  it("skips the check when the entry has a star re-export it can't resolve", () => {
    expect(
      findUnexportedDurableObjectClasses(bundleWith('export * from "./do.js";\nexport default {};', ["LeaderboardDO"])),
    ).toEqual([]);
    expect(
      findUnexportedDurableObjectClasses(bundleWith('export * as ns from "./do.js";\nexport default {};', ["LeaderboardDO"])),
    ).toEqual([]);
  });
});

it("accepts a vite-plugin manifest that uses `main` instead of `main_module`", async () => {
  const files = new Map<string, string>([
    ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
      name: "demo",
      main: "index.js",
      no_bundle: true,
      rules: [{ type: "ESModule", globs: ["**/*.js", "**/*.mjs"] }],
      compatibility_date: "2026-06-01",
      assets: { directory: "../client", binding: "ASSETS" },
    })],
    ["/workspace/demo/build/server/index.js", "export default {};"],
    ["/workspace/demo/build/client/index.html", "<html></html>"],
  ]);
  const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");
  expect(bundle.metadata).toMatchObject({ main_module: "index.js" });
  expect(bundle.metadata).not.toHaveProperty("main");
  expect(bundle.metadata).not.toHaveProperty("no_bundle");
  expect(bundle.metadata).not.toHaveProperty("rules");
  expect(bundle.modules.map((module) => module.name)).toContain("index.js");
});

it("allowlists deploy metadata: lifts vars to bindings, drops unknown config keys", async () => {
  const files = new Map<string, string>([
    ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
      name: "demo",
      main: "index.js",
      compatibility_date: "2026-06-01",
      vars: { GREETING: "hi", COUNT: 3 },
      tail_consumers: [{ service: "user-logs" }],
      // config-only keys the upload API does not accept:
      dev: { port: 8787 },
      site: { bucket: "./public" },
      workers_dev: true,
      migrations: [],
      assets: { directory: "../client" },
    })],
    ["/workspace/demo/build/server/index.js", "export default {};"],
    ["/workspace/demo/build/client/index.html", "<html></html>"],
  ]);
  const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");
  expect(bundle.metadata.main_module).toBe("index.js");
  expect(bundle.metadata.bindings).toEqual(expect.arrayContaining([
    { type: "plain_text", name: "GREETING", text: "hi" },
    { type: "json", name: "COUNT", json: 3 },
  ]));
  expect(bundle.metadata.tail_consumers).toEqual([{ service: "user-logs" }]);
  for (const key of ["vars", "dev", "site", "workers_dev", "name", "main", "no_bundle"]) {
    expect(bundle.metadata).not.toHaveProperty(key);
  }
  // migrations passes through here; the deploy path normalizes/omits it later
  expect(bundle.metadata).toHaveProperty("migrations");
});

it("skips non-module server build files (fonts, images) instead of uploading them as modules", async () => {
  const files = new Map<string, string>([
    ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
      main: "index.js",
      compatibility_date: "2026-06-01",
      assets: { directory: "../client" },
    })],
    ["/workspace/demo/build/server/index.js", "export default {};"],
    ["/workspace/demo/build/server/assets/figtree-latin-400.woff2", "fontbytes"],
    ["/workspace/demo/build/server/assets/hero.png", "pngbytes"],
    ["/workspace/demo/build/client/index.html", "<html></html>"],
  ]);
  const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");
  expect(bundle.modules.map((module) => module.name)).toEqual(["index.js"]);
});

it("rejects legacy main_module manifests with a remediation error", async () => {
  const files = new Map<string, string>([
    ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
      main_module: "worker.js",
      compatibility_date: "2026-06-01",
      assets: { directory: "../client" },
    })],
    ["/workspace/demo/build/server/worker.js", "export default {};"],
  ]);
  await expect(collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo"))
    .rejects.toThrow(/legacy main_module.*build-manifest\.mjs/s);
});

it("honors declared module rules including Text and Data types", async () => {
  const imageBytes = "x".repeat(2 * 1024 * 1024);
  const files = new Map<string, string>([
    ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
      main: "index.js",
      no_bundle: true,
      rules: [
        { type: "ESModule", globs: ["**/*.js"] },
        { type: "Text", globs: ["**/*.txt"] },
        { type: "Data", globs: ["**/*.png"] },
      ],
      compatibility_date: "2026-06-01",
      assets: { directory: "../client" },
    })],
    ["/workspace/demo/build/server/index.js", "export default {};"],
    ["/workspace/demo/build/server/prompts/system.txt", "be helpful"],
    ["/workspace/demo/build/server/assets/hero.png", imageBytes],
    ["/workspace/demo/build/server/assets/font.woff2", "fontbytes"],
    ["/workspace/demo/build/client/index.html", "<html></html>"],
  ]);
  const sandbox = fakeBundleSandbox(files);
  const bundle = await collectWorkerBundleFromSandbox(sandbox, "/workspace/demo");
  expect(bundle.modules.map((m) => ({ name: m.name, contentType: m.contentType }))).toEqual([
    { name: "assets/hero.png", contentType: "application/octet-stream" },
    { name: "index.js", contentType: "application/javascript+module" },
    { name: "prompts/system.txt", contentType: "text/plain" },
  ]);
  expect((bundle.modules.find((module) => module.name === "assets/hero.png")!.content as Uint8Array).byteLength)
    .toBe(2 * 1024 * 1024);
  expect(readFileStreamPaths(sandbox)).toContain("/workspace/demo/build/server/assets/hero.png");
  expect(readFilePaths(sandbox)).not.toContain("/workspace/demo/build/server/assets/hero.png");
});

it("surfaces the wrangler config name for deploy script-name continuity", async () => {
  const files = new Map<string, string>([
    ["/workspace/demo/build/server/wrangler.json", JSON.stringify({
      name: "frogger-game",
      main: "index.js",
      no_bundle: true,
      compatibility_date: "2026-06-01",
    })],
    ["/workspace/demo/build/server/index.js", "export default {};"],
  ]);
  const bundle = await collectWorkerBundleFromSandbox(fakeBundleSandbox(files), "/workspace/demo");
  expect(bundle.configName).toBe("frogger-game");
  // name still never leaks into the upload metadata
  expect(bundle.metadata).not.toHaveProperty("name");
});
