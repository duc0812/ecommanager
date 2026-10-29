import { isLayerlessField } from '@/lib/layer-fields'
import { currentFiles, extraPrintParts, missingPrintAreas, type FileKind } from '@/lib/task-files'
import type { TaskDetail } from './types'
import { productPageUrl } from './model'

export type CheckState = 'done' | 'missing' | 'blocked' | 'na'

export type CheckAction =
  | { kind: 'link'; label: string; href: string }
  | { kind: 'ask'; label: string }
  | { kind: 'refresh'; label: string }
  /** `area` empty = pick any number of files; each file name becomes its own part. */
  | { kind: 'upload'; label: string; area: string; fileKind?: FileKind }
  | { kind: 'submit'; label: string }

export type CheckKey = 'mapping' | 'template' | 'library' | 'customer' | 'files' | 'mockup' | 'submit'

/** An optional item never becomes "the next step" and never holds up the review. */
export type CheckItem = { key: CheckKey; title: string; state: CheckState; reason: string; action: CheckAction | null; optional?: boolean }

export type ChecklistInput = Pick<TaskDetail, 'task' | 'line' | 'template' | 'slots' | 'library' | 'profile'> & {
  me: Pick<TaskDetail['me'], 'isLeader' | 'canApprove'>
}

export type Checklist = { items: CheckItem[]; next: CheckItem | null; done: number; total: number }

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

export const NO_TEMPLATE_REASON = 'Sản phẩm chưa có template — upload file in theo yêu cầu của xưởng'

