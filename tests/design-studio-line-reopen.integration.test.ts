import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_ROLE_PERMISSIONS, type FeaturePermission } from '@/lib/roles'
import { LINE_FIX_REASONS } from '@/lib/line-fix'
import { SUPPLIER_RECHECK, SUPPLIER_TOLD, listSupplierFixes, loadTask, syncDesignTasks, transitionTask, type Actor } from '@/lib/design-tasks'
import { markOrdersExported, updateOrderStatus } from '@/lib/repos/orders'
import { markPushExported } from '@/lib/repos/push-export'
import { closeCancelledPush, reservePush } from '@/lib/repos/supplier-push-core'
import { buildPrintwayPush } from '@/lib/repos/printway-push'
import { handoffStateFor, listHandoffCards, pendingCardsForSupplier } from '@/lib/supplier-handoff'
import { POST as postReopen } from '@/app/api/design-studio/lines/[lineId]/reopen/route'
import { POST as postTransition } from '@/app/api/design-studio/tasks/[key]/transition/route'
import { GET as getFixes } from '@/app/api/design-studio/tasks/supplier-recheck/route'
import { POST as postTold } from '@/app/api/design-studio/tasks/[key]/supplier-told/route'

const P = 't22r'
const STORE_A = `${P}-store-a`
const STORE_B = `${P}-store-b`
const SUP = `${P}-sup`
const SENT_AT = new Date('2026-11-02T08:00:00Z')
const LINK = 'https://drive.google.com/drive/folders/t22r-sent'
const [FACTORY_ASKS, CUSTOMER_ASKS, WE_FOUND] = LINE_FIX_REASONS
const NOTE = 'chỗ cái dao bị lệch'
const RECHECK = 'Design đã sửa sau khi gửi xưởng — báo T22R Factory kiểm tra lại folder design (không ghi lại sheet)'
const fix = (reason: string = FACTORY_ASKS, note = NOTE) => ({ reason, note })

type Who = 'lead' | 'des' | 'sellerA' | 'sellerOrders' | 'sellerPlain'
const users: Record<Who, { id: string; token: string; actor: Actor }> = {} as any
let printwayId = ''
let createdPrintway = false
let seq = 0

type OrderOpts = {
  status?: string; fulfillmentStatus?: string | null; store?: string; line2Supplier?: string; task2?: 'DONE' | 'CANCELLED' | 'REVIEW'
  exported?: boolean; addOn?: boolean; sheet?: boolean; fromLibrary?: boolean
}

async function sentOrder(opts: OrderOpts = {}) {
  seq++
  const id = `${P}-o${seq}`
  const code = `T22R${seq}`
  const exported = opts.exported ?? true
  const line = (n: number, title: string, supplier: string | null, extra: object = {}) => ({
    id: `${id}-l${n}`, shopifyLineId: `${id}-sl${n}`, productTitle: title, qty: 1, linePosition: n, unitPrice: 10, customized: true,
    resolvedSupplierId: supplier, designDriveLink: supplier ? LINK : null,
    exportedAt: supplier && exported ? SENT_AT : null, exportedToSupplierId: supplier && exported ? supplier : null, ...extra,
  })
  await prisma.order.create({ data: {
    id, storeId: opts.store ?? STORE_A, projectId: opts.store === STORE_B ? `${P}-proj-b` : `${P}-proj-a`, shopifyOrderNumber: `#${code}`,
    financialStatus: 'PAID', currency: 'USD', grossAmount: 20, expectedPayout: 20, totalFees: 0, refundedAmount: 0,
    placedAt: new Date(`2020-01-01T00:00:${String(seq).padStart(2, '0')}Z`), pipelineStatus: opts.status ?? 'EXPORTED', orderType: 'CUSTOM',
    fulfillmentStatus: opts.fulfillmentStatus ?? null, designReady: true, designDriveLink: LINK,
    exportedAt: exported ? SENT_AT : null, exportedToSupplierId: exported ? SUP : null,
    ...(opts.sheet && exported ? { supplierHandoffAt: SENT_AT, supplierHandoffMode: 'SHEET' } : {}),
    lines: { create: [
      line(1, 'Reopen Mug', SUP),
      ...(opts.addOn ? [line(2, 'Shipping Protection', null)] : []),
      line(3, 'Reopen Tee', opts.line2Supplier ?? SUP),
    ] },
  } })
  await prisma.designArtwork.create({ data: { orderId: id, shopifyLineId: `${id}-sl1`, printArea: 'PRINT', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png' } })
  await prisma.designTask.create({ data: { orderId: id, shopifyLineId: `${id}-sl1`, taskKey: `${code}_1`, status: 'DONE' } })
  if (opts.task2) await prisma.designTask.create({ data: { orderId: id, shopifyLineId: `${id}-sl3`, taskKey: `${code}_2`, status: opts.task2, fromLibrary: opts.fromLibrary ?? false } })
  if (opts.sheet && exported) {
    for (const [n, key] of [[1, `${code}_1`], [3, `${code}_2`]] as const) {
      await prisma.supplierSheetWrite.create({ data: {
        supplierId: SUP, orderId: id, orderLineId: `${id}-l${n}`, lineKey: key, spreadsheetId: 'sheet-t22r', tabName: 'ORDER 11-2026', status: 'WRITTEN', rowRange: `A${n + 1}`,
      } })
    }
  }
  return { id, code, line1: `${id}-l1`, line2: `${id}-l3`, addOn: `${id}-l2`, sl1: `${id}-sl1`, sl2: `${id}-sl3`, key1: `${code}_1`, key2: `${code}_2` }
}
type Sent = Awaited<ReturnType<typeof sentOrder>>

function authed(url: string, who: Who, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const req = new NextRequest(`http://x${url}`, init)
  req.cookies.set(AUTH_COOKIE, users[who].token)
  return req
}

const press = (lineId: string, who: Who, body: unknown = fix()) =>
  postReopen(authed(`/api/design-studio/lines/${lineId}/reopen`, who, { method: 'POST', body: JSON.stringify(body) }), { params: { lineId } })
const transitionReq = (key: string, who: Who, body: unknown) =>
  postTransition(authed(`/api/design-studio/tasks/${key}/transition`, who, { method: 'POST', body: JSON.stringify(body) }), { params: { key } })
const told = (key: string, who: Who) => postTold(authed(`/api/design-studio/tasks/${key}/supplier-told`, who, { method: 'POST', body: '{}' }), { params: { key } })

type FixList = { waiting: any[]; told: any[]; fixing: any[]; waitingTotal: number; suppliers: { id: string; name: string }[] }
async function fixes(who: Who, qs = ''): Promise<FixList> {
  const res = await getFixes(authed(`/api/design-studio/tasks/supplier-recheck${qs}`, who))
  expect(res.status).toBe(200)
  const body = await res.json()
  const mine = (rows: any[]) => rows.filter((r: any) => r.orderNumber.startsWith('#T22R'))
  return { ...body, waiting: mine(body.waiting), told: mine(body.told), fixing: mine(body.fixing) }
}
const keysOf = (rows: any[]) => rows.map(r => r.taskKey)

async function lineTask(orderId: string, shopifyLineId: string) {
  return prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } }, include: { events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } })
}

