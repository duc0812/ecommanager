# Printposs fulfillment

Implementation branch: `codex/printposs-api`, based on release `ff1d961`.
API reference: https://docs.printposs.com/v1 (reviewed 2026-11-24).

## Enable in the application

1. Open Setup › Fulfill. A Super Admin saves a Printposs API token from Account settings › API Token › Add Key.
2. Click **Kiểm tra kết nối**. This reads stores and catalog only. Optionally save the numeric Printposs store ID shown by this check.
3. Click **Đồng bộ catalog và giá**. This creates/reactivates supplier `printposs` and imports active variants: supplier SKU, API variant ID, USD base cost, and design-required flag. Existing templates and shipping rates are preserved. Discontinued variants are never sent; each preview checks the current catalog.
4. Configure shipping rates and supplier print templates. Catalog base costs do not include shipping. Map Shopify products/variants to the imported supplier SKUs in Product Mapping.
5. Approve the design, open **Sản xuất - API** in Duyệt sản xuất, inspect the preview, then confirm sending. The configured public application URL must serve the approved print and mockup files over HTTPS.

This is one shared Printposs account across Shopify stores, matching the existing keyed-supplier setup. The optional store ID is a Printposs store ID, not a Shopify store ID. Tokens live in AppSetting and never appear in GET responses, request snapshots, or browser storage. A blank token input preserves the stored token; explicit removal clears it. No schema migration is required.

## Behavior and limits

- Each item carries a numeric `product_variant_id`, integer quantity, one `design_image_url`, and one `mockup_image_url`. Multiple print parts block sending; prepare the supplier's combined canvas first. FBA labels and sample orders are outside this integration.
- Only approved, unsent lines of this supplier are sent. The shared reservation, payload hash, per-line export marks, and later-send mechanism prevent duplicates and preserve mixed-supplier orders.
- Internal design/CS notes are shown in preview but never sent.
- Timeout, network errors, 5xx, duplicate references, and unreadable create responses leave the push SENDING. Refresh looks up the exact external reference across all documented order-list pages. Absence never automatically releases the lock: Printposs documents no consistency deadline. Resolve unresolved references with the supplier before any manual reopening.
- Confirmed creates are CREATED even when Printposs says `pending_payment` / `unpaid`. The app reports payment status; it does not call an undocumented payment endpoint.
- Printposs publishes no cancellation endpoint. The shared modal hides cancellation for this supplier. Remote cancellations retain their export lock and display a reconciliation note.
- Tracking polling runs through `syncApiSupplierTracking` before existing Auto Fulfill processing. It matches package items by variant, quantity, design and mockup, then requires full line quantity under one tracking number. Reordered items are supported. Ambiguous duplicates, missing package-item links, partial quantities and multiple parcels on one line are held for manual handling. The generic Shopify fulfillment flow uses the resulting supplier-scoped Shipment rows.
- This integration uses polling, so it requires no public webhook subscription or webhook secret.

## Validation and release

Targeted tests cover HTTP contracts, pagination, identity matching, permissions, catalog import, mixed suppliers, concurrent sends, stale previews, timeout reconciliation, and tracking. Run:

```powershell
npm test -- tests/printposs-client.test.ts tests/printposs-push.integration.test.ts tests/supplier-handoff.integration.test.ts tests/lenful-push.integration.test.ts src/lib/api-access.test.ts
npx tsc --noEmit
npm run lint
npm run build
```

No real account token has been configured and no live Printposs order has been created. Production deployment requires the owner's instruction under AGENTS.md. After deploying, complete steps 1–4 and validate the first intended production order through the normal preview and confirmation flow.
