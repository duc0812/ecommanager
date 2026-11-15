import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { generateWorkerToken, revokeWorkerToken } from '@/lib/artwork-worker'
import { DELIVERY_SWITCH_KEY } from '@/lib/delivery/guard'
import { GOOGLE_KEYS } from '@/lib/google-oauth'
import { primeAccessToken, resetDriveCache } from '@/lib/google-drive'
import { POST as postToken } from '@/app/api/design-studio/worker/delivery/drive-token/route'
import { PUT as putPreview } from '@/app/api/design-studio/worker/delivery/artworks/[id]/preview/route'

const ORDER_ID = 'gid://test/Order/dtp-1'
const SHOP = 'dtp.myshopify.com'
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dtp-storage-'))
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 1)])
const KEYS = Object.values(GOOGLE_KEYS)
let token = ''
let oldStorage: string | undefined

const tokenReq = (auth = true) =>
  postToken(new NextRequest('http://localhost/api/design-studio/worker/delivery/drive-token', { method: 'POST', headers: auth ? { authorization: `Bearer ${token}` } : {} }))

const put = (id: string, body: Buffer, auth = true, headers: Record<string, string> = {}) =>
  putPreview(
    new NextRequest(`http://localhost/api/design-studio/worker/delivery/artworks/${id}/preview`, {
      method: 'PUT',
      body: new Uint8Array(body),
      headers: { 'content-type': 'image/jpeg', ...(auth ? { authorization: `Bearer ${token}` } : {}), ...headers },
    }),
    { params: { id } },
  )

async function art(id: string, data: Record<string, unknown> = {}) {
  return prisma.designArtwork.create({
    data: { id, orderId: ORDER_ID, shopifyLineId: 'dtp-l1', printArea: 'Front', version: 1, fileName: 'a.png', size: 1, mimeType: 'image/png', source: 'AUTO', ...data },
  })
}

beforeAll(async () => {
  oldStorage = process.env.DESIGN_STORAGE_DIR
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: 'proj_dtp' }, create: { id: 'proj_dtp', name: 'DTP', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_dtp' }, update: {} })).id
  await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_dtp', storeId, shopifyOrderNumber: '#DTP1', financialStatus: 'PAID', currency: 'USD',
      grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      pipelineStatus: 'PENDING_DESIGN', orderType: 'CUSTOM',
      lines: { create: [{ shopifyLineId: 'dtp-l1', linePosition: 1, sku: 'DTP-1', productTitle: 'Tee', qty: 1, unitPrice: 1, customized: true }] },
    },
  })
  token = await generateWorkerToken()
  await prisma.appSetting.upsert({ where: { key: DELIVERY_SWITCH_KEY }, update: { value: 'true' }, create: { key: DELIVERY_SWITCH_KEY, value: 'true' } })
})

beforeEach(async () => {
  await prisma.designArtwork.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.appSetting.deleteMany({ where: { key: { in: KEYS } } })
  resetDriveCache()
})

afterAll(async () => {
  await prisma.designArtwork.deleteMany({ where: { orderId: ORDER_ID } })
  await prisma.order.deleteMany({ where: { id: ORDER_ID } })
  await prisma.appSetting.deleteMany({ where: { key: { in: [...KEYS, DELIVERY_SWITCH_KEY] } } })
  await revokeWorkerToken()
  if (oldStorage === undefined) delete process.env.DESIGN_STORAGE_DIR
  else process.env.DESIGN_STORAGE_DIR = oldStorage
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('POST delivery drive-token', () => {
  it('401 without a token', async () => {
    expect((await tokenReq(false)).status).toBe(401)
  })

  it('503 drive_not_connected when Drive is not connected', async () => {
    const res = await tokenReq()
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: 'Google Drive chưa kết nối', code: 'drive_not_connected' })
  })

  it('returns the cached access token and an ISO expiry', async () => {
    await prisma.appSetting.createMany({
      data: [
        { key: GOOGLE_KEYS.clientId, value: 'cid' },
        { key: GOOGLE_KEYS.clientSecret, value: 'sec' },
        { key: GOOGLE_KEYS.refreshToken, value: '1//refresh' },
      ],
    })
    primeAccessToken('at-primed', 3600, '1//refresh')
    const res = await tokenReq()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accessToken).toBe('at-primed')
    expect(new Date(body.expiresAt).toISOString()).toBe(body.expiresAt)
  })
})

describe('PUT delivery artwork preview', () => {
  it('401 without a token', async () => {
    await art('dtp-a0')
    expect((await put('dtp-a0', JPEG, false)).status).toBe(401)
  })

  it('saves a JPEG and returns the previewPath', async () => {
    await art('dtp-a1')
    const res = await put('dtp-a1', JPEG)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.ok).toBe(true)
    expect(body.previewPath).toBe('design/_previews/dtp-a1.jpg')
    expect(fs.existsSync(path.join(tmp, body.previewPath))).toBe(true)
    expect((await prisma.designArtwork.findUniqueOrThrow({ where: { id: 'dtp-a1' } })).previewPath).toBe(body.previewPath)
  })

  it('400 not_jpeg for a non-JPEG body', async () => {
    await art('dtp-a2')
    const res = await put('dtp-a2', Buffer.from('PNGDATA-not-jpeg'))
    expect(res.status).toBe(400)
    expect((await res.json()).code).toBe('not_jpeg')
  })

  it('413 too_large over 4 MB, by body and by content-length', async () => {
    await art('dtp-a3')
    const big = Buffer.concat([JPEG, Buffer.alloc(4 * 1024 * 1024)])
    const res = await put('dtp-a3', big)
    expect(res.status).toBe(413)
    expect((await res.json()).code).toBe('too_large')
    const res2 = await put('dtp-a3', JPEG, true, { 'content-length': String(5 * 1024 * 1024) })
    expect(res2.status).toBe(413)
  })

  it('404 not_found for an unknown id', async () => {
    const res = await put('dtp-missing', JPEG)
    expect(res.status).toBe(404)
    expect((await res.json()).code).toBe('not_found')
  })

  it('409 not_auto for a removed or non-AUTO artwork', async () => {
    await art('dtp-a4', { removedAt: new Date() })
    await art('dtp-a5', { source: 'MANUAL', version: 2 })
    for (const id of ['dtp-a4', 'dtp-a5']) {
      const res = await put(id, JPEG)
      expect(res.status).toBe(409)
      expect((await res.json()).code).toBe('not_auto')
    }
  })
})
