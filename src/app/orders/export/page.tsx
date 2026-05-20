'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type Project = { id: string; name: string; shopifyStore: { shop: string } | null }
type Supplier = { id: string; name: string; code: string }
type Template = {
  id: string
  name: string
  rowMode: 'PER_LINE' | 'PER_ORDER'
  isDefault: boolean
  columns?: string
}
type TemplateColumn = { header: string; source: string }
type SourceOption = { value: string; label: string; needsLine?: boolean }

const SOURCE_OPTIONS: SourceOption[] = [
  { value: 'literal:', label: 'Fixed value' },
  { value: 'order.shopifyOrderNumber', label: 'Order number' },
  { value: 'order.customerName', label: 'Customer name' },
  { value: 'order.customerEmail', label: 'Email' },
  { value: 'order.shippingPhone', label: 'Phone number' },
  { value: 'order.shippingName', label: 'Shipping name' },
  { value: 'order.shippingAddressFull', label: 'Address 1&2' },
  { value: 'order.shippingAddress1', label: 'Address 1' },
  { value: 'order.shippingAddress2', label: 'Address 2' },
  { value: 'order.shippingCity', label: 'City' },
  { value: 'order.shippingState', label: 'State / province' },
  { value: 'order.shippingZip', label: 'Postal code' },
  { value: 'order.shippingCountry', label: 'Country' },
  { value: 'order.financialStatus', label: 'Financial status' },
  { value: 'order.fulfillmentStatus', label: 'Fulfillment status' },
  { value: 'order.placedAt', label: 'Order date' },
  { value: 'order.placedDate', label: 'Order date (YYYY-MM-DD)' },
  { value: 'order.designDriveLink', label: 'Design link' },
  { value: 'order.trelloCardUrl', label: 'Trello card link' },
  { value: 'line.supplierSku', label: 'Supplier SKU', needsLine: true },
  { value: 'line.sku', label: 'Shopify SKU', needsLine: true },
  { value: 'line.designSku', label: 'Design SKU', needsLine: true },
  { value: 'line.itemName', label: 'Item name', needsLine: true },
  { value: 'line.productTitle', label: 'Product title', needsLine: true },
  { value: 'line.variantTitle', label: 'Variant title', needsLine: true },
  { value: 'line.qty', label: 'Quantity', needsLine: true },
  { value: 'line.unitPrice', label: 'Unit price', needsLine: true },
  { value: 'line.supplierProductType', label: 'Supplier product type', needsLine: true },
  { value: 'line.supplierProductName', label: 'Supplier product name', needsLine: true },
  { value: 'line.supplierVariant1Value', label: 'Supplier variant 1 value', needsLine: true },
  { value: 'line.supplierVariant2Value', label: 'Supplier variant 2 value', needsLine: true },
]

const today = () => new Date().toISOString().split('T')[0]
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

function parseCsvHeader(text: string): string[] {
  const firstLine = text.split(/\r?\n/).find(line => line.trim().length > 0) ?? ''
  const result: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < firstLine.length; i += 1) {
    const ch = firstLine[i]
    if (ch === '"' && firstLine[i + 1] === '"') {
      cell += '"'
      i += 1
    } else if (ch === '"') {
      quoted = !quoted
    } else if (ch === ',' && !quoted) {
      result.push(cell.trim())
      cell = ''
    } else {
      cell += ch
    }
  }
  result.push(cell.trim())
  return result.filter(Boolean)
}

function sourceBase(source: string) {
  return source.startsWith('literal:') ? 'literal:' : source
}

function sourceLiteral(source: string) {
  return source.startsWith('literal:') ? source.slice('literal:'.length) : ''
}

function columnsFromTemplate(t?: Template | null): TemplateColumn[] {
  if (!t?.columns) return []
  try {
    const cols = JSON.parse(t.columns)
    return Array.isArray(cols)
      ? cols.filter(c => c && typeof c.header === 'string' && typeof c.source === 'string')
      : []
  } catch {
    return []
  }
}

function buildColumns(headers: string[]): TemplateColumn[] {
  return headers.map(header => ({ header, source: guessSource(header) }))
}

