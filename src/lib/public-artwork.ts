import { randomBytes, timingSafeEqual } from 'crypto'
import { prisma } from '@/lib/db'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { ALLOWED_MIME, safeFileName } from '@/lib/design-storage'

export class PublicUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PublicUrlError'
  }
}

const NON_PUBLIC_SUFFIXES = ['.localhost', '.test', '.internal', '.lan', '.home', '.example', '.invalid']
const TOKEN_RE = /^[0-9a-f]{64}$/

/**
 * The only base a supplier-facing file URL may be built from. A dev machine runs on a copy of the
 * production DB, so a push from it would create a real paid order pointing at files nobody can fetch.
 */
export function requirePublicBaseUrl(raw: string | undefined | null = process.env.NEXT_PUBLIC_APP_URL): string {
  const value = (raw ?? '').trim().replace(/\/+$/, '')
  if (!value) throw new PublicUrlError('Chưa cấu hình NEXT_PUBLIC_APP_URL — không tạo được link file in công khai cho xưởng')
  let url: URL
  try {
    url = assertSafeExternalUrl(value)
  } catch (e: any) {
    throw new PublicUrlError(`NEXT_PUBLIC_APP_URL (${value}) không dùng được để gửi file in: ${e?.message ?? 'URL không hợp lệ'}. Cần domain public chạy https`)
  }
  const host = url.hostname.toLowerCase()
  if (!host.includes('.') || NON_PUBLIC_SUFFIXES.some(s => host.endsWith(s))) {
    throw new PublicUrlError(`NEXT_PUBLIC_APP_URL (${value}) không phải domain public — xưởng không tải được file in`)
  }
  if (url.search || url.hash) throw new PublicUrlError('NEXT_PUBLIC_APP_URL không được chứa query hoặc hash')
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`
}

export function isPublicToken(value: string): boolean {
  return TOKEN_RE.test(value)
}

export function mimeExtension(mimeType: string): string | null {
  return ALLOWED_MIME[mimeType] ?? null
}

function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.')
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : ''
}

function sameExtension(a: string, b: string): boolean {
  const norm = (x: string) => (x === 'jpeg' ? 'jpg' : x === 'tiff' ? 'tif' : x)
  return norm(a) === norm(b)
}

export function publicArtworkFileName(a: { fileName: string; mimeType: string }): string {
  const name = safeFileName(a.fileName)
  const ext = mimeExtension(a.mimeType)
  if (!ext || sameExtension(extensionOf(name), ext)) return name
  return `${name}.${ext}`
}

export function publicArtworkUrl(baseUrl: string, token: string, a: { fileName: string; mimeType: string }): string {
  return `${baseUrl}/api/public/artwork/${token}/${publicArtworkFileName(a)}`
}

export async function ensurePublicToken(artworkId: string): Promise<string> {
  const current = await prisma.designArtwork.findUnique({ where: { id: artworkId }, select: { publicToken: true } })
  if (!current) throw new Error('Artwork not found')
  if (current.publicToken) return current.publicToken
  const token = randomBytes(32).toString('hex')
  const r = await prisma.designArtwork.updateMany({ where: { id: artworkId, publicToken: null }, data: { publicToken: token } })
  if (r.count === 1) return token
  const again = await prisma.designArtwork.findUnique({ where: { id: artworkId }, select: { publicToken: true } })
  if (!again?.publicToken) throw new Error('Không tạo được token cho file in')
  return again.publicToken
}

/** A line is cleared for production once its design link is set and, when a design task exists, that task is DONE. */
export function isLineApproved(line: { designDriveLink: string | null }, task: { status: string } | null | undefined): boolean {
  return !!line.designDriveLink && (!task || task.status === 'DONE')
}

function tokensEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8')
  const y = Buffer.from(b, 'utf8')
  return x.length === y.length && timingSafeEqual(x, y)
}

export type PublicArtwork = {
  id: string; fileName: string; mimeType: string; storage: string; storagePath: string | null; driveFileId: string | null; size: number
}

export async function findPublicArtwork(token: string, requestedFileName: string): Promise<PublicArtwork | null> {
  if (!isPublicToken(token)) return null
  const row = await prisma.designArtwork.findUnique({ where: { publicToken: token } })
  if (!row || !row.publicToken || !tokensEqual(row.publicToken, token)) return null
  if (row.removedAt) return null
  const ext = mimeExtension(row.mimeType)
  if (!ext || !sameExtension(extensionOf(requestedFileName), ext)) return null
  const [line, task] = await Promise.all([
    prisma.orderLine.findFirst({ where: { orderId: row.orderId, shopifyLineId: row.shopifyLineId }, select: { designDriveLink: true } }),
    prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId: row.orderId, shopifyLineId: row.shopifyLineId } }, select: { status: true } }),
  ])
  if (!line || !isLineApproved(line, task)) return null
  return {
    id: row.id, fileName: publicArtworkFileName(row), mimeType: row.mimeType, storage: row.storage,
    storagePath: row.storagePath, driveFileId: row.driveFileId, size: row.size,
  }
}
