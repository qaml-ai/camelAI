# Unified analysis container (AnalysisSandbox) — successor to the warehouse tier.
#
# One warm container per workspace runs Jupyter notebook execution, ad-hoc Python/
# shell, and DuckDB cross-source reduction. Runtime egress is SDK-enforced:
# `enableInternet = false` with `allowedHosts` = PyPI (so `uv` can install packages
# beyond this baked stack) plus the intercepted `connections.internal` host for
# live workspace-connection queries (served by a Worker-side outbound handler; no
# credential enters the container). See analysis-sandbox.ts and
# plans/stateless-data-analysis-architecture.md.
#
# The default data stack is baked in so the common case needs NO install step
# (deleting the old skill's `uv init && uv add …` preamble). Projects that declare
# a pyproject.toml sync from the seeded uv cache in seconds.
#
# Tag MUST match the @cloudflare/sandbox npm version (0.12.10). Do NOT set ENTRYPOINT
# — the base image's entrypoint starts the sandbox HTTP API server; we only add
# packages and tools on top.
#
# SANDBOX_BASE_IMAGE exists because Cloudflare publishes amd64-only images:
# on Apple Silicon the amd64 image runs under Rosetta/QEMU, where the Jupyter
# kernel never answers its handshake, so run_notebook always fails locally.
# scripts/build-analysis-sandbox-image.mjs builds the same base from the
# sandbox-sdk source for arm64 and passes it here; production always uses the
# default.
ARG SANDBOX_BASE_IMAGE=docker.io/cloudflare/sandbox:0.12.10-python
FROM ${SANDBOX_BASE_IMAGE}

# --- CLI tools the data-analysis skill documents -----------------------------
# sqlite3 for local DBs; usql as the universal SQL CLI (static binary).
RUN apt-get update \
    && apt-get install -y --no-install-recommends sqlite3 ca-certificates curl bzip2 \
    && rm -rf /var/lib/apt/lists/*

# usql universal SQL client. Pinned to 0.19.3: newer releases (>= 0.21) are
# built against glibc 2.38, and this base image is Ubuntu 22.04 / glibc 2.35.
# Re-check when the sandbox base image moves to a newer Ubuntu.
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
# (keep in sync with ANALYSIS_DEFAULT_STACK in analysis-service.ts). The common
# analysis needs no install: `python`, `jupyter`, and the stack are ready. The
# install also populates UV_CACHE_DIR, so project `uv sync`/`uv add` runs reuse
# the downloaded wheels. This step is BUILD-FATAL by design — a resolution or
# network failure must fail the image build, never ship a stackless image.
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
# sandbox/validate-notebook.py (canonical). The copy is kept byte-identical by a drift test
# (analysis-service.test.ts); update both together.
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
# default venv, per-project uv environments, AND run_code alike. Keep in sync
# with ANALYSIS_PYTHONPATH in analysis-service.ts.
COPY analysis-sandbox-assets/camelai /opt/camelai-python/camelai
ENV PYTHONPATH=/opt/camelai-python
