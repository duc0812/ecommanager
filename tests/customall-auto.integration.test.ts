import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { NextRequest } from 'next/server'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { generateWorkerToken } from '@/lib/artwork-worker'
import { syncDesignTasks } from '@/lib/design-tasks'
import { drainDrivePushes } from '@/lib/drive-push-queue'
import { POST as queueRoute } from '@/app/api/design-studio/tasks/[key]/auto-render/route'
import { POST as claimRoute } from '@/app/api/design-studio/worker/claim/route'
import { POST as resultRoute } from '@/app/api/design-studio/worker/jobs/[id]/result/route'

const ID = 'customall-auto-regression'
const PRODUCT = 'gid://test/Product/customall-auto'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'customall-auto-'))
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.from('fixture-print')])
let admin = '', worker = '', entryId = '', seq = 0

function request(url: string, method: string, body?: BodyInit, workerAuth = false) {
  const req = new NextRequest(url, { method, ...(body ? { body } : {}), ...(workerAuth ? { headers: { Authorization: `Bearer ${worker}` } } : {}) })
  if (!workerAuth) req.cookies.set(AUTH_COOKIE, admin)
  return req
}

async function createLine(customall: { key: string; value: string }[], size = 'XL', extraAttrs: { key: string; value: string }[] = []) {
  const id = `${ID}-${++seq}`
  await prisma.order.create({ data: {
    id, projectId: ID, storeId: ID, shopifyOrderNumber: `#CAT${seq}`, financialStatus: 'PAID', currency: 'USD',
    grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-11-09'), pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
    lines: { create: [{ shopifyLineId: 'line', linePosition: 1, sku: `SWTEST-${size}`, variantTitle: size, variantOptions: JSON.stringify({ Size: size }), productTitle: 'Jersey', qty: 1, unitPrice: 1,
      shopifyProductId: PRODUCT, resolvedSupplierId: ID, resolvedSupplierSku: `TBEJ-${size}`, customized: true,
      customAttributesJson: JSON.stringify([{ key: '_print_files', value: JSON.stringify([{ print_area: 'PRINT', url: 'https://example.com/reference.png' }]) }, ...extraAttrs]), customallFieldsJson: JSON.stringify(customall) }] },
  } })
  await syncDesignTasks(id)
  return prisma.designTask.findFirstOrThrow({ where: { orderId: id } })
}

async function queue(taskKey: string) {
  return queueRoute(request('http://localhost/queue', 'POST'), { params: { key: taskKey } })
}

async function claim() {
  const r = await claimRoute(request('http://localhost/claim', 'POST', JSON.stringify({ kinds: ['RENDER_LINE'] }), true))
  return r.json()
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-customall-auto-render-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.appSetting.deleteMany({ where: { key: { in: Object.values(GOOGLE_KEYS) } } })
  await prisma.artworkJob.deleteMany({ where: { status: { in: ['QUEUED', 'RUNNING'] } } })
  await prisma.project.create({ data: { id: ID, name: ID, startDate: new Date('2026-01-01') } })
  await prisma.shopifyStore.create({ data: { id: ID, shop: `${ID}.myshopify.com`, projectId: ID } })
  await prisma.supplier.create({ data: { id: ID, name: ID, code: ID } })
  await prisma.printTemplate.create({ data: { id: ID, supplierId: ID, name: 'Jersey', supplierSku: 'TBEJ', widthPx: 1, heightPx: 1, dpi: 150, areas: JSON.stringify([{ name: 'Print', x: 0, y: 0, w: 1, h: 1 }]) } })
  await prisma.productProfile.create({ data: { storeId: ID, shopifyProductId: PRODUCT, title: 'Jersey', printTemplateId: ID } })
  const art = await prisma.libraryFile.create({ data: { kind: 'ARTWORK', fileName: 'artwork.png', mimeType: 'image/png', size: PNG.length, sha256: ID, storagePath: `${ID}/artwork.png` } })
  entryId = (await prisma.artworkEntry.create({ data: { storeId: ID, shopifyProductId: PRODUCT, printTemplateId: ID, supplierId: ID, title: 'Jersey', status: 'READY', artworkFileId: art.id,
    fields: JSON.stringify([{ field: 'Custom name', layer: '@Custom name', sample: 'NAME', font: 'FixtureFont', sizePx: 1, color: '#d7a658', align: 'center', box: { x: 0, y: 0, w: 1, h: 1 }, anchor: 'center', fit: 'shrink' }]) } })).id
  const user = await prisma.appUser.create({ data: { name: 'Test Admin', email: `${ID}@test.local`, role: 'SUPERADMIN', permissions: '[]' } })
  admin = await signToken({ userId: user.id, email: user.email, name: user.name, role: 'SUPERADMIN', permissions: [], tv: 0 })
  worker = await generateWorkerToken()
})

