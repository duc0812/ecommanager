# CS Insights & Staff Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Attribute every problem ticket to a pipeline stage with evidence, report issue statistics on `/cs/insights`, and measure + review the CS staff's replies on `/cs/performance` with a periodic improvement write-up.

**Architecture:** Two new LLM passes ride on the existing 2-min agent cycle: a root-cause investigation (problem tickets, fed a deterministic order timeline) and a reply review (per ticket, grades every staff reply and tags every customer message with a sentiment). Deterministic metrics (`src/lib/cs/performance.ts`) read `CsMessage` plus Freshdesk `stats` timestamps stored on `CsTicket`. Pages and routes follow the `/cs` conventions; the LLM layer gains one generic structured-output call used by all passes.

**Tech Stack:** Next.js 14 app router, Prisma 7/SQLite, node-cron, `@anthropic-ai/sdk` + Kie Responses adapter (`src/lib/llm/*`), zod, vitest. Plain SVG/CSS bars for charts (no chart library).

**Spec:** `docs/superpowers/specs/2026-10-24-cs-insights-performance-design.md` (builds on `2026-10-23-customer-service-agent-design.md`)

## Global Constraints

- Schema change workflow: `npx prisma migrate dev --name <name> && npx prisma generate`, bump `SCHEMA_VERSION` in `src/lib/db.ts` (`'v73'` → `'v74'`). Never add `url` to `datasource db`.
- Tests run on `test.db`; integration tests create and delete their own fixtures.
- Every `/api/cs/*` route is covered by `{ prefix: '/api/cs', access: ['cs'] }`; add `{ prefix: '/api/cs/review', methods: WRITE, access: 'SUPERADMIN' }` before it and call `requireSuperadmin` in that route.
- LLM calls: one generic `Llm.complete()` (Task 2). Daily cap `cs.llmDailyCallCap` default 500 across every pass; a pass that would exceed it is skipped for the day and logged `[cs] llm daily cap reached`.
- Cycle budgets: ≤5 root-cause investigations and ≤5 reviews per 2-min cycle; backfill ≤20 LLM calls per minute, resumable.
- Closed tickets (fdStatus 4/5): never written back to Freshdesk, never alerted.
- Stage values: `DESIGN | FULFILLMENT | FACTORY | CARRIER | CUSTOMER | LISTING | UNKNOWN`. Issue types: `WRONG_TEXT, WRONG_IMAGE, WRONG_SIZE_COLOR, PRINT_QUALITY, DAMAGED_IN_TRANSIT, LATE_DESIGN, LATE_HANDOFF, LATE_PRODUCTION, LATE_SHIPPING, LOST, NOT_AS_DESCRIBED, CUSTOMER_INPUT, OTHER`. Rubric issues: `IGNORED_QUESTION, ASKED_PHOTO_AS_PROOF, TEMPLATE_ONLY, NO_RESOLUTION, WRONG_FACT, PROMISED_FORBIDDEN, TONE, CLOSED_UNRESOLVED, TOO_SLOW, GOOD`. Message sources: `FRESHDESK | OWN | DRAFT_EDITED | DRAFT_UNCHANGED | AGENT`.
- Lateness budgets from settings: design ≤ 2 calendar days, handoff gap ≤ 2 days, production ≤ `productionDays` (5) calendar days, transit ≤ `shippingDays` (15), no scan for ≥ 7 days = stalled. Week = Monday–Sunday Asia/Ho_Chi_Minh. `TOO_SLOW` = first/next response > 24 h.
- Copy: labels Vietnamese, dates `MM/DD/YYYY`, quotes from customers/staff kept in English. Page shell and card classes as in `src/app/cs/page.tsx`.

## Review Focus

1. A ticket whose order was placed before Design Studio (no `DesignTask`, `supplierHandoffAt` null, `exportedAt` set) must get a timeline that uses `exportedAt` as the hand-off and can never be attributed `LATE_DESIGN`/`LATE_HANDOFF` — test in Task 4.
2. A customer message that arrives after `fdResolvedAt` must count as a premature close even when Freshdesk never set `reopened_at` — test in Task 3.
3. A staff reply whose body equals the latest `draftReply` (ignoring whitespace) must be stored as `DRAFT_UNCHANGED` and must not appear in the staff reply-count or review — tests in Tasks 3 and 6.
4. Reaching the daily LLM cap mid-cycle must stop further LLM calls that day without marking tickets as reviewed/investigated — test in Task 2 and Task 7.
5. The insights CSV must contain exactly the filtered rows and escape commas/quotes in evidence text — test in Task 9.

