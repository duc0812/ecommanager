import { prisma } from '@/lib/db'
import { AUTO_REVIEW_FROM, requiredSlotsFor, requiredSlotsForLine, submitAutoRenderForReview, templateForLine } from '@/lib/design-tasks'
import { isOrderOpen } from '@/lib/design-agent/order-open'
import { driveFileViewUrl } from '@/lib/google-drive'
import { allSlotNames, templateViewFor, type TemplateRow } from '@/lib/print-template-resolve'
import type { TidyResult } from '@/lib/task-folder'
import { isUniqueViolation } from '@/lib/sqlite-busy'
import { driveFileName, driveOldFileName, missingPrintAreas, sameLabel } from '@/lib/task-files'
import { DriveTimeoutError, type DeliveryDrive } from '@/lib/delivery/drive'
import { DeliveryLineMissingError, deliveryTaskState } from '@/lib/delivery/task-state'
import type { CommitError, CommitInput, CommitResult, TaskState } from '@/lib/delivery/types'
import {
  driveBusyRefusal, driveFileError, duplicateFileError, inDesignLibrary, inputError, isAlreadyApplied, isStale, layoutCheck, refuse, sameIds, slotWarnings,
  staleRefusal,
} from '@/lib/delivery/commit-checks'
import { RESUBMIT_EVENT, pushEventMessage } from '@/lib/delivery/commit-text'
import { isRevertApplied, nextVersionFor, planReplace, planRetire, planRevert, type Ctx, type Plan } from '@/lib/delivery/commit-replace'

type Artwork = CommitResult['artworks'][number]

type LineRow = { id: string; kind: string; printArea: string; driveFileId: string | null; removedAt: Date | null; removedById: string | null; source: string }

type RetiredRow = { kind: string; printArea: string; version: number; fileName: string; driveFileId: string }

/** What the commit left to do on Drive for the rows it retired. */
type RetiredDrive = {
  shortcuts: (RetiredRow & { shortcutId: string })[]
  stays: RetiredRow[]
  lookupFailed: (RetiredRow & { error: string })[]
  toShare: RetiredRow[]
}

type ShortcutLookup = { shortcutId: string | null; failed: string | null }

type Task = { id: string; taskKey: string; status: string; orderId: string; shopifyLineId: string }

type ActionSpec = {
  plan: (ctx: Ctx) => CommitError | Plan
  after: (ctx: Ctx, warnings: string[]) => Promise<string[]>
  applied: (rows: LineRow[], input: CommitInput, taskStatus: string) => boolean
  /** Runs on an already-applied resend that is not a dryRun; returns the task status afterwards. */
  resend?: (task: Task) => Promise<string>
}

class StaleWrite extends Error {}

const RESUBMIT_FROM = ['NEW', 'ASSIGNED']
const RESUBMIT_AFTER_REPLACE = ['DOING', 'REJECTED']
const SHARED_STAYS_WARNING = 'File dùng chung vẫn nằm trong thư mục task'
const sharedStaysEvent = (r: RetiredRow) => `File dùng chung ${r.printArea} v${r.version} vẫn nằm trong thư mục task — cần dọn tay khi các dòng khác xong`
const shortcutStuckEvent = (r: RetiredRow) => `Không dời được lối tắt file cũ ${r.printArea} v${r.version} — cần dọn tay`

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
 * A retired file that another line ever used (live or removed) may be a shortcut here or the original other lines point at, so
 * this task folder is asked for a shortcut to it before the transaction decides where the row lives.
 */
async function lookupShortcuts(ctx: Ctx, plan: Plan, drive: DeliveryDrive): Promise<Map<string, ShortcutLookup>> {
  const { orderId, shopifyLineId, state } = ctx
  const found = new Map<string, ShortcutLookup>()
  for (const r of plan.retire) {
    if (!r.driveFileId) continue
    const elsewhere = await prisma.designArtwork.findFirst({ where: { driveFileId: r.driveFileId, NOT: { orderId, shopifyLineId } }, select: { id: true } })
    if (!elsewhere && !(await inDesignLibrary(r.driveFileId))) continue
    try {
      found.set(r.id, { shortcutId: await drive.findShortcut(state.folder.id, r.driveFileId), failed: null })
    } catch (err: any) {
      if (err instanceof DriveTimeoutError) throw err
      found.set(r.id, { shortcutId: null, failed: err?.message ?? String(err) })
    }
  }
  return found
}

/**
 * Shortcuts first (their rows say TASK), then one transaction that re-checks the task it planned against, so a second writer gets
 * `stale`. A retired row goes to drivePlace NULL so tidy (now or the periodic pass) moves its own file to `_old`, unless the file
 * may belong to other lines: a shortcut here (moved after the commit), an original other lines still print from, or a lookup
 * that failed all get 'OLD' so tidy never moves the original.
 */
