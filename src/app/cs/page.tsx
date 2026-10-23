'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { UrgencyChip, fmtDate, hoursLabel } from '@/components/cs/UrgencyChip'
import { CATEGORY_LABELS } from '@/lib/cs/labels'

type Row = {
  id: string; fdTicketId: number; subject: string; requesterEmail: string | null; requesterName: string | null; orderNumber: string | null
  category: string | null; urgency: string | null; sentiment: string | null; needsHuman: boolean; autoReplied: boolean
  lastCustomerAt: string | null; lastReplyAt: string | null; summary: string | null; hoursUnanswered: number
}
type Tab = 'todo' | 'agent' | 'done'
const TABS: { key: Tab; label: string }[] = [
  { key: 'todo', label: 'Cần xử lý' },
  { key: 'agent', label: 'Agent đã trả lời' },
  { key: 'done', label: 'Đã xong' },
]

export default function CsInboxPage() {
  const [tab, setTab] = useState<Tab>('todo')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/cs/tickets?tab=${tab}&q=${encodeURIComponent(q)}`)
      const data = await res.json().catch(() => ({}))
      setRows(data.tickets ?? [])
    } catch {}
    setLoading(false)
  }, [tab, q])

  useEffect(() => { setLoading(true); load() }, [load])
  useEffect(() => {
    const id = setInterval(load, 60_000)
    return () => clearInterval(id)
  }, [load])

  async function syncNow() {
    setSyncing(true)
    setMessage(null)
    const res = await fetch('/api/cs/sync', { method: 'POST' })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) setMessage(data.error ?? 'Đồng bộ thất bại')
    else {
      const r = data.run
      setMessage(`Đã xem ${r.ticketsSeen} ticket · phân tích ${r.analysed} · agent trả lời ${r.autoReplied}${r.partial ? ` · ${r.partial}` : ''}${r.error ? ` · lỗi: ${r.error}` : ''}`)
    }
    setSyncing(false)
    load()
  }

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-lg flex flex-wrap items-end justify-between gap-md">
          <div>
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Customer Service</p>
            <h2 className="text-display-md font-bold text-primary">Tickets</h2>
            <p className="mt-xs text-body-md text-on-surface-variant">Freshdesk của Litzzy, agent đọc trước và xếp theo độ gấp.</p>
          </div>
          <div className="flex items-center gap-sm">
            <Link href="/cs/settings" className="rounded-lg border border-outline-variant/40 px-lg py-sm text-label-md text-primary">Cài đặt</Link>
            <button onClick={syncNow} disabled={syncing} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary disabled:opacity-50">
              {syncing ? 'Đang đồng bộ…' : 'Đồng bộ ngay'}
            </button>
          </div>
        </header>
        {message && <p className="mb-md rounded-lg bg-surface-container px-md py-sm text-body-sm text-on-surface-variant">{message}</p>}

        <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
          <div className="flex flex-wrap items-center gap-sm border-b border-outline-variant/20 px-lg py-md">
            <div className="flex gap-xs">
              {TABS.map(t => (
                <button key={t.key} onClick={() => setTab(t.key)} className={`rounded-lg px-md py-xs text-label-md ${tab === t.key ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>{t.label}</button>
              ))}
            </div>
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm theo số đơn, email, tiêu đề…" className="ml-auto w-72 rounded-lg border border-outline-variant/40 bg-surface px-md py-xs text-body-sm" />
          </div>
          <table className="w-full text-left">
            <thead className="text-label-sm uppercase text-on-surface-variant">
              <tr>
                <th className="px-lg py-sm">Độ gấp</th>
                <th className="px-sm py-sm">Loại</th>
                <th className="px-sm py-sm">Đơn</th>
                <th className="px-sm py-sm">Khách</th>
                <th className="px-sm py-sm">Tóm tắt</th>
                <th className="px-lg py-sm text-right">Chờ</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={6} className="px-lg py-xl text-center text-body-sm text-on-surface-variant">Đang tải…</td></tr>}
              {!loading && rows.length === 0 && <tr><td colSpan={6} className="px-lg py-xl text-center text-body-sm text-on-surface-variant">Không có ticket nào.</td></tr>}
              {rows.map(r => (
                <tr key={r.id} className="border-t border-outline-variant/20 hover:bg-surface-container-low">
                  <td className="px-lg py-md align-top"><Link href={`/cs/${r.id}`}><UrgencyChip urgency={r.urgency} /></Link></td>
                  <td className="px-sm py-md align-top text-body-sm text-on-surface">{r.category ? CATEGORY_LABELS[r.category as keyof typeof CATEGORY_LABELS] ?? r.category : '—'}</td>
                  <td className="px-sm py-md align-top text-label-md text-primary">{r.orderNumber ?? '—'}</td>
                  <td className="px-sm py-md align-top">
                    <p className="text-body-sm text-on-surface">{r.requesterName ?? '—'}</p>
                    <p className="text-label-sm text-on-surface-variant">{r.requesterEmail ?? ''}</p>
                  </td>
                  <td className="px-sm py-md align-top">
                    <Link href={`/cs/${r.id}`} className="block">
                      <p className="text-label-md text-primary">#{r.fdTicketId} · {r.subject || '(không tiêu đề)'}</p>
                      <p className="line-clamp-1 text-body-sm text-on-surface-variant">{r.summary ?? 'Chưa có tóm tắt'}</p>
                    </Link>
                  </td>
                  <td className="px-lg py-md align-top text-right">
                    <p className={`text-label-sm ${r.hoursUnanswered > 24 ? 'text-error' : 'text-on-surface-variant'}`}>{hoursLabel(r.hoursUnanswered)}</p>
                    <p className="text-label-sm text-on-surface-variant">{fmtDate(r.lastCustomerAt, true)}</p>
                    {r.autoReplied && <span className="mt-xs inline-block rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">Agent đã trả lời</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </main>
    </div>
    </RoleGate>
  )
}