---

### Task 1: Schema and settings

**Files:**
- Modify: `prisma/schema.prisma` (CsTicket, CsMessage, CsAnalysis; append CsReplyReview, CsPerformanceReport), `src/lib/db.ts:7`, `src/lib/cs/settings.ts`, `src/lib/api-access.ts`
- Test: `tests/cs-settings.integration.test.ts` (extend)

**Interfaces:**
- Produces Prisma columns: `CsTicket.closedAt DateTime?`, `reopenCount Int @default(0)`, `fdFirstRespondedAt DateTime?`, `fdResolvedAt DateTime?`, `fdClosedAt DateTime?`, `fdReopenedAt DateTime?`, `rootCauseStageOverride String?`, `rootCauseNote String?`, `rootCauseById String?`, `reviewedAt DateTime?`, `reviewSeq Int @default(0)`; `CsMessage.sentiment String?`, `source String @default("FRESHDESK")`; `CsAnalysis.rootCauseStage String?`, `rootCauseEvidence String?`, `rootCauseConfidence String?`, `issueType String?`, `affectedLineIds String @default("[]")`, `rootCauseAt DateTime?`.
- `model CsReplyReview { id, ticketId (→CsTicket cascade), messageId String, score Int, issues String @default("[]"), reason String, rewrite String?, runAt DateTime @default(now()), model String, @@unique([messageId]) @@index([ticketId]) }`
- `model CsPerformanceReport { id, periodStart DateTime, periodEnd DateTime, kind String, metricsJson String, body String, createdAt DateTime @default(now()), @@index([periodStart]) }`
- Settings additions on `CsSettings`: `reviewEnabled: boolean (true)`, `weeklyReport: boolean (true)`, `reviewModel: string | null (null = model)`, `llmDailyCallCap: number (500)`.

- [ ] **Step 1: Failing settings test** — add to `tests/cs-settings.integration.test.ts`:
```ts
it('review settings default on with a 500 call cap', async () => {
  const s = await getCsSettings()
  expect(s.reviewEnabled).toBe(true); expect(s.weeklyReport).toBe(true); expect(s.reviewModel).toBeNull(); expect(s.llmDailyCallCap).toBe(500)
  await saveCsSettings({ reviewModel: ' GPT 6 Luna ', llmDailyCallCap: 50 })
  const t = await getCsSettings(); expect(t.reviewModel).toBe('gpt-6-luna'); expect(t.llmDailyCallCap).toBe(50)
})
```
- [ ] **Step 2: Run → FAIL** (`npx vitest run tests/cs-settings.integration.test.ts`).
- [ ] **Step 3: Schema** — add the columns/models above; `npx prisma migrate dev --name cs_insights_performance && npx prisma generate`; `SCHEMA_VERSION = 'v74'`.
- [ ] **Step 4: Settings** — extend `CsSettings`, `DEFAULT_CS_SETTINGS`, `normalize()` (reviewModel through `normalizeModelId`, null when blank), `PATCH_KEYS` in `src/app/api/cs/settings/route.ts`. Add `{ prefix: '/api/cs/review', methods: WRITE, access: 'SUPERADMIN' }` above the `/api/cs` rule.
- [ ] **Step 5: Run → PASS**; `npx tsc --noEmit` clean.
- [ ] **Step 6: Commit** `feat(cs): schema and settings for insights and performance`

---

### Task 2: Generic structured LLM call and the daily cap

**Files:**
- Modify: `src/lib/llm/types.ts`, `src/lib/llm/anthropic.ts`, `src/lib/llm/kie-responses.ts`, test fakes in `tests/cs-agent-cycle.integration.test.ts`, `tests/cs-analyze.integration.test.ts`
- Create: `src/lib/llm/cap.ts`
- Test: `tests/cs-llm-complete.test.ts`, `tests/cs-llm-cap.integration.test.ts`

