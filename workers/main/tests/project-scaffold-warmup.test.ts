import { describe, expect, it } from "vitest";

import { defaultProjectScaffoldFiles, type ProjectScaffoldTemplate } from "../src/project-scaffold";
import { SHADCN_NPM_PACKAGE_VERSIONS } from "../src/shadcn-registry.generated";
import warmupManifest from "../project-build-sandbox-warmup/package.json";

// The project build sandbox image (workers/main/project-build-container.Dockerfile)
// prebakes a warm bun cache by installing the buildable scaffold templates'
// dependencies at image build time. This test guards against drift: every
// dependency (name AND version range) used by a scaffold template must appear in
// workers/main/project-build-sandbox-warmup/package.json, otherwise cold builds
// silently lose the cache benefit for the missing packages.

function scaffoldDependencyMap(template: ProjectScaffoldTemplate): Record<string, string> {
  const files = defaultProjectScaffoldFiles("Warmup Drift Check", template, "warmup-drift-check");
  const packageJson = files.find((file) => file.path === "/package.json");
  if (!packageJson) throw new Error(`Scaffold template "${template}" produced no /package.json`);
  const parsed = JSON.parse(packageJson.content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  return { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
}

const warmupDependencies: Record<string, string> = {
  ...(warmupManifest.dependencies ?? {}),
  ...(warmupManifest.devDependencies ?? {}),
};

describe("project build sandbox warmup manifest", () => {
  // Only templates that seed a /package.json matter here; data-analysis projects
  // are notebook-only and never hit the build sandbox.
  const templates: ProjectScaffoldTemplate[] = ["crud", "vanilla", "ai-chat", "integration-dashboard", "data-dashboard"];

  for (const template of templates) {
    it(`covers every dependency of the "${template}" scaffold template`, () => {
      const scaffoldDeps = scaffoldDependencyMap(template);
      expect(Object.keys(scaffoldDeps).length).toBeGreaterThan(0);
      for (const [name, range] of Object.entries(scaffoldDeps)) {
        expect(
          warmupDependencies[name],
          `Scaffold template "${template}" depends on "${name}": "${range}", which is missing from `
          + `workers/main/project-build-sandbox-warmup/package.json. Update the warmup manifest so the `
          + `prebaked bun cache in project-build-container.Dockerfile stays warm for scaffold installs.`,
        ).toBeDefined();
        expect(
          warmupDependencies[name],
          `Scaffold template "${template}" pins "${name}": "${range}" but the warmup manifest has `
          + `"${name}": "${warmupDependencies[name]}". Update `
          + `workers/main/project-build-sandbox-warmup/package.json to the scaffold's range so the `
          + `prebaked bun cache matches what cold builds actually install.`,
        ).toBe(range);
      }
    });
  }

  // add_shadcn_component can add any package from the bundled shadcn registry
  // to a project's package.json; keep those cached in the image too so
  // component/block installs stay as fast as plain scaffold builds.
  it("covers every npm package the bundled shadcn registry can add", () => {
    expect(Object.keys(SHADCN_NPM_PACKAGE_VERSIONS).length).toBeGreaterThan(0);
    for (const [name, range] of Object.entries(SHADCN_NPM_PACKAGE_VERSIONS)) {
      expect(
        warmupDependencies[name],
        `shadcn registry can add "${name}": "${range}", which is missing from `
        + `workers/main/project-build-sandbox-warmup/package.json. Update the warmup manifest so the `
        + `prebaked bun cache in project-build-container.Dockerfile stays warm for component installs.`,
      ).toBe(range);
    }
  });
});
