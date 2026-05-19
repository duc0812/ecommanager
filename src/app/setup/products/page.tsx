'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  supplier: { id: string; name: string; code: string; currency: string }
}

export default function ProductsPage() {
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierId, setSupplierId] = useState<string>('')
  const [search, setSearch] = useState('')
  const [products, setProducts] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [form, setForm] = useState({ sku: '', baseCost: '', productName: '' })
  const [importPreview, setImportPreview] = useState<Array<{ sku: string; baseCost: number; productName?: string; requiresDesign?: boolean }> | null>(null)
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: any[] } | null>(null)
  const [busy, setBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? []))
  }, [])

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

  const editBaseCost = async (p: Product, newCost: number) => {
    if (newCost === p.baseCost) return
    await fetch(`/api/suppliers/products/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ baseCost: newCost }),
    })
    await load()
  }

  const deleteOne = async (p: Product) => {
    if (!confirm(`Delete mapping ${p.sku} → ${p.supplier.name}?`)) return
    await fetch(`/api/suppliers/products/${p.id}`, { method: 'DELETE' })
    await load()
  }

  const onCsvPick = async (file: File) => {
    if (!supplierId) { alert('Pick a supplier first (CSV import goes into the selected supplier)'); return }
    const text = await file.text()
    const rows = parseCsv(text)
    const parsed = rows.map(r => ({
      sku: (r.sku ?? '').trim(),
      baseCost: parseFloat(r.baseCost ?? r.basecost ?? '0'),
      productName: r.productName ?? r.name ?? undefined,
      requiresDesign: ['1', 'true', 'TRUE', 'yes', 'YES'].includes((r.requiresDesign ?? r.requiresdesign ?? '').toString().trim()),
    })).filter(r => r.sku)
    setImportPreview(parsed); setImportResult(null)
  }

  const commitImport = async () => {
    if (!importPreview || !supplierId) return
    setBusy(true)
    const r = await fetch('/api/suppliers/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId, rows: importPreview }),
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
              <h2 className="text-headline-sm mb-md">Bulk import CSV</h2>
              <p className="text-body-sm text-on-surface-variant mb-sm">
                Format: header row required. Columns: <code>sku</code>, <code>baseCost</code>, optional <code>productName</code>, <code>currency</code>, <code>requiresDesign</code> (1/0/true/false).
                Import goes to the supplier selected above.
              </p>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,text/csv"
                onChange={e => e.target.files?.[0] && onCsvPick(e.target.files[0])}
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
        </div>

        {/* Table */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="px-md py-sm">SKU</th>
                <th className="px-md py-sm">Product</th>
                <th className="px-md py-sm">Supplier</th>
                <th className="px-md py-sm text-right">Base cost</th>
                <th className="px-md py-sm">Currency</th>
                <th className="px-md py-sm">Custom?</th>
                <th className="px-md py-sm">Updated</th>
                <th className="px-md py-sm"></th>
              </tr>
            </thead>
            <tbody>
              {products.map(p => (
                <tr key={p.id} className="border-t border-outline-variant/20">
                  <td className="px-md py-sm font-mono">{p.sku}</td>
                  <td className="px-md py-sm">{p.productName ?? '—'}</td>
                  <td className="px-md py-sm">{p.supplier.name}</td>
                  <td className="px-md py-sm text-right">
                    <input
                      type="number"
                      step="0.01"
                      defaultValue={p.baseCost.toFixed(2)}
                      onBlur={e => editBaseCost(p, parseFloat(e.target.value))}
                      className="w-24 text-right border rounded px-xs py-[2px]"
                    />
                  </td>
                  <td className="px-md py-sm">{p.currency}</td>
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
                  <td className="px-md py-sm">
                    <button onClick={() => deleteOne(p)} className="text-error text-label-sm">Delete</button>
                  </td>
                </tr>
              ))}
              {products.length === 0 && <tr><td colSpan={8} className="px-md py-lg text-center text-on-surface-variant">No mappings. Add or import CSV.</td></tr>}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
