import { describe, it, expect } from 'vitest'
import { buildOrderShipments, type ShipmentSourceLine, type ShipmentSourceFulfillment } from './build-shipments'

function line(overrides: Partial<ShipmentSourceLine> & { shopifyLineId: string }): ShipmentSourceLine {
  return {
    sku: 'SKU-1',
    productTitle: 'Tee',
    shopifyProductType: 'Apparel',
    linePosition: 1,
    resolvedSupplierId: null,
    ...overrides,
  }
}

function fulfillment(overrides: Partial<ShipmentSourceFulfillment> & { id: string; lineItemIds: string[] }): ShipmentSourceFulfillment {
  return {
    displayStatus: null,
    deliveredAt: null,
    trackingNumber: null,
    carrier: null,
    trackingUrl: null,
    ...overrides,
  }
}

describe('buildOrderShipments', () => {
  it('creates one row per product line coded like order management, strips leading #', () => {
    const rows = buildOrderShipments({
      shopifyOrderNumber: '#1023',
      lines: [
        line({ shopifyLineId: 'gid://L1', linePosition: 1, resolvedSupplierId: 'sup-yun' }),
        line({ shopifyLineId: 'gid://L2', linePosition: 2, resolvedSupplierId: 'sup-4px' }),
      ],
      fulfillments: [],
    })
    expect(rows.map(r => r.lineKey)).toEqual(['1023_1', '1023_2'])
    expect(rows[0].supplierId).toBe('sup-yun')
    expect(rows[1].supplierId).toBe('sup-4px')
    expect(rows[0].trackingNumber).toBeNull()
    expect(rows[0].status).toBe('PENDING')
  })

  it('attaches tracking to the covered line and leaves un-fulfilled lines pending', () => {
    const rows = buildOrderShipments({
      shopifyOrderNumber: '1024',
      lines: [
        line({ shopifyLineId: 'gid://A', linePosition: 1 }),
        line({ shopifyLineId: 'gid://B', linePosition: 2 }),
      ],
      fulfillments: [
        fulfillment({ id: 'f1', lineItemIds: ['gid://A'], trackingNumber: 'YT001', carrier: 'YunExpress', trackingUrl: 'http://t/YT001', displayStatus: 'IN_TRANSIT' }),
      ],
    })
    const a = rows.find(r => r.lineKey === '1024_1')!
    const b = rows.find(r => r.lineKey === '1024_2')!
    expect(a.trackingNumber).toBe('YT001')
    expect(a.carrier).toBe('YunExpress')
    expect(a.shopifyFulfillmentId).toBe('f1')
    expect(a.status).toBe('IN_TRANSIT')
    expect(b.trackingNumber).toBeNull()
    expect(b.status).toBe('PENDING')
  })

  it('excludes non-product lines (e.g. Tip) from numbering', () => {
    const rows = buildOrderShipments({
      shopifyOrderNumber: '#2000',
      lines: [
        line({ shopifyLineId: 'gid://tip', sku: null, productTitle: 'Tip', shopifyProductType: null, linePosition: 1 }),
        line({ shopifyLineId: 'gid://prod', sku: 'SKU-9', productTitle: 'Mug', linePosition: 2 }),
      ],
      fulfillments: [],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].lineKey).toBe('2000_1')
    expect(rows[0].sku).toBe('SKU-9')
  })

  it('shares one tracking number across all lines in the same fulfillment', () => {
    const rows = buildOrderShipments({
      shopifyOrderNumber: '3001',
      lines: [
        line({ shopifyLineId: 'gid://X', linePosition: 1 }),
        line({ shopifyLineId: 'gid://Y', linePosition: 2 }),
      ],
      fulfillments: [
        fulfillment({ id: 'f9', lineItemIds: ['gid://X', 'gid://Y'], trackingNumber: 'YT999', deliveredAt: '2026-08-01T00:00:00Z' }),
      ],
    })
    expect(rows.every(r => r.trackingNumber === 'YT999')).toBe(true)
    expect(rows.every(r => r.status === 'DELIVERED')).toBe(true)
  })
})
