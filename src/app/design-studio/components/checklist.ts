import { isLayerlessField } from '@/lib/layer-fields'
import type { TaskDetail } from './types'

export type CheckState = 'done' | 'missing' | 'blocked' | 'na'

export type CheckAction =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'ask'; label: string }
  | { kind: 'refresh'; label: string }
  | { kind: 'upload'; label: string; area: string }
  | { kind: 'submit'; label: string }

export type CheckKey = 'mapping' | 'template' | 'library' | 'customer' | 'files' | 'mockup' | 'submit'

export type CheckItem = { key: CheckKey; title: string; state: CheckState; reason: string; action: CheckAction | null }

export type ChecklistInput = Pick<TaskDetail, 'task' | 'line' | 'template' | 'slots' | 'library' | 'profile'> & {
  me: Pick<TaskDetail['me'], 'isLeader'>
  supplierNeedsMockup?: boolean | null
}

export type Checklist = { items: CheckItem[]; next: CheckItem | null; done: number; total: number }

export function libraryPageUrl(key: string): string {
  return `/design-studio/library/${encodeURIComponent(key)}`
}

export function printTemplatesUrl(supplierId: string): string {
  return `/fulfillment/suppliers/${encodeURIComponent(supplierId)}/print-templates`
}

function mappingItem({ line }: ChecklistInput): CheckItem {
  const title = 'Mapping xưởng'
  if (line.supplier) {
    return { key: 'mapping', title, state: 'done', reason: `${line.supplier.name}${line.supplierSku ? ` · SKU xưởng ${line.supplierSku}` : ''}`, action: null }
  }
  return { key: 'mapping', title, state: 'missing', reason: 'Dòng này chưa map xưởng — chưa biết template và yêu cầu file', action: { kind: 'link', label: 'Mở Mapping', href: '/fulfillment/mapping' } }
}

function templateItem({ line, template }: ChecklistInput): CheckItem {
  const title = 'Template in'
  if (template) {
    return { key: 'template', title, state: 'done', reason: `${template.name} · ${template.widthPx}×${template.heightPx} · ${template.areas.length} vùng in`, action: null }
  }
  if (!line.supplier) return { key: 'template', title, state: 'blocked', reason: 'Cần map xưởng trước', action: null }
  const sku = line.supplierSku ?? line.sku ?? '—'
  return {
    key: 'template', title, state: 'missing', reason: `Chưa có template cho ${sku} (${line.supplier.name})`,
    action: { kind: 'link', label: 'Thêm template', href: printTemplatesUrl(line.supplier.id) },
  }
}

const LIBRARY_REASON: Record<string, string> = {
  NONE: 'Chưa có artwork gốc cho template này',
  EMPTY: 'Chưa có artwork gốc cho template này',
  QUEUED: 'PSD đang chờ worker đọc',
  PARSING: 'Worker đang đọc PSD',
  NEEDS_FONTS: 'Thiếu font — upload font để đọc PSD',
  NEEDS_REVIEW: 'Đã đọc PSD — cần duyệt trường',
  ERROR: 'Đọc PSD lỗi — xem lại file',
}

function libraryItem({ template, library }: ChecklistInput): CheckItem {
  const title = 'Artwork gốc (Artwork Library)'
  if (!template) return { key: 'library', title, state: 'blocked', reason: 'Artwork gốc gắn theo template — cần template trước', action: null }
  if (!library) return { key: 'library', title, state: 'na', reason: 'Dòng không gắn sản phẩm Shopify — không dùng Artwork Library', action: null }
  if (library.status === 'READY') return { key: 'library', title, state: 'done', reason: 'Artwork gốc sẵn sàng', action: { kind: 'link', label: 'Xem', href: libraryPageUrl(library.key) } }
  return {
    key: 'library', title, state: 'missing', reason: LIBRARY_REASON[library.status] ?? `Trạng thái ${library.status}`,
    action: { kind: 'link', label: 'Mở Artwork Library', href: libraryPageUrl(library.key) },
  }
}

export function missingCustomerFields(input: Pick<ChecklistInput, 'line' | 'profile'>): string[] {
  const have = new Set(input.line.personalization.map(f => f.key.toLowerCase().trim()))
  const expected = (input.profile?.layerMap ?? []).map(e => e.field).filter(f => !isLayerlessField(f))
  return Array.from(new Set(expected.filter(f => !have.has(f.toLowerCase().trim()))))
}

