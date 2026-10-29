import { lineKeyOf } from '@/lib/order-lines'
import fsp from 'fs/promises'
import { prisma } from '@/lib/db'
import { parseFields } from '@/lib/artwork-fields'
import { autoRenderEligibility, customerValues, renderFields, type RenderJobView } from '@/lib/artwork-render-eligibility'
import { RENDER_LINE, latestRenderJob, renderJobView } from '@/lib/artwork-render-jobs'
import { parseAttributes } from '@/lib/design-studio'
import { saveArtwork } from '@/lib/design-storage'
import { enqueueDrivePush } from '@/lib/drive-push-queue'
import { loadTask, submitAutoRenderForReview, type Actor } from '@/lib/design-tasks'
import { visibleCustomAttributes } from '@/lib/order-classify'
import { mapTemplate } from '@/lib/print-template-resolve'
import type { TempFile } from '@/lib/library-storage'
import { LibraryError } from '@/lib/repos/artwork-library'

export { RENDER_LINE, latestRenderJob }

const OPEN = ['QUEUED', 'RUNNING']

async function taskEvent(orderId: string, shopifyLineId: string, message: string, actorId: string | null = null) {
  const task = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } }, select: { id: true } })
  if (task) await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'ARTWORK', message, actorId } })
}

type LoadedTask = NonNullable<Awaited<ReturnType<typeof loadTask>>>

async function enqueueRender(detail: LoadedTask, actorId: string | null, how: string): Promise<RenderJobView> {
  const { task, library, slots } = detail
  const created = await prisma.$transaction(async tx => {
    const open = await tx.artworkJob.count({ where: { kind: RENDER_LINE, orderId: task.orderId, shopifyLineId: task.shopifyLineId, status: { in: OPEN } } })
    if (open > 0) throw new LibraryError('Đang dựng file in…', 409)
    return tx.artworkJob.create({
      data: { kind: RENDER_LINE, entryId: library!.entryId!, orderId: task.orderId, shopifyLineId: task.shopifyLineId, printArea: slots[0] },
    })
  })
  await taskEvent(task.orderId, task.shopifyLineId, `${how} (${slots[0]}) từ artwork gốc${library?.optionLabel ? ` ${library.optionLabel}` : ''}`, actorId)
  return renderJobView(created)
}

async function renderCheck(detail: LoadedTask) {
  const { task, line, library, template, slots } = detail
  const job = await latestRenderJob(task.orderId, task.shopifyLineId)
  return autoRenderEligibility({ taskStatus: task.status, hasTemplate: !!template, slots, library, personalization: line.personalization, job })
}

export async function queueRenderLine(taskKey: string, actor: Actor): Promise<RenderJobView> {
  const detail = await loadTask(taskKey)
  if (!detail) throw new LibraryError('Không tìm thấy task', 404)
  const check = await renderCheck(detail)
  if (!check.ok) throw new LibraryError(check.reason ?? 'Chưa tạo được file in tự động', 409)
  return enqueueRender(detail, actor.id, 'Xếp hàng tạo file in tự động')
}

/** Statuses the daily run picks up: nobody has started on the task yet. */
export const SCHEDULED_RENDER_FROM = ['NEW', 'ASSIGNED']
const SCHEDULED_SCAN_LIMIT = 400

export type ScheduledRenderSummary = { scanned: number; queued: { taskKey: string; jobId: string }[]; skipped: { reason: string; count: number }[] }

/**
 * The daily auto-render: every task nobody has started whose product has a READY artwork for its template and whose customer
 * filled every field gets a RENDER_LINE job. A line is tried once: one that already has a print file (uploaded or rendered)
 * or any earlier render job is left to the designer, so a failed render or a rejected one is never redone on its own.
 */
