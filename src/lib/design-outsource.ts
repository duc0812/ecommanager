import { createHash, randomBytes } from 'crypto'
import { prisma } from '@/lib/db'
import type { Prisma } from '@/generated/prisma/client'
import type { AuthUser } from '@/lib/api-auth'
import { canManageOutsource } from '@/lib/roles'
import { linePersonalization } from '@/lib/design-studio'
import { templateForLine, requiredSlotsFor } from '@/lib/design-tasks'
import { loadTemplateContext, pickTemplate, type TemplateRow } from '@/lib/print-template-resolve'
import { currentFiles } from '@/lib/task-files'
import type { OutsourceDetail, OutsourceManagement, OutsourceRow } from '@/lib/design-outsource-shared'
import { assertSafeExternalUrl } from '@/lib/safe-url'
import { assertNoOutsourceReview } from '@/lib/design-outsource-lock'
import { sourceTemplateVersion, templateStamp } from '@/lib/design-outsource-template'
import { printFileFit } from '@/lib/print-file-fit'

export class OutsourceError extends Error {
  constructor(message: string, readonly status = 400) { super(message) }
}

export function driveTemplateLinks(value: unknown) {
  if (typeof value !== 'string') throw new OutsourceError('Cần link template Google Drive')
  let u: URL
  try { u = new URL(value.trim()) } catch { throw new OutsourceError('Link Drive không hợp lệ') }
  if (u.protocol !== 'https:' || u.hostname !== 'drive.google.com' || u.port || u.username || u.password) throw new OutsourceError('Template phải là link HTTPS trên drive.google.com')
  const folder = u.pathname.match(/^\/drive\/(?:u\/\d+\/)?folders\/([\w-]+)\/?$/)
  const file = u.pathname.match(/^\/file\/d\/([\w-]+)(?:\/view|\/preview|\/edit)?\/?$/)
  const id = file?.[1] ?? (['/open', '/uc'].includes(u.pathname) ? u.searchParams.get('id') : null)
  if (folder) return { view: `https://drive.google.com/drive/folders/${folder[1]}`, download: `https://drive.google.com/drive/folders/${folder[1]}` }
  if (!id || !/^[\w-]+$/.test(id)) throw new OutsourceError('Dùng link file hoặc thư mục template Drive')
  return { view: `https://drive.google.com/file/d/${id}/view`, download: `https://drive.google.com/uc?export=download&id=${id}` }
}

function text(value: unknown, label: string, max = 4000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new OutsourceError(`${label} không được trống và tối đa ${max} ký tự`)
  return value.trim()
}

function technicalOptions(json: string | null) {
  try {
    const options = JSON.parse(json ?? '{}')
    return Object.entries(options).filter(([key, value]) => /^(size|color|colour|kích thước|màu|màu sắc)$/i.test(key.trim()) && typeof value === 'string').map(([key, value]) => ({ key, value: String(value) }))
  } catch { return [] }
}

export function assertOutsourceManager(user: AuthUser) {
  if (!canManageOutsource(user)) throw new OutsourceError('Bạn không có quyền quản lý outsource', 403)
}

async function taskContext(taskKey: string) {
  const task = await prisma.designTask.findUnique({ where: { taskKey }, include: { outsource: true } })
  if (!task) throw new OutsourceError('Không tìm thấy task', 404)
  const line = await prisma.orderLine.findFirst({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId } })
  if (!line) throw new OutsourceError('Dòng task đang đồng bộ, thử lại sau', 409)
  const template = await templateForLine(line)
  return { task, line, template }
}

