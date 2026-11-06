# Clone queue runner

Runs on the owner's PC. It holds one claim open to Ecom Manager (`/api/clone-worker/*`), checks each clone job, finds
the personaliser the source page uses, looks the link up in the old Litzzy registers, hands the job to one headless
Claude Code session, and reports the outcome. One job at a time. Spec:
`docs/superpowers/specs/2026-11-06-clone-queue-design.md` (sections 7.6 and 7.7).

| File | Role |
|---|---|
| `runner.py` | claim loop, job checks, heartbeat, result and failure reports, one-runner lock, `runner.log` |
| `api.py` | client for `/api/clone-worker/*` (token only in the `Authorization` header) |
| `detect.py` | platform from markers in the source page HTML; `python detect.py --url <link>` prints it as one word for a session (`unloaded` when the page could not be fetched) |
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
4. Run the runner from its own checkout of a reviewed commit, one that nothing else uses: it re-reads `job_prompt.md`
   for every job, so a worktree that other sessions switch branches in would hand a job whatever prompt happens to be
   checked out. Never start it from inside a Claude Code session either: `claude` refuses to start inside another
   session.
5. First run, supervised, from a plain terminal: `python tools\clone-runner\runner.py --once`.
6. Once the owner is happy with that run: `powershell -ExecutionPolicy Bypass -File tools\clone-runner\install-task.ps1`
   from that checkout. It registers "EcomManager Clone Runner" for the current user, interactive and not elevated:
   the `python.exe` the PATH resolves to (refused when it is the `\WindowsApps\` alias stub or older than 3.12) runs
   `runner.py` at logon with the runner folder as its working directory, no time limit, restart-on-failure set on the
   task's settings (`-RestartCount`, `-RestartInterval` 1 minute). Whether Task Scheduler restarts the task after a
   plain non-zero exit (the runner's own exit codes below) is unverified. The task's console window shows the log;
   `runner.log` is the record.

## Stopping it

- The pause switch on the page stops the runner from getting a new job; it does not stop a running job.
- The remote kill switch is revoking the worker token on the page: the next heartbeat (within about a minute) gets a
  401, the runner kills the session's process tree, and the claim loop exits with code 3.
- On the PC: close the task's window or `Stop-ScheduledTask`; the session dies with the runner (Job Object).

Exit codes: 0 done (`--once`), 1 another runner holds the lock (with `--once` also: the server could not be reached,
or the disk is short of space), 2 `ECOM_URL` or `CLONE_WORKER_TOKEN` missing or malformed, 3 the server refused the
token, 4 (`--once`) the Claude CLI could not run.

## Environment

| Variable | Default | Use |
|---|---|---|
| `ECOM_URL` | (required) | `https://<host>`; `http://` only for localhost |
| `CLONE_WORKER_TOKEN` | (required) | `cqw_…`; never logged, never passed to a session |
| `CLONE_CLAUDE_BIN` | `claude` | path to `claude.exe`; a `.cmd`/`.bat` is refused (it would run through cmd.exe) |
| `CLONE_CLAUDE_MODEL` | CLI default | `--model` for every session (user settings are not loaded, see below) |
| `CLONE_MAX_BUDGET_USD` | `8` | `--max-budget-usd` per session |
| `CLONE_BASH_TIMEOUT_MS` | `3600000` | digits only, clamped to 60000…7200000; given to every session as `BASH_DEFAULT_TIMEOUT_MS` and `BASH_MAX_TIMEOUT_MS` (Claude Code's Bash tool stops a command after 2 minutes otherwise, and settings files do not apply under `--restricted`) |
| `CLONE_CLI_BACKOFF_S` | `1800` | seconds the claim loop waits after a session found the Claude CLI unable to run |
| `CLONE_SKILLS_ROOT` | `C:\Users\TM PC\.claude\skills` | where the clone skills live |

Every session also gets `DISABLE_AUTOUPDATER=1`: the session itself never updates the CLI. The owner's own interactive
sessions can still update the shared `claude` executable, so the version can change between two jobs.

## A job on disk

`D:\Ecom manager\clone-queue\` (change with `--job-root`) holds `runner.lock`, `runner.log` (every runner log line,
appended in UTF-8; past 5 MB it becomes `runner.log.1`, replacing the older one) and one folder per job,
`<jobId>\`:

- `job.json`: the job's values for the session (link, SKU code, slug = code in lower case, store, `targets`,
  skill folder, work roots, this folder) and `requestedByName` as data. It never holds a token.
- `session.log`: the runner's start and end lines plus everything the session printed: with
  `--output-format stream-json --verbose` that is one JSON object per line for each step (the start-up line, every
  assistant message, every tool call and its result) and last the `"type": "result"` line the runner reads the cost
  and duration from. The store token and the worker token are replaced by `***` before anything is written.
- `stage.txt`: `clone`, `qa` or `public`, written by the session and sent with each heartbeat.
- `result.json`: written by the session; the only thing the runner trusts. Deleted before each attempt. A `reused`
  in it is ignored: only the runner's own register lookup marks a job reused, since the server then skips its SKU
  check. Its `platform` is sent in one last heartbeat when the runner could not tell the platform itself.
- `<slug>\tool-state.json`: the Litzzy tool's own state. When a session times out or ends without `result.json`, the
  runner reports the product named in its `done.product.id` as this job's leftover. When a session is stopped (the
  job was cancelled or its lease lost) nothing is sent: the lease lapses and the server requeues or fails the job.

Before each attempt the runner also deletes `.claude\`, `CLAUDE.md`, `CLAUDE.local.md` and `.mcp.json` from the job
folder (a link or junction is removed itself, never its target): Claude Code loads them at start-up, and a retry must
not inherit settings, hooks or MCP servers left by an earlier attempt. It also looks in the job root and every folder
above it: a `CLAUDE.md`, `CLAUDE.local.md` or `.claude\CLAUDE.md` there fails the job (`TOOL`, the path in
`runner.log`) until it is removed, since Claude Code would load it into every session; `.claude\settings*.json` found
there is only logged at start-up, as `--restricted` leaves settings files out.

## What a session may do

`session.py` starts `claude -p <prompt> --output-format stream-json --verbose --permission-mode dontAsk --restricted
--safe-mode --tools Read,Glob,Grep,Write,Edit,Bash --setting-sources project --strict-mcp-config --allowedTools …
--disallowedTools … --add-dir … --max-budget-usd …` as a list of arguments, never through a shell, with the job
folder as the working directory.

- `--restricted` (per `claude --help`) confines the file tools to the working folders (the job folder and the
  `--add-dir` folders), ignores the user, project and local settings files, and removes every code-running tool
  except the ones `--tools` names. So the bare `Read` cannot reach the owner's credentials, the repo's `.env` files
  or database copies. `--setting-sources project` and `--strict-mcp-config` keep the owner's user settings
  (hundreds of allow rules) and MCP servers out as well.
- `--safe-mode` (per `claude --help`) starts the session with CLAUDE.md, skills, plugins, hooks, MCP servers and the
  other customisations disabled, while permissions work normally.
- `--add-dir`: the job folder; the skill folder of the job's platform and store (all of the store's skills when the
  runner could not tell the platform); the skill folders that tool imports code from (`SHARED_SKILL_DIRS`, for
  reading); the tool's work roots on `D:`; and this folder (`shopify_ops.py`, `detect.py`).
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
  `cloning-clipart-customizers-litzzy\shopify.env` (`SHOPIFY_API_VERSION` only if the file has it), plus the Bash
  timeouts and `DISABLE_AUTOUPDATER` above. The Reminiso tools fetch their own token.

This narrows what a session can do; it is not a sandbox. Any Python script the session runs can still read and
write whatever this Windows account can, including the SSH keys, the NAS and the store tokens. The stronger fix is
a separate Windows account without those, kept for the PC hardening round. Both tool lists are constants in
`session.py`: tune them after a supervised run if a session gets blocked on a legitimate command.

## Time limits and guards

- A session runs at most 120 minutes. On timeout, or when the server says the job was cancelled or the lease was
  lost, the runner kills the whole process tree. On Windows each session sits in a Job Object that kills it when the
  runner's handle closes, so a session dies with the runner too. If Windows refuses the Job Object, the runner writes
  a line to `session.log` and falls back to `taskkill /T`.
- The heartbeat stops by itself 30 minutes after a session's 120 could have ended, so a runner stuck after its
  session loses the lease and the server hands the job out again. At start-up the runner switches QuickEdit off in
  its console window (a click into the window would otherwise freeze the next console write); a console write that
  fails is dropped, and `runner.log` keeps the line.
- A session that ends without `result.json` and either fails within one turn or prints no result at all within
  90 seconds means the Claude CLI could not run (logged out, usage limit spent, a start-up error). The job fails as
  retryable `TOOL`, the runner logs one loud line and claims nothing for `CLONE_CLI_BACKOFF_S`; `--once` exits with
  code 4 instead. So a broken CLI does not fail the whole queue within minutes.
- Before each claim the runner checks the job root's drive: under 2 GB free, it logs a line and waits 5 minutes
  instead of claiming.

## Tests

```powershell
python -m pytest tools/clone-runner/tests -q
```

The tests use a fake `claude` (`tests/fake_claude.py`), a fake server and temporary folders; they never start
`claude`, call a store or open a link.
