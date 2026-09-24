# camelAI agentOS platform — VPS app image (Bun + Rivetkit embedded engine).
# agentOS native sidecar binaries ship as optional deps in node_modules
# (@rivet-dev/agentos-sidecar-linux-x64-gnu, agentos-runtime-sidecar-linux-x64-gnu).

FROM oven/bun:1.2 AS app

WORKDIR /app

COPY package.json bun.lock ./
COPY src ./src
COPY web ./web

RUN bun install --frozen-lockfile

ARG RIVET_ENVOY_VERSION=1
ENV RIVET_ENVOY_VERSION=${RIVET_ENVOY_VERSION}

EXPOSE 6420

CMD ["bun", "run", "src/server/index.ts"]

# ---------------------------------------------------------------------------
# Web static assets (optional second stage for docker compose `web` service)
# ---------------------------------------------------------------------------

FROM app AS web-build
RUN bun run build

FROM nginx:1.27-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=web-build /app/web/dist /usr/share/nginx/html
EXPOSE 80
