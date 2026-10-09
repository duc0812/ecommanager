import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { saveArtwork, localArtworkPath } from '@/lib/design-storage'
import { loadWorkspace, updateLine, artworkUrl } from '@/lib/design-studio'
import { loadTask, syncDesignTasks, transitionTask } from '@/lib/design-tasks'
import { DELETE as deleteArtwork } from '@/app/api/design-studio/artwork/[artworkId]/route'
import { POST as pushArtwork } from '@/app/api/design-studio/artwork/[artworkId]/push/route'

const ORDER_ID = 'gid://test/Order/dar-1'
const SHOP = 'dar.myshopify.com'
const SUP = 'sup_dar'
const EMAILS = ['admin@dar.test', 'designer@dar.test', 'other@dar.test']
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dar-storage-'))

let lineId = ''
let lineId2 = ''
let adminId = '', designerId = '', otherId = ''
let adminToken = '', designerToken = '', otherToken = ''

async function del(artworkId: string, token: string | null) {
  const req = new NextRequest(`http://x/api/design-studio/artwork/${artworkId}`, { method: 'DELETE' })
  if (token) req.cookies.set(AUTH_COOKIE, token)
  return deleteArtwork(req, { params: { artworkId } })
}

function save(line: string, printArea: string, uploadedById: string | null, name = 'art.png') {
  return saveArtwork({ lineId: line, printArea, fileName: name, mimeType: 'image/png', bytes: Buffer.from(`${printArea}-${Math.random()}`), uploadedById })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: 'proj_dar' }, create: { id: 'proj_dar', name: 'DAR', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dar' }, update: {} })).id
  await prisma.supplier.upsert({ where: { code: 'DARSUP' }, create: { id: SUP, name: 'DAR Supplier', code: 'DARSUP' }, update: {} })
  const order = await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_dar', storeId, shopifyOrderNumber: '#DAR1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [
        { shopifyLineId: 'a1', sku: 'TUMB', productTitle: 'Tumbler', qty: 1, linePosition: 1, unitPrice: 1, resolvedSupplierId: SUP, customized: true,
          customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Ann' }]) },
        { shopifyLineId: 'a2', sku: 'TUMB', productTitle: 'Tumbler', qty: 1, linePosition: 2, unitPrice: 1, resolvedSupplierId: SUP, customized: true,
          customAttributesJson: JSON.stringify([{ key: 'Name', value: 'Bob' }]) },
      ] },
    },
    include: { lines: { orderBy: { linePosition: 'asc' } } },
  })
  lineId = order.lines[0].id
  lineId2 = order.lines[1].id
  adminId = (await prisma.appUser.upsert({ where: { email: EMAILS[0] }, create: { name: 'Admin', email: EMAILS[0], role: 'ADMIN' }, update: {} })).id
  designerId = (await prisma.appUser.upsert({ where: { email: EMAILS[1] }, create: { name: 'Designer', email: EMAILS[1], role: 'SUPPORT' }, update: {} })).id
  otherId = (await prisma.appUser.upsert({ where: { email: EMAILS[2] }, create: { name: 'Other', email: EMAILS[2], role: 'SUPPORT' }, update: {} })).id
  adminToken = await signToken({ userId: adminId, email: EMAILS[0], name: 'Admin', role: 'ADMIN', permissions: [], tv: 0 })
  designerToken = await signToken({ userId: designerId, email: EMAILS[1], name: 'Designer', role: 'SUPPORT', permissions: [], tv: 0 })
  otherToken = await signToken({ userId: otherId, email: EMAILS[2], name: 'Other', role: 'SUPPORT', permissions: [], tv: 0 })
  await syncDesignTasks(ORDER_ID)
})

afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.supplier.deleteMany({ where: { id: SUP } })
  await prisma.appUser.deleteMany({ where: { email: { in: EMAILS } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('DELETE /api/design-studio/artwork/[artworkId]', () => {
  it('401 without a session', async () => {
    const art = await save(lineId, 'Artwork', designerId)
    expect((await del(art.id, null)).status).toBe(401)
    await prisma.designArtwork.delete({ where: { id: art.id } })
  })

  it('lets the uploader soft-delete: the row and the file stay, the workspace and task no longer show it', async () => {
    const art = await save(lineId, 'Artwork', designerId)
    const res = await del(art.id, designerToken)
    expect(res.status).toBe(200)
    expect((await res.json()).removed).toMatchObject({ id: art.id, printArea: 'Artwork', version: art.version })

    const row = await prisma.designArtwork.findUniqueOrThrow({ where: { id: art.id } })
    expect(row.removedAt).not.toBeNull()
    expect(row.removedById).toBe(designerId)
    expect(fs.existsSync(localArtworkPath(row.storagePath)!)).toBe(true)

    const ws = await loadWorkspace(ORDER_ID)
    expect(ws!.lines[0].artworks.map(a => a.id)).not.toContain(art.id)
    const task = await loadTask('DAR1_1')
    expect(task!.line.artworks.map(a => a.id)).not.toContain(art.id)
    expect(task!.events.some(e => e.type === 'ARTWORK' && e.message.includes(`v${art.version}`) && e.actorName === 'Designer')).toBe(true)
  })

  it('404 when the artwork is already removed or unknown', async () => {
    const art = await save(lineId, 'Artwork', designerId)
    expect((await del(art.id, designerToken)).status).toBe(200)
    expect((await del(art.id, designerToken)).status).toBe(404)
    expect((await del('nope', adminToken)).status).toBe(404)
  })

  it('403 for a non-admin who did not upload it, including legacy rows with no uploader', async () => {
    const mine = await save(lineId, 'Artwork', designerId)
    expect((await del(mine.id, otherToken)).status).toBe(403)
    const legacy = await save(lineId, 'Artwork', null)
    expect((await del(legacy.id, designerToken)).status).toBe(403)
    expect((await prisma.designArtwork.findUniqueOrThrow({ where: { id: mine.id } })).removedAt).toBeNull()
  })

  it('lets an admin remove anyone\'s artwork', async () => {
    const art = await save(lineId, 'Artwork', designerId)
    expect((await del(art.id, adminToken)).status).toBe(200)
    expect((await prisma.designArtwork.findUniqueOrThrow({ where: { id: art.id } })).removedById).toBe(adminId)
  })

  it('never reuses a removed version number', async () => {
    const a = await save(lineId2, 'Front', designerId)
    const b = await save(lineId2, 'Front', designerId)
    expect(b.version).toBe(a.version + 1)
    expect((await del(b.id, designerToken)).status).toBe(200)
    const c = await save(lineId2, 'Front', designerId)
    expect(c.version).toBe(b.version + 1)
  })

  it('done picks the newest artwork that is not removed', async () => {
    const keep = await save(lineId2, 'Back', designerId)
    const drop = await save(lineId2, 'Back', designerId)
    expect((await del(drop.id, designerToken)).status).toBe(200)
    const r = await updateLine(lineId2, { done: true, requiredAreas: ['Back'] })
    expect(r!.line.designDriveLink).toBe(artworkUrl(keep.id))
    await updateLine(lineId2, { done: false })
  })

  it('409 when the artwork is the line\'s current design link', async () => {
    const art = await save(lineId2, 'Side', designerId)
    await prisma.orderLine.update({ where: { id: lineId2 }, data: { designDriveLink: artworkUrl(art.id) } })
    try {
      expect((await del(art.id, adminToken)).status).toBe(409)
    } finally {
      await prisma.orderLine.update({ where: { id: lineId2 }, data: { designDriveLink: null } })
    }
  })

  it('409 once the task is DONE', async () => {
    const art = await save(lineId2, 'Top', designerId)
    await prisma.designTask.update({ where: { taskKey: 'DAR1_2' }, data: { status: 'DONE' } })
    try {
      const res = await del(art.id, adminToken)
      expect(res.status).toBe(409)
      expect((await res.json()).error).toMatch(/Sửa & gửi lại/)
    } finally {
      await prisma.designTask.update({ where: { taskKey: 'DAR1_2' }, data: { status: 'NEW' } })
    }
  })

  it('a removed artwork no longer fills its slot for Gửi duyệt', async () => {
    await prisma.designArtwork.updateMany({ where: { orderId: ORDER_ID, shopifyLineId: 'a1', removedAt: null }, data: { removedAt: new Date() } })
    const art = await save(lineId, 'Artwork', designerId)
    await transitionTask('DAR1_1', { id: designerId, name: 'Designer', role: 'SUPPORT' }, { to: 'DOING' })
    expect((await del(art.id, designerToken)).status).toBe(200)
    await expect(transitionTask('DAR1_1', { id: designerId, name: 'Designer', role: 'SUPPORT' }, { to: 'REVIEW' })).rejects.toThrow(/Chưa có artwork cho: Artwork/)
  })

  it('the Drive push route refuses a removed artwork', async () => {
    const art = await save(lineId, 'Artwork', designerId)
    expect((await del(art.id, designerToken)).status).toBe(200)
    const res = await pushArtwork(new NextRequest(`http://x/api/design-studio/artwork/${art.id}/push`, { method: 'POST' }), { params: { artworkId: art.id } })
    expect(res.status).toBe(404)
  })
})