async function packageDefaults({ task, line, template }: Awaited<ReturnType<typeof taskContext>>) {
  const mappedProduct = line.resolvedSupplierId && line.resolvedSupplierSku
    ? await prisma.supplierProduct.findUnique({ where: { supplierId_sku: { supplierId: line.resolvedSupplierId, sku: line.resolvedSupplierSku } }, select: { designTemplateUrl: true } })
    : null
  const previous = task.outsource
  const candidates = [template?.templateUrl, mappedProduct?.designTemplateUrl]
  if (previous?.active) candidates.unshift(previous.templateUrl)
  else candidates.push(previous?.templateUrl)
  let templateUrl = ''
  for (const candidate of candidates) {
    if (!candidate) continue
    try { templateUrl = driveTemplateLinks(candidate).view; break } catch { /* Try the next mapped source. */ }
  }

  const fields = linePersonalization(line)
  const shared: { key: string; value: string }[] = previous ? JSON.parse(previous.personalization) : []
  const selectedFieldIndexes = fields.flatMap((f, i) => {
    const selected = previous ? shared.some(v => v.key === f.key && v.value === f.value)
      : /^(?:(?:custom|personalized|pet|your) )?(?:name|text|font|colou?r|number|initials|tên|chữ|màu)(?: [1-9])?$/i.test(f.key.trim()) && !/(?:https?:\/\/|@)/i.test(f.value)
    return selected ? [i] : []
  })
  const referenceKind = previous
    ? (previous.referenceUrl && previous.referenceUrl === line.previewCdnUrl ? 'preview' : previous.referenceUrl && previous.referenceUrl === line.imageUrl ? 'image' : 'none')
    : (line.previewCdnUrl ? 'preview' : line.imageUrl ? 'image' : 'none')
  let reference: OutsourceManagement['reference'] = referenceKind
  if (reference !== 'none') {
    try { assertSafeExternalUrl((reference === 'preview' ? line.previewCdnUrl : line.imageUrl)!) } catch { reference = 'none' }
  }
  return {
    templateUrl, templateLabel: previous?.templateLabel ?? 'Template in',
    brief: previous?.brief || 'Làm mẫu theo template và nội dung được giao. Nộp file in cho từng vùng trên template.',
    fields, selectedFieldIndexes, reference,
  }
}

export async function outsourceManagement(taskKey: string, user: AuthUser): Promise<OutsourceManagement> {
  assertOutsourceManager(user)
  const context = await taskContext(taskKey)
  const { task, line, template } = context
  const defaults = await packageDefaults(context)
  const users = await prisma.appUser.findMany({ where: { status: 'ACTIVE', role: 'OUTSOURCE' }, select: { id: true, name: true, permissions: true } })
  const a = task.outsource
  return {
    assignment: a ? { code: a.code, revision: a.revision, active: a.active, assigneeId: a.assigneeId, brief: a.brief, templateLabel: a.templateLabel, templateUrl: a.templateUrl } : null,
    users: users.filter(u => { try { return JSON.parse(u.permissions).includes('design_outsource') } catch { return false } }).map(u => ({ id: u.id, name: u.name })),
    templateUrl: defaults.templateUrl, templateLabel: defaults.templateLabel, brief: defaults.brief, hasTemplate: !!template,
    personalization: defaults.fields.map(f => ({ key: f.key, value: f.value })),
    hasPreview: !!line.previewCdnUrl, hasImage: !!line.imageUrl,
    technicalOptions: technicalOptions(line.variantOptions),
    selectedFieldIndexes: defaults.selectedFieldIndexes, reference: defaults.reference,
  }
}

