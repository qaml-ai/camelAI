# Hosted agent runtime: the HTTP/SSE service, agent processes and the QuickJS sandbox.
# Build from services/agent-runtime: docker build -t agent-runtime .
# The same image runs a code executor host (no credentials, no agent state) with:
#   docker run --runtime=runsc -e AGENT_EXECUTOR_TOKEN=... agent-runtime \
#     node --experimental-strip-types --disable-warning=ExperimentalWarning src/executor/server.ts
# See infra/agent-runtime/executor/README.md.
FROM node:22-bookworm-slim

WORKDIR /app
# Install only what the service imports; the SDK clients and Studio are not part of the image.
COPY package.json ./package.source.json
RUN node -e '\
  const source = require("./package.source.json"); \
  const keep = ["@earendil-works/pi-agent-core", "@earendil-works/pi-ai", "quickjs-emscripten", "typebox", "sucrase"]; \
  const dependencies = Object.fromEntries(keep.map(name => { \
    if (!source.dependencies[name]) throw new Error(`missing dependency ${name}`); \
    return [name, source.dependencies[name]]; \
  })); \
  require("fs").writeFileSync("package.json", JSON.stringify({ name: "agent-runtime", private: true, type: "module", dependencies }, null, 2));' \
  && npm install --omit=dev --no-audit --no-fund \
  && rm package.source.json \
  && npm cache clean --force

COPY src ./src
COPY shared ./shared
# Built on the host first (npm run build:console); served at /console/.
COPY console/dist ./console/dist

RUN mkdir -p /data && chown node:node /data
USER node
ENV NODE_ENV=production \
    AGENT_DATA_DIR=/data \
    HOST=0.0.0.0 \
    PORT=8790
EXPOSE 8790
VOLUME ["/data"]
CMD ["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", "src/server.ts"]
