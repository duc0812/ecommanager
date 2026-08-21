# Codex Repository Instructions

Read `CLAUDE.md`, `SPEC.md`, `PLAN.md`, and `NOTES.md` before changing code. For fulfillment or supplier work, also read the active fulfillment specification referenced by `CLAUDE.md`.

## VPS safety

- Inspect `git status` before editing and preserve unrelated work.
- Never edit, replace, copy, or delete the runtime SQLite database or environment files.
- Do not commit, push, deploy, restart services, or change PM2/nginx/systemd configuration unless the user explicitly requests it.
- Keep the sandbox at `workspace-write`; request approval before any operation outside the repository.
- Diagnose with read-only commands first. For fixes, make the smallest scoped change and run the relevant tests plus TypeScript validation.
- Treat `~/.codex/auth.json`, API keys, OAuth tokens, `.env`, and production logs as secrets. Never print or commit them.

## Verification

For application changes, run the checks relevant to the change. The full verification sequence is:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
```

Report any check that could not run and why.
