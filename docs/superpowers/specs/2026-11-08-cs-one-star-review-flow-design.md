# CS — 1-star review recovery flow

Status: design, 2026-11-08. Owner: duc0812. Builds on the CS agent (`docs/superpowers/specs/2026-10-23-customer-service-agent-design.md`), the CS task board (`/cs/tasks`, `src/lib/cs/tasks.ts`, NOTES.md "CS Task board") and the agent rules in `src/lib/cs/agent-prompt.ts`.

## Why

Litzzy uses Judge.me for product reviews. The store shows 540 published reviews, 25 of them 1★ (2026-11-08). Each one is an unhappy customer whom nobody follows up. The owner wants the agent to reach out on every 1★ review, find out what went wrong and offer a fitting fix, so that the customer ends up satisfied. If they are satisfied, they may raise the review themselves.

## Goals

1. Every new 1★ Judge.me review is noticed within a few hours, matched to its customer and order, and gets one agent email asking what went wrong.
2. The case is followed on the CS task board until it is closed, including when the customer never answers.
3. The existing 1★ backlog is worked through the same way.

## Non-goals

- Replying publicly on Judge.me. That may come later; this flow is email only.
- 2★ and 3★ reviews (owner said 1★).
- Changing, hiding or unpublishing reviews.

## Anti-goals (a failure even if it works)

- **The email asks for a better review, mentions the star score, or ties any remedy to changing or removing the review.** The US FTC rule on consumer reviews (16 CFR 465) and Judge.me's terms forbid review-conditioned incentives and review suppression. The owner's wording: we do not ask directly; we ask what the problem is and propose a fitting fix. Saying *that* we saw their review is allowed and wanted (owner, 2026-11-08), so the customer knows why we are writing.
- An email reaches the wrong person (a guessed match).
- A customer gets two outreach emails about the same review, or an outreach email on top of a ticket staff are already handling.

## Decisions the owner made

