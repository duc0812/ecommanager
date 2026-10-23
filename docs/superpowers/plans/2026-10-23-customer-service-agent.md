# Customer Service Agent Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sync Litzzy's Freshdesk tickets into Ecom Manager, let an AI agent classify, rank, summarise and draft every ticket, auto-reply inside a strict allow-list, alert staff on Telegram, and give staff a `/cs` workspace plus a case library the agent must cite.

**Architecture:** A node-cron poller (`src/lib/cs/scheduler.ts`) pulls changed tickets through a thin Freshdesk client into `CsTicket`/`CsMessage`, then `src/lib/cs/agent.ts` runs one analysis per ticket with new customer text: order context from the local `Order`/`Shipment`/`DesignTask` mirror → Claude structured output → deterministic urgency rules → policy gate → write-back (Freshdesk priority/tags/note, Telegram, optional auto-reply). `/api/cs/*` routes and four `'use client'` pages sit on top. Every external call (Freshdesk, Claude, Telegram) is behind an injectable interface so integration tests run on `test.db` with fakes.

**Tech Stack:** Next.js 14 (app router, `'use client'` pages), Prisma 7 + SQLite, node-cron, `@anthropic-ai/sdk` + `zod` (new deps), vitest. Tailwind tokens from `tailwind.config.ts`, Material Symbols icons.

**Spec:** `docs/superpowers/specs/2026-10-23-customer-service-agent-design.md`

## Global Constraints

- Never add `url` to `datasource db {}`; after the schema change run `npx prisma migrate dev --name cs_module && npx prisma generate`, bump `SCHEMA_VERSION` in `src/lib/db.ts` (`'v69'` → `'v70'`).
- Tests run on `test.db` (vitest sets it); integration tests create their own `Order`/`CsTicket` fixtures and delete them in `afterAll`.
- Import prisma from `@/lib/db`; never from `@/generated/prisma`.
- New feature permission `cs`; every `/api/cs/*` route needs a rule in `API_ACCESS_RULES` (settings writes `'SUPERADMIN'` and `requireSuperadmin`).
- Secrets (`cs.freshdeskApiKey`, `cs.anthropicApiKey`) live in `AppSetting`; GET routes return masked values only (`maskApiKey` from `@/lib/tracking/parcelpanel-config`).
- Freshdesk: base `https://<domain>.freshdesk.com/api/v2`, basic auth `apiKey:X`, ≤ 25 requests per sync cycle (plan limit ≈ 40/min).
- Claude: `@anthropic-ai/sdk`, `client.messages.parse` + `zodOutputFormat`, default model `claude-opus-5-5`, `output_config: { effort: 'low' }`, `max_tokens: 4000`, `maxRetries: 2`. Model id is a setting.
- Freshdesk ids: support agent `158024049112`; Freddy shadow agents `158024416092`, `158024416093` (their private notes are never shown to the model or staff). Statuses 2 Open, 3 Pending, 4 Resolved, 5 Closed, 6 Waiting on Customer, 7 Waiting on Third Party, 9000 Assigned to AI Agent. Priority 1–4.
- Copy: UI labels Vietnamese, customer-facing drafts English, dates `MM/DD/YYYY` (`toLocaleDateString('en-US')`).
- Page shell: `'use client'`, `<div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-[280px] flex-1 p-xl">…</main></div>`, wrapped in `<RoleGate>`. Card: `bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20`. Primary button: `bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md`.
- No code comments except for non-obvious constraints.

## Review Focus

1. A ticket whose subject is only `LIT3910` (no `#`) and whose body is empty must still match order `#LIT3910` — test in Task 4.
2. A customer who writes a second message while the first is unanswered must never be auto-replied, even if the category is ORDER_STATUS — test in Task 6.
3. A Freshdesk 429 or 5xx mid-cycle must not advance the `updatedSince` cursor past unsynced tickets — test in Task 3.
4. The model returning a lower urgency than the rules (e.g. `NORMAL` for an address change before handoff) must end as `URGENT` — test in Task 5.
5. Re-running analysis with no new customer message must not post a second Freshdesk note or a second Telegram alert (hash unchanged) — test in Task 8.

---

### Task 1: Schema, permission, settings module

**Files:**
- Modify: `prisma/schema.prisma` (append), `src/lib/db.ts:7`, `src/lib/roles.ts`, `src/lib/api-access.ts`, `src/components/Sidebar.tsx`
- Create: `src/lib/cs/settings.ts`
- Test: `tests/cs-settings.integration.test.ts`

**Interfaces:**
- Produces Prisma models `CsTicket`, `CsMessage`, `CsAnalysis`, `CsCase`, `CsAgentRun` (fields below).
- Produces `getCsSettings(): Promise<CsSettings>`, `saveCsSettings(patch: Partial<CsSettings>): Promise<CsSettings>`, `getCsSecrets(): Promise<{ freshdeskApiKey: string | null; anthropicApiKey: string | null }>`, `saveCsSecrets(p: { freshdeskApiKey?: string; anthropicApiKey?: string })`, `toCsSettingsView(s, secrets): CsSettingsView`, `DEFAULT_CS_SETTINGS`.

- [ ] **Step 1: Append the models to `prisma/schema.prisma`**

