import fs from 'fs/promises'
import { prisma } from '@/lib/db'
import { localArtworkPath } from '@/lib/design-storage'
import { artworkUrl } from '@/lib/design-studio'
import { taskKeyFor } from '@/lib/design-tasks'
import { DESIGN_LINK_SEPARATOR, joinDesignLinks } from '@/lib/design-links'
import { localLibraryPath } from '@/lib/library-storage'
import {
  DriveAuthError, DriveError, deleteFile, folderForPath, folderForTask, getFile, isDriveConnected, shareAnyoneReader,
  startResumableUpload, uploadChunk,
} from '@/lib/google-drive'

export const DRIVE_CHUNK_SIZE = 8 * 1024 * 1024
export const RECONNECT_WARNING = 'Google Drive cần kết nối lại'

export type PushResult = { pushed: boolean; warning: string | null; inProgress?: boolean }

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

function swapPublicLink(stored: string, marker: string, driveLink: string): string {
  return joinDesignLinks(stored.split(DESIGN_LINK_SEPARATOR).map(part => ({ url: part.includes(marker) ? driveLink : part.trim() })).filter(l => l.url))
}

/**
 * Before the push, a file the app still held went out as a public URL: into the design library (studio-library) and,
 * through the library, into lines of later orders. Those copies now get the Drive link, which does not depend on the source task.
 */
async function replacePublicLinks(publicToken: string | null, driveLink: string) {
  if (!publicToken) return
  const marker = `/api/public/artwork/${publicToken}/`
  const where = { designLink: { contains: marker } }
  for (const row of await prisma.skuSupplierDesign.findMany({ where, select: { id: true, designLink: true } })) {
    await prisma.skuSupplierDesign.updateMany({ where: { id: row.id }, data: { designLink: swapPublicLink(row.designLink ?? '', marker, driveLink) } })
  }
  const lineWhere = { designDriveLink: { contains: marker } }
  for (const row of await prisma.orderLine.findMany({ where: lineWhere, select: { id: true, designDriveLink: true } })) {
    await prisma.orderLine.updateMany({ where: { id: row.id }, data: { designDriveLink: swapPublicLink(row.designDriveLink ?? '', marker, driveLink) } })
  }
  for (const row of await prisma.order.findMany({ where: lineWhere, select: { id: true, designDriveLink: true } })) {
    await prisma.order.updateMany({ where: { id: row.id }, data: { designDriveLink: swapPublicLink(row.designDriveLink ?? '', marker, driveLink) } })
  }
}

export async function pushArtworkToDrive(artworkId: string): Promise<PushResult> {
  if (inflight().has(artworkId)) return { pushed: false, warning: 'Đang đẩy file này lên Drive, thử lại sau.', inProgress: true }
  inflight().add(artworkId)
  let driveFileId: string | null = null
  try {
    if (!(await isDriveConnected())) return { pushed: false, warning: null }
    const art = await prisma.designArtwork.findUnique({
      where: { id: artworkId },
      include: { order: { select: { shopifyOrderNumber: true, placedAt: true, store: { select: { shop: true, project: { select: { name: true } } } } } } },
    })
    if (!art) throw new Error('Artwork not found')
    if (art.removedAt) return { pushed: false, warning: 'File đã bị xoá khỏi task' }
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
    const stale = await prisma.designArtworkUpload.findMany({ where: { ...key, completedAt: null }, select: { driveFileId: true } })
    for (const row of stale) if (row.driveFileId) await deleteFile(row.driveFileId).catch(() => {})
    await prisma.designArtworkUpload.deleteMany({ where: { ...key, completedAt: null } })
    const upload = await prisma.designArtworkUpload.create({
      data: { ...key, fileName: art.fileName, mimeType: art.mimeType, size, sessionUrl, folderId, createdById: art.uploadedById },
    })

    const file = await uploadFile(absPath, size, sessionUrl)
    if (typeof file?.id !== 'string' || !file.id) throw new DriveError('Google Drive không trả về id file.')
    driveFileId = file.id as string
    await prisma.designArtworkUpload.update({ where: { id: upload.id }, data: { driveFileId } })
    await shareAnyoneReader(driveFileId)
    const webViewLink = typeof file.webViewLink === 'string' && file.webViewLink
      ? file.webViewLink
      : ((await getFile(driveFileId, 'webViewLink'))?.webViewLink || driveViewLink(driveFileId))

    const appUrl = artworkUrl(art.id)
    await prisma.$transaction([
      prisma.designArtworkUpload.update({ where: { id: upload.id }, data: { completedAt: new Date() } }),
      prisma.designArtwork.update({ where: { id: art.id }, data: { storage: 'DRIVE', driveFileId, driveWebViewLink: webViewLink, storagePath: null } }),
      prisma.orderLine.updateMany({ where: { orderId: art.orderId, shopifyLineId: art.shopifyLineId, designDriveLink: appUrl }, data: { designDriveLink: webViewLink } }),
      prisma.order.updateMany({ where: { id: art.orderId, designDriveLink: appUrl }, data: { designDriveLink: webViewLink } }),
    ])
    await replacePublicLinks(art.publicToken, webViewLink).catch(err => console.error('[drive push] public link rewrite failed:', err?.message ?? err))
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

export async function pushLibraryFileToDrive(fileId: string, folder: string[]): Promise<PushResult> {
  const key = `lib:${fileId}`
  if (inflight().has(key)) return { pushed: false, warning: 'Đang đẩy file này lên Drive, thử lại sau.', inProgress: true }
  inflight().add(key)
  let driveFileId: string | null = null
  try {
    if (!(await isDriveConnected())) return { pushed: false, warning: null }
    const row = await prisma.libraryFile.findUnique({ where: { id: fileId } })
    if (!row) throw new Error('File not found')
    if (row.storage === 'DRIVE') return { pushed: true, warning: null }
    const absPath = localLibraryPath(row.storagePath)
    if (!absPath) throw new Error('File không có bản local')
    const { size } = await fs.stat(absPath)
    if (size === 0) throw new Error('File rỗng')

    const folderId = await folderForPath(folder)
    const sessionUrl = await startResumableUpload({ name: row.fileName, mimeType: row.mimeType, size, parentId: folderId })
    const file = await uploadFile(absPath, size, sessionUrl)
    if (typeof file?.id !== 'string' || !file.id) throw new DriveError('Google Drive không trả về id file.')
    driveFileId = file.id as string
    const webViewLink = typeof file.webViewLink === 'string' && file.webViewLink
      ? file.webViewLink
      : ((await getFile(driveFileId, 'webViewLink'))?.webViewLink || driveViewLink(driveFileId))
    const updated = await prisma.libraryFile.updateMany({
      where: { id: row.id, storage: 'LOCAL' },
      data: { storage: 'DRIVE', driveFileId, driveWebViewLink: webViewLink, storagePath: null },
    })
    if (updated.count === 0) throw new Error('File đã đổi trong lúc đẩy lên Drive')
    await fs.rm(absPath, { force: true }).catch(err => console.error('[drive push] local cleanup failed:', err?.message ?? err))
    return { pushed: true, warning: null }
  } catch (err: any) {
    if (driveFileId) await deleteFile(driveFileId).catch(() => {})
    console.error('[drive push] library file failed:', err?.message ?? err)
    if (err instanceof DriveAuthError) return { pushed: false, warning: RECONNECT_WARNING }
    return { pushed: false, warning: `Chưa đẩy được lên Drive: ${err?.message ?? 'lỗi không rõ'}` }
  } finally {
    inflight().delete(key)
  }
}
