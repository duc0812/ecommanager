import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { parseAttributes, safeHttpUrl, sourcePrintFiles, printAreasForLine, updateLine, loadWorkspace, type WorkspaceLine, type Workspace } from '@/lib/design-studio'
import { getDesignSettings, kpiForProductType, type DesignSettings } from '@/lib/design-settings'
import { visibleCustomAttributes } from '@/lib/order-classify'
import { findProfile, parseLayerMap, toRouteKey, type LayerMapEntry } from '@/lib/product-profiles'
import { loadTemplateContext, mapTemplate, pickTemplate, type TemplateLookupLine, type TemplateRow } from '@/lib/print-template-resolve'
import { productArtworkStatus } from '@/lib/artwork-slots'
import type { LibraryProductStatus } from '@/lib/artwork-fields'
import { isDriveConnected } from '@/lib/google-drive'
import { libraryStateFor } from '@/lib/artwork-library-state'
import type { TaskLibraryState } from '@/lib/artwork-library-types'
import type { RenderJobView } from '@/lib/artwork-render-eligibility'
import { latestRenderJob } from '@/lib/artwork-render-jobs'
import { autoRenderEligibility } from '@/lib/artwork-render-eligibility'

export { loadTemplateContext, mapTemplate, pickTemplate, type TemplateRow }

export type TaskStatus = 'NEW' | 'ASSIGNED' | 'DOING' | 'REVIEW' | 'REJECTED' | 'ASK_CUSTOMER' | 'DONE' | 'CANCELLED'
export type Readiness = 'AUTO' | 'LOW' | 'MANUAL'
export type ActorRole = 'LEADER' | 'DESIGNER'
export const TASK_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED', 'ASK_CUSTOMER', 'DONE', 'CANCELLED']
const OPEN: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']
export const FACTORY_REJECT_REASON = 'Xưởng trả file'
const APP_FILE_PREFIX = '/api/design-studio/file/'

export function taskKeyFor(orderNumber: string, linePosition: number): string {
  return `${orderNumber.replace(/^#/, '')}_${linePosition}`
}

export function isLeader(role: string): boolean {
  return role === 'SUPERADMIN' || role === 'ADMIN'
}

export function canTransition(from: TaskStatus, to: TaskStatus, actor: ActorRole): boolean {
  if (from === to) return false
  if (from === 'CANCELLED') return false
  if (to === 'ASK_CUSTOMER') return OPEN.includes(from)
  if (to === 'CANCELLED') return actor === 'LEADER' && [...OPEN, 'ASK_CUSTOMER'].includes(from)
  switch (to) {
    case 'ASSIGNED': return actor === 'LEADER' && (from === 'NEW' || from === 'DOING' || from === 'REJECTED')
    case 'NEW': return from === 'ASSIGNED'
    case 'DOING': return from === 'NEW' || from === 'ASSIGNED' || from === 'DONE' || from === 'REJECTED'
    case 'REVIEW': return from === 'DOING' || from === 'REJECTED'
    case 'DONE': return actor === 'LEADER' && from === 'REVIEW'
    case 'REJECTED': return actor === 'LEADER' && from === 'REVIEW'
    default: return false
  }
}

type ReadinessLine = TemplateLookupLine & { customAttributesJson: string | null; variantOptions: string | null }

/** True when the line resolves to a READY artwork-library entry for a single-area template and the customer filled every field it renders. */
export async function canAutoRenderLine(line: ReadinessLine, storeId: string): Promise<boolean> {
  if (!line.shopifyProductId || !line.resolvedSupplierId) return false
  const profile = await findProfile(storeId, line.shopifyProductId)
  const template = await templateForLine(line, profile)
  if (!template) return false
  const slots = requiredSlotsFor(line, template)
  if (slots.length !== 1) return false
  const library = await libraryStateFor({
    storeId, shopifyProductId: line.shopifyProductId, templateId: template.id,
    variantOptions: line.variantOptions, artworkSplits: profile?.artworkSplits ?? null,
  })
  const personalization = visibleCustomAttributes(parseAttributes(line.customAttributesJson))
  return autoRenderEligibility({ taskStatus: 'NEW', hasTemplate: true, slots, library, personalization, job: null }).ok
}

