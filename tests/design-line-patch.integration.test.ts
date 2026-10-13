import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { PATCH } from '@/app/api/design-studio/lines/[lineId]/route'

const ORDER_ID = 'gid://test/Order/dlp-1'
const SHOP = 'dlp.myshopify.com'
const PROJECT = 'proj_dlp'
const SUP = 'sup_dlp'
const tokens: Record<string, string> = {}
let taskLine = ''
let bareLine = ''

async function user(name: string, role: string, permissions: string[]) {
  const email = `${name}@dlp.test`
  const row = await prisma.appUser.upsert({ where: { email }, create: { name, email, role, permissions: JSON.stringify(permissions) }, update: {} })
  tokens[name] = await signToken({ userId: row.id, email, name, role: role as any, permissions: permissions as any, tv: 0 })
}

function patch(who: string | null, lineId: string, body: unknown) {
  const req = new NextRequest(`http://x/api/design-studio/lines/${lineId}`, { method: 'PATCH', body: JSON.stringify(body) })
  if (who) req.cookies.set(AUTH_COOKIE, tokens[who])
  return PATCH(req, { params: { lineId } })
}

const state = async () => {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: ORDER_ID }, include: { lines: true, designTasks: true } })
  return { status: order.pipelineStatus, ready: order.designReady, links: order.lines.map(l => l.designDriveLink), tasks: order.designTasks.map(t => t.status) }
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DLP', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DLPSUP' }, create: { id: SUP, name: 'DLP Supplier', code: 'DLPSUP' }, update: {} })
  const order = await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: PROJECT, storeId, shopifyOrderNumber: '#DLP1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-10'), pipelineStatus: 'PENDING_DESIGN',
      lines: { create: [
        { shopifyLineId: 'p1', sku: 'DLP-1', productTitle: 'Mug', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, customized: true },
        { shopifyLineId: 'p2', sku: 'DLP-2', productTitle: 'Mug', qty: 1, linePosition: 2, unitPrice: 1 },
      ] },
    },
    include: { lines: true },
  })
  taskLine = order.lines.find(l => l.shopifyLineId === 'p1')!.id
  bareLine = order.lines.find(l => l.shopifyLineId === 'p2')!.id
  await prisma.designArtwork.create({ data: { orderId: ORDER_ID, shopifyLineId: 'p1', printArea: 'Artwork', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png' } })
  await prisma.designTask.create({ data: { orderId: ORDER_ID, shopifyLineId: 'p1', taskKey: 'DLP1_1', status: 'DOING' } })
  await user('designer', 'SUPPORT', ['design_tasks'])
  await user('orders', 'SUPPORT', ['fulfillment_orders'])
  await user('admin', 'ADMIN', [])
  await user('super', 'SUPERADMIN', [])
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
})

describe('PATCH /api/design-studio/lines/[lineId]', () => {
  it.each(['designer', 'admin', 'super'])('%s cannot mark a line done or reopen it here — approval goes through the task review', async (who) => {
    const before = await state()
    for (const done of [true, false]) {
      const res = await patch(who, taskLine, { done })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('task')
    }
    expect((await patch(who, taskLine, { done: true, note: 'x' })).status).toBe(400)
    expect(await state()).toEqual(before)
    expect(before).toMatchObject({ status: 'PENDING_DESIGN', ready: false, links: [null, null], tasks: ['DOING'] })
  })

  it('needs a session, and design_tasks or admin, to edit the note', async () => {
    expect((await patch(null, taskLine, { note: 'x' })).status).toBe(401)
    expect((await patch('orders', taskLine, { note: 'x' })).status).toBe(403)
    expect((await patch('designer', taskLine, {})).status).toBe(400)
    expect((await patch('designer', 'no-such-line', { note: 'x' })).status).toBe(404)
  })

  it('saves the note; on a line with a task the change is logged there', async () => {
    const res = await patch('designer', taskLine, { note: ' In chữ vàng ' })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      line: { id: taskLine, designDriveLink: null, designNote: 'In chữ vàng' },
      order: { id: ORDER_ID, designReady: false, pipelineStatus: 'PENDING_DESIGN' },
    })
    const events = await prisma.designTaskEvent.findMany({ where: { task: { taskKey: 'DLP1_1' }, type: 'NOTE' } })
    expect(events.map(e => e.message)).toEqual(['Ghi chú CS: In chữ vàng'])

    const bare = await patch('admin', bareLine, { note: 'không có task' })
    expect(bare.status).toBe(200)
    expect((await bare.json()).line.designNote).toBe('không có task')
    expect((await patch('admin', bareLine, { note: null })).status).toBe(200)
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: bareLine } })).designNote).toBeNull()
  })
})
