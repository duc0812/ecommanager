import { printCutCheck } from '@/lib/print-cut'
import { prisma } from '@/lib/db'
import { rejectReasonsError } from '@/lib/reject-reasons'
import { isNonProductLine, lineKeysOf, planTaskKeys, type KeyedTask, type TaskKeyMove } from '@/lib/order-lines'
import {
  artworkUrl, linePersonalization, linkedPrintFiles, parseAttributes, safeHttpUrl, sourcePrintFiles, updateLine, loadWorkspace,
  type PersonalizationField, type SourcePrintFile, type WorkspaceLine, type Workspace,
} from '@/lib/design-studio'
import { extractPreviewCdnUrl } from '@/lib/order-line-assets'
import { fillCustomallFields } from '@/lib/customall-fields'
import { getDesignSettings, kpiForProductType, type DesignSettings } from '@/lib/design-settings'
import { visibleCustomAttributes } from '@/lib/order-classify'
import { findProfile, parseLayerMap, toRouteKey, type LayerMapEntry } from '@/lib/product-profiles'
import { allSlotNames, loadTemplateContext, mapTemplate, pickTemplate, templateViewFor, type TemplateLookupLine, type TemplateRow } from '@/lib/print-template-resolve'
import { productArtworkStatus } from '@/lib/artwork-slots'
import type { LibraryProductStatus } from '@/lib/artwork-fields'
import { isDriveConnected } from '@/lib/google-drive'
import { checklistLibraryState, libraryStateFor, readLocalEntries } from '@/lib/artwork-library-state'
import type { TaskLibraryState } from '@/lib/artwork-library-types'
import type { RenderJobView } from '@/lib/artwork-render-eligibility'
import { latestRenderJob } from '@/lib/artwork-render-jobs'
import { canApproveDesign, canEditDesignNote, canHandoffToSupplier, isLeaderRole, type FeaturePermission } from '@/lib/roles'
import { ACTIVE_PUSH_STATUSES, activePushByOrder, carriedShopifyLineIds } from '@/lib/repos/push-export'
import type { HandoffPush } from '@/lib/handoff-shared'
import { autoRenderEligibility, hasTeeinblueDesign } from '@/lib/artwork-render-eligibility'
import { autoFromLocalLibrary } from '@/lib/flat-text-coverage'
import { APP_FILE_PREFIX, DESIGN_LINK_SEPARATOR, isAppFileLink } from '@/lib/design-links'
import { saveStudioDesignToLibrary } from '@/lib/studio-library'
import { MISSING_AREAS_PREFIX, missingPrintAreas, outdatedParts, printFilesReady } from '@/lib/task-files'
import { exportedSupplierOf, isLineExported } from '@/lib/line-export'
import { isUniqueViolation, retryOnBusy } from '@/lib/sqlite-busy'
import {
  LINE_FIX_EVENT_PREFIX, LINE_FIX_REASONS, FIX_NOT_IN_FOLDER_MESSAGE, heldLinkMessage, lineFixMessage, parseLineFix, readHeldLinkMessage, readLineFixMessage, readSupplierLinkKind,
  supplierLinkMessage, type LineFix, type LineFixReason, type SupplierLinkKind,
} from '@/lib/line-fix'
import { cancelQueuedJobsForTask, enqueueFixOnReject, queueLibraryApplyOnApproval } from '@/lib/design-agent/jobs'

export { loadTemplateContext, mapTemplate, pickTemplate, type TemplateRow }

export type TaskStatus = 'NEW' | 'ASSIGNED' | 'DOING' | 'REVIEW' | 'REJECTED' | 'ASK_CUSTOMER' | 'DONE' | 'CANCELLED'
export type Readiness = 'AUTO' | 'LOW' | 'MANUAL'
export type ActorRole = 'LEADER' | 'DESIGNER'
export const TASK_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER', 'DONE', 'CANCELLED']
const OPEN: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']
export const FACTORY_REJECT_REASON = 'Xưởng trả file'
const FACTORY_REOPEN_MESSAGE = 'Xưởng trả file — mở lại task'
/** A task sent back after its line went to the supplier: by the order (Design Rejected) or one line at a time (LINE_FIX_REASONS, client-shared in line-fix.ts). */
export const SENT_BACK_REASONS: string[] = [FACTORY_REJECT_REASON, ...LINE_FIX_REASONS]
/** What "Sửa & gửi lại" wrote on a DONE task before a line already sent asked for a reason (#LIT5105). */
const OLD_REOPEN_MESSAGE = 'Mở lại để sửa'
/**
 * A fix approved for a line its supplier got by a link: someone tells the supplier to look again, or sends it the new link
 * (the message says which, supplierLinkMessage); SUPPLIER_TOLD records that it was done.
 */
export const SUPPLIER_RECHECK = 'SUPPLIER_RECHECK'
export const SUPPLIER_TOLD = 'SUPPLIER_TOLD'
const TOLD_VISIBLE_DAYS = 14
/** One line sent back by "Mở lại để sửa": the factory-return state with its own reason and note. */
function lineFixReopen(fix: LineFix) {
  return { status: 'REJECTED', rejectReasons: JSON.stringify([fix.reason]), rejectNote: fix.note, prevStatus: null, fromLibrary: false }
}
export const APPROVE_MESSAGE = 'Duyệt design'

export function isLeader(role: string): boolean {
  return isLeaderRole(role)
}

/** canApprove is the REVIEW → DONE / REJECTED capability; it defaults to leader-only. Nothing reaches DONE except from REVIEW. */
export function canTransition(from: TaskStatus, to: TaskStatus, actor: ActorRole, canApprove: boolean = actor === 'LEADER'): boolean {
  if (from === to) return false
  if (from === 'CANCELLED') return false
  if (to === 'ASK_CUSTOMER') return OPEN.includes(from)
  if (to === 'CANCELLED') return actor === 'LEADER' && [...OPEN, 'ASK_CUSTOMER'].includes(from)
  switch (to) {
    case 'ASSIGNED': return actor === 'LEADER' && (from === 'NEW' || from === 'DOING' || from === 'REJECTED')
    case 'NEW': return from === 'ASSIGNED'
    case 'DOING': return from === 'NEW' || from === 'ASSIGNED' || from === 'DONE' || from === 'REJECTED'
    case 'REVIEW': return from === 'DOING' || from === 'REJECTED'
    case 'DONE': return canApprove && from === 'REVIEW'
    case 'REJECTED': return canApprove && from === 'REVIEW'
    default: return false
  }
}

type ReadinessLine = TemplateLookupLine & {
  sku: string | null; variantTitle?: string | null; customAttributesJson: string | null; customallFieldsJson?: string | null; variantOptions: string | null
}

/**
 * True when the line resolves to a READY artwork-library entry for a single-area template and the customer filled every field it renders.
 * Owner 11-04: the library on the office PC holds the state and an agent stamps it here (scripts/sync-library-state.py), so a new order is labelled
 * as soon as it arrives, flat-text specs included. Those render on that PC when someone processes orders; prod's own job queue still needs an entry on this server.
 */
export async function canAutoRenderLine(line: ReadinessLine, storeId: string, orderNumber: string): Promise<boolean> {
  if (!line.shopifyProductId || !line.resolvedSupplierId) return false
  const attrs = parseAttributes(line.customAttributesJson)
  if (hasTeeinblueDesign(attrs)) return false
  const profile = await findProfile(storeId, line.shopifyProductId)
  const template = await templateForLine(line, profile)
  if (!template) return false
  const slots = requiredSlotsFor(template)
  const personalization = linePersonalization({ previewCdnUrl: null, customAttributesJson: line.customAttributesJson, customallFieldsJson: line.customallFieldsJson ?? null })
  const local = (await readLocalEntries() ?? []).filter(e => e.storeId === storeId && e.shopifyProductId === line.shopifyProductId && e.printTemplateId === template.id)
  if (local.length > 0 && autoFromLocalLibrary(local, {
    sku: line.sku, supplierSku: line.resolvedSupplierSku, variantTitle: line.variantTitle ?? null, orderNumber,
    variantOptions: line.variantOptions, artworkSplits: profile?.artworkSplits ?? null, templateId: template.id,
    personalization: [...personalization, ...parseAttributes(line.customallFieldsJson ?? null)],
  })) return true
  if (slots.length !== 1) return false
  const library = await libraryStateFor({
    storeId, shopifyProductId: line.shopifyProductId, templateId: template.id,
    variantOptions: line.variantOptions, artworkSplits: profile?.artworkSplits ?? null,
  })
  return autoRenderEligibility({ taskStatus: 'NEW', hasTemplate: true, slots, library, personalization, job: null }).ok
}

export async function readinessForLine(line: ReadinessLine, storeId: string, orderNumber: string): Promise<Readiness> {
  if (await canAutoRenderLine(line, storeId, orderNumber)) return 'AUTO'
  return sourcePrintFiles(parseAttributes(line.customAttributesJson)).length > 0 ? 'LOW' : 'MANUAL'
}

const READINESS_REFRESH: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REJECTED']
/** A link from outside the studio closes a task only while nobody has started on it. */
const AUTO_COMPLETE_FROM: TaskStatus[] = ['NEW', 'ASSIGNED']
const STUDIO_MOVED: TaskStatus[] = ['DOING', 'REVIEW', 'REJECTED', 'DONE']
/** Orders not sent yet. Only these get a task for a library or unmapped line, so turning that on does not add tasks to old orders. */
const TASK_FOR_EVERY_LINE: string[] = ['PENDING_DESIGN', 'PENDING_MAPPING', 'READY_TO_PRODUCTION']
const HUMAN_MOVE_EVENTS = ['STATUS', 'REJECT']

async function linesWithArtwork(orderId: string): Promise<Set<string>> {
  // A mockup the system filled in says nothing about who made the design.
  const rows = await prisma.designArtwork.findMany({ where: { orderId, removedAt: null, NOT: { kind: 'MOCKUP', source: 'AUTO' } }, select: { shopifyLineId: true }, distinct: ['shopifyLineId'] })
  return new Set(rows.map(r => r.shopifyLineId))
}

/** A mockup the system added goes in the task log. The file is already stored, so a failed log line never fails it. */
export async function logAutoMockup(orderId: string, shopifyLineId: string, message: string): Promise<void> {
  try {
    const task = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } }, select: { id: true } })
    if (task) await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'ARTWORK', message } })
  } catch (err: any) {
    console.error('[design tasks] mockup log failed:', err?.message ?? err)
  }
}

/**
 * Lines Design Studio owns (by shopifyLineId): a file was uploaded, or a person moved the task to DOING / REVIEW / REJECTED / DONE.
 * A Trello or library link must not overwrite them. A system move (factory reopen, done outside) does not count.
 */
