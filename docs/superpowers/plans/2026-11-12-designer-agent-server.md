# Designer Agent — Server and UI (Part 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A reject on Design Studio (or a reopened sent line) becomes a `DesignAgentJob` that a runner on the shop PC claims, works on and delivers back to REVIEW through runner endpoints; the designer then answers the library question on the task page.

**Architecture:** One new table (`DesignAgentJob`) and one folder `src/lib/design-agent/` split so nothing imports in a circle: `jobs.ts` (queue store, no import of `design-tasks.ts`) ← `design-tasks.ts` (hooks) ← `runner.ts` / `delivery.ts` (claim, result, delivery as the "Design Agent" user). Routes under `/api/design-agent/` are thin: the runner ones check their own bearer token (`dag_…`, sha256 in `AppSetting`), the others go through `API_ACCESS_RULES`. The queue copies the `CloneJob` pattern (`src/lib/clone/worker.ts`, `jobs.ts`, `leases.ts`).

**Tech Stack:** Next.js 14.2 app router, Prisma 7 + SQLite (libsql adapter), Vitest integration tests on `test.db`, Tailwind design tokens, material-symbols icons.

**Spec:** `docs/superpowers/specs/2026-11-12-designer-agent-design.md` — sections "Part 2", "My calls", "Testing" and "Interface contract (server ↔ PC tools)". The contract table and the `Job` JSON are fixed: the PC runner is built against them by another plan.

**Not in this plan:** Part 1 (`tools/auto-render-hourly/`), the PC runner (`tools/design-agent-runner/`), Part 3 Lark (`2026-11-12-designer-agent-lark.md`, which consumes the functions marked **(Lark)** below).

## Global Constraints

- Everything ships OFF: `agent.autoFixOnReject` defaults to `false`; no job is created by a reject until a Superadmin turns it on; no runner token exists until one is minted.
- The agent never approves a design (no code path moves a task to DONE as the agent), never creates/cancels a supplier order, never writes a supplier sheet, never messages a supplier or a customer. Everything it delivers stops at REVIEW.
- No direct production DB writes: no script, no SQL by hand. The stored `rejectReasons` on production are edited in the settings page after deploy, not by migration.
- Every new `/api/*` path has a rule in `API_ACCESS_RULES` (`src/lib/api-access.ts`). Runner routes = `PUBLIC` + their own bearer check. Library decision = `['design_tasks']` + task scope. Backfill, agent settings writes and token mint/revoke = `SUPERADMIN` rule AND `requireSuperadmin(req)` (`src/lib/api-auth.ts`).
- Never add `url` to the `datasource db {}` block of `prisma/schema.prisma`. Import Prisma types from `@/generated/prisma/client`, the client from `@/lib/db`.
- On this PC `npx prisma migrate dev` exits silently without creating anything. The migration folder is made by hand: `npx prisma migrate diff --from-config-datasource --to-schema prisma/schema.prisma --script` → save as `prisma/migrations/<UTC yyyymmddHHMMSS>_design_agent_job/migration.sql`, then `npx prisma migrate deploy`, then `npx prisma generate`, then bump `SCHEMA_VERSION` in `src/lib/db.ts` (`'v92-production-edit'` → `'v93-design-agent'`).
- Tests: Vitest integration tests on `test.db` (`npx vitest run tests/<file>`), each file creates and removes its own fixtures with its own id prefix, no network. TDD: failing test first. One commit per task.
- Code style per `CLAUDE.md`: no comments unless a non-obvious constraint, `'use client'` pages and components, Tailwind tokens only (`bg-surface-container-lowest`, `text-on-surface-variant`, …), `material-symbols-outlined` through `Icon` from `src/app/design-studio/components/ui.tsx`.
- All user-facing copy in Vietnamese, exactly as written in this plan. Dates `en-US` `MM/DD/YYYY` (`fmtDate` / `fmtDateTime` from `ui.tsx`).
- Lint each changed file: `npx eslint --no-eslintrc -c .eslintrc.json --ext .ts,.tsx <files>`. Type-check: `npx tsc --noEmit`.
- Secrets never leave the server unmasked: the runner token is returned once at mint, only its sha256 is stored, and no GET, job payload, event or log line carries it (pattern: `tests/secrets-not-returned.integration.test.ts`).
- Job text (`requestText`, `summary`, `error`, `stage`) is data: stored and shown, never executed, never joined into a path or a command.
- Commit messages end with `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.

## Builder's calls (where the design left a choice)

- **Design Agent user:** `AppUser` email `design-agent@ecom-manager.local`, name `Design Agent`, role `SUPPORT`, permissions `["design_tasks"]`, status `INACTIVE`, no password — cannot log in, never listed in "Giao việc".
- **`transitionTask` / `reopenLineForFix` get a 4th argument `opts: { agent?: boolean }`.** With it only DONE → DOING is allowed, the ownership check is skipped, the task's assignee is left alone, and no job is queued by the reopen.
- **"The task has a RUNNING job" means:** a RUNNING job of that task, or a RUNNING `LIBRARY_APPLY` job whose `affectedJson` lists the task key (it has to deliver to the other orders).
- **File download:** the contract has no call for it, the public artwork URL refuses unapproved lines and `/api/design-studio/file` needs a session. Added `GET /api/design-agent/runner/files/{artworkId}`; `files[].url` in a claim is that path (relative to `ECOM_URL`), `files[].driveUrl` carries the Drive link.
- **A DONE result is checked:** a FIX/MAKE job that reports DONE without having submitted the task is stored as `NEEDS_OWNER`. A delivery the designer already rejected again stays DONE, asks no library question and (switch on) queues the next FIX job.
- **Stale queue entries are dropped at claim:** task cancelled or already approved → job `CANCELLED`.
- **FAILED is shown** on the strip as "Agent không chạy được" and also calls the owner notice.
- **`LIBRARY_APPLY` gets the affected list recomputed at claim**, not the snapshot the designer saw.
- **Order-level factory return** (`DESIGN_REJECTED` sync) queues nothing by itself, as in the design; the backfill action picks those tasks up.

## Review Focus

1. **Runner says DONE but the task was never sent to review** (session skipped `submit`): the job must not read "Đã sửa, chờ duyệt"; it becomes `NEEDS_OWNER` with the reason. Test in Task 8.
2. **Order cancelled, fulfilled, or task approved by a person while its job is QUEUED:** the claim hands out nothing for it and marks the job `CANCELLED`. Test in Task 6.
3. **The existing settings page saves without an `agent` field:** the switch and limits must survive that save. Test in Task 1.
4. **Designer rejects the agent's delivery before the runner posts the result:** the reject is not lost — the old job ends DONE without a library question and a new FIX job is queued. Test in Task 8.
5. **Orders of the design change between the library question and the approval** (new order arrives, one gets fulfilled) and a line with an empty design code: the `LIBRARY_APPLY` claim lists the orders as they are then; an empty code never matches every line. Tests in Task 3 and Task 10.

---

### Task 1: `DesignAgentJob` model, migration, `agent{}` settings

**Files:**
- Modify: `prisma/schema.prisma` (append the model), `src/lib/db.ts` (`SCHEMA_VERSION`), `src/lib/design-settings.ts`, `src/app/api/design-studio/settings/route.ts`, `src/app/design-studio/components/types.ts` (`DesignSettings` mirror)
- Create: `prisma/migrations/<UTC yyyymmddHHMMSS>_design_agent_job/migration.sql`
- Test: `tests/design-agent-settings.integration.test.ts`

**Interfaces:**
- Produces: `prisma.designAgentJob` — the model exactly as in the spec ("Schema"), no relation fields, both indexes.
- Produces (`src/lib/design-settings.ts`): `type AgentSettings = { autoFixOnReject: boolean; maxConcurrent: number; leaseMinutes: number }`; `DEFAULT_AGENT_SETTINGS = { autoFixOnReject: false, maxConcurrent: 5, leaseMinutes: 20 }`; `DesignSettings.agent: AgentSettings`; `normalizeAgentSettings(raw: unknown): AgentSettings` (`maxConcurrent` integer clamped to 1–10, `leaseMinutes` integer clamped to 5–120, anything else → default); `saveAgentSettings(patch: Partial<AgentSettings>): Promise<AgentSettings>` (merges into `design.settings`).

- [ ] **Step 1: Write the failing tests**

```ts
it('agent settings default OFF and survive a settings save that does not send them', async () => {
  expect((await getDesignSettings()).agent).toEqual({ autoFixOnReject: false, maxConcurrent: 5, leaseMinutes: 20 })
  await saveAgentSettings({ autoFixOnReject: true, maxConcurrent: 3 })
  const res = await PUT(await superRequest('http://localhost/api/design-studio/settings', { method: 'PUT', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slaCustomHours: 24, slaNonCustomHours: 48, kpiByType: { default: 0.3 }, rejectReasons: ['Sai chi tiết'] }) }))
  expect(res.status).toBe(200)
  expect((await getDesignSettings()).agent).toEqual({ autoFixOnReject: true, maxConcurrent: 3, leaseMinutes: 20 })
})
it('normalizeAgentSettings clamps', () => {
  expect(normalizeAgentSettings({ autoFixOnReject: 'yes', maxConcurrent: 99, leaseMinutes: 0 })).toEqual({ autoFixOnReject: false, maxConcurrent: 10, leaseMinutes: 5 })
  expect(normalizeAgentSettings(null)).toEqual(DEFAULT_AGENT_SETTINGS)
})
it('DesignAgentJob row defaults', async () => {
  const j = await prisma.designAgentJob.create({ data: { kind: 'FIX', source: 'REJECT', requestText: 'x' } })
  expect(j).toMatchObject({ status: 'QUEUED', priority: 0, rounds: 0, attempts: 0, libraryState: null, taskId: null })
})
```
`superRequest` / `dropSessionUser` come from `tests/helpers/session.ts`. Delete `design.settings` and the job rows in `afterAll`.

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-settings.integration.test.ts` — Expected: FAIL (`designAgentJob` undefined / `saveAgentSettings` not exported).
- [ ] **Step 3: Schema and migration.** Append the model to `prisma/schema.prisma`; run the `migrate diff` command from Global Constraints. The script must contain only `CREATE TABLE "DesignAgentJob"` and its two `CREATE INDEX` lines — if it holds anything else the local DB is behind: run `npx prisma migrate deploy` and diff again. Save it in the migration folder, `npx prisma migrate deploy`, `npx prisma generate`, bump `SCHEMA_VERSION` to `'v93-design-agent'`.
- [ ] **Step 4: Settings.** Add the types and functions above; `getDesignSettings` returns `agent: normalizeAgentSettings(parsed.agent)`. In the settings route's `PUT`, build the saved object with `agent: current.agent` (the page does not send it). Add `agent` to the client `DesignSettings` type.
- [ ] **Step 5: Run** the new file and `npx vitest run tests/design-settings.integration.test.ts` — Expected: PASS both.
- [ ] **Step 6: Lint, type-check, commit** — `feat(design-agent): DesignAgentJob table and agent settings (default off)`

### Task 2: API access rules and the middleware matcher

**Files:**
- Modify: `src/lib/api-access.ts`, `src/middleware.ts`
- Test: `tests/design-agent-access.test.ts`

**Interfaces:**
- Produces: rules, in this order, placed before the `/api/design-studio/worker/` rule:
  `{ prefix: '/api/design-agent/runner/', access: 'PUBLIC' }`, `{ prefix: '/api/design-agent/backfill', access: 'SUPERADMIN' }`, `{ prefix: '/api/design-agent/settings', methods: WRITE, access: 'SUPERADMIN' }`, `{ prefix: '/api/design-agent/settings', methods: READ, access: ['design_tasks'] }`, `{ prefix: '/api/design-agent/jobs/', access: ['design_tasks'] }`.