export async function readinessForLine(line: ReadinessLine, storeId: string): Promise<Readiness> {
  if (sourcePrintFiles(parseAttributes(line.customAttributesJson)).length > 0) return 'LOW'
  return (await canAutoRenderLine(line, storeId)) ? 'AUTO' : 'MANUAL'
}

const READINESS_REFRESH: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REJECTED']

export type SyncResult = { created: number; cancelled: number; completed: number; reopened: number }

function reopenedByFactory(task: { rejectReasons: string | null }): boolean {
  return parseRejectReasons(task.rejectReasons).includes(FACTORY_REJECT_REASON)
}

export async function syncDesignTasks(orderId: string): Promise<SyncResult> {
  const order = await prisma.order.findUnique({ where: { id: orderId }, include: { lines: true, designTasks: true } })
  if (!order) return { created: 0, cancelled: 0, completed: 0, reopened: 0 }
  const settings = await getDesignSettings()
  const supplierIds = Array.from(new Set(order.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[]))
  const suppliers = supplierIds.length ? await prisma.supplier.findMany({ where: { id: { in: supplierIds } }, select: { id: true, name: true } }) : []
  const supplierName = new Map(suppliers.map(s => [s.id, s.name]))
  const orderClosed = ['CANCELLED', 'REFUNDED'].includes(order.pipelineStatus)
  const factoryRejected = order.pipelineStatus === 'DESIGN_REJECTED'
  let created = 0, cancelled = 0, completed = 0, reopened = 0
  const factoryReopen = { status: 'REJECTED', rejectReasons: JSON.stringify([FACTORY_REJECT_REASON]), rejectNote: null, prevStatus: null }
  const factoryEvent = { type: 'SYSTEM', message: 'Xưởng trả file — mở lại task' }

  for (const line of order.lines) {
    if (isNonProductLine(line) || !line.resolvedSupplierId) continue
    const existing = order.designTasks.find(t => t.shopifyLineId === line.shopifyLineId)
    if (orderClosed) {
      if (existing && existing.status !== 'CANCELLED' && existing.status !== 'DONE') {
        await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'CANCELLED', events: { create: { type: 'SYSTEM', message: 'Đơn huỷ — task tự huỷ' } } } })
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
      if (existing && existing.status !== 'DONE' && existing.status !== 'CANCELLED' && !reopenedByFactory(existing)) {
        await prisma.designTask.update({ where: { id: existing.id }, data: { status: 'DONE', events: { create: { type: 'SYSTEM', message: 'Design có từ ngoài studio (Trello / Library) — task done outside' } } } })
        completed++
      }
      if (!factoryRejected) continue
    }
    if (existing) {
      if (READINESS_REFRESH.includes(existing.status as TaskStatus) && existing.readiness !== 'LOW') {
        const readiness = await readinessForLine(line, order.storeId)
        if (readiness !== existing.readiness) await prisma.designTask.update({ where: { id: existing.id }, data: { readiness } })
      }
      continue
    }
    const slaHours = line.customized ? settings.slaCustomHours : settings.slaNonCustomHours
    const reopenNew = factoryRejected && !!line.designDriveLink
    await prisma.designTask.create({ data: {
      orderId, shopifyLineId: line.shopifyLineId, taskKey: taskKeyFor(order.shopifyOrderNumber, line.linePosition),
      status: 'NEW', readiness: await readinessForLine(line, order.storeId), kpi: kpiForProductType(settings, line.shopifyProductType),
      slaHours, dueAt: new Date(order.placedAt.getTime() + slaHours * 3600_000), supplierSnapshot: supplierName.get(line.resolvedSupplierId) ?? null,
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

export type Actor = { id: string; name: string; role: string }
export type TransitionInput = { to: TaskStatus; note?: string; reasons?: string[]; assigneeId?: string; kpi?: number; dueHours?: number; continue?: boolean }

export type TaskRow = {
  id: string; taskKey: string; status: TaskStatus; readiness: Readiness; assigneeId: string | null; assigneeName: string | null
  kpi: number; dueAt: string | null; slaHours: number; rejectReasons: string[]; rejectNote: string | null
  orderId: string; orderNumber: string; placedAt: string; shopifyLineId: string; linePosition: number
  sku: string | null; productTitle: string; variantTitle: string | null; previewUrl: string | null; imageUrl: string | null
  supplierName: string | null; customized: boolean; storeName: string
}

export type TaskProfile = { key: string; status: LibraryProductStatus; layerMap: LayerMapEntry[] }

export type TaskDetail = {
  task: TaskRow; line: WorkspaceLine; order: Workspace['order']; template: TemplateRow | null; profile: TaskProfile | null; profileRouteKey: string | null
  events: { id: string; type: string; message: string; actorName: string | null; createdAt: string }[]
  assignable: { id: string; name: string }[]; settings: DesignSettings; prevStatus: TaskStatus | null
  slots: string[]; driveConnected: boolean; library: TaskLibraryState | null; autoRender: RenderJobView | null
}

export function requiredSlotsFor(line: { customAttributesJson: string | null }, template: TemplateRow | null): string[] {
  const names = template ? Array.from(new Set(template.areas.map(a => a.name).filter(Boolean))) : []
  return names.length > 0 ? names : printAreasForLine(parseAttributes(line.customAttributesJson))
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

export async function transitionTask(taskKey: string, actor: Actor, input: TransitionInput) {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) throw new Error('Task not found')
  const from = task.status as TaskStatus
  const role = actorRole(actor)
  if (!(input.continue && from === 'ASK_CUSTOMER' && input.to === (task.prevStatus ?? 'NEW')) && !canTransition(from, input.to, role)) {
    throw new Error(`Chuyển ${from} → ${input.to} không được phép với vai trò ${role}`)
  }
  if (role !== 'LEADER' && input.to === 'DONE' && await hasAutoArtwork(task.orderId, task.shopifyLineId)) {
    throw new Error('File in tự động phải được leader duyệt')
  }
  if (role !== 'LEADER' && task.assigneeId && task.assigneeId !== actor.id && OWNED_MOVES.includes(input.to)) {
    const owner = await prisma.appUser.findUnique({ where: { id: task.assigneeId }, select: { name: true } })
    throw new Error(`Task đang thuộc về ${owner?.name ?? 'người khác'}`)
  }
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId } })
  if (!line) throw new Error('Line not found')

  const data: any = { status: input.to }
  const events: { type: string; message: string; actorId: string }[] = []
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
    if (!task.assigneeId) data.assigneeId = actor.id
    if (!task.dueAt) data.dueAt = new Date(Date.now() + task.slaHours * 3600_000)
    say('STATUS', from === 'ASK_CUSTOMER' ? 'Tiếp tục làm' : from === 'DONE' ? 'Mở lại để sửa' : 'Nhận việc')
  } else if (input.to === 'REVIEW') {
    if (!input.continue) {
      const missing = await missingArtworkSlots(line)
      if (missing.length > 0) throw new Error(`Chưa có artwork cho: ${missing.join(', ')}`)
    }
    say('STATUS', from === 'ASK_CUSTOMER' ? 'Tiếp tục sau khi hỏi khách' : 'Gửi duyệt')
  } else if (input.to === 'REJECTED') {
    const reasons = input.reasons ?? []
    data.rejectReasons = JSON.stringify(reopenedByFactory(task) && !reasons.includes(FACTORY_REJECT_REASON) ? [FACTORY_REJECT_REASON, ...reasons] : reasons)
    data.rejectNote = input.note ?? null
    say('REJECT', `Trả lại sửa: ${(input.reasons ?? []).join(', ')}${input.note ? ` — ${input.note}` : ''}`)
  } else if (input.to === 'ASK_CUSTOMER') {
    data.prevStatus = from; say('ASK', `Hỏi khách: ${input.note ?? ''}`.trim())
  } else if (input.to === 'DONE') {
    say('STATUS', role === 'LEADER' ? 'Duyệt & gửi xưởng' : 'Duyệt nhanh (file tự động) & gửi xưởng')
  } else if (input.to === 'CANCELLED') {
    say('STATUS', 'Huỷ task')
  }
  if (input.continue) data.prevStatus = null
  if (input.note && !['ASSIGNED', 'REJECTED', 'ASK_CUSTOMER'].includes(input.to)) say('NOTE', input.note)

  let order: { id: string; designReady: boolean; pipelineStatus: string } | null = null
  if (input.to === 'DONE') {
    const current = await prisma.order.findUniqueOrThrow({ where: { id: task.orderId }, select: { id: true, designReady: true, pipelineStatus: true } })
    const externalLink = !!line.designDriveLink && !line.designDriveLink.startsWith(APP_FILE_PREFIX)
      && !(await prisma.designArtwork.findFirst({ where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, driveWebViewLink: line.designDriveLink }, select: { id: true } }))
    if (externalLink && current.pipelineStatus !== 'DESIGN_REJECTED' && !reopenedByFactory(task)) {
      events.splice(0, events.length, ...events.filter(e => e.type !== 'STATUS'), { type: 'SYSTEM', message: 'Design đã có từ ngoài studio — giữ link hiện tại', actorId: actor.id })
      order = current
    } else {
      const template = await templateForLine(line)
      order = (await updateLine(line.id, { done: true, requiredAreas: requiredSlotsFor(line, template) }))?.order ?? null
      data.rejectReasons = null; data.rejectNote = null
    }
  }
  if (from === 'DONE' && input.to === 'DOING') order = (await updateLine(line.id, { done: false }))?.order ?? null

  const updated = await prisma.designTask.update({ where: { id: task.id }, data: { ...data, events: { create: events } } })
  const row = await rowFor(updated.taskKey)
  if (!row) throw new Error('Task row not found after update')
  return { task: row, order }
}

