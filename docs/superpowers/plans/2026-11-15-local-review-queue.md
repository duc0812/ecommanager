# Local Review Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lines finished on the local PC wait in a local review queue with instant previews; the owner approves (delivered to prod as Đã duyệt), rejects, or sends them to Claude/Codex to fix; lines nobody touches for 3 hours go to the cloud as today.

**Architecture:** A SQLite queue plus per-version file folders under `D:\Ecom manager\review-queue`. The push CLIs (`--via api --to-queue`) and the hourly auto render (`PUSH_VIA=queue`) enqueue instead of delivering. A small Node HTTP server on 127.0.0.1:3020 serves the review page and runs actions through the existing `runApiDelivery`. A tick task delivers expired items. Prod gains `approve` on `commit` (guarded by its own token) and a `note` route.

**Tech Stack:** Node ESM `.mjs` (`@libsql/client`, `sharp`, `node:http`), vitest; Python 3.12 (auto render); Next.js 14 + Prisma (server part).

**Spec:** `docs/superpowers/specs/2026-11-15-local-review-queue-design.md` (owner approved 2026-11-15). Builds on `docs/superpowers/specs/2026-11-15-artwork-delivery-api-design.md`.

## Global Constraints

- Work on branch `feat/local-review-queue` in a new worktree `D:\Ecom manager\wt-review-queue` cut from `origin/main` (5a08234 or newer). Same worktree setup as `wt-delivery-api` (node_modules junction, own `.env` with a private DB path, `.env.local` `DISABLE_SCHEDULERS=1`, `npx prisma generate`).
- Queue root `D:\Ecom manager\review-queue` (env `REVIEW_QUEUE_ROOT` overrides; tests always use a temp dir). DB `queue.db`; files `items\<itemId>\v<n>\`; jobs `items\<itemId>\jobs\<n>\`.
- Server listens on `127.0.0.1:3020` only (env `REVIEW_QUEUE_PORT`).
- Countdown 3 hours (`10_800_000` ms) from the current version's `enteredAt`. Rejected, fixing, qa_failed and needs_look items do not count down.
- Tick every 10 minutes. Agent job limit 60 minutes, one job at a time.
- Previews JPEG, longest side 1600 px, quality 85.
- Approve token: header `X-Delivery-Approve`, hash in `AppSetting delivery.approveTokenHash` (same hashing as the worker token, `verifyBearerHash`-style), approver user id in `AppSetting delivery.localApprover`. Local token file `%USERPROFILE%\.review-queue\approve.env` (`DELIVERY_APPROVE_TOKEN=…`). Never logged.
- Prod note text: `Đang chờ chủ shop duyệt ở máy local (tối đa 3 giờ)`. Approve event text: `Duyệt ở máy local`.
- Item statuses: `waiting`, `rejected`, `fixing`, `qa_failed`, `needs_look`, `approved` (delivered DONE), `cloud` (delivered REVIEW), `held` (sent to /hold), `removed`.
- The live push CLIs in `D:\Ecom manager\ecommanager-claude-ecommerce-cashflow-tool-XsLzh\.claude\worktrees\peaceful-villani-d3d860\scripts\` are edited additively only (dynamic `import()` inside the new branch), never committed there. The scheduled auto render copy `D:\Ecom manager\wt-designer-agent\tools\auto-render-hourly\auto_render.py` is edited in place only outside :00–:25 and when no auto_render process runs.
- No network or SSH in tests; Drive and the server are fakes.
- Vietnamese UI copy; dates shown MM/DD/YYYY (en-US).

## Review Focus

1. Approve pressed twice fast, or approve while the tick fires on the same item → exactly one delivery (lock + ledger). Test in Task 4.
2. PC off for 6 hours → the first tick delivers every expired waiting item once, and qa_failed items go to /hold, not to REVIEW. Test in Task 4.
3. Agent writes files outside `out\` or nothing at all → no new version, item shows "agent không sửa được", original files untouched. Test in Task 5.
4. Hourly run re-renders a queued line with byte-identical output → no new version, clock unchanged; different output on a rejected item → new version, status waiting, clock restarts. Test in Task 3.
5. Approve on a line prod changed meanwhile (stale) → nothing uploaded, item moves to needs_look with the reason. Test in Task 4.

---

### Task 1: Prod — `approve` on commit, approve token, note route

**Files:**
- Modify: `src/lib/delivery/types.ts`, `src/lib/delivery/commit.ts`, `src/app/api/design-studio/worker/delivery/tasks/[key]/commit/route.ts`
- Create: `src/lib/delivery/approve.ts`, `src/app/api/design-studio/worker/delivery/tasks/[key]/note/route.ts`
- Test: `tests/delivery-approve.integration.test.ts`

**Interfaces:**
- Produces: `CommitInput.approve?: boolean`; `verifyApproveToken(header: string | null): Promise<boolean>` (hash in `delivery.approveTokenHash`); `approveDelivered(taskKey: string): Promise<{ approved: boolean; warning?: string }>` using `transitionTask(key, actor, { to: 'DONE' })` with `actor` loaded from `delivery.localApprover`; event `Duyệt ở máy local`. `POST …/note` body `{ message }` → SYSTEM DesignTaskEvent, 200 `{ ok: true }`; refuses messages over 500 chars.
- Rules (spec 7.4, 12.3): `approve` only with `push`/`replace`; without a valid `X-Delivery-Approve` → 403 `approve_token`; no/invalid `localApprover` or the user cannot approve → 409 `approve_not_allowed` and nothing written (check before writing). After the write: task REVIEW → approve; task kept NEW (missing parts) → no approve, warning `Không duyệt được: thiếu phần`; app refuses → warning `Không duyệt được: <reason>`. An `alreadyApplied` commit with `approve` approves when the task is REVIEW. `replace` on DONE ignores approve. `dryRun` + `approve` reports `wouldApprove: boolean` without writing.

- [ ] **Step 1: Write failing tests** for every rule above (fixtures as in `tests/delivery-commit-replace.integration.test.ts`; a leader user as `localApprover`; mint the approve token in the test and store its hash). Assert DONE + `Duyệt ở máy local` event + actor id; 403/409 write nothing; NEW-with-missing → warning, status NEW; alreadyApplied + approve → DONE; note route writes one SYSTEM event and requires the worker token + switch like the other routes.
- [ ] **Step 2: Run** `npx vitest run tests/delivery-approve.integration.test.ts` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new file plus `tests/delivery-*.test.ts` — PASS; `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat(delivery): approve on commit with its own token, note route`.

### Task 2: Queue store

**Files:**
- Create: `scripts/review-queue/store.mjs`
- Test: `tests/review-queue-store.test.ts`

**Interfaces:**
- Produces `openQueue({ root }) → Queue` with:
  - `addOrUpdate({ taskKey, groupKey, kind: 'line'|'group', apiLines, files: [{ part, kind, path, sha256 }], meta, qa: { verdict: 'pass'|'fail'|'unchecked', items: string[] } }) → { itemId, version, created: boolean, changed: boolean }` — one active item per `groupKey` (= taskKey for single lines); same sha256 set → `changed:false`, nothing else changes; different → new version, status `waiting` (or `qa_failed` when `qa.verdict==='fail'`), `enteredAt=now`.
  - `get(itemId)`, `list({ statuses })`, `setStatus(itemId, status, { reason })`, `addEvent(itemId, type, message)`, `versions(itemId)`, `expired(now) → items` (waiting/qa_failed with `enteredAt + 3h <= now`), `activeByTaskKey(taskKey)`.
  - `withLock(itemId, fn)` — process-safe lock (a row with owner pid + timestamp, taken in one transaction; stale after 15 min or dead pid).
- Schema: tables `items`, `versions`, `events`, `locks`; times as ISO strings; `now` injectable.

- [ ] **Step 1: Failing tests:** create; same files → `changed:false`; new sha → v2 + clock reset; rejected item + new version → waiting; qa fail → qa_failed; `expired` honours the statuses in Global Constraints; `withLock` refuses a second holder and recovers a stale one.
- [ ] **Step 2: Run** — FAIL. **Step 3: Implement.** **Step 4: Run** — PASS. **Step 5: Commit** `feat(review-queue): SQLite queue store`.

### Task 3: Intake — enqueue from the push CLIs

**Files:**
- Create: `scripts/review-queue/intake.mjs`
- Modify (live, additive): `…/peaceful-villani-d3d860/scripts/push-local-renders.mjs`, `push-shared-prints.mjs` (flag `--to-queue`, only with `--via api`)
- Test: `tests/review-queue-intake.test.ts`

**Interfaces:**
- Consumes: `planLinesToApi` (lines incl. `expectedStatus`, `planIds`, `retire`, `files[].path`), Task 2 store, `createDeliveryClient().note` (add `note(key, message)` to the client in this task, POST to Task 1's route).
- Produces: `enqueuePlan({ plan, apiLines, queue, storageRoot, snapshot, qaByKey = {}, client, previewer = makePreview }) → { enqueued: string[], unchanged: string[], bypassed: string[] }`.
- Rules (spec 7.2, 12.1, 12.2, 12.4): copy every file with a local `path` into `v<n>\<part><ext>`; preview per file into `v<n>\preview\<part>.jpg`; a group whose lines carry only `shortcutOf`/`knownDriveFileId` and no local file → `bypassed` (delivered by the caller as today); a group with a new upload → one `group` item holding all its api lines; `meta` = product title, variant, custom fields (from the snapshot `OrderLine.customization`/properties the plan already reads), customer preview path (`_pers` / Customall preview if present in the plan), store mockup path if present; on first enqueue call `client.note(key, 'Đang chờ chủ shop duyệt ở máy local (tối đa 3 giờ)')` (failure logged, not fatal).
- CLI: with `--to-queue`, after `planLinesToApi`, call `enqueuePlan`, print one line per key (`vào hàng chờ` / `không đổi` / `giao thẳng`), deliver the `bypassed` lines with the existing `runApiDelivery` path.

- [ ] **Step 1: Failing tests** (fake store root, fake client, fake previewer): single line enqueued with files + previews + meta + one note call; re-run identical → `unchanged`, no second note; reuse-only group → `bypassed`; group with upload → one group item; missing local file for a non-shortcut part → line refused with a clear reason. *(Review Focus 4)*
- [ ] **Step 2–4:** run FAIL → implement → PASS; `node --check` both live CLIs; smoke `--via api --to-queue --line NONEXISTENT_KEY` prints "0 dòng" with no network.
- [ ] **Step 5: Commit** (wt-review-queue only) `feat(review-queue): intake from the push CLIs`.

### Task 4: Actions and the 3-hour tick

**Files:**
- Create: `scripts/review-queue/actions.mjs`, `scripts/review-queue/tick.mjs`
- Modify: `scripts/lib/delivery-client.mjs` (optional `approveToken`: sends `X-Delivery-Approve` on commits whose body has `approve: true`), `scripts/lib/api-delivery.mjs` (pass a line's `approve` into the commit body; `dryRun` result carries `wouldApprove`)
- Test: `tests/review-queue-actions.test.ts`

**Interfaces:**
- Produces: `approveItem(queue, itemId, deps)`, `rejectItem(queue, itemId, reason)`, `sendToCloud(queue, itemId, deps)`, `removeItem(queue, itemId)`, `tickQueue(queue, deps, now)`; `deps = { client, uploader, ledgerPath, log, hold }` where `hold(taskKey, reason)` reports /hold like auto render's `_hold_phase` (port its HTTP call: `POST /api/design-agent/runner/hold` with `DESIGN_AGENT_TOKEN`).
- Rules: approve = under `withLock`: dryRun with `approve:true` → if not ok or `wouldApprove:false` → status `needs_look` (stale/wrong state) or stay `waiting` with the error event, nothing uploaded → else real `runApiDelivery` with `approve:true` → `approved` (or `cloud` with the warning when the server could not approve). `qa_failed` items refuse approve unless `{ force: true }`. Reject → `rejected` + reason. Tick: expired `waiting` → `sendToCloud` (REVIEW); expired `qa_failed` → `hold` + status `held`; stale on delivery → `needs_look`. All deliveries share `ledgerPath` (the push CLI's `api-ledger.json` for that source) so nothing is sent twice. Tick entry: `node scripts/review-queue/tick.mjs` reads env from `%USERPROFILE%\.artwork-worker\prod.env`, `%USERPROFILE%\.review-queue\approve.env`, `%USERPROFILE%\.auto-render\config.env` (`DESIGN_AGENT_TOKEN`).

- [ ] **Step 1: Failing tests** (fake server state like `tests/api-delivery.test.ts`): approve happy path → DONE + approved; approve stale → needs_look, zero uploads *(RF 5)*; double approve / approve during tick → one delivery *(RF 1)*; qa_failed approve refused without force; tick after 6 h → every expired waiting item delivered once, qa_failed → held via `hold`, rejected/fixing untouched *(RF 2)*; approve token header sent only on approve commits.
- [ ] **Step 2–4:** FAIL → implement → PASS (also re-run `tests/api-delivery.test.ts`, `tests/delivery-client.test.ts`).
- [ ] **Step 5: Commit** `feat(review-queue): approve, reject, cloud fallback and tick`.

### Task 5: Agent fix jobs

**Files:**
- Create: `scripts/review-queue/fix-job.mjs`
- Test: `tests/review-queue-fix-job.test.ts`

**Interfaces:**
- Produces: `startFix(queue, itemId, { agent: 'claude'|'codex', reason }, deps) → jobId`; `runFixJob(queue, jobId, deps)`; `deps = { spawn, codexExe, claudeExe, qaItem, now }` (`spawn` injectable; real one uses `child_process.spawn` with a clean env: only PATH, SYSTEMROOT, TEMP, USERPROFILE, APPDATA, LOCALAPPDATA).
- Rules (spec 7.5, 6, 13): job dir `items\<id>\jobs\<n>\` with `BRIEF.md` (task, owner's reason, QA items, file list, template/spec paths from `meta`, rules: write only into `out\` using the same part names, do not touch anything outside the job dir), `in\` copies of the current version. Codex: `<codexExe> exec -C <job> --skip-git-repo-check -o <job>\last-message.txt "Đọc BRIEF.md và làm đúng như trong đó."`. Claude: `<claudeExe> -p "<same>" --add-dir <job> --permission-mode dontAsk --output-format json` with cwd = job dir and no MCP config. Status `fixing` while running; one job at a time (a second `startFix` queues it); 60-min kill. On exit: every expected part present in `out\` and nothing written outside the job dir (compare mtimes of `in\` and the item's version dirs) → new version via `addOrUpdate` (QA via `qaItem(versionDir)`; fail → qa_failed); otherwise status back to previous with event `agent không sửa được: <last message, 500 chars>`. Codex path from `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` (newest).

- [ ] **Step 1: Failing tests** with a fake `spawn` that writes `out\` files (success), writes nothing (fail), writes outside (fail), hangs (killed at the limit with fake timers) *(RF 3)*; second job while one runs waits.
- [ ] **Step 2–4:** FAIL → implement → PASS.
- [ ] **Step 5: Commit** `feat(review-queue): Claude/Codex fix jobs`.

### Task 6: Review server and page

**Files:**
- Create: `scripts/review-queue/server.mjs`, `scripts/review-queue/public/index.html`, `public/app.js`, `public/app.css`
- Test: `tests/review-queue-server.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces JSON API: `GET /api/items?status=…`, `GET /api/items/:id`, `GET /files/:id/v/:n/:file` (only paths under the item dir; `..` refused), `POST /api/items/:id/approve` (`{ force? }`), `/reject` (`{ reason }`), `/cloud`, `/remove`, `/fix` (`{ agent, reason }`). Every POST requires header `X-Review-Queue: 1` (same-origin guard) and the server binds 127.0.0.1 only.
- Page (spec 7.3, 13): list with countdown, status chips (Chờ duyệt / Bị trả lại / Agent đang sửa / Lỗi QA / Prod đã thay đổi / Đã duyệt / Lên cloud), detail with previews (click → original), customer preview, store mockup, custom fields, QA items, version history, buttons Duyệt / Trả lại / Gọi Agent sửa (Claude | Codex + lý do) / Cho lên cloud ngay / Bỏ khỏi hàng chờ; "Duyệt dù có lỗi" with a second confirm on qa_failed; keys ←/→, D, T.
- Entry: `node scripts/review-queue/server.mjs` (env as the tick).