export async function queueScheduledRenders(opts: { limit?: number } = {}): Promise<ScheduledRenderSummary> {
  const tasks = await prisma.designTask.findMany({
    where: { status: { in: SCHEDULED_RENDER_FROM } },
    select: { taskKey: true, orderId: true, shopifyLineId: true },
    orderBy: { createdAt: 'asc' }, take: opts.limit ?? SCHEDULED_SCAN_LIMIT,
  })
  const summary: ScheduledRenderSummary = { scanned: tasks.length, queued: [], skipped: [] }
  if (tasks.length === 0) return summary
  const orderIds = Array.from(new Set(tasks.map(t => t.orderId)))
  const key = (orderId: string, shopifyLineId: string) => `${orderId}\u0000${shopifyLineId}`
  const [files, jobs] = await Promise.all([
    prisma.designArtwork.findMany({ where: { orderId: { in: orderIds }, kind: 'PRINT', removedAt: null }, select: { orderId: true, shopifyLineId: true }, distinct: ['orderId', 'shopifyLineId'] }),
    prisma.artworkJob.findMany({ where: { kind: RENDER_LINE, orderId: { in: orderIds } }, select: { orderId: true, shopifyLineId: true }, distinct: ['orderId', 'shopifyLineId'] }),
  ])
  const hasFile = new Set(files.map(f => key(f.orderId, f.shopifyLineId)))
  const tried = new Set(jobs.map(j => key(j.orderId as string, j.shopifyLineId as string)))
  const reasons = new Map<string, number>()
  const skip = (reason: string) => reasons.set(reason, (reasons.get(reason) ?? 0) + 1)

  for (const t of tasks) {
    const k = key(t.orderId, t.shopifyLineId)
    if (hasFile.has(k)) { skip('Đã có file in'); continue }
    if (tried.has(k)) { skip('Đã từng dựng tự động'); continue }
    try {
      const detail = await loadTask(t.taskKey)
      if (!detail) { skip('Không tìm thấy task'); continue }
      const check = await renderCheck(detail)
      if (!check.ok) { skip(check.reason?.startsWith('Khách chưa điền') ? 'Khách chưa điền đủ' : check.reason ?? 'Không đủ điều kiện'); continue }
      const job = await enqueueRender(detail, null, 'Lịch hằng ngày: xếp hàng tạo file in tự động')
      summary.queued.push({ taskKey: t.taskKey, jobId: job.id })
    } catch (err: any) {
      skip(`Lỗi: ${err?.message ?? String(err)}`.slice(0, 120))
    }
  }
  summary.skipped = Array.from(reasons, ([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count)
  return summary
}

export type RenderClaim = {
  job: { id: string; kind: string; attempts: number; createdAt: string }
  entry: { id: string; storeId: string; shopifyProductId: string; printTemplateId: string; optionKey: string; title: string; status: string; fields: unknown[] }
  template: ReturnType<typeof mapTemplate>
  artwork: { id: string; fileName: string; size: number; sha256: string }
  fonts: { postscriptName: string; fileId: string; sha256: string }[]
  values: Record<string, string>
  target: { orderId: string; shopifyLineId: string; orderNumber: string; linePosition: number; taskKey: string | null; printArea: string }
}

/** Builds the worker payload for a claimed RENDER_LINE job, or returns the reason it can't run (permanent). */
export async function renderClaimFor(job: { id: string; kind: string; attempts: number; createdAt: Date; entryId: string; orderId: string | null; shopifyLineId: string | null; printArea: string | null }): Promise<RenderClaim | { error: string }> {
  if (!job.orderId || !job.shopifyLineId || !job.printArea) return { error: 'Job thiếu dòng đơn đích' }
  const [entry, line, task] = await Promise.all([
    prisma.artworkEntry.findUnique({ where: { id: job.entryId }, include: { printTemplate: true, artworkFile: true } }),
    prisma.orderLine.findFirst({
      where: { orderId: job.orderId, shopifyLineId: job.shopifyLineId },
      select: { linePosition: true, customAttributesJson: true, order: { select: { shopifyOrderNumber: true } } },
    }),
    prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId: job.orderId, shopifyLineId: job.shopifyLineId } }, select: { taskKey: true } }),
  ])
  if (!entry) return { error: 'Artwork gốc đã bị xoá' }
  if (entry.status !== 'READY') return { error: `Artwork gốc không còn sẵn sàng (${entry.status})` }
  if (!entry.artworkFile) return { error: 'Artwork gốc chưa có artwork.png' }
  if (!line) return { error: 'Không tìm thấy dòng đơn' }
  const fields = parseFields(entry.fields)
  const names = renderFields({ layers: fields.map(f => ({ field: f.field, layer: f.layer, fit: f.fit })) })
  const values = customerValues(names, visibleCustomAttributes(parseAttributes(line.customAttributesJson)))
  const missing = names.filter(n => values[n] === undefined)
  if (missing.length) return { error: `Khách chưa điền: ${missing.join(', ')}` }
  const wanted = Array.from(new Set(fields.map(f => f.font.toLowerCase()).filter(Boolean)))
  const fonts = wanted.length
    ? await prisma.designFont.findMany({ include: { file: { select: { sha256: true } } } })
    : []
  return {
    job: { id: job.id, kind: job.kind, attempts: job.attempts, createdAt: job.createdAt.toISOString() },
    entry: {
      id: entry.id, storeId: entry.storeId, shopifyProductId: entry.shopifyProductId, printTemplateId: entry.printTemplateId,
      optionKey: entry.optionKey, title: entry.title, status: entry.status, fields,
    },
    template: mapTemplate(entry.printTemplate),
    artwork: { id: entry.artworkFile.id, fileName: entry.artworkFile.fileName, size: entry.artworkFile.size, sha256: entry.artworkFile.sha256 },
    fonts: fonts.filter(f => wanted.includes(f.postscriptName.toLowerCase())).map(f => ({ postscriptName: f.postscriptName, fileId: f.fileId, sha256: f.file.sha256 })),
    values,
    target: {
      orderId: job.orderId, shopifyLineId: job.shopifyLineId, orderNumber: line.order.shopifyOrderNumber, linePosition: line.linePosition,
      taskKey: task?.taskKey ?? null, printArea: job.printArea,
    },
  }
}