async function state(orderId: string) {
  const o = await prisma.order.findUniqueOrThrow({ where: { id: orderId }, include: { lines: { orderBy: { linePosition: 'asc' } } } })
  return { status: o.pipelineStatus, exported: o.lines.filter(l => l.exportedAt).map(l => l.id) }
}

async function marks(orderId: string) {
  return (await prisma.orderLine.findMany({ where: { orderId }, orderBy: { linePosition: 'asc' } })).map(l => [l.id, l.exportedAt?.toISOString() ?? null, l.exportedToSupplierId])
}

async function sheetRows(orderId: string) {
  return (await prisma.supplierSheetWrite.findMany({ where: { orderId }, orderBy: { lineKey: 'asc' } })).map(w => ({ id: w.id, lineKey: w.lineKey, status: w.status, updatedAt: w.updatedAt.toISOString() }))
}

/** The designer uploads the corrected file and sends it for review; the leader approves. */
async function fixAndApprove(orderId: string, shopifyLineId: string, key: string, version = 2) {
  await prisma.designArtwork.create({ data: { orderId, shopifyLineId, printArea: 'PRINT', version, fileName: `fix${version}.png`, storagePath: `x/fix${version}.png`, size: 1, mimeType: 'image/png' } })
  const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: key } })
  if (task.status === 'ASSIGNED') await transitionTask(key, users.des.actor, { to: 'DOING' })
  if (task.status !== 'REVIEW') await transitionTask(key, users.des.actor, { to: 'REVIEW' })
  return transitionTask(key, users.lead.actor, { to: 'DONE' })
}

async function readyLines(orderId: string) {
  return [...(await handoffStateFor(orderId))?.readyLineIds ?? []].sort()
}

async function offered(orderId: string) {
  const [all, ofSupplier] = await Promise.all([listHandoffCards(), pendingCardsForSupplier(SUP)])
  return { hub: all.pending.some(c => c.order.id === orderId), sheetSend: ofSupplier.some(c => c.order.id === orderId) }
}

async function recheckEvents(orderId: string, shopifyLineId: string) {
  return (await lineTask(orderId, shopifyLineId))!.events.filter(e => e.type === SUPPLIER_RECHECK || e.type === SUPPLIER_TOLD)
    .map(e => ({ type: e.type, actorId: e.actorId }))
}

/** A live push of the Printway supplier that carried line 2, as a push made by the app leaves it. */
async function livePush(o: Sent) {
  return prisma.supplierOrderPush.create({ data: {
    orderId: o.id, supplierId: printwayId, externalOrderId: o.code, activeKey: `${o.id}::${printwayId}`, status: 'CREATED', exportMarked: true,
    requestJson: '{}', pushedAt: SENT_AT, prevExportJson: JSON.stringify({ lineIds: [o.line2], shopifyLineIds: [o.sl2], pipelineStatus: 'READY_TO_PRODUCTION' }),
  } })
}