async function hasAutoArtwork(orderId: string, shopifyLineId: string): Promise<boolean> {
  return !!(await prisma.designArtwork.findFirst({ where: { orderId, shopifyLineId, removedAt: null, source: 'AUTO' }, select: { id: true } }))
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
  const missing = await missingArtworkSlots(line)
  if (missing.length > 0) return { moved: false, reason: `Chưa có artwork cho: ${missing.join(', ')}` }
  const moved = await prisma.$transaction(async tx => {
    const r = await tx.designTask.updateMany({ where: { id: task.id, status: task.status }, data: { status: 'REVIEW', readiness: 'AUTO', prevStatus: null } })
    if (r.count === 0) return false
    await tx.designTaskEvent.create({ data: { taskId: task.id, type: 'SYSTEM', message: AUTO_REVIEW_MESSAGE } })
    return true
  })
  return moved ? { moved: true, reason: null } : { moved: false, reason: 'Task vừa đổi trạng thái' }
}

export type ReviewCard = { task: TaskRow; line: WorkspaceLine; slots: string[] }

export async function listReviewCards(f: { assigneeId?: string; q?: string } = {}): Promise<ReviewCard[]> {
  const rows = await listTasks({ statuses: ['REVIEW'], assigneeId: f.assigneeId, q: f.q, limit: 200 })
  if (rows.length === 0) return []
  const orderIds = Array.from(new Set(rows.map(r => r.orderId)))
  const [orderLines, workspaces] = await Promise.all([
    prisma.orderLine.findMany({
      where: { orderId: { in: orderIds } },
      select: { orderId: true, shopifyLineId: true, resolvedSupplierId: true, resolvedSupplierSku: true, shopifyProductId: true, customAttributesJson: true },
    }),
    Promise.all(orderIds.map(id => loadWorkspace(id))),
  ])
  const wsById = new Map(workspaces.filter((w): w is Workspace => !!w).map(w => [w.order.id, w]))
  const cards: ReviewCard[] = []
  for (const task of rows) {
    const line = wsById.get(task.orderId)?.lines.find(l => l.shopifyLineId === task.shopifyLineId)
    const orderLine = orderLines.find(l => l.orderId === task.orderId && l.shopifyLineId === task.shopifyLineId)
    if (!line || !orderLine) continue
    cards.push({ task, line, slots: requiredSlotsFor(orderLine, await templateForLine(orderLine)) })
  }
  return cards
}