function guessSource(header: string): string {
  const key = header.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
  if (key === 'date' || key.includes('production date')) return 'order.placedDate'
  if (key.includes('order number') || key.includes('order vendor')) return 'order.shopifyOrderNumber'
  if (key.includes('phone')) return 'order.shippingPhone'
  if (key.includes('name shipping')) return 'order.shippingName'
  if (key.includes('address')) return 'order.shippingAddressFull'
  if (key.includes('city')) return 'order.shippingCity'
  if (key.includes('state')) return 'order.shippingState'
  if (key.includes('postcode') || key.includes('postal') || key.includes('zip')) return 'order.shippingZip'
  if (key.includes('country')) return 'order.shippingCountry'
  if (key.includes('sku suplier') || key.includes('sku supplier')) return 'line.supplierSku'
  if (key.includes('sku custom')) return 'line.sku'
  if (key.includes('item name')) return 'line.itemName'
  if (key === 'type') return 'line.supplierProductName'
  if (key === 'size') return 'line.supplierVariant1Value'
  if (key === 'color') return 'line.supplierVariant2Value'
  if (key.includes('quantity')) return 'line.qty'
  if (key.includes('design link')) return 'order.designDriveLink'
  if (key.includes('mockup')) return 'order.trelloCardUrl'
  if (key === 'price' || key.includes('total')) return 'line.unitPrice'
  return 'literal:'
}

