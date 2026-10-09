'use client'
import { useId, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { productUrl, putJson } from '../../components/model'
import { ErrorBanner, Icon, Note, btn, card, input } from '../../components/ui'
import type { OverrideRow, ProductDetail, SaveResponse, SupplierProductOption } from './types'
import { groupBySupplier, overrideRowsToPayload, referencedSupplierIds, supplierProductLabel, toOverrideRows } from './profile-form'

type Form = { supplierProductId: string; overrides: OverrideRow[]; printTemplateId: string; notes: string }

function initForm(d: ProductDetail): Form {
  const p = d.profile
  return {
    supplierProductId: p?.supplierProductId ?? '',
    overrides: toOverrideRows(p?.overrides ?? []),
    printTemplateId: p?.printTemplateId ?? '',
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

function Section({ icon, title, right, children }: { icon: string; title: string; right?: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-sm min-w-0">
      <div className="flex items-center gap-xs text-label-md font-semibold text-on-surface">
        <Icon name={icon} className="text-[18px] text-on-surface-variant" />{title}
        {right && <span className="ml-auto text-label-sm font-normal text-on-surface-variant">{right}</span>}
      </div>
      {children}
    </div>
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

export default function MappingCard({ detail, canEdit, onSaved }: {
  detail: ProductDetail; canEdit: boolean; onSaved: () => Promise<ProductDetail | null>
}) {
  const ids = useId()
  const [form, setForm] = useState<Form>(() => initForm(detail))
  const [baseline, setBaseline] = useState(() => JSON.stringify(initForm(detail)))
  const [spFilter, setSpFilter] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  const set = <K extends keyof Form>(k: K, v: Form[K]) => { setMessage(''); setForm(f => ({ ...f, [k]: v })) }
  const setOverride = (i: number, patch: Partial<OverrideRow>) => set('overrides', form.overrides.map((o, j) => (j === i ? { ...o, ...patch } : o)))

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

  async function save() {
    if (saving) return
    setError(''); setMessage('')
    const overrides = overrideRowsToPayload(form.overrides)
    if (!overrides.ok) { setError(overrides.error); return }
    if (templateOtherSupplier) { setError('Template thuộc xưởng khác — chọn lại'); return }
    setSaving(true)
    const r = await putJson<SaveResponse>(productUrl(detail.key), {
      supplierProductId: form.supplierProductId || null,
      overrides: overrides.overrides,
      printTemplateId: form.printTemplateId || null,
      notes: form.notes,
    })
    if (!r.ok) { setSaving(false); setError(r.error); return }
    const { ordersUpdated, tasksTouched, errors } = r.data.reevaluation
    setMessage(`Đã lưu mapping · cập nhật ${ordersUpdated} đơn · ${tasksTouched} task`)
    if (errors.length > 0) setError(`Đồng bộ task lỗi: ${errors.join('; ')}`)
    const fresh = await onSaved()
    if (fresh) {
      const next = initForm(fresh)
      setForm(next)
      setBaseline(JSON.stringify(next))
    }
    setSaving(false)
  }

  const templatesLink = supplierIds.size === 1 ? `/fulfillment/suppliers/${Array.from(supplierIds)[0]}/print-templates` : '/fulfillment/suppliers'

  return (
    <section aria-labelledby={`${ids}-title`} className={`${card} flex flex-col`}>
      <div className="flex items-center gap-sm flex-wrap px-lg py-md border-b border-outline-variant/20">
        <Icon name="account_tree" className="text-[20px] text-secondary" />
        <h2 id={`${ids}-title`} className="text-body-md font-semibold text-on-surface">Mapping xưởng &amp; template</h2>
        <span className="text-label-sm text-on-surface-variant">áp cho mọi biến thể · lưu xong sẽ tính lại các đơn đang mở</span>
      </div>
      <div className="p-md flex flex-col gap-md">
        {!detail.profile && canEdit && (
          <Note tone="idle" icon="info">Sản phẩm chưa có mapping riêng — đang dùng Product Mapping. Chọn rồi bấm Lưu mapping để ghi đè.</Note>
        )}
        <fieldset disabled={!canEdit} className="grid grid-cols-1 xl:grid-cols-2 gap-lg min-w-0 border-0 p-0 m-0">
          <Section icon="factory" title="Xưởng mặc định">
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
          </Section>

          <Section icon="dashboard_customize" title="Template in" right={<Link href={templatesLink} className="text-secondary hover:underline">Quản lý template</Link>}>
            <Field label={supplierIds.size > 0 ? 'Template của xưởng đã chọn' : 'Template (chưa chọn xưởng — hiện tất cả)'}>
              <select className={`${input} w-full`} value={form.printTemplateId} onChange={e => set('printTemplateId', e.target.value)} aria-label="Template in">
                <option value="">— theo SKU xưởng (mặc định) —</option>
                {currentTemplateHidden && <option value={form.printTemplateId}>{currentTemplateName} (xưởng khác)</option>}
                {templateOptions.map(t => <option key={t.id} value={t.id}>{t.name}{t.supplierSku ? ` · ${t.supplierSku}` : ''}</option>)}
              </select>
            </Field>
            {templateOtherSupplier && (
              <p role="alert" className="inline-flex items-center gap-xs text-label-sm text-error"><Icon name="warning" className="text-[16px]" />Template thuộc xưởng khác — chọn lại</p>
            )}
            {supplierIds.size > 0 && templateOptions.length === 0 && (
              <p className="text-label-sm text-on-surface-variant">Xưởng đã chọn chưa có template — tạo ở trang xưởng › Template in.</p>
            )}
            <p className="text-label-sm text-on-surface-variant">Để trống: mỗi SKU xưởng dùng template của nó. Các slot artwork bên dưới đi theo kết quả này.</p>
          </Section>

          <div className="xl:col-span-2">
            <Section icon="call_split" title="Ghi đè theo option" right={`${form.overrides.length} dòng`}>
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
            </Section>
          </div>

          <Field label="Ghi chú sản phẩm" className="xl:col-span-2">
            <textarea className={`${input} w-full min-h-[60px]`} value={form.notes} onChange={e => set('notes', e.target.value)} />
          </Field>
        </fieldset>

        <div className="flex items-center gap-sm flex-wrap">
          {message && <span role="status" className="text-label-sm text-on-tertiary-container">{message}</span>}
          {canEdit && dirty && <span className="inline-flex items-center gap-xs text-label-sm text-amber-900"><Icon name="edit" className="text-[14px]" />Chưa lưu</span>}
          {canEdit
            ? (
              <button type="button" onClick={() => void save()} disabled={saving || !dirty}
                className="ml-auto bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40">
                {saving ? 'Đang lưu…' : 'Lưu mapping'}
              </button>
            )
            : <span className="ml-auto text-label-sm text-on-surface-variant inline-flex items-center gap-xs"><Icon name="lock" className="text-[16px]" />Chỉ quản trị viên sửa được mapping</span>}
          {error && <div className="w-full"><ErrorBanner msg={error} onClose={() => setError('')} /></div>}
        </div>
      </div>
    </section>
  )
}
