import { prisma } from '@/lib/db'
import { artworkUrl } from '@/lib/design-studio'
import { lineKeyOf } from '@/lib/order-lines'
import { DESIGN_LINK_SEPARATOR, joinDesignLinks } from '@/lib/design-links'
import { getGoogleConfig, isDriveConfigured } from '@/lib/google-oauth'
import { DriveAuthError, DriveError, driveFolderUrl, folderForPath, placeFile, removeEmptyChildFolder, shareAnyoneReader } from '@/lib/google-drive'
import { OLD_FOLDER_NAME, currentFileIds, driveFileName, driveOldFileName, folderHoldsPrintFiles, type DrivePlace } from '@/lib/task-files'

export type TaskFolder = { id: string; url: string; taskId: string | null }
export type TidyResult = { moved: number; stuck: number; failed: number; lastError: string | null; promoted: boolean; authError: boolean }

const BLANK: TidyResult = { moved: 0, stuck: 0, failed: 0, lastError: null, promoted: false, authError: false }
const SCAN_LIMIT = 5000

declare global {
  // eslint-disable-next-line no-var
  var __taskFolderInflight: Map<string, Promise<TaskFolder>> | undefined
  // eslint-disable-next-line no-var
  var __taskFolderTidy: Map<string, Promise<unknown>> | undefined
}

function folderInflight() {
  if (!global.__taskFolderInflight) global.__taskFolderInflight = new Map()
  return global.__taskFolderInflight
}

function tidyChains() {
  if (!global.__taskFolderTidy) global.__taskFolderTidy = new Map()
  return global.__taskFolderTidy
}

export function resetTaskFolderState() {
  folderInflight().clear()
  tidyChains().clear()
}

const lineKey = (orderId: string, shopifyLineId: string) => `${orderId}\u0000${shopifyLineId}`

/** `[<Store>, <YYYY-MM>, <Order>, <TaskKey>]`, the Drive path of a line's folder under the Design Studio root. */
async function taskFolderPath(orderId: string, shopifyLineId: string, taskKey?: string): Promise<string[]> {
  const [order, lines] = await Promise.all([
    prisma.order.findUnique({
      where: { id: orderId },
      select: { shopifyOrderNumber: true, placedAt: true, store: { select: { shop: true, project: { select: { name: true } } } } },
    }),
    taskKey ? null : prisma.orderLine.findMany({ where: { orderId }, select: { shopifyLineId: true, linePosition: true, productTitle: true, shopifyProductType: true } }),
  ])
  if (!order) throw new Error('Order not found')
  return [
    order.store.project?.name ?? order.store.shop,
    order.placedAt.toISOString().slice(0, 7),
    order.shopifyOrderNumber,
    taskKey ?? lineKeyOf(order.shopifyOrderNumber, lines ?? [], { shopifyLineId }) ?? shopifyLineId,
  ]
}

async function resolveTaskFolder(orderId: string, shopifyLineId: string): Promise<TaskFolder> {
  const task = await prisma.designTask.findUnique({
    where: { orderId_shopifyLineId: { orderId, shopifyLineId } }, select: { id: true, taskKey: true, driveFolderId: true, driveFolderUrl: true },
  })
  if (task?.driveFolderId) return { id: task.driveFolderId, url: task.driveFolderUrl ?? driveFolderUrl(task.driveFolderId), taskId: task.id }
  const id = await folderForPath(await taskFolderPath(orderId, shopifyLineId, task?.taskKey))
  const url = driveFolderUrl(id)
  if (!task) return { id, url, taskId: null }
  // The folder is shared before it is remembered: a failed share is retried by the next push instead of leaving a private folder behind.
  await shareAnyoneReader(id)
  await prisma.designTask.updateMany({ where: { id: task.id, driveFolderId: null }, data: { driveFolderId: id, driveFolderUrl: url } })
  return { id, url, taskId: task.id }
}

/**
 * Where superseded and removed versions of a task go: `<Order>/_old/<TaskKey>`, beside the task folders and never inside the
 * folder the factory has a link to, so the factory only ever sees the current files.
 */
export async function oldFolderFor(orderId: string, shopifyLineId: string): Promise<string> {
  const task = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } }, select: { taskKey: true } })
  const [store, month, order, taskKey] = await taskFolderPath(orderId, shopifyLineId, task?.taskKey)
  return folderForPath([store, month, order, OLD_FOLDER_NAME, taskKey])
}

/**
 * The one Drive folder of a task: `Design Studio/<Store>/<YYYY-MM>/<Order>/<TaskKey>`, created and shared "anyone with the link"
 * the first time a file of the task goes to Drive, then read from the task row. A line without a task gets the same path, unshared.
 */
export function ensureTaskFolder(orderId: string, shopifyLineId: string): Promise<TaskFolder> {
  const key = lineKey(orderId, shopifyLineId)
  const inflight = folderInflight()
  const pending = inflight.get(key)
  if (pending) return pending
  const promise = resolveTaskFolder(orderId, shopifyLineId).finally(() => { if (inflight.get(key) === promise) inflight.delete(key) })
  inflight.set(key, promise)
  return promise
}

