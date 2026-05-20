// src/app/fulfillment/mapping/page.tsx
'use client'
import { useEffect, useMemo, useState } from 'react'
import Sidebar from '@/components/Sidebar'

// ── Types ────────────────────────────────────────────────────
type SupplierProduct = {
  id: string; sku: string; productName: string | null; productType: string | null
  baseSku: string | null; variant1Name: string | null; variant1Value: string | null
  variant2Name: string | null; variant2Value: string | null
  supplier: { id: string; name: string; code: string }
}

type SupplierMapping = {
  preferenceRank: number; supplierProductId: string
  supplierProduct: SupplierProduct
}

type Override = {
  id?: string; attributeCombo: string; supplierProductId: string; notes?: string | null
  supplierProduct?: SupplierProduct
}

type ProductBase = {
  id: string; name: string; shopifyProductType: string
  variantConditions: string; notes: string | null
  supplierMappings: SupplierMapping[]
  overrides: Override[]
  _count: { variantMappings: number }
}

type ConditionRow = { optionName: string; anyOf: string[] }

type PendingLine = {
  id: string; shopifyVariantId: string | null; sku: string | null
  productTitle: string; variantTitle: string | null
  order: { shopifyOrderNumber: string }
}

type SavedMapping = {
  id: string; shopifyVariantId: string; shopifyProductTitle: string
  variantTitle: string | null
  supplierProduct: SupplierProduct
}

// ── Tag Input ────────────────────────────────────────────────
function TagInput({ tags, onChange }: { tags: string[]; onChange: (t: string[]) => void }) {
  const [input, setInput] = useState('')
  function add(val: string) {
    const v = val.trim()
    if (v && !tags.includes(v)) onChange([...tags, v])
    setInput('')
  }
  return (
    <div className="flex flex-wrap gap-1 items-center border border-outline-variant/40 rounded-lg px-sm py-[6px] min-h-[38px] bg-surface-container-lowest">
      {tags.map(t => (
        <span key={t} className="flex items-center gap-1 bg-secondary/10 text-secondary px-sm py-[2px] rounded text-label-sm font-semibold">
          {t}
          <button onClick={() => onChange(tags.filter(x => x !== t))} className="text-secondary/50 hover:text-secondary text-xs">✕</button>
        </span>
      ))}
      <input
        className="flex-1 min-w-[60px] outline-none text-body-sm bg-transparent"
        placeholder="Nhập rồi Enter…"
        value={input}
        onChange={e => setInput(e.target.value)}
        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(input) } }}
        onBlur={() => { if (input.trim()) add(input) }}
      />
    </div>
  )
}

function supplierParentKey(p: SupplierProduct): string {
  return [
    p.supplier.id,
    p.productName ?? '',
    p.productType ?? '',
    p.baseSku ?? '',
  ].join('|')
}

function normalize(v: string | null | undefined): string {
  return (v ?? '').toLowerCase().trim()
}

function productLabel(p: SupplierProduct): string {
  return `${p.productName ?? p.productType ?? p.baseSku ?? p.sku} — ${p.supplier.name}${p.baseSku ? ` · ${p.baseSku}` : ''}`
}

function variantLabel(p: SupplierProduct): string {
  const variants = [p.variant1Value, p.variant2Value].filter(Boolean).join(' / ')
  return `${p.productName ?? p.productType ?? p.baseSku ?? p.sku} — ${p.supplier.name} · ${p.sku}${variants ? ` · ${variants}` : ''}`
}

