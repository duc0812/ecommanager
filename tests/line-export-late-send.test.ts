import { describe, expect, it } from 'vitest'
import { isLateSendOrder, readyLines } from '@/lib/line-export'

const DONE_AT = new Date('2026-11-05T00:00:00Z')
const line = (id: string, over: Record<string, unknown> = {}) => ({
  id, shopifyLineId: `sl-${id}`, sku: `SKU-${id}`, productTitle: `Product ${id}`, shopifyProductType: 'Hoodie',
  resolvedSupplierId: 'sup-a', exportedAt: null as Date | null, exportedToSupplierId: null as string | null,
  designDriveLink: `https://drive.google.com/drive/folders/${id}`, dropship: false, ...over,
})
const fee = { id: 'fee', shopifyLineId: 'sl-fee', sku: null, productTitle: 'Shipping protection', shopifyProductType: 'Kaching Cart Upsell Toggle', resolvedSupplierId: null, exportedAt: null, exportedToSupplierId: null, designDriveLink: null, dropship: false }
const order = (lines: any[], over: Record<string, unknown> = {}) => ({
  pipelineStatus: 'FULFILLED', financialStatus: 'PAID', fulfillmentStatus: 'FULFILLED', designReady: true, supplierHandoffAt: null as Date | null,
  exportedAt: null as Date | null, exportedToSupplierId: null as string | null,
  lines, designTasks: lines.filter(l => l.sku).map(l => ({ shopifyLineId: l.shopifyLineId, status: 'DONE', updatedAt: DONE_AT })),
  supplierPushes: [] as any[], ...over,
})

describe('a fulfilled order sends a line no supplier got only when it has several product lines (owner 11/22/2026, #LIT5519_2)', () => {
  it('two product lines, one sent: the unsent approved line is ready even though Shopify says fulfilled', () => {
    const o = order([fee, line('socks', { exportedAt: new Date('2026-10-28'), exportedToSupplierId: 'sup-b', resolvedSupplierId: 'sup-b' }), line('legging')])
    expect(isLateSendOrder(o)).toBe(true)
    expect(readyLines(o).map(l => l.id)).toEqual(['legging'])
  })

  it('one product line (fee lines do not count): fulfilled still closes the order', () => {
    const o = order([fee, line('only')])
    expect(isLateSendOrder(o)).toBe(false)
    expect(readyLines(o)).toEqual([])
  })

  it('a cancelled or refunded order stays closed', () => {
    expect(readyLines(order([line('a'), line('b')], { pipelineStatus: 'CANCELLED' }))).toEqual([])
    expect(readyLines(order([line('a'), line('b')], { financialStatus: 'REFUNDED' }))).toEqual([])
  })

  it('an open design, a dropship line or a live push of its supplier keeps the line out', () => {
    const o = order([line('a'), line('b', { dropship: true }), line('c', { resolvedSupplierId: 'sup-p' })])
    o.designTasks[0].status = 'DOING'
    o.supplierPushes = [{ supplierId: 'sup-p', status: 'CREATED', exportMarked: false, prevExportJson: null }]
    expect(readyLines(o)).toEqual([])
  })

  it('an earlier CSV save of the order does not hold the unsent line', () => {
    const o = order([line('a', { exportedAt: new Date('2026-11-04'), exportedToSupplierId: 'sup-a' }), line('b')], { supplierHandoffAt: new Date('2026-11-06') })
    expect(readyLines(o).map(l => l.id)).toEqual(['b'])
  })

  it('a legacy order-level export counts as sent for its lines', () => {
    const o = order([line('a'), line('b')], { exportedAt: new Date('2026-10-01'), exportedToSupplierId: 'sup-a' })
    expect(readyLines(o)).toEqual([])
  })

  it('an order Shopify fulfilled only in part keeps the usual rules', () => {
    const o = order([line('a', { exportedAt: new Date('2026-11-04'), exportedToSupplierId: 'sup-a' }), line('b')], { pipelineStatus: 'READY_TO_PRODUCTION', fulfillmentStatus: 'PARTIALLY_FULFILLED' })
    expect(isLateSendOrder(o)).toBe(false)
    expect(readyLines(o).map(l => l.id)).toEqual(['b'])
  })
})
