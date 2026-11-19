# Design Agent Work Board Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The Lark bot and the Design Agent take only work nobody else is doing, answer from real state (including minutes until a local fix reaches the cloud), change a variant's supplier on staff request, and list work nobody holds.

**Architecture:** The runner on the shop PC publishes who holds what (local review queue, stream worklists) to a prod table every 2 minutes. `workStateFor` on prod combines that table with prod facts and gates every job creation; the runner re-checks `queue.db` before starting. New bot intents read the same state.

**Tech Stack:** Next.js 14 route handlers, Prisma v7 + SQLite, zod, vitest; Python 3.12 + requests + pytest for the runner.

**Spec:** `docs/superpowers/specs/2026-11-19-design-agent-work-board-design.md`

## Global Constraints

- All user-facing text is Vietnamese. Dates shown to people are MM/DD/YYYY.
- Server work: worktree `D:\Ecom manager\wt-review-ui`, branch `feat/lark-work-board`. Tests never touch `dev.db`; run with `npx vitest run <paths>`.
- Runner work: new worktree `D:\Ecom manager\wt-runner-board`, branch `feat/runner-work-board`, cut from `feat/designer-agent` (52a9342). Never edit or commit in `D:\Ecom manager\wt-designer-agent`.
- Never add `url` to `datasource db`. `prisma migrate dev` is silent on this PC: build the migration folder from `npx prisma migrate diff` SQL, then `npx prisma generate`. Bump `SCHEMA_VERSION` in `src/lib/db.ts` to `'v96-work-board'`.
- Import prisma from `@/lib/db`; generated types from `@/generated/prisma/client`.
- No comments unless they explain a non-obvious constraint.
- Values: board published every `120` s; board stale after `600_000` ms; stream validity `48` h; queue tick every `10` min; report shows at most `20` keys per group; supplier candidates at most `5`; queue `detail` at most `300` chars; at most `5000` board entries per publish.
- Never print or log tokens.

## Review Focus

1. A queue line past its deadline must say "lượt quét tới", never a zero or negative minute count (Task 3).
2. A queue group item holding several task keys must mark every key busy, not only the lead `taskKey` (Task 5).
3. A same-variant sibling in another order that is exported or has a live print must block the supplier change (Task 4).
4. A stale or never-published board must never produce "chưa ai làm" or a new Lark job (Tasks 2, 3).
5. Text from task events inside a status reply stays data and is cut to length, so a long or instruction-like event cannot change bot behaviour or break the Lark reply (Task 3).

---

### Task 1: Work board storage and publish endpoint

**Files:**
- Modify: `prisma/schema.prisma`, `src/lib/db.ts`
- Create: `prisma/migrations/20261119090000_work_board/migration.sql`
- Create: `src/lib/design-agent/work-board.ts`, `src/app/api/design-agent/runner/board/route.ts`
- Test: `tests/design-agent-work-board.integration.test.ts`

**Interfaces:**
- Produces:
  - Model `WorkBoardEntry { id String @id @default(cuid()); taskKey String; source String; worker String; state String; detail String?; version Int?; etaAt DateTime?; publishedAt DateTime; @@index([taskKey]) }`
  - Model `BotMappingChange { id String @id @default(cuid()); taskKey String; profileKey String; comboJson String; beforeOverridesJson String; afterSupplierProductId String; lineSnapshotJson String; requestedBy String; createdAt DateTime @default(now()); undoneAt DateTime?; @@index([taskKey, createdAt]) }`
  - `type BoardEntryInput = { taskKey: string; source: 'LOCAL_QUEUE' | 'STREAM'; worker: string; state: string; detail?: string | null; version?: number | null; etaAt?: string | null }`
  - `replaceWorkBoard(input: { entries: BoardEntryInput[]; rejectedOwner?: string | null }, now?: Date): Promise<{ count: number }>` replaces all rows in one transaction and stores AppSettings `design.board.publishedAt` (ISO) and `design.board.rejectedOwner`.
  - `readWorkBoard(taskKeys: string[] | null, now?: Date): Promise<{ fresh: boolean; publishedAt: Date | null; rejectedOwner: string | null; entries: WorkBoardEntry[] }>`; `null` reads every row; `fresh` is false when never published or older than `BOARD_STALE_MS = 600_000`.
- Route: `PUT /api/design-agent/runner/board`, guarded by `requireRunner`; 400 `{ error }` when `entries` is not an array, longer than 5000, or a row lacks `taskKey`, a valid `source`, `worker` or `state`.