function templateItem({ line, template, me }: ChecklistInput): CheckItem {
  const title = 'Template in'
  if (template) {
    return { key: 'template', title, state: 'done', reason: `${template.name} · ${template.widthPx}×${template.heightPx} · ${template.areas.length} vùng in`, action: null }
  }
  if (!line.supplier) return { key: 'template', title, state: 'blocked', reason: 'Cần map xưởng trước', action: null }
  // A template is optional: without one the designer uploads the print file straight away. Only admins can open the template setup.
  return {
    key: 'template', title, state: 'na', reason: NO_TEMPLATE_REASON,
    action: me.isLeader ? { kind: 'link', label: 'Thêm template', href: printTemplatesUrl(line.supplier.id) } : null,
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

function libraryItem({ line, template, library }: ChecklistInput): CheckItem {
  const title = 'Artwork gốc của sản phẩm'
  if (!template) {
    return line.supplier
      ? { key: 'library', title, state: 'na', reason: 'Artwork gốc gắn theo template — sản phẩm chưa có template nên bỏ qua', action: null }
      : { key: 'library', title, state: 'blocked', reason: 'Artwork gốc gắn theo template — cần map xưởng trước', action: null }
  }
  if (!library) return { key: 'library', title, state: 'na', reason: 'Dòng không gắn sản phẩm Shopify — không có artwork gốc', action: null }
  const scope = library.optionLabel ? ` (${library.optionLabel})` : ''
  if (library.status === 'READY') {
    return { key: 'library', title, state: 'done', reason: `Artwork gốc sẵn sàng${scope}`, action: { kind: 'link', label: 'Xem', href: productPageUrl(library.key) } }
  }
  return {
    key: 'library', title, state: 'missing', reason: `${LIBRARY_REASON[library.status] ?? `Trạng thái ${library.status}`}${scope}`,
    action: { kind: 'link', label: 'Mở trang sản phẩm', href: productPageUrl(library.key) },
  }
}

export function expectedCustomerFields(input: Pick<ChecklistInput, 'profile'> & { library?: ChecklistInput['library'] }): string[] {
  const fromLibrary = input.library?.entryId ? input.library.layers.map(l => l.field) : []
  const source = fromLibrary.length > 0 ? fromLibrary : (input.profile?.layerMap ?? []).map(e => e.field)
  return source.filter(f => !isLayerlessField(f))
}

export function missingCustomerFields(input: Pick<ChecklistInput, 'line' | 'profile'> & { library?: ChecklistInput['library'] }): string[] {
  const have = new Set(input.line.personalization.map(f => f.key.toLowerCase().trim()))
  const expected = expectedCustomerFields(input)
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
  if (line.customallPending && line.personalization.length === 0) {
    return { key: 'customer', title, state: 'missing', reason: 'Chưa lấy được text khách gõ từ Customall — nạp lại', action: { kind: 'refresh', label: 'Nạp lại từ Shopify' } }
  }
  const missing = missingCustomerFields(input)
  if (missing.length > 0) return { key: 'customer', title, state: 'missing', reason: `Khách chưa điền: ${missing.join(', ')}`, action: ask }
  if (line.personalization.length === 0) {
    if (line.sourcePrintFiles.length > 0) return { key: 'customer', title, state: 'done', reason: 'Có file in nguồn từ app custom', action: null }
    return { key: 'customer', title, state: 'missing', reason: 'Khách không nhập trường custom nào', action: ask }
  }
  return { key: 'customer', title, state: 'done', reason: `${line.personalization.length} trường đã điền`, action: null }
}

export const NO_PRINT_FILE_REASON = 'Chưa có file in — upload ít nhất một file (sản phẩm nhiều mặt in: mỗi mặt một file)'

function filesItem({ line, slots }: ChecklistInput): CheckItem {
  const prints = currentFiles(line.artworks, 'PRINT')
  if (slots.length === 0) {
    const title = 'File in'
    if (prints.length === 0) return { key: 'files', title, state: 'missing', reason: NO_PRINT_FILE_REASON, action: { kind: 'upload', label: 'Upload file in', area: '' } }
    const names = prints.slice(0, 4).map(p => p.printArea).join(', ')
    return { key: 'files', title, state: 'done', reason: `${prints.length} file in: ${names}${prints.length > 4 ? '…' : ''}`, action: null }
  }
  const title = 'File in từng vùng'
  const missing = missingPrintAreas(line.artworks, slots)
  const have = slots.length - missing.length
  const extras = extraPrintParts(line.artworks, slots).length
  const more = extras > 0 ? ` · thêm ${extras} file khác` : ''
  if (missing.length === 0) return { key: 'files', title, state: 'done', reason: `${have}/${slots.length} vùng in đã có file${more}`, action: null }
  return {
    key: 'files', title, state: 'missing', reason: `${have}/${slots.length} vùng in có file — thiếu ${missing.join(', ')}${more}`,
    action: { kind: 'upload', label: `Upload ${missing[0]}`, area: missing[0] },
  }
}

/**
 * Done once a mockup made from the print files is uploaded (rendered locally from the supplier's mockup PSD), so the
 * print can be checked against the listing mockup / customer preview. The preview or product photo never count. Missing never blocks.
 */
function mockupItem({ line }: ChecklistInput): CheckItem {
  const title = 'Mockup từ files in'
  const have = currentFiles(line.artworks, 'MOCKUP').length
  if (have > 0) return { key: 'mockup', title, state: 'done', reason: `${have} mockup — so với mockup gốc / preview để QA`, action: null, optional: true }
  return {
    key: 'mockup', title, state: 'missing', optional: true,
    reason: 'Chưa có mockup dựng từ file in — upload ảnh mockup để QA với mockup gốc / preview (không chặn gửi duyệt)',
    action: { kind: 'upload', label: 'Upload mockup', area: '', fileKind: 'MOCKUP' },
  }
}

function submitItem(input: ChecklistInput, filesDone: boolean): CheckItem {
  const { task, me } = input
  const title = 'Gửi duyệt / trạng thái'
  switch (task.status) {
    case 'DONE': return { key: 'submit', title, state: 'done', reason: 'Đã duyệt design', action: null }
    case 'CANCELLED': return { key: 'submit', title, state: 'na', reason: 'Task đã huỷ', action: null }
    case 'ASK_CUSTOMER': return { key: 'submit', title, state: 'blocked', reason: 'Đang hỏi khách — chờ trả lời rồi tiếp tục', action: null }
    case 'REVIEW':
      return me.canApprove
        ? { key: 'submit', title, state: 'missing', reason: me.isLeader ? 'Designer đã gửi — chờ bạn duyệt' : 'Mẫu đang chờ duyệt — bạn duyệt được', action: { kind: 'submit', label: 'Duyệt design' } }
        : { key: 'submit', title, state: 'blocked', reason: 'Đã gửi duyệt — chờ leader duyệt', action: null }
  }
  if (!filesDone) {
    const reason = input.slots.length > 0 ? 'Cần đủ file cho mọi vùng in trước khi gửi duyệt' : 'Cần ít nhất một file in trước khi gửi duyệt'
    return { key: 'submit', title, state: 'blocked', reason, action: null }
  }
  const again = task.status === 'REJECTED'
  return {
    key: 'submit', title, state: 'missing',
    reason: again ? `Bị trả lại${task.rejectReasons.length ? `: ${task.rejectReasons.join(', ')}` : ''} — sửa rồi gửi lại` : 'Đủ file — gửi duyệt',
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
    next: items.find(i => !i.optional && (i.state === 'missing' || i.state === 'blocked')) ?? null,
    done: counted.filter(i => i.state === 'done').length,
    total: counted.length,
  }
}
