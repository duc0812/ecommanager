import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GET as getReview } from '@/app/api/design-studio/tasks/review/route'
import { DEFAULT_DESIGN_SETTINGS, saveDesignSettings } from '@/lib/design-settings'
import { AUTO_REVIEW_MESSAGE, canTransition, listReviewCards, submitAutoRenderForReview, syncDesignTasks, transitionTask, type Actor } from '@/lib/design-tasks'

const SHOP = 'dtar.myshopify.com'
const SUP = 'sup_dtar'
const ORDER_ID = 'gid://test/Order/dtar-1'
const TWO_AREAS = JSON.stringify([{ print_area: 'FRONT', url: 'https://cdn.example/f.png' }, { print_area: 'BACK', url: 'https://cdn.example/b.png' }])
const ONE_AREA = JSON.stringify([{ print_area: 'PRINT', url: 'https://cdn.example/p.png' }])

let LEAD: Actor
let DES: Actor
let artworkVersion = 0

function line(id: string, position: number, printFiles: string) {
  return {
    shopifyLineId: id, sku: `S${position}`, productTitle: 'Tumbler', variantTitle: '20oz', qty: 1, linePosition: position, unitPrice: 1,
    resolvedSupplierId: SUP, customized: true,
    customAttributesJson: JSON.stringify([{ key: 'Custom Name', value: 'Marie-Pier' }, { key: '_print_files', value: printFiles }]),
  }
}

async function art(shopifyLineId: string, printArea: string, source = 'AUTO') {
  await prisma.designArtwork.create({ data: {
    orderId: ORDER_ID, shopifyLineId, printArea, version: ++artworkVersion, fileName: `${printArea}.png`, storagePath: `x/${printArea}.png`,
    size: 1, mimeType: 'image/png', source,
  } })
}

const task = (key: string) => prisma.designTask.findUniqueOrThrow({ where: { taskKey: key }, include: { events: true } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: 'proj_dtar' }, create: { id: 'proj_dtar', name: 'DTAR', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dtar' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DTAR' }, create: { id: SUP, name: 'DTAR Supplier', code: 'DTAR' }, update: {} })
  await prisma.order.create({ data: {
    id: ORDER_ID, projectId: 'proj_dtar', storeId, shopifyOrderNumber: '#DTAR1', financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
    pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
    lines: { create: [line('a1', 1, TWO_AREAS), line('a2', 2, ONE_AREA), line('a3', 3, ONE_AREA), line('a4', 4, ONE_AREA)] },
  } })
  const leadId = (await prisma.appUser.upsert({ where: { email: 'lead@dtar.test' }, create: { name: 'Lead', email: 'lead@dtar.test', role: 'ADMIN' }, update: {} })).id
  const desId = (await prisma.appUser.upsert({ where: { email: 'des@dtar.test' }, create: { name: 'Des', email: 'des@dtar.test', role: 'SUPPORT' }, update: {} })).id
  LEAD = { id: leadId, name: 'Lead', role: 'ADMIN' }
  DES = { id: desId, name: 'Des', role: 'SUPPORT' }
  await syncDesignTasks(ORDER_ID)
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['lead@dtar.test', 'des@dtar.test'] } } })
})

describe('submitAutoRenderForReview', () => {
  it('waits until every print area has a file, then moves NEW → REVIEW as AUTO with one event', async () => {
    await art('a1', 'FRONT')
    expect(await submitAutoRenderForReview(ORDER_ID, 'a1')).toEqual({ moved: false, reason: 'Chưa có artwork cho: BACK' })
    expect((await task('DTAR1_1')).status).toBe('NEW')

    await art('a1', 'BACK')
    expect(await submitAutoRenderForReview(ORDER_ID, 'a1')).toEqual({ moved: true, reason: null })
    const t = await task('DTAR1_1')
    expect(t.status).toBe('REVIEW')
    expect(t.readiness).toBe('AUTO')
    expect(t.events.filter(e => e.message === AUTO_REVIEW_MESSAGE)).toEqual([expect.objectContaining({ type: 'SYSTEM', actorId: null })])

    expect((await submitAutoRenderForReview(ORDER_ID, 'a1')).moved).toBe(false)
    expect((await task('DTAR1_1')).events.filter(e => e.message === AUTO_REVIEW_MESSAGE)).toHaveLength(1)
  })

  it('a removed artwork does not count', async () => {
    await art('a2', 'PRINT')
    await prisma.designArtwork.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 'a2' }, data: { removedAt: new Date() } })
    expect((await submitAutoRenderForReview(ORDER_ID, 'a2')).moved).toBe(false)
    expect((await task('DTAR1_2')).status).toBe('NEW')
  })

  it('moves ASSIGNED, DOING and REJECTED; leaves ASK_CUSTOMER, DONE and CANCELLED alone', async () => {
    await art('a3', 'PRINT')
    for (const status of ['ASK_CUSTOMER', 'DONE', 'CANCELLED']) {
      await prisma.designTask.update({ where: { taskKey: 'DTAR1_3' }, data: { status } })
      expect((await submitAutoRenderForReview(ORDER_ID, 'a3')).moved).toBe(false)
      expect((await task('DTAR1_3')).status).toBe(status)
    }
    for (const status of ['ASSIGNED', 'DOING', 'REJECTED']) {
      await prisma.designTask.update({ where: { taskKey: 'DTAR1_3' }, data: { status } })
      expect((await submitAutoRenderForReview(ORDER_ID, 'a3')).moved).toBe(true)
      expect((await task('DTAR1_3')).status).toBe('REVIEW')
    }
  })

  it('people still cannot jump NEW → REVIEW', () => {
    expect(canTransition('NEW', 'REVIEW', 'DESIGNER')).toBe(false)
    expect(canTransition('ASSIGNED', 'REVIEW', 'LEADER')).toBe(false)
  })
})

