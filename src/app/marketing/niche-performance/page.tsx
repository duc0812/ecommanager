'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import CampaignTable from '@/components/marketing/CampaignTable'
import NicheManagerPanel from '@/components/marketing/NicheManagerPanel'
import { fmtUsd, fmtRoas, fmtInt, roasTone } from '@/components/marketing/format'
import type { NichePerformanceResult } from '@/lib/marketing/niche-performance'

type Data = NichePerformanceResult & { project: { id: string; name: string } }
type Project = { id: string; name: string; archivedAt?: string | null }

const PERIODS = [
  { key: 'today', label: 'Hôm nay' },
  { key: 'this-week', label: 'Tuần này' },
  { key: 'this-month', label: 'Tháng này' },
  { key: 'last-7', label: '7 ngày' },
  { key: 'last-30', label: '30 ngày' },
  { key: 'custom', label: 'Tuỳ chọn' },
]

export default function NichePerformancePage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [period, setPeriod] = useState('this-month')
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState('')
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showManager, setShowManager] = useState(false)

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(d => {
      const list: Project[] = (Array.isArray(d) ? d : (d.projects ?? [])).filter((p: Project) => !p.archivedAt)
      setProjects(list)
      if (list.length > 0 && !projectId) setProjectId(list[0].id)
    }).catch(() => {})
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(async () => {
    if (!projectId) return
    if (period === 'custom' && (!from || !to)) return
    setLoading(true); setError('')
    const params = new URLSearchParams({ projectId, period })
    if (period === 'custom') { params.set('from', from); params.set('to', to) }
    try {
      const res = await fetch(`/api/marketing/niche-performance?${params}`)
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      setData(body)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [projectId, period, from, to])

  useEffect(() => { load() }, [load])

  const syncCampaigns = async () => {
    setSyncing(true); setMessage('Đang sync campaign insights…')
    try {
      const res = await fetch('/api/meta/sync-campaign-insights', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
      const errs = Array.isArray(body.errors) && body.errors.length ? ` Lỗi: ${body.errors.join('; ')}` : ''
      setMessage(`Sync xong: ${body.synced} dòng campaign/ngày trên ${body.accounts} account.${errs}`)
      await load()
    } catch (e: any) {
      setMessage(`Lỗi sync: ${e.message}`)
    } finally {
      setSyncing(false)
    }
  }

  const assign = async (campaignId: string, nicheId: string) => {
    const res = await fetch('/api/marketing/campaign-overrides', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ campaignId, nicheId }),
    })
    if (!res.ok) { const b = await res.json().catch(() => ({})); setMessage(`Lỗi gán niche: ${b.error ?? res.status}`); return }
    await load()
  }

  const toggle = (id: string) => setExpanded(prev => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  const nicheOptions = data?.niches.map(n => ({ id: n.nicheId, name: n.name })) ?? []
  const showUnassigned = Boolean(data && (data.unassigned.spend > 0 || data.unassigned.revenue > 0 || data.unassigned.campaigns.length > 0))

  return (
    <RoleGate>
      <div className="flex min-h-screen bg-surface">
        <Sidebar />
        <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 w-full lg:w-[calc(100vw-280px)] min-w-0 overflow-x-hidden p-xl">
          <div className="flex items-start justify-between mb-lg gap-md flex-wrap">
            <div>
              <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Marketing</p>
              <h1 className="text-display-md text-primary">Niche Performance</h1>
              <p className="text-on-surface-variant text-body-md mt-xs">Meta spend theo campaign vs doanh thu Shopify theo niche</p>
            </div>
            <div className="flex items-center gap-xs flex-wrap">
              {projects.length > 1 && (
                <select value={projectId} onChange={e => setProjectId(e.target.value)}
                  className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-sm text-body-sm">
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
              <button onClick={syncCampaigns} disabled={syncing}
                className="bg-surface-container-lowest text-on-surface border border-outline-variant/40 px-lg py-sm rounded-lg text-label-md disabled:opacity-50 flex items-center gap-xs hover:bg-surface-container">
                <span className={`material-symbols-outlined text-[18px] ${syncing ? 'animate-spin' : ''}`}>sync</span>
                {syncing ? 'Syncing…' : 'Sync campaign'}
              </button>
              <button onClick={() => setShowManager(true)}
                className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md flex items-center gap-xs">
                <span className="material-symbols-outlined text-[18px]">tune</span>
                Quản lý niche
              </button>
            </div>
          </div>

          <div className="flex items-center gap-xs flex-wrap mb-lg">
            {PERIODS.map(p => (
              <button key={p.key} onClick={() => setPeriod(p.key)}
                className={`px-md py-xs rounded-lg text-label-sm font-semibold transition-all ${
                  period === p.key ? 'bg-secondary text-on-secondary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-high'
                }`}>
                {p.label}
              </button>
            ))}
            {period === 'custom' && (
              <>
                <input type="date" value={from} onChange={e => setFrom(e.target.value)}
                  className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-xs text-body-sm" />
                <span className="text-on-surface-variant text-body-sm">→</span>
                <input type="date" value={to} onChange={e => setTo(e.target.value)}
                  className="rounded-lg border border-outline-variant/30 bg-surface-container-lowest px-md py-xs text-body-sm" />
              </>
            )}
            {data && (
              <span className="ml-auto text-label-sm text-on-surface-variant">
                {data.period.from.replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3/$1')} – {data.period.to.replace(/(\d{4})-(\d{2})-(\d{2})/, '$2/$3/$1')} · {data.period.timeZone}
              </span>
            )}
          </div>

          {message && <p className="mb-md text-body-sm text-on-surface-variant">{message}</p>}
          {error && <p className="mb-md text-body-sm text-error">{error}</p>}

          {data && data.missingExchangeRateAccounts.length > 0 && (
            <div className="mb-lg rounded-xl border border-amber-300 bg-amber-50 px-lg py-md text-body-sm text-amber-900 flex items-center gap-sm">
              <span className="material-symbols-outlined text-[18px]">warning</span>
              Thiếu tỷ giá cho {data.missingExchangeRateAccounts.map(a => `${a.accountName ?? a.accountId} (${a.currency})`).join(', ')} — spend các account này đang tính 0.
              <a href="/setup/meta-rates" className="underline ml-auto">Cập nhật tỷ giá</a>
            </div>
          )}

          {loading && !data && (
            <div className="flex items-center justify-center py-xl">
              <span className="material-symbols-outlined animate-spin text-secondary">sync</span>
            </div>
          )}

          {data && (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-md mb-lg">
                <StatCard label="Total Spend" value={fmtUsd(data.totals.spend)} />
                <StatCard label="Total Revenue" value={fmtUsd(data.totals.revenue)} />
                <StatCard label="ROAS" value={fmtRoas(data.totals.roas)} tone={roasTone(data.totals.roas)} />
                <StatCard label="Orders" value={fmtInt(data.totals.orders)} />
              </div>

              <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 overflow-hidden">
                <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
                  <span className="material-symbols-outlined text-secondary">insights</span>
                  <h3 className="text-headline-sm text-primary">Theo niche</h3>
                  <span className="text-label-sm text-on-surface-variant">bấm vào niche để xem campaign</span>
                  {loading && <span className="material-symbols-outlined animate-spin text-secondary text-[18px] ml-auto">sync</span>}
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-body-sm">
                    <thead>
                      <tr className="text-label-sm text-on-surface-variant uppercase tracking-wider border-b border-outline-variant/20">
                        <th className="text-left px-lg py-sm font-medium">Niche</th>
                        <th className="text-right px-md py-sm font-medium">Spend</th>
                        <th className="text-right px-md py-sm font-medium">Revenue</th>
                        <th className="text-right px-md py-sm font-medium">ROAS</th>
                        <th className="text-right px-md py-sm font-medium">Orders</th>
                        <th className="text-right px-md py-sm font-medium">AOV</th>
                        <th className="text-right px-lg py-sm font-medium">Campaigns</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.niches.map(n => (
                        <NicheRows key={n.nicheId} open={expanded.has(n.nicheId)} onToggle={() => toggle(n.nicheId)}
                          name={n.name} spend={n.spend} revenue={n.revenue} roas={n.roas} orders={n.orders} aov={n.aov}
                          campaignsLabel={`${n.activeCampaignCount}/${n.campaignCount}`}>
                          <CampaignTable campaigns={n.campaigns} />
                        </NicheRows>
                      ))}
                      {showUnassigned && (
                        <NicheRows open={expanded.has('__unassigned')} onToggle={() => toggle('__unassigned')}
                          name="Chưa gán" muted spend={data.unassigned.spend} revenue={data.unassigned.revenue}
                          roas={null} orders={null} aov={null}
                          campaignsLabel={String(data.unassigned.campaigns.length)}
                          revenueTitle="Doanh thu từ sản phẩm không match keyword niche nào">
                          <CampaignTable campaigns={data.unassigned.campaigns} niches={nicheOptions} onAssign={assign} />
                        </NicheRows>
                      )}
                      {data.niches.length === 0 && !showUnassigned && (
                        <tr><td colSpan={7} className="px-lg py-xl text-center text-on-surface-variant">
                          Chưa có niche. Bấm &quot;Quản lý niche&quot; để thêm, rồi &quot;Sync campaign&quot; để lấy dữ liệu.
                        </td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}
        </main>
      </div>

      <NicheManagerPanel open={showManager} onClose={() => setShowManager(false)} onChanged={load} />
    </RoleGate>
  )
}

function StatCard({ label, value, tone = 'text-primary' }: { label: string; value: string; tone?: string }) {
  return (
    <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 p-lg">
      <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">{label}</p>
      <p className={`text-stats-lg font-bold ${tone}`}>{value}</p>
    </div>
  )
}

function NicheRows({ open, onToggle, name, muted, spend, revenue, roas, orders, aov, campaignsLabel, revenueTitle, children }: {
  open: boolean
  onToggle: () => void
  name: string
  muted?: boolean
  spend: number
  revenue: number
  roas: number | null
  orders: number | null
  aov: number | null
  campaignsLabel: string
  revenueTitle?: string
  children: React.ReactNode
}) {
  return (
    <>
      <tr onClick={onToggle} className={`cursor-pointer border-b border-outline-variant/10 hover:bg-surface-container-low ${muted ? 'text-on-surface-variant' : ''}`}>
        <td className="px-lg py-md">
          <div className="flex items-center gap-xs">
            <span className="material-symbols-outlined text-[18px] text-on-surface-variant">{open ? 'expand_more' : 'chevron_right'}</span>
            <span className={`text-label-md ${muted ? '' : 'font-bold text-primary'}`}>{name}</span>
          </div>
        </td>
        <td className="px-md py-md text-right">{fmtUsd(spend)}</td>
        <td className="px-md py-md text-right" title={revenueTitle}>{fmtUsd(revenue)}</td>
        <td className={`px-md py-md text-right font-bold ${roasTone(roas)}`}>{fmtRoas(roas)}</td>
        <td className="px-md py-md text-right">{orders == null ? '—' : fmtInt(orders)}</td>
        <td className="px-md py-md text-right">{aov == null ? '—' : fmtUsd(aov)}</td>
        <td className="px-lg py-md text-right">{campaignsLabel}</td>
      </tr>
      {open && (
        <tr className="bg-surface-container-low/60">
          <td colSpan={7} className="p-0">{children}</td>
        </tr>
      )}
    </>
  )
}
