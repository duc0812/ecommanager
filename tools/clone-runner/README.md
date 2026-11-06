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
- `session.log`: the runner's start and end lines plus everything the session printed, with the store token and the
  worker token replaced by `***` before anything is written; the CLI's final JSON line gives the cost and duration.
- `stage.txt`: `clone`, `qa` or `public`, written by the session and sent with each heartbeat.
- `result.json`: written by the session; the only thing the runner trusts. Deleted before each attempt. A `reused`
  in it is ignored: only the runner's own register lookup marks a job reused, since the server then skips its SKU
  check.

Before each attempt the runner also deletes `.claude\`, `CLAUDE.md`, `CLAUDE.local.md` and `.mcp.json` from the job
folder (a link or junction is removed itself, never its target): Claude Code loads them at start-up, and a retry must
not inherit settings, hooks or MCP servers left by an earlier attempt.

## What a session may do

`session.py` starts `claude -p <prompt> --output-format json --permission-mode dontAsk --restricted --tools
Read,Glob,Grep,Write,Edit,Bash --setting-sources project --strict-mcp-config --allowedTools … --disallowedTools …
--add-dir … --max-budget-usd …` as a list of arguments, never through a shell, with the job folder as the working
directory.

- `--restricted` (per `claude --help`) confines the file tools to the working folders (the job folder and the
  `--add-dir` folders), ignores the user, project and local settings files, and removes every code-running tool
  except the ones `--tools` names. So the bare `Read` cannot reach the owner's credentials, the repo's `.env` files
  or database copies. `--setting-sources project` and `--strict-mcp-config` keep the owner's user settings
  (hundreds of allow rules) and MCP servers out as well.
- `--add-dir`: the job folder; the skill folder of the job's platform and store (all of the store's skills when the
  runner could not tell the platform); the skill folders that tool imports code from (`SHARED_SKILL_DIRS`, for
  reading); the tool's work roots on `D:`; and this folder (`shopify_ops.py`).
- `ALLOWED_TOOLS`: `Read`, `Glob`, `Grep`, `Write`/`Edit` in the job folder, `Bash(python *)`. `build_argv` adds
  `Write`/`Edit` for this job's own work folders only, `<work root>\<slug>` with the slug being the job's SKU code
  in lower case; no other product's folder or register entry is writable by Claude's file tools. `dontAsk` refuses
  anything else. The skill's pre-batch step (Litzzy: `adopt_theme.py --adopt`) writes into the skill folder through
  its own python tool, so it needs no file-tool rule.
- `DISALLOWED_TOOLS`: ssh, scp, sftp, sshpass, cmd, cmd.exe, powershell, pwsh, the PowerShell tool; `Read`, `Edit`
  and `Write` of any path with a `.ssh` folder in it or its 8.3 short name (`SSH~1`, matched as `SSH~*` and
  `ssh~*`); `Read` of `*.env` files; `Write`/`Edit` of the job folder's `.claude\`, `CLAUDE.md`, `CLAUDE.local.md`
  and `.mcp.json`. Claude Code applies `Read` rules to Glob and Grep too; no separate Glob or Grep path rule is used,
  since the help text documents none.
- What the `.ssh` rules do not cover: anything a Python script does, and other names for the same folder (links,
  junctions, `\\?\` and `\\localhost\c$\` paths, `subst` drives). With `--restricted` the home folder is outside the
  working folders anyway; the rules are a second fence for Claude's own file tools.
- The session's environment is the runner's minus every `*_WORKER_TOKEN` variable and the three store variables
  `SHOPIFY_STORE`, `SHOPIFY_ADMIN_TOKEN` and `SHOPIFY_API_VERSION`, plus, for Litzzy, those read from
  `cloning-clipart-customizers-litzzy\shopify.env` (`SHOPIFY_API_VERSION` only if the file has it). The Reminiso
  tools fetch their own token.

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
