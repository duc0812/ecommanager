#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="${1:-}"
if [[ -z "${mode}" ]]; then
  echo "Usage: $0 <review|fix> [task prompt]" >&2
  exit 2
fi
shift

if ! command -v codex >/dev/null 2>&1; then
  echo "Codex CLI is not installed. Run scripts/codex-vps-setup.sh first." >&2
  exit 3
fi

if [[ "$#" -gt 0 ]]; then
  task_prompt="$*"
else
  task_prompt="$(cat)"
fi

if [[ -z "${task_prompt//[[:space:]]/}" ]]; then
  echo "A task prompt is required." >&2
  exit 4
fi

case "${mode}" in
  review)
    sandbox="read-only"
    guardrail="Review only. Do not modify files. Inspect the real code path, report findings by severity with file locations, and run only read-only diagnostics."
    ;;
  fix)
    sandbox="workspace-write"
    guardrail="Implement the smallest safe fix in the repository and verify it. Do not commit, push, deploy, restart services, edit environment files, or touch the runtime database unless the user explicitly asks."
    ;;
  *)
    echo "Mode must be 'review' or 'fix'." >&2
    exit 5
    ;;
esac

printf '%s\n\n%s\n' "${guardrail}" "${task_prompt}" \
  | codex exec --ephemeral --cd "${repo_root}" --sandbox "${sandbox}" -
