import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GET as getTasks } from '@/app/api/design-studio/tasks/route'

const P = 't22sl'
const STORE_A = `${P}-store-a`
const STORE_B = `${P}-store-b`
const SUP = `${P}-sup`
const EMAILS = [`${P}-admin@test.local`, `${P}-seller-a@test.local`]
const tokens: Record<'admin' | 'sellerA', string> = { admin: '', sellerA: '' }

type LineSeed = {
  id: string; pos: number; title?: string; type?: string; sku?: string; exportedAt?: Date | null
  attrs?: { key: string; value: string }[]; designDriveLink?: string | null; variantTitle?: string
}

async function order(id: string, storeId: string, number: string, placedAt: string, pipelineStatus: string, lines: LineSeed[], extra: { fulfillmentStatus?: string } = {}) {
  await prisma.order.create({ data: {
    id, storeId, projectId: storeId === STORE_A ? `${P}-proj-a` : `${P}-proj-b`, shopifyOrderNumber: number,
    financialStatus: 'PAID', currency: 'USD', grossAmount: 10, expectedPayout: 10, totalFees: 0, refundedAmount: 0,
    placedAt: new Date(placedAt), pipelineStatus, orderType: 'CUSTOM', fulfillmentStatus: extra.fulfillmentStatus ?? null,
    lines: { create: lines.map(l => ({
      id: l.id, shopifyLineId: `${l.id}-sl`, sku: l.sku ?? null, productTitle: l.title ?? 'QX22 Product', shopifyProductType: l.type ?? null,
      variantTitle: l.variantTitle ?? null, qty: 1, linePosition: l.pos, unitPrice: 10, resolvedSupplierId: l.type === 'Add-on' ? null : SUP,
      exportedAt: l.exportedAt === undefined ? new Date('2026-11-01T10:00:00Z') : l.exportedAt, exportedToSupplierId: l.exportedAt === null ? null : SUP,
      customAttributesJson: l.attrs ? JSON.stringify(l.attrs) : null,
      designDriveLink: l.designDriveLink === undefined ? 'https://drive.google.com/file/d/qx22/view' : l.designDriveLink,
    })) },
  } })
}

function req(url: string, who: 'admin' | 'sellerA') {
  const r = new NextRequest(`http://x${url}`)
  r.cookies.set(AUTH_COOKIE, tokens[who])
  return r
}

async function search(q: string, who: 'admin' | 'sellerA' = 'admin', extra = '') {
  const res = await getTasks(req(`/api/design-studio/tasks?q=${encodeURIComponent(q)}${extra}`, who))
  expect(res.status).toBe(200)
  return res.json()
}

const keys = (body: any) => body.sentLines.map((l: any) => l.lineKey)