async function cleanup() {
  const orders = await prisma.order.findMany({ where: { id: { startsWith: `${P}-` } }, select: { id: true } })
  await prisma.supplierSheetWrite.deleteMany({ where: { orderId: { in: orders.map(o => o.id) } } })
  await prisma.order.deleteMany({ where: { id: { startsWith: `${P}-` } } })
  await prisma.appUser.deleteMany({ where: { email: { startsWith: `${P}-` } } })
  await prisma.shopifyStore.deleteMany({ where: { id: { in: [STORE_A, STORE_B] } } })
  await prisma.project.deleteMany({ where: { id: { in: [`${P}-proj-a`, `${P}-proj-b`] } } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await cleanup()
  await prisma.supplier.create({ data: { id: SUP, name: 'T22R Factory', code: `${P}sup` } })
  const pw = await prisma.supplier.findUnique({ where: { code: 'printway' } })
  createdPrintway = !pw
  printwayId = (pw ?? await prisma.supplier.create({ data: { name: 'Printway', code: 'printway' } })).id
  for (const s of ['a', 'b'] as const) {
    await prisma.project.create({ data: { id: `${P}-proj-${s}`, name: `T22R ${s}`, startDate: new Date('2026-01-01') } })
    await prisma.shopifyStore.create({ data: { id: s === 'a' ? STORE_A : STORE_B, shop: `${P}-${s}.myshopify.com`, projectId: `${P}-proj-${s}` } })
  }
  const make = async (who: Who, role: string, permissions: FeaturePermission[], stores: string[] = []) => {
    const email = `${P}-${who}@test.local`
    const row = await prisma.appUser.create({ data: { name: who, email, role, permissions: JSON.stringify(permissions), storeAccess: { create: stores.map(storeId => ({ storeId })) } } })
    users[who] = {
      id: row.id, actor: { id: row.id, name: who, role, permissions },
      token: await signToken({ userId: row.id, email, name: who, role: role as any, permissions, tv: row.tokenVersion }),
    }
  }
  await make('lead', 'ADMIN', DEFAULT_ROLE_PERMISSIONS.ADMIN)
  await make('des', 'SUPPORT', ['design_tasks'])
  await make('sellerA', 'SELLER', ['design_tasks'], [STORE_A])
  await make('sellerOrders', 'SELLER', ['fulfillment_orders'], [STORE_A])
  await make('sellerPlain', 'SELLER', ['projects'], [STORE_A])
})

afterAll(async () => {
  await cleanup()
  if (createdPrintway) await prisma.supplier.deleteMany({ where: { id: printwayId } })
})

describe('the reason and the "Cần sửa ở đâu" note are required', () => {
  it.each([
    ['no reason', { note: NOTE }, /Chọn lý do/],
    ['an unknown reason', { reason: 'Xưởng trả file', note: NOTE }, /Lý do không hợp lệ/],
    ['no note', { reason: CUSTOMER_ASKS }, /Cần sửa ở đâu/],
    ['a note of blanks', { reason: CUSTOMER_ASKS, note: '     ' }, /Cần sửa ở đâu/],
    ['a note under 3 characters once trimmed', { reason: CUSTOMER_ASKS, note: '  ab  ' }, /từ 3 đến 500 ký tự \(đang 2\)/],
    ['a note over 500 characters', { reason: CUSTOMER_ASKS, note: 'x'.repeat(501) }, /từ 3 đến 500 ký tự \(đang 501\)/],
  ])('refuses %s with a 400 and changes nothing', async (_name, body: { reason?: string; note?: string }, message) => {
    const o = await sentOrder({ task2: 'DONE' })
    const before = await marks(o.id)
    const res = await press(o.line2, 'des', body)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(message)
    const viaControl = await transitionReq(o.key2, 'des', { to: 'DOING', reasons: body.reason ? [body.reason] : undefined, note: body.note })
    expect(viaControl.status).toBe(400)
    expect((await viaControl.json()).error).toMatch(message)
    expect((await lineTask(o.id, o.sl2))!).toMatchObject({ status: 'DONE', rejectReasons: null })
    expect((await lineTask(o.id, o.sl2))!.events).toEqual([])
    expect(await marks(o.id)).toEqual(before)
  })

  it('keeps 3 and 500 characters, trimmed', async () => {
    const a = await sentOrder()
    expect((await press(a.line2, 'des', fix(WE_FOUND, '  abc  '))).status).toBe(200)
    expect((await lineTask(a.id, a.sl2))!.rejectNote).toBe('abc')
    const b = await sentOrder()
    expect((await press(b.line2, 'des', fix(WE_FOUND, 'y'.repeat(500)))).status).toBe(200)
  })
})

describe('"Mở lại để sửa" at press time', () => {
  it.each(LINE_FIX_REASONS)('reopens that line alone (%s), a second press changes nothing, and the task sync leaves it open', async reason => {
    const o = await sentOrder({ sheet: true })
    const before = { marks: await marks(o.id), sheet: await sheetRows(o.id), order: await prisma.order.findUniqueOrThrow({ where: { id: o.id } }) }
    const res = await press(o.line2, 'des', fix(reason))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ changed: true, task: { taskKey: o.key2, status: 'REJECTED', rejectReasons: [reason], rejectNote: NOTE } })
    const task = await lineTask(o.id, o.sl2)
    expect(task!.events.map(e => ({ type: e.type, message: e.message, actorId: e.actorId }))).toEqual([
      { type: 'REJECT', message: `Mở lại để sửa (đã gửi xưởng) — ${reason}: ${NOTE}`, actorId: users.des.id },
    ])
    expect(await lineTask(o.id, o.sl1)).toMatchObject({ status: 'DONE', rejectReasons: null })
    expect((await lineTask(o.id, o.sl1))!.events).toEqual([])
    expect(await marks(o.id)).toEqual(before.marks)
    expect(await sheetRows(o.id)).toEqual(before.sheet)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({
      pipelineStatus: 'EXPORTED', designReady: true, supplierHandoffMode: 'SHEET', supplierHandoffAt: before.order.supplierHandoffAt,
    })
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: o.line2 } })).designDriveLink).toBe(LINK)

    const again = await press(o.line2, 'lead', fix(WE_FOUND, 'lần bấm thứ hai'))
    expect(again.status).toBe(200)
    expect(await again.json()).toMatchObject({ changed: false, task: { taskKey: o.key2, status: 'REJECTED', rejectReasons: [reason], rejectNote: NOTE } })
    expect(await prisma.designTask.count({ where: { orderId: o.id } })).toBe(2)
    expect((await lineTask(o.id, o.sl2))!.events).toHaveLength(1)

    await syncDesignTasks(o.id)
    expect(await lineTask(o.id, o.sl2)).toMatchObject({ status: 'REJECTED', rejectReasons: JSON.stringify([reason]) })
    // A leader hands it to a designer: an outside link closes an ASSIGNED task unless it was sent back.
    await transitionTask(o.key2, users.lead.actor, { to: 'ASSIGNED', assigneeId: users.des.id })
    await syncDesignTasks(o.id)
    expect(await lineTask(o.id, o.sl2)).toMatchObject({ status: 'ASSIGNED', rejectReasons: JSON.stringify([reason]) })
    expect(await marks(o.id)).toEqual(before.marks)
  })

  it('two people pressing at once make one task and one event', async () => {
    const o = await sentOrder()
    const [a, b] = await Promise.all([press(o.line2, 'des'), press(o.line2, 'lead', fix(CUSTOMER_ASKS))])
    expect([a.status, b.status]).toEqual([200, 200])
    expect([(await a.json()).changed, (await b.json()).changed].sort()).toEqual([false, true])
    expect(await prisma.designTask.count({ where: { orderId: o.id, shopifyLineId: o.sl2 } })).toBe(1)
    expect((await lineTask(o.id, o.sl2))!.events).toHaveLength(1)
  })

  it('a DONE task of the line is reopened the same way, through the route or through its own "Sửa & gửi lại" control', async () => {
    const viaRoute = await sentOrder({ task2: 'DONE' })
    const res = await press(viaRoute.line2, 'sellerA', fix(CUSTOMER_ASKS))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ changed: true, task: { taskKey: viaRoute.key2, status: 'REJECTED', rejectReasons: [CUSTOMER_ASKS], rejectNote: NOTE } })
    expect((await lineTask(viaRoute.id, viaRoute.sl2))!.events).toEqual([expect.objectContaining({ type: 'REJECT', actorId: users.sellerA.id })])

    const viaControl = await sentOrder({ task2: 'DONE' })
    expect((await loadTask(viaControl.key2))!.reopensSentLine).toBe(true)
    const r = await transitionReq(viaControl.key2, 'des', { to: 'DOING', reasons: [WE_FOUND], note: NOTE })
    expect(r.status).toBe(200)
    expect((await r.json()).task).toMatchObject({ taskKey: viaControl.key2, status: 'REJECTED', rejectReasons: [WE_FOUND], rejectNote: NOTE })
    expect((await lineTask(viaControl.id, viaControl.sl2))!.events.map(e => [e.type, e.message, e.actorId])).toEqual([
      ['REJECT', `Mở lại để sửa (đã gửi xưởng) — ${WE_FOUND}: ${NOTE}`, users.des.id],
    ])
    for (const o of [viaRoute, viaControl]) {
      expect(await state(o.id)).toEqual({ status: 'EXPORTED', exported: [o.line1, o.line2] })
      expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: o.line2 } })).designDriveLink).toBe(LINK)
      expect((await lineTask(o.id, o.sl1))!.status).toBe('DONE')
      await syncDesignTasks(o.id)
      expect((await lineTask(o.id, o.sl2))!.status).toBe('REJECTED')
    }
  })

  it('a task waiting for the library scan is reopened as a normal task, and the sync does not close it', async () => {
    const o = await sentOrder({ task2: 'DONE', fromLibrary: true })
    expect((await press(o.line2, 'des')).status).toBe(200)
    expect(await lineTask(o.id, o.sl2)).toMatchObject({ status: 'REJECTED', fromLibrary: false })
    await transitionTask(o.key2, users.lead.actor, { to: 'ASSIGNED', assigneeId: users.des.id })
    await syncDesignTasks(o.id)
    expect((await lineTask(o.id, o.sl2))!.status).toBe('ASSIGNED')
  })

  it('a task already open is left as it is', async () => {
    const o = await sentOrder({ task2: 'REVIEW' })
    const res = await press(o.line2, 'des')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ changed: false, task: { taskKey: o.key2, status: 'REVIEW', rejectReasons: [] } })
    expect((await lineTask(o.id, o.sl2))!.events).toEqual([])
  })

  it('a key held by another task refuses with a 409 instead of colliding', async () => {
    const o = await sentOrder()
    await prisma.designTask.update({ where: { taskKey: o.key1 }, data: { taskKey: o.key2 } })
    const res = await press(o.line2, 'des')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(new RegExp(`${o.key2} đang thuộc một task khác`))
    expect(await lineTask(o.id, o.sl2)).toBeNull()
  })
})

