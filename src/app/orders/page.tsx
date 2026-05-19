'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { PIPELINE_STATUSES, STATUS_LABELS, STATUS_COLORS, type PipelineStatus } from '@/lib/pipeline-status'

type OrderRow = {
  id: string
  shopifyOrderNumber: string
  customerName: string | null
  customerEmail: string | null
  placedAt: string
  currency: string
  expectedPayout: number
  pipelineStatus: PipelineStatus
  shippingZone: string | null
  shippingCountry: string | null
  defaultSupplier: { id: string; name: string } | null
  lines: Array<{ id: string; sku: string | null; productTitle: string; qty: number }>
  computed: { baseCost: number; shipping: number; profit: number; margin: number; hasUnmappedSku: boolean }
  orderType: string           // "CUSTOM" | "NON_CUSTOM" | "UNKNOWN"
  trelloCardId: string | null
  trelloCardUrl: string | null
  designReady: boolean
}

type Summary = {
  orderCount: number; revenue: number; cogs: number; shipping: number
  profit: number; margin: number; avgProfit: number; unmappedCount: number
}

type Project = { id: string; name: string; shopifyStore: { shop: string } | null }
type Supplier = { id: string; name: string }
type StatusCounts = Record<PipelineStatus, number>

export default function OrdersPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [projectId, setProjectId] = useState<string>('')
  const [activeTab, setActiveTab] = useState<'ALL' | PipelineStatus>('ALL')
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [supplierId, setSupplierId] = useState('')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [showUnmappedOnly, setShowUnmappedOnly] = useState(false)

  const [orders, setOrders] = useState<OrderRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [counts, setCounts] = useState<StatusCounts | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkStatus, setBulkStatus] = useState<PipelineStatus>('EXPORTED')
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState('')
  const [syncingTrello, setSyncingTrello] = useState(false)
  const [trelloResult, setTrelloResult] = useState('')
  const [typeFilter, setTypeFilter] = useState<'ALL' | 'CUSTOM' | 'NON_CUSTOM'>('ALL')
  const [designFilter, setDesignFilter] = useState<'ALL' | 'HAS' | 'MISSING'>('ALL')
  const [trelloFilter, setTrelloFilter] = useState<'ALL' | 'CREATED' | 'NOT_CREATED'>('ALL')

  // Initial fetch of projects and suppliers
  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(d => {
      setProjects(Array.isArray(d) ? d : (d.projects ?? []))
    })
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? []))
  }, [])

  // Debounce search input
  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  // Build filter query string (shared by orders + pl-summary)
  const queryString = useMemo(() => {
    const q = new URLSearchParams()
    if (projectId) q.set('projectId', projectId)
    if (activeTab !== 'ALL') q.set('pipelineStatus', activeTab)
    if (searchDebounced) q.set('search', searchDebounced)
    if (supplierId) q.set('supplierId', supplierId)
    if (dateFrom) q.set('dateFrom', dateFrom)
    if (dateTo) q.set('dateTo', dateTo)
    return q.toString()
  }, [projectId, activeTab, searchDebounced, supplierId, dateFrom, dateTo])

  const load = useCallback(async () => {
    const qs = queryString ? '?' + queryString : ''
    // status-counts responds only to projectId — intentional (tab counts show all statuses for the project)
    const countsQs = projectId ? '?projectId=' + projectId : ''
    const [oRes, sRes, cRes] = await Promise.all([
      fetch(`/api/fulfillment/orders${qs}`).then(r => r.json()),
      fetch(`/api/fulfillment/pl-summary${qs}`).then(r => r.json()),
      fetch(`/api/fulfillment/status-counts${countsQs}`).then(r => r.json()),
    ])
    let list: OrderRow[] = oRes.orders ?? []
    if (showUnmappedOnly) list = list.filter(o => o.computed.hasUnmappedSku)
    if (typeFilter !== 'ALL') list = list.filter(o => o.orderType === typeFilter)
    if (designFilter === 'HAS') list = list.filter(o => o.orderType === 'NON_CUSTOM' && o.designReady)
    if (designFilter === 'MISSING') list = list.filter(o => o.orderType === 'NON_CUSTOM' && !o.designReady)
    if (trelloFilter === 'CREATED') list = list.filter(o => o.trelloCardId != null)
    if (trelloFilter === 'NOT_CREATED') list = list.filter(o => o.trelloCardId == null)
    setOrders(list)
    setSummary(sRes)
    setCounts(cRes)
    setSelected(new Set())
  }, [queryString, projectId, showUnmappedOnly, typeFilter, designFilter, trelloFilter])

  useEffect(() => { load() }, [load])

  const syncTrello = async () => {
    setSyncingTrello(true); setTrelloResult('Đang sync Trello...')
    try {
      const res = await fetch('/api/trello/sync', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) setTrelloResult(`Lỗi: ${body.error ?? res.statusText}`)
      else setTrelloResult(`Đã cập nhật ${body.updated} design(s) từ ${body.cardsChecked} card DONE.`)
      await load()
    } catch (e: any) { setTrelloResult(`Lỗi: ${e.message}`) }
    finally { setSyncingTrello(false) }
  }

  const sync = async () => {
    setSyncing(true); setSyncResult('Syncing...')
    try {
      const res = await fetch('/api/shopify/orders/sync', {
        method: 'POST',
      })
      const body = await res.json()
      if (!res.ok) setSyncResult(`Error: ${body.error ?? res.statusText}`)
      else setSyncResult(`Synced ${body.totalSynced} order(s) (${body.withUnmappedSku} unmapped) into "${body.projectName}".`)
      await load()
    } catch (e: any) { setSyncResult(`Error: ${e.message}`) }
    finally { setSyncing(false) }
  }

  const changeOneStatus = async (id: string, status: PipelineStatus) => {
    await fetch(`/api/fulfillment/orders/${id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    })
    await load()
  }

  const applyBulk = async () => {
    if (selected.size === 0) return
    if (!confirm(`Change ${selected.size} order(s) to ${STATUS_LABELS[bulkStatus]}?`)) return
    await fetch('/api/fulfillment/orders/bulk-status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ orderIds: Array.from(selected), status: bulkStatus }),
    })
    await load()
  }

  const toggleSelect = (id: string) => {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }

  const toggleAll = () => {
    if (selected.size === orders.length) setSelected(new Set())
    else setSelected(new Set(orders.map(o => o.id)))
  }

  const fmt = (n: number, cur = 'USD') =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n)

  const allCount = counts ? PIPELINE_STATUSES.reduce((s, k) => s + (counts[k] ?? 0), 0) : 0

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-lg gap-md">
          <h1 className="text-display-md">All Orders</h1>
          <div className="flex items-center gap-sm">
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className="border rounded-lg px-md py-sm text-body-sm"
            >
              <option value="">All projects</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.shopifyStore ? ` · ${p.shopifyStore.shop}` : ''}
                </option>
              ))}
            </select>
            <button
              onClick={syncTrello}
              disabled={syncingTrello}
              className="border border-outline-variant/40 px-lg py-sm rounded-lg text-label-md disabled:opacity-50"
            >
              {syncingTrello ? 'Syncing…' : 'Sync Trello'}
            </button>
            <button
              onClick={sync}
              disabled={syncing}
              className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Sync Now'}
            </button>
          </div>
        </div>
        {syncResult && <p className="mb-md text-body-sm text-on-surface-variant">{syncResult}</p>}
        {trelloResult && <p className="mb-md text-body-sm text-on-surface-variant">{trelloResult}</p>}

        {/* Search + More filters */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 mb-md">
          <div className="flex items-center gap-sm p-md">
            <span className="material-symbols-outlined text-on-surface-variant">search</span>
            <input
              placeholder="Filter by order number, customer name, or email"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="flex-1 outline-none bg-transparent text-body-sm"
            />
            <button
              onClick={() => setShowFilters(!showFilters)}
              className="text-label-md border rounded-lg px-md py-sm"
            >
              {showFilters ? 'Hide filters' : 'More filters'}
            </button>
          </div>
          {showFilters && (
            <div className="border-t border-outline-variant/20 p-md grid grid-cols-2 md:grid-cols-4 gap-md">
              <div>
                <label className="text-label-sm block mb-xs">Supplier</label>
                <select
                  value={supplierId}
                  onChange={e => setSupplierId(e.target.value)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                >
                  <option value="">All</option>
                  {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Date from</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={e => setDateFrom(e.target.value)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                />
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Date to</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={e => setDateTo(e.target.value)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                />
              </div>
              <div className="flex items-end">
                <label className="flex items-center gap-sm text-body-sm">
                  <input
                    type="checkbox"
                    checked={showUnmappedOnly}
                    onChange={e => setShowUnmappedOnly(e.target.checked)}
                  />
                  Show unmapped SKU only
                </label>
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Loại đơn</label>
                <select
                  value={typeFilter}
                  onChange={e => setTypeFilter(e.target.value as any)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                >
                  <option value="ALL">Tất cả</option>
                  <option value="CUSTOM">Custom</option>
                  <option value="NON_CUSTOM">Non-Custom</option>
                </select>
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Design</label>
                <select
                  value={designFilter}
                  onChange={e => setDesignFilter(e.target.value as any)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                >
                  <option value="ALL">Tất cả</option>
                  <option value="HAS">Đã có</option>
                  <option value="MISSING">Chưa có</option>
                </select>
              </div>
              <div>
                <label className="text-label-sm block mb-xs">Trello</label>
                <select
                  value={trelloFilter}
                  onChange={e => setTrelloFilter(e.target.value as any)}
                  className="w-full border rounded-lg px-sm py-xs text-body-sm"
                >
                  <option value="ALL">Tất cả</option>
                  <option value="CREATED">Đã tạo card</option>
                  <option value="NOT_CREATED">Chưa tạo</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Status tabs */}
        <div className="flex items-center gap-md mb-md border-b border-outline-variant/20 overflow-x-auto">
          <button
            onClick={() => setActiveTab('ALL')}
            className={`px-sm py-sm text-label-md whitespace-nowrap ${
              activeTab === 'ALL'
                ? 'border-b-2 border-secondary text-secondary'
                : 'text-on-surface-variant'
            }`}
          >
            All <span className="text-label-sm ml-xs">{allCount}</span>
          </button>
          {PIPELINE_STATUSES.map(s => {
            const c = counts?.[s] ?? 0
            return (
              <button
                key={s}
                onClick={() => setActiveTab(s)}
                className={`px-sm py-sm text-label-md whitespace-nowrap ${
                  activeTab === s
                    ? 'border-b-2 border-secondary text-secondary'
                    : 'text-on-surface-variant'
                }`}
              >
                {STATUS_LABELS[s]}{c > 0 && <span className="text-label-sm ml-xs">{c}</span>}
              </button>
            )
          })}
        </div>

        {/* Stats cards */}
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-md mb-lg">
            {[
              { label: 'Revenue', value: fmt(summary.revenue) },
              { label: 'COGS', value: fmt(summary.cogs + summary.shipping) },
              { label: 'Profit', value: fmt(summary.profit) },
              { label: 'Margin', value: `${summary.margin.toFixed(1)}%` },
              { label: 'Orders', value: String(summary.orderCount) },
            ].map(s => (
              <div
                key={s.label}
                className="bg-surface-container-lowest rounded-xl p-md shadow-card border border-outline-variant/20"
              >
                <p className="text-label-sm text-on-surface-variant">{s.label}</p>
                <p className="text-stats-lg">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {summary && summary.unmappedCount > 0 && (
          <div className="bg-error/10 border border-error/30 rounded-lg p-md mb-md text-body-sm">
            {'⚠'} {summary.unmappedCount} order(s) có SKU thiếu mapping — Profit có thể không chính xác.
          </div>
        )}

        {/* Bulk action bar */}
        {selected.size > 0 && (
          <div className="bg-surface-container rounded-xl p-md mb-md flex items-center gap-sm">
            <span className="text-body-sm">{selected.size} selected</span>
            <select
              value={bulkStatus}
              onChange={e => setBulkStatus(e.target.value as PipelineStatus)}
              className="border rounded-lg px-sm py-xs text-body-sm"
            >
              {PIPELINE_STATUSES.map(s => (
                <option key={s} value={s}>{STATUS_LABELS[s]}</option>
              ))}
            </select>
            <button
              onClick={applyBulk}
              className="bg-secondary text-on-secondary px-md py-xs rounded-lg text-label-md"
            >
              Apply
            </button>
            <button
              onClick={() => setSelected(new Set())}
              className="text-label-md text-on-surface-variant"
            >
              Clear
            </button>
          </div>
        )}

        {/* Orders table */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="px-md py-sm">
                  <input
                    type="checkbox"
                    checked={selected.size === orders.length && orders.length > 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="px-md py-sm">Order #</th>
                <th className="px-md py-sm">Loại</th>
                <th className="px-md py-sm">Design</th>
                <th className="px-md py-sm">Trello</th>
                <th className="px-md py-sm">Customer</th>
                <th className="px-md py-sm">Date</th>
                <th className="px-md py-sm">Supplier</th>
                <th className="px-md py-sm">Zone</th>
                <th className="px-md py-sm text-right">Payout</th>
                <th className="px-md py-sm text-right">COGS</th>
                <th className="px-md py-sm text-right">Profit</th>
                <th className="px-md py-sm text-right">Margin</th>
                <th className="px-md py-sm">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr
                  key={o.id}
                  className={`border-t border-outline-variant/20 ${o.computed.hasUnmappedSku ? 'bg-error/5' : ''}`}
                >
                  <td className="px-md py-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(o.id)}
                      onChange={() => toggleSelect(o.id)}
                    />
                  </td>
                  <td className="px-md py-sm font-mono">{o.shopifyOrderNumber}</td>
                  <td className="px-md py-sm">
                    {o.orderType === 'CUSTOM' && (
                      <span className="bg-tertiary/15 text-tertiary text-label-sm px-xs py-[2px] rounded">Custom</span>
                    )}
                    {o.orderType === 'NON_CUSTOM' && (
                      <span className="bg-surface-container text-on-surface-variant text-label-sm px-xs py-[2px] rounded">Non-Custom</span>
                    )}
                    {o.orderType === 'UNKNOWN' && (
                      <span className="text-label-sm text-on-surface-variant">—</span>
                    )}
                  </td>
                  <td className="px-md py-sm">
                    {o.orderType === 'NON_CUSTOM' ? (
                      o.designReady
                        ? <span className="text-label-sm text-tertiary font-medium">Đã có</span>
                        : <span className="text-label-sm text-on-surface-variant">—</span>
                    ) : (
                      <span className="text-label-sm text-on-surface-variant">—</span>
                    )}
                  </td>
                  <td className="px-md py-sm">
                    {o.trelloCardUrl ? (
                      <a
                        href={o.trelloCardUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-label-sm text-secondary underline"
                      >
                        Xem card
                      </a>
                    ) : (
                      <span className="text-label-sm text-on-surface-variant">—</span>
                    )}
                  </td>
                  <td className="px-md py-sm">
                    <div>{o.customerName ?? '—'}</div>
                    {o.customerEmail && (
                      <div className="text-label-sm text-on-surface-variant">{o.customerEmail}</div>
                    )}
                  </td>
                  <td className="px-md py-sm">{new Date(o.placedAt).toLocaleDateString('en-CA')}</td>
                  <td className="px-md py-sm">
                    {o.defaultSupplier?.name ?? (
                      <span className="text-error text-label-sm">unmapped</span>
                    )}
                  </td>
                  <td className="px-md py-sm">
                    <span className="font-mono text-label-sm">{o.shippingZone ?? '—'}</span>
                    {o.shippingCountry && (
                      <span className="text-label-sm text-on-surface-variant ml-xs">({o.shippingCountry})</span>
                    )}
                  </td>
                  <td className="px-md py-sm text-right">{fmt(o.expectedPayout, o.currency)}</td>
                  <td className="px-md py-sm text-right">
                    {fmt(o.computed.baseCost + o.computed.shipping, o.currency)}
                  </td>
                  <td
                    className={`px-md py-sm text-right font-semibold ${
                      o.computed.profit >= 0 ? 'text-on-tertiary-container' : 'text-error'
                    }`}
                  >
                    {fmt(o.computed.profit, o.currency)}
                  </td>
                  <td className="px-md py-sm text-right">{o.computed.margin.toFixed(1)}%</td>
                  <td className="px-md py-sm">
                    <select
                      value={o.pipelineStatus}
                      onChange={e => changeOneStatus(o.id, e.target.value as PipelineStatus)}
                      className={`text-label-sm rounded px-xs py-[2px] ${STATUS_COLORS[o.pipelineStatus]}`}
                    >
                      {PIPELINE_STATUSES.map(s => (
                        <option key={s} value={s}>{STATUS_LABELS[s]}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={14} className="px-md py-lg text-center text-on-surface-variant">
                    No orders match filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