function swapOwnLinks(stored: string, isOwn: (part: string) => boolean, folderUrl: string): string {
  return joinDesignLinks(stored.split(DESIGN_LINK_SEPARATOR).map(part => ({ url: isOwn(part) ? folderUrl : part.trim() })).filter(l => l.url))
}

/**
 * Once the folder holds every current print file, the links written while files were still on the server or were single
 * Drive files become the folder link: on the approved line and order, in the design library row, and on lines that reused that row.
 */
export async function promoteFolderLink(orderId: string, shopifyLineId: string): Promise<boolean> {
  const task = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } }, select: { driveFolderUrl: true } })
  const folderUrl = task?.driveFolderUrl
  if (!folderUrl) return false
  const files = await prisma.designArtwork.findMany({
    where: { orderId, shopifyLineId },
    select: { id: true, kind: true, printArea: true, version: true, storage: true, drivePlace: true, removedAt: true, driveWebViewLink: true, publicToken: true },
  })
  if (!folderHoldsPrintFiles(files)) return false

  const exact = new Set<string>()
  const markers: string[] = []
  for (const f of files) {
    exact.add(artworkUrl(f.id))
    if (f.driveWebViewLink) { exact.add(f.driveWebViewLink); markers.push(f.driveWebViewLink) }
    if (f.publicToken) markers.push(`/api/public/artwork/${f.publicToken}/`)
  }
  const isOwn = (part: string) => exact.has(part.trim()) || markers.some(m => part.includes(m))
  let changed = false
  const swap = async (stored: string | null, write: (value: string) => Promise<unknown>) => {
    if (!stored) return
    const next = swapOwnLinks(stored, isOwn, folderUrl)
    if (next === stored) return
    await write(next)
    changed = true
  }

  const line = await prisma.orderLine.findFirst({ where: { orderId, shopifyLineId }, select: { id: true, designDriveLink: true } })
  if (line) await swap(line.designDriveLink, v => prisma.orderLine.updateMany({ where: { id: line.id, designDriveLink: line.designDriveLink }, data: { designDriveLink: v } }))
  const order = await prisma.order.findUnique({ where: { id: orderId }, select: { designDriveLink: true } })
  if (order) await swap(order.designDriveLink, v => prisma.order.updateMany({ where: { id: orderId, designDriveLink: order.designDriveLink }, data: { designDriveLink: v } }))

  if (markers.length > 0) {
    const libraryWhere = { OR: markers.map(m => ({ designLink: { contains: m } })) }
    for (const row of await prisma.skuSupplierDesign.findMany({ where: libraryWhere, select: { id: true, designLink: true } })) {
      await swap(row.designLink, v => prisma.skuSupplierDesign.updateMany({ where: { id: row.id }, data: { designLink: v } }))
    }
    const reuseWhere = { OR: markers.map(m => ({ designDriveLink: { contains: m } })) }
    for (const row of await prisma.orderLine.findMany({ where: reuseWhere, select: { id: true, designDriveLink: true } })) {
      await swap(row.designDriveLink, v => prisma.orderLine.updateMany({ where: { id: row.id }, data: { designDriveLink: v } }))
    }
    for (const row of await prisma.order.findMany({ where: reuseWhere, select: { id: true, designDriveLink: true } })) {
      await swap(row.designDriveLink, v => prisma.order.updateMany({ where: { id: row.id }, data: { designDriveLink: v } }))
    }
  }
  return changed
}