**Interfaces:**
```ts
// types.ts
export type StructuredInput<T> = { system: string; user: string; model: string; schema: z.ZodType<T>; schemaName: string }
export type Llm = {
  complete<T>(input: StructuredInput<T>): Promise<{ output: T; tokensIn: number; tokensOut: number }>
  analyze(input: { system: string; user: string; model: string }): Promise<{ output: Analysis; tokensIn: number; tokensOut: number }>  // = complete with AnalysisSchema
}
// cap.ts
export async function takeLlmCall(cap: number, now?: Date): Promise<boolean>   // AppSetting key `cs.llmCalls.<YYYY-MM-DD>` (VN date); increments and returns true while count < cap
export async function llmCallsToday(now?: Date): Promise<number>
export class LlmCapReached extends Error {}
export async function withCap<T>(cap: number, fn: () => Promise<T>): Promise<T>   // throws LlmCapReached before calling fn when the cap is hit
```

- [ ] **Step 1: Failing tests**
```ts
// cs-llm-complete.test.ts — both providers, fake fetch returning a message whose text is {"a":1}
it('claudeLlm.complete parses any zod schema', ...)        // schema z.object({a: z.number()}) → output.a === 1
it('kieResponsesLlm.complete sends the given schema name', ...)   // body.text.format.name === 'root_cause'
it('analyze still works through complete', ...)
// cs-llm-cap.integration.test.ts
it('takeLlmCall counts per VN day and refuses at the cap', ...)  // cap 2: true,true,false; llmCallsToday()===2
it('withCap throws LlmCapReached without calling fn', ...)
```
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** — `complete` is the body of today's `analyze` with `zodOutputFormat(schema)` / `z.toJSONSchema(schema)` and `schema.parse`; `analyze = complete({..., schema: AnalysisSchema, schemaName: 'cs_analysis'})`. Update the test fakes to expose `complete` (they can implement `complete` as `analyze`-like with a switch on `schemaName`).
- [ ] **Step 4: Run → PASS**; all `tests/cs-*.ts` still green. **Step 5: Commit** `feat(cs): generic structured llm call and daily call cap`

---

### Task 3: Freshdesk stats, premature-close tracking, reply source

**Files:**
- Modify: `src/lib/cs/freshdesk.ts` (`FdTicket.stats?`, include `requester,description,stats`), `src/lib/cs/sync.ts`, `src/lib/cs/actions.ts` (`sendStaffReply` source), `src/app/api/cs/tickets/[id]/reply/route.ts`, `tests/fixtures/cs/tickets-page.json` (add `stats` to ticket 119)
- Test: `tests/cs-sync.integration.test.ts`, `tests/cs-agent-cycle.integration.test.ts` (reply source)

**Interfaces:**
- `FdTicket.stats?: { first_responded_at?: string | null; agent_responded_at?: string | null; resolved_at?: string | null; closed_at?: string | null; reopened_at?: string | null }`
- Sync stores `fdFirstRespondedAt/fdResolvedAt/fdClosedAt/fdReopenedAt` from stats; sets `closedAt = fdResolvedAt ?? fdClosedAt` when status is 4/5 (first time seen), and increments `reopenCount` when (a) `fdReopenedAt` advances, or (b) a CUSTOMER message newer than `closedAt` arrives while `closedAt` is set (then clears `closedAt`).
- `export function replySource(body: string, draft: string | null): 'OWN' | 'DRAFT_EDITED' | 'DRAFT_UNCHANGED'` (whitespace-insensitive equality → UNCHANGED; draft null → OWN; else EDITED). `sendStaffReply(..., opts: { private: boolean; source?: MessageSource })` stores `source`; `autoReply` stores `AGENT`.

- [ ] **Step 1: Failing tests**
```ts
it('stores freshdesk stats timestamps', ...)                                 // fixture 119 stats.first_responded_at → ticket.fdFirstRespondedAt
it('counts a customer message after resolution as a reopen', ...)           // ticket closed (status 5, resolved_at set) then next sync brings status 2 + a newer CUSTOMER message → reopenCount 1, closedAt null   (Review Focus 2)
it('replySource tells unchanged, edited and own replies apart', ...)        // ('Hi\n\nthere ', 'Hi there') → DRAFT_UNCHANGED; ('Hi there!', 'Hi there') → DRAFT_EDITED; ('x', null) → OWN
it('sendStaffReply stores the source', ...)                                 // in cycle suite with fake fd (Review Focus 3)
```
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** Reply route: load latest analysis draft, `source = replySource(body, draft)`. **Step 4: Run → PASS.** **Step 5: Commit** `feat(cs): freshdesk stats, reopen tracking and reply source`

