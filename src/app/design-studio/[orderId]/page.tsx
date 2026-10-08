'use client'
import { useCallback, useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { STATUS_COLORS, STATUS_LABELS, type PipelineStatus } from '@/lib/pipeline-status'
import LineBlock, { type WorkspaceLine } from './LineBlock'

type Workspace = {
  order: { id: string; shopifyOrderNumber: string; placedAt: string; pipelineStatus: PipelineStatus; orderType: string; designReady: boolean; trelloCardUrl: string | null; store: { shop: string; projectId: string; projectName: string } }
  lines: WorkspaceLine[]
}

function shopifyAdminOrdersUrl(shop: string, orderNumber: string) {
  const store = shop.replace(/\.myshopify\.com$/, '')
  return `https://admin.shopify.com/store/${store}/orders?query=${encodeURIComponent(orderNumber)}`
}

export default function DesignWorkspacePage() {
  const params = useParams<{ orderId: string }>()
  const orderId = decodeURIComponent(params.orderId)
  const [ws, setWs] = useState<Workspace | null>(null)
  const [err, setErr] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [msg, setMsg] = useState('')

  const load = useCallback(async () => {
    const res = await fetch(`/api/design-studio/orders/${encodeURIComponent(orderId)}`)
    if (!res.ok) { setErr((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`); return }
    setWs(await res.json())
  }, [orderId])
  useEffect(() => { load() }, [load])

  async function refresh() {
    setRefreshing(true); setMsg('')
    const res = await fetch(`/api/design-studio/orders/${encodeURIComponent(orderId)}/refresh`, { method: 'POST' })
    const d = await res.json().catch(() => ({}))
    setRefreshing(false)
    setMsg(res.ok ? `Đã nạp ${d.updated} dòng từ Shopify` : (d.error ?? 'Lỗi'))
    if (res.ok) load()
  }

  const productLines = ws?.lines.filter(l => !l.isNonProduct) ?? []
  const doneCount = productLines.filter(l => l.designDriveLink).length

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <Link href="/design-studio" className="text-body-sm text-secondary hover:underline">← Design Studio</Link>
        {err && <div className="mt-md px-md py-sm rounded-lg bg-error-container text-on-error-container text-body-sm">{err}</div>}
        {ws && (
          <>
            <div className="bg-surface-container-lowest rounded-xl shadow-card border border-outline-variant/20 px-lg py-md mt-md mb-lg flex flex-wrap items-center gap-md">
              <h1 className="text-headline-lg text-on-surface">{ws.order.shopifyOrderNumber}</h1>
              <span className={`px-sm py-xs rounded-md text-label-sm ${STATUS_COLORS[ws.order.pipelineStatus]}`}>{STATUS_LABELS[ws.order.pipelineStatus]}</span>
              <span className="text-body-sm text-on-surface-variant">{ws.order.store.projectName} · {new Date(ws.order.placedAt).toLocaleDateString('en-US')} · {ws.order.orderType}</span>
              <span className="text-body-sm">{doneCount}/{productLines.length} dòng xong{ws.order.designReady && ' · đơn đã đủ design'}</span>
              <div className="ml-auto flex gap-sm items-center">
                {msg && <span className="text-body-sm text-on-surface-variant">{msg}</span>}
                <a className="px-md py-sm rounded-lg border border-outline-variant/40 text-label-md" href={shopifyAdminOrdersUrl(ws.order.store.shop, ws.order.shopifyOrderNumber)} target="_blank" rel="noreferrer">Shopify ↗</a>
                {ws.order.trelloCardUrl && <a className="px-md py-sm rounded-lg border border-outline-variant/40 text-label-md" href={ws.order.trelloCardUrl} target="_blank" rel="noreferrer">Trello ↗</a>}
                <button onClick={refresh} disabled={refreshing} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">{refreshing ? 'Đang nạp…' : 'Nạp lại từ Shopify'}</button>
              </div>
            </div>
            <div className="flex flex-col gap-lg">
              {ws.lines.map(l => <LineBlock key={l.id} line={l} onChanged={load} />)}
            </div>
          </>
        )}
      </main>
    </div>
  )
}
