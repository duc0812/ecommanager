# Design Library v2 — Parent Design Code, DUAL products, Task Queue

Date: 2026-09-03
Status: Draft for review
Supersedes parts of: `2026-09-03-design-sku-reuse-design.md` (reuse key changes from full SKU → parent design code; adds DUAL + task queue + per-line classification)

## Problem

The design library (`SkuSupplierDesign`) currently keys reuse by the **full Shopify SKU**
(e.g. `SW15051601-3XL`). Three gaps surfaced:

1. **Size/variant explodes the key.** `SW15051601-S…5XL` all share the same artwork, yet
   each variant would need its own library entry. The design is identified by the leading
   **design code** (`SW15051601`), not the size/color.
2. **Dual-nature products.** A product like `SW15051601` (jersey) can be sold either
   customized (customer personalizes → per-order design) or non-customized (fixed reusable
   design). Today the whole order is typed `CUSTOM` if any line has custom markers, and the
   type is written once then frozen (`sync/route.ts:376-377` only sets it when `UNKNOWN`),
   so orders like `#LIT3487` are stuck `CUSTOM` even after the triggering tag is gone.
3. **No task surface.** When a non-custom design is missing, a Trello card is created but the
   library has no explicit "to-do" entry the user can complete.

## Business decisions (confirmed)

1. **Reuse key = parent design code + supplier**, not full SKU. Size/color are ignored.
2. **Parent code is user-entered** on the tool. Auto-task creation suggests a parent (split
   the SKU at the first `-`) which the user can edit. Matching a line to a library entry is
   by the line SKU **containing / starting with** the entry's parent code (same supplier).
3. **Design type** per library entry: `NON_CUSTOM | CUSTOM | DUAL` — set manually by the user.
4. **Per-line custom detection**: a line is "customized" when it has a `_print_files`
   line-item property **or** a `previewCdnUrl`. Customized lines → per-order design (Trello
   card), never reused. Non-customized lines → reuse the parent library design.
5. **Order type** gains `DUAL` and `MIXED`, and is **re-evaluated on every sync** (drop the
   sticky "set-once" behavior):
   - all product lines NON_CUSTOM → `NON_CUSTOM`
   - all relevant lines resolve to the same single "customness" → that type (`CUSTOM` or `DUAL`)
   - a mix of types across lines → `MIXED`
   - `DUAL` = order contains a DUAL-product line used in non-custom (reuse) mode with no
     customized line forcing `CUSTOM`.
6. **Task queue**: a library entry with `ready=false` is a task. Auto-created when a
   non-custom line's parent has no ready entry; the user completes it (parent code, type,
   template link) → `ready=true` → reused by all matching orders.
7. **Migration**: auto-derive `parentCode` from existing full-SKU `SkuSupplierDesign` rows
   (split at first `-`), merge rows sharing `(parentCode, supplierId)` keeping the ready one
   with a link; order types re-evaluate naturally on the next sync.

## Data model

`SkuSupplierDesign` (evolve; exact column names at implementation time):
- add `parentCode String?` — the user-defined/auto-suggested match key.
- add `designType String @default("NON_CUSTOM")` — `NON_CUSTOM | CUSTOM | DUAL`.
- keep `sku` as the originating/sample SKU (reference), `supplierId`, `designLink`, `ready`,
  `source`, `trelloCardId`, `note`.
- matching effective key becomes `(parentCode, supplierId)`; retain `sku` for display and
  back-compat. A uniqueness strategy on `(parentCode, supplierId)` is added; the old
  `@@unique([sku, supplierId])` is relaxed/removed as part of migration.

`Order.orderType`: allowed values become `NON_CUSTOM | CUSTOM | DUAL | MIXED | UNKNOWN`.

No other schema changes anticipated. (Any migration follows CLAUDE.md: `prisma migrate dev`
+ `generate` + bump `SCHEMA_VERSION`.)

## Classification (per sync, re-evaluated)

For each order, per product line (`!isNonProductLine && resolvedSupplierId`):
- `customized = hasPrintFiles(line) || !!previewCdnUrl(line)`.
- look up library entry by parent match: an entry where `line.sku` contains/startsWith
  `entry.parentCode` and `entry.supplierId === line.resolvedSupplierId`.
