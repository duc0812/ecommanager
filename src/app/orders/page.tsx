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
  grossAmount: number
  subtotalAmount: number
  shippingAmount: number
  taxAmount: number
  expectedPayout: number
  financialStatus: string
  fulfillmentStatus: string | null
  shopTimezone: string | null
  store: { id: string; shop: string; ianaTimezone: string | null } | null
  pipelineStatus: PipelineStatus
  shippingZone: string | null
  shippingCountry: string | null
  shippingState: string | null
  shippingName: string | null
  shippingAddress1: string | null
  shippingAddress2: string | null
  shippingCity: string | null
  shippingZip: string | null
  shippingPhone: string | null
  defaultSupplier: { id: string; name: string } | null
  lines: Array<{
    id: string
    lineKey: string
    sku: string | null
    productTitle: string
    variantTitle: string | null
    variantOptions: string | null
    qty: number
    unitPrice: number
    resolvedSupplierSku: string | null
    resolvedBaseCost: number | null
    designDriveLink: string | null
    previewCdnUrl: string | null
  }>
  computed: { baseCost: number; shipping: number; profit: number; margin: number; hasUnmappedSku: boolean }
  mappingSummary: { mapped: number; total: number; complete: boolean }
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

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) {
    throw new Error(text || `${url} failed with ${res.status}`)
  }
  if (!text) throw new Error(`${url} returned an empty response`)
  return JSON.parse(text) as T
}

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
  const [selectedOrder, setSelectedOrder] = useState<OrderRow | null>(null)

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
    try {
      const [oRes, sRes, cRes] = await Promise.all([
        fetchJson<{ orders?: OrderRow[] }>(`/api/fulfillment/orders${qs}`),
        fetchJson<Summary>(`/api/fulfillment/pl-summary${qs}`),
        fetchJson<StatusCounts>(`/api/fulfillment/status-counts${countsQs}`),
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
      setSyncResult('')
    } catch (e: any) {
      setSyncResult(`Load orders failed: ${e.message}`)
    }
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
    new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(Number.isFinite(n) ? n : 0)

  const formatShopifyDate = (iso: string, timeZone?: string | null) =>
    new Intl.DateTimeFormat('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
      timeZone: timeZone || 'UTC',
    }).format(new Date(iso))

  const compactShopifyDate = (iso: string, timeZone?: string | null) => {
    const dt = new Date(iso)
    const zone = timeZone || 'UTC'
    return {
      date: new Intl.DateTimeFormat('en-US', {
        month: 'short',
        day: 'numeric',
        timeZone: zone,
      }).format(dt),
      time: new Intl.DateTimeFormat('en-US', {
        hour: 'numeric',
        minute: '2-digit',
        hour12: true,
        timeZone: zone,
      }).format(dt),
    }
  }

  const titleCaseStatus = (status: string | null | undefined) =>
    status ? status.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Unfulfilled'

  const statusTone = (status: string | null | undefined) => {
    const s = status?.toUpperCase()
    if (s === 'FULFILLED') return 'bg-tertiary/15 text-tertiary'
    if (s === 'PARTIALLY_FULFILLED') return 'bg-secondary/10 text-secondary'
    return 'bg-surface-container text-on-surface-variant'
  }

  const variantLabel = (line: OrderRow['lines'][number]) => {
    if (line.variantTitle) return line.variantTitle
    if (!line.variantOptions) return '—'
    try {
      const parsed = JSON.parse(line.variantOptions) as Record<string, string>
      const entries = Object.entries(parsed)
      return entries.length > 0 ? entries.map(([k, v]) => `${k}: ${v}`).join(', ') : '—'
    } catch {
      return line.variantOptions
    }
  }

  const orderTimeZone = (order: OrderRow) =>
    order.shopTimezone ?? order.store?.ianaTimezone ?? null

  const allCount = counts ? PIPELINE_STATUSES.reduce((s, k) => s + (counts[k] ?? 0), 0) : 0

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] w-[calc(100vw-280px)] min-w-0 overflow-x-hidden p-xl">
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
        <div className="flex flex-wrap items-center gap-x-md gap-y-xs mb-md border-b border-outline-variant/20">
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
          <table className="w-full table-fixed text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="w-9 px-sm py-sm">
                  <input
                    type="checkbox"
                    checked={selected.size === orders.length && orders.length > 0}
                    onChange={toggleAll}
                  />
                </th>
                <th className="w-[8%] px-sm py-sm">Order #</th>
                <th className="w-[7%] px-sm py-sm">Mapping</th>
                <th className="w-[7%] px-sm py-sm">Type</th>
                <th className="w-[6%] px-sm py-sm">Design</th>
                <th className="w-[7%] px-sm py-sm">Trello</th>
                <th className="w-[8%] px-sm py-sm">Order status</th>
                <th className="w-[9%] px-sm py-sm">Supplier</th>
                <th className="w-[7%] px-sm py-sm">Zone</th>
                <th className="w-[7%] px-sm py-sm text-right">Payout</th>
                <th className="w-[7%] px-sm py-sm text-right">COGS</th>
                <th className="w-[7%] px-sm py-sm text-right">Profit</th>
                <th className="w-[6%] px-sm py-sm text-right">Margin</th>
                <th className="w-[7%] px-sm py-sm">Date</th>
                <th className="w-[11%] px-sm py-sm">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr
                  key={o.id}
                  className={`border-t border-outline-variant/20 ${o.computed.hasUnmappedSku ? 'bg-error/5' : ''}`}
                >
                  <td className="px-sm py-sm">
                    <input
                      type="checkbox"
                      checked={selected.has(o.id)}
                      onChange={() => toggleSelect(o.id)}
                    />
                  </td>
                  <td className="px-sm py-sm truncate">
                    <button
                      type="button"
                      onClick={() => setSelectedOrder(o)}
                      className="font-mono text-secondary underline underline-offset-2"
                    >
                      {o.shopifyOrderNumber}
                    </button>
                  </td>
                  <td className="px-sm py-sm">
                    <span className={`text-label-sm ${o.mappingSummary.complete ? 'text-tertiary' : 'text-error'}`}>
                      {o.mappingSummary.mapped}/{o.mappingSummary.total}
                    </span>
                  </td>
                  <td className="px-sm py-sm">
                    {o.orderType === 'CUSTOM' && (
                      <span className="bg-tertiary/15 text-tertiary text-label-sm px-xs py-[2px] rounded">Custom</span>
                    )}
                    {o.orderType === 'NON_CUSTOM' && (
                      <span className="bg-surface-container text-on-surface-variant text-label-sm px-xs py-[2px] rounded">Non-Custom</span>
                    )}
                    {o.orderType === 'UNKNOWN' && (
                      <span className="text-label-sm text-on-surface-variant">-</span>
                    )}
                  </td>
                  <td className="px-sm py-sm">
                    {o.designReady ? (
                      <span className="text-label-sm text-tertiary font-medium">Done</span>
                    ) : (
                      <span className="text-label-sm text-on-surface-variant">-</span>
                    )}
                  </td>
                  <td className="px-sm py-sm truncate">
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
                  <td className="px-sm py-sm">
                    <span className={`rounded px-xs py-[2px] text-label-sm ${statusTone(o.fulfillmentStatus)}`}>
                      {titleCaseStatus(o.fulfillmentStatus)}
                    </span>
                  </td>
                  <td className="px-sm py-sm truncate">
                    {o.defaultSupplier?.name ?? (
                      <span className="text-error text-label-sm">unmapped</span>
                    )}
                  </td>
                  <td className="px-sm py-sm">
                    <span className="font-mono text-label-sm">{o.shippingZone ?? '—'}</span>
                    {o.shippingCountry && (
                      <span className="text-label-sm text-on-surface-variant ml-xs">({o.shippingCountry})</span>
                    )}
                  </td>
                  <td className="px-sm py-sm text-right">{fmt(o.expectedPayout, o.currency)}</td>
                  <td className="px-sm py-sm text-right">
                    {fmt(o.computed.baseCost + o.computed.shipping, o.currency)}
                  </td>
                  <td
                    className={`px-sm py-sm text-right font-semibold ${
                      o.computed.profit >= 0 ? 'text-on-tertiary-container' : 'text-error'
                    }`}
                  >
                    {fmt(o.computed.profit, o.currency)}
                  </td>
                  <td className="px-sm py-sm text-right">{o.computed.margin.toFixed(1)}%</td>
                  <td className="px-sm py-sm text-label-sm text-on-surface-variant">
                    {(() => {
                      const parts = compactShopifyDate(o.placedAt, orderTimeZone(o))
                      return (
                        <div className="leading-tight">
                          <div>{parts.date}</div>
                          <div>{parts.time}</div>
                        </div>
                      )
                    })()}
                  </td>
                  <td className="px-sm py-sm">
                    <select
                      value={o.pipelineStatus}
                      onChange={e => changeOneStatus(o.id, e.target.value as PipelineStatus)}
                      className={`w-full text-label-sm rounded px-xs py-[2px] ${STATUS_COLORS[o.pipelineStatus]}`}
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
                  <td colSpan={15} className="px-md py-lg text-center text-on-surface-variant">
                    No orders match filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {selectedOrder && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-lg">
            <div className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-xl bg-surface-container-lowest shadow-xl">
              <div className="sticky top-0 flex items-start justify-between gap-md border-b border-outline-variant/20 bg-surface-container-lowest p-lg">
                <div>
                  <h2 className="text-headline-sm font-semibold">{selectedOrder.shopifyOrderNumber}</h2>
                  <div className="mt-xs flex flex-wrap items-center gap-xs text-body-sm text-on-surface-variant">
                    <span>{formatShopifyDate(selectedOrder.placedAt, orderTimeZone(selectedOrder))}</span>
                    <span className={`rounded px-xs py-[2px] text-label-sm ${statusTone(selectedOrder.fulfillmentStatus)}`}>
                      {titleCaseStatus(selectedOrder.fulfillmentStatus)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => setSelectedOrder(null)}
                  className="rounded-lg border border-outline-variant/40 px-md py-xs text-label-md"
                >
                  Close
                </button>
              </div>

              <div className="grid gap-lg p-lg lg:grid-cols-[1fr_320px]">
                <div>
                  <h3 className="mb-sm text-label-md">Line items</h3>
                  <div className="overflow-hidden rounded-lg border border-outline-variant/20">
                    <table className="w-full text-body-sm">
                      <thead className="bg-surface-container">
                        <tr className="text-left">
                          <th className="px-md py-sm">Product</th>
                          <th className="px-md py-sm">Line key</th>
                          <th className="px-md py-sm">SKU</th>
                          <th className="px-md py-sm">Variant</th>
                          <th className="px-md py-sm text-right">Qty</th>
                          <th className="px-md py-sm text-right">Price</th>
                          <th className="px-md py-sm text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedOrder.lines.map(line => (
                          <tr key={line.id} className="border-t border-outline-variant/20">
                            <td className="px-md py-sm">{line.productTitle}</td>
                            <td className="px-md py-sm font-mono">{line.lineKey}</td>
                            <td className="px-md py-sm font-mono">{line.sku ?? '—'}</td>
                            <td className="px-md py-sm">{variantLabel(line)}</td>
                            <td className="px-md py-sm text-right">{line.qty}</td>
                            <td className="px-md py-sm text-right">{fmt(line.unitPrice, selectedOrder.currency)}</td>
                            <td className="px-md py-sm text-right">{fmt(line.unitPrice * line.qty, selectedOrder.currency)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="space-y-md">
                  <section className="rounded-lg border border-outline-variant/20 p-md">
                    <h3 className="mb-sm text-label-md">Customer</h3>
                    <p className="text-body-sm">{selectedOrder.customerName ?? '—'}</p>
                    <p className="text-body-sm text-on-surface-variant">{selectedOrder.customerEmail ?? '—'}</p>
                    {selectedOrder.shippingPhone && (
                      <p className="text-body-sm text-on-surface-variant">{selectedOrder.shippingPhone}</p>
                    )}
                    {(selectedOrder.shippingName || selectedOrder.shippingAddress1 || selectedOrder.shippingCity) && (
                      <div className="mt-sm space-y-[2px] border-t border-outline-variant/20 pt-sm text-body-sm text-on-surface-variant">
                        <p>{selectedOrder.shippingName ?? selectedOrder.customerName}</p>
                        {selectedOrder.shippingAddress1 && <p>{selectedOrder.shippingAddress1}</p>}
                        {selectedOrder.shippingAddress2 && <p>{selectedOrder.shippingAddress2}</p>}
                        {(selectedOrder.shippingCity || selectedOrder.shippingState || selectedOrder.shippingZip) && (
                          <p>
                            {[selectedOrder.shippingCity, selectedOrder.shippingState, selectedOrder.shippingZip]
                              .filter(Boolean)
                              .join(', ')}
                          </p>
                        )}
                        {selectedOrder.shippingCountry && <p>{selectedOrder.shippingCountry}</p>}
                      </div>
                    )}
                  </section>

                  <section className="rounded-lg border border-outline-variant/20 p-md">
                    <h3 className="mb-sm text-label-md">Fulfillment</h3>
                    <dl className="space-y-xs text-body-sm">
                      <div className="flex justify-between gap-md">
                        <dt className="text-on-surface-variant">Supplier</dt>
                        <dd>{selectedOrder.defaultSupplier?.name ?? 'unmapped'}</dd>
                      </div>
                      <div className="flex justify-between gap-md">
                        <dt className="text-on-surface-variant">Zone</dt>
                        <dd>{selectedOrder.shippingZone ?? '—'} {selectedOrder.shippingCountry ? `(${selectedOrder.shippingCountry})` : ''}</dd>
                      </div>
                      <div className="flex justify-between gap-md">
                        <dt className="text-on-surface-variant">Financial</dt>
                        <dd>{selectedOrder.financialStatus}</dd>
                      </div>
                      <div className="flex justify-between gap-md">
                        <dt className="text-on-surface-variant">Fulfillment</dt>
                        <dd>{selectedOrder.fulfillmentStatus ?? '—'}</dd>
                      </div>
                    </dl>
                  </section>
                </div>
              </div>
            </div>
          </div>
        )}
      </main>
    </div>
  )
}
