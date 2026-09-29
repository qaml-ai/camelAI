# Project build sandbox (ProjectBuildSandbox).
#
# Cold project builds run `bun install && bun run build` (see
# src/project-build-service.ts). To avoid downloading the full scaffold
# dependency tree from npm on every fresh container, prebake a warm bun
# global cache: install the buildable scaffold templates' dependencies
# (workers/main/project-build-sandbox-warmup/package.json, kept in sync with
# src/project-scaffold.ts by tests/project-scaffold-warmup.test.ts) into a
# throwaway dir at image build time, then delete the dir but keep the cache.
#
# The sandbox control plane executes commands as root with HOME=/root, so the
# cache must land in /root/.bun/install/cache (verified against the base
# image's /api/execute). Wrangler's container build context defaults to this
# Dockerfile's directory (workers/main), hence the relative COPY path.
FROM docker.io/cloudflare/sandbox:0.12.10

COPY project-build-sandbox-warmup/ /tmp/camelai-warmup/
RUN cd /tmp/camelai-warmup \
    && bun install --frozen-lockfile --no-progress \
    && cd /tmp/camelai-warmup/crud \
    && bun install --frozen-lockfile --no-progress \
    && rm -rf /tmp/camelai-warmup