// ── Edit Modal ───────────────────────────────────────────────
function EditModal({
  base, supplierProducts, onSave, onClose,
}: {
  base: ProductBase | null
  supplierProducts: SupplierProduct[]
  onSave: (data: any) => Promise<void>
  onClose: () => void
}) {
  const [name, setName] = useState(base?.name ?? '')
  const [productType, setProductType] = useState(base?.shopifyProductType ?? '')
  const [conditions, setConditions] = useState<ConditionRow[]>(() => {
    if (!base?.variantConditions) return [{ optionName: '', anyOf: [] }]
    try {
      const parsed = JSON.parse(base.variantConditions)
      return parsed.map((c: any) => ({ optionName: c.optionName, anyOf: c.anyOf ?? (c.value ? [c.value] : []) }))
    } catch { return [{ optionName: '', anyOf: [] }] }
  })
  const [supplierMappings, setSupplierMappings] = useState<Array<{ preferenceRank: number; supplierProductId: string }>>(
    base?.supplierMappings.map(m => ({ preferenceRank: m.preferenceRank, supplierProductId: m.supplierProductId })) ?? []
  )
  const [overrides, setOverrides] = useState<Array<{ attributeCombo: string; supplierProductId: string; attrKey: string; attrVal: string }>>(
    base?.overrides.map(o => {
      let attrKey = '', attrVal = ''
      try { const c = JSON.parse(o.attributeCombo); const k = Object.keys(c)[0]; attrKey = k; attrVal = c[k] } catch {}
      return { attributeCombo: o.attributeCombo, supplierProductId: o.supplierProductId, attrKey, attrVal }
    }) ?? []
  )
  const [saving, setSaving] = useState(false)

  const parentGroups = useMemo(() => {
    const map = new Map<string, { key: string; label: string; products: SupplierProduct[]; representative: SupplierProduct }>()
    for (const p of supplierProducts) {
      const key = supplierParentKey(p)
      const existing = map.get(key)
      if (existing) {
        existing.products.push(p)
        if (p.sku < existing.representative.sku) existing.representative = p
      } else {
        map.set(key, { key, label: productLabel(p), products: [p], representative: p })
      }
    }
    return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label))
  }, [supplierProducts])

  const parentGroupByProductId = useMemo(() => {
    const map = new Map<string, { key: string; label: string; products: SupplierProduct[]; representative: SupplierProduct }>()
    for (const group of parentGroups) {
      for (const p of group.products) map.set(p.id, group)
    }
    return map
  }, [parentGroups])

  const generatedVariantRows = useMemo(() => (
    conditions.filter(c => c.anyOf.length > 1 || ['size', 'color'].includes(normalize(c.optionName))).flatMap(c => c.optionName
      ? c.anyOf.map(value => ({ optionName: c.optionName, value }))
      : [])
  ), [conditions])

  useEffect(() => {
    const primaryGroup = supplierMappings[0]?.supplierProductId
      ? parentGroupByProductId.get(supplierMappings[0].supplierProductId)
      : null
    if (!primaryGroup || generatedVariantRows.length === 0) return

    setOverrides(prev => {
      let changed = false
      const next = [...prev]
      for (const row of generatedVariantRows) {
        const existing = next.find(o => normalize(o.attrKey) === normalize(row.optionName) && normalize(o.attrVal) === normalize(row.value))
        if (existing) continue
        const exact = primaryGroup.products.find(p =>
          normalize(p.variant1Value) === normalize(row.value) ||
          normalize(p.variant2Value) === normalize(row.value)
        )
        next.push({
          attributeCombo: '',
          attrKey: row.optionName,
          attrVal: row.value,
          supplierProductId: exact?.id ?? '',
        })
        changed = true
      }
      return changed ? next : prev
    })
  }, [generatedVariantRows, parentGroupByProductId, supplierMappings])

  function buildConditionsJson() {
    return JSON.stringify(conditions.filter(c => c.optionName && c.anyOf.length > 0).map(c => ({
      optionName: c.optionName,
      anyOf: c.anyOf,
    })))
  }

  async function handleSave() {
    if (!name || !productType) return
    setSaving(true)
    try {
      await onSave({
        name, shopifyProductType: productType,
        variantConditions: buildConditionsJson(),
        supplierMappings: supplierMappings.filter(m => m.supplierProductId),
        overrides: overrides.filter(o => o.supplierProductId && o.attrKey && o.attrVal).map(o => ({
          supplierProductId: o.supplierProductId,
          attributeCombo: JSON.stringify({ [o.attrKey]: o.attrVal }),
        })),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-surface-container-lowest rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-xl py-md bg-primary rounded-t-xl">
          <h2 className="text-headline-sm text-on-primary font-bold">{base ? `Edit — ${base.name}` : 'New Product Base'}</h2>
          <button onClick={onClose} className="text-on-primary/50 hover:text-on-primary text-xl">✕</button>
        </div>

        <div className="p-xl flex flex-col gap-lg">
          {/* Basic info */}
          <div>
            <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-sm">Thông tin cơ bản</p>
            <div className="grid grid-cols-2 gap-md">
              <div>
                <label className="text-label-sm text-on-surface/60 mb-xs block">Tên Product Base</label>
                <input className="w-full border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm" value={name} onChange={e => setName(e.target.value)} />
              </div>
              <div>
                <label className="text-label-sm text-on-surface/60 mb-xs block">Shopify Product Type</label>
                <input className="w-full border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm" value={productType} onChange={e => setProductType(e.target.value)} />
              </div>
            </div>
          </div>

          {/* Conditions */}
          <div>
            <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-xs">Match Conditions <span className="font-normal normal-case text-on-surface/40">(AND logic)</span></p>
            <div className="flex flex-col gap-sm">
              {conditions.map((c, i) => (
                <div key={i} className="border border-outline-variant/30 rounded-lg p-md grid grid-cols-[130px_1fr_32px] gap-md items-start">
                  <div>
                    <label className="text-label-sm text-on-surface/50 mb-xs block">Option Name</label>
                    <input className="w-full border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm" value={c.optionName} onChange={e => setConditions(prev => prev.map((r, j) => j === i ? { ...r, optionName: e.target.value } : r))} placeholder="Style, Size…" />
                  </div>
                  <div>
                    <label className="text-label-sm text-on-surface/50 mb-xs block">Values <span className="text-on-surface/30 font-normal">(Enter để thêm)</span></label>
                    <TagInput tags={c.anyOf} onChange={tags => setConditions(prev => prev.map((r, j) => j === i ? { ...r, anyOf: tags } : r))} />
                  </div>
                  <button onClick={() => setConditions(prev => prev.filter((_, j) => j !== i))} className="text-error hover:text-error/80 text-lg mt-5">✕</button>
                </div>
              ))}
              <button onClick={() => setConditions(prev => [...prev, { optionName: '', anyOf: [] }])} className="text-secondary text-label-sm self-start hover:underline">+ Add condition</button>
            </div>
          </div>

          {/* Supplier mappings */}
          <div>
            <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-xs">Suppliers theo Rank</p>
            <p className="text-body-sm text-on-surface/40 mb-sm">Choose the supplier parent product. If you add conditions like Size S/M/L, variant mapping rows appear below.</p>
            <div className="flex flex-col gap-sm">
              {supplierMappings.map((m, i) => (
                <div key={i} className="grid grid-cols-[40px_1fr_32px] gap-sm items-center">
                  <span className={`text-center rounded-lg py-[6px] text-label-sm font-bold ${i === 0 ? 'bg-secondary text-on-secondary' : 'bg-secondary/10 text-secondary'}`}>#{i + 1}</span>
                  <select className="border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm bg-surface-container-lowest" value={m.supplierProductId} onChange={e => setSupplierMappings(prev => prev.map((r, j) => j === i ? { ...r, supplierProductId: e.target.value, preferenceRank: j + 1 } : r))}>
                    <option value="">-- Choose supplier parent product --</option>
                    {parentGroups.map(g => (
                      <option key={g.key} value={g.representative.id}>{g.label}</option>
                    ))}
                  </select>
                  <button onClick={() => setSupplierMappings(prev => prev.filter((_, j) => j !== i).map((r, j) => ({ ...r, preferenceRank: j + 1 })))} className="text-error text-lg">✕</button>
                </div>
              ))}
              <button onClick={() => setSupplierMappings(prev => [...prev, { preferenceRank: prev.length + 1, supplierProductId: '' }])} className="text-secondary text-label-sm self-start hover:underline">+ Add supplier product</button>
            </div>
          </div>

          {generatedVariantRows.length > 0 && (
            <div>
              <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-xs">Variant Mapping</p>
              <p className="text-body-sm text-on-surface/40 mb-sm">Map từng value của Shopify option sang variant cụ thể của supplier.</p>
              <div className="flex flex-col gap-sm">
                {generatedVariantRows.map((row) => {
                  const existing = overrides.find(o => normalize(o.attrKey) === normalize(row.optionName) && normalize(o.attrVal) === normalize(row.value))
                  const selectedParent = supplierMappings[0]?.supplierProductId
                    ? parentGroupByProductId.get(supplierMappings[0].supplierProductId)
                    : null
                  const options = selectedParent?.products.length ? selectedParent.products : supplierProducts
                  return (
                    <div key={`${row.optionName}:${row.value}`} className="grid grid-cols-[160px_1fr] gap-md items-center rounded-lg border border-outline-variant/30 p-md">
                      <div>
                        <div className="text-label-sm text-on-surface/50">{row.optionName}</div>
                        <div className="text-body-md font-semibold">{row.value}</div>
                      </div>
                      <select
                        className="border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm bg-surface-container-lowest"
                        value={existing?.supplierProductId ?? ''}
                        onChange={e => setOverrides(prev => {
                          const found = prev.some(o => normalize(o.attrKey) === normalize(row.optionName) && normalize(o.attrVal) === normalize(row.value))
                          if (found) {
                            return prev.map(o => normalize(o.attrKey) === normalize(row.optionName) && normalize(o.attrVal) === normalize(row.value)
                              ? { ...o, supplierProductId: e.target.value }
                              : o)
                          }
                          return [...prev, { attributeCombo: '', attrKey: row.optionName, attrVal: row.value, supplierProductId: e.target.value }]
                        })}
                      >
                        <option value="">-- Chọn supplier variant --</option>
                        {options.map(p => (
                          <option key={p.id} value={p.id}>{variantLabel(p)}</option>
                        ))}
                      </select>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Special cases */}
          <div>
            <p className="text-label-sm font-semibold text-on-surface/50 uppercase tracking-widest mb-xs">Special Cases</p>
            <p className="text-body-sm text-on-surface/40 mb-sm">Ngoại lệ cho attribute combo cụ thể</p>
            <div className="flex flex-col gap-sm">
              {overrides.map((o, index) => ({ o, index })).filter(({ o }) => !generatedVariantRows.some(row =>
                normalize(o.attrKey) === normalize(row.optionName) &&
                normalize(o.attrVal) === normalize(row.value)
              )).map(({ o, index }) => (
                <div key={index} className="bg-[#fff8e1] border border-[#ffe082] rounded-lg p-md grid grid-cols-[1fr_1fr_32px] gap-md items-end">
                  <div>
                    <label className="text-label-sm text-on-surface/50 mb-xs block">Khi <span className="text-on-surface/30">(key = value)</span></label>
                    <div className="flex gap-sm">
                      <input className="flex-1 border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm" value={o.attrKey} onChange={e => setOverrides(prev => prev.map((r, j) => j === index ? { ...r, attrKey: e.target.value } : r))} placeholder="Size" />
                      <input className="flex-1 border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm" value={o.attrVal} onChange={e => setOverrides(prev => prev.map((r, j) => j === index ? { ...r, attrVal: e.target.value } : r))} placeholder="6XL" />
                    </div>
                  </div>
                  <div>
                    <label className="text-label-sm text-on-surface/50 mb-xs block">Dùng supplier product</label>
                    <select className="w-full border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm bg-white" value={o.supplierProductId} onChange={e => setOverrides(prev => prev.map((r, j) => j === index ? { ...r, supplierProductId: e.target.value } : r))}>
                      <option value="">-- Chọn --</option>
                      {supplierProducts.map(p => (
                        <option key={p.id} value={p.id}>{p.productName ?? p.sku} — {p.supplier.name}</option>
                      ))}
                    </select>
                  </div>
                  <button onClick={() => setOverrides(prev => prev.filter((_, j) => j !== index))} className="text-error text-lg mb-[2px]">✕</button>
                </div>
              ))}
              <button onClick={() => setOverrides(prev => [...prev, { attributeCombo: '', supplierProductId: '', attrKey: '', attrVal: '' }])} className="text-secondary text-label-sm self-start hover:underline">+ Add special case</button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-md px-xl py-md border-t border-outline-variant/20 bg-surface-container-low rounded-b-xl">
          <button onClick={onClose} className="px-lg py-sm rounded-lg border border-outline-variant/40 text-label-md text-on-surface/60">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
            {saving ? 'Saving…' : 'Save Product Base'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Main Page ─────────────────────────────────────────────────
export default function MappingPage() {
  const [tab, setTab] = useState<'auto' | 'manual'>('auto')
  const [bases, setBases] = useState<ProductBase[]>([])
  const [supplierProducts, setSupplierProducts] = useState<SupplierProduct[]>([])
  const [pendingLines, setPendingLines] = useState<PendingLine[]>([])
  const [savedMappings, setSavedMappings] = useState<SavedMapping[]>([])
  const [manualSubTab, setManualSubTab] = useState<'pending' | 'saved'>('pending')
  const [editBase, setEditBase] = useState<ProductBase | null | undefined>(undefined) // undefined = closed, null = new
  const [pendingAssign, setPendingAssign] = useState<Record<string, string>>({}) // variantId → supplierProductId
  const [saving, setSaving] = useState<string | null>(null)

  async function loadData() {
    const [basesRes, spRes, manualRes] = await Promise.all([
      fetch('/api/fulfillment/mapping/product-bases').then(r => r.json()),
      fetch('/api/fulfillment/mapping/supplier-products').then(r => r.json()),
      fetch('/api/fulfillment/mapping/manual').then(r => r.json()),
    ])
    setBases(basesRes.bases ?? [])
    setSupplierProducts(spRes.products ?? [])
    setPendingLines(manualRes.pending ?? [])
    setSavedMappings(manualRes.saved ?? [])
  }

  useEffect(() => { loadData() }, [])

  async function handleSaveBase(data: any) {
    let res: Response
    if (editBase === null) {
      res = await fetch('/api/fulfillment/mapping/product-bases', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    } else if (editBase) {
      res = await fetch(`/api/fulfillment/mapping/product-bases/${editBase.id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) })
    } else {
      return
    }
    if (!res.ok) return
    setEditBase(undefined)
    loadData()
  }

  async function handleDeleteBase(id: string) {
    if (!confirm('Xóa Product Base này?')) return
    await fetch(`/api/fulfillment/mapping/product-bases/${id}`, { method: 'DELETE' })
    loadData()
  }

  async function handleSaveManual(line: PendingLine) {
    const spId = pendingAssign[line.shopifyVariantId ?? line.id]
    if (!spId || !line.shopifyVariantId) return
    setSaving(line.id)
    await fetch('/api/fulfillment/mapping/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        shopifyVariantId: line.shopifyVariantId,
        shopifyProductTitle: line.productTitle,
        variantTitle: line.variantTitle,
        supplierProductId: spId,
      }),
    })
    setSaving(null)
    loadData()
  }

  async function handleDeleteManual(id: string) {
    if (!confirm('Xóa manual mapping này?')) return
    await fetch(`/api/fulfillment/mapping/manual/${id}`, { method: 'DELETE' })
    loadData()
  }

  const pendingCount = pendingLines.length

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-xl py-md border-b border-outline-variant/20">
            <div>
              <h1 className="text-headline-sm font-bold text-on-surface">Product Mapping</h1>
              <p className="text-body-sm text-on-surface/50 mt-xs">Cấu hình tự động khớp sản phẩm với supplier</p>
            </div>
            {tab === 'auto' && (
              <button onClick={() => setEditBase(null)} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
                + New Product Base
              </button>
            )}
          </div>

          {/* Tabs */}
          <div className="flex border-b-2 border-outline-variant/20 bg-surface-container-low">
            <button onClick={() => setTab('auto')} className={`px-xl py-md text-label-md font-semibold transition-colors border-b-2 -mb-[2px] ${tab === 'auto' ? 'text-secondary border-secondary' : 'text-on-surface/50 border-transparent hover:text-on-surface'}`}>
              Auto Mapping
            </button>
            <button onClick={() => setTab('manual')} className={`px-xl py-md text-label-md font-semibold transition-colors border-b-2 -mb-[2px] flex items-center gap-sm ${tab === 'manual' ? 'text-error border-error' : 'text-on-surface/50 border-transparent hover:text-on-surface'}`}>
              Manual Mapping
              {pendingCount > 0 && <span className="bg-error text-white rounded-full px-sm py-[1px] text-[11px] font-bold">{pendingCount}</span>}
            </button>
          </div>

          {/* AUTO TAB */}
          {tab === 'auto' && (
            <div className="p-xl">
              <div className="border border-outline-variant/20 rounded-xl overflow-hidden">
                <div className="grid grid-cols-[2fr_2.5fr_2.5fr_1.2fr_80px] gap-md px-lg py-sm bg-surface-container-low text-label-sm font-semibold text-on-surface/50 uppercase tracking-wide">
                  <span>Product Base</span><span>Match Conditions</span><span>Suppliers</span><span>Special Cases</span><span></span>
                </div>
                {bases.length === 0 && (
                  <div className="px-lg py-xl text-center text-on-surface/40 text-body-sm">Chưa có Product Base nào. Nhấn New để tạo.</div>
                )}
                {bases.map((b, i) => {
                  let conditions: ConditionRow[] = []
                  try { conditions = JSON.parse(b.variantConditions) } catch {}
                  return (
                    <div key={b.id} className={`grid grid-cols-[2fr_2.5fr_2.5fr_1.2fr_80px] gap-md px-lg py-md items-center border-t border-outline-variant/10 ${i % 2 === 1 ? 'bg-surface-container-lowest' : ''}`}>
                      <div>
                        <p className="text-label-md font-bold text-on-surface">{b.name}</p>
                        <p className="text-body-sm text-on-surface/40 mt-[2px]">{b.shopifyProductType}</p>
                      </div>
                      <div className="flex flex-wrap gap-xs">
                        {conditions.map((c, ci) => (
                          <span key={ci} className="bg-secondary/10 text-secondary px-sm py-[2px] rounded text-label-sm font-semibold">
                            {c.optionName} = {(c.anyOf ?? []).join(', ')}
                          </span>
                        ))}
                      </div>
                      <div className="flex flex-wrap gap-xs">
                        {b.supplierMappings.map((m, mi) => (
                          <span key={m.supplierProductId} className={`px-sm py-[2px] rounded text-label-sm font-semibold ${mi === 0 ? 'bg-tertiary/10 text-tertiary' : 'bg-blue-100 text-blue-800'}`}>
                            #{m.preferenceRank} {m.supplierProduct.supplier.name}
                          </span>
                        ))}
                      </div>
                      <div>
                        {b.overrides.length > 0
                          ? <span className="bg-amber-100 text-amber-800 px-sm py-[2px] rounded text-label-sm font-semibold">{b.overrides.length} case{b.overrides.length > 1 ? 's' : ''}</span>
                          : <span className="text-on-surface/30 text-body-sm">—</span>}
                      </div>
                      <div className="flex gap-md justify-end">
                        <button onClick={() => setEditBase(b)} className="text-secondary text-label-sm font-semibold hover:underline">Edit</button>
                        <button onClick={() => handleDeleteBase(b.id)} className="text-error text-label-sm font-semibold hover:underline">Del</button>
                      </div>
                    </div>
                  )
                })}
              </div>
              <div className="mt-md p-md bg-secondary/5 rounded-lg text-body-sm text-on-surface/50 flex gap-xl flex-wrap">
                <span>🔵 Conditions match → auto assign supplier theo rank</span>
                <span>🟠 Special Cases = ngoại lệ attribute combo</span>
                <span>🔴 Manual Mapping tab = override tuyệt đối, priority 1</span>
              </div>
            </div>
          )}

          {/* MANUAL TAB */}
          {tab === 'manual' && (
            <div className="p-xl">
              <div className="bg-amber-50 border border-amber-200 rounded-lg px-lg py-md mb-lg flex items-start gap-sm text-body-sm text-amber-900">
                <span className="text-lg">⚡</span>
                <span>Mapping ở đây <strong>override tất cả Auto Mapping rules</strong> và được dùng làm priority 1 cho mọi order về sau có cùng variant.</span>
              </div>

              <div className="flex gap-xs mb-lg border border-outline-variant/20 rounded-lg overflow-hidden w-fit">
                <button onClick={() => setManualSubTab('pending')} className={`px-lg py-sm text-label-md font-semibold flex items-center gap-sm ${manualSubTab === 'pending' ? 'bg-error text-white' : 'bg-surface-container-lowest text-on-surface/60'}`}>
                  Pending
                  {pendingCount > 0 && <span className={`rounded-full px-sm py-[1px] text-[11px] font-bold ${manualSubTab === 'pending' ? 'bg-white/30 text-white' : 'bg-error text-white'}`}>{pendingCount}</span>}
                </button>
                <button onClick={() => setManualSubTab('saved')} className={`px-lg py-sm text-label-md font-semibold flex items-center gap-sm border-l border-outline-variant/20 ${manualSubTab === 'saved' ? 'bg-secondary text-on-secondary' : 'bg-surface-container-lowest text-on-surface/60'}`}>
                  Saved Mappings
                  <span className={`rounded-full px-sm py-[1px] text-[11px] font-bold ${manualSubTab === 'saved' ? 'bg-white/20 text-white' : 'bg-secondary/10 text-secondary'}`}>{savedMappings.length}</span>
                </button>
              </div>

              {/* Pending sub-tab */}
              {manualSubTab === 'pending' && (
                <div className="border border-outline-variant/20 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-[2.5fr_1.5fr_1fr_2fr_100px] gap-md px-lg py-sm bg-surface-container-low text-label-sm font-semibold text-on-surface/50 uppercase tracking-wide">
                    <span>Product / Variant</span><span>SKU</span><span>Blocked</span><span>Assign Supplier SKU</span><span></span>
                  </div>
                  {pendingLines.length === 0 && (
                    <div className="px-lg py-xl text-center text-on-surface/40 text-body-sm">Không có order nào đang bị blocked. ✅</div>
                  )}
                  {pendingLines.filter(line => line.shopifyVariantId != null).map(line => (
                    <div key={line.id} className="grid grid-cols-[2.5fr_1.5fr_1fr_2fr_100px] gap-md px-lg py-md items-center border-t border-outline-variant/10">
                      <div>
                        <p className="text-label-md font-semibold text-on-surface">{line.productTitle}</p>
                        <p className="text-body-sm text-on-surface/40">{line.variantTitle}</p>
                        <p className="text-body-sm text-on-surface/30">#{line.order.shopifyOrderNumber}</p>
                      </div>
                      <span className="font-mono text-body-sm text-on-surface/60">{line.sku ?? '—'}</span>
                      <span className="text-error text-label-sm font-semibold">blocked</span>
                      <select
                        className="border border-outline-variant/40 rounded-lg px-sm py-[6px] text-body-sm bg-surface-container-lowest"
                        value={pendingAssign[line.shopifyVariantId ?? line.id] ?? ''}
                        onChange={e => setPendingAssign(prev => ({ ...prev, [line.shopifyVariantId ?? line.id]: e.target.value }))}
                      >
                        <option value="">-- Chọn supplier SKU --</option>
                        {supplierProducts.map(p => (
                          <option key={p.id} value={p.id}>{p.productName ?? p.sku} — {p.supplier.name} · {p.sku}</option>
                        ))}
                      </select>
                      <button
                        onClick={() => handleSaveManual(line)}
                        disabled={!pendingAssign[line.shopifyVariantId ?? line.id] || saving === line.id}
                        className="bg-secondary text-on-secondary px-md py-sm rounded-lg text-label-sm font-semibold disabled:opacity-40"
                      >
                        {saving === line.id ? '…' : 'Save'}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              {/* Saved sub-tab */}
              {manualSubTab === 'saved' && (
                <div className="border border-outline-variant/20 rounded-xl overflow-hidden">
                  <div className="grid grid-cols-[2.5fr_2fr_80px] gap-md px-lg py-sm bg-surface-container-low text-label-sm font-semibold text-on-surface/50 uppercase tracking-wide">
                    <span>Product / Variant</span><span>Mapped Supplier Product</span><span></span>
                  </div>
                  {savedMappings.length === 0 && (
                    <div className="px-lg py-xl text-center text-on-surface/40 text-body-sm">Chưa có mapping nào được lưu.</div>
                  )}
                  {savedMappings.map(m => (
                    <div key={m.id} className="grid grid-cols-[2.5fr_2fr_80px] gap-md px-lg py-md items-center border-t border-outline-variant/10">
                      <div>
                        <p className="text-label-md font-semibold text-on-surface">{m.shopifyProductTitle}</p>
                        <p className="text-body-sm text-on-surface/40">{m.variantTitle}</p>
                        <p className="font-mono text-body-sm text-on-surface/30">{m.shopifyVariantId}</p>
                      </div>
                      <div>
                        <p className="text-label-md font-semibold text-on-surface">{m.supplierProduct.productName ?? m.supplierProduct.sku}</p>
                        <p className="text-body-sm text-on-surface/50">{m.supplierProduct.supplier.name} · {m.supplierProduct.sku}</p>
                      </div>
                      <div className="flex justify-end">
                        <button onClick={() => handleDeleteManual(m.id)} className="text-error text-label-sm font-semibold hover:underline">Delete</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* Edit Modal */}
      {editBase !== undefined && (
        <EditModal
          base={editBase}
          supplierProducts={supplierProducts}
          onSave={handleSaveBase}
          onClose={() => setEditBase(undefined)}
        />
      )}
    </div>
  )
}

