# Designer Agent — follow-ups and decisions (2026-11-12)

Branch `feat/designer-agent` at 44b310c. Spec: `docs/superpowers/specs/2026-11-12-designer-agent-design.md`. Everything ships with the switches off.

## Not verified by a real run

- nginx / proxy body limit for `PUT /api/design-agent/runner/tasks/*/artwork` on the VPS (print files are 15–30 MB): upload one real file in the first supervised run.
- A real headless `claude -p` session started by the runner (permission mode, Skill tool in print mode, ~12 KB prompt on the Windows command line), Codex rounds started by that session, five sessions at once.
- The two scheduled tasks (`install-task.ps1` was only run with `-PrintOnly`); whether Task Scheduler's 55-minute stop kills a `next dev` the hourly run started.
- A real hourly run: `process-new-orders`, push scripts, ledgers, name guards on real CMYK files, Photoshop-rule renders (cannot be diffed: pushed with the warning).
- A live Lark round trip (URL verification, @mention, reply, owner mention, test message); a real Claude call for the intent schema.
- Browser: Agent badge in the task list, token mint card, backfill button, Lark card buttons.

## Go-live order

1. Deploy: `prisma migrate deploy` BEFORE the new build serves (task list and task page query `DesignAgentJob`).
2. Settings → add the four new reject reasons (production stores its own list).
3. Mint the runner token; write `%USERPROFILE%\.design-agent\runner.env`; run the runner once by hand on one rejected task with the switch on; check the upload.
4. Register the runner task; then the hourly task (`--dry-run` first).
5. Lark: create the bot app, scopes `im:message.group_at_msg:readonly`, `im:message:send_as_bot`, optional `contact:user.base:readonly`; subscribe `im.message.receive_v1`; set an Encrypt Key; fill the Lark card; send the test message; enable.

## Deferred minor findings (from the task reviews)

- 4 more in review.md
- 5 more in review.md
- 8 more in review.md
- AgentSettingsCard repeats reload(); number inputs send 0 for an empty field
- AgentStrip under VerdictStrip has no rounding — visual check
- RejectDialog loses a typed note on Huỷ / click-outside (before: kept until a successful submit)
- RejectDialog shows the 3-200 error as soon as the chip is toggled; Enter in the "Lý do khác" input submits at once
- __enter__ unpacks lock_identity() without a None check (stat failing right after mkdir)
- a FAILED LIBRARY_APPLY job can never be re-queued (any job with parentJobId blocks it)
- a FIX job on an order that closes mid-flight gets 409 from reopen for non-DONE tasks
- a failed process-new-orders leaves its ~180 MB snapshot behind every hour
- a next dev that never comes up is left running; detached next dev may be killed by Task Scheduler at the 55-minute stop (check on the PC or CREATE_BREAKAWAY_FROM_JOB)
- a refused /result posts no /fail, the job waits for the 20-minute lease and reruns
- affected.ts no bound on orders loaded; findLineByKey not store-scoped
- backfill re-queues tasks whose last job ended NEEDS_OWNER/FAILED on every run (per brief)
- completeAgentJob checks only status RUNNING — a stale /result arriving after a lease expiry and a re-claim would be accepted for the new attempt (needs attempt number in the result call)
- design-settings.ts default agent object returned by reference
- enqueueAfterMove turns an AgentJobError into the generic reply, losing its message
- file download also serves removed/superseded artwork versions
- fulfilled order whose task stays REJECTED keeps a claimable job
- if enqueueFixOnReject throws, the NEEDS_OWNER owner notice is never sent (runner.ts:122 not reached)
- jobs.ts appended line starts with ": " when requestedBy is null
- jobs.ts open-job check + create not atomic (two concurrent enqueues -> two open jobs)
- lease-expired "runner lost" writes no task note
- no MAKE / MOCKUP-RUNNING case in agentStripState tests
- no test for delivery to a task listed by a running LIBRARY_APPLY job, oversize body, odd fileName
- no timestamp window on events — replay refused only by LarkEvent rows never being pruned
- settings GET scans all REJECTED tasks on every call
- submit guard + agentSubmit not atomic; decideLibrary flips state before writing the note
- syncDesignTasks writes CANCELLED directly, a QUEUED job stays until the next claim cancels it
- tests — one depends on previous test's state, console.error in output, loose cleanup of global design.settings key
- three test_serve tests need 30 GB free on the temp drive
- truncated resultJson is invalid JSON (plan-mandated cut)
- two simultaneous claims can exceed maxConcurrent; LIBRARY_APPLY target tasks not marked busy
- types.ts duplicates agent types from jobs.ts / affected.ts
- upload guard answers 409 for an unknown task (should be 404)

## Decisions the coordinator made while executing (rulings)

- PC-tool plans (runner, hourly) run in parallel with this plan because they touch only tools/design-agent-runner and tools/auto-render-hourly and do not commit; the controller commits their folders — costs: none expected; a git index lock is avoided by them not using git.
- fix Important 1 against the plan's test text — a job the server no longer holds must not start a session; the test is changed so the 409 comes after the first beat and a new test covers 409-on-first-beat — the spec's lease semantics are the authority — costs if wrong: none visible, a lost job simply is not started.
- fix Important 2 beyond the brief's recovery rule — store the lock folder identity (st_ino + st_ctime_ns) in the marker and remove only on a match — "never break someone else's lock" is the spec's binding line — costs if wrong: a stale lock of our own that fails the identity check stays and needs a manual rmdir (run exits with a clear message).
- group D handed to a fresh sonnet implementer (a0c2aa133158a2f9c) instead of waiting for the opus limit to reset at 18:00 — the owner asked to continue — costs: none expected; the items are small and listed.
- one fix wave covering I-1..I-3, the two RejectDialog regressions (always-on UI), and the code-level before-switch-on minors of final-review.md; I-4, the browser check of badge / token mint / backfill and the Task Scheduler behaviour are hand-over items for the supervised first run — they need the VPS or the real PC schedule — costs: none in code; they stay unverified until that run.
- one implementer for all six tasks, one review — same batching ruling as the server plan.
- one implementer for the whole plan, no git by the implementer (controller commits), runs in parallel with the server plan — separate folder under tools/ — costs: one review for all tasks.
- one small extra fix dispatch for the hold note (server-side dedupe in agentHold: skip the note when the task's latest NOTE already carries the same message) although the skill allows only one fix wave — the breakage was introduced by the wave itself and would spam designers' task history from the first hourly run — costs if wrong: one more small diff without a full re-review; covered by its own test.
- preflight scan limited to the Interfaces blocks' names (planner ran the plan's own self-review); cross-task conflicts are left to the batch reviews — costs: a plan conflict surfaces one batch later than it could have.
- tasks are dispatched in four batches (1-4, 5-8, 9-11, 12-14), one implementer and one reviewer per batch, one commit per task inside a batch — 14 tasks x 2 seats sequential would take most of a day; the owner asked for the whole of parts 2-3 and a report at the end — costs: a reviewer sees 3-4 tasks at once, so a defect in an early task of a batch can be built on before review.
- the Task 5-8 implementer runs while Task 1-4 is under review — the review is read-only and its findings go to a fix dispatch after Task 5-8 lands — costs: Task 5-8 may build on a Task 1-4 defect and need a follow-up fix.
