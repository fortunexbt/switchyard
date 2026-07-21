#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
backend_pid=""
frontend_pid=""

cleanup() {
  [[ -n "$backend_pid" ]] && kill "$backend_pid" 2>/dev/null || true
  [[ -n "$frontend_pid" ]] && kill "$frontend_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

PYTHONPATH="$repo_root/backend" "$repo_root/.venv/bin/python" -m app &
backend_pid=$!

(cd "$repo_root/frontend" && npm run dev) &
frontend_pid=$!

wait "$backend_pid" "$frontend_pid"