export async function renderJobFailed(job: { orderId: string | null; shopifyLineId: string | null }, message: string, final: boolean) {
  if (!final || !job.orderId || !job.shopifyLineId) return
  await taskEvent(job.orderId, job.shopifyLineId, `Tạo file in tự động lỗi: ${message}`)
}

export type RenderResultInput = { warnings: string[]; widthPx?: number; heightPx?: number }

export async function applyRenderResult(input: { jobId: string; print: TempFile; preview: TempFile | null; result: RenderResultInput }) {
  const job = await prisma.artworkJob.findUnique({ where: { id: input.jobId } })
  if (!job || job.status !== 'RUNNING' || job.kind !== RENDER_LINE) return null
  if (!job.orderId || !job.shopifyLineId || !job.printArea) return null
  const line = await prisma.orderLine.findFirst({
    where: { orderId: job.orderId, shopifyLineId: job.shopifyLineId },
    select: { id: true, shopifyLineId: true, order: { select: { shopifyOrderNumber: true, lines: { select: { shopifyLineId: true, linePosition: true, productTitle: true, shopifyProductType: true } } } } },
  })
  if (!line) return null
  const [bytes, preview] = await Promise.all([
    fsp.readFile(input.print.tmpPath),
    input.preview ? fsp.readFile(input.preview.tmpPath) : Promise.resolve(null),
  ])
  const lineKey = lineKeyOf(line.order.shopifyOrderNumber, line.order.lines, line) ?? line.order.shopifyOrderNumber.replace(/^#/, '')
  const artwork = await saveArtwork({
    lineId: line.id, printArea: job.printArea, fileName: `${lineKey}_${job.printArea}_auto.png`, mimeType: 'image/png',
    bytes, uploadedById: null, source: 'AUTO', preview,
  })
  const claimed = await prisma.artworkJob.updateMany({
    where: { id: job.id, status: 'RUNNING' },
    data: { status: 'DONE', error: null, finishedAt: new Date(), lockedAt: null, resultArtworkId: artwork.id },
  })
  if (claimed.count === 0) {
    await prisma.designArtwork.update({ where: { id: artwork.id }, data: { removedAt: new Date() } })
    return null
  }
  enqueueDrivePush(artwork.id)
  const notes = input.result.warnings
  await taskEvent(job.orderId, job.shopifyLineId,
    `Tạo file in tự động ${job.printArea} v${artwork.version} · ${artwork.widthPx ?? '?'}×${artwork.heightPx ?? '?'} px${notes.length ? ` · ${notes.join(' · ')}` : ''}`)
  const review = await submitAutoRenderForReview(job.orderId, job.shopifyLineId)
  return { artworkId: artwork.id, version: artwork.version, warning: null, review: review.moved }
}
