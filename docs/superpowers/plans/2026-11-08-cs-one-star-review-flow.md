# 1-star Review Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every 1★ Judge.me review is pulled in, matched to its order, classified, and either emailed by the agent (asking what went wrong, adapted to the order's state) or parked on the CS board for the owner, with one `REVIEW_RECOVERY` task per review.

**Architecture:**
- A Judge.me private-API client is polled every 3 hours. Reviews land in a new `CsReview` table.
- `review-recovery.ts` does three things:
  - matches each review to an order by reviewer email + product;
  - asks the CS model for the case, a Vietnamese task note and an English email (structured output);
  - opens the board task, and sends through the existing `FreshdeskClient.outboundEmail` when the "Tự liên hệ review 1★" switch is on.
- Replies come back as ordinary tickets tagged `em-review-1star`. The agent prompt is told where they came from.

**Tech Stack:** Next.js app router, Prisma 7 + SQLite, vitest on `test.db`, node-cron scheduler, zod structured LLM output (`llm.complete`).

**Spec:** `docs/superpowers/specs/2026-11-08-cs-one-star-review-flow-design.md`

## Global Constraints

- **Judge.me API:**
  - Base `https://api.judge.me/api/v1`.
  - Auth: header `X-Api-Token: <private token>` and query `shop_domain=caramiaus-store.myshopify.com`.
  - List: `GET /reviews?rating=1&per_page=<n>&page=<p>` → `{ current_page, per_page, reviews: Review[] }`.
  - One review: `GET /reviews/{id}` → `{ review }`.
  - `Review` fields used: `id, title, body, rating, product_external_id, product_title, product_handle, reviewer { email, name }, verified, hidden, created_at`.
- **Email content:**
  - Never mention the star score.
  - Never ask to change, remove or update the review.
  - Never offer a remedy (refund, resend, credit, discount).
  - Saying "we saw the review you left for <product> on order <#>" is required.
- **Email skips** (put on the board instead):
  - the reviewer's email had any Freshdesk ticket in the last 90 days;
  - the matched order is already refunded (`refundedAmount > 0`);
  - no confident match.
- **Confident match:** order `customerEmail` equals the reviewer email (case-insensitive) and a line's `shopifyProductId` ends with `/<product_external_id>`. Fallback: SKU parent code (sku before the first `-`) equals the code found in `product_title`. Take the latest order placed before `created_at`.
- **Reviews on "Shipping protection":** match by email only, take the latest order before the review, and use its first non-add-on line as the product.
- **Sending:** only when settings `reviewOutreachEnabled` is true and `killSwitch` is false. Default `reviewOutreachEnabled: false`, so the first run builds the board list with drafts for the owner to look at before switching on.
- **Freshdesk outbound email:** `email_config_id` = settings `outboundEmailConfigId`, `status: 6`, `priority: 2`, `tags: ['em-review-1star']`, `custom_fields.cf_order_id` = the order number.
- **New `/api/*` routes** fall under the existing `/api/cs` rule (`['cs']`). Writing the token is SUPERADMIN-only (the settings route already uses `requireSuperadmin`).
- **Schema change:**
  - migration built from `npx prisma migrate diff --from-schema <git show HEAD:prisma/schema.prisma> --to-schema prisma/schema.prisma --script` (`migrate dev` is silent on this PC);
  - `SCHEMA_VERSION` `v90` → `v91`.
- **Comments:** match the surrounding code (few comments, only non-obvious constraints). UI text in Vietnamese, customer emails in English.

## Review Focus

1. **A reviewer whose email matches no order, or two customers sharing one email.** Expect no email and a board task "không xác định được khách". Test in Task 2 (`matchReview returns null when no order has the product`).
2. **Re-running the sync.** It must never create a second `CsReview`, task or email for the same Judge.me id, even after the task is closed. Test in Task 4 (`second run sends nothing and opens no task`).
3. **The model draft breaking the rules:** a reply that mentions "review"+"star"/"update your review" or offers refund/replacement must be dropped. Expect the task kept with "bản nháp vi phạm quy tắc, CS viết tay" and nothing sent. Test in Task 3 (`guardDraft rejects a draft that asks to update the review`).
4. **Judge.me down or token wrong.** The cycle logs the error, nothing else breaks, and the settings "Kiểm tra" shows the error text. Test in Task 1 (`listReviews throws JudgemeError with the status on 401`).
5. **Switch flipped on later.** Drafted-but-unsent tasks from the off period get sent exactly once, using the stored draft. Test in Task 4 (`turning the switch on sends the stored drafts once`).

