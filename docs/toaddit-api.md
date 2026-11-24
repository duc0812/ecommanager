# Toaddit fulfillment

Reference: [Toaddit OpenAPI v1](https://xiaoyaoji.cn/project/24TV9JbXwEC/24TV9JhDupU), reviewed 2026-11-24. The public Xiaoyaoji document tree also supplies request specifications, template catalog, order create/list/cancel, token refresh and logistics tracking contracts. Their authentication examples are fixtures, never usable credentials.

## Setup

1. Obtain the production App Key and App Secret from Toaddit. The vendor grants credentials to the account owner; this integration does not register an application or contact Toaddit on the owner's behalf.
2. In Setup › Fulfill › Toaddit, a Super Admin saves the credentials and selects production. Blank credential fields preserve stored values; removal is explicit. The account is shared across Shopify stores, as shown on the settings card.
3. Test the connection. The app obtains a token and reads saved product templates; it creates no orders. Sandbox uses its own credentials and is read-only here: importing sandbox SKUs or sending real app orders is refused.
4. Finish and save designs on Toaddit, then click **Đồng bộ mẫu/SKU và giá**. Import maps each active template's `customSku` to its `customSpecificProductList.id` in `apiSku`, with its size price in USD. Existing print templates and shipping rates are preserved. Missing prices or unavailable/revised templates are skipped. Configure shipping rates separately.
5. Use Product Mapping or Ghép SKU Toaddit to connect tool SKUs to the saved template IDs. Before sending an approved line, the preview permits choosing another final Toaddit template just for that line; this does not edit shared SKU mappings.
6. Review Toaddit's actual template mockups, size, style and personalization against the approved local artwork. Check the template confirmation box and confirm the send. Changing a template clears confirmation and rebuilds the preview.

**Artwork contract:** `/order/create` receives `specificProductId` and quantity. It has no print URL upload field. Local approved print files and mockups are review evidence; they are not sent or uploaded by this connector. Designing a new template in the separate Toaddit Mockup Generator is outside the fulfillment connector. Never reuse a non-personalized template for a personalized order.

**Payment:** default `isPayment=0` creates an unpaid order; pay on Toaddit to start production. The Super Admin can explicitly enable pay-on-create (`isPayment=1`) to charge the account balance during the confirmed create request. The app never replays a create/payment on uncertain results and never invokes `/order/payment`. The preview's catalog estimate excludes shipping and tax. The vendor's wholesale workflow is handled on its website; known catalog goods totals at or above USD 200 block API sending.

## Implementation

- Native `node:http2`, TLS >=1.2, JSON POST only, fixed production/sandbox origins, no redirects. A persistent per-account request slot keeps calls at least 1.1 seconds apart across app processes. Each request gets a fresh UUID nonce and a seconds timestamp.
- App credentials, access tokens and refresh tokens stay in AppSetting on the server. Session identity includes account and environment. Access is renewed two minutes before expiry; expired refresh tokens fall back to fresh authentication. Read-only calls can renew a token rejected with 401/403; mutations are never automatically retried.
- Common approved-line selection, reservation, per-line export marks, mixed suppliers and later-send behavior are reused. The preview hash also binds account, template revision/images and local review files. `confirmTemplates` is mandatory at the push endpoint.
- The request audit snapshot stores the actual outbound request with account fingerprint and carried Shopify line IDs. Credentials and auth headers are never part of it. Existing pushes reject a different account/environment; restore the correct credentials to reconcile them.
- Before creation, the connector checks the exact external order code. Duplicate references, timeouts, malformed responses, system errors and ambiguous payment errors keep SENDING and its duplicate lock. Missing remote orders never automatically unlock a send. Reconciliation checks exact template quantities and, for an uncertain create, the recipient address before marking the lines sent.
- Long order IDs are preserved as strings; unsafe numeric IDs are refused.
- Cancel is explicit. It checks the remote ID, calls `/order/cancel`, reads back status 80, then reverts export marks through the shared helper. A refusal or uncertain result keeps local export marks. The next send after confirmed cancellation uses a fresh `-R2` reference.
- Tracking polling joins the existing `syncApiSupplierTracking` flow. Only a shipped/completed order, a real collected waybill, and one parcel covering the full sent quantity feeds Shipment rows. Virtual Toaddit waybills, unknown split details and multiple parcels are held for manual tracking. Sandbox cannot feed Auto Fulfill. The app never guesses the undocumented `outTrackInfos` structure.
- No schema or environment-file change is required. Without credentials, existing supplier channels keep their behavior.

## Checks

Run the new contracts and relevant supplier regressions against an isolated SQLite database:

```powershell
$env:TEST_DATABASE_URL='file:./test.db'
npm test -- --config tests/toaddit.vitest.config.ts tests/toaddit-client.test.ts tests/toaddit-transport.test.ts tests/toaddit-push.integration.test.ts tests/printposs-client.test.ts tests/printposs-push.integration.test.ts tests/supplier-handoff.integration.test.ts tests/lenful-push.integration.test.ts src/lib/api-access.test.ts
npx tsc --noEmit
npm run lint
npm run build
```

Build and tests must use different SQLite files if run concurrently. The scoped Vitest config maps the existing `stream` import to the real `node:stream` builtin for the Windows Node 24 test runner; it adds no mock and changes no production code.

Coverage includes HTTP/2, rate slots, large IDs, authentication caching/refresh, template choices and stale review hashes, explicit confirmation, concurrent sends, payment uncertainty, cancellation, sandbox/account boundaries, price import and virtual tracking refusal. Browser QA covers settings on desktop/mobile and the real shared push component's template selection, confirmation reset, reviewed payload hash and send request.

An unauthenticated production-host request negotiated HTTP/2 and returned the documented JSON error envelope. Successful account-specific responses follow the published contract and mocked tests until the owner supplies real Toaddit credentials. No real Toaddit order has been created during development or deployment checks.
