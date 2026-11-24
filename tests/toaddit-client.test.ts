import { describe, expect, it } from 'vitest'
import { toadditId } from '@/lib/toaddit-shared'
import { toadditOrderOf, toadditTracking } from '@/lib/toaddit'
import { canCallApi } from '@/lib/api-access'
import { parseToadditSelection } from '@/lib/repos/toaddit-push'

describe('Toaddit contracts', () => {
  it('preserves long string IDs and refuses rounded numeric IDs', () => {
    expect(toadditId('2702623869149929495')).toBe('2702623869149929495')
    for (const value of [2702623869149929495, '1e4', '-1', 0, '01', {}, true]) expect(toadditId(value)).toBeNull()
  })
  it('reads order totals in dollars and never invents a missing amount', () => {
    expect(toadditOrderOf({ id: '2702623869149929495', orderCode: 'TD-1', status: 41, orderFinance: { paymentProductAmount: '5.50', finalFreightAmount: '6.00', paymentTax: '0.10' } })).toMatchObject({ total: 11.6, freight: 6 })
    expect(toadditOrderOf({ orderId: '123', orderCode: 'TD-1' })?.total).toBeNull()
  })
  it('accepts a single real waybill covering the full sent quantity', () => {
    const order = toadditOrderOf({ id: '123', orderCode: 'TD-1', status: 70 })!
    const row = { orderId: '123', orderStatus: 70, productCount: 2, waybillStatus: 4, shippingMethodName: 'Standard', waybillCode: 'REALTRACK', companyName: 'USPS' }
    expect(toadditTracking([row], order, 2)).toEqual({ number: 'REALTRACK', company: 'USPS' })
    expect(toadditTracking([{ ...row, shippingMethodName: 'ToAddit' }], order, 2)).toBeNull()
    expect(toadditTracking([{ ...row, productCount: 1 }], order, 2)).toBeNull()
    expect(toadditTracking([{ ...row, orderId: '999' }], order, 2)).toBeNull()
    expect(toadditTracking([{ ...row, waybillStatus: 7 }], order, 2)).toBeNull()
    expect(toadditTracking([row, { ...row, waybillCode: 'OTHER' }], order, 2)).toBeNull()
    expect(toadditTracking([row], { ...order, status: 30 }, 2)).toBeNull()
  })
  it('validates per-order template selections and keeps credential edits restricted', () => {
    expect(parseToadditSelection({ line1: '123' })).toEqual({ line1: '123' })
    expect(() => parseToadditSelection({ line1: 123 })).toThrow()
    expect(() => parseToadditSelection([])).toThrow()
    expect(canCallApi('ADMIN', [], '/api/fulfillment/toaddit/settings', 'PUT')).toBe('forbidden')
    expect(canCallApi('SUPERADMIN', [], '/api/fulfillment/toaddit/settings', 'PUT')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_export'], '/api/fulfillment/toaddit/orders/o1/push', 'POST')).toBe('ok')
    expect(canCallApi('SUPPORT', ['fulfillment_orders'], '/api/fulfillment/toaddit/orders/o1/push', 'POST')).toBe('forbidden')
    expect(canCallApi('SELLER', ['fulfillment_export'], '/api/fulfillment/toaddit/orders/o1/push', 'POST')).toBe('forbidden')
    expect(canCallApi('ADMIN', [], '/api/fulfillment/toaddit/orders/o1/cancel', 'POST')).toBe('ok')
    expect(canCallApi(null, [], '/api/fulfillment/toaddit/settings', 'GET')).toBe('unauthenticated')
  })
})
