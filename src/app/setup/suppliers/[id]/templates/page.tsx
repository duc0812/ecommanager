'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams, usePathname, useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { renderCsv, type CsvTemplate as RenderTemplate, type OrderForCsv } from '@/lib/csv-template'

type Supplier = { id: string; name: string; code: string }
type Template = {
  id: string
  name: string
  columns: string  // JSON string
  rowMode: 'PER_LINE' | 'PER_ORDER'
  isDefault: boolean
}

const SOURCE_OPTIONS = [
  { value: 'order.shopifyOrderNumber', label: 'Order — Number' },
  { value: 'order.customerName', label: 'Order — Customer Name' },
  { value: 'order.customerEmail', label: 'Order — Customer Email' },
  { value: 'order.shippingCountry', label: 'Order — Country' },
  { value: 'order.shippingState', label: 'Order — State' },
  { value: 'order.placedAt', label: 'Order — Placed At (ISO)' },
  { value: 'line.designSku', label: 'Line — Design SKU' },
  { value: 'line.sku', label: 'Line — Shopify SKU' },
  { value: 'line.supplierSku', label: 'Line — Supplier SKU' },
  { value: 'line.qty', label: 'Line — Quantity' },
  { value: 'line.productTitle', label: 'Line — Product Title' },
  { value: 'line.variantTitle', label: 'Line — Variant Title' },
  { value: 'literal:', label: 'Literal (type value)' },
]

type EditorColumn = { header: string; source: string }

const emptyEditor = {
  name: '',
  rowMode: 'PER_LINE' as 'PER_LINE' | 'PER_ORDER',
  isDefault: false,
  columns: [] as EditorColumn[],
}

