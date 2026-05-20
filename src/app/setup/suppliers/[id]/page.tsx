'use client'
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useParams, usePathname } from 'next/navigation'
import * as XLSX from 'xlsx'
import Sidebar from '@/components/Sidebar'
import { parseCsv } from '@/lib/csv-parser'

type Supplier = {
  id: string
  name: string
  code: string
  apiType: string | null
  firstItemShipFee: number
  additionalItemShipFee: number
  currency: string
  preferenceRank: number
  note: string | null
  isActive: boolean
}

type Product = {
  id: string
  sku: string
  productName: string | null
  baseCost: number
  currency: string
  requiresDesign: boolean
  updatedAt: string
  baseSku: string | null
  productType: string | null
  variant1Name: string | null
  variant1Value: string | null
  variant2Name: string | null
  variant2Value: string | null
  designTemplateUrl: string | null
  minProductionDays: number | null
  maxProductionDays: number | null
  shippingByRegion: string | null
}

type ImportRow = {
  sku: string
  baseCost: number
  productName?: string
  requiresDesign?: boolean
  baseSku?: string | null
  productType?: string | null
  variant1Name?: string | null
  variant1Value?: string | null
  variant2Name?: string | null
  variant2Value?: string | null
  designTemplateUrl?: string | null
  minProductionDays?: number | null
  maxProductionDays?: number | null
  shippingByRegion?: string | null
}

type AddRow = {
  productType: string
  baseSku: string
  variant1Name: string
  variant1Value: string
  variant2Name: string
  variant2Value: string
  sku: string
  baseCost: string
  usShipFirst: string
  usShipAdditional: string
}

type ExpandState = {
  designTemplateUrl: string
  minProductionDays: string
  maxProductionDays: string
  usShipFirst: string
  usShipAdditional: string
  euShipFirst: string
  euShipAdditional: string
  rowShipFirst: string
  rowShipAdditional: string
}

const emptyAddRow: AddRow = {
  productType: '',
  baseSku: '',
  variant1Name: '',
  variant1Value: '',
  variant2Name: '',
  variant2Value: '',
  sku: '',
  baseCost: '',
  usShipFirst: '',
  usShipAdditional: '',
}

function num(v: unknown): number {
  if (!v) return 0
  const n = parseFloat(v.toString().replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function buildShipping(regions: Record<string, { first: string; additional: string }>): string | null {
  const obj: Record<string, { first: number; additional: number }> = {}
  for (const [zone, { first, additional }] of Object.entries(regions)) {
    if (first || additional) obj[zone] = { first: num(first), additional: num(additional) }
  }
  return Object.keys(obj).length > 0 ? JSON.stringify(obj) : null
}

function parseExcelRows(fileBuffer: ArrayBuffer): Record<string, string>[] {
  const workbook = XLSX.read(fileBuffer, { type: 'array' })
  const sheet = workbook.Sheets[workbook.SheetNames[0]]
  const matrix = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: '' })
  const headerIndex = matrix.findIndex(row => row.map(String).some(cell => cell.trim() === 'SKU variant'))
  if (headerIndex < 0) return []
  const headers = matrix[headerIndex].map(cell => String(cell).trim())
  return matrix.slice(headerIndex + 1).map(row => {
    const obj: Record<string, string> = {}
    headers.forEach((header, index) => { if (header) obj[header] = String(row[index] ?? '').trim() })
    return obj
  })
}