- [ ] **Step 1: Write failing tests** named `replaces the whole board and records the time`, `reports never-published and 10-minute-old boards as not fresh`, `keeps rejectedOwner`, `refuses a malformed row with 400 and leaves the board unchanged`, `requires the runner token`. Assert exact row counts, `fresh` at 599,999 ms true and 600,001 ms false.
- [ ] **Step 2: Run** `npx vitest run tests/design-agent-work-board.integration.test.ts`. Expected: FAIL, module missing.
- [ ] **Step 3: Add models, migration, `SCHEMA_VERSION`, `work-board.ts`, route.** `/api/design-agent/runner/` is already PUBLIC in `api-access.ts`; do not widen it.
- [ ] **Step 4: Run the test file and** `npx prisma validate`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(design-agent): work board published by the runner`.

### Task 2: One-worker rule in `workStateFor` and job creation

**Files:**
- Create: `src/lib/design-agent/work-state.ts`, `src/app/api/design-agent/runner/jobs/[id]/busy/route.ts`
- Modify: `src/lib/design-agent/jobs.ts`, `src/lib/design-agent/runner.ts`
- Test: `tests/design-agent-work-state.integration.test.ts`

**Interfaces:**
- Consumes: `readWorkBoard`; `agentTaskState`, `AgentTaskState` from `delivery.ts`.
- Produces:
  ```ts
  export type WorkState =
    | { kind: 'CLOSED'; reason: 'CANCELLED' | 'ORDER_CLOSED' | 'ASK_CUSTOMER' | 'SENT' }
    | { kind: 'AGENT'; jobId: string; status: string; stage: string | null; startedAt: Date | null }
    | { kind: 'UNKNOWN' }
    | { kind: 'QUEUE'; state: string; version: number | null; etaAt: Date | null; detail: string | null }
    | { kind: 'STREAM'; worker: string }
    | { kind: 'PERSON'; name: string }
    | { kind: 'AUTO' }
    | { kind: 'FREE'; heldReason: string | null }
  export function workStatesFor(tasks: AgentTaskState[], now?: Date): Promise<Map<string, WorkState>>
  export function workStateFor(task: AgentTaskState, now?: Date): Promise<WorkState>
  export class AgentJobBusy extends AgentJobError { state: WorkState } // status 409
  ```
- Order, first match wins: CLOSED; open agent job; `UNKNOWN` when the board is not fresh; `LOCAL_QUEUE` row with state other than `held`; `STREAM` row, or task `REJECTED` with `rejectedOwner` set (worker = that value); task `ASSIGNED`/`DOING` with an assignee (name from `AppUser`, else "nhân sự được giao"); task `NEW` with readiness `AUTO`; else FREE, carrying the `held` row's detail as `heldReason`.
- `enqueueAgentJob` (all kinds except `LIBRARY_APPLY`): after the existing open-job handling, compute the state. Throw `AgentJobBusy` for QUEUE, STREAM, PERSON, and AUTO. `UNKNOWN` throws only for `source === 'LARK'`. `AUTO` does not block `source === 'AUTO_HOLD'`.
- `enqueueFixOnReject`, `agentHold` and backfill catch `AgentJobBusy`: no job, one task note `Agent không nhận: <worker hoặc trạng thái> đang giữ dòng này`.
- `POST /api/design-agent/runner/jobs/[id]/busy` body `{ worker: string, detail?: string }`: `RUNNING` job becomes `CANCELLED` with `error` `Đã có bên khác làm: <worker>`, writes that as a task note, sends it to the Lark group when Lark is enabled. A failed Lark send does not fail the request. Not a failure and no owner notice.

- [ ] **Step 1: Write failing tests**, one per row of the priority order (`CLOSED beats everything`, `open agent job`, `stale board is UNKNOWN`, `waiting queue row`, `held row is FREE with heldReason`, `stream row`, `REJECTED follows rejectedOwner`, `assignee`, `NEW AUTO`, `FREE`), plus `Lark job refused while queue holds the line`, `AUTO_HOLD allowed on an AUTO line`, `reject path writes a note and creates no job when a stream holds it`, `stale board blocks LARK but not REJECT`, `busy endpoint cancels the job, notes the task, is idempotent`.
- [ ] **Step 2: Run** `npx vitest run tests/design-agent-work-state.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Existing design-agent tests create jobs with no board: `FREE`/non-LARK paths must keep them green. Lark tests that need a job publish a fresh empty board in setup.
- [ ] **Step 4: Run** `npx vitest run tests/design-agent tests/lark tests/design-approve`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(design-agent): one worker per line`.

### Task 3: Bot intents, busy replies, status and unassigned report

**Files:**
- Modify: `src/lib/lark/intent.ts`, `src/lib/lark/process.ts`, `src/lib/lark/replies.ts`
- Create: `src/lib/lark/status.ts`, `src/lib/lark/unassigned.ts`
- Test: `tests/lark-intent.integration.test.ts`, `tests/lark-process.integration.test.ts`, `tests/lark-status.integration.test.ts`

**Interfaces:**
- Consumes: `workStateFor`, `workStatesFor`, `WorkState`, `readWorkBoard`, `agentAddNote`.
- Produces:
  - `LarkIntentSchema.kind` adds `STATUS`, `SUPPLIER_CHANGE`, `SUPPLIER_UNDO`, `UNASSIGNED_REPORT`; adds `supplierName: z.string().max(100)`, `supplierSku: z.string().max(100)` (empty string when absent).
  - `describeWorkState(key: string, state: WorkState, now: Date): string`
  - `larkTaskStatus(task: AgentTaskState, now?: Date): Promise<string>`, at most 1500 chars, each event cut to 120 chars.
  - `larkUnassignedReport(now?: Date): Promise<string>`
- Exact copy for `describeWorkState` (`m` = minutes rounded up):
  - QUEUE waiting with future eta: `{key}: đã có bản sửa v{n} ở hàng duyệt local, khoảng {m} phút nữa tự lên cloud.`
  - QUEUE waiting, eta past: `{key}: đã có bản sửa v{n} ở hàng duyệt local, sẽ lên cloud ở lượt quét tới (tối đa 10 phút).`
  - QUEUE qa_failed: `{key}: bản ở hàng duyệt local đang lỗi QA: {detail}. Sau {m} phút nếu không ai xử lý sẽ bị giữ lại.`
  - QUEUE other: `{key}: đang ở hàng duyệt local, trạng thái {state}{: detail}.`
  - STREAM: `{key}: {worker} đang giữ dòng này.`
  - PERSON: `{key}: {name} đang làm dòng này.`
  - AUTO: `{key}: auto render sẽ xử lý ở lượt hằng giờ.`
  - AGENT: `{key}: Agent đang làm{, bước {stage}}.`
  - UNKNOWN: `{key}: chưa xác định được ai đang giữ vì dữ liệu từ máy local chưa cập nhật. Bot chưa tạo việc.`
- `requestForTask` checks state first. CLOSED keeps today's replies. AGENT keeps today's `enqueueFor` path. QUEUE/STREAM/PERSON/AUTO/UNKNOWN: call `agentAddNote(key, 'Lark – {sender}: {instruction}')` when the instruction is non-empty, reply `describeWorkState` + ` Yêu cầu của bạn đã được ghi vào task.`, and do not reject, reopen or enqueue. FREE with `heldReason` appends ` Dòng này từng bị giữ: {heldReason}` to the accepted reply.
- Intent prompt: a request to change one line's supplier or SKU is `DESIGN_STUDIO`/`SUPPLIER_CHANGE`; "sao rồi", "tới đâu rồi" is `STATUS`; "việc nào chưa có người làm" is `UNASSIGNED_REPORT` with no line keys; revenue, ads, customers remain `OUT_OF_SCOPE`.
- `UNASSIGNED_REPORT` must not require a task ref. Report covers open, unexported tasks in `NEW`/`ASSIGNED`/`DOING`/`REJECTED` whose state is FREE, grouped by the `mappingStates` verdict: `Chưa mapping` (UNMAPPED), `Thiếu template` (NO_TEMPLATE), `Làm tay` (readiness MANUAL/LOW), `Cần làm artwork` (rest). Not fresh: `Chưa có dữ liệu tin cậy từ máy local, chưa báo được việc chưa có người làm.`
- `larkTaskStatus` shows task status, supplier, supplier SKU, template name, live print and mockup counts with the newest file date, `describeWorkState`, last 3 events, and the newest agent job's status, stage and summary. It answers even when the board is stale, and must then use the UNKNOWN sentence.

- [ ] **Step 1: Write failing tests**: `describeWorkState` for each copy line including `eta 30 s ahead shows 1 phút` and `eta past shows lượt quét tới`; `busy line gets the local-fix reply, one note, no job and no status change` for REVIEW and DONE tasks; `status question works without a job`; `status cuts a 5000-char event and ignores instruction-like text`; `report groups and caps at 20 keys with the total`; `report refuses a stale board`; intent schema accepts the new kinds.
- [ ] **Step 2: Run** `npx vitest run tests/lark-status.integration.test.ts tests/lark-process.integration.test.ts tests/lark-intent.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Route `SUPPLIER_CHANGE` and `SUPPLIER_UNDO` to `REPLY_OTHER` in this task; Task 4 replaces that.
- [ ] **Step 4: Run** `npx vitest run tests/lark`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lark): answer from real work state, status and unassigned report`.

### Task 4: Supplier change and undo

**Files:**
- Create: `src/lib/lark/supplier-change.ts`
- Modify: `src/lib/lark/process.ts`, `src/lib/repos/product-profiles.ts` (export a scoped re-evaluation only if needed)
- Test: `tests/lark-supplier-change.integration.test.ts`

**Interfaces:**
- Consumes: `workStatesFor`, `parseProfileOverrides`, `matchesProfileCombo`, `saveProfile` or its store, `syncDesignTasksCounted`, `recalculateMissingOrderLineCosts`, `FROZEN_PIPELINE_STATUSES`.
- Produces:
  - `changeSupplierFromLark(input: { task: AgentTaskState; supplierName: string; supplierSku: string; instruction: string; sender: string }): Promise<{ changed: boolean; reply: string; error?: string }>`
  - `undoSupplierFromLark(input: { task: AgentTaskState; sender: string }): Promise<{ changed: boolean; reply: string }>`
- Group = open lines with the same `storeId`, `shopifyProductId` and identical parsed `variantOptions` as the named line, in orders outside `FROZEN_PIPELINE_STATUSES`. Combo = those `variantOptions`; empty options refuse with a reply, because an empty combo would pin the whole product.
- Refuse, writing nothing, in this order: no supplier name; supplier not exactly one match (case and accent insensitive on name or code); product not exactly one match on SKU, else on `instruction` words, listing up to 5 SKUs; no real template (`SupplierProduct.printTemplateId` or a `PrintTemplate` with the exact `supplierSku`; a null-`supplierSku` template does not count); any group line with `exportedAt`; any group line whose state is not FREE or `UNKNOWN`-free (UNKNOWN refuses too); any group line with a live `PRINT` artwork. Each refusal names the blocking line and reason.
- On success, in one transaction: replace or add the profile override for that combo, create the profile if absent; update `resolvedSupplierId`, `resolvedSupplierSku`, and clear `resolvedBaseCost` on group lines only; insert `BotMappingChange` with prior overrides and each line's prior supplier values. Then recalculate costs and sync design tasks for those orders only, and add a task event `Chuyển xưởng theo yêu cầu của {sender} trên Lark: {old} sang {new} ({sku})`. Reply: `{key}: đã chuyển sang {supplier}, SKU {sku}, template {template}. Đã đổi {n} dòng cùng biến thể.`
- Undo: newest not-undone change of that task. Refuse if any line in its snapshot is now exported or has a live print created after the change. Restore overrides and line values, set `undoneAt`, recalc as above.
- `decide` handles both intents with exactly one resolved task; more than one replies `Mỗi lần chỉ chuyển xưởng một dòng.`

- [ ] **Step 1: Write failing tests**: `changes only the named combo`, `other variant of the product untouched`, `sibling in another order moves too`, `exported sibling refuses and names it`, `sibling with a live print refuses`, `line held by a stream refuses`, `stale board refuses`, `default null-SKU template does not count`, `ambiguous SKU lists at most 5 and writes nothing`, `empty variant options refuses`, `undo restores overrides and lines`, `undo refuses after an export`, `two lines in one message refused`.
- [ ] **Step 2: Run** `npx vitest run tests/lark-supplier-change.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Do not call the product-wide `reevaluateProduct`.
- [ ] **Step 4: Run** `npx vitest run tests/lark tests/design-agent`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(lark): staff change a variant's supplier, with undo`.