export async function studioOwnedLines(orderId: string): Promise<Set<string>> {
  const [withArtwork, moved] = await Promise.all([
    linesWithArtwork(orderId),
    prisma.designTask.findMany({
      where: { orderId, status: { in: STUDIO_MOVED }, events: { some: { actorId: { not: null }, type: { in: HUMAN_MOVE_EVENTS } } } },
      select: { shopifyLineId: true },
    }),
  ])
  for (const t of moved) withArtwork.add(t.shopifyLineId)
  return withArtwork
}

/** SLA runs from the order date; a task created after that deadline (backlog, late mapping) gets a full SLA from now instead of being born overdue. */
export function dueForNewTask(placedAt: Date, slaHours: number, now = Date.now()): Date {
  const fromOrder = placedAt.getTime() + slaHours * 3600_000
  return new Date(fromOrder > now ? fromOrder : now + slaHours * 3600_000)
}

export const SHIPPED_WITHOUT_FILE_REASON = 'Đơn đã fulfilled nhưng dòng chưa có file'
export const SHIPPED_WITHOUT_FILE_NOTE = 'Shopify đã báo giao cả đơn nhưng dòng này chưa có file in. Kiểm tra với xưởng xem sản phẩm đã được làm chưa.'

export type SyncResult = { created: number; cancelled: number; completed: number; reopened: number }

function isClosedOrder(o: { pipelineStatus: string }): boolean {
  return ['CANCELLED', 'REFUNDED'].includes(o.pipelineStatus)
}

function isShippedOrder(o: { pipelineStatus: string; fulfillmentStatus: string | null }): boolean {
  return o.pipelineStatus === 'FULFILLED' || (o.fulfillmentStatus ?? '').toLowerCase() === 'fulfilled'
}

/** An order handed to production counts as sent even when its lines carry no export mark of their own. */
const SENT_ORDER_STATUSES = ['EXPORTED', 'READY_TO_PRODUCTION']

function isSentLine(o: { pipelineStatus: string }, line: { exportedAt: Date | null }): boolean {
  return !!line.exportedAt || SENT_ORDER_STATUSES.includes(o.pipelineStatus)
}

function reopenedByFactory(task: { rejectReasons: string | null }): boolean {
  return parseRejectReasons(task.rejectReasons).some(r => SENT_BACK_REASONS.includes(r))
}

/** Nobody ever touched the task: NEW, unassigned, no Drive folder, system events only. Files are checked apart: they belong to the line. */
const UNTOUCHED = { status: 'NEW', assigneeId: null, driveFolderId: null, driveFolderUrl: null, events: { every: { type: 'SYSTEM' } } }

async function untouchedTasks(orderId: string, taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set()
  const [tasks, files] = await Promise.all([
    prisma.designTask.findMany({ where: { id: { in: taskIds }, ...UNTOUCHED }, select: { id: true, shopifyLineId: true } }),
    prisma.designArtwork.findMany({ where: { orderId }, select: { shopifyLineId: true }, distinct: ['shopifyLineId'] }),
  ])
  const withFile = new Set(files.map(f => f.shopifyLineId))
  return new Set(tasks.filter(t => !withFile.has(t.shopifyLineId)).map(t => t.id))
}

const KEY_MOVE_REASON: Record<TaskKeyMove['why'], string> = {
  LINE_KEY: 'theo mã line của đơn',
  NOT_A_PRODUCT: 'dòng không phải sản phẩm, nhường mã cho dòng sản phẩm',
  LINE_GONE: 'dòng không còn trong đơn, nhường mã cho dòng sản phẩm',
}

/**
 * The owner's rule since 2026-10-29: a task's key is its line key (planTaskKeys says what moves). One transaction, through
 * temporary keys since an order's old and new keys overlap (`_2,_3 → _1,_2`). Every write is a compare-and-set on the
 * `updatedAt` the sync read: a task changed since then keeps its key until the next sync, and so does any move that needed
 * that key. `updatedAt` is written back: a CSV save compares it with the approval time. A key held in another order leaves
 * this order as it is, with a warning. The Drive folder keeps its old name until scripts/rename-task-folders.mjs runs.
 */
async function followLineKeys(
  order: { id: string; shopifyOrderNumber: string; lines: Array<{ shopifyLineId: string }> },
  keys: Map<string, string>,
  tasks: Array<KeyedTask & { updatedAt: Date }>,
): Promise<void> {
  if (tasks.every(t => keys.get(t.shopifyLineId) === t.taskKey)) return
  const lineIds = new Set(order.lines.map(l => l.shopifyLineId))
  const untouched = await untouchedTasks(order.id, tasks.filter(t => !keys.has(t.shopifyLineId) && lineIds.has(t.shopifyLineId)).map(t => t.id))
  const plan = planTaskKeys(keys, lineIds, tasks.map(t => ({ ...t, untouched: untouched.has(t.id) })))
  if (plan.remove.length === 0 && plan.moves.length === 0) return
  const elsewhere = await prisma.designTask.findMany({
    where: { taskKey: { in: plan.moves.map(m => m.to) }, orderId: { not: order.id } },
    select: { taskKey: true, order: { select: { shopifyOrderNumber: true } } },
  })
  if (elsewhere.length > 0) {
    const others = Array.from(new Set(elsewhere.map(t => t.order.shopifyOrderNumber))).join(', ')
    console.warn(`[design tasks] ${order.shopifyOrderNumber}: mã ${elsewhere.map(t => t.taskKey).join(', ')} đang thuộc task của đơn ${others} — giữ nguyên mã task của đơn này`)
    return
  }
  const readAt = new Map(tasks.map(t => [t.id, t.updatedAt]))
  const asRead = (id: string) => ({ id, updatedAt: readAt.get(id) })
  await prisma.$transaction(async tx => {
    if (plan.remove.length) await tx.designTask.deleteMany({ where: { OR: plan.remove.map(asRead), ...UNTOUCHED } })
    let parked: TaskKeyMove[] = []
    const stayed = [...plan.remove]
    for (const m of plan.moves) {
      const r = await tx.designTask.updateMany({ where: { ...asRead(m.id), taskKey: m.from }, data: { taskKey: `~${m.id}`, updatedAt: readAt.get(m.id) } })
      if (r.count === 1) parked.push(m)
      else stayed.push(m.id)
    }
    // Keys still held this run: by a task the delete left, or one changed since it was read. A move into one waits, and gives its own key back.
    const held = new Set((await tx.designTask.findMany({ where: { id: { in: stayed } }, select: { taskKey: true } })).map(t => t.taskKey))
    for (let blocked = parked.filter(m => held.has(m.to)); blocked.length > 0; blocked = parked.filter(m => held.has(m.to))) {
      for (const m of blocked) {
        await tx.designTask.update({ where: { id: m.id }, data: { taskKey: m.from, updatedAt: readAt.get(m.id) } })
        held.add(m.from)
      }
      parked = parked.filter(m => !blocked.includes(m))
    }
    for (const m of parked) {
      await tx.designTask.update({ where: { id: m.id }, data: {
        taskKey: m.to, updatedAt: readAt.get(m.id),
        events: { create: { type: 'SYSTEM', message: `Đổi mã task ${m.from} → ${m.to} (${KEY_MOVE_REASON[m.why]})` } },
      } })
    }
  })
}

export async function syncDesignTasks(orderId: string): Promise<SyncResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true, designTasks: true } })
  if (!order) return { created: 0, cancelled: 0, completed: 0, reopened: 0 }
  const settings = await getDesignSettings()
  const supplierIds = Array.from(new Set(order.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[]))
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : []
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))
  const orderClosed = isClosedOrder(order)
  const orderShipped = isShippedOrder(order)
  const factoryRejected = order.pipelineStatus === 'DESIGN_REJECTED'
  let created = 0, cancelled = 0, completed = 0, reopened = 0
  const withArtwork = await linesWithArtwork(orderId)
  const keys = lineKeysOf(order.shopifyOrderNumber, order.lines)
  // The key sweep never fails the rest of the sync: whatever it could not do waits for the next one.
  await followLineKeys(order, keys, order.designTasks)
    .catch((err: any) => console.warn(`[design tasks] ${order.shopifyOrderNumber}: chưa đổi được mã task — ${err?.message ?? err}`))
  const factoryReopen = { status: 'REJECTED', rejectReasons: JSON.stringify([FACTORY_REJECT_REASON]), rejectNote: null, prevStatus: null }
  const factoryEvent = { type: 'SYSTEM', message: FACTORY_REOPEN_MESSAGE }

  const everyLine = TASK_FOR_EVERY_LINE.includes(order.pipelineStatus)

  for (const line of order.lines) {
    if (isNonProductLine(line)) continue
    const existing = order.designTasks.find(t => t.shopifyLineId === line.shopifyLineId)
    if (!line.resolvedSupplierId && !existing && (!everyLine || line.exportedAt)) continue
    if (orderClosed || orderShipped) {
      if (existing && existing.status !== 'CANCELLED' && existing.status !== 'DONE') {
        // A fulfilled order does not prove this line was made: one supplier's tracking can close the whole order. An export mark without a file proves nothing either (LIT4981).
        const hasFile = withArtwork.has(line.shopifyLineId) || !!line.designDriveLink || !!order.trelloCardUrl
        if (!orderClosed && !hasFile) {
          if (existing.status !== 'REJECTED') {
            await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'REJECTED', rejectReasons: JSON.stringify([SHIPPED_WITHOUT_FILE_REASON]), rejectNote: SHIPPED_WITHOUT_FILE_NOTE, events: { create: { type: 'SYSTEM', message: `${SHIPPED_WITHOUT_FILE_REASON} — giữ task mở` } } } })
            reopened++
          }
          continue
        }
        const message = orderClosed ? 'Đơn huỷ — task tự huỷ' : 'Đơn đã fulfilled — task tự huỷ'
        await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'CANCELLED', events: { create: { type: 'SYSTEM', message } } } })
        cancelled++
      }
      continue
    }
    if (factoryRejected && existing) {
      if (existing.status === 'DONE') {
        await prisma.designTask.update({ where: { id: existing.id }, data: { ...factoryReopen, events: { create: factoryEvent } } })
        reopened++
      }
      continue
    }
    if (line.designDriveLink) {
      if (existing?.fromLibrary) {
        // Someone sent the line before the scan ran: there is nothing left to attach for.
        if (line.exportedAt && AUTO_COMPLETE_FROM.includes(existing.status as TaskStatus)) {
          await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'DONE', events: { create: { type: 'SYSTEM', message: 'Dòng đã gửi xưởng trước khi quét thư viện' } } } })
          completed++
        }
        continue
      }
      if (!existing && !factoryRejected && everyLine && !line.exportedAt) {
        const slaHours = settings.slaNonCustomHours
        await prisma.designTask.create({ data: {
          orderId, shopifyLineId: line.shopifyLineId, taskKey: keys.get(line.shopifyLineId)!, status: 'NEW', fromLibrary: true, kpi: 0, slaHours, dueAt: null,
          readiness: await readinessForLine(line, order.storeId, order.shopifyOrderNumber),
          supplierSnapshot: line.resolvedSupplierId ? (supplierName.get(line.resolvedSupplierId) ?? null) : null,
          events: { create: { type: 'SYSTEM', message: 'Có sẵn trong thư viện — chờ quét để gắn bản in' } },
        } })
        created++
        continue
      }
      if (existing && AUTO_COMPLETE_FROM.includes(existing.status as TaskStatus) && !withArtwork.has(line.shopifyLineId) && !reopenedByFactory(existing)) {
        await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'DONE', events: { create: { type: 'SYSTEM', message: 'Design có từ ngoài studio (Trello / Library) — task done outside' } } } })
        completed++
      }
      if (!factoryRejected) continue
    }
    if (existing) {
      if (READINESS_REFRESH.includes(existing.status as TaskStatus)) {
        const readiness = await readinessForLine(line, order.storeId, order.shopifyOrderNumber)
        if (readiness !== existing.readiness) await prisma.designTask.update({ where: { id: existing.id }, data: { readiness } })
      }
      // A line mapped after its task was made.
      if (!existing.supplierSnapshot && line.resolvedSupplierId && supplierName.get(line.resolvedSupplierId)) {
        await prisma.designTask.update({ where: { id: existing.id }, data: { supplierSnapshot: supplierName.get(line.resolvedSupplierId) } })
      }
      continue
    }
    const slaHours = line.customized ? settings.slaCustomHours : settings.slaNonCustomHours
    const reopenNew = factoryRejected && !!line.designDriveLink
    await prisma.designTask.create({ data: {
      orderId, shopifyLineId: line.shopifyLineId, taskKey: keys.get(line.shopifyLineId)!,
      status: 'NEW', readiness: await readinessForLine(line, order.storeId, order.shopifyOrderNumber), kpi: kpiForProductType(settings, line.shopifyProductType),
      slaHours, dueAt: dueForNewTask(order.placedAt, slaHours), supplierSnapshot: line.resolvedSupplierId ? (supplierName.get(line.resolvedSupplierId) ?? null) : null,
      ...(reopenNew ? factoryReopen : {}),
      events: { create: reopenNew ? factoryEvent : { type: 'SYSTEM', message: 'Đơn vào từ Shopify — tạo task' } },
    } })
    created++
  }
  return { created, cancelled, completed, reopened }
}