---

### Task 4: Order timeline

**Files:**
- Create: `src/lib/cs/timeline.ts`
- Test: `tests/cs-timeline.integration.test.ts`

**Interfaces:**
```ts
export type TimelineEvent = { at: Date; stage: 'ORDER' | 'DESIGN' | 'FULFILLMENT' | 'FACTORY' | 'CARRIER'; label: string }
export type Gap = { name: 'design' | 'handoff' | 'production' | 'transit' | 'stalled'; days: number | null; budgetDays: number; late: boolean }
export type OrderTimeline = {
  orderId: string; legacy: boolean   // legacy = no DesignTask and supplierHandoffAt null
  events: TimelineEvent[]; gaps: Gap[]
  customerInputs: { lineId: string; title: string; fields: Record<string, string> }[]   // from OrderLine.customAttributesJson
  printFiles: { lineId: string; designDriveLink: string | null; designNote: string | null }[]
  shipments: { trackingNumber: string | null; status: string; firstScanAt: Date | null; lastScanAt: Date | null }[]
}
export async function buildOrderTimeline(orderId: string, settings: Pick<CsSettings,'productionDays'|'shippingDays'>, now?: Date): Promise<OrderTimeline | null>
export function formatTimeline(t: OrderTimeline): string   // the block in spec §4.1, dates MM/DD/YYYY HH:mm, gaps as "(2.3 d, budget 2 — LATE)"
```
Hand-off time = `supplierHandoffAt ?? SupplierOrderPush.pushedAt (CREATED) ?? exportedAt`. Design done = DesignTask status DONE: latest `DesignTaskEvent` with type STATUS/HANDOFF/SYSTEM whose message mentions DONE, else `DesignTask.updatedAt` when status is DONE. First scan = earliest checkpoint time in `checkpointsJson`, else `lastCheckpointAt`.

- [ ] **Step 1: Failing tests** — fixtures: order A (DesignTask created +0, DONE +3 d, handoff +5 d, push CREATED, shipment first scan +9 d, last scan +20 d, now +30 d) → gaps design 3 d LATE, handoff 2 d not late, production 4 d ok, transit 21 d LATE, stalled 10 d LATE, `legacy=false`; order B (no DesignTask, handoff null, exportedAt +1 d) → `legacy=true`, events contain FULFILLMENT "exported (CSV)" at +1 d, gaps has no `design` entry (Review Focus 1); `formatTimeline` contains `LATE` and `no design timeline` for B; unknown order → null.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Commit** `feat(cs): order timeline with lateness gaps`

---

### Task 5: Root-cause investigation pass

**Files:**
- Create: `src/lib/cs/root-cause.ts`, `src/lib/cs/root-cause-prompt.ts`
- Modify: `src/lib/cs/agent.ts` (after triage: investigate ≤5 per cycle), `src/lib/cs/labels.ts` (STAGE_LABELS, ISSUE_LABELS)
- Test: `tests/cs-root-cause.integration.test.ts`, `tests/cs-agent-cycle.integration.test.ts` (one case)

**Interfaces:**
```ts
export const PROBLEM_CATEGORIES: CsCategory[]  // DAMAGED_OR_DEFECTIVE, WRONG_ITEM, MISSING_ITEM, DELIVERED_NOT_RECEIVED, REFUND_REQUEST, PERSONALIZATION_ISSUE, ADDRESS_CHANGE, ORDER_STATUS
export const RootCauseSchema = z.object({ stage: z.enum(STAGES), issueType: z.enum(ISSUE_TYPES), confidence: z.enum(['LOW','MEDIUM','HIGH']), evidence: z.string(), affectedLineIds: z.array(z.string()) })
export function needsInvestigation(a: Pick<CsAnalysis,'category'|'rootCauseAt'>, ticket: Pick<CsTicket,'orderMatch'>, timeline: OrderTimeline | null): 'RUN' | 'UNKNOWN' | 'SKIP'
   // SKIP when category not a problem (ORDER_STATUS only when a gap is late) or already investigated for this analysis; UNKNOWN when no matched order/timeline → store stage UNKNOWN without an LLM call
export async function investigateTicket(ticketId: string, deps: { llm: Llm; now?: Date }): Promise<CsAnalysis>   // updates latest CsAnalysis root-cause fields + rootCauseAt
export function buildRootCausePrompt(i: { thread: string; timeline: string; category: CsCategory; summary: string }): { system: string; user: string }
```
Prompt rules (system): the stage definitions; the three attribution rules from spec §4.1; "late" decided by the gap flags given, not by arithmetic; evidence in Vietnamese ≤3 lines quoting the timeline; LOW confidence when the thread lacks the fact needed.

