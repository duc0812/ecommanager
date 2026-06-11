# Manual Base Cost Override — Design

**Date:** 2026-06-11
**Status:** Approved (Approach A)

## Problem

`OrderLine.resolvedBaseCost` is snapshotted from supplier product mapping at sync time. When the snapshot is wrong (supplier price changed, mapping picked the wrong variant, negotiated price differs), the user has no way to correct it. Profit/COGS numbers stay wrong forever for that order.

## Decision

Add a per-line manual override column that always wins over the auto-resolved cost. The auto value is never destroyed, so reverting to it is a one-field null-out.

**Effective base cost = `manualBaseCost ?? resolvedBaseCost`** — everywhere COGS/profit is computed.

Constraints chosen by the user:
- Edit happens **per order line** (order detail modal on `/orders`), not on supplier products.
- Manual edit is **only allowed on lines that already have a supplier mapping** (`resolvedSupplierId` set). Unmapped lines must be mapped first; manual cost does not bypass Pending Mapping.
- A **revert control** clears the manual value and returns to the auto price.

## Schema

```prisma
model OrderLine {
  // ...existing fields
  manualBaseCost Float?   // user-entered unit base cost; wins over resolvedBaseCost
}
```

Migration `add_manual_base_cost`, then `npx prisma generate`, bump `SCHEMA_VERSION` in `src/lib/db.ts` (v22 → v23).

## API

`PATCH /api/orders/line-cost` — body `{ lineId: string, manualBaseCost: number | null }`

- `manualBaseCost: null` → clear override (revert to auto). Always allowed.
- `manualBaseCost: number` → must be finite and `>= 0`, and the line must have `resolvedSupplierId` set; otherwise `400`.
- `404` if line not found. Returns the updated line.

## Calculation flow (single choke point)

`src/lib/order-profit.ts` is the one place that turns line rows into COGS/profit. Change it instead of every caller:

- `OrderLineForProfit` gains `manualBaseCost?: number | null`.
- `computeKnownOrderCogs` uses `(l.manualBaseCost ?? l.resolvedBaseCost ?? 0)`.
- `hasUnmappedProductCost` becomes `!l.resolvedSupplierId || (l.manualBaseCost ?? l.resolvedBaseCost) === null` — supplier mapping still required (user decision), but a manual cost satisfies the "has a price" half.

Callers (`reports.ts`, `projects/analytics`, `projects/profit-chart`, orders page summary) pass full Prisma line objects, so the new field flows through without changes. Two exceptions that read `resolvedBaseCost` directly must switch to the effective value:

- `src/app/api/fulfillment/export/route.ts` — `crogsPrice` / `crogsTotal` in supplier CSV.
- `src/lib/repos/reports.ts` — `mappedLineCount` (counts `resolvedBaseCost != null`).

## Re-sync survival

`upsertOrderWithLines` (`src/lib/repos/orders.ts`) deletes and recreates lines on every sync, carrying snapshot fields. Add `manualBaseCost` to the snapshot select and carry it **unconditionally** (`snap?.manualBaseCost ?? null`) — independent of `preserveSnapshot`, so the manual price survives even if the supplier mapping changes. The user's entered number is the user's truth until they clear it.

`recalculateMissingOrderLineCosts` (`order-costs.ts`) only writes `resolvedBaseCost`; it never touches `manualBaseCost`. No change needed.

## UI — order detail modal (`/orders`)

Line items table gets a **Base cost** column:

- Shows effective cost; manual values get a small `manual` badge.
- Lines with `resolvedSupplierId`: click value → inline number input → Enter/blur saves via PATCH, Esc cancels.
- Manual lines show a `✕` to revert to auto.
- Unmapped lines show `—` (not editable).
- After save/revert, refetch the orders list so order-level COGS/profit and the summary cards update.

## Testing

- Unit (`order-profit.test.ts`): manual overrides resolved in `computeKnownOrderCogs`; manual + supplier set means not unmapped; manual on line without supplier still counts as unmapped.
- API route test: rejects manual cost on unmapped line; accepts null revert.
- `upsertOrderWithLines`: manual cost survives line recreation (extend existing integration test if practical).

## Out of scope

- Editing supplier product base prices (mapping-level) — separate feature.
- Manual shipping-fee overrides.
- Audit history of who changed the cost.
