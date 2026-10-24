# CS Insights & Staff Performance — Design

Date: 2026-10-24 · Status: built (branch `feat/cs-insights`) · Builds on `2026-10-23-customer-service-agent-design.md`
(Freshdesk sync, `CsTicket`/`CsMessage`/`CsAnalysis`, GPT 6.1 Sol via Kie, pages under `/cs`).

## 1. Intent

The owner runs a POD pipeline: order → **Design** (Design Studio tasks) → **Fulfillment** (hand the
print files to the factory) → **Factory** (produce + ship) → **Carrier**. When a customer complains, he
wants to know **which stage caused it**, with evidence, and to see the pattern over time so he can go to
design, fulfillment or the factory with numbers and example tickets. He also has **one CS staff member**
(all replies in Freshdesk come from `support@litzzy.com`) whose handling he judges weak, and wants the
tool to measure that with hard numbers, review every reply, and tell him what to fix.

## 2. Goals / non-goals / anti-goals

Goals
- Every problem ticket gets a **root-cause stage** (Design / Fulfillment / Factory / Carrier / Customer /
  Listing / Unknown) with evidence drawn from the order's real timeline, editable by staff.
- `/cs/insights`: issue statistics by stage, category, week, product, factory, with drill-down to tickets.
- `/cs/performance`: the four metrics the owner named (first/next response time, replies per ticket,
  premature closes, customer sentiment after each reply) plus an AI review of every staff reply and a
  periodic improvement write-up; staff vs agent on the same metrics.
- Backfill both over the ~175 tickets already synced (and everything synced later), unattended.

Non-goals
- Per-person attribution beyond "staff" vs "agent" (one Freshdesk account).
- Changing how tickets are answered; this phase reads and reports.
- SLA enforcement or automatic escalation (reports only).

Anti-goals
- Blaming a stage without evidence: when the timeline is missing, the stage is `UNKNOWN`, never a guess
  presented as fact.
- Counting the agent's auto-replies as staff replies, or Freddy's shadow notes as replies at all.
- A review that only says "be nicer": every reply grade must cite the rubric item and quote the sentence.

## 3. Data already available (verified 2026-10-24)

- `CsMessage` has every customer / STAFF / AGENT / SYSTEM public message with timestamps; private notes
  flagged. `CsTicket.fdStatus` (2 open, 3 pending, 4 resolved, 5 closed, 6 waiting on customer), `fdTags`
  (Freshdesk adds `reopen 1 day` when a customer writes to a closed ticket).
- `CsAnalysis` per ticket: category, urgency, sentiment (ticket-level), summary, proposal.
- Order timeline: `Order.placedAt`, `DesignTask.createdAt/status`, `DesignTaskEvent` (SYSTEM, ARTWORK,
  STATUS, ASSIGN, HANDOFF, NOTE with timestamps), `Order.supplierHandoffAt`, `SupplierOrderPush.pushedAt /
  remoteStatus`, `Shipment.status / checkpointsJson / lastCheckpointAt`, `OrderLine.customAttributesJson`
  (what the customer typed), `designDriveLink` (what was sent to print).
- Settings `cs.productionDays` (5) and `cs.shippingDays` (15) define "late".

## 4. Decisions

### 4.1 Root-cause investigation (per ticket, agent step)
A second LLM pass, **after** triage, only for problem categories (DAMAGED_OR_DEFECTIVE, WRONG_ITEM,
MISSING_ITEM, DELIVERED_NOT_RECEIVED, ORDER_STATUS when the order is late, REFUND_REQUEST,
PERSONALIZATION_ISSUE, ADDRESS_CHANGE after handoff). Input = the thread + an **order timeline** block the
tool builds deterministically:

```
placed 10/02 14:11 · design task created 10/02 14:12 · design DONE 10/04 09:30 (1.8 d)
handed to factory 10/09 16:00 (5.2 d after design) via API, push CREATED, remote status PRINTED 10/11
shipment SWX… IN_TRANSIT, first scan 10/12, last scan 10/20 (no movement 8 d) · promised: production 5 bd + shipping 7–15 d
customer typed: Name = "Laurance"  ·  print file: <drive link name>  ·  design note: …
```
Output (stored on `CsAnalysis` as `rootCauseStage`, `rootCauseEvidence` (Vietnamese, ≤3 lines),
`rootCauseConfidence` LOW/MEDIUM/HIGH, `issueType` — a finer label than category:
WRONG_TEXT, WRONG_IMAGE, WRONG_SIZE_COLOR, PRINT_QUALITY, DAMAGED_IN_TRANSIT, LATE_DESIGN, LATE_HANDOFF,
LATE_PRODUCTION, LATE_SHIPPING, LOST, NOT_AS_DESCRIBED, CUSTOMER_INPUT, OTHER).
Deterministic hints are computed first and passed to the model (design duration, handoff gap, production
gap, transit gap, which one exceeds its budget), so "late" attributions do not depend on the model's
arithmetic. Rules the prompt states: wrong text with the customer's typed value correct in the order →
Design or Factory depending on whether the approved file (design note / artwork) carries the wrong text;
file sent ≠ approved file → Fulfillment; address wrong but matches what the customer typed → Customer.
Staff can override on the ticket page (`CsTicket.rootCauseStageOverride`, `rootCauseNote`, `rootCauseById`);
reports use the override when present. `UNKNOWN` when the order is not matched or the timeline is empty.

### 4.2 `/cs/insights`
Filters: period (this week / last 4 weeks / this month / custom), stage, category. Cards: problem tickets,
% of all tickets, top stage, top issue type. Charts (simple bar/line, no new chart lib — plain SVG/CSS):
tickets by stage; by issue type; weekly trend per stage; top 10 products (OrderLine.productTitle) and
suppliers (`Order.exportedToSupplierId` / push supplier) by problem count. Table: ticket, order, stage,
issue type, confidence, evidence, link. Export CSV of the table (same filters).

### 4.3 Performance metrics (deterministic, `src/lib/cs/performance.ts`)
Computed from `CsMessage` for a period (ticket counted in the period of its first customer message):
1. **First response time** = first STAFF public reply − first CUSTOMER message. **Next response time** = for
   every later CUSTOMER message that is followed by a STAFF reply, reply − message. Report median, mean,
   p90, % over 24 h, worst 10. Calendar hours (my call; business hours later if asked).
2. **Replies per ticket** = count of STAFF public replies on tickets with ≥1 reply; % of tickets needing
   > 3; list of those tickets.
3. **Premature closes**: a ticket counts when a CUSTOMER message arrives after the ticket was at status
   4/5 (tool records `CsTicket.closedAt` whenever sync sees status move to 4/5, and `reopenCount` when a
   customer message postdates `closedAt` or the `reopen` tag appears). Report count, % of closed tickets,
   and the sentiment of the reopening message.
4. **Sentiment trajectory**: per customer message sentiment (CALM/FRUSTRATED/ANGRY/DISPUTE_THREAT, stored
   per message by the review pass, 4.4). For each STAFF reply with a customer message before and after:
   improved / same / worse. Report the three shares and the "worse after reply" list.
Agent column: the same 1, 2, 4 for AGENT replies (3 does not apply).

### 4.4 Reply review (LLM pass per ticket, `CsReplyReview`)
Runs once per ticket when it has ≥1 STAFF public reply and (a) the ticket is resolved/closed, or (b) no
new message for 48 h, or (c) a new STAFF reply appeared since the last review. One call returns:
- `messageSentiments`: sentiment for every CUSTOMER message (feeds 4.3.4).
- For every STAFF reply: `score` 1–5, `issues[]` from a fixed rubric —
  `IGNORED_QUESTION`, `ASKED_PHOTO_AS_PROOF`, `TEMPLATE_ONLY`, `NO_RESOLUTION` ("we are checking" with no
  next step/date), `WRONG_FACT` (contradicts order data), `PROMISED_FORBIDDEN` (refund/reship promised),
  `TONE` (cold, blaming, policy-first), `CLOSED_UNRESOLVED`, `TOO_SLOW` (set by code from metric 1),
  `GOOD` — plus a one-line reason quoting the offending sentence and a suggested rewrite (English).
- `ticketVerdict`: resolved / unresolved / unclear, one line.
Stored as `CsReplyReview { ticketId, messageId, score, issues JSON, reason, rewrite, runAt, model }` and
`CsMessage.sentiment` for customer messages. Backfill: a one-off job over all synced tickets, bounded by
the Kie budget (no Freshdesk calls needed), ~1 call per ticket.

### 4.5 Improvement write-up (`CsPerformanceReport`)
On demand ("Tạo đánh giá") and every Monday 08:00 for the previous week: the tool aggregates 4.3 + 4.4
(counts per issue, score distribution, worst examples) and asks the model for a Vietnamese write-up:
top 3 weaknesses with numbers and 2 quoted examples each, what good looks like (rewrite of one example),
3 concrete habits to change, and what improved vs the previous period. Stored with the period, shown on
`/cs/performance`, Telegram gets a 5-line summary.