function customerItem(input: ChecklistInput): CheckItem {
  const { line, task } = input
  const title = 'Thông tin khách'
  const ask: CheckAction = { kind: 'ask', label: 'Hỏi khách' }
  if (!line.customized) return { key: 'customer', title, state: 'na', reason: 'Non-custom — không cần thông tin khách', action: null }
  if (task.status === 'ASK_CUSTOMER') return { key: 'customer', title, state: 'blocked', reason: 'Đang chờ CS hỏi khách', action: null }
  if (!line.attributesLoaded) {
    return { key: 'customer', title, state: 'missing', reason: 'Chưa có dữ liệu custom — nạp lại từ Shopify', action: { kind: 'refresh', label: 'Nạp lại từ Shopify' } }
  }
  const missing = missingCustomerFields(input)
  if (missing.length > 0) return { key: 'customer', title, state: 'missing', reason: `Khách chưa điền: ${missing.join(', ')}`, action: ask }
  if (line.personalization.length === 0) {
    if (line.sourcePrintFiles.length > 0) return { key: 'customer', title, state: 'done', reason: 'Có file in nguồn từ app custom', action: null }
    return { key: 'customer', title, state: 'missing', reason: 'Khách không nhập trường custom nào', action: ask }
  }
  return { key: 'customer', title, state: 'done', reason: `${line.personalization.length} trường đã điền`, action: null }
}

function filesItem({ line, slots }: ChecklistInput): CheckItem {
  const title = 'File in từng vùng'
  if (slots.length === 0) return { key: 'files', title, state: 'na', reason: 'Không có vùng in nào', action: null }
  const missing = slots.filter(s => !line.artworks.some(a => a.printArea === s))
  const have = slots.length - missing.length
  if (missing.length === 0) return { key: 'files', title, state: 'done', reason: `${have}/${slots.length} vùng in đã có file`, action: null }
  return {
    key: 'files', title, state: 'missing', reason: `${have}/${slots.length} vùng in có file — thiếu ${missing.join(', ')}`,
    action: { kind: 'upload', label: `Upload ${missing[0]}`, area: missing[0] },
  }
}

function mockupItem({ supplierNeedsMockup, line }: ChecklistInput): CheckItem {
  const title = 'Mockup xưởng'
  if (!supplierNeedsMockup) return { key: 'mockup', title, state: 'na', reason: 'Xưởng không yêu cầu mockup', action: null }
  const hasArt = line.artworks.length > 0
  return { key: 'mockup', title, state: hasArt ? 'missing' : 'blocked', reason: hasArt ? 'Xưởng yêu cầu mockup — dựng từ file in' : 'Cần file in trước khi dựng mockup', action: null }
}

function submitItem(input: ChecklistInput, filesDone: boolean): CheckItem {
  const { task, me } = input
  const title = 'Gửi duyệt / trạng thái'
  switch (task.status) {
    case 'DONE': return { key: 'submit', title, state: 'done', reason: 'Đã duyệt & gửi xưởng', action: null }
    case 'CANCELLED': return { key: 'submit', title, state: 'na', reason: 'Task đã huỷ', action: null }
    case 'ASK_CUSTOMER': return { key: 'submit', title, state: 'blocked', reason: 'Đang hỏi khách — chờ trả lời rồi tiếp tục', action: null }
    case 'REVIEW':
      return me.isLeader
        ? { key: 'submit', title, state: 'missing', reason: 'Designer đã gửi — chờ bạn duyệt', action: { kind: 'submit', label: 'Duyệt & gửi xưởng' } }
        : { key: 'submit', title, state: 'blocked', reason: 'Đã gửi duyệt — chờ leader duyệt', action: null }
  }
  if (!filesDone) return { key: 'submit', title, state: 'blocked', reason: 'Cần đủ file cho mọi vùng in trước khi gửi duyệt', action: null }
  const again = task.status === 'REJECTED'
  return {
    key: 'submit', title, state: 'missing',
    reason: again ? `Leader trả lại${task.rejectReasons.length ? `: ${task.rejectReasons.join(', ')}` : ''} — sửa rồi gửi lại` : 'Đủ file — gửi leader duyệt',
    action: { kind: 'submit', label: again ? 'Gửi duyệt lại' : 'Gửi duyệt' },
  }
}

export function buildChecklist(input: ChecklistInput): Checklist {
  const files = filesItem(input)
  const items = [
    mappingItem(input),
    templateItem(input),
    libraryItem(input),
    customerItem(input),
    files,
    mockupItem(input),
    submitItem(input, files.state === 'done' || files.state === 'na'),
  ]
  const counted = items.filter(i => i.state !== 'na')
  return {
    items,
    next: items.find(i => i.state === 'missing' || i.state === 'blocked') ?? null,
    done: counted.filter(i => i.state === 'done').length,
    total: counted.length,
  }
}