- [ ] **Step 1: Failing tests** — fake llm returns `{stage:'FACTORY', issueType:'WRONG_TEXT', confidence:'HIGH', evidence:'…', affectedLineIds:['l1']}`:
```ts
it('stores the root cause on the latest analysis and skips the second call', ...)
it('writes UNKNOWN without calling the model when the order is unmatched', ...)
it('skips ORDER_STATUS tickets whose timeline is not late', ...)
it('prompt carries the gap flags and the customer inputs', ...)   // user prompt contains 'transit 21 d' and 'Name = "Laurance"'
it('cycle investigates at most 5 tickets per run', ...)         // in cycle suite: 6 problem tickets → llm root-cause calls 5
```
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement**; in `runAgentCycle` after the triage loop: candidates = open tickets with latest analysis `rootCauseAt null` and `PROBLEM_CATEGORIES`, oldest first, ≤5, each under `withCap`. **Step 4: Run → PASS.** **Step 5: Commit** `feat(cs): root-cause investigation per problem ticket`

---

### Task 6: Performance metrics (deterministic)

**Files:**
- Create: `src/lib/cs/performance.ts`
- Test: `tests/cs-performance.integration.test.ts`

**Interfaces:**
```ts
export type Period = { from: Date; to: Date }
export type ResponseStats = { count: number; medianH: number | null; meanH: number | null; p90H: number | null; over24hPct: number | null; worst: { ticketId: string; fdTicketId: number; hours: number }[] }
export type PerformanceMetrics = {
  period: Period; tickets: number
  staff: { firstResponse: ResponseStats; nextResponse: ResponseStats; repliesPerTicket: { mean: number | null; over3Pct: number | null; over3: { ticketId: string; fdTicketId: number; replies: number }[] }; draftUnchanged: number
           prematureCloses: { count: number; closedTickets: number; pct: number | null; items: { ticketId: string; fdTicketId: number; reopenSentiment: string | null }[] }
           sentimentAfterReply: { improved: number; same: number; worse: number; worseItems: { ticketId: string; fdTicketId: number; messageId: string }[] } }
  agent: { firstResponse: ResponseStats; nextResponse: ResponseStats; repliesPerTicket: {...same}; sentimentAfterReply: {...same} }
}
export async function computePerformance(period: Period): Promise<PerformanceMetrics>
export function weekBounds(now: Date, offsetWeeks = 0): Period   // Monday 00:00 Asia/Ho_Chi_Minh
```
Staff replies = `author STAFF && !private && source != DRAFT_UNCHANGED`; agent replies = `author AGENT` plus STAFF with `source DRAFT_UNCHANGED`. First response: `fdFirstRespondedAt − first CUSTOMER message` when stats exist, else first reply − first customer message. Sentiment ranks CALM 0 < FRUSTRATED 1 < ANGRY 2 < DISPUTE_THREAT 3; "improved" = next customer sentiment rank < previous.

- [ ] **Step 1: Failing tests** — build 5 tickets with messages/sentiments/sources/stats covering: median/p90, >24 h, 4 replies on one ticket, one DRAFT_UNCHANGED (excluded from staff counts, Review Focus 3), one reopen with ANGRY, sentiment improved/same/worse; `weekBounds(new Date('2026-10-24T03:00:00Z'))` → Mon 10/19 17:00Z … Sun 10/25 16:59:59Z.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Commit** `feat(cs): performance metrics`

---

### Task 7: Reply review pass and backfill

**Files:**
- Create: `src/lib/cs/review.ts`, `src/lib/cs/review-prompt.ts`, `src/lib/cs/backfill.ts`
- Modify: `src/lib/cs/agent.ts` (≤5 reviews per cycle), `src/lib/cs/scheduler.ts` (nothing new; backfill is manual)
- Test: `tests/cs-review.integration.test.ts`, `tests/cs-backfill.integration.test.ts`

