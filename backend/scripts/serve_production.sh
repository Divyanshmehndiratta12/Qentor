#!/usr/bin/env bash
# Build the web app and serve it, with the API, from ONE process (the same thing the Dockerfile runs).
# Usage: backend/scripts/serve_production.sh [port]      (from anywhere; needs Node 22 and backend/.venv)
set -euo pipefail
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
port="${1:-8000}"
( cd "$root/web" && npm ci && npm run build )
cd "$root"
exec backend/.venv/bin/python -m uvicorn qentor.api.app:app --app-dir backend --host 0.0.0.0 --port "$port"
