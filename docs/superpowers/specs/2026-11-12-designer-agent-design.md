# Designer Agent — design (2026-11-12)

Branch `feat/designer-agent`, cut from `origin/main` 9f94358 (what production runs). Worktree `D:\Ecom manager\wt-designer-agent`.

## Why

Today every design fix and every new batch of artwork starts with the owner typing a request to an AI session. Designers already record what is wrong on the tool ("Trả lại sửa" + reasons: 235 rejects in two weeks, 95 tasks sitting in REJECTED on 11/12), but nothing picks those up. The owner is the bottleneck.

Goal: designers drive the work themselves. A reject on the tool, or a request in the Lark group, becomes a job that an agent on the shop PC executes; the result comes back on the tool for the designer to review. The owner is only called when the agent cannot finish.

## Decided by the owner (11/11–11/12/2026)

1. Results are returned on the tool only. The designer opens Design Studio and checks the task the agent finished. The chat group is where requests are made, not where results live.
2. The group chat is Lark (Larksuite), with the owner in it. Designers may ask the bot for anything that belongs to Design Studio. Other data (revenue, ads, customers, suppliers) is out of scope. No owner pre-approval step before the agent starts.
3. Most requests are fixes of existing designs. New designs are secondary.
4. The reject dialog needs a free-text "Lý do khác" in addition to the multi-select list, and more precise reasons, e.g.: background colour not uniform between pieces; main motif outside the safe zone; wrong template mapping; wrong detail.
5. A fix is made on one order. When it is done the agent must ask the designer whether to save it to the library, and show the plan: which orders in the system are affected if it is saved.
6. Scope of "affected orders": when an order is fixed, the other orders of that design are fixed too — later orders whatever their status, including ones already sent to the factory (they go back to the factory), and earlier orders that are not yet produced. Affected orders get their art updated to the new design.
7. A QA verdict carries the fix per piece; the loop runs until the design passes; after 3 failed rounds the owner is told (rule of 11/11).
8. Capacity: about 5 fix / new-design jobs at the same time on the shop PC, each with its own Codex session; auto render is faster and separate.
9. Hourly schedule: scan the lines labelled AUTO, render with the local tool, push up. Auto render is a settled process: the schedule only runs the tool, no visual QA step. One thing to guard: a custom name must stay clear of the safe-zone line.
10. Order when the queue is long was not chosen by the owner (see "My calls").

## Non-goals and anti-goals

- The agent never approves a design, never creates/cancels a supplier order, never writes a supplier sheet or messages a supplier, never emails a customer. Everything it produces stops at REVIEW.
- No AI in the hourly auto-render run.
- Not a general chat bot: no answers about data outside Design Studio.
- Anti-goal: a silent run. A run or job that could not do its work must leave a visible trace (task note, job state, log), never "0 lines" with exit 0.
- Anti-goal: touching work of other sessions. The tool worktree `.claude/worktrees/peaceful-villani-d3d860` is dirty and mid cherry-pick; nothing in this project edits or commits files there. Running its scripts and its dev server on :3013 is allowed — every order-processing session already does that. Its path is a config value (`TOOL_WORKTREE`), never hard-coded in logic; if the scripts are missing the run fails loudly.
- The agent never writes the prod database directly. Everything it delivers goes through the app's API (new runner endpoints below), so the app's own rules and hooks apply.

## Existing pieces this builds on (verified 11/12)