- Produces: `'/api/design-agent/jobs'` in `SELLER_API_PREFIXES` (a seller with Design Tasks answers the library question for its own stores; the route checks the task's store).
- Produces: `api/design-agent/runner/tasks/[^/]+/artwork` added to the negative look-ahead of `config.matcher` in `src/middleware.ts` (Next 14 buffers the whole body for middleware; the route checks the bearer itself).

- [ ] **Step 1: Write the failing test**

```ts
it('design-agent routes', () => {
  expect(canCallApi(null, [], '/api/design-agent/runner/claim', 'POST')).toBe('ok')
  expect(canCallApi('SUPPORT', ['design_tasks'], '/api/design-agent/backfill', 'POST')).toBe('forbidden')
  expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/design-agent/settings', 'PUT')).toBe('forbidden')
  expect(canCallApi('ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN, '/api/design-agent/settings/runner-token', 'POST')).toBe('forbidden')
  expect(canCallApi('SUPPORT', ['design_tasks'], '/api/design-agent/settings', 'GET')).toBe('ok')
  expect(canCallApi('SUPPORT', ['design_tasks'], '/api/design-agent/jobs/j1/library', 'POST')).toBe('ok')
  expect(canCallApi('SUPPORT', ['cs'], '/api/design-agent/jobs/j1/library', 'POST')).toBe('forbidden')
  expect(canCallApi('SELLER', ['design_tasks'], '/api/design-agent/jobs/j1/library', 'POST')).toBe('ok')
  expect(canCallApi('SELLER', ['design_tasks'], '/api/design-agent/settings', 'GET')).toBe('forbidden')
  expect(canCallApi(null, [], '/api/design-agent/jobs/j1/library', 'POST')).toBe('unauthenticated')
})
it('the runner upload skips middleware, nothing else of the agent does', () => {
  const matcher = pathToRegexp(middlewareConfig.matcher[0])
  expect(matcher.test('/api/design-agent/runner/tasks/LIT6262_1/artwork')).toBe(false)
  expect(matcher.test('/api/design-agent/runner/tasks/LIT6262_1/submit')).toBe(true)
  expect(matcher.test('/api/design-agent/runner/claim')).toBe(true)
})
```
Import `pathToRegexp` the way `tests/design-task-artwork-upload.integration.test.ts` (line 6, 380) does.

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-access.test.ts` — Expected: FAIL (`forbidden` / `unauthenticated` where `ok` is expected).
- [ ] **Step 3: Add the rules, the seller prefix and the matcher entry.**
- [ ] **Step 4: Run** the new file plus `npx vitest run tests/store-scope-finance.integration.test.ts tests/design-task-artwork-upload.integration.test.ts` — Expected: PASS.
- [ ] **Step 5: Lint, commit** — `feat(design-agent): access rules for runner, jobs, settings and backfill`

### Task 3: Affected lines of a design

**Files:**
- Create: `src/lib/design-agent/affected.ts`, `tests/helpers/design-agent-fixture.ts`
- Test: `tests/design-agent-affected.integration.test.ts`

**Interfaces:**
- Consumes: `designOf(sku)` (`src/lib/flat-text-coverage.ts`), `isLineExported(order, line)` (`src/lib/line-export.ts`), `lineKeysOf`, `isNonProductLine` (`src/lib/order-lines.ts`).
- Produces:
  - `type AffectedRow = { taskKey: string; orderNumber: string; placedAt: string; taskStatus: string | null; sent: boolean; sameSupplierSku: boolean }` (`taskKey` is the line key when the line has no task; `taskStatus` is then `null`)
  - `type AffectedList = { rows: AffectedRow[]; fulfilledCount: number }`
  - `listDesignLines(designCode: string, storeId: string, fixed: { orderId: string; shopifyLineId: string; supplierSku: string | null }): Promise<AffectedList>` — product lines of the store whose `designOf(sku) === designCode`, except the fixed line and lines whose task is CANCELLED. Order cancelled/refunded (`pipelineStatus` CANCELLED/REFUNDED, or `financialStatus` REFUNDED/VOIDED) → left out. Order fulfilled (`pipelineStatus` FULFILLED or `fulfillmentStatus` = fulfilled, any case) → counted in `fulfilledCount`, not listed. Rows ordered by `placedAt` then `taskKey`. An empty `designCode` returns `{ rows: [], fulfilledCount: 0 }`. Narrow in the DB with `sku: { contains: designCode }`, decide with `designOf`.
  - `affectedForTask(taskId: string): Promise<AffectedList & { designCode: string | null }>`
  - `findLineByKey(key: string): Promise<{ lineId: string; orderId: string; shopifyLineId: string } | null>` — the product line whose line key (`lineKeysOf`) is `key`, task or no task.
- Produces (`tests/helpers/design-agent-fixture.ts`, used by every later test file): `agentFixture(prefix: string)` returning `{ storeId, supplierId, seed(), order(n, opts?), user(key, role, permissions?), cleanup() }` where `order(n, opts)` creates order `#<PREFIX><n>` with one product line per entry of `opts.skus` (default `['DN1-Hoodie']`), runs `syncDesignTasks`, then applies `opts.taskStatus`, `opts.exported` (line `exportedAt`), `opts.pipelineStatus`, `opts.fulfillmentStatus`, `opts.placedAt`, `opts.supplierSku`, `opts.withPrint` (one `DesignArtwork` PRINT row per line) and returns `{ orderId, orderNumber, taskKeys }`; `user()` returns `{ actor: Actor, cookie: string }`. Model the rows on `tests/design-tasks-transition.integration.test.ts` lines 16–54.

- [ ] **Step 1: Write the failing tests**

```ts
// seed: fixed #DAF1 (11/05, 'DN1-Hoodie', supplierSku 'WZIP-XL', task REVIEW)
// #DAF2 11/01 same design, supplierSku 'WZIP-L', exported, task DONE · #DAF3 11/08 same design + 'WZIP-XL', task NEW
// #DAF4 same design, fulfillmentStatus 'fulfilled' · #DAF5 same design, pipelineStatus 'CANCELLED'
// #DAF6 'DN2-Hoodie' · #DAF7 'DN12-Hoodie' · #DAF8 'HOODIE-XL=DN1' 11/09, task NEW · #DAF9 same design in another store
it('lists every open order of the design, sent or not, before or after', async () => {
  const r = await listDesignLines('DN1', fx.storeId, { orderId: o1.orderId, shopifyLineId: 'l1', supplierSku: 'WZIP-XL' })
  expect(r.rows.map(x => [x.taskKey, x.taskStatus, x.sent, x.sameSupplierSku])).toEqual([
    ['DAF2_1', 'DONE', true, false], ['DAF3_1', 'NEW', false, true], ['DAF8_1', 'NEW', false, false]])
  expect(r.fulfilledCount).toBe(1)
})
it('an empty design code matches nothing', async () => {
  expect(await listDesignLines('', fx.storeId, { orderId: o1.orderId, shopifyLineId: 'l1', supplierSku: null })).toEqual({ rows: [], fulfilledCount: 0 })
})
it('a line without a task is listed by its line key and found again', async () => {
  // #DAF10: READY_TO_PRODUCTION, exported, task row deleted
  expect((await listDesignLines('DN1', fx.storeId, fixed)).rows.find(x => x.taskKey === 'DAF10_1')).toMatchObject({ taskStatus: null, sent: true })
  expect(await findLineByKey('DAF10_1')).toMatchObject({ orderId: o10.orderId })
  expect(await findLineByKey('DAF999_1')).toBeNull()
})
```

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-affected.integration.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Write the fixture helper, then `affected.ts`** with the signatures above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Lint, commit** — `feat(design-agent): affected lines of a design`

### Task 4: Job store — enqueue, append, cancel, queue wake-up

**Files:**
- Create: `src/lib/design-agent/jobs.ts`
- Test: `tests/design-agent-jobs.integration.test.ts`

**Interfaces:**
- Consumes: `getDesignSettings().agent` (Task 1), `designOf`. Must NOT import `@/lib/design-tasks` (that file imports this one in Task 5).
- Produces:
  - `type AgentJobKind = 'FIX' | 'MAKE' | 'MOCKUP' | 'LIBRARY_APPLY'`; `type AgentJobSource = 'REJECT' | 'LINE_REOPEN' | 'LARK' | 'LIBRARY' | 'AUTO_HOLD' | 'BACKFILL'`; `type AgentJobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'NEEDS_OWNER' | 'FAILED' | 'CANCELLED'`
  - `class AgentJobError extends Error { constructor(message: string, readonly status: number) }` **(Lark)**
  - `buildRequestText(reasons: string[], note?: string | null): string` → `` `Lý do: ${reasons.join('; ')}` `` + `` `\nGhi chú: ${note}` `` when a note is given **(Lark)**
  - `type EnqueueInput = { kind: AgentJobKind; source: AgentJobSource; taskKey: string; requestText: string; requestedById?: string | null; requestedBy?: string | null; factory?: boolean; parentJobId?: string | null }`
  - `enqueueAgentJob(input: EnqueueInput): Promise<{ job: DesignAgentJob; created: boolean; appended: boolean }>` **(Lark)** — unknown task → `AgentJobError(…, 404)`. When the task already has a QUEUED or RUNNING job of a kind other than `LIBRARY_APPLY`: nothing is created and that job is returned; if it is QUEUED and `input.source === 'LARK'` the text is appended as `` `\n${requestedBy}: ${requestText}` `` (`appended: true`). Otherwise creates the row with `taskId`, `taskKey`, `designCode` (`designOf(line.sku)`, `null` when empty), `priority: factory ? 10 : 0`, then `notifyAgentQueue()`. `LIBRARY_APPLY` is never blocked by, and never blocks, another job of the task.
  - `enqueueFixOnReject(input: { taskKey: string; reasons: string[]; note: string | null; by: { id: string; name: string }; source: 'REJECT' | 'LINE_REOPEN'; factory: boolean }): Promise<DesignAgentJob | null>` — `null` when `agent.autoFixOnReject` is off. Never throws: a failure is logged with `console.error('[design agent] …')` and the reject stands.
  - `openJobForTask(taskId: string): Promise<DesignAgentJob | null>` **(Lark)**; `openJobStatusByTask(taskIds: string[]): Promise<Map<string, 'QUEUED' | 'RUNNING'>>` (both ignore `LIBRARY_APPLY`)
  - `cancelQueuedJobsForTask(taskId: string, why: string): Promise<number>` — QUEUED jobs (not `LIBRARY_APPLY`) → `CANCELLED`, `finishedAt` now, `error: why`
  - `notifyAgentQueue(): void`, `waitForAgentQueue(ms: number, signal?: AbortSignal): Promise<void>` — same shape as `notifyCloneQueue` / `waitForCloneQueue`, waiter set on `globalThis.__designAgentQueueWaiters`

- [ ] **Step 1: Write the failing tests**

```ts
it('buildRequestText', () => {
  expect(buildRequestText(['Sai chi tiết', 'Khác: sao trên mũ lệch'], 'xem mockup')).toBe('Lý do: Sai chi tiết; Khác: sao trên mũ lệch\nGhi chú: xem mockup')
  expect(buildRequestText(['Sai chi tiết'])).toBe('Lý do: Sai chi tiết')
})
it('one open job per task; a Lark request is appended to a queued one', async () => {
  const a = await enqueueAgentJob({ kind: 'FIX', source: 'REJECT', taskKey: 'DAJ1_1', requestText: 'Lý do: Sai chi tiết', requestedBy: 'Huong', factory: true })
  expect(a).toMatchObject({ created: true, appended: false }); expect(a.job).toMatchObject({ status: 'QUEUED', priority: 10, designCode: 'DN1', taskKey: 'DAJ1_1' })
  const b = await enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'DAJ1_1', requestText: 'sao lệch', requestedBy: 'Lan' })
  expect(b).toMatchObject({ created: false, appended: true }); expect(b.job.requestText).toBe('Lý do: Sai chi tiết\nLan: sao lệch')
  await prisma.designAgentJob.update({ where: { id: a.job.id }, data: { status: 'RUNNING' } })
  expect(await enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'DAJ1_1', requestText: 'x', requestedBy: 'Lan' })).toMatchObject({ created: false, appended: false })
  expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAJ1_1' } })).toBe(1)
})
it('unknown task is a 404', async () => { await expect(enqueueAgentJob({ kind: 'FIX', source: 'LARK', taskKey: 'NOPE_1', requestText: 'x' })).rejects.toMatchObject({ status: 404 }) })
it('enqueueFixOnReject follows the switch', async () => {
  expect(await enqueueFixOnReject(input)).toBeNull()
  await saveAgentSettings({ autoFixOnReject: true })
  expect(await enqueueFixOnReject(input)).toMatchObject({ kind: 'FIX', source: 'REJECT', requestedBy: 'Lead', priority: 0 })
})
it('cancelQueuedJobsForTask leaves a running job alone', async () => { /* QUEUED → CANCELLED with error = why, count 1; RUNNING untouched, count 0 */ })
it('a waiter wakes on enqueue and none is left behind', async () => {
  const woke = waitForAgentQueue(5000); await enqueueAgentJob(other); await woke
  expect(globalThis.__designAgentQueueWaiters?.size ?? 0).toBe(0)
})
```

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-jobs.integration.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `jobs.ts`** with the signatures above.
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Lint, commit** — `feat(design-agent): job store (enqueue, append, cancel, wake-up)`

### Task 5: Hooks in `design-tasks.ts` — queue on reject / line reopen, cancel when a person moves on, the `agent` option

**Files:**
- Modify: `src/lib/design-tasks.ts` (`transitionTask` ~line 660, `reopenLineForFix` ~line 532, `SENT_BACK_REASONS` line 46, `isSentLineOfOpenOrder` line 487)
- Test: `tests/design-agent-hooks.integration.test.ts`

**Interfaces:**
- Consumes: `enqueueFixOnReject`, `cancelQueuedJobsForTask`, `buildRequestText` (Task 4).
- Produces:
  - `transitionTask(taskKey: string, actor: Actor, input: TransitionInput, opts: { agent?: boolean } = {}): Promise<TransitionResult>`
  - `reopenLineForFix(lineId: string, actor: Actor, input: { reason?: unknown; note?: unknown }, opts: { agent?: boolean } = {}): Promise<{ task: TaskRow; changed: boolean }>`
  - now exported: `SENT_BACK_REASONS`, `isSentLineOfOpenOrder(lineId: string): Promise<boolean>`
- Behaviour to add, all after the task row is written:
  - `to === 'REJECTED'` → `enqueueFixOnReject({ taskKey, reasons: <the reasons stored on the task>, note, by: actor, source: 'REJECT', factory: <a stored reason is in SENT_BACK_REASONS> })`.
  - `reopenLineForFix` with `changed === true` and no `opts.agent` → `enqueueFixOnReject({ …, reasons: [fix.reason], note: fix.note, source: 'LINE_REOPEN', factory: true })`.
  - no `opts.agent` and (`from === 'REJECTED'` or `to === 'CANCELLED'`) → `cancelQueuedJobsForTask(task.id, 'Task đã được người xử lý trước khi Agent nhận')`.
  - `opts.agent`: any move other than DONE → DOING throws `Agent chỉ được mở lại task đã duyệt`; the "Task đang thuộc về …" check is skipped; `assigneeId` is not set; the internal hand-over to `reopenLineForFix` passes `opts` on.

- [ ] **Step 1: Write the failing tests**

```ts
it('switch off: a reject queues nothing', async () => { await reject('DAH1_1'); expect(await jobsOf('DAH1_1')).toEqual([]) })
it('switch on: a reject queues one FIX job with the reasons and the note', async () => {
  await saveAgentSettings({ autoFixOnReject: true })
  await transitionTask('DAH2_1', LEAD, { to: 'REJECTED', reasons: ['Sai chi tiết', 'Khác: sao trên mũ lệch'], note: 'xem mockup' })
  expect(await jobsOf('DAH2_1')).toMatchObject([{ kind: 'FIX', source: 'REJECT', status: 'QUEUED', priority: 0, requestedBy: 'Lead',
    requestText: 'Lý do: Sai chi tiết; Khác: sao trên mũ lệch\nGhi chú: xem mockup' }])
})
it('a reopened sent line queues with priority 10, and so does a later reject of it', async () => {
  await reopenLineForFix(sentLineId, LEAD, { reason: 'Xưởng yêu cầu update design', note: 'lệch tâm' })
  expect(await jobsOf('DAH3_1')).toMatchObject([{ source: 'LINE_REOPEN', priority: 10, requestText: 'Lý do: Xưởng yêu cầu update design\nGhi chú: lệch tâm' }])
  await prisma.designAgentJob.deleteMany({ where: { taskKey: 'DAH3_1' } })
  await prisma.designTask.update({ where: { taskKey: 'DAH3_1' }, data: { status: 'REVIEW' } })
  await transitionTask('DAH3_1', LEAD, { to: 'REJECTED', reasons: ['Sai chi tiết'] })
  expect(await jobsOf('DAH3_1')).toMatchObject([{ source: 'REJECT', priority: 10, requestText: 'Lý do: Xưởng yêu cầu update design; Sai chi tiết' }])
})
it('a person resubmitting a rejected task cancels its queued job', async () => {
  await transitionTask('DAH2_1', DES, { to: 'REVIEW' })
  expect((await jobsOf('DAH2_1'))[0]).toMatchObject({ status: 'CANCELLED', error: 'Task đã được người xử lý trước khi Agent nhận' })
})
it('the agent option only reopens, keeps the assignee, queues nothing', async () => {
  await expect(transitionTask('DAH4_1', AGENT, { to: 'DONE' }, { agent: true })).rejects.toThrow('Agent chỉ được mở lại task đã duyệt')
  await expect(transitionTask('DAH4_1', AGENT, { to: 'REJECTED', reasons: ['x'] }, { agent: true })).rejects.toThrow('Agent chỉ được mở lại task đã duyệt')
  const r = await transitionTask('DAH5_1', AGENT, { to: 'DOING' }, { agent: true })   // DONE, assigned to DES
  expect(r.task).toMatchObject({ status: 'DOING', assigneeId: desId })
  expect((await transitionTask('DAH6_1', AGENT, { to: 'DOING' }, { agent: true })).task.assigneeId).toBeNull()   // DONE, unassigned
  await reopenLineForFix(otherSentLineId, AGENT, { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }, { agent: true })
  expect(await jobsOf('DAH7_1')).toEqual([])
})
```
`AGENT = { id: <a SUPPORT user>, name: 'Design Agent', role: 'SUPPORT', permissions: ['design_tasks'] }`.

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-hooks.integration.test.ts` — Expected: FAIL (no job rows; `transitionTask` ignores the 4th argument).
- [ ] **Step 3: Implement the option and the three hooks.**
- [ ] **Step 4: Run** the new file plus `npx vitest run tests/design-tasks-transition.integration.test.ts tests/design-studio-line-reopen.integration.test.ts tests/design-approve.integration.test.ts` — Expected: PASS (no behaviour change with the switch off).
- [ ] **Step 5: Lint, commit** — `feat(design-agent): queue a fix on reject and line reopen, cancel when a person takes over`

### Task 6: Runner core — token, last seen, claim with lease and long-poll, heartbeat, fail

**Files:**
- Create: `src/lib/design-agent/runner.ts`, `src/lib/design-agent/agent-user.ts`
- Test: `tests/design-agent-runner.integration.test.ts`

**Interfaces:**
- Consumes: `mintHashedToken`, `revokeHashedToken`, `hashedTokenInfo`, `verifyBearerHash` (`src/lib/hashed-token.ts`); `waitForAgentQueue`; `affectedForTask` (Task 3); `templateForLine`, `isSentLineOfOpenOrder`, type `Actor` (`design-tasks.ts`); `linePersonalization`, `safeHttpUrl` (`src/lib/design-studio.ts`); `currentFiles` (`src/lib/task-files.ts`).
- Produces (`agent-user.ts`): `AGENT_USER_EMAIL = 'design-agent@ecom-manager.local'`, `AGENT_USER_NAME = 'Design Agent'`, `ensureAgentUser(): Promise<Actor>` **(Lark)** — upserts the user described in "Builder's calls" and returns `{ id, name: 'Design Agent', role: 'SUPPORT', permissions: ['design_tasks'] }`.
- Produces (`runner.ts`):
  - `DESIGN_AGENT_TOKEN_KEY = 'design.agent.tokenHash'`, `DESIGN_AGENT_SEEN_KEY = 'design.agent.lastSeenAt'`, `AGENT_MAX_WAIT_S = 25`, `AGENT_MAX_ATTEMPTS = 2`, `RUNNER_LOST = 'runner lost'`
  - `generateAgentRunnerToken(): Promise<string>` (prefix `dag_`), `revokeAgentRunnerToken(): Promise<void>`, `verifyAgentRunnerRequest(req: NextRequest): Promise<boolean>`, `markAgentRunnerSeen(now?: Date): Promise<void>`, `agentRunnerInfo(): Promise<{ configured: boolean; tokenUpdatedAt: string | null; lastSeenAt: string | null; online: boolean }>` (online = seen within 90 s)
  - `type AgentClaim` — the `Job` JSON of the spec's interface contract, field for field, plus `files[].driveUrl: string | null`. `files[].url` = `` `/api/design-agent/runner/files/${artworkId}` ``. `files` = the current version of every part, PRINT and MOCKUP. `events` = the last 20, oldest first, `{ at, type, message, actor }`. `task.customFields` = `linePersonalization(line)` as an object. `parent` = `null` here (Task 10 fills it).
  - `buildAgentClaim(job: DesignAgentJob): Promise<AgentClaim | null>` (`null` when the task or its line is gone)
  - `releaseExpiredAgentLeases(now?: Date): Promise<void>` — RUNNING with `lockedAt` older than `agent.leaseMinutes` (or null): `attempts < 2` → QUEUED (`lockedAt`, `stage` cleared); else FAILED, `error: 'runner lost'`, `finishedAt`.
  - `claimAgentJobs(free: number, now?: Date): Promise<AgentClaim[]>` — releases expired leases; takes up to `min(free, agent.maxConcurrent − running)` QUEUED jobs ordered `priority desc, createdAt asc, id asc`; each by compare-and-set on `{ id, status: 'QUEUED', attempts }` → RUNNING, `attempts + 1`, `lockedAt`, `startedAt` if unset. Before taking a job: task missing or CANCELLED → job CANCELLED `error: 'Task đã huỷ'`; kind FIX/MAKE and task DONE → CANCELLED `error: 'Task đã được duyệt'`; another job of the same task is RUNNING → skipped this round.
  - `claimAgentJobsWithWait(free: number, waitSeconds: number, signal?: AbortSignal): Promise<AgentClaim[]>` — like `claimWithWait` in `src/lib/clone/worker.ts`: wait capped at 25 s, the wait is registered before the second look, nothing is claimed once `signal` is aborted; with no capacity it waits the window out and returns `[]`.
  - `heartbeatAgentJob(id: string, patch: { stage?: unknown; rounds?: unknown }): Promise<boolean>` — RUNNING only; renews `lockedAt`, stores `stage` (string, cut to 200) and `rounds` (integer ≥ 0).
  - `failAgentJob(id: string, input: { error: unknown; permanent?: unknown }): Promise<{ status: 'QUEUED' | 'FAILED'; attempts: number } | null>` — `null` when not RUNNING; not permanent and `attempts < 2` → QUEUED; else FAILED (`error` cut to 2000), a NOTE event on the task `` `Agent: không chạy được — ${error cut to 300}` `` by the Design Agent user, and `notifyNeedsOwner` (Task 8 wires it; until then nothing).

- [ ] **Step 1: Write the failing tests**

```ts
it('token: dag_ prefix, only the hash is stored, other tokens are refused', async () => {
  const token = await generateAgentRunnerToken()
  expect(token).toMatch(/^dag_[A-Za-z0-9_-]{43}$/)
  expect((await prisma.appSetting.findUniqueOrThrow({ where: { key: 'design.agent.tokenHash' } })).value).toBe(sha256(token))
  expect(await verifyAgentRunnerRequest(req(`Bearer ${token}`))).toBe(true)
  expect(await verifyAgentRunnerRequest(req(`Bearer ${await generateCloneWorkerToken()}`))).toBe(false)
  expect(await verifyAgentRunnerRequest(req())).toBe(false)
})
it('claims factory jobs first, then the oldest, within maxConcurrent', async () => {
  // queued: A (priority 0, oldest), B (priority 10), C (priority 0); maxConcurrent 2
  expect((await claimAgentJobs(5)).map(j => j.id)).toEqual([B, A])
  expect(await claimAgentJobs(5)).toEqual([])
  expect(await claimAgentJobs(0)).toEqual([])
})
it('the claim carries the context of the contract', async () => {
  const [job] = await claimAgentJobs(1)
  expect(job).toMatchObject({ kind: 'FIX', source: 'REJECT', attempts: 1, priority: 0, requestedBy: 'Huong', parent: null,
    task: { key: 'DAR1_1', status: 'REJECTED', orderNumber: '#DAR1', linePosition: 1, sku: 'DN1-Hoodie', designCode: 'DN1', sent: false },
    files: [{ kind: 'PRINT', printArea: 'PRINT', version: 1, url: expect.stringMatching(/^\/api\/design-agent\/runner\/files\//) }],
    affected: [{ taskKey: 'DAR2_1', sent: true }] })
  expect(job.events.length).toBeLessThanOrEqual(20)
  expect(JSON.stringify(job)).not.toContain('dag_')
})
it('a lost runner: requeued once, then FAILED "runner lost"', async () => {
  // RUNNING, attempts 1, lockedAt 21 min ago → claim returns it again with attempts 2; again 21 min → FAILED
  expect(await rowOf(id)).toMatchObject({ status: 'FAILED', error: 'runner lost' })
})
it('nothing is handed out for a cancelled or already approved task', async () => {
  expect(await claimAgentJobs(5)).toEqual([])
  expect(await rowOf(cancelledTaskJob)).toMatchObject({ status: 'CANCELLED', error: 'Task đã huỷ' })
  expect(await rowOf(approvedTaskJob)).toMatchObject({ status: 'CANCELLED', error: 'Task đã được duyệt' })
})
it('heartbeat renews a running job only', async () => {
  expect(await heartbeatAgentJob(running, { stage: 'round 1: codex', rounds: 1 })).toBe(true)
  expect(await rowOf(running)).toMatchObject({ stage: 'round 1: codex', rounds: 1 })
  expect(await heartbeatAgentJob(queued, {})).toBe(false)
})
it('fail: back to the queue once, then FAILED with a note on the task', async () => {
  expect(await failAgentJob(id, { error: 'claude exited 1', permanent: false })).toEqual({ status: 'QUEUED', attempts: 1 })
  expect(await failAgentJob(idAfterSecondClaim, { error: 'no result.json' })).toEqual({ status: 'FAILED', attempts: 2 })
  expect(lastEvent('DAR3_1')).toMatchObject({ type: 'NOTE', message: 'Agent: không chạy được — no result.json', actorName: 'Design Agent' })
  expect(await failAgentJob(queued, { error: 'x' })).toBeNull()
})
it('the long poll returns when a job arrives and claims nothing after an abort', async () => { /* as tests/clone-worker.integration.test.ts does for claimWithWait; waiter set empty afterEach */ })
it('ensureAgentUser is one inactive Support user without a password, not offered in "Giao việc"', async () => {
  const a = await ensureAgentUser(); expect((await ensureAgentUser()).id).toBe(a.id)
  expect(await prisma.appUser.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ role: 'SUPPORT', permissions: '["design_tasks"]', status: 'INACTIVE', passwordHash: null })
  expect((await loadTask('DAR1_1'))!.assignable.some(u => u.id === a.id)).toBe(false)
})
```

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-runner.integration.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Implement `agent-user.ts`, then `runner.ts`** with the signatures above.
- [ ] **Step 4: Run** — Expected: PASS, no waiter left.
- [ ] **Step 5: Lint, commit** — `feat(design-agent): runner token, claim with lease and long-poll, heartbeat, fail`

### Task 7: Delivery as the Design Agent — upload guard, submit, reopen, reject, note, hold

**Files:**
- Create: `src/lib/design-agent/delivery.ts`, `src/lib/task-artwork-upload.ts`
- Modify: `src/lib/design-tasks.ts` (two new functions beside `submitAutoRenderForReview`), `src/app/api/design-studio/tasks/[key]/artwork/route.ts` (calls the shared upload function)
- Test: `tests/design-agent-delivery.integration.test.ts`

**Interfaces:**
- Consumes: `ensureAgentUser` (Task 6), `transitionTask` / `reopenLineForFix` with `{ agent: true }`, `isSentLineOfOpenOrder` (Task 5), `findLineByKey` (Task 3), `enqueueAgentJob`, `AgentJobError` (Task 4), `parseLineFix` (`src/lib/line-fix.ts`).
- Produces (`design-tasks.ts`):
  - `AGENT_SUBMIT_MESSAGE = 'Gửi duyệt lại (Agent)'`
  - `submitAgentForReview(taskKey: string, agentId: string): Promise<{ moved: true } | { moved: false; error: string; missing: string[]; status: 400 | 404 | 409 }>` — NEW / ASSIGNED / DOING / REJECTED → REVIEW by compare-and-set, `prevStatus` cleared, event `{ type: 'STATUS', message: AGENT_SUBMIT_MESSAGE, actorId: agentId }`. Already REVIEW → `{ moved: true }` with no event. Other statuses → 409 `` `Task đang ${status}` ``. Same checks as "Gửi duyệt": `printCutCheck` then `missingPrintFiles`; a failure is 400 with `missing` = `missingPrintAreas(files, slots)` (empty when there is no template).
  - `rejectReviewAsAgent(taskKey: string, agentId: string, input: { reason: string; note: string }): Promise<boolean>` — REVIEW → REJECTED by compare-and-set, stored reasons = sent-back reasons already on the task + `reason`, `rejectNote: note`, event `REJECT` `` `Trả lại sửa: ${reason} — ${note}` ``. Queues nothing. `false` when the task is not in REVIEW.
- Produces (`task-artwork-upload.ts`): `receiveTaskArtwork(req: NextRequest, taskKey: string, uploadedById: string): Promise<{ artwork: ArtworkRow } | { error: string; status: number }>` — lines 25–64 of the designer route moved here unchanged (query checks, type and size checks, `streamToTempFile`, `saveArtworkFromTemp`, `logArtworkUpload`, `retireOutdatedParts`, `enqueueDrivePush`, `discardTemp`). The designer route keeps its auth and returns `{ artwork }` as before.
- Produces (`delivery.ts`):
  - `type AgentTaskState = { taskId: string; taskKey: string; status: TaskStatus; sent: boolean; lineId: string; orderId: string; orderNumber: string }`; `agentTaskState(taskKey: string): Promise<AgentTaskState | null>` **(Lark)**
  - `runningJobCovering(taskKey: string): Promise<DesignAgentJob | null>` — see "Builder's calls"
  - `agentUploadGuard(taskKey: string, kind: FileKind): Promise<{ ok: true } | { error: string; status: 404 | 409 }>` — no covering job → 409 `Task không có job Agent đang chạy`; PRINT on a DONE or CANCELLED task → 409 `Task đã duyệt — mở lại trước khi thay file in`; MOCKUP refused only on CANCELLED
  - `agentSubmit(taskKey: string)` → `submitAgentForReview` as the agent user
  - `agentReopenTask(key: string, input: { reason?: unknown; note?: unknown }, opts: { allowSent: boolean }): Promise<{ status: TaskStatus; sent: boolean }>` **(Lark)** — task not DONE → its status, unchanged. DONE and not sent → `transitionTask(key, agent, { to: 'DOING', note }, { agent: true })`. Sent (or a sent line with no task, found by `findLineByKey`): `allowSent` false → `AgentJobError('Đơn đã gửi xưởng — cần mở lại trên tool với lý do', 409)`; true → `reopenLineForFix(lineId, agent, { reason, note }, { agent: true })` (a `LineFixError` becomes an `AgentJobError` with the same message and status). No task and not sent → `AgentJobError('Dòng chưa có task — bấm Đồng bộ task trên tool', 409)`. Unknown key → 404.
  - `agentRejectReview(taskKey: string, input: { reason: string; note: string }): Promise<void>` **(Lark)** — `rejectReviewAsAgent`; not in REVIEW → `AgentJobError('Task không ở Chờ duyệt', 409)`
  - `agentAddNote(taskKey: string, message: string): Promise<void>` **(Lark)** — NOTE event `` `Agent: ${message}` `` (message trimmed, cut to 2000; empty → `AgentJobError(…, 400)`; unknown task → 404)
  - `HOLD_NOTE_PREFIX = 'Auto render giữ lại: '`; `agentHold(taskKey: string, reason: string): Promise<{ jobId: string | null }>` — NOTE event `` `${HOLD_NOTE_PREFIX}${reason}` `` (reason cut to 300) always; a FIX job (`source: 'AUTO_HOLD'`, `requestText` = the note text, `requestedBy: 'Auto render'`) only when `agent.autoFixOnReject` is on. Unknown task → `AgentJobError(…, 404)`; an empty reason → 400.

- [ ] **Step 1: Write the failing tests**

```ts
it('upload guard', async () => {
  expect(await agentUploadGuard('DAD1_1', 'PRINT')).toMatchObject({ status: 409, error: 'Task không có job Agent đang chạy' })
  await run('DAD1_1')   // FIX job of the task set RUNNING
  expect(await agentUploadGuard('DAD1_1', 'PRINT')).toEqual({ ok: true })
  expect(await agentUploadGuard('DAD9_1', 'PRINT')).toEqual({ ok: true })   // listed in a RUNNING LIBRARY_APPLY job's affectedJson
  expect(await agentUploadGuard('DAD2_1', 'PRINT')).toMatchObject({ status: 409 })   // DONE task with a RUNNING MOCKUP job
  expect(await agentUploadGuard('DAD2_1', 'MOCKUP')).toEqual({ ok: true })
})
it('submit moves a rejected task to review as Design Agent, and refuses an incomplete set', async () => {
  expect(await agentSubmit('DAD1_1')).toEqual({ moved: true })
  expect(lastEvent('DAD1_1')).toMatchObject({ type: 'STATUS', message: 'Gửi duyệt lại (Agent)', actorName: 'Design Agent' })
  expect(await agentSubmit('DAD3_1')).toMatchObject({ moved: false, status: 400, missing: ['Back'] })   // template Front + Back, only Front uploaded
  expect((await loadTask('DAD3_1'))!.task.status).toBe('REJECTED')
  expect(await agentSubmit('DAD2_1')).toMatchObject({ moved: false, status: 409 })   // DONE
})
it('reopen: an unsent approved task goes back to DOING and the line is no longer done', async () => {
  expect(await agentReopenTask('DAD4_1', { note: 'theo yêu cầu' }, { allowSent: false })).toEqual({ status: 'DOING', sent: false })
  expect((await prisma.order.findUniqueOrThrow({ where: { id: o4.orderId } })).designReady).toBe(false)
})
it('reopen: a sent line only with allowSent, through the line-fix path, without a new FIX job', async () => {
  await saveAgentSettings({ autoFixOnReject: true })
  await expect(agentReopenTask('DAD5_1', { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }, { allowSent: false })).rejects.toMatchObject({ status: 409 })
  expect(await agentReopenTask('DAD5_1', { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }, { allowSent: true })).toEqual({ status: 'REJECTED', sent: true })
  expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAD5_1' } })).toBe(0)
  await expect(agentReopenTask('DAD6_1', { reason: 'không có', note: 'x' }, { allowSent: true })).rejects.toMatchObject({ status: 400 })
  expect(await agentReopenTask('DAD7_1', { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }, { allowSent: true })).toMatchObject({ sent: true })   // sent line that had no task
})
it('reject from review as Design Agent queues nothing by itself', async () => {
  await agentRejectReview('DAD8_1', { reason: 'Khác: sao trên mũ lệch', note: 'Theo yêu cầu của Lan trên Lark' })
  expect((await loadTask('DAD8_1'))!.task).toMatchObject({ status: 'REJECTED', rejectReasons: ['Khác: sao trên mũ lệch'] })
  expect(await prisma.designAgentJob.count({ where: { taskKey: 'DAD8_1' } })).toBe(0)
  await expect(agentRejectReview('DAD8_1', { reason: 'Khác: x y z', note: 'n' })).rejects.toMatchObject({ status: 409 })
})
it('note and hold', async () => {
  await agentAddNote('DAD1_1', 'vòng 1 chưa đạt'); expect(lastEvent('DAD1_1').message).toBe('Agent: vòng 1 chưa đạt')
  await expect(agentAddNote('NOPE_1', 'x')).rejects.toMatchObject({ status: 404 })
  await saveAgentSettings({ autoFixOnReject: false })
  expect(await agentHold('DAD10_1', 'tên vượt khung')).toEqual({ jobId: null })
  expect(lastEvent('DAD10_1').message).toBe('Auto render giữ lại: tên vượt khung')
  await saveAgentSettings({ autoFixOnReject: true })
  const { jobId } = await agentHold('DAD11_1', 'chạm safe zone')
  expect(await rowOf(jobId!)).toMatchObject({ kind: 'FIX', source: 'AUTO_HOLD', requestText: 'Auto render giữ lại: chạm safe zone' })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-delivery.integration.test.ts` — Expected: FAIL (module not found).
- [ ] **Step 3: Move the upload body into `receiveTaskArtwork`** and call it from the designer route. Run `npx vitest run tests/design-task-artwork-upload.integration.test.ts` — Expected: PASS unchanged.
- [ ] **Step 4: Add `submitAgentForReview` and `rejectReviewAsAgent` to `design-tasks.ts`, then write `delivery.ts`.**
- [ ] **Step 5: Run** the new file — Expected: PASS.
- [ ] **Step 6: Lint, commit** — `feat(design-agent): delivery as the Design Agent user`

### Task 8: Result — task note, checked DONE, library question, owner notice

**Files:**
- Create: `src/lib/design-agent/notify.ts`
- Modify: `src/lib/design-agent/runner.ts`
- Test: `tests/design-agent-result.integration.test.ts`

**Interfaces:**
- Consumes: `affectedForTask` (Task 3), `enqueueFixOnReject` (Task 4), `AGENT_SUBMIT_MESSAGE` (Task 7), `ensureAgentUser`.
- Produces (`notify.ts`): `type OwnerNotice = { jobId: string; taskKey: string | null; kind: AgentJobKind; reason: 'NEEDS_OWNER' | 'FAILED'; summary: string }`; `notifyNeedsOwner(notice: OwnerNotice): Promise<void>` **(Lark)** — in this plan it writes one line `console.warn('[design agent] cần chủ shop', notice.jobId, notice.taskKey)` and nothing else; the Lark plan gives it its body. Callers always wrap it so a throw never fails a result.
- Produces (`runner.ts`): `completeAgentJob(id: string, input: { outcome: unknown; summary: unknown; rounds?: unknown; result?: unknown }): Promise<{ status: AgentJobStatus } | { error: string; status: 400 | 409 }>`:
  - `outcome` not `DONE` / `NEEDS_OWNER`, or an empty `summary` → 400 `outcome và summary là bắt buộc`; job not RUNNING → 409 `not running`.
  - Stores `summary` (cut to 4000), `rounds`, `resultJson` (`JSON.stringify(result)`, cut to 20000), `finishedAt`, clears `lockedAt`; writes a NOTE event `` `Agent: ${summary}` `` on the task as the Design Agent user.
  - `NEEDS_OWNER` → status `NEEDS_OWNER`, `notifyNeedsOwner({ …, reason: 'NEEDS_OWNER' })`.
  - `DONE`, kind FIX or MAKE — "submitted" = the task is in REVIEW or DONE, or a `STATUS` event with `AGENT_SUBMIT_MESSAGE` exists since `job.startedAt`:
    - not submitted → status `NEEDS_OWNER`, summary + `\n(Agent báo xong nhưng task chưa được gửi duyệt.)`, owner notice.
    - submitted and the task is REJECTED now → status `DONE`, `libraryState` stays `null`; then, once that row is written (the finished job must no longer count as open), `enqueueFixOnReject` with the task's current reasons and note (`by` = the Design Agent user, `source: 'REJECT'`).
    - otherwise → status `DONE`; kind FIX with a non-empty affected list → `libraryState: 'ASKED'`, `affectedJson` = `JSON.stringify({ rows, fulfilledCount })`.
  - `DONE`, kind MOCKUP or LIBRARY_APPLY → status `DONE` (Task 10 adds the parent update).
  - `failAgentJob` (Task 6) now calls `notifyNeedsOwner({ …, reason: 'FAILED', summary: error })` when the job ends FAILED.

- [ ] **Step 1: Write the failing tests** (`vi.mock('@/lib/design-agent/notify', …)` with a spy, as `tests/secrets-not-returned.integration.test.ts` mocks `@/lib/telegram`)

```ts
it('DONE after a real submit: note on the task and the library question', async () => {
  await agentSubmit('DAS1_1')
  expect(await completeAgentJob(j1, { outcome: 'DONE', summary: 'Đã sửa thân trước', rounds: 2, result: { pushed: ['FRONT'] } })).toEqual({ status: 'DONE' })
  expect(await rowOf(j1)).toMatchObject({ status: 'DONE', rounds: 2, libraryState: 'ASKED', lockedAt: null })
  expect(JSON.parse((await rowOf(j1)).affectedJson!).rows.map((r: any) => r.taskKey)).toEqual(['DAS2_1'])
  expect(lastEvent('DAS1_1')).toMatchObject({ type: 'NOTE', message: 'Agent: Đã sửa thân trước', actorName: 'Design Agent' })
})
it('DONE with no other order of the design asks nothing', async () => { expect((await rowOf(jLone)).libraryState).toBeNull() })
it('DONE without a submit becomes NEEDS_OWNER', async () => {
  expect(await completeAgentJob(j3, { outcome: 'DONE', summary: 'xong' })).toEqual({ status: 'NEEDS_OWNER' })
  expect((await rowOf(j3)).summary).toBe('xong\n(Agent báo xong nhưng task chưa được gửi duyệt.)')
  expect(notify).toHaveBeenCalledWith(expect.objectContaining({ jobId: j3, reason: 'NEEDS_OWNER' }))
})
it('a delivery rejected again before the result arrives is not lost', async () => {
  await saveAgentSettings({ autoFixOnReject: true })
  await agentSubmit('DAS4_1'); await transitionTask('DAS4_1', LEAD, { to: 'REJECTED', reasons: ['Sai chi tiết'] })   // job still RUNNING → no new job yet
  expect(await completeAgentJob(j4, { outcome: 'DONE', summary: 'xong' })).toEqual({ status: 'DONE' })
  expect((await rowOf(j4)).libraryState).toBeNull()
  expect(await openJobForTask(task4Id)).toMatchObject({ status: 'QUEUED', requestText: 'Lý do: Sai chi tiết' })
})
it('NEEDS_OWNER calls the owner once and a failing notice never fails the result', async () => {
  notify.mockRejectedValueOnce(new Error('lark down'))
  expect(await completeAgentJob(j5, { outcome: 'NEEDS_OWNER', summary: '3 vòng chưa đạt' })).toEqual({ status: 'NEEDS_OWNER' })
})
it('refusals', async () => {
  expect(await completeAgentJob(queued, { outcome: 'DONE', summary: 'x' })).toMatchObject({ status: 409, error: 'not running' })
  expect(await completeAgentJob(running, { outcome: 'OK', summary: 'x' })).toMatchObject({ status: 400 })
  expect(await completeAgentJob(running, { outcome: 'DONE', summary: ' ' })).toMatchObject({ status: 400 })
})
it('a job that ends FAILED calls the owner', async () => { expect(notify).toHaveBeenCalledWith(expect.objectContaining({ reason: 'FAILED' })) })
```

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-result.integration.test.ts` — Expected: FAIL (`completeAgentJob` not exported).
- [ ] **Step 3: Write `notify.ts`, add `completeAgentJob`, wire the notice into `failAgentJob`.**
- [ ] **Step 4: Run** the new file and `tests/design-agent-runner.integration.test.ts` — Expected: PASS.
- [ ] **Step 5: Lint, commit** — `feat(design-agent): result handling with checked DONE and the library question`

### Task 9: Runner API routes

**Files:**
- Create: `src/lib/design-agent/route-http.ts` and, under `src/app/api/design-agent/runner/`: `claim/route.ts`, `jobs/[id]/heartbeat/route.ts`, `jobs/[id]/result/route.ts`, `jobs/[id]/fail/route.ts`, `notes/route.ts`, `hold/route.ts`, `tasks/[key]/artwork/route.ts`, `tasks/[key]/submit/route.ts`, `tasks/[key]/reopen/route.ts`, `files/[artworkId]/route.ts`
- Test: `tests/design-agent-routes.integration.test.ts`

**Interfaces:**
- Consumes: everything produced by Tasks 6–8; `readJson`, `isJsonObject` (`src/lib/clone/route-http.ts`); `localArtworkPath` (`src/lib/design-storage.ts`), `streamFile` (`src/lib/google-drive.ts`).
- Produces (`route-http.ts`): `requireRunner(req: NextRequest): Promise<NextResponse | null>` — 401 `{ error: 'unauthorized' }` when the bearer is wrong, else `markAgentRunnerSeen()` and `null`; `agentErrorResponse(e: unknown): NextResponse` — `AgentJobError` → its message and status, anything else → logged, 500 `{ error: 'Lỗi máy chủ.' }`.
- Every route: `export const dynamic = 'force-dynamic'`, first statement `const denied = await requireRunner(req); if (denied) return denied`. Requests and responses exactly as the contract table:

| Route | Calls | Answers |
|---|---|---|
| `POST claim` | `claimAgentJobsWithWait(free, waitSeconds, req.signal)` (`free` not a number → 0) | `{ jobs }` always 200 |
| `POST jobs/[id]/heartbeat` | `heartbeatAgentJob` | `{ ok: true }` / 409 `{ error: 'not running' }` |
| `POST jobs/[id]/result` | `completeAgentJob` | `{ ok: true, status }` / 400 / 409 |
| `POST jobs/[id]/fail` | `failAgentJob` | `{ ok: true, status, attempts }` / 409 `{ error: 'not running' }` |
| `POST notes` | `agentAddNote(taskKey, message)` | `{ ok: true }` / 404 |
| `POST hold` | `agentHold(taskKey, reason)` (unknown task → 404) | `{ ok: true, jobId }` |
| `PUT tasks/[key]/artwork` | `agentUploadGuard(key, kind)` then `receiveTaskArtwork(req, key, agent.id)` | `{ ok: true, artworkId, version, printArea }` / 409 |
| `POST tasks/[key]/submit` | covering job required (409 as the guard), then `agentSubmit` | `{ ok: true, status: 'REVIEW' }` / 400 `{ error, missing }` / 409 |
| `POST tasks/[key]/reopen` | covering job required; `agentReopenTask(key, body, { allowSent: job.kind === 'LIBRARY_APPLY' })` | `{ ok: true, status, sent }` |
| `GET files/[artworkId]` | the file's task must have a covering job (else 404); LOCAL → stream from disk, DRIVE → `streamFile(driveFileId)`; `Content-Disposition: attachment` | the bytes |

- [ ] **Step 1: Write the failing tests**

```ts
it.each(ROUTES)('%s refuses a call without the runner token', async (_name, call) => {
  const res = await call(undefined); expect(res.status).toBe(401); expect(await res.json()).toEqual({ error: 'unauthorized' })
})
it('claim answers { jobs: [] } and records the runner as seen', async () => {
  const res = await claim(post('/claim', { free: 3, waitSeconds: 0 })); expect(res.status).toBe(200); expect(await res.json()).toEqual({ jobs: [] })
  expect((await agentRunnerInfo()).online).toBe(true)
})
it('heartbeat / result / fail follow the contract', async () => {
  expect(await body(heartbeat(post(`/jobs/${queued}/heartbeat`, { stage: 's', rounds: 0 }), id(queued)))).toEqual([409, { error: 'not running' }])
  expect(await body(heartbeat(post(`/jobs/${running}/heartbeat`, { stage: 'round 1: codex', rounds: 1 }), id(running)))).toEqual([200, { ok: true }])
  expect(await body(fail(post(`/jobs/${running2}/fail`, { error: 'x', permanent: false }), id(running2)))).toEqual([200, { ok: true, status: 'QUEUED', attempts: 1 }])
  expect(await body(result(post(`/jobs/${running}/result`, { outcome: 'NEEDS_OWNER', summary: 'thiếu nguồn', rounds: 3, result: {} }), id(running)))).toEqual([200, { ok: true, status: 'NEEDS_OWNER' }])
})
it('artwork: 409 without a running job, then a new version of the part', async () => {
  expect((await artwork(put('DAT1_1', 'FRONT', png), key('DAT1_1'))).status).toBe(409)
  await run('DAT1_1')
  const res = await artwork(put('DAT1_1', 'FRONT', png), key('DAT1_1'))
  expect(await res.json()).toMatchObject({ ok: true, version: 2, printArea: 'FRONT', artworkId: expect.any(String) })
  expect(lastEvent('DAT1_1')).toMatchObject({ type: 'ARTWORK', actorName: 'Design Agent' })
})
it('submit, reopen, notes, hold, files', async () => {
  expect(await body(submit(post('/tasks/DAT2_1/submit', {}), key('DAT2_1')))).toEqual([400, { error: expect.any(String), missing: ['Back'] }])
  expect(await body(submit(post('/tasks/DAT1_1/submit', {}), key('DAT1_1')))).toEqual([200, { ok: true, status: 'REVIEW' }])
  expect(await body(reopen(post('/tasks/DAT3_1/reopen', { reason: 'Nội bộ phát hiện lỗi', note: 'cập nhật thư viện' }), key('DAT3_1')))).toEqual([200, { ok: true, status: 'REJECTED', sent: true }])
  expect((await notes(post('/notes', { taskKey: 'NOPE_1', message: 'x' }))).status).toBe(404)
  expect(await body(hold(post('/hold', { taskKey: 'DAT4_1', reason: 'tên vượt khung' })))).toEqual([200, { ok: true, jobId: null }])
  expect((await files(get(`/files/${artOfRunningTask}`), art(artOfRunningTask))).status).toBe(200)
  expect((await files(get(`/files/${artOfOtherTask}`), art(artOfOtherTask))).status).toBe(404)
})
```
Build the upload request the way `tests/design-task-artwork-upload.integration.test.ts` does; set `DESIGN_STORAGE_DIR` to a temp folder for the file.

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-routes.integration.test.ts` — Expected: FAIL (route modules not found).
- [ ] **Step 3: Write `route-http.ts` and the ten route files.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Lint, commit** — `feat(design-agent): runner API (claim, heartbeat, result, fail, delivery, files)`

### Task 10: Library decision and `LIBRARY_APPLY` on approval

**Files:**
- Create: `src/app/api/design-agent/jobs/[id]/library/route.ts`
- Modify: `src/lib/design-agent/jobs.ts`, `src/lib/design-agent/runner.ts` (`buildAgentClaim`, `completeAgentJob`), `src/lib/design-tasks.ts` (`transitionTask` DONE branch)
- Test: `tests/design-agent-library.integration.test.ts`

**Interfaces:**
- Consumes: `requireTaskScope` (`src/lib/order-scope.ts`), `enqueueAgentJob`, `affectedForTask`.
- Produces (`jobs.ts`):
  - `decideLibrary(jobId: string, save: boolean, by: { id: string; name: string }): Promise<{ libraryState: 'YES' | 'NO'; applyJobId: string | null }>` — only from `ASKED` (else `AgentJobError('Câu hỏi này đã được trả lời', 409)`; unknown job → 404). Writes a NOTE event on the task by the user: YES → `` `Lưu thư viện: có — cập nhật ${n} đơn sau khi duyệt` `` (n = rows in `affectedJson`), NO → `Lưu thư viện: không — chỉ sửa đơn này`. YES while the task is already DONE → queues the apply job at once.
  - `queueLibraryApplyOnApproval(taskId: string, by: { id: string | null; name: string }): Promise<DesignAgentJob | null>` — the task's newest FIX job with `libraryState: 'YES'` and no job pointing at it by `parentJobId` → `enqueueAgentJob({ kind: 'LIBRARY_APPLY', source: 'LIBRARY', taskKey, parentJobId, requestedById: by.id, requestedBy: by.name, factory: <parent priority is 10>, requestText: `` `Cập nhật thư viện và các đơn cùng design ${designCode} từ bản sửa đã duyệt của ${taskKey}` `` })`. Otherwise `null`.
- `transitionTask`, `to === 'DONE'`, after the row is written: `queueLibraryApplyOnApproval(task.id, actor)`; a throw never fails the approval — it adds a SYSTEM event `` `Chưa xếp được job cập nhật thư viện: ${message}` ``.
- `buildAgentClaim` for `LIBRARY_APPLY`: `task` = the approved fixed task, `affected` = `affectedForTask` computed now (also stored back into the job's `affectedJson`, which `runningJobCovering` reads), `parent` = `{ id, summary }` of the FIX job.
- `completeAgentJob`: a `LIBRARY_APPLY` job that ends DONE sets its parent's `libraryState` to `'APPLIED'`.
- Route `POST /api/design-agent/jobs/[id]/library` `{ save: boolean }`: unknown job → 404; `requireTaskScope(req, job.taskKey)`; `save` not a boolean → 400 `save phải là true hoặc false`; answers `{ libraryState, applyJobId }`.

- [ ] **Step 1: Write the failing tests**

```ts
it('"Chỉ sửa đơn này" closes the question for good', async () => {
  expect(await decideLibrary(jNo, false, LEAD)).toEqual({ libraryState: 'NO', applyJobId: null })
  await transitionTask('DAL1_1', LEAD, { to: 'DONE' })
  expect(await prisma.designAgentJob.count({ where: { kind: 'LIBRARY_APPLY', taskKey: 'DAL1_1' } })).toBe(0)
  expect(lastNote('DAL1_1')).toBe('Lưu thư viện: không — chỉ sửa đơn này')
})
it('"Lưu thư viện" waits for the approval, then queues one LIBRARY_APPLY job', async () => {
  expect(await decideLibrary(jYes, true, LEAD)).toEqual({ libraryState: 'YES', applyJobId: null })
  expect(lastNote('DAL2_1')).toBe('Lưu thư viện: có — cập nhật 2 đơn sau khi duyệt')
  await transitionTask('DAL2_1', LEAD, { to: 'DONE' })
  const apply = await prisma.designAgentJob.findMany({ where: { parentJobId: jYes } })
  expect(apply).toMatchObject([{ kind: 'LIBRARY_APPLY', source: 'LIBRARY', status: 'QUEUED', taskKey: 'DAL2_1', requestedBy: 'Lead' }])
  await transitionTask('DAL2_1', LEAD, { to: 'DOING' }); await transitionTask('DAL2_1', LEAD, { to: 'REVIEW' }); await transitionTask('DAL2_1', LEAD, { to: 'DONE' })
  expect(await prisma.designAgentJob.count({ where: { parentJobId: jYes } })).toBe(1)
})
it('a yes given after the approval queues at once; a second answer is refused', async () => {
  expect((await decideLibrary(jLate, true, LEAD)).applyJobId).toEqual(expect.any(String))
  await expect(decideLibrary(jLate, false, LEAD)).rejects.toMatchObject({ status: 409 })
})
it('the apply claim lists the orders as they are now and names its parent', async () => {
  // after the decision: a new order #DAL9 of the design arrives, #DAL3 becomes fulfilled
  const [claim] = await claimAgentJobs(1)
  expect(claim).toMatchObject({ kind: 'LIBRARY_APPLY', parent: { id: jYes, summary: 'Đã sửa thân trước' }, task: { key: 'DAL2_1', status: 'DONE' } })
  expect(claim.affected.map(a => a.taskKey)).toEqual(['DAL4_1', 'DAL9_1'])
  expect(await runningJobCovering('DAL9_1')).toMatchObject({ id: claim.id })
})
it('a finished apply marks the fix as APPLIED', async () => {
  await completeAgentJob(applyId, { outcome: 'DONE', summary: 'Đã cập nhật 2 đơn' }); expect((await rowOf(jYes)).libraryState).toBe('APPLIED')
})
it('route: design permission and the task\'s store', async () => {
  expect((await post(jAsk, { save: 'yes' }, des)).status).toBe(400)
  expect((await post(jAsk, { save: true }, sellerOfOtherStore)).status).toBe(404)
  expect(await (await post(jAsk, { save: true }, des)).json()).toEqual({ libraryState: 'YES', applyJobId: null })
})
```

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-library.integration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement the two functions, the DONE hook, the claim and result additions, the route.**
- [ ] **Step 4: Run** the new file plus `tests/design-approve.integration.test.ts tests/design-agent-result.integration.test.ts` — Expected: PASS.
- [ ] **Step 5: Lint, commit** — `feat(design-agent): library decision and LIBRARY_APPLY after approval`

### Task 11: Agent settings API, runner token, backfill

**Files:**
- Create: `src/app/api/design-agent/settings/route.ts`, `src/app/api/design-agent/settings/runner-token/route.ts`, `src/app/api/design-agent/backfill/route.ts`
- Modify: `src/lib/design-agent/jobs.ts`
- Test: `tests/design-agent-admin.integration.test.ts`

**Interfaces:**
- Consumes: `saveAgentSettings`, `normalizeAgentSettings` (Task 1), `agentRunnerInfo`, `generateAgentRunnerToken`, `revokeAgentRunnerToken` (Task 6), `requireApiAccess`, `requireSuperadmin`.
- Produces (`jobs.ts`):
  - `agentQueueCounts(): Promise<{ queued: number; running: number; needsOwner: number; failed: number }>`
  - `backfillRejected(opts: { dryRun: boolean; by: { id: string; name: string }; factoryReasons: string[] }): Promise<{ dryRun: boolean; count: number; taskKeys: string[]; queued: number }>` — REJECTED tasks of orders that are not cancelled, refunded or fulfilled and have no QUEUED/RUNNING job, ordered by task key. Not a dry run → one FIX job each (`source: 'BACKFILL'`, `requestText` = `buildRequestText(task reasons, task note)`, `factory` when a reason is in `factoryReasons`). The routes pass `SENT_BACK_REASONS`; `jobs.ts` still does not import `design-tasks.ts`. Works with the switch off: it is a Superadmin's explicit action.
- Routes:
  - `GET /api/design-agent/settings` (`requireApiAccess`) → `{ agent, runner: agentRunnerInfo(), queue: agentQueueCounts(), rejectedBacklog: <count of a dry run> }`
  - `PUT /api/design-agent/settings` (`requireSuperadmin`) body `{ autoFixOnReject?, maxConcurrent?, leaseMinutes? }` → 400 `maxConcurrent phải là số nguyên từ 1 đến 10` / `leaseMinutes phải là số nguyên từ 5 đến 120` / `autoFixOnReject phải là true hoặc false`; else the saved `{ agent }`
  - `POST /api/design-agent/settings/runner-token` (`requireSuperadmin`) → `{ token, ...agentRunnerInfo() }`; `DELETE` → `agentRunnerInfo()`
  - `POST /api/design-agent/backfill` (`requireSuperadmin`) body `{ dryRun?: boolean }` — anything but `dryRun === false` is a dry run

- [ ] **Step 1: Write the failing tests**

```ts
it('GET shows switches, runner and queue; never the token', async () => {
  const token = await generateAgentRunnerToken()
  const res = await getSettings(asDesigner('/api/design-agent/settings'))
  expect(await res.clone().json()).toMatchObject({ agent: { autoFixOnReject: false, maxConcurrent: 5, leaseMinutes: 20 }, runner: { configured: true, online: false }, queue: { queued: 0 } })
  expect(await res.text()).not.toContain(token.slice(4))
})
it('only a Superadmin changes settings or the token', async () => {
  expect((await putSettings(asAdmin({ autoFixOnReject: true }))).status).toBe(403)
  expect((await putSettings(asSuper({ maxConcurrent: 0 }))).status).toBe(400)
  expect(await (await putSettings(asSuper({ autoFixOnReject: true, maxConcurrent: 3 }))).json()).toEqual({ agent: { autoFixOnReject: true, maxConcurrent: 3, leaseMinutes: 20 } })
  expect((await mintToken(asAdmin())).status).toBe(403)
  expect((await (await mintToken(asSuper())).json()).token).toMatch(/^dag_/)
  expect((await (await revokeToken(asSuper())).json()).configured).toBe(false)
})
it('backfill is a dry run unless told otherwise, and skips tasks that already have a job or a closed order', async () => {
  // REJECTED: DAB1_1 (plain), DAB2_1 (reason 'Xưởng trả file'), DAB3_1 (has a QUEUED job), DAB4_1 (order fulfilled)
  expect(await (await backfill(asSuper({}))).json()).toEqual({ dryRun: true, count: 2, taskKeys: ['DAB1_1', 'DAB2_1'], queued: 0 })
  expect(await prisma.designAgentJob.count({ where: { source: 'BACKFILL' } })).toBe(0)
  expect((await (await backfill(asSuper({ dryRun: false }))).json()).queued).toBe(2)
  expect(await jobOf('DAB2_1')).toMatchObject({ source: 'BACKFILL', priority: 10 })
  expect((await backfill(asAdmin({ dryRun: false }))).status).toBe(403)
})
```

- [ ] **Step 2: Run** `npx vitest run tests/design-agent-admin.integration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Implement the two functions and the three route files.**
- [ ] **Step 4: Run** — Expected: PASS.
- [ ] **Step 5: Lint, commit** — `feat(design-agent): agent settings, runner token and backfill routes`

### Task 12: Reject dialog "Lý do khác", new default reasons, dashboard bucket

**Files:**
- Create: `src/lib/reject-reasons.ts`, `src/app/design-studio/components/RejectDialog.tsx`
- Modify: `src/lib/design-settings.ts` (`DEFAULT_DESIGN_SETTINGS.rejectReasons`), `src/lib/design-tasks.ts` (REJECTED branch), `src/app/design-studio/components/TaskHeader.tsx` (lines 79–80, 143–147, 307–332), `src/app/design-studio/components/ReviewWorkspace.tsx` (lines 80–81, 91–95, 156–181), `src/app/design-studio/dashboard/page.tsx` (lines 78–82)
- Test: `tests/reject-reasons.test.ts`, one case added to `tests/design-agent-hooks.integration.test.ts`

**Interfaces:**
- Produces (`reject-reasons.ts`, no server imports — the client uses it):
  - `OTHER_REASON_LABEL = 'Lý do khác'`, `OTHER_REASON_PREFIX = 'Khác: '`, `OTHER_REASON_MIN = 3`, `OTHER_REASON_MAX = 200`
  - `isOtherReason(reason: string): boolean` (starts with `Khác:`)
  - `rejectSelection(picked: string[], otherOn: boolean, otherText: string): { reasons: string[]; error: string | null }` — `otherOn` adds `` `Khác: ${otherText.trim()}` ``; error `Lý do khác dài từ 3 đến 200 ký tự` when the trimmed text is outside 3–200; error `Chọn ít nhất một lý do` when nothing is picked
  - `rejectReasonsError(reasons: string[]): string | null` — the server check: every `Khác:` reason has 3–200 characters after the prefix
  - `rejectReasonBucket(reason: string): string` — `'Lý do khác'` for any `Khác: …`, else the reason
- `DEFAULT_DESIGN_SETTINGS.rejectReasons` = the six existing ones followed by `'Nền không đồng màu giữa các mảnh'`, `'Hoạ tiết chính nằm ngoài safe zone'`, `'Sai template đang mapping'`, `'Sai chi tiết'`.
- `transitionTask`, `to === 'REJECTED'`: `rejectReasonsError(input.reasons ?? [])` → throw that message before anything is written.
- `RejectDialog` — `export default function RejectDialog(props: { reasons: string[]; busy: boolean; onCancel: () => void; onSubmit: (reasons: string[], note: string) => void })`. It is the `<form role="dialog" aria-label="Trả lại sửa">` popover both headers render today, moved as it is (same classes: `popover`, `top-12 right-12 w-[400px] p-md flex flex-col gap-sm`), holding its own `picked` / `otherOn` / `otherText` / `note` state. Copy: title `Trả lại sửa`; `Lý do (chọn nhiều)`; after the configured chips one more chip `Lý do khác` (same chip classes, `aria-pressed`); when it is on, a one-line input (`field` class, `aria-label="Lý do khác"`, placeholder `Vd. sao trên mũ bị lệch`, `maxLength={200}`, autofocus); label `Ghi chú cho designer` with placeholder `Vd. tên đang là Emely, khách nhập Emily`; buttons `Huỷ` and `` `Trả lại · ${n} lý do` `` (disabled while `busy` or `rejectSelection(...).error`). The error text shows under the input in `text-label-sm text-error`.
- Dashboard: count with `rejectReasonBucket(r)` instead of `r`.

- [ ] **Step 1: Write the failing tests**

```ts
it('rejectSelection', () => {
  expect(rejectSelection(['Sai chi tiết'], false, '')).toEqual({ reasons: ['Sai chi tiết'], error: null })
  expect(rejectSelection(['Sai chi tiết'], true, '  sao trên mũ lệch ')).toEqual({ reasons: ['Sai chi tiết', 'Khác: sao trên mũ lệch'], error: null })
  expect(rejectSelection([], true, 'ab').error).toBe('Lý do khác dài từ 3 đến 200 ký tự')
  expect(rejectSelection([], true, 'x'.repeat(201)).error).toBe('Lý do khác dài từ 3 đến 200 ký tự')
  expect(rejectSelection([], false, '').error).toBe('Chọn ít nhất một lý do')
})
it('every "Khác: …" counts under "Lý do khác"', () => {
  expect(['Khác: sao lệch', 'Khác: thiếu viền', 'Sai chi tiết'].map(rejectReasonBucket)).toEqual(['Lý do khác', 'Lý do khác', 'Sai chi tiết'])
})
it('the defaults carry the four new reasons', () => {
  expect(DEFAULT_DESIGN_SETTINGS.rejectReasons.slice(-4)).toEqual(['Nền không đồng màu giữa các mảnh', 'Hoạ tiết chính nằm ngoài safe zone', 'Sai template đang mapping', 'Sai chi tiết'])
  expect(DEFAULT_DESIGN_SETTINGS.rejectReasons).toHaveLength(10)
})
// tests/design-agent-hooks.integration.test.ts
it('the server refuses an empty "Khác:"', async () => {
  await expect(transitionTask(reviewKey, LEAD, { to: 'REJECTED', reasons: ['Khác: a'] })).rejects.toThrow('Lý do khác dài từ 3 đến 200 ký tự')
})
```

- [ ] **Step 2: Run** `npx vitest run tests/reject-reasons.test.ts tests/design-agent-hooks.integration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Write `reject-reasons.ts`, extend the defaults, add the server check.**
- [ ] **Step 4: Write `RejectDialog.tsx`; replace both inline forms and their `reasons` / note state** — `TaskHeader`: `<RejectDialog reasons={settings.rejectReasons} busy={busy} onCancel={close} onSubmit={(r, n) => go({ to: 'REJECTED', reasons: r, note: n || undefined }, close)} />`; `ReviewHeader`: `onSubmit={async (r, n) => { if (await onReject(r, n)) close() }}`. Switch the dashboard to the bucket.
- [ ] **Step 5: Run** the two test files plus `npx vitest run tests/design-settings.integration.test.ts`, then `npx tsc --noEmit` and the lint command on the six changed files — Expected: PASS, no type or lint error.
- [ ] **Step 6: Commit** — `feat(design-studio): "Lý do khác" in the reject dialog, four new reasons, dashboard bucket`

### Task 13: Agent strip on the task page, badge in the list

**Files:**
- Create: `src/app/design-studio/components/AgentStrip.tsx`
- Modify: `src/lib/design-agent/jobs.ts`, `src/lib/design-tasks.ts` (`TaskRow`, `listTasks`, `TaskDetail`, `loadTask`), `src/app/design-studio/components/types.ts`, `src/app/design-studio/components/model.ts`, `src/app/design-studio/components/TaskHeader.tsx` (after `<SupplierStrip>`), `src/app/design-studio/components/ReviewWorkspace.tsx` (after `<VerdictStrip>`), `src/app/design-studio/components/Queue.tsx` (line 58)
- Test: `tests/design-tasks-model.test.ts` (new `describe`), `tests/design-agent-library.integration.test.ts` (one case)

**Interfaces:**
- Produces (`jobs.ts`): `type AgentTaskView = { jobId: string; kind: AgentJobKind; status: AgentJobStatus; stage: string | null; rounds: number; summary: string | null; error: string | null; requestedBy: string | null; libraryState: 'ASKED' | 'YES' | 'NO' | 'APPLIED' | null; affected: AffectedRow[]; fulfilledCount: number; apply: { status: AgentJobStatus; summary: string | null } | null }`; `agentViewForTask(taskId: string): Promise<AgentTaskView | null>` — the task's newest job that is neither `LIBRARY_APPLY` nor `CANCELLED`; `affected` / `fulfilledCount` from its `affectedJson`; `apply` = the job pointing at it by `parentJobId`.
- Produces: `TaskRow.agent: 'QUEUED' | 'RUNNING' | null` (from `openJobStatusByTask`, one query per `listTasks` call); `TaskDetail.agent: AgentTaskView | null` (from `loadTask`); both mirrored in `components/types.ts`.
- Produces (`model.ts`): `agentStripState(view: Pick<AgentTaskView, 'kind' | 'status' | 'rounds'>, taskStatus: TaskStatus): { label: string; tone: Tone; icon: string }`:

| Job status | Label | Tone / icon |
|---|---|---|
| QUEUED | `Đang chờ` | idle / `schedule` |
| RUNNING | `Đang sửa – vòng ${rounds}` (`Đang sửa` when `rounds` is 0; MAKE: `Đang làm mẫu`; MOCKUP: `Đang làm mockup`) | brand / `progress_activity` |
| DONE | `Đã sửa, chờ duyệt` when the task is in REVIEW, else `Đã sửa` (MAKE: `Đã làm mẫu, chờ duyệt` / `Đã làm mẫu`; MOCKUP: `Đã làm mockup`) | ok / `check_circle` |
| NEEDS_OWNER | `Cần chủ shop` | bad / `support_agent` |
| FAILED | `Agent không chạy được` | bad / `error` |

- `AgentStrip` — `export default function AgentStrip({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void })`; renders nothing when `detail.agent` is null. One band in the style of `SupplierStrip` (`flex flex-wrap items-center gap-x-[14px] gap-y-xs px-[20px] py-[10px] bg-surface-container-low border-t border-outline-variant/40 text-[13px] leading-[18px]`): `Icon smart_toy`, bold `Agent`, the state `Pill`, then `summary` (or `error` for FAILED) in `text-on-surface-variant`, `requestedBy` as `` `yêu cầu: ${requestedBy}` ``. Below it, by `libraryState`:
  - `ASKED`: the question `Lưu bản sửa này vào thư viện?`; a table of `affected` (first 20 rows; more → `` `và ${n} đơn khác` ``) with columns `Đơn` (`orderNumber`, `taskKey` in mono), `Ngày đặt` (`fmtDate`), `Trạng thái` (`STATUS_META[taskStatus].label`, `Chưa có task` when null), `Xưởng` (`Đã gửi xưởng` / `Chưa gửi`); when `fulfilledCount > 0` the line `` `${fulfilledCount} đơn đã giao, không sửa được` ``; two buttons — `btnPrimaryMd` `` `Lưu thư viện và cập nhật ${affected.length} đơn` `` and `btnMd` `Chỉ sửa đơn này`. Each posts `{ save }` to `` `/api/design-agent/jobs/${jobId}/library` `` with `postJson`, shows the error with `useToast().say(error, 'bad')`, then calls `onChanged()`.
  - `YES` and no `apply`: `Sẽ cập nhật sau khi bạn duyệt task này.`
  - `YES` with `apply` QUEUED/RUNNING: `Đang cập nhật thư viện và các đơn liên quan…`; with `apply` NEEDS_OWNER/FAILED: `Cập nhật thư viện chưa xong — cần chủ shop.` plus the apply summary
  - `APPLIED`: `` `Đã cập nhật thư viện và ${affected.length} đơn.` ``
  - `NO` or null: nothing more
- Queue badge: `{t.agent && <Pill tone="brand" icon="smart_toy" title={t.agent === 'RUNNING' ? 'Agent đang sửa' : 'Agent đang chờ'}>Agent</Pill>}` after the "Thư viện" pill.

- [ ] **Step 1: Write the failing tests**

```ts
describe('agentStripState', () => {
  it('names the state of the newest job', () => {
    expect(agentStripState({ kind: 'FIX', status: 'QUEUED', rounds: 0 }, 'REJECTED').label).toBe('Đang chờ')
    expect(agentStripState({ kind: 'FIX', status: 'RUNNING', rounds: 2 }, 'REJECTED').label).toBe('Đang sửa – vòng 2')
    expect(agentStripState({ kind: 'FIX', status: 'RUNNING', rounds: 0 }, 'REJECTED').label).toBe('Đang sửa')
    expect(agentStripState({ kind: 'FIX', status: 'DONE', rounds: 2 }, 'REVIEW').label).toBe('Đã sửa, chờ duyệt')
    expect(agentStripState({ kind: 'FIX', status: 'DONE', rounds: 2 }, 'DONE').label).toBe('Đã sửa')
    expect(agentStripState({ kind: 'FIX', status: 'NEEDS_OWNER', rounds: 3 }, 'REJECTED')).toMatchObject({ label: 'Cần chủ shop', tone: 'bad' })
    expect(agentStripState({ kind: 'FIX', status: 'FAILED', rounds: 0 }, 'REJECTED').label).toBe('Agent không chạy được')
    expect(agentStripState({ kind: 'MOCKUP', status: 'DONE', rounds: 0 }, 'DONE').label).toBe('Đã làm mockup')
  })
})
// tests/design-agent-library.integration.test.ts
it('the task page and the list carry the agent state', async () => {
  expect((await loadTask('DAL5_1'))!.agent).toMatchObject({ status: 'DONE', libraryState: 'ASKED', affected: [{ taskKey: 'DAL6_1' }], apply: null })
  expect((await loadTask('DAL7_1'))!.agent).toBeNull()                       // only a CANCELLED job
  expect((await listTasks({ taskKeys: ['DAL8_1', 'DAL5_1'] })).map(t => t.agent)).toEqual(expect.arrayContaining(['QUEUED', null]))
})
```

- [ ] **Step 2: Run** `npx vitest run tests/design-tasks-model.test.ts tests/design-agent-library.integration.test.ts` — Expected: FAIL.
- [ ] **Step 3: Add `agentViewForTask`, the two fields and `agentStripState`.**
- [ ] **Step 4: Write `AgentStrip.tsx`; render `<AgentStrip detail={detail} onChanged={onChanged} />` in `TaskHeader`. `ReviewHeader` has no reload callback today (`onRefresh` re-reads Shopify): give it a new prop `onChanged: () => void`, pass `refreshAll` from `ReviewWorkspace`, and render `<AgentStrip detail={detail} onChanged={onChanged} />` there. Add the badge.**
- [ ] **Step 5: Run** the two test files, `npx tsc --noEmit`, lint the changed files — Expected: PASS, clean.
- [ ] **Step 6: Commit** — `feat(design-studio): Agent strip with the library question, Agent badge in the list`

### Task 14: Agent card in Design Studio settings

**Files:**
- Create: `src/app/design-studio/components/AgentSettingsCard.tsx`
- Modify: `src/app/design-studio/settings/page.tsx` (render under `WorkerTokenCard`, line 258)

**Interfaces:**
- Consumes: the three routes of Task 11; `Card`, `Note`, `ErrorBanner`, `Icon`, `btn`, `input`, `fmtDateTime` (`ui.tsx`); `requestJson`, `postJson`, `putJson` (`model.ts`).
- Produces: `export default function AgentSettingsCard({ canManage }: { canManage: boolean })`, rendered as `<div className="mt-md max-w-3xl"><AgentSettingsCard canManage={canSave} /></div>`.
- Layout and copy (`Card icon="smart_toy" title="Agent"`; `right` = `runner đang chạy` / `runner offline` / `chưa có token`):
  - Checkbox (pattern of "Designer được duyệt design", `accent-secondary`): **`Tự sửa khi bị trả lại`** — `Khi bật, mỗi task bị "Trả lại sửa" hoặc "Mở lại để sửa" tạo một job cho Agent trên máy shop. Agent chỉ đưa task về Chờ duyệt, không bao giờ tự duyệt.`
  - Two number inputs: `Số job chạy cùng lúc` (1–10), `Phút chờ trước khi coi runner mất kết nối` (5–120). Button `Lưu cài đặt Agent` → `PUT`; status text `Đã lưu cài đặt Agent.`
  - Queue line: `` `Đang chờ ${queued} · Đang chạy ${running} · Cần chủ shop ${needsOwner} · Lỗi ${failed}` ``
  - Runner: `` `Runner gọi lần cuối: ${fmtDateTime(lastSeenAt)}` `` or `Runner chưa gọi lần nào`. Text: `Runner trên máy shop (tools/design-agent-runner) gọi /api/design-agent/runner/* bằng token này qua biến DESIGN_AGENT_TOKEN. Server chỉ lưu mã băm.` Token buttons and one-time display exactly as `WorkerTokenCard` (`Tạo token` / `Tạo token mới` / `Thu hồi`, `Token chỉ hiện một lần — chép ngay.`, confirm texts `Tạo token mới sẽ vô hiệu token cũ. Runner đang chạy phải đổi sang token mới. Tiếp tục?` and `Thu hồi token? Runner sẽ không gọi được nữa cho đến khi có token mới.`).
  - Backlog: `` `${rejectedBacklog} task đang bị trả lại chưa có job` `` and button `Xếp các task đang bị trả lại` → `POST backfill {}` → `window.confirm(`Sẽ xếp ${count} task đang bị trả lại cho Agent. Tiếp tục?`)` → `POST backfill { dryRun: false }` → `` `Đã xếp ${queued} task.` ``; the button is disabled when the count is 0.
  - `canManage` false: inputs disabled, no token or backlog buttons, the line `Chỉ Superadmin đổi được cài đặt Agent.`

- [ ] **Step 1: Write the component and render it.** No render-test pattern exists in this repo for pages; the data paths are covered by Task 11.
- [ ] **Step 2: Verify** — `npx tsc --noEmit` and the lint command on the two files: no error. Then with the dev server (`npm run dev -- --port 3002`), as a Superadmin open `/design-studio/settings`: the card shows `chưa có token`, the switch is off, saving `Số job chạy cùng lúc = 3` survives a reload, `Tạo token` shows a `dag_…` value once, `Xếp các task đang bị trả lại` asks before queueing. As a non-Superadmin the card is read-only.
- [ ] **Step 3: Run the whole agent suite** — `npx vitest run tests/design-agent-settings.integration.test.ts tests/design-agent-access.test.ts tests/design-agent-affected.integration.test.ts tests/design-agent-jobs.integration.test.ts tests/design-agent-hooks.integration.test.ts tests/design-agent-runner.integration.test.ts tests/design-agent-delivery.integration.test.ts tests/design-agent-result.integration.test.ts tests/design-agent-routes.integration.test.ts tests/design-agent-library.integration.test.ts tests/design-agent-admin.integration.test.ts tests/reject-reasons.test.ts tests/design-tasks-model.test.ts` — Expected: PASS.
- [ ] **Step 4: Commit** — `feat(design-studio): Agent card in settings (switch, limits, runner token, backlog)`

---

## Hand-over notes (not verified by this plan)

- A real runner against these routes, five jobs at once, and a 100+ MB upload through `PUT …/artwork` on the VPS.
- A design with very many open orders: the strip lists the first 20 and one `LIBRARY_APPLY` job gets them all inside the runner's 90-minute limit.
- Go-live order: deploy (migration), mint the runner token, install the runner, then turn on `Tự sửa khi bị trả lại`.