describe('approval of the fix: a line the supplier got by a link (sheet, CSV, a mark by hand)', () => {
  it('a sheet line: nothing is sent or written again; staff are told to have the supplier re-check, and "Đã báo xưởng" closes it', async () => {
    const o = await sentOrder({ sheet: true })
    const sheet = await sheetRows(o.id)
    const before = await marks(o.id)
    await press(o.line2, 'des', fix(CUSTOMER_ASKS))
    expect(keysOf((await fixes('lead')).fixing)).toContain(o.key2)
    const r = await fixAndApprove(o.id, o.sl2, o.key2)
    expect(r).toMatchObject({ task: { status: 'DONE' }, notice: RECHECK })
    expect(await marks(o.id)).toEqual(before)
    expect(await state(o.id)).toEqual({ status: 'EXPORTED', exported: [o.line1, o.line2] })
    expect(await readyLines(o.id)).toEqual([])
    expect(await offered(o.id)).toEqual({ hub: false, sheetSend: false })
    expect(await sheetRows(o.id)).toEqual(sheet)
    expect(await prisma.supplierSheetWrite.count({ where: { orderId: o.id } })).toBe(2)
    expect(await recheckEvents(o.id, o.sl2)).toEqual([{ type: SUPPLIER_RECHECK, actorId: null }])
    expect((await lineTask(o.id, o.sl2))!.events.find(e => e.type === SUPPLIER_RECHECK)!.message).toBe(RECHECK)

    const reopenEvent = (await lineTask(o.id, o.sl2))!.events.find(e => e.type === 'REJECT')!
    const approval = (await lineTask(o.id, o.sl2))!.events.find(e => e.type === SUPPLIER_RECHECK)!
    const newLink = (await prisma.orderLine.findUniqueOrThrow({ where: { id: o.line2 } })).designDriveLink
    const list = await fixes('lead')
    expect(keysOf(list.fixing)).not.toContain(o.key2)
    expect(list.waiting.find(w => w.taskKey === o.key2)).toEqual(expect.objectContaining({
      taskKey: o.key2, orderNumber: `#${o.code}`, storeName: 'T22R a', supplierId: SUP, supplierName: 'T22R Factory', reason: CUSTOMER_ASKS, note: NOTE,
      reopenedBy: 'des', reopenedAt: reopenEvent.createdAt.toISOString(), approvedAt: approval.createdAt.toISOString(), designLink: newLink,
      toldBy: null, toldAt: null, taskStatus: 'DONE',
    }))
    expect(list.waitingTotal).toBeGreaterThanOrEqual(list.waiting.length)

    const res = await told(o.key2, 'des')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ changed: true })
    expect(await recheckEvents(o.id, o.sl2)).toEqual([{ type: SUPPLIER_RECHECK, actorId: null }, { type: SUPPLIER_TOLD, actorId: users.des.id }])
    const toldEvent = (await lineTask(o.id, o.sl2))!.events.find(e => e.type === SUPPLIER_TOLD)!
    expect(toldEvent.message).toBe('Đã báo T22R Factory kiểm tra lại folder design')
    const after = await fixes('lead')
    expect(keysOf(after.waiting)).not.toContain(o.key2)
    expect(after.told.find(t => t.taskKey === o.key2)).toEqual(expect.objectContaining({ toldBy: 'des', toldAt: toldEvent.createdAt.toISOString(), reason: CUSTOMER_ASKS }))
    expect(await (await told(o.key2, 'lead')).json()).toEqual({ changed: false })
    expect(await recheckEvents(o.id, o.sl2)).toHaveLength(2)

    const in13Days = new Date(toldEvent.createdAt.getTime() + 13 * 86400_000)
    const in15Days = new Date(toldEvent.createdAt.getTime() + 15 * 86400_000)
    expect(keysOf((await listSupplierFixes({ now: in13Days })).told)).toContain(o.key2)
    expect(keysOf((await listSupplierFixes({ now: in15Days })).told)).not.toContain(o.key2)
    expect(keysOf((await listSupplierFixes({ now: in15Days })).waiting)).not.toContain(o.key2)

    await press(o.line2, 'des', fix(WE_FOUND, 'lần hai: màu chữ'))
    const reopened = await fixes('lead')
    expect(reopened.fixing.find(f => f.taskKey === o.key2)).toMatchObject({ reason: WE_FOUND, note: 'lần hai: màu chữ', taskStatus: 'REJECTED' })
    expect(keysOf(reopened.told)).not.toContain(o.key2)
    expect((await fixAndApprove(o.id, o.sl2, o.key2, 3)).notice).toBe(RECHECK)
    const second = await fixes('lead')
    expect(second.waiting.find(w => w.taskKey === o.key2)).toMatchObject({ reason: WE_FOUND, note: 'lần hai: màu chữ', toldAt: null })
    expect(keysOf(second.told)).not.toContain(o.key2)
    expect(await marks(o.id)).toEqual(before)
    expect(await sheetRows(o.id)).toEqual(sheet)
  })

  it.each([
    ['a CSV export', async (o: Sent) => { await markOrdersExported([o.id], SUP, SENT_AT, { mode: 'CSV', byId: null }) }],
    ['the order set to Exported by hand', async (o: Sent) => { await updateOrderStatus(o.id, 'EXPORTED') }],
  ])('%s counts as a link: the mark stays and the supplier is to re-check', async (_name, send) => {
    const o = await sentOrder({ status: 'READY_TO_PRODUCTION', exported: false })
    await send(o)
    const before = await marks(o.id)
    expect(await state(o.id)).toEqual({ status: 'EXPORTED', exported: [o.line1, o.line2] })
    await press(o.line2, 'des')
    expect((await fixAndApprove(o.id, o.sl2, o.key2)).notice).toBe(RECHECK)
    expect(await marks(o.id)).toEqual(before)
    expect(await state(o.id)).toEqual({ status: 'EXPORTED', exported: [o.line1, o.line2] })
    expect(await offered(o.id)).toEqual({ hub: false, sheetSend: false })
    expect(keysOf((await fixes('lead')).waiting)).toContain(o.key2)
  })

  it('#LIT5105: a line reopened by the old control (no reason, notes beside it) and approved after deploy gets the same rule, reason "—"', async () => {
    const o = await sentOrder({ task2: 'DONE', sheet: true })
    const task = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: o.key2 } })
    // What production holds this morning: STATUS "Mở lại để sửa" by a user (DONE → DOING, link cleared), two notes, sent for review.
    const t0 = Date.now() - 60_000
    await prisma.designTaskEvent.createMany({ data: [
      { taskId: task.id, type: 'STATUS', message: 'Duyệt design (designer)', actorId: users.des.id, createdAt: new Date(t0 - 86400_000) },
      { taskId: task.id, type: 'STATUS', message: 'Mở lại để sửa', actorId: users.des.id, createdAt: new Date(t0) },
      { taskId: task.id, type: 'NOTE', message: 'design khác mockup', actorId: users.des.id, createdAt: new Date(t0 + 1000) },
      { taskId: task.id, type: 'NOTE', message: 'chỗ cái dao', actorId: users.lead.id, createdAt: new Date(t0 + 2000) },
    ] })
    await prisma.designTask.update({ where: { id: task.id }, data: { status: 'DOING', assigneeId: users.des.id } })
    await prisma.orderLine.update({ where: { id: o.line2 }, data: { designDriveLink: null } })
    await prisma.order.update({ where: { id: o.id }, data: { designReady: false } })
    await prisma.designArtwork.create({ data: { orderId: o.id, shopifyLineId: o.sl2, printArea: 'PRINT', version: 2, fileName: 'fix2.png', storagePath: 'x/fix2.png', size: 1, mimeType: 'image/png' } })
    await transitionTask(o.key2, users.des.actor, { to: 'REVIEW' })
    const before = await marks(o.id)
    const sheet = await sheetRows(o.id)

    expect((await fixes('lead')).fixing.find(f => f.taskKey === o.key2)).toMatchObject({ reason: null, note: 'design khác mockup · chỗ cái dao', reopenedBy: 'des', taskStatus: 'REVIEW' })
    const r = await transitionTask(o.key2, users.lead.actor, { to: 'DONE' })
    expect(r).toMatchObject({ task: { status: 'DONE' }, notice: RECHECK })
    expect(await marks(o.id)).toEqual(before)
    expect(await sheetRows(o.id)).toEqual(sheet)
    expect(await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).toMatchObject({ pipelineStatus: 'EXPORTED', designReady: true })
    expect(await offered(o.id)).toEqual({ hub: false, sheetSend: false })
    expect((await fixes('lead')).waiting.find(w => w.taskKey === o.key2)).toMatchObject({
      reason: null, note: 'design khác mockup · chỗ cái dao', reopenedBy: 'des', reopenedAt: new Date(t0).toISOString(), supplierName: 'T22R Factory',
    })
  })

  it.each([
    ['a link', undefined],
    ['an API push', 'push'],
  ] as const)('an approval that ends no reopen of a line sent by %s changes nothing beyond today: no to-do, no mark moved', async (_name, via) => {
    // The line went out while its task was still in its first design (the order set to Exported by hand, or pushed beforehand).
    const o = await sentOrder({ task2: 'REVIEW', ...(via ? { line2Supplier: printwayId } : {}) })
    if (via) await livePush(o)
    await prisma.orderLine.update({ where: { id: o.line2 }, data: { designDriveLink: null } })
    const before = await marks(o.id)
    await prisma.designArtwork.create({ data: { orderId: o.id, shopifyLineId: o.sl2, printArea: 'PRINT', version: 1, fileName: 'b.png', storagePath: 'x/b.png', size: 1, mimeType: 'image/png' } })
    const r = await transitionTask(o.key2, users.lead.actor, { to: 'DONE' })
    expect(r.notice).toBeUndefined()
    expect(await recheckEvents(o.id, o.sl2)).toEqual([])
    expect(await marks(o.id)).toEqual(before)
    expect(await state(o.id)).toEqual({ status: 'EXPORTED', exported: [o.line1, o.line2] })
    expect(await readyLines(o.id)).toEqual([])
  })
})

