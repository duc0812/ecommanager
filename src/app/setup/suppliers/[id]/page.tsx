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
  textureOfMaterial: string | null
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
  textureOfMaterial?: string | null
}

type NewProductState = {
  productType: string
  productName: string
  baseSku: string
  designTemplateUrl: string
  textureOfMaterial: string
  opt1Name: string
  opt1Values: string[]
  opt2Name: string
  opt2Values: string[]
}

type GenRow = {
  tmpId: string
  sku: string
  variant1Name: string
  variant1Value: string
  variant2Name: string
  variant2Value: string
  baseCost: string
  usShipFirst: string
  usShipAdditional: string
}

type ExpandState = {
  baseCost: string
  minProductionDays: string
  maxProductionDays: string
  usShipFirst: string
  usShipAdditional: string
  caShipFirst: string
  caShipAdditional: string
  euShipFirst: string
  euShipAdditional: string
  rowShipFirst: string
  rowShipAdditional: string
}

const emptyNewProduct: NewProductState = {
  productType: '',
  productName: '',
  baseSku: '',
  designTemplateUrl: '',
  textureOfMaterial: '',
  opt1Name: '',
  opt1Values: [],
  opt2Name: '',
  opt2Values: [],
}

function makeSkuSegment(val: string): string {
  return val.toUpperCase().replace(/\s+/g, '-').replace(/[^A-Z0-9-]/g, '')
}

function autoSku(baseSku: string, v1: string, v2: string): string {
  return [baseSku, makeSkuSegment(v1), v2 ? makeSkuSegment(v2) : ''].filter(Boolean).join('-')
}

function computeVariants(v1s: string[], v2s: string[]): { tmpId: string; v1: string; v2: string }[] {
  if (v1s.length === 0) return []
  if (v2s.length === 0) return v1s.map(v1 => ({ tmpId: `v1:${v1}`, v1, v2: '' }))
  return v1s.flatMap(v1 => v2s.map(v2 => ({ tmpId: `v1:${v1}|v2:${v2}`, v1, v2 })))
}

const SIZE_ORDER = ['XS', 'S', 'M', 'L', 'XL', '2XL', '3XL', '4XL', '5XL', '6XL', '7XL', '8XL']

