'use client'
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { parseTrackingCheckpoints, type TrackingCheckpoint } from '@/lib/tracking/tracking-status'

type ShipmentRow = {
  id: string
  lineKey: string
  trackingNumber: string | null
  carrier: string | null
  detectedCarrier: string | null
  trackingUrl: string | null
  status: string
  internalStatus: string | null
  lastMileCarrier: string | null
  lastMileTrackingNumber: string | null
  checkpointsJson: string | null
  lastCheckpointAt: string | null
  crawlSource: string | null
  crawledAt: string | null
  crawlError: string | null
  supplier: { id: string; name: string } | null
  order: {
    id: string
    shopifyOrderNumber: string
    placedAt: string
    shopTimezone: string | null
    project: { id: string; name: string } | null
  } | null
}

type Stats = {
  total: number
  withTracking: number
  withoutTracking: number
  internallyTracked: number
  internalDelivered: number
}
type Project = { id: string; name: string }
type Supplier = { id: string; name: string }

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const text = await res.text()
  if (!res.ok) throw new Error(text || `${url} failed with ${res.status}`)
  return JSON.parse(text) as T
}

function statusTone(status: string): string {
  const s = status.toUpperCase()
  if (s === 'DELIVERED') return 'bg-tertiary/15 text-tertiary'
  if (s === 'IN_TRANSIT' || s === 'OUT_FOR_DELIVERY' || s === 'FULFILLED' || s === 'INFO_RECEIVED') return 'bg-secondary/10 text-secondary'
  if (s === 'ATTEMPTED_DELIVERY' || s === 'FAILURE' || s === 'EXCEPTION' || s === 'FAILED_ATTEMPT' || s === 'EXPIRED') return 'bg-error/10 text-error'
  return 'bg-surface-container text-on-surface-variant'
}

