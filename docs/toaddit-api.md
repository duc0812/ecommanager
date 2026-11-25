# Toaddit ROS fulfillment

Source: [ToAddit ROS API Authorization](https://docs.google.com/document/d/16eKTX0RY-OG7LqGnVBSoopKuQFWewpQa1EiDupEbzEg/edit?tab=t.0), reviewed 2026-11-25. ROS is a separate API from the earlier Xiaoyaoji/OpenAPI integration.

## Setup

1. Use a ROS account and obtain its ROS API key. The observed Delta Team menu has only Log out; no key-generation UI was visible. This connector does not create credentials, contact the supplier or reuse browser session tokens. A logged-in ROS browser session alone is not an OpenAPI credential.
2. A Super Admin saves **API key Toaddit ROS** under Setup › Fulfill. The account is shared across stores. Blank input preserves the stored key; explicit removal clears it. Pasting a Bearer-prefixed key is accepted. GET returns flags only. Old AppKey/AppSecret settings remain stored but are never sent to ROS.
3. Test connection: reads the account's catalog, creates no order. Sync published products, code/color and size prices. Existing print-template links, shipping rates and production metadata are preserved. Missing-price variants are not imported with an invented cost.
4. In **Ghép sản phẩm và size**, match the tool SKU to the exact ROS product code and size. The mapping stores an opaque `ros:[productCode,size]` value in existing `SupplierProduct.apiSku`, without a schema migration. The UI shows readable product/size labels. Old numeric saved-design IDs deliberately do not match. The default internal catalog SKU is `productCode-size`; ambiguous collisions fail before import.
5. Map the Shopify variant to that supplier product. Resolve its exact official print template. In Duyệt sản xuất, select a different product/size for this send if necessary; this does not change shared mappings.
6. The line must have approved artwork, exactly one complete print sheet, a matching template and a stored order-specific PNG/JPEG mockup. Listing photos alone are not accepted as mockups. Multiple print files are blocked because ROS documents a singular designLink; do not drop panels or silently concatenate URLs. All four prepared Toaddit blanks currently use one complete-sheet Print slot.
7. Review product, size, address, print, mockup and personalization, then confirm the actual send. Confirmation clears when the preview is rebuilt. Ship methods1/2/3 are supported; confirm the exact service with the account when needed. No price override or payment call is sent. The estimate excludes shipping/tax; the ROS site handles review/billing/payment with the supplier.

## Wire contract

Fixed origin `https://ros-openapi.toaddit.com`; JSON POST with `Authorization: Bearer <key>`. Only the ROS host is allowed and redirects are refused. Requests are paced conservatively per account, have a45s timeout and16MiB response limit. Failures never automatically replay mutations.

- Catalog: `/api/v1/prototype/prototypeList`; published status1, `productCodeList[].productCode`, `sizeList[].sizeName/price`. Pagination max200 items/page and bounded iteration; incomplete/bad pages fail.
- Create: `/api/v1/order/createOrder`; `orderCode`, `deliveryShippingType`, `items:[{sku,productCode,size,quantity,designLink,urlMockup}]`, `logistics:{consignee,address1,address2?,city,province,countryCode,postcode,phone}`.
- Lookup: `/api/v1/order/orderList` by exact orderCode; compares id and itemList SKU/code/size/quantity. Its published example does not echo address or artwork URLs; the original submitted payload and approved file IDs remain in the snapshot.
- Cancel: `/api/v1/order/cancel`, `{id}`. The scalar returned ID and a subsequent orderList status80 must both match before undoing local export marks.

Success requires HTTP2xx AND code0 AND success1. Create/cancel return a scalar ID, not the old payment/order object. ROS does not document an AppSecret exchange, sandbox base, payment endpoint or create-error catalogue. Business errors, malformed success IDs, timeouts, 408/5xx and mismatched readback retain the send lock; explicit authentication rejection is the only remotely verified definite create refusal currently eligible for retry.

Catalog reads retry transient service/network errors at most three times per page, with bounded backoff. Authentication and invalid catalog data are not retried. An unavailable catalog blocks sending and reports the ROS outage without falsely marking existing mappings as legacy or erasing them. No cached or old-web catalog is substituted. Create/cancel requests are never automatically retried.

## Duplicate protection and reconciliation

Order codes include a stable store/order fingerprint to avoid cross-store number collisions. A DB reservation wins before the create. Concurrent confirms cannot create twice. Approved lines can be sent beside lines already sent; a cancelled send uses a fresh -R suffix. The snapshot records protocol ros-v1, account hash, item payload and carried Shopify line IDs, never the API key.

A successful create ID is stored before readback. Exports are marked only after ROS lookup matches that ID, orderCode, SKU/code/size/quantity. Uncertain results stay SENDING and cannot resend. Refresh reads exact orderCode and item totals; an absent order does not mean the create failed. Legacy OpenAPI snapshots and changed ROS keys stop before calling ROS. No runtime SQLite/env file is modified by shell scripts.

## Status and tracking

ROS status14 = needs processing;18 = awaiting review;42 = production;70 = shipped;80 = cancelled. Unknown statuses remain visible, not guessed as paid/fulfilled. ROS orderList supplies expressWaybillCode and logisticTrackingUrl, without a documented carrier. A single syntactically valid waybill on a shipped order, after exact item-content reconciliation, updates only the lines carried by that send; carrier remains unknown. Multi-code/ambiguous tracking requires manual parcel entry. No separate old trackInfo endpoint or virtual-waybill fields are inferred.

A successful upload to the artwork queue/Drive is separate from supplier handoff. This connector sends only after the production confirmation. It never starts design work, approves artwork, changes the local review queue or bills the account itself.

## Verification and limits

Tests mock only transport and use test.db rebuilt from migrations. Coverage includes required fields, approved links/mockup, exact-size mapping, secret settings/RBAC, old-key isolation, stale previews, concurrency, unknown create results, scalar IDs/readback mismatch, cancellation, shipping3, catalog preservation and tracking scope. Neighbouring API-supplier handoff tests are run too.

An unauthenticated catalog request to the ROS origin returned HTTP200/code1001000/success0 requiring Bearer API_KEY. The logged-in ROS website confirmed FZH56/ONESIZE (its page ID2952 differs from public Toaddit blank ID2500). Authenticated API behavior remains unverified until the owner supplies a ROS key. No real ROS order, payment or cancellation is performed during development checks.