export async function syncDesignTasksCounted(orderIds: string[]): Promise<{ tasksTouched: number; errors: string[] }> {
  const ids = Array.from(new Set(orderIds))
  if (ids.length === 0) return { tasksTouched: 0, errors: [] }
  const targets = await prisma.order.findMany({
    where: { id: { in: ids }, OR: [{ designTasks: { some: {} } }, { pipelineStatus: { in: ['PENDING_DESIGN', 'DESIGN_REJECTED'] } }] },
    select: { id: true, shopifyOrderNumber: true },
  })
  const errors: string[] = []
  let tasksTouched = 0
  for (const o of targets) {
    try {
      const r = await syncDesignTasks(o.id)
      tasksTouched += r.created + r.cancelled + r.completed + r.reopened
    } catch (e: any) { errors.push(`design tasks ${o.shopifyOrderNumber}: ${e.message}`) }
  }
  return { tasksTouched, errors }
}

export async function syncDesignTasksForOrders(orderIds: string[]): Promise<string[]> {
  return (await syncDesignTasksCounted(orderIds)).errors
}

export type Actor = { id: string; name: string; role: string; permissions?: FeaturePermission[] }
export type Viewer = { id: string; name: string; role: string; isLeader: boolean; canApprove: boolean; canHandoff: boolean; canEditNote: boolean }

export function viewerFor(user: Actor, settings: Pick<DesignSettings, 'designerCanApprove'>): Viewer {
  return {
    id: user.id, name: user.name, role: user.role, isLeader: isLeader(user.role),
    canApprove: canApproveDesign(user.role, user.permissions, settings.designerCanApprove),
    canHandoff: canHandoffToSupplier(user.role, user.permissions),
    canEditNote: canEditDesignNote(user.role, user.permissions),
  }
}
export type TransitionInput = { to: TaskStatus; note?: string; reasons?: string[]; assigneeId?: string; kpi?: number; dueHours?: number; continue?: boolean; acceptMissingAreas?: boolean }

export type TaskRow = {
  id: string; taskKey: string; status: TaskStatus; readiness: Readiness; assigneeId: string | null; assigneeName: string | null
  kpi: number; dueAt: string | null; slaHours: number; rejectReasons: string[]; rejectNote: string | null
  orderId: string; orderNumber: string; placedAt: string; shopifyLineId: string; linePosition: number
  sku: string | null; productTitle: string; variantTitle: string | null; previewUrl: string | null; imageUrl: string | null
  supplierName: string | null; customized: boolean; storeName: string
  /** Waiting for the local scan of the NAS library to attach its print. */
  fromLibrary: boolean
  /** No supplier yet: mapping comes first. */
  unmapped: boolean
  /** A print file is on the task: an AUTO line has been rendered, or someone uploaded one. */
  hasPrint: boolean
  /** Lines of one product share this: its artwork, once made, serves them all. */
  productKey: string
}

export type TaskProfile = { key: string; status: LibraryProductStatus; layerMap: LayerMapEntry[] }

export type TaskDetail = {
  task: TaskRow; line: WorkspaceLine; order: Workspace['order']; template: TemplateRow | null; profile: TaskProfile | null; profileRouteKey: string | null
  events: { id: string; type: string; message: string; actorName: string | null; createdAt: string }[]
  assignable: { id: string; name: string }[]; settings: DesignSettings; prevStatus: TaskStatus | null
  slots: string[]; driveConnected: boolean; library: TaskLibraryState | null; autoRender: RenderJobView | null
  driveFolder: { url: string } | null
  /** The line carries a Teeinblue design reference (`_tb_design`), which auto-render cannot draw. */
  teeinblue: boolean
  /** The line is at its supplier and the order open: "Sửa & gửi lại" on the DONE task asks why and reopens this line only. */
  reopensSentLine: boolean
}

/**
 * The print areas a task must fill: the template's areas. A product without a template has none — its task holds whatever
 * files the designer uploads (one part per file name) and needs at least one print file.
 */
export function requiredSlotsFor(template: TemplateRow | null): string[] {
  return template ? Array.from(new Set(template.areas.map(a => a.name).filter(Boolean))) : []
}

const OWNED_MOVES: TaskStatus[] = ['DOING', 'NEW', 'REVIEW', 'ASK_CUSTOMER']

function actorRole(a: Actor): ActorRole { return isLeader(a.role) ? 'LEADER' : 'DESIGNER' }

function parseRejectReasons(json: string | null): string[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch { return [] }
}

/**
 * "Chuyển sang sản xuất" on a flagged task: no scan needed, the line goes to the hub with the library link it already has.
 * The link stays as it is, nothing is attached and nothing is saved to the library.
 */
export async function releaseLibraryTask(taskKey: string, actor: Actor) {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) throw new Error('Task not found')
  if (!canApproveDesign(actor.role, actor.permissions, (await getDesignSettings()).designerCanApprove)) throw new Error('Chỉ người được duyệt design mới chuyển sang sản xuất')
  if (!task.fromLibrary || !AUTO_COMPLETE_FROM.includes(task.status as TaskStatus)) throw new Error('Task này không ở trạng thái chờ quét thư viện')
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId } })
  if (!line?.designDriveLink) throw new Error('Dòng này chưa có link thư viện')
  if (!line.resolvedSupplierId) throw new Error('Dòng này chưa mapping xưởng — map xong mới chuyển sang sản xuất')
  const updated = await prisma.designTask.update({
    where: { id: task.id },
    data: { status: 'DONE', events: { create: { type: 'STATUS', message: 'Chuyển sang sản xuất bằng link thư viện, không chờ quét', actorId: actor.id } } },
  })
  const row = await rowFor(updated.taskKey)
  if (!row) throw new Error('Task row not found after update')
  return { task: row }
}

export class LineFixError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
    this.name = 'LineFixError'
  }
}

const SENT_CHECK_SELECT = {
  pipelineStatus: true, fulfillmentStatus: true, exportedAt: true, exportedToSupplierId: true,
  lines: { select: { id: true, shopifyLineId: true, sku: true, productTitle: true, shopifyProductType: true, resolvedSupplierId: true, exportedAt: true, exportedToSupplierId: true } },
} as const

/**
 * The line went to its supplier (its own mark, or its order's export from before lines were tracked) and its order is still
 * open: "Sửa & gửi lại" on its DONE task then asks why and reopens this line alone. A READY_TO_PRODUCTION order whose line has
 * no mark has not sent it, so that control works there as it always did.
 */
export async function isSentLineOfOpenOrder(lineId: string): Promise<boolean> {
  const row = await prisma.orderLine.findUnique({ where: { id: lineId }, select: { order: { select: SENT_CHECK_SELECT } } })
  const order = row?.order
  const line = order?.lines.find(l => l.id === lineId)
  return !!order && !!line && !isNonProductLine(line) && !isClosedOrder(order) && !isShippedOrder(order) && isLineExported(order, line)
}

/** The reopen's events: who and why, then the link the line carried, the one its supplier holds (read back by lastFixCycle). */
function lineFixEvents(fix: LineFix, actor: Actor, heldLink: string | null) {
  return [
    { type: 'REJECT', message: lineFixMessage(fix), actorId: actor.id },
    { type: 'SYSTEM', message: heldLinkMessage(heldLink), actorId: null },
  ]
}

/**
 * The link the supplier holds when the line is reopened. The line's link only when nothing since the export says otherwise:
 * no earlier fix of the line (what it got at export is the line's link), or the earlier fix was marked told. Any other earlier
 * fix — never told, or approved before the notice existed (#LIT5105: no re-check at all) — left the supplier with what that
 * fix recorded, which is nothing for a reopen made before links were recorded.
 */
async function heldLinkAtReopen(taskId: string, lineLink: string | null): Promise<string | null> {
  const cycle = lastFixCycle(await prisma.designTaskEvent.findMany({ where: { taskId }, select: TASK_EVENT_SELECT }))
  if (!cycle || cycle.told) return lineLink
  return cycle.held?.link ?? null
}

async function reopenTaskOfLine(task: { id: string; taskKey: string; status: string }, actor: Actor, fix: LineFix, heldLink: string | null): Promise<{ task: TaskRow; changed: boolean }> {
  if (task.status === 'CANCELLED') throw new LineFixError(`Task ${task.taskKey} của dòng này đã huỷ — task đã huỷ không mở lại được`, 409)
  const changed = task.status === 'DONE' && await retryOnBusy(() => prisma.$transaction(async tx => {
    const r = await tx.designTask.updateMany({ where: { id: task.id, status: 'DONE' }, data: lineFixReopen(fix) })
    if (r.count === 0) return false
    for (const e of lineFixEvents(fix, actor, heldLink)) await tx.designTaskEvent.create({ data: { taskId: task.id, ...e } })
    return true
  }))
  const row = await rowFor(task.taskKey)
  if (!row) throw new Error('Task row not found after update')
  return { task: row, changed }
}

