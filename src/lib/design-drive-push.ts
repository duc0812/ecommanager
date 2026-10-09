import fs from 'fs/promises'
import { prisma } from '@/lib/db'
import { localArtworkPath } from '@/lib/design-storage'
import { taskKeyFor } from '@/lib/design-tasks'
import {
  DriveAuthError, DriveError, deleteFile, folderForTask, getFile, isDriveConnected, shareAnyoneReader,
  startResumableUpload, uploadChunk,
} from '@/lib/google-drive'

export const DRIVE_CHUNK_SIZE = 8 * 1024 * 1024
export const RECONNECT_WARNING = 'Google Drive cần kết nối lại'

export type PushResult = { pushed: boolean; warning: string | null }

declare global {
  // eslint-disable-next-line no-var
  var __drivePushInflight: Set<string> | undefined
}

function inflight() {
  if (!global.__drivePushInflight) global.__drivePushInflight = new Set()
  return global.__drivePushInflight
}

function driveViewLink(id: string) {
  return `https://drive.google.com/file/d/${encodeURIComponent(id)}/view?usp=drivesdk`
}

async function uploadFile(absPath: string, size: number, sessionUrl: string): Promise<any> {
  const handle = await fs.open(absPath, 'r')
  try {
    let start = 0
    const maxRounds = Math.ceil(size / DRIVE_CHUNK_SIZE) * 3 + 3
    for (let round = 0; round < maxRounds; round++) {
      const length = Math.min(DRIVE_CHUNK_SIZE, size - start)
      const chunk = Buffer.allocUnsafe(length)
      const { bytesRead } = await handle.read(chunk, 0, length, start)
      if (bytesRead !== length) throw new Error('File thay đổi trong lúc đẩy lên Drive')
      const result = await uploadChunk(sessionUrl, chunk, start, size)
      if (result.done) return result.file
      start = result.nextStart
      if (start >= size) throw new DriveError('Google Drive báo đã nhận đủ nhưng chưa trả file.')
    }
    throw new DriveError('Google Drive không nhận hết file sau nhiều lần gửi.')
  } finally {
    await handle.close()
  }
}

export async function pushArtworkToDrive(artworkId: string): Promise<PushResult> {
  if (!(await isDriveConnected())) return { pushed: false, warning: null }
  if (inflight().has(artworkId)) return { pushed: false, warning: 'Đang đẩy file này lên Drive, thử lại sau.' }
  inflight().add(artworkId)
  let driveFileId: string | null = null
  try {
    const art = await prisma.designArtwork.findUnique({
      where: { id: artworkId },
      include: { order: { select: { shopifyOrderNumber: true, placedAt: true, store: { select: { shop: true, project: { select: { name: true } } } } } } },
    })
    if (!art) throw new Error('Artwork not found')
    if (art.storage === 'DRIVE') return { pushed: true, warning: null }
    const absPath = localArtworkPath(art.storagePath)
    if (!absPath) throw new Error('Artwork không có file local')
    const { size } = await fs.stat(absPath)
    if (size === 0) throw new Error('File rỗng')

    const [task, line] = await Promise.all([
      prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId: art.orderId, shopifyLineId: art.shopifyLineId } }, select: { taskKey: true } }),
      prisma.orderLine.findFirst({ where: { orderId: art.orderId, shopifyLineId: art.shopifyLineId }, select: { linePosition: true } }),
    ])
    const folderId = await folderForTask({
      storeName: art.order.store.project?.name ?? art.order.store.shop,
      placedAt: art.order.placedAt,
      orderNumber: art.order.shopifyOrderNumber,
      taskKey: task?.taskKey ?? taskKeyFor(art.order.shopifyOrderNumber, line?.linePosition ?? 0),
    })
    const sessionUrl = await startResumableUpload({ name: `v${art.version}-${art.fileName}`, mimeType: art.mimeType, size, parentId: folderId })
    const key = { orderId: art.orderId, shopifyLineId: art.shopifyLineId, printArea: art.printArea, version: art.version }
    await prisma.designArtworkUpload.deleteMany({ where: { ...key, completedAt: null } })
    const upload = await prisma.designArtworkUpload.create({
      data: { ...key, fileName: art.fileName, mimeType: art.mimeType, size, sessionUrl, folderId, createdById: art.uploadedById },
    })

    const file = await uploadFile(absPath, size, sessionUrl)
    if (typeof file?.id !== 'string' || !file.id) throw new DriveError('Google Drive không trả về id file.')
    driveFileId = file.id as string
    await shareAnyoneReader(driveFileId)
    const webViewLink = typeof file.webViewLink === 'string' && file.webViewLink
      ? file.webViewLink
      : ((await getFile(driveFileId, 'webViewLink'))?.webViewLink || driveViewLink(driveFileId))

    await prisma.$transaction([
      prisma.designArtworkUpload.update({ where: { id: upload.id }, data: { completedAt: new Date(), driveFileId } }),
      prisma.designArtwork.update({ where: { id: art.id }, data: { storage: 'DRIVE', driveFileId, driveWebViewLink: webViewLink, storagePath: null } }),
    ])
    await fs.rm(absPath, { force: true }).catch(err => console.error('[drive push] local cleanup failed:', err?.message ?? err))
    return { pushed: true, warning: null }
  } catch (err: any) {
    if (driveFileId) await deleteFile(driveFileId).catch(() => {})
    console.error('[drive push] failed:', err?.message ?? err)
    if (err instanceof DriveAuthError) return { pushed: false, warning: RECONNECT_WARNING }
    return { pushed: false, warning: `Chưa đẩy được lên Drive: ${err?.message ?? 'lỗi không rõ'}` }
  } finally {
    inflight().delete(artworkId)
  }
}