function prettyStatus(status: string): string {
  return status.toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export default function TrackingPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [projectId, setProjectId] = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [hasTracking, setHasTracking] = useState<'' | 'yes' | 'no'>('')
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')

  const [shipments, setShipments] = useState<ShipmentRow[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [crawling, setCrawling] = useState(false)
  const [message, setMessage] = useState('')
  const [expandedId, setExpandedId] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(d => setProjects(Array.isArray(d) ? d : (d.projects ?? [])))
    fetch('/api/suppliers').then(r => r.json()).then(d => setSuppliers(d.suppliers ?? []))
  }, [])

  useEffect(() => {
    const t = setTimeout(() => setSearchDebounced(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const queryString = useMemo(() => {
    const q = new URLSearchParams()
    if (projectId) q.set('projectId', projectId)
    if (supplierId) q.set('supplierId', supplierId)
    if (hasTracking) q.set('hasTracking', hasTracking)
    if (searchDebounced) q.set('search', searchDebounced)
    return q.toString()
  }, [projectId, supplierId, hasTracking, searchDebounced])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = queryString ? '?' + queryString : ''
      const data = await fetchJson<{ shipments: ShipmentRow[]; stats: Stats }>(`/api/fulfillment/tracking${qs}`)
      setShipments(data.shipments)
      setStats(data.stats)
    } catch (e: any) {
      setMessage(`Load thất bại: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [queryString])

  useEffect(() => { load() }, [load])

  const sync = async () => {
    setSyncing(true)
    setMessage('Đang sync tracking 30 ngày gần nhất...')
    try {
      const res = await fetch('/api/fulfillment/tracking/sync?days=30', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setMessage(`Lỗi: ${body.error ?? res.statusText}`)
      } else {
        setMessage(
          `Đã sync ${body.shipmentCount} shipment từ ${body.ordersProcessed} đơn — ${body.withTracking} có tracking, ${body.withoutTracking} chưa có (project "${body.projectName}").`,
        )
        await load()
      }
    } catch (e: any) {
      setMessage(`Lỗi: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  const crawl = async () => {
    setCrawling(true)
    setMessage('Đang crawl Status 2 bằng headless browser (có thể mất vài phút)...')
    try {
      const res = await fetch('/api/fulfillment/tracking/crawl?scope=undelivered', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setMessage(`Lỗi crawl: ${body.error ?? res.statusText}`)
      } else {
        const byStatus = Object.entries(body.byStatus ?? {}).map(([k, v]) => `${k}: ${v}`).join(', ')
        setMessage(`Status 2: đã crawl ${body.numbersCrawled} tracking — ${body.withEvents} có hành trình. ${byStatus}${body.errors?.length ? ` (${body.errors.length} lỗi)` : ''}`)
        await load()
      }
    } catch (e: any) {
      setMessage(`Lỗi crawl: ${e.message}`)
    } finally {
      setCrawling(false)
    }
  }

  const fmtDate = (iso: string, tz?: string | null) =>
    new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: tz || 'UTC' }).format(new Date(iso))

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 w-[calc(100vw-280px)] min-w-0 overflow-x-hidden p-xl">
        {/* Header */}
        <div className="flex items-center justify-between mb-lg gap-md">
          <div>
            <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Fulfillment</p>
            <h1 className="text-display-md text-primary">Tracking Management</h1>
          </div>
          <div className="flex items-center gap-sm">
            <button
              onClick={crawl}
              disabled={crawling || syncing}
              className="border border-outline-variant/40 px-lg py-sm rounded-lg text-label-md disabled:opacity-50"
            >
              {crawling ? 'Crawling…' : 'Crawl Status 2'}
            </button>
            <button
              onClick={sync}
              disabled={syncing || crawling}
              className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50"
            >
              {syncing ? 'Syncing…' : 'Sync 30 ngày'}
            </button>
          </div>
        </div>
        {message && <p className="mb-md text-body-sm text-on-surface-variant">{message}</p>}

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-1 md:grid-cols-5 gap-md mb-lg">
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
              <p className="text-label-sm text-on-surface-variant">Tổng shipment</p>
              <p className="text-headline-md text-primary mt-xs">{stats.total}</p>
            </div>
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
              <p className="text-label-sm text-on-surface-variant">Có tracking</p>
              <p className="text-headline-md text-tertiary mt-xs">{stats.withTracking}</p>
            </div>
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
              <p className="text-label-sm text-on-surface-variant">Chưa có tracking</p>
              <p className="text-headline-md text-on-surface-variant mt-xs">{stats.withoutTracking}</p>
            </div>
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
              <p className="text-label-sm text-on-surface-variant">Đã có Status 2</p>
              <p className="text-headline-md text-secondary mt-xs">{stats.internallyTracked}</p>
            </div>
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
              <p className="text-label-sm text-on-surface-variant">Status 2 Delivered</p>
              <p className="text-headline-md text-tertiary mt-xs">{stats.internalDelivered}</p>
            </div>
          </div>
        )}

        {/* Filters */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 p-md mb-md grid grid-cols-1 md:grid-cols-4 gap-md">
          <div>
            <label className="text-label-sm block mb-xs">Project</label>
            <select value={projectId} onChange={e => setProjectId(e.target.value)} className="w-full border rounded-lg px-sm py-xs text-body-sm">
              <option value="">All projects</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-label-sm block mb-xs">Supplier</label>
            <select value={supplierId} onChange={e => setSupplierId(e.target.value)} className="w-full border rounded-lg px-sm py-xs text-body-sm">
              <option value="">All</option>
              {suppliers.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-label-sm block mb-xs">Tracking</label>
            <select value={hasTracking} onChange={e => setHasTracking(e.target.value as any)} className="w-full border rounded-lg px-sm py-xs text-body-sm">
              <option value="">Tất cả</option>
              <option value="yes">Đã có tracking</option>
              <option value="no">Chưa có</option>
            </select>
          </div>
          <div>
            <label className="text-label-sm block mb-xs">Tìm kiếm</label>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Order ID hoặc tracking number"
              className="w-full border rounded-lg px-sm py-xs text-body-sm"
            />
          </div>
        </div>

        {/* Table */}
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="px-md py-sm">Order ID</th>
                <th className="px-md py-sm">Tracking number</th>
                <th className="px-md py-sm">Carrier</th>
                <th className="px-md py-sm">Last-mile tracking</th>
                <th className="px-md py-sm">Supplier</th>
                <th className="px-md py-sm">Status nguồn ngoài</th>
                <th className="px-md py-sm">Status 2 nội bộ</th>
                <th className="px-md py-sm">Placed</th>
                {!projectId && <th className="px-md py-sm">Project</th>}
              </tr>
            </thead>
            <tbody>
              {shipments.map(s => {
                const checkpoints: TrackingCheckpoint[] = s.crawlSource
                  ? parseTrackingCheckpoints(s.checkpointsJson)
                  : []
                const expanded = expandedId === s.id
                return (
                  <Fragment key={s.id}>
                    <tr
                      className={`border-t border-outline-variant/20 ${checkpoints.length > 0 ? 'cursor-pointer hover:bg-surface-container/40' : ''}`}
                      onClick={() => checkpoints.length > 0 && setExpandedId(expanded ? null : s.id)}
                    >
                      <td className="px-md py-sm font-mono text-secondary">
                        <span className="inline-flex items-center gap-xs">
                          {checkpoints.length > 0 && (
                            <span className="material-symbols-outlined text-[16px] text-on-surface-variant">
                              {expanded ? 'expand_more' : 'chevron_right'}
                            </span>
                          )}
                          {s.lineKey}
                        </span>
                      </td>
                      <td className="px-md py-sm font-mono">
                        {s.trackingNumber
                          ? (s.trackingUrl
                              ? <a href={s.trackingUrl} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()} className="text-secondary underline underline-offset-2">{s.trackingNumber}</a>
                              : s.trackingNumber)
                          : <span className="text-on-surface-variant">— chưa có</span>}
                      </td>
                      <td className="px-md py-sm">{s.detectedCarrier ?? s.carrier ?? '—'}</td>
                      <td className="px-md py-sm">
                        {s.lastMileTrackingNumber
                          ? (
                            <div className="flex flex-col leading-tight">
                              <a
                                href={`https://parcelsapp.com/en/tracking/${s.lastMileTrackingNumber}`}
                                target="_blank" rel="noopener noreferrer"
                                onClick={e => e.stopPropagation()}
                                className="font-mono text-secondary underline underline-offset-2"
                              >{s.lastMileTrackingNumber}</a>
                              {s.lastMileCarrier && <span className="text-label-sm text-on-surface-variant">{s.lastMileCarrier}</span>}
                            </div>
                          )
                          : <span className="text-on-surface-variant">—</span>}
                      </td>
                      <td className="px-md py-sm">
                        {s.supplier?.name ?? <span className="text-error text-label-sm">unmapped</span>}
                      </td>
                      <td className="px-md py-sm">
                        <div className="flex flex-col gap-[2px]">
                          <span className={`rounded px-xs py-[2px] text-label-sm w-fit ${statusTone(s.status)}`}>{prettyStatus(s.status)}</span>
                        </div>
                      </td>
                      <td className="px-md py-sm">
                        <div className="flex flex-col gap-[2px]">
                          {s.internalStatus
                            ? <span className={`rounded px-xs py-[2px] text-label-sm w-fit ${statusTone(s.internalStatus)}`}>{prettyStatus(s.internalStatus)}</span>
                            : <span className="text-on-surface-variant">— chưa crawl</span>}
                          {checkpoints[0] && (
                            <span className="text-label-sm text-on-surface-variant truncate max-w-[260px]" title={checkpoints[0].desc}>
                              {checkpoints[0].desc}
                            </span>
                          )}
                          {s.crawlError && (
                            <span className="text-label-sm text-error" title={s.crawlError}>Lỗi crawl</span>
                          )}
                        </div>
                      </td>
                      <td className="px-md py-sm text-label-sm text-on-surface-variant">
                        {s.order ? fmtDate(s.order.placedAt, s.order.shopTimezone) : '—'}
                      </td>
                      {!projectId && <td className="px-md py-sm text-label-sm text-on-surface-variant">{s.order?.project?.name ?? '—'}</td>}
                    </tr>
                    {expanded && checkpoints.length > 0 && (
                      <tr className="border-t border-outline-variant/10 bg-surface-container/30">
                        <td colSpan={projectId ? 8 : 9} className="px-lg py-md">
                          <ol className="space-y-xs">
                            {checkpoints.map((cp, i) => (
                              <li key={i} className="flex items-start gap-md text-body-sm">
                                <span className={`mt-[6px] h-2 w-2 shrink-0 rounded-full ${i === 0 ? 'bg-secondary' : 'bg-outline-variant'}`} />
                                <span className="w-[150px] shrink-0 font-mono text-label-sm text-on-surface-variant">{cp.time}</span>
                                <span>{cp.desc}</span>
                              </li>
                            ))}
                          </ol>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
              {shipments.length === 0 && !loading && (
                <tr>
                  <td colSpan={projectId ? 8 : 9} className="px-md py-lg text-center text-on-surface-variant">
                    Chưa có shipment. Bấm Sync 30 ngày để kéo tracking từ Shopify về.
                  </td>
                </tr>
              )}
              {loading && (
                <tr>
                  <td colSpan={projectId ? 8 : 9} className="px-md py-lg text-center text-on-surface-variant">Đang tải…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