/**
 * "Mở lại để sửa" on a line already sent to its supplier: its task is created, or reopened from DONE, in the factory-return
 * state with the reason and the note, and nothing else moves (no other task or line, not the order's status, no export mark).
 * What its approval does is fixDelivery's. A task already open is left as it is, so a second press, or two at once, makes one task.
 */
export async function reopenLineForFix(
  lineId: string, actor: Actor, input: { reason?: unknown; note?: unknown }, opts: { agent?: boolean } = {},
): Promise<{ task: TaskRow; changed: boolean }> {
  const result = await reopenSentLine(lineId, actor, input)
  if (result.changed && !opts.agent) {
    const fix = parseLineFix(input) as LineFix
    await enqueueFixOnReject({ taskKey: result.task.taskKey, reasons: [fix.reason], note: fix.note, by: actor, source: 'LINE_REOPEN', factory: true })
  }
  return result
}

async function reopenSentLine(lineId: string, actor: Actor, input: { reason?: unknown; note?: unknown }): Promise<{ task: TaskRow; changed: boolean }> {
  const fix = parseLineFix(input)
  if ('error' in fix) throw new LineFixError(fix.error, 400)
  const line = await prisma.orderLine.findUnique({ where: { id: lineId } })
  if (!line) throw new LineFixError('Không tìm thấy dòng', 404)
  const order = await prisma.order.findUniqueOrThrow({
    where: { id: line.orderId },
    select: {
      id: true, storeId: true, shopifyOrderNumber: true, placedAt: true, pipelineStatus: true, fulfillmentStatus: true,
      lines: { select: { shopifyLineId: true, linePosition: true, sku: true, productTitle: true, shopifyProductType: true } },
    },
  })
  if (isNonProductLine(line)) throw new LineFixError('Dòng này không phải sản phẩm (add-on, phí…) — không có design để sửa', 409)
  if (isClosedOrder(order)) throw new LineFixError('Đơn đã huỷ hoặc hoàn tiền — không mở lại dòng để sửa', 409)
  if (isShippedOrder(order)) throw new LineFixError('Đơn đã giao (fulfilled) — không mở lại dòng để sửa', 409)
  if (!isSentLine(order, line)) throw new LineFixError('Dòng chưa gửi xưởng — sửa design ngay trên task, không cần mở lại', 409)

  const ofLine = { orderId_shopifyLineId: { orderId: order.id, shopifyLineId: line.shopifyLineId } }
  const existing = await prisma.designTask.findUnique({ where: ofLine })
  if (existing) return reopenTaskOfLine(existing, actor, fix, await heldLinkAtReopen(existing.id, line.designDriveLink))
  const taskKey = lineKeysOf(order.shopifyOrderNumber, order.lines).get(line.shopifyLineId)!
  const keyTaken = `Mã ${taskKey} đang thuộc một task khác — bấm Đồng bộ task rồi thử lại`
  if (await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true } })) throw new LineFixError(keyTaken, 409)
  const settings = await getDesignSettings()
  const slaHours = line.customized ? settings.slaCustomHours : settings.slaNonCustomHours
  const supplierId = line.exportedToSupplierId ?? line.resolvedSupplierId
  const supplier = supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } }) : null
  const readiness = await readinessForLine(line, order.storeId, order.shopifyOrderNumber)
  try {
    await retryOnBusy(() => prisma.designTask.create({ data: {
      orderId: order.id, shopifyLineId: line.shopifyLineId, taskKey, readiness, kpi: kpiForProductType(settings, line.shopifyProductType),
      slaHours, dueAt: dueForNewTask(order.placedAt, slaHours), supplierSnapshot: supplier?.name ?? null, ...lineFixReopen(fix),
      events: { create: lineFixEvents(fix, actor, line.designDriveLink) },
    } }))
  } catch (e: any) {
    if (!isUniqueViolation(e)) throw e
    const raced = await prisma.designTask.findUnique({ where: ofLine })
    if (!raced) throw new LineFixError(keyTaken, 409)
    return reopenTaskOfLine(raced, actor, fix, line.designDriveLink)
  }
  const row = await rowFor(taskKey)
  if (!row) throw new Error('Task row not found after create')
  return { task: row, changed: true }
}

type TaskEvent = { id: string; type: string; message: string; actorId: string | null; createdAt: Date }
const TASK_EVENT_SELECT = { id: true, type: true, message: true, actorId: true, createdAt: true } as const

function inOrder(events: TaskEvent[]): TaskEvent[] {
  return [...events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

/** A reopen of one line already at its supplier: "Mở lại để sửa" with its reason, or the old control's STATUS event (#LIT5105). */
function isLineReopen(e: TaskEvent): boolean {
  return (e.type === 'REJECT' && e.message.startsWith(LINE_FIX_EVENT_PREFIX)) || (e.type === 'STATUS' && e.message === OLD_REOPEN_MESSAGE)
}

type FixCycle = {
  reopen: TaskEvent; reason: LineFixReason | null; note: string | null
  /** The link the supplier held when the line was reopened; null when it was not recorded (a reopen made before this was asked). */
  held: { link: string | null } | null
  recheck: TaskEvent | null; told: TaskEvent | null
}

/**
 * The task's last trip back to design when it was a reopen of its own line (an order-level return is not one), and what
 * followed: the approval's re-check and the "told" that closed it. A reopen made before the reason was asked stores none;
 * its note is what was written on the task between the reopen and the approval.
 */
function lastFixCycle(events: TaskEvent[]): FixCycle | null {
  const sorted = inOrder(events)
  let at = -1
  for (let i = sorted.length - 1; i >= 0 && at < 0; i--) {
    if (isLineReopen(sorted[i]) || (sorted[i].type === 'SYSTEM' && sorted[i].message === FACTORY_REOPEN_MESSAGE)) at = i
  }
  if (at < 0 || !isLineReopen(sorted[at])) return null
  const reopen = sorted[at]
  const after = sorted.slice(at + 1)
  const r = after.findIndex(e => e.type === SUPPLIER_RECHECK)
  const recheck = r >= 0 ? after[r] : null
  const told = recheck ? after.slice(r + 1).find(e => e.type === SUPPLIER_TOLD) ?? null : null
  const fix = readLineFixMessage(reopen.message)
  const held = fix ? after.map(e => (e.type === 'SYSTEM' ? readHeldLinkMessage(e.message) : null)).find(h => !!h) ?? null : null
  if (fix) return { reopen, reason: fix.reason, note: fix.note, held, recheck, told }
  const notes = (recheck ? after.slice(0, r) : after).filter(e => e.type === 'NOTE').map(e => e.message.trim()).filter(Boolean)
  return { reopen, reason: null, note: notes.length ? notes.join(' · ') : null, held: null, recheck, told }
}

/**
 * Whether the link the supplier holds still leads to the approved fix: only when it is the task's own Drive folder, where every
 * new version lands. Any other link (unknown, empty, a library folder, one part's file, even the file the line still links
 * when the fix is in another part) means sending the new link, which costs nothing. Compared as stored: two spellings of one
 * folder answer NEW_LINK, the safe side.
 */
function supplierLinkKind(held: FixCycle['held'], taskFolder: string | null): SupplierLinkKind {
  return !!held?.link && !!taskFolder && held.link === taskFolder ? 'SAME_FOLDER' : 'NEW_LINK'
}

type FixDelivery = { kind: 'API' } | { kind: 'LINK'; supplierName: string; held: FixCycle['held'] }

/**
 * How the approved fix of a line reopened after it went to its supplier reaches that supplier (owner 11/06/2026, #LIT5105).
 * A live API push holding the line: the supplier keeps its own copy of the files, so the line goes out again. Any other send
 * (a sheet row, a CSV, a mark set by hand) gave the supplier a link: nothing goes out again, someone tells the supplier to
 * open it again. Null when this approval ends no such reopen (a first design, an order-level return), when the line is not
 * at a supplier, or when its order is closed.
 */
async function fixDelivery(taskId: string, lineId: string): Promise<FixDelivery | null> {
  const cycle = lastFixCycle(await prisma.designTaskEvent.findMany({ where: { taskId }, select: TASK_EVENT_SELECT }))
  if (!cycle) return null
  const row = await prisma.orderLine.findUnique({
    where: { id: lineId },
    select: { order: { select: { ...SENT_CHECK_SELECT, supplierPushes: { where: { status: { in: ACTIVE_PUSH_STATUSES } }, select: { orderId: true, supplierId: true, prevExportJson: true, requestJson: true } } } } },
  })
  const order = row?.order
  const line = order?.lines.find(l => l.id === lineId)
  if (!order || !line || isClosedOrder(order) || isShippedOrder(order) || !isLineExported(order, line)) return null
  const supplierId = exportedSupplierOf(order, line)
  for (const push of order.supplierPushes) {
    const carried = await carriedShopifyLineIds(push, order.lines)
    if (carried ? carried.includes(line.shopifyLineId) : push.supplierId === supplierId) return { kind: 'API' }
  }
  const supplier = supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } }) : null
  return { kind: 'LINK', supplierName: supplier?.name ?? 'xưởng', held: cycle.held }
}

type TransitionResult = { task: TaskRow; order: { id: string; designReady: boolean; pipelineStatus: string } | null; notice?: string }

const AGENT_REOPEN_ONLY = 'Agent chỉ được mở lại task đã duyệt'
const TAKEN_OVER = 'Task đã được người xử lý trước khi Agent nhận'