---

### Task 1: Judge.me token setting, client and "Kiểm tra" (deployable on its own; the owner is waiting to paste the token)

**Files:**
- Create: `src/lib/cs/judgeme.ts`, `tests/cs-judgeme.test.ts`
- Modify: `src/lib/cs/settings.ts` (secret `judgemeApiToken`, key `cs.judgemeApiToken`; masked view field `judgemeApiTokenMasked` / `hasJudgemeApiToken`; settings `reviewOutreachEnabled: boolean` default `false`, `judgemeShopDomain: string` default `'caramiaus-store.myshopify.com'`)
- Modify: `src/app/api/cs/settings/route.ts` (PATCH_KEYS += `reviewOutreachEnabled`, `judgemeShopDomain`; `saveCsSecrets` accepts `judgemeApiToken`; mask list += `judgemeApiTokenMasked`)
- Modify: `src/app/api/cs/settings/test/route.ts` (adds `judgeme: { ok, error?, reviews? }`)
- Modify: `src/app/cs/settings/page.tsx`:
  - token input next to the Kie key, same pattern as the other secrets;
  - in a new card "Review 1★": the switch "Tự liên hệ review 1★ (agent tự gửi email)" and the Judge.me shop domain input;
  - the "Kiểm tra" result shows the Judge.me line.
- Test: `tests/cs-settings.integration.test.ts` (extend)

**Interfaces:**
- Produces:
  - `type JmReview = { id: number; title: string | null; body: string; rating: number; productExternalId: string | null; productTitle: string | null; productHandle: string | null; reviewerEmail: string | null; reviewerName: string | null; verified: string | null; hidden: boolean; createdAt: Date }`
  - `class JudgemeError extends Error { status: number }`
  - `class JudgemeClient { constructor(o: { token: string; shopDomain: string; fetch?: typeof fetch }); listReviews(o: { rating: number; page: number; perPage: number }): Promise<JmReview[]>; getReview(id: number): Promise<JmReview | null> }`. `getReview` returns `null` on 404.
  - `CsSecrets.judgemeApiToken: string | null`
  - `CsSettings.reviewOutreachEnabled`, `CsSettings.judgemeShopDomain`

- [ ] **Step 1: Write failing tests** in `tests/cs-judgeme.test.ts`, using an injected fake `fetch`:
  - `sends the token header and shop domain`: the request URL is `https://api.judge.me/api/v1/reviews?rating=1&per_page=50&page=2&shop_domain=caramiaus-store.myshopify.com` and the headers carry `X-Api-Token: tok`.
  - `maps a review`: given `{ id: 7, title: 'Sad', body: 'Still waiting', rating: 1, product_external_id: 8891490140317, product_title: 'Stwa X', product_handle: 'stwa-x', reviewer: { email: 'A@B.com', name: 'Ann' }, verified: 'buyer', hidden: false, created_at: '2026-11-08T10:00:00Z' }`, expect `reviewerEmail 'a@b.com'`, `productExternalId '8891490140317'`, `createdAt` as a Date.
  - `listReviews throws JudgemeError with the status on 401`.
  - `getReview returns null on 404`.

  In `tests/cs-settings.integration.test.ts`:
  - `review outreach defaults off and the shop domain to Litzzy`.
  - `the Judge.me token is stored masked`: `saveCsSecrets({ judgemeApiToken: 'abcd1234wxyz' })` gives `getCsSecrets().judgemeApiToken === 'abcd1234wxyz'`, and the view's masked value is `'abcd…wxyz'`.
- [ ] **Step 2:** Run `npx vitest run tests/cs-judgeme.test.ts tests/cs-settings.integration.test.ts`. Expected: FAIL (module missing, fields undefined).
- [ ] **Step 3: Implement** `judgeme.ts` and the settings/route/page changes above. The test route calls `listReviews({ rating: 1, page: 1, perPage: 1 })` and reports `{ ok: true, reviews: n }` or `{ ok: false, error }`.
- [ ] **Step 4:** Rerun Step 2's command. Expected: PASS. Then run `npx vitest run tests/cs-`: all pass.
- [ ] **Step 5: Commit**: `feat(cs): Judge.me API token setting, client and connection test`. Deploy now (no schema change; build + restart) so the owner can paste the token.

### Task 2: `CsReview` table, sync and order matching

