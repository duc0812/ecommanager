import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import type { AuthUser } from '@/lib/api-auth'
import { canAccess, DEFAULT_ROLE_PERMISSIONS, homePathFor } from '@/lib/roles'
import { canCallApi } from '@/lib/api-access'
import { actOutsource, assignOutsource, assertOutsourceUpload, driveTemplateLinks, loadOutsource, revokeOutsource, visibleOutsource } from '@/lib/design-outsource'
import { withOutsourceReviewLock } from '@/lib/design-outsource-lock'
import { artworkTargetForTask, saveArtwork, saveArtworkFromTemp } from '@/lib/design-storage'
import { reopenLineForFix, syncDesignTasks, transitionTask } from '@/lib/design-tasks'
import { GET as list } from '@/app/api/design-studio/outsource/route'
import { GET as detail, POST as action } from '@/app/api/design-studio/outsource/[code]/route'
import { GET as manage } from '@/app/api/design-studio/outsource/manage/route'
import { PUT as upload } from '@/app/api/design-studio/outsource/[code]/artwork/route'
import { GET as download } from '@/app/api/design-studio/outsource/[code]/files/[fileId]/route'

vi.mock('@/lib/drive-push-queue', () => ({ enqueueDrivePush: vi.fn() }))
const prefix = 'outsource_it'
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4X8AAAAASUVORK5CYII=', 'base64')
const orderIds: string[] = []
const templateIds: string[] = []
const userIds: string[] = []
const root = path.resolve('storage', `${prefix}-${Date.now()}`)
const previousStorage = process.env.DESIGN_STORAGE_DIR
let storeId: string
let admin: AuthUser
let one: AuthUser
let two: AuthUser
let designer: AuthUser
let counter = 0

