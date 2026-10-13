import { constants as fsConstants } from 'fs'
import fs from 'fs/promises'
import path from 'path'
import { prisma } from '@/lib/db'
import { artworkUrl, toArtworkRow, type ArtworkRow } from '@/lib/design-studio'
import { imageSize } from '@/lib/image-size'
import { cleanPartLabel, fileKindOf, DEFAULT_PART, partLabelFromFileName, partTaken, resolvePartLabel, type FileKind } from '@/lib/task-files'

export const ALLOWED_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'application/pdf': 'pdf',
  'image/vnd.adobe.photoshop': 'psd',
  'application/x-photoshop': 'psd',
  'application/zip': 'zip',
  'application/x-zip-compressed': 'zip',
  'image/tiff': 'tif',
}

const EXT_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  psd: 'image/vnd.adobe.photoshop',
  zip: 'application/zip',
  tif: 'image/tiff',
  tiff: 'image/tiff',
}
const ALLOWED_EXT = new Set(Object.keys(EXT_MIME))
export const MAX_ARTWORK_BYTES = 200 * 1024 * 1024
export const ARTWORK_TYPES_LABEL = 'PNG, JPG, PDF, PSD, ZIP, TIF'
const DIMENSION_PROBE_BYTES = 2 * 1024 * 1024
// Two part labels can share one folder name on disk once sanitised; the version number then skips ahead instead of failing.
const MAX_VERSION_ATTEMPTS = 50

export function storageRoot(): string {
  return process.env.DESIGN_STORAGE_DIR || path.resolve(process.cwd(), 'storage')
}

export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const ascii = base.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
  const cleaned = ascii.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').replace(/_+\./g, '.')
  return cleaned || 'file'
}

function extOf(fileName: string, mimeType: string): string {
  const fromName = fileName.includes('.') ? fileName.split('.').pop()!.toLowerCase() : ''
  if (ALLOWED_EXT.has(fromName)) return fromName
  return fromName ? '' : ALLOWED_MIME[mimeType] ?? ''
}

/** The stored mime comes from the extension allow-list, never from what the browser claims. */
export function artworkFileType(fileName: string, mimeType: string): { ext: string; mimeType: string } | null {
  const ext = extOf(fileName, mimeType)
  return ext && ALLOWED_EXT.has(ext) ? { ext, mimeType: EXT_MIME[ext] } : null
}

export type ArtworkSource = 'MANUAL' | 'AUTO'
export type ArtworkTarget = { orderId: string; shopifyLineId: string; linePosition: number; orderNumber: string }
type ArtworkMeta = {
  printArea: string; fileName: string; mimeType: string; uploadedById: string | null; source?: ArtworkSource; preview?: Buffer | null
  kind?: FileKind
  /** Set when nobody named the part: it is read from the file name and joined to a template area or an existing part of the task. */
  derivePart?: { slots: string[] }
}
type ArtworkPayload = { bytes: Buffer } | { tmpPath: string; size: number }

async function placeTempFile(tmpPath: string, abs: string) {
  try {
    await fs.link(tmpPath, abs)
  } catch (e: any) {
    if (e?.code === 'EEXIST') throw e
    await fs.copyFile(tmpPath, abs, fsConstants.COPYFILE_EXCL)
  }
  await fs.rm(tmpPath, { force: true }).catch(() => {})
}