describe('approving an auto render', () => {
  it('with "designer được duyệt" off a designer cannot approve a REVIEW task, a leader can', async () => {
    await saveDesignSettings({ ...DEFAULT_DESIGN_SETTINGS, designerCanApprove: false })
    await expect(transitionTask('DTAR1_1', DES, { to: 'DONE' })).rejects.toThrow(/không được phép/)
    const r = await transitionTask('DTAR1_1', LEAD, { to: 'DONE' })
    await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
    expect(r.task.status).toBe('DONE')
    expect((await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID, shopifyLineId: 'a1' } })).designDriveLink).toMatch(/^\/api\/design-studio\/file\//)
  })

  it('a designer cannot shortcut an AUTO-ready task with an auto file to DONE from DOING', async () => {
    await art('a4', 'PRINT')
    await prisma.designTask.update({ where: { taskKey: 'DTAR1_4' }, data: { status: 'DOING', readiness: 'AUTO', assigneeId: DES.id } })
    await expect(transitionTask('DTAR1_4', DES, { to: 'DONE' })).rejects.toThrow(/không được phép/)
    expect((await transitionTask('DTAR1_4', DES, { to: 'REVIEW' })).task.status).toBe('REVIEW')
  })

  it('a designer cannot finish an AUTO-ready task even when every file is manual', async () => {
    await prisma.designArtwork.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 'a2' }, data: { removedAt: null, source: 'MANUAL' } })
    await prisma.designTask.update({ where: { taskKey: 'DTAR1_2' }, data: { status: 'DOING', readiness: 'AUTO', assigneeId: DES.id } })
    await expect(transitionTask('DTAR1_2', DES, { to: 'DONE' })).rejects.toThrow(/không được phép/)
    await prisma.designTask.update({ where: { taskKey: 'DTAR1_2' }, data: { status: 'DONE' } })
  })
})

describe('listReviewCards', () => {
  it('returns REVIEW tasks with their files, slots and customer values', async () => {
    const cards = await listReviewCards()
    const mine = cards.filter(c => c.task.orderId === ORDER_ID)
    expect(mine.map(c => c.task.taskKey).sort()).toEqual(['DTAR1_3', 'DTAR1_4'])
    const c = mine.find(x => x.task.taskKey === 'DTAR1_4')!
    expect(c.slots).toEqual(['PRINT'])
    expect(c.task.variantTitle).toBe('20oz')
    expect(c.line.artworks.map(a => ({ printArea: a.printArea, source: a.source }))).toEqual([{ printArea: 'PRINT', source: 'AUTO' }])
    expect(c.line.personalization).toEqual([{ key: 'Custom Name', value: 'Marie-Pier' }])
  })
})

describe('GET /api/design-studio/tasks/review', () => {
  it('needs a session and returns cards, reject reasons and the viewer role', async () => {
    expect((await getReview(new NextRequest('http://localhost/api/design-studio/tasks/review'))).status).toBe(401)
    const req = new NextRequest('http://localhost/api/design-studio/tasks/review?q=DTAR1')
    req.cookies.set(AUTH_COOKIE, await signToken({ userId: DES.id, email: 'des@dtar.test', name: 'Des', role: 'SUPPORT', permissions: ['design_tasks'], tv: 0 }))
    const body = await (await getReview(req)).json()
    expect(body.cards.map((c: any) => c.task.taskKey).sort()).toEqual(['DTAR1_3', 'DTAR1_4'])
    expect(Array.isArray(body.rejectReasons)).toBe(true)
    expect(body.me).toMatchObject({ id: DES.id, isLeader: false })
  })
})