export async function assignOutsource(taskKey: string, user: AuthUser, input: Record<string, unknown>) {
  assertOutsourceManager(user)
  const context = await taskContext(taskKey)
  const { task, line, template } = context
  const defaults = await packageDefaults(context)
  if (!template) throw new OutsourceError('Task chưa có template in, bổ sung template trước khi giao')
  const brief = text(input.brief || defaults.brief, 'Yêu cầu outsource')
  const templateLabel = text(input.templateLabel || defaults.templateLabel, 'Tên template trung lập', 120)
  const links = driveTemplateLinks(input.templateUrl || defaults.templateUrl)
  const assigneeId = text(input.assigneeId, 'Người làm', 100)
  const assignee = await prisma.appUser.findUnique({ where: { id: assigneeId } })
  if (!assignee || assignee.role !== 'OUTSOURCE' || assignee.status !== 'ACTIVE' || !JSON.parse(assignee.permissions).includes('design_outsource')) throw new OutsourceError('Chọn tài khoản Design Outsource đang hoạt động')
  const referenceKind = input.reference ?? defaults.reference
  const reference = referenceKind === 'preview' ? line.previewCdnUrl : referenceKind === 'image' ? line.imageUrl : null
  if (reference) assertSafeExternalUrl(reference)
  const fields = defaults.fields
  const selected = Array.isArray(input.fieldIndexes) ? input.fieldIndexes.filter((i): i is number => Number.isInteger(i) && Number(i) >= 0 && Number(i) < fields.length) : defaults.selectedFieldIndexes
  const personalization = JSON.stringify(Array.from(new Set(selected)).map(i => ({ key: fields[i].key, value: fields[i].value })))
  let dueAt = task.dueAt
  if (input.dueAt !== undefined && input.dueAt !== '') {
    if (typeof input.dueAt !== 'string' || !Number.isFinite(new Date(input.dueAt).getTime())) throw new OutsourceError('Hạn trả không hợp lệ')
    dueAt = new Date(input.dueAt)
  }
  const sourceVersion = templateStamp(template)
  const version = createHash('sha256').update(JSON.stringify([sourceVersion, links.view, randomBytes(16).toString('hex')])).digest('hex')
  return prisma.$transaction(async tx => {
    const live = await tx.designTask.findUniqueOrThrow({ where: { id: task.id }, include: { outsource: true } })
    await assertNoOutsourceReview(tx, task.id)
    if (live.fromLibrary || line.dropship) throw new OutsourceError('Dòng này không cần giao thiết kế', 409)
    if (await tx.designAgentJob.count({ where: { taskId: task.id, status: { in: ['QUEUED', 'RUNNING'] }, kind: { not: 'LIBRARY_APPLY' } } })) throw new OutsourceError('Design Agent đang giữ task', 409)
    const old = live.outsource
    if (old && input.revision !== old.revision) throw new OutsourceError('Lần giao đã thay đổi, tải lại trước khi lưu', 409)
    if (input.action === 'refresh') {
      if (!old?.active || old.assigneeId !== assigneeId) throw new OutsourceError('Cập nhật template chỉ áp dụng cho người đang được giao', 409)
      if (!['ASSIGNED', 'DOING', 'REJECTED', 'ASK_CUSTOMER'].includes(live.status)) throw new OutsourceError('Chỉ cập nhật template khi task chưa gửi duyệt', 409)
    } else {
      if (!['NEW', 'ASSIGNED', 'REJECTED'].includes(live.status)) throw new OutsourceError('Task đang làm hoặc đã gửi duyệt; cần thu hồi trước khi giao lại', 409)
      if (live.assigneeId && !old?.active) throw new OutsourceError('Task đang có người giữ, trả về hàng đợi trước khi chuyển outsource', 409)
      if (await tx.designArtwork.count({ where: { orderId: task.orderId, shopifyLineId: task.shopifyLineId, removedAt: null } }) && !old) throw new OutsourceError('Task đã có file đang xử lý, không chuyển outsource tự động', 409)
    }
    if (await tx.artworkJob.count({ where: { kind: 'RENDER_LINE', orderId: task.orderId, shopifyLineId: task.shopifyLineId, status: { in: ['QUEUED', 'RUNNING'] } } })) throw new OutsourceError('Task đang có lệnh render, chưa chuyển outsource được', 409)
    const data = { assigneeId, active: true, brief, templateLabel, templateUrl: links.view, templateSnapshot: JSON.stringify({ ...template, sourceVersion, technicalOptions: technicalOptions(line.variantOptions) }), templateVersion: version, confirmedTemplateVersion: input.action === 'refresh' ? null : version, referenceUrl: reference, personalization }
    const a = old
      ? await tx.designOutsource.update({ where: { id: old.id }, data: { ...data, ...(input.action !== 'refresh' ? { revision: { increment: 1 } } : {}) } })
      : await tx.designOutsource.create({ data: { ...data, taskId: task.id, code: `OUT-${randomBytes(5).toString('hex').toUpperCase()}` } })
    await tx.designTask.update({ where: { id: task.id }, data: { assigneeId, dueAt, ...(input.action !== 'refresh' ? { status: 'ASSIGNED', prevStatus: null } : {}), events: { create: { type: 'ASSIGN', actorId: user.id, message: `${input.action === 'refresh' ? 'Cập nhật gói' : 'Giao'} outsource ${a.code} · ${assignee.name}` } } } })
    await tx.designOutsourceMessage.create({ data: { outsourceId: a.id, revision: a.revision, side: 'SYSTEM', message: input.action === 'refresh' ? 'Template hoặc yêu cầu đã cập nhật. Kiểm tra và xác nhận trước khi nộp lại.' : 'Đã giao việc. Đọc yêu cầu và tải template để bắt đầu.' } })
    return { code: a.code, revision: a.revision }
  })
}

