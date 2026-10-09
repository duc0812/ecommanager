'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { useCurrentUser } from '@/components/RoleGate'
import TemplateCanvas, { CanvasTools, type CanvasBg } from '@/app/design-studio/components/TemplateCanvas'
import type { TemplateArea, TemplateRow } from '@/app/design-studio/components/types'
import { requestJson } from '@/app/design-studio/components/model'
import { Card, ErrorBanner, Icon, Note, Pill, btn, card, input } from '@/app/design-studio/components/ui'

type Supplier = { id: string; name: string; code: string }
type SupplierProduct = { id: string; sku: string; productName: string | null; productType: string | null; variant1Value: string | null; variant2Value: string | null }
type PrintTemplate = TemplateRow & { sourceFileName: string | null; sourceUrl: string | null; supplierProductIds: string[] }
type AreaForm = { name: string; x: string; y: string; w: string; h: string }
type Form = {
  name: string; widthPx: string; heightPx: string; dpi: string; bleedIn: string; safeIn: string; mirror: boolean
  areas: AreaForm[]; productIds: string[]
}

const EMPTY: Form = { name: '', widthPx: '', heightPx: '', dpi: '300', bleedIn: '0.125', safeIn: '0.2', mirror: false, areas: [], productIds: [] }
const SOURCE_ACCEPT = '.png,.jpg,.jpeg,.tif,.tiff,.psd,.pdf'

function num(s: string): number { return s.trim() === '' ? NaN : Number(s) }

function toForm(t: PrintTemplate): Form {
  return {
    name: t.name, widthPx: String(t.widthPx), heightPx: String(t.heightPx), dpi: String(t.dpi), bleedIn: String(t.bleedIn),
    safeIn: String(t.safeIn), mirror: t.mirror, productIds: t.supplierProductIds,
    areas: t.areas.map(a => ({ name: a.name, x: String(a.x), y: String(a.y), w: String(a.w), h: String(a.h) })),
  }
}