### Task 5: Runner publishes the board and re-checks before starting

**Files (worktree `D:\Ecom manager\wt-runner-board`):**
- Create: `tools/design-agent-runner/work_board.py`, `tools/design-agent-runner/tests/test_work_board.py`
- Modify: `tools/design-agent-runner/agent_api.py`, `tools/design-agent-runner/runner.py`, `tools/design-agent-runner/tests/fake_server.py`, `tools/design-agent-runner/README.md`

**Interfaces:**
- Consumes: `PUT /board` body `{ entries, rejectedOwner }`, `POST /jobs/{id}/busy` body `{ worker, detail }` from Tasks 1 and 2.
- Produces:
  - `AgentApi.publish_board(entries: list[dict], rejected_owner: str | None) -> dict`, `AgentApi.busy(job_id: str, worker: str, detail: str) -> dict`
  - `queue_entries(queue_db: Path, countdown_s: int = 3600) -> list[dict]`: opens with `Path.as_uri() + '?mode=ro'`; the newest item per task key among statuses `waiting`, `qa_failed`, `needs_look`, `held`, `rejected`, `fixing`, joined through `item_keys`; `etaAt` = `enteredAt` + countdown for `waiting`/`qa_failed`; `worker` = `Hàng duyệt local`; `detail` from `statusReason` or QA items, cut to 300 chars. Any later non-active newest item for that key excludes the key.
  - `stream_entries(builder_dir: Path, now: float, ttl_s: int = 172800) -> tuple[list[dict], str | None]`: newest `_streams-*` directory; stream table from `README.md`; rows whose first cell matches `^[A-Z]+\d+_\d+$`; `handoff.md` lines `KEY | từ | sang | ...` move a key to the target stream; a stream counts when its list file or any `progress-luong{n}*.md` changed within `ttl_s`; second value is `Luồng {n}` when README assigns all REJECTED lines to a still-valid stream.
  - `local_queue_holder(queue_db: Path, task_key: str) -> dict | None`: the active non-`held` entry for that key.
  - `publish_once(deps) -> bool` and a daemon thread started by `serve` publishing at start and every `BOARD_PUBLISH_S = 120`. A failed `queue.db` read publishes nothing and logs one line. Never raises into `serve`.