async function user(name: string, role: AuthUser['role'], permissions = DEFAULT_ROLE_PERMISSIONS[role]): Promise<AuthUser> {
  const u = await prisma.appUser.create({ data: { name, email: `${name}@${prefix}.test`, role, permissions: JSON.stringify(permissions) } })
  userIds.push(u.id)
  return { ...u, role, permissions }
}
async function req(url: string, who: AuthUser | null, init?: ConstructorParameters<typeof NextRequest>[1]) {
  const r = new NextRequest(`http://localhost${url}`, init)
  if (who) r.cookies.set(AUTH_COOKIE, await signToken({ userId: who.id, name: who.name, email: who.email, role: who.role, permissions: who.permissions, tv: 0 }))
  return r
}
async function fixture() {
  const n = ++counter
  const template = await prisma.printTemplate.create({ data: { supplierId: prefix, supplierSku: `OSP${n}`, name: 'Private Supplier Template', widthPx: 1, heightPx: 1, dpi: 150, areas: JSON.stringify([{ name: 'Front', x: 0, y: 0, w: 1, h: 1 }, { name: 'Back', x: 0, y: 0, w: 1, h: 1 }]), templateUrl: 'https://drive.google.com/file/d/template123/view' } })
  templateIds.push(template.id)
  const id = `gid://private/Order/${prefix}-${n}`
  orderIds.push(id)
  const order = await prisma.order.create({ data: { id, projectId: prefix, storeId, shopifyOrderNumber: `#SECRET${n}`, financialStatus: 'PAID', currency: 'USD', grossAmount: 100, expectedPayout: 100, totalFees: 0, refundedAmount: 0, placedAt: new Date(), pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM', customerEmail: 'private-customer@shop.test', lines: { create: { shopifyLineId: 'private-line', sku: 'SECRET-SKU', productTitle: 'Secret product listing', qty: 1, linePosition: 1, unitPrice: 100, resolvedSupplierId: prefix, resolvedSupplierSku: `OSP${n}`, customized: true, customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Alex' }, { key: 'Internal note', value: 'Private note' }]) } } }, include: { lines: true } })
  const task = await prisma.designTask.create({ data: { orderId: id, shopifyLineId: 'private-line', taskKey: `SECRET${n}_1`, status: 'NEW', readiness: 'MANUAL', slaHours: 24, dueAt: new Date(Date.now() + 3600_000), events: { create: { type: 'NOTE', message: 'Private internal event with store details' } } } })
  const input = { action: 'assign', assigneeId: one.id, brief: 'Làm mẫu theo template. Giữ chữ rõ nét.', templateLabel: 'Template hai mặt', templateUrl: template.templateUrl, shareConfirmed: true, fieldIndexes: [0] }
  return { task, template, line: order.lines[0], input }
}
async function assigned() {
  const f = await fixture()
  const a = await assignOutsource(f.task.taskKey, admin, f.input)
  return { ...f, ...a }
}
async function post(code: string, who: AuthUser, revision: number, name: string, extra = {}) {
  return action(await req(`/api/design-studio/outsource/${code}`, who, { method: 'POST', body: JSON.stringify({ action: name, revision, ...extra }) }), { params: { code } })
}
async function put(code: string, who: AuthUser, revision: number, part: string) {
  return upload(await req(`/api/design-studio/outsource/${code}/artwork?fileName=${part}.png&printArea=${part}&revision=${revision}`, who, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: png }), { params: { code } })
}
beforeAll(async () => {
  process.env.AUTH_SECRET = 'outsource-isolated-test-secret-for-signing'
  process.env.DESIGN_STORAGE_DIR = root
  await prisma.project.create({ data: { id: prefix, name: 'Secret store project', startDate: new Date() } })
  storeId = (await prisma.shopifyStore.create({ data: { shop: `${prefix}.myshopify.com`, projectId: prefix } })).id
  await prisma.supplier.create({ data: { id: prefix, code: prefix, name: 'Secret supplier' } })
  admin = await user('os-admin', 'ADMIN')
  one = await user('os-one', 'OUTSOURCE')
  two = await user('os-two', 'OUTSOURCE')
  designer = await user('os-designer', 'SUPPORT', ['design_tasks'])
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } })
  await prisma.printTemplate.deleteMany({ where: { id: { in: templateIds } } })
  await prisma.supplier.delete({ where: { id: prefix } })
  await prisma.shopifyStore.delete({ where: { id: storeId } })
  await prisma.project.delete({ where: { id: prefix } })
  await prisma.appUser.deleteMany({ where: { id: { in: userIds } } })
  if (root.startsWith(path.resolve('storage') + path.sep) && path.basename(root).startsWith(prefix)) fs.rmSync(root, { recursive: true, force: true })
  if (previousStorage === undefined) delete process.env.DESIGN_STORAGE_DIR
  else process.env.DESIGN_STORAGE_DIR = previousStorage
})