- Reject: `transitionTask` REJECTED branch (`src/lib/design-tasks.ts`), dialog in `src/app/design-studio/components/TaskHeader.tsx` and `ReviewWorkspace.tsx`. Already multi-select. Reasons come from `AppSetting 'design.settings'.rejectReasons`, editable in `/design-studio/settings`. The transition route accepts any strings as reasons.
- Sent lines: `reopenLineForFix` puts a sent line's task in REJECTED with a `LINE_FIX_REASONS` reason; after approval `SUPPLIER_RECHECK` / "Cần báo xưởng" tells staff what to tell the factory. Unchanged.
- Queue pattern to copy: `CloneJob` + `src/lib/clone/worker.ts` (hashed bearer token, long-poll claim, heartbeat lease, last-seen). `ArtworkJob` cannot be reused (requires `entryId`).
- Design code of a line: `designOf(sku)` in `src/lib/flat-text-coverage.ts`. No helper lists the other lines of a design yet.
- PC: `claude` 2.1.260 on PATH; Codex bundled with the desktop app at `C:\Users\TM PC\AppData\Local\OpenAI\Codex\bin\<hash>\codex.exe` (0.167; the `codex` on PATH is 0.128 and cannot run the configured model). `codex exec -C <dir> --skip-git-repo-check -o <file> "<prompt>"` and `codex exec resume <session id>` were used on 11/12 for LIT6262_1.
- PC schedule pattern: `Register-ScheduledTask` as user `TM PC`, `-MultipleInstances IgnoreNew` (see task "EcomManager Disk Janitor"). Existing task "EcomManager Auto Render" (daily 07:00, `ecom-worker\tools\artwork-worker\run-daily.ps1`) drains the PROD render queue; it stays.
- `process-new-orders.mjs` (tool worktree) renders library lines through a local tool on :3013 (nothing supervises it; it is down on 11/12), reuses no-name links, runs flat-text, writes specs; `--push` runs apply → prove → push. It has no readiness filter and no safe-zone check. Push scripts take no `.push-lock` themselves.

## Part 1 — Hourly auto render (PC only, no server change)

New folder `tools/auto-render-hourly/` in this repo: `run.ps1` (entry), `auto_render.py` (logic), `safe_zone.py` (name check), `install-task.ps1`, `README.md`, tests.