export async function transitionTask(taskKey: string, actor: Actor, input: TransitionInput, opts: { agent?: boolean } = {}): Promise<TransitionResult> {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) throw new Error('Task not found')
  const from = task.status as TaskStatus
  if (opts.agent && !(from === 'DONE' && input.to === 'DOING')) throw new Error(AGENT_REOPEN_ONLY)
  const role = actorRole(actor)
  const canApprove = canApproveDesign(actor.role, actor.permissions, (await getDesignSettings()).designerCanApprove)
  if (!(input.continue && from === 'ASK_CUSTOMER' && input.to === (task.prevStatus ?? 'NEW')) && !canTransition(from, input.to, role, canApprove)) {
    const leaderOnly = from === 'REVIEW' && (input.to === 'DONE' || input.to === 'REJECTED')
    throw new Error(`Chuyển ${from} → ${input.to} không được phép với vai trò ${role}${leaderOnly ? ' — chỉ leader duyệt hoặc trả lại mẫu (cài đặt "Designer được duyệt design" đang tắt, hoặc bạn không có quyền Design Tasks)' : ''}`)
  }
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId } })
  if (!line) throw new Error('Line not found')
  // "Sửa & gửi lại" on a line its supplier already has is "Mở lại để sửa" of that line, open to whoever may press that.
  if (from === 'DONE' && input.to === 'DOING' && await isSentLineOfOpenOrder(line.id)) {
    return { task: (await reopenLineForFix(line.id, actor, { reason: input.reasons?.[0], note: input.note }, opts)).task, order: null }
  }
  if (!opts.agent && role !== 'LEADER' && task.assigneeId && task.assigneeId !== actor.id && OWNED_MOVES.includes(input.to)) {
    const owner = await prisma.appUser.findUnique({ where: { id: task.assigneeId }, select: { name: true } })
    throw new Error(`Task đang thuộc về ${owner?.name ?? 'người khác'}`)
  }

  if (input.to === 'REVIEW' || input.to === 'DONE') {
    const files = await prisma.designArtwork.findMany({ where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, removedAt: null } })
    const pair = printCutCheck(await templateForLine(line), files)
    if (pair && !pair.ok) throw new Error(pair.message)
  }

  const data: any = { status: input.to }
  const events: { type: string; message: string; actorId: string | null }[] = []
  let notice: string | null = null
  const say = (type: string, message: string) => events.push({ type, message, actorId: actor.id })

  if (input.to === 'ASSIGNED') {
    if (!input.assigneeId) throw new Error('assigneeId is required')
    data.assigneeId = input.assigneeId
    if (input.kpi !== undefined) data.kpi = input.kpi
    if (input.dueHours !== undefined) data.dueAt = new Date(Date.now() + input.dueHours * 3600_000)
    const who = await prisma.appUser.findUnique({ where: { id: input.assigneeId }, select: { name: true } })
    say('ASSIGN', `Giao cho ${who?.name ?? input.assigneeId} · ${data.kpi ?? task.kpi} điểm${input.dueHours ? ` · hạn ${input.dueHours}h` : ''}${input.note ? ` · ${input.note}` : ''}`)
  } else if (input.to === 'NEW') {
    data.assigneeId = null; say('STATUS', 'Từ chối việc — trả về leader giao lại')
  } else if (input.to === 'DOING') {
    if (!task.assigneeId && !opts.agent) data.assigneeId = actor.id
    if (!task.dueAt) data.dueAt = new Date(Date.now() + task.slaHours * 3600_000)
    say('STATUS', from === 'ASK_CUSTOMER' ? 'Tiếp tục làm' : from === 'DONE' ? OLD_REOPEN_MESSAGE : 'Nhận việc')
  } else if (input.to === 'REVIEW') {
    if (!input.continue) {
      const missing = await missingPrintFiles(line)
      if (missing) throw new Error(missing)
    }
    say('STATUS', from === 'ASK_CUSTOMER' ? 'Tiếp tục sau khi hỏi khách' : 'Gửi duyệt')
  } else if (input.to === 'REJECTED') {
    const reasons = input.reasons ?? []
    const reasonError = rejectReasonsError(reasons)
    if (reasonError) throw new Error(reasonError)
    // A task sent back after it went to the supplier keeps saying so, whatever the reviewer adds.
    const sentBack = parseRejectReasons(task.rejectReasons).filter(r => SENT_BACK_REASONS.includes(r) && !reasons.includes(r))
    data.rejectReasons = JSON.stringify([...sentBack, ...reasons])
    data.rejectNote = input.note ?? null
    say('REJECT', `Trả lại sửa: ${(input.reasons ?? []).join(', ')}${input.note ? ` — ${input.note}` : ''}`)
  } else if (input.to === 'ASK_CUSTOMER') {
    data.prevStatus = from; say('ASK', `Hỏi khách: ${input.note ?? ''}`.trim())
  } else if (input.to === 'DONE') {
    say('STATUS', role === 'LEADER' ? APPROVE_MESSAGE : `${APPROVE_MESSAGE} (designer)`)
  } else if (input.to === 'CANCELLED') {
    say('STATUS', 'Huỷ task')
  }
  if (input.continue) data.prevStatus = null
  if (input.note && !['ASSIGNED', 'REJECTED', 'ASK_CUSTOMER'].includes(input.to)) say('NOTE', input.note)

  let order: { id: string; designReady: boolean; pipelineStatus: string } | null = null
  if (input.to === 'DONE') {
    const current = await prisma.order.findUniqueOrThrow({ where: { id: task.orderId }, select: { id: true, designReady: true, pipelineStatus: true } })
    const externalLink = !!line.designDriveLink && !line.designDriveLink.startsWith(APP_FILE_PREFIX) && line.designDriveLink !== task.driveFolderUrl
      && !(await prisma.designArtwork.findFirst({ where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, driveWebViewLink: line.designDriveLink }, select: { id: true } }))
    if (externalLink && current.pipelineStatus !== 'DESIGN_REJECTED' && !reopenedByFactory(task)) {
      events.splice(0, events.length, ...events.filter(e => e.type !== 'STATUS'), { type: 'SYSTEM', message: 'Design đã có từ ngoài studio — giữ link hiện tại', actorId: actor.id })
      order = current
    } else {
      const files = await prisma.designArtwork.findMany({ where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, removedAt: null }, select: { kind: true, printArea: true, version: true } })
      const template = templateViewFor(await templateForLine(line), files)
      const slots = requiredSlotsFor(template)
      // A leader may approve a set that does not follow the template's areas (pieces for a one-sheet template, one sleeve
      // for both); such a set is not saved to the library, so a later order of the SKU does not reuse it unseen.
      const missing = missingPrintAreas(files, slots)
      const accepted = missing.length > 0 && input.acceptMissingAreas === true && canApprove
      if (missing.length > 0 && !accepted) throw new Error(`${MISSING_AREAS_PREFIX}${missing.join(', ')}`)
      const delivery = current.pipelineStatus === 'DESIGN_REJECTED' ? null : await fixDelivery(task.id, line.id)
      order = (await updateLine(line.id, { done: true, requiredAreas: accepted ? [] : slots, reofferLine: delivery?.kind === 'API' }))?.order ?? null
      if (delivery?.kind === 'LINK') {
        notice = supplierLinkMessage(supplierLinkKind(delivery.held, task.driveFolderUrl), delivery.supplierName)
        events.push({ type: SUPPLIER_RECHECK, message: notice, actorId: null })
      }
      data.rejectReasons = null; data.rejectNote = null
      if (accepted) {
        events.push({ type: 'SYSTEM', message: `Duyệt khi chưa có file cho vùng: ${missing.join(', ')} — không lưu vào Design Library`, actorId: actor.id })
      } else {
        // The approval stands even when the library cannot be written; the reason is logged on the task.
        const library = await saveStudioDesignToLibrary(line, slots)
          .catch((e: any) => ({ saved: false, designLink: null, note: `Chưa lưu vào Design Library: ${e?.message ?? e}` }))
        if (library.saved) events.push({ type: 'SYSTEM', message: `Đã lưu design vào Design Library cho SKU ${line.sku} — đơn sau cùng SKU dùng lại`, actorId: actor.id })
        else if (library.note) events.push({ type: 'SYSTEM', message: library.note, actorId: actor.id })
      }
    }
  }
  if (from === 'DONE' && input.to === 'DOING') order = (await updateLine(line.id, { done: false }))?.order ?? null

  const updated = await prisma.designTask.update({ where: { id: task.id }, data: { ...data, events: { create: events } } })
  if (input.to === 'REJECTED') {
    const reasons = parseRejectReasons(updated.rejectReasons)
    await enqueueFixOnReject({
      taskKey: updated.taskKey, reasons, note: updated.rejectNote, by: actor, source: 'REJECT', factory: reasons.some(r => SENT_BACK_REASONS.includes(r)),
    })
  }
  if (input.to === 'DONE') {
    await queueLibraryApplyOnApproval(task.id, actor).catch(async e => {
      const message = `Chưa xếp được job cập nhật thư viện: ${e?.message ?? e}`
      await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'SYSTEM', message } }).catch(() => {})
    })
  }
  if (!opts.agent && (from === 'REJECTED' || input.to === 'CANCELLED')) {
    await cancelQueuedJobsForTask(task.id, TAKEN_OVER).catch(e => console.error(`[design agent] không huỷ được job của ${taskKey}:`, e?.message ?? e))
  }
  const row = await rowFor(updated.taskKey)
  if (!row) throw new Error('Task row not found after update')
  return { task: row, order, ...(notice ? { notice } : {}) }
}

export const AUTO_REVIEW_FROM: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REJECTED']
export const AUTO_REVIEW_MESSAGE = 'Tự động gửi duyệt (file in tự động)'

/**
 * System move to REVIEW after an auto render, deliberately outside canTransition: no human actor,
 * and NEW/ASSIGNED → REVIEW is not a move a person may make. Only fires once every print area has a file.
 */
export async function submitAutoRenderForReview(orderId: string, shopifyLineId: string): Promise<{ moved: boolean; reason: string | null }> {
  const task = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } } })
  if (!task) return { moved: false, reason: 'Không có task' }
  if (!AUTO_REVIEW_FROM.includes(task.status as TaskStatus)) return { moved: false, reason: `Task đang ${task.status}` }
  const line = await prisma.orderLine.findFirst({ where: { orderId, shopifyLineId } })
  if (!line) return { moved: false, reason: 'Không tìm thấy dòng đơn' }
  const missing = await missingPrintFiles(line)
  if (missing) return { moved: false, reason: missing }
  const moved = await prisma.$transaction(async tx => {
    const r = await tx.designTask.updateMany({ where: { id: task.id, status: task.status }, data: { status: 'REVIEW', readiness: 'AUTO', prevStatus: null } })
    if (r.count === 0) return false
    await tx.designTaskEvent.create({ data: { taskId: task.id, type: 'SYSTEM', message: AUTO_REVIEW_MESSAGE } })
    return true
  })
  if (moved && task.status === 'REJECTED') {
    await cancelQueuedJobsForTask(task.id, TAKEN_OVER).catch(e => console.error(`[design agent] không huỷ được job của ${task.taskKey}:`, e?.message ?? e))
  }
  return moved ? { moved: true, reason: null } : { moved: false, reason: 'Task vừa đổi trạng thái' }
}

export const AGENT_SUBMIT_MESSAGE = 'Gửi duyệt lại (Agent)'
const AGENT_SUBMIT_FROM: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REJECTED']
type AgentSubmitResult = { moved: true } | { moved: false; error: string; missing: string[]; status: 400 | 404 | 409 }