async function cleanup() {
  await prisma.order.deleteMany({ where: { id: { startsWith: `${P}-` } } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: [STORE_A, STORE_B] } } })
  await prisma.project.deleteMany({ where: { id: { in: [`${P}-proj-a`, `${P}-proj-b`] } } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await cleanup()
  await prisma.supplier.create({ data: { id: SUP, name: 'QX22 Factory', code: 'QX22SUP' } })
  for (const s of ['a', 'b'] as const) {
    await prisma.project.create({ data: { id: `${P}-proj-${s}`, name: `QX22 ${s === 'a' ? 'Alpha' : 'Beta'}`, startDate: new Date('2026-01-01') } })
    await prisma.shopifyStore.create({ data: { id: s === 'a' ? STORE_A : STORE_B, shop: `${P}-${s}.myshopify.com`, projectId: `${P}-proj-${s}` } })
  }

  await order(`${P}-o1`, STORE_A, '#QX22A1', '2026-11-01T09:00:00Z', 'EXPORTED', [
    { id: `${P}-o1-l1`, pos: 1, title: 'Velvetine Lantern', sku: 'ZK-91X', variantTitle: 'Large',
      attrs: [{ key: 'Name', value: 'Zephyrine' }, { key: '_qx22plumbing', value: 'Quorblax' }] },
    { id: `${P}-o1-l2`, pos: 2, title: 'Shipping Protection', type: 'Add-on', exportedAt: null, designDriveLink: null },
    { id: `${P}-o1-l3`, pos: 3, title: 'QX22 Tasked Mug' },
    { id: `${P}-o1-l4`, pos: 4, title: 'QX22 Second Mug' },
  ])
  await prisma.designTask.create({ data: { orderId: `${P}-o1`, shopifyLineId: `${P}-o1-l3-sl`, taskKey: 'QX22A1_2', status: 'DONE' } })
  await order(`${P}-o2`, STORE_A, '#QX22A2', '2026-11-02T09:00:00Z', 'FULFILLED', [{ id: `${P}-o2-l1`, pos: 1 }])
  await order(`${P}-o3`, STORE_A, '#QX22A3', '2026-11-03T09:00:00Z', 'EXPORTED', [{ id: `${P}-o3-l1`, pos: 1 }], { fulfillmentStatus: 'FULFILLED' })
  await order(`${P}-o4`, STORE_A, '#QX22A4', '2026-11-04T09:00:00Z', 'READY_TO_PRODUCTION', [{ id: `${P}-o4-l1`, pos: 1, exportedAt: null }])
  await order(`${P}-o5`, STORE_A, '#QX22A5', '2026-11-05T09:00:00Z', 'PENDING_DESIGN', [
    { id: `${P}-o5-l1`, pos: 1 },
    { id: `${P}-o5-l2`, pos: 2, exportedAt: null, designDriveLink: null },
  ])
  await order(`${P}-o6`, STORE_A, '#QX22A6', '2026-11-05T10:00:00Z', 'CANCELLED', [{ id: `${P}-o6-l1`, pos: 1 }])
  await order(`${P}-o7`, STORE_B, '#QX22B1', '2026-11-03T12:00:00Z', 'EXPORTED', [{ id: `${P}-o7-l1`, pos: 1, sku: 'ZK-91X' }])

  const capLines = (o: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${P}-${o}-c${i + 1}`, pos: i + 1, sku: `CAPQX22-${o}-${i + 1}` }))
  await order(`${P}-cap-old`, STORE_A, '#QX22C1', '2026-10-01T09:00:00Z', 'EXPORTED', capLines('old', 30))
  await order(`${P}-cap-new`, STORE_A, '#QX22C2', '2026-10-02T09:00:00Z', 'EXPORTED', capLines('new', 25))

  for (const [who, role, permissions, stores] of [
    ['admin', 'ADMIN', [], []], ['sellerA', 'SELLER', ['design_tasks'], [STORE_A]],
  ] as const) {
    const email = `${P}-${who === 'admin' ? 'admin' : 'seller-a'}@test.local`
    const row = await prisma.appUser.create({ data: {
      name: who, email, role, permissions: JSON.stringify(permissions), storeAccess: { create: stores.map(storeId => ({ storeId })) },
    } })
    tokens[who] = await signToken({ userId: row.id, email, name: who, role, permissions: [...permissions], tv: row.tokenVersion })
  }
})

afterAll(cleanup)

describe('Design Studio search: lines already sent to a supplier without a task', () => {
  it('a search by order number lists the sent product lines that have no task, not the tasked line or the add-on', async () => {
    const body = await search('#QX22A1')
    expect(keys(body)).toEqual(['QX22A1_1', 'QX22A1_3'])
    expect(body.tasks.map((t: any) => t.taskKey)).toEqual(['QX22A1_2'])
    const row = body.sentLines[0]
    expect(row).toMatchObject({
      lineId: `${P}-o1-l1`, orderId: `${P}-o1`, orderNumber: '#QX22A1', pipelineStatus: 'EXPORTED', sku: 'ZK-91X',
      productTitle: 'Velvetine Lantern', variantTitle: 'Large', supplierName: 'QX22 Factory', storeName: 'QX22 Alpha',
      sentAt: '2026-11-01T10:00:00.000Z', designLinks: ['https://drive.google.com/file/d/qx22/view'],
    })
    expect(row.personalization).toEqual([{ key: 'Name', value: 'Zephyrine' }])
  })

  it('leaves out lines of fulfilled, Shopify-fulfilled and cancelled orders, and a line that was not sent', async () => {
    expect(keys(await search('QX22A2'))).toEqual([])
    expect(keys(await search('QX22A3'))).toEqual([])
    expect(keys(await search('QX22A6'))).toEqual([])
    expect(keys(await search('QX22A5'))).toEqual(['QX22A5_1'])
  })

  it('counts a line of a ready-for-production order as being sent, as the owner decided', async () => {
    expect(keys(await search('QX22A4'))).toEqual(['QX22A4_1'])
  })

  it('matches on line key, SKU, product title and a visible personalisation value (not a hidden app field), newest order first', async () => {
    expect(keys(await search('QX22A1_3'))).toEqual(['QX22A1_3'])
    expect(keys(await search('zk-91x'))).toEqual(['QX22B1_1', 'QX22A1_1'])
    expect(keys(await search('velvetine lantern'))).toEqual(['QX22A1_1'])
    expect(keys(await search('Zephyrine'))).toEqual(['QX22A1_1'])
    expect(keys(await search('Quorblax'))).toEqual([])
  })

  it('caps the list at 50 lines, newest order first', async () => {
    const body = await search('CAPQX22')
    expect(body.sentLines).toHaveLength(50)
    expect(body.sentLines.slice(0, 25).every((l: any) => l.orderNumber === '#QX22C2')).toBe(true)
    expect(body.sentLines[25]).toMatchObject({ orderNumber: '#QX22C1', lineKey: 'QX22C1_1' })
  })

  it('a seller sees only its own store, also when the store pick names it', async () => {
    const seller = await search('ZK-91X', 'sellerA')
    expect(keys(seller)).toEqual(['QX22A1_1'])
    expect(JSON.stringify(seller.sentLines)).not.toContain('QX22B')
    expect(JSON.stringify(seller.sentLines)).not.toContain('Beta')
    expect(keys(await search('ZK-91X', 'admin', `&storeId=${STORE_A}`))).toEqual(['QX22A1_1'])
  })

  it('without a search, or with a status filter, the answer only gains an empty list', async () => {
    const res = await getTasks(req('/api/design-studio/tasks', 'admin'))
    const body = await res.json()
    expect(Object.keys(body)).toEqual(['tasks', 'me', 'handoffCount', 'lastSync', 'sentLines'])
    expect(body.sentLines).toEqual([])
    expect((await search('QX22A1', 'admin', '&statuses=DONE')).sentLines).toEqual([])
  })
})
