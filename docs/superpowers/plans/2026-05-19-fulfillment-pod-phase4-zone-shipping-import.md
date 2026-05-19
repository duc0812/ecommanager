# Fulfillment & POD — Phase 4: Zone-Aware Shipping + Real Supplier Data Import

> Use superpowers:subagent-driven-development.

**Goal:** Support real POD supplier price sheets (region-specific shipping × variant size, US import tax, design template URL, production time). Replace single-rate supplier shipping with per-variant `shippingByRegion` JSON. Country→zone mapping mix of hardcoded default + per-supplier override.

**Spec extension:** Section 7 of spec — schema updates reflected here.

## Schema additions

### `SupplierProduct` adds 7 fields + 1 JSON
```prisma
model SupplierProduct {
  // existing: id, supplierId, sku, productName, baseCost, currency, requiresDesign, updatedAt, createdAt
  baseSku             String?
  productType         String?
  printingMethod      String?
  sizeLabel           String?
  designTemplateUrl   String?
  minProductionDays   Int?
  maxProductionDays   Int?
  shippingByRegion    String?    // JSON: { US: {first,additional,importTax?}, EU: {...}, GB: {...}, CA: {...}, ROW: {...} }
  @@index([baseSku])
}
```

### New `SupplierZoneOverride` (rare per-supplier zone customization)
```prisma
model SupplierZoneOverride {
  id          String   @id @default(cuid())
  supplierId  String
  supplier    Supplier @relation(fields: [supplierId], references: [id], onDelete: Cascade)
  zoneCode    String   // US | EU | GB | CA | ROW (or custom code)
  countryCodes String  // JSON array of ISO2 codes overriding the default zone
  createdAt   DateTime @default(now())
  @@unique([supplierId, zoneCode])
}
```

### `Supplier` — keep `firstItemShipFee`/`additionalItemShipFee` as fallback for legacy / non-zoned variants
(No removal — backward compatible)

## Tasks

### P4-T1: Schema migration
Add 7 fields + JSON to SupplierProduct + SupplierZoneOverride model. Migrate `add_zone_shipping`. Bump SCHEMA_VERSION v10 → v11. Commit.

### P4-T2: `src/lib/regions.ts` — zone mapping (TDD)
```typescript
export const REGIONS = ['US', 'EU', 'GB', 'CA', 'ROW'] as const
export type Region = typeof REGIONS[number]

export const DEFAULT_ZONE_COUNTRIES: Record<Region, string[]> = {
  US: ['US'],
  EU: ['AT','BE','BG','HR','CY','CZ','DK','EE','FI','FR','DE','GR','HU','IE','IT','LV','LT','LU','MT','NL','PL','PT','RO','SK','SI','ES','SE'],
  GB: ['GB','UK'],  // accept both
  CA: ['CA'],
  ROW: [],  // catch-all
}

export type SupplierZoneOverrides = Record<string, string[]>  // zoneCode → country codes

export function resolveZone(countryCode: string | null | undefined, overrides?: SupplierZoneOverrides): Region {
  if (!countryCode) return 'ROW'
  const cc = countryCode.toUpperCase()
  // Per-supplier override has priority
  if (overrides) {
    for (const [zone, codes] of Object.entries(overrides)) {
      if (codes.includes(cc)) return zone as Region
    }
  }
  // Default mapping
  for (const z of REGIONS) {
    if (z !== 'ROW' && DEFAULT_ZONE_COUNTRIES[z].includes(cc)) return z
  }
  return 'ROW'
}
```

Tests:
- `resolveZone('US') === 'US'`
- `resolveZone('DE') === 'EU'`
- `resolveZone('GB') === 'GB'`, `resolveZone('UK') === 'GB'`
- `resolveZone('CA') === 'CA'`
- `resolveZone('JP') === 'ROW'`
- `resolveZone(null) === 'ROW'`
- override: `resolveZone('NO', { EU: ['NO'] }) === 'EU'`
- override priority: `resolveZone('CH', { ROW: [], ANY: ['CH'] })` returns ANY

Commit.

### P4-T3: Update `pl-calculator.ts` for zone shipping + import tax (TDD update)
Extend `SupplierInput`:
```typescript
export type ZoneShipping = { first: number; additional: number; importTax?: number }
export type SupplierInput = {
  supplierId: string
  baseCost: number
  // Either legacy single rates OR per-zone map (variant-level wins)
  firstItemShipFee: number
  additionalItemShipFee: number
  shippingByRegion?: Partial<Record<string, ZoneShipping>>  // keys are Region codes
  requiresDesign?: boolean
}
```

Extend `OrderInput`:
```typescript
export type OrderInput = {
  grossAmount: number
  totalFees: number
  refundedAmount: number
  shippingZone?: string   // resolved zone code (US/EU/GB/CA/ROW)
  lines: OrderLineInput[]
}
```