/** The Design Agent's "Gửi duyệt": outside canTransition (it is never the assignee), with the checks a designer's press runs. */
export async function submitAgentForReview(taskKey: string, agentId: string): Promise<AgentSubmitResult> {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) return { moved: false, error: 'Không tìm thấy task', missing: [], status: 404 }
  if (task.status === 'REVIEW') return { moved: true }
  if (!AGENT_SUBMIT_FROM.includes(task.status as TaskStatus)) return { moved: false, error: `Task đang ${task.status}`, missing: [], status: 409 }
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId } })
  if (!line) return { moved: false, error: 'Không tìm thấy dòng đơn', missing: [], status: 404 }
  const files = await prisma.designArtwork.findMany({ where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, removedAt: null } })
  const template = await templateForLine(line)
  const missingAreas = () => template ? missingPrintAreas(files, requiredSlotsFor(templateViewFor(template, files))) : []
  const pair = printCutCheck(template, files)
  if (pair && !pair.ok) return { moved: false, error: pair.message, missing: missingAreas(), status: 400 }
  const missing = await missingPrintFiles(line)
  if (missing) return { moved: false, error: missing, missing: missingAreas(), status: 400 }
  const moved = await prisma.$transaction(async tx => {
    const r = await tx.designTask.updateMany({ where: { id: task.id, status: task.status }, data: { status: 'REVIEW', prevStatus: null } })
    if (r.count === 0) return false
    await tx.designTaskEvent.create({ data: { taskId: task.id, type: 'STATUS', message: AGENT_SUBMIT_MESSAGE, actorId: agentId } })
    return true
  })
  if (moved) return { moved: true }
  const now = await prisma.designTask.findUnique({ where: { id: task.id }, select: { status: true } })
  if (now?.status === 'REVIEW') return { moved: true }
  return { moved: false, error: `Task đang ${now?.status ?? 'không còn'}`, missing: [], status: 409 }
}

/** REVIEW → REJECTED for the Design Agent (a request relayed from chat). Queues nothing: the request itself is the job. */
export async function rejectReviewAsAgent(taskKey: string, agentId: string, input: { reason: string; note: string }): Promise<boolean> {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task || task.status !== 'REVIEW') return false
  const sentBack = parseRejectReasons(task.rejectReasons).filter(r => SENT_BACK_REASONS.includes(r) && r !== input.reason)
  return prisma.$transaction(async tx => {
    const r = await tx.designTask.updateMany({
      where: { id: task.id, status: 'REVIEW' },
      data: { status: 'REJECTED', rejectReasons: JSON.stringify([...sentBack, input.reason]), rejectNote: input.note || null },
    })
    if (r.count === 0) return false
    await tx.designTaskEvent.create({ data: { taskId: task.id, type: 'REJECT', message: `Trả lại sửa: ${input.reason}${input.note ? ` — ${input.note}` : ''}`, actorId: agentId } })
    return true
  })
}

export type ReviewCard = {
  task: TaskRow; line: WorkspaceLine; slots: string[]; push: HandoffPush | null
  template: TemplateRow | null; profile: TaskProfile | null; library: TaskLibraryState | null; shipTo: Workspace['order']['shipTo'] | null
}

export async function listReviewCards(f: { assigneeId?: string; q?: string; storeIds?: string[] | null } = {}): Promise<ReviewCard[]> {
  const rows = await listTasks({ statuses: ['REVIEW'], assigneeId: f.assigneeId, q: f.q, limit: 200, storeIds: f.storeIds })
  if (rows.length === 0) return []
  const orderIds = Array.from(new Set(rows.map(r => r.orderId)))
  const [orderLines, orders, workspaces, pushes] = await Promise.all([
    prisma.orderLine.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, shopifyLineId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, customAttributesJson: true, variantOptions: true, shopifyProductType: true },
    }),
    prisma.order.findMany({ where: { id: { in: orderIds } }, select: { id: true, storeId: true } }),
    Promise.all(orderIds.map(id => loadWorkspace(id))),
    activePushByOrder(orderIds),
  ])
  const wsById = new Map(workspaces.filter((w): w is Workspace => !!w).map(w => [w.order.id, w]))
  const storeByOrder = new Map(orders.map(o => [o.id, o.storeId]))
  const built = await Promise.all(rows.map(async (task): Promise<ReviewCard | null> => {
    const ws = wsById.get(task.orderId)
    const line = ws?.lines.find(l => l.shopifyLineId === task.shopifyLineId)
    const orderLine = orderLines.find(l => l.orderId === task.orderId && l.shopifyLineId === task.shopifyLineId)
    if (!ws || !line || !orderLine) return null
    const push = pushes.get(task.orderId)
    const { template: base, profile, library } = await lineContext(orderLine, storeByOrder.get(task.orderId) ?? null)
    const template = templateViewFor(base, line.artworks)
    return {
      task, line, slots: requiredSlotsFor(template), template, profile, library, shipTo: ws.order.shipTo ?? null,
      push: push ? { status: push.status, supplierOrderCode: push.supplierOrderCode, externalOrderId: push.externalOrderId } : null,
    }
  }))
  return built.filter((c): c is ReviewCard => !!c)
}

export const NO_PRINT_FILE_MESSAGE = 'Chưa có file in nào — upload ít nhất một file in'

/** Why the line cannot go to review yet, or null: a template area without a file, or no print file at all. Mockups never count. */
async function missingPrintFiles(line: TemplateLookupLine & { shopifyLineId: string }): Promise<string | null> {
  const files = await prisma.designArtwork.findMany({
    where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, removedAt: null }, select: { kind: true, printArea: true, version: true },
  })
  const slots = requiredSlotsFor(templateViewFor(await templateForLine(line), files))
  if (printFilesReady(files, slots)) return null
  return slots.length > 0 ? `Chưa có artwork cho: ${missingPrintAreas(files, slots).join(', ')}` : NO_PRINT_FILE_MESSAGE
}

export async function addTaskNote(taskKey: string, actor: Actor, message: string) {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true } })
  if (!task) throw new Error('Task not found')
  await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'NOTE', message, actorId: actor.id } })
}

/** A row of "Đã update design / Cần báo xưởng". Mirrored for the client in components/types.ts. */
export type SupplierFixRow = {
  taskKey: string; orderId: string; orderNumber: string; storeName: string; productTitle: string; taskStatus: TaskStatus
  supplierId: string | null; supplierName: string | null
  /** Null for a line reopened before the reason was asked (#LIT5105): shown as "—". */
  reason: LineFixReason | null
  note: string | null
  reopenedBy: string | null; reopenedAt: string
  approvedAt: string | null
  toldBy: string | null; toldAt: string | null
  /** Set by the approval: the supplier's link still leads to the fix, or a new link must be sent (read from the re-check event). */
  linkKind: SupplierLinkKind | null
  /** The link the supplier held when the line was reopened; null when it was not recorded. */
  supplierLink: string | null
  /** The line's design link now. */
  designLink: string | null
  /**
   * The task's Drive folder once the line carries it (it then holds every current part): the link to send for NEW_LINK, and
   * what makes SAME_FOLDER true. Null before: neither can be announced yet.
   */
  readyLink: string | null
  /** For a row under "Đã báo": the link that was told, as the told event wrote it. */
  toldLink: string | null
}

export type SupplierFixList = {
  /** Approved again after the reopen, the supplier got the line by a link, nobody has told it yet: oldest approval first. */
  waiting: SupplierFixRow[]
  /** Told within TOLD_VISIBLE_DAYS, newest first. */
  told: SupplierFixRow[]
  /** Reopened and not approved yet, oldest reopen first. */
  fixing: SupplierFixRow[]
  /** Waiting rows before the reason and supplier filters. */
  waitingTotal: number
  suppliers: { id: string; name: string }[]
}

/** A fulfilled, cancelled or refunded order needs no supplier told (Shopify's own "fulfilled" is checked on the rows). */
const OPEN_ORDER_STATUS = { pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] } }

type SupplierFixFilter = {
  storeIds?: string[] | null; reason?: LineFixReason | 'none' | null; supplierId?: string | null; kind?: SupplierLinkKind | null; now?: Date
}

/**
 * "Đã update design / Cần báo xưởng": the lines staff have to tell their supplier about, read from the task events (a reopen,
 * the approval's re-check, the "told"), so the list needs no state of its own. `reason: 'none'` keeps the rows without one.
 * Only open to-dos (of any age), the ones told within TOLD_VISIBLE_DAYS and open tasks are read in full: a grouped read of
 * each task's latest re-check and "told" picks the first two without loading the history of every task ever re-checked.
 */
export async function listSupplierFixes(f: SupplierFixFilter = {}): Promise<SupplierFixList> {
  const now = f.now ?? new Date()
  const toldSince = now.getTime() - TOLD_VISIBLE_DAYS * 86400_000
  const ofOrder = { ...(f.storeIds ? { storeId: { in: f.storeIds } } : {}), ...OPEN_ORDER_STATUS }
  const latest = await prisma.designTaskEvent.groupBy({
    by: ['taskId', 'type'], where: { type: { in: [SUPPLIER_RECHECK, SUPPLIER_TOLD] }, task: { status: 'DONE', order: ofOrder } }, _max: { createdAt: true },
  })
  const lastAt = new Map<string, { recheck?: number; told?: number }>()
  for (const g of latest) {
    const at = lastAt.get(g.taskId) ?? {}
    at[g.type === SUPPLIER_RECHECK ? 'recheck' : 'told'] = g._max.createdAt?.getTime()
    lastAt.set(g.taskId, at)
  }
  const doneIds = Array.from(lastAt.entries())
    .filter(([, at]) => at.recheck !== undefined && (at.told === undefined || at.recheck > at.told || at.told >= toldSince)).map(([id]) => id)
  const tasks = await prisma.designTask.findMany({
    where: {
      order: ofOrder,
      OR: [
        { id: { in: doneIds } },
        { status: { notIn: ['DONE', 'CANCELLED'] }, events: { some: { OR: [{ type: 'REJECT', message: { startsWith: LINE_FIX_EVENT_PREFIX } }, { type: 'STATUS', message: OLD_REOPEN_MESSAGE }] } } },
      ],
    },
    select: {
      id: true, taskKey: true, status: true, shopifyLineId: true, driveFolderUrl: true, events: { select: TASK_EVENT_SELECT },
      order: { select: {
        ...SENT_CHECK_SELECT, id: true, shopifyOrderNumber: true, store: { select: { shop: true, project: { select: { name: true } } } },
        lines: { select: { ...SENT_CHECK_SELECT.lines.select, designDriveLink: true } },
      } },
    },
  })
  type Built = { list: 'waiting' | 'told' | 'fixing'; row: SupplierFixRow; actorIds: (string | null)[] }
  const built: Built[] = []
  for (const t of tasks) {
    const line = t.order.lines.find(l => l.shopifyLineId === t.shopifyLineId)
    const cycle = lastFixCycle(t.events)
    if (!line || !cycle || isShippedOrder(t.order)) continue
    let list: Built['list']
    if (t.status === 'DONE') {
      if (!cycle.recheck) continue
      if (cycle.told && cycle.told.createdAt.getTime() < toldSince) continue
      list = cycle.told ? 'told' : 'waiting'
    } else {
      // A reopen also happens on a line still waiting for hand-off (the route's wider "sent", the old control): not at a supplier, not here.
      if (!isLineExported(t.order, line)) continue
      list = 'fixing'
    }
    built.push({
      list, actorIds: [cycle.reopen.actorId, cycle.told?.actorId ?? null],
      row: {
        taskKey: t.taskKey, orderId: t.order.id, orderNumber: t.order.shopifyOrderNumber, storeName: t.order.store.project?.name ?? t.order.store.shop,
        productTitle: line.productTitle, taskStatus: t.status as TaskStatus,
        supplierId: exportedSupplierOf(t.order, line) ?? line.resolvedSupplierId, supplierName: null,
        reason: cycle.reason, note: cycle.note, reopenedBy: null, reopenedAt: cycle.reopen.createdAt.toISOString(),
        approvedAt: cycle.recheck?.createdAt.toISOString() ?? null, toldBy: null, toldAt: cycle.told?.createdAt.toISOString() ?? null,
        linkKind: cycle.recheck ? readSupplierLinkKind(cycle.recheck.message) : null, supplierLink: cycle.held?.link ?? null,
        designLink: line.designDriveLink, readyLink: folderWithFix(line.designDriveLink, t.driveFolderUrl),
        toldLink: cycle.told ? toldLinkOf(cycle.told.message) : null,
      },
    })
  }
  const userIds = Array.from(new Set(built.flatMap(b => b.actorIds).filter((x): x is string => !!x)))
  const supplierIds = Array.from(new Set(built.map(b => b.row.supplierId).filter((x): x is string => !!x)))
  const [users, suppliers] = await Promise.all([
    userIds.length ? prisma.appUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
    supplierIds.length ? prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : [],
  ])
  const userName = new Map(users.map(u => [u.id, u.name]))
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))
  for (const b of built) {
    b.row.supplierName = b.row.supplierId ? (supplierName.get(b.row.supplierId) ?? null) : null
    b.row.reopenedBy = b.actorIds[0] ? (userName.get(b.actorIds[0]) ?? null) : null
    b.row.toldBy = b.actorIds[1] ? (userName.get(b.actorIds[1]) ?? null) : null
  }
  const shown = built.filter(b => (!f.reason || (f.reason === 'none' ? b.row.reason === null : b.row.reason === f.reason))
    && (!f.supplierId || b.row.supplierId === f.supplierId) && (!f.kind || b.row.linkKind === f.kind))
  const rows = (list: Built['list'], at: (r: SupplierFixRow) => string, dir: 1 | -1) =>
    shown.filter(b => b.list === list).map(b => b.row).sort((x, y) => (at(x) < at(y) ? -dir : at(x) > at(y) ? dir : x.taskKey.localeCompare(y.taskKey)))
  return {
    waiting: rows('waiting', r => r.approvedAt!, 1),
    told: rows('told', r => r.toldAt!, -1),
    fixing: rows('fixing', r => r.reopenedAt, 1),
    waitingTotal: built.filter(b => b.list === 'waiting').length,
    suppliers: suppliers.map(s => ({ id: s.id, name: s.name })).sort((x, y) => x.name.localeCompare(y.name)),
  }
}

