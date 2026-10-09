import { describe, it, expect } from 'vitest'
import { buildChecklist, missingCustomerFields, type ChecklistInput } from '@/app/design-studio/components/checklist'

const art = (printArea: string) => ({ printArea, id: printArea, version: 1 } as any)
const template = { id: 't1', name: 'Tumbler 40oz', widthPx: 2700, heightPx: 1200, dpi: 300, bleedIn: 0, safeIn: 0, mirror: false, areas: [{ name: 'Wrap', x: 0, y: 0, w: 2700, h: 1200 }], guideImageUrl: null, templateUrl: null }

function input(over: { task?: any; line?: any; template?: any; slots?: string[]; library?: any; profile?: any; isLeader?: boolean; supplierNeedsMockup?: boolean } = {}): ChecklistInput {
  return {
    task: { status: 'DOING', rejectReasons: [], ...over.task },
    line: {
      supplier: { id: 'sup1', name: 'Mangoshao', code: 'MGS' }, supplierSku: 'TU20-40OZ', sku: 'HAPO-40', customized: true, attributesLoaded: true,
      personalization: [{ key: 'Name', value: 'Ann' }], sourcePrintFiles: [], artworks: [art('Artwork')], ...over.line,
    },
    template: 'template' in over ? over.template : null,
    slots: over.slots ?? ['Artwork'],
    library: 'library' in over ? over.library : null,
    profile: over.profile ?? null,
    me: { isLeader: over.isLeader ?? false },
    supplierNeedsMockup: over.supplierNeedsMockup,
  } as ChecklistInput
}

const byKey = (c: ReturnType<typeof buildChecklist>, key: string) => c.items.find(i => i.key === key)!

describe('buildChecklist', () => {
  it('LIT4610_1: mapped, no template, one artwork — the template is the next step and links to the supplier setup', () => {
    const c = buildChecklist(input())
    expect(c.items.map(i => i.key)).toEqual(['mapping', 'template', 'library', 'customer', 'files', 'mockup', 'submit'])
    expect(byKey(c, 'mapping').state).toBe('done')
    const tpl = byKey(c, 'template')
    expect(tpl).toMatchObject({ state: 'missing', reason: 'Chưa có template cho TU20-40OZ (Mangoshao)' })
    expect(tpl.action).toEqual({ kind: 'link', label: 'Thêm template', href: '/fulfillment/suppliers/sup1/print-templates' })
    expect(byKey(c, 'library').state).toBe('blocked')
    expect(byKey(c, 'files')).toMatchObject({ state: 'done', reason: '1/1 vùng in đã có file' })
    expect(byKey(c, 'mockup').state).toBe('na')
    expect(byKey(c, 'submit')).toMatchObject({ state: 'missing', action: { kind: 'submit', label: 'Gửi duyệt' } })
    expect(c.next?.key).toBe('template')
    expect(c.total).toBe(6)
    expect(c.done).toBe(3)
  })

  it('an unmapped line links to the mapping page and blocks the template', () => {
    const c = buildChecklist(input({ line: { supplier: null, supplierSku: null } }))
    expect(byKey(c, 'mapping')).toMatchObject({ state: 'missing', action: { kind: 'link', href: '/fulfillment/mapping' } })
    expect(byKey(c, 'template').state).toBe('blocked')
    expect(c.next?.key).toBe('mapping')
  })

  it('falls back to the shop SKU in the template reason when there is no supplier SKU', () => {
    expect(byKey(buildChecklist(input({ line: { supplierSku: null } })), 'template').reason).toBe('Chưa có template cho HAPO-40 (Mangoshao)')
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

  it('mockup only matters when the supplier asks for one', () => {
    expect(byKey(buildChecklist(input({ supplierNeedsMockup: true })), 'mockup').state).toBe('missing')
    expect(byKey(buildChecklist(input({ supplierNeedsMockup: true, line: { artworks: [] } })), 'mockup').state).toBe('blocked')
  })

  it('submit follows the task status', () => {
    expect(byKey(buildChecklist(input({ task: { status: 'DONE' } })), 'submit').state).toBe('done')
    expect(byKey(buildChecklist(input({ task: { status: 'CANCELLED' } })), 'submit').state).toBe('na')
    expect(byKey(buildChecklist(input({ task: { status: 'REVIEW' } })), 'submit').state).toBe('blocked')
    expect(byKey(buildChecklist(input({ task: { status: 'REVIEW' }, isLeader: true })), 'submit')).toMatchObject({ state: 'missing', action: { label: 'Duyệt & gửi xưởng' } })
    expect(byKey(buildChecklist(input({ task: { status: 'REJECTED', rejectReasons: ['Sai chính tả'] } })), 'submit'))
      .toMatchObject({ reason: 'Leader trả lại: Sai chính tả — sửa rồi gửi lại', action: { label: 'Gửi duyệt lại' } })
  })

  it('has no next step when everything is done', () => {
    const c = buildChecklist(input({ template, library: { key: 'k', entryId: 'e', status: 'READY', label: 'Sẵn sàng', optionKey: '', optionLabel: null, layers: [] }, task: { status: 'DONE' } }))
    expect(c.next).toBeNull()
    expect(c.done).toBe(c.total)
  })
})