describe('outsource access and private data', () => {
  it('limits the outsource role even when broader permissions are granted', () => {
    const all = DEFAULT_ROLE_PERMISSIONS.SUPERADMIN
    expect(homePathFor('OUTSOURCE', all)).toBe('/design-studio/outsource')
    expect(canAccess('OUTSOURCE', '/design-studio/outsource', all)).toBe(true)
    expect(canAccess('OUTSOURCE', '/design-studio', all)).toBe(false)
    expect(canAccess('OUTSOURCE', '/fulfillment/orders', all)).toBe(false)
    for (const route of ['/api/design-studio/tasks', '/api/design-studio/file/secret', '/api/projects', '/api/design-studio/worker/claim', '/api/design-studio/outsource/manage', '/api/design-studio/outsource-fake']) expect(canCallApi('OUTSOURCE', all, route, 'GET')).toBe('forbidden')
    expect(canCallApi('OUTSOURCE', all, '/api/design-studio/outsource/OUT-123', 'GET')).toBe('ok')
  })
  it('canonicalizes Drive file and folder URLs and rejects unsafe links', () => {
    expect(driveTemplateLinks('https://drive.google.com/open?id=abc_123').download).toBe('https://drive.google.com/uc?export=download&id=abc_123')
    expect(driveTemplateLinks('https://drive.google.com/drive/u/0/folders/abc').view).toBe('https://drive.google.com/drive/folders/abc')
    for (const url of ['http://drive.google.com/file/d/a/view', 'https://drive.google.com.evil.test/file/d/a/view', 'https://u:p@drive.google.com/file/d/a/view', 'https://drive.google.com/not-a-file', 'javascript:alert(1)']) expect(() => driveTemplateLinks(url)).toThrow()
  })
  it('requires a session and blocks management by outsiders or ordinary designers', async () => {
    expect((await list(await req('/api/design-studio/outsource', null))).status).toBe(401)
    for (const who of [one, designer]) expect((await manage(await req('/api/design-studio/outsource/manage?taskKey=x', who))).status).toBe(403)
  })
  it('requires a sharing check and keeps assignment data out of the outsource API', async () => {
    const f = await fixture()
    await prisma.orderLine.update({ where: { id: f.line.id }, data: { variantOptions: JSON.stringify({ Size: 'L', Color: 'Navy', Product: 'Private listing option' }) } })
    await expect(assignOutsource(f.task.taskKey, admin, { ...f.input, shareConfirmed: false })).rejects.toThrow('Xác nhận')
    const a = await assignOutsource(f.task.taskKey, admin, f.input)
    const response = await detail(await req(`/api/design-studio/outsource/${a.code}`, one), { params: { code: a.code } })
    expect(response.status).toBe(200)
    const data = await response.json()
    expect(data.personalization).toEqual([{ key: 'Name', value: 'Alex' }])
    expect(data.technicalOptions).toEqual([{ key: 'Size', value: 'L' }, { key: 'Color', value: 'Navy' }])
    const serialized = JSON.stringify(data)
    expect(serialized).not.toContain('Private listing option')
    for (const secret of ['Secret product', 'SECRET-SKU', 'SECRET1', 'myshopify', 'private-customer', 'Private internal event', 'Private note', 'Secret supplier', 'Private Supplier Template', 'gid://', 'internalTaskKey', 'orderId', 'assigneeId']) expect(serialized).not.toContain(secret)
    const listing = await (await list(await req('/api/design-studio/outsource', two))).json()
    expect(listing.tasks.map((t: any) => t.code)).not.toContain(a.code)
    expect((await detail(await req(`/api/design-studio/outsource/${a.code}`, two), { params: { code: a.code } })).status).toBe(404)
  })
})