export async function revokeOutsource(taskKey: string, user: AuthUser, revision: unknown) {
  assertOutsourceManager(user)
  const { task } = await taskContext(taskKey)
  return prisma.$transaction(async tx => {
    const a = await tx.designOutsource.findUnique({ where: { taskId: task.id } })
    if (!a?.active || a.revision !== revision) throw new OutsourceError('Lần giao đã thay đổi, tải lại trước khi thu hồi', 409)
    const live = await tx.designTask.findUniqueOrThrow({ where: { id: task.id } })
    await assertNoOutsourceReview(tx, task.id)
    await tx.designOutsource.update({ where: { id: a.id }, data: { active: false, revision: { increment: 1 } } })
    await tx.designTask.update({ where: { id: task.id }, data: { assigneeId: null, status: ['DONE', 'CANCELLED', 'REJECTED'].includes(live.status) ? live.status : 'NEW', prevStatus: null, events: { create: { type: 'ASSIGN', message: `Thu hồi outsource ${a.code}`, actorId: user.id } } } })
    return { ok: true }
  })
}

function accessWhere(user: AuthUser) {
  if (canManageOutsource(user)) return { active: true }
  if (user.role !== 'OUTSOURCE' || !user.permissions.includes('design_outsource')) throw new OutsourceError('Bạn không có quyền Design Outsource', 403)
  return { active: true, assigneeId: user.id }
}

export async function visibleOutsource(code: string, user: AuthUser) {
  const a = await prisma.designOutsource.findFirst({ where: { code, ...accessWhere(user) }, include: { task: true } })
  if (!a) throw new OutsourceError('Không tìm thấy task', 404)
  return a
}

type Assignment = Awaited<ReturnType<typeof visibleOutsource>>
function row(a: Assignment): OutsourceRow {
  return { code: a.code, revision: a.revision, status: a.task.status, dueAt: a.task.dueAt?.toISOString() ?? null, updatedAt: a.updatedAt.toISOString(), referenceUrl: a.referenceUrl ? `/api/design-studio/outsource/${a.code}/assets?kind=reference&r=${a.revision}` : null }
}

export async function listOutsource(user: AuthUser) {
  const rows = await prisma.designOutsource.findMany({ where: accessWhere(user), include: { task: true }, orderBy: { task: { dueAt: 'asc' } } })
  return { tasks: rows.map(row), canManage: canManageOutsource(user) }
}

export async function currentOutsourceTemplate(a: Assignment) {
  const line = await prisma.orderLine.findFirst({ where: { orderId: a.task.orderId, shopifyLineId: a.task.shopifyLineId } })
  return line ? templateForLine(line) : null
}