```prisma
model CsTicket {
  id              String   @id @default(cuid())
  fdTicketId      Int      @unique
  subject         String
  fdStatus        Int
  fdPriority      Int
  fdTags          String   @default("[]")
  requesterEmail  String?
  requesterName   String?
  orderId         String?
  orderNumber     String?
  orderMatch      String   @default("NONE")
  category        String?
  urgency         String?
  sentiment       String?
  needsHuman      Boolean  @default(true)
  autoReplied     Boolean  @default(false)
  resolvedInTool  Boolean  @default(false)
  fdCreatedAt     DateTime
  fdUpdatedAt     DateTime
  lastCustomerAt  DateTime?
  lastReplyAt     DateTime?
  lastAnalysisAt  DateTime?
  lastNoteHash    String?
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt
  messages        CsMessage[]
  analyses        CsAnalysis[]
  @@index([needsHuman, urgency, lastCustomerAt])
  @@index([fdUpdatedAt])
}

model CsMessage {
  id               String   @id @default(cuid())
  ticketId         String
  ticket           CsTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  fdConversationId String?  @unique
  author           String
  private          Boolean  @default(false)
  bodyText         String
  bodyHtml         String?
  fromEmail        String?
  createdAt        DateTime
  @@index([ticketId, createdAt])
}

model CsAnalysis {
  id                String   @id @default(cuid())
  ticketId          String
  ticket            CsTicket @relation(fields: [ticketId], references: [id], onDelete: Cascade)
  runAt             DateTime @default(now())
  model             String
  inputHash         String
  outputJson        String
  category          String
  urgency           String
  sentiment         String
  summary           String
  proposal          String
  draftReply        String?
  needsHuman        Boolean
  citedCaseIds      String   @default("[]")
  autoReplyEligible Boolean  @default(false)
  gateJson          String   @default("{}")
  tokensIn          Int      @default(0)
  tokensOut         Int      @default(0)
  @@index([ticketId, runAt])
}

model CsCase {
  id                   String   @id @default(cuid())
  title                String
  category             String
  situation            String
  resolution           String
  toneNotes            String?
  forbidden            String?
  exampleReply         String?
  active               Boolean  @default(true)
  source               String   @default("MANUAL")
  promotedFromTicketId String?
  createdById          String?
  createdAt            DateTime @default(now())
  updatedAt            DateTime @updatedAt
  @@index([category, active])
}

model CsAgentRun {
  id           String   @id @default(cuid())
  startedAt    DateTime @default(now())
  finishedAt   DateTime?
  ticketsSeen  Int      @default(0)
  analysed     Int      @default(0)
  autoReplied  Int      @default(0)
  fdRequests   Int      @default(0)
  error        String?
}
```

- [ ] **Step 2: Migrate, generate, bump version**

Run:
```bash
npx prisma migrate dev --name cs_module && npx prisma generate
```
Then set `SCHEMA_VERSION = 'v70'` in `src/lib/db.ts`. Expected: migration folder created, no errors.

- [ ] **Step 3: Add the `cs` permission in `src/lib/roles.ts`**

Union member `'cs'`; `FEATURE_LABELS.cs = 'Customer Service'`; new `FEATURE_GROUPS` entry `{ label: 'Customer Service', permissions: ['cs'] }`; add `'cs'` to `DEFAULT_ROLE_PERMISSIONS.ADMIN` and `.SUPPORT`; `FEATURE_PATHS.cs = ['/cs']`; insert `'cs'` in `HOME_PRIORITY` right after `'need_to_fix'` (or first if absent).

- [ ] **Step 4: Add API rules in `src/lib/api-access.ts`** (before any generic rule)

```ts
{ prefix: '/api/cs/settings', methods: WRITE, access: 'SUPERADMIN' },
{ prefix: '/api/cs', access: ['cs'] },
```

- [ ] **Step 5: Sidebar group in `src/components/Sidebar.tsx`** after the Design Studio group:

```ts
{ type: 'group', label: 'Customer Service' },
{ type: 'child', href: '/cs', icon: 'support_agent', label: 'Tickets' },
{ type: 'child', href: '/cs/cases', icon: 'menu_book', label: 'Thư viện case' },
{ type: 'child', href: '/cs/settings', icon: 'tune', label: 'Cài đặt CS' },
```

- [ ] **Step 6: Write the failing settings test** `tests/cs-settings.integration.test.ts`

```ts
it('returns defaults when nothing stored', async () => {
  expect(await getCsSettings()).toEqual(DEFAULT_CS_SETTINGS)
})
it('patch merges and persists', async () => {
  await saveCsSettings({ autoReplyCategories: ['ORDER_STATUS', 'PRODUCT_QUESTION'], pollEnabled: false })
  const s = await getCsSettings()
  expect(s.autoReplyCategories).toEqual(['ORDER_STATUS', 'PRODUCT_QUESTION'])
  expect(s.pollEnabled).toBe(false)
  expect(s.model).toBe('claude-opus-5-5')
})
it('secrets are masked in the view and never returned raw', async () => {
  await saveCsSecrets({ freshdeskApiKey: 'fwapABCDEFGH1234', anthropicApiKey: 'sk-ant-xyz' })
  const view = toCsSettingsView(await getCsSettings(), await getCsSecrets())
  expect(view.freshdeskApiKeyMasked).toBe('fwap…1234')
  expect(view.hasAnthropicApiKey).toBe(true)
  expect(JSON.stringify(view)).not.toContain('sk-ant-xyz')
})
```

- [ ] **Step 7: Run to verify it fails** — `npx vitest run tests/cs-settings.integration.test.ts` → FAIL (module not found).

- [ ] **Step 8: Implement `src/lib/cs/settings.ts`**

