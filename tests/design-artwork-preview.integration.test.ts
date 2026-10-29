import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { AUTH_COOKIE, signToken } from '@/lib/auth'
import { saveArtwork, localArtworkPath } from '@/lib/design-storage'
import { PUT as putPreview } from '@/app/api/design-studio/artwork/[artworkId]/preview/route'
import { GET as getFile } from '@/app/api/design-studio/file/[artworkId]/route'
import { artSources, driveImageUrl } from '@/app/design-studio/components/model'
import type { ArtworkRow } from '@/app/design-studio/components/types'

const ORDER_ID = 'gid://test/Order/dap-1'
const SHOP = 'dap.myshopify.com'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dap-storage-'))
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)])

let lineId = ''
let token = ''

async function put(artworkId: string, body: Buffer, auth = true) {
  const req = new NextRequest(`http://x/api/design-studio/artwork/${artworkId}/preview`, { method: 'PUT', body: new Uint8Array(body), headers: { 'content-type': 'image/jpeg' } })
  if (auth) req.cookies.set(AUTH_COOKIE, token)
  return putPreview(req, { params: { artworkId } })
}

async function get(artworkId: string, query = '') {
  const req = new NextRequest(`http://x/api/design-studio/file/${artworkId}${query}`)
  return getFile(req, { params: { artworkId } })
}

beforeAll(async () => {
  process.env.AUTH_SECRET = 'test-secret-that-is-long-enough-32chars'
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: 'proj_dap' }, create: { id: 'proj_dap', name: 'DAP', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dap' }, update: {} })).id
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_dap', storeId, shopifyOrderNumber: '#DAP1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [{ shopifyLineId: 'dap-l1', linePosition: 1, sku: 'DAP-1', productTitle: 'Tee', qty: 1, unitPrice: 1, customized: true }] },
    },
  })
  lineId = (await prisma.orderLine.findFirstOrThrow({ where: { orderId: ORDER_ID } })).id
  const user = await prisma.appUser.upsert({
    where: { email: 'designer@dap.test' },
    create: { email: 'designer@dap.test', name: 'DAP Designer', role: 'SUPPORT', permissions: JSON.stringify(['design_tasks']) }, update: {},
  })
  token = await signToken({ userId: user.id, email: user.email, name: user.name, role: 'SUPPORT', permissions: ['design_tasks'] })
})

afterAll(async () => {
  await prisma.designArtwork.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.appUser.deleteMany({ where: { email: 'designer@dap.test' } })
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('artwork preview', () => {
  it('a small picture request never streams the original when there is nothing small', async () => {
    const art = await saveArtwork({ lineId, printArea: 'Front', fileName: 'front.png', mimeType: 'image/png', bytes: Buffer.from('png-bytes'), uploadedById: null })
    const res = await get(art.id, '?thumb=1')
    expect(res.status).toBe(404)
    const full = await get(art.id)
    expect(full.status).toBe(200)
    expect(await full.text()).toBe('png-bytes')
  })

  it('the browser stores a JPEG preview; the file route then serves it for ?preview=1', async () => {
    const art = await saveArtwork({ lineId, printArea: 'Back', fileName: 'back.png', mimeType: 'image/png', bytes: Buffer.from('big'), uploadedById: null })
    expect((await put(art.id, JPEG, false)).status).toBe(401)
    expect((await put(art.id, Buffer.from('not a jpeg'))).status).toBe(400)
    const ok = await put(art.id, JPEG)
    expect(ok.status).toBe(200)
    expect(await ok.json()).toEqual({ previewUrl: `/api/design-studio/file/${art.id}?preview=1` })
    const row = await prisma.designArtwork.findUniqueOrThrow({ where: { id: art.id } })
    expect(row.previewPath).toBe(`design/_previews/${art.id}.jpg`)
    expect(fs.readFileSync(localArtworkPath(row.previewPath)!)).toEqual(JPEG)
    const res = await get(art.id, '?preview=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/jpeg')
    expect(Buffer.from(await res.arrayBuffer())).toEqual(JPEG)
    expect((await put('nope', JPEG)).status).toBe(404)
  })
})

describe('artSources', () => {
  const base: ArtworkRow = {
    id: 'a1', kind: 'PRINT', printArea: 'Front', version: 1, fileName: 'f.png', size: 5e6, mimeType: 'image/png', uploadedById: null,
    createdAt: '2026-10-29T00:00:00Z', url: '/api/design-studio/file/a1', widthPx: 4200, heightPx: 4800,
    storage: 'DRIVE', driveWebViewLink: 'https://drive.google.com/file/d/abc_-1/view', driveFileId: 'abc_-1', source: 'MANUAL', previewUrl: '/api/design-studio/file/a1?thumb=1',
  }
  it('a shared Drive image under 40 MB comes resized from Google first, the server thumbnail next, the original only on request', () => {
    expect(driveImageUrl(base, 2000)).toBe('https://lh3.googleusercontent.com/d/abc_-1=s2000')
    expect(artSources(base, 2000)).toEqual(['https://lh3.googleusercontent.com/d/abc_-1=s2000', '/api/design-studio/file/a1?thumb=1'])
    expect(artSources(base, 2000, true).at(-1)).toBe('/api/design-studio/file/a1')
  })
  it('over 40 MB Google makes no copy: an uploaded preview leads, else only the original', () => {
    const big = { ...base, size: 60e6 }
    expect(driveImageUrl(big, 2000)).toBeNull()
    expect(artSources({ ...big, previewUrl: '/api/design-studio/file/a1?preview=1' }, 2000)).toEqual(['/api/design-studio/file/a1?preview=1'])
    expect(artSources(big, 480)).toEqual([])
    expect(artSources(big, 2000, true)).toEqual(['/api/design-studio/file/a1'])
    expect(artSources({ ...big, storage: 'LOCAL' }, 480)).toEqual(['/api/design-studio/file/a1?thumb=1'])
  })
  it('non-image files and files still on the server have no Google copy', () => {
    expect(artSources({ ...base, mimeType: 'application/pdf', previewUrl: null }, 2000, true)).toEqual([])
    expect(driveImageUrl({ ...base, storage: 'LOCAL' }, 2000)).toBeNull()
    expect(driveImageUrl({ ...base, driveFileId: 'bad/id' }, 2000)).toBeNull()
  })
})
