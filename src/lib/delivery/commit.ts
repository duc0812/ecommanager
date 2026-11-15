import { prisma } from '@/lib/db'
import { AUTO_REVIEW_FROM, requiredSlotsFor, requiredSlotsForLine, submitAutoRenderForReview, templateForLine } from '@/lib/design-tasks'
import { isOrderOpen } from '@/lib/design-agent/order-open'
import { driveFileViewUrl } from '@/lib/google-drive'
import { allSlotNames, templateViewFor, type TemplateRow } from '@/lib/print-template-resolve'
import { isUniqueViolation } from '@/lib/sqlite-busy'
import { driveFileName, driveOldFileName, missingPrintAreas, sameLabel } from '@/lib/task-files'
import type { DeliveryDrive } from '@/lib/delivery/drive'
import { DeliveryLineMissingError, deliveryTaskState } from '@/lib/delivery/task-state'
import type { CommitError, CommitInput, CommitResult, TaskState } from '@/lib/delivery/types'
import {
  driveFileError, duplicateFileError, inputError, isAlreadyApplied, isStale, layoutCheck, refuse, sameIds, staleRefusal,
} from '@/lib/delivery/commit-checks'
import { RESUBMIT_EVENT, pushEventMessage } from '@/lib/delivery/commit-text'
import { isRevertApplied, nextVersionFor, planReplace, planRetire, planRevert, type Ctx, type Plan } from '@/lib/delivery/commit-replace'

type Artwork = CommitResult['artworks'][number]

type LineRow = { id: string; kind: string; printArea: string; driveFileId: string | null; removedAt: Date | null; removedById: string | null; source: string }

type SharedRetired = { kind: string; printArea: string; version: number; fileName: string; driveFileId: string }

type Task = { id: string; taskKey: string; status: string; orderId: string; shopifyLineId: string }

type ActionSpec = {
  plan: (ctx: Ctx) => CommitError | Plan
  after: (ctx: Ctx, warnings: string[]) => Promise<string[]>
  applied: (rows: LineRow[], input: CommitInput) => boolean
  /** Runs on an already-applied resend that is not a dryRun; returns the task status afterwards. */
  resend?: (task: Task) => Promise<string>
}

class StaleWrite extends Error {}

const RESUBMIT_FROM = ['NEW', 'ASSIGNED']
const RESUBMIT_AFTER_REPLACE = ['DOING', 'REJECTED']
const SHARED_STAYS_WARNING = 'File dùng chung vẫn nằm trong thư mục task'

const LINE_TEMPLATE_FIELDS = { orderId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, shopifyProductType: true } as const