export default function TemplatesPage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const pathname = usePathname()
  const suppliersPath = pathname.startsWith('/fulfillment') ? '/fulfillment/suppliers' : '/setup/suppliers'
  const supplierId = params.id

  const [supplier, setSupplier] = useState<Supplier | null>(null)
  const [templates, setTemplates] = useState<Template[]>([])
  const [editor, setEditor] = useState<typeof emptyEditor>(emptyEditor)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [previewOrders, setPreviewOrders] = useState<OrderForCsv[]>([])

  const load = useCallback(async () => {
    const [supRes, tmplRes] = await Promise.all([
      fetch(`/api/suppliers/${supplierId}`).then(r => r.json()),
      fetch(`/api/suppliers/templates?supplierId=${supplierId}`).then(r => r.json()),
    ])
    setSupplier(supRes)
    setTemplates(tmplRes.templates ?? [])
  }, [supplierId])
  useEffect(() => { load() }, [load])

  // Load 3 sample orders for live preview
  useEffect(() => {
    fetch('/api/fulfillment/orders?supplierId=' + supplierId)
      .then(r => r.json())
      .then(d => {
        const orders = (d.orders ?? []).slice(0, 3).map((o: any) => ({
          shopifyOrderNumber: o.shopifyOrderNumber,
          customerName: o.customerName,
          customerEmail: o.customerEmail ?? null,
          shippingCountry: o.shippingCountry ?? null,
          shippingState: o.shippingState ?? null,
          placedAt: new Date(o.placedAt),
          lines: (o.lines ?? []).map((l: any) => ({
            sku: l.sku,
            supplierSku: l.resolvedSupplierSku,
            qty: l.qty,
            productTitle: l.productTitle,
            variantTitle: l.variantTitle,
          })),
        })) as OrderForCsv[]
        setPreviewOrders(orders)
      })
      .catch(() => setPreviewOrders([]))
  }, [supplierId])

  const startEdit = (t: Template) => {
    setEditingId(t.id)
    let cols: EditorColumn[] = []
    try { cols = JSON.parse(t.columns) } catch { cols = [] }
    setEditor({
      name: t.name,
      rowMode: t.rowMode,
      isDefault: t.isDefault,
      columns: cols,
    })
  }

  const addColumn = () => {
    setEditor(e => ({ ...e, columns: [...e.columns, { header: '', source: 'line.sku' }] }))
  }
  const removeColumn = (i: number) => {
    setEditor(e => ({ ...e, columns: e.columns.filter((_, idx) => idx !== i) }))
  }
  const moveColumn = (i: number, dir: -1 | 1) => {
    setEditor(e => {
      const cols = [...e.columns]
      const j = i + dir
      if (j < 0 || j >= cols.length) return e
      ;[cols[i], cols[j]] = [cols[j], cols[i]]
      return { ...e, columns: cols }
    })
  }
  const updateColumn = (i: number, patch: Partial<EditorColumn>) => {
    setEditor(e => ({
      ...e,
      columns: e.columns.map((c, idx) => idx === i ? { ...c, ...patch } : c),
    }))
  }

  const save = async () => {
    if (!editor.name || editor.columns.length === 0) { alert('Name + at least 1 column required'); return }
    const cleaned = editor.columns.filter(c => c.header && c.source)
    if (cleaned.length === 0) { alert('Each column must have a header and source'); return }
    const body = {
      supplierId,
      name: editor.name,
      rowMode: editor.rowMode,
      isDefault: editor.isDefault,
      columns: cleaned,
    }
    const url = editingId ? `/api/suppliers/templates/${editingId}` : '/api/suppliers/templates'
    const method = editingId ? 'PATCH' : 'POST'
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) { const e = await res.json(); alert(e.error || 'Save failed'); return }
    setEditor(emptyEditor); setEditingId(null); await load()
  }

  const remove = async (id: string) => {
    if (!confirm('Delete template?')) return
    await fetch(`/api/suppliers/templates/${id}`, { method: 'DELETE' })
    await load()
  }

  // Render preview
  const previewCsv = (() => {
    if (editor.columns.length === 0 || previewOrders.length === 0) return ''
    const renderTmpl: RenderTemplate = {
      rowMode: editor.rowMode,
      columns: editor.columns.filter(c => c.header && c.source),
    }
    try {
      return renderCsv(renderTmpl, previewOrders)
    } catch (e: any) {
      return `Error: ${e.message}`
    }
  })()

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <button onClick={() => router.push(suppliersPath)} className="text-secondary text-body-sm mb-md">
          ← Back to suppliers
        </button>
        <h1 className="text-display-md mb-lg">CSV Templates — {supplier?.name ?? '...'}</h1>

        {/* Existing templates */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden mb-lg">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="px-md py-sm">Name</th>
                <th className="px-md py-sm">Row mode</th>
                <th className="px-md py-sm text-right"># Columns</th>
                <th className="px-md py-sm">Default</th>
                <th className="px-md py-sm"></th>
              </tr>
            </thead>
            <tbody>
              {templates.map(t => {
                let cols: any[] = []
                try { cols = JSON.parse(t.columns) } catch { /* empty */ }
                return (
                  <tr key={t.id} className="border-t border-outline-variant/20">
                    <td className="px-md py-sm">{t.name}</td>
                    <td className="px-md py-sm">{t.rowMode}</td>
                    <td className="px-md py-sm text-right">{cols.length}</td>
                    <td className="px-md py-sm">{t.isDefault ? '★' : ''}</td>
                    <td className="px-md py-sm">
                      <div className="flex gap-xs">
                        <button onClick={() => startEdit(t)} className="text-secondary text-label-sm">Edit</button>
                        <button onClick={() => remove(t.id)} className="text-error text-label-sm">Delete</button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {templates.length === 0 && <tr><td colSpan={5} className="px-md py-lg text-center text-on-surface-variant">No templates yet.</td></tr>}
            </tbody>
          </table>
        </div>

        {/* Editor */}
        <div className="bg-surface-container-lowest rounded-xl p-lg shadow-card border border-outline-variant/20">
          <h2 className="text-headline-sm mb-md">{editingId ? 'Edit template' : 'New template'}</h2>

          <div className="grid grid-cols-2 gap-md mb-md">
            <div>
              <label className="text-label-sm block mb-xs">Name</label>
              <input value={editor.name} onChange={e => setEditor({ ...editor, name: e.target.value })} className="w-full border rounded-lg px-sm py-xs" placeholder="Printful Bulk Upload" />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Row mode</label>
              <select value={editor.rowMode} onChange={e => setEditor({ ...editor, rowMode: e.target.value as 'PER_LINE' | 'PER_ORDER' })} className="w-full border rounded-lg px-sm py-xs">
                <option value="PER_LINE">PER_LINE (one row per line item)</option>
                <option value="PER_ORDER">PER_ORDER (one row per order)</option>
              </select>
            </div>
            <div className="col-span-2">
              <label className="flex items-center gap-sm text-body-sm">
                <input type="checkbox" checked={editor.isDefault} onChange={e => setEditor({ ...editor, isDefault: e.target.checked })} />
                Set as default template for this supplier
              </label>
            </div>
          </div>

          <h3 className="text-label-md mb-sm">Columns</h3>
          <div className="space-y-sm mb-md">
            {editor.columns.map((c, i) => {
              const isLiteral = c.source.startsWith('literal:')
              return (
                <div key={i} className="flex items-center gap-sm">
                  <span className="text-on-surface-variant text-label-sm w-8">#{i + 1}</span>
                  <input
                    value={c.header}
                    onChange={e => updateColumn(i, { header: e.target.value })}
                    className="border rounded-lg px-sm py-xs flex-1"
                    placeholder="Header"
                  />
                  <select
                    value={isLiteral ? 'literal:' : c.source}
                    onChange={e => {
                      if (e.target.value === 'literal:') updateColumn(i, { source: 'literal:' })
                      else updateColumn(i, { source: e.target.value })
                    }}
                    className="border rounded-lg px-sm py-xs"
                  >
                    {SOURCE_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                  {isLiteral && (
                    <input
                      value={c.source.slice('literal:'.length)}
                      onChange={e => updateColumn(i, { source: 'literal:' + e.target.value })}
                      className="border rounded-lg px-sm py-xs"
                      placeholder="static value"
                    />
                  )}
                  <button onClick={() => moveColumn(i, -1)} className="px-xs">↑</button>
                  <button onClick={() => moveColumn(i, 1)} className="px-xs">↓</button>
                  <button onClick={() => removeColumn(i)} className="text-error px-xs">✕</button>
                </div>
              )
            })}
          </div>
          <button onClick={addColumn} className="text-secondary text-label-md mb-md">+ Add column</button>

          {/* Preview */}
          <h3 className="text-label-md mb-sm">Live preview (3 sample orders)</h3>
          <pre className="bg-surface-container p-sm rounded-lg text-label-sm overflow-x-auto mb-md whitespace-pre">
            {previewCsv || (previewOrders.length === 0 ? '(No orders to preview — sync first or add columns)' : '(Add columns to see preview)')}
          </pre>

          <div className="flex gap-sm">
            <button onClick={save} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md">
              {editingId ? 'Update' : 'Create'}
            </button>
            {editingId && <button onClick={() => { setEditor(emptyEditor); setEditingId(null) }} className="px-lg py-sm rounded-lg text-label-md border">Cancel</button>}
          </div>
        </div>
      </main>
    </div>
  )
}