function variantSortValue(p: Product): string {
  const value = p.variant1Value || p.variant2Value || p.sku
  const normalized = value.toUpperCase().replace(/\s+/g, '')
  const sizeIndex = SIZE_ORDER.indexOf(normalized)
  return `${sizeIndex >= 0 ? sizeIndex.toString().padStart(2, '0') : '99'}|${normalized}|${p.sku}`
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
    baseCost: p.baseCost.toString(),
    minProductionDays: p.minProductionDays?.toString() ?? '',
    maxProductionDays: p.maxProductionDays?.toString() ?? '',
    usShipFirst: s.US?.first?.toString() ?? '',
    usShipAdditional: s.US?.additional?.toString() ?? '',
    caShipFirst: s.CA?.first?.toString() ?? '',
    caShipAdditional: s.CA?.additional?.toString() ?? '',
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
  const [addPanelOpen, setAddPanelOpen] = useState(false)
  const [newProduct, setNewProduct] = useState<NewProductState>({ ...emptyNewProduct })
  const [opt1Input, setOpt1Input] = useState('')
  const [opt2Input, setOpt2Input] = useState('')
  const [genRows, setGenRows] = useState<GenRow[]>([])
  const [addBusy, setAddBusy] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
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

  // Recompute generated rows when variant options or base SKU change; preserve existing row data
  const { opt1Name, opt1Values, opt2Name, opt2Values, baseSku: npBaseSku } = newProduct
  const opt1Key = opt1Values.join(' ')
  const opt2Key = opt2Values.join(' ')
  useEffect(() => {
    const variants = computeVariants(opt1Values, opt2Values)
    setGenRows(prev => {
      const prevMap = new Map(prev.map(r => [r.tmpId, r]))
      return variants.map(v => {
        const ex = prevMap.get(v.tmpId)
        return ex
          ? { ...ex, variant1Name: opt1Name || 'Option 1', variant2Name: opt2Name || '' }
          : {
              tmpId: v.tmpId,
              sku: autoSku(npBaseSku, v.v1, v.v2),
              variant1Name: opt1Name || 'Option 1',
              variant1Value: v.v1,
              variant2Name: opt2Name || '',
              variant2Value: v.v2,
              baseCost: '',
              usShipFirst: '',
              usShipAdditional: '',
            }
      })
    })
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opt1Name, opt1Key, opt2Name, opt2Key, npBaseSku])

  const commitNewProduct = async () => {
    if (genRows.length === 0) { alert('Add variant values first (e.g. S, M, L)'); return }
    const rows = genRows.filter(r => r.sku.trim())
    if (rows.length === 0) { alert('All rows need a SKU'); return }
    setAddBusy(true)
    const importRows: ImportRow[] = rows.map(r => ({
      sku: r.sku.trim(),
      baseCost: num(r.baseCost),
      productType: newProduct.productType || null,
      productName: newProduct.productName || newProduct.productType || undefined,
      baseSku: newProduct.baseSku || null,
      variant1Name: r.variant1Name || null,
      variant1Value: r.variant1Value || null,
      variant2Name: r.variant2Name || null,
      variant2Value: r.variant2Value || null,
      designTemplateUrl: newProduct.designTemplateUrl || null,
      textureOfMaterial: newProduct.textureOfMaterial || null,
      shippingByRegion: buildShipping({ US: { first: r.usShipFirst, additional: r.usShipAdditional } }),
    }))
    const res = await fetch('/api/suppliers/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId, rows: importRows }),
    })
    if (res.ok) { setNewProduct({ ...emptyNewProduct }); setAddPanelOpen(false); await loadProducts() }
    setAddBusy(false)
  }

  const updateGenRow = (tmpId: string, patch: Partial<GenRow>) =>
    setGenRows(rs => rs.map(r => r.tmpId === tmpId ? { ...r, ...patch } : r))

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
    // Start from existing shipping data to preserve GB/CA and any other imported regions
    let existingShipping: Record<string, { first: number; additional: number; importTax?: number }> = {}
    try { if (p.shippingByRegion) existingShipping = JSON.parse(p.shippingByRegion) } catch {}
    const formZones: Record<string, { first: string; additional: string }> = {
      US: { first: es.usShipFirst, additional: es.usShipAdditional },
      CA: { first: es.caShipFirst, additional: es.caShipAdditional },
      EU: { first: es.euShipFirst, additional: es.euShipAdditional },
      ROW: { first: es.rowShipFirst, additional: es.rowShipAdditional },
    }
    const merged = { ...existingShipping }
    for (const [zone, { first, additional }] of Object.entries(formZones)) {
      if (first || additional) {
        merged[zone] = { first: num(first), additional: num(additional) }
      } else {
        delete merged[zone]
      }
    }
    const shippingByRegion = Object.keys(merged).length > 0 ? JSON.stringify(merged) : null
    const body = {
      baseCost: num(es.baseCost),
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

        {/* Add product panel */}
        {addPanelOpen && (
          <div className="bg-surface-container-lowest rounded-lg border border-secondary/30 p-lg mb-md">
            <div className="flex items-center justify-between mb-md">
              <div className="text-title-md font-semibold">Add product variants</div>
              <button onClick={() => { setAddPanelOpen(false); setNewProduct({ ...emptyNewProduct }) }}
                className="text-on-surface-variant hover:text-on-surface text-lg leading-none">✕</button>
            </div>

            {/* Product info */}
            <div className="grid grid-cols-3 gap-md mb-sm">
              <div>
                <label className="text-label-sm text-on-surface-variant block mb-xs">Product type</label>
                <input className="w-full border rounded-lg px-sm py-xs text-body-sm" placeholder="3D Clothing"
                  value={newProduct.productType} onChange={e => setNewProduct(p => ({ ...p, productType: e.target.value }))} />
              </div>
              <div>
                <label className="text-label-sm text-on-surface-variant block mb-xs">Product name</label>
                <input className="w-full border rounded-lg px-sm py-xs text-body-sm" placeholder="Fit Hawaii Shirt"
                  value={newProduct.productName} onChange={e => setNewProduct(p => ({ ...p, productName: e.target.value }))} />
              </div>
              <div>
                <label className="text-label-sm text-on-surface-variant block mb-xs">Base SKU</label>
                <input className="w-full border rounded-lg px-sm py-xs text-body-sm font-mono" placeholder="TX"
                  value={newProduct.baseSku} onChange={e => setNewProduct(p => ({ ...p, baseSku: e.target.value }))} />
              </div>
            </div>
            <div className="grid grid-cols-2 gap-md mb-lg">
              <div>
                <label className="text-label-sm text-on-surface-variant block mb-xs">Design Template URL <span className="text-[10px] font-normal">(applied to all variants)</span></label>
                <input className="w-full border rounded-lg px-sm py-xs text-body-sm" placeholder="https://drive.google.com/…"
                  value={newProduct.designTemplateUrl} onChange={e => setNewProduct(p => ({ ...p, designTemplateUrl: e.target.value }))} />
              </div>
              <div>
                <label className="text-label-sm text-on-surface-variant block mb-xs">Texture of material</label>
                <input className="w-full border rounded-lg px-sm py-xs text-body-sm" placeholder="e.g. Cotton, Polyester, Canvas"
                  value={newProduct.textureOfMaterial} onChange={e => setNewProduct(p => ({ ...p, textureOfMaterial: e.target.value }))} />
              </div>
            </div>

            {/* Variant options */}
            <div className="mb-lg">
              <div className="text-label-md font-semibold mb-sm">Variant options</div>
              <div className="space-y-sm">
                {/* Option 1 */}
                <div className="flex items-center gap-md">
                  <div className="text-label-sm text-on-surface-variant w-20 shrink-0">Option 1</div>
                  <input className="w-28 border rounded-lg px-sm py-xs text-body-sm" placeholder="Size"
                    value={newProduct.opt1Name} onChange={e => setNewProduct(p => ({ ...p, opt1Name: e.target.value }))} />
                  <div className="flex-1 border rounded-lg px-sm py-[6px] flex flex-wrap gap-xs items-center min-h-[34px] cursor-text"
                    onClick={e => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
                    {newProduct.opt1Values.map(v => (
                      <span key={v} className="inline-flex items-center gap-xs bg-secondary/10 text-secondary px-xs py-[2px] rounded text-xs font-medium">
                        {v}
                        <button type="button" className="hover:text-error leading-none"
                          onClick={e => { e.stopPropagation(); setNewProduct(p => ({ ...p, opt1Values: p.opt1Values.filter(x => x !== v) })) }}>×</button>
                      </span>
                    ))}
                    <input
                      className="flex-1 min-w-[80px] outline-none text-body-sm bg-transparent"
                      placeholder={newProduct.opt1Values.length === 0 ? 'Type S, M, L… then press Enter' : 'Add more…'}
                      value={opt1Input}
                      onChange={e => setOpt1Input(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault()
                          const vals = opt1Input.split(',').map(v => v.trim()).filter(v => v && !newProduct.opt1Values.includes(v))
                          if (vals.length) setNewProduct(p => ({ ...p, opt1Values: [...p.opt1Values, ...vals] }))
                          setOpt1Input('')
                        } else if (e.key === 'Backspace' && !opt1Input && newProduct.opt1Values.length > 0) {
                          setNewProduct(p => ({ ...p, opt1Values: p.opt1Values.slice(0, -1) }))
                        }
                      }}
                      onBlur={() => {
                        const vals = opt1Input.split(',').map(v => v.trim()).filter(v => v && !newProduct.opt1Values.includes(v))
                        if (vals.length) setNewProduct(p => ({ ...p, opt1Values: [...p.opt1Values, ...vals] }))
                        setOpt1Input('')
                      }}
                    />
                  </div>
                </div>
                {/* Option 2 */}
                <div className="flex items-center gap-md">
                  <div className="text-label-sm text-on-surface-variant w-20 shrink-0">Option 2 <span className="text-[10px]">(opt)</span></div>
                  <input className="w-28 border rounded-lg px-sm py-xs text-body-sm" placeholder="Color"
                    value={newProduct.opt2Name} onChange={e => setNewProduct(p => ({ ...p, opt2Name: e.target.value }))} />
                  <div className="flex-1 border rounded-lg px-sm py-[6px] flex flex-wrap gap-xs items-center min-h-[34px] cursor-text"
                    onClick={e => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
                    {newProduct.opt2Values.map(v => (
                      <span key={v} className="inline-flex items-center gap-xs bg-secondary/10 text-secondary px-xs py-[2px] rounded text-xs font-medium">
                        {v}
                        <button type="button" className="hover:text-error leading-none"
                          onClick={e => { e.stopPropagation(); setNewProduct(p => ({ ...p, opt2Values: p.opt2Values.filter(x => x !== v) })) }}>×</button>
                      </span>
                    ))}
                    <input
                      className="flex-1 min-w-[80px] outline-none text-body-sm bg-transparent"
                      placeholder={newProduct.opt2Values.length === 0 ? 'Type Red, Blue… then press Enter' : 'Add more…'}
                      value={opt2Input}
                      onChange={e => setOpt2Input(e.target.value)}
                      onKeyDown={e => {
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault()
                          const vals = opt2Input.split(',').map(v => v.trim()).filter(v => v && !newProduct.opt2Values.includes(v))
                          if (vals.length) setNewProduct(p => ({ ...p, opt2Values: [...p.opt2Values, ...vals] }))
                          setOpt2Input('')
                        } else if (e.key === 'Backspace' && !opt2Input && newProduct.opt2Values.length > 0) {
                          setNewProduct(p => ({ ...p, opt2Values: p.opt2Values.slice(0, -1) }))
                        }
                      }}
                      onBlur={() => {
                        const vals = opt2Input.split(',').map(v => v.trim()).filter(v => v && !newProduct.opt2Values.includes(v))
                        if (vals.length) setNewProduct(p => ({ ...p, opt2Values: [...p.opt2Values, ...vals] }))
                        setOpt2Input('')
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>

            {/* Generated rows */}
            {genRows.length > 0 && (
              <div>
                <div className="text-label-md font-semibold mb-sm">{genRows.length} variant{genRows.length !== 1 ? 's' : ''} generated</div>
                <div className="border rounded-lg overflow-hidden mb-md">
                  <table className="w-full text-label-sm border-collapse">
                    <thead className="bg-surface-container text-left">
                      <tr>
                        <th className="px-sm py-xs text-on-surface-variant font-semibold">SKU variant</th>
                        <th className="px-sm py-xs text-on-surface-variant font-semibold bg-secondary/5">Variant 1</th>
                        {newProduct.opt2Values.length > 0 && <th className="px-sm py-xs text-on-surface-variant font-semibold bg-secondary/5">Variant 2</th>}
                        <th className="px-sm py-xs text-on-surface-variant font-semibold">Base cost</th>
                        <th className="px-sm py-xs text-on-surface-variant font-semibold text-center">US Ship (1st / add.)</th>
                      </tr>
                    </thead>
                    <tbody>
                      {genRows.map((row, i) => (
                        <tr key={row.tmpId} className={`border-t border-outline-variant/10 ${i % 2 === 1 ? 'bg-surface-container/30' : ''}`}>
                          <td className="px-sm py-xs">
                            <input className="w-40 border rounded px-xs py-[3px] font-mono text-xs"
                              value={row.sku} onChange={e => updateGenRow(row.tmpId, { sku: e.target.value })} />
                          </td>
                          <td className="px-sm py-xs bg-secondary/5">
                            <div className="text-[10px] text-on-surface-variant">{row.variant1Name}</div>
                            <div className="text-label-sm font-semibold text-secondary">{row.variant1Value}</div>
                          </td>
                          {newProduct.opt2Values.length > 0 && (
                            <td className="px-sm py-xs bg-secondary/5">
                              <div className="text-[10px] text-on-surface-variant">{row.variant2Name}</div>
                              <div className="text-label-sm font-semibold text-secondary">{row.variant2Value}</div>
                            </td>
                          )}
                          <td className="px-sm py-xs">
                            <input className="w-20 border rounded px-xs py-[3px] text-xs" type="number" step="0.01" placeholder="10.00"
                              value={row.baseCost} onChange={e => updateGenRow(row.tmpId, { baseCost: e.target.value })} />
                          </td>
                          <td className="px-sm py-xs">
                            <div className="flex gap-xs items-center justify-center">
                              <input className="w-14 border rounded px-xs py-[3px] text-xs text-center" type="number" step="0.01" placeholder="4.50"
                                value={row.usShipFirst} onChange={e => updateGenRow(row.tmpId, { usShipFirst: e.target.value })} />
                              <span className="text-on-surface-variant text-xs">/</span>
                              <input className="w-14 border rounded px-xs py-[3px] text-xs text-center" type="number" step="0.01" placeholder="1.50"
                                value={row.usShipAdditional} onChange={e => updateGenRow(row.tmpId, { usShipAdditional: e.target.value })} />
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="flex justify-end gap-sm">
                  <button onClick={() => { setAddPanelOpen(false); setNewProduct({ ...emptyNewProduct }) }}
                    className="px-md py-xs rounded-lg border text-label-sm">Cancel</button>
                  <button onClick={commitNewProduct} disabled={addBusy}
                    className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm font-semibold disabled:opacity-50">
                    {addBusy ? 'Saving…' : `Save ${genRows.length} variant${genRows.length !== 1 ? 's' : ''}`}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Product setup table */}
        <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 overflow-hidden">
          <div className="px-lg py-md border-b border-outline-variant/20 flex items-center justify-between">
            <div>
              <div className="text-title-md font-semibold">Product setup</div>
              <div className="text-label-sm text-on-surface-variant mt-xs">Mỗi dòng là một supplier SKU variant</div>
            </div>
            <div className="flex items-center gap-sm">
              <input placeholder="Search SKU or product" value={search} onChange={e => setSearch(e.target.value)}
                className="border rounded-lg px-md py-sm text-body-sm w-[260px]" />
              <button onClick={() => setAddPanelOpen(v => !v)}
                className="bg-secondary text-on-secondary px-md py-sm rounded-lg text-label-sm font-semibold whitespace-nowrap">
                + Add product
              </button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-label-sm border-collapse">
              <thead className="bg-surface-container text-left">
                <tr>
                  <th className="w-8 px-sm py-xs" />
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">Product type</th>
                  <th className="px-sm py-xs text-on-surface-variant font-semibold">Product name</th>
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
                {/* Existing product rows — grouped by product type */}
                {Object.entries(
                  products.reduce<Record<string, Product[]>>((acc, p) => {
                    const key = p.productType || '(no type)'
                    acc[key] = acc[key] || []
                    acc[key].push(p)
                    return acc
                  }, {})
                ).sort(([a], [b]) => a.localeCompare(b)).map(([groupName, groupProducts]) => (
                  <React.Fragment key={groupName}>
                    <tr className="bg-secondary/10 border-b border-secondary/20 cursor-pointer select-none hover:bg-secondary/15"
                      onClick={() => setCollapsedGroups(prev => {
                        const next = new Set(prev)
                        if (next.has(groupName)) next.delete(groupName)
                        else next.add(groupName)
                        return next
                      })}>
                      <td colSpan={10} className="px-sm py-xs">
                        <div className="flex items-center gap-xs">
                          <svg viewBox="0 0 24 24" fill="currentColor"
                            className="w-4 h-4 text-secondary transition-transform duration-150 flex-shrink-0"
                            style={{ transform: collapsedGroups.has(groupName) ? 'rotate(0deg)' : 'rotate(90deg)' }}>
                            <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                          </svg>
                          <span className="text-label-sm font-semibold text-secondary">{groupName}</span>
                          <span className="text-[11px] text-on-surface-variant font-normal ml-xs">{groupProducts.length} variant{groupProducts.length !== 1 ? 's' : ''}</span>
                        </div>
                      </td>
                    </tr>
                    {!collapsedGroups.has(groupName) && [...groupProducts].sort((a, b) => {
                      const productNameCompare = (a.productName || '').localeCompare(b.productName || '')
                      if (productNameCompare !== 0) return productNameCompare
                      return variantSortValue(a).localeCompare(variantSortValue(b))
                    }).map(p => (
                      <React.Fragment key={p.id}>
                        <tr className={`border-b border-outline-variant/10 ${expandedIds.has(p.id) ? 'bg-secondary/5' : 'hover:bg-surface-container/30'}`}>
                          <td className="px-sm py-sm text-center">
                            <button onClick={() => toggleExpand(p)}
                              className="text-secondary inline-flex items-center justify-center transition-transform duration-150"
                              style={{ transform: expandedIds.has(p.id) ? 'rotate(90deg)' : 'rotate(0deg)' }}>
                              <svg viewBox="0 0 24 24" fill="currentColor" className="w-4 h-4">
                                <path d="M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z" />
                              </svg>
                            </button>
                          </td>
                          <td className="px-sm py-sm text-body-sm text-on-surface-variant">{p.productType || '—'}</td>
                          <td className="px-sm py-sm text-body-sm font-medium">{p.productName || 'â€”'}</td>
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
                            <td colSpan={10} className="px-lg py-md bg-secondary/5 border-b border-secondary/20">
                              {/* Row 1: shipping by region */}
                              <div className="grid grid-cols-4 gap-md mb-sm">
                                {[
                                  { label: 'US Shipping (1st / add.)', f: 'usShipFirst' as const, a: 'usShipAdditional' as const, pf: '4.50', pa: '1.50' },
                                  { label: 'CA Shipping (1st / add.)', f: 'caShipFirst' as const, a: 'caShipAdditional' as const, pf: '5.00', pa: '2.00' },
                                  { label: 'EU Shipping (1st / add.)', f: 'euShipFirst' as const, a: 'euShipAdditional' as const, pf: '6.00', pa: '2.00' },
                                  { label: 'Other regions (1st / add.)', f: 'rowShipFirst' as const, a: 'rowShipAdditional' as const, pf: '7.00', pa: '2.50' },
                                ].map(({ label, f, a, pf, pa }) => (
                                  <div key={f}>
                                    <label className="text-label-sm text-on-surface-variant block mb-xs">{label}</label>
                                    <div className="flex items-center gap-xs">
                                      <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder={pf}
                                        value={expandForms[p.id][f]}
                                        onChange={e => updateExpandForm(p.id, { [f]: e.target.value })} />
                                      <span className="text-on-surface-variant">/</span>
                                      <input className="w-16 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder={pa}
                                        value={expandForms[p.id][a]}
                                        onChange={e => updateExpandForm(p.id, { [a]: e.target.value })} />
                                    </div>
                                  </div>
                                ))}
                              </div>
                              {/* Row 2: base cost + production days + save */}
                              <div className="grid grid-cols-4 gap-md">
                                <div>
                                  <label className="text-label-sm text-on-surface-variant block mb-xs">Base cost</label>
                                  <input className="w-24 border rounded-lg px-sm py-xs text-body-sm text-center" type="number" step="0.01" placeholder="10.00"
                                    value={expandForms[p.id].baseCost}
                                    onChange={e => updateExpandForm(p.id, { baseCost: e.target.value })} />
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
                                <div />
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
                  </React.Fragment>
                ))}

                {products.length === 0 && (
                  <tr>
                    <td colSpan={10} className="px-lg py-xl text-center text-on-surface-variant">
                      No products yet. Import a sheet or click Add product to add variants.
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