- [ ] **Step 1: Failing tests** against the handler (start on port 0): list/detail shapes, file route refuses `..`, POST without `X-Review-Queue` → 403, approve calls `approveItem` once.
- [ ] **Step 2–4:** FAIL → implement → PASS; open the page once in the browser pane against a temp queue with two fake items and take a screenshot for the report.
- [ ] **Step 5: Commit** `feat(review-queue): local review page`.

### Task 7: Auto render `PUSH_VIA=queue` and `--qa-item`

**Files:**
- Modify: `tools/auto-render-hourly/auto_render.py`, `README.md` (main copy in the worktree; same edit to the scheduled copy under the Global Constraints rule)
- Test: `tools/auto-render-hourly/tests/test_push_queue.py`

**Interfaces:**
- Produces: `PUSH_VIA=queue` → passing lines go through the CLIs with `--via api --to-queue`; lines whose guard is `ERROR`/`FAIL` (today sent to `/hold`) also go to the queue with their reasons as QA items (`--qa-json <file>` passed to the CLI, mapping taskKey → `{ verdict, items }`; add that option in Task 3's CLI edit as part of this task); lines already in the queue (`activeByTaskKey`) are skipped before rendering. `python auto_render.py --qa-item <versionDir>` re-runs the same guard for one queued version (inputs saved in `meta.qaInputs` at intake) and prints `{ verdict, items }` JSON.
- [ ] **Step 1: Failing tests:** queue mode builds the CLI args with `--to-queue` and `--qa-json`; failing lines are not sent to /hold in queue mode; queued keys skipped; `--qa-item` prints pass/fail for a fixture; ssh/api modes unchanged.
- [ ] **Step 2–4:** FAIL → implement → PASS (main copy suite and the scheduled copy's own suite).
- [ ] **Step 5: Commit** `feat(auto-render): PUSH_VIA=queue and --qa-item`.

### Task 8: Install and rollout

**Files:**
- Create: `scripts/review-queue/install-tasks.ps1`, `scripts/review-queue/mint-approve-token.mjs`
- Create: `docs/superpowers/plans/2026-11-15-local-review-queue-rollout.md` (log)

- [ ] **Step 1:** `install-tasks.ps1` registers "EcomManager Review Queue Tick" (every 10 min) and "EcomManager Review Queue Server" (at logon, restart on failure) for the current user; `mint-approve-token.mjs` writes `%USERPROFILE%\.review-queue\approve.env` and prints only the sha256 hash.
- [ ] **Step 2:** Merge to `origin/main` (ff), deploy the server part (no schema change; same deploy steps as 11/15), write `delivery.approveTokenHash` and `delivery.localApprover` (owner's user id) on prod.
- [ ] **Step 3:** Install the tasks; open `http://localhost:3020`; set `PUSH_VIA=queue` in `%USERPROFILE%\.auto-render\config.env`.
- [ ] **Step 4:** Acceptance (spec 9): 3 real lines — one approved (prod DONE, files on Drive, event `Duyệt ở máy local`), one rejected then fixed by Codex and approved, one left 3 hours → REVIEW on prod. Record in the rollout log.
