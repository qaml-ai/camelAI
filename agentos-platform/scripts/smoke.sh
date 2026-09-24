#!/usr/bin/env bash
# CI-friendly smoke: unit tests + typecheck (no long-running server boot).
set -euo pipefail

export PATH="/home/ubuntu/.bun/bin:${PATH:-}"
cd "$(dirname "$0")/.."

echo "==> agentos-platform smoke: typecheck"
bun run typecheck

echo "==> agentos-platform smoke: unit tests"
bun run test

echo "OK — agentos-platform smoke passed"
