// ParcelPanel-style status buckets for the tracking dashboard. Raw statuses come
// from Shopify fulfillment/tracking data (build-shipments); we collapse them into
// a small, ordered set of buckets used for the status tabs + badges.

export type StatusBucket =
  | 'PENDING'
  | 'INFO_RECEIVED'
  | 'IN_TRANSIT'
  | 'OUT_FOR_DELIVERY'
  | 'DELIVERED'
  | 'EXCEPTION'

export const BUCKET_ORDER: StatusBucket[] = [
  'PENDING',
  'INFO_RECEIVED',
  'IN_TRANSIT',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'EXCEPTION',
]

export const BUCKET_LABELS: Record<StatusBucket, string> = {
  PENDING: 'Pending',
  INFO_RECEIVED: 'Info Received',
  IN_TRANSIT: 'In Transit',
  OUT_FOR_DELIVERY: 'Out for Delivery',
  DELIVERED: 'Delivered',
  EXCEPTION: 'Exception',
}

const MAP: Record<string, StatusBucket> = {
  PENDING: 'PENDING',
  CONFIRMED: 'INFO_RECEIVED',
  FULFILLED: 'INFO_RECEIVED',
  INFO_RECEIVED: 'INFO_RECEIVED',
  IN_TRANSIT: 'IN_TRANSIT',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  ATTEMPTED_DELIVERY: 'EXCEPTION',
  EXCEPTION: 'EXCEPTION',
  FAILURE: 'EXCEPTION',
  FAILED_ATTEMPT: 'EXCEPTION',
  EXPIRED: 'EXCEPTION',
}

export function statusBucket(raw: string): StatusBucket {
  return MAP[(raw ?? '').trim().toUpperCase()] ?? 'PENDING'
}
