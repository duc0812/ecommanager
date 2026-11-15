import { prisma } from '@/lib/db'
import { AUTO_REVIEW_FROM, requiredSlotsFor, requiredSlotsForLine, submitAutoRenderForReview, templateForLine } from '@/lib/design-tasks'
import { isOrderOpen } from '@/lib/design-agent/order-open'
import { driveFileViewUrl } from '@/lib/google-drive'
import { templateViewFor, type TemplateRow } from '@/lib/print-template-resolve'
import { isUniqueViolation } from '@/lib/sqlite-busy'
import { driveFileName, missingPrintAreas } from '@/lib/task-files'
import type { DeliveryDrive } from '@/lib/delivery/drive'
import { DeliveryLineMissingError, deliveryTaskState } from '@/lib/delivery/task-state'
import type { CommitError, CommitInput, CommitResult, DeliveryFile, TaskState } from '@/lib/delivery/types'
import {
  driveFileError, inputError, isAlreadyApplied, isStale, layoutCheck, refuse, sameIds, staleRefusal,
} from '@/lib/delivery/commit-checks'
import { pushEventMessage } from '@/lib/delivery/commit-text'

type PlannedFile = DeliveryFile & { version: number }

type Plan = { inserts: PlannedFile[]; event: { type: string; message: string } }

type Ctx = {
  taskId: string
  orderId: string
  shopifyLineId: string
  input: CommitInput
  state: TaskState
  template: TemplateRow | null
  now: Date
}

type Artwork = CommitResult['artworks'][number]

class StaleWrite extends Error {}

const LINE_TEMPLATE_FIELDS = { orderId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, shopifyProductType: true } as const

function planPush(ctx: Ctx): CommitError | Plan {
  const { state, input } = ctx
  if (!AUTO_REVIEW_FROM.includes(state.status as any)) {
    return refuse(409, 'wrong_state', `Task đang ${state.status} — push chỉ nhận task NEW, ASSIGNED, DOING hoặc REJECTED`, state)
  }
  if (state.artworks.some(a => a.kind === 'PRINT')) return refuse(409, 'wrong_state', 'Dòng đã có file in — dùng replace', state)
  const inserts = input.files.map(f => ({ ...f, version: state.nextVersion[`${f.kind}/${f.printArea}`] ?? 1 }))
  return { inserts, event: { type: 'ARTWORK', message: pushEventMessage(inserts, input.eventMessage?.trim() ? input.eventMessage : undefined) } }
}

const liveArtworks = (orderId: string, shopifyLineId: string) => prisma.designArtwork.findMany({
  where: { orderId, shopifyLineId, removedAt: null },
  select: { id: true, kind: true, printArea: true, version: true, driveFileId: true },
  orderBy: [{ kind: 'asc' }, { printArea: 'asc' }, { version: 'asc' }],
})

function missingFor(template: TemplateRow | null, files: { kind: string; printArea: string; version: number }[]): string[] {
  return missingPrintAreas(files, requiredSlotsFor(templateViewFor(template, files)))
}

async function removeShortcuts(ids: string[], drive: DeliveryDrive) {
  for (const id of ids) await drive.deleteFile(id).catch(err => console.error('delivery: shortcut cleanup failed', id, err))
}

/** Shortcuts first (their rows say TASK), then one transaction that re-checks the task it planned against, so a second writer gets `stale`. */
async function writePlan(ctx: Ctx, plan: Plan, drive: DeliveryDrive): Promise<CommitError | null> {
  const { orderId, shopifyLineId, state, now } = ctx
  const created: string[] = []
  try {
    for (const f of plan.inserts.filter(x => x.shortcutOf)) {
      const existing = await drive.findShortcut(state.folder.id, f.shortcutOf as string)
      if (!existing) created.push(await drive.createShortcut(f.shortcutOf as string, state.folder.id, driveFileName(f)))
    }
    await prisma.$transaction(async tx => {
      const guard = await tx.designTask.updateMany({ where: { id: ctx.taskId, status: state.status }, data: { updatedAt: now } })
      if (guard.count === 0) throw new StaleWrite()
      const live = await tx.designArtwork.findMany({ where: { orderId, shopifyLineId, removedAt: null }, select: { id: true } })
      if (!sameIds(live.map(r => r.id), state.artworks.map(a => a.id))) throw new StaleWrite()
      for (const f of plan.inserts) {
        await tx.designArtwork.create({
          data: {
            orderId, shopifyLineId, kind: f.kind, printArea: f.printArea, version: f.version, fileName: f.fileName,
            storage: 'DRIVE', storagePath: null, driveFileId: f.driveFileId, driveWebViewLink: driveFileViewUrl(f.driveFileId),
            drivePlace: f.shortcutOf ? 'TASK' : null, size: f.size, mimeType: f.mimeType, widthPx: f.widthPx ?? null, heightPx: f.heightPx ?? null,
            uploadedById: null, source: 'AUTO', previewPath: null, createdAt: now,
          },
        })
      }
      await tx.designTaskEvent.create({ data: { taskId: ctx.taskId, type: plan.event.type, message: plan.event.message, actorId: null, createdAt: now } })
    })
  } catch (err) {
    await removeShortcuts(created, drive)
    if (err instanceof StaleWrite || isUniqueViolation(err)) {
      const current = await deliveryTaskState(state.taskKey, drive).catch(() => null)
      return current ? staleRefusal(current) : refuse(409, 'stale', 'Task đã đổi từ lúc máy đọc trạng thái — đọc lại rồi gửi lại')
    }
    throw err
  }
  return null
}