function rowsToImportRows(rows: Record<string, unknown>[]): ImportRow[] {
  return rows.map(r => {
    const sku = String(r['SKU variant'] ?? r.sku ?? '').trim()
    const baseCost = num(r['Base cost ($)'] ?? r['Tier 1 (0 - 999)'] ?? r.baseCost ?? r.basecost ?? '0')
    const minProd = r['Min production time']
    const maxProd = r['Max production time']
    const v1Value = String(r['Variant 1 Value'] ?? r['SIZES'] ?? '').trim() || null
    const v1Name = String(r['Variant 1 Name'] ?? '').trim() || (v1Value ? 'Size' : null)
    const shipping: Record<string, { first: number; additional: number; importTax?: number }> = {}
    const usFirst = r['US shipping fee (1st item)']
    const usAdditional = r['US additional shipping fee']
    const usTax = r['US import Tax/item']
    if (usFirst !== undefined || usAdditional !== undefined || usTax !== undefined) {
      shipping.US = { first: num(usFirst), additional: num(usAdditional) }
      if (num(usTax) > 0) shipping.US.importTax = num(usTax)
    }
    for (const zone of ['EU', 'GB', 'CA', 'ROW']) {
      const f = r[`${zone} shipping fee (1st item)`]
      const a = r[`${zone} additional shipping fee`]
      if (f !== undefined || a !== undefined) shipping[zone] = { first: num(f), additional: num(a) }
    }
    return {
      sku,
      baseCost,
      productName: String(r.productName ?? r['Product type'] ?? r['Product Title'] ?? '').trim() || undefined,
      requiresDesign: ['1', 'true', 'TRUE', 'yes', 'YES'].includes(String(r.requiresDesign ?? r.requiresdesign ?? '').trim()),
      baseSku: String(r['SKU product'] ?? '').trim() || null,
      productType: String(r['Product type'] ?? r['Product Title'] ?? '').trim() || null,
      variant1Name: v1Name,
      variant1Value: v1Value,
      variant2Name: String(r['Variant 2 Name'] ?? '').trim() || null,
      variant2Value: String(r['Variant 2 Value'] ?? '').trim() || null,
      designTemplateUrl: String(r['Design Template'] ?? '').trim() || null,
      minProductionDays: minProd ? parseInt(String(minProd), 10) : null,
      maxProductionDays: maxProd ? parseInt(String(maxProd), 10) : null,
      shippingByRegion: Object.keys(shipping).length > 0 ? JSON.stringify(shipping) : null,
    }
  }).filter(r => r.sku)
}

function initExpandState(p: Product): ExpandState {
  let s: Record<string, { first?: number; additional?: number }> = {}
  try { if (p.shippingByRegion) s = JSON.parse(p.shippingByRegion) } catch {}
  return {
    designTemplateUrl: p.designTemplateUrl ?? '',
    minProductionDays: p.minProductionDays?.toString() ?? '',
    maxProductionDays: p.maxProductionDays?.toString() ?? '',
    usShipFirst: s.US?.first?.toString() ?? '',
    usShipAdditional: s.US?.additional?.toString() ?? '',
    euShipFirst: s.EU?.first?.toString() ?? '',
    euShipAdditional: s.EU?.additional?.toString() ?? '',
    rowShipFirst: s.ROW?.first?.toString() ?? '',
    rowShipAdditional: s.ROW?.additional?.toString() ?? '',
  }
}

function usShippingDisplay(p: Product): string {
  try {
    const s = p.shippingByRegion ? JSON.parse(p.shippingByRegion) : {}
    const us = s.US
    if (!us) return '—'
    return `$${(us.first ?? 0).toFixed(2)} / $${(us.additional ?? 0).toFixed(2)}`
  } catch { return '—' }
}

