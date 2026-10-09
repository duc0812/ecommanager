'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { useCurrentUser } from '@/components/RoleGate'
import type { TemplateListRow } from '../components/types'
import { postJson, requestJson } from '../components/model'
import { Card, ErrorBanner, Icon, Note, Pill, btn, btnPrimary, card, input } from '../components/ui'

type Supplier = { id: string; name: string; code: string }
type AreaForm = { name: string; x: string; y: string; w: string; h: string }
type Form = {
  supplierId: string; supplierSku: string; name: string; widthPx: string; heightPx: string; dpi: string
  bleedIn: string; safeIn: string; mirror: boolean; templateUrl: string; areas: AreaForm[]
}

const EMPTY: Form = {
  supplierId: '', supplierSku: '', name: '', widthPx: '', heightPx: '', dpi: '300',
  bleedIn: '0.125', safeIn: '0.2', mirror: false, templateUrl: '', areas: [],
}

function toForm(t: TemplateListRow): Form {
  return {
    supplierId: t.supplierId, supplierSku: t.supplierSku ?? '', name: t.name, widthPx: String(t.widthPx), heightPx: String(t.heightPx),
    dpi: String(t.dpi), bleedIn: String(t.bleedIn), safeIn: String(t.safeIn), mirror: t.mirror, templateUrl: t.templateUrl ?? '',
    areas: t.areas.map(a => ({ name: a.name, x: String(a.x), y: String(a.y), w: String(a.w), h: String(a.h) })),
  }
}

function num(s: string): number { return s.trim() === '' ? NaN : Number(s) }

function Preview({ form }: { form: Form }) {
  const W = num(form.widthPx), H = num(form.heightPx)
  if (!(W > 0) || !(H > 0)) return <p className="text-body-sm text-on-surface-variant">Nhập chiều rộng và cao (px) để xem trước.</p>
  const fs = Math.max(10, W / 45)
  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Xem trước vùng in" className="block w-full max-h-[320px] rounded border border-outline-variant/40 bg-surface-container-low">
      <rect width={W} height={H} className="fill-surface-container-lowest stroke-outline-variant" strokeWidth={Math.max(1, W / 400)} />
      {form.areas.map((a, i) => {
        const x = num(a.x), y = num(a.y), w = num(a.w), h = num(a.h)
        if (![x, y, w, h].every(Number.isFinite)) return null
        return (
          <g key={i}>
            <rect x={x} y={y} width={w} height={h} className="fill-outline/20 stroke-outline" strokeWidth={Math.max(1, W / 500)} />
            <text x={x + fs / 2} y={y + fs * 1.4} fontSize={fs} className="fill-on-surface-variant font-mono">{a.name || `vùng ${i + 1}`}</text>
          </g>
        )
      })}
    </svg>
  )
}

function Field({ label, children, className = '' }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`flex flex-col gap-[2px] text-label-sm text-on-surface-variant ${className}`}>
      {label}
      {children}
    </label>
  )
}