- line design status:
  - `customized` → **CUSTOM line** → needs per-order design (Trello card), no reuse.
  - not customized, entry `ready` with link → **reuse** (fill `line.designDriveLink` from
    the parent template link).
  - not customized, entry exists but not ready → **task pending** (card exists / to create).
  - not customized, no entry → **new design** → auto-create task (ready=false) + card.

Order type = reduce over line types: any CUSTOM line and any DUAL-reuse line → `MIXED`;
all CUSTOM → `CUSTOM`; all DUAL → `DUAL`; all NON_CUSTOM → `NON_CUSTOM`; mixed of
NON_CUSTOM with exactly one other family → `MIXED` when more than one family present.
(Exact reduction table finalized in the plan; guiding rule: show the most-custom family, and
`MIXED` whenever ≥2 distinct families are present.)

`designReady` = every design-needing line has a link (reuse link or its own card link).
`autoDetectStatus` continues to use `hasDesignLine` + `hasDesignReady` (already deployed).

## Matching change (reuse lookup)

Replace full-SKU library lookup with parent-code matching:
- Build a lookup of ready entries: `[{parentCode, supplierId, designLink}]`.
- For a line, find the entry whose `parentCode` is contained in / a prefix of the line SKU
  and supplier matches. Prefer the longest matching `parentCode` to avoid prefix collisions
  (e.g. `DN15` vs `DN15041511`).

## Task queue + Design Library UI

Evolve `/fulfillment/design-library`:
- Columns: parent code (editable), sample SKU, supplier, **type** (NON_CUSTOM/CUSTOM/DUAL),
  status (Task / Ready), template link (editable), Trello card link, note.
- Tasks (`ready=false`) shown as a work queue; completing = fill parent code + type + link
  → mark ready.
- Auto-created tasks carry the suggested parent (SKU split at first `-`), supplier, and the
  Trello card URL.

Auto-task creation lives in the order sync: when a non-custom line has no ready parent entry,
upsert a `ready=false` entry (suggested parentCode, supplierId, trelloCardId) and create the
Trello card (existing card path).

## Migration

One-off (script or migration step):
- For each existing `SkuSupplierDesign`: set `parentCode = sku.split('-')[0]` if null.
- Merge rows sharing `(parentCode, supplierId)`: keep the `ready` row with a `designLink`;
  drop/merge duplicates; default `designType='NON_CUSTOM'` (user re-types DUAL/CUSTOM later).
- Order types: no backfill needed — re-evaluated on next sync (sticky behavior removed).
  Optionally a one-off re-evaluate pass for already-synced orders.

## Testing

- Unit: parent-code matching (contain/prefix, longest-match wins, supplier scoping).
- Unit: per-line custom detection (`_print_files` / `previewCdnUrl`).
- Unit: order-type reduction (NON_CUSTOM / CUSTOM / DUAL / MIXED) across line combinations.
- Unit: classification re-evaluation is not sticky (a re-sync can change orderType).
- Migration: full-SKU rows collapse to parent rows, ready link preserved, no data loss.

## Files (anticipated)

- `prisma/schema.prisma` — SkuSupplierDesign fields; orderType values (string, no enum change).
- `src/lib/design-library.ts` — parent-code lookup + resolveOrderDesign inputs.
- `src/lib/order-classify.ts` — per-line custom detection + order-type reduction (NON/CUSTOM/DUAL/MIXED).
- `src/lib/design-status.ts` — line status honors reuse/parent + link presence.
- `src/app/api/shopify/orders/sync/route.ts` — drop sticky orderType; parent lookup; auto-task.
- `src/lib/repos/design-library.ts` — parent-keyed queries; task upsert.
- `src/app/fulfillment/design-library/page.tsx` + API — parent/type/status/link management UI.
- migration script for existing data.

## Open points to finalize in the plan

- Exact order-type reduction table for all line combinations.
- Uniqueness/index strategy on `(parentCode, supplierId)` and handling entries without a
  parentCode yet.
- Whether `designType` lives on the library entry alone or also needs a product-level store
  (for SKUs never yet in an order).

## Out of scope

- Google Drive API auto-folder creation.
- Automatic parent-code inference beyond the first-`-` suggestion (user owns final value).
- Changing Trello card content/format.
