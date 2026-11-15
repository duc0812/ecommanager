import {
  createShortcut, deleteFile, findShortcut, folderForPath, getFileInfo, listChildren, placeFile, shareAnyoneReader,
} from '@/lib/google-drive'
import { ensureTaskFolder, oldFolderFor, tidyTaskFolder, type TidyResult } from '@/lib/task-folder'

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
  tidy(orderId: string, shopifyLineId: string): Promise<TidyResult | void>
  listChildren(parentId: string): ReturnType<typeof listChildren>
  deleteFile(id: string): Promise<void>
}

const METHODS: (keyof DeliveryDrive)[] = [
  'fileInfo', 'taskFolder', 'incomingRoot', 'incomingFolder', 'oldFolder', 'createShortcut', 'findShortcut', 'moveFile',
  'shareAnyoneReader', 'tidy', 'listChildren', 'deleteFile',
]

export const DRIVE_CALL_TIMEOUT_MS = 60_000

export class DriveTimeoutError extends Error {
  constructor(public method: string, public ms: number) {
    super(`Drive ${method} quá ${Math.round(ms / 1000)} giây — việc vẫn chạy nền`)
    this.name = 'DriveTimeoutError'
  }
}

/** The call keeps running after the timeout (fetch is not aborted); only the caller stops waiting. */
function bounded<T>(method: string, call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let timedOut = false
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { timedOut = true; reject(new DriveTimeoutError(method, ms)) }, ms)
  })
  call.then(
    () => { if (timedOut) console.warn(`delivery: Drive ${method} finished after its ${ms} ms timeout`) },
    err => { if (timedOut) console.error(`delivery: Drive ${method} failed after its ${ms} ms timeout`, err) },
  )
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer))
}

export function withDriveTimeout(drive: DeliveryDrive, ms: number | (() => number) = DRIVE_CALL_TIMEOUT_MS): DeliveryDrive {
  const out: Record<string, unknown> = {}
  for (const name of METHODS) {
    const fn = drive[name] as (...args: unknown[]) => Promise<unknown>
    out[name] = (...args: unknown[]) => bounded(name, Promise.resolve().then(() => fn.apply(drive, args)), typeof ms === 'function' ? ms() : ms)
  }
  return out as DeliveryDrive
}

let timeoutOverride: number | null = null

export function setDriveTimeoutForTests(ms: number | null) {
  timeoutOverride = ms
}

const unboundedDrive: DeliveryDrive = {
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
  tidy: (orderId, shopifyLineId) => tidyTaskFolder(orderId, shopifyLineId),
  listChildren: parentId => listChildren(parentId),
  deleteFile: id => deleteFile(id),
}

export const realDeliveryDrive: DeliveryDrive = withDriveTimeout(unboundedDrive, () => timeoutOverride ?? DRIVE_CALL_TIMEOUT_MS)

let override: DeliveryDrive | null = null

export function getDeliveryDrive(): DeliveryDrive {
  return override ?? realDeliveryDrive
}

export function setDeliveryDriveForTests(d: DeliveryDrive | null) {
  override = d
}