One run:
1. Take the named mutex `Local\EcomManagerAutoRenderHourly`; if held, exit 0 with a log line (previous run still going).
2. Disk guard: free space on D: under 30 GB → log and stop (own check with `shutil.disk_usage`; `janitor.py` is not in git, so it is not a dependency).
3. Local tool: probe `http://localhost:3013/api/auth/login` reachability; if down, start `node node_modules/next/dist/bin/next dev --port 3013` in the tool worktree, wait up to 120 s. After login, GET one known task; a non-2xx answer stops the run with exit 1 and the message "tool local lỗi <status>" (this is the silent "render 0" trap).
4. Run `process-new-orders.mjs --since <today − 14 days>` WITHOUT `--push`. `--skip` does not stop library renders, so the AUTO filter is applied at push time (step 6), on the readiness column of the prod snapshot the run used.
5. Name guard on every line about to be pushed that carries a custom name (flat-text outputs and local AUTO renders). v1 detects and holds; it does not re-render (the renderers live outside this repo):
   - "No" guard: a line whose customer answer is a lone "No" must carry no name — the pushed file must equal the no-name render (flat-text: the spec's `baseNoName`/`base` with no text drawn; worker: `noName` true in the claim). A hit holds the line.
   - Box guard: the name's ink box (difference between the render and the same render without the name, or the renderer's reported box) must lie inside the box the design gives the name (flat-text `texts[].box`; worker: the field's box from the entry), with a 3 px tolerance. Arc, glow and swashes that grow past the box are what this catches.
   - Safe guard: that designed box, and the ink box, must lie inside the print area's rect inset by `PrintTemplate.safeIn × dpi`; where the spec gives `minimumCutClearancePx` use the larger. For shaped pieces the rect inset is weaker than the real cut line; the box guard is the main protection there. A line with no usable geometry (no box, no template) is pushed with the warning "không kiểm được safe zone" in the summary, not held.
6. Push the lines that passed and whose prod readiness is AUTO, holding `artwork-builder/.push-lock` (mkdir/rmdir, wait up to 30 min, never break): local renders one line at a time with `push-local-renders.mjs --line <key>` through apply → prove → push; flat-text and reuse groups with a copy of the spec filtered to the passing AUTO lines through `push-shared-prints.mjs`. Tasks end in REVIEW / AUTO, as today.
7. Held lines: when Part 2 is deployed and `agent.autoFixOnReject` is on, `POST /api/design-agent/runner/hold` `{ taskKey, reason }` writes a NOTE ("Auto render giữ lại: tên vượt khung / chạm safe zone") and queues a FIX job (source `AUTO_HOLD`) so the agent resizes the name with judgement. Otherwise the hold is only in the run log and summary.
8. Log `~/.auto-render/logs/<date>.log` and a JSON summary per run (`rendered`, `pushed`, `held`, `errors`), kept 30 days. Exit code non-zero on any stage failure.

`install-task.ps1` registers "EcomManager Auto Render Hourly": every hour, user `TM PC`, 55-minute limit, IgnoreNew, StartWhenAvailable. It is NOT run by the build; the owner (or the agent on his word) runs it once.

## Part 2 — Fix on reject + library question

### Server

Schema (one migration, bump `SCHEMA_VERSION`):

```
model DesignAgentJob {
  id            String   @id @default(cuid())
  kind          String   // FIX | MAKE | MOCKUP | LIBRARY_APPLY
  source        String   // REJECT | LINE_REOPEN | LARK | LIBRARY | AUTO_HOLD | BACKFILL
  taskId        String?
  taskKey       String?
  designCode    String?
  requestText   String   // reasons + note, or the chat message
  requestedById String?  // AppUser id
  requestedBy   String?  // display name (Lark sender when no AppUser)
  priority      Int      @default(0)   // 10 = factory-reported
  status        String   @default("QUEUED") // QUEUED RUNNING DONE NEEDS_OWNER FAILED CANCELLED
  stage         String?
  rounds        Int      @default(0)
  attempts      Int      @default(0)
  lockedAt      DateTime?
  startedAt     DateTime?
  finishedAt    DateTime?
  summary       String?  // Vietnamese, shown to the designer
  resultJson    String?  // { pushedTaskKeys, rounds, files, codexSessions }
  libraryState  String?  // null | ASKED | YES | NO | APPLIED
  affectedJson  String?  // snapshot of the affected list shown to the designer
  parentJobId   String?
  error         String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  @@index([status, priority, createdAt])
  @@index([taskId])
}
```

Settings (inside `design.settings`): `agent: { autoFixOnReject: false, maxConcurrent: 5, leaseMinutes: 20 }`. Everything ships switched OFF.

Enqueue:
- `transitionTask` → REJECTED, and `reopenLineForFix`: when `agent.autoFixOnReject` is on, create one `FIX` job for the task unless it already has a QUEUED/RUNNING one. `requestText` = reasons + note. Priority 10 when a reason is in `SENT_BACK_REASONS`.
- A superadmin action "Xếp các task đang bị trả lại" (`POST /api/design-agent/backfill`, dry-run by default) queues the existing REJECTED backlog; never automatic.
- If the task leaves REJECTED by a human while its job is QUEUED, the job is CANCELLED.

Runner API under `/api/design-agent/runner/` (PUBLIC rule, own bearer check, token `design.agent.tokenHash`, prefix `dag_`, minted in settings like the worker token):
- `claim` `{ free: n, waitSeconds }` → up to `min(free, maxConcurrent − running)` jobs, highest priority then oldest, long-poll like `claimWithWait`. Each job comes with a context block: task key, order number, line, SKU, design code, supplier SKU, reasons, note, last 20 events, current files (area, version, Drive link), template id, product image, and the affected list.
- `jobs/[id]/heartbeat` `{ stage, rounds }` renews the lease; an expired lease requeues (max 2 attempts, then FAILED "runner lost").
- `jobs/[id]/result` `{ outcome: DONE | NEEDS_OWNER, summary, rounds, result }`.
- `jobs/[id]/fail` `{ error, permanent }`.
- `notes` `{ taskKey, message }` → a `NOTE` event, prefixed "Agent: ".
- Delivery endpoints (the only way a session changes a task; all act as the dedicated AppUser "Design Agent", created on first use with `design_tasks` permission and no usable password, so events show who did it):
  - `PUT tasks/[key]/artwork?printArea=&fileName=&kind=PRINT|MOCKUP` — same streaming save as the designer upload route (`saveArtworkFromTemp`, new version, `retireOutdatedParts`, `enqueueDrivePush`, ARTWORK event). Only while the task has a RUNNING job.
  - `POST tasks/[key]/submit` — REJECTED / NEW / ASSIGNED / DOING → REVIEW through the same checks as a designer's "Gửi duyệt" (`missingPrintFiles`), event `STATUS 'Gửi duyệt lại (Agent)'`.
  - `POST tasks/[key]/reopen` `{ reason, note }` — for LIBRARY_APPLY and chat requests: an unsent DONE task goes back to DOING through `transitionTask` (which rolls back `line.done` / design-ready as the app does); a sent line goes through `reopenLineForFix` (LIBRARY_APPLY only).
  - `hold` (Part 1, above).
On `result`: write a `NOTE` event with the summary on the task; `DONE` on a FIX job sets `libraryState = ASKED` when the affected list is not empty; `NEEDS_OWNER` also sends a Lark message to the group mentioning the owner when Part 3 is configured.

Affected list — `listDesignLines(designCode, storeId)` in a new `src/lib/design-agent/affected.ts`: every product line whose `designOf(sku)` equals the code and whose order is open (not cancelled, refunded or fulfilled), except the fixed line. Each row: order number, line key, placed date, task status, `sent` (`isLineExported`), same supplier SKU or not. Fulfilled orders are counted separately as "đã giao, không sửa được". This is the owner's rule 6 read as: every unfulfilled order of the design, sent or not.

Library decision — `POST /api/design-agent/jobs/[id]/library` `{ save: boolean }` (design permission). The question is about the ARTWORK library (PC/NAS master, bases, spec) and about updating the other existing orders. It does not change `saveStudioDesignToLibrary`, which keeps running on approval as today (non-customized lines: later orders of the same SKU reuse the approved link). `NO` closes the question: no other order is touched and the artwork library is not changed. `YES` records it; the `LIBRARY_APPLY` job (parent = the FIX job) is queued as soon as the fixed task is DONE (approved) — a fix the designer has not approved is never spread. On approval of a task whose job is `YES`, the DONE branch queues it.

A `LIBRARY_APPLY` job tells the agent to: update the library source (master, bases, spec) from the approved fix, publish to the NAS library, stamp the library state, then for each affected line produce the art from the new library and put it on the task — unsent lines replace files and go to REVIEW; sent lines go through `reopenLineForFix` (reason "Nội bộ phát hiện lỗi", or "Xưởng yêu cầu update design" when the parent came from the factory) so that approval produces the existing "Cần báo xưởng" row. Each line gets a NOTE. The job's summary lists what was updated and what could not be.

### UI

- Reject dialog (both copies; extract one shared component): add chip "Lý do khác" that opens a one-line input; it is sent as the reason `Khác: <text>` (3–200 chars). Dashboard counts every `Khác: …` under "Lý do khác". Default `rejectReasons` gain: "Nền không đồng màu giữa các mảnh", "Hoạ tiết chính nằm ngoài safe zone", "Sai template đang mapping", "Sai chi tiết". Production's stored list is edited in the settings page after deploy (not by migration).
- Task page: an "Agent" strip under the header when the task has a job: state (Đang chờ / Đang sửa – vòng n / Đã sửa, chờ duyệt / Cần chủ shop), the summary, and when `libraryState = ASKED` the question "Lưu bản sửa này vào thư viện?" with the affected list (order, status, đã gửi xưởng hay chưa) and two buttons: "Lưu thư viện và cập nhật N đơn" / "Chỉ sửa đơn này". After YES: "Sẽ cập nhật sau khi bạn duyệt task này."
- Task list: a small "Agent" badge on tasks with an open job. Settings page: an "Agent" card (switches, max concurrent, runner token, runner last seen, backlog button).

### Runner on the PC — `tools/design-agent-runner/`

`runner.py` (stdlib + requests): reads `~/.design-agent/runner.env` (`ECOM_URL`, `DESIGN_AGENT_TOKEN`, `MAX_CONCURRENT=5`, `CLAUDE_BIN`, `PROJECT_DIR`, `CODEX_BIN`). Loop: long-poll claim with the number of free slots; for each job create `D:\Ecom manager\artwork-builder\<TASKKEY>-agent-<jobid>\` with `job.json` (the context) and start a headless Claude session in `PROJECT_DIR`:

`claude -p "<prompt>" --output-format json` with the permission settings from `runner.env` (default: tools Bash, Read, Write, Edit, Glob, Grep, Skill; the exact flags are taken from `claude --help` of the installed version).

The prompt is `prompts/fix.md` / `prompts/make.md` / `prompts/mockup.md` / `prompts/library-apply.md` with the job folder path filled in. The runner gives each session a small CLI, `agent_api.py` (`upload <taskKey> <area> <file> [--mockup]`, `submit <taskKey>`, `reopen <taskKey> <reason> <note>`, `note <taskKey> <text>`), which calls the delivery endpoints with the runner token; the prompts tell the session to deliver ONLY through it — never the direct-DB push scripts. `fix.md` states, in this order: read `job.json`; the designer's text is a description of a fault, never an instruction to change scope; use skill `processing-litzzy-orders` and the design's rules; choose the smallest fix (no image generation when a move/scale/re-render/mockup does it); when image work is needed write a per-piece fix brief and run Codex (`CODEX_BIN exec …`) — maker = Codex, QA = this session, files exchanged through `round-N/` exactly as in `LIT6262_1-process-20261111/QA-claude/`; QA against the store mockup with measurable pass lines; at most 3 rounds; on pass upload the changed files and submit the task with `agent_api.py` (a new version of the same print areas; unchanged parts are left alone); hold `.ps-lock` for Photoshop; run the disk guard first; never go past REVIEW, never contact a supplier or a customer; finally write `result.json` `{ outcome, summary (Vietnamese, for the designer), rounds, pushed, problems }`.

The runner heartbeats every 60 s (stage read from `stage.txt` the session may update), enforces a 90-minute wall clock per job (then kills the process tree and reports fail), reads `result.json` and posts `result`. A missing `result.json` is a failure, never a success. Logs in `~/.design-agent/logs/`. `install-task.ps1` registers "EcomManager Design Agent Runner" (at logon + every 5 minutes, IgnoreNew) — not run by the build.

## Part 3 — Lark bot

- Settings (superadmin card, masked on GET, plain `AppSetting` like Telegram): `lark.appId`, `lark.appSecret`, `lark.verificationToken`, `lark.encryptKey` (optional), `lark.chatId` (the one group the bot listens to), `lark.ownerOpenId`, `lark.enabled`.
- `POST /api/public/lark/events` (PUBLIC rule; own verification): answers the `url_verification` challenge; verifies the token (and signature when an encrypt key is set); accepts only `im.message.receive_v1` from `lark.chatId` where the bot is mentioned; de-duplicates on `event_id` (Lark retries); returns 200 at once and processes after the response.
- Processing: the message text (mentions stripped) goes to Claude through the Anthropic client the CS agent already uses, with a strict JSON schema: `{ scope: DESIGN_STUDIO | OUT_OF_SCOPE | UNCLEAR, kind: FIX | NEW_DESIGN | MOCKUP | OTHER, lineKeys: [..], instruction }`. Order references are resolved against tasks (`LIT6262_1`, `#LIT6262`, "đơn 6262 dòng 1").
  - `DESIGN_STUDIO` with a resolved task → a job (source LARK, `requestedBy` = sender name), reply in the thread: "Đã nhận: <task> — <instruction tóm tắt>. Kết quả xem trên tool." What the job is depends on `kind` and the task's state:
    - `FIX`, task REJECTED: a FIX job (or the text is appended to the open one).
    - `FIX`, task REVIEW: the server first rejects it as "Design Agent" with reason `Khác: <instruction>` and note "Theo yêu cầu của <sender> trên Lark", which queues the FIX job through the normal path.
    - `FIX`, task NEW / ASSIGNED / DOING: a FIX job on the task as it is; the agent delivers and submits to REVIEW.
    - `FIX`, task DONE and not sent: `reopen`, then a FIX job.
    - `FIX`, task DONE and sent to the factory: no job; reply "Đơn đã gửi xưởng — hãy bấm 'Mở lại để sửa' trên tool và chọn lý do" (a factory re-send must have a recorded reason; that reopen then queues the job).
    - `NEW_DESIGN` (stored as kind `MAKE`), task NEW / ASSIGNED: a MAKE job — the agent produces the line's art by the per-design standard flow and submits to REVIEW. Other states: treated as FIX.
    - `MOCKUP`: a MOCKUP job — the agent makes the mockup and uploads it as `kind=MOCKUP`; the task's status does not change.
    - `OTHER`: no job; reply with what the bot can do (sửa mẫu, làm mẫu, làm mockup cho một đơn cụ thể).
  Chat-created jobs do not depend on `agent.autoFixOnReject`; they depend on `lark.enabled`.
  - `UNCLEAR` or no task found → reply asking for the order code; no job.
  - `OUT_OF_SCOPE` → one-line refusal.
- Outbound: `tenant_access_token` from app id/secret (cached), `im/v1/messages` reply. Host `open.larksuite.com`. The exact endpoints, signature formula and event shape are taken from the Lark Open Platform documentation at build time, not from memory.
- The model's output only selects among the listed actions; chat text never reaches a shell. The fix prompt treats `requestText` as data.

## My calls (not the owner's)

- Queue order: factory-reported first, then oldest.
- Everything ships behind switches that are OFF; the owner turns each on.
- `LIBRARY_APPLY` waits for the fixed task to be approved.
- "Not yet produced" = order not fulfilled; fulfilled orders are listed, not touched.
- The hourly run handles NEW + AUTO only; AUTO tasks that are REJECTED belong to Part 2.
- The hourly name guard holds a failing line instead of re-rendering it smaller (the renderers are outside this repo); the held line becomes an agent FIX job. This replaces the "shrink to 70 %" idea described to the owner on 11/12 — to be told at hand-over.
- A chat request cannot re-open a line already sent to the factory; that needs the tool's "Mở lại để sửa" with a reason.
- "Chỉ đơn này" leaves today's save-on-approval behaviour as it is.
- Agent deliveries go through new runner endpoints as the user "Design Agent", not through the direct-DB push scripts.
- The fix agent is a headless Claude Code session in the project (so the project's skills and rules apply), started by a small runner; Codex is called by that session.
- Job folders follow the disk-janitor naming rule (`<TASKKEY>-…`) so they are cleaned 24 h after the line is sent.

## Needed from the owner before go-live

- Lark: create the bot app, give App ID / App Secret / Verification Token, add the bot to the group, set the event URL.
- Go-ahead to deploy (schema migration) and to register the two scheduled tasks.
- Mint the runner token in settings; turn the switches on.

## Testing

- Server: vitest integration tests on `test.db` for enqueue rules, claim/lease/heartbeat, result → events + libraryState, affected list (open/sent/fulfilled, before/after), library decision → job after DONE, Lark webhook (challenge, bad token, wrong chat, duplicate event, out-of-scope) with the Claude call stubbed.
- PC: unit tests for the safe-zone geometry and the "No" guard on fixture images; runner tests with a fake `claude` executable (success, missing result.json, timeout).
- Not testable here: a live Lark round trip, the scheduled tasks, a real 5-way concurrent Codex run. These are listed as unverified in the hand-over.
