import { describe, it, expect } from 'vitest'
import { statusBucket, BUCKET_ORDER, BUCKET_LABELS } from './status-bucket'

describe('statusBucket', () => {
  it('maps raw Shopify/tracking statuses to ParcelPanel-style buckets', () => {
    expect(statusBucket('PENDING')).toBe('PENDING')
    expect(statusBucket('CONFIRMED')).toBe('INFO_RECEIVED')
    expect(statusBucket('FULFILLED')).toBe('INFO_RECEIVED')
    expect(statusBucket('INFO_RECEIVED')).toBe('INFO_RECEIVED')
    expect(statusBucket('IN_TRANSIT')).toBe('IN_TRANSIT')
    expect(statusBucket('OUT_FOR_DELIVERY')).toBe('OUT_FOR_DELIVERY')
    expect(statusBucket('DELIVERED')).toBe('DELIVERED')
  })

  it('groups all failure-ish statuses into EXCEPTION', () => {
    for (const s of ['ATTEMPTED_DELIVERY', 'EXCEPTION', 'FAILURE', 'FAILED_ATTEMPT', 'EXPIRED']) {
      expect(statusBucket(s)).toBe('EXCEPTION')
    }
  })

  it('is case-insensitive and falls back to PENDING for unknown', () => {
    expect(statusBucket('delivered')).toBe('DELIVERED')
    expect(statusBucket('something_weird')).toBe('PENDING')
    expect(statusBucket('')).toBe('PENDING')
  })

  it('exposes ordered buckets with labels', () => {
    expect(BUCKET_ORDER[0]).toBe('PENDING')
    expect(BUCKET_ORDER).toContain('DELIVERED')
    expect(BUCKET_LABELS.OUT_FOR_DELIVERY).toBe('Out for Delivery')
  })
})