async function missingArtworkSlots(line: TemplateLookupLine & { shopifyLineId: string; customAttributesJson: string | null }): Promise<string[]> {
  const template = await templateForLine(line)
  const slots = requiredSlotsFor(line, template)
  const artworks = await prisma.designArtwork.findMany({ where: { orderId: line.orderId, shopifyLineId: line.shopifyLineId, removedAt: null }, select: { printArea: true } })
  return slots.filter(s => !artworks.some(a => a.printArea === s))
}

export async function addTaskNote(taskKey: string, actor: Actor, message: string) {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, select: { id: true } })
  if (!task) throw new Error('Task not found')
  await prisma.designTaskEvent.create({ data: { taskId: task.id, type: 'NOTE', message, actorId: actor.id } })
}

export async function listTasks(f: { statuses?: TaskStatus[]; readiness?: Readiness; assigneeId?: string; q?: string; limit?: number; taskKeys?: string[] }): Promise<TaskRow[]> {
  const where: any = {}
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
    })
  }

  rows.sort((a, b) => {
    if (a.dueAt === b.dueAt) return 0
    if (a.dueAt === null) return 1
    if (b.dueAt === null) return -1
    return a.dueAt < b.dueAt ? -1 : 1
  })
  return rows.slice(0, f.limit ?? 300)
}

