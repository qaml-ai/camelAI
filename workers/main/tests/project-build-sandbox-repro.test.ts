import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getProjectBuildSandbox, runProjectAddDependency, runProjectBuild } from "../src/project-build-service";
import { ProjectFilesystemClient } from "../src/workspace-filesystem-do";

type ReproEnv = typeof env & {
  RUN_PROJECT_BUILD_SANDBOX_REPRO?: string;
};

const testEnv = env as ReproEnv;
const maybeIt = testEnv.RUN_PROJECT_BUILD_SANDBOX_REPRO === "1" ? it : it.skip;

const DEPENDENCIES = [
  "clsx@^2.1.1",
  "is-number@^7.0.0",
  "is-odd@^3.0.1",
  "left-pad@^1.3.0",
  "nanoid@^5.1.6",
  "tslib@^2.8.1",
  "tiny-invariant@^1.3.3",
  "kleur@^4.1.5",
];

describe("real project build sandbox repro", () => {
  maybeIt("builds a cold 20 MB data-heavy project through streamed archive lanes", async () => {
    expect(testEnv.PROJECT_BUILD_SANDBOX).toBeDefined();
    const suffix = Date.now().toString(36);
    const projectId = `large-repro-${suffix}`;
    const sandbox = getProjectBuildSandbox(testEnv, `large-repro-org-${suffix}`);
    const files = new ProjectFilesystemClient(testEnv as never, projectId);
    await expect(files.writeFile(
      "/package.json",
      JSON.stringify({
        type: "module",
        scripts: { build: "bun -e \"console.log('built large source')\"" },
      }),
    )).resolves.toEqual({ success: true });
    await expect(files.writeFile("/src/index.ts", "export default {};\n")).resolves.toEqual({ success: true });
    // Many small source files exercise the WorkspaceFilesystemDO streaming
    // connection ceiling in addition to the large archive lanes below.
    for (let index = 0; index < 48; index += 1) {
      await expect(files.writeFile(
        `/src/generated/file-${index}.ts`,
        `export const value${index} = ${index};\n`,
      )).resolves.toEqual({ success: true });
    }
    await expect(files.writeFile("/public/data.json", "a".repeat(11 * 1024 * 1024))).resolves.toEqual({ success: true });
    await expect(files.writeFile("/public/skus/0.json", "b".repeat(5 * 1024 * 1024))).resolves.toEqual({ success: true });
    await expect(files.writeFile("/public/skus/1.json", "c".repeat(4 * 1024 * 1024))).resolves.toEqual({ success: true });

    const build = await runProjectBuild({ projectId, files, sandbox });

    expect(build, build.stderr || build.stdout).toMatchObject({
      success: true,
      fileCount: 53,
      sourceBytes: expect.any(Number),
    });
    expect(build.sourceBytes).toBeGreaterThanOrEqual(20 * 1024 * 1024);
  }, 180_000);

  maybeIt("runs add_dependency followed immediately by build repeatedly", async () => {
    expect(testEnv.PROJECT_BUILD_SANDBOX).toBeDefined();
    const projectId = `repro-${Date.now().toString(36)}`;
    const sandbox = getProjectBuildSandbox(testEnv, "repro-org");
    const files = new ProjectFilesystemClient(testEnv as never, projectId);
    await expect(files.writeFile(
      "/package.json",
      JSON.stringify({
        type: "module",
        scripts: {
          build: "bun -e \"console.log('built')\"",
        },
      }, null, 2),
    )).resolves.toEqual({ success: true });
    await expect(files.writeFile("/src/index.ts", "export default {};\n")).resolves.toEqual({ success: true });

    for (let index = 0; index < DEPENDENCIES.length; index += 1) {
      const dependency = DEPENDENCIES[index];
      const add = await runProjectAddDependency({ projectId, files, sandbox, dependency });
      expect(add, `add_dependency attempt ${index}`).toMatchObject({ success: true, packageJsonPersisted: true });
      const build = await runProjectBuild({ projectId, files, sandbox });
      expect(build, `project build attempt ${index}: ${build.stderr || build.stdout}`).toMatchObject({ success: true });
    }
  }, 180_000);
});
