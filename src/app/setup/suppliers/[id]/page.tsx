'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
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
  printingMethod: string | null
  sizeLabel: string | null
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
  printingMethod?: string | null
  sizeLabel?: string | null
  designTemplateUrl?: string | null
  minProductionDays?: number | null
  maxProductionDays?: number | null
  shippingByRegion?: string | null
}

type ManualRow = {
  productType: string
  baseSku: string
  printingMethod: string
  sizeLabel: string
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
  productType: '',
  baseSku: '',
  printingMethod: '',
  sizeLabel: '',
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
    if (f !== undefined || a !== undefined) obj[zone] = { first: num(f), additional: num(a) }
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
      sku,
      baseCost,
      productName: String(r.productName ?? r['Product type'] ?? r['Product Title'] ?? '').trim() || undefined,
      requiresDesign: ['1', 'true', 'TRUE', 'yes', 'YES'].includes(String(r.requiresDesign ?? r.requiresdesign ?? '').trim()),
      baseSku: String(r['SKU product'] ?? '').trim() || null,
      productType: String(r['Product type'] ?? r['Product Title'] ?? '').trim() || null,
      printingMethod: String(r['Printing method'] ?? '').trim() || null,
      sizeLabel: String(r['SIZES'] ?? '').trim() || null,
      designTemplateUrl: String(r['Design Template'] ?? '').trim() || null,
      minProductionDays: minProd ? parseInt(String(minProd), 10) : null,
      maxProductionDays: maxProd ? parseInt(String(maxProd), 10) : null,
      shippingByRegion: buildShippingByRegion(r),
    }
  }).filter(r => r.sku)
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
  const [manualRows, setManualRows] = useState<ManualRow[]>([{ ...emptyManualRow }])
  const [importPreview, setImportPreview] = useState<ImportRow[] | null>(null)
  const [importResult, setImportResult] = useState<{ created: number; updated: number; errors: any[] } | null>(null)
  const [busy, setBusy] = useState(false)
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

  const onFilePick = async (file: File) => {
    const rows = /\.(xlsx|xls)$/i.test(file.name)
      ? parseExcelRows(await file.arrayBuffer())
      : parseCsv(await file.text())
    setImportPreview(rowsToImportRows(rows))
    setImportResult(null)
  }

  const updateManualRow = (index: number, patch: Partial<ManualRow>) => {
    setManualRows(rows => rows.map((row, i) => i === index ? { ...row, ...patch } : row))
  }

  const manualRowsToImport = (): ImportRow[] => manualRows.map(r => ({
    sku: r.sku.trim(),
    baseCost: num(r.baseCost),
    productName: r.productType || undefined,
    baseSku: r.baseSku || null,
    productType: r.productType || null,
    printingMethod: r.printingMethod || null,
    sizeLabel: r.sizeLabel || null,
    designTemplateUrl: r.designTemplateUrl || null,
    minProductionDays: r.minProductionDays ? parseInt(r.minProductionDays, 10) : null,
    maxProductionDays: r.maxProductionDays ? parseInt(r.maxProductionDays, 10) : null,
    shippingByRegion: buildShippingByRegion({
      'US import Tax/item': r.usImportTax,
      'US shipping fee (1st item)': r.usShipFirst,
      'US additional shipping fee': r.usShipAdditional,
    }),
  })).filter(r => r.sku)

  const previewManualRows = () => {
    const rows = manualRowsToImport()
    if (rows.length === 0) { alert('Enter at least one SKU variant row.'); return }
    setImportPreview(rows)
    setImportResult(null)
  }

  const commitImport = async () => {
    if (!importPreview) return
    setBusy(true)
    const r = await fetch('/api/suppliers/products', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ supplierId, rows: importPreview }),
    })
    const result = await r.json()
    setImportResult(result)
    setImportPreview(null)
    setBusy(false)
    if (fileRef.current) fileRef.current.value = ''
    await loadProducts()
  }

  const deleteOne = async (p: Product) => {
    if (!confirm(`Delete mapping ${p.sku}?`)) return
    await fetch(`/api/suppliers/products/${p.id}`, { method: 'DELETE' })
    await loadProducts()
  }

  const grouped = products.reduce<Record<string, Product[]>>((acc, p) => {
    const key = p.productType || p.productName || 'Uncategorized'
    acc[key] = acc[key] || []
    acc[key].push(p)
    return acc
  }, {})

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
                Setup product catalog, supplier SKU, cost, shipping và fulfillment export cho supplier này.
              </p>
            </div>
            <a href={`${suppliersPath}/${supplierId}/templates`} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
              Export templates
            </a>
          </div>
        </div>

        {supplier && (
          <div className="grid grid-cols-4 gap-md mb-lg">
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
              <div className="text-label-sm text-on-surface-variant">Code</div>
              <div className="font-mono text-body-md mt-xs">{supplier.code}</div>
            </div>
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
              <div className="text-label-sm text-on-surface-variant">Products</div>
              <div className="text-body-md mt-xs">{total}</div>
            </div>
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
              <div className="text-label-sm text-on-surface-variant">Default shipping</div>
              <div className="text-body-md mt-xs">${supplier.firstItemShipFee.toFixed(2)} / ${supplier.additionalItemShipFee.toFixed(2)}</div>
            </div>
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-md">
              <div className="text-label-sm text-on-surface-variant">Auto mapping rank</div>
              <div className="text-body-md mt-xs">{supplier.preferenceRank}</div>
            </div>
          </div>
        )}

        <div className="bg-surface-container-lowest rounded-lg p-lg shadow-card border border-outline-variant/20 mb-lg">
          <div className="flex items-start justify-between gap-md mb-md">
            <div>
              <h2 className="text-headline-sm">Product setup</h2>
              <p className="text-body-sm text-on-surface-variant mt-xs">
                Mỗi dòng là một supplier SKU variant. Tool dùng Product type, Printing method, Size, Tag Shopify và rank để auto map order/crawler vào đúng supplier.
              </p>
            </div>
            <input
              placeholder="Search SKU or product"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="border rounded-lg px-md py-sm text-body-sm w-[280px]"
            />
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-[320px_1fr] gap-lg">
            <div className="space-y-md">
              <div>
                <h3 className="text-label-md mb-sm">Import supplier sheet</h3>
                <input
                  ref={fileRef}
                  type="file"
                  accept=".xlsx,.xls,.csv,text/csv"
                  onChange={e => e.target.files?.[0] && onFilePick(e.target.files[0])}
                  className="text-body-sm"
                />
                <p className="text-label-sm text-on-surface-variant mt-sm">
                  Sheet nên có Product type, SKU product, Printing method, SIZES, SKU variant, Base cost, shipping fee và production time.
                </p>
              </div>
              {importPreview && (
                <div className="rounded-lg border border-outline-variant/20 p-md">
                  <p className="text-body-sm mb-sm">Preview: {importPreview.length} row(s)</p>
                  <button onClick={commitImport} disabled={busy} className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm disabled:opacity-50">
                    {busy ? 'Saving...' : 'Save to this supplier'}
                  </button>
                </div>
              )}
              {importResult && (
                <div className="text-body-sm">
                  Created: {importResult.created}, Updated: {importResult.updated}
                  {importResult.errors?.length > 0 && <p className="text-error">{importResult.errors.length} error(s). Check SKU/base cost.</p>}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center justify-between mb-sm">
                <h3 className="text-label-md">Manual sheet entry</h3>
                <div className="flex gap-sm">
                  <button onClick={() => setManualRows(rows => [...rows, { ...emptyManualRow }])} className="px-md py-xs rounded-lg border text-label-sm">Add row</button>
                  <button onClick={previewManualRows} className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-sm">Preview rows</button>
                </div>
              </div>
              <div className="overflow-x-auto">
                <table className="min-w-[1360px] w-full text-label-sm">
                  <thead className="bg-surface-container">
                    <tr className="text-left">
                      {['Product type', 'SKU product', 'Printing method', 'SIZES', 'SKU variant', 'Base cost ($)', 'US import Tax/item', 'US shipping fee (1st item)', 'US additional shipping fee', 'Design Template', 'Min production time', 'Max production time', ''].map(h => (
                        <th key={h} className="px-sm py-xs">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {manualRows.map((row, index) => (
                      <tr key={index} className="border-t border-outline-variant/20">
                        <td className="px-sm py-xs"><input className="w-40 border rounded px-xs py-[3px]" value={row.productType} onChange={e => updateManualRow(index, { productType: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-28 border rounded px-xs py-[3px] font-mono" value={row.baseSku} onChange={e => updateManualRow(index, { baseSku: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-36 border rounded px-xs py-[3px]" value={row.printingMethod} onChange={e => updateManualRow(index, { printingMethod: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" value={row.sizeLabel} onChange={e => updateManualRow(index, { sizeLabel: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-40 border rounded px-xs py-[3px] font-mono" value={row.sku} onChange={e => updateManualRow(index, { sku: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" type="number" step="0.01" value={row.baseCost} onChange={e => updateManualRow(index, { baseCost: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" type="number" step="0.01" value={row.usImportTax} onChange={e => updateManualRow(index, { usImportTax: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" type="number" step="0.01" value={row.usShipFirst} onChange={e => updateManualRow(index, { usShipFirst: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-24 border rounded px-xs py-[3px]" type="number" step="0.01" value={row.usShipAdditional} onChange={e => updateManualRow(index, { usShipAdditional: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-56 border rounded px-xs py-[3px]" value={row.designTemplateUrl} onChange={e => updateManualRow(index, { designTemplateUrl: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" type="number" value={row.minProductionDays} onChange={e => updateManualRow(index, { minProductionDays: e.target.value })} /></td>
                        <td className="px-sm py-xs"><input className="w-20 border rounded px-xs py-[3px]" type="number" value={row.maxProductionDays} onChange={e => updateManualRow(index, { maxProductionDays: e.target.value })} /></td>
                        <td className="px-sm py-xs">{manualRows.length > 1 && <button onClick={() => setManualRows(rows => rows.filter((_, i) => i !== index))} className="text-error">Remove</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>

        <div className="space-y-md">
          {Object.entries(grouped).map(([productType, rows]) => (
            <div key={productType} className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 overflow-hidden">
              <div className="px-md py-sm bg-surface-container flex items-center justify-between">
                <h3 className="text-title-md">{productType}</h3>
                <span className="text-label-sm text-on-surface-variant">{rows.length} variant(s)</span>
              </div>
              <table className="w-full text-body-sm">
                <thead>
                  <tr className="text-left border-b border-outline-variant/20">
                    <th className="px-md py-sm">Supplier SKU</th>
                    <th className="px-md py-sm">Base SKU</th>
                    <th className="px-md py-sm">Print</th>
                    <th className="px-md py-sm">Size</th>
                    <th className="px-md py-sm text-right">Base cost</th>
                    <th className="px-md py-sm">Shipping</th>
                    <th className="px-md py-sm">Updated</th>
                    <th className="px-md py-sm"></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(p => (
                    <tr key={p.id} className="border-b border-outline-variant/10 last:border-b-0">
                      <td className="px-md py-sm font-mono text-xs">{p.sku}</td>
                      <td className="px-md py-sm font-mono text-xs">{p.baseSku || '-'}</td>
                      <td className="px-md py-sm">{p.printingMethod || '-'}</td>
                      <td className="px-md py-sm">{p.sizeLabel || '-'}</td>
                      <td className="px-md py-sm text-right">{p.currency} {p.baseCost.toFixed(2)}</td>
                      <td className="px-md py-sm text-xs">{p.shippingByRegion ? Object.keys(JSON.parse(p.shippingByRegion)).join(', ') : '-'}</td>
                      <td className="px-md py-sm">{new Date(p.updatedAt).toLocaleDateString('en-CA')}</td>
                      <td className="px-md py-sm text-right">
                        <a href={`/fulfillment/products?supplierId=${supplierId}&search=${encodeURIComponent(p.sku)}`} className="text-secondary text-label-sm mr-sm">Edit</a>
                        <button onClick={() => deleteOne(p)} className="text-error text-label-sm">Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
          {products.length === 0 && (
            <div className="bg-surface-container-lowest rounded-lg border border-outline-variant/20 p-xl text-center text-on-surface-variant">
              No product variants yet. Import supplier sheet or add manual rows above.
            </div>
          )}
        </div>
      </main>
    </div>
  )
}
