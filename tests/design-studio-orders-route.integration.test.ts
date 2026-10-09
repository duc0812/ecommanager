import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { GET } from '@/app/api/design-studio/orders/route'

const PENDING_ID = 'gid://test/Order/ds-list-pending'
const FULFILLED_ID = 'gid://test/Order/ds-list-fulfilled'
const SHOP = 'ds-list.myshopify.com'
const PROJECT = 'proj_ds_list'

function req(qs: string) {
  return new NextRequest(`http://localhost/api/design-studio/orders?${qs}`)
}

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DS list', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  const base = {
    projectId: PROJECT, storeId, financialStatus: 'PAID', currency: 'USD', grossAmount: 50, expectedPayout: 48,
    totalFees: 2, refundedAmount: 0, placedAt: new Date('2026-10-01'),
  }
  await prisma.order.create({
    data: {
      ...base, id: PENDING_ID, shopifyOrderNumber: '#DSL1', pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [{ shopifyLineId: 'l1', sku: 'L1', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 50, customized: true, customAttributesJson: '[{"key":"_design","value":"big"}]' }] },
    },
  })
  await prisma.order.create({
    data: {
      ...base, id: FULFILLED_ID, shopifyOrderNumber: '#DSL2', pipelineStatus: 'FULFILLED', fulfillmentStatus: 'FULFILLED', orderType: 'CUSTOM',
      lines: { create: [{ shopifyLineId: 'l2', sku: 'L2', productTitle: 'Mug', qty: 1, linePosition: 1, unitPrice: 50 }] },
    },
  })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: [PENDING_ID, FULFILLED_ID] } } })
})

describe('GET /api/design-studio/orders', () => {
  it('returns only the requested statuses, with slim line fields', async () => {
    const res = await GET(req(`statuses=PENDING_DESIGN&projectId=${PROJECT}`))
    expect(res.status).toBe(200)
    const { orders } = await res.json()
    const ids = orders.map((o: any) => o.id)
    expect(ids).toContain(PENDING_ID)
    expect(ids).not.toContain(FULFILLED_ID)
    const o = orders.find((x: any) => x.id === PENDING_ID)
    expect(Object.keys(o).sort()).toEqual(['designReady', 'id', 'lines', 'orderType', 'pipelineStatus', 'placedAt', 'projectId', 'shopifyOrderNumber'])
    expect(Object.keys(o.lines[0]).sort()).toEqual(['customized', 'designDriveLink', 'id', 'previewCdnUrl', 'productTitle', 'resolvedSupplierId', 'shopifyLineId', 'sku'])
  })
  it('merges several statuses', async () => {
    const res = await GET(req(`statuses=PENDING_DESIGN,FULFILLED&projectId=${PROJECT}`))
    const ids = (await res.json()).orders.map((o: any) => o.id)
    expect(ids).toEqual(expect.arrayContaining([PENDING_ID, FULFILLED_ID]))
  })
  it('rejects an unknown status', async () => {
    const res = await GET(req('statuses=NOPE'))
    expect(res.status).toBe(400)
  })
})