export default function SupplierSetupPage() {
  const params = useParams<{ id: string }>()
  const pathname = usePathname()
  const supplierId = params.id
  const suppliersPath = pathname.startsWith('/fulfillment') ? '/fulfillment/suppliers' : '/setup/suppliers'

  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [products, setProducts] = useState<Product[]>([])
  const [search, setSearch] = useState('')
  const [total, setTotal] = useState(0)
  const [addRow, setAddRow] = useState<AddRow>({ ...emptyAddRow })
  const [addBusy, setAddBusy] = useState(false)
  const [importPreview, setImportPreview] = useState<ImportRow[] | null>(null)
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: unknown[] } | null>(null)
  const [importBusy, setImportBusy] = useState(false)
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set())
  const [expandForms, setExpandForms] = useState<Record<string, ExpandState>>({})
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set())
  const fileRef = useRef<HTMLInputElement>(null)

  const loadSupplier = useCallback(async () => {
    const r = await fetch(`/api/suppliers/${supplierId}`)
    if (r.ok) setSupplier(await r.json())
  }, [supplierId])

  const loadProducts = useCallback(async () => {
    const q = new URLSearchParams({ supplierId })
    if (search) q.set('search', search)
    const r = await fetch('/api/suppliers/products?' + q.toString())
    const d = await r.json()
    setProducts(d.products ?? [])
    setTotal(d.total ?? 0)
  }, [supplierId, search])

  useEffect(() => { loadSupplier() }, [loadSupplier])
  useEffect(() => { loadProducts() }, [loadProducts])

  const updateAddRow = (patch: Partial<AddRow>) => setAddRow(r => ({ ...r, ...patch }))

  const commitAddRow = async () => {
    if (!addRow.sku.trim()) { alert('SKU variant required'); return }
    if (!addRow.baseCost) { alert('Base cost required'); return }
    setAddBusy(true)
    const row: ImportRow = {
      sku: addRow.sku.trim(),
      baseCost: num(addRow.baseCost),
      productType: addRow.productType || null,
      productName: addRow.productType || undefined,
      baseSku: addRow.baseSku || null,
      variant1Name: addRow.variant1Name || null,
      variant1Value: addRow.variant1Value || null,
      variant2Name: addRow.variant2Name || null,
      variant2Value: addRow.variant2Value || null,
      shippingByRegion: buildShipping({ US: { first: addRow.usShipFirst, additional: addRow.usShipAdditional } }),
    }
    const r = await fetch('/api/suppliers/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId, rows: [row] }),
    })
    if (r.ok) { setAddRow({ ...emptyAddRow }); await loadProducts() }
    setAddBusy(false)
  }

  const onFilePick = async (file: File) => {
    const rows = /\.(xlsx|xls)$/i.test(file.name)
      ? parseExcelRows(await file.arrayBuffer())
      : parseCsv(await file.text())
    setImportPreview(rowsToImportRows(rows))
    setImportResult(null)
  }

  const commitImport = async () => {
    if (!importPreview) return
    setImportBusy(true)
    const r = await fetch('/api/suppliers/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId, rows: importPreview }),
    })
    const result = await r.json()
    setImportResult(result)
    setImportPreview(null)
    setImportBusy(false)
    if (fileRef.current) fileRef.current.value = ''
    await loadProducts()
  }

  const toggleExpand = (p: Product) => {
    setExpandedIds(prev => {
      const next = new Set(prev)
      if (next.has(p.id)) {
        next.delete(p.id)
        setExpandForms(f => { const n = { ...f }; delete n[p.id]; return n })
      } else {
        next.add(p.id)
        setExpandForms(f => ({ ...f, [p.id]: initExpandState(p) }))
      }
      return next
    })
  }

  const updateExpandForm = (id: string, patch: Partial<ExpandState>) =>
    setExpandForms(f => ({ ...f, [id]: { ...f[id], ...patch } }))

  const cancelExpand = (id: string) => {
    setExpandedIds(prev => { const n = new Set(prev); n.delete(id); return n })
    setExpandForms(f => { const n = { ...f }; delete n[id]; return n })
  }

  const saveExpanded = async (p: Product) => {
    const es = expandForms[p.id]
    if (!es) return
    setSavingIds(prev => new Set(prev).add(p.id))
    const shippingByRegion = buildShipping({
      US: { first: es.usShipFirst, additional: es.usShipAdditional },
      EU: { first: es.euShipFirst, additional: es.euShipAdditional },
      ROW: { first: es.rowShipFirst, additional: es.rowShipAdditional },
    })
    const body = {
      designTemplateUrl: es.designTemplateUrl || null,
      minProductionDays: es.minProductionDays ? parseInt(es.minProductionDays, 10) : null,
      maxProductionDays: es.maxProductionDays ? parseInt(es.maxProductionDays, 10) : null,
      shippingByRegion,
    }
    const r = await fetch(`/api/suppliers/products/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (r.ok) { cancelExpand(p.id); await loadProducts() }
    setSavingIds(prev => { const n = new Set(prev); n.delete(p.id); return n })
  }

  const deleteOne = async (p: Product) => {
    if (!confirm(`Delete ${p.sku}?`)) return
    await fetch(`/api/suppliers/products/${p.id}`, { method: 'DELETE' })
    await loadProducts()
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="mb-lg">
          <a href={suppliersPath} className="text-secondary text-label-md">Back to fulfillments</a>
          <div className="flex items-start justify-between mt-sm gap-lg">
            <div>
              <h1 className="text-display-md">{supplier?.name ?? 'Supplier setup'}</h1>
              <p className="text-body-sm text-on-surface-variant mt-xs">
                Product catalog, SKU, cost, shipping và fulfillment export.
              </p>
            </div>
            <a href={`${suppliersPath}/${supplierId}/templates`} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
              Export templates
            </a>
          </div>
        </div>

        {supplier && (
          <div className="grid grid-cols-4 gap-md mb-lg">
            {[
              { label: 'Code', value: <span className="font-mono">{supplier.code}</span> },
              { label: 'Products', value: total },
              { label: 'Default shipping', value: `$${supplier.firstItemShipFee.toFixed(2)} / $${supplier.additionalItemShipFee.toFixed(2)}` },
              { label: 'Auto mapping rank', value: supplier.preferenceRank },
            ].map(({ label, value }) => (
              <div key={label} className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
                <div className="text-label-sm text-on-surface-variant">{label}</div>
                <div className="text-body-md mt-xs">{value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Import bar */}
        <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md mb-md flex items-center gap-lg flex-wrap">
          <div className="text-label-md font-semibold text-secondary whitespace-nowrap">📥 Import từ file</div>
          <div className="text-label-sm text-on-surface-variant flex-1 min-w-[200px]">
            Sheet cần có: Product type, SKU product, Variant 1 Name/Value, Variant 2 Name/Value, SKU variant, Base cost, shipping, production time
          </div>
          <label className="bg-secondary text-on-secondary px-md py-sm rounded-lg text-label-sm font-semibold cursor-pointer whitespace-nowrap">
            Choose File
            <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv,text/csv" className="hidden"
              onChange={e => e.target.files?.[0] && onFilePick(e.target.files[0])} />
          </label>
        </div>

        {importPreview && (
          <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md mb-md flex items-center gap-md">
            <span className="text-body-sm">Preview: {importPreview.length} row(s)</span>
            <button onClick={commitImport} disabled={importBusy}
              className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm disabled:opacity-50">
              {importBusy ? 'Saving...' : 'Save to this supplier'}
            </button>
            <button onClick={() => setImportPreview(null)} className="text-label-sm text-on-surface-variant">Cancel</button>
          </div>
        )}
        {importResult && (
          <div className="text-body-sm mb-md">
            Created: {importResult.created}, Updated: {importResult.updated}
            {(importResult.errors?.length ?? 0) > 0 && <span className="text-error ml-md">{importResult.errors.length} error(s)</span>}
          </div>
        )}

        {/* Product setup table */}
        <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant/20 flex items-center justify-between">
            <div>
              <div className="text-title-md font-semibold">Product setup</div>
              <div className="text-label-sm text-on-surface-variant mt-xs">Mỗi dòng là một supplier SKU variant</div>
            </div>
            <input placeholder="Search SKU or product" value={search} onChange={e => setSearch(e.target.value)}
              className="border rounded-lg px-md py-sm text-body-sm w-[260px]" />
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-label-sm border-collapse">
              <thead className="bg-surface-container text-left">
                <tr>
                  <th className="w-8 px-sm py-xs" />
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">Product type</th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">SKU product</th>
                  <th className="px-sm py-xs font-semibold bg-secondary/5">
                    <div className="text-secondary text-[11px]">Variant 1</div>
                    <div className="flex gap-xs mt-[2px]">
                      <span className="bg-secondary/10 text-secondary px-xs rounded text-[10px]">Name</span>
                      <span className="bg-secondary/10 text-secondary px-xs rounded text-[10px]">Value</span>
                    </div>
                  </th>
                  <th className="px-sm py-xs font-semibold bg-secondary/5">
                    <div className="text-secondary text-[11px]">Variant 2 <span className="text-[10px] text-on-surface-variant font-normal">(opt)</span></div>
                    <div className="flex gap-xs mt-[2px]">
                      <span className="bg-secondary/10 text-secondary px-xs rounded text-[10px]">Name</span>
                      <span className="bg-secondary/10 text-secondary px-xs rounded text-[10px]">Value</span>
                    </div>
                  </th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">SKU variant</th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">Base cost</th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold text-center">
                    <div>US Shipping</div>
                    <div className="text-[10px] font-normal text-on-surface-variant">1st / add.</div>
                  </th>
                  <th className="w-8" />
                </tr>
              </thead>
              <tbody>
                {/* Inline add row */}
                <tr className="bg-surface border-b border-outline-variant/20">
                  <td className="px-sm py-xs text-on-surface-variant text-center text-xs">+</td>
                  <td className="px-xs py-xs"><input className="w-36 border rounded px-xs py-[3px] text-xs" placeholder="3D Clothing" value={addRow.productType} onChange={e => updateAddRow({ productType: e.target.value })} /></td>
                  <td className="px-xs py-xs"><input className="w-24 border rounded px-xs py-[3px] font-mono text-xs" placeholder="TX" value={addRow.baseSku} onChange={e => updateAddRow({ baseSku: e.target.value })} /></td>
                  <td className="px-xs py-xs bg-secondary/5">
                    <div className="flex gap-xs">
                      <input className="w-16 border rounded px-xs py-[3px] text-xs" placeholder="Size" value={addRow.variant1Name} onChange={e => updateAddRow({ variant1Name: e.target.value })} />
                      <input className="w-14 border rounded px-xs py-[3px] text-xs" placeholder="XL" value={addRow.variant1Value} onChange={e => updateAddRow({ variant1Value: e.target.value })} />
                    </div>
                  </td>
                  <td className="px-xs py-xs bg-secondary/5">
                    <div className="flex gap-xs">
                      <input className="w-16 border rounded px-xs py-[3px] text-xs" placeholder="Color" value={addRow.variant2Name} onChange={e => updateAddRow({ variant2Name: e.target.value })} />
                      <input className="w-14 border rounded px-xs py-[3px] text-xs" placeholder="Black" value={addRow.variant2Value} onChange={e => updateAddRow({ variant2Value: e.target.value })} />
                    </div>
                  </td>
                  <td className="px-xs py-xs"><input className="w-32 border rounded px-xs py-[3px] font-mono text-xs" placeholder="TX-XL-BLK" value={addRow.sku} onChange={e => updateAddRow({ sku: e.target.value })} /></td>
                  <td className="px-xs py-xs"><input className="w-20 border rounded px-xs py-[3px] text-xs" type="number" step="0.01" placeholder="10.00" value={addRow.baseCost} onChange={e => updateAddRow({ baseCost: e.target.value })} /></td>
                  <td className="px-xs py-xs">
                    <div className="flex gap-xs items-center">
                      <input className="w-14 border rounded px-xs py-[3px] text-xs text-center" type="number" step="0.01" placeholder="4.00" value={addRow.usShipFirst} onChange={e => updateAddRow({ usShipFirst: e.target.value })} />
                      <span className="text-on-surface-variant text-xs">/</span>
                      <input className="w-14 border rounded px-xs py-[3px] text-xs text-center" type="number" step="0.01" placeholder="1.50" value={addRow.usShipAdditional} onChange={e => updateAddRow({ usShipAdditional: e.target.value })} />
                    </div>
                  </td>
                  <td className="px-xs py-xs">
                    <button onClick={commitAddRow} disabled={addBusy}
                      className="bg-secondary text-on-secondary px-sm py-[3px] rounded text-[11px] font-semibold disabled:opacity-50">
                      {addBusy ? '…' : 'Add'}
                    </button>
                  </td>
                </tr>

                {/* Existing product rows */}
                {products.map(p => (
                  <React.Fragment key={p.id}>
                    <tr className={`border-b border-outline-variant/10 ${expandedIds.has(p.id) ? 'bg-secondary/5' : 'hover:bg-surface-container/30'}`}>
                      <td className="px-sm py-sm text-center">
                        <button onClick={() => toggleExpand(p)}
                          className="text-secondary inline-flex items-center justify-center transition-transform duration-150"
                          style={{ transform: expandedIds.has(p.id) ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                          <span className="material-icons text-[16px]">chevron_right</span>
                        </button>
                      </td>
                      <td className="px-sm py-sm text-body-sm">{p.productType || '—'}</td>
                      <td className="px-sm py-sm font-mono text-xs text-on-surface-variant">{p.baseSku || '—'}</td>
                      <td className="px-sm py-sm bg-secondary/5">
                        {p.variant1Value
                          ? <><div className="text-[10px] text-on-surface-variant">{p.variant1Name}</div><div className="text-label-sm font-semibold text-secondary">{p.variant1Value}</div></>
                          : <span className="text-on-surface-variant text-xs">—</span>}
                      </td>
                      <td className="px-sm py-sm bg-secondary/5">
                        {p.variant2Value
                          ? <><div className="text-[10px] text-on-surface-variant">{p.variant2Name}</div><div className="text-label-sm font-semibold text-secondary">{p.variant2Value}</div></>
                          : <span className="text-on-surface-variant text-xs">—</span>}
                      </td>
                      <td className="px-sm py-sm font-mono text-xs">{p.sku}</td>
                      <td className="px-sm py-sm text-green-700 font-semibold text-body-sm">{p.currency} {p.baseCost.toFixed(2)}</td>
                      <td className="px-sm py-sm text-body-sm text-center">{usShippingDisplay(p)}</td>
                      <td className="px-sm py-sm text-center">
                        <button onClick={() => deleteOne(p)} className="text-error text-label-sm hover:opacity-70">✕</button>
                      </td>
                    </tr>
                    {expandedIds.has(p.id) && expandForms[p.id] && (
                      <tr>
                        <td colSpan={9} className="px-lg py-md bg-secondary/5 border-b border-secondary/20">
                          <div className="grid grid-cols-4 gap-md mb-sm">
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">Design Template URL</label>
                              <input className="w-full border rounded-lg px-sm py-xs text-body-sm" placeholder="https://drive.google.com/…"
                                value={expandForms[p.id].designTemplateUrl}
                                onChange={e => updateExpandForm(p.id, { designTemplateUrl: e.target.value })} />
                            </div>
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">Production days (min – max)</label>
                              <div className="flex items-center gap-xs">
                                <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" placeholder="3"
                                  value={expandForms[p.id].minProductionDays}
                                  onChange={e => updateExpandForm(p.id, { minProductionDays: e.target.value })} />
                                <span className="text-on-surface-variant">–</span>
                                <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" placeholder="7"
                                  value={expandForms[p.id].maxProductionDays}
                                  onChange={e => updateExpandForm(p.id, { maxProductionDays: e.target.value })} />
                              </div>
                            </div>
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">US Shipping (1st / add.)</label>
                              <div className="flex items-center gap-xs">
                                <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder="4.50"
                                  value={expandForms[p.id].usShipFirst}
                                  onChange={e => updateExpandForm(p.id, { usShipFirst: e.target.value })} />
                                <span className="text-on-surface-variant">/</span>
                                <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder="1.50"
                                  value={expandForms[p.id].usShipAdditional}
                                  onChange={e => updateExpandForm(p.id, { usShipAdditional: e.target.value })} />
                              </div>
                            </div>
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">EU Shipping (1st / add.)</label>
                              <div className="flex items-center gap-xs">
                                <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder="6.00"
                                  value={expandForms[p.id].euShipFirst}
                                  onChange={e => updateExpandForm(p.id, { euShipFirst: e.target.value })} />
                                <span className="text-on-surface-variant">/</span>
                                <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder="2.00"
                                  value={expandForms[p.id].euShipAdditional}
                                  onChange={e => updateExpandForm(p.id, { euShipAdditional: e.target.value })} />
                              </div>
                            </div>
                          </div>
                          <div className="grid grid-cols-4 gap-md">
                            <div>
                              <label className="text-label-sm text-on-surface-variant block mb-xs">Other regions (1st / add.)</label>
                              <div className="flex items-center gap-xs">
                                <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder="7.00"
                                  value={expandForms[p.id].rowShipFirst}
                                  onChange={e => updateExpandForm(p.id, { rowShipFirst: e.target.value })} />
                                <span className="text-on-surface-variant">/</span>
                                <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder="2.50"
                                  value={expandForms[p.id].rowShipAdditional}
                                  onChange={e => updateExpandForm(p.id, { rowShipAdditional: e.target.value })} />
                              </div>
                            </div>
                            <div /><div />
                            <div className="flex items-end justify-end gap-sm">
                              <button onClick={() => cancelExpand(p.id)} className="px-md py-xs rounded-lg border text-label-sm">Cancel</button>
                              <button onClick={() => saveExpanded(p)} disabled={savingIds.has(p.id)}
                                className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm disabled:opacity-50">
                                {savingIds.has(p.id) ? 'Saving…' : 'Save'}
                              </button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}

                {products.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-lg py-xl text-center text-on-surface-variant">
                      No products yet. Import a sheet or fill in the row above and click Add.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  )
}