export default function PrintTemplatesPage() {
  const { user } = useCurrentUser()
  const canEdit = user?.role === 'SUPERADMIN' || user?.role === 'ADMIN'
  const [templates, setTemplates] = useState<TemplateListRow[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [form, setForm] = useState<Form>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await requestJson<{ templates: TemplateListRow[] }>('/api/design-studio/templates')
    setLoading(false)
    if (!r.ok) { setError(r.error); return [] as TemplateListRow[] }
    setTemplates(r.data.templates)
    return r.data.templates
  }, [])

  useEffect(() => { void load() }, [load])

  useEffect(() => {
    if (!canEdit) return
    void requestJson<{ suppliers: Supplier[] }>('/api/suppliers').then(r => { if (r.ok) setSuppliers(r.data.suppliers) })
  }, [canEdit])

  const groups = useMemo(() => {
    const m = new Map<string, { name: string; rows: TemplateListRow[] }>()
    for (const t of templates) {
      const g = m.get(t.supplierId) ?? { name: t.supplierName, rows: [] }
      g.rows.push(t)
      m.set(t.supplierId, g)
    }
    return Array.from(m.entries()).sort((a, b) => a[1].name.localeCompare(b[1].name))
  }, [templates])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm(f => ({ ...f, [k]: v }))
  const setArea = (i: number, patch: Partial<AreaForm>) => setForm(f => ({ ...f, areas: f.areas.map((a, j) => (j === i ? { ...a, ...patch } : a)) }))

  function select(t: TemplateListRow) {
    setSelectedId(t.id)
    setForm(toForm(t))
    setSaved('')
    setError('')
  }

  function startNew() {
    setSelectedId(null)
    setForm({ ...EMPTY, supplierId: suppliers[0]?.id ?? '' })
    setSaved('')
    setError('')
  }

  async function save() {
    setSaved('')
    if (!form.supplierId) { setError('Chọn xưởng.'); return }
    if (!form.name.trim()) { setError('Nhập tên template.'); return }
    const widthPx = num(form.widthPx), heightPx = num(form.heightPx)
    if (!(widthPx > 0) || !(heightPx > 0)) { setError('Chiều rộng và cao phải lớn hơn 0.'); return }
    const areas = []
    for (const a of form.areas) {
      const row = { name: a.name.trim(), x: num(a.x), y: num(a.y), w: num(a.w), h: num(a.h) }
      if (!row.name || ![row.x, row.y, row.w, row.h].every(Number.isFinite) || row.w <= 0 || row.h <= 0) {
        setError('Mỗi vùng in cần tên và x, y, rộng, cao hợp lệ.')
        return
      }
      areas.push(row)
    }
    setSaving(true)
    const r = await postJson<{ template: { id: string } }>('/api/design-studio/templates', {
      supplierId: form.supplierId,
      supplierSku: form.supplierSku.trim() || undefined,
      name: form.name.trim(), widthPx, heightPx,
      dpi: num(form.dpi), bleedIn: num(form.bleedIn), safeIn: num(form.safeIn),
      mirror: form.mirror, areas, templateUrl: form.templateUrl.trim() || undefined,
    })
    setSaving(false)
    if (!r.ok) { setError(r.error); return }
    setError('')
    setSaved('Đã lưu template.')
    const rows = await load()
    const row = rows.find(t => t.id === r.data.template.id)
    if (row) select(row)
    setSaved('Đã lưu template.')
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center gap-sm mb-lg">
          <Icon name="dashboard_customize" className="text-[28px] text-secondary" />
          <h1 className="text-headline-sm font-bold text-primary">Design Studio · Print Templates</h1>
          {canEdit && (
            <button type="button" className={`${btnPrimary} ml-auto`} onClick={startNew}>
              <Icon name="add" className="text-[16px]" />Template mới
            </button>
          )}
        </div>

        <ErrorBanner msg={error} onClose={() => setError('')} />

        <div className={`grid gap-md mt-md ${canEdit ? 'xl:grid-cols-[minmax(320px,2fr)_3fr]' : ''}`}>
          <div className="flex flex-col gap-md min-w-0">
            {loading && templates.length === 0 && <p className="text-body-sm text-on-surface-variant">Đang tải…</p>}
            {!loading && groups.length === 0 && !error && (
              <div className={`${card} p-lg text-center text-body-sm text-on-surface-variant`}>Chưa có template nào.</div>
            )}
            {groups.map(([id, g]) => (
              <Card key={id} icon="factory" title={g.name} right={`${g.rows.length} template`}>
                <ul className="flex flex-col">
                  {g.rows.map(t => (
                    <li key={t.id}>
                      <button
                        type="button"
                        onClick={() => select(t)}
                        aria-pressed={selectedId === t.id}
                        className={`w-full text-left rounded-lg px-sm py-xs flex items-center gap-sm hover:bg-surface-container-low ${selectedId === t.id ? 'bg-secondary/10' : ''}`}
                      >
                        <span className="flex-1 min-w-0">
                          <span className="block text-body-sm font-semibold text-on-surface truncate">{t.name}</span>
                          <span className="block text-label-sm text-on-surface-variant">
                            {t.supplierSku ?? 'mặc định'} · {t.widthPx}×{t.heightPx} px · {t.dpi} DPI
                          </span>
                        </span>
                        <Pill tone="idle">{t.areas.length} vùng</Pill>
                        {t.mirror && <Pill tone="warn">mirror</Pill>}
                      </button>
                    </li>
                  ))}
                </ul>
              </Card>
            ))}
            {!canEdit && templates.length > 0 && (
              <Note tone="idle" icon="lock">Chỉ quản trị viên mới sửa được template.</Note>
            )}
          </div>

          {canEdit && (
            <Card icon="edit" title={selectedId ? 'Sửa template' : 'Thêm template'} right={selectedId ? 'khoá = xưởng + SKU xưởng' : undefined}>
              <div className="grid grid-cols-2 gap-sm">
                <Field label="Xưởng">
                  <select className={input} value={form.supplierId} onChange={e => set('supplierId', e.target.value)} aria-label="Xưởng">
                    <option value="">— chọn xưởng —</option>
                    {suppliers.map(s => <option key={s.id} value={s.id}>{s.name} ({s.code})</option>)}
                  </select>
                </Field>
                <Field label="SKU xưởng (để trống = mặc định)">
                  <input className={input} value={form.supplierSku} onChange={e => set('supplierSku', e.target.value)} aria-label="SKU xưởng" />
                </Field>
                <Field label="Tên template" className="col-span-2">
                  <input className={input} value={form.name} onChange={e => set('name', e.target.value)} aria-label="Tên template" />
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
                <Field label="Link file template" className="col-span-2">
                  <input className={input} value={form.templateUrl} onChange={e => set('templateUrl', e.target.value)} aria-label="Link file template" placeholder="https://" />
                </Field>
                <label className="col-span-2 inline-flex items-center gap-xs text-body-sm text-on-surface">
                  <input type="checkbox" checked={form.mirror} onChange={e => set('mirror', e.target.checked)} className="accent-secondary" />
                  Mirror (in lật gương)
                </label>
              </div>

              <div className="flex items-center gap-sm border-t border-outline-variant/20 pt-sm">
                <span className="text-body-sm font-semibold text-on-surface">Vùng in ({form.areas.length})</span>
                <button type="button" className={`${btn} ml-auto`} onClick={() => set('areas', [...form.areas, { name: '', x: '0', y: '0', w: '', h: '' }])}>
                  <Icon name="add" className="text-[16px]" />Thêm vùng
                </button>
              </div>
              {form.areas.length === 0 && <p className="text-body-sm text-on-surface-variant">Chưa có vùng in nào.</p>}
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

              <Preview form={form} />

              <div className="flex items-center gap-sm">
                <button type="button" className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-40" onClick={() => void save()} disabled={saving}>
                  {saving ? 'Đang lưu…' : 'Lưu template'}
                </button>
                {saved && <span role="status" className="text-label-sm text-on-tertiary-container">{saved}</span>}
              </div>
            </Card>
          )}
        </div>
      </main>
    </div>
  )
}