describe('the section "Đã update design / Cần báo xưởng"', () => {
  it('lists waiting rows oldest approval first, filters by reason (— included) and supplier, and counts every waiting row', async () => {
    const a = await sentOrder()
    const b = await sentOrder({ line2Supplier: printwayId })
    const c = await sentOrder({ task2: 'DONE' })
    await press(a.line2, 'des', fix(CUSTOMER_ASKS))
    await fixAndApprove(a.id, a.sl2, a.key2)
    // b: line 1 goes to the T22R factory by a link; its line 2 at Printway was marked by hand, with no push.
    await press(b.line2, 'des', fix(WE_FOUND))
    await fixAndApprove(b.id, b.sl2, b.key2)
    const ct = await prisma.designTask.findUniqueOrThrow({ where: { taskKey: c.key2 } })
    await prisma.designTaskEvent.create({ data: { taskId: ct.id, type: 'STATUS', message: 'Mở lại để sửa', actorId: users.lead.id } })
    await prisma.designTask.update({ where: { id: ct.id }, data: { status: 'REVIEW' } })
    await prisma.orderLine.update({ where: { id: c.line2 }, data: { designDriveLink: null } })
    await prisma.designArtwork.create({ data: { orderId: c.id, shopifyLineId: c.sl2, printArea: 'PRINT', version: 2, fileName: 'c.png', storagePath: 'x/c.png', size: 1, mimeType: 'image/png' } })
    await transitionTask(c.key2, users.lead.actor, { to: 'DONE' })
    const d = await sentOrder()
    await press(d.line2, 'des', fix(FACTORY_ASKS))

    const all = await fixes('lead')
    const mine = [a.key2, b.key2, c.key2]
    expect(keysOf(all.waiting).filter(k => mine.includes(k))).toEqual(mine)
    expect(all.waitingTotal).toBeGreaterThanOrEqual(3)
    expect(keysOf(all.fixing)).toContain(d.key2)
    expect(all.suppliers).toEqual(expect.arrayContaining([{ id: SUP, name: 'T22R Factory' }, { id: printwayId, name: 'Printway' }]))

    const ours = (rows: any[]) => keysOf(rows).filter(k => mine.includes(k))
    const byReason = await fixes('lead', `?reason=${encodeURIComponent(WE_FOUND)}`)
    expect(ours(byReason.waiting)).toEqual([b.key2])
    expect(byReason.waiting.every(r => r.reason === WE_FOUND)).toBe(true)
    expect(keysOf(byReason.fixing)).not.toContain(d.key2)
    expect(byReason.waitingTotal).toBeGreaterThanOrEqual(3)
    expect(byReason.waitingTotal).toBeGreaterThan(byReason.waiting.length)
    const noReason = await fixes('lead', '?reason=none')
    expect(ours(noReason.waiting)).toEqual([c.key2])
    expect(noReason.waiting.every(r => r.reason === null)).toBe(true)
    expect(keysOf((await fixes('lead', `?reason=${encodeURIComponent(FACTORY_ASKS)}`)).fixing)).toContain(d.key2)
    const atPrintway = await fixes('lead', `?supplier=${printwayId}`)
    expect(ours(atPrintway.waiting)).toEqual([b.key2])
    expect(atPrintway.waiting.every(r => r.supplierId === printwayId)).toBe(true)
    expect(ours((await fixes('lead', `?supplier=${SUP}`)).waiting)).toEqual([a.key2, c.key2])
  })

  it('follows the store scope: a seller sees and closes only its own store\'s rows', async () => {
    const own = await sentOrder()
    const other = await sentOrder({ store: STORE_B })
    for (const o of [own, other]) {
      await press(o.line2, 'lead')
      await fixAndApprove(o.id, o.sl2, o.key2)
    }
    expect(keysOf((await fixes('lead')).waiting)).toEqual(expect.arrayContaining([own.key2, other.key2]))
    const seller = await fixes('sellerA')
    expect(keysOf(seller.waiting)).toContain(own.key2)
    expect(keysOf(seller.waiting)).not.toContain(other.key2)
    expect(JSON.stringify(seller)).not.toContain('T22R b')
    expect((await told(other.key2, 'sellerA')).status).toBe(404)
    expect((await told(own.key2, 'sellerA')).status).toBe(200)
  })
})

