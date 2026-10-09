import fs from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import { artworkUrl, type ArtworkRow } from '@/lib/design-studio'
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

export async function saveArtwork(input: {
  lineId: string; printArea: string; fileName: string; mimeType: string; bytes: Buffer; uploadedById: string | null
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

  const dims = imageSize(input.bytes)
  const row = await prisma.designArtwork.create({
    data: {
      orderId: line.orderId, shopifyLineId: line.shopifyLineId, printArea, version, fileName,
      storagePath: rel.split(path.sep).join('/'), size: input.bytes.length, mimeType, uploadedById: input.uploadedById,
      widthPx: dims?.width ?? null, heightPx: dims?.height ?? null,
    },
  })
  return {
    id: row.id, printArea: row.printArea, version: row.version, fileName: row.fileName, size: row.size,
    mimeType: row.mimeType, uploadedById: row.uploadedById, createdAt: row.createdAt.toISOString(), url: artworkUrl(row.id),
    widthPx: row.widthPx, heightPx: row.heightPx,
  }
}

export async function readArtwork(id: string) {
  const row = await prisma.designArtwork.findUnique({ where: { id } })
  if (!row) return null
  const root = storageRoot()
  const absPath = path.resolve(root, row.storagePath)
  if (!absPath.startsWith(path.resolve(root) + path.sep)) return null
  return { absPath, fileName: row.fileName, mimeType: row.mimeType }
}
