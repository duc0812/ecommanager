import { prisma } from '@/lib/db'
import { saveArtwork } from '@/lib/design-storage'
import { logAutoMockup } from '@/lib/design-tasks'
import { enqueueDrivePush } from '@/lib/drive-push-queue'

export const PREVIEW_PART = 'Preview'
const PREVIEW_HOST = /(^|\.)customall\.io$/i
const MAX_PREVIEW_DOWNLOAD = 20 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff])
const CLOSED_TASK = ['DONE', 'CANCELLED']

/** The preview link comes from a line property the shopper's browser sends, so the server only fetches it from the personaliser's own CDN. */
export function isPreviewCdnUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && PREVIEW_HOST.test(u.hostname)
  } catch {
    return false
  }
}

/** The CDN labels every preview image/jpeg, but many are really WebP, which a mockup may not be. Anything not JPEG is re-encoded. */
export async function previewAsJpeg(bytes: Buffer): Promise<Buffer> {
  if (bytes.subarray(0, 3).equals(JPEG_MAGIC)) return bytes
  const { default: sharp } = await import('sharp')
  return sharp(bytes).flatten({ background: '#ffffff' }).jpeg({ quality: 95, chromaSubsampling: '4:4:4' }).toBuffer()
}

async function downloadPreview(url: string): Promise<Buffer> {
  const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (bytes.length === 0) throw new Error('ảnh rỗng')
  if (bytes.length > MAX_PREVIEW_DOWNLOAD) throw new Error('ảnh quá lớn')
  return bytes
}

/**
 * A line with a customer preview gets that image in its task folder as its mockup. A line that ever had a mockup is left alone, so
 * a mockup a person removed stays removed, and an approved task is not touched. A failed download is retried by the next sync.
 */
export async function savePreviewMockups(orderId: string): Promise<{ saved: number; errors: string[] }> {
  const [lines, tasks, mockups] = await Promise.all([
    prisma.orderLine.findMany({ where: { orderId, previewCdnUrl: { not: null } }, select: { id: true, shopifyLineId: true, previewCdnUrl: true } }),
    prisma.designTask.findMany({ where: { orderId, status: { notIn: CLOSED_TASK } }, select: { shopifyLineId: true } }),
    prisma.designArtwork.findMany({ where: { orderId, kind: 'MOCKUP' }, select: { shopifyLineId: true }, distinct: ['shopifyLineId'] }),
  ])
  const open = new Set(tasks.map(t => t.shopifyLineId))
  const hasMockup = new Set(mockups.map(m => m.shopifyLineId))
  let saved = 0
  const errors: string[] = []
  for (const line of lines) {
    if (!line.previewCdnUrl || !open.has(line.shopifyLineId) || hasMockup.has(line.shopifyLineId)) continue
    if (!isPreviewCdnUrl(line.previewCdnUrl)) continue
    try {
      const bytes = await previewAsJpeg(await downloadPreview(line.previewCdnUrl))
      const artwork = await saveArtwork({
        lineId: line.id, printArea: PREVIEW_PART, fileName: `${PREVIEW_PART}.jpg`, mimeType: 'image/jpeg', bytes, uploadedById: null, source: 'AUTO', kind: 'MOCKUP',
      })
      await logAutoMockup(orderId, line.shopifyLineId, 'Lưu preview khách tạo lúc đặt hàng làm mockup')
      enqueueDrivePush(artwork.id)
      saved++
    } catch (e: any) {
      errors.push(`preview mockup ${line.shopifyLineId}: ${e?.message ?? e}`)
    }
  }
  return { saved, errors }
}