describe('approval of the fix: a line the supplier got by an API push', () => {
  it('sends that line alone again: refused while the old push is live, cancelled it goes out as <order>-R2; no to-do', async () => {
    const o = await sentOrder({ line2Supplier: printwayId })
    const old = await livePush(o)
    await press(o.line2, 'des')
    const r = await fixAndApprove(o.id, o.sl2, o.key2)
    expect(r.notice).toBeUndefined()
    expect(await recheckEvents(o.id, o.sl2)).toEqual([])
    expect(await state(o.id)).toEqual({ status: 'READY_TO_PRODUCTION', exported: [o.line1] })
    expect(await readyLines(o.id)).toEqual([o.line2])
    const card = (await listHandoffCards()).pending.find(c => c.order.id === o.id)!
    expect(card.lines.map(l => ({ key: l.lineKey, exportedTo: l.exportedTo, waiting: l.waiting }))).toEqual([
      { key: o.key1, exportedTo: 'T22R Factory', waiting: null },
      { key: o.key2, exportedTo: null, waiting: null },
    ])
    expect(card.state.pushBeside).toBe(false)
    const list = await fixes('lead')
    expect(keysOf([...list.waiting, ...list.told, ...list.fixing])).not.toContain(o.key2)

    const live = await buildPrintwayPush(o.id, { quote: false })
    expect(live!.preview.issues.map(i => i.code)).toContain('ACTIVE_PUSH')
    await expect(reservePush({ orderId: o.id, supplierId: printwayId, externalOrderId: `${o.code}-R2`, lines: [{ id: o.line2, shopifyLineId: o.sl2 }], requestJson: '{}', userId: null }, 'trùng'))
      .rejects.toMatchObject({ status: 409 })

    await closeCancelledPush(old, 'cancelled')
    expect(await state(o.id)).toEqual({ status: 'READY_TO_PRODUCTION', exported: [o.line1] })
    const fresh = await buildPrintwayPush(o.id, { quote: false })
    expect(fresh!.preview.issues.map(i => i.code)).not.toContain('ACTIVE_PUSH')
    expect(fresh!.externalOrderId).toBe(`${o.code}-R2`)
    const sent = await reservePush({ orderId: o.id, supplierId: printwayId, externalOrderId: fresh!.externalOrderId, lines: [{ id: o.line2, shopifyLineId: o.sl2 }], requestJson: '{}', userId: null }, 'trùng')
    await prisma.supplierOrderPush.update({ where: { id: sent.id }, data: { status: 'CREATED' } })
    expect(await markPushExported({ id: sent.id, orderId: o.id, supplierId: printwayId, pushedAt: sent.pushedAt })).toBe(true)
    expect(await state(o.id)).toEqual({ status: 'EXPORTED', exported: [o.line1, o.line2] })
    expect(await readyLines(o.id)).toEqual([])
  })

  it('a mixed order: the link line keeps its mark and gets a to-do, the pushed line goes back to hand-off alone', async () => {
    const o = await sentOrder({ line2Supplier: printwayId })
    await livePush(o)
    await press(o.line1, 'des')
    await press(o.line2, 'des')
    expect((await fixAndApprove(o.id, o.sl1, o.key1)).notice).toBe(RECHECK)
    expect(await state(o.id)).toEqual({ status: 'EXPORTED', exported: [o.line1, o.line2] })
    expect((await fixAndApprove(o.id, o.sl2, o.key2)).notice).toBeUndefined()
    expect(await state(o.id)).toEqual({ status: 'READY_TO_PRODUCTION', exported: [o.line1] })
    expect(await readyLines(o.id)).toEqual([o.line2])
    const open = keysOf((await fixes('lead')).waiting)
    expect(open).toContain(o.key1)
    expect(open).not.toContain(o.key2)
  })

  it('a line sent again by CSV after its push was cancelled is marked and the order is Exported again', async () => {
    const o = await sentOrder({ line2Supplier: printwayId })
    const old = await livePush(o)
    await press(o.line2, 'des')
    await fixAndApprove(o.id, o.sl2, o.key2)
    await closeCancelledPush(old, 'cancelled')
    await markOrdersExported([o.id], printwayId, new Date(), { mode: 'CSV', byId: null }, { lineIds: [o.line2] })
    expect(await state(o.id)).toEqual({ status: 'EXPORTED', exported: [o.line1, o.line2] })
    expect(await readyLines(o.id)).toEqual([])
  })

  it('the existing control on a DONE task of a pushed line follows the same rule', async () => {
    const o = await sentOrder({ line2Supplier: printwayId, task2: 'DONE' })
    await livePush(o)
    expect((await (await transitionReq(o.key2, 'des', { to: 'DOING', reasons: [FACTORY_ASKS], note: NOTE })).json()).task).toMatchObject({ status: 'REJECTED' })
    await fixAndApprove(o.id, o.sl2, o.key2)
    expect(await state(o.id)).toEqual({ status: 'READY_TO_PRODUCTION', exported: [o.line1] })
    expect(await readyLines(o.id)).toEqual([o.line2])
  })
})

