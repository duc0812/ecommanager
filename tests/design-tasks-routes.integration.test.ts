import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { syncDesignTasks } from '@/lib/design-tasks'
import { GET as getTasks } from '@/app/api/design-studio/tasks/route'
import { GET as getTask } from '@/app/api/design-studio/tasks/[key]/route'
import { POST as postTransition } from '@/app/api/design-studio/tasks/[key]/transition/route'
import { POST as postEvent } from '@/app/api/design-studio/tasks/[key]/events/route'
import { GET as getSync, POST as postSync } from '@/app/api/design-studio/tasks/sync/route'
import { GET as getTemplates, POST as postTemplate } from '@/app/api/design-studio/templates/route'
import { GET as getSettings, PUT as putSettings } from '@/app/api/design-studio/settings/route'
import { GET as getGuideFile } from '@/app/api/design-studio/file/guide/[templateId]/route'

const ORDER_ID = 'gid://test/Order/dtr-1'
const DONE_ORDER_ID = 'gid://test/Order/dtr-done'
const SHOP = 'dtr.myshopify.com'
const SUP = 'sup_dtr'
const PRINT_FILES = JSON.stringify([{ print_area: 'PRINT', url: 'https://cdn.example/dtr.png' }])

let adminId = ''
let supportId = ''
let superadminId = ''
let adminToken = ''
let supportToken = ''
let superadminToken = ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtr-storage-'))

async function cookieReq(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const req = new NextRequest(url, init)
  if (token) req.cookies.set(AUTH_COOKIE, token)
  return req
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp

  await prisma.project.upsert({ where: { id: 'proj_dtr' }, create: { id: 'proj_dtr', name: 'DTR', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dtr' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DTRSUP' }, create: { id: SUP, name: 'DTR Supplier', code: 'DTRSUP' }, update: {} })

  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_dtr', storeId, shopifyOrderNumber: '#DTR1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [
        { shopifyLineId: 'r1', sku: 'R1', productTitle: 'Jersey', shopifyProductType: 'Baseball Jersey', qty: 1, linePosition: 1, unitPrice: 1,
          resolvedSupplierId: SUP, customized: true,
          customAttributesJson: JSON.stringify([{ key: 'Name', value: 'X' }, { key: '_print_files', value: PRINT_FILES }]) },
      ] },
    },
  })
  await prisma.designArtwork.create({
    data: { orderId: ORDER_ID, shopifyLineId: 'r1', printArea: 'PRINT', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png' },
  })

  await prisma.order.create({
    data: {
      id: DONE_ORDER_ID, projectId: 'proj_dtr', storeId, shopifyOrderNumber: '#DTR2', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [
        { shopifyLineId: 'r2', sku: 'R2', productTitle: 'Mug', qty: 1, linePosition: 1, unitPrice: 1,
          resolvedSupplierId: SUP, customized: false },
      ] },
    },
  })

  adminId = (await prisma.appUser.upsert({ where: { email: 'admin@dtr.test' }, create: { name: 'Admin', email: 'admin@dtr.test', role: 'ADMIN' }, update: {} })).id
  supportId = (await prisma.appUser.upsert({ where: { email: 'support@dtr.test' }, create: { name: 'Support', email: 'support@dtr.test', role: 'SUPPORT' }, update: {} })).id
  superadminId = (await prisma.appUser.upsert({ where: { email: 'super@dtr.test' }, create: { name: 'Super', email: 'super@dtr.test', role: 'SUPERADMIN' }, update: {} })).id

  adminToken = await signToken({ userId: adminId, email: 'admin@dtr.test', name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  supportToken = await signToken({ userId: supportId, email: 'support@dtr.test', name: 'Support', role: 'SUPPORT', permissions: [], tv: 0 })
  superadminToken = await signToken({ userId: superadminId, email: 'super@dtr.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })

  await syncDesignTasks(ORDER_ID)
  await syncDesignTasks(DONE_ORDER_ID)
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: [ORDER_ID, DONE_ORDER_ID] } } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: ['admin@dtr.test', 'support@dtr.test', 'super@dtr.test'] } } })
  await prisma.printTemplate.deleteMany({ where: { supplierId: SUP } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('GET /api/design-studio/tasks', () => {
  it('401 without a session', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks?statuses=NEW', null)
    const res = await getTasks(req)
    expect(res.status).toBe(401)
  })

  it('returns the fixture task and the me object', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks?statuses=NEW', adminToken)
    const res = await getTasks(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tasks.map((t: any) => t.taskKey)).toContain('DTR1_1')
    expect(body.me).toEqual({ id: adminId, name: 'Admin', role: 'ADMIN', isLeader: true, canApprove: true, canHandoff: true, canEditNote: true })
  })

  it('defaults to open statuses plus DONE tasks updated today when statuses is omitted', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks', adminToken)
    const res = await getTasks(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tasks.map((t: any) => t.taskKey)).toContain('DTR1_1')
  })

  it('a search finds a task finished before today, which the default queue hides', async () => {
    const before = await prisma.designTask.findFirstOrThrow({ where: { orderId: DONE_ORDER_ID } })
    await prisma.designTask.update({ where: { id: before.id }, data: { status: 'DONE', updatedAt: new Date('2026-10-02T00:00:00Z') } })
    const keys = async (url: string) => (await (await getTasks(await cookieReq(url, adminToken))).json()).tasks.map((t: any) => t.taskKey)
    expect(await keys('http://x/api/design-studio/tasks')).not.toContain('DTR2_1')
    expect(await keys('http://x/api/design-studio/tasks?q=%23DTR2')).toEqual(['DTR2_1'])
    expect(await keys('http://x/api/design-studio/tasks?q=mug')).toContain('DTR2_1')
    expect(await keys('http://x/api/design-studio/tasks?q=DTR')).toEqual(expect.arrayContaining(['DTR1_1', 'DTR2_1']))
    await prisma.designTask.update({ where: { id: before.id }, data: { status: before.status } })
  })

  it('treats an empty statuses= as not given, falling back to the default queue', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks?statuses=', adminToken)
    const res = await getTasks(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.tasks.map((t: any) => t.taskKey)).toContain('DTR1_1')
  })

  it('mine=1 returns tasks assigned to the caller only', async () => {
    const otherId = (await prisma.appUser.upsert({ where: { email: 'mine@dtr.test' }, create: { name: 'Mine', email: 'mine@dtr.test', role: 'SUPPORT' }, update: {} })).id
    try {
      await prisma.designTask.update({ where: { taskKey: 'DTR2_1' }, data: { assigneeId: supportId } })
      const otherToken = await signToken({ userId: otherId, email: 'mine@dtr.test', name: 'Mine', role: 'SUPPORT', permissions: [], tv: 0 })
      const keysFor = async (token: string) => {
        const res = await getTasks(await cookieReq('http://x/api/design-studio/tasks?mine=1', token))
        expect(res.status).toBe(200)
        return (await res.json()).tasks.map((t: any) => t.taskKey)
      }
      expect(await keysFor(supportToken)).toContain('DTR2_1')
      expect(await keysFor(otherToken)).not.toContain('DTR2_1')
    } finally {
      await prisma.designTask.update({ where: { taskKey: 'DTR2_1' }, data: { assigneeId: null } })
      await prisma.appUser.deleteMany({ where: { email: 'mine@dtr.test' } })
    }
  })

  it('400s when every status value is invalid', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks?statuses=BOGUS', adminToken)
    const res = await getTasks(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Unknown status: BOGUS/)
  })

  it('400s when only some status values are invalid', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks?statuses=NEW,BOGUS', adminToken)
    const res = await getTasks(req)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/Unknown status: BOGUS/)
  })
})