**Files:**
- Modify: `prisma/schema.prisma`:
  - new model `CsReview { id cuid; judgemeId Int @unique; rating Int; title String?; body String; productExternalId String?; productTitle String?; reviewerEmail String?; reviewerName String?; verified String?; hidden Boolean; reviewCreatedAt DateTime; orderNumber String?; matchNote String?; caseType String?; status String @default("NEW"); draftSubject String?; draftBody String?; fdTicketId Int?; sentAt DateTime?; taskId String?; createdAt; updatedAt; @@index([status]) }`;
  - `CsTask` += `reviewId String?`.
- Create: migration `prisma/migrations/20261108150000_cs_reviews/`
- Modify: `src/lib/db.ts` (`SCHEMA_VERSION 'v91'`), `src/lib/cs/task-labels.ts` (type `REVIEW_RECOVERY`, label `'Review 1★'`, dept `CS`, priority 2)
- Create: `src/lib/cs/review-recovery.ts` (sync + match only in this task), `tests/cs-review-recovery.integration.test.ts`

**Interfaces:**
- Consumes: `JudgemeClient`, `JmReview` (Task 1).
- Produces:
  - `syncReviews(client: Pick<JudgemeClient, 'listReviews'>, now?: Date): Promise<{ added: number }>`. Pages `rating=1, perPage=50` newest first. It stops at a page whose reviews are all already stored, or after 10 pages. It upserts by `judgemeId` and never resets `status`.
  - `matchReview(r: Pick<CsReview, 'reviewerEmail' | 'productExternalId' | 'productTitle' | 'reviewCreatedAt'>): Promise<{ orderNumber: string; lineId: string } | { orderNumber: null; reason: string }>`.

- [ ] **Step 1: Write failing tests** (fixtures as in `tests/cs-custom-verify.integration.test.ts`: project + store upsert, `order.create` with lines):
  - `syncReviews stores new 1★ reviews once`: the fake client returns 2 reviews on page 1 and `[]` after. Two runs give 2 rows; the second run returns `added 0`.
  - `syncReviews keeps the status of a review already handled`.
  - `matchReview finds the order by email and product id`: the order's line has `shopifyProductId 'gid://shopify/Product/8891490140317'`.
  - `matchReview falls back to the SKU parent code in the product title`: the line has sku `DN2509261948-US, 20OZ`, the review title is `'HaPo Wizard … Tumbler DN2509261948'`.
  - `matchReview takes the latest order before the review date`.
  - `matchReview returns null when no order has the product`, with a reason containing `'không'`.
  - `a review on Shipping protection matches the reviewer's latest order before the review`.
