import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { signToken, AUTH_COOKIE } from '@/lib/auth'
import { insights, insightsCsv } from '@/lib/cs/insights'
import { PATCH as patchRootCause } from '@/app/api/cs/tickets/[id]/root-cause/route'
import { GET as getInsights } from '@/app/api/cs/insights/route'

const T = (iso: string) => new Date(iso)
const PROJECT = 'cs-ins-project'
const SHOP = 'cs-ins.myshopify.com'
const SUP = 'cs-ins-supplier'
const ORDER = 'cs-ins-order'
const period = { from: T('2026-10-19T17:00:00Z'), to: T('2026-10-25T16:59:59Z') }
let token = ''
let userId = ''

async function mk(fdId: number, at: string, stage: string | null, issue: string | null, patch: Record<string, unknown> = {}) {
  const t = await prisma.csTicket.create({ data: { fdTicketId: fdId, subject: `ins ${fdId}`, fdStatus: 2, fdPriority: 1, category: 'WRONG_ITEM', orderId: ORDER, orderNumber: '#LIT8301', orderMatch: 'EXACT', fdCreatedAt: T(at), fdUpdatedAt: T(at), lastCustomerAt: T(at), ...patch } })
  await prisma.csMessage.create({ data: { ticketId: t.id, fdConversationId: `ins-${fdId}`, author: 'CUSTOMER', bodyText: 'x', createdAt: T(at) } })
  await prisma.csAnalysis.create({ data: { ticketId: t.id, model: 'm', inputHash: 'h', outputJson: '{}', category: 'WRONG_ITEM', urgency: 'HIGH', sentiment: 'CALM', summary: 's', proposal: 'p', needsHuman: true, rootCauseStage: stage, issueType: issue, rootCauseConfidence: stage ? 'HIGH' : null, rootCauseEvidence: stage ? 'File "duyệt", in sai, lỗi xưởng' : null, rootCauseAt: T(at), affectedLineIds: JSON.stringify(['ins-l1']) } })
  return t
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.csTicket.deleteMany({})
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'CS ins', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { id: SUP }, create: { id: SUP, name: 'Ins Factory', code: 'INSF' }, update: {} })
  await prisma.order.upsert({ where: { id: ORDER }, update: {}, create: { id: ORDER, projectId: PROJECT, storeId, shopifyOrderNumber: '#LIT8301', financialStatus: 'PAID', currency: 'USD', grossAmount: 10, expectedPayout: 9, placedAt: T('2026-10-01T00:00:00Z'), exportedToSupplierId: SUP,
    lines: { create: [{ shopifyLineId: 'ins-l1', productTitle: 'Family Mug', qty: 1, unitPrice: 10, linePosition: 1 }, { shopifyLineId: 'ins-l2', productTitle: 'Tumbler', qty: 1, unitPrice: 10, linePosition: 2 }] } } })
  await mk(601, '2026-10-20T08:00:00Z', 'FACTORY', 'WRONG_TEXT')
  await mk(602, '2026-10-21T08:00:00Z', 'FACTORY', 'PRINT_QUALITY', { rootCauseStageOverride: 'DESIGN', rootCauseNote: 'file sai' })
  await mk(603, '2026-10-22T08:00:00Z', 'CARRIER', 'LATE_SHIPPING', { fdStatus: 5 })
  await mk(604, '2026-10-10T08:00:00Z', 'FACTORY', 'WRONG_TEXT')
  await mk(605, '2026-10-23T08:00:00Z', null, null)
  await mk(606, '2026-10-23T09:00:00Z', 'FACTORY', 'WRONG_TEXT')
  const u = await prisma.appUser.upsert({ where: { email: 'cs-ins@test.local' }, update: {}, create: { name: 'Ins Tester', email: 'cs-ins@test.local', role: 'SUPPORT', permissions: JSON.stringify(['cs']) } })
  userId = u.id
  token = await signToken({ userId, email: u.email, name: u.name, role: 'SUPPORT', permissions: ['cs'], tv: 0 })
})
afterAll(async () => {
  await prisma.csTicket.deleteMany({})
  await prisma.order.deleteMany({ where: { id: ORDER } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: 'cs-ins@test.local' } })
})

describe('insights', () => {
  it('totals, stage breakdown (override wins), weekly trend, products and suppliers', async () => {
    const r = await insights(period)
    expect(r.totals.all).toBe(5)
    expect(r.totals.problem).toBe(4)
    expect(r.totals.topStage).toBe('FACTORY')
    expect(r.byStage).toEqual({ FACTORY: 2, DESIGN: 1, CARRIER: 1 })
    expect(r.byIssue).toEqual({ WRONG_TEXT: 2, PRINT_QUALITY: 1, LATE_SHIPPING: 1 })
    expect(r.weekly).toHaveLength(1)
    expect(r.weekly[0].byStage.FACTORY).toBe(2)
    expect(r.products[0]).toEqual({ title: 'Family Mug', count: 4 })
    expect(r.suppliers[0]).toEqual({ supplierId: SUP, name: 'Ins Factory', count: 4 })
    expect(r.rows.map(x => x.fdTicketId).sort()).toEqual([601, 602, 603, 606])
    expect(r.rows.find(x => x.fdTicketId === 602)!.overridden).toBe(true)
  })
  it('filters by stage and category', async () => {
    expect((await insights({ ...period, stage: 'DESIGN' })).rows.map(x => x.fdTicketId)).toEqual([602])
    expect((await insights({ ...period, category: 'ORDER_STATUS' })).rows).toEqual([])
  })
  it('csv has exactly the filtered rows and escapes commas and quotes', async () => {
    const r = await insights({ ...period, stage: 'FACTORY' })
    const csv = insightsCsv(r.rows)
    const lines = csv.trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(csv.charCodeAt(0)).toBe(0xfeff)
    expect(lines[0]).toContain('ticket,order,stage')
    expect(lines[1]).toContain('"File ""duyệt"", in sai, lỗi xưởng"')
  })
  it('GET /api/cs/insights returns csv when asked', async () => {
    const res = await getInsights(new NextRequest(`http://localhost/api/cs/insights?from=${period.from.toISOString()}&to=${period.to.toISOString()}&format=csv`))
    expect(res.headers.get('content-type')).toContain('text/csv')
    expect((await res.text()).split('\n')).toHaveLength(6)
  })
  it('PATCH root-cause stores the override and who set it', async () => {
    const t = await prisma.csTicket.findUnique({ where: { fdTicketId: 601 } })
    const req = new NextRequest(`http://localhost/api/cs/tickets/${t!.id}/root-cause`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: `${AUTH_COOKIE}=${token}` }, body: JSON.stringify({ stage: 'FULFILLMENT', note: 'gửi nhầm file' }) })
    const res = await patchRootCause(req, { params: { id: t!.id } })
    expect(res.status).toBe(200)
    const after = await prisma.csTicket.findUnique({ where: { id: t!.id } })
    expect(after!.rootCauseStageOverride).toBe('FULFILLMENT')
    expect(after!.rootCauseById).toBe(userId)
    const bad = await patchRootCause(new NextRequest(`http://localhost/x`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: `${AUTH_COOKIE}=${token}` }, body: JSON.stringify({ stage: 'NOPE' }) }), { params: { id: t!.id } })
    expect(bad.status).toBe(400)
  })
})