async function readHead(abs: string, size: number): Promise<Buffer> {
  const length = Math.min(size, DIMENSION_PROBE_BYTES)
  const handle = await fs.open(abs, 'r')
  try {
    const head = Buffer.alloc(length)
    const { bytesRead } = await handle.read(head, 0, length, 0)
    return head.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

async function storeArtwork(target: ArtworkTarget, meta: ArtworkMeta, payload: ArtworkPayload): Promise<ArtworkRow> {
  const type = artworkFileType(meta.fileName, meta.mimeType)
  if (!type) throw new Error(`File type not allowed: ${meta.fileName} (${meta.mimeType})`)

  const kind = fileKindOf(meta.kind)
  const line = { orderId: target.orderId, shopifyLineId: target.shopifyLineId, kind }
  let printArea = meta.printArea.trim()
  if (!printArea && meta.derivePart) {
    const existing = await prisma.designArtwork.findMany({ where: line, select: { printArea: true }, distinct: ['printArea'] })
    printArea = resolvePartLabel(partLabelFromFileName(meta.fileName), kind === 'PRINT' ? meta.derivePart.slots : [], existing.map(e => e.printArea))
  }
  printArea = printArea || DEFAULT_PART
  const fileName = safeFileName(meta.fileName)
  const dir = path.join(
    'design', safeFileName(target.orderNumber.replace(/^#/, '')), String(target.linePosition), ...(kind === 'MOCKUP' ? ['_mockup'] : []), safeFileName(printArea),
  )
  const root = path.resolve(storageRoot())

  let version = 0
  let rel = ''
  let abs = ''
  for (let attempt = 0; ; attempt++) {
    const last = await prisma.designArtwork.findFirst({ where: { ...line, printArea }, orderBy: { version: 'desc' }, select: { version: true } })
    version = Math.max((last?.version ?? 0) + 1, version + 1)
    rel = path.join(dir, `v${version}-${fileName}`)
    abs = path.resolve(root, rel)
    if (!abs.startsWith(root + path.sep)) throw new Error('Invalid storage path')
    await fs.mkdir(path.dirname(abs), { recursive: true })
    try {
      if ('bytes' in payload) await fs.writeFile(abs, payload.bytes, { flag: 'wx' })
      else await placeTempFile(payload.tmpPath, abs)
      break
    } catch (e: any) {
      if (e?.code !== 'EEXIST' || attempt >= MAX_VERSION_ATTEMPTS) throw e
    }
  }

  let previewRel: string | null = null
  if (meta.preview && meta.preview.length > 0) {
    previewRel = path.join(dir, `v${version}-preview.jpg`)
    await fs.writeFile(path.resolve(root, previewRel), meta.preview)
  }
  const size = 'bytes' in payload ? payload.bytes.length : payload.size
  const dims = imageSize('bytes' in payload ? payload.bytes : await readHead(abs, size))
  const row = await prisma.designArtwork.create({
    data: {
      orderId: target.orderId, shopifyLineId: target.shopifyLineId, kind, printArea, version, fileName,
      storagePath: rel.split(path.sep).join('/'), size, mimeType: type.mimeType, uploadedById: meta.uploadedById,
      widthPx: dims?.width ?? null, heightPx: dims?.height ?? null,
      source: meta.source ?? 'MANUAL', previewPath: previewRel ? previewRel.split(path.sep).join('/') : null,
    },
  })
  return toArtworkRow(row)
}

export async function saveArtwork(input: {
  lineId: string; printArea: string; fileName: string; mimeType: string; bytes: Buffer; uploadedById: string | null
  source?: ArtworkSource; preview?: Buffer | null; kind?: FileKind
}): Promise<ArtworkRow> {
  if (!artworkFileType(input.fileName, input.mimeType)) throw new Error(`File type not allowed: ${input.fileName} (${input.mimeType})`)
  const line = await prisma.orderLine.findUnique({
    where: { id: input.lineId },
    select: { orderId: true, shopifyLineId: true, linePosition: true, order: { select: { shopifyOrderNumber: true } } },
  })
  if (!line) throw new Error('Line not found')
  return storeArtwork(
    { orderId: line.orderId, shopifyLineId: line.shopifyLineId, linePosition: line.linePosition, orderNumber: line.order.shopifyOrderNumber },
    input, { bytes: input.bytes },
  )
}

/** Stores a file already streamed to disk: the temp file is moved into place, never read into memory. */
export async function saveArtworkFromTemp(input: {
  target: ArtworkTarget; printArea: string; fileName: string; mimeType: string; temp: { tmpPath: string; size: number }; uploadedById: string | null
  kind?: FileKind; derivePart?: { slots: string[] }
}): Promise<ArtworkRow> {
  return storeArtwork(input.target, input, input.temp)
}

/**
 * A task is tied to its order line by orderId + shopifyLineId. OrderLine.id is not stable: every order sync
 * deletes and recreates the rows, so an id held by an open browser tab goes stale.
 */
export async function artworkTargetForTask(taskKey: string): Promise<ArtworkTarget | 'no-task' | 'no-line'> {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { orderId: true, shopifyLineId: true } })
  if (!task) return 'no-task'
  const line = await prisma.orderLine.findFirst({
    where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId },
    select: { linePosition: true, order: { select: { shopifyOrderNumber: true } } },
  })
  if (!line) return 'no-line'
  return { orderId: task.orderId, shopifyLineId: task.shopifyLineId, linePosition: line.linePosition, orderNumber: line.order.shopifyOrderNumber }
}

export function localArtworkPath(storagePath: string | null): string | null {
  if (!storagePath) return null
  const root = path.resolve(storageRoot())
  const absPath = path.resolve(root, storagePath)
  return absPath.startsWith(root + path.sep) ? absPath : null
}

export async function readArtwork(id: string) {
  const row = await prisma.designArtwork.findUnique({ where: { id } })
  const absPath = row ? localArtworkPath(row.storagePath) : null
  if (!row || !absPath) return null
  return { absPath, fileName: row.fileName, mimeType: row.mimeType }
}

export async function loadArtworkRow(id: string): Promise<ArtworkRow | null> {
  const row = await prisma.designArtwork.findUnique({ where: { id } })
  return row ? toArtworkRow(row) : null
}

export class ArtworkRemoveError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function removeArtwork(artworkId: string, actor: { id: string; role: string }) {
  const art = await prisma.designArtwork.findUnique({ where: { id: artworkId } })
  if (!art || art.removedAt) throw new ArtworkRemoveError('Không tìm thấy file', 404)
  const isAdmin = actor.role === 'SUPERADMIN' || actor.role === 'ADMIN'
  if (!isAdmin && art.uploadedById !== actor.id) throw new ArtworkRemoveError('Chỉ người upload hoặc admin được xoá file này', 403)
  const [task, line] = await Promise.all([
    prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId: art.orderId, shopifyLineId: art.shopifyLineId } }, select: { id: true, status: true } }),
    prisma.orderLine.findFirst({ where: { orderId: art.orderId, shopifyLineId: art.shopifyLineId }, select: { designDriveLink: true } }),
  ])
  if (task?.status === 'DONE') throw new ArtworkRemoveError('Task đã duyệt design — bấm "Sửa & gửi lại" trước khi xoá file', 409)
  const links = [artworkUrl(art.id), art.driveWebViewLink].filter(Boolean)
  if (line?.designDriveLink && links.includes(line.designDriveLink)) {
    throw new ArtworkRemoveError('File này đang là file gửi xưởng của dòng — không xoá được', 409)
  }
  const removedAt = new Date()
  const r = await prisma.designArtwork.updateMany({ where: { id: art.id, removedAt: null }, data: { removedAt, removedById: actor.id } })
  if (r.count === 0) throw new ArtworkRemoveError('Không tìm thấy file', 404)
  if (task) {
    await prisma.designTaskEvent.create({
      data: { taskId: task.id, type: 'ARTWORK', message: `Xoá file ${art.printArea} v${art.version} · ${art.fileName}`, actorId: actor.id },
    })
  }
  return { id: art.id, orderId: art.orderId, shopifyLineId: art.shopifyLineId, printArea: art.printArea, version: art.version, removedAt: removedAt.toISOString() }
}