async function rowFor(taskKey: string): Promise<TaskRow | undefined> {
  return (await listTasks({ taskKeys: [taskKey], statuses: undefined, limit: 1 }))[0]
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

export async function loadTask(taskKey: string): Promise<TaskDetail | null> {
  const task = await prisma.designTask.findUnique({ where: { taskKey } })
  if (!task) return null
  const workspace = await loadWorkspace(task.orderId)
  if (!workspace) return null
  const line = workspace.lines.find(l => l.shopifyLineId === task.shopifyLineId)
  if (!line) return null

  const orderLine = await prisma.orderLine.findFirst({
    where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId },
    select: { orderId: true, resolvedSupplierId: true, resolvedSupplierSku: true, customAttributesJson: true, shopifyProductId: true, variantOptions: true },
  })
  const productId = orderLine?.shopifyProductId ?? null
  const storeId = productId
    ? (await prisma.order.findUnique({ where: { id: task.orderId }, select: { storeId: true } }))?.storeId ?? null
    : null
  const profileRouteKey = storeId && productId ? toRouteKey(storeId, productId) : null
  const profileRow = storeId && productId ? await findProfile(storeId, productId) : null
  const template = orderLine ? await templateForLine(orderLine, profileRow) : null
  const profile: TaskProfile | null = storeId && productId && profileRouteKey
    ? { key: profileRouteKey, status: await productArtworkStatus(storeId, productId), layerMap: parseLayerMap(profileRow?.layerMap) }
    : null
  const library = await libraryStateFor({
    storeId, shopifyProductId: productId, templateId: template?.id ?? null,
    variantOptions: orderLine?.variantOptions ?? null, artworkSplits: profileRow?.artworkSplits ?? null,
  })

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
    slots: requiredSlotsFor(orderLine ?? { customAttributesJson: null }, template),
    driveConnected: await isDriveConnected(),
    library,
    autoRender: await latestRenderJob(task.orderId, task.shopifyLineId),
  }
}

export async function pruneUntouchedTasksOutside(keepOrderIds: string[]): Promise<number> {
  const stale = await prisma.designTask.findMany({
    where: {
      orderId: { notIn: keepOrderIds },
      status: 'NEW',
      assigneeId: null,
      events: { none: { type: { not: 'SYSTEM' } } },
      order: { artworks: { none: {} } },
    },
    select: { id: true },
  })
  if (stale.length === 0) return 0
  const r = await prisma.designTask.deleteMany({ where: { id: { in: stale.map(t => t.id) } } })
  return r.count
}