describe('outsource lifecycle and file ownership', () => {
  it('submits complete print slots, locks review, receives feedback and finishes in the original task', async () => {
    const f = await assigned()
    expect((await put(f.code, one, f.revision, 'Front')).status).toBe(409)
    expect((await post(f.code, one, f.revision, 'start')).status).toBe(200)
    expect((await post(f.code, one, f.revision, 'submit')).status).toBe(400)
    expect((await put(f.code, two, f.revision, 'Front')).status).toBe(404)
    expect((await put(f.code, one, f.revision, 'Front')).status).toBe(200)
    expect((await post(f.code, one, f.revision, 'submit')).status).toBe(400)
    expect((await put(f.code, one, f.revision, 'Back')).status).toBe(200)
    expect((await post(f.code, one, f.revision, 'submit')).status).toBe(200)
    expect((await put(f.code, one, f.revision, 'Front')).status).toBe(409)
    expect((await post(f.code, one, f.revision, 'approve')).status).toBe(409)
    await expect(transitionTask(f.task.taskKey, designer, { to: 'DONE' })).rejects.toThrow('quản lý')
    await transitionTask(f.task.taskKey, admin, { to: 'REJECTED', reasons: ['Sai vị trí chữ'], note: 'Dịch tên xuống 10 px.' })
    const returned = await prisma.designTask.findUniqueOrThrow({ where: { id: f.task.id }, include: { outsource: true } })
    expect(returned).toMatchObject({ status: 'REJECTED', assigneeId: null, rejectNote: 'Dịch tên xuống 10 px.', outsource: { active: false } })
    expect((await put(f.code, one, f.revision, 'Front')).status).toBe(404)
    expect((await post(f.code, one, f.revision, 'submit')).status).toBe(404)
    const next = await assignOutsource(f.task.taskKey, admin, { ...f.input, assigneeId: two.id, revision: returned.outsource!.revision })
    expect((await loadOutsource(f.code, two)).artworks).toEqual([])
    expect((await post(f.code, two, next.revision, 'start')).status).toBe(200)
    expect((await post(f.code, two, next.revision, 'submit')).status).toBe(400)
    await put(f.code, two, next.revision, 'Front')
    await put(f.code, two, next.revision, 'Back')
    expect((await post(f.code, two, next.revision, 'submit')).status).toBe(200)
    await transitionTask(f.task.taskKey, admin, { to: 'DONE' })
    expect((await loadOutsource(f.code, two)).status).toBe('DONE')
    expect((await prisma.designTask.findUniqueOrThrow({ where: { id: f.task.id } })).status).toBe('DONE')
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: f.line.id } })).designDriveLink).toBeTruthy()
    await revokeOutsource(f.task.taskKey, admin, next.revision)
    expect((await prisma.designTask.findUniqueOrThrow({ where: { id: f.task.id } })).status).toBe('DONE')
    expect((await prisma.orderLine.findUniqueOrThrow({ where: { id: f.line.id } })).designDriveLink).toBeTruthy()
  })
  it.each(['supplier', 'sync'])('releases the previous worker on a %s return after approval', async via => {
    const f = await assigned()
    await prisma.designTask.update({ where: { id: f.task.id }, data: { status: 'DONE' } })
    if (via === 'supplier') {
      await prisma.orderLine.update({ where: { id: f.line.id }, data: { exportedAt: new Date(), exportedToSupplierId: prefix } })
      await reopenLineForFix(f.line.id, admin, { reason: 'Xưởng yêu cầu update design', note: 'Sửa mặt trước' })
    } else {
      await prisma.order.update({ where: { id: f.task.orderId }, data: { pipelineStatus: 'DESIGN_REJECTED' } })
      await syncDesignTasks(f.task.orderId)
    }
    const task = await prisma.designTask.findUniqueOrThrow({ where: { id: f.task.id }, include: { outsource: true } })
    expect(task).toMatchObject({ status: 'REJECTED', assigneeId: null, outsource: { active: false } })
    expect((await post(f.code, one, f.revision, 'start')).status).toBe(404)
    expect(await prisma.designAgentJob.count({ where: { taskId: task.id } })).toBe(0)
  })
  it('protects downloads and prevents using a file ID from another task', async () => {
    const f = await assigned()
    await actOutsource(f.code, one, { action: 'start', revision: f.revision })
    await put(f.code, one, f.revision, 'Front')
    const fileId = (await loadOutsource(f.code, one)).artworks[0].id
    const get = (who: AuthUser, code = f.code) => req(`/api/design-studio/outsource/${code}/files/${fileId}`, who).then(r => download(r, { params: { code, fileId } }))
    expect((await get(two)).status).toBe(404)
    const other = await assigned()
    expect((await get(one, other.code)).status).toBe(404)
    const response = await get(one)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png)
    expect(response.headers.get('location')).toBeNull()
    expect(response.headers.get('cache-control')).toContain('no-store')
    expect(response.headers.get('content-disposition')).not.toContain('SECRET')
    await revokeOutsource(f.task.taskKey, admin, f.revision)
    expect((await get(one)).status).toBe(404)
  })
  it('rejects a slow upload finalized after revocation and separates reassigned revisions', async () => {
    const f = await assigned()
    await actOutsource(f.code, one, { action: 'start', revision: f.revision })
    const a = await visibleOutsource(f.code, one)
    const target = await artworkTargetForTask(f.task.taskKey)
    if (typeof target === 'string') throw new Error(target)
    fs.mkdirSync(root, { recursive: true })
    const tmpPath = path.join(root, 'slow-upload.part')
    fs.writeFileSync(tmpPath, png)
    await revokeOutsource(f.task.taskKey, admin, f.revision)
    await expect(saveArtworkFromTemp({ target, printArea: 'Front', fileName: 'slow.png', mimeType: 'image/png', uploadedById: one.id, temp: { tmpPath, size: png.length }, outsource: { id: a.id, revision: a.revision, templateVersion: a.templateVersion, validate: tx => assertOutsourceUpload(tx, a.id, a.revision, one.id, a.templateVersion) } })).rejects.toThrow('thay đổi')
    expect(await prisma.designArtwork.count({ where: { outsourceId: a.id } })).toBe(0)
    const current = await prisma.designOutsource.findUniqueOrThrow({ where: { id: a.id } })
    const next = await assignOutsource(f.task.taskKey, admin, { ...f.input, assigneeId: two.id, revision: current.revision })
    expect(next.code).toBe(f.code)
    expect(next.revision).toBeGreaterThan(f.revision)
    expect((await post(f.code, one, f.revision, 'start')).status).toBe(404)
    expect((await post(f.code, two, f.revision, 'start')).status).toBe(409)
    expect((await post(f.code, two, next.revision, 'start')).status).toBe(200)
  })
  it('requires updated template confirmation and new files after a template change', async () => {
    const f = await assigned()
    await actOutsource(f.code, one, { action: 'start', revision: f.revision })
    await put(f.code, one, f.revision, 'Front'); await put(f.code, one, f.revision, 'Back')
    await prisma.printTemplate.update({ where: { id: f.template.id }, data: { dpi: 300 } })
    expect((await loadOutsource(f.code, one)).templateChanged).toBe(true)
    expect((await post(f.code, one, f.revision, 'submit')).status).toBe(409)
    expect((await put(f.code, one, f.revision, 'Front')).status).toBe(409)
    await assignOutsource(f.task.taskKey, admin, { ...f.input, action: 'refresh', revision: f.revision })
    expect((await loadOutsource(f.code, one)).templateConfirmed).toBe(false)
    expect((await post(f.code, one, f.revision, 'confirm-template')).status).toBe(200)
    expect((await post(f.code, one, f.revision, 'submit')).status).toBe(400)
    await put(f.code, one, f.revision, 'Front'); await put(f.code, one, f.revision, 'Back')
    expect((await post(f.code, one, f.revision, 'submit')).status).toBe(200)
  })
  it('keeps customer questions in the internal conversation and resumes the previous state', async () => {
    const f = await assigned()
    await actOutsource(f.code, one, { action: 'start', revision: f.revision })
    await actOutsource(f.code, one, { action: 'ask', revision: f.revision, message: 'Xác nhận font giúp mình.' })
    expect((await loadOutsource(f.code, one)).status).toBe('ASK_CUSTOMER')
    await actOutsource(f.code, admin, { action: 'message', revision: f.revision, message: 'Dùng font trong gói template.' })
    await actOutsource(f.code, one, { action: 'resume', revision: f.revision })
    expect((await loadOutsource(f.code, one)).status).toBe('DOING')
  })
  it('prevents review, withdrawal and revoke from crossing one another', async () => {
    const f = await assigned()
    await withOutsourceReviewLock(f.task.id, async () => {
      await expect(revokeOutsource(f.task.taskKey, admin, f.revision)).rejects.toThrow('đang duyệt')
      await expect(actOutsource(f.code, one, { action: 'start', revision: f.revision })).rejects.toThrow('đang duyệt')
    })
    expect((await post(f.code, one, f.revision, 'start')).status).toBe(200)
  })
  it('does not let sync close an assigned outsource task or internal uploads replace it', async () => {
    const f = await assigned()
    await prisma.orderLine.update({ where: { id: f.line.id }, data: { designDriveLink: 'https://drive.google.com/file/d/external/view' } })
    await syncDesignTasks(f.task.orderId)
    expect((await loadOutsource(f.code, one)).status).toBe('ASSIGNED')
    await expect(saveArtwork({ lineId: f.line.id, printArea: 'Front', fileName: 'internal.png', mimeType: 'image/png', bytes: png, uploadedById: admin.id })).rejects.toThrow('outsource')
    expect(await prisma.designArtwork.count({ where: { orderId: f.task.orderId } })).toBe(0)
  })
})