export default function ExportPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [templates, setTemplates] = useState<Template[]>([])

  const [projectId, setProjectId] = useState<string>('')
  const [supplierId, setSupplierId] = useState<string>('')
  const [templateId, setTemplateId] = useState<string>('')
  const [dateFrom, setDateFrom] = useState<string>(daysAgo(7))
  const [dateTo, setDateTo] = useState<string>(today())
  const [pipelineStatus, setPipelineStatus] = useState<string>('')

  const [previewing, setPreviewing] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [preview, setPreview] = useState<{ orderCount: number; csv: string; supplierCode: string } | null>(null)
  const [message, setMessage] = useState('')

  const [templateOpen, setTemplateOpen] = useState(false)
  const [editingTemplateId, setEditingTemplateId] = useState<string>('')
  const [templateName, setTemplateName] = useState('')
  const [rowMode, setRowMode] = useState<'PER_LINE' | 'PER_ORDER'>('PER_LINE')
  const [isDefault, setIsDefault] = useState(true)
  const [columns, setColumns] = useState<TemplateColumn[]>([])
  const [templateMessage, setTemplateMessage] = useState('')
  const [savingTemplate, setSavingTemplate] = useState(false)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const selectedSupplier = useMemo(
    () => suppliers.find(s => s.id === supplierId) ?? null,
    [suppliers, supplierId],
  )
  const selectedTemplate = useMemo(
    () => templates.find(t => t.id === templateId) ?? null,
    [templates, templateId],
  )

  const loadTemplates = useCallback(async (nextSupplierId = supplierId) => {
    if (!nextSupplierId) {
      setTemplates([])
      setTemplateId('')
      return
    }
    const res = await fetch(`/api/suppliers/templates?supplierId=${nextSupplierId}&ensureDefault=1`)
    const data = await res.json()
    const list: Template[] = data.templates ?? []
    setTemplates(list)
    const currentStillExists = list.some(t => t.id === templateId)
    if (currentStillExists) return
    const def = list.find(t => t.isDefault)
    setTemplateId(def?.id ?? list[0]?.id ?? '')
  }, [supplierId, templateId])

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(d => {
      const list = Array.isArray(d) ? d : (d.projects ?? [])
      setProjects(list)
    })
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? []))
  }, [])

  useEffect(() => {
    void loadTemplates(supplierId)
  }, [supplierId, loadTemplates])

  const openTemplateModal = () => {
    if (!supplierId) {
      setMessage('Pick a supplier before setting up templates')
      return
    }
    const tmpl = selectedTemplate
    setEditingTemplateId(tmpl?.id ?? '')
    setTemplateName(tmpl?.name ?? `${selectedSupplier?.code ?? selectedSupplier?.name ?? 'Supplier'} template`)
    setRowMode(tmpl?.rowMode ?? 'PER_LINE')
    setIsDefault(tmpl?.isDefault ?? true)
    setColumns(columnsFromTemplate(tmpl))
    setTemplateMessage('')
    setTemplateOpen(true)
  }

  const importTemplateFile = async (file: File) => {
    setTemplateMessage('')
    const lower = file.name.toLowerCase()
    let headers: string[] = []
    if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) {
      const XLSX = await import('xlsx')
      const buffer = await file.arrayBuffer()
      const workbook = XLSX.read(buffer, { type: 'array' })
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<string[]>(firstSheet, { header: 1, blankrows: false })
      headers = (rows[0] ?? []).map(v => String(v ?? '').trim()).filter(Boolean)
    } else {
      headers = parseCsvHeader(await file.text())
    }
    if (headers.length === 0) {
      setTemplateMessage('No header found in sample file')
      return
    }
    setColumns(buildColumns(headers))
    if (!templateName.trim()) setTemplateName(file.name.replace(/\.(csv|xlsx|xls)$/i, ''))
    setTemplateMessage(`Imported ${headers.length} header(s)`)
  }

  const updateColumn = (index: number, patch: Partial<TemplateColumn>) => {
    setColumns(cols => cols.map((col, i) => (i === index ? { ...col, ...patch } : col)))
  }

  const removeColumn = (index: number) => {
    setColumns(cols => cols.filter((_, i) => i !== index))
  }

  const addColumn = () => {
    setColumns(cols => [...cols, { header: '', source: 'literal:' }])
  }

  const saveTemplate = async () => {
    const cleaned = columns
      .map(c => ({ header: c.header.trim(), source: c.source }))
      .filter(c => c.header && c.source)
    if (!supplierId || !templateName.trim() || cleaned.length === 0) {
      setTemplateMessage('Template name and at least one mapped column are required')
      return
    }
    setSavingTemplate(true)
    setTemplateMessage('')
    const body = {
      supplierId,
      name: templateName.trim(),
      rowMode,
      isDefault,
      columns: cleaned,
    }
    const res = await fetch(editingTemplateId ? `/api/suppliers/templates/${editingTemplateId}` : '/api/suppliers/templates', {
      method: editingTemplateId ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      setTemplateMessage(err.error || 'Save failed')
      setSavingTemplate(false)
      return
    }
    const saved: Template = await res.json()
    await loadTemplates(supplierId)
    setTemplateId(saved.id)
    setTemplateOpen(false)
    setSavingTemplate(false)
    setMessage('Template saved')
  }

  const deleteTemplate = async () => {
    if (!editingTemplateId || !confirm('Delete this template?')) return
    const res = await fetch(`/api/suppliers/templates/${editingTemplateId}`, { method: 'DELETE' })
    if (!res.ok) {
      setTemplateMessage('Delete failed')
      return
    }
    await loadTemplates(supplierId)
    setTemplateOpen(false)
    setMessage('Template deleted')
  }

  const runPreview = useCallback(async () => {
    if (!templateId) { setMessage('Pick a template'); return }
    setPreviewing(true); setMessage('')
    const res = await fetch('/api/fulfillment/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId,
        projectId: projectId || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        pipelineStatus: pipelineStatus || undefined,
        preview: true,
        markExported: false,
      }),
    })
    const data = await res.json()
    if (!res.ok) { setMessage(data.error || 'Preview failed'); setPreviewing(false); return }
    setPreview(data); setPreviewing(false)
  }, [templateId, projectId, dateFrom, dateTo, pipelineStatus])

  const download = async () => {
    if (!templateId) { setMessage('Pick a template'); return }
    if (!confirm('Download CSV and mark these orders as EXPORTED?')) return
    setDownloading(true); setMessage('')
    const res = await fetch('/api/fulfillment/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        templateId,
        projectId: projectId || undefined,
        dateFrom: dateFrom || undefined,
        dateTo: dateTo || undefined,
        pipelineStatus: pipelineStatus || undefined,
        markExported: true,
      }),
    })
    if (!res.ok) {
      const e = await res.json()
      setMessage(e.error || 'Export failed')
      setDownloading(false)
      return
    }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const cd = res.headers.get('content-disposition') ?? ''
    const m = cd.match(/filename="([^"]+)"/)
    a.download = m ? m[1] : 'export.csv'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    setMessage('Downloaded and marked orders as EXPORTED')
    setDownloading(false)
    setPreview(null)
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] w-[calc(100vw-280px)] min-w-0 p-xl">
        <h1 className="text-display-md mb-lg">CSV Export</h1>

        <div className="bg-surface-container-lowest rounded-xl p-lg shadow-card border border-outline-variant/20 mb-lg">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-md">
            <div>
              <label className="text-label-sm block mb-xs">Project</label>
              <select value={projectId} onChange={e => setProjectId(e.target.value)} className="w-full border rounded-lg px-sm py-xs">
                <option value="">All projects</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Supplier</label>
              <select value={supplierId} onChange={e => setSupplierId(e.target.value)} className="w-full border rounded-lg px-sm py-xs">
                <option value="">- pick supplier -</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <div className="mb-xs flex items-center justify-between gap-sm">
                <label className="text-label-sm">Template</label>
                <button
                  type="button"
                  onClick={openTemplateModal}
                  disabled={!supplierId}
                  className="text-secondary text-label-sm disabled:opacity-40"
                >
                  Setup template
                </button>
              </div>
              <select value={templateId} onChange={e => setTemplateId(e.target.value)} disabled={!supplierId} className="w-full border rounded-lg px-sm py-xs">
                <option value="">- pick template -</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' *' : ''} ({t.rowMode})</option>)}
              </select>
            </div>
            <div>
              <label className="text-label-sm block mb-xs">From (UTC date)</label>
              <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="w-full border rounded-lg px-sm py-xs" />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">To (UTC date)</label>
              <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="w-full border rounded-lg px-sm py-xs" />
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Pipeline status</label>
              <select value={pipelineStatus} onChange={e => setPipelineStatus(e.target.value)} className="w-full border rounded-lg px-sm py-xs">
                <option value="">All</option>
                <option value="PENDING_DESIGN">Pending Design</option>
                <option value="PENDING_MAPPING">Pending Mapping</option>
                <option value="READY_TO_PRODUCTION">Ready to Production</option>
                <option value="PENDING">Pending</option>
                <option value="EXPORTED">Exported</option>
                <option value="SUPPLIER_PROCESSING">Supplier Processing</option>
                <option value="IN_PRODUCTION">In Production</option>
                <option value="FULFILLED">Fulfilled</option>
                <option value="CANCELLED">Cancelled</option>
              </select>
            </div>
          </div>

          <div className="mt-md flex flex-wrap gap-sm items-center">
            <button onClick={runPreview} disabled={previewing || !templateId} className="px-lg py-sm rounded-lg text-label-md border disabled:opacity-50">
              {previewing ? 'Loading...' : 'Preview'}
            </button>
            <button onClick={download} disabled={downloading || !templateId} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
              {downloading ? 'Downloading...' : 'Download CSV (mark exported)'}
            </button>
            {message && <span className="text-body-sm">{message}</span>}
          </div>
        </div>

        {preview && (
          <div className="bg-surface-container-lowest rounded-xl p-lg shadow-card border border-outline-variant/20">
            <div className="flex items-center justify-between mb-md">
              <h2 className="text-headline-sm">Preview - {preview.orderCount} order(s)</h2>
              <span className="text-label-sm text-on-surface-variant">Supplier: {preview.supplierCode}</span>
            </div>
            {preview.orderCount === 0
              ? <p className="text-on-surface-variant">No orders match the filter. Adjust date range or pipeline status.</p>
              : <pre className="bg-surface-container p-sm rounded-lg text-label-sm overflow-x-auto whitespace-pre">{preview.csv}</pre>
            }
          </div>
        )}

        {templateOpen && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-lg">
            <div className="max-h-[86vh] w-full max-w-4xl overflow-hidden rounded-xl bg-surface-container-lowest shadow-xl">
              <div className="flex items-center justify-between border-b border-outline-variant/20 p-lg">
                <div>
                  <h2 className="text-headline-sm">CSV Template Setup - {selectedSupplier?.name ?? 'Supplier'}</h2>
                  <p className="text-body-sm text-on-surface-variant">Import supplier sample file, then map each output column to order data.</p>
                </div>
                <button type="button" onClick={() => setTemplateOpen(false)} className="rounded-full border px-sm py-xs text-title-md">x</button>
              </div>

              <div className="max-h-[calc(86vh-88px)] overflow-y-auto p-lg">
                <div className="grid grid-cols-1 gap-md md:grid-cols-[1fr_180px_160px] mb-md">
                  <div>
                    <label className="text-label-sm block mb-xs">Template name</label>
                    <input value={templateName} onChange={e => setTemplateName(e.target.value)} className="w-full rounded-lg border px-sm py-xs" />
                  </div>
                  <div>
                    <label className="text-label-sm block mb-xs">Row mode</label>
                    <select value={rowMode} onChange={e => setRowMode(e.target.value as 'PER_LINE' | 'PER_ORDER')} className="w-full rounded-lg border px-sm py-xs">
                      <option value="PER_LINE">Per line item</option>
                      <option value="PER_ORDER">Per order</option>
                    </select>
                  </div>
                  <label className="mt-lg flex items-center gap-sm text-body-sm">
                    <input type="checkbox" checked={isDefault} onChange={e => setIsDefault(e.target.checked)} />
                    Default template
                  </label>
                </div>

                <div className="mb-lg rounded-xl border border-dashed border-outline-variant p-lg text-center">
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,.xlsx,.xls"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0]
                      if (file) void importTemplateFile(file)
                      e.target.value = ''
                    }}
                  />
                  <div className="mb-sm text-headline-sm">Upload</div>
                  <p className="mb-md text-body-sm text-on-surface-variant">
                    Import a supplier CSV or Excel sample. The first row will be used as template headers.
                  </p>
                  <button type="button" onClick={() => fileInputRef.current?.click()} className="rounded-lg border px-lg py-sm text-label-md">
                    Choose sample file
                  </button>
                  {templateMessage && <p className="mt-sm text-body-sm text-on-surface-variant">{templateMessage}</p>}
                </div>

                <div className="mb-sm flex items-center justify-between">
                  <h3 className="text-title-md">Column mapping ({columns.length})</h3>
                  <button type="button" onClick={addColumn} className="text-secondary text-label-md">+ Add column</button>
                </div>

                <div className="mb-md rounded-xl border border-outline-variant/30 bg-surface-container-low p-md">
                  <div className="mb-sm text-label-md">Drag data source to a column</div>
                  <div className="flex max-h-28 flex-wrap gap-xs overflow-y-auto pr-xs">
                    {SOURCE_OPTIONS.map(option => (
                      <button
                        key={`${option.value}-${option.label}`}
                        type="button"
                        draggable
                        onDragStart={e => e.dataTransfer.setData('text/plain', option.value)}
                        className="cursor-grab rounded-full border border-outline-variant/40 bg-surface-container-lowest px-sm py-[5px] text-label-sm active:cursor-grabbing"
                        title={option.needsLine ? 'Line item field' : 'Order field'}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="overflow-hidden rounded-xl border border-outline-variant/30">
                  <table className="w-full text-body-sm">
                    <thead className="bg-surface-container">
                      <tr className="text-left">
                        <th className="w-12 px-md py-sm">#</th>
                        <th className="px-md py-sm">Header in file</th>
                        <th className="px-md py-sm">Data source</th>
                        <th className="w-12 px-md py-sm"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {columns.map((column, index) => {
                        const base = sourceBase(column.source)
                        const isFixed = base === 'literal:'
                        return (
                          <tr
                            key={`${column.header}-${index}`}
                            onDragOver={e => e.preventDefault()}
                            onDrop={e => {
                              e.preventDefault()
                              const source = e.dataTransfer.getData('text/plain')
                              if (source) updateColumn(index, { source: source === 'literal:' ? 'literal:' : source })
                            }}
                            className="border-t border-outline-variant/20"
                          >
                            <td className="px-md py-sm text-on-surface-variant">{index + 1}</td>
                            <td className="px-md py-sm">
                              <input
                                value={column.header}
                                onChange={e => updateColumn(index, { header: e.target.value })}
                                className="w-full rounded-lg border px-sm py-xs"
                                placeholder="Header"
                              />
                            </td>
                            <td className="px-md py-sm">
                              <div className="grid grid-cols-1 gap-sm md:grid-cols-[minmax(180px,1fr)_minmax(120px,180px)]">
                                <select
                                  value={base}
                                  onChange={e => {
                                    const value = e.target.value
                                    updateColumn(index, { source: value === 'literal:' ? 'literal:' : value })
                                  }}
                                  className="rounded-lg border px-sm py-xs"
                                >
                                  {SOURCE_OPTIONS.map(option => (
                                    <option key={`${option.value}-${option.label}`} value={option.value}>
                                      {option.label}
                                    </option>
                                  ))}
                                </select>
                                {isFixed && (
                                  <input
                                    value={sourceLiteral(column.source)}
                                    onChange={e => updateColumn(index, { source: `literal:${e.target.value}` })}
                                    className="rounded-lg border px-sm py-xs"
                                    placeholder="Value"
                                  />
                                )}
                              </div>
                            </td>
                            <td className="px-md py-sm text-right">
                              <button type="button" onClick={() => removeColumn(index)} className="text-error text-title-md">x</button>
                            </td>
                          </tr>
                        )
                      })}
                      {columns.length === 0 && (
                        <tr>
                          <td colSpan={4} className="px-md py-xl text-center text-on-surface-variant">
                            Import a sample file or add columns manually.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                <div className="sticky bottom-0 -mx-lg mt-lg flex items-center justify-between border-t border-outline-variant/20 bg-surface-container-lowest px-lg py-md">
                  <div>
                    {editingTemplateId && (
                      <button type="button" onClick={deleteTemplate} className="text-error text-label-md">
                        Delete template
                      </button>
                    )}
                  </div>
                  <div className="flex gap-sm">
                    <button type="button" onClick={() => setTemplateOpen(false)} className="rounded-lg border px-lg py-sm text-label-md">
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={saveTemplate}
                      disabled={savingTemplate}
                      className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary disabled:opacity-50"
                    >
                      {savingTemplate ? 'Saving...' : 'Save template'}
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
