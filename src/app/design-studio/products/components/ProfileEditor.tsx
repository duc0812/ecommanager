'use client'
import { useId, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import TemplateCanvas, { CanvasTools, type CanvasBg } from '../../components/TemplateCanvas'
import type { TemplateListRow } from '../../components/types'
import { productUrl, putJson } from '../../components/model'
import { Card, ErrorBanner, Icon, Note, PROFILE_META, Pill, btn, card, input } from '../../components/ui'
import type { LayerRow, OverrideRow, ProductDetail, SaveResponse, SupplierProductOption } from './types'
import {
  FITS, groupBySupplier, isHttpUrl, layerRowsToMap, overrideRowsToPayload, referencedSupplierIds, shopLabel, supplierProductLabel,
  toLayerRows, toOverrideRows,
} from './profile-form'

type Form = {
  supplierProductId: string; overrides: OverrideRow[]; printTemplateId: string; masterUrl: string; layers: LayerRow[]; notes: string
}

function initForm(d: ProductDetail): Form {
  const p = d.profile
  return {
    supplierProductId: p?.supplierProductId ?? '',
    overrides: toOverrideRows(p?.overrides ?? []),
    printTemplateId: p?.printTemplateId ?? '',
    masterUrl: p?.masterArtworkUrl ?? '',
    layers: toLayerRows(p?.layerMap ?? [], d.observedFields),
    notes: p?.notes ?? '',
  }
}

function Field({ label, children, className = '' }: { label: string; children: ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-[2px] text-label-sm text-on-surface-variant min-w-0 ${className}`}>
      {label}
      {children}
    </label>
  )
}

function SupplierProductSelect({ value, onChange, products, label, emptyLabel, filter = '' }: {
  value: string; onChange: (v: string) => void; products: SupplierProductOption[]; label: string; emptyLabel: string; filter?: string
}) {
  const f = filter.trim().toLowerCase()
  const visible = f
    ? products.filter(p => p.id === value || `${supplierProductLabel(p)} ${p.supplier.name} ${p.supplier.code} ${p.productType ?? ''}`.toLowerCase().includes(f))
    : products
  const missing = value && !products.some(p => p.id === value)
  return (
    <select className={`${input} w-full`} value={value} onChange={e => onChange(e.target.value)} aria-label={label}>
      <option value="">{emptyLabel}</option>
      {missing && <option value={value}>{value} (không còn trong danh sách xưởng)</option>}
      {groupBySupplier(visible).map(g => (
        <optgroup key={g.supplierId} label={g.label}>
          {g.items.map(p => <option key={p.id} value={p.id}>{supplierProductLabel(p)}</option>)}
        </optgroup>
      ))}
    </select>
  )
}

export default function ProfileEditor({ detail, templates, canEdit, onSaved }: {
  detail: ProductDetail; templates: TemplateListRow[]; canEdit: boolean; onSaved: () => Promise<ProductDetail | null>
}) {
  const ids = useId()
  const [form, setForm] = useState<Form>(() => initForm(detail))
  const [baseline, setBaseline] = useState(() => JSON.stringify(initForm(detail)))
  const [spFilter, setSpFilter] = useState('')
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [guide, setGuide] = useState(50)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setMessage(''); setForm(f => ({ ...f, [k]: v })) }
  const setOverride = (i: number, patch: Partial<OverrideRow>) => set('overrides', form.overrides.map((o, j) => (j === i ? { ...o, ...patch } : o)))
  const setLayer = (i: number, patch: Partial<LayerRow>) => set('layers', form.layers.map((l, j) => (j === i ? { ...l, ...patch } : l)))

  const sps = detail.supplierProducts
  const selectedSp = sps.find(p => p.id === form.supplierProductId)
  const supplierIds = useMemo(
    () => referencedSupplierIds(sps, [form.supplierProductId, ...form.overrides.map(o => o.supplierProductId)].filter(Boolean)),
    [sps, form.supplierProductId, form.overrides],
  )
  const templateOptions = supplierIds.size > 0 ? detail.templates.filter(t => supplierIds.has(t.supplierId)) : detail.templates
  const currentTemplateHidden = form.printTemplateId && !templateOptions.some(t => t.id === form.printTemplateId)
  const templateOtherSupplier = !!currentTemplateHidden && supplierIds.size > 0
  const dirty = JSON.stringify(form) !== baseline
  const currentTemplateName = detail.templates.find(t => t.id === form.printTemplateId)?.name ?? form.printTemplateId
  const previewTemplate = templates.find(t => t.id === form.printTemplateId) ?? null
  const masterPreview = isHttpUrl(form.masterUrl) ? form.masterUrl.trim() : null

  const optionNames = useMemo(() => {
    const names = new Set<string>()
    for (const v of detail.summary.variants) for (const k of Object.keys(v.options)) names.add(k)
    return Array.from(names)
  }, [detail.summary.variants])
  const valuesFor = (option: string) => {
    const vals = new Set<string>()
    for (const v of detail.summary.variants) { const x = v.options[option]; if (x) vals.add(x) }
    return Array.from(vals)
  }

  const meta = PROFILE_META[detail.status]
  const { summary } = detail

  async function save() {
    if (saving) return
    setError(''); setMessage('')
    const layers = layerRowsToMap(form.layers)
    if (!layers.ok) { setError(layers.error); return }
    const overrides = overrideRowsToPayload(form.overrides)
    if (!overrides.ok) { setError(overrides.error); return }
    if (templateOtherSupplier) { setError('Template thuộc xưởng khác — chọn lại'); return }
    if (form.masterUrl.trim() && !masterPreview) { setError('Link master artwork phải là http(s)'); return }
    setSaving(true)
    const r = await putJson<SaveResponse>(productUrl(detail.key), {
      supplierProductId: form.supplierProductId || null,
      overrides: overrides.overrides,
      printTemplateId: form.printTemplateId || null,
      masterArtworkUrl: form.masterUrl.trim() || null,
      layerMap: layers.layerMap,
      notes: form.notes,
    })
    if (!r.ok) { setSaving(false); setError(r.error); return }
    const { ordersUpdated, tasksTouched, errors } = r.data.reevaluation
    setMessage(`Đã lưu · cập nhật ${ordersUpdated} đơn · ${tasksTouched} task`)
    if (errors.length > 0) setError(`Đồng bộ task lỗi: ${errors.join('; ')}`)
    const fresh = await onSaved()
    if (fresh) {
      const next = initForm(fresh)
      setForm(next)
      setBaseline(JSON.stringify(next))
    }
    setSaving(false)
  }

  return (
    <div className="grid grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] gap-lg items-start">
      <div className="sticky top-md flex flex-col gap-md min-w-0">
        <Card icon="preview" title="Xem trước" right={previewTemplate ? previewTemplate.name : undefined}>
          {previewTemplate ? (
            <>
              <CanvasTools bg={bg} onBg={setBg} guide={guide} onGuide={setGuide} hasGuide={!!previewTemplate.guideImageUrl} />
              <TemplateCanvas template={previewTemplate} masterUrl={masterPreview} bg={bg} guide={guide} />
            </>
          ) : (
            <div className="rounded-lg border border-dashed border-outline-variant/60 bg-surface-container-low p-xl grid place-items-center text-center text-body-sm text-on-surface-variant gap-xs">
              <Icon name="dashboard_customize" className="text-[32px]" />
              Chưa chọn template
            </div>
          )}
        </Card>

        <section className={`${card} p-md flex gap-md min-w-0`}>
          {summary.imageUrl
            // eslint-disable-next-line @next/next/no-img-element
            ? <img src={summary.imageUrl} alt={summary.title} className="w-20 h-20 rounded-lg object-cover border border-outline-variant/20 shrink-0" />
            : <span className="w-20 h-20 rounded-lg bg-surface-container grid place-items-center shrink-0"><Icon name="image" className="text-[28px] text-on-surface-variant" /></span>}
          <div className="flex flex-col gap-xs min-w-0 flex-1">
            <b className="text-body-md text-on-surface">{summary.title}</b>
            <div className="flex flex-wrap gap-x-md gap-y-xs text-label-sm text-on-surface-variant">
              <span className="inline-flex items-center gap-xs"><Icon name="storefront" className="text-[16px]" />{shopLabel(detail.shop)}</span>
              <span className="inline-flex items-center gap-xs font-mono"><Icon name="tag" className="text-[16px]" />{detail.shopifyProductId.replace('gid://shopify/Product/', '')}</span>
              <span className="inline-flex items-center gap-xs"><Icon name="receipt_long" className="text-[16px]" /><b className="text-on-surface">{summary.orderCount}</b> đơn</span>
              <span className="inline-flex items-center gap-xs"><Icon name="brush" className="text-[16px]" /><b className="text-on-surface">{summary.openTasks}</b> task mở</span>
              {summary.lastOrderAt && <span className="inline-flex items-center gap-xs"><Icon name="event" className="text-[16px]" />{new Date(summary.lastOrderAt).toLocaleDateString('en-US')}</span>}
            </div>
            {summary.variants.length > 0 && (
              <ul className="flex flex-col gap-[2px] max-h-40 overflow-auto text-label-sm">
                {summary.variants.map(v => (
                  <li key={v.shopifyVariantId} className="flex gap-sm">
                    <span className="text-on-surface truncate">{v.variantTitle ?? v.shopifyVariantId}</span>
                    <span className="ml-auto text-on-surface-variant font-mono whitespace-nowrap">{v.supplierSku ?? 'chưa map'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <div className="flex flex-col gap-md min-w-0">
        {!detail.profile && canEdit && <Note tone="idle" icon="info">Sản phẩm này chưa có hồ sơ — điền và bấm Lưu hồ sơ để tạo.</Note>}
        <fieldset disabled={!canEdit} className="flex flex-col gap-md min-w-0 border-0 p-0 m-0">
          <Card icon="factory" title="Xưởng" right="mặc định cho mọi biến thể">
            <Field label="Lọc sản phẩm xưởng">
              <input type="search" className={input} value={spFilter} onChange={e => setSpFilter(e.target.value)} placeholder="SKU, tên, xưởng…" />
            </Field>
            <Field label="Sản phẩm xưởng">
              <SupplierProductSelect value={form.supplierProductId} onChange={v => set('supplierProductId', v)} products={sps} filter={spFilter}
                label="Sản phẩm xưởng mặc định" emptyLabel="— không chọn (dùng Product Mapping) —" />
            </Field>
            {selectedSp && (
              <div className="flex flex-wrap gap-x-md gap-y-xs text-label-sm text-on-surface-variant">
                <span>{selectedSp.supplier.name} ({selectedSp.supplier.code})</span>
                {selectedSp.productType && <span>{selectedSp.productType}</span>}
                {typeof selectedSp.baseCost === 'number' && <span>Giá gốc <b className="text-on-surface">${selectedSp.baseCost.toFixed(2)}</b></span>}
              </div>
            )}
          </Card>

          <Card icon="call_split" title="Ghi đè theo option" right={`${form.overrides.length} dòng`}>
            {form.overrides.length === 0 && <p className="text-body-sm text-on-surface-variant">Chưa có ghi đè — mọi biến thể dùng sản phẩm xưởng mặc định.</p>}
            <datalist id={`${ids}-options`}>{optionNames.map(n => <option key={n} value={n} />)}</datalist>
            {form.overrides.map((o, i) => (
              <div key={i} className="flex flex-col gap-xs">
                <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(0,2fr)_auto] gap-xs items-center">
                  <input className={input} value={o.option} onChange={e => setOverride(i, { option: e.target.value })} list={`${ids}-options`} aria-label={`Ghi đè ${i + 1}: tên option`} placeholder="Option (vd Size)" />
                  <input className={input} value={o.value} onChange={e => setOverride(i, { value: e.target.value })} list={`${ids}-values-${i}`} aria-label={`Ghi đè ${i + 1}: giá trị`} placeholder="Giá trị (vd 6XL)" />
                  <datalist id={`${ids}-values-${i}`}>{valuesFor(o.option).map(v => <option key={v} value={v} />)}</datalist>
                  <SupplierProductSelect value={o.supplierProductId} onChange={v => setOverride(i, { supplierProductId: v })} products={sps}
                    label={`Ghi đè ${i + 1}: sản phẩm xưởng`} emptyLabel="— chọn sản phẩm xưởng —" />
                  {canEdit && (
                    <button type="button" className={btn} aria-label={`Xoá ghi đè ${i + 1}`} onClick={() => set('overrides', form.overrides.filter((_, j) => j !== i))}>
                      <Icon name="delete" className="text-[16px]" />
                    </button>
                  )}
                </div>
                {Object.keys(o.extra).length > 0 && (
                  <span className="text-label-sm text-on-surface-variant">kèm {Object.entries(o.extra).map(([k, v]) => `${k}=${v}`).join(', ')}</span>
                )}
              </div>
            ))}
            {canEdit && (
              <button type="button" className={`${btn} self-start`} onClick={() => set('overrides', [...form.overrides, { option: '', value: '', extra: {}, supplierProductId: '' }])}>
                <Icon name="add" className="text-[16px]" />Thêm ghi đè
              </button>
            )}
          </Card>

          <Card icon="dashboard_customize" title="Template in" right={<Link href="/design-studio/templates" className="text-secondary hover:underline">Quản lý template</Link>}>
            <Field label={supplierIds.size > 0 ? 'Template của xưởng đã chọn' : 'Template (chưa chọn xưởng — hiện tất cả)'}>
              <select className={`${input} w-full`} value={form.printTemplateId} onChange={e => set('printTemplateId', e.target.value)} aria-label="Template in">
                <option value="">— chưa chọn —</option>
                {currentTemplateHidden && <option value={form.printTemplateId}>{currentTemplateName} (xưởng khác)</option>}
                {templateOptions.map(t => <option key={t.id} value={t.id}>{t.name} · {t.supplierSku ?? 'mặc định'}</option>)}
              </select>
            </Field>
            {templateOtherSupplier && (
              <p role="alert" className="inline-flex items-center gap-xs text-label-sm text-error"><Icon name="warning" className="text-[16px]" />Template thuộc xưởng khác — chọn lại</p>
            )}
            {supplierIds.size > 0 && templateOptions.length === 0 && (
              <p className="text-label-sm text-on-surface-variant">Xưởng đã chọn chưa có template — tạo ở Print Templates.</p>
            )}
          </Card>

          <Card icon="image" title="Master artwork">
            <Field label="Link file master (http/https)">
              <input className={input} value={form.masterUrl} onChange={e => set('masterUrl', e.target.value)} placeholder="https://" inputMode="url" />
            </Field>
            {masterPreview && (
              <a href={masterPreview} target="_blank" rel="noreferrer" className="self-start rounded-lg border border-outline-variant/20 bg-surface-container-low p-xs">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={masterPreview} alt="Xem trước master artwork" className="max-h-32 max-w-full object-contain" />
              </a>
            )}
            <p className="text-label-sm text-on-surface-variant">Dán link file master (Drive hoặc CDN). Upload trực tiếp chưa có.</p>
          </Card>

          <Card icon="layers" title="Bảng layer" right={`${form.layers.filter(l => l.layer.trim()).length}/${form.layers.length} đã gắn`}>
            {form.layers.length === 0 && <p className="text-body-sm text-on-surface-variant">Chưa thấy trường cá nhân hoá nào trong đơn 90 ngày qua.</p>}
            {form.layers.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-body-sm">
                  <thead>
                    <tr className="text-label-sm text-on-surface-variant text-left border-b border-outline-variant/20">
                      <th className="py-xs pr-xs font-medium">Trường</th>
                      <th className="py-xs pr-xs font-medium">Layer</th>
                      <th className="py-xs pr-xs font-medium">Font</th>
                      <th className="py-xs pr-xs font-medium w-20">Max ký tự</th>
                      <th className="py-xs pr-xs font-medium w-24">Fit</th>
                      <th className="py-xs font-medium w-8"><span className="sr-only">Xoá</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {form.layers.map((l, i) => {
                      const name = l.field || `dòng ${i + 1}`
                      return (
                        <tr key={i} className="border-b border-outline-variant/20 last:border-b-0">
                          <td className="py-xs pr-xs">
                            {l.observed
                              ? <span className="inline-flex items-center gap-xs" title="Trường thấy trong đơn"><Icon name="visibility" className="text-[14px] text-on-surface-variant" />{l.field}</span>
                              : <input className={`${input} w-full`} value={l.field} onChange={e => setLayer(i, { field: e.target.value })} aria-label={`Tên trường dòng ${i + 1}`} placeholder="Tên trường" />}
                          </td>
                          <td className="py-xs pr-xs"><input className={`${input} w-full font-mono`} value={l.layer} onChange={e => setLayer(i, { layer: e.target.value })} aria-label={`Layer cho ${name}`} placeholder="tên layer" /></td>
                          <td className="py-xs pr-xs"><input className={`${input} w-full`} value={l.font} onChange={e => setLayer(i, { font: e.target.value })} aria-label={`Font cho ${name}`} /></td>
                          <td className="py-xs pr-xs"><input className={`${input} w-full`} type="number" min={1} step={1} value={l.maxChars} onChange={e => setLayer(i, { maxChars: e.target.value })} aria-label={`Max ký tự cho ${name}`} /></td>
                          <td className="py-xs pr-xs">
                            <select className={`${input} w-full`} value={l.fit} onChange={e => setLayer(i, { fit: e.target.value as LayerRow['fit'] })} aria-label={`Fit cho ${name}`}>
                              {FITS.map(f => <option key={f} value={f}>{f}</option>)}
                            </select>
                          </td>
                          <td className="py-xs">
                            {canEdit && (
                              <button type="button" className={btn} aria-label={`Xoá dòng layer ${name}`} onClick={() => set('layers', form.layers.filter((_, j) => j !== i))}>
                                <Icon name="delete" className="text-[16px]" />
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {canEdit && (
              <button type="button" className={`${btn} self-start`} onClick={() => set('layers', [...form.layers, { field: '', observed: false, layer: '', font: '', maxChars: '', fit: 'shrink' }])}>
                <Icon name="add" className="text-[16px]" />Thêm dòng
              </button>
            )}
            <p className="text-label-sm text-on-surface-variant">Trường thấy trong đơn mà để trống layer sẽ không được lưu và hồ sơ vẫn &quot;Thiếu layer&quot;.</p>
          </Card>

          <Card icon="sticky_note_2" title="Ghi chú">
            <textarea className={`${input} w-full min-h-[80px]`} value={form.notes} onChange={e => set('notes', e.target.value)} aria-label="Ghi chú hồ sơ" />
          </Card>
        </fieldset>

        <div className={`${card} sticky bottom-0 z-10 px-md py-sm flex items-center gap-sm flex-wrap`}>
          <Pill tone={meta.tone} icon={meta.icon}>{meta.label}</Pill>
          {message && <span role="status" className="text-label-sm text-on-tertiary-container">{message}</span>}
          {canEdit && dirty && <span className="inline-flex items-center gap-xs text-label-sm text-amber-900"><Icon name="edit" className="text-[14px]" />Chưa lưu</span>}
          {canEdit
            ? (
              <button type="button" onClick={() => void save()} disabled={saving} className="ml-auto bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40">
                {saving ? 'Đang lưu…' : 'Lưu hồ sơ'}
              </button>
            )
            : <span className="ml-auto text-label-sm text-on-surface-variant inline-flex items-center gap-xs"><Icon name="lock" className="text-[16px]" />Chỉ quản trị viên sửa được hồ sơ</span>}
          {error && <div className="w-full"><ErrorBanner msg={error} onClose={() => setError('')} /></div>}
        </div>
      </div>
    </div>
  )
}