**Interfaces:**
```ts
export const ReviewSchema = z.object({
  messageSentiments: z.array(z.object({ messageId: z.string(), sentiment: z.enum(CS_SENTIMENTS) })),
  replies: z.array(z.object({ messageId: z.string(), score: z.number().int().min(1).max(5), issues: z.array(z.enum(RUBRIC)), reason: z.string(), rewrite: z.string().nullable() })),
  ticketVerdict: z.enum(['RESOLVED','UNRESOLVED','UNCLEAR']), verdictNote: z.string(),
})
export function reviewDue(t: Pick<CsTicket,'fdStatus'|'reviewedAt'|'lastCustomerAt'|'lastReplyAt'>, lastReplyAtAny: Date | null, now: Date): boolean
   // ≥1 reviewable reply AND (status 4/5 OR quiet 48 h OR a reply newer than reviewedAt)
export async function reviewTicket(ticketId: string, deps: { llm: Llm; now?: Date }): Promise<{ reviews: number }>
   // upserts CsReplyReview per STAFF(source≠DRAFT_UNCHANGED)/AGENT public reply, sets CsMessage.sentiment for customers, adds TOO_SLOW from metric 1 (>24 h) in code, sets ticket.reviewedAt/reviewSeq
export const CombinedBackfillSchema  // AnalysisSchema fields + root cause + review in one object
export async function runReviewBackfill(deps: { llm: Llm; now?: Date; maxCalls?: number }): Promise<{ processed: number; remaining: number; capReached: boolean }>
   // oldest-first over tickets with reviewedAt null; closed+untriaged tickets use the combined pass (no Freshdesk, no Telegram); progress in AppSetting `last_cs_review_backfill`
```
- [ ] **Step 1: Failing tests**
```ts
it('reviewDue: closed, quiet 48h, or new reply since last review', ...)
it('reviewTicket grades staff and agent replies, skips DRAFT_UNCHANGED, tags customer sentiments', ...)   // Review Focus 3
it('adds TOO_SLOW when the first response exceeded 24h', ...)
it('stops at the daily cap without marking the ticket reviewed', ...)   // cap 0 → LlmCapReached, reviewedAt stays null (Review Focus 4)
it('backfill processes oldest first and resumes from progress', ...)   // maxCalls 2 of 3 tickets → remaining 1; second run finishes
it('backfill never touches Freshdesk for closed tickets', ...)         // fake fd records no calls
```
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** — prompt: rubric definitions with one example each, brand rules from the triage prompt, "quote the sentence", rewrite ≤120 words English; input = thread with message ids. **Step 4: Run → PASS.** **Step 5: Commit** `feat(cs): reply review pass and backfill`

---

### Task 8: Performance write-up and weekly job

**Files:**
- Create: `src/lib/cs/report.ts`
- Modify: `src/lib/cs/scheduler.ts` (Monday 08:00 `0 8 * * 1`)
- Test: `tests/cs-report.integration.test.ts`

**Interfaces:**
```ts
export const ReportSchema = z.object({ weaknesses: z.array(z.object({ title: z.string(), numbers: z.string(), examples: z.array(z.string()).max(2) })).max(3), goodExample: z.string(), habits: z.array(z.string()).max(3), progress: z.string() })
export async function buildReportInput(period: Period): Promise<{ metrics: PerformanceMetrics; issueCounts: Record<string, number>; scoreHistogram: number[]; worst: { quote: string; issues: string[]; reason: string; rewrite: string | null }[] }>
export async function generateReport(period: Period, kind: 'WEEKLY' | 'MANUAL', deps: { llm: Llm; notifier?: Notifier; appUrl: string }): Promise<CsPerformanceReport>   // body = Vietnamese markdown rendered from ReportSchema; Telegram 5-line summary when notifier given
```
- [ ] **Step 1: Failing tests** — fake llm returns a fixed ReportSchema object → report row stored with `metricsJson` containing `staff.firstResponse.count`, body contains the weakness title and the habits; notifier receives one text containing the top weakness; `kind` stored.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** + cron. **Step 4: Run → PASS.** **Step 5: Commit** `feat(cs): weekly performance write-up`

---

### Task 9: API routes

