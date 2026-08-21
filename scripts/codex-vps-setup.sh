#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  echo "Node.js and npm are required before installing Codex CLI." >&2
  exit 1
fi

if ! command -v codex >/dev/null 2>&1; then
  if [[ "${1:-}" == "--install" ]]; then
    npm install --global @openai/codex
  else
    echo "Codex CLI is not installed. Run:" >&2
    echo "  bash scripts/codex-vps-setup.sh --install" >&2
    exit 2
  fi
fi

echo "Codex CLI: $(codex --version)"
echo "Repository: ${repo_root}"

if codex login status; then
  echo "Codex is ready on this VPS."
else
  echo
  echo "Authenticate this headless VPS with one of these supported methods:"
  echo "  codex login --device-auth"
  echo "  printenv OPENAI_API_KEY | codex login --with-api-key"
  echo
  echo "Device authentication is recommended for an interactive ChatGPT account."
  exit 3
fi

git -C "${repo_root}" status --short
