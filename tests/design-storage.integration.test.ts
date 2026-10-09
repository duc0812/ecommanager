import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { prisma } from '@/lib/db'
import { safeFileName, saveArtwork, readArtwork, storageRoot } from '@/lib/design-storage'

const ORDER_ID = 'gid://test/Order/ds-store-1'
const EVIL_ID = 'gid://test/Order/ds-store-evil'
const SHOP = 'ds-store.myshopify.com'
let lineId = ''
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds-storage-'))

beforeAll(async () => {
  process.env.DESIGN_STORAGE_DIR = tmp
  await prisma.project.upsert({ where: { id: 'proj_ds_store' }, create: { id: 'proj_ds_store', name: 'DS store', startDate: new Date('2026-06-01') }, update: {} })
  const storeId = (await prisma.shopifyStore.upsert({ where: { shop: SHOP }, create: { shop: SHOP, projectId: 'proj_ds_store' }, update: {} })).id
  const o = await prisma.order.create({
    data: {
      id: ORDER_ID, projectId: 'proj_ds_store', storeId, shopifyOrderNumber: '#DSS1', financialStatus: 'PAID',
      currency: 'USD', grossAmount: 1, expectedPayout: 1, totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
      lines: { create: [{ shopifyLineId: 's1', sku: 'S', productTitle: 'Socks', qty: 1, linePosition: 1, unitPrice: 1 }] },
    },
    include: { lines: true },
  })
  lineId = o.lines[0].id
})
afterAll(async () => {
  await prisma.order.deleteMany({ where: { id: { in: [ORDER_ID, EVIL_ID] } } })
  fs.rmSync(tmp, { recursive: true, force: true })
  delete process.env.DESIGN_STORAGE_DIR
})

describe('safeFileName', () => {
  it('strips path parts and odd characters', () => {
    expect(safeFileName('../../etc/passwd')).toBe('passwd')
    expect(safeFileName('Tên áo (final) v2.PNG')).toBe('Ten_ao_final_v2.PNG')
    expect(safeFileName('')).toBe('file')
  })
})

describe('saveArtwork / readArtwork', () => {
  it('writes v1 then v2 into the storage root and records both', async () => {
    const a1 = await saveArtwork({ lineId, printArea: 'Front', fileName: 'front.png', mimeType: 'image/png', bytes: Buffer.from('one'), uploadedById: null })
    const a2 = await saveArtwork({ lineId, printArea: 'Front', fileName: 'front.png', mimeType: 'image/png', bytes: Buffer.from('two'), uploadedById: 'u1' })
    expect(a1.version).toBe(1)
    expect(a2.version).toBe(2)
    const r2 = await readArtwork(a2.id)
    expect(r2?.absPath.startsWith(storageRoot())).toBe(true)
    expect(fs.readFileSync(r2!.absPath, 'utf8')).toBe('two')
    expect(r2?.mimeType).toBe('image/png')
  })
  it('rejects a disallowed type', async () => {
    await expect(saveArtwork({ lineId, printArea: 'Front', fileName: 'x.exe', mimeType: 'application/x-msdownload', bytes: Buffer.from('x'), uploadedById: null }))
      .rejects.toThrow(/not allowed/i)
  })
  it('returns null for an unknown id', async () => {
    expect(await readArtwork('nope')).toBeNull()
  })
  it('derives the stored mime from the extension, ignoring a spoofed client mime', async () => {
    const a = await saveArtwork({ lineId, printArea: 'Spoof', fileName: 'evil.png', mimeType: 'text/html', bytes: Buffer.from('x'), uploadedById: null })
    const r = await readArtwork(a.id)
    expect(r?.mimeType).toBe('image/png')
  })
  it('derives the stored mime from the client mime when the filename has no usable extension', async () => {
    const a = await saveArtwork({ lineId, printArea: 'NoExt', fileName: 'noext', mimeType: 'application/x-zip-compressed', bytes: Buffer.from('x'), uploadedById: null })
    const r = await readArtwork(a.id)
    expect(r?.mimeType).toBe('application/zip')
  })
  it('does not overwrite a file already on disk for the next version', async () => {
    const taken = path.join(storageRoot(), 'design', 'DSS1', '1', 'Collide', 'v1-c.png')
    fs.mkdirSync(path.dirname(taken), { recursive: true })
    fs.writeFileSync(taken, 'keep')
    const a = await saveArtwork({ lineId, printArea: 'Collide', fileName: 'c.png', mimeType: 'image/png', bytes: Buffer.from('new'), uploadedById: null })
    expect(a.version).toBe(2)
    expect(fs.readFileSync(taken, 'utf8')).toBe('keep')
    const r = await readArtwork(a.id)
    expect(fs.readFileSync(r!.absPath, 'utf8')).toBe('new')
  })
  it('keeps the written path under the storage root for hostile order numbers and areas', async () => {
    const o = await prisma.order.create({
      data: {
        id: EVIL_ID, projectId: 'proj_ds_store', storeId: (await prisma.shopifyStore.findUniqueOrThrow({ where: { shop: SHOP } })).id,
        shopifyOrderNumber: '../../../evil', financialStatus: 'PAID', currency: 'USD', grossAmount: 1, expectedPayout: 1,
        totalFees: 0, refundedAmount: 0, placedAt: new Date('2026-10-01'),
        lines: { create: [{ shopifyLineId: 'e1', sku: 'E', productTitle: 'Evil', qty: 1, linePosition: 1, unitPrice: 1 }] },
      },
      include: { lines: true },
    })
    const a = await saveArtwork({ lineId: o.lines[0].id, printArea: '../../up', fileName: '../../x.png', mimeType: 'image/png', bytes: Buffer.from('x'), uploadedById: null })
    const r = await readArtwork(a.id)
    expect(r).not.toBeNull()
    expect(path.resolve(r!.absPath).startsWith(path.resolve(storageRoot()) + path.sep)).toBe(true)
  })
})
