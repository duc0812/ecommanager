import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { prisma } from '@/lib/db'
import { driveFileViewUrl } from '@/lib/google-drive'
import { promoteFolderLink } from '@/lib/task-folder'
import { agentFixture } from './helpers/design-agent-fixture'

const fx = agentFixture('TFP')
const fileLink = (id: string) => `https://drive.google.com/file/d/${id}/view?usp=drivesdk`
const folderOf = (n: number) => `https://drive.google.com/drive/folders/tfp-folder-${n}`
let n = 0

async function lineWith(files: { printArea: string; driveFileId: string; removedAt?: Date }[], designDriveLink: string | null) {
  const o = await fx.order(++n)
  await prisma.designTask.updateMany({ where: { orderId: o.orderId }, data: { driveFolderId: `tfp-folder-${n}`, driveFolderUrl: folderOf(n) } })
  for (const f of files) {
    await prisma.designArtwork.create({ data: {
      orderId: o.orderId, shopifyLineId: 'l1', kind: 'PRINT', printArea: f.printArea, version: 1, fileName: `${f.printArea}.png`,
      storage: 'DRIVE', driveFileId: f.driveFileId, driveWebViewLink: driveFileViewUrl(f.driveFileId), drivePlace: f.removedAt ? 'OLD' : 'TASK',
      size: 1, mimeType: 'image/png', source: 'AUTO', removedAt: f.removedAt ?? null,
    } })
  }
  if (designDriveLink) {
    await prisma.orderLine.updateMany({ where: { orderId: o.orderId }, data: { designDriveLink } })
    await prisma.order.update({ where: { id: o.orderId }, data: { designDriveLink } })
  }
  return { orderId: o.orderId, folder: folderOf(n) }
}

const lineLink = async (orderId: string) => (await prisma.orderLine.findFirstOrThrow({ where: { orderId } })).designDriveLink

beforeAll(async () => {
  await fx.cleanup()
  await fx.seed()
})

afterAll(async () => {
  await fx.cleanup()
})

describe('promoteFolderLink with files shared between lines', () => {
  it('promoting the sharer\'s folder never rewrites the library or other orders\' links to the original', async () => {
    const owner = await lineWith([{ printArea: 'Front', driveFileId: 'tfp-orig' }], fileLink('tfp-orig'))
    const reuse = await lineWith([], fileLink('tfp-orig'))
    const library = await prisma.skuSupplierDesign.create({ data: { sku: 'TFP-LIB', supplierId: fx.supplierId, designLink: fileLink('tfp-orig'), ready: true } })
    const sharer = await lineWith(
      [{ printArea: 'Front', driveFileId: 'tfp-orig' }, { printArea: 'Back', driveFileId: 'tfp-own-b' }],
      `${fileLink('tfp-orig')} | ${fileLink('tfp-own-b')}`,
    )

    expect(await promoteFolderLink(sharer.orderId, 'l1')).toBe(true)

    expect((await prisma.skuSupplierDesign.findUniqueOrThrow({ where: { id: library.id } })).designLink).toBe(fileLink('tfp-orig'))
    expect(await lineLink(reuse.orderId)).toBe(fileLink('tfp-orig'))
    expect(await lineLink(owner.orderId)).toBe(fileLink('tfp-orig'))
    expect(await lineLink(sharer.orderId)).toBe(`${fileLink('tfp-orig')} | ${sharer.folder}`)
  })

  it('a file another line once held (now removed) is left out too', async () => {
    await lineWith([{ printArea: 'Front', driveFileId: 'tfp-was', removedAt: new Date('2026-11-10') }], null)
    const library = await prisma.skuSupplierDesign.create({ data: { sku: 'TFP-LIB2', supplierId: fx.supplierId, designLink: fileLink('tfp-was'), ready: true } })
    const l = await lineWith([{ printArea: 'Front', driveFileId: 'tfp-was' }], fileLink('tfp-was'))
    expect(await promoteFolderLink(l.orderId, 'l1')).toBe(false)
    expect((await prisma.skuSupplierDesign.findUniqueOrThrow({ where: { id: library.id } })).designLink).toBe(fileLink('tfp-was'))
    expect(await lineLink(l.orderId)).toBe(fileLink('tfp-was'))
  })

  it('a file only this line holds still turns into the folder link, in the library too', async () => {
    const library = await prisma.skuSupplierDesign.create({ data: { sku: 'TFP-LIB3', supplierId: fx.supplierId, designLink: fileLink('tfp-solo'), ready: true } })
    const l = await lineWith([{ printArea: 'Front', driveFileId: 'tfp-solo' }], fileLink('tfp-solo'))
    expect(await promoteFolderLink(l.orderId, 'l1')).toBe(true)
    expect((await prisma.skuSupplierDesign.findUniqueOrThrow({ where: { id: library.id } })).designLink).toBe(l.folder)
    expect(await lineLink(l.orderId)).toBe(l.folder)
  })
})
