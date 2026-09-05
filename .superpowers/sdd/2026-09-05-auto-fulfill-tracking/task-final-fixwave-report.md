# Final-Review Fix Wave Report — Auto Fulfilled

Branch: `feat/auto-fulfill`. All nine review items (F1–F9) applied.

## F1 — `orders(first: 25 ...)` → `first: 50` in fetchOrderFulfillmentOrdersByNames

**File:** `src/lib/shopify-orders.ts:589` (query string inside `fetchOrderFulfillmentOrdersByNames`)

25 names batched into a `first: 25` order page had zero headroom — a single sheet name
matching more than one Shopify order (e.g. a base name and its `R1` revision) would push
a requested order off the page, silently dropping it and producing a false `not_found`.
Changed to `first: 50`, matching the sibling `fetchOrderLinePropsByNames` (`first: 50` for
its 25-name batches, `src/lib/shopify-orders.ts:472`). The 25-names-per-batch loop is
unchanged (`src/lib/shopify-orders.ts:601`).

## F8 — removed decorative section-header comment

**File:** `src/lib/shopify-orders.ts` (was line 546, directly above `ShopifyOrderFO`)

Removed the banner comment `// ─── Fulfillment-order read + fulfillment create (for Auto
Fulfilled) ───────`. It carried no non-obvious constraint, so it violates the CLAUDE.md
"no comments unless explaining a non-obvious constraint" rule. Other pre-existing banner
comments in the file were left untouched (out of scope for this item).

## F2 — `setMinAgeDays` invalid input now falls back to `DEFAULT_MIN_AGE_DAYS`

**File:** `src/lib/fulfillment/auto-fulfill-sheets.ts:42-49`

Extracted the coercion into a pure exported `coerceMinAgeDays(n: unknown): number`:
- non-finite `Number(n)` (e.g. `"abc"`) → `DEFAULT_MIN_AGE_DAYS` (5)
- finite input → floored and clamped to `>= 0`

`setMinAgeDays` now calls `coerceMinAgeDays(n)` instead of the old
`Math.max(0, Math.floor(Number(n) || 0))`, which previously collapsed any invalid input
(including `"abc"` and `0`) down to `"0"`.

**Test added:** `src/lib/fulfillment/auto-fulfill-sheets.test.ts` — new `describe('coerceMinAgeDays', ...)` block:
`coerceMinAgeDays('abc') === 5`, `coerceMinAgeDays(0) === 0`, `coerceMinAgeDays(7) === 7`,
`coerceMinAgeDays(-3) === 0`, `coerceMinAgeDays(3.9) === 3`.

## F4 — `openByLineId` now only counts OPEN/IN_PROGRESS fulfillment orders

**File:** `src/lib/fulfillment/build-fulfill-plan.ts:54-69`

Added `OPEN_FO_STATUSES = new Set(['OPEN', 'IN_PROGRESS'])`; the loop building
`openByLineId` now skips any FO whose `status` is not in that set (ON_HOLD, SCHEDULED,
CANCELLED, INCOMPLETE, CLOSED, etc. are no longer treated as fulfillable).

Empty-`openByLineId` handling was split into three cases (in order):
1. `displayFulfillmentStatus === 'FULFILLED'` → `already_fulfilled` (unreachable in
   practice since that's already gated earlier in the function, but kept per spec for
   defensiveness/clarity).
2. FOs exist AND none of them are OPEN/IN_PROGRESS (`fulfillmentOrders.some(fo =>
   OPEN_FO_STATUSES.has(fo.status))` is false) → `needs_manual`, message `'Fulfillment
   order chưa mở (on hold/scheduled)'`. This is distinct from an OPEN FO whose lines are
   simply all at `remainingQuantity: 0` (already fulfilled) — that case still falls
   through to case 3, not `needs_manual`.
3. Otherwise (no FOs at all, or an open FO with nothing left to fulfill) → `already_fulfilled`.

Ordering (`not_found` → `placedAt`-null → `too_recent` → `FULFILLED` → open-line handling)
is unchanged.

## F9 — `normalizeBaseOrder` behavior unchanged; constraint documented

**File:** `src/lib/fulfillment/build-fulfill-plan.ts:7-9`

No behavior change — the existing regex (`/(_[A-Za-z0-9]+)+$/`, requires a literal
leading underscore) already does not strip `R`/`R1` suffixes since they have no
underscore. Added a one-line-context comment directly above `normalizeBaseOrder`
explaining why revision tokens like `R`/`R1` (`#LIT2362R1`, `#LIT2736R`) must stay
distinct order names and must never be folded into the base (risk: fulfilling the wrong
order).

## F3 + F4 + F9 — new tests

**File:** `src/lib/fulfillment/build-fulfill-plan.test.ts`

