// calls records each invocation as "<method>:<first arg>", e.g. "moveFile:abc", "tidy:<orderId>", "taskFolder:<orderId>".
import type { DeliveryDrive, DriveFileInfo } from '@/lib/delivery/drive'

type FakeFile = DriveFileInfo & { name: string; createdTime: string; target?: string }

export function fakeDrive() {
  const files = new Map<string, FakeFile>()
  const calls: string[] = []
  let seq = 0

  const drive: DeliveryDrive & {
    files: Map<string, FakeFile>
    calls: string[]
    addFile(f: Partial<DriveFileInfo> & { id: string; parent: string; size: number; name?: string; createdTime?: string }): void
  } = {
    files,
    calls,
    addFile(f) {
      files.set(f.id, {
        id: f.id,
        size: f.size,
        parents: [f.parent],
        trashed: f.trashed ?? false,
        mimeType: f.mimeType ?? 'application/octet-stream',
        name: f.name ?? f.id,
        createdTime: f.createdTime ?? new Date().toISOString(),
      })
    },
    async fileInfo(id) {
      calls.push(`fileInfo:${id}`)
      const f = files.get(id)
      if (!f) return null
      return { id: f.id, size: f.size, parents: [...f.parents], trashed: f.trashed, mimeType: f.mimeType }
    },
    async taskFolder(orderId, shopifyLineId) {
      calls.push(`taskFolder:${orderId}`)
      const id = `task-${orderId}-${shopifyLineId}`
      return { id, url: `https://drive.google.com/drive/folders/${id}` }
    },
    async incomingFolder(taskKey) {
      calls.push(`incomingFolder:${taskKey}`)
      return `incoming-${taskKey}`
    },
    async oldFolder(orderId, shopifyLineId) {
      calls.push(`oldFolder:${orderId}`)
      return `old-${orderId}-${shopifyLineId}`
    },
    async createShortcut(targetId, parentId, name) {
      calls.push(`createShortcut:${targetId}`)
      const id = `shortcut-${++seq}`
      files.set(id, {
        id, size: 0, parents: [parentId], trashed: false, name, target: targetId,
        mimeType: 'application/vnd.google-apps.shortcut', createdTime: new Date().toISOString(),
      })
      return id
    },
    async findShortcut(parentId, targetId) {
      calls.push(`findShortcut:${parentId}`)
      for (const f of Array.from(files.values())) {
        if (f.target === targetId && f.parents.includes(parentId) && !f.trashed) return f.id
      }
      return null
    },
    async moveFile(id, folderId, name) {
      calls.push(`moveFile:${id}`)
      const f = files.get(id)
      if (!f) throw new Error(`fake drive: no file ${id}`)
      f.parents = [folderId]
      f.name = name
    },
    async tidy(orderId) {
      calls.push(`tidy:${orderId}`)
    },
    async listChildren(parentId) {
      calls.push(`listChildren:${parentId}`)
      return Array.from(files.values())
        .filter(f => f.parents.includes(parentId) && !f.trashed)
        .map(f => ({ id: f.id, name: f.name, mimeType: f.mimeType, createdTime: f.createdTime }))
    },
    async deleteFile(id) {
      calls.push(`deleteFile:${id}`)
      files.delete(id)
    },
  }
  return drive
}