async function tidy(orderId: string, shopifyLineId: string, retryStuck: boolean): Promise<TidyResult> {
  const result: TidyResult = { ...BLANK }
  const cfg = await getGoogleConfig()
  if (!isDriveConfigured(cfg) || cfg.needsReconnect) return result
  const hasTask = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } }, select: { id: true } })
  if (!hasTask) return result
  const files = await prisma.designArtwork.findMany({
    where: { orderId, shopifyLineId },
    select: { id: true, kind: true, printArea: true, version: true, fileName: true, storage: true, driveFileId: true, drivePlace: true, removedAt: true },
  })
  const current = currentFileIds(files)
  const wanted = (f: (typeof files)[number]): DrivePlace => (current.has(f.id) ? 'TASK' : 'OLD')
  const todo = files
    .filter(f => f.storage === 'DRIVE' && !!f.driveFileId && f.drivePlace !== wanted(f) && (retryStuck || f.drivePlace !== 'STUCK'))
    .sort((a, b) => (wanted(a) === wanted(b) ? 0 : wanted(a) === 'OLD' ? -1 : 1))

  if (todo.length > 0) {
    let folder: TaskFolder
    try {
      folder = await ensureTaskFolder(orderId, shopifyLineId)
    } catch (err: any) {
      return { ...result, failed: todo.length, lastError: err?.message ?? String(err), authError: err instanceof DriveAuthError }
    }
    if (!folder.taskId) return result
    let oldFolder: string | null = null
    for (const f of todo) {
      const place = wanted(f)
      const where = { id: f.id, driveFileId: f.driveFileId }
      try {
        const target = place === 'TASK' ? folder.id : (oldFolder ??= await oldFolderFor(orderId, shopifyLineId))
        await placeFile(f.driveFileId as string, target, place === 'TASK' ? driveFileName(f) : driveOldFileName(f))
        // _old is not shared: a file another line still prints from (shared non-custom print, shortcut in its folder)
        // would lose the folder's "anyone with the link" there, and the supplier gets "no access" (LIT5399, 10/29/2026).
        if (place === 'OLD' && await prisma.designArtwork.findFirst({
          where: { driveFileId: f.driveFileId, removedAt: null, NOT: { orderId, shopifyLineId } }, select: { id: true },
        })) await shareAnyoneReader(f.driveFileId as string)
        await prisma.designArtwork.updateMany({ where, data: { drivePlace: place } })
        result.moved++
      } catch (err: any) {
        result.lastError = err?.message ?? String(err)
        if (err instanceof DriveAuthError) { result.authError = true; result.failed++; break }
        if (err instanceof DriveError && (err.status === 404 || err.status === 403)) {
          // Not a file this connection can touch (created by another OAuth client, or gone): it stays where it is.
          await prisma.designArtwork.updateMany({ where, data: { drivePlace: 'STUCK' } })
          result.stuck++
          if (f.drivePlace === 'STUCK') continue
          await prisma.designTaskEvent.create({
            data: {
              taskId: folder.taskId, type: 'SYSTEM',
              message: `Không chuyển được file ${f.printArea} v${f.version} · ${f.fileName} ${place === 'TASK' ? 'vào thư mục Drive của task' : `sang ${OLD_FOLDER_NAME}`} (Drive trả ${err.status}) — file giữ nguyên chỗ cũ`,
            },
          })
          continue
        }
        // Unknown placement: the reorganise pass looks at this file again.
        await prisma.designArtwork.updateMany({ where, data: { drivePlace: null } })
        result.failed++
      }
    }
    // Before old versions moved out, they sat in an `_old` inside the task folder; once it is empty it goes.
    if (oldFolder && result.failed === 0) await removeEmptyChildFolder(folder.id, OLD_FOLDER_NAME).catch(() => false)
  }
  result.promoted = await promoteFolderLink(orderId, shopifyLineId)
  return result
}

/**
 * Makes the task folder match the task: every current file (the newest version of each part, mockups included) sits in the
 * folder under its part name, every superseded or removed file sits in the order's `_old/<TaskKey>`. Runs one at a time per task.
 */
export function tidyTaskFolder(orderId: string, shopifyLineId: string, opts: { retryStuck?: boolean } = {}): Promise<TidyResult> {
  const key = lineKey(orderId, shopifyLineId)
  const chains = tidyChains()
  const run = () => tidy(orderId, shopifyLineId, opts.retryStuck === true)
  const next = (chains.get(key) ?? Promise.resolve()).then(run, run)
  const settled = next.catch(() => {})
  chains.set(key, settled)
  void settled.then(() => { if (chains.get(key) === settled) chains.delete(key) })
  return next
}

/** Tasks with a Drive file whose place is not known: pushed before task folders existed, renamed, or a move that failed. */
export async function linesNeedingTidy(opts: { limit: number; retryStuck?: boolean }): Promise<Array<{ orderId: string; shopifyLineId: string }>> {
  const place = opts.retryStuck ? { OR: [{ drivePlace: null }, { drivePlace: 'STUCK' }] } : { drivePlace: null }
  const rows = await prisma.designArtwork.findMany({
    where: { storage: 'DRIVE', driveFileId: { not: null }, ...place },
    select: { orderId: true, shopifyLineId: true }, distinct: ['orderId', 'shopifyLineId'], orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], take: SCAN_LIMIT,
  })
  if (rows.length === 0) return []
  // Only a line with a task has a folder to tidy; the rest keep their files where they are.
  const orderIds = Array.from(new Set(rows.map(r => r.orderId)))
  const withTask = new Set<string>()
  for (let i = 0; i < orderIds.length; i += 400) {
    const tasks = await prisma.designTask.findMany({ where: { orderId: { in: orderIds.slice(i, i + 400) } }, select: { orderId: true, shopifyLineId: true } })
    for (const t of tasks) withTask.add(lineKey(t.orderId, t.shopifyLineId))
  }
  return rows.filter(r => withTask.has(lineKey(r.orderId, r.shopifyLineId))).slice(0, Math.max(1, opts.limit))
}

export function countUnplacedFiles(): Promise<number> {
  return prisma.designArtwork.count({ where: { storage: 'DRIVE', driveFileId: { not: null }, drivePlace: null } })
}
