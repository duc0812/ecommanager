import { describe, expect, it } from 'vitest'
import {
  buildInternalTrackingSnapshot,
  detectInternalStatus,
  parseInternalTrackingSnapshot,
  parseTrackingCheckpoints,
} from './tracking-status'

describe('internal tracking status', () => {
  it('prefers the current DOM status signal over progress labels in the page body', () => {
    expect(detectInternalStatus(['In transit'], 'Info received In transit Out for delivery Delivered')).toBe('IN_TRANSIT')
  })

  it('normalizes common English and Vietnamese delivery states', () => {
    expect(detectInternalStatus(['Out for delivery'])).toBe('OUT_FOR_DELIVERY')
    expect(detectInternalStatus(['Đã giao hàng'])).toBe('DELIVERED')
    expect(detectInternalStatus(['Giao hàng không thành công'])).toBe('FAILED_ATTEMPT')
  })

  it('stores status 2 separately in a versioned crawl snapshot', () => {
    const checkpoint = { time: '2026-08-27 10:30', desc: 'Arrived at facility', status: 'IN_TRANSIT' }
    const json = JSON.stringify(buildInternalTrackingSnapshot('IN_TRANSIT', [checkpoint]))
    expect(parseInternalTrackingSnapshot(json)).toEqual({ version: 1, status: 'IN_TRANSIT', checkpoints: [checkpoint] })
    expect(parseTrackingCheckpoints(json)).toEqual([checkpoint])
  })

  it('keeps legacy checkpoint arrays readable without treating them as internal status', () => {
    const checkpoint = { time: '', desc: 'Legacy event', status: 'transit' }
    const json = JSON.stringify([checkpoint])
    expect(parseInternalTrackingSnapshot(json)).toBeNull()
    expect(parseTrackingCheckpoints(json)).toEqual([checkpoint])
  })
})
