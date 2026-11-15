import { promises as fs } from 'fs'
import { prisma } from '@/lib/db'
import { localArtworkPath, saveArtwork } from '@/lib/design-storage'
import { logAutoMockup } from '@/lib/design-tasks'
import { enqueueDrivePush } from '@/lib/drive-push-queue'
import { streamFile } from '@/lib/google-drive'
import { isOrderClosed } from '@/lib/line-export'
import { isReusableDesignLine } from '@/lib/studio-library'
import { currentFiles } from '@/lib/task-files'

export const LIBRARY_MOCKUP_PART = 'Preview no-name'
const IMAGE_TYPES = ['image/png', 'image/jpeg']
const MAX_SOURCE_BYTES = 30 * 1024 * 1024
const SOURCE_LINES = 40
/** A proof or QA board stored as a mockup must never be copied on to another order (LIT6280_1, 11/12/2026). */
const NOT_A_MOCKUP = /(^|[^a-z])(qa|proof|safe.?zones?|guides?|contact.?sheet|overlay|checklist)([^a-z]|$)/i
/**
 * Only a mockup someone named as plain is copied without a look: an automatic "Preview" on a no-custom line can be the store
 * photo with its sample name (LIT6054_1 "LINDA", LIT6217_2 "ROBERT", 11/15/2026), and copying it would spread the error.
 */
const PLAIN_NAME = /(^|[^a-z])(no[\s_-]?name|plain|kh[oô]ng[\s_-]?t[eê]n|tr[oơ]n)([^a-z]|$)/i

const folderIdOf = (link: string | null | undefined) => link?.match(/\/folders\/([\w-]+)/)?.[1] ?? null

type SourceLine = { orderId: string; shopifyLineId: string; folderId: string | null; taskKey: string }
type SourceFile = { id: string; storagePath: string | null; driveFileId: string | null; mimeType: string; fileName: string; printArea: string; createdAt: Date }

/** Approved no-custom lines of the same SKU at the same supplier, the one the SKU's library link points to first. */
async function sourceLines(orderId: string, sku: string, supplierId: string, libraryFolder: string | null): Promise<SourceLine[]> {
  const lines = await prisma.orderLine.findMany({
    where: { sku, resolvedSupplierId: supplierId, orderId: { not: orderId }, customAttributesJson: { not: null } },
    orderBy: { order: { placedAt: 'desc' } },
    take: SOURCE_LINES,
    select: { orderId: true, shopifyLineId: true, sku: true, resolvedSupplierId: true, customized: true, customAttributesJson: true, previewCdnUrl: true },
  })
  const plain = lines.filter(isReusableDesignLine)
  if (plain.length === 0) return []
  const tasks = await prisma.designTask.findMany({
    where: { status: 'DONE', OR: plain.map(l => ({ orderId: l.orderId, shopifyLineId: l.shopifyLineId })) },
    select: { orderId: true, shopifyLineId: true, driveFolderUrl: true, taskKey: true },
  })
  const out = plain.flatMap(l => {
    const t = tasks.find(x => x.orderId === l.orderId && x.shopifyLineId === l.shopifyLineId)
    return t ? [{ orderId: l.orderId, shopifyLineId: l.shopifyLineId, folderId: folderIdOf(t.driveFolderUrl), taskKey: t.taskKey }] : []
  })
  return libraryFolder ? [...out.filter(s => s.folderId === libraryFolder), ...out.filter(s => s.folderId !== libraryFolder)] : out
}

/** The mockup a source line shows now: its newest current PNG/JPEG mockup part. */
async function mockupOf(src: SourceLine): Promise<SourceFile | null> {
  const files = await prisma.designArtwork.findMany({
    where: { orderId: src.orderId, shopifyLineId: src.shopifyLineId, kind: 'MOCKUP', removedAt: null },
    select: { id: true, kind: true, printArea: true, version: true, createdAt: true, storagePath: true, driveFileId: true, mimeType: true, fileName: true },
  })
  const usable = currentFiles(files, 'MOCKUP')
    .filter(f => IMAGE_TYPES.includes(f.mimeType) && PLAIN_NAME.test(`${f.printArea} ${f.fileName}`) && !NOT_A_MOCKUP.test(`${f.printArea} ${f.fileName}`))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  return usable[0] ?? null
}

