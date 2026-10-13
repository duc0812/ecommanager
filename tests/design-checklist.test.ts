import { describe, it, expect } from 'vitest'
import { buildChecklist, missingCustomerFields, type ChecklistInput } from '@/app/design-studio/components/checklist'

const art = (printArea: string, kind = 'PRINT') => ({ printArea, id: `${kind}-${printArea}`, version: 1, kind } as any)
const template = { id: 't1', name: 'Tumbler 40oz', widthPx: 2700, heightPx: 1200, dpi: 300, bleedIn: 0, safeIn: 0, mirror: false, areas: [{ name: 'Wrap', x: 0, y: 0, w: 2700, h: 1200 }], guideImageUrl: null, templateUrl: null }

function input(over: { task?: any; line?: any; template?: any; slots?: string[]; library?: any; profile?: any; isLeader?: boolean; canApprove?: boolean } = {}): ChecklistInput {
  return {
    task: { status: 'DOING', rejectReasons: [], ...over.task },
    line: {
      supplier: { id: 'sup1', name: 'Mangoshao', code: 'MGS' }, supplierSku: 'TU20-40OZ', sku: 'HAPO-40', customized: true, attributesLoaded: true,
      personalization: [{ key: 'Name', value: 'Ann' }], sourcePrintFiles: [], artworks: [art('Artwork')], ...over.line,
    },
    template: 'template' in over ? over.template : null,
    slots: over.slots ?? [],
    library: 'library' in over ? over.library : null,
    profile: over.profile ?? null,
    me: { isLeader: over.isLeader ?? false, canApprove: over.canApprove ?? over.isLeader ?? false },
  } as ChecklistInput
}

const byKey = (c: ReturnType<typeof buildChecklist>, key: string) => c.items.find(i => i.key === key)!