export async function loadOutsource(code: string, user: AuthUser): Promise<OutsourceDetail> {
  const a = await visibleOutsource(code, user)
  const [artworks, messages, current] = await Promise.all([
    prisma.designArtwork.findMany({ where: { outsourceId: a.id, outsourceRevision: a.revision, removedAt: null }, orderBy: { version: 'desc' } }),
    prisma.designOutsourceMessage.findMany({ where: { outsourceId: a.id, revision: a.revision }, orderBy: { createdAt: 'asc' } }),
    currentOutsourceTemplate(a),
  ])
  const t: TemplateRow = JSON.parse(a.templateSnapshot)
  const slots = requiredSlotsFor(t)
  const base = `/api/design-studio/outsource/${a.code}`
  const latest = currentFiles(artworks, 'PRINT')
  return {
    ...row(a), ...(canManageOutsource(user) ? { internalTaskKey: a.task.taskKey } : {}), brief: a.brief, templateLabel: a.templateLabel, templateUrl: a.templateUrl, downloadUrl: driveTemplateLinks(a.templateUrl).download,
    templateVersion: a.templateVersion, templateChanged: !current || templateStamp(current) !== sourceTemplateVersion(a),
    templateConfirmed: a.confirmedTemplateVersion === a.templateVersion,
    template: { id: a.code, name: a.templateLabel, widthPx: t.widthPx, heightPx: t.heightPx, dpi: t.dpi, bleedIn: t.bleedIn, safeIn: t.safeIn, mirror: t.mirror, areas: t.areas, guideImageUrl: t.guideImageUrl ? `${base}/assets?kind=guide&r=${a.revision}` : null, templateUrl: a.templateUrl },
    slots, technicalOptions: JSON.parse(a.templateSnapshot).technicalOptions ?? [], personalization: JSON.parse(a.personalization), canManage: canManageOutsource(user),
    artworks: artworks.map(f => ({ id: f.id, kind: f.kind as 'PRINT' | 'MOCKUP', printArea: f.printArea, version: f.version, fileName: f.fileName, size: f.size, mimeType: f.mimeType, uploadedById: null, createdAt: f.createdAt.toISOString(), url: `${base}/files/${f.id}?r=${a.revision}`, widthPx: f.widthPx, heightPx: f.heightPx, storage: 'LOCAL', driveFileId: null, driveWebViewLink: null, source: 'MANUAL', previewUrl: `${base}/files/${f.id}?preview=1&r=${a.revision}` })),
    messages: messages.map(m => ({ id: m.id, side: m.side, message: m.message, createdAt: m.createdAt.toISOString() })),
    qa: (slots.length ? slots : ['File in']).map(area => {
      const file = latest.find(f => f.kind === 'PRINT' && (!slots.length || f.printArea === area))
      if (!file) return { area, state: 'missing', message: 'Chưa có file in' }
      if (file.outsourceTemplateVersion !== a.templateVersion) return { area, state: 'warning', message: 'File thuộc template cũ, cần nộp lại' }
      const fit = printFileFit(t, area, file)
      if (fit.state === 'unknown') return { area, state: 'warning', message: 'Chưa đọc được kích thước, nội bộ cần kiểm tra' }
      return fit.state === 'ok' ? { area, state: 'ok', message: `${file.widthPx} × ${file.heightPx} px` } : { area, state: 'warning', message: `${file.widthPx ?? '?'} × ${file.heightPx ?? '?'} px — kiểm tra khổ yêu cầu ${fit.expected?.w ?? t.widthPx} × ${fit.expected?.h ?? t.heightPx} px` }
    }),
  }
}

export async function lockOutsource<T>(a: Assignment, user: AuthUser, revision: number, run: (tx: Prisma.TransactionClient, live: Assignment) => Promise<T>) {
  return prisma.$transaction(async tx => {
    const claimed = await tx.designOutsource.updateMany({ where: { id: a.id, active: true, revision, assigneeId: a.assigneeId, ...(canManageOutsource(user) ? {} : { assigneeId: user.id }) }, data: { updatedAt: new Date() } })
    if (!claimed.count) throw new OutsourceError('Task đã được thu hồi hoặc giao lại, tải lại danh sách', 409)
    const live = await tx.designOutsource.findUniqueOrThrow({ where: { id: a.id }, include: { task: true } })
    await assertNoOutsourceReview(tx, live.taskId)
    if (live.task.assigneeId !== live.assigneeId) throw new OutsourceError('Người giữ task đã thay đổi, liên hệ nội bộ', 409)
    return run(tx, live)
  })
}