- [ ] **Step 2:** Run `npx vitest run tests/cs-review-recovery.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Schema, migration (Global Constraints recipe), `npx prisma generate`, then implement.
- [ ] **Step 4:** Rerun. Expected: PASS. Run `npx vitest run tests/cs-`: all pass.
- [ ] **Step 5: Commit**: `feat(cs): store 1-star Judge.me reviews and match them to orders`.

### Task 3: Case + email draft from the CS model, with a rule guard

**Files:**
- Create: `src/lib/cs/review-prompt.ts` (exports `ReviewDraftSchema`, `buildReviewSystemPrompt()`, `buildReviewUserPrompt(...)`, `guardDraft(...)`)
- Modify: `src/lib/cs/review-recovery.ts` (adds `draftForReview`)
- Test: `tests/cs-review-prompt.test.ts`, plus extend `tests/cs-review-recovery.integration.test.ts`

**Interfaces:**
- Produces:
  - `ReviewDraftSchema = z.object({ caseType: z.enum(['NOT_RECEIVED','NOT_AS_PICTURED','WRONG_ITEM','PERSONALIZATION','QUALITY','OTHER']), taskType: z.enum(TASK_TYPES), taskDetail: z.string(), subject: z.string(), body: z.string(), alsoCsComplaint: z.boolean() })`. `taskType` is the follow-up job for the team, per the spec table; `taskDetail` is Vietnamese.
  - `guardDraft(body: string): string | null`. Returns the reason the draft must not be sent, or `null`. It rejects any of: `/\b(star|stars|rating)\b/i`, `/(update|change|edit|remove|delete|revise)\s+(your|the)\s+review/i`, `/\b(refund|replacement|replace|resend|reprint|remake|credit|discount|voucher|coupon|free)\b/i`. It also rejects a body without `"review"` (the required "we saw the review" opening).
  - `draftForReview(reviewId: string, deps: { llm: Llm; now?: Date }): Promise<{ caseType: string; subject: string; body: string; taskType: TaskType; taskDetail: string; blocked: string | null }>`. It builds the order context with `buildOrderContext({ subject: '', texts: [], cfOrderId: orderNumber, email: reviewerEmail })`, calls `llm.complete` with `schemaName: 'review_draft'` inside `withCap(settings.llmDailyCallCap, …)`, saves `caseType/draftSubject/draftBody` on `CsReview`, and returns `blocked = guardDraft(body)`.
- The system prompt must carry:
  - the spec's two tables (case → what to check / what to ask; order state → how to adapt);
  - the house frame (first name; "we saw the review you left for <product> on order <#>"; what we checked; one specific question; within 24 hours; "Warm regards,\nLitzzy Support");
  - the prohibitions from Global Constraints.

- [ ] **Step 1: Write failing tests:**
  - `buildReviewSystemPrompt carries the rules`: the lowercased prompt contains `'we saw the review'`, `'never mention the star'`, `'never ask'`, `'not yet shipped'`, `'delivered'`, `'shipping protection'`, `'one specific question'`.
  - `guardDraft rejects a draft that asks to update the review` (`'…would you consider updating your review?'` → non-null).
  - `guardDraft rejects an offer` (`'we can send a replacement'` → non-null).
  - `guardDraft rejects a draft that never mentions the review`.
  - `guardDraft passes a clean draft` (`'Hi Ann,\n\nWe saw the review you left for the Stwa shirt on order #LIT1. …'` → `null`).
  - `draftForReview stores the draft and returns the guard result`, with a fake llm returning a fixed `ReviewDraftSchema` object.
- [ ] **Step 2:** Run `npx vitest run tests/cs-review-prompt.test.ts tests/cs-review-recovery.integration.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS.
- [ ] **Step 5: Commit**: `feat(cs): draft a 1-star review outreach email by case and order state, with a rule guard`.

### Task 4: Process reviews: skip rules, board task, send gated by the switch, scheduler, agent context

**Files:**
- Modify: `src/lib/cs/review-recovery.ts` (adds `processReviews`)
- Modify: `src/lib/cs/scheduler.ts`: a cron at minute 15 every 3 hours runs `runExclusive('cs-reviews', runReviewCycle)`, which builds `JudgemeClient` from secrets/settings and calls `syncReviews` then `processReviews`. It does nothing without a token.
- Modify: `src/lib/cs/agent-prompt.ts` + `src/lib/cs/analyze.ts`: `buildUserPrompt` takes `reviewOrigin?: boolean`. The analyze step passes `ticketTags(ticket.fdTags).includes('em-review-1star')`. When it is true, the prompt adds the line `# Origin: this ticket started from our email about the customer's 1★ review. Never mention the star score and never ask them to change or remove the review; solve the problem under the usual rules.`
- Test: `tests/cs-review-recovery.integration.test.ts`, `tests/cs-agent-prompt.test.ts`

**Interfaces:**
- Consumes: `syncReviews`, `matchReview`, `draftForReview`, `FreshdeskClient.outboundEmail`, `createTask`-like insertion (use `prisma.csTask.create` with `type 'REVIEW_RECOVERY'`, `reviewId`, `source 'AGENT'`, a `CREATED` event, `dueAt +24h` to match `openTask` in `tasks.ts`; export `openTask` from `tasks.ts` if that is cleaner).
- Produces: `processReviews(deps: { llm: Llm | null; fd: { outboundEmail(p: OutboundPayload): Promise<{ id: number }> }; fdLookup: { ticketsByEmail(email: string): Promise<{ id: number; created_at: string }[]> }; now?: Date }): Promise<{ tasks: number; sent: number }>`. `fdLookup` wraps Freshdesk `GET /tickets?email=` and treats HTTP 400 "no contact" as `[]`; add `ticketsByEmail` to `FreshdeskClient`.
- Per review in status `NEW`, the order is:
  1. match;
  2. skip checks (90-day ticket, refunded, no match), each writing `status 'PARKED'` and a task whose detail says why, with no LLM call;
  3. draft;
  4. guard;
  5. the task carries the review quote plus the draft as a COMMENT event;
  6. if `reviewOutreachEnabled && !killSwitch && !blocked`, send, set `status 'SENT'`, `fdTicketId`, `sentAt`, and move the task to `WAITING` with an event `Đã gửi email review tới <email> (Freshdesk #<id>)`; otherwise set `status 'DRAFTED'`.