/**
 * The task's Drive folder once it holds the fix: the line carries it when the folder holds every current print (approval, or
 * the folder tidy later). It is the link to send for NEW_LINK and what makes SAME_FOLDER true. A single file, of this server or
 * of Drive, never is: in a design of several parts the fixed part may be another one.
 */
function folderWithFix(lineLink: string | null, taskFolder: string | null): string | null {
  return !!lineLink && !!taskFolder && lineLink === taskFolder ? taskFolder : null
}

/** The link a "told" event wrote ("…: <link>"). */
function toldLinkOf(message: string): string | null {
  return message.match(/: (\S+)$/)?.[1] ?? null
}

/**
 * "Đã báo xưởng": records who told the supplier (or sent it which new link), with the link, and when. Nothing changes when
 * nothing is waiting. Either kind waits (409) until the task's Drive folder holds the fix: before that the supplier's folder
 * does not show it, and there is no link to send.
 */
export async function markSupplierTold(taskKey: string, actor: Actor): Promise<{ changed: boolean }> {
  const task = await prisma.designTask.findUnique({
    where: { taskKey },
    select: {
      id: true, status: true, shopifyLineId: true, driveFolderUrl: true,
      order: { select: { ...SENT_CHECK_SELECT, lines: { select: { ...SENT_CHECK_SELECT.lines.select, designDriveLink: true } } } },
    },
  })
  if (!task) throw new Error('Task not found')
  const line = task.order.lines.find(l => l.shopifyLineId === task.shopifyLineId)
  const supplierId = line ? (exportedSupplierOf(task.order, line) ?? line.resolvedSupplierId) : null
  const name = (supplierId ? await prisma.supplier.findUnique({ where: { id: supplierId }, select: { name: true } }) : null)?.name ?? 'xưởng'
  const readyLink = folderWithFix(line?.designDriveLink ?? null, task.driveFolderUrl)
  return retryOnBusy(() => prisma.$transaction(async tx => {
    const cycle = task.status === 'DONE' ? lastFixCycle(await tx.designTaskEvent.findMany({ where: { taskId: task.id }, select: TASK_EVENT_SELECT })) : null
    if (!cycle?.recheck || cycle.told) return { changed: false }
    if (!readyLink) throw new LineFixError(FIX_NOT_IN_FOLDER_MESSAGE, 409)
    const message = readSupplierLinkKind(cycle.recheck.message) === 'SAME_FOLDER'
      ? `Đã báo ${name} xem lại folder design: ${readyLink}`
      : `Đã gửi ${name} link mới: ${readyLink}`
    await tx.designTaskEvent.create({ data: { taskId: task.id, type: SUPPLIER_TOLD, message, actorId: actor.id } })
    return { changed: true }
  }))
}

export const CS_NOTE_MAX = 2000

/** The CS note lives on the order line (OrderLine.designNote); every change is logged on the task. */
export async function setTaskCsNote(taskKey: string, actor: Actor, note: string | null): Promise<{ designNote: string | null; changed: boolean }> {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true, orderId: true, shopifyLineId: true } })
  if (!task) throw new Error('Task not found')
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId }, select: { id: true, designNote: true } })
  if (!line) throw new Error('Line not found')
  const next = note?.trim() || null
  if (next && next.length > CS_NOTE_MAX) throw new Error(`Ghi chú CS dài tối đa ${CS_NOTE_MAX} ký tự`)
  if (next === (line.designNote ?? null)) return { designNote: next, changed: false }
  await prisma.$transaction([
    prisma.orderLine.update({ where: { id: line.id }, data: { designNote: next } }),
    prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'NOTE', message: next ? `Ghi chú CS: ${next}` : 'Xoá ghi chú CS', actorId: actor.id } }),
  ])
  return { designNote: next, changed: true }
}

export async function listTasks(f: { statuses?: TaskStatus[]; readiness?: Readiness; assigneeId?: string; q?: string; limit?: number; taskKeys?: string[]; storeIds?: string[] | null }): Promise<TaskRow[]> {
  const where: any = {}
  if (f.storeIds) where.order = { storeId: { in: f.storeIds } }
  if (f.statuses) where.status = { in: f.statuses }
  if (f.readiness) where.readiness = f.readiness
  if (f.assigneeId) where.assigneeId = f.assigneeId
  if (f.taskKeys) where.taskKey = { in: f.taskKeys }

  const tasks = await prisma.designTask.findMany({
    where,
    include: { order: { include: { store: { include: { project: true } }, lines: true } } },
  })

  const assigneeIds = Array.from(new Set(tasks.map(t => t.assigneeId).filter((x): x is string => !!x)))
  const users = assigneeIds.length ? await prisma.appUser.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } }) : []
  const nameById = new Map(users.map(u => [u.id, u.name]))

  const printed = await prisma.designArtwork.findMany({
    where: { orderId: { in: Array.from(new Set(tasks.map(t => t.orderId))) }, kind: 'PRINT', removedAt: null },
    select: { orderId: true, shopifyLineId: true },
  })
  const printedLines = new Set(printed.map(a => `${a.orderId}\u0000${a.shopifyLineId}`))

  const q = f.q?.trim().toLowerCase()
  const rows: TaskRow[] = []
  for (const task of tasks) {
    const line = task.order.lines.find(l => l.shopifyLineId === task.shopifyLineId)
    if (!line) continue
    if (q) {
      const attrs = parseAttributes(line.customAttributesJson)
      const haystacks = [task.taskKey, line.sku ?? '', line.productTitle, ...visibleCustomAttributes(attrs).map(a => a.value)]
      if (!haystacks.some(h => h.toLowerCase().includes(q))) continue
    }
    rows.push({
      id: task.id, taskKey: task.taskKey, status: task.status as TaskStatus, readiness: task.readiness as Readiness,
      assigneeId: task.assigneeId, assigneeName: task.assigneeId ? (nameById.get(task.assigneeId) ?? null) : null,
      kpi: task.kpi, dueAt: task.dueAt ? task.dueAt.toISOString() : null, slaHours: task.slaHours,
      rejectReasons: parseRejectReasons(task.rejectReasons), rejectNote: task.rejectNote,
      orderId: task.orderId, orderNumber: task.order.shopifyOrderNumber, placedAt: task.order.placedAt.toISOString(),
      shopifyLineId: task.shopifyLineId, linePosition: line.linePosition, sku: line.sku, productTitle: line.productTitle,
      variantTitle: line.variantTitle, previewUrl: line.previewCdnUrl, imageUrl: safeHttpUrl(line.imageUrl), supplierName: task.supplierSnapshot,
      customized: line.customized, storeName: task.order.store.project?.name ?? task.order.store.shop,
      fromLibrary: task.fromLibrary, unmapped: !line.resolvedSupplierId,
      hasPrint: printedLines.has(`${task.orderId}\u0000${task.shopifyLineId}`),
      productKey: line.shopifyProductId ?? line.productTitle,
    })
  }

  rows.sort((a, b) => {
    if (a.dueAt === b.dueAt) return 0
    if (a.dueAt === null) return 1
    if (b.dueAt === null) return -1
    return a.dueAt < b.dueAt ? -1 : 1
  })
  return f.limit !== undefined ? rows.slice(0, f.limit) : rows
}

async function rowFor(taskKey: string): Promise<TaskRow | undefined> {
  return (await listTasks({ taskKeys: [taskKey], statuses: undefined, limit: 1 }))[0]
}

export type SentLineRow = {
  lineId: string; lineKey: string; orderId: string; orderNumber: string; placedAt: string; pipelineStatus: string
  /** The line's own export mark, else the order's (an export made before lines were tracked). */
  sentAt: string | null
  sku: string | null; productTitle: string; variantTitle: string | null; qty: number
  previewUrl: string | null; imageUrl: string | null; supplierName: string | null; storeName: string
  personalization: PersonalizationField[]
  /** The design link(s) the line carried to its supplier. */
  designLinks: string[]
  sourcePrintFiles: SourcePrintFile[]
}

export const SENT_LINES_LIMIT = 50
const SENT_LINES_SCAN = 200

function designLinksOf(stored: string | null): string[] {
  return (stored ?? '').split(DESIGN_LINK_SEPARATOR).map(s => s.trim()).filter(s => isAppFileLink(s) || !!safeHttpUrl(s))
}

/**
 * For a search: product lines of a still-open order that went to a supplier but never had a design task (a design from the
 * library or from outside the studio, exported before the sync made a task). Matched on what a task is matched on, newest order first.
 */