/**
 * Renames a part: every version of it (removed ones too, so version numbers stay in one line) takes the new label.
 * The Drive copies in the task folder are marked "place unknown" so the folder tidy gives them the new name.
 */
export async function renameArtworkPart(taskKey: string, input: { kind: FileKind; from: string; to: string }, actor: { id: string }) {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true, orderId: true, shopifyLineId: true, status: true } })
  if (!task) throw new ArtworkRemoveError('Không tìm thấy task', 404)
  if (task.status === 'DONE') throw new ArtworkRemoveError('Task đã duyệt design — bấm "Sửa & gửi lại" trước khi đổi tên file', 409)
  const to = cleanPartLabel(input.to)
  if (!to) throw new ArtworkRemoveError('Tên file không được để trống', 400)
  const line = { orderId: task.orderId, shopifyLineId: task.shopifyLineId, kind: input.kind }
  const labels = (await prisma.designArtwork.findMany({ where: line, select: { printArea: true }, distinct: ['printArea'] })).map(r => r.printArea)
  if (!labels.includes(input.from)) throw new ArtworkRemoveError('Không tìm thấy file này trong task', 404)
  const result = { orderId: task.orderId, shopifyLineId: task.shopifyLineId, kind: input.kind, from: input.from, to }
  if (to === input.from) return { ...result, changed: 0 }
  if (partTaken(to, labels.filter(l => l !== input.from))) throw new ArtworkRemoveError(`Task đã có file tên "${to}" — chọn tên khác`, 409)
  const where = { ...line, printArea: input.from }
  const [, renamed] = await prisma.$transaction([
    prisma.designArtwork.updateMany({ where: { ...where, storage: 'DRIVE', drivePlace: 'TASK' }, data: { drivePlace: null } }),
    prisma.designArtwork.updateMany({ where, data: { printArea: to } }),
    prisma.designTaskEvent.create({
      data: { taskId: task.id, type: 'ARTWORK', message: `Đổi tên ${input.kind === 'MOCKUP' ? 'mockup' : 'file in'} "${input.from}" → "${to}"`, actorId: actor.id },
    }),
  ])
  return { ...result, changed: renamed.count }
}