- Reviews in status `DRAFTED` are sent on a later run once the switch is on, using the stored draft without a new LLM call.

- [ ] **Step 1: Write failing tests:**
  - `a matched review gets a task and an email when the switch is on`: the outbound payload has `tags ['em-review-1star']` and `cf_order_id`; the task is `WAITING`; `CsReview.status` is `SENT`.
  - `with the switch off it drafts and opens the task but sends nothing`: `DRAFTED`, task `NEW`, `sent 0`.
  - `turning the switch on sends the stored drafts once`: llm calls stay at 1.
  - `a reviewer with a ticket in the last 90 days is parked without an email or llm call`.
  - `a refunded order is parked`.
  - `an unmatched review is parked with the reason`.
  - `a blocked draft is not sent and the task says CS must write it`.
  - `second run sends nothing and opens no task`.
  - `the kill switch stops sending`.
  - `a raised rating is logged on the open task`: `runReviewCycle`'s follow-up calls `getReview(judgemeId)` for reviews whose task is still open. A rating that changed from 1 to 4 adds the event `Khách đã đổi đánh giá: 4★`, updates `CsReview.rating` and leaves the task open. Implement this as `followUpRatings(client: Pick<JudgemeClient, 'getReview'>, now?: Date): Promise<{ changed: number }>` in `review-recovery.ts`, called after `processReviews`.
  - In `cs-agent-prompt.test.ts`: `a review-origin ticket tells the agent never to raise the review`.
- [ ] **Step 2:** Run `npx vitest run tests/cs-review-recovery.integration.test.ts tests/cs-agent-prompt.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun, then run `npx vitest run tests/cs-` and `npx tsc --noEmit -p .` (filter to `src/lib/cs`, `src/app/(api/)?cs`, `tests/cs-`). Expected: green, no type errors.
- [ ] **Step 5: Commit**: `feat(cs): reach out on 1-star reviews: park, draft, send behind a switch, every 3 hours`.

### Task 5: Show the review on the board

**Files:**
- Modify: `src/lib/cs/tasks.ts` (`taskDetail` includes the linked `CsReview`, selecting `rating, title, body, productTitle, reviewerName, reviewerEmail, reviewCreatedAt, status, caseType, judgemeId, orderNumber, matchNote`)
- Modify: `src/app/cs/tasks/page.tsx`:
  - The drawer for `REVIEW_RECOVERY` shows the star count, the quote, the product, the reviewer, the date, the outreach status (`Đã gửi` / `Bản nháp, chờ bật công tắc` / `Tạm giữ: <matchNote>`) and the draft.
  - The card shows a short quote.
- Test: extend `tests/cs-tasks-route.integration.test.ts` with `task detail carries its review`.

- [ ] **Step 1:** Write the failing route test (create a `CsReview` and a `REVIEW_RECOVERY` task with `reviewId`; GET `/api/cs/tasks/[id]` returns `review.body`).
- [ ] **Step 2:** Run it. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Rerun. Expected: PASS. Lint the touched files: `npx eslint --no-eslintrc -c .eslintrc.json --ext .ts,.tsx <files>`.
- [ ] **Step 5: Commit**: `feat(cs): review card and drawer on the task board`.

### Task 6: Deploy and first run with the switch off

- [ ] **Step 1:** Rebase on `origin/main`, then run `npx vitest run tests/cs-` and `npx tsc --noEmit -p .`. Expected: green.
- [ ] **Step 2:** Push `HEAD:main`. Deploy with migration (memory `vps-deploy-process`):
  1. wait for any `next build`;
  2. `git checkout -- package-lock.json`, then pull;
  3. back up `dev.db` (VACUUM INTO);
  4. `pm2 stop podmanager`, then `npx prisma migrate deploy`, `npx prisma generate`, `npm run build`;
  5. `pm2 start podmanager`, `pm2 save`.

  Expected: `/login` returns 200.
- [ ] **Step 3:** After the owner pastes the token, press "Kiểm tra" (or call the test route). Expected: `judgeme.ok true`. Run `runReviewCycle` once with the switch off.
- [ ] **Step 4:** Report the board list to the owner in Vietnamese:
  - per review: customer, order, case, the draft's first lines;
  - which reviews were parked and why.

  The owner switches outreach on after reading it. That answers the open backlog question safely.
