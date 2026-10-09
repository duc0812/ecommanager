# Product profiles — one setup per Shopify product

**Status:** approved in chat 2026-10-10 ("cả xưởng lẫn design"). Builds on Design Tasks v2.

## Goal

Configure each Shopify product once — supplier, print template, master artwork, and how the customer's fields map to template layers — and let every variant and every order line of that product inherit it. Today supplier choice is per variant (manual) or per product type + options, and design data is keyed on SKU strings; neither is tied to the product a customer actually bought.

Out of scope: the auto-design agent, merging the Design Library into profiles (non-custom lines keep using the library), Drive storage (separate spec).

## Data

- `OrderLine.shopifyProductId String?` — product GID from the order sync (`lineItem.product.id`), indexed. Backfilled for existing lines by `refreshMissingLineProps` (the "Đồng bộ task" button), which already re-reads line props from Shopify; add the field to `ShopifyOrderLineProps` and `applyLineProps`.
- `ProductProfile`:

| column | type | note |
|---|---|---|
| id | cuid | |
| storeId | FK ShopifyStore | |
| shopifyProductId | String | product GID |
| title | String | snapshot for the list |
| imageUrl | String? | snapshot |
| supplierProductId | String? | FK SupplierProduct, default for all variants |
| overrides | String | JSON `[{ combo: {"Size":"6XL"}, supplierProductId }]`, same matching rules as `ProductBaseOverride` |
| printTemplateId | String? | FK PrintTemplate |
| masterArtworkUrl | String? | http(s) link |
| masterArtworkId | String? | a `DesignArtwork`-style upload (stored like artwork; see Drive spec) |
| layerMap | String | JSON `[{ field, layer, font?, maxChars?, fit: 'shrink'|'wrap'|'none' }]` |
| notes | String? | |
| createdAt / updatedAt | | |

Unique `[storeId, shopifyProductId]`.

## Resolution order

- **Supplier:** `VariantManualMapping` (exact variant) → **ProductProfile** (override whose combo matches the line's options, else the default supplier product) → `ProductBase` rules (unchanged). The sync route's size-sibling swap applies to profile results exactly as it does to `product_base_rank` results. New `resolvedVia` values: `product_profile`, `product_profile_override`.
- **Print template:** profile's `printTemplateId` → existing `templateForLine` SKU match.
- **Master artwork:** profile's master → `SkuDesign` / Design Library (existing).
- **Layer hints:** the workspace's "Layer" column uses the profile's `layerMap` when present, else the current heuristic.

`resolveByProductBase` gains a `productProfiles` argument (profiles for the order's store, keyed by product id) — pure, unit-tested.

## Re-evaluation

Saving a profile re-resolves supplier/template for lines of that product in orders whose pipeline status is not `EXPORTED`, `FULFILLED`, `CANCELLED` or `REFUNDED` (reuse the cost recalculation the manual-mapping route performs), then runs `syncDesignTasks` for those orders. The response returns `{ ordersUpdated, tasksTouched }`.

## Profile completeness

`profileStatus(profile, observedFields)` → `NONE` (no profile) · `NO_TEMPLATE` · `NO_MASTER` · `NO_LAYERS` (some observed customer field has no `layerMap` entry) · `READY`. Observed fields = distinct visible personalization keys across the product's order lines (from `customAttributesJson`). Shown in the product list and as a "Hồ sơ đủ" pill on tasks whose profile is `READY`. Readiness stays `LOW/MANUAL` until the agent exists.

## UI — "Sản phẩm" in the Design Studio group (`/design-studio/products`)

- **List:** products seen in order lines (group by `shopifyProductId`, latest 90 days): image, title, store, variants seen, orders, open tasks, status chip; sorted by open tasks desc; search; filter by status.
- **Editor** (`/design-studio/products/[profileKey]`, key = `storeId~productNumericId`): left = template preview (reuse `TemplateCanvas` with the master artwork drawn into the first area, no task required) ; right = supplier product picker (search supplier products), overrides table (option name/value → supplier product), template select (templates of the chosen supplier, link to Print Templates), master artwork (link field + upload), layer map table pre-filled with observed fields (field · layer · font · max chars · fit), notes, Save.
- Workspace task header: link "Hồ sơ sản phẩm" to the editor; the "Nhớ cách gắn dữ liệu → layer" checkbox becomes a button "Lưu vào hồ sơ" that writes the current layer hints for that product's fields.

## API (`/api/design-studio/products*`, covered by the existing `/api/design-studio` rule; writes require `requireAdmin`)

`GET /products?q=&status=` · `GET /products/[key]` (profile or null + product summary + observed fields + supplier products of the store's suppliers + templates) · `PUT /products/[key]` (upsert, validates JSON shapes and that FKs exist, triggers re-evaluation).

## Tests

Resolver precedence (variant manual > profile override > profile default > product base); size-sibling swap applied to a profile result; `profileStatus` for each state; PUT validates and re-evaluates an open order but not an exported one; backfill of `shopifyProductId` through `applyLineProps`; template/master precedence in `loadTask`.
