'use client'
import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import * as XLSX from 'xlsx'
import Sidebar from '@/components/Sidebar'
import { parseCsv } from '@/lib/csv-parser'

type Supplier = { id: string; name: string; code: string; currency: string }
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
  supplier: { id: string; name: string; code: string; currency: string }
}

type ImportRow = {
  supplierName?: string | null
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

type ManualRow = {
  supplierName: string
  productType: string
  baseSku: string
  variant1Name: string
  variant1Value: string
  variant2Name: string
  variant2Value: string
  sku: string
  baseCost: string
  usImportTax: string
  usShipFirst: string
  usShipAdditional: string
  designTemplateUrl: string
  minProductionDays: string
  maxProductionDays: string
}

const emptyManualRow: ManualRow = {
  supplierName: '',
  productType: '',
  baseSku: '',
  variant1Name: '',
  variant1Value: '',
  variant2Name: '',
  variant2Value: '',
  sku: '',
  baseCost: '',
  usImportTax: '',
  usShipFirst: '',
  usShipAdditional: '',
  designTemplateUrl: '',
  minProductionDays: '',
  maxProductionDays: '',
}

function num(v: unknown): number {
  if (!v) return 0
  const n = parseFloat(v.toString().replace(/[$,\s]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function buildShippingByRegion(r: Record<string, unknown>): string | null {
  const obj: Record<string, { first: number; additional: number; importTax?: number }> = {}
  const usFirst = r['US shipping fee (1st item)']
  const usAdditional = r['US additional shipping fee']
  const usTax = r['US import Tax/item']
  if (usFirst !== undefined || usAdditional !== undefined || usTax !== undefined) {
    obj.US = { first: num(usFirst), additional: num(usAdditional) }
    if (num(usTax) > 0) obj.US.importTax = num(usTax)
  }
  for (const zone of ['EU', 'GB', 'CA', 'ROW']) {
    const f = r[`${zone} shipping fee (1st item)`]
    const a = r[`${zone} additional shipping fee`]
    if (f !== undefined || a !== undefined) {
      obj[zone] = { first: num(f), additional: num(a) }
    }
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
    headers.forEach((header, index) => {
      if (header) obj[header] = String(row[index] ?? '').trim()
    })
    return obj
  })
}

function rowsToImportRows(rows: Record<string, unknown>[]): ImportRow[] {
  return rows.map(r => {
    const sku = String(r['SKU variant'] ?? r.sku ?? '').trim()
    const baseCost = num(r['Base cost ($)'] ?? r['Tier 1 (0 - 999)'] ?? r.baseCost ?? r.basecost ?? '0')
    const minProd = r['Min production time']
    const maxProd = r['Max production time']
    return {
      supplierName: String(r['SUPPLIER NAME'] ?? r['Supplier Name'] ?? r.supplierName ?? r.supplier ?? '').trim() || null,
      sku,
      baseCost,
      productName: String(r.productName ?? r['Product type'] ?? r['Product Title'] ?? '').trim() || undefined,
      requiresDesign: ['1', 'true', 'TRUE', 'yes', 'YES'].includes(String(r.requiresDesign ?? r.requiresdesign ?? '').trim()),
      baseSku: String(r['SKU product'] ?? '').trim() || null,
      productType: String(r['Product type'] ?? r['Product Title'] ?? '').trim() || null,
      variant1Name: String(r['Variant 1 Name'] ?? '').trim() || (String(r['SIZES'] ?? '').trim() ? 'Size' : null),
      variant1Value: String(r['Variant 1 Value'] ?? r['SIZES'] ?? '').trim() || null,
      variant2Name: String(r['Variant 2 Name'] ?? '').trim() || null,
      variant2Value: String(r['Variant 2 Value'] ?? '').trim() || null,
      designTemplateUrl: String(r['Design Template'] ?? '').trim() || null,
      minProductionDays: minProd ? parseInt(String(minProd), 10) : null,
      maxProductionDays: maxProd ? parseInt(String(maxProd), 10) : null,
      shippingByRegion: buildShippingByRegion(r),
    }
  }).filter(r => r.sku)
}

function ProductsPageContent() {
  const searchParams = useSearchParams()
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState<string>('')
  const [search, setSearch] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [form, setForm] = useState({ sku: '', baseCost: '', productName: '' })
  const [manualRows, setManualRows] = useState<ManualRow[]>([{ ...emptyManualRow }])
  const [importPreview, setImportPreview] = useState<ImportRow[] | null>(null)
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: any[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editForm, setEditForm] = useState<any>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? []))
  }, [])

  useEffect(() => {
    const fromQuery = searchParams.get('supplierId')
    if (fromQuery) setSupplierId(fromQuery)
  }, [searchParams])

  const load = useCallback(async () => {
    const q = new URLSearchParams()
    if (supplierId) q.set('supplierId', supplierId)
    if (search) q.set('search', search)
    const r = await fetch('/api/suppliers/products?' + q.toString())
    const d = await r.json()
    setProducts(d.products ?? []); setTotal(d.total ?? 0)
  }, [supplierId, search])
  useEffect(() => { load() }, [load])

  const addOne = async () => {
    if (!supplierId) { alert('Pick a supplier first'); return }
    if (!form.sku || !form.baseCost) { alert('SKU + baseCost required'); return }
    const requiresDesign = (document.getElementById('add-requires-design') as HTMLInputElement | null)?.checked ?? false
    setBusy(true)
    await fetch('/api/suppliers/products', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        supplierId, sku: form.sku, baseCost: Number(form.baseCost),
        productName: form.productName || null,
        requiresDesign,
      }),
    })
    setForm({ sku: '', baseCost: '', productName: '' })
    const cb = document.getElementById('add-requires-design') as HTMLInputElement | null
    if (cb) cb.checked = false
    setBusy(false); await load()
  }

  const openEdit = (p: Product) => {
    let ship: any = {}
    try { if (p.shippingByRegion) ship = JSON.parse(p.shippingByRegion) } catch {}
    setEditingId(p.id)
    setEditForm({
      sku: p.sku,
      baseCost: p.baseCost,
      productName: p.productName ?? '',
      currency: p.currency,
      requiresDesign: p.requiresDesign,
      baseSku: p.baseSku ?? '',
      productType: p.productType ?? '',
      variant1Name: p.variant1Name ?? '',
      variant1Value: p.variant1Value ?? '',
      variant2Name: p.variant2Name ?? '',
      variant2Value: p.variant2Value ?? '',
      designTemplateUrl: p.designTemplateUrl ?? '',
      minProductionDays: p.minProductionDays ?? '',
      maxProductionDays: p.maxProductionDays ?? '',
      shipping: ship,
    })
  }

  const saveEdit = async () => {
    if (!editingId || !editForm) return
    const shippingByRegion = Object.keys(editForm.shipping).length > 0 ? JSON.stringify(editForm.shipping) : null
    const body = {
      baseCost: Number(editForm.baseCost),
      productName: editForm.productName || null,
      currency: editForm.currency,
      requiresDesign: editForm.requiresDesign,
      baseSku: editForm.baseSku || null,
      productType: editForm.productType || null,
      variant1Name: editForm.variant1Name || null,
      variant1Value: editForm.variant1Value || null,
      variant2Name: editForm.variant2Name || null,
      variant2Value: editForm.variant2Value || null,
      designTemplateUrl: editForm.designTemplateUrl || null,
      minProductionDays: editForm.minProductionDays === '' ? null : Number(editForm.minProductionDays),
      maxProductionDays: editForm.maxProductionDays === '' ? null : Number(editForm.maxProductionDays),
      shippingByRegion,
    }
    await fetch(`/api/suppliers/products/${editingId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    setEditingId(null); setEditForm(null); await load()
  }

  const deleteOne = async (p: Product) => {
    if (!confirm(`Delete mapping ${p.sku} → ${p.supplier.name}?`)) return
    await fetch(`/api/suppliers/products/${p.id}`, { method: 'DELETE' })
    await load()
  }

  const onFilePick = async (file: File) => {
    const isExcel = /\.(xlsx|xls)$/i.test(file.name)
    const rows = isExcel
      ? parseExcelRows(await file.arrayBuffer())
      : parseCsv(await file.text())
    const parsed = rowsToImportRows(rows)
    setImportPreview(parsed); setImportResult(null)
  }

  const updateManualRow = (index: number, patch: Partial<ManualRow>) => {
    setManualRows(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row))
  }

  const addManualRow = () => {
    const selectedSupplier = suppliers.find(s => s.id === supplierId)
    setManualRows(rows => [...rows, { ...emptyManualRow, supplierName: selectedSupplier?.name ?? '' }])
  }

  const manualRowsToImport = (): ImportRow[] => {
    const fallbackSupplier = suppliers.find(s => s.id === supplierId)?.name ?? ''
    return manualRows.map(r => ({
      supplierName: r.supplierName || fallbackSupplier || null,
      sku: r.sku.trim(),
      baseCost: num(r.baseCost),
      productName: r.productType || undefined,
      baseSku: r.baseSku || null,
      productType: r.productType || null,
      variant1Name: r.variant1Name || null,
      variant1Value: r.variant1Value || null,
      variant2Name: r.variant2Name || null,
      variant2Value: r.variant2Value || null,
      designTemplateUrl: r.designTemplateUrl || null,
      minProductionDays: r.minProductionDays ? parseInt(r.minProductionDays, 10) : null,
      maxProductionDays: r.maxProductionDays ? parseInt(r.maxProductionDays, 10) : null,
      shippingByRegion: buildShippingByRegion({
        'US import Tax/item': r.usImportTax,
        'US shipping fee (1st item)': r.usShipFirst,
        'US additional shipping fee': r.usShipAdditional,
      }),
    })).filter(r => r.sku)
  }

  const previewManualRows = () => {
    const rows = manualRowsToImport()
    if (rows.length === 0) { alert('Enter at least one row with SKU variant'); return }
    setImportPreview(rows)
    setImportResult(null)
  }

  const commitImport = async () => {
    if (!importPreview) return
    setBusy(true)
    const r = await fetch('/api/suppliers/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId: supplierId || undefined, rows: importPreview }),
    })
    const result = await r.json()
    setImportResult(result); setBusy(false); setImportPreview(null)
    if (fileRef.current) fileRef.current.value = ''
    await load()
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <h1 className="text-display-md mb-lg">Product Mapping</h1>

        {/* Filter bar */}
        <div className="flex items-center gap-md mb-md">
          <select value={supplierId} onChange={e => setSupplierId(e.target.value)} className="border rounded-lg px-md py-sm text-body-sm">
            <option value="">All suppliers</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <input
            placeholder="Search SKU or name"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="border rounded-lg px-md py-sm text-body-sm flex-1"
          />
          <span className="text-body-sm text-on-surface-variant">{total} mapping(s)</span>
        </div>

        {/* Add + Import */}
        <div className="bg-surface-container-lowest rounded-xl p-lg shadow-card border border-outline-variant/20 mb-lg">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-lg">
            <div>
              <h2 className="text-headline-sm mb-md">Add single mapping</h2>
              <div className="flex flex-col gap-sm">
                <input placeholder="SKU" value={form.sku} onChange={e => setForm({ ...form, sku: e.target.value })} className="border rounded-lg px-sm py-xs" />
                <input placeholder="Base cost (USD)" type="number" step="0.01" value={form.baseCost} onChange={e => setForm({ ...form, baseCost: e.target.value })} className="border rounded-lg px-sm py-xs" />
                <input placeholder="Product name (optional)" value={form.productName} onChange={e => setForm({ ...form, productName: e.target.value })} className="border rounded-lg px-sm py-xs" />
                <label className="flex items-center gap-sm text-body-sm">
                  <input type="checkbox" id="add-requires-design" />
                  Custom design product (needs design approval)
                </label>
                <button onClick={addOne} disabled={busy || !supplierId} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50 w-fit">
                  Add to selected supplier
                </button>
              </div>
            </div>
            <div>
              <h2 className="text-headline-sm mb-md">Import supplier SKU sheet</h2>
              <p className="text-body-sm text-on-surface-variant mb-sm">
                Accepts the supplier Excel sheet format with <code>SUPPLIER NAME</code>, <code>Product type</code>, <code>SKU product</code>, <code>SIZES</code>, <code>SKU variant</code>, base cost, shipping fees, design template, production time.
                If a supplier is selected above, rows import into that supplier; otherwise each row uses its Supplier Name.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv,text/csv"
                onChange={e => e.target.files?.[0] && onFilePick(e.target.files[0])}
                disabled={!supplierId}
                className="text-body-sm"
              />
              {importPreview && (
                <div className="mt-sm">
                  <p className="text-body-sm">Preview: {importPreview.length} row(s) parsed.</p>
                  <button onClick={commitImport} disabled={busy} className="mt-sm bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
                    {busy ? 'Importing…' : `Commit ${importPreview.length} mapping(s)`}
                  </button>
                </div>
              )}
              {importResult && (
                <div className="mt-sm text-body-sm">
                  Created: {importResult.created}, Updated: {importResult.updated}
                  {importResult.errors.length > 0 && (
                    <p className="text-error">
                      {importResult.errors.length} error(s) — see console
                    </p>
                  )}
                  {importResult.errors.length > 0 && (() => { console.warn('CSV import errors:', importResult.errors); return null })()}
                </div>
              )}
            </div>
          </div>

          <div className="mt-lg border-t border-outline-variant/20 pt-lg">
            <div className="flex items-center justify-between mb-md">
              <h2 className="text-headline-sm">Manual sheet entry</h2>
              <div className="flex gap-sm">
                <button onClick={addManualRow} className="px-md py-xs rounded-lg border text-label-sm">Add row</button>
                <button onClick={previewManualRows} className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm">Preview manual rows</button>
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="min-w-[1500px] w-full text-label-sm">
                <thead className="bg-surface-container">
                  <tr className="text-left">
                    {['SUPPLIER NAME', 'Product type', 'SKU product', 'Variant 1 Name', 'Variant 1 Value', 'Variant 2 Name', 'Variant 2 Value', 'SKU variant', 'Base cost ($)', 'US import Tax/item', 'US shipping fee (1st item)', 'US additional shipping fee', 'Design Template', 'Min production time', 'Max production time', ''].map(h => (
                      <th key={h} className="px-sm py-xs">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {manualRows.map((row, index) => (
                    <tr key={index} className="border-t border-outline-variant/20">
                      <td className="px-sm py-xs"><input className="w-40 border rounded px-xs py-[3px]" value={row.supplierName} onChange={e => updateManualRow(index, { supplierName: e.target.value })} placeholder={suppliers.find(s => s.id === supplierId)?.name ?? 'Supplier'} /></td>
                      <td className="px-sm py-xs"><input className="w-40 border rounded px-xs py-[3px]" value={row.productType} onChange={e => updateManualRow(index, { productType: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-28 border rounded px-xs py-[3px] font-mono" value={row.baseSku} onChange={e => updateManualRow(index, { baseSku: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" placeholder="Size" value={row.variant1Name} onChange={e => updateManualRow(index, { variant1Name: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" placeholder="XL" value={row.variant1Value} onChange={e => updateManualRow(index, { variant1Value: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" placeholder="Color" value={row.variant2Name} onChange={e => updateManualRow(index, { variant2Name: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" placeholder="Black" value={row.variant2Value} onChange={e => updateManualRow(index, { variant2Value: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-40 border rounded px-xs py-[3px] font-mono" value={row.sku} onChange={e => updateManualRow(index, { sku: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" type="number" step="0.01" value={row.baseCost} onChange={e => updateManualRow(index, { baseCost: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" type="number" step="0.01" value={row.usImportTax} onChange={e => updateManualRow(index, { usImportTax: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" type="number" step="0.01" value={row.usShipFirst} onChange={e => updateManualRow(index, { usShipFirst: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" type="number" step="0.01" value={row.usShipAdditional} onChange={e => updateManualRow(index, { usShipAdditional: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-56 border rounded px-xs py-[3px]" value={row.designTemplateUrl} onChange={e => updateManualRow(index, { designTemplateUrl: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" type="number" value={row.minProductionDays} onChange={e => updateManualRow(index, { minProductionDays: e.target.value })} /></td>
                      <td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" type="number" value={row.maxProductionDays} onChange={e => updateManualRow(index, { maxProductionDays: e.target.value })} /></td>
                      <td className="px-sm py-xs">
                        {manualRows.length > 1 && (
                          <button onClick={() => setManualRows(rows => rows.filter((_, i) => i !== index))} className="text-error">Remove</button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Table */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="px-md py-sm">SKU</th>
                <th className="px-md py-sm">Product / Type</th>
                <th className="px-md py-sm">Supplier</th>
                <th className="px-md py-sm text-right">Base cost</th>
                <th className="px-md py-sm">Variant 1</th>
                <th className="px-md py-sm">Variant 2</th>
                <th className="px-md py-sm">Shipping</th>
                <th className="px-md py-sm">Custom?</th>
                <th className="px-md py-sm">Updated</th>
                <th className="px-md py-sm"></th>
              </tr>
            </thead>
            <tbody>
              {products.map(p => (
                <tr key={p.id} className="border-t border-outline-variant/20 hover:bg-surface-container/40">
                  <td className="px-md py-sm font-mono text-xs">
                    <div>{p.sku}</div>
                    {p.baseSku && <div className="text-on-surface-variant">{p.baseSku}</div>}
                  </td>
                  <td className="px-md py-sm">
                    <div>{p.productName ?? p.productType ?? '—'}</div>
                  </td>
                  <td className="px-md py-sm">{p.supplier.name}</td>
                  <td className="px-md py-sm text-right cursor-pointer hover:underline" onClick={() => openEdit(p)}>
                    {p.currency} {p.baseCost.toFixed(2)}
                  </td>
                  <td className="px-md py-sm text-xs">
                    {p.variant1Value ? <span><span className="text-on-surface-variant">{p.variant1Name}: </span>{p.variant1Value}</span> : '—'}
                  </td>
                  <td className="px-md py-sm text-xs">
                    {p.variant2Value ? <span><span className="text-on-surface-variant">{p.variant2Name}: </span>{p.variant2Value}</span> : '—'}
                  </td>
                  <td className="px-md py-sm text-xs">
                    {p.shippingByRegion ? (() => {
                      try {
                        const z = JSON.parse(p.shippingByRegion)
                        return Object.keys(z).join(', ')
                      } catch { return '—' }
                    })() : '—'}
                  </td>
                  <td className="px-md py-sm">
                    <input
                      type="checkbox"
                      checked={p.requiresDesign}
                      onChange={async e => {
                        await fetch(`/api/suppliers/products/${p.id}`, {
                          method: 'PATCH',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ requiresDesign: e.target.checked }),
                        })
                        await load()
                      }}
                      title="Mark as custom-design product → orders with this SKU go to Pending Design status"
                    />
                  </td>
                  <td className="px-md py-sm">{new Date(p.updatedAt).toLocaleDateString('en-CA')}</td>
                  <td className="px-md py-sm flex gap-sm">
                    <button onClick={() => openEdit(p)} className="text-secondary text-label-sm hover:underline">Edit</button>
                    <button onClick={() => deleteOne(p)} className="text-error text-label-sm hover:underline">Delete</button>
                  </td>
                </tr>
              ))}
              {products.length === 0 && <tr><td colSpan={10} className="px-md py-lg text-center text-on-surface-variant">No mappings. Add or import CSV.</td></tr>}
            </tbody>
          </table>
        </div>

        {/* Edit modal */}
        {editingId && editForm && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setEditingId(null)}>
            <div onClick={e => e.stopPropagation()} className="bg-surface-container-lowest rounded-xl p-lg shadow-card border border-outline-variant/20 w-[800px] max-h-[90vh] overflow-y-auto">
              <h2 className="text-headline-sm mb-md">Edit variant — {editForm.sku}</h2>

              <h3 className="text-label-md mt-md mb-sm">Basics</h3>
              <div className="grid grid-cols-2 gap-sm">
                <div><label className="text-label-sm block mb-xs">Product type</label><input className="w-full border rounded-lg px-sm py-xs" value={editForm.productType} onChange={e => setEditForm({...editForm, productType: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Base SKU</label><input className="w-full border rounded-lg px-sm py-xs font-mono" value={editForm.baseSku} onChange={e => setEditForm({...editForm, baseSku: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Variant 1 Name</label><input className="w-full border rounded-lg px-sm py-xs" placeholder="Size, Color, Capacity…" value={editForm.variant1Name} onChange={e => setEditForm({...editForm, variant1Name: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Variant 1 Value</label><input className="w-full border rounded-lg px-sm py-xs" placeholder="XL, Black, 10oz…" value={editForm.variant1Value} onChange={e => setEditForm({...editForm, variant1Value: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Variant 2 Name</label><input className="w-full border rounded-lg px-sm py-xs" placeholder="Color, Style…" value={editForm.variant2Name} onChange={e => setEditForm({...editForm, variant2Name: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Variant 2 Value</label><input className="w-full border rounded-lg px-sm py-xs" placeholder="White, Matte…" value={editForm.variant2Value} onChange={e => setEditForm({...editForm, variant2Value: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Product name</label><input className="w-full border rounded-lg px-sm py-xs" value={editForm.productName} onChange={e => setEditForm({...editForm, productName: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Base cost</label><input type="number" step="0.01" className="w-full border rounded-lg px-sm py-xs" value={editForm.baseCost} onChange={e => setEditForm({...editForm, baseCost: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Currency</label><input className="w-full border rounded-lg px-sm py-xs" value={editForm.currency} onChange={e => setEditForm({...editForm, currency: e.target.value})} /></div>
                <div className="col-span-2"><label className="flex items-center gap-sm text-body-sm"><input type="checkbox" checked={editForm.requiresDesign} onChange={e => setEditForm({...editForm, requiresDesign: e.target.checked})} /> Requires design approval</label></div>
              </div>

              <h3 className="text-label-md mt-md mb-sm">Shipping by region</h3>
              <p className="text-label-sm text-on-surface-variant mb-sm">Set per-zone first-item and additional-item shipping. Leave a zone empty to fall back to supplier default.</p>
              {['US', 'EU', 'GB', 'CA', 'ROW'].map(zone => {
                const z = editForm.shipping[zone] ?? {}
                const setField = (key: 'first' | 'additional' | 'importTax', val: string) => {
                  const next = { ...editForm.shipping }
                  next[zone] = { ...next[zone], [key]: val === '' ? undefined : Number(val) }
                  if (Object.values(next[zone]).every(v => v === undefined || v === 0)) {
                    delete next[zone]
                  }
                  setEditForm({ ...editForm, shipping: next })
                }
                return (
                  <div key={zone} className="grid grid-cols-4 gap-sm items-center mb-xs">
                    <div className="font-mono text-label-md">{zone}</div>
                    <div><label className="text-label-sm block">First item</label><input type="number" step="0.01" className="w-full border rounded-lg px-sm py-xs" value={z.first ?? ''} onChange={e => setField('first', e.target.value)} /></div>
                    <div><label className="text-label-sm block">Additional</label><input type="number" step="0.01" className="w-full border rounded-lg px-sm py-xs" value={z.additional ?? ''} onChange={e => setField('additional', e.target.value)} /></div>
                    {zone === 'US' && (
                      <div><label className="text-label-sm block">Import tax/item</label><input type="number" step="0.01" className="w-full border rounded-lg px-sm py-xs" value={z.importTax ?? ''} onChange={e => setField('importTax', e.target.value)} /></div>
                    )}
                  </div>
                )
              })}

              <h3 className="text-label-md mt-md mb-sm">Design + Production</h3>
              <div className="grid grid-cols-2 gap-sm">
                <div className="col-span-2"><label className="text-label-sm block mb-xs">Design template URL</label><input className="w-full border rounded-lg px-sm py-xs" value={editForm.designTemplateUrl} onChange={e => setEditForm({...editForm, designTemplateUrl: e.target.value})} placeholder="https://drive.google.com/..." /></div>
                <div><label className="text-label-sm block mb-xs">Min production days</label><input type="number" className="w-full border rounded-lg px-sm py-xs" value={editForm.minProductionDays} onChange={e => setEditForm({...editForm, minProductionDays: e.target.value})} /></div>
                <div><label className="text-label-sm block mb-xs">Max production days</label><input type="number" className="w-full border rounded-lg px-sm py-xs" value={editForm.maxProductionDays} onChange={e => setEditForm({...editForm, maxProductionDays: e.target.value})} /></div>
              </div>

              <div className="mt-lg flex gap-sm justify-end">
                <button onClick={() => { setEditingId(null); setEditForm(null) }} className="px-lg py-sm rounded-lg text-label-md border">Cancel</button>
                <button onClick={saveEdit} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">Save</button>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}

export default function ProductsPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-surface" />}>
      <ProductsPageContent />
    </Suspense>
  )
}