### 4.6 `/cs/performance`
Period filter. Row of metric cards (1–4) with staff vs agent. Score distribution of replies, issue-type
bar chart, table of reviewed replies (ticket, date, score, issues, quote, rewrite) filterable by issue.
The latest write-up at the top, history below.

### 4.7 Data model additions
- `CsAnalysis`: `rootCauseStage?`, `rootCauseEvidence?`, `rootCauseConfidence?`, `issueType?`.
- `CsTicket`: `closedAt?`, `reopenCount Int @default(0)`, `rootCauseStageOverride?`, `rootCauseNote?`,
  `rootCauseById?`, `reviewedAt?`.
- `CsMessage`: `sentiment?`.
- `CsReplyReview`, `CsPerformanceReport { id, periodStart, periodEnd, kind WEEKLY|MANUAL, metricsJson,
  body, createdAt }`.
- Settings: `cs.review.enabled` (default on), `cs.review.weeklyReport` (on).

### 4.8 Routes (all `['cs']`, writes to overrides/reports by anyone with `cs`)
`GET /api/cs/insights?from&to&stage&category` (+ `&format=csv`), `GET /api/cs/performance?from&to`,
`POST /api/cs/performance/report` (manual write-up), `POST /api/cs/review/backfill` (superadmin, one-off),
`PATCH /api/cs/tickets/[id]/root-cause`.

## 5. Constraints
- Same Kie budget/rate limits; review pass runs inside the existing 2-min cycle after triage, ≤5 reviews
  per cycle, backfill ≤20 per minute.
- No new chart library; keep bundle small (plain SVG bars/lines like the rest of the tool).
- Dates MM/DD/YYYY; labels Vietnamese; quotes from customer/staff kept in English.

## 6. Left to the builder
Exact prompts; the timeline formatter; CSV columns; how the weekly cron shares `runExclusive` with the
agent cycle; what "no movement N days" threshold flags LATE_SHIPPING (my default: 7 days without a scan).

## 7. Builder-check answers (my calls unless marked owner)
- **Orders older than Design Studio (before 2026-10-09) have no design/handoff timeline.** Use
  `Order.exportedAt` (CSV export) as the hand-off proxy when `supplierHandoffAt` is null; `LATE_DESIGN` /
  `LATE_HANDOFF` are only possible when a `DesignTask` exists, otherwise lateness is split between
  Factory (handoff→first scan) and Carrier (first scan→now) and the evidence says "no design timeline".
- **Backfill of closed tickets that were never triaged**: one combined pass (category + root cause +
  reply review in a single call) for tickets at status 4/5; **no Freshdesk write-back and no Telegram**
  for closed tickets. Open tickets keep the normal triage → root-cause → review sequence.
- **Replies sent from the tool that are the agent's draft**: `CsMessage.source` = `DRAFT_UNCHANGED` |
  `DRAFT_EDITED` | `OWN` | `FRESHDESK` recorded at send time (reply route compares the body with the
  latest `draftReply`). Staff metrics and reply reviews count `OWN`, `DRAFT_EDITED` and `FRESHDESK`;
  `DRAFT_UNCHANGED` replies are reported as their own line ("gửi nguyên nháp agent: N") and reviewed
  under the agent. *(Owner may change this definition.)*
- **Timestamps for metrics 1 and 3 come from Freshdesk `include=stats`** (`first_responded_at`,
  `agent_responded_at`, `resolved_at`, `closed_at`, `reopened_at`) stored on `CsTicket` as `fd*At`
  columns and refreshed on every sync; message-derived values are the fallback when stats are null.
  A premature close = `reopened_at` set, or a CUSTOMER message after `resolved_at`/`closed_at`. The
  `reopen 1 day` tag is informative only.
- **LLM spend guard**: `cs.llm.dailyCallCap` (default 500 calls/day across triage, root cause, review,
  write-ups; counted in `CsAgentRun`), `cs.review.model` (default = `cs.model`). Backfill is resumable
  (processes oldest-first, records progress in `last_cs_review_backfill`), started by the superadmin
  button, not automatically after deploy. At GPT 6.1 Sol prices the whole backlog costs ≈ $2–3.
- Review trigger also covers tickets with only AGENT replies (so the agent column of metric 4 exists).
- Multi-line orders: the model returns `affectedLineIds`; fallback = all lines count for the product
  breakdown. Week = Monday–Sunday Asia/Ho_Chi_Minh. `TOO_SLOW` threshold 24 h. "Late" uses calendar
  days like `policy.ts`.
