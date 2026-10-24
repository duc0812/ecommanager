'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { Bars, WeeklyStacked } from '@/components/cs/Bars'
import { PeriodPicker, presetPeriod, type PeriodValue } from '@/components/cs/PeriodPicker'
import { fmtDate } from '@/components/cs/UrgencyChip'
import { CATEGORY_LABELS, ISSUE_LABELS, STAGE_LABELS } from '@/lib/cs/labels'
import { CS_CATEGORIES } from '@/lib/cs/triage'
import { STAGES } from '@/lib/cs/root-cause-prompt'

type Row = { ticketId: string; fdTicketId: number; subject: string; orderNumber: string | null; stage: string; issueType: string | null; confidence: string | null; evidence: string | null; category: string | null; createdAt: string; products: string[]; supplierId: string | null; overridden: boolean }
type Data = {
  totals: { problem: number; all: number; topStage: string | null; topIssue: string | null }
  byStage: Record<string, number>; byIssue: Record<string, number>
  weekly: { week: string; byStage: Record<string, number> }[]
  products: { title: string; count: number }[]; suppliers: { supplierId: string; name: string | null; count: number }[]
  rows: Row[]
}

const label = (map: Record<string, string>, k: string | null) => (k ? map[k] ?? k : '—')

export default function CsInsightsPage() {
  const [period, setPeriod] = useState<PeriodValue>({ ...presetPeriod('last4'), preset: 'last4' })
  const [stage, setStage] = useState('')
  const [category, setCategory] = useState('')
  const [data, setData] = useState<Data | null>(null)
  const [loading, setLoading] = useState(true)

  const query = `from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}${stage ? `&stage=${stage}` : ''}${category ? `&category=${category}` : ''}`
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/cs/insights?${query}`)
      setData(await res.json())
    } catch {}
    setLoading(false)
  }, [query])
  useEffect(() => { load() }, [load])

  const card = (title: string, children: React.ReactNode) => (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">{title}</h3></div>
      <div className="p-lg">{children}</div>
    </section>
  )
  const stat = (title: string, value: string | number) => (
    <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest p-lg shadow-card">
      <p className="text-label-sm uppercase text-on-surface-variant">{title}</p>
      <p className="text-stats-lg text-primary">{value}</p>
    </div>
  )

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-lg flex flex-wrap items-end justify-between gap-md">
          <div>
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Customer Service</p>
            <h2 className="text-display-md font-bold text-primary">Thống kê lỗi</h2>
            <p className="mt-xs text-body-md text-on-surface-variant">Khâu nào gây ra lỗi: Design → Fulfillment → Xưởng → Vận chuyển, theo bằng chứng từ timeline đơn.</p>
          </div>
          <a href={`/api/cs/insights?${query}&format=csv`} className="rounded-lg border border-outline-variant/40 px-lg py-sm text-label-md text-primary">Xuất CSV</a>
        </header>

        <div className="mb-lg flex flex-wrap items-center gap-md rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-lg py-md shadow-card">
          <PeriodPicker value={period} onChange={setPeriod} />
          <select value={stage} onChange={e => setStage(e.target.value)} className="rounded-lg border border-outline-variant/40 bg-surface px-md py-xs text-body-sm">
            <option value="">Mọi khâu</option>
            {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
          </select>
          <select value={category} onChange={e => setCategory(e.target.value)} className="rounded-lg border border-outline-variant/40 bg-surface px-md py-xs text-body-sm">
            <option value="">Mọi loại ticket</option>
            {CS_CATEGORIES.map(c => <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>)}
          </select>
        </div>

        {loading && !data && <p className="text-body-sm text-on-surface-variant">Đang tải…</p>}
        {data && (
          <div className="space-y-lg">
            <div className="grid grid-cols-2 gap-md xl:grid-cols-4">
              {stat('Ticket có lỗi', data.totals.problem)}
              {stat('Tỉ lệ trên tổng ticket', data.totals.all ? `${Math.round((data.totals.problem / data.totals.all) * 100)}%` : '—')}
              {stat('Khâu lỗi nhiều nhất', label(STAGE_LABELS, data.totals.topStage))}
              {stat('Loại lỗi nhiều nhất', label(ISSUE_LABELS, data.totals.topIssue))}
            </div>
            <div className="grid grid-cols-1 gap-lg xl:grid-cols-2">
              {card('Theo khâu', <Bars data={data.byStage} labels={STAGE_LABELS} />)}
              {card('Theo loại lỗi', <Bars data={data.byIssue} labels={ISSUE_LABELS} />)}
            </div>
            {card('Xu hướng theo tuần', <WeeklyStacked weeks={data.weekly} labels={STAGE_LABELS} />)}
            <div className="grid grid-cols-1 gap-lg xl:grid-cols-2">
              {card('Sản phẩm dính lỗi nhiều nhất', data.products.length ? <table className="w-full text-body-sm"><tbody>{data.products.map(p => <tr key={p.title} className="border-t border-outline-variant/20"><td className="py-xs">{p.title}</td><td className="py-xs text-right text-label-md text-primary">{p.count}</td></tr>)}</tbody></table> : <p className="text-body-sm text-on-surface-variant">Chưa có dữ liệu</p>)}
              {card('Xưởng dính lỗi nhiều nhất', data.suppliers.length ? <table className="w-full text-body-sm"><tbody>{data.suppliers.map(s => <tr key={s.supplierId} className="border-t border-outline-variant/20"><td className="py-xs">{s.name ?? s.supplierId}</td><td className="py-xs text-right text-label-md text-primary">{s.count}</td></tr>)}</tbody></table> : <p className="text-body-sm text-on-surface-variant">Chưa có dữ liệu</p>)}
            </div>
            <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
              <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">Ticket ({data.rows.length})</h3></div>
              <table className="w-full text-left">
                <thead className="text-label-sm uppercase text-on-surface-variant"><tr><th className="px-lg py-sm">Ticket</th><th className="px-sm py-sm">Đơn</th><th className="px-sm py-sm">Khâu</th><th className="px-sm py-sm">Loại lỗi</th><th className="px-sm py-sm">Bằng chứng</th><th className="px-lg py-sm">Ngày</th></tr></thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td colSpan={6} className="px-lg py-xl text-center text-body-sm text-on-surface-variant">Không có ticket lỗi trong kỳ.</td></tr>}
                  {data.rows.map(r => (
                    <tr key={r.ticketId} className="border-t border-outline-variant/20 align-top hover:bg-surface-container-low">
                      <td className="px-lg py-sm"><Link href={`/cs/${r.ticketId}`} className="text-label-md text-primary">#{r.fdTicketId}</Link><p className="line-clamp-1 text-label-sm text-on-surface-variant">{r.subject}</p></td>
                      <td className="px-sm py-sm text-body-sm">{r.orderNumber ?? '—'}<p className="line-clamp-1 text-label-sm text-on-surface-variant">{r.products.join(', ')}</p></td>
                      <td className="px-sm py-sm text-body-sm">{label(STAGE_LABELS, r.stage)}{r.overridden && <span className="ml-xs rounded-full bg-secondary/10 px-sm text-label-sm text-secondary">sửa tay</span>}<p className="text-label-sm text-on-surface-variant">{r.confidence === 'OVERRIDE' ? '' : r.confidence ?? ''}</p></td>
                      <td className="px-sm py-sm text-body-sm">{label(ISSUE_LABELS, r.issueType)}</td>
                      <td className="px-sm py-sm text-body-sm text-on-surface-variant"><p className="line-clamp-3 whitespace-pre-wrap">{r.evidence ?? '—'}</p></td>
                      <td className="px-lg py-sm text-label-sm text-on-surface-variant">{fmtDate(r.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </div>
        )}
      </main>
    </div>
    </RoleGate>
  )
}