describe('GET /api/design-studio/tasks/[key]', () => {
  it('404 for an unknown task', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/NOPE_1', adminToken)
    const res = await getTask(req, { params: { key: 'NOPE_1' } })
    expect(res.status).toBe(404)
  })

  it('returns the task detail and me', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/DTR1_1', adminToken)
    const res = await getTask(req, { params: { key: 'DTR1_1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.task.taskKey).toBe('DTR1_1')
    expect(body.me.isLeader).toBe(true)
  })
})

describe('POST /api/design-studio/tasks/[key]/transition', () => {
  it('rejects a disallowed transition with 400', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/DTR1_1/transition', supportToken, {
      method: 'POST', body: JSON.stringify({ to: 'ASSIGNED', assigneeId: supportId }),
    })
    const res = await postTransition(req, { params: { key: 'DTR1_1' } })
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(typeof body.error).toBe('string')
  })

  it('allows the leader to assign', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/DTR1_1/transition', adminToken, {
      method: 'POST', body: JSON.stringify({ to: 'ASSIGNED', assigneeId: supportId }),
    })
    const res = await postTransition(req, { params: { key: 'DTR1_1' } })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.task.status).toBe('ASSIGNED')
    expect(body.task.assigneeId).toBe(supportId)
  })

  it("400s when another designer tries to take the assignee's task", async () => {
    const otherId = (await prisma.appUser.upsert({ where: { email: 'other@dtr.test' }, create: { name: 'Other', email: 'other@dtr.test', role: 'SUPPORT' }, update: {} })).id
    try {
      const otherToken = await signToken({ userId: otherId, email: 'other@dtr.test', name: 'Other', role: 'SUPPORT', permissions: [], tv: 0 })
      const req = await cookieReq('http://x/api/design-studio/tasks/DTR1_1/transition', otherToken, {
        method: 'POST', body: JSON.stringify({ to: 'DOING' }),
      })
      const res = await postTransition(req, { params: { key: 'DTR1_1' } })
      expect(res.status).toBe(400)
      expect((await res.json()).error).toBe('Task đang thuộc về Support')
    } finally {
      await prisma.appUser.deleteMany({ where: { email: 'other@dtr.test' } })
    }
  })

  it('401 without a session', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/DTR1_1/transition', null, {
      method: 'POST', body: JSON.stringify({ to: 'DOING' }),
    })
    const res = await postTransition(req, { params: { key: 'DTR1_1' } })
    expect(res.status).toBe(401)
  })

  it('404 for an unknown task', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/NOPE_1/transition', adminToken, {
      method: 'POST', body: JSON.stringify({ to: 'DOING' }),
    })
    const res = await postTransition(req, { params: { key: 'NOPE_1' } })
    expect(res.status).toBe(404)
  })
})