```ts
export type CsSettings = {
  freshdeskDomain: string            // default 'litzzy'
  model: string                      // 'claude-opus-5-5'
  pollEnabled: boolean               // true
  killSwitch: boolean                // false
  autoReplyEnabled: boolean          // false
  autoReplyCategories: string[]      // ['ORDER_STATUS']
  autoReplyDailyCap: number          // 30
  notifyLevels: string[]             // ['URGENT', 'HIGH']
  productionDays: number             // 5
  shippingDays: number               // 15
  supportAgentId: number             // 158024049112
  ignoredAgentIds: number[]          // [158024416092, 158024416093]
  syncUpdatedSince: string | null    // ISO cursor
}
```
JSON in one AppSetting key `cs.settings` (pattern: `src/lib/design-settings.ts`); secrets in keys `cs.freshdeskApiKey` / `cs.anthropicApiKey` via `getSettings`/`saveSetting` from `@/lib/token-store`, env fallbacks `FRESHDESK_API_KEY`, `ANTHROPIC_API_KEY`. `CsSettingsView = CsSettings & { hasFreshdeskApiKey, freshdeskApiKeyMasked, hasAnthropicApiKey, anthropicApiKeyMasked }` with `syncUpdatedSince` included.

- [ ] **Step 9: Run tests** — PASS. Also `npx tsc --noEmit` clean.

- [ ] **Step 10: Commit** `feat(cs): schema, permission and settings for the customer service module`

---

### Task 2: Freshdesk client

**Files:**
- Create: `src/lib/cs/freshdesk.ts`
- Test: `tests/cs-freshdesk.test.ts`

**Interfaces:**
- Produces:
```ts
export type FdTicket = { id: number; subject: string; status: number; priority: number; tags: string[]; created_at: string; updated_at: string; description_text?: string; description?: string; requester?: { email?: string; name?: string }; custom_fields?: { cf_order_id?: string | null } }
export type FdConversation = { id: number; incoming: boolean; private: boolean; user_id: number; body: string; body_text: string; from_email?: string | null; created_at: string }
export class FreshdeskClient {
  constructor(opts: { domain: string; apiKey: string; fetchImpl?: typeof fetch; budget?: number })
  requests: number
  listTickets(updatedSince: string, page?: number): Promise<FdTicket[]>   // include=requester,description, per_page=100, order_by=updated_at, order_type=asc
  getConversations(ticketId: number): Promise<FdConversation[]>
  reply(ticketId: number, bodyHtml: string): Promise<{ id: number }>
  note(ticketId: number, bodyHtml: string): Promise<{ id: number }>
  update(ticketId: number, patch: { priority?: number; status?: number; tags?: string[]; custom_fields?: Record<string, string | null> }): Promise<void>
}
export class FreshdeskError extends Error { status: number; retryAfter?: number }
export class FreshdeskBudgetExceeded extends Error {}
```

- [ ] **Step 1: Failing tests** (`fetchImpl = vi.fn()` returning `new Response(JSON.stringify(...), { status })`)

```ts
it('sends basic auth and the list query', ...)            // header Authorization === 'Basic ' + base64('key:X'); URL contains updated_since, include=requester,description
it('throws FreshdeskError with retryAfter on 429', ...)   // Retry-After: 7 → err.retryAfter === 7
it('stops at the request budget', ...)                    // budget 2 → third call throws FreshdeskBudgetExceeded without calling fetch
it('reply posts {body} to /tickets/:id/reply', ...)
```

- [ ] **Step 2: Run → FAIL.** 
- [ ] **Step 3: Implement** — `fetch(\`https://${domain}.freshdesk.com/api/v2${path}\`)`, JSON body, count every call in `requests`, throw `FreshdeskBudgetExceeded` when `requests >= budget` (default 25).
- [ ] **Step 4: Run → PASS.** 
- [ ] **Step 5: Commit** `feat(cs): freshdesk api client`

---

### Task 3: Ticket sync

**Files:**
- Create: `src/lib/cs/sync.ts`, `tests/fixtures/cs/tickets-page.json`, `tests/fixtures/cs/conversations-119.json`
- Test: `tests/cs-sync.integration.test.ts`

**Interfaces:**
- Consumes `FreshdeskClient` (Task 2), `getCsSettings/saveCsSettings` (Task 1).
- Produces:
```ts
export type FdLike = Pick<FreshdeskClient, 'listTickets' | 'getConversations' | 'requests'>
export function authorOf(c: FdConversation, s: Pick<CsSettings, 'supportAgentId' | 'ignoredAgentIds'>, knownAgentIds: Set<string>): 'CUSTOMER' | 'STAFF' | 'AGENT' | 'SYSTEM' | 'SKIP'
export async function syncTickets(fd: FdLike, opts?: { since?: string }): Promise<{ seen: number; changed: string[]; cursor: string | null; error?: string }>
```
`changed` = `CsTicket.id`s whose customer messages grew (candidates for analysis).

- [ ] **Step 1: Fixtures** — `tickets-page.json`: three tickets copied in shape from the live sample (ids 119, 194, 195; 195 subject `LIT3910`, empty description; 119 `cf_order_id: '#LIT4525'`). `conversations-119.json`: the five real conversations (two Freddy private notes user 158024416093, one staff private note, one staff public reply, one incoming customer message).

- [ ] **Step 2: Failing tests**

```ts
it('upserts tickets, description as first CUSTOMER message, and maps authors', ...)  // ticket 119 → 4 CsMessage rows (Freddy notes skipped): description CUSTOMER, staff note STAFF private, staff reply STAFF, incoming CUSTOMER; lastCustomerAt = 2026-10-23T14:16:19Z; lastReplyAt = 2026-10-23T09:26:05Z
it('returns changed ids only for tickets with new customer text', ...)               // second sync with same fixtures → changed = []
it('does not advance the cursor when a fetch fails mid-cycle', ...)                 // getConversations rejects with FreshdeskError(503) on ticket 194 → cursor stays at opts.since, error set, tickets before 194 still upserted
it('tags conversation ids we posted as AGENT', ...)                                 // knownAgentIds contains '158049449778' → author AGENT
```

