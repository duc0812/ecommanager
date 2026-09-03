# Design SKU Reuse & Card Mechanism (NON_CUSTOM + CUSTOM)

Date: 2026-09-03
Status: Approved (Approach A)

## Problem

Some orders export with a blank design column even though the design is "done".
Root cause found on the production DB (order `#LIT3510` and 37 others):

- The order's mapped `SupplierProduct` has `requiresDesign = 0` (426 of 481 products
  are `0`; the flag defaults to `false` and was almost never set).
- Because no line has `requiresDesign`, `resolveOrderDesign` skips its loop and returns
  `orderDesignReady = true` by default (`src/lib/design-library.ts:27`), with an empty
  `missing` and empty `lineLinks`.
- Consequences per order:
  - `designReady` is stamped `true` with no design link anywhere.
  - NON_CUSTOM: `needsCard = missing.length > 0 = false` → **no Trello card is created**.
  - CUSTOM: `hasCustomDesignLine = false` → skips `PENDING_DESIGN` → jumps straight to
    `READY_TO_PRODUCTION`, still designReady with no link.
  - Export reads `line.designDriveLink` / `order.designDriveLink` / `SkuDesign` — all
    null → **blank design cell**.

All 38 symptom orders share: every supplier line has `requiresDesign = 0`.

## Business decisions (confirmed)

1. Reuse key for "same design" = **full Shopify SKU variant + supplierId**
   (matches current `SkuSupplierDesign` keying).
2. A line "needs design" = **every product line mapped to a supplier**
   (`!isNonProductLine && resolvedSupplierId != null`). Drop the `requiresDesign` gate.
3. NON_CUSTOM: reuse design from library. First time a SKU is not in the library →
   create a card. Card done → design goes into the library → later orders auto-resolve.
4. CUSTOM: always needs design, always create a card, **no library reuse**. Order sits
   in `PENDING_DESIGN` until its card is done.
5. Multi-line orders: **each line must have its own design file** (no shared/positional
   fallback). A SKU whose file can't be identified stays not-ready (never reused wrongly).
6. Fix both order types in this pass.
7. Backfill the 38 broken orders: recreate cards so their designs enter the library.

## Approach A — rewire the existing library mechanism

Keep both tables; no schema change:
- `SkuSupplierDesign` (sku + supplierId → designLink, ready, trelloCardId) = reuse library.
- `SkuDesign` (sku → driveLink) = master artwork by sku.

### 1. `resolveOrderDesign` (`src/lib/design-library.ts`)

- A library entry counts as usable **only when `ready && designLink`** (guards the
  latent ready-but-null-link case; such an entry is treated as missing → needs card).
- `orderDesignReady = missing.length === 0` (remove the default-true short-circuit).
- Add reuse control so CUSTOM does not consult the library. Either an `allowReuse`
  option or the caller passes a null-returning lookup for CUSTOM.

### 2. `designInputs` construction (`src/app/api/shopify/orders/sync/route.ts`)

- `requiresDesign` → `!!sp?.supplierId` (mapped product line = needs design).
- `existingDesignLink` = the line's current `designDriveLink` read from the DB, so a
  re-sync does not re-flag a CUSTOM line that already has a design from its card.
- Build the lookup per order type: NON_CUSTOM → `designLookup` (ready+link only);
  CUSTOM → always `null`.

### 3. Status (`src/lib/pipeline-status.ts`)

- Rename/redefine `hasCustomDesignLine` → `hasDesignLine` = order has ≥1 design-needing
  line. `autoDetectStatus`: `hasDesignLine && !hasDesignReady` → `PENDING_DESIGN`.
- NON_CUSTOM that reuses library → `designReady = true` → `READY_TO_PRODUCTION`.
- NON_CUSTOM first-time / CUSTOM pending → `PENDING_DESIGN`.

### 4. Card creation (`src/app/api/shopify/orders/sync/route.ts`)

- `needsCard`: CUSTOM → always; NON_CUSTOM → `designResolution.missing.length > 0`.
- NON_CUSTOM: link each missing (sku, supplier) to the card via `SkuSupplierDesign`
  upsert (`ready=false`, `trelloCardId`) — already implemented.

### 5. Multi-line-safe library population (`src/app/api/trello/sync/route.ts`,
`src/lib/repos/design-library.ts`)

Current bug: `markLibraryReadyByCard` stamps `driveAttachments[0]` onto **every**
`SkuSupplierDesign` of the card, and the `SkuDesign` upsert loop uses the first
attachment for every sku. Multi-line orders with distinct designs get cross-contaminated
library links.

Fix: match each `SkuSupplierDesign(sku)` (and `SkuDesign(sku)`) of the card to the drive
file whose name/URL contains that SKU (reuse the SKU/`order_line`-token matcher from
`findDriveAttachmentForLine`). A SKU with no identifiable file stays `ready=false` — never
populated with a wrong link. The per-order-line matching (lines 111-129) already handles
the current order's export; this fixes the reuse path.

### 6. Export (`src/app/api/fulfillment/export/route.ts`)

No change required: with library reuse and per-line matching populating
`line.designDriveLink`, per-line export works for multi-line. Add a regression test.

### 7. Backfill (`scripts/backfill-design-cards.mjs`, run against prod DB)

For orders where `designReady = true` but no design link exists (order + every line null)
and there is ≥1 mapped product line:
- Reset `designReady = false`, `designDriveLink = null`.
- For non-terminal, non-fulfilled orders: recompute `pipelineStatus = PENDING_DESIGN`.
- For each mapped product line whose (sku, supplier) is not `ready` in the library:
  create a Trello card (reuse `buildTrelloCardContent`) and upsert
  `SkuSupplierDesign(ready=false, trelloCardId)`.
- EXPORTED/fulfilled orders: still create cards so the library gets populated; flag that
  those orders may need re-export after the design is completed.

## Testing

- Unit (`src/lib/design-library.test.ts` + new):
  - reuse hit (ready+link) → line link set, not missing.
  - first-time miss → missing, `orderDesignReady=false`.
  - ready-but-null-link → treated as missing (guarded).
  - CUSTOM lookup disabled → always missing regardless of library.
  - `orderDesignReady` correctness incl. empty design-lines.
  - multi-line partial (one line satisfied, one missing) → not ready.
- Unit: SKU-based library matcher (multi-line) picks the right file per SKU; ambiguous
  → not ready.
- Unit: `autoDetectStatus` with `hasDesignLine`.
- Regression: export produces per-line design links for a reused multi-line order.

## Files touched

- `src/lib/design-library.ts` — resolveOrderDesign
- `src/lib/pipeline-status.ts` — autoDetectStatus / hasDesignLine
- `src/app/api/shopify/orders/sync/route.ts` — designInputs, needsCard, hasDesignLine,
  existing line links
- `src/lib/repos/design-library.ts` — markLibraryReadyByCard per-SKU
- `src/app/api/trello/sync/route.ts` — per-SKU library + SkuDesign population
- `src/lib/order-line-assets.ts` — expose a SKU-based matcher (if needed)
- `scripts/backfill-design-cards.mjs` — new backfill
- tests as above

No Prisma schema change; no migration.

## Out of scope

- Merging `SkuSupplierDesign` and `SkuDesign` into one table.
- Changing the Trello card content/format.
- Fixing the `requiresDesign` UI (the flag becomes unused for the design decision; leave
  the column/editor as-is for now).
