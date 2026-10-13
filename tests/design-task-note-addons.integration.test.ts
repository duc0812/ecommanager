import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GET as getTask, PATCH as patchTask } from '@/app/api/design-studio/tasks/[key]/route'
import { addOnSummaries, buildTrelloCardContent, formatAddOn } from '@/lib/order-classify'

const ORDER_ID = 'gid://test/Order/dtn-1'
const SHOP = 'dtn.myshopify.com'
const PROJECT = 'proj_dtn'
const SUP = 'sup_dtn'
const KEY = 'DTN1_1'
const tokens: Record<string, string> = {}

async function user(name: string, role: string, permissions: string[] | null) {
  const email = `${name}@dtn.test`
  const row = await prisma.appUser.upsert({
    where: { email }, create: { name, email, role, permissions: permissions ? JSON.stringify(permissions) : undefined }, update: {},
  })
  tokens[name] = await signToken({ userId: row.id, email, name, role: role as any, permissions: (permissions ?? []) as any, tv: 0 })
  return row.id
}

function req(method: 'GET' | 'PATCH', who: string | null, body?: unknown) {
  const r = new NextRequest(`http://x/api/design-studio/tasks/${KEY}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  if (who) r.cookies.set(AUTH_COOKIE, tokens[who])
  return r
}
const patch = (who: string | null, body: unknown, key = KEY) => patchTask(req('PATCH', who, body), { params: { key } })
const noteEvents = async () => (await prisma.designTaskEvent.findMany({ where: { task: { taskKey: KEY }, type: 'NOTE' }, orderBy: { createdAt: 'asc' } }))

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DTN', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DTNSUP' }, create: { id: SUP, name: 'DTN Supplier', code: 'DTNSUP' }, update: {} })
  await prisma.order.create({ data: {
    id: ORDER_ID, projectId: PROJECT, storeId, shopifyOrderNumber: '#DTN1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-10'), pipelineStatus: 'PENDING_DESIGN',
    trelloCardId: 'card-dtn', trelloCardUrl: 'https://trello.com/c/dtn',
    lines: { create: [
      { shopifyLineId: 'n1', sku: 'LIT2570', productTitle: 'Mug', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, customized: true,
        customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Ann' }]) },
      { shopifyLineId: 'n2', sku: 'LIT2570_1', productTitle: 'Custom Text', variantTitle: 'Add Text', shopifyProductType: 'Custom Text', qty: 2, linePosition: 2, unitPrice: 1,
        customAttributesJson: JSON.stringify([{ key: 'Text', value: 'Happy Birthday' }, { key: '_hidden', value: 'x' }, { key: 'Font', value: 'Script' }]) },
      { shopifyLineId: 'n3', sku: null, productTitle: 'Tip', qty: 1, linePosition: 3, unitPrice: 1 },
    ] },
  } })
  await prisma.designTask.create({ data: { orderId: ORDER_ID, shopifyLineId: 'n1', taskKey: KEY, status: 'NEW' } })
  await user('designer', 'SUPPORT', ['design_tasks'])
  await user('outsider', 'SUPPORT', ['fulfillment_orders'])
  await user('admin', 'ADMIN', [])
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

describe('order add-ons on the task', () => {
  it('the task lists the same add-on lines the Trello card does, and links the card', async () => {
    const detail = await (await getTask(req('GET', 'designer'), { params: { key: KEY } })).json()
    expect(detail.order.addOns).toEqual([{ title: 'Custom Text', variantTitle: 'Add Text', qty: 2, details: 'Text: Happy Birthday, Font: Script' }])
    expect(detail.order.trelloCardUrl).toBe('https://trello.com/c/dtn')
    expect(detail.me.canEditNote).toBe(true)

    const lines = (await prisma.orderLine.findMany({ where: { orderId: ORDER_ID }, orderBy: { linePosition: 'asc' } })).map(l => ({
      sku: l.sku, productTitle: l.productTitle, shopifyProductType: l.shopifyProductType, variantTitle: l.variantTitle, qty: l.qty,
      customAttributes: JSON.parse(l.customAttributesJson ?? '[]'), productTags: [],
    }))
    const { desc } = buildTrelloCardContent('#DTN1', lines, 'CUSTOM')
    for (const a of detail.order.addOns) expect(desc).toContain(`- ${formatAddOn(a)}`)
    expect(desc).toContain('**Add-ons (digital):**\n- Custom Text [Add Text] x2 — Text: Happy Birthday, Font: Script')
  })

  it('addOnSummaries keeps only non-product lines that carry a SKU', () => {
    expect(addOnSummaries([
      { sku: 'A', productTitle: 'Mug', variantTitle: null, qty: 1, customAttributes: [] },
      { sku: null, productTitle: 'Tip', variantTitle: null, qty: 1, customAttributes: [] },
      { sku: 'PP', productTitle: 'Package Protection', variantTitle: null, qty: 1, customAttributes: [] },
    ])).toEqual([{ title: 'Package Protection', variantTitle: null, qty: 1, details: '' }])
    expect(formatAddOn({ title: 'Package Protection', variantTitle: null, qty: 1, details: '' })).toBe('Package Protection x1')
  })
})

describe('PATCH /api/design-studio/tasks/[key] — CS note', () => {
  it('a design_tasks user saves the note on the line and the change is logged on the task', async () => {
    const res = await patch('designer', { designNote: '  Khách muốn chữ to hơn  ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ designNote: 'Khách muốn chữ to hơn', changed: true })
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID, shopifyLineId: 'n1' } })).designNote).toBe('Khách muốn chữ to hơn')
    const events = await noteEvents()
    expect(events).toHaveLength(1)
    expect(events[0].message).toBe('Ghi chú CS: Khách muốn chữ to hơn')
    expect(events[0].actorId).toBeTruthy()
    const detail = await (await getTask(req('GET', 'designer'), { params: { key: KEY } })).json()
    expect(detail.line.designNote).toBe('Khách muốn chữ to hơn')
  })

  it('an admin may edit too; saving the same text logs nothing; null clears it', async () => {
    expect((await (await patch('admin', { designNote: 'Khách muốn chữ to hơn' })).json()).changed).toBe(false)
    expect(await noteEvents()).toHaveLength(1)
    expect((await (await patch('admin', { designNote: null })).json())).toEqual({ designNote: null, changed: true })
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID, shopifyLineId: 'n1' } })).designNote).toBeNull()
    expect((await noteEvents()).map(e => e.message)).toEqual(['Ghi chú CS: Khách muốn chữ to hơn', 'Xoá ghi chú CS'])
  })

  it('401 without a session, 403 without design_tasks, 400 for a bad body, 404 for an unknown task', async () => {
    expect((await patch(null, { designNote: 'x' })).status).toBe(401)
    expect((await patch('outsider', { designNote: 'x' })).status).toBe(403)
    expect((await patch('designer', {})).status).toBe(400)
    expect((await patch('designer', { designNote: 5 })).status).toBe(400)
    expect((await patch('designer', { designNote: 'a'.repeat(2001) })).status).toBe(400)
    expect((await patch('designer', { designNote: 'x' }, 'NOPE_1')).status).toBe(404)
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID, shopifyLineId: 'n1' } })).designNote).toBeNull()
  })
})