describe('the order-level factory return (order set to DESIGN_REJECTED) is unchanged', () => {
  it('reopens every task, and the first approval clears every line and re-offers each line once approved, with no to-do', async () => {
    const o = await sentOrder({ task2: 'DONE' })
    await updateOrderStatus(o.id, 'DESIGN_REJECTED')
    expect((await syncDesignTasks(o.id)).reopened).toBe(2)
    for (const sl of [o.sl1, o.sl2]) {
      const t = await lineTask(o.id, sl)
      expect(t).toMatchObject({ status: 'REJECTED', rejectReasons: JSON.stringify(['Xưởng trả file']) })
      expect(t!.events.map(e => [e.type, e.message, e.actorId])).toEqual([['SYSTEM', 'Xưởng trả file — mở lại task', null]])
    }
    expect(keysOf((await fixes('lead')).fixing)).not.toContain(o.key2)
    expect((await fixAndApprove(o.id, o.sl1, o.key1)).notice).toBeUndefined()
    expect(await state(o.id)).toEqual({ status: 'READY_TO_PRODUCTION', exported: [] })
    expect(await readyLines(o.id)).toEqual([o.line1])
    expect((await fixAndApprove(o.id, o.sl2, o.key2)).notice).toBeUndefined()
    expect(await state(o.id)).toEqual({ status: 'READY_TO_PRODUCTION', exported: [] })
    expect(await readyLines(o.id)).toEqual([o.line1, o.line2])
    for (const sl of [o.sl1, o.sl2]) expect(await recheckEvents(o.id, sl)).toEqual([])
  })
})

