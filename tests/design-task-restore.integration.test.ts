import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { AUTO_CANCEL_SHIPPED, syncDesignTasks } from '@/lib/design-tasks'
import { RESTORE_PREFIX, restoreUnsentCancelledTasks, statusBeforeCancel } from '@/lib/design-task-restore'
import { GET, POST } from '@/app/api/design-studio/tasks/restore-unsent/route'
import { dropSessionUser, superRequest } from './helpers/session'

const P = 'dtr'
const SUP = `${P}-sup`
const SHOP = `${P}.myshopify.com`
let seq = 0
const T0 = Date.UTC(2026, 9, 25, 20, 0, 0)
const at = (min: number) => new Date(T0 + min * 60_000)

type LineOpts = { exported?: boolean; sheet?: boolean; dropship?: boolean; link?: boolean }
async function order(opts: { status?: string; lines: LineOpts[]; events?: Array<{ type: string; message: string; actorId?: string | null }>[] }) {
  seq++
  const id = `${P}-o${seq}`
  const code = `DTR${seq}`
  const storeId = (await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })).id
  await prisma.order.create({ data: {
    id, storeId, projectId: `${P}-proj`, shopifyOrderNumber: `#${code}`, financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0,
    placedAt: new Date('2026-10-18'), pipelineStatus: opts.status ?? 'FULFILLED', fulfillmentStatus: 'fulfilled', orderType: 'NON_CUSTOM',
    lines: { create: opts.lines.map((l, i) => ({
      id: `${id}-l${i + 1}`, shopifyLineId: `${id}-sl${i + 1}`, sku: `S${i + 1}`, productTitle: 'Hoodie', qty: 1, linePosition: i + 1, unitPrice: 1, resolvedSupplierId: SUP,
      designDriveLink: l.link === false ? null : 'https://drive.example/x', dropship: !!l.dropship,
      ...(l.exported ? { exportedAt: new Date('2026-10-20'), exportedToSupplierId: SUP } : {}),
    })) },
  } })
  for (const [i, l] of opts.lines.entries()) {
    const events = opts.events?.[i] ?? [{ type: 'SYSTEM', message: 'Đơn vào từ Shopify — tạo task' }, { type: 'SYSTEM', message: AUTO_CANCEL_SHIPPED }]
    await prisma.designTask.create({ data: {
      orderId: id, shopifyLineId: `${id}-sl${i + 1}`, taskKey: `${code}_${i + 1}`, status: 'CANCELLED',
      events: { create: events.map((e, n) => ({ ...e, createdAt: at(n) })) },
    } })
    if (l.sheet) await prisma.supplierSheetWrite.create({ data: { supplierId: SUP, orderId: id, orderLineId: `${id}-l${i + 1}`, lineKey: `${code}_${i + 1}`, spreadsheetId: 's', tabName: 't', status: 'WRITTEN' } })
  }
  return { id, code }
}
const task = (key: string) => prisma.designTask.findUniqueOrThrow({ where: { taskKey: key }, include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } })
const keys = (rows: { taskKey: string }[]) => rows.map(r => r.taskKey).filter(k => k.startsWith('DTR')).sort()

