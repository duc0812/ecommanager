# Design Tasks — luồng việc → nhóm ưu tiên: Implementation Plan (v2, on origin/main)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the `/design-studio` Design Tasks page so every open task sits in exactly one work stream (Mapping → Template → Files in → Duyệt mẫu → Duyệt sản xuất → Đã chuyển xưởng, plus Dropship) and, inside the stream, in exactly one priority group (gấp → sắp quá hạn → còn hạn), with counts that add up.

**Architecture:** Stream and group assignment are pure functions in `components/streams.ts`, fed by fields the list API already returns (`TaskRow.mapping`, `dueAt`, `status`) and one new field on handoff cards (`dueAt`). The page replaces its mode tabs and the queue's chip row with a `StreamStepper` and a `PriorityRow`; `Queue` renders the groups it is given; the production hub groups its cards by priority; the one-task-at-a-time review workspace stays. Nothing changes in task statuses, transitions, readiness, mapping verdicts, store scoping or the workspace cards.

**Tech Stack:** Next.js 14 (app router, `'use client'` pages), React, Tailwind tokens, Prisma + SQLite, vitest (`tests/*.test.ts` unit, `*.integration.test.ts` against `test.db`).

**Spec:** `docs/superpowers/specs/2026-11-21-design-tasks-stream-priority-layout-design.md` (sections 5.1–5.6 bind; **this plan's "Adjustments" block below overrides the spec where the current code differs from what the spec assumed**). Clickable reference demo: `docs/superpowers/mockups/2026-11-20-design-tasks-layout-demo.html`, button "Phương án C".

## Adjustments to the spec for the code on origin/main (controller rulings, 11/21/2026)

1. **Mapping/template facts come from `TaskRow.mapping`** (`'READY' | 'UNMAPPED' | 'NO_TEMPLATE'`, computed server-side by `mappingStates` in `src/lib/mapping-state.ts`). No new `hasSupplier`/`hasTemplate` fields: Mapping stream = `mapping === 'UNMAPPED'`; Template stream = `mapping === 'NO_TEMPLATE'` and status NEW/ASSIGNED.
2. **Dropship is a seventh stepper entry** ("Dropship", after Đã chuyển xưởng, count = the existing dropship count, no "gấp"), full width with the existing `DropshipGrid`; its row is title-only. Dropship tasks (`TaskRow.dropship`, CANCELLED) belong to no task stream.
3. **Duyệt mẫu keeps the current one-task-at-a-time workspace** (`ReviewToolbar` + `ReviewWorkspace`): the queue on the left is grouped by priority and drives `reviewSel`; "Mở task" (the workspace's `onOpenTask`) shows the full `TaskWorkspace` in place of `ReviewWorkspace` with a "← Màn duyệt" button to return. `ReviewToolbar`'s quick-approve is restricted to the review tasks currently listed (group + secondary filters).
4. **Secondary filters** in the `PriorityRow`: the readiness chips keep today's semantics (`matchesQueueFilter`, `readyLabel`, "Auto" label in Duyệt mẫu), plus "Của tôi" (client-side) and, in Files in only, "Cần làm artwork" (one row per product, `artworkProducts`). The queue's own chip row and "Của tôi" button are removed; its search box, collapsible sections, store labels and sent-line rows stay.
5. **Store filter** stays in the header and applies to the task streams (MAP/TPL/FILE/REVIEW), exactly as it applies to work/review today. **Sellers** (`useSellerReadOnly`) see only those four streams.
6. **Search:** the queue search stays global (search sections + sent lines) in the four task streams; Duyệt sản xuất gets a search box above the hub bound to the same `q`; Đã chuyển xưởng keeps `SentGrid`'s own box (bound to `q` as today); Dropship has none (as today).
7. **Workspace bands:** the existing `Banners` (Bị trả lại / Đang chờ khách trả lời, with event details) stay; the new `Flags` notes render after them. The queue's existing "Chưa mapping" / "Thiếu template" pills satisfy spec 5.1's row pill.
8. **Handoff grouping** applies inside the selected supplier tab of the production hub; the priority chips of Duyệt sản xuất count the cards loaded for that tab; "Tất cả" = their sum.
9. The old branch `worktree-design-tasks-streams` (built on stale local `main`) is reference only; `streams.ts`, `StreamStepper.tsx`, `PriorityRow.tsx`, `Flags.tsx`, `tests/design-streams.test.ts` were copied from it as starting points and are adapted in Tasks 1 and 3.

## Global Constraints

- All pages `'use client'`; Tailwind utility classes only, tokens from `tailwind.config.ts`; icons `<Icon name="…">`; card = `bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20` (`card` in `components/ui.tsx`).
- UI copy in Vietnamese; dates `en-US`. Exact labels are in the spec (5.1, 5.2, 5.4), the Adjustments above and the test assertions below — copy them verbatim.
- Tests never touch `dev.db`: vitest uses `file:./test.db`; integration tests create and delete their own fixtures. Route tests sign tokens like `tests/design-tasks-routes.integration.test.ts` does (`signToken({ userId, email, name, role, permissions: [], tv: 0 })`, cookie `AUTH_COOKIE`).
- API fields are additive only; route access rules unchanged. No schema change.
- No new task statuses, no change to `canTransition`, readiness, `mappingStates`, SLA, store scoping, Trello, bot, work board, agent jobs.
- Worktree rules: work in `.claude/worktrees/design-tasks-streams-v2` (branch `worktree-design-tasks-streams-v2`, based on `origin/main`); never switch branches; stage only the files each task names; lint with `npx eslint --no-eslintrc -c .eslintrc.json --ext .ts,.tsx <files>` (the repo's `npm run lint` fails in a nested worktree); typecheck with `npx tsc --noEmit`.
- Urgency thresholds come from one place: `urgencyOf` (`SOON_HOURS = 4`) agrees with `timeLeft` in `components/model.ts` (quá hạn = `dueAt < now`; sắp = `Math.floor((due − now) / 3.6e6) ≤ 4`; null → còn hạn).

## Review Focus

1. A task whose line is unmapped **and** REJECTED **and** overdue → stream `MAP`, group "Cần mapping gấp", never "Files in cần sửa gấp" — `streamOf`/`groupOf` tests in Task 1.
2. `dueAt === null` anywhere (task, handoff card) → "Còn hạn", sorted last, no crash — Task 1 (`urgencyOf`, `byDue`) and Task 2 (`handoffDueAt`).
3. A DONE task older than today or a CANCELLED task opened through `?task=` → stream FILE, workspace with the "không nằm trong hàng đợi" band, queue unchanged — `flagNotes` test in Task 1, manual check in Task 7.
4. Search text shows the global sections and sent lines while the stepper and chip counts keep the unsearched totals; a task picked from search switches to its stream and survives clearing — Task 6 (manual check in Task 7).
5. A seller (read-only) never sees Duyệt sản xuất / Đã chuyển xưởng / Dropship; the store filter narrows task streams only — Task 6 (manual check in Task 7).

---

### Task 1: Pure model on the current `TaskRow`, docs committed

**Files:**
- Modify: `src/app/design-studio/components/streams.ts` (copied from the old branch; adapt)
- Test: `tests/design-streams.test.ts` (copied; adapt)
- Commit also: `docs/superpowers/specs/2026-11-21-design-tasks-stream-priority-layout-design.md`, `docs/superpowers/plans/2026-11-21-design-tasks-stream-priority-layout.md`, `docs/superpowers/mockups/2026-11-20-design-tasks-layout-demo.html` (already in the worktree, untracked)

**Interfaces:**
- Consumes: `TaskRow` from `./types` (`status`, `dueAt`, `mapping`, `dropship`, `readiness`), `Tone` from `./model`.
- Produces (all exported from `streams.ts`; keep what the copied file already has unless listed):
  ```ts
  export type StreamId = 'MAP' | 'TPL' | 'FILE' | 'REVIEW' | 'HANDOFF' | 'SENT' | 'DROPSHIP'
  export const STREAMS: StreamDef[]   // MAP 'Mapping' account_tree 'fulfillment / leader' task · TPL 'Template' dashboard_customize 'leader / người dựng template' task ·
                                       // FILE 'Files in' brush 'designer' task · REVIEW 'Duyệt mẫu' fact_check 'leader' task · HANDOFF 'Duyệt sản xuất' precision_manufacturing 'fulfillment' đơn ·
                                       // SENT 'Đã chuyển xưởng' local_shipping 'theo dõi' đơn · DROPSHIP 'Dropship' inventory 'không cần design — map xưởng rồi gửi' đơn
  export const TASK_STREAMS: StreamId[] = ['MAP', 'TPL', 'FILE', 'REVIEW']
  export type StreamTask = Pick<TaskRow, 'status' | 'dueAt' | 'mapping' | 'dropship'>
  export function streamOf(t: Pick<StreamTask, 'status' | 'mapping' | 'dropship'>): StreamId | null
    // CANCELLED → null (dropship tasks are CANCELLED); DONE → 'FILE'; mapping 'UNMAPPED' → 'MAP'; mapping 'NO_TEMPLATE' && status NEW|ASSIGNED → 'TPL'; REVIEW → 'REVIEW'; else 'FILE'
  export type StreamCounts = Record<StreamId, { total: number | null; overdue: number }>
  export function streamCounts(tasks: StreamTask[], handoff: { count: number; overdue: number }, dropship: number | null, now?: number): StreamCounts
    // task streams: open statuses only (OPEN_TASK_STATUSES); HANDOFF from the API numbers; SENT.total = null; DROPSHIP = { total: dropship, overdue: 0 }
  export type FlagInput = { status: TaskStatus; dueAt: string | null; readiness: Readiness; mapping: TaskRow['mapping']; stream: StreamId | null; inQueue: boolean; productPageHref: string | null }
  export function flagNotes(input: FlagInput, now?: number): FlagNote[]
    // order: outside (DONE/CANCELLED && !inQueue, alone) → [] for DONE/CANCELLED when inQueue → overdue (open status, OVER; wording by stream: MAP 'cần mapping gấp', TPL 'cần dựng template gấp', REVIEW 'cần duyệt gấp', else 'cần file in gấp')
    //   → blocked ('chưa map xưởng → Mở Product Mapping' when mapping UNMAPPED; 'chưa có template in → Mở Tồn đọng · Mở trang sản phẩm' only when stream TPL; ends "Task này không render tự động được cho tới khi gỡ xong")
    //   → no-template (mapping NO_TEMPLATE, status not NEW/ASSIGNED: 'Không có template —' / 'tự kiểm tra khổ file trước khi gửi duyệt') → low (open, readiness LOW, mapping READY, no blocked/no-template)
  ```
  Everything else (`urgencyOf`, `SOON_HOURS`, `OPEN_TASK_STATUSES`, `PriorityGroupDef`, `TASK_GROUPS` with the FILE/MAP/TPL/REVIEW groups and their exact ids/titles/subs/tones, `HANDOFF_GROUPS`, `groupOf`, `byDue`, `groupTasks`, `groupCounts`, `FlagNote`) stays as in the copied file. Group ids/titles (unchanged): FILE `FI_URGENT` "Files in gấp" · `FI_FIX_URGENT` "Files in cần sửa gấp" · `FI_SOON` "Sắp quá hạn" · `FI_FIX` "Cần sửa" · `FI_ASK` "Chờ khách trả lời" · `FI_OK` "Còn hạn" · `FI_DONE` "Xong hôm nay"; MAP `MP_URGENT` "Cần mapping gấp" · `MP_SOON` · `MP_OK`; TPL `TP_URGENT` "Thiếu template gấp" · `TP_SOON` · `TP_OK`; REVIEW `RV_URGENT` "Quá hạn — cần duyệt gấp" · `RV_SOON` "Sắp quá hạn — cần duyệt" · `RV_OK` "Còn hạn"; HANDOFF `HO_URGENT` "Quá hạn — cần gửi xưởng gấp" · `HO_SOON` "Sắp quá hạn" · `HO_OK` "Còn hạn".

- [ ] **Step 1: Adapt the test file first** — replace every `hasSupplier`/`hasTemplate` in `tests/design-streams.test.ts`: the `task()` helper becomes `({ taskKey: 'K', status: 'NEW', dueAt: at(10), mapping: 'READY', dropship: false, readiness: 'AUTO', ...over })`; "unmapped" cases use `mapping: 'UNMAPPED'`, "no template" cases `mapping: 'NO_TEMPLATE'`; add to the `streamOf` describe:

```ts
    expect(streamOf(task({ status: 'CANCELLED', dropship: true }))).toBeNull()
    expect(streamOf(task({ status: 'DONE', mapping: 'UNMAPPED' }))).toBe('FILE')
    expect(STREAMS.map(s => s.id)).toEqual(['MAP', 'TPL', 'FILE', 'REVIEW', 'HANDOFF', 'SENT', 'DROPSHIP'])
```
and change the `streamCounts` expectation to the new signature `streamCounts(tasks as any, { count: 7, overdue: 2 }, 3, NOW)` with `DROPSHIP: { total: 3, overdue: 0 }` added to the expected object. In the `flagNotes` block replace `hasSupplier: false` by `mapping: 'UNMAPPED'`, `hasTemplate: false` by `mapping: 'NO_TEMPLATE'`, and `hasSupplier: true, hasTemplate: true` by `mapping: 'READY'`; keep every expected string.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/design-streams.test.ts`
Expected: FAIL on the new `mapping`-based cases / type shape.

- [ ] **Step 3: Adapt `streams.ts`** per the Interfaces block (`StreamTask`, `streamOf`, `STREAMS` + `TASK_STREAMS`, `streamCounts` third parameter, `FlagInput`/`flagNotes` on `mapping`).

- [ ] **Step 4: Run the tests and typecheck**

Run: `npx vitest run tests/design-streams.test.ts` then `npx tsc --noEmit`
Expected: PASS; `tsc` reports errors only in the three copied components (`StreamStepper.tsx`, `PriorityRow.tsx`, `Flags.tsx` — fixed in Task 3) and nowhere else.

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-11-21-design-tasks-stream-priority-layout-design.md docs/superpowers/plans/2026-11-21-design-tasks-stream-priority-layout.md docs/superpowers/mockups/2026-11-20-design-tasks-layout-demo.html src/app/design-studio/components/streams.ts tests/design-streams.test.ts
git commit -m "feat(design-studio): stream/priority model on TaskRow.mapping; spec, plan and demo"
```

---

### Task 2: Handoff `dueAt`, `countOverdueHandoff`, `handoffOverdue` on the tasks route

**Files:**
- Modify: `src/lib/handoff-shared.ts` (`HandoffCard`, ~line 96)
- Modify: `src/lib/supplier-handoff.ts` (`TASK_GATE` line 90, `StateOrder` ~line 111, `countPendingHandoff` ~line 106, `buildCards` card push ~line 373)
- Modify: `src/app/api/design-studio/tasks/route.ts` (lines 78–83)
- Test: `tests/design-streams-api.integration.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // handoff-shared.ts
  export type HandoffCard = { …existing…; /** Earliest design-task due among the order's non-cancelled tasks; null when none has a due. */ dueAt: string | null }
  // supplier-handoff.ts
  export function handoffDueAt(tasks: { status: string; dueAt: Date | null }[]): Date | null
  export async function countOverdueHandoff(opts: { storeIds?: string[] | null; now?: Date } = {}): Promise<number>
    // = ordersWithReadyLines(same where as countPendingHandoff).filter(o => (handoffDueAt(o.designTasks)?.getTime() ?? Infinity) < now).length
  ```
  `TASK_GATE.select` gains `dueAt: true` (so `ordersWithReadyLines`, `STATE_INCLUDE` and `StateOrder.designTasks` carry it; `StateOrder.designTasks` type gains `dueAt: Date | null`). Tasks route response gains `handoffOverdue: number` computed with the same `storeIds` as `handoffCount`.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/design-streams-api.integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { countOverdueHandoff, countPendingHandoff, handoffDueAt, listHandoffHub } from '@/lib/supplier-handoff'
import { GET as getTasks } from '@/app/api/design-studio/tasks/route'

describe('handoffDueAt', () => {
  it('ignores cancelled tasks and null dues', () => {
    expect(handoffDueAt([{ status: 'DONE', dueAt: new Date(5000) }, { status: 'CANCELLED', dueAt: new Date(1000) }, { status: 'DONE', dueAt: null }])).toEqual(new Date(5000))
    expect(handoffDueAt([{ status: 'DONE', dueAt: null }])).toBeNull()
    expect(handoffDueAt([])).toBeNull()
  })
})

describe('pending handoff orders carry the design due', () => {
  // Fixture: copy the shape of makeOrder({ approve: true }) in tests/supplier-handoff.integration.test.ts (project, store, CSV supplier,
  // one customized line with a print file and a DONE design task), with ids prefixed `dsp2-`; then set the task's dueAt to 2026-11-02T00:00:00Z.
  let orderId = ''
  let token = ''
  beforeAll(async () => { /* create the fixture; token = await signToken({ userId, email: 'dsp2@dt.test', name: 'Dsp2', role: 'ADMIN', permissions: [], tv: 0 }) */ })
  afterAll(async () => { /* delete the order, supplier, user */ })

  it('the hub card shows the earliest non-cancelled due and the order counts as overdue', async () => {
    expect(await countPendingHandoff()).toBeGreaterThanOrEqual(1)
    const hub = await listHandoffHub({ q: orderId.slice(-6) })
    const card = hub.pending.find(c => c.order.id === orderId)!
    expect(card.dueAt).toBe('2026-11-02T00:00:00.000Z')
    const before = await countOverdueHandoff({ now: new Date('2026-10-15T00:00:00Z') })
    expect(await countOverdueHandoff({ now: new Date('2026-11-03T00:00:00Z') })).toBe(before + 1)
  })
  it('GET /api/design-studio/tasks returns handoffOverdue', async () => {
    const req = new NextRequest('http://x/api/design-studio/tasks')
    req.cookies.set(AUTH_COOKIE, token)
    const body = await (await getTasks(req)).json()
    expect(typeof body.handoffOverdue).toBe('number')
    expect(body.handoffOverdue).toBeGreaterThanOrEqual(1)
  })
})
```
If the fixture does not appear in `listHandoffHub().pending`, align it with `readyLines` / `pendingHandoffWhere` (`SEND_STATUSES`, the task gate) by reading `tests/supplier-handoff.integration.test.ts`'s `makeOrder` and `approve` steps — the test is about the new fields, not the gate.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/design-streams-api.integration.test.ts`
Expected: FAIL — `handoffDueAt` not exported.

- [ ] **Step 3: Implement** per the Interfaces block.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/design-streams-api.integration.test.ts tests/supplier-handoff.integration.test.ts tests/design-tasks-routes.integration.test.ts` and `npx tsc --noEmit`
Expected: PASS (the copied components may still fail `tsc` until Task 3 — nothing else).

- [ ] **Step 5: Commit**

```bash
git add src/lib/handoff-shared.ts src/lib/supplier-handoff.ts src/app/api/design-studio/tasks/route.ts tests/design-streams-api.integration.test.ts
git commit -m "feat(design-studio): handoff cards carry the order's design due; tasks API counts overdue handoff orders"
```

---

### Task 3: `StreamStepper`, `PriorityRow`, `Flags` on the current code

**Files:**
- Modify: `src/app/design-studio/components/StreamStepper.tsx`, `PriorityRow.tsx`, `Flags.tsx` (copied; adapt)

**Interfaces:**
- Consumes: `STREAMS`, `StreamCounts`, `StreamId`, `PriorityGroupDef`, `flagNotes` from `./streams`; `READY_META`, `chip`, `card`, `Icon`, `TEXT_TONE`, `Pill` from `./ui`; `QueueFilter`, `MAPPING_FILTER_LABEL`, `productPageUrl` from `./model`; `TaskDetail` from `./types`; `Link` from `next/link`.
- Produces:
  ```tsx
  export default function StreamStepper({ counts, active, streams, onSelect }: { counts: StreamCounts; active: StreamId; streams: StreamId[]; onSelect: (id: StreamId) => void })
    // renders the entries of STREAMS whose id is in `streams`, in STREAMS order; chevron between entries; count badge omitted when total === null; "N gấp" badge when overdue > 0; no check marks
  export type SecondaryFilter = 'ALL' | 'AUTO' | 'LOW' | 'MANUAL' | 'NEEDS_ARTWORK'
  export default function PriorityRow(props: {
    stream: StreamDef; total: number; unit: 'task' | 'đơn'
    groups: { def: PriorityGroupDef<any>; count: number }[]; group: string | null; onGroup: (id: string | null) => void
    secondary: { filter: SecondaryFilter; onFilter: (f: SecondaryFilter) => void; autoLabel: string; counts: Record<SecondaryFilter, number>; needsArtwork: boolean; mine: boolean; onMine: () => void } | null
    titleOnly?: boolean
  })
    // header: icon · title · "{who} · {total} {unit} · nhóm ưu tiên từ trái sang phải, bấm để lọc" (titleOnly: icon · title · who only);
    // right side when `secondary`: "Lọc thêm:" + chips AUTO (label = autoLabel) / LOW / MANUAL (+ NEEDS_ARTWORK "Cần làm artwork" when needsArtwork) each with its count, clicking the active one returns to 'ALL'; "Của tôi" chip
    // body: "Tất cả {total}" + one chip per group (tone colours, icon by tone bad→local_fire_department warn→schedule else check_circle, opacity-50 at 0, ring-2 ring-secondary when active, title={def.sub}); count pills bg-surface-container-lowest
  export function GroupHeader({ def, count }: { def: PriorityGroupDef<any>; count: number })
  export default function Flags({ detail, stream, inQueue }: { detail: TaskDetail; stream: StreamId | null; inQueue: boolean })
    // renders one <Note tone icon><b>{title}</b> {text} + <Link className="underline"> per flagNotes({ ...detail.task fields, mapping: detail.task.mapping, stream, inQueue, productPageHref: detail.profileRouteKey ? productPageUrl(detail.profileRouteKey) : null }); nothing else (the page's Banners already show Bị trả lại / Đang chờ khách)
  ```

- [ ] **Step 1: Adapt the three components** to the props above (remove the `hasSupplier`/`hasTemplate` usage and the old "Bị trả lại" note from `Flags`).
- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean; `npx eslint --no-eslintrc -c .eslintrc.json --ext .ts,.tsx src/app/design-studio/components/StreamStepper.tsx src/app/design-studio/components/PriorityRow.tsx src/app/design-studio/components/Flags.tsx` clean.
- [ ] **Step 3: Commit**

```bash
git add src/app/design-studio/components/StreamStepper.tsx src/app/design-studio/components/PriorityRow.tsx src/app/design-studio/components/Flags.tsx
git commit -m "feat(design-studio): stream stepper, priority row and workspace flags components"
```

---

### Task 4: `Queue` renders caller-provided groups; its chip row moves out

**Files:**
- Modify: `src/app/design-studio/components/Queue.tsx`

**Interfaces:**
- Produces:
  ```ts
  export type QueueGroup = { key: string; title: string; tone: Tone; rows: TaskRow[] }
  export default function Queue(props: {
    tasks: TaskRow[]; groups: QueueGroup[]; sel: string | null; onSelect: (key: string) => void
    q: string; onQ: (v: string) => void; loading: boolean; error: string; retrying: boolean
    emptyText: string; onClearFilters: (() => void) | null
    showStore?: boolean; sentLines?: SentLineRow[]; selLine?: string | null; onSelectLine?: (lineId: string) => void
    artworkWaiting?: Map<string, number>; needsArtworkMode?: boolean
  })
  ```
  Behaviour: when `q.trim()` is non-empty, group `tasks` by `SEARCH_SECTIONS` and list sent lines exactly as today; otherwise render `groups` as given (rows already sorted), each group collapsible like today's sections, header coloured `TEXT_TONE[tone]` + `font-semibold` for `bad`/`warn` (unchanged colour for `idle`/`ok`). The `waiting` pill ("N đơn chờ") shows when `needsArtworkMode && artworkWaiting`. Remove the filter chip row, the "Của tôi" button and the `filter/onFilter/counts/mine/onMine/autoLabel` props; keep `byDue` exported (the page imports it) and `SECTIONS`-derived `SEARCH_SECTIONS`. `QueueRow` unchanged (its "Chưa mapping" / "Thiếu template" pills stay).

- [ ] **Step 1: Make the change.**
- [ ] **Step 2: Verify** — `npx tsc --noEmit`: exactly the errors in `page.tsx` caused by the removed props (fixed in Task 6), nothing else; eslint on `Queue.tsx` clean.
- [ ] **Step 3: Commit**

```bash
git add src/app/design-studio/components/Queue.tsx
git commit -m "refactor(design-studio): Queue renders caller-provided priority groups; filter chips move to the priority row"
```

---

### Task 5: Hub grouped by priority, due pill on hub cards, review quick-approve restricted to the listed tasks

**Files:**
- Modify: `src/app/design-studio/components/HandoffGrid.tsx` (grid at ~lines 190–195), `HubCard.tsx` (header row ~lines 44–52), `ReviewToolbar.tsx`

**Interfaces:**
- Consumes: `HANDOFF_GROUPS`, `groupOf`, `byDue` from `./streams`; `GroupHeader` from `./PriorityRow`; `timeLeft` from `./model`; `HandoffCard.dueAt` (Task 2).
- Produces (props added, optional):
  ```ts
  HandoffGrid: { …; group?: string | null; onGroupCounts?: (counts: Record<string, number>) => void }
    // inside the selected tab: pending (sorted by dueAt via byDue on { dueAt: c.dueAt }) rendered per HANDOFF_GROUPS group as <GroupHeader def count> + the existing card grid; empty groups omitted; `group` filters to one group;
    // onGroupCounts(counts over all loaded pending cards, every group id present) after each successful load — hold the callback in a ref, not in load's deps;
    // when a group is active and has no cards but pending is not empty: the existing empty-state card with "Không có đơn nào trong nhóm này."
  HubCard: when c.dueAt is set, a <span title="Hạn design sớm nhất của đơn"><Pill tone icon>{label}</Pill></span> from timeLeft({ status: 'DOING', dueAt: c.dueAt }) placed in the header row before the country code
  ReviewToolbar: { total; version; onApproved; only?: string[] }   // `clean` is intersected with `only` when given, so quick-approve only touches the review tasks the queue currently lists
  ```

- [ ] **Step 1: Make the changes.**
- [ ] **Step 2: Verify** — `npx tsc --noEmit` (only the Task 4 `page.tsx` errors remain); eslint on the three files clean.
- [ ] **Step 3: Commit**

```bash
git add src/app/design-studio/components/HandoffGrid.tsx src/app/design-studio/components/HubCard.tsx src/app/design-studio/components/ReviewToolbar.tsx
git commit -m "feat(design-studio): production hub grouped by priority with design-due pills; review quick-approve limited to listed tasks"
```

---

### Task 6: Wire the page — streams, groups, URL, body layout

**Files:**
- Modify: `src/app/design-studio/page.tsx` (whole `DesignTasks` component)

**Interfaces:**
- Consumes: everything from Tasks 1–5; spec 5.3, 5.4, 5.6 as adjusted above.
- Produces: the page. State (replaces `mode`): `stream: StreamId` (from `?stream=` when valid for this user, else `'FILE'`), `group: string | null` (from `?group=`), `taskOpen: boolean` (REVIEW: full workspace shown instead of `ReviewWorkspace`), `filter: SecondaryFilter`, `mine` (client-side `t.assigneeId === me.id`; drop the `mine` query param), `q`, `sel`, `reviewSel`, `selLine`, `now` (60 s interval), `handoffOverdue`, `handoffGroupCounts: Record<string, number> | null`, `baseTasks` (last list loaded without a search term), `pinned: string | null`.

- [ ] **Step 1: Rewrite the component**
  1. `loadList` keeps `q` and `listStoreId` (store filter) but not `mine`; stores `handoffOverdue`; sets `baseTasks` only when `debouncedQ` is empty.
  2. Derived: `streamTasks = baseTasks.filter(t => streamOf(t) === stream)`; `secondary` = `streamTasks` filtered by `matchesQueueFilter(t, filter, stream === 'REVIEW')` (`'NEEDS_ARTWORK'` → `artworkProducts(streamTasks).rows`) and by `mine`; `visible = groupTasks(stream, secondary, group, now)` for task streams; `queueGroups` from it; `counts = streamCounts(baseTasks, { count: handoffCount, overdue: handoffOverdue }, dropshipCount ?? null, now)`; `rowGroups` from `groupCounts(stream, secondary, now)` for task streams, from `handoffGroupCounts` for HANDOFF; `total` = sum of the group counts (HANDOFF: `handoffCount` until the hub reported); secondary chip counts like today's `counts` memo but over `streamTasks`.
  3. Streams offered: `readOnly ? TASK_STREAMS : all`; a `?stream=` outside that set falls back to `'FILE'`.
  4. Selection: in MAP/TPL/FILE, `sel` falls back to the first visible row when neither in `flat` nor pinned; in REVIEW, `reviewSel` follows `visible` as today's `reviewTasks` effect; nothing is auto-selected for HANDOFF/SENT/DROPSHIP.
  5. `selectTask(key)` (queue rows, "Mở task" from the review workspace, hub cards, sent grid, sent-line panel): find the task in `tasks` then `baseTasks`; target = `streamOf(t)` when it is a task stream, else `'FILE'`; switch stream (clearing `group`) when it differs; pin the key when it is not in the target's visible list; in REVIEW set `reviewSel = key` and `taskOpen = true`; in other task streams set `sel = key`, `selLine = null`.
  6. `?task=` on arrival (once per value, after the first load): same routing as `selectTask`; `task` wins over `stream`.
  7. URL sync via `router.replace` only when it differs from the current params: `stream` (omitted for FILE), `group` when set, `task` = `sel` in MAP/TPL/FILE, `reviewSel` in REVIEW only when `taskOpen`, nothing otherwise. Readiness, mine and search text never go to the URL.
  8. `setStream(id)` clears `group`, `taskOpen`, `pinned`.
  9. JSX, top to bottom: header (title + info icon, `StoreFilter` when `stream ∈ TASK_STREAMS`, sync button with its tooltip — the mode `tablist` is deleted) → `syncError` / `DriveHealthBanner` → `<StreamStepper counts active={stream} streams onSelect={setStream}>` → `<PriorityRow …>` (`secondary` for task streams with `autoLabel = stream === 'REVIEW' ? 'Auto' : READY_META.AUTO.label` and `needsArtwork = stream === 'FILE'`; `titleOnly` for SENT and DROPSHIP; HANDOFF without `secondary`) → body:
     - MAP/TPL/FILE: `grid grid-cols-[290px_minmax(0,1fr)]` with `<Queue tasks={tasks} groups={queueGroups} sel … showStore sentLines selLine onSelectLine artworkWaiting needsArtworkMode={filter === 'NEEDS_ARTWORK'}>` and the right column: `SentLinePanel` when a sent line is picked, else the existing loading/error/empty cards and `<LightboxProvider><Flags detail stream={streamOf(current.task) ?? stream} inQueue={baseTasks.some(t => t.taskKey === sel)} /><TaskWorkspace …/></LightboxProvider>` (the `Flags` go inside `TaskWorkspace` right after `Banners`); an empty stream with nothing pinned shows "Luồng này không có task nào." (the "Chưa có task nào. Bấm nút đồng bộ…" copy only when `baseTasks` is empty).
     - REVIEW: same grid; right column = `taskOpen && reviewSel ? (<button className={btn} onClick={() => setTaskOpen(false)}><Icon name="arrow_back" />Màn duyệt</button> + the full workspace for reviewSel) : (<ReviewToolbar total={visible rows} only={visible keys} version onApproved …> + <ReviewWorkspace …> as today)`.
     - HANDOFF: a search box above the hub (same markup as the queue's, placeholder "Tìm đơn, task ID, SKU…", bound to `q`/`setQ`, spinner on `listLoading`) + `<HandoffGrid q={debouncedQ} version group onGroupCounts={setHandoffGroupCounts} onOpenTask={selectTask} onChanged={reload} />` full width.
     - SENT: `<SentGrid …>` full width as today. DROPSHIP: `<DropshipGrid …>` full width as today (its `onSend` switches to HANDOFF with `q` set, as today).
  10. `emptyText`/`clearFilters` also reset `group`; `reviewMoved` keeps its behaviour over the new `visible` review rows; `holdCount` over `baseTasks`; delete `Mode`, `tabs`, `shownTabs`, the old `counts`/`reviewCount` memos.

- [ ] **Step 2: Verify** — `npx tsc --noEmit` clean; `npx eslint --no-eslintrc -c .eslintrc.json --ext .ts,.tsx src/app/design-studio/page.tsx` clean; `npx vitest run tests/design-streams.test.ts tests/design-streams-api.integration.test.ts tests/design-tasks-routes.integration.test.ts` PASS.

- [ ] **Step 3: Commit**

```bash
git add src/app/design-studio/page.tsx
git commit -m "feat(design-studio): Design Tasks page organised by work stream and priority group"
```

---

### Task 7: Docs, full verification, browser check

**Files:**
- Modify: `NOTES.md` (Design Tasks v2 section, after the intro at ~line 334; the "UI." bullet at ~line 389 about the "Chuyển xưởng N" chip must be rewritten), the spec (status line → "đã code, xem plan …"; new section "8. Điều chỉnh khi code trên origin/main" = the Adjustments block of this plan in Vietnamese)

- [ ] **Step 1: Write the NOTES.md paragraph**: stream → priority organisation; `streams.ts` rules (`streamOf` on `mapping`, DONE → Files in even when unmapped, dropship tasks in no stream); components; `HandoffCard.dueAt` (= earliest non-cancelled task due; owner decision 11/21: production urgency = design overdue); `handoffOverdue`; URL params; search global with counts from the last unsearched list; "Của tôi" client-side; Dropship as the seventh stream; sellers see four streams. Rewrite the stale "Chuyển xưởng N" bullet.
- [ ] **Step 2: Full run** — `npx vitest run` (expect green except pre-existing failures, which the report names), `npx tsc --noEmit`, eslint on `src/app/design-studio src/lib/supplier-handoff.ts src/lib/handoff-shared.ts src/app/api/design-studio/tasks/route.ts`.
- [ ] **Step 3: Browser check (controller, dev server from this worktree on port 3016 against a copy of the production snapshot, logged in as a leader and as a seller)**: stepper totals add up to the open-task count; each stream's chips add up; Files in groups in spec order; Duyệt mẫu queue grouped with `ReviewWorkspace`, "Mở task" → full workspace + "Màn duyệt" back; Duyệt sản xuất hub tabs with priority headers and due pills, search box above; Đã chuyển xưởng and Dropship unchanged; `?task=` for an old DONE / CANCELLED / unmapped task; search then stream switch; store filter narrows task streams only; seller sees four streams; no console errors.
- [ ] **Step 4: Commit**

```bash
git add NOTES.md docs/superpowers/specs/2026-11-21-design-tasks-stream-priority-layout-design.md docs/superpowers/plans/2026-11-21-design-tasks-stream-priority-layout.md
git commit -m "docs(design-studio): notes and spec adjustments for the stream/priority Design Tasks layout"
```