- Config: `REVIEW_QUEUE_DB` in `runner.env`, default `D:\Ecom manager\review-queue\queue.db`.
- `serve`'s `start(job)`: before creating the thread, for kinds other than `LIBRARY_APPLY`, call `local_queue_holder`; when it returns an entry, call `api.busy` and skip the job. A failed read does not start the job: call `api.fail(id, 'không đọc được hàng duyệt local', False)`.

- [ ] **Step 1: Create the worktree:** `git -C "D:/Ecom manager/ecommanager-claude-ecommerce-cashflow-tool-XsLzh" worktree add -b feat/runner-work-board "D:/Ecom manager/wt-runner-board" feat/designer-agent`.
- [ ] **Step 2: Write failing tests** with a temp SQLite queue and temp stream folder: `every key of a group item is listed`, `newest item wins`, `cloud item clears the key`, `eta is enteredAt plus one hour`, `database is opened read-only`, `path with spaces works`, `stream rows parsed from markdown`, `handoff moves a key`, `recent progress file keeps an old list valid`, `stream past 48 h is dropped`, `REJECTED owner read from README`, `held entry is published but is not a holder`, `unreadable queue publishes nothing`, `job on a queued line calls busy and never starts`, `unreadable queue fails the job without starting it`.
- [ ] **Step 3: Run** `python -m pytest tools/design-agent-runner/tests/test_work_board.py -q`. Expected: FAIL.
- [ ] **Step 4: Implement,** keeping the `runner.py` change to the import, the config field, the thread start and the check in `start(job)`, so the patch applies on the live file with its uncommitted colour-rule edit.
- [ ] **Step 5: Run** `python -m pytest tools/design-agent-runner/tests -q`. Expected: PASS.
- [ ] **Step 6: Commit** `feat(design-agent-runner): publish the work board and re-check the local queue`.

---

## Rollout (controller, after the final review)

1. Push `feat/lark-work-board`; on the VPS back up `dev.db`, fast-forward, `npx prisma migrate deploy`, `npx prisma generate`, build, `pm2 restart podmanager`.
2. Outside :00 to :25 with no auto render running: copy `work_board.py` and `agent_api.py` changes to `D:\Ecom manager\wt-designer-agent`, apply the `runner.py` hunk with `git apply`, restart the runner task once its running job has ended.
3. Check `design.board.publishedAt` advances, then run the live checks in spec section 5.
4. Update `NOTES.md`, skill `processing-litzzy-orders`, `AGENTS.md`, memory.
