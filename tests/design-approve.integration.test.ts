import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { DEFAULT_DESIGN_SETTINGS, getDesignSettings, saveDesignSettings } from '@/lib/design-settings'
import { APPROVE_MESSAGE, loadTask, syncDesignTasks, transitionTask, viewerFor, type Actor } from '@/lib/design-tasks'
import { canApproveDesign, canHandoffToSupplier } from '@/lib/roles'
import { GET as getTasks } from '@/app/api/design-studio/tasks/route'
import { GET as getTask } from '@/app/api/design-studio/tasks/[key]/route'
import { POST as postTransition } from '@/app/api/design-studio/tasks/[key]/transition/route'
import { GET as getSettings, PUT as putSettings } from '@/app/api/design-studio/settings/route'

const SHOP = 'dap.myshopify.com'
const PROJECT = 'proj_dap'
const SUP = 'sup_dap'
const PRINT = JSON.stringify([{ print_area: 'PRINT', url: 'https://cdn.example/dap.png' }])
const EMAILS = ['lead@dap.test', 'des@dap.test', 'cs@dap.test', 'super@dap.test']

let storeId = ''
let seq = 0
let LEAD: Actor
let DES: Actor
let CS: Actor
let desToken = ''
let csToken = ''
let superToken = ''

async function makeTask(status: 'NEW' | 'ASSIGNED' | 'DOING' | 'REVIEW', source: 'MANUAL' | 'AUTO' = 'MANUAL') {
  seq++
  const id = `gid://test/Order/dap-${seq}`
  const number = `#DAP${seq}`
  await prisma.order.create({
    data: {
      id, projectId: PROJECT, storeId, shopifyOrderNumber: number, financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [{
        shopifyLineId: `dap-l${seq}`, sku: 'DAP', productTitle: 'Tumbler', qty: 1, linePosition: 1, unitPrice: 1,
        resolvedSupplierId: SUP, customized: true,
        customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Ann' }, { key: '_print_files', value: PRINT }]),
      }] },
    },
  })
  await prisma.designArtwork.create({
    data: { orderId: id, shopifyLineId: `dap-l${seq}`, printArea: 'PRINT', version: 1, fileName: 'a.png', storagePath: 'x/a.png', size: 1, mimeType: 'image/png', source },
  })
  await syncDesignTasks(id)
  const key = `DAP${seq}_1`
  await prisma.designTask.update({ where: { taskKey: key }, data: { status, assigneeId: status === 'NEW' ? null : DES.id } })
  return { id, key }
}

async function setDesignerCanApprove(on: boolean) {
  await saveDesignSettings({ ...DEFAULT_DESIGN_SETTINGS, designerCanApprove: on })
}

function cookieReq(url: string, token: string | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const req = new NextRequest(url, init)
  if (token) req.cookies.set(AUTH_COOKIE, token)
  return req
}

const transition = (key: string, token: string, body: unknown) =>
  postTransition(cookieReq(`http://x/api/design-studio/tasks/${key}/transition`, token, { method: 'POST', body: JSON.stringify(body) }), { params: { key } })

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  await prisma.project.upsert({ where: { id: PROJECT }, create: { id: PROJECT, name: 'DAP', startDate: new Date('2026-06-01') }, update: {} })
  storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: PROJECT }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DAPSUP' }, create: { id: SUP, name: 'DAP Supplier', code: 'DAPSUP' }, update: {} })
  const user = async (email: string, name: string, role: string, permissions: string[]) =>
    (await prisma.appUser.upsert({ where: { email }, create: { name, email, role, permissions: JSON.stringify(permissions) }, update: {} })).id
  const leadId = await user('lead@dap.test', 'Lead', 'ADMIN', ['design_tasks'])
  const desId = await user('des@dap.test', 'Des', 'SUPPORT', ['design_tasks'])
  const csId = await user('cs@dap.test', 'Cs', 'SUPPORT', ['fulfillment_orders'])
  const superId = await user('super@dap.test', 'Super', 'SUPERADMIN', [])
  LEAD = { id: leadId, name: 'Lead', role: 'ADMIN', permissions: ['design_tasks'] }
  DES = { id: desId, name: 'Des', role: 'SUPPORT', permissions: ['design_tasks'] }
  CS = { id: csId, name: 'Cs', role: 'SUPPORT', permissions: ['fulfillment_orders'] }
  desToken = await signToken({ userId: desId, email: 'des@dap.test', name: 'Des', role: 'SUPPORT', permissions: ['design_tasks'], tv: 0 })
  csToken = await signToken({ userId: csId, email: 'cs@dap.test', name: 'Cs', role: 'SUPPORT', permissions: ['fulfillment_orders'], tv: 0 })
  superToken = await signToken({ userId: superId, email: 'super@dap.test', name: 'Super', role: 'SUPERADMIN', permissions: [], tv: 0 })
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { projectId: PROJECT } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
})

