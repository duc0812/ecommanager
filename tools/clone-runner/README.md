# Clone queue runner

Runs on the owner's PC. It holds one claim open to Ecom Manager (`/api/clone-worker/*`), checks each clone job, finds
the personaliser the source page uses, looks the link up in the old Litzzy registers, hands the job to one headless
Claude Code session, and reports the outcome. One job at a time. Spec:
`docs/superpowers/specs/2026-11-06-clone-queue-design.md` (sections 7.6 and 7.7).

| File | Role |
|---|---|
| `runner.py` | claim loop, job checks, heartbeat, result and failure reports, one-runner lock |
| `api.py` | client for `/api/clone-worker/*` (token only in the `Authorization` header) |
| `detect.py` | platform from markers in the source page HTML |
| `registers.py` | the link in `D:\Ecom manager\clipart-clones\*\clone.json` and `customall-clones\*\clone.json` (Litzzy only) |
| `session.py` | starts `claude -p` for a job and reads back `result.json` |
| `proc.py` | the session's process tree: Job Object on Windows, tree kill on timeout or stop |
| `job_prompt.md` | the fixed prompt every session gets, followed by the job's values as JSON |
| `set-token.ps1`, `install-task.ps1` | owner setup (below) |

## Setup (owner)

1. In Ecom Manager, "Clone từ link" > settings (SUPERADMIN): create the worker token. It is shown once.
2. `powershell -ExecutionPolicy Bypass -File tools\clone-runner\set-token.ps1` and paste the token. It stores
   `ECOM_URL` and `CLONE_WORKER_TOKEN` as user environment variables and never prints the token.
3. Keep `claude` logged in (`claude auth`) and Python 3.12 on the PATH.
4. First run, supervised, from its own terminal: `python tools\clone-runner\runner.py --once`. Never start the runner
   from inside a Claude Code session: `claude` refuses to start inside another session.
5. Once the owner is happy with that run: `powershell -ExecutionPolicy Bypass -File tools\clone-runner\install-task.ps1`.
   It registers "EcomManager Clone Runner": `python runner.py` at logon, restarted a minute after a failure, no
   time limit. The task's console window is the runner's log.

## Environment

| Variable | Default | Use |
|---|---|---|
| `ECOM_URL` | (required) | `https://<host>`; `http://` only for localhost |
| `CLONE_WORKER_TOKEN` | (required) | `cqw_…`; never logged, never passed to a session |
| `CLONE_CLAUDE_BIN` | `claude` | path to `claude.exe`; a `.cmd`/`.bat` is refused (it would run through cmd.exe) |
| `CLONE_CLAUDE_MODEL` | CLI default | `--model` for every session (user settings are not loaded, see below) |
| `CLONE_MAX_BUDGET_USD` | `8` | `--max-budget-usd` per session |
| `CLONE_SKILLS_ROOT` | `C:\Users\TM PC\.claude\skills` | where the clone skills live |

## A job on disk

`D:\Ecom manager\clone-queue\<jobId>\` (change with `--job-root`):

- `job.json`: the job's values for the session (link, SKU code, slug = code in lower case, store, `targets`,
  skill folder, work roots, this folder) and `requestedByName` as data. It never holds a token.
- `session.log`: the runner's start and end lines plus everything the session printed; the CLI's final JSON line
  gives the cost and duration.
- `stage.txt`: `clone`, `qa` or `public`, written by the session and sent with each heartbeat.
- `result.json`: written by the session; the only thing the runner trusts. Deleted before each attempt.

## What a session may do

`session.py` starts `claude -p <prompt> --output-format json --permission-mode dontAsk --setting-sources project
--strict-mcp-config --allowedTools … --disallowedTools … --add-dir … --max-budget-usd …` as a list of arguments,
never through a shell, with the job folder as the working directory.

- `ALLOWED_TOOLS`: `Read`, `Glob`, `Grep`; `Write`/`Edit` only in the job folder and in a work folder named like a
  queue slug under `D:\Ecom manager\*-clones\`; `Bash(python *)`. `dontAsk` refuses anything else.
- `DISALLOWED_TOOLS`: ssh, scp, sftp, sshpass, cmd, cmd.exe, powershell, pwsh, the PowerShell tool, and reading or
  writing anything under a `.ssh` folder; also reading `*.env` files.
- `--setting-sources project` keeps the owner's own user settings (hundreds of allow rules) out of the session, and
  `--strict-mcp-config` starts no MCP server. The job folder has no project settings.
- `--add-dir`: the job folder, the skill folder of the job's platform and store (all of the store's skills when the
  runner could not tell the platform), the tool's work roots on `D:`, and this folder (`shopify_ops.py`).
- The session's environment is the runner's minus every `*_WORKER_TOKEN` and `SHOPIFY_*` variable, plus, for Litzzy,
  `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN` (and `SHOPIFY_API_VERSION` if present) read from
  `cloning-clipart-customizers-litzzy\shopify.env`. The Reminiso tools fetch their own token.

This narrows what a session can do; it is not a sandbox. Any Python script the session runs can still read and
write whatever this Windows account can, including the SSH keys, the NAS and the store tokens. The stronger fix is
a separate Windows account without those, kept for the PC hardening round. Both tool lists are constants in
`session.py`: tune them after a supervised run if a session gets blocked on a legitimate command.

A session runs at most 120 minutes. On timeout, or when the server says the job was cancelled or the lease was lost,
the runner kills the whole process tree. On Windows each session sits in a Job Object that kills it when the
runner's handle closes, so a session dies with the runner too. If Windows refuses the Job Object, the runner writes a
line to `session.log` and falls back to `taskkill /T`.

## Tests

```powershell
python -m pytest tools/clone-runner/tests -q
```

The tests use a fake `claude` (`tests/fake_claude.py`), a fake server and temporary folders; they never start
`claude`, call a store or open a link.