function variantLabel(p: SupplierProduct): string {
  return [p.variant1Value, p.variant2Value].filter(Boolean).join(' / ') || '—'
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-[2px] text-label-sm text-on-surface-variant ${className}`}>
      {label}
      {children}
    </label>
  )
}

function previewAreas(form: Form, W: number, H: number): TemplateArea[] {
  const rows = form.areas
    .map((a, i) => ({ name: a.name.trim() || `vùng ${i + 1}`, x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h) }))
    .filter(a => [a.x, a.y, a.w, a.h].every(Number.isFinite) && a.w > 0 && a.h > 0)
  const seen = new Set<string>()
  const unique = rows.filter(a => (seen.has(a.name) ? false : (seen.add(a.name), true)))
  return unique.length > 0 ? unique : [{ name: 'Print', x: 0, y: 0, w: W, h: H }]
}

export default function SupplierPrintTemplatesPage() {
  const params = useParams<{ id: string }>()
  const pathname = usePathname()
  const supplierId = params.id
  const suppliersPath = pathname.startsWith('/fulfillment') ? '/fulfillment/suppliers' : '/setup/suppliers'
  const { user } = useCurrentUser()
  const canEdit = user?.role === 'SUPERADMIN' || user?.role === 'ADMIN'

  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [templates, setTemplates] = useState<PrintTemplate[]>([])
  const [products, setProducts] = useState<SupplierProduct[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [guideFile, setGuideFile] = useState<File | null>(null)
  const [guidePreview, setGuidePreview] = useState<string | null>(null)
  const [sourceFile, setSourceFile] = useState<File | null>(null)
  const [fileKey, setFileKey] = useState(0)
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [guide, setGuide] = useState(60)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [s, t, p] = await Promise.all([
      requestJson<Supplier>(`/api/suppliers/${supplierId}`),
      requestJson<{ templates: PrintTemplate[] }>(`/api/fulfillment/suppliers/${supplierId}/print-templates`),
      requestJson<{ products: SupplierProduct[] }>(`/api/suppliers/products?supplierId=${encodeURIComponent(supplierId)}&limit=2000`),
    ])
    setLoading(false)
    if (s.ok) setSupplier(s.data)
    if (p.ok) setProducts(p.data.products)
    if (!t.ok) { setError(t.error); return [] as PrintTemplate[] }
    setTemplates(t.data.templates)
    return t.data.templates
  }, [supplierId])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!guideFile) { setGuidePreview(null); return }
    const url = URL.createObjectURL(guideFile)
    setGuidePreview(url)
    return () => URL.revokeObjectURL(url)
  }, [guideFile])

  const selected = templates.find(t => t.id === selectedId) ?? null
  const productGroups = useMemo(() => {
    const m = new Map<string, SupplierProduct[]>()
    for (const p of products) {
      const k = p.productName || p.productType || '(không tên)'
      m.set(k, [...(m.get(k) ?? []), p])
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]))
  }, [products])
  const linkedElsewhere = useMemo(() => {
    const m = new Map<string, string>()
    for (const t of templates) if (t.id !== selectedId) for (const id of t.supplierProductIds) m.set(id, t.name)
    return m
  }, [templates, selectedId])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }))
  const setArea = (i: number, patch: Partial<AreaForm>) => setForm(f => ({ ...f, areas: f.areas.map((a, j) => (j === i ? { ...a, ...patch } : a)) }))
  const toggleProducts = (ids: string[], on: boolean) => setForm(f => ({
    ...f, productIds: on ? Array.from(new Set([...f.productIds, ...ids])) : f.productIds.filter(id => !ids.includes(id)),
  }))

  function resetFiles() {
    setGuideFile(null)
    setSourceFile(null)
    setFileKey(k => k + 1)
  }

  function select(t: PrintTemplate) {
    setSelectedId(t.id)
    setForm(toForm(t))
    resetFiles()
    setSaved('')
    setError('')
  }

  function startNew() {
    setSelectedId(null)
    setForm(EMPTY)
    resetFiles()
    setSaved('')
    setError('')
  }

  async function save() {
    setSaved('')
    if (!form.name.trim()) { setError('Nhập tên template.'); return }
    const widthPx = num(form.widthPx), heightPx = num(form.heightPx), dpi = num(form.dpi)
    if (!(widthPx > 0) || !(heightPx > 0) || !(dpi > 0)) { setError('Rộng, cao và DPI phải lớn hơn 0.'); return }
    const areas = []
    for (const a of form.areas) {
      const row = { name: a.name.trim(), x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h) }
      if (!row.name || ![row.x, row.y, row.w, row.h].every(Number.isFinite) || row.w <= 0 || row.h <= 0) {
        setError('Mỗi vùng in cần tên và x, y, rộng, cao hợp lệ.')
        return
      }
      areas.push(row)
    }
    const fd = new FormData()
    fd.append('name', form.name.trim())
    fd.append('widthPx', String(widthPx))
    fd.append('heightPx', String(heightPx))
    fd.append('dpi', String(dpi))
    fd.append('bleedIn', form.bleedIn.trim() || '0')
    fd.append('safeIn', form.safeIn.trim() || '0')
    fd.append('mirror', form.mirror ? 'true' : 'false')
    fd.append('areas', JSON.stringify(areas.length > 0 ? areas : [{ name: 'Print', x: 0, y: 0, w: widthPx, h: heightPx }]))
    fd.append('supplierProductIds', JSON.stringify(form.productIds))
    if (guideFile) fd.append('guide', guideFile)
    if (sourceFile) fd.append('source', sourceFile)
    setSaving(true)
    const url = selectedId
      ? `/api/fulfillment/suppliers/${supplierId}/print-templates/${selectedId}`
      : `/api/fulfillment/suppliers/${supplierId}/print-templates`
    const r = await requestJson<{ template: PrintTemplate }>(url, { method: selectedId ? 'PATCH' : 'POST', body: fd })
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    setError('')
    const rows = await load()
    const row = rows.find(t => t.id === r.data.template.id)
    if (row) select(row)
    setSaved('Đã lưu template.')
  }

  async function remove() {
    if (!selected) return
    const n = selected.supplierProductIds.length
    if (!confirm(`Xoá template "${selected.name}"?${n ? ` ${n} variant sẽ bị bỏ gán.` : ''}`)) return
    const r = await requestJson(`/api/fulfillment/suppliers/${supplierId}/print-templates/${selected.id}`, { method: 'DELETE' })
    if (!r.ok) { setError(r.error); return }
    startNew()
    await load()
  }

  const W = num(form.widthPx), H = num(form.heightPx)
  const previewTemplate: TemplateRow | null = W > 0 && H > 0 ? {
    id: selectedId ?? 'new', name: form.name || 'template', widthPx: W, heightPx: H, dpi: num(form.dpi) > 0 ? num(form.dpi) : 300,
    bleedIn: Math.max(0, num(form.bleedIn) || 0), safeIn: Math.max(0, num(form.safeIn) || 0), mirror: form.mirror,
    areas: previewAreas(form, W, H), guideImageUrl: guidePreview ?? selected?.guideImageUrl ?? null, templateUrl: null,
  } : null

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <div className="mb-lg">
          <a href={`${suppliersPath}/${supplierId}`} className="text-secondary text-label-md">Back to {supplier?.name ?? 'supplier'}</a>
          <div className="flex items-start justify-between mt-sm gap-lg">
            <div>
              <h1 className="text-display-md">Template in{supplier ? ` · ${supplier.name}` : ''}</h1>
              <p className="text-body-sm text-on-surface-variant mt-xs">
                Khổ in, vùng in, artguide và file template gốc của xưởng — gán cho từng variant để Design Studio dùng đúng template.
              </p>
            </div>
            {canEdit && (
              <button type="button" onClick={startNew} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md inline-flex items-center gap-xs">
                <Icon name="add" className="text-[18px]" />Template mới
              </button>
            )}
          </div>
        </div>

        <ErrorBanner msg={error} onClose={() => setError('')} />

        <div className={`grid gap-md mt-md ${canEdit ? 'xl:grid-cols-[minmax(300px,2fr)_3fr]' : ''}`}>
          <div className="flex flex-col gap-md min-w-0">
            {loading && templates.length === 0 && <p className="text-body-sm text-on-surface-variant">Đang tải…</p>}
            {!loading && templates.length === 0 && !error && (
              <div className={`${card} p-lg text-center text-body-sm text-on-surface-variant`}>Xưởng này chưa có template in.</div>
            )}
            {templates.length > 0 && (
              <Card icon="dashboard_customize" title="Templates" right={`${templates.length} template`}>
                <ul className="flex flex-col">
                  {templates.map(t => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => select(t)}
                        aria-pressed={selectedId === t.id}
                        className={`w-full text-left rounded-lg px-sm py-xs flex items-center gap-sm hover:bg-surface-container-low ${selectedId === t.id ? 'bg-secondary/10' : ''}`}
                      >
                        <span className="w-16 h-10 shrink-0 rounded border border-outline-variant/40 bg-surface-container-low grid place-items-center overflow-hidden">
                          {t.guideImageUrl
                            // eslint-disable-next-line @next/next/no-img-element
                            ? <img src={t.guideImageUrl} alt="" className="max-w-full max-h-full object-contain" />
                            : <Icon name="dashboard_customize" className="text-[18px] text-on-surface-variant" />}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block text-body-sm font-semibold text-on-surface truncate">{t.name}</span>
                          <span className="block text-label-sm text-on-surface-variant">{t.widthPx}×{t.heightPx} px · {t.dpi} DPI</span>
                        </span>
                        <Pill tone={t.supplierProductIds.length > 0 ? 'ok' : 'idle'}>{t.supplierProductIds.length} variant</Pill>
                        {t.mirror && <Pill tone="warn">mirror</Pill>}
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            )}
            {!canEdit && templates.length > 0 && (
              <Note tone="idle" icon="lock">Chỉ quản trị viên mới sửa được template.</Note>
            )}
          </div>

          {canEdit && (
            <div className="flex flex-col gap-md min-w-0">
              <Card icon="edit" title={selectedId ? 'Sửa template' : 'Thêm template'}>
                <div className="grid grid-cols-2 gap-sm">
                  <Field label="Tên template" className="col-span-2">
                    <input className={input} value={form.name} onChange={e => set('name', e.target.value)} aria-label="Tên template" placeholder="20oz Stainless Steel Tumbler (US)" />
                  </Field>
                  <Field label="Rộng (px)">
                    <input className={input} type="number" min={1} value={form.widthPx} onChange={e => set('widthPx', e.target.value)} aria-label="Rộng px" />
                  </Field>
                  <Field label="Cao (px)">
                    <input className={input} type="number" min={1} value={form.heightPx} onChange={e => set('heightPx', e.target.value)} aria-label="Cao px" />
                  </Field>
                  <Field label="DPI">
                    <input className={input} type="number" min={1} value={form.dpi} onChange={e => set('dpi', e.target.value)} aria-label="DPI" />
                  </Field>
                  <div className="grid grid-cols-2 gap-sm">
                    <Field label="Bleed (inch)">
                      <input className={input} type="number" min={0} step="0.005" value={form.bleedIn} onChange={e => set('bleedIn', e.target.value)} aria-label="Bleed inch" />
                    </Field>
                    <Field label="Vùng an toàn (inch)">
                      <input className={input} type="number" min={0} step="0.005" value={form.safeIn} onChange={e => set('safeIn', e.target.value)} aria-label="Vùng an toàn inch" />
                    </Field>
                  </div>
                  <label className="col-span-2 inline-flex items-center gap-xs text-body-sm text-on-surface">
                    <input type="checkbox" checked={form.mirror} onChange={e => set('mirror', e.target.checked)} className="accent-secondary" />
                    Mirror (in lật gương)
                  </label>
                </div>

                <div className="flex items-center gap-sm border-t border-outline-variant/20 pt-sm">
                  <span className="text-body-sm font-semibold text-on-surface">Vùng in ({form.areas.length || 'mặc định: cả khổ'})</span>
                  <button type="button" className={`${btn} ml-auto`} onClick={() => set('areas', [...form.areas, { name: form.areas.length ? '' : 'Print', x: '0', y: '0', w: form.widthPx, h: form.heightPx }])}>
                    <Icon name="add" className="text-[16px]" />Thêm vùng
                  </button>
                </div>
                {form.areas.map((a, i) => (
                  <div key={i} className="grid grid-cols-[1fr_repeat(4,5.5rem)_auto] gap-xs items-center">
                    <input className={input} value={a.name} onChange={e => setArea(i, { name: e.target.value })} aria-label={`Tên vùng ${i + 1}`} placeholder="Tên vùng" />
                    <input className={input} type="number" value={a.x} onChange={e => setArea(i, { x: e.target.value })} aria-label={`Vùng ${i + 1} x`} placeholder="x" />
                    <input className={input} type="number" value={a.y} onChange={e => setArea(i, { y: e.target.value })} aria-label={`Vùng ${i + 1} y`} placeholder="y" />
                    <input className={input} type="number" value={a.w} onChange={e => setArea(i, { w: e.target.value })} aria-label={`Vùng ${i + 1} rộng`} placeholder="rộng" />
                    <input className={input} type="number" value={a.h} onChange={e => setArea(i, { h: e.target.value })} aria-label={`Vùng ${i + 1} cao`} placeholder="cao" />
                    <button type="button" className={btn} aria-label={`Xoá vùng ${i + 1}`} onClick={() => set('areas', form.areas.filter((_, j) => j !== i))}>
                      <Icon name="delete" className="text-[16px]" />
                    </button>
                  </div>
                ))}

                <div className="grid grid-cols-2 gap-sm border-t border-outline-variant/20 pt-sm">
                  <Field label="Artguide (PNG/JPG, vẽ đè lên khổ in)">
                    <input key={`g${fileKey}`} type="file" accept=".png,.jpg,.jpeg,image/png,image/jpeg" className="text-label-sm"
                      onChange={e => setGuideFile(e.target.files?.[0] ?? null)} aria-label="Ảnh artguide" />
                    <span className="text-label-sm">{guideFile ? guideFile.name : selected?.guideImageUrl ? 'Đã có artguide' : 'Chưa có'}</span>
                  </Field>
                  <Field label="File template gốc (png, jpg, tif, psd, pdf ≤ 200 MB)">
                    <input key={`s${fileKey}`} type="file" accept={SOURCE_ACCEPT} className="text-label-sm"
                      onChange={e => setSourceFile(e.target.files?.[0] ?? null)} aria-label="File template gốc" />
                    {sourceFile
                      ? <span className="text-label-sm">{sourceFile.name}</span>
                      : selected?.sourceFileName && selected.sourceUrl
                        ? <a href={selected.sourceUrl} className="text-label-sm text-secondary hover:underline inline-flex items-center gap-xs"><Icon name="download" className="text-[14px]" />{selected.sourceFileName}</a>
                        : <span className="text-label-sm">Chưa có</span>}
                  </Field>
                </div>
              </Card>

              <Card icon="visibility" title="Xem trước">
                {previewTemplate ? (
                  <>
                    <CanvasTools bg={bg} onBg={setBg} guide={guide} onGuide={setGuide} hasGuide={!!previewTemplate.guideImageUrl} />
                    <TemplateCanvas template={previewTemplate} bg={bg} guide={guide} />
                  </>
                ) : (
                  <p className="text-body-sm text-on-surface-variant">Nhập chiều rộng và cao (px) để xem trước.</p>
                )}
              </Card>

              <Card icon="inventory_2" title="Variants dùng template này" right={`${form.productIds.length}/${products.length}`}>
                {products.length === 0 && <p className="text-body-sm text-on-surface-variant">Xưởng chưa có sản phẩm.</p>}
                <div className="flex flex-col gap-sm max-h-[360px] overflow-y-auto">
                  {productGroups.map(([group, rows]) => {
                    const ids = rows.map(r => r.id)
                    const all = ids.every(id => form.productIds.includes(id))
                    return (
                      <div key={group} className="flex flex-col">
                        <label className="inline-flex items-center gap-xs text-label-sm font-semibold text-secondary">
                          <input type="checkbox" className="accent-secondary" checked={all} onChange={e => toggleProducts(ids, e.target.checked)} />
                          {group} <span className="font-normal text-on-surface-variant">{rows.length} variant</span>
                        </label>
                        {rows.map(p => {
                          const other = linkedElsewhere.get(p.id)
                          return (
                            <label key={p.id} className="inline-flex items-center gap-xs pl-lg text-body-sm text-on-surface">
                              <input type="checkbox" className="accent-secondary" checked={form.productIds.includes(p.id)} onChange={e => toggleProducts([p.id], e.target.checked)} />
                              <span>{p.productName || group} · {variantLabel(p)} · <span className="font-mono text-label-sm">{p.sku}</span></span>
                              {other && <span className="text-label-sm text-amber-900">(đang dùng {other})</span>}
                            </label>
                          )
                        })}
                      </div>
                    )
                  })}
                </div>
              </Card>

              <div className="flex items-center gap-sm">
                <button type="button" className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40" onClick={() => void save()} disabled={saving}>
                  {saving ? 'Đang lưu…' : 'Lưu template'}
                </button>
                {selected && (
                  <button type="button" className={`${btn} text-error`} onClick={() => void remove()}>
                    <Icon name="delete" className="text-[16px]" />Xoá
                  </button>
                )}
                {saved && <span role="status" className="text-label-sm text-on-tertiary-container">{saved}</span>}
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