**Files:**
- Create: `src/app/api/cs/insights/route.ts` (GET JSON or `format=csv`), `src/app/api/cs/performance/route.ts` (GET), `src/app/api/cs/performance/report/route.ts` (POST manual), `src/app/api/cs/review/backfill/route.ts` (POST superadmin; runs `runReviewBackfill` under `runExclusive('cs-backfill')` with `maxCalls` 20, returns progress), `src/app/api/cs/tickets/[id]/root-cause/route.ts` (PATCH `{ stage, note }`), `src/lib/cs/insights.ts`
- Test: `tests/cs-insights.integration.test.ts`

**Interfaces:**
```ts
export type InsightsFilter = { from: Date; to: Date; stage?: string; category?: string }
export type InsightsRow = { ticketId: string; fdTicketId: number; subject: string; orderNumber: string | null; stage: string; issueType: string | null; confidence: string | null; evidence: string | null; category: string | null; createdAt: Date; products: string[]; supplierId: string | null; overridden: boolean }
export async function insights(f: InsightsFilter): Promise<{ totals: { problem: number; all: number; topStage: string | null; topIssue: string | null }; byStage: Record<string, number>; byIssue: Record<string, number>; weekly: { week: string; byStage: Record<string, number> }[]; products: { title: string; count: number }[]; suppliers: { supplierId: string; name: string | null; count: number }[]; rows: InsightsRow[] }>
export function insightsCsv(rows: InsightsRow[]): string   // header + rows, RFC4180 quoting
```
Stage for a row = `rootCauseStageOverride ?? analysis.rootCauseStage`; problem = stage not null.

- [ ] **Step 1: Failing tests** — 4 tickets (one overridden, one closed, one outside the period) → totals/byStage/weekly correct; `insightsCsv` escapes a comma and a quote in evidence and has exactly the filtered rows (Review Focus 5); PATCH root-cause stores override + `rootCauseById`.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.** **Step 5: Commit** `feat(cs): insights and performance api`

---

### Task 10: Pages

**Files:**
- Create: `src/app/cs/insights/page.tsx`, `src/app/cs/performance/page.tsx`, `src/components/cs/Bars.tsx` (horizontal bars + weekly stacked bars in SVG), `src/components/cs/PeriodPicker.tsx`
- Modify: `src/app/cs/[id]/page.tsx` (root-cause card: stage chip, evidence, confidence, override select + note; reply bubbles show source pill "nháp agent" / "đã sửa"; reviewed replies show score + issues), `src/components/Sidebar.tsx` (children `Thống kê lỗi` → `/cs/insights`, `Đánh giá CS` → `/cs/performance`), `src/app/cs/settings/page.tsx` (review on/off, weekly on/off, review model, daily cap, "Chạy backfill" button with progress)

- [ ] **Step 1: `/cs/insights`** — PeriodPicker (Tuần này / 4 tuần / Tháng này / Tuỳ chọn), stage + category selects; 4 cards; Bars for byStage and byIssue; weekly stacked bars; two top-10 tables; rows table with evidence and link to ticket; "Xuất CSV" link (`format=csv`).
- [ ] **Step 2: `/cs/performance`** — PeriodPicker; latest report at top (markdown → simple paragraphs/lists) with "Tạo đánh giá" (POST report); metric cards staff vs agent (median/p90/%>24h for first & next response; replies/ticket + >3; premature closes; sentiment improved/same/worse); score histogram; issue bars; reviewed-replies table filterable by issue with quote + rewrite; report history list.
- [ ] **Step 3: Ticket page + settings + sidebar** as listed.
- [ ] **Step 4: Browser check** on the dev server with the 49 synced tickets after a manual backfill against the fake-free real model is **not** required; verify pages render with empty data and with the Task 6/9 fixtures left in dev.db by a small seed script run once (`scripts/seed-cs-demo.mjs`, deleted after). `read_console_messages` clean, screenshots of both pages.
- [ ] **Step 5: Commit** `feat(cs): insights and performance pages`

---

### Task 11: Docs, suite, deploy notes

- [ ] NOTES.md section "CS insights & performance" (passes, caps, backfill button, weekly report, prod migrate-with-pm2-stop reminder); PLAN.md entry; spec status → built.
- [ ] `npx vitest run` all green, `npx tsc --noEmit`, `npm run lint`.
- [ ] Commit `docs(cs): insights and performance notes`.