async function writePlan(ctx: Ctx, plan: Plan, drive: DeliveryDrive): Promise<{ error: CommitError } | { retired: RetiredDrive }> {
  const { orderId, shopifyLineId, state, now } = ctx
  const created: string[] = []
  let retired: RetiredDrive = { shortcuts: [], stays: [], lookupFailed: [], toShare: [] }
  try {
    for (const f of plan.inserts.filter(x => x.shortcutOf)) {
      const existing = await drive.findShortcut(state.folder.id, f.shortcutOf as string)
      if (!existing) created.push(await drive.createShortcut(f.shortcutOf as string, state.folder.id, driveFileName(f)))
    }
    const lookups = await lookupShortcuts(ctx, plan, drive)
    retired = await prisma.$transaction(async tx => {
      const guard = await tx.designTask.updateMany({
        where: { id: ctx.taskId, status: state.status, ...(plan.guardReadiness ? { readiness: plan.guardReadiness } : {}) },
        data: { updatedAt: now, ...(plan.task ?? {}) },
      })
      if (guard.count === 0) throw new StaleWrite()
      const live = await tx.designArtwork.findMany({ where: { orderId, shopifyLineId, removedAt: null }, select: { id: true } })
      if (!sameIds(live.map(r => r.id), state.artworks.map(a => a.id))) throw new StaleWrite()
      const out: RetiredDrive = { shortcuts: [], stays: [], lookupFailed: [], toShare: [] }
      const notes: string[] = []
      for (const r of plan.retire) {
        const row = await tx.designArtwork.findUnique({
          where: { id: r.id }, select: { kind: true, printArea: true, version: true, fileName: true, driveFileId: true, storage: true },
        })
        if (!row) throw new StaleWrite()
        const look = lookups.get(r.id)
        const file = { ...row, driveFileId: row.driveFileId as string }
        let place: 'OLD' | null = null
        if (look?.shortcutId) {
          place = 'OLD'
          out.shortcuts.push({ ...file, shortcutId: look.shortcutId })
        } else if (look?.failed) {
          place = 'OLD'
          out.lookupFailed.push({ ...file, error: look.failed })
          notes.push(shortcutStuckEvent(file))
        } else if (await tx.designArtwork.count({ where: { driveFileId: row.driveFileId, removedAt: null, NOT: { orderId, shopifyLineId } } }) > 0) {
          place = 'OLD'
          out.stays.push(file)
          notes.push(sharedStaysEvent(file))
        } else if (row.storage === 'DRIVE' && row.driveFileId) {
          out.toShare.push(file)
        }
        const done = await tx.designArtwork.updateMany({
          where: { id: r.id, orderId, shopifyLineId, removedAt: null },
          data: { removedAt: now, removedById: null, drivePlace: place },
        })
        if (done.count !== 1) throw new StaleWrite()
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
      for (const message of notes) await tx.designTaskEvent.create({ data: { taskId: ctx.taskId, type: 'SYSTEM', message, actorId: null, createdAt: now } })
      return out
    })
  } catch (err) {
    await removeShortcuts(created, drive)
    if (err instanceof DriveTimeoutError) return { error: driveBusyRefusal(err) }
    if (err instanceof StaleWrite || isUniqueViolation(err)) {
      const current = await deliveryTaskState(state.taskKey, drive).catch(() => null)
      return { error: current ? staleRefusal(current) : refuse(409, 'stale', 'Task đã đổi từ lúc máy đọc trạng thái — đọc lại rồi gửi lại') }
    }
    throw err
  }
  return { retired }
}

/**
 * After the commit, before tidy: this line's shortcuts go to `_old`; each file tidy will move to the unshared `_old` gets its own
 * "anyone, reader" first so a factory's per-file link keeps working. Drive failures are warnings (and a task event for a shortcut).
 */
async function finishRetiredOnDrive(ctx: Ctx, retired: RetiredDrive, drive: DeliveryDrive, warnings: string[]) {
  let oldFolder: string | null = null
  for (const r of retired.shortcuts) {
    try {
      oldFolder ??= await drive.oldFolder(ctx.orderId, ctx.shopifyLineId)
      await drive.moveFile(r.shortcutId, oldFolder, driveOldFileName(r))
    } catch (err: any) {
      warnings.push(`${r.printArea} v${r.version}: chưa dời được lối tắt sang _old: ${err?.message ?? err}`)
      await prisma.designTaskEvent.create({ data: { taskId: ctx.taskId, type: 'SYSTEM', message: shortcutStuckEvent(r), actorId: null } })
        .catch(e => console.error('delivery: shortcut event failed', ctx.state.taskKey, e))
    }
  }
  if (retired.stays.length) warnings.push(SHARED_STAYS_WARNING)
  for (const r of retired.lookupFailed) warnings.push(`${r.printArea} v${r.version}: không hỏi được Drive về lối tắt (${r.error}) — giữ nguyên file, cần dọn tay`)
  for (const r of retired.toShare) {
    await drive.shareAnyoneReader(r.driveFileId)
      .catch((err: any) => { warnings.push(`${r.printArea} v${r.version}: chưa chia sẻ được file cũ trước khi dời sang _old: ${err?.message ?? err}`) })
  }
}

function tidyWarnings(r: TidyResult | void): string[] {
  if (!r) return []
  const out: string[] = []
  if (r.failed > 0) out.push(`Chưa xếp được ${r.failed} file vào thư mục task${r.lastError ? `: ${r.lastError}` : ''} — lượt dọn định kỳ làm lại`)
  if (r.stuck > 0) out.push(`${r.stuck} file Drive không cho chuyển (403/404) — giữ nguyên chỗ cũ, cần xem tay`)
  return out
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
  const rows: LineRow[] = await prisma.designArtwork.findMany({
    where: { orderId, shopifyLineId },
    select: { id: true, kind: true, printArea: true, driveFileId: true, removedAt: true, removedById: true, source: true },
  })
  if (action.applied(rows, input, task.status)) {
    // A resend may land after the order closed: it is still answered as applied, but a closed line is never resubmitted.
    const open = task.status !== 'CANCELLED' && await isOrderOpen(orderId)
    const status = action.resend && !input.dryRun && open ? await action.resend(task) : task.status
    const live = await liveArtworks(orderId, shopifyLineId)
    const retired = input.action === 'revert'
      ? rows.filter(r => input.expected.liveIds.includes(r.id) && r.source === 'AUTO').map(r => r.id)
      : retire
    return {
      ok: true, status, artworks: live, retired, warnings: [], alreadyApplied: true,
      missing: status === 'REVIEW' ? [] : missingPrintAreas(live, await requiredSlotsForLine(orderId, shopifyLineId)),
    }
  }

  if (task.status === 'CANCELLED') return refuse(409, 'closed', 'Task đã huỷ — không nhận file nữa')
  if (!(await isOrderOpen(orderId))) return refuse(409, 'closed', 'Đơn đã giao hoặc đã đóng — không nhận file nữa')
  const line = await prisma.orderLine.findFirst({ where: { orderId, shopifyLineId }, select: LINE_TEMPLATE_FIELDS })
  if (!line) return refuse(409, 'line_syncing', new DeliveryLineMissingError().message)
  const template = await templateForLine(line)
  const slots = allSlotNames(template)
  const files = input.files.map(f => ({ ...f, printArea: slots.find(s => sameLabel(s, f.printArea)) ?? f.printArea }))

  let state: TaskState | null
  try {
    state = await deliveryTaskState(taskKey, drive)
  } catch (err) {
    if (err instanceof DeliveryLineMissingError) return refuse(409, 'line_syncing', err.message)
    if (err instanceof DriveTimeoutError) return driveBusyRefusal(err)
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

  let driveError: CommitError | null
  try {
    driveError = await driveFileError(files, state, task, drive)
  } catch (err) {
    if (err instanceof DriveTimeoutError) return driveBusyRefusal(err)
    throw err
  }
  if (driveError) return driveError
  const view = templateViewFor(template, [...remaining, ...files])
  const layout = layoutCheck(template, view, files, ctx.now)
  if (layout.error) return layout.error
  const warnings = [...slotWarnings(template, slots, files), ...layout.warnings]

  if (input.dryRun) {
    const wouldBe: Artwork[] = [
      ...remaining.map(a => ({ id: a.id, kind: a.kind, printArea: a.printArea, version: a.version, driveFileId: a.driveFileId })),
      ...planned.inserts.map(f => ({ id: null, kind: f.kind, printArea: f.printArea, version: f.version, driveFileId: f.driveFileId })),
    ]
    return { ok: true, status: planned.task?.status ?? state.status, artworks: wouldBe, retired: retiredIds, missing: missingFor(ctx.template, wouldBe), warnings, alreadyApplied: false }
  }

  const written = await writePlan(ctx, planned, drive)
  if ('error' in written) return written.error

  await finishRetiredOnDrive(ctx, written.retired, drive, warnings)
  const missing = await action.after(ctx, warnings)
  try {
    warnings.push(...tidyWarnings(await drive.tidy(orderId, shopifyLineId)))
  } catch (err: any) {
    warnings.push(`Chưa xếp được file vào thư mục task: ${err?.message ?? err} — lượt dọn định kỳ làm lại`)
  }
  const after = await prisma.designTask.findUniqueOrThrow({ where: { id: task.id }, select: { status: true } })
  return { ok: true, status: after.status, artworks: await liveArtworks(orderId, shopifyLineId), retired: retiredIds, missing, warnings, alreadyApplied: false }
}