function planPush(ctx: Ctx): CommitError | Plan {
  const { state, input, files } = ctx
  if (!AUTO_REVIEW_FROM.includes(state.status as any)) {
    return refuse(409, 'wrong_state', `Task đang ${state.status} — push chỉ nhận task NEW, ASSIGNED, DOING hoặc REJECTED`, state)
  }
  const taken = files.filter(f => state.artworks.some(a => a.kind === f.kind && sameLabel(a.printArea, f.printArea)))
  if (taken.length) {
    return refuse(409, 'wrong_state', `Đã có file cho ${taken.map(f => `${f.kind === 'MOCKUP' ? 'mockup ' : ''}${f.printArea}`).join(', ')} — dùng replace`, state)
  }
  const inserts = files.map(f => ({ ...f, version: nextVersionFor(state, f.kind, f.printArea) }))
  return { inserts, retire: [], event: { type: 'ARTWORK', message: pushEventMessage(inserts, input.eventMessage?.trim() ? input.eventMessage : undefined) } }
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

/**
 * Shortcuts first (their rows say TASK), then one transaction that re-checks the task it planned against, so a second writer gets
 * `stale`. A retired row gets drivePlace NULL so tidy (now or the periodic pass) moves its file to `_old`; a row whose file other
 * lines still print from gets 'OLD' so tidy never moves that file, and only this line's shortcut moves, after the commit.
 */
async function writePlan(ctx: Ctx, plan: Plan, drive: DeliveryDrive): Promise<{ error: CommitError } | { shared: SharedRetired[] }> {
  const { orderId, shopifyLineId, state, now } = ctx
  const created: string[] = []
  let shared: SharedRetired[] = []
  try {
    for (const f of plan.inserts.filter(x => x.shortcutOf)) {
      const existing = await drive.findShortcut(state.folder.id, f.shortcutOf as string)
      if (!existing) created.push(await drive.createShortcut(f.shortcutOf as string, state.folder.id, driveFileName(f)))
    }
    shared = await prisma.$transaction(async tx => {
      const guard = await tx.designTask.updateMany({
        where: { id: ctx.taskId, status: state.status, ...(plan.guardReadiness ? { readiness: plan.guardReadiness } : {}) },
        data: { updatedAt: now, ...(plan.task ?? {}) },
      })
      if (guard.count === 0) throw new StaleWrite()
      const live = await tx.designArtwork.findMany({ where: { orderId, shopifyLineId, removedAt: null }, select: { id: true } })
      if (!sameIds(live.map(r => r.id), state.artworks.map(a => a.id))) throw new StaleWrite()
      const sharedRows: SharedRetired[] = []
      for (const r of plan.retire) {
        const row = await tx.designArtwork.findUniqueOrThrow({
          where: { id: r.id }, select: { kind: true, printArea: true, version: true, fileName: true, driveFileId: true },
        })
        const others = row.driveFileId
          ? await tx.designArtwork.count({ where: { driveFileId: row.driveFileId, removedAt: null, NOT: { orderId, shopifyLineId } } })
          : 0
        const done = await tx.designArtwork.updateMany({
          where: { id: r.id, orderId, shopifyLineId, removedAt: null },
          data: { removedAt: now, removedById: null, drivePlace: others > 0 ? 'OLD' : null },
        })
        if (done.count !== 1) throw new StaleWrite()
        if (others > 0) sharedRows.push({ ...row, driveFileId: row.driveFileId as string })
      }
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
      return sharedRows
    })
  } catch (err) {
    await removeShortcuts(created, drive)
    if (err instanceof StaleWrite || isUniqueViolation(err)) {
      const current = await deliveryTaskState(state.taskKey, drive).catch(() => null)
      return { error: current ? staleRefusal(current) : refuse(409, 'stale', 'Task đã đổi từ lúc máy đọc trạng thái — đọc lại rồi gửi lại') }
    }
    throw err
  }
  return { shared }
}

/** After the commit: a retired shared file stays where it is; only the shortcut in this task folder goes to `_old`. */
async function moveRetiredShortcuts(ctx: Ctx, rows: SharedRetired[], drive: DeliveryDrive, warnings: string[]) {
  let oldFolder: string | null = null
  for (const r of rows) {
    try {
      const shortcut = await drive.findShortcut(ctx.state.folder.id, r.driveFileId)
      if (!shortcut) {
        warnings.push(SHARED_STAYS_WARNING)
        continue
      }
      oldFolder ??= await drive.oldFolder(ctx.orderId, ctx.shopifyLineId)
      await drive.moveFile(shortcut, oldFolder, driveOldFileName(r))
    } catch (err: any) {
      warnings.push(`${r.printArea} v${r.version}: chưa dời được lối tắt sang _old: ${err?.message ?? err}`)
    }
  }
}

async function currentMissing(ctx: Ctx): Promise<string[]> {
  const live = await liveArtworks(ctx.orderId, ctx.shopifyLineId)
  return missingPrintAreas(live, await requiredSlotsForLine(ctx.orderId, ctx.shopifyLineId))
}

async function submitForReview(ctx: Ctx, warnings: string[]): Promise<{ moved: boolean; missing: string[] }> {
  let moved = false
  let reason: string | null = null
  try {
    const r = await submitAutoRenderForReview(ctx.orderId, ctx.shopifyLineId)
    moved = r.moved
    reason = r.reason
  } catch (err: any) {
    reason = err?.message ?? String(err)
  }
  if (moved) return { moved, missing: [] }
  const missing = await currentMissing(ctx)
  if (missing.length === 0 && reason) warnings.push(`Chưa gửi duyệt: ${reason}`)
  return { moved, missing }
}

async function afterPush(ctx: Ctx, warnings: string[]): Promise<string[]> {
  return (await submitForReview(ctx, warnings)).missing
}

/** REJECTED/DOING go back to review once every part is there (owner 11/06, 11/13); REVIEW and DONE keep their status. */
async function afterReplace(ctx: Ctx, warnings: string[]): Promise<string[]> {
  if (!RESUBMIT_AFTER_REPLACE.includes(ctx.state.status)) return currentMissing(ctx)
  const r = await submitForReview(ctx, warnings)
  if (r.moved) {
    await prisma.designTaskEvent.create({ data: { taskId: ctx.taskId, type: 'ARTWORK', message: RESUBMIT_EVENT, actorId: null } })
      .catch((err: any) => { warnings.push(`Chưa ghi được event "${RESUBMIT_EVENT}": ${err?.message ?? err}`) })
  }
  return r.missing
}

// A push whose process died after the rows landed left the task NEW/ASSIGNED; DOING and later mean a person acted since.
async function resubmitLandedPush(task: Task): Promise<string> {
  if (!RESUBMIT_FROM.includes(task.status)) return task.status
  await submitAutoRenderForReview(task.orderId, task.shopifyLineId).catch(err => console.error('delivery: resubmit failed', task.taskKey, err))
  return (await prisma.designTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })).status
}

