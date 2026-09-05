import { describe, it, expect } from 'vitest'
import { mapFulfillmentOrdersResponse } from './shopify-orders'

describe('mapFulfillmentOrdersResponse', () => {
  it('keys by name without # and flattens line items', () => {
    const m = mapFulfillmentOrdersResponse([{
      id: 'gid://order/1', name: '#LIT2225', createdAt: '2026-08-01T00:00:00Z',
      displayFulfillmentStatus: 'UNFULFILLED',
      fulfillmentOrders: { nodes: [{ id: 'fo1', status: 'OPEN', lineItems: { nodes: [
        { id: 'foli-A', remainingQuantity: 1, lineItem: { id: 'gid://li/A', sku: 'A' } },
      ] } }] },
    }])
    expect(m.get('LIT2225')).toEqual({
      orderId: 'gid://order/1', name: '#LIT2225', createdAt: '2026-08-01T00:00:00Z',
      displayFulfillmentStatus: 'UNFULFILLED',
      fulfillmentOrders: [{ id: 'fo1', status: 'OPEN', lineItems: [
        { id: 'foli-A', remainingQuantity: 1, shopifyLineId: 'gid://li/A', sku: 'A' },
      ] }],
    })
  })
})
