import { prisma } from '@/lib/db'
import type { DeliveryDrive } from '@/lib/delivery/drive'

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
const MIN_INTERVAL_MS = 60 * 60 * 1000
const FOLDER_MIME = 'application/vnd.google-apps.folder'

type Stamp = { __deliveryIncomingCleanupAt?: number }

/**
 * Deletes plain files older than 7 days that no DesignArtwork row references. The `_incoming/<taskKey>` folders themselves
 * are never deleted: folderForPath caches path → id for the process life, so a deleted folder would be handed out again.
 */
export async function cleanupIncoming(drive: DeliveryDrive, now: Date = new Date(), opts: { force?: boolean } = {}) {
  const out = { deletedFiles: 0, kept: 0 }
  const g = globalThis as Stamp
  if (!opts.force && g.__deliveryIncomingCleanupAt && now.getTime() - g.__deliveryIncomingCleanupAt < MIN_INTERVAL_MS) return out

  const root = await drive.incomingRoot()
  const folders = (await drive.listChildren(root)).filter(c => c.mimeType === FOLDER_MIME)
  for (const folder of folders) {
    for (const f of await drive.listChildren(folder.id)) {
      if (f.mimeType === FOLDER_MIME) { out.kept++; continue }
      const created = Date.parse(f.createdTime)
      if (!Number.isFinite(created) || now.getTime() - created <= MAX_AGE_MS) continue
      const referenced = await prisma.designArtwork.findFirst({ where: { driveFileId: f.id }, select: { id: true } })
      if (referenced) { out.kept++; continue }
      await drive.deleteFile(f.id)
      out.deletedFiles++
    }
  }
  g.__deliveryIncomingCleanupAt = now.getTime()
  return out
}