const ACTIONS: Record<CommitInput['action'], ActionSpec> = {
  push: { plan: planPush, after: afterPush, applied: isAlreadyApplied, resend: resubmitLandedPush },
  replace: { plan: planReplace, after: afterReplace, applied: isAlreadyApplied },
  retire: { plan: planRetire, after: afterReplace, applied: isAlreadyApplied },
  revert: { plan: planRevert, after: currentMissing, applied: isRevertApplied },
}

export async function commitDelivery(taskKey: string, input: CommitInput, drive: DeliveryDrive): Promise<CommitResult | CommitError> {
  const invalid = inputError(input)
  if (invalid) return invalid
  const retire = input.retire ?? []
  const action = ACTIONS[input.action]

  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) return refuse(404, 'not_found', 'Không tìm thấy task')
  const { orderId, shopifyLineId } = task
  if (task.status === 'CANCELLED') return refuse(409, 'closed', 'Task đã huỷ — không nhận file nữa')
  if (!(await isOrderOpen(orderId))) return refuse(409, 'closed', 'Đơn đã giao hoặc đã đóng — không nhận file nữa')
  const line = await prisma.orderLine.findFirst({ where: { orderId, shopifyLineId }, select: LINE_TEMPLATE_FIELDS })
  if (!line) return refuse(409, 'line_syncing', new DeliveryLineMissingError().message)
  const template = await templateForLine(line)
  const slots = allSlotNames(template)
  const files = input.files.map(f => ({ ...f, printArea: slots.find(s => sameLabel(s, f.printArea)) ?? f.printArea }))

  const rows: LineRow[] = await prisma.designArtwork.findMany({
    where: { orderId, shopifyLineId },
    select: { id: true, kind: true, printArea: true, driveFileId: true, removedAt: true, removedById: true, source: true },
  })
  if (action.applied(rows, input)) {
    const status = action.resend && !input.dryRun ? await action.resend(task) : task.status
    const live = await liveArtworks(orderId, shopifyLineId)
    const retired = input.action === 'revert'
      ? rows.filter(r => input.expected.liveIds.includes(r.id) && r.source === 'AUTO').map(r => r.id)
      : retire
    return {
      ok: true, status, artworks: live, retired, warnings: [], alreadyApplied: true,
      missing: status === 'REVIEW' ? [] : missingPrintAreas(live, await requiredSlotsForLine(orderId, shopifyLineId)),
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

  const duplicate = duplicateFileError(state, files)
  if (duplicate) return duplicate

  const ctx: Ctx = { taskId: task.id, orderId, shopifyLineId, input, files, state, template, now: new Date() }
  const planned = action.plan(ctx)
  if ('ok' in planned) return planned
  const retiredIds = planned.retire.map(r => r.id)
  const remaining = state.artworks.filter(a => !retiredIds.includes(a.id))

  const driveError = await driveFileError(files, state, task, drive)
  if (driveError) return driveError
  const view = templateViewFor(template, [...remaining, ...files])
  const layout = layoutCheck(template, view, files, ctx.now)
  if (layout.error) return layout.error
  const warnings = [...layout.warnings]

  if (input.dryRun) {
    const wouldBe: Artwork[] = [
      ...remaining.map(a => ({ id: a.id, kind: a.kind, printArea: a.printArea, version: a.version, driveFileId: a.driveFileId })),
      ...planned.inserts.map(f => ({ id: null, kind: f.kind, printArea: f.printArea, version: f.version, driveFileId: f.driveFileId })),
    ]
    return { ok: true, status: state.status, artworks: wouldBe, retired: retiredIds, missing: missingFor(ctx.template, wouldBe), warnings, alreadyApplied: false }
  }

  const written = await writePlan(ctx, planned, drive)
  if ('error' in written) return written.error

  await moveRetiredShortcuts(ctx, written.shared, drive, warnings)
  const missing = await action.after(ctx, warnings)
  try {
    await drive.tidy(orderId, shopifyLineId)
  } catch (err: any) {
    warnings.push(`Chưa xếp được file vào thư mục task: ${err?.message ?? err} — lượt dọn định kỳ làm lại`)
  }
  const after = await prisma.designTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })
  return { ok: true, status: after.status, artworks: await liveArtworks(orderId, shopifyLineId), retired: retiredIds, missing, warnings, alreadyApplied: false }
}