async function bytesOf(file: SourceFile): Promise<Buffer> {
  const local = localArtworkPath(file.storagePath)
  if (local) {
    const bytes = await fs.readFile(local).catch(() => null)
    if (bytes && bytes.length > 0) return bytes
  }
  if (!file.driveFileId) throw new Error('file mockup nguồn không còn trên máy chủ lẫn Drive')
  const bytes = Buffer.from(await (await streamFile(file.driveFileId)).arrayBuffer())
  if (bytes.length === 0) throw new Error('file mockup nguồn rỗng')
  if (bytes.length > MAX_SOURCE_BYTES) throw new Error('file mockup nguồn quá lớn')
  return bytes
}

/**
 * Owner 11/15/2026: a no-custom line takes the plain mockup its SKU already has, the fastest way to give the supplier the right
 * picture instead of the Shopify photo with a sample name. Only a line whose shopper typed nothing (the rule the library uses,
 * with its properties already read), not sent yet, in an open order, with a task, and that never had a mockup: a mockup a person
 * removed stays removed. The source is an approved no-custom line of the same SKU and supplier whose mockup is named as plain,
 * the one the library link points to first. A line whose SKU has no such mockup waits; the next sync looks again.
 */
export async function saveLibraryMockups(orderId: string): Promise<{ saved: number; errors: string[] }> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      pipelineStatus: true, financialStatus: true, fulfillmentStatus: true,
      lines: { select: { id: true, orderId: true, shopifyLineId: true, sku: true, resolvedSupplierId: true, customized: true, customAttributesJson: true, previewCdnUrl: true, dropship: true, exportedAt: true, designDriveLink: true } },
      designTasks: { where: { status: { not: 'CANCELLED' } }, select: { shopifyLineId: true } },
    },
  })
  if (!order || isOrderClosed(order)) return { saved: 0, errors: [] }
  const withTask = new Set(order.designTasks.map(t => t.shopifyLineId))
  const candidates = order.lines.filter(l => withTask.has(l.shopifyLineId) && !l.dropship && !l.exportedAt && l.customAttributesJson != null && isReusableDesignLine(l))
  if (candidates.length === 0) return { saved: 0, errors: [] }
  const hadMockup = new Set((await prisma.designArtwork.findMany({
    where: { orderId, kind: 'MOCKUP', shopifyLineId: { in: candidates.map(l => l.shopifyLineId) } }, select: { shopifyLineId: true }, distinct: ['shopifyLineId'],
  })).map(m => m.shopifyLineId))

  let saved = 0
  const errors: string[] = []
  for (const line of candidates) {
    if (hadMockup.has(line.shopifyLineId)) continue
    try {
      const sku = line.sku as string
      const supplierId = line.resolvedSupplierId as string
      let picked: { src: SourceLine; file: SourceFile } | null = null
      for (const src of await sourceLines(orderId, sku, supplierId, folderIdOf(line.designDriveLink))) {
        const file = await mockupOf(src)
        if (file) { picked = { src, file }; break }
      }
      if (!picked) continue
      const bytes = await bytesOf(picked.file)
      const ext = picked.file.mimeType === 'image/png' ? 'png' : 'jpg'
      const artwork = await saveArtwork({
        lineId: line.id, printArea: LIBRARY_MOCKUP_PART, fileName: `${LIBRARY_MOCKUP_PART}.${ext}`, mimeType: picked.file.mimeType, bytes,
        uploadedById: null, source: 'AUTO', kind: 'MOCKUP',
      })
      await logAutoMockup(orderId, line.shopifyLineId, `Gắn mockup trơn có sẵn của SKU ${sku} (từ ${picked.src.taskKey}) — đơn không custom`)
      enqueueDrivePush(artwork.id)
      saved++
    } catch (e: any) {
      errors.push(`library mockup ${line.shopifyLineId}: ${e?.message ?? e}`)
    }
  }
  return { saved, errors }
}