- **The agent sends the first email itself**, with no staff approval step.
- **The first email says we saw their review, then asks what went wrong.** It names the product and the order, says what we checked, and asks one specific question. No remedy is promised, as the offer rules in `agent-prompt.ts` require ("Offers need approval").
- **The content follows the order's current state** (owner, 2026-11-08). See "Email content by case and order state" below.
- **Customers who already have a Freshdesk ticket are skipped for now.** Their review goes on the board for the owner to decide (e.g. the four Stwa reviewers #251–#254 and Toni/#LIT4700 #249).
- **A Judge.me private API token will be supplied by the owner** through a new settings field.

## Calls I made (the owner can change them)

- **Backlog:** every published 1★ review with no existing ticket, no date limit.
- **Matching:**
  - **With the token:** Judge.me gives the reviewer email (and, where available, the order), so the match uses the email plus the product.
  - **Without a token, or with no confident match:** no email is sent; the board task says "không xác định được khách" for CS.
- **Settings:** a "Judge.me API token" field in Cài đặt CS, set only by a Super Admin. It is stored in the DB like the other CS secrets, returned masked, and has a "Kiểm tra" button.
- **Polling:** a background job reads Judge.me every 2–4 hours, rating = 1, newest first.
- **Ticket and email:** the outbound email is sent like the verify-custom emails (Freshdesk `tickets/outbound_email`, LITZZY SUPPORT mailbox, `cf_order_id` set, tag e.g. `em-review-1star`). When the customer replies, the existing CS agent handles it under its normal rules: offers need approval, at most two agent replies, then a person. The agent's prompt must know this ticket came from a 1★ review so it never raises the review itself.
- **Board:** a new task type, e.g. `REVIEW_RECOVERY` ("Review 1★"), CS dept, priority 2. One task per review, carrying the Judge.me review id, rating, text, product, date and the matched order/ticket. The task stays open until staff close it. Re-reading Judge.me never creates a second task for the same review. If the customer later raises the rating, the task records the new rating as an event; this is a check, not a goal.
- **"Already has a ticket" means:** any Freshdesk ticket from the reviewer's email in the last 90 days, open or closed. An order already refunded in Shopify also counts. Both go on the board, not to email.
- **Confident match:** the reviewer's email equals the email on an order that contains the reviewed product (by product id, else by SKU parent code). If several orders match, take the latest one placed before the review date. Anything else gets no email.
- **Remedies after the customer answers:** no case is pre-approved yet. The agent follows "Offers need approval" (checking with my supervisor, 24 hours) and puts its recommendation in the proposal. The owner may later pre-approve remedies per case via the case library.
- **Sending hours:** any time. Replies are handled by the normal business / after-hours rules.
- **Sequencing:** build after the verify-custom work, which is now on main (`be0bd2d`, `223d4a1`, `fbfe009`). That work added `FreshdeskClient.outboundEmail`, `outboundEmailConfigId`, `VERIFY_CUSTOM` and `Order.salesChannel`. Reuse them.
- **Language:** the email follows the house voice (memory `cs-reply-voice`): first name, specific, short. No "entirely on us" unless the order data confirm our fault.

## Email content by case and order state

The 25 published 1★ reviews (2026-11-08) fall into five cases. The agent classifies the review text (an LLM call through the existing CS model) and reads the order context (`buildOrderContext`: factory state, shipments and last scan, personalisation per line, print file / mockup names, refunds) before it writes.

| Case | Real examples | Check before writing | What the email asks | Board task |
|---|---|---|---|---|
| 1. Not received / too slow | "Haven't gotten the shirt", "30 days no product", "Never arrived but still got charged" (7) | tracking, last scan, delivered or not | states what tracking shows; if marked delivered, asks about neighbours / mailbox | CARRIER_CHECK |
| 2. Not like the photos / description | Stwa "flat plastic not a bauble", "not embossed, a decal", "not a Stanley cup" (9) | was the right item sent; is the listing misleading (known: Stwa acrylic) | what exactly differs from what they expected; a photo is optional, framed as helping us fix it | OTHER, flagged "listing" so the team fixes photos/copy |
| 3. Wrong item / colour / size | "wrong purse", "no handle and straw", "wrong colour" (5) | order line vs print file / mockup (who erred: customer, us, factory; case #LIT5022) | states what the order holds, asks what arrived | SUPPLIER_ERROR or per case #LIT5022 |
| 4. Personalisation missing / wrong / unreadable | "personalization was missing", "can't read the name, should say Sandra" (3) | name typed at checkout vs print file | confirms the name they typed, asks what was missing or unreadable | SUPPLIER_ERROR or PERSONALIZATION_CHANGE |
| 5. Quality / damage | "sides tore from the strap", "poor workmanship", "very thin" (3–4) | delivery date, within the 30-day policy | where the damage is; a photo helps the factory | SUPPLIER_ERROR |

Reviews posted on the "Shipping protection" product must be traced to the real product in the same order. When the review also complains about our support ("won't refund", "all I get is it's on its way"), the email apologises for that specifically.

The order's state changes the opening and the question:

| Order state | How the email adapts |
|---|---|
| Not yet shipped / in production | Say where the order is (production, about N business days), that nothing is lost; for case 1 this is the answer itself. |
| In transit, scans moving | Give the last scan and place; ask them to bear with it while we follow the carrier (the existing "Late or stalled parcels" rule, customs only as a possibility). |
| In transit, stalled or no scans | Say we are contacting the carrier today and will update within 24 hours. |
| Delivered | Ask the case question (what arrived, what is wrong); for case 1 ask about neighbours / mailbox / safe place. |
| Already refunded or resent | Do not email; put it on the board for the owner (the review predates or ignores the fix). |
| Open ticket or any ticket in 90 days | Do not email; board task for the owner (owner decision above). |
| No confident match | Do not email; board task for CS. |

Every email follows the house frame: first name; "we saw the review you left for <product> on order <#>"; what we checked; one specific question; an answer within 24 hours; "Warm regards, Litzzy Support". Never the star score, never a request about the review, never an offer.

## Constraints

- Follow CLAUDE.md:
  - new `/api/*` routes need `API_ACCESS_RULES`;
  - token writes need `requireSuperadmin`;
  - secrets never travel from the client;
  - tests run on `test.db`.
- The `/cs/tasks` board, `CsTask` and `CsTaskEvent` already exist, and so do the verify-custom pieces listed under Sequencing. Do not duplicate them.
- The prod VPS is weak: pace Judge.me and Freshdesk calls, and keep the daily LLM cap (`llmDailyCallCap`, 500) in mind.
- A schema change needs a migration built with `prisma migrate diff`, a `SCHEMA_VERSION` bump, and the stop → migrate → generate → build deploy.

## Left to the builder

- **Judge.me API details:** endpoints, paging, which fields carry email and order, rate limits. Read Judge.me's API docs. The public, unauthenticated feed `https://judge.me/reviews/all_reviews_js_based?shop_domain=caramiaus-store.myshopify.com&platform=shopify&page=N` returns HTML of published reviews and can serve as a read-only fallback and test fixture source.
- **Data storage:** whether review data lives on the task (new columns) or in its own small table.
- **The exact email wording,** within the rules above.
- **Board UI:** how the review shows on the board (stars, quote, Judge.me link).