In `computeOrderPL`, after computing `defaultSupplierId`:
```typescript
let totalShipping = 0
let importTax = 0
if (defaultSupplierIdRaw && !isMixedSupplier) {
  const sup = Object.values(supplierMap).find(s => s.supplierId === defaultSupplierIdRaw)!
  const zone = order.shippingZone ?? 'ROW'
  const zoneRate = sup.shippingByRegion?.[zone]
  const first = zoneRate?.first ?? sup.firstItemShipFee
  const additional = zoneRate?.additional ?? sup.additionalItemShipFee
  totalShipping = first + additional * Math.max(0, totalQty - 1)
  if (zoneRate?.importTax) importTax = zoneRate.importTax * totalQty
}
const profit = expectedPayout - totalBaseCost - totalShipping - importTax
```

Add `importTax` to `OrderPLResult` return.

Add 3 new tests:
- order with zone=US + variant has US importTax=0.4 + qty=2 → importTax = 0.8
- order with zone=EU + variant `shippingByRegion.EU = {first:4.1, additional:4.1}` → use those, ignore sup default
- order with zone=ROW + no zone rate → fallback to sup `firstItemShipFee`/`additionalItemShipFee`

Commit.

### P4-T4: Update `buildSkuPriceMap` + sync route
- `buildSkuPriceMap` parses `SupplierProduct.shippingByRegion` JSON into `shippingByRegion` field of `SupplierInput`
- Sync route: import `resolveZone` from `src/lib/regions.ts`, for each order: load supplier's `SupplierZoneOverride` rows + build override map, compute `shippingZone = resolveZone(o.shippingCountry, override)`, pass into `computeOrderPL`
- Update `repos/orders.ts` `UpsertOrderInput` to accept `shippingZone` and store on Order — actually, we can compute on-the-fly each time we read. Simpler to NOT persist zone — recompute per order in reports.

Skip persisting shippingZone for now. Just pass into computeOrderPL during sync — but the cost snapshot in OrderLine.resolvedBaseCost only stores base cost, not shipping. Shipping is computed live in reports.

So actually need to also persist `Order.shippingZone` so future reads see correct shipping. Add column to `Order` model, fill at sync time.

Update reports.ts `ordersWithComputedPL` and `plSummary` to use the persisted zone + variant-level shipping rates (need to look up SupplierProduct.shippingByRegion at read time — or denormalize).

Decision: Add `Order.shippingZone String?` + denormalize `OrderLine.resolvedShipFirst Float?`, `resolvedShipAdditional Float?`, `resolvedImportTax Float?` (snapshot per line at sync time) — keeps reports fast and consistent.

Update schema (still P4-T1 — fold in):
```prisma
model Order {
  ...
  shippingZone        String?   // US|EU|GB|CA|ROW (resolved at sync time)
}
model OrderLine {
  ...
  resolvedShipFirst    Float?    // first-item ship fee for line's variant + order's zone
  resolvedShipAdditional Float?  // additional-item fee
  resolvedImportTax    Float?    // import tax per unit (× qty later)
}
```

Update upsertOrderWithLines to accept these. Update sync route to compute them. Update reports/order list to use them (instead of supplier-level rate).

Commit.

### P4-T5: Update `/setup/products` page — sheet-format bulk import + variant modal
- Update CSV parser logic in /setup/products to accept the new column layout:
  ```
  Product type | SKU product | Printing method | SIZES | SKU variant | Base cost | US import Tax/item | US shipping fee (1st item) | US additional | EU 1st | EU add | GB 1st | GB add | CA 1st | CA add | ROW 1st | ROW add | Design Template | Min production time | Max production time
  ```
- Build the `shippingByRegion` JSON from columns I-R + H (importTax).
- After parsing, preview rows with full structure.
- Replace inline-cost-edit with **Modal form per variant** (click row → modal with all fields by section)
- Modal sections: Basics (sku, productName, baseSku, productType, printingMethod, sizeLabel, baseCost, currency, requiresDesign), Shipping (5 zones × 2 fields), Tax (US importTax), Design (templateUrl), Production (min/max days)

Update repo `upsertProductMapping` to accept all new fields.

Commit (2 commits — one for parser/import, one for modal UI).

### P4-T6: Display polish in `/orders`
- Order row: show "Zone" column next to Supplier (resolved from country)
- Drill-down (future): show shipping breakdown per line

Commit.

### P4-T7: Docs update
NOTES.md + PLAN.md mark Plan 4 done.

## Notes

- `Supplier.firstItemShipFee` / `additionalItemShipFee` remain as **fallback** for variants without `shippingByRegion`.
- Existing orders (from Plan 1-3) won't have `shippingZone` or per-line ship snapshot — they'll show as `null` and reports treat them with sup-level default. Re-sync to refresh.
- Country code from Shopify: `order.shippingAddress.countryCodeV2` (ISO2) — already captured in sync (Plan 1).
- Production time + design URL are informational only for now; could power alerts later (orders aging past `maxProductionDays` post-EXPORTED).
