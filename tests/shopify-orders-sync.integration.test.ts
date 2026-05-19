import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { prisma } from '@/lib/db'

const SHOP = 'test-store.myshopify.com'
const TOKEN = 'test_token'

beforeAll(async () => {
  // Multi-tenant setup: project must exist + linked to store
  await prisma.project.upsert({
    where: { id: 'proj_test' },
    create: { id: 'proj_test', name: 'Test Project', startDate: new Date('2026-05-01') },
    update: { archivedAt: null },
  })
  await prisma.shopifyStore.upsert({
    where: { shop: SHOP },
    create: { shop: SHOP, syncSinceDate: new Date('2026-05-01'), projectId: 'proj_test' },
    update: { syncSinceDate: new Date('2026-05-01'), projectId: 'proj_test' },
  })
  await prisma.supplier.upsert({
    where: { code: 'test_sup' },
    create: {
      id: 'sup_test',
      name: 'Test Sup',
      code: 'test_sup',
      firstItemShipFee: 4.99,
      additionalItemShipFee: 2.99,
    },
    update: {},
  })
  await prisma.supplierProduct.upsert({
    where: { supplierId_sku: { supplierId: 'sup_test', sku: 'TSHIRT-RED-M' } },
    create: { supplierId: 'sup_test', sku: 'TSHIRT-RED-M', baseCost: 48.20 },
    update: { baseCost: 48.20 },
  })
})

afterAll(async () => {
  const stores = await prisma.shopifyStore.findMany({ where: { shop: SHOP } })
  const storeIds = stores.map(s => s.id)
  const orders = await prisma.order.findMany({ where: { storeId: { in: storeIds } } })
  const orderIds = orders.map(o => o.id)
  await prisma.orderLine.deleteMany({ where: { orderId: { in: orderIds } } })
  await prisma.order.deleteMany({ where: { storeId: { in: storeIds } } })
})

describe('POST /api/shopify/orders/sync', () => {
  it('upserts orders with computed P/L from mocked Shopify response', async () => {
    const mockResponse = {
      data: {
        orders: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [{
            id: 'gid://shopify/Order/4090412213889',
            name: '#1023',
            createdAt: '2026-05-18T07:06:00Z',
            processedAt: '2026-05-18T07:06:00Z',
            displayFinancialStatus: 'PAID',
            displayFulfillmentStatus: 'UNFULFILLED',
            currencyCode: 'USD',
            currentTotalPriceSet: { shopMoney: { amount: '149.99' } },
            currentSubtotalPriceSet: { shopMoney: { amount: '149.99' } },
            currentTotalTaxSet: { shopMoney: { amount: '0' } },
            currentShippingPriceSet: { shopMoney: { amount: '0' } },
            customer: { email: 'smoothflight@yahoo.com', displayName: 'David Olsen' },
            shippingAddress: { country: 'United States', countryCodeV2: 'US', province: 'CA' },
            taxLines: [],
            lineItems: { nodes: [{
              id: 'gid://shopify/LineItem/1',
              sku: 'TSHIRT-RED-M',
              title: 'Premium Tee',
              variantTitle: 'Red / M',
              quantity: 1,
              originalUnitPriceSet: { shopMoney: { amount: '149.99' } },
            }] },
            transactions: [{
              id: 'gid://shopify/OrderTransaction/1',
              kind: 'SALE',
              status: 'SUCCESS',
              processedAt: '2026-05-18T07:06:00Z',
              amountSet: { shopMoney: { amount: '149.99' } },
              fees: [{ amount: { amount: '4.65' } }],
            }],
            refunds: [],
          }],
        },
      },
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => mockResponse,
      text: async () => '',
    } as Response)

    const { POST } = await import('@/app/api/shopify/orders/sync/route')
    const req = new Request('http://test/api/shopify/orders/sync', {
      method: 'POST',
      headers: {
        'x-shopify-shop-domain': SHOP,
        'x-shopify-access-token': TOKEN,
      },
    })
    const res = await POST(req as any)
    const body = await res.json()

    expect(body.totalSynced).toBe(1)
    expect(body.withUnmappedSku).toBe(0)
    expect(body.projectId).toBe('proj_test')

    const saved = await prisma.order.findUnique({
      where: { id: 'gid://shopify/Order/4090412213889' },
      include: { lines: true },
    })
    expect(saved).not.toBeNull()
    expect(saved!.projectId).toBe('proj_test')
    expect(saved!.expectedPayout).toBeCloseTo(145.34, 2)
    expect(saved!.totalFees).toBeCloseTo(4.65, 2)
    expect(saved!.defaultSupplierId).toBe('sup_test')
    expect(saved!.lines).toHaveLength(1)
    expect(saved!.lines[0].resolvedBaseCost).toBeCloseTo(48.20, 2)

    fetchSpy.mockRestore()
  })
})
