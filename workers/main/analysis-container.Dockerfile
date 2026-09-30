# Workspace analysis container (AnalysisContainer, Sandbox SDK 1.0 on the native
# Durable Object container API).
#
# One warm container per workspace runs Jupyter notebook execution, ad-hoc
# Python/shell and DuckDB cross-source reduction. Egress is set up by the
# Durable Object, not here: the container starts with the internet off, and
# outbound intercepts allow only PyPI (so `uv` can install beyond this baked
# stack) and `connections.internal` (live workspace-connection queries, served in
# the Worker; no credential enters the container). See analysis-container.ts
# and plans/stateless-data-analysis-architecture.md.
#
# The default data stack is baked in so the common case needs NO install step.
# Projects that declare a pyproject.toml sync from the seeded uv cache in seconds.
#
# 1.0 has no sandbox server: the main process only has to stay alive, and the
# Durable Object runs every command with ctx.container.exec(). exec() sees none
# of the ENV lines below (only PATH) and starts in / whatever WORKDIR says, so
# analysis-container.ts passes the same variables (ANALYSIS_BASE_ENV) and a cwd
# on every command. Keep the two in sync.
#
# Cloudflare runs containers as linux/amd64, and sandbox-shim (used by Files
# and S3Mount) is published for amd64 only, hence the pinned platform on its
# donor stage. Everything else is multi-arch, so an arm64 host can build this
# natively (scripts/build-analysis-sandbox-image.mjs), where Jupyter works; the
# shim then runs under the host's amd64 emulation.
FROM --platform=linux/amd64 docker.io/cloudflare/sandbox:1.0.0 AS sandbox-tools

FROM docker.io/python:3.13-slim-trixie

# --- System tools ------------------------------------------------------------
# ca-certificates: the DO appends the HTTPS intercept CA to this bundle.
# fuse3 + s3fs: S3Mount's R2 mounts on Cloudflare (self-host copies instead).
# sqlite3 for local DBs; git/curl/wget/jq/unzip/zip/xz/bzip2/procps for the
# shell work the data-analysis skill documents (the 0.12 base image had them).
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        ca-certificates curl wget git jq unzip zip bzip2 xz-utils procps \
        sqlite3 fuse3 s3fs \
    && rm -rf /var/lib/apt/lists/*

# Files (readFile/writeFile/stat/mkdir/rename) and S3Mount run this helper. Keep
# its tag equal to the installed @cloudflare/sandbox version.
COPY --from=sandbox-tools /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim

# usql universal SQL client (static-ish binary built against glibc 2.35).
RUN set -eux; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64) usql_arch="amd64" ;; \
      aarch64|arm64) usql_arch="arm64" ;; \
      *) echo "unsupported arch $arch" >&2; exit 1 ;; \
    esac; \
    curl -fsSL "https://github.com/xo/usql/releases/download/v0.19.3/usql-0.19.3-linux-${usql_arch}.tar.bz2" -o /tmp/usql.tar.bz2; \
    tar -xjf /tmp/usql.tar.bz2 -C /usr/local/bin usql; \
    rm /tmp/usql.tar.bz2; \
    /usr/local/bin/usql --version

# --- uv (fast Python package manager) with a seeded cache --------------------
# uv drives per-project `pyproject.toml` syncs; a seeded cache makes them fast
# even on a cold container.
ENV UV_CACHE_DIR=/opt/uv-cache
RUN curl -fsSL https://astral.sh/uv/0.5.11/install.sh | env UV_INSTALL_DIR=/usr/local/bin sh \
    && uv --version

# --- Baked default analysis venv (on PATH) -----------------------------------
# The exact set the data-analysis skill used to `uv add` on every fresh VM
# (keep in sync with ANALYSIS_DEFAULT_STACK in analysis-service.ts). Python 3.13
# is the base image's. The install also populates UV_CACHE_DIR, so project
# `uv sync`/`uv add` runs reuse the downloaded wheels. This step is BUILD-FATAL
# by design — a resolution or network failure must fail the image build, never
# ship a stackless image.
ENV ANALYSIS_VENV=/opt/analysis-venv
RUN uv venv --python 3.13 "$ANALYSIS_VENV" \
    && VIRTUAL_ENV="$ANALYSIS_VENV" uv pip install --python "$ANALYSIS_VENV/bin/python" \
        pandas numpy polars duckdb pyarrow \
        altair plotly matplotlib seaborn \
        scipy scikit-learn statsmodels \
        openpyxl xlsxwriter pdfplumber python-docx python-pptx \
        sqlalchemy 'psycopg[binary]' pymysql \
        jupyter nbconvert ipykernel
ENV PATH="/opt/analysis-venv/bin:${PATH}"

# --- validate-notebook CLI ---------------------------------------------------
# Pure-stdlib .ipynb inspector (cell errors, charts fallen back to text/plain,
# blank/constant charts). Wrangler's container build context is this Dockerfile's
# directory (workers/main), so we COPY a build-context copy of the canonical
# sandbox/validate-notebook.py. The copy is kept byte-identical by a drift test
# (tests/analysis-sandbox-asset-drift.test.ts); update both together.
COPY analysis-sandbox-assets/validate-notebook.py /usr/local/bin/validate-notebook
RUN chmod +x /usr/local/bin/validate-notebook

# --- execute-notebook runner ---------------------------------------------------
# In-place notebook executor that saves after EVERY cell (nbconvert only writes
# on full success, so a failure discarded all completed cells' outputs). Invoked
# as `python /usr/local/bin/execute-notebook` so it runs under whichever env is
# active (baked venv or a project's uv env); nbclient/nbformat come with the
# jupyter toolchain either way. See notebookExecuteCommand in analysis-service.ts.
COPY analysis-sandbox-assets/execute-notebook.py /usr/local/bin/execute-notebook
RUN chmod +x /usr/local/bin/execute-notebook

# --- uploaded archive inspector/extractor -----------------------------------
# Purpose-built ZIP handling for agents. It lists/reads entries without copying
# the archive and stages extraction before touching a materialized project tree.
COPY analysis-sandbox-assets/archive-tool.py /usr/local/bin/camelai-archive
RUN chmod +x /usr/local/bin/camelai-archive

# --- camelai Python helper package --------------------------------------------
# In-sandbox helpers for workspace connections and BigQuery (`from camelai
# import bq`): RPC plumbing, MCP response parsing, and export→DuckDB loading.
# On PYTHONPATH (not installed into a venv) so it is importable from the baked
# default venv, per-project uv environments, AND run_code alike.
COPY analysis-sandbox-assets/camelai /opt/camelai-python/camelai
ENV PYTHONPATH=/opt/camelai-python

RUN mkdir -p /projects /scratch /venvs
WORKDIR /root

CMD ["sleep", "infinity"]
