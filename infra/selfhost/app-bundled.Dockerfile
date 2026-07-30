FROM node:22-bookworm-slim AS build

ARG BUN_VERSION=1.3.14

RUN npm install --global "bun@${BUN_VERSION}"

WORKDIR /workspace

COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile

COPY . .
RUN bun run build:cf

FROM node:22-bookworm-slim AS runtime

ARG BUN_VERSION=1.3.14
ARG OCI_VERSION=dev
ARG OCI_REVISION=unknown

LABEL org.opencontainers.image.title="camelAI self-host app" \
  org.opencontainers.image.description="Immutable camelAI application bundle for single-node self-host deployments" \
  org.opencontainers.image.version="${OCI_VERSION}" \
  org.opencontainers.image.revision="${OCI_REVISION}" \
  org.opencontainers.image.source="https://github.com/qaml-ai/chiridion"

# Chromium is downloaded by the application dependency install. These shared
# libraries match the source-development image and are required by the local
# Browser Rendering binding.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    git \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libxss1 \
    libxtst6 \
    xdg-utils \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global "bun@${BUN_VERSION}"

WORKDIR /workspace

# Runtime still needs the self-host generators, dispatcher source, migrations,
# and Miniflare/workerd support modules. Install only production dependencies,
# copy the source tree, then overlay the immutable build artifacts.
COPY package.json bun.lock ./
COPY patches ./patches
RUN bun install --frozen-lockfile --production
COPY . .
COPY --from=build /workspace/build /workspace/build
COPY --from=build /workspace/public/notebook-renderer /workspace/public/notebook-renderer

ENV NODE_ENV=production
EXPOSE 3001

# The React Router bundle is built into the image. The lightweight generator
# still runs at startup because it materializes deployment-specific workerd
# bindings from the operator's environment.
CMD ["sh", "-lc", "node scripts/selfhost-workerd-config.mjs && node scripts/selfhost-workerd-serve.mjs"]
