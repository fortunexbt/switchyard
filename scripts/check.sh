#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PYTHONPATH="$repo_root/backend" "$repo_root/.venv/bin/python" -m pytest \
  -c "$repo_root/backend/pytest.ini" "$repo_root/backend/tests" -q
"$repo_root/.venv/bin/python" -m compileall -q "$repo_root/backend/app"
"$repo_root/.venv/bin/python" -m pip_audit -r "$repo_root/backend/requirements.txt" --strict

(cd "$repo_root/frontend" && npm test && npm run typecheck && npm run build && npm audit --audit-level=high)
"$repo_root/scripts/scan-secrets.sh"
