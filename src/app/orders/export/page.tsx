'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type Project = { id: string; name: string; shopifyStore: { shop: string } | null }
type Supplier = { id: string; name: string; code: string }
type Template = { id: string; name: string; rowMode: string; isDefault: boolean }

const today = () => new Date().toISOString().split('T')[0]
const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString().split('T')[0]

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

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(d => {
      const list = Array.isArray(d) ? d : (d.projects ?? [])
      setProjects(list)
    })
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? []))
  }, [])

  // Load templates when supplier changes
  useEffect(() => {
    if (!supplierId) { setTemplates([]); setTemplateId(''); return }
    fetch(`/api/suppliers/templates?supplierId=${supplierId}`)
      .then(r => r.json())
      .then(d => {
        setTemplates(d.templates ?? [])
        const def = (d.templates ?? []).find((t: Template) => t.isDefault)
        if (def) setTemplateId(def.id)
        else if (d.templates && d.templates.length > 0) setTemplateId(d.templates[0].id)
        else setTemplateId('')
      })
  }, [supplierId])

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
    if (!res.ok) { const e = await res.json(); setMessage(e.error || 'Export failed'); setDownloading(false); return }
    const blob = await res.blob()
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const cd = res.headers.get('content-disposition') ?? ''
    const m = cd.match(/filename="([^"]+)"/)
    a.download = m ? m[1] : 'export.csv'
    document.body.appendChild(a); a.click(); a.remove()
    URL.revokeObjectURL(url)
    setMessage('Downloaded and marked orders as EXPORTED')
    setDownloading(false)
    setPreview(null)  // force re-preview after marking
  }

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <h1 className="text-display-md mb-lg">CSV Export</h1>

        <div className="bg-surface-container-lowest rounded-xl p-lg shadow-card border border-outline-variant/20 mb-lg">
          <div className="grid grid-cols-2 md:grid-cols-3 gap-md">
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
                <option value="">— pick supplier —</option>
                {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-label-sm block mb-xs">Template</label>
              <select value={templateId} onChange={e => setTemplateId(e.target.value)} disabled={!supplierId} className="w-full border rounded-lg px-sm py-xs">
                <option value="">— pick template —</option>
                {templates.map(t => <option key={t.id} value={t.id}>{t.name}{t.isDefault ? ' ★' : ''} ({t.rowMode})</option>)}
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
                <option value="PENDING">PENDING</option>
                <option value="EXPORTED">EXPORTED</option>
                <option value="FULFILLED">FULFILLED</option>
                <option value="SHIPPED">SHIPPED</option>
                <option value="DELIVERED">DELIVERED</option>
                <option value="CANCELLED">CANCELLED</option>
              </select>
            </div>
          </div>

          <div className="mt-md flex gap-sm items-center">
            <button onClick={runPreview} disabled={previewing || !templateId} className="px-lg py-sm rounded-lg text-label-md border disabled:opacity-50">
              {previewing ? 'Loading…' : 'Preview'}
            </button>
            <button onClick={download} disabled={downloading || !templateId} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
              {downloading ? 'Downloading…' : 'Download CSV (mark exported)'}
            </button>
            {message && <span className="text-body-sm">{message}</span>}
          </div>
        </div>

        {preview && (
          <div className="bg-surface-container-lowest rounded-xl p-lg shadow-card border border-outline-variant/20">
            <div className="flex items-center justify-between mb-md">
              <h2 className="text-headline-sm">Preview &mdash; {preview.orderCount} order(s)</h2>
              <span className="text-label-sm text-on-surface-variant">Supplier: {preview.supplierCode}</span>
            </div>
            {preview.orderCount === 0
              ? <p className="text-on-surface-variant">No orders match the filter. Adjust date range or pipeline status.</p>
              : <pre className="bg-surface-container p-sm rounded-lg text-label-sm overflow-x-auto whitespace-pre">{preview.csv}</pre>
            }
          </div>
        )}
      </main>
    </div>
  )
}