async function afterPush(ctx: Ctx, warnings: string[]): Promise<string[]> {
  const { orderId, shopifyLineId } = ctx
  let moved = false
  let reason: string | null = null
  try {
    const r = await submitAutoRenderForReview(orderId, shopifyLineId)
    moved = r.moved
    reason = r.reason
  } catch (err: any) {
    reason = err?.message ?? String(err)
  }
  if (moved) return []
  const live = await liveArtworks(orderId, shopifyLineId)
  const missing = missingPrintAreas(live, await requiredSlotsForLine(orderId, shopifyLineId))
  if (missing.length === 0 && reason) warnings.push(`Chưa gửi duyệt: ${reason}`)
  return missing
}

const ACTIONS: Partial<Record<CommitInput['action'], { plan: (ctx: Ctx) => CommitError | Plan; after: (ctx: Ctx, warnings: string[]) => Promise<string[]> }>> = {
  push: { plan: planPush, after: afterPush },
}

export async function commitDelivery(taskKey: string, input: CommitInput, drive: DeliveryDrive): Promise<CommitResult | CommitError> {
  const invalid = inputError(input)
  if (invalid) return invalid
  const retire = input.retire ?? []

  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) return refuse(404, 'not_found', 'Không tìm thấy task')
  const { orderId, shopifyLineId } = task
  if (task.status === 'CANCELLED') return refuse(409, 'closed', 'Task đã huỷ — không nhận file nữa')
  if (!(await isOrderOpen(orderId))) return refuse(409, 'closed', 'Đơn đã giao hoặc đã đóng — không nhận file nữa')
  const line = await prisma.orderLine.findFirst({ where: { orderId, shopifyLineId }, select: LINE_TEMPLATE_FIELDS })
  if (!line) return refuse(409, 'line_syncing', new DeliveryLineMissingError().message)

  const rows = await prisma.designArtwork.findMany({
    where: { orderId, shopifyLineId }, select: { id: true, kind: true, printArea: true, driveFileId: true, removedAt: true },
  })
  if (isAlreadyApplied(rows, input)) {
    const live = await liveArtworks(orderId, shopifyLineId)
    return {
      ok: true, status: task.status, artworks: live, retired: retire, warnings: [], alreadyApplied: true,
      missing: missingPrintAreas(live, await requiredSlotsForLine(orderId, shopifyLineId)),
    }
  }

  let state: TaskState | null
  try {
    state = await deliveryTaskState(taskKey, drive)
  } catch (err) {
    if (err instanceof DeliveryLineMissingError) return refuse(409, 'line_syncing', err.message)
    throw err
  }
  if (!state) return refuse(404, 'not_found', 'Không tìm thấy task')
  if (isStale(state, input.expected)) return staleRefusal(state)

  const ctx: Ctx = { taskId: task.id, orderId, shopifyLineId, input, state, template: await templateForLine(line), now: new Date() }
  const action = ACTIONS[input.action]
  if (!action) return refuse(400, 'unsupported_action', `Action ${input.action} chưa hỗ trợ`)
  const planned = action.plan(ctx)
  if ('ok' in planned) return planned

  const driveError = await driveFileError(input.files, state, task, drive)
  if (driveError) return driveError
  const view = templateViewFor(ctx.template, [...state.artworks, ...input.files])
  const layout = layoutCheck(view, input.files, ctx.now)
  if (layout.error) return layout.error
  const warnings = [...layout.warnings]

  if (input.dryRun) {
    const wouldBe: Artwork[] = [
      ...state.artworks.map(a => ({ id: a.id, kind: a.kind, printArea: a.printArea, version: a.version, driveFileId: a.driveFileId })),
      ...planned.inserts.map(f => ({ id: '', kind: f.kind, printArea: f.printArea, version: f.version, driveFileId: f.driveFileId })),
    ]
    return { ok: true, status: state.status, artworks: wouldBe, retired: [], missing: missingFor(ctx.template, wouldBe), warnings, alreadyApplied: false }
  }

  const writeError = await writePlan(ctx, planned, drive)
  if (writeError) return writeError

  const missing = await action.after(ctx, warnings)
  try {
    await drive.tidy(orderId, shopifyLineId)
  } catch (err: any) {
    warnings.push(`Chưa xếp được file vào thư mục task: ${err?.message ?? err} — lượt dọn định kỳ làm lại`)
  }
  const after = await prisma.designTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })
  return { ok: true, status: after.status, artworks: await liveArtworks(orderId, shopifyLineId), retired: [], missing, warnings, alreadyApplied: false }
}