afterAll(async () => {
  await drainDrivePushes()
  await prisma.order.deleteMany({ where: { storeId: ID } })
  await prisma.artworkEntry.deleteMany({ where: { storeId: ID } })
  await prisma.libraryFile.deleteMany({ where: { sha256: ID } })
  await prisma.productProfile.deleteMany({ where: { storeId: ID } })
  await prisma.printTemplate.deleteMany({ where: { id: ID } })
  await prisma.supplier.deleteMany({ where: { id: ID } })
  await prisma.shopifyStore.deleteMany({ where: { id: ID } })
  await prisma.project.deleteMany({ where: { id: ID } })
  await prisma.appUser.deleteMany({ where: { email: `${ID}@test.local` } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('Customall auto render with a server READY entry', () => {
  it.each(['S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL'])('labels a future %s line AUTO despite personaliser print metadata', async size => {
    const task = await createLine([{ key: 'Custom Name Yes Or No', value: 'Yes' }, { key: 'Custom name', value: 'JANE' }], size)
    expect(task.readiness).toBe('AUTO')
  })

  it('carries a Customall-only name from the database into the worker claim', async () => {
    const task = await createLine([{ key: 'Custom Name Yes Or No', value: 'Yes' }, { key: 'Custom name', value: 'JANE' }])
    expect((await queue(task.taskKey)).status).toBe(200)
    const c = await claim()
    expect(c.target.taskKey).toBe(task.taskKey)
    expect(c.values).toEqual({ 'Custom name': 'JANE' })
    expect(c.noName).toBe(false)
    await prisma.artworkJob.delete({ where: { id: c.job.id } })
  })

  it('No selects the no-name master, while Yes without a name stays blocked', async () => {
    const no = await createLine([{ key: 'Custom Name Yes Or No', value: 'No' }])
    expect(no.readiness).toBe('AUTO')
    expect((await queue(no.taskKey)).status).toBe(200)
    const c = await claim()
    expect(c.noName).toBe(true)
    expect(c.values).toEqual({})
    await prisma.artworkJob.delete({ where: { id: c.job.id } })
    const empty = await createLine([{ key: 'Custom Name Yes Or No', value: 'Yes' }])
    expect(empty.readiness).toBe('LOW')
    expect((await queue(empty.taskKey)).status).toBe(409)
  })

  it('keeps an entered name when a stray No is also present', async () => {
    const task = await createLine([{ key: 'Custom Name Yes Or No', value: 'No' }, { key: 'Custom name', value: 'JANE' }])
    expect((await queue(task.taskKey)).status).toBe(200)
    const c = await claim()
    expect(c.noName).toBe(false)
    expect(c.values).toEqual({ 'Custom name': 'JANE' })
    await prisma.artworkJob.delete({ where: { id: c.job.id } })
  })

  it('accepts the expected current-worker piece and rejects a wrong slot', async () => {
    const task = await createLine([{ key: 'Custom name', value: 'JANE' }])
    expect((await queue(task.taskKey)).status).toBe(200)
    const c = await claim()
    async function result(area: string) {
      const fd = new FormData()
      fd.append(`piece.${area}`, new Blob([new Uint8Array(PNG)], { type: 'image/png' }), `piece.${area}.png`)
      fd.append('result', new Blob([JSON.stringify({ warnings: [] })], { type: 'application/json' }), 'result.json')
      return resultRoute(request('http://localhost/result', 'POST', fd, true), { params: { id: c.job.id } })
    }
    expect((await result('BACK')).status).toBe(400)
    expect((await result('Print')).status).toBe(200)
    expect((await prisma.artworkJob.findUniqueOrThrow({ where: { id: c.job.id } })).status).toBe('DONE')
    const print = await prisma.designArtwork.findFirstOrThrow({ where: { orderId: task.orderId, kind: 'PRINT' } })
    expect(print.source).toBe('AUTO')
    expect(print.printArea).toBe('Print')
    expect((await prisma.designTask.findUniqueOrThrow({ where: { id: task.id } })).status).toBe('REVIEW')
  })
})