export async function actOutsource(code: string, user: AuthUser, input: Record<string, unknown>) {
  const a = await visibleOutsource(code, user)
  if (!Number.isInteger(input.revision)) throw new OutsourceError('Thiếu phiên bản giao việc', 409)
  const current = await currentOutsourceTemplate(a)
  return lockOutsource(a, user, Number(input.revision), async (tx, live) => {
    const from = live.task.status
    const action = input.action
    const manager = canManageOutsource(user)
    let to: string | null = null
    let message = ''
    let prevStatus: string | null | undefined
    if (action === 'message') {
      message = text(input.message, 'Nội dung trao đổi', 2000)
    } else if (action === 'confirm-template') {
      if (!current || templateStamp(current) !== sourceTemplateVersion(live)) throw new OutsourceError('Template đã đổi, chờ nội bộ cập nhật gói', 409)
      await tx.designOutsource.update({ where: { id: live.id }, data: { confirmedTemplateVersion: live.templateVersion } })
      message = 'Đã xác nhận template và yêu cầu cập nhật.'
    } else {
      if (manager) throw new OutsourceError('Duyệt và trả sửa tại Design Tasks; chỉ người được giao thao tác làm việc', 403)
      if (action === 'start' && ['ASSIGNED', 'REJECTED'].includes(from)) { to = 'DOING'; message = 'Đã bắt đầu làm.' }
      if (action === 'withdraw' && from === 'REVIEW') { to = 'DOING'; message = 'Đã rút mẫu về để sửa.' }
      if (action === 'ask' && ['ASSIGNED', 'DOING', 'REJECTED'].includes(from)) { to = 'ASK_CUSTOMER'; prevStatus = from; message = `Cần bổ sung thông tin: ${text(input.message, 'Câu hỏi', 2000)}` }
      if (action === 'resume' && from === 'ASK_CUSTOMER') { to = ['ASSIGNED', 'DOING', 'REJECTED'].includes(live.task.prevStatus ?? '') ? live.task.prevStatus : 'DOING'; prevStatus = null; message = 'Đã tiếp tục làm.' }
      if (action === 'submit' && ['DOING', 'REJECTED'].includes(from)) {
        if (!current || templateStamp(current) !== sourceTemplateVersion(live) || live.confirmedTemplateVersion !== live.templateVersion) throw new OutsourceError('Template đã đổi hoặc chưa được xác nhận; kiểm tra lại trước khi gửi', 409)
        const files = currentFiles(await tx.designArtwork.findMany({ where: { outsourceId: live.id, outsourceRevision: live.revision, removedAt: null, kind: 'PRINT' }, orderBy: { version: 'desc' } }), 'PRINT')
        const slots = requiredSlotsFor(JSON.parse(live.templateSnapshot))
        if (!files.length || (slots.length ? slots.some(s => !files.some(f => f.printArea === s && f.outsourceTemplateVersion === live.templateVersion)) : files.some(f => f.outsourceTemplateVersion !== live.templateVersion))) throw new OutsourceError('Cần file in đúng phiên bản template cho đủ mọi vùng in')
        to = 'REVIEW'; message = 'Đã gửi mẫu, đang chờ nội bộ duyệt.'
      }
      if (!to) throw new OutsourceError('Thao tác không phù hợp với trạng thái hiện tại', 409)
    }
    if (['DONE', 'CANCELLED'].includes(from)) throw new OutsourceError('Task đã kết thúc', 409)
    if (to) await tx.designTask.update({ where: { id: live.taskId }, data: { status: to, ...(prevStatus !== undefined ? { prevStatus } : {}), events: { create: { type: 'STATUS', actorId: user.id, message: `Outsource ${live.code}: ${message}` } } } })
    await tx.designOutsourceMessage.create({ data: { outsourceId: live.id, revision: live.revision, side: action === 'message' || action === 'ask' ? (manager ? 'INTERNAL' : 'OUTSOURCE') : 'SYSTEM', message } })
    return { ok: true }
  })
}

export async function assertOutsourceUpload(tx: Prisma.TransactionClient, id: string, revision: number, userId: string, version: string) {
  const a = await tx.designOutsource.findUnique({ where: { id }, include: { task: true } })
  if (!a?.active || a.revision !== revision || a.assigneeId !== userId || a.task.assigneeId !== userId || !['DOING', 'REJECTED'].includes(a.task.status) || a.templateVersion !== version) throw new OutsourceError('Lần giao hoặc trạng thái task đã thay đổi, tải lại trước khi upload', 409)
  await assertNoOutsourceReview(tx, a.taskId)
  const line = await tx.orderLine.findFirst({ where: { orderId: a.task.orderId, shopifyLineId: a.task.shopifyLineId }, include: { order: { select: { storeId: true } } } })
  if (!line) throw new OutsourceError('Dòng task đang đồng bộ', 409)
  const profile = line.shopifyProductId ? await tx.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId: line.order.storeId, shopifyProductId: line.shopifyProductId } }, select: { printTemplateId: true } }) : null
  const template = pickTemplate(line, profile, await loadTemplateContext([line], [profile?.printTemplateId], tx))
  if (!template || templateStamp(template) !== sourceTemplateVersion(a) || a.confirmedTemplateVersion !== version) throw new OutsourceError('Template đã đổi hoặc chưa xác nhận; liên hệ nội bộ trước khi upload', 409)
  await tx.designOutsource.update({ where: { id }, data: { updatedAt: new Date() } })
}
