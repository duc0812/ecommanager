import { describe, expect, it } from 'vitest'
import { toadditId, toadditVariantId, validToadditVariantId } from '@/lib/toaddit-shared'
import { toadditOrderOf, toadditTracking, toadditStatus } from '@/lib/toaddit'
import { canCallApi } from '@/lib/api-access'
import { parseToadditSelection } from '@/lib/repos/toaddit-push'
describe('Toaddit ROS contracts', () => {
  it('preserves long IDs and never rounds numeric IDs', () => {
    expect(toadditId('2702623869149929495')).toBe('2702623869149929495')
    for (const value of [2702623869149929495, '1e4', '-1', 0, '01', {}, true]) expect(toadditId(value)).toBeNull()
  })
  it('keeps exact productCode + size, including punctuation and case', () => {
    const id = toadditVariantId('FZH9-L', 'ONESIZE')
    expect(validToadditVariantId(id)).toBe(true)
    expect(parseToadditSelection({ line1: id })).toEqual({ line1: id })
    for (const value of ['2501', 'FZH9-L', toadditVariantId('', 'M'), 'ros:["X"]', toadditVariantId('a'.repeat(200), 'M')]) {
      expect(validToadditVariantId(value)).toBe(false)
      expect(() => parseToadditSelection({ line1: value })).toThrow()
    }
    expect(() => parseToadditSelection([])).toThrow()
    expect(() => parseToadditSelection({ line1: 123 })).toThrow()
  })
  it('reads ROS status and tracking fields without inventing cost or carrier', () => {
    const order = toadditOrderOf({ id: 673, orderCode: 'ROS-1', status: 70, expressWaybillCode: 'REALTRACK', logisticTrackingUrl: 'https://example.com/track' })!
    expect(order).toMatchObject({ id: '673', code: 'ROS-1', tracking: 'REALTRACK' })
    expect(toadditTracking(order)).toEqual({ number: 'REALTRACK', company: null })
    for (const tracking of ['A123, B456', 'A123 B456', 'https://example.com/t', '']) expect(toadditTracking({ ...order, tracking })).toBeNull()
    expect(toadditTracking({ ...order, status: 42 })).toBeNull()
    expect(toadditStatus({ ...order, status: 14 })).toBe('Cần xử lý')
    expect(toadditStatus({ ...order, status: 18 })).toBe('Chờ duyệt')
    expect(toadditOrderOf({ orderId: 673, orderCode: 'old-api-shape' })).toBeNull()
  })
  it('keeps key edits and scoped handoff restricted', () => {
    expect(canCallApi('ADMIN', [], '/api/fulfillment/toaddit/settings', 'PUT')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], '/api/fulfillment/toaddit/settings', 'PUT')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], '/api/fulfillment/toaddit/orders/o1/push', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_orders'], '/api/fulfillment/toaddit/orders/o1/push', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['fulfillment_export'], '/api/fulfillment/toaddit/orders/o1/push', 'POST')).toBe('forbidden')
    expect(canCallApi(null, [], '/api/fulfillment/toaddit/settings', 'GET')).toBe('unauthenticated')
  })
})