describe('buildChecklist', () => {
  it('LIT4610_1: mapped, no template, one artwork — template and master artwork are not applicable, the task goes straight on', () => {
    const c = buildChecklist(input())
    expect(c.items.map(i => i.key)).toEqual(['mapping', 'template', 'library', 'customer', 'files', 'mockup', 'submit'])
    expect(byKey(c, 'mapping').state).toBe('done')
    const tpl = byKey(c, 'template')
    expect(tpl).toMatchObject({ state: 'na', reason: 'Sản phẩm chưa có template — upload file in theo yêu cầu của xưởng' })
    expect(tpl.action).toBeNull()
    expect(byKey(c, 'library').state).toBe('na')
    expect(byKey(c, 'files')).toMatchObject({ title: 'File in', state: 'done', reason: '1 file in: Artwork' })
    expect(byKey(c, 'mockup')).toMatchObject({ state: 'missing', optional: true })
    expect(byKey(c, 'submit')).toMatchObject({ state: 'missing', action: { kind: 'submit', label: 'Gửi duyệt' } })
    expect(c.next?.key).toBe('submit')
    expect(c.total).toBe(5)
    expect(c.done).toBe(3)
  })

  it('no template and no file yet: the next step is the print file, not the template', () => {
    const c = buildChecklist(input({ line: { artworks: [] } }))
    expect(byKey(c, 'template').state).toBe('na')
    expect(byKey(c, 'library').state).toBe('na')
    expect(c.next).toMatchObject({ key: 'files', state: 'missing', action: { kind: 'upload', area: '', label: 'Upload file in' } })
    expect(byKey(c, 'submit')).toMatchObject({ state: 'blocked', reason: 'Cần ít nhất một file in trước khi gửi duyệt' })
  })

  it('only an admin gets the link to the template setup; it never becomes the next step', () => {
    const admin = buildChecklist(input({ isLeader: true, line: { artworks: [] } }))
    expect(byKey(admin, 'template')).toMatchObject({ state: 'na', action: { kind: 'link', label: 'Thêm template', href: '/fulfillment/suppliers/sup1/print-templates' } })
    expect(admin.next?.key).toBe('files')
    expect(byKey(buildChecklist(input({ isLeader: false, canApprove: true })), 'template').action).toBeNull()
  })

  it('an unmapped line links to the mapping page and blocks the template', () => {
    const c = buildChecklist(input({ line: { supplier: null, supplierSku: null } }))
    expect(byKey(c, 'mapping')).toMatchObject({ state: 'missing', action: { kind: 'link', href: '/fulfillment/mapping' } })
    expect(byKey(c, 'template').state).toBe('blocked')
    expect(byKey(c, 'library').state).toBe('blocked')
    expect(c.next?.key).toBe('mapping')
  })

  it('reports the library entry state for the line\'s template', () => {
    const ready = buildChecklist(input({ template, library: { key: 'k1', entryId: 'e', status: 'READY', label: 'Sẵn sàng', optionKey: '', optionLabel: null, layers: [] } }))
    expect(byKey(ready, 'library').state).toBe('done')
    const none = buildChecklist(input({ template, library: { key: 'k1', entryId: null, status: 'NONE', label: 'Thiếu', optionKey: '', optionLabel: null, layers: [] } }))
    expect(byKey(none, 'library')).toMatchObject({ state: 'missing', action: { kind: 'link', label: 'Mở trang sản phẩm', href: '/design-studio/products/k1' } })
    const parsing = buildChecklist(input({ template, library: { key: 'k 1', entryId: 'e', status: 'PARSING', label: 'Đang đọc', optionKey: '', optionLabel: null, layers: [] } }))
    expect(byKey(parsing, 'library')).toMatchObject({ state: 'missing', reason: 'Worker đang đọc PSD', action: { href: '/design-studio/products/k%201' } })
    const split = buildChecklist(input({ template, library: { key: 'k1', entryId: 'e', status: 'NEEDS_REVIEW', label: 'Thiếu', optionKey: '{"Size":"30oz"}', optionLabel: 'Size: 30oz', layers: [] } }))
    expect(byKey(split, 'library').reason).toBe('Đã đọc PSD — cần duyệt trường (Size: 30oz)')
    expect(byKey(buildChecklist(input({ template, library: null })), 'library').state).toBe('na')
  })

  it('customer info: profile fields left empty ask the customer; non-custom is n.a.', () => {
    const profile = { key: 'p', status: 'READY', masterArtworkUrl: null, layerMap: [{ field: 'Name', layer: 'name', fit: 'shrink' }, { field: 'Number', layer: 'number', fit: 'shrink' }] } as any
    const c = buildChecklist(input({ profile }))
    expect(byKey(c, 'customer')).toMatchObject({ state: 'missing', reason: 'Khách chưa điền: Number', action: { kind: 'ask', label: 'Hỏi khách' } })
    expect(byKey(buildChecklist(input({ line: { customized: false, personalization: [] } })), 'customer').state).toBe('na')
    expect(byKey(buildChecklist(input({ line: { personalization: [] } })), 'customer')).toMatchObject({ state: 'missing', action: { kind: 'ask' } })
    expect(byKey(buildChecklist(input({ line: { attributesLoaded: false } })), 'customer').action).toEqual({ kind: 'refresh', label: 'Nạp lại từ Shopify' })
    expect(byKey(buildChecklist(input({ task: { status: 'ASK_CUSTOMER' } })), 'customer').state).toBe('blocked')
  })

  it('missingCustomerFields matches case-insensitively', () => {
    const profile = { layerMap: [{ field: ' name ', layer: 'n', fit: 'none' }] } as any
    expect(missingCustomerFields({ line: { personalization: [{ key: 'NAME', value: 'x' }] } as any, profile })).toEqual([])
  })

  it('expected customer fields come from the resolved library entry before the old layerMap', () => {
    const profile = { layerMap: [{ field: 'Name', layer: 'n', fit: 'none' }] } as any
    const library = { key: 'k', entryId: 'e', status: 'READY', label: 'Sẵn sàng', optionKey: '', optionLabel: null, layers: [{ field: 'Name', layer: '@Name', fit: 'shrink' }, { field: 'Year', layer: '@Year', fit: 'shrink' }] } as any
    const line = { personalization: [{ key: 'Name', value: 'x' }] } as any
    expect(missingCustomerFields({ line, profile, library })).toEqual(['Year'])
    expect(missingCustomerFields({ line, profile, library: { ...library, layers: [] } })).toEqual([])
  })

  it('files: missing areas give an upload action for the first one and block the submit', () => {
    const c = buildChecklist(input({ slots: ['Front', 'Back'], line: { artworks: [art('Back')] } }))
    expect(byKey(c, 'files')).toMatchObject({ state: 'missing', reason: '1/2 vùng in có file — thiếu Front', action: { kind: 'upload', area: 'Front' } })
    expect(byKey(c, 'submit').state).toBe('blocked')
  })

  it('files without a template: one print file is enough, however many sides the product has; a mockup is not a print file', () => {
    const three = buildChecklist(input({ line: { artworks: [art('front'), art('back'), art('sleeve')] } }))
    expect(byKey(three, 'files')).toMatchObject({ state: 'done', reason: '3 file in: back, front, sleeve' })
    expect(byKey(buildChecklist(input({ line: { artworks: [art('front')] } })), 'files').state).toBe('done')
    const onlyMockup = buildChecklist(input({ line: { artworks: [art('look', 'MOCKUP')] } }))
    expect(byKey(onlyMockup, 'files').state).toBe('missing')
    expect(byKey(onlyMockup, 'submit').state).toBe('blocked')
    expect(onlyMockup.next?.key).toBe('files')
  })

  it('files with a template: every area needs a file; extra files and mockups do not fill an area', () => {
    const slots = ['Front', 'Back']
    const partial = buildChecklist(input({ template, slots, line: { artworks: [art('Front'), art('Sleeve'), art('Back', 'MOCKUP')] } }))
    expect(byKey(partial, 'files')).toMatchObject({ title: 'File in từng vùng', state: 'missing', reason: '1/2 vùng in có file — thiếu Back · thêm 1 file khác', action: { kind: 'upload', area: 'Back' } })
    expect(byKey(partial, 'submit')).toMatchObject({ state: 'blocked', reason: 'Cần đủ file cho mọi vùng in trước khi gửi duyệt' })
    const full = buildChecklist(input({ template, slots, line: { artworks: [art('Front'), art('Back'), art('Sleeve')] } }))
    expect(byKey(full, 'files')).toMatchObject({ state: 'done', reason: '2/2 vùng in đã có file · thêm 1 file khác' })
  })

  it('mockup: done with an uploaded mockup or a preview / product image; missing never becomes the next step nor blocks the submit', () => {
    expect(byKey(buildChecklist(input({ line: { artworks: [art('Artwork'), art('look', 'MOCKUP')] } })), 'mockup')).toMatchObject({ state: 'done', reason: '1 mockup đã upload — nằm cùng thư mục với file in' })
    expect(byKey(buildChecklist(input({ line: { previewUrl: 'https://cdn/p.png' } })), 'mockup')).toMatchObject({ state: 'done', reason: 'Dùng ảnh preview khách tạo lúc đặt hàng' })
    expect(byKey(buildChecklist(input({ line: { imageUrl: 'https://cdn/v.png' } })), 'mockup')).toMatchObject({ state: 'done', reason: 'Dùng ảnh sản phẩm Shopify' })

    const none = buildChecklist(input())
    expect(byKey(none, 'mockup')).toMatchObject({ state: 'missing', optional: true, action: { kind: 'upload', area: '', fileKind: 'MOCKUP', label: 'Upload mockup' } })
    expect(byKey(none, 'submit').state).toBe('missing')
    expect(none.next?.key).toBe('submit')
    const done = buildChecklist(input({ task: { status: 'DONE' } }))
    expect(byKey(done, 'mockup').state).toBe('missing')
    expect(done.next).toBeNull()
  })

  it('submit follows the task status', () => {
    expect(byKey(buildChecklist(input({ task: { status: 'DONE' } })), 'submit').state).toBe('done')
    expect(byKey(buildChecklist(input({ task: { status: 'CANCELLED' } })), 'submit').state).toBe('na')
    expect(byKey(buildChecklist(input({ task: { status: 'REVIEW' } })), 'submit').state).toBe('blocked')
    expect(byKey(buildChecklist(input({ task: { status: 'REVIEW' }, isLeader: true })), 'submit')).toMatchObject({ state: 'missing', action: { label: 'Duyệt design' } })
    expect(byKey(buildChecklist(input({ task: { status: 'REVIEW' }, canApprove: true })), 'submit')).toMatchObject({ state: 'missing', action: { label: 'Duyệt design' } })
    expect(byKey(buildChecklist(input({ task: { status: 'DONE' } })), 'submit')).toMatchObject({ state: 'done', reason: 'Đã duyệt design' })
    expect(byKey(buildChecklist(input({ task: { status: 'REJECTED', rejectReasons: ['Sai chính tả'] } })), 'submit'))
      .toMatchObject({ reason: 'Bị trả lại: Sai chính tả — sửa rồi gửi lại', action: { label: 'Gửi duyệt lại' } })
  })

  it('has no next step when everything is done', () => {
    const c = buildChecklist(input({
      template, slots: ['Wrap'], line: { artworks: [art('Wrap')], previewUrl: 'https://cdn/p.png' },
      library: { key: 'k', entryId: 'e', status: 'READY', label: 'Sẵn sàng', optionKey: '', optionLabel: null, layers: [] }, task: { status: 'DONE' },
    }))
    expect(c.next).toBeNull()
    expect(c.done).toBe(c.total)
  })
})