describe('POST /api/design-studio/tasks/[key]/events', () => {
  it('adds a NOTE event visible in the task detail', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/DTR1_1/events', supportToken, {
      method: 'POST', body: JSON.stringify({ message: 'đang chờ ảnh gốc' }),
    })
    const res = await postEvent(req, { params: { key: 'DTR1_1' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })

    const detailReq = await cookieReq('http://x/api/design-studio/tasks/DTR1_1', adminToken)
    const detailRes = await getTask(detailReq, { params: { key: 'DTR1_1' } })
    const detail = await detailRes.json()
    expect(detail.events.some((e: any) => e.type === 'NOTE' && e.message === 'đang chờ ảnh gốc')).toBe(true)
  })

  it('400 for an empty message', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/DTR1_1/events', adminToken, {
      method: 'POST', body: JSON.stringify({ message: '' }),
    })
    const res = await postEvent(req, { params: { key: 'DTR1_1' } })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/design-studio/tasks/sync', () => {
  it('syncs a single order by id', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/sync', adminToken, {
      method: 'POST', body: JSON.stringify({ orderId: ORDER_ID }),
    })
    const res = await postSync(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ created: 0, cancelled: 0, completed: 0, reopened: 0, orders: 1 })
  })

  it('iterates every PENDING_DESIGN/DESIGN_REJECTED order when no id is given', async () => {
    const req = await cookieReq('http://x/api/design-studio/tasks/sync', adminToken, { method: 'POST', body: JSON.stringify({}) })
    const res = await postSync(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.orders).toBeGreaterThanOrEqual(2)
    expect(body.errors).toEqual([])
    expect(body.trigger).toBe('manual')
    expect(body).not.toHaveProperty('pruned')
  })

  it('the task list and GET sync report when the last sync ran', async () => {
    const list = await (await getTasks(await cookieReq('http://x/api/design-studio/tasks', adminToken))).json()
    expect(list.lastSync).toMatchObject({ trigger: 'manual', error: null })
    expect(Number.isNaN(new Date(list.lastSync.ranAt).getTime())).toBe(false)
    const got = await (await getSync(await cookieReq('http://x/api/design-studio/tasks/sync', adminToken))).json()
    expect(got.lastSync.ranAt).toBe(list.lastSync.ranAt)
    expect((await getSync(await cookieReq('http://x/api/design-studio/tasks/sync', null))).status).toBe(401)
  })

  it('also visits orders outside the design statuses that still have an open task', async () => {
    await prisma.order.update({ where: { id: DONE_ORDER_ID }, data: { pipelineStatus: 'READY_TO_PRODUCTION' } })
    await prisma.orderLine.updateMany({ where: { orderId: DONE_ORDER_ID }, data: { designDriveLink: 'https://drive.google.com/file/d/from-trello' } })
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTR2_1' } }))?.status).toBe('NEW')
    const req = await cookieReq('http://x/api/design-studio/tasks/sync', adminToken, { method: 'POST', body: JSON.stringify({}) })
    const body = await (await postSync(req)).json()
    expect(body.completed).toBeGreaterThanOrEqual(1)
    expect((await prisma.designTask.findUnique({ where: { taskKey: 'DTR2_1' } }))?.status).toBe('DONE')
  })
})