export async function listSentLinesWithoutTask(f: { q: string; storeIds?: string[] | null; limit?: number }): Promise<SentLineRow[]> {
  const q = f.q.trim().replace(/^#/, '')
  if (!q) return []
  const limit = f.limit ?? SENT_LINES_LIMIT
  const orders = await prisma.order.findMany({
    where: {
      ...(f.storeIds ? { storeId: { in: f.storeIds } } : {}),
      pipelineStatus: { notIn: ['FULFILLED', 'CANCELLED', 'REFUNDED'] },
      AND: [
        { OR: [{ pipelineStatus: { in: SENT_ORDER_STATUSES } }, { lines: { some: { exportedAt: { not: null } } } }] },
        { OR: [
          { shopifyOrderNumber: { contains: q.replace(/_\d+$/, '') } },
          { lines: { some: { OR: [{ sku: { contains: q } }, { productTitle: { contains: q } }, { customAttributesJson: { contains: q } }] } } },
        ] },
      ],
    },
    orderBy: { placedAt: 'desc' }, take: SENT_LINES_SCAN,
    select: {
      id: true, shopifyOrderNumber: true, placedAt: true, pipelineStatus: true, fulfillmentStatus: true, exportedAt: true,
      store: { select: { shop: true, project: { select: { name: true } } } },
      designTasks: { select: { shopifyLineId: true } },
      lines: { select: {
        id: true, shopifyLineId: true, linePosition: true, sku: true, productTitle: true, shopifyProductType: true, variantTitle: true, qty: true,
        previewCdnUrl: true, imageUrl: true, customAttributesJson: true, customallFieldsJson: true, designDriveLink: true,
        exportedAt: true, exportedToSupplierId: true, resolvedSupplierId: true,
      } },
    },
  })
  const supplierIds = Array.from(new Set(orders.flatMap(o => o.lines.flatMap(l => [l.exportedToSupplierId, l.resolvedSupplierId])).filter((x): x is string => !!x)))
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : []
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))
  const needle = q.toLowerCase()
  const rows: SentLineRow[] = []
  for (const o of orders) {
    if (isClosedOrder(o) || isShippedOrder(o)) continue
    const keys = lineKeysOf(o.shopifyOrderNumber, o.lines)
    const tasked = new Set(o.designTasks.map(t => t.shopifyLineId))
    for (const line of [...o.lines].sort((a, b) => a.linePosition - b.linePosition)) {
      if (isNonProductLine(line) || tasked.has(line.shopifyLineId) || !isSentLine(o, line)) continue
      const lineKey = keys.get(line.shopifyLineId)!
      const attrs = parseAttributes(line.customAttributesJson)
      const haystacks = [lineKey, line.sku ?? '', line.productTitle, ...visibleCustomAttributes(attrs).map(a => a.value)]
      if (!haystacks.some(h => h.toLowerCase().includes(needle))) continue
      const supplierId = line.exportedToSupplierId ?? line.resolvedSupplierId
      const sentAt = line.exportedAt ?? o.exportedAt
      rows.push({
        lineId: line.id, lineKey, orderId: o.id, orderNumber: o.shopifyOrderNumber, placedAt: o.placedAt.toISOString(), pipelineStatus: o.pipelineStatus,
        sentAt: sentAt ? sentAt.toISOString() : null,
        sku: line.sku, productTitle: line.productTitle, variantTitle: line.variantTitle, qty: line.qty,
        previewUrl: safeHttpUrl(line.previewCdnUrl ?? extractPreviewCdnUrl(attrs)), imageUrl: safeHttpUrl(line.imageUrl),
        supplierName: supplierId ? (supplierName.get(supplierId) ?? null) : null, storeName: o.store.project?.name ?? o.store.shop,
        personalization: linePersonalization(line), designLinks: designLinksOf(line.designDriveLink), sourcePrintFiles: linkedPrintFiles(attrs),
      })
      if (rows.length >= limit) return rows
    }
  }
  return rows
}

async function profileForLine(line: { orderId: string; shopifyProductId?: string | null }) {
  if (!line.shopifyProductId) return null
  const order = await prisma.order.findUnique({ where: { id: line.orderId }, select: { storeId: true } })
  return order ? findProfile(order.storeId, line.shopifyProductId) : null
}

export async function templateForLine(line: TemplateLookupLine, profile?: { printTemplateId: string | null } | null): Promise<TemplateRow | null> {
  const p = profile !== undefined ? profile : await profileForLine(line)
  const ctx = await loadTemplateContext([line], [p?.printTemplateId])
  return pickTemplate(line, p ?? null, ctx)
}

/** The part set the line is filling now (its template's areas, or the alternative set its print files lean towards). */
export async function requiredSlotsForLine(orderId: string, shopifyLineId: string): Promise<string[]> {
  const line = await prisma.orderLine.findFirst({
    where: { orderId, shopifyLineId }, select: { orderId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, shopifyProductType: true },
  })
  if (!line) return []
  const files = await prisma.designArtwork.findMany({ where: { orderId, shopifyLineId, kind: 'PRINT', removedAt: null }, select: { kind: true, printArea: true } })
  return requiredSlotsFor(templateViewFor(await templateForLine(line), files))
}

/** Every part name an upload may land in: the template's areas and those of its alternative sets, so `FRONT.jpg` finds its slot on a one-sheet template. */
export async function uploadSlotsForLine(orderId: string, shopifyLineId: string): Promise<string[]> {
  const line = await prisma.orderLine.findFirst({
    where: { orderId, shopifyLineId }, select: { orderId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, shopifyProductType: true },
  })
  return line ? allSlotNames(await templateForLine(line)) : []
}

/**
 * Takes the print parts left over from before the line used its template out of the task (see `outdatedParts`), so the
 * folder tidy moves their Drive copies to `_old`. Runs after a print file lands; a file that is the line's factory link stays.
 */
export async function retireOutdatedParts(orderId: string, shopifyLineId: string, actorId: string | null): Promise<string[]> {
  const files = await prisma.designArtwork.findMany({
    where: { orderId, shopifyLineId, kind: 'PRINT', removedAt: null }, select: { id: true, printArea: true, version: true, fileName: true, createdAt: true, driveWebViewLink: true },
  })
  const parts = outdatedParts(files, await requiredSlotsForLine(orderId, shopifyLineId))
  if (parts.length === 0) return []
  const line = await prisma.orderLine.findFirst({ where: { orderId, shopifyLineId }, select: { designDriveLink: true } })
  const sent = line?.designDriveLink ?? null
  const retire = files.filter(f => parts.includes(f.printArea) && (!sent || (sent !== artworkUrl(f.id) && sent !== f.driveWebViewLink)))
  if (retire.length === 0) return []
  const task = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId, shopifyLineId } }, select: { id: true } })
  await prisma.$transaction([
    prisma.designArtwork.updateMany({ where: { id: { in: retire.map(f => f.id) }, removedAt: null }, data: { removedAt: new Date(), removedById: actorId } }),
    ...(task ? [prisma.designTaskEvent.create({
      data: {
        taskId: task.id, type: 'ARTWORK', actorId,
        message: `Chuyển vào _old ${retire.length} file của vùng không còn trong template: ${retire.map(f => `${f.printArea} v${f.version}`).join(', ')}`,
      },
    })] : []),
  ])
  return retire.map(f => f.printArea)
}

type ContextLine = TemplateLookupLine & { variantOptions: string | null }

/** The template, product profile and artwork-library state a line is checked against — shared by the task page and the review grid. */
async function lineContext(orderLine: ContextLine | null, storeId: string | null) {
  const productId = orderLine?.shopifyProductId ?? null
  const profileRouteKey = storeId && productId ? toRouteKey(storeId, productId) : null
  const profileRow = storeId && productId ? await findProfile(storeId, productId) : null
  const template = orderLine ? await templateForLine(orderLine, profileRow) : null
  const profile: TaskProfile | null = storeId && productId && profileRouteKey
    ? { key: profileRouteKey, status: await productArtworkStatus(storeId, productId), layerMap: parseLayerMap(profileRow?.layerMap) }
    : null
  const library = await checklistLibraryState({
    storeId, shopifyProductId: productId, templateId: template?.id ?? null,
    variantOptions: orderLine?.variantOptions ?? null, artworkSplits: profileRow?.artworkSplits ?? null,
  })
  return { template, profile, profileRouteKey, library }
}

export async function loadTask(taskKey: string): Promise<TaskDetail | null> {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) return null
  await fillCustomallFields([task.orderId], { throttle: true }).catch(() => null)
  const workspace = await loadWorkspace(task.orderId)
  if (!workspace) return null
  const line = workspace.lines.find(l => l.shopifyLineId === task.shopifyLineId)
  if (!line) return null

  const orderLine = await prisma.orderLine.findFirst({
    where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId },
    select: { orderId: true, resolvedSupplierId: true, resolvedSupplierSku: true, customAttributesJson: true, shopifyProductId: true, variantOptions: true, shopifyProductType: true },
  })
  const productId = orderLine?.shopifyProductId ?? null
  const storeId = productId
    ? (await prisma.order.findUnique({ where: { id: task.orderId }, select: { storeId: true } }))?.storeId ?? null
    : null
  const { template: base, profile, profileRouteKey, library } = await lineContext(orderLine, storeId)
  const template = templateViewFor(base, line.artworks)

  const events = await prisma.designTaskEvent.findMany({ where: { taskId: task.id }, orderBy: { createdAt: 'asc' } })
  const actorIds = Array.from(new Set(events.map(e => e.actorId).filter((x): x is string => !!x)))
  const actors = actorIds.length ? await prisma.appUser.findMany({ where: { id: { in: actorIds } }, select: { id: true, name: true } }) : []
  const actorNameById = new Map(actors.map(a => [a.id, a.name]))

  const assignable = await prisma.appUser.findMany({
    where: { status: 'ACTIVE', role: { in: ['ADMIN', 'SUPPORT', 'SELLER'] } },
    select: { id: true, name: true },
  })
  const settings = await getDesignSettings()
  const row = await rowFor(taskKey)
  if (!row) return null

  return {
    task: row, line, order: workspace.order, template, profile, profileRouteKey,
    events: events.map(e => ({
      id: e.id, type: e.type, message: e.message,
      actorName: e.actorId ? (actorNameById.get(e.actorId) ?? null) : null,
      createdAt: e.createdAt.toISOString(),
    })),
    assignable, settings, prevStatus: (task.prevStatus as TaskStatus | null) ?? null,
    slots: requiredSlotsFor(template),
    driveConnected: await isDriveConnected(),
    driveFolder: task.driveFolderUrl ? { url: task.driveFolderUrl } : null,
    library,
    autoRender: await latestRenderJob(task.orderId, task.shopifyLineId),
    teeinblue: hasTeeinblueDesign(parseAttributes(orderLine?.customAttributesJson ?? null)),
    reopensSentLine: await isSentLineOfOpenOrder(line.id),
  }
}
