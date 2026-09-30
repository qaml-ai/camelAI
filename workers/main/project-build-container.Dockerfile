# Project build container (ProjectBuildContainer) on the native Durable Object
# container API (Sandbox SDK 1.0).
#
# There is no sandbox server: the Durable Object runs every command with
# ctx.container.exec(), so this is a plain image (bun 1.3.12, node 22, git,
# curl) whose main process just stays alive.
#
# exec() does not see ENV lines here (only PATH), and it starts in / whatever
# WORKDIR says: project-build-container.ts passes HOME, LANG and cwd itself.
#
# Cloudflare runs containers as linux/amd64; sandbox-shim (used by Files) is
# amd64-only.
FROM docker.io/oven/bun:1.3.12 AS bun
FROM docker.io/cloudflare/sandbox:1.0.0 AS sandbox-tools

FROM docker.io/node:22-trixie-slim

# git: dependencies from git URLs. ca-certificates: registry TLS. tar, gzip,
# find, timeout and bash come with the base image.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git \
    && rm -rf /var/lib/apt/lists/*

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
RUN ln -s /usr/local/bin/bun /usr/local/bin/bunx

# Files (writeFile/readFile/stat/mkdir) runs this helper. Keep its tag equal to
# the installed @cloudflare/sandbox version.
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# Prebake a warm bun cache for the scaffold templates: install into a throwaway
# dir, keep /root/.bun/install/cache. Commands run as root with HOME=/root, which the
# Durable Object passes explicitly. Wrangler's build context is this
# Dockerfile's directory (workers/main).
COPY project-build-sandbox-warmup/ /tmp/camelai-warmup/
RUN cd /tmp/camelai-warmup \
    && HOME=/root bun install --frozen-lockfile --no-progress \
    && cd /tmp/camelai-warmup/crud \
    && HOME=/root bun install --frozen-lockfile --no-progress \
    && rm -rf /tmp/camelai-warmup

RUN mkdir -p /workspace

CMD ["sleep", "infinity"]
