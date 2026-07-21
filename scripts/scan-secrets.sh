#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pattern='AKI''A[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|BEGIN ([A-Z ]+ )?PRIVATE KEY'

found=1
if git -C "$repo_root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  LC_ALL=C git -C "$repo_root" grep -nIE "$pattern" -- . \
    ':(exclude)scripts/scan-secrets.sh' && found=0 || found=$?
else
  LC_ALL=C grep -RInIE \
    --exclude='scan-secrets.sh' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude-dir='.git' \
    --exclude-dir='.venv' \
    --exclude-dir='node_modules' \
    --exclude-dir='dist' \
    --exclude='*.db' \
    --exclude='*.db-shm' \
    --exclude='*.db-wal' \
    "$pattern" "$repo_root" && found=0 || found=$?
fi

if [[ "$found" -eq 0 ]]; then
  echo "Potential credential material found." >&2
  exit 1
fi

if [[ "$found" -ne 1 ]]; then
  echo "Secret scan failed to inspect the source tree." >&2
  exit "$found"
fi

echo "No high-signal credential patterns found."
