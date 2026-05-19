'use client'
import { useCallback, useEffect, useState } from 'react'
import Sidebar from '@/components/Sidebar'

type OrderRow = {
  id: string
  shopifyOrderNumber: string
  customerName: string | null
  placedAt: string
  currency: string
  expectedPayout: number
  pipelineStatus: string
  defaultSupplier: { name: string } | null
  computed: { baseCost: number; shipping: number; profit: number; margin: number; hasUnmappedSku: boolean }
}

type Summary = {
  orderCount: number; revenue: number; cogs: number; shipping: number;
  profit: number; margin: number; avgProfit: number; unmappedCount: number
}

type ProjectItem = { id: string; name: string; shopifyStore: { shop: string } | null }

export default function OrdersPage() {
  const [projects, setProjects] = useState<ProjectItem[]>([])
  const [projectId, setProjectId] = useState<string>('')
  const [orders, setOrders] = useState<OrderRow[]>([])
  const [summary, setSummary] = useState<Summary | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncResult, setSyncResult] = useState<string>('')

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then(data => {
        const list = Array.isArray(data) ? data : (data.projects ?? [])
        setProjects(list)
      })
      .catch(() => setProjects([]))
  }, [])

  const load = useCallback(async () => {
    const q = projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''
    const [oRes, sRes] = await Promise.all([
      fetch(`/api/fulfillment/orders${q}`).then(r => r.json()),
      fetch(`/api/fulfillment/pl-summary${q}`).then(r => r.json()),
    ])
    setOrders(oRes.orders ?? [])
    setSummary(sRes)
  }, [projectId])

  useEffect(() => { load() }, [load])

  const sync = async () => {
    const creds = JSON.parse(localStorage.getItem('shopify_credentials_v1') ?? '{}')
    if (!creds.shop || !creds.accessToken) {
      setSyncResult('Missing Shopify credentials. Connect in /setup first.')
      return
    }
    setSyncing(true); setSyncResult('Syncing...')
    try {
      const res = await fetch('/api/shopify/orders/sync', {
        method: 'POST',
        headers: {
          'x-shopify-shop-domain': creds.shop,
          'x-shopify-access-token': creds.accessToken,
        },
      })
      const body = await res.json()
      if (!res.ok) {
        setSyncResult(`Error: ${body.error ?? res.statusText}`)
      } else {
        setSyncResult(`Synced ${body.totalSynced} orders (${body.withUnmappedSku} unmapped SKU) into project "${body.projectName}".`)
      }
      await load()
    } catch (e: any) {
      setSyncResult(`Error: ${e.message}`)
    } finally { setSyncing(false) }
  }

  const fmt = (n: number, cur = 'USD') => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n)

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center justify-between mb-lg gap-md">
          <h1 className="text-display-md">Orders & P/L</h1>
          <div className="flex items-center gap-sm">
            <select
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
              className="bg-surface-container-lowest border border-outline-variant rounded-lg px-md py-sm text-body-sm"
            >
              <option value="">All projects</option>
              {projects.map(p => (
                <option key={p.id} value={p.id}>
                  {p.name}{p.shopifyStore ? ` · ${p.shopifyStore.shop}` : ''}
                </option>
              ))}
            </select>
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

        {summary && (
          <div className="grid grid-cols-5 gap-md mb-lg">
            {[
              { label: 'Revenue', value: fmt(summary.revenue) },
              { label: 'COGS', value: fmt(summary.cogs + summary.shipping) },
              { label: 'Profit', value: fmt(summary.profit) },
              { label: 'Margin', value: `${summary.margin.toFixed(1)}%` },
              { label: 'Orders', value: String(summary.orderCount) },
            ].map(s => (
              <div key={s.label} className="bg-surface-container-lowest rounded-xl p-md shadow-card border border-outline-variant/20">
                <p className="text-label-sm text-on-surface-variant">{s.label}</p>
                <p className="text-stats-lg">{s.value}</p>
              </div>
            ))}
          </div>
        )}

        {summary && summary.unmappedCount > 0 && (
          <div className="bg-error/10 border border-error/30 rounded-lg p-md mb-md text-body-sm">
            {'⚠'} {summary.unmappedCount} order(s) có SKU thiếu mapping — profit có thể không chính xác.
          </div>
        )}

        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="px-md py-sm">Order #</th>
                <th className="px-md py-sm">Customer</th>
                <th className="px-md py-sm">Date</th>
                <th className="px-md py-sm">Supplier</th>
                <th className="px-md py-sm text-right">Payout</th>
                <th className="px-md py-sm text-right">COGS</th>
                <th className="px-md py-sm text-right">Ship</th>
                <th className="px-md py-sm text-right">Profit</th>
                <th className="px-md py-sm text-right">Margin</th>
                <th className="px-md py-sm">Status</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => (
                <tr key={o.id} className={`border-t border-outline-variant/20 ${o.computed.hasUnmappedSku ? 'bg-error/5' : ''}`}>
                  <td className="px-md py-sm font-mono">{o.shopifyOrderNumber}</td>
                  <td className="px-md py-sm">{o.customerName ?? '—'}</td>
                  <td className="px-md py-sm">{new Date(o.placedAt).toLocaleDateString('en-CA')}</td>
                  <td className="px-md py-sm">{o.defaultSupplier?.name ?? <span className="text-error">unmapped</span>}</td>
                  <td className="px-md py-sm text-right">{fmt(o.expectedPayout, o.currency)}</td>
                  <td className="px-md py-sm text-right">{fmt(o.computed.baseCost, o.currency)}</td>
                  <td className="px-md py-sm text-right">{fmt(o.computed.shipping, o.currency)}</td>
                  <td className={`px-md py-sm text-right font-semibold ${o.computed.profit >= 0 ? 'text-on-tertiary-container' : 'text-error'}`}>
                    {fmt(o.computed.profit, o.currency)}
                  </td>
                  <td className="px-md py-sm text-right">{o.computed.margin.toFixed(1)}%</td>
                  <td className="px-md py-sm">{o.pipelineStatus}</td>
                </tr>
              ))}
              {orders.length === 0 && (
                <tr><td colSpan={10} className="px-md py-lg text-center text-on-surface-variant">No orders yet. Click &quot;Sync Now&quot;.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