- [ ] **Step 3: Run → FAIL.**
- [ ] **Step 4: Implement `syncTickets`** — page through `listTickets(since)` until < 100; for each ticket: upsert `CsTicket` (subject, fdStatus, fdPriority, fdTags JSON, requester, timestamps); if `fdUpdatedAt` moved or ticket new → `getConversations` and upsert `CsMessage` by `fdConversationId` (description stored with `fdConversationId = \`desc-${id}\``). `knownAgentIds` = set of `CsMessage.fdConversationId` where `author='AGENT'` (populated by Task 8's auto-reply). Cursor = max `updated_at` of fully processed tickets minus 1 s; only saved when no error. Strip HTML for `bodyText` when `body_text` missing (regex `<[^>]+>`, decode `&nbsp;&amp;&lt;&gt;&quot;`).
- [ ] **Step 5: Run → PASS.**
- [ ] **Step 6: Commit** `feat(cs): sync freshdesk tickets and conversations`

---

### Task 4: Order context

**Files:**
- Create: `src/lib/cs/order-context.ts`
- Test: `tests/cs-order-context.test.ts` (unit part) and `tests/cs-order-context.integration.test.ts`

**Interfaces:**
```ts
export function extractOrderNumbers(text: string): string[]           // '#LIT4525', 'LIT3910', 'order lit 4525' → ['#LIT4525'] normalised upper, '#' added, deduped
export type FactoryState = 'NOT_SENT' | 'AT_FACTORY' | 'SHIPPED' | 'DELIVERED' | 'CANCELLED'
export function factoryStateOf(o: { supplierHandoffAt: Date | null; pipelineStatus: string; fulfillmentStatus: string | null; supplierPushes: { status: string }[]; shipments: { status: string }[] }): FactoryState
export type OrderMatch = 'EXACT' | 'BY_EMAIL' | 'AMBIGUOUS' | 'NONE'
export type OrderContext = { match: OrderMatch; order: null | { id, shopifyOrderNumber, placedAt, customerName, shipTo: string, factoryState, lines: { title, variant, qty, customized }[], shipments: { trackingNumber, carrier, status, lastCheckpointAt, trackingUrl }[], designTaskStatuses: string[] }; candidates: string[] }
export async function buildOrderContext(input: { subject: string; texts: string[]; cfOrderId?: string | null; email?: string | null }): Promise<OrderContext>
```

- [ ] **Step 1: Unit tests (pure)**
```ts
expect(extractOrderNumbers('Re: Order #LIT5037 confirmed')).toEqual(['#LIT5037'])
expect(extractOrderNumbers('LIT3910')).toEqual(['#LIT3910'])          // Review Focus 1
expect(extractOrderNumbers('no order here')).toEqual([])
expect(factoryStateOf({ supplierHandoffAt: null, pipelineStatus: 'READY_TO_PRODUCTION', fulfillmentStatus: null, supplierPushes: [], shipments: [] })).toBe('NOT_SENT')
expect(factoryStateOf({ ...base, supplierPushes: [{ status: 'CREATED' }] })).toBe('AT_FACTORY')
expect(factoryStateOf({ ...base, pipelineStatus: 'EXPORTED', shipments: [{ status: 'IN_TRANSIT' }] })).toBe('SHIPPED')
expect(factoryStateOf({ ...base, shipments: [{ status: 'DELIVERED' }] })).toBe('DELIVERED')
expect(factoryStateOf({ ...base, pipelineStatus: 'CANCELLED' })).toBe('CANCELLED')
```
- [ ] **Step 2: Integration tests** — create `ShopifyStore`+`Order` fixtures (`#LIT9001` email a@x.com, `#LIT9002` email a@x.com, `#LIT9003` email b@x.com):
```ts
it('EXACT by number from cf_order_id even when body is empty')
it('BY_EMAIL when exactly one order for the email')
it('AMBIGUOUS lists candidates when email has two orders and no number')
it('NONE when nothing matches')
```
- [ ] **Step 3: Run → FAIL.** 
- [ ] **Step 4: Implement** — number search order: `cfOrderId`, subject, texts; `prisma.order.findFirst({ where: { shopifyOrderNumber }, include: { lines, shipments, designTasks, supplierPushes } })`; email fallback `findMany({ where: { customerEmail: { equals: email } }, orderBy: { placedAt: 'desc' }, take: 5 })`. `shipTo` = joined address fields. `trackingUrl` fallback `https://litzzy.com/apps/trackingorder?nums=<trackingNumber>`.
- [ ] **Step 5: Run → PASS.** 
- [ ] **Step 6: Commit** `feat(cs): order context lookup for tickets`

---

### Task 5: Triage rules

**Files:**
- Create: `src/lib/cs/triage.ts`
- Test: `tests/cs-triage.test.ts`

**Interfaces:**
```ts
export const CS_CATEGORIES = ['ADDRESS_CHANGE','CANCEL_ORDER','ORDER_STATUS','DAMAGED_OR_DEFECTIVE','WRONG_ITEM','MISSING_ITEM','DELIVERED_NOT_RECEIVED','REFUND_REQUEST','PRODUCT_QUESTION','PERSONALIZATION_ISSUE','OTHER','SPAM'] as const
export const CS_URGENCIES = ['LOW','NORMAL','HIGH','URGENT'] as const
export const CS_SENTIMENTS = ['CALM','FRUSTRATED','ANGRY','DISPUTE_THREAT'] as const
export type CsCategory/CsUrgency/CsSentiment
export function ruleUrgency(i: { category: CsCategory; factoryState: FactoryState | null; sentiment: CsSentiment; hoursUnanswered: number }): CsUrgency
export function finalUrgency(modelUrgency: CsUrgency, ruleUrgency: CsUrgency): CsUrgency   // max of the two
export function urgencyToPriority(u: CsUrgency): 1 | 2 | 3 | 4
export function tagsFor(category: CsCategory, urgency: CsUrgency, existing: string[]): string[]  // keeps non-em- tags, sets em-<category-kebab>, em-urgent|em-high
```

- [ ] **Step 1: Failing tests**
```ts
ADDRESS_CHANGE + NOT_SENT → URGENT; ADDRESS_CHANGE + SHIPPED → HIGH; CANCEL_ORDER + null factory → URGENT
WRONG_ITEM → HIGH; ORDER_STATUS + DISPUTE_THREAT → HIGH; ORDER_STATUS calm → NORMAL; SPAM → LOW
ORDER_STATUS calm + hoursUnanswered 30 → HIGH (bump one level)
finalUrgency('NORMAL','URGENT') === 'URGENT'   // Review Focus 4
tagsFor('ADDRESS_CHANGE','URGENT',['shadow-email-ai-agent','em-order-status']) → ['shadow-email-ai-agent','em-address-change','em-urgent']
urgencyToPriority('URGENT') === 4
```
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement.** **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(cs): deterministic triage rules`

---

### Task 6: Auto-reply policy gate

**Files:**
- Create: `src/lib/cs/policy.ts`
- Test: `tests/cs-policy.test.ts`

**Interfaces:**
```ts
export type GateInput = {
  settings: Pick<CsSettings, 'autoReplyEnabled' | 'autoReplyCategories' | 'autoReplyDailyCap' | 'killSwitch' | 'productionDays' | 'shippingDays'>
  category: CsCategory; sentiment: CsSentiment; orderMatch: OrderMatch
  customerMessageCount: number; hasAnyReply: boolean
  hasTracking: boolean; placedAt: Date | null; now: Date
  textMentionsRefundAddressOrCancel: boolean
  autoRepliesToday: number
  hasActiveCaseForCategory: boolean
}
export const BASELINE_CATEGORIES: CsCategory[] = ['ORDER_STATUS']
export function autoReplyGate(i: GateInput): { allowed: boolean; reasons: string[] }
export function mentionsRefundAddressOrCancel(text: string): boolean   // /refund|charge ?back|dispute|cancel|wrong address|change (the )?address|different address|send(ing)? it to/i
```

- [ ] **Step 1: Failing tests** — one `it` per rule, starting from a `passing` input and flipping one field:
`disabled`, `killSwitch`, `category not allowed`, `second customer message` (count 2 → blocked, Review Focus 2), `has reply`, `AMBIGUOUS match`, `ANGRY`, `mentions refund`, `no tracking and placed 30 days ago` (blocked), `no tracking but placed 2 days ago` (allowed: within productionDays+shippingDays), `daily cap reached`, `category without case and not baseline` (PRODUCT_QUESTION in allow-list, no case → blocked), `passing → allowed with reasons []`.
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement** (collect every failing reason; `allowed = reasons.length === 0`). **Step 4: Run → PASS.**
- [ ] **Step 5: Commit** `feat(cs): auto-reply policy gate`

---

### Task 7: LLM helper, prompt and analysis

**Files:**
- Create: `src/lib/llm/anthropic.ts`, `src/lib/cs/analysis-schema.ts`, `src/lib/cs/agent-prompt.ts`, `src/lib/cs/analyze.ts`
- Test: `tests/cs-analyze.integration.test.ts`, `tests/cs-agent-prompt.test.ts`

**Interfaces:**
- Consumes Tasks 1, 4, 5.
- Produces:
```ts
// analysis-schema.ts
export const AnalysisSchema = z.object({
  category: z.enum(CS_CATEGORIES), urgency: z.enum(CS_URGENCIES), sentiment: z.enum(CS_SENTIMENTS),
  orderNumber: z.string().nullable(), summary: z.string(), facts: z.array(z.string()),
  proposal: z.string(), citedCaseIds: z.array(z.string()), draftReply: z.string().nullable(),
  needsHuman: z.boolean(), needsHumanReason: z.string(), autoReplyEligible: z.boolean(), autoReplyReason: z.string(),
})
export type Analysis = z.infer<typeof AnalysisSchema>
// anthropic.ts
export type Llm = { analyze(input: { system: string; user: string; model: string }): Promise<{ output: Analysis; tokensIn: number; tokensOut: number }> }
export function anthropicLlm(apiKey: string): Llm
// agent-prompt.ts
export function buildSystemPrompt(cases: CsCase[], settings: Pick<CsSettings,'productionDays'|'shippingDays'>): string
export function buildUserPrompt(i: { ticket: CsTicket; messages: CsMessage[]; order: OrderContext; previous: CsAnalysis[] }): string
// analyze.ts
export async function analyzeTicket(ticketId: string, deps: { llm: Llm; now?: Date }): Promise<CsAnalysis>
export function inputHashFor(messages: CsMessage[], order: OrderContext): string   // sha1 of customer message ids + order factoryState + shipment statuses
```

- [ ] **Step 1: Install deps** — `npm i @anthropic-ai/sdk zod`.
- [ ] **Step 2: Prompt test** `tests/cs-agent-prompt.test.ts`:
```ts
it('system prompt carries brand rules and POD facts', () => {
  const s = buildSystemPrompt([], { productionDays: 5, shippingDays: 15 })
  for (const needle of ['believe the customer', 'where it is wrong', 'never ask for a photo as proof', 'made to order', '5 business days', '7–15 days', 'before the order is handed to the factory', 'refund', 'citedCaseIds', 'Vietnamese', 'English'])
    expect(s.toLowerCase()).toContain(needle.toLowerCase())
})
it('cases are listed with ids and forbidden lines', ...)   // case {id:'c1', title, situation, resolution, forbidden:'never promise a refund'} → prompt contains '[c1]' and 'never promise a refund'
it('user prompt excludes nothing but shows order + thread in order', ...)
```
- [ ] **Step 3: Analyze test** with `fakeLlm` returning a fixed `Analysis` (category ADDRESS_CHANGE, urgency NORMAL, sentiment ANGRY) for a fixture ticket linked to a `NOT_SENT` order:
```ts
it('stores CsAnalysis with rule-raised urgency and updates the ticket', ...)   // analysis.urgency === 'URGENT', ticket.category/urgency/sentiment/orderId/orderMatch/lastAnalysisAt set, needsHuman true
it('skips the model when inputHash is unchanged', ...)                           // second call → llm.analyze not called, returns latest analysis
it('marks needsHuman when the model says eligible but the gate blocks', ...)    // gateJson.reasons non-empty
```
- [ ] **Step 4: Run → FAIL.**
- [ ] **Step 5: Implement `anthropicLlm`** — `new Anthropic({ apiKey, maxRetries: 2 })`, `client.messages.parse({ model, max_tokens: 4000, output_config: { effort: 'low', format: zodOutputFormat(AnalysisSchema) }, system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages: [{ role: 'user', content: user }] })`; throw if `parsed_output` is null or `stop_reason === 'refusal'`; return usage tokens.
- [ ] **Step 6: Implement `buildSystemPrompt`** — sections: role (Litzzy CS agent for a made-to-order POD store), brand voice (spec §2 verbatim in English: believe the customer; ask where it is wrong; never ask for a photo as proof — photo only as a secondary step framed as helping the workshop remake it; never argue policy; acknowledge fast; keeping the customer beats one reprint), POD facts (production ≈ `productionDays` business days, shipping 7–15 days, address/cancel possible only before the order is handed to the factory, tracking page URL pattern), output rules (summary/proposal/facts in Vietnamese for staff, draftReply in English, draftReply signs "Litzzy Support", never promise a refund/reship — propose it in `proposal`, any money decision → needsHuman true, cite `citedCaseIds` from the library, if no case fits set autoReplyEligible false), category/urgency/sentiment definitions, then "Case library" listing each active case as `[id] title — category\nSituation…\nResolution…\nForbidden…`, or "(empty — rely on the baseline rules)".
- [ ] **Step 7: Implement `buildUserPrompt`** — ticket header (id, subject, requester, created), order block (match, number, placed `MM/DD/YYYY`, factoryState, ship-to, lines, shipments with last checkpoint, design task statuses, candidates if AMBIGUOUS), previous analyses (category/urgency/summary, max 3), then the thread oldest→newest as `[CUSTOMER 10/23/2026 14:16]` / `[STAFF]` / `[AGENT]` with `private` marked; Freddy/SKIP never included.
- [ ] **Step 8: Implement `analyzeTicket`** — load ticket+messages; `buildOrderContext`; `inputHashFor`; return latest analysis if unchanged; call llm; `finalUrgency(model, ruleUrgency(...))` with `hoursUnanswered` from `lastCustomerAt`/`lastReplyAt`; run `autoReplyGate` (Task 6) with `autoRepliesToday = count CsMessage author AGENT createdAt ≥ today`, `hasActiveCaseForCategory` from `CsCase`; persist `CsAnalysis` (`gateJson = { allowed, reasons }`), update `CsTicket` fields (`needsHuman = !gate.allowed || output.needsHuman`).
- [ ] **Step 9: Run → PASS.** `npx tsc --noEmit` clean.
- [ ] **Step 10: Commit** `feat(cs): claude analysis of tickets with structured output`

---

### Task 8: Write-back, notify, auto-reply, cycle, scheduler

**Files:**
- Create: `src/lib/cs/actions.ts`, `src/lib/cs/agent.ts`, `src/lib/cs/scheduler.ts`
- Modify: `src/instrumentation.ts` (add `initCsScheduler`)
- Test: `tests/cs-agent-cycle.integration.test.ts`

**Interfaces:**
```ts
// actions.ts
export type Notifier = (text: string) => Promise<unknown>
export function noteHtml(a: CsAnalysis, ticket: CsTicket, appUrl: string): string
export function telegramText(a: CsAnalysis, ticket: CsTicket, appUrl: string): string
export async function writeBack(fd: Pick<FreshdeskClient,'update'|'note'>, ticket: CsTicket, a: CsAnalysis, settings: CsSettings): Promise<{ noted: boolean }>   // priority/tags/cf_order_id always via update; note only when sha1(summary+proposal+urgency) !== ticket.lastNoteHash → then save hash
export async function notify(notifier: Notifier, ticket: CsTicket, a: CsAnalysis, settings: CsSettings): Promise<boolean>   // only if urgency ∈ notifyLevels and hash changed (reuse lastNoteHash compare before writeBack saves it)
export async function autoReply(fd: Pick<FreshdeskClient,'reply'|'update'>, ticket: CsTicket, a: CsAnalysis): Promise<CsMessage>  // reply draft (HTML paragraphs), status 6, tag em-auto-replied, store CsMessage author AGENT with fdConversationId, ticket.autoReplied = true, needsHuman = false
export async function sendStaffReply(fd, ticket, body: string, opts: { private: boolean; userId: string }): Promise<CsMessage>  // public → status 6; stores STAFF message, lastReplyAt
// agent.ts
export type CycleDeps = { fd: FreshdeskClient; llm: Llm | null; notifier: Notifier; appUrl: string; now?: Date }
export async function runAgentCycle(deps: CycleDeps, opts?: { ticketIds?: string[]; force?: boolean }): Promise<CsAgentRun>
export async function defaultDeps(): Promise<CycleDeps | null>   // null when no Freshdesk key; llm null when no Anthropic key
// scheduler.ts
export function initCsScheduler(): void   // initOnce('cs-scheduler'); cron '*/2 * * * *' tz Asia/Ho_Chi_Minh; runExclusive('cs-agent', ...) ; skips when !pollEnabled
```

- [ ] **Step 1: Failing cycle test** — fake `fd` (records calls, serves fixtures from Task 3), fake `llm` (returns ORDER_STATUS/NORMAL/CALM with a draft for ticket 195 and ADDRESS_CHANGE/HIGH/ANGRY for 119), fake notifier (collects texts):
```ts
it('full cycle: syncs, analyses changed tickets, writes back and notifies HIGH only', ...)  // fd.update called for both with priority 3 for 119; one note each; notifier texts length 1 containing '#LIT4525'
it('auto-replies ticket 195 when settings allow and gate passes', ...)                       // settings autoReplyEnabled true → fd.reply called once with the draft; CsMessage AGENT stored; ticket.autoReplied true; CsAgentRun.autoReplied 1
it('does not auto-reply when autoReplyEnabled is false', ...)
it('re-run with no changes posts no second note and no second telegram', ...)                // Review Focus 5
it('runs without an llm: sync + rule urgency from keyword category is skipped, tickets stay needsHuman with no analysis', ...)  // llm null → analysed 0, run.error null
```
- [ ] **Step 2: Run → FAIL.** 
- [ ] **Step 3: Implement** `runAgentCycle`: create `CsAgentRun`; `syncTickets`; for each changed id (or `opts.ticketIds` / all open when `force`): `analyzeTicket` → `notify` → `writeBack` → if `gate.allowed && !output.needsHuman && draftReply` → `autoReply`; catch per-ticket errors into `run.error` (joined) and continue; set counters; `fdRequests = fd.requests`; `finishedAt`. Wrap each `fd` failure of `FreshdeskBudgetExceeded` by stopping the loop (remaining tickets wait for next cycle). `defaultDeps` reads settings/secrets, builds `FreshdeskClient`, `anthropicLlm`, `sendTelegramMessage`, `appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''`.
- [ ] **Step 4: Scheduler + instrumentation** — pattern from `src/lib/fulfillment/auto-fulfill-scheduler.ts`; add `const { initCsScheduler } = await import('./lib/cs/scheduler'); initCsScheduler()` to `src/instrumentation.ts`. Store `last_cs_run_result` JSON in AppSetting (`ranAt`, counters, error).
- [ ] **Step 4b: Daily digest** — in `actions.ts` add `export async function dailyDigest(notifier: Notifier, appUrl: string): Promise<boolean>` (counts `todo` tickets by urgency, sends one Telegram line per level, returns false when zero); schedule it in `scheduler.ts` at `0 9 * * *` under `runExclusive('cs-digest', …)`. Test in the cycle suite: two URGENT + one NORMAL todo → notifier text contains `URGENT: 2`.
- [ ] **Step 5: Run → PASS.** 
- [ ] **Step 6: Commit** `feat(cs): agent cycle with freshdesk write-back, telegram alerts and gated auto-reply`

---

### Task 9: API routes

**Files:**
- Create under `src/app/api/cs/`: `settings/route.ts` (GET view, POST patch + secrets, requireSuperadmin on POST), `settings/test/route.ts` (POST: Freshdesk `listTickets(now-1h)` + optional Claude ping → `{ freshdesk: ok|error, anthropic: ok|error|skipped }`), `sync/route.ts` (POST → `runAgentCycle(defaultDeps())`), `tickets/route.ts` (GET `?tab=todo|agent|done&q=`), `tickets/[id]/route.ts` (GET detail), `tickets/[id]/reply/route.ts` (POST `{ body, private }`), `tickets/[id]/analyze/route.ts` (POST → `runAgentCycle(deps, { ticketIds:[id], force:true })`), `tickets/[id]/resolve/route.ts` (POST → `resolvedInTool = true`, `needsHuman=false`, Freshdesk status 4), `cases/route.ts` (GET list, POST create), `cases/[id]/route.ts` (PATCH, DELETE), `cases/promote/route.ts` (POST `{ ticketId, replyBody }` → prefilled `CsCase` draft, `source: 'PROMOTED'`, `active: false`).
- Create: `src/lib/cs/queries.ts` with `listTickets(tab, q)`, `ticketDetail(id)`.
- Test: `tests/cs-queries.integration.test.ts`, `tests/cs-cases-route.integration.test.ts`

**Interfaces:**
```ts
export type TicketRow = { id, fdTicketId, subject, requesterEmail, orderNumber, category, urgency, sentiment, needsHuman, autoReplied, lastCustomerAt, lastReplyAt, summary: string | null, hoursUnanswered: number }
export async function listTickets(tab: 'todo'|'agent'|'done', q?: string): Promise<TicketRow[]>   // todo: needsHuman && !resolvedInTool && fdStatus ∉ {4,5}; agent: autoReplied && !needsHuman; done: resolvedInTool || fdStatus ∈ {4,5}; sort urgency URGENT>HIGH>NORMAL>LOW then lastCustomerAt asc
export async function ticketDetail(id: string): Promise<{ ticket: CsTicket; messages: CsMessage[]; analysis: CsAnalysis | null; order: OrderContext; cases: Pick<CsCase,'id'|'title'>[] } | null>
```

- [ ] **Step 1: Failing tests** — `listTickets('todo')` orders URGENT before HIGH and older customer message first; `q` matches order number and requester email; cases POST→GET→PATCH active false→DELETE through the route handlers (`new NextRequest(...)` as in `tests/design-studio-orders-route.integration.test.ts`).
- [ ] **Step 2: Run → FAIL.** **Step 3: Implement routes and queries** (every handler: `const auth = await requireApiAccess(req)` not needed — middleware enforces; settings POST uses `requireSuperadmin`; validate bodies, 400 on missing fields; Vietnamese error strings). **Step 4: Run → PASS**, `npx tsc --noEmit`.
- [ ] **Step 5: Commit** `feat(cs): api routes for tickets, cases and settings`

---

### Task 10: Pages

**Files:**
- Create: `src/app/cs/page.tsx`, `src/app/cs/[id]/page.tsx`, `src/app/cs/cases/page.tsx`, `src/app/cs/settings/page.tsx`, `src/components/cs/UrgencyChip.tsx`, `src/components/cs/OrderCard.tsx`, `src/components/cs/AgentPanel.tsx`

- [ ] **Step 1: `/cs` inbox** — header "Customer Service" + buttons "Đồng bộ ngay" (POST /api/cs/sync, shows counters) and link to settings; tabs `Cần xử lý` / `Agent đã trả lời` / `Đã xong`; search box; table rows: `UrgencyChip` (URGENT `bg-error text-on-error`, HIGH `bg-tertiary-container text-on-tertiary-container`, NORMAL `bg-surface-container-high`, LOW muted), category label (Vietnamese map in `src/lib/cs/labels.ts`: ADDRESS_CHANGE "Đổi địa chỉ", CANCEL_ORDER "Huỷ đơn", ORDER_STATUS "Hỏi đơn hàng", DAMAGED_OR_DEFECTIVE "Hàng lỗi/hỏng", WRONG_ITEM "Sai hàng", MISSING_ITEM "Thiếu hàng", DELIVERED_NOT_RECEIVED "Báo đã giao nhưng chưa nhận", REFUND_REQUEST "Xin hoàn tiền", PRODUCT_QUESTION "Hỏi sản phẩm", PERSONALIZATION_ISSUE "Lỗi cá nhân hoá", OTHER "Khác", SPAM "Spam"), order no., requester, summary (1 line, truncate), "chưa trả lời Xh" in red when > 24. Row click → `/cs/[id]`. Auto-refresh every 60 s.
- [ ] **Step 2: `/cs/[id]`** — two columns (`grid grid-cols-[1fr_380px] gap-lg`). Left: thread bubbles (CUSTOMER left `bg-surface-container`, STAFF/AGENT right `bg-secondary-container`, private notes dashed border + "Ghi chú nội bộ"), newest at bottom; reply box with textarea prefilled from `analysis.draftReply`, buttons "Gửi khách" (POST reply private:false) and "Ghi chú nội bộ"; after a public send show "Lưu thành case mẫu" → POST cases/promote then navigate to `/cs/cases?edit=<id>`. Right: `OrderCard` (number link to `/fulfillment/orders?q=`, placed date, factory state label — NOT_SENT "Chưa chuyển xưởng" in green, AT_FACTORY "Đang ở xưởng", SHIPPED "Đang vận chuyển", DELIVERED "Đã giao", CANCELLED "Đã huỷ" — ship-to, lines, tracking + last checkpoint); `AgentPanel` (urgency chip, category, sentiment, summary, facts list, proposal with cited case titles as links, gate reasons when blocked, buttons "Phân tích lại" and "Đánh dấu xong", "Agent đã trả lời" badge). Header shows Freshdesk link `https://litzzy.freshdesk.com/a/tickets/<fdTicketId>`.
- [ ] **Step 3: `/cs/cases`** — table (title, category, active toggle, source) + side form (title, category select, situation, resolution, toneNotes, forbidden, exampleReply, active); `?edit=<id>` opens the form; delete with confirm.
- [ ] **Step 4: `/cs/settings`** — card Freshdesk (domain, api key masked + replace field, "Test kết nối"), card Claude (api key masked, model text), card Agent (poll on/off, kill switch red, auto-reply on/off, category checkboxes, daily cap, production/shipping days), card Thông báo (Telegram levels checkboxes; link to Telegram config in Tools → Resources), card "Lần chạy gần nhất" from `GET /api/cs/settings` (`lastRun`). Save → POST; secrets sent only when the replace field is non-empty.
- [ ] **Step 5: Verify in the browser** — `preview_start` dev server, open `/cs` as SUPERADMIN: inbox lists live tickets after "Đồng bộ ngay" (auto-reply off), open #119 → ADDRESS_CHANGE, factory state SHIPPED, urgency HIGH, draft present; settings save round-trips; `read_console_messages` clean. Screenshot for the user.
- [ ] **Step 6: Commit** `feat(cs): customer service pages`

---

### Task 11: Docs and rollout notes

**Files:**
- Modify: `NOTES.md` (new "Customer Service" section: settings keys, scheduler, the Freddy shadow agent ids, rate budget, rollout phases), `PLAN.md` (phase entry), `CLAUDE.md` (one line under "Adding New API Routes"? no — add to the list in the header: active spec pointer), `.env.example` (`FRESHDESK_API_KEY=`, `FRESHDESK_DOMAIN=litzzy`, `ANTHROPIC_API_KEY=` as optional fallbacks).

- [ ] **Step 1: Write the docs.** 
- [ ] **Step 2: Run the full suite** `npx vitest run` → all green; `npx tsc --noEmit` clean; `npm run lint` clean.
- [ ] **Step 3: Commit** `docs(cs): notes, plan and env example for the customer service module`
