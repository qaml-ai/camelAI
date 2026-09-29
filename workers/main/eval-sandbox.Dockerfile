FROM docker.io/cloudflare/sandbox:0.12.10

COPY sandbox/create-worker /usr/local/lib/create-worker
RUN chmod +x /usr/local/lib/create-worker/create-worker.mjs /usr/local/lib/create-worker/publish.mjs \
  && ln -sf /usr/local/lib/create-worker/create-worker.mjs /usr/local/bin/create-worker \
  && ln -sf /usr/local/lib/create-worker/publish.mjs /usr/local/bin/publish
