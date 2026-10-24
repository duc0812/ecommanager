import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { buildOrderTimeline, formatTimeline } from '@/lib/cs/timeline'

const PROJECT = 'cs-tl-project'
const SHOP = 'cs-tl.myshopify.com'
const SUP = 'cs-tl-supplier'
const A = 'cs-tl-order-a'
const B = 'cs-tl-order-b'
const T0 = new Date('2026-10-01T10:00:00Z')
const day = (n: number) => new Date(T0.getTime() + n * 86400_000)
const settings = { productionDays: 5, shippingDays: 15 }

beforeAll(async () => {
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CS tl', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { id: SUP }, create: { id: SUP, name: 'TL Factory', code: 'TLF' }, update: {} })
  const base = (id: string, number: string) => ({ id, projectId: PROJECT, storeId, shopifyOrderNumber: number, customerEmail: 'tl@x.com', financialStatus: 'PAID', currency: 'USD', grossAmount: 10, expectedPayout: 9, placedAt: T0 })
  await prisma.order.create({ data: { ...base(A, '#LIT8001'), pipelineStatus: 'EXPORTED', supplierHandoffAt: day(5), supplierHandoffMode: 'API',
    lines: { create: [{ shopifyLineId: 'tl-a1', productTitle: 'Family Mug', qty: 1, unitPrice: 10, linePosition: 1, customized: true, customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Laurance' }]), designDriveLink: 'https://drive.test/a1.png', designNote: 'approved: Laurance' }] },
    designTasks: { create: [{ shopifyLineId: 'tl-a1', taskKey: 'LIT8001_1', status: 'DONE', createdAt: day(0), updatedAt: day(3), events: { create: [{ type: 'SYSTEM', message: 'Đơn vào từ Shopify — tạo task', createdAt: day(0) }, { type: 'STATUS', message: 'REVIEW → DONE', createdAt: day(3) }] } }] },
    supplierPushes: { create: [{ supplierId: SUP, status: 'CREATED', pushedAt: day(5), remoteStatus: 'PRINTED', externalOrderId: 'ext-a', requestJson: '{}' }] },
    shipments: { create: [{ projectId: PROJECT, lineKey: '8001_1', trackingNumber: 'TLA1', status: 'IN_TRANSIT', lastCheckpointAt: day(20), checkpointsJson: JSON.stringify([{ time: day(9).toISOString(), desc: 'Picked up', status: 'IN_TRANSIT' }, { time: day(20).toISOString(), desc: 'In transit', status: 'IN_TRANSIT' }]) }] },
  } })
  await prisma.order.create({ data: { ...base(B, '#LIT8002'), exportedAt: day(1), exportedToSupplierId: SUP,
    lines: { create: [{ shopifyLineId: 'tl-b1', productTitle: 'Tumbler', qty: 1, unitPrice: 10, linePosition: 1, customized: false }] },
  } })
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: [A, B] } } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

describe('buildOrderTimeline', () => {
  it('builds events and lateness gaps for an order with a full timeline', async () => {
    const t = (await buildOrderTimeline(A, settings, day(30)))!
    expect(t.legacy).toBe(false)
    const gap = (name: string) => t.gaps.find(g => g.name === name)!
    expect(gap('design').days).toBeCloseTo(3, 1); expect(gap('design').late).toBe(true)
    expect(gap('handoff').days).toBeCloseTo(2, 1); expect(gap('handoff').late).toBe(false)
    expect(gap('production').days).toBeCloseTo(4, 1); expect(gap('production').late).toBe(false)
    expect(gap('transit').days).toBeCloseTo(21, 1); expect(gap('transit').late).toBe(true)
    expect(gap('stalled').days).toBeCloseTo(10, 1); expect(gap('stalled').late).toBe(true)
    expect(t.events.map(e => e.stage)).toEqual(['ORDER', 'DESIGN', 'DESIGN', 'FULFILLMENT', 'FACTORY', 'CARRIER', 'CARRIER'])
    expect(t.customerInputs[0].fields).toEqual({ Name: 'Laurance' })
    expect(t.printFiles[0].designNote).toBe('approved: Laurance')
    expect(t.shipments[0].firstScanAt?.toISOString()).toBe(day(9).toISOString())
  })
  it('treats an order without design studio data as legacy and uses exportedAt as the hand-off', async () => {
    const t = (await buildOrderTimeline(B, settings, day(30)))!
    expect(t.legacy).toBe(true)
    expect(t.gaps.find(g => g.name === 'design')).toBeUndefined()
    expect(t.gaps.find(g => g.name === 'handoff')).toBeUndefined()
    const f = t.events.find(e => e.stage === 'FULFILLMENT')!
    expect(f.at.toISOString()).toBe(day(1).toISOString())
    expect(f.label).toContain('CSV')
    expect(formatTimeline(t)).toContain('no design timeline')
  })
  it('formats gaps with LATE markers and MM/DD/YYYY dates', async () => {
    const text = formatTimeline((await buildOrderTimeline(A, settings, day(30)))!)
    expect(text).toContain('10/01/2026')
    expect(text).toContain('LATE')
    expect(text).toContain('Name = "Laurance"')
  })
  it('returns null for an unknown order', async () => {
    expect(await buildOrderTimeline('nope', settings)).toBeNull()
  })
})
