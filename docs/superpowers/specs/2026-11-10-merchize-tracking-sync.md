# Merchize tracking sync — 2026-11-10

## Source and problem

Merchize's [API integration overview](https://merchize.com/api-integration/) covers shipment integration. Its [webhooks guide](https://merchize.com/helpdesk/merchize-webhooks-guide/) documents `ORDER.CHANGED.TRACKING`; that is a separate future option. This change repairs polling through the existing manual refresh, Auto Fulfill, and nightly supplier sync. It does not require a webhook, new credentials, a schema migration, or a new schedule.

The old adapter tried to read `data.fulfillments` from `GET /order/external/orders/order-detail`. The live order-detail response has status and cost metadata but no fulfillment array. Direct read-only verification against the provider confirmed that `GET /order/external/orders/tracking?external_number=...&identifier=...` returns the parcels in `data[]`.

On 2026-11-10, the corrected reader found tracking for all 20 open Merchize orders reporting `shipping`. The existing push records and the returned item identifiers mapped those parcels to 22 product lines without ambiguity. No account-specific URL, key, customer address, or raw customer response is included here.

## Contract and mapping

- Order identity uses the saved external number and the identifier from the original request, under the account resolved for the order's store.
- A parcel contains `has_tracking`, `tracking_number`, `tracking_company`, `tracking_url`, and `items[]`. Item identity comes from `sku` or `ffm_mapped_catalog_sku`; shipped quantity comes from `fulfilled_quantity`, falling back to `quantity` when absent.
- Parcel item identifiers are matched only to physical lines carried by that API push. The mapped supplier SKU and its catalog alias are accepted. A tracking for one product never implies that another identified product also shipped.
- Ambiguous catalog matches, a partial shipped quantity, or conflicting parcel numbers for one identified line are held for inspection. Legacy records without item identifiers retain the existing conservative multi-line fallback rules.
- The shared writer preserves a shipment already tied to a Shopify fulfillment and tracking. Empty responses do not clear tracking. The existing Auto Fulfill planner remains responsible for creating Shopify fulfillments and checking other sheet/API conflicts.

## Failures and request limits

Only reads retry HTTP 429, up to two retries. The adapter respects numeric or date `Retry-After` values and otherwise waits 30 then 60 seconds. Longer cooldowns, or an exhausted retry budget, defer the account to a later run instead of continuing through the remaining pushes. Creating, paying for, cancelling or pushing an order to production is never retried by this mechanism.

The provider's `Order has not fulfilled` response is a normal waiting state with no tracking. Other per-push read failures are included in the sync result, with account secrets redacted. The manual Auto Fulfill stream sends a heartbeat while a provider read is waiting; the timer is released when processing finishes or the stream no longer accepts data.

## Verification and activation

Coverage includes the live response shape, exact account/order identity, blank customer SKU with mapped catalog SKU, split parcels, partial quantities, unknown items, preservation of existing tracking, HTTP 429 recovery and retry bounds, no retry for paid creates, and a slow supplier response in the streaming route. Existing Merchize, Bondre, Printway and Auto Fulfill integration coverage also runs against an isolated test database.

The production backfill is an explicitly requested data operation using a temporary copy of the adapter and the application's normal supplier sync functions. It does not activate the new code in the running service. Permanent activation requires deploying the tested source changes under the repository's deployment approval rule.
