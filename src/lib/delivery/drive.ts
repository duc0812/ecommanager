import {
  createShortcut, deleteFile, findShortcut, folderForPath, getFileInfo, listChildren, placeFile, shareAnyoneReader,
} from '@/lib/google-drive'
import { ensureTaskFolder, oldFolderFor, tidyTaskFolder } from '@/lib/task-folder'

export type DriveFileInfo = { id: string; size: number; parents: string[]; trashed: boolean; mimeType: string }

export type DeliveryDrive = {
  fileInfo(id: string): Promise<DriveFileInfo | null>
  taskFolder(orderId: string, shopifyLineId: string): Promise<{ id: string; url: string }>
  incomingRoot(): Promise<string>
  incomingFolder(taskKey: string): Promise<string>
  oldFolder(orderId: string, shopifyLineId: string): Promise<string>
  createShortcut(targetId: string, parentId: string, name: string): Promise<string>
  findShortcut(parentId: string, targetId: string): Promise<string | null>
  moveFile(id: string, folderId: string, name: string): Promise<void>
  shareAnyoneReader(id: string): Promise<void>
  tidy(orderId: string, shopifyLineId: string): Promise<void>
  listChildren(parentId: string): ReturnType<typeof listChildren>
  deleteFile(id: string): Promise<void>
}

export const realDeliveryDrive: DeliveryDrive = {
  fileInfo: id => getFileInfo(id),
  async taskFolder(orderId, shopifyLineId) {
    const f = await ensureTaskFolder(orderId, shopifyLineId)
    return { id: f.id, url: f.url }
  },
  incomingRoot: () => folderForPath(['_incoming']),
  incomingFolder: taskKey => folderForPath(['_incoming', taskKey]),
  oldFolder: (orderId, shopifyLineId) => oldFolderFor(orderId, shopifyLineId),
  createShortcut: (targetId, parentId, name) => createShortcut(targetId, parentId, name),
  findShortcut: (parentId, targetId) => findShortcut(parentId, targetId),
  async moveFile(id, folderId, name) { await placeFile(id, folderId, name) },
  async shareAnyoneReader(id) { await shareAnyoneReader(id) },
  async tidy(orderId, shopifyLineId) {
    try {
      await tidyTaskFolder(orderId, shopifyLineId)
    } catch (err) {
      console.error('delivery tidy failed', orderId, shopifyLineId, err)
    }
  },
  listChildren: parentId => listChildren(parentId),
  deleteFile: id => deleteFile(id),
}

let override: DeliveryDrive | null = null

export function getDeliveryDrive(): DeliveryDrive {
  return override ?? realDeliveryDrive
}

export function setDeliveryDriveForTests(d: DeliveryDrive | null) {
  override = d
}
