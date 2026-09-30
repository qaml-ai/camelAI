# Project build sandbox warmup manifest

`package.json` in this directory is the union of the dependency sets used by
the buildable project scaffold templates in `workers/main/src/project-scaffold.ts`
and the bundled shadcn registry, with the exact same version ranges.

It exists solely so `workers/main/project-build-container.Dockerfile` can run a
frozen `bun install` against it at image build time, prebaking a warm Bun global
cache (`~/.bun/install/cache`) into the ProjectBuildContainer image. Cold
project builds then resolve the scaffold dependency tree from the local cache
instead of downloading everything from npm on every fresh container.

The root `bun.lock` makes the broad prebaked dependency graph reproducible.
`crud/package.json` and `crud/bun.lock` mirror the exact default CRUD scaffold
graph. The Dockerfile installs both frozen graphs so a transitive resolution
difference in the union manifest cannot leave a scaffold package uncached. If
you change a manifest, regenerate all warmup and scaffold locks together
with `bun run generate:project-dependency-locks` and commit both generated
lock sets. The Docker build uses `--frozen-lockfile`, so an unavailable locked
artifact fails the image build instead of becoming a runtime surprise.

This package is never installed at runtime — the temp install dir and its
`node_modules` are deleted in the same Dockerfile layer; only the cache is
kept.

When you change a dependency or version range in a scaffold or the generated
shadcn registry, update this file and its lock to match. The drift-guard test
`workers/main/tests/project-scaffold-warmup.test.ts` fails if the two get out
of sync.

The default CRUD scaffold has its own generated lock at
`workers/main/src/project-scaffold-lock.generated.ts`. Refresh it with
`bun run generate:project-dependency-locks` whenever that scaffold's dependency
manifest changes.