beforeEach(async () => {
  await prisma.appSetting.deleteMany({ where: { key: 'design.settings' } })
})

describe('designerCanApprove setting', () => {
  it('defaults to on, also for settings saved before the key existed', async () => {
    expect((await getDesignSettings()).designerCanApprove).toBe(true)
    await prisma.appSetting.create({ data: { key: 'design.settings', value: JSON.stringify({ slaCustomHours: 12 }) } })
    const s = await getDesignSettings()
    expect(s.slaCustomHours).toBe(12)
    expect(s.designerCanApprove).toBe(true)
  })

  it('capability helpers: leader always, design_tasks holder only while on, handoff by fulfillment_export', () => {
    expect(canApproveDesign('ADMIN', [], false)).toBe(true)
    expect(canApproveDesign('SUPERADMIN', [], false)).toBe(true)
    expect(canApproveDesign('SUPPORT', ['design_tasks'], true)).toBe(true)
    expect(canApproveDesign('SUPPORT', ['design_tasks'], false)).toBe(false)
    expect(canApproveDesign('SUPPORT', ['fulfillment_orders'], true)).toBe(false)
    expect(canApproveDesign('SELLER', [], true)).toBe(false)
    expect(canHandoffToSupplier('ADMIN', [])).toBe(true)
    expect(canHandoffToSupplier('SUPPORT', ['design_tasks'])).toBe(false)
    expect(canHandoffToSupplier('SUPPORT', ['design_tasks', 'fulfillment_export'])).toBe(true)
    expect(viewerFor(DES, { designerCanApprove: true })).toMatchObject({ isLeader: false, canApprove: true, canHandoff: false })
    expect(viewerFor(DES, { designerCanApprove: false })).toMatchObject({ isLeader: false, canApprove: false, canHandoff: false })
  })

  it('PUT saves the toggle, keeps it when the field is absent, and rejects a non-boolean', async () => {
    const base = { slaCustomHours: 24, slaNonCustomHours: 48, kpiByType: { default: 0.3 }, rejectReasons: ['Sai chính tả'] }
    const put = (body: unknown, token = superToken) =>
      putSettings(cookieReq('http://x/api/design-studio/settings', token, { method: 'PUT', body: JSON.stringify(body) }))
    expect((await put({ ...base, designerCanApprove: false }, desToken)).status).toBe(403)
    const off = await put({ ...base, designerCanApprove: false })
    expect(off.status).toBe(200)
    expect((await off.json()).designerCanApprove).toBe(false)
    const kept = await put(base)
    expect((await kept.json()).designerCanApprove).toBe(false)
    expect((await put({ ...base, designerCanApprove: 'yes' })).status).toBe(400)
    const read = await (await getSettings(cookieReq('http://x/api/design-studio/settings', desToken))).json()
    expect(read.designerCanApprove).toBe(false)
    expect((await (await put({ ...base, designerCanApprove: true })).json()).designerCanApprove).toBe(true)
  })
})

