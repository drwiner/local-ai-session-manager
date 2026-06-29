#!/bin/bash
# Production launcher for the session manager, used by the LaunchAgent.
# Builds (to pick up any source changes since last boot), then serves.
set -euo pipefail

cd "$(dirname "$0")/.."

export PORT=8420
export NODE_ENV=production

echo "[start-prod] $(date) building..."
pnpm build

echo "[start-prod] $(date) starting on :$PORT"
exec pnpm exec next start -p "$PORT"
