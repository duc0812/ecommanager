'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { STATUS_COLORS, STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'

type Line = { id: string; sku: string | null; productTitle: string; previewCdnUrl: string | null; resolvedSupplierId: string | null; designStatus: string; customized: boolean }
type OrderRow = {
  id: string; shopifyOrderNumber: string; placedAt: string; updatedAt: string; pipelineStatus: PipelineStatus
  orderType: string; designReady: boolean; projectId: string; lines: Line[]
}
type Supplier = { id: string; name: string; code: string }
type Project = { id: string; name: string }
type Tab = 'TODO' | 'DONE'

const TYPE_LABEL: Record<string, string> = { CUSTOM: 'Custom', NON_CUSTOM: 'Non-custom', DUAL: 'Dual', MIXED: 'Mixed', UNKNOWN: '—' }

function hoursSince(iso: string) { return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 36e5)) }

export default function DesignStudioPage() {
  const [tab, setTab] = useState<Tab>('TODO')
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [type, setType] = useState('ALL')
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? [])).catch(() => setSuppliers([]))
    fetch('/api/projects').then(r => r.json()).then(d => setProjects(Array.isArray(d) ? d : (d.projects ?? []))).catch(() => setProjects([]))
  }, [])

  const load = useCallback(async () => {
    setLoading(true); setErr('')
    try {
      const statuses: PipelineStatus[] = tab === 'TODO' ? ['PENDING_DESIGN', 'DESIGN_REJECTED'] : ['READY_TO_PRODUCTION', 'EXPORTED', 'FULFILLED']
      const pages = await Promise.all(statuses.map(async s => {
        const qs = new URLSearchParams({ pipelineStatus: s, page: '1', pageSize: '200' })
        if (projectId) qs.set('projectId', projectId)
        if (supplierId) qs.set('supplierId', supplierId)
        if (search.trim()) qs.set('search', search.trim())
        if (tab === 'DONE') qs.set('dateFrom', new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10))
        const res = await fetch(`/api/fulfillment/orders?${qs}`)
        if (!res.ok) throw new Error(`${s}: HTTP ${res.status}`)
        return (await res.json()).orders as OrderRow[]
      }))
      let list = pages.flat()
      if (tab === 'DONE') list = list.filter(o => o.designReady && o.lines.some(l => l.customized))
      if (type !== 'ALL') list = list.filter(o => o.orderType === type)
      list.sort((a, b) => new Date(a.placedAt).getTime() - new Date(b.placedAt).getTime())
      setOrders(list)
    } catch (e: any) { setErr(e.message) } finally { setLoading(false) }
  }, [tab, projectId, supplierId, type, search])
  useEffect(() => { load() }, [load])

  const supplierName = useMemo(() => new Map(suppliers.map(s => [s.id, s.code || s.name])), [suppliers])

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-end gap-md mb-lg">
          <div>
            <h1 className="text-headline-lg text-on-surface">Design Studio</h1>
            <p className="text-body-sm text-on-surface-variant">Mỗi đơn là một workspace: thông tin custom, supplier, template, artwork.</p>
          </div>
          <div className="ml-auto flex gap-xs bg-surface-container rounded-lg p-xs">
            {(['TODO', 'DONE'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-md py-xs rounded-md text-label-sm ${tab === t ? 'bg-surface-container-lowest shadow-card text-on-surface' : 'text-on-surface-variant'}`}>
                {t === 'TODO' ? 'Cần design' : 'Đã xong 7 ngày'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap gap-sm mb-md">
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Tìm số đơn / SKU" aria-label="Tìm đơn"
            className="px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm" />
          <select value={projectId} onChange={e => setProjectId(e.target.value)} aria-label="Store" className="px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm">
            <option value="">Mọi store</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <select value={supplierId} onChange={e => setSupplierId(e.target.value)} aria-label="Supplier" className="px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm">
            <option value="">Mọi supplier</option>
            {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={type} onChange={e => setType(e.target.value)} aria-label="Loại đơn" className="px-md py-sm rounded-lg border border-outline-variant/40 bg-surface-container-lowest text-body-sm">
            <option value="ALL">Mọi loại</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
          <span className="self-center text-body-sm text-on-surface-variant">{loading ? 'Đang tải…' : `${orders.length} đơn`}</span>
        </div>
        {err && <div className="mb-md px-md py-sm rounded-lg bg-error-container text-on-error-container text-body-sm">{err}</div>}

        <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container-low text-label-sm text-on-surface-variant">
              <tr>
                <th className="text-left px-lg py-sm">Đơn</th>
                <th className="text-left px-md py-sm">Ngày</th>
                <th className="text-left px-md py-sm">Loại</th>
                <th className="text-left px-md py-sm">Dòng</th>
                <th className="text-left px-md py-sm">Supplier</th>
                <th className="text-left px-md py-sm">Preview</th>
                <th className="text-right px-md py-sm">Chờ</th>
                <th className="text-left px-md py-sm">Trạng thái</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const sups = Array.from(new Set(o.lines.map(l => l.resolvedSupplierId).filter(Boolean) as string[])).map(id => supplierName.get(id) ?? '?')
                const preview = o.lines.find(l => l.previewCdnUrl)?.previewCdnUrl
                const h = hoursSince(o.placedAt)
                return (
                  <tr key={o.id} className="border-t border-outline-variant/20 hover:bg-surface-container-low">
                    <td className="px-lg py-sm">
                      <Link href={`/design-studio/${encodeURIComponent(o.id)}`} className="text-secondary font-semibold hover:underline">{o.shopifyOrderNumber}</Link>
                    </td>
                    <td className="px-md py-sm">{new Date(o.placedAt).toLocaleDateString('en-US')}</td>
                    <td className="px-md py-sm">{TYPE_LABEL[o.orderType] ?? o.orderType}</td>
                    <td className="px-md py-sm">{o.lines.filter(l => l.sku).length}</td>
                    <td className="px-md py-sm">{sups.join(', ') || <span className="text-on-surface-variant">chưa map</span>}</td>
                    <td className="px-md py-sm">{preview ? <img src={preview} alt="" className="w-10 h-10 rounded-md object-cover border border-outline-variant/30" /> : '—'}</td>
                    <td className={`px-md py-sm text-right ${h > 24 ? 'text-error font-semibold' : ''}`}>{h}h</td>
                    <td className="px-md py-sm"><span className={`px-sm py-xs rounded-md text-label-sm ${STATUS_COLORS[o.pipelineStatus]}`}>{STATUS_LABELS[o.pipelineStatus]}</span></td>
                  </tr>
                )
              })}
              {!loading && orders.length === 0 && (
                <tr><td colSpan={8} className="px-lg py-xl text-center text-on-surface-variant">Không có đơn nào.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