describe('designer approval while the setting is on (default)', () => {
  it('a design_tasks holder approves a REVIEW task; the order becomes ready and the event names the approver', async () => {
    const t = await makeTask('REVIEW')
    const r = await transitionTask(t.key, DES, { to: 'DONE' })
    expect(r.task.status).toBe('DONE')
    expect(r.order).toMatchObject({ designReady: true, pipelineStatus: 'READY_TO_PRODUCTION' })
    const order = await prisma.order.findUniqueOrThrow({ where: { id: t.id } })
    expect(order.supplierHandoffAt).toBeNull()
    expect(order.exportedAt).toBeNull()
    const row = await prisma.designTaskEvent.findFirstOrThrow({ where: { task: { taskKey: t.key }, type: 'STATUS' }, orderBy: { createdAt: 'desc' } })
    expect(row.message).toBe(`${APPROVE_MESSAGE} (designer)`)
    expect(row.actorId).toBe(DES.id)
    const shown = (await loadTask(t.key))!.events.at(-1)!
    expect(shown).toMatchObject({ type: 'STATUS', actorName: 'Des' })
  })

  it('a leader approval is logged as "Duyệt design" with the leader as actor', async () => {
    const t = await makeTask('REVIEW')
    await transitionTask(t.key, LEAD, { to: 'DONE' })
    const row = await prisma.designTaskEvent.findFirstOrThrow({ where: { task: { taskKey: t.key }, type: 'STATUS' }, orderBy: { createdAt: 'desc' } })
    expect(row).toMatchObject({ message: 'Duyệt design', actorId: LEAD.id })
  })

  it('auto-rendered files no longer need a leader', async () => {
    const t = await makeTask('REVIEW', 'AUTO')
    expect((await transitionTask(t.key, DES, { to: 'DONE' })).task.status).toBe('DONE')
  })

  it('a designer returns a REVIEW task with reasons', async () => {
    const t = await makeTask('REVIEW')
    const r = await transitionTask(t.key, DES, { to: 'REJECTED', reasons: ['Thiếu nét'], note: 'vỡ hình' })
    expect(r.task).toMatchObject({ status: 'REJECTED', rejectReasons: ['Thiếu nét'], rejectNote: 'vỡ hình' })
    const row = await prisma.designTaskEvent.findFirstOrThrow({ where: { task: { taskKey: t.key }, type: 'REJECT' } })
    expect(row.actorId).toBe(DES.id)
  })

  it('a user without design_tasks cannot approve or return', async () => {
    const t = await makeTask('REVIEW')
    await expect(transitionTask(t.key, CS, { to: 'DONE' })).rejects.toThrow(/không được phép/)
    await expect(transitionTask(t.key, CS, { to: 'REJECTED', reasons: ['x'] })).rejects.toThrow(/không được phép/)
    expect((await transition(t.key, csToken, { to: 'DONE' })).status).toBe(400)
    expect((await loadTask(t.key))!.task.status).toBe('REVIEW')
  })

  it.each(['NEW', 'ASSIGNED', 'DOING'] as const)('nobody goes straight to DONE from %s', async (status) => {
    const t = await makeTask(status)
    await expect(transitionTask(t.key, DES, { to: 'DONE' })).rejects.toThrow(/không được phép/)
    await expect(transitionTask(t.key, LEAD, { to: 'DONE' })).rejects.toThrow(/không được phép/)
    expect((await transition(t.key, desToken, { to: 'DONE' })).status).toBe(400)
    const after = (await loadTask(t.key))!
    expect(after.task.status).toBe(status)
    expect((await prisma.order.findUniqueOrThrow({ where: { id: t.id } })).pipelineStatus).toBe('PENDING_DESIGN')
  })

  it('the route approves with the designer session and reports canApprove to the page', async () => {
    const t = await makeTask('REVIEW')
    const res = await transition(t.key, desToken, { to: 'DONE' })
    expect(res.status).toBe(200)
    expect((await res.json()).task.status).toBe('DONE')
    const list = await (await getTasks(cookieReq('http://x/api/design-studio/tasks?statuses=DONE', desToken))).json()
    expect(list.me).toEqual({ id: DES.id, name: 'Des', role: 'SUPPORT', isLeader: false, canApprove: true, canHandoff: false })
    const detail = await (await getTask(cookieReq(`http://x/api/design-studio/tasks/${t.key}`, csToken), { params: { key: t.key } })).json()
    expect(detail.me).toMatchObject({ canApprove: false, canHandoff: false })
  })
})

describe('designer approval while the setting is off', () => {
  it('only a leader approves or returns; the designer gets a clear refusal', async () => {
    await setDesignerCanApprove(false)
    const t = await makeTask('REVIEW')
    await expect(transitionTask(t.key, DES, { to: 'DONE' })).rejects.toThrow(/không được phép.*chỉ leader/)
    await expect(transitionTask(t.key, DES, { to: 'REJECTED', reasons: ['x'] })).rejects.toThrow(/không được phép/)
    const res = await transition(t.key, desToken, { to: 'DONE' })
    expect(res.status).toBe(400)
    expect((await loadTask(t.key))!.task.status).toBe('REVIEW')
    const list = await (await getTasks(cookieReq('http://x/api/design-studio/tasks?statuses=REVIEW', desToken))).json()
    expect(list.me).toMatchObject({ isLeader: false, canApprove: false })
    expect((await transitionTask(t.key, LEAD, { to: 'DONE' })).task.status).toBe('DONE')
  })

  it('the designer still submits for review', async () => {
    await setDesignerCanApprove(false)
    const t = await makeTask('DOING')
    expect((await transitionTask(t.key, DES, { to: 'REVIEW' })).task.status).toBe('REVIEW')
  })
})
