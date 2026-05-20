# Supplier Product UI Redesign — Design Spec
Date: 2026-05-20

## Overview

Redesign the supplier product management UI and data model:
1. Remove `printingMethod` field (no longer needed with ProductBase mapping system)
2. Replace `sizeLabel` with `variant1Name/variant1Value/variant2Name/variant2Value` (flexible variant pairs)
3. Supplier detail page: import bar at top, full-width manual entry table, expandable rows for extra fields
4. CSV import column mapping updated to match new schema

---

## 1. Schema Changes

### Remove from `SupplierProduct`
- `printingMethod String?`
- `sizeLabel String?`

### Add to `SupplierProduct`
```prisma
variant1Name  String?   // e.g. "Size", "Color", "Capacity"
variant1Value String?   // e.g. "XL", "Black", "10oz"
variant2Name  String?   // optional second variant
variant2Value String?   // optional second variant value
```

### Migration data preservation
- Existing rows: `sizeLabel` → `variant1Value`, `variant1Name` defaults to `"Size"`
- `printingMethod` → dropped (no migration needed)
- New SCHEMA_VERSION bump required in `src/lib/db.ts`

---

## 2. Auto-Mapping Update (`src/lib/auto-mapping.ts`)

### Remove
- `printingMethod` from `SupplierProductCandidate` type
- All design-type detection arrays (`DESIGN_2D`, `DESIGN_3D`, etc.) that rely on printingMethod
- printingMethod-based scoring logic (lines detecting "2d", "3d", "sublimation", "screen print", etc.)

### Update
- `sizeLabel` matching → match against `variant1Value` OR `variant2Value` (OR logic — +10 if either variant value matches)
- `SupplierProductCandidate` type: remove `printingMethod: string | null`, remove `sizeLabel: string | null`, add `variant1Name`, `variant1Value`, `variant2Name`, `variant2Value` (all `string | null`)

### Tests
- Update `tests/auto-mapping.test.ts` mock data: remove `printingMethod`, remove `sizeLabel`, add variant fields

---

## 3. Repo Layer (`src/lib/repos/suppliers.ts`)

### `SupplierProductCandidate` type
Remove `printingMethod`, `sizeLabel`. Add `variant1Name`, `variant1Value`, `variant2Name`, `variant2Value`.

### `ProductUpsertInput` type
Remove `printingMethod`, `sizeLabel`. Add 4 variant fields.

### `buildSkuPriceMap` / `buildSupplierProductCandidates`
Remove these two fields from the DB select, add 4 new fields.

### Upsert functions
Remove these two fields from create/update data, add 4 new fields.

---

## 4. API Route (`src/app/api/suppliers/products/[id]/route.ts`)

### PATCH handler
Remove `printingMethod` and `sizeLabel` from the update payload.
Add `variant1Name`, `variant1Value`, `variant2Name`, `variant2Value`.

---

## 5. UI — Supplier Detail Page

**File:** `src/app/setup/suppliers/[id]/page.tsx` (or equivalent fulfillment route)

### Layout
```
┌─────────────────────────────────────────────────────────┐
│ 📥 Import từ file   [description]          [Choose File] │  ← compact bar, full width
└─────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────┐
│ Product setup                           [+ Add row]      │
│─────────────────────────────────────────────────────────│
│ ▸ │ Product type │ SKU product │ Variant 1 │ Variant 2   │
│   │              │             │ Name Value│ Name Value  │  ← header
│   │              │             │           │             │
│ + │ [input]      │ [input]     │ [  ][  ]  │ [  ][  ]   │  ← add row
│   │ Base cost    │ US Ship 1st/│ add       │             │
│───┼──────────────┼─────────────┼───────────┼─────────────│
│ ▸ │ 3D Clothing  │ TX          │ Size  S   │ —           │ $10 │ $4.50/$1.50 │ ✕
│   └── [expanded] Design URL · Prod days · EU Ship · Other regions · Save/Cancel
│ ▸ │ Mug          │ MG          │ Cap.  10oz│ Color White │ $6.50 │ ...  │ ✕
└─────────────────────────────────────────────────────────┘
```

### Table columns (collapsed state)
| Col | Content |
|-----|---------|
| ▸ | Expand toggle (chevron rotates on expand) |
| Product type | Text |
| SKU product | Monospace |
| Variant 1 | Two sub-values: Name (muted) + Value (bold purple) |
| Variant 2 | Same, shows — if empty |
| SKU variant | Monospace |
| Base cost | Green bold |
| US Shipping | `$X.XX / $Y.YY` compact (1st item / additional) |
| ✕ | Delete row |

### Expanded row (inline, purple tint background)
4-column grid:
1. **Design Template URL** — text input
2. **Production days (min–max)** — two number inputs with `–` separator
3. **EU Shipping** — two inputs `1st / add.`
4. **Other regions** — two inputs `1st / add.`

Footer: Cancel + Save buttons (right-aligned)

### Add new row
Inline at top of tbody (not a modal). All inputs in-place. "Save" button appends the row.

### Removed
- "Printing method" column and input — gone entirely
- "SIZES" column — replaced by Variant 1/2
- Left/right split layout (import left, manual right) — replaced by stacked layout

---

## 6. Supplier Products Page (`src/app/setup/products/page.tsx`)

Same column changes as supplier detail:
- Remove `printingMethod` column and its filter/display
- Replace `sizeLabel` column with `Variant 1` (Name + Value display) and `Variant 2`
- Update manual entry row inputs accordingly
- Update edit modal fields

---

## 7. CSV Import Column Mapping

### Old → New mapping
| Old column | New column |
|------------|------------|
| `Printing method` | *(removed)* |
| `SIZES` | *(removed)* |
| *(new)* | `Variant 1 Name` |
| *(new)* | `Variant 1 Value` |
| *(new)* | `Variant 2 Name` |
| *(new)* | `Variant 2 Value` |

Both the supplier detail import and the products page import must be updated.

---

## 8. Scope NOT Included

- Migrating/editing existing manual mappings that referenced old sizeLabel data
- Adding a 3rd variant dimension
- Changing shipping region structure (EU / Other stays as-is)
- Any changes to ProductBase / ProductMapping module (already complete)
