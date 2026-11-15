import { prisma } from '@/lib/db'
import type { DeliveryDrive } from '@/lib/delivery/drive'

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MIN_INTERVAL_MS = 60 * 60 * 1000
const FOLDER_MIME = 'application/vnd.google-apps.folder'

type Stamp = { __deliveryIncomingCleanupAt?: number }

export async function cleanupIncoming(drive: DeliveryDrive, now: Date = new Date(), opts: { force?: boolean } = {}) {
  const out = { deletedFiles: 0, removedFolders: 0, kept: 0 }
  const g = globalThis as Stamp
  if (!opts.force && g.__deliveryIncomingCleanupAt && now.getTime() - g.__deliveryIncomingCleanupAt < MIN_INTERVAL_MS) return out
  g.__deliveryIncomingCleanupAt = now.getTime()

  const root = await drive.incomingRoot()
  const folders = (await drive.listChildren(root)).filter(c => c.mimeType === FOLDER_MIME)
  for (const folder of folders) {
    const children = await drive.listChildren(folder.id)
    let remaining = children.length
    for (const f of children) {
      const created = Date.parse(f.createdTime)
      if (!Number.isFinite(created) || now.getTime() - created <= MAX_AGE_MS) continue
      const referenced = await prisma.designArtwork.findFirst({ where: { driveFileId: f.id }, select: { id: true } })
      if (referenced) { out.kept++; continue }
      await drive.deleteFile(f.id)
      out.deletedFiles++
      remaining--
    }
    if (remaining === 0) {
      await drive.deleteFile(folder.id)
      out.removedFolders++
    }
  }
  return out
}
