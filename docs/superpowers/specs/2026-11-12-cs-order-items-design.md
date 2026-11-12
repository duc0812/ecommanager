# CS agent: per-item order status (owner 11/12/2026, case #LIT4987)

## Why
#LIT4987 had a tumbler sent to PGprints (by hand, 10/26) and a hoodie sent to Mango (10/28). The Mango sheet wrote the bare
order number, so Shopify got one fulfillment with both items on the hoodie's tracking. The agent saw "order delivered", read
"tumbler missing" as a packing error and wrote "This is entirely on us". It never knew the two items went to two factories.

## What the agent must answer first, for every product line (add-ons such as Shipping protection excluded)
1. Was it sent to a factory: which factory, how (API push, sheet, CSV export), on what date, and the factory's own status when
   an API reports one. No record = "Không tìm được thông tin gửi xưởng" (owner: from now on every item is sent from the tool,
   so a missing record is reported as such, never guessed).
2. Where its tracking is: number, last-mile carrier, status, the newest scan (text, place, date), delivery date, and which other
   items share the same tracking.

A warning is attached when the tracking may not be that item's parcel:
- the item has a tracking but no send record;
- the tracking came from another factory than the one the item was sent to.

## Where it shows
- `OrderContextOrder.items` (`src/lib/cs/order-context.ts`), built from OrderLine export marks, SupplierOrderPush (lines it
  carried), SupplierSheetWrite and Shipment (checkpoints).
- Agent prompt: an `items:` block, plus rules: start the summary from it; an item with a warning that the customer reports as
  missing or not received is not called lost or our fault — staff check whether it ships in its own parcel.
- Freshdesk private note: a deterministic "Từng sản phẩm" block under the summary (not written by the model).
- Ticket page "Đơn hàng" panel: one row per item instead of one tracking list for the whole order.
- Auto-reply: never sends while an item carries a warning.

## Already handled elsewhere
Auto Fulfill no longer fulfils a multi-item order from a sheet row that has only the bare order number (needs_manual, on prod
since before 11/12).
