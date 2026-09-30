# db-query sandbox on the native Durable Object container API
# (DbQueryContainer, Sandbox SDK 1.0).
#
# Node, the DB drivers in /opt/db-query-runner and cloudflared (the same
# contents as the 0.12 image it replaced). It runs NO user code and
# does not bake the query logic: db-query-service.ts pipes the runner into node
# over stdin on every call, so changing how we query needs only a worker
# deploy. Nothing secret is baked in either; relay credentials arrive per exec.
#
# 1.0 has no sandbox server: the Durable Object runs every command with
# ctx.container.exec(), so the main process only has to stay alive. exec()
# does not see ENV lines here (only PATH) and starts in / whatever WORKDIR
# says; db-query-container.ts passes env and cwd itself.
#
# Cloudflare runs containers as linux/amd64; sandbox-shim (used by Files and
# S3Mount) is amd64-only.
FROM docker.io/cloudflare/sandbox:1.0.0 AS sandbox-tools

FROM docker.io/node:22-trixie-slim

# --- cloudflared (Access TCP client for the egress relay) --------------------
# Same pinned release and checksums as the 0.12 image. Cloudflare's apt
# repository keeps only its current package, so the immutable release asset is
# downloaded and verified instead.
#
# ca-certificates: TLS to databases and the relay. fuse3 + s3fs: the warehouse
# export mount (S3Mount). bash, timeout (coreutils) and setsid come with the
# base image.
ARG CLOUDFLARED_VERSION=2026.7.2
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl fuse3 s3fs; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in \
      amd64) sha256="88195157a136199a86977c122a22084dae6907480bbe3640222b7b55834afc3a" ;; \
      arm64) sha256="ddd7d2a0d55a1879485ac34354e936424f1df92e306bfa6428a81908aaddbe87" ;; \
      *) echo "Unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL \
      "https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${arch}.deb" \
      -o /tmp/cloudflared.deb; \
    echo "$sha256  /tmp/cloudflared.deb" | sha256sum --check --strict; \
    apt-get install -y --no-install-recommends /tmp/cloudflared.deb; \
    rm -f /tmp/cloudflared.deb; \
    rm -rf /var/lib/apt/lists/*; \
    cloudflared --version

# Files and S3Mount run this helper. Keep its tag equal to the installed
# @cloudflare/sandbox version.
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# --- baked query drivers ------------------------------------------------------
# Only package.json is copied (not the runner source): the shipped runner
# resolves `import "pg"` etc. against the node_modules installed here.
# Wrangler's build context is this Dockerfile's directory (workers/main).
# Build-fatal on resolution failure: never ship a driverless image.
COPY db-query-sandbox-assets/runner/package.json /opt/db-query-runner/package.json
RUN cd /opt/db-query-runner && npm install --omit=dev --no-audit --no-fund \
    && node -e "for (const m of ['pg', 'pg-cursor', 'mysql2', 'tedious', '@dsnp/parquetjs', 'socks']) require.resolve(m); console.log('drivers resolve OK')"

CMD ["sleep", "infinity"]
