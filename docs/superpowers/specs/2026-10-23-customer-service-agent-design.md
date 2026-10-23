# Customer Service Agent (Freshdesk × Ecom Manager) — Design

Date: 2026-10-23 · Status: approved to build (owner said "triển khai đi")
Store: Litzzy only (Freshdesk account `litzzy.freshdesk.com`, one human agent `support@litzzy.com`).

## 1. Intent

Litzzy gets 15–20 tickets/day today, growing. One person handles them in Freshdesk.
The owner wants an AI agent that is **part of the handling loop**, not a side report:

1. Every ticket is read, matched to its order in the tool, classified and **ranked by urgency**
   (address change before the factory prints = the race that must never be lost).
2. Every ticket gets a **short summary + a proposed resolution** so staff decide in seconds.
3. When the agent has **complete context and the case is one it is allowed to handle**, it
   **answers the customer itself** (phase 1: first "where is my order" with a clear tracking).
4. Anything touching money (refund, partial refund, reship at our cost) is **proposed, never decided**
   by the agent. Staff decide.
5. A **case library** ("thư viện case", like a law library) tells the agent how Litzzy handles each
   situation. Starts empty; staff fill it, partly by promoting their own real replies.

Evidence this matters (ticket #119, 2026-10-20): customer wrote "you're sending it to the wrong
place" with the correct address in the body. Freshdesk's own AI wrote a private note saying addresses
lock after 12 h; staff replied three days later with a tracking link and never addressed the address.
Customer is now angry and the parcel is in transit to the wrong place. The agent must surface exactly
this: category ADDRESS_CHANGE, URGENT, order #LIT4525, handoff state, and the new address extracted.

## 2. Brand voice (non-negotiable)

Litzzy is a branding-first POD store. Customer emotion comes first:

- Believe the customer. On a damaged / wrong item ask **"where is it wrong so we can fix it"**, never
  "send a photo to prove it". A photo may be requested as a secondary step, framed as
  "so the workshop can remake it right".
- Never argue policy at the customer. Explain what we will do, then what we need from them.
- Fast acknowledgement beats a perfect answer; a dispute/chargeback is the thing to avoid.
- Keeping the customer and the brand is worth more than one reprint.

The agent system prompt encodes this; the case library refines it.

## 3. Goals / non-goals / anti-goals

Goals
- Zero urgent tickets missed: URGENT/HIGH tickets ping Telegram within one poll cycle (≤ 2 min) and
  sit at the top of the tool inbox in red.
- Staff can work a ticket end-to-end inside the tool (read thread, see order/tracking/factory state,
  see summary + proposal + draft, edit, send). Freshdesk stays the system of record for the thread.
- Agent auto-replies only inside an explicit allow-list, with a full audit trail.
- Case library is editable by staff and is what the agent cites.

Non-goals (this phase)
- Reminiso / Rosterpress mailboxes. Chat / social channels. Freshdesk Freddy AI (left in shadow mode,
  ignored; our tags are prefixed `em-`).
- Automatic refunds, Shopify edits, or factory cancellations by the agent.
- Multi-language replies (customers write English; replies are English).

Anti-goals (would make it a failure even if it "works")
- Agent sends a reply that contradicts the brand voice or quotes policy at an upset customer.
- Agent auto-replies to a thread a human has already touched, or to a second customer message.
- A ticket is downgraded in urgency because the model was unsure (uncertainty → escalate, never relax).
- Freshdesk rate limit (40 req/min on this plan) exhausted by the poller so staff can't use Freshdesk.

## 4. Constraints discovered

- Freshdesk API v2, basic auth `apiKey:X`, ~40 req/min. Ticket statuses used: 2 Open, 3 Pending,
  4 Resolved, 5 Closed, 6 Waiting on Customer, 7 Waiting on Third Party, 9000 Assigned to AI Agent.
  Priority 1–4. Custom field `cf_order_id` (text, often `#LIT4525`). Group `Litzzy` 158000834119.
  Agent id for `support@litzzy.com` = 158024049112; Freddy shadow agents 158024416092/3.
  Conversations: `GET /tickets/{id}/conversations` (incoming, private, user_id, body, body_text).
  Reply: `POST /tickets/{id}/reply {body}`; note: `POST /tickets/{id}/notes {body, private:true}`;
  update: `PUT /tickets/{id} {priority, tags, status, custom_fields}`.
- The tool already mirrors Litzzy orders: `Order` (shipping address, `supplierHandoffAt`,
  `pipelineStatus`), `OrderLine`, `Shipment` (tracking, status, checkpoints), `DesignTask`,
  `SupplierOrderPush`. "Already at the factory" =
  `supplierHandoffAt != null || pipelineStatus in (EXPORTED, FULFILLED) || any SupplierOrderPush in (SENDING, CREATED)`.
- No LLM code exists in the repo. Telegram helper exists (`src/lib/telegram.ts`). Schedulers are
  node-cron in-process (`src/instrumentation.ts`, `initOnce` + `runExclusive`), and must call lib
  functions directly (no session cookie).
- Secrets live in `AppSetting` via `token-store.ts`; settings views mask them. The Freshdesk key
  currently sits in `.env` under a non-standard name — it moves to settings (env fallback
  `FRESHDESK_API_KEY` / `FRESHDESK_DOMAIN`).
- Permissions: new feature `cs` (roles.ts + api-access.ts), default on for ADMIN and SUPPORT.

## 5. Decisions

### 5.1 Where staff work — owner left open; **my call: inside the tool**
Staff read, draft, and **send from `/cs`**; the tool posts to Freshdesk (reply or private note). The
Freshdesk UI remains usable; anything done there is picked up on the next poll. Reason: the summary,
order card and draft live here, and sending here is what makes the agent's draft a one-click action.

### 5.2 LLM — my call: Anthropic Messages API, model `claude-opus-5-5` (effort low; model id editable in settings)
Key in AppSetting `cs.anthropicApiKey` (env fallback `ANTHROPIC_API_KEY`), entered on the CS settings
card. Structured JSON output (tool-use with a fixed schema). One call per analysis; temperature low.
The builder reads the `claude-api` skill before writing the helper (`src/lib/llm/anthropic.ts`).

### 5.3 Sync loop
- node-cron every 2 min (`*/2 * * * *`, Asia/Ho_Chi_Minh), `runExclusive('cs-sync')`.
- Cursor `cs.sync.updatedSince` in AppSetting; `GET /tickets?updated_since=&order_by=updated_at&include=requester,description&per_page=100`.
- For each changed ticket: fetch conversations only if `updated_at` moved; upsert `CsTicket` +
  `CsMessage`. Budget: ≤ 25 Freshdesk calls per cycle; leftovers wait for the next cycle.
- A ticket is **analysed** when it has a customer (incoming, non-private) message newer than its last
  analysis, or has never been analysed. Spam/closed tickets older than the cursor start are skipped.
- Manual "Sync now" and "Re-analyse" buttons exist for staff.

### 5.4 Agent run (one analysis)
Input: full thread (customer + staff + our own earlier replies; Freddy private notes excluded),
requester email/name, `cf_order_id`, subject; order context from the tool (match by `#LIT\d+` in
subject/body/cf_order_id, else by customer email, newest first, flag if >1 match); shipment state;
factory state; previous analyses of the ticket; the **case library** (all active cases, compact).

Output (JSON, stored as `CsAnalysis`):
```
category        ADDRESS_CHANGE | CANCEL_ORDER | ORDER_STATUS | DAMAGED_OR_DEFECTIVE | WRONG_ITEM |
                MISSING_ITEM | DELIVERED_NOT_RECEIVED | REFUND_REQUEST | PRODUCT_QUESTION |
                PERSONALIZATION_ISSUE | OTHER | SPAM
urgency         URGENT | HIGH | NORMAL | LOW
sentiment       CALM | FRUSTRATED | ANGRY | DISPUTE_THREAT
orderNumber, orderMatch: EXACT | BY_EMAIL | AMBIGUOUS | NONE
summary         ≤ 3 lines, Vietnamese, for staff
facts           bullet list the model extracted (new address, item wrong how, dates promised…)
proposal        what to do, Vietnamese, cites case ids it relied on (citedCaseIds[])
draftReply      English email body ready to send (or null)
needsHuman      boolean + reason
autoReplyEligible boolean + reason   (model's view; the policy gate below has the final say)
```

Urgency rules (deterministic, applied after the model; model may only raise, never lower):
- ADDRESS_CHANGE / CANCEL_ORDER and order **not yet at factory** → URGENT.
- ADDRESS_CHANGE / CANCEL_ORDER and already at factory/in transit → HIGH.
- DAMAGED_OR_DEFECTIVE, WRONG_ITEM, MISSING_ITEM, DELIVERED_NOT_RECEIVED, REFUND_REQUEST,
  any `DISPUTE_THREAT` → HIGH.
- ORDER_STATUS, PRODUCT_QUESTION, PERSONALIZATION_ISSUE → NORMAL; OTHER → NORMAL; SPAM → LOW.
- Customer wrote again with no reply for > 24 h → bump one level.

### 5.5 Auto-reply policy gate (code, not model)
Auto-send only when **all** hold:
1. `cs.autoReply.enabled` and category ∈ `cs.autoReply.categories` (default `["ORDER_STATUS"]`).
2. It is the customer's **first** message in the ticket and no human/agent reply exists.
3. `orderMatch = EXACT` (or BY_EMAIL with exactly one order), sentiment CALM or FRUSTRATED (not ANGRY /
   DISPUTE_THREAT), no refund / address / cancel wording detected.
4. The order has a shipment with a tracking number **or** is within the promised production window
   (configurable `cs.productionDays`, default 5 business days, and `cs.shippingDays`, default 15).
5. Daily cap `cs.autoReply.dailyCap` (default 30) not reached; kill switch off.
6. A case-library entry of the category is active **or** the built-in baseline for that category is
   enabled (`ORDER_STATUS` baseline ships enabled; everything else requires a library case).
On send: Freshdesk reply from the support agent, ticket status → 6 (Waiting on Customer), tag
`em-auto-replied`, `CsMessage` stored with `author = AGENT`.

Everything else → **needs human**: tool inbox + Telegram if URGENT/HIGH.

### 5.6 Write-back to Freshdesk on every analysis
- priority ← urgency map (URGENT 4, HIGH 3, NORMAL 2, LOW 1); `cf_order_id` if empty and matched.
- tags: `em-<category-kebab>`, `em-urgent` / `em-high` as applicable (existing tags preserved).
- one **private note** "Ecom Manager: <summary> · Đề xuất: <proposal> · <link to /cs/<id>>", only when
  the analysis changed (hash) — so staff who open Freshdesk directly still see it.

### 5.7 Notifications
`sendTelegramMessage` on URGENT and HIGH (settable: `cs.notify.levels`), once per analysis change,
HTML: urgency badge, ticket subject, order number, summary line, deep link. Also a daily 09:00 digest
of open needs-human tickets (count by urgency) — my call, cheap and useful.

### 5.8 Case library
`CsCase { id, title, category, situation, resolution, toneNotes, forbidden, exampleReply, active,
source: MANUAL | PROMOTED, promotedFromTicketId?, createdById, updatedAt }`.
UI `/cs/cases`: list, create, edit, toggle active. On the ticket page, after staff send a reply (edited
or not), a "Lưu thành case mẫu" button pre-fills a case from the ticket + reply. The agent receives
the active cases (title/situation/resolution/forbidden, truncated) and must list `citedCaseIds`.

### 5.9 Data model (Prisma, SQLite)
- `CsTicket` fdTicketId(unique) subject status priority fdTags requesterEmail requesterName
  orderId? orderNumber? orderMatch category urgency sentiment needsHuman autoReplied
  fdCreatedAt fdUpdatedAt lastCustomerAt lastReplyAt lastAnalysisAt resolvedAt
- `CsMessage` fdConversationId(unique, null for description) ticketId author(CUSTOMER|STAFF|AGENT|SYSTEM)
  private bodyText bodyHtml? fromEmail createdAt
- `CsAnalysis` ticketId runAt model inputHash output(JSON) summary proposal draftReply category
  urgency sentiment needsHuman citedCaseIds autoReplyEligible gateResult(JSON) tokensIn tokensOut
- `CsCase` as above. `CsAgentRun` (per cycle log: ticketsSeen, analysed, autoReplied, errors).
- Settings in AppSetting under `cs.*` (domain, apiKey, anthropicApiKey, model, pollEnabled,
  autoReply.*, notify.levels, productionDays, shippingDays, sync.updatedSince, kill switch).
- Bump `SCHEMA_VERSION`.

### 5.10 UI
- Sidebar group **Customer Service**: `Tickets` (`/cs`), `Thư viện case` (`/cs/cases`),
  `Cài đặt` (`/cs/settings`).
- `/cs` inbox: tabs Cần xử lý / Agent đã trả lời / Đã xong; sort urgency desc then
  lastCustomerAt asc; row = urgency chip (red/orange/neutral), category, order no., requester,
  summary (1 line), age, "chưa trả lời Xh".
- `/cs/[id]`: left thread (customer / staff / agent bubbles, private notes muted); right column:
  order card (status, factory state, ship-to, tracking + last checkpoint, link to Design Studio
  order), agent panel (summary, facts, proposal with cited cases, draft), reply box (prefilled with
  draft; "Gửi khách" / "Ghi chú nội bộ"), buttons "Phân tích lại", "Đánh dấu xong", "Lưu case mẫu".
- `/cs/settings`: Freshdesk domain + key (masked), Anthropic key (masked), model, poll on/off,
  auto-reply on/off + categories + daily cap, Telegram levels, production/shipping days, "Test
  connection", kill switch, last run status.
- All labels Vietnamese; customer-facing text English. Date format MM/DD/YYYY.

### 5.11 API routes (all under `/api/cs`, access `['cs']`; writes to settings SUPERADMIN)
`GET /tickets`, `GET /tickets/[id]`, `POST /tickets/[id]/reply` (body, private), `POST /tickets/[id]/analyze`,
`POST /tickets/[id]/resolve`, `POST /sync`, `GET|POST /cases`, `PATCH|DELETE /cases/[id]`,
`GET|POST /settings`, `POST /settings/test`.

## 6. Testing
- Unit: urgency rules, policy gate, order matching (number in subject/body/cf, email fallback,
  ambiguity), Freshdesk payload mapping, tag/priority write-back diff.
- Integration (test.db): sync upserts from fixture JSON; analysis stored; auto-reply path with a
  mocked LLM + mocked Freshdesk client; promote-to-case.
- Manual on dev: run against live Freshdesk with `cs.autoReply.enabled=false`, confirm #119 →
  ADDRESS_CHANGE / HIGH (already in transit) with the new address in facts.

## 7. Left to the builder
- Exact prompt wording (must embed §2 and the POD baseline: made-to-order, production ~5 business
  days, shipping 7–15 days, address editable only before factory handoff, tracking page
  `https://litzzy.com/apps/trackingorder?nums=<tracking>`).
- HTML sanitising of Freshdesk bodies for display; quoting the customer's thread in replies (don't).
- Backfill: first run analyses only tickets with status 2/6/7 updated in the last 7 days.

## 8. Rollout
1. Deploy with poll on, auto-reply **off**, Telegram on. Owner reviews a week of summaries/drafts.
2. Turn on auto-reply for ORDER_STATUS. Watch `em-auto-replied` tickets daily.
3. Fill the case library; widen categories one at a time.