describe('"Sửa & gửi lại" on a task whose line was not sent', () => {
  it('works as before: no form, the task goes to DOING and the line waits for its new design', async () => {
    const o = await sentOrder({ status: 'READY_TO_PRODUCTION', exported: false })
    expect((await loadTask(o.key1))!.reopensSentLine).toBe(false)
    const res = await transitionReq(o.key1, 'des', { to: 'DOING' })
    expect(res.status).toBe(200)
    expect((await res.json()).task).toMatchObject({ status: 'DOING', rejectReasons: [] })
    expect((await lineTask(o.id, o.sl1))!.events.map(e => [e.type, e.message])).toEqual([['STATUS', 'Mở lại để sửa']])
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: o.line1 } })).designDriveLink).toBeNull()
    expect(await state(o.id)).toEqual({ status: 'PENDING_DESIGN', exported: [] })
    await transitionTask(o.key1, users.des.actor, { to: 'REVIEW' })
    expect((await transitionTask(o.key1, users.lead.actor, { to: 'DONE' })).notice).toBeUndefined()
    expect(await state(o.id)).toEqual({ status: 'READY_TO_PRODUCTION', exported: [] })
    expect(await readyLines(o.id)).toEqual([o.line1, o.line2])
    const list = await fixes('lead')
    expect(keysOf([...list.waiting, ...list.fixing])).not.toContain(o.key1)
  })
})

describe('refusals', () => {
  it.each([
    ['a fulfilled order', { status: 'FULFILLED' }, /fulfilled/],
    ['an order Shopify reports fulfilled', { fulfillmentStatus: 'FULFILLED' }, /fulfilled/],
    ['a cancelled order', { status: 'CANCELLED' }, /huỷ hoặc hoàn tiền/],
    ['a refunded order', { status: 'REFUNDED' }, /huỷ hoặc hoàn tiền/],
    ['a line not sent yet', { status: 'PENDING_DESIGN', exported: false }, /chưa gửi xưởng/],
  ] as const)('refuses %s with a 409 and changes nothing', async (_name, opts: OrderOpts, message) => {
    const o = await sentOrder(opts)
    const before = await marks(o.id)
    const res = await press(o.line2, 'des')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(message)
    expect(await lineTask(o.id, o.sl2)).toBeNull()
    expect(await marks(o.id)).toEqual(before)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).pipelineStatus).toBe(opts.status ?? 'EXPORTED')
  })

  it('refuses an add-on line', async () => {
    const o = await sentOrder({ addOn: true })
    const res = await press(o.addOn, 'des')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/không phải sản phẩm/)
    expect(await prisma.designTask.count({ where: { orderId: o.id } })).toBe(1)
  })

  it('refuses a line whose task was cancelled: a cancelled task never opens again', async () => {
    const o = await sentOrder({ task2: 'CANCELLED' })
    const res = await press(o.line2, 'des')
    expect(res.status).toBe(409)
    expect((await res.json()).error).toMatch(/đã huỷ — task đã huỷ không mở lại được/)
    expect((await lineTask(o.id, o.sl2))!.status).toBe('CANCELLED')
  })

  it('refuses an unknown line with a 404', async () => {
    expect((await press(`${P}-nope`, 'des')).status).toBe(404)
  })

  it('a seller: 404 for another store\'s line, 403 without the feature; in its store it may press like the task actions beside it', async () => {
    const other = await sentOrder({ store: STORE_B })
    expect((await press(other.line2, 'sellerA')).status).toBe(404)
    expect(await lineTask(other.id, other.sl2)).toBeNull()
    const own = await sentOrder()
    expect((await press(own.line2, 'sellerPlain')).status).toBe(403)
    expect(await lineTask(own.id, own.sl2)).toBeNull()
    expect((await press(own.line2, 'sellerA')).status).toBe(200)
    const asOrders = await sentOrder()
    expect((await transitionReq(asOrders.key1, 'sellerOrders', { to: 'DOING', reasons: [FACTORY_ASKS], note: NOTE })).status).toBe(200)
    expect((await press(asOrders.line2, 'sellerOrders')).status).toBe(200)
    expect((await getFixes(authed('/api/design-studio/tasks/supplier-recheck', 'sellerPlain'))).status).toBe(403)
    expect((await told(asOrders.key1, 'sellerPlain')).status).toBe(403)
  })
})