beforeAll(async () => {
  await prisma.project.create({ data: { id: `${P}-proj`, name: 'DTR', startDate: new Date('2026-01-01') } })
  await prisma.shopifyStore.create({ data: { shop: SHOP, projectId: `${P}-proj` } })
  await prisma.supplier.create({ data: { id: SUP, name: 'DTR Factory', code: `${P}sup` } })
})
afterAll(async () => {
  const orders = await prisma.order.findMany({ where: { id: { startsWith: `${P}-` } }, select: { id: true } })
  await prisma.supplierSheetWrite.deleteMany({ where: { orderId: { in: orders.map(o => o.id) } } })
  await prisma.order.deleteMany({ where: { id: { startsWith: `${P}-` } } })
  await prisma.shopifyStore.deleteMany({ where: { shop: SHOP } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.project.deleteMany({ where: { id: `${P}-proj` } })
  await dropSessionUser()
})

describe('statusBeforeCancel', () => {
  const ev = (type: string, message: string, n: number) => ({ id: `e${n}`, type, message, actorId: null, createdAt: at(n) })
  it('replays the events up to the sync cancel', () => {
    expect(statusBeforeCancel([ev('SYSTEM', 'Đơn vào từ Shopify — tạo task', 0), ev('SYSTEM', AUTO_CANCEL_SHIPPED, 1)])).toBe('NEW')
    expect(statusBeforeCancel([ev('ASSIGN', 'Giao cho A · 0.3 điểm', 0), ev('STATUS', 'Nhận việc', 1), ev('SYSTEM', AUTO_CANCEL_SHIPPED, 2)])).toBe('DOING')
    expect(statusBeforeCancel([ev('STATUS', 'Nhận việc', 0), ev('STATUS', 'Gửi duyệt', 1), ev('SYSTEM', AUTO_CANCEL_SHIPPED, 2)])).toBe('REVIEW')
    expect(statusBeforeCancel([ev('SYSTEM', 'Tự động gửi duyệt (file in tự động)', 0), ev('REJECT', 'Trả lại sửa: màu', 1), ev('SYSTEM', AUTO_CANCEL_SHIPPED, 2)])).toBe('REJECTED')
    expect(statusBeforeCancel([ev('STATUS', 'Nhận việc', 0), ev('ASK', 'Hỏi khách: tên?', 1), ev('SYSTEM', AUTO_CANCEL_SHIPPED, 2)])).toBe('DOING')
    expect(statusBeforeCancel([ev('ASSIGN', 'Giao cho A', 0), ev('SYSTEM', AUTO_CANCEL_SHIPPED, 1), ev('STATUS', 'Nhận việc', 2)])).toBe('ASSIGNED')
  })
})

describe('restoreUnsentCancelledTasks (owner 11/20/2026)', () => {
  it('lists only sync-cancelled tasks of unsent lines, restores them to their earlier state, and the sync leaves them alone', async () => {
    const o = await order({
      lines: [{}, { exported: true }, { sheet: true }, { dropship: true }, { link: false }],
      events: [
        [{ type: 'SYSTEM', message: 'Đơn vào từ Shopify — tạo task' }, { type: 'ASSIGN', message: 'Giao cho A', actorId: 'u1' }, { type: 'STATUS', message: 'Nhận việc', actorId: 'u1' }, { type: 'SYSTEM', message: AUTO_CANCEL_SHIPPED }],
      ],
    })
    const closed = await order({ status: 'CANCELLED', lines: [{}] })
    const byHand = await order({ lines: [{}], events: [[{ type: 'SYSTEM', message: AUTO_CANCEL_SHIPPED }, { type: 'STATUS', message: 'Huỷ task', actorId: 'u1' }]] })

    const dry = await restoreUnsentCancelledTasks({ apply: false })
    expect(keys(dry.rows)).toEqual([`${o.code}_1`, `${o.code}_5`])
    expect(dry.restored).toBe(0)
    expect(dry.rows.find(r => r.taskKey === `${o.code}_1`)).toMatchObject({ restoreTo: 'DOING', hasFile: true, supplier: 'DTR Factory', orderNumber: `#${o.code}` })
    expect(dry.rows.find(r => r.taskKey === `${o.code}_5`)).toMatchObject({ restoreTo: 'NEW', hasFile: false })
    expect((await task(`${o.code}_1`)).status).toBe('CANCELLED')
    expect((await task(`${closed.code}_1`)).status).toBe('CANCELLED')
    expect((await task(`${byHand.code}_1`)).status).toBe('CANCELLED')

    const done = await restoreUnsentCancelledTasks({ apply: true })
    expect(keys(done.rows)).toEqual([`${o.code}_1`, `${o.code}_5`])
    expect(done.restored).toBe(2)
    const t1 = await task(`${o.code}_1`)
    expect(t1.status).toBe('DOING')
    expect(t1.events.at(-1)).toMatchObject({ type: 'SYSTEM', message: `${RESTORE_PREFIX} (trả về DOING)` })
    expect((await task(`${o.code}_5`)).status).toBe('NEW')
    for (const k of [`${o.code}_2`, `${o.code}_3`, `${o.code}_4`, `${closed.code}_1`, `${byHand.code}_1`]) expect((await task(k)).status).toBe('CANCELLED')

    expect((await restoreUnsentCancelledTasks({ apply: true })).restored).toBe(0)

    const r = await syncDesignTasks(o.id)
    expect(r.cancelled).toBe(0)
    expect((await task(`${o.code}_1`)).status).toBe('DOING')
    expect((await task(`${o.code}_5`)).status).toBe('REJECTED')
  })

  it('the route: GET lists, POST {apply:true} restores, superadmin only', async () => {
    const o = await order({ lines: [{}] })
    const list = await GET(await superRequest('http://x/api/design-studio/tasks/restore-unsent'))
    expect(list.status).toBe(200)
    expect(keys((await list.json()).rows)).toContain(`${o.code}_1`)
    const other = await order({ lines: [{}] })
    const res = await POST(await superRequest('http://x/api/design-studio/tasks/restore-unsent', { method: 'POST', body: JSON.stringify({ apply: true, taskKeys: [`${o.code}_1`] }) }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ restored: 1, rows: [expect.objectContaining({ taskKey: `${o.code}_1` })] })
    expect((await task(`${o.code}_1`)).status).toBe('NEW')
    expect((await task(`${other.code}_1`)).status).toBe('CANCELLED')
    const { NextRequest } = await import('next/server')
    expect((await GET(new NextRequest('http://x/api/design-studio/tasks/restore-unsent'))).status).toBe(401)
  })
})
