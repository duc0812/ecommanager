import fs from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import { artworkUrl, toArtworkRow, type ArtworkRow } from '@/lib/design-studio'
import { imageSize } from '@/lib/image-size'

export const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'image/vnd.adobe.photoshop': 'psd',
  'application/x-photoshop': 'psd',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  psd: 'image/vnd.adobe.photoshop',
  zip: 'application/zip',
}
const ALLOWED_EXT = new Set(Object.keys(EXT_MIME))

export function storageRoot(): string {
  return process.env.DESIGN_STORAGE_DIR || path.resolve(process.cwd(), 'storage')
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const ascii = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  const cleaned = ascii.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+\./g, '.')
  return cleaned || 'file'
}

function extOf(fileName: string, mimeType: string): string {
  const fromName = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  if (ALLOWED_EXT.has(fromName)) return fromName
  return ALLOWED_MIME[mimeType] ?? ''
}

export type ArtworkSource = 'MANUAL' | 'AUTO'

export async function saveArtwork(input: {
  lineId: string; printArea: string; fileName: string; mimeType: string; bytes: Buffer; uploadedById: string | null
  source?: ArtworkSource; preview?: Buffer | null
}): Promise<ArtworkRow> {
  const ext = extOf(input.fileName, input.mimeType)
  if (!ext || !ALLOWED_EXT.has(ext)) throw new Error(`File type not allowed: ${input.fileName} (${input.mimeType})`)
  const mimeType = EXT_MIME[ext]
  const line = await prisma.orderLine.findUnique({
    where: { id: input.lineId },
    select: { orderId: true, shopifyLineId: true, linePosition: true, order: { select: { shopifyOrderNumber: true } } },
  })
  if (!line) throw new Error('Line not found')

  const printArea = input.printArea.trim() || 'Artwork'
  const fileName = safeFileName(input.fileName)
  const dir = path.join('design', safeFileName(line.order.shopifyOrderNumber.replace(/^#/, '')), String(line.linePosition), safeFileName(printArea))
  const root = path.resolve(storageRoot())

  let version = 0
  let rel = ''
  for (let attempt = 0; ; attempt++) {
    const last = await prisma.designArtwork.findFirst({
      where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, printArea }, orderBy: { version: 'desc' }, select: { version: true },
    })
    version = Math.max((last?.version ?? 0) + 1, version + 1)
    rel = path.join(dir, `v${version}-${fileName}`)
    const abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep)) throw new Error('Invalid storage path')
    await fs.mkdir(path.dirname(abs), { recursive: true })
    try {
      await fs.writeFile(abs, input.bytes, { flag: 'wx' })
      break
    } catch (e: any) {
      if (e?.code !== 'EEXIST' || attempt > 0) throw e
    }
  }

  let previewRel: string | null = null
  if (input.preview && input.preview.length > 0) {
    previewRel = path.join(dir, `v${version}-preview.jpg`)
    await fs.writeFile(path.resolve(root, previewRel), input.preview)
  }
  const dims = imageSize(input.bytes)
  const row = await prisma.designArtwork.create({
    data: {
      orderId: line.orderId, shopifyLineId: line.shopifyLineId, printArea, version, fileName,
      storagePath: rel.split(path.sep).join('/'), size: input.bytes.length, mimeType, uploadedById: input.uploadedById,
      widthPx: dims?.width ?? null, heightPx: dims?.height ?? null,
      source: input.source ?? 'MANUAL', previewPath: previewRel ? previewRel.split(path.sep).join('/') : null,
    },
  })
  return toArtworkRow(row)
}

export function localArtworkPath(storagePath: string | null): string | null {
  if (!storagePath) return null
  const root = path.resolve(storageRoot())
  const absPath = path.resolve(root, storagePath)
  return absPath.startsWith(root + path.sep) ? absPath : null
}

export async function readArtwork(id: string) {
  const row = await prisma.designArtwork.findUnique({ where: { id } })
  const absPath = row ? localArtworkPath(row.storagePath) : null
  if (!row || !absPath) return null
  return { absPath, fileName: row.fileName, mimeType: row.mimeType }
}

export async function loadArtworkRow(id: string): Promise<ArtworkRow | null> {
  const row = await prisma.designArtwork.findUnique({ where: { id } })
  return row ? toArtworkRow(row) : null
}

export class ArtworkRemoveError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function removeArtwork(artworkId: string, actor: { id: string; role: string }) {
  const art = await prisma.designArtwork.findUnique({ where: { id: artworkId } })
  if (!art || art.removedAt) throw new ArtworkRemoveError('Không tìm thấy file', 404)
  const isAdmin = actor.role === 'SUPERADMIN' || actor.role === 'ADMIN'
  if (!isAdmin && art.uploadedById !== actor.id) throw new ArtworkRemoveError('Chỉ người upload hoặc admin được xoá file này', 403)
  const [task, line] = await Promise.all([
    prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId: art.orderId, shopifyLineId: art.shopifyLineId } }, select: { id: true, status: true } }),
    prisma.orderLine.findFirst({ where: { orderId: art.orderId, shopifyLineId: art.shopifyLineId }, select: { designDriveLink: true } }),
  ])
  if (task?.status === 'DONE') throw new ArtworkRemoveError('Task đã duyệt design — bấm "Sửa & gửi lại" trước khi xoá file', 409)
  const links = [artworkUrl(art.id), art.driveWebViewLink].filter(Boolean)
  if (line?.designDriveLink && links.includes(line.designDriveLink)) {
    throw new ArtworkRemoveError('File này đang là file gửi xưởng của dòng — không xoá được', 409)
  }
  const removedAt = new Date()
  const r = await prisma.designArtwork.updateMany({ where: { id: art.id, removedAt: null }, data: { removedAt, removedById: actor.id } })
  if (r.count === 0) throw new ArtworkRemoveError('Không tìm thấy file', 404)
  if (task) {
    await prisma.designTaskEvent.create({
      data: { taskId: task.id, type: 'ARTWORK', message: `Xoá file ${art.printArea} v${art.version} · ${art.fileName}`, actorId: actor.id },
    })
  }
  return { id: art.id, printArea: art.printArea, version: art.version, removedAt: removedAt.toISOString() }
}