describe('GET/POST /api/design-studio/templates', () => {
  it('POST requires admin', async () => {
    const req = await cookieReq('http://x/api/design-studio/templates', supportToken, {
      method: 'POST',
      body: JSON.stringify({ supplierId: SUP, name: 'Standard', widthPx: 4500, heightPx: 5400, areas: [] }),
    })
    const res = await postTemplate(req)
    expect(res.status).toBe(403)
  })

  it('leader can upsert a template by (supplierId, supplierSku)', async () => {
    const req = await cookieReq('http://x/api/design-studio/templates', adminToken, {
      method: 'POST',
      body: JSON.stringify({ supplierId: SUP, supplierSku: 'R1', name: 'Jersey template', widthPx: 4500, heightPx: 5400, areas: [{ name: 'Front', x: 0, y: 0, w: 100, h: 100 }] }),
    })
    const res = await postTemplate(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.template.name).toBe('Jersey template')
    expect(body.template.widthPx).toBe(4500)

    const listReq = await cookieReq(`http://x/api/design-studio/templates?supplierId=${SUP}`, adminToken)
    const listRes = await getTemplates(listReq)
    const listBody = await listRes.json()
    expect(listBody.templates.some((t: any) => t.name === 'Jersey template')).toBe(true)
  })

  it('two sequential POSTs with no supplierSku update the same default template, not create a second one', async () => {
    const postDefault = (name: string) => cookieReq('http://x/api/design-studio/templates', adminToken, {
      method: 'POST',
      body: JSON.stringify({ supplierId: SUP, name, widthPx: 1000, heightPx: 1000, areas: [] }),
    }).then(postTemplate)

    const r1 = await postDefault('Default v1')
    expect(r1.status).toBe(200)
    const r2 = await postDefault('Default v2')
    expect(r2.status).toBe(200)
    const body2 = await r2.json()
    expect(body2.template.name).toBe('Default v2')

    const rows = await prisma.printTemplate.findMany({ where: { supplierId: SUP, supplierSku: null } })
    expect(rows.length).toBe(1)
    expect(rows[0].name).toBe('Default v2')
  })
})

describe('GET/PUT /api/design-studio/settings', () => {
  it('GET works for any authenticated user', async () => {
    const req = await cookieReq('http://x/api/design-studio/settings', supportToken)
    const res = await getSettings(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slaCustomHours).toBeGreaterThan(0)
  })

  it('PUT requires superadmin, not just admin', async () => {
    const req = await cookieReq('http://x/api/design-studio/settings', adminToken, {
      method: 'PUT',
      body: JSON.stringify({ slaCustomHours: 20, slaNonCustomHours: 40, kpiByType: { default: 0.3 }, rejectReasons: ['x'] }),
    })
    const res = await putSettings(req)
    expect(res.status).toBe(403)
  })

  it('400 when rejectReasons is empty', async () => {
    const req = await cookieReq('http://x/api/design-studio/settings', superadminToken, {
      method: 'PUT',
      body: JSON.stringify({ slaCustomHours: 20, slaNonCustomHours: 40, kpiByType: { default: 0.3 }, rejectReasons: [] }),
    })
    const res = await putSettings(req)
    expect(res.status).toBe(400)
  })

  it('superadmin can save valid settings', async () => {
    const req = await cookieReq('http://x/api/design-studio/settings', superadminToken, {
      method: 'PUT',
      body: JSON.stringify({ slaCustomHours: 20, slaNonCustomHours: 40, kpiByType: { default: 0.3 }, rejectReasons: ['Sai màu'] }),
    })
    const res = await putSettings(req)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.slaCustomHours).toBe(20)
  })
})

describe('GET /api/design-studio/file/guide/[templateId]', () => {
  it('404 when the template has no guide image', async () => {
    const t = await prisma.printTemplate.create({ data: { supplierId: SUP, supplierSku: 'NOGUIDE', name: 'No guide', widthPx: 100, heightPx: 100, areas: '[]' } })
    const req = await cookieReq(`http://x/api/design-studio/file/guide/${t.id}`, null)
    const res = await getGuideFile(req, { params: { templateId: t.id } })
    expect(res.status).toBe(404)
  })

  it('404 for an unknown template', async () => {
    const req = await cookieReq('http://x/api/design-studio/file/guide/nope', null)
    const res = await getGuideFile(req, { params: { templateId: 'nope' } })
    expect(res.status).toBe(404)
  })

  it('streams the guide image bytes from the storage root', async () => {
    const rel = 'guides/sample.png'
    const abs = path.join(tmp, rel)
    fs.mkdirSync(path.dirname(abs), { recursive: true })
    fs.writeFileSync(abs, 'guide-bytes')
    const t = await prisma.printTemplate.create({ data: { supplierId: SUP, supplierSku: 'GUIDED', name: 'Guided', widthPx: 100, heightPx: 100, areas: '[]', guideImagePath: rel } })
    const req = await cookieReq(`http://x/api/design-studio/file/guide/${t.id}`, null)
    const res = await getGuideFile(req, { params: { templateId: t.id } })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    const text = await res.text()
    expect(text).toBe('guide-bytes')
  })
})