- `preserves revision tokens like R/R1 — they are distinct orders, not sub-order suffixes`
  — `normalizeBaseOrder('#LIT2362R1') === 'LIT2362R1'`, `normalizeBaseOrder('#LIT2736R')
  === 'LIT2736R'`.
- `idempotent-skip: a sub-order line already fulfilled (remainingQuantity 0) is skipped,
  not needs_manual` — two-line order, one FO line at `remainingQuantity: 0`, the other at
  `1`; only the open line is planned.
- `no-open-lines: FO is OPEN but all lines have remainingQuantity 0 → already_fulfilled`
  — single OPEN FO, all lines closed, `displayFulfillmentStatus: 'PARTIALLY_FULFILLED'`.
- `FO on hold: a single FO with status ON_HOLD and an open-qty line → needs_manual`.
- `FO in progress: status IN_PROGRESS with a remaining line still gets fulfilled` →
  `will_fulfill`.

All pre-existing `build-fulfill-plan.test.ts` cases (age-gate, split-by-tracking,
needs_manual-unmapped-line, not_found, already_fulfilled-when-FULFILLED) still pass
unchanged — they already pass `status: 'OPEN'` on their fulfillment-order fixtures, so
the F4 filter is a no-op for them.

## F5 — Preview now reports planned counts

**File:** `src/lib/fulfillment/auto-fulfill.ts`

- `summary.fulfilled` now increments for every `will_fulfill` plan regardless of
  `opts.apply` (`case 'will_fulfill': summary.fulfilled++; break`, line ~104). In apply
  mode, a plan that fails `createFulfillment` is mutated to `status: 'error'` before this
  switch runs, so failed applies still correctly fall into the `errored` bucket, not
  `fulfilled`.
- Added (lines ~74-76): when `!opts.apply && plan.status === 'will_fulfill'`,
  `fulfilledLines` is set to `plan.fulfillments.reduce((sum, f) => sum + f.lineItems.length, 0)`
  — the planned line count — before the row is pushed. In apply mode `fulfilledLines` is
  still only incremented per actually-successful `createFulfillment` call, unchanged.

## F6 — writeback now also sets `carrier: 'Other'`

**File:** `src/lib/fulfillment/auto-fulfill.ts` (`prisma.shipment.updateMany` call inside
the apply branch, ~line 86)

Added `carrier: 'Other'` to the `data` object alongside `trackingNumber`, `trackingUrl`,
`shopifyFulfillmentId`, `status: 'FULFILLED'`, matching spec §5's write-back field list.
`Shipment.carrier` is `String?` in `prisma/schema.prisma:424` — no schema change needed.

## F7 — done-summary message now includes `notFound`

**File:** `src/app/fulfillment/auto-fulfill/page.tsx` (`run()`'s `setMessage(...)` after
a completed run)

Added `${doneMsg.notFound} không thấy đơn` into the summary string, between `cần tay` and
`lỗi`, so the Vietnamese run summary now reads: `... cần tay, N không thấy đơn, N lỗi / N đơn.`

## Verification

- `npx vitest run src/lib/fulfillment` → **3 test files, 27 tests, all passed.**
- `npx tsc --noEmit -p tsconfig.json` → **exit 0, no output.**
- Full `npx vitest run` (whole repo, informational only): 85/86 files pass, 450/452 tests
  pass. The 2 failures are in `src/lib/order-profit.test.ts`
  (`returns null if a line has base cost but no supplier`,
  `manual cost without supplier mapping still counts as unmapped`) — pre-existing,
  unrelated to this fix wave (last touched by commit `d1d7187`, not modified here), and
  outside the fulfillment module this task scoped.
- No `for...of` over a `Map`/`Set` was introduced; the new `.some()`/`.has()` calls on
  `OPEN_FO_STATUSES` (a `Set`) and the existing `.forEach()` usage on `Map`s are method
  calls, not `for...of` iteration.

## Files changed

- `src/lib/shopify-orders.ts` (F1, F8)
- `src/lib/fulfillment/auto-fulfill-sheets.ts` (F2)
- `src/lib/fulfillment/auto-fulfill-sheets.test.ts` (F2 tests)
- `src/lib/fulfillment/build-fulfill-plan.ts` (F4, F9)
- `src/lib/fulfillment/build-fulfill-plan.test.ts` (F3/F4/F9 tests)
- `src/lib/fulfillment/auto-fulfill.ts` (F5, F6)
- `src/app/fulfillment/auto-fulfill/page.tsx` (F7)

Not touched: pre-existing unrelated working-tree changes (`.gitignore`,
`src/components/spy/AdDetailModal.tsx`, `src/lib/spy/scan-ads.ts`,
`tests/__snapshots__/project-analytics.characterization.test.ts.snap`) and untracked
scratch files (`scripts/__pycache__/`, `scripts/cache-ad-media.py`,
`scripts/fix-sku-jeep-girl.mjs`) — none staged or committed as part of this fix wave.
