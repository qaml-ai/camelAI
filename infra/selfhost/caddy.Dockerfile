ARG CADDY_VERSION=2.11.4

FROM caddy:${CADDY_VERSION}-builder-alpine AS builder

RUN xcaddy build \
  --with github.com/caddy-dns/cloudflare@v0.2.4 \
  --with github.com/caddy-dns/route53@v1.6.2

FROM caddy:${CADDY_VERSION}-alpine

ARG OCI_VERSION=dev
ARG OCI_REVISION=unknown
LABEL org.opencontainers.image.source="https://github.com/qaml-ai/camelAI" \
  org.opencontainers.image.version="${OCI_VERSION}" \
  org.opencontainers.image.revision="${OCI_REVISION}"

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
