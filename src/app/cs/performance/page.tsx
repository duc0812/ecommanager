'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { Bars, Histogram } from '@/components/cs/Bars'
import { PeriodPicker, presetPeriod, type PeriodValue } from '@/components/cs/PeriodPicker'
import { fmtDate } from '@/components/cs/UrgencyChip'
import { RUBRIC_LABELS } from '@/lib/cs/review-prompt'

type Resp = { count: number; medianH: number | null; meanH: number | null; p90H: number | null; over24hPct: number | null; worst: { ticketId: string; fdTicketId: number; hours: number }[] }
type Side = { firstResponse: Resp; nextResponse: Resp; repliesPerTicket: { mean: number | null; over3Pct: number | null; over3: { ticketId: string; fdTicketId: number; replies: number }[] }; sentimentAfterReply: { improved: number; same: number; worse: number; worseItems: { ticketId: string; fdTicketId: number }[] } }
type Metrics = { tickets: number; staff: Side & { draftUnchanged: number; prematureCloses: { count: number; closedTickets: number; pct: number | null; items: { ticketId: string; fdTicketId: number; reopenSentiment: string | null }[] } }; agent: Side }
type ReviewRow = { id: string; ticketId: string; fdTicketId: number; subject: string; who: string; source: string | null; at: string; score: number; issues: string[]; reason: string; rewrite: string | null; quote: string }
type Report = { id: string; periodStart: string; periodEnd: string; kind: string; body: string; createdAt: string }
type Data = { metrics: Metrics; scoreHistogram: number[]; issueCounts: Record<string, number>; reviews: ReviewRow[]; reports: Report[] }

const h = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}h`)
const pct = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n}%`)

function Markdown({ text }: { text: string }) {
  return (
    <div className="space-y-xs text-body-sm">
      {text.split('\n').map((line, i) => {
        if (line.startsWith('# ')) return <h3 key={i} className="text-headline-sm text-primary">{line.slice(2)}</h3>
        if (line.startsWith('## ')) return <h4 key={i} className="mt-md text-label-md uppercase text-on-surface-variant">{line.slice(3)}</h4>
        if (line.startsWith('> ') || line.trim().startsWith('> ')) return <blockquote key={i} className="border-l-2 border-secondary/40 pl-md italic text-on-surface-variant">{line.trim().slice(2)}</blockquote>
        if (line.startsWith('- ')) return <p key={i} className="pl-md">• {line.slice(2)}</p>
        if (!line.trim()) return null
        return <p key={i} dangerouslySetInnerHTML={{ __html: line.replace(/</g, '&lt;').replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') }} />
      })}
    </div>
  )
}

export default function CsPerformancePage() {
  const [period, setPeriod] = useState<PeriodValue>({ ...presetPeriod('last4'), preset: 'last4' })
  const [data, setData] = useState<Data | null>(null)
  const [issueFilter, setIssueFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const load = useCallback(async () => {
    try { setData(await (await fetch(`/api/cs/performance?from=${encodeURIComponent(period.from)}&to=${encodeURIComponent(period.to)}`)).json()) } catch {}
  }, [period])
  useEffect(() => { load() }, [load])

  async function makeReport() {
    setBusy(true); setMessage(null)
    const res = await fetch('/api/cs/performance/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ from: period.from, to: period.to }) })
    const d = await res.json().catch(() => ({}))
    setBusy(false)
    setMessage(res.ok ? 'Đã tạo bản đánh giá.' : d.error ?? 'Không tạo được')
    load()
  }

  const card = (title: string, children: React.ReactNode, extra?: React.ReactNode) => (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="flex items-center justify-between border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">{title}</h3>{extra}</div>
      <div className="p-lg">{children}</div>
    </section>
  )
  const m = data?.metrics
  const row = (label: string, staff: string, agent: string) => (
    <tr className="border-t border-outline-variant/20"><td className="py-xs text-on-surface-variant">{label}</td><td className="py-xs text-right text-label-md text-primary">{staff}</td><td className="py-xs text-right text-label-md text-secondary">{agent}</td></tr>
  )
  const reviews = (data?.reviews ?? []).filter(r => !issueFilter || r.issues.includes(issueFilter))

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-lg flex flex-wrap items-end justify-between gap-md">
          <div>
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Customer Service</p>
            <h2 className="text-display-md font-bold text-primary">Đánh giá CS</h2>
            <p className="mt-xs text-body-md text-on-surface-variant">Tốc độ, số thư, đóng non, cảm xúc khách — và agent chấm từng thư của nhân sự.</p>
          </div>
          <button onClick={makeReport} disabled={busy} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary disabled:opacity-50">{busy ? 'Đang viết…' : 'Tạo đánh giá'}</button>
        </header>
        <div className="mb-lg rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-lg py-md shadow-card"><PeriodPicker value={period} onChange={setPeriod} /></div>
        {message && <p className="mb-md rounded-lg bg-surface-container px-md py-sm text-body-sm text-on-surface-variant">{message}</p>}

        {data && m && (
          <div className="space-y-lg">
            {data.reports[0] && card(`Bản đánh giá mới nhất · ${fmtDate(data.reports[0].periodStart)} – ${fmtDate(data.reports[0].periodEnd)} (${data.reports[0].kind === 'WEEKLY' ? 'tự động' : 'bấm tay'})`, <Markdown text={data.reports[0].body} />)}

            {card(`Thước đo · ${m.tickets} ticket trong kỳ`, (
              <table className="w-full text-body-sm">
                <thead><tr className="text-label-sm uppercase text-on-surface-variant"><th className="text-left">Chỉ số</th><th className="text-right">Nhân sự</th><th className="text-right">Agent</th></tr></thead>
                <tbody>
                  {row('Phản hồi lần đầu · median', h(m.staff.firstResponse.medianH), h(m.agent.firstResponse.medianH))}
                  {row('Phản hồi lần đầu · p90', h(m.staff.firstResponse.p90H), h(m.agent.firstResponse.p90H))}
                  {row('Phản hồi lần đầu · quá 24h', pct(m.staff.firstResponse.over24hPct), pct(m.agent.firstResponse.over24hPct))}
                  {row('Phản hồi sau khi khách reply · median', h(m.staff.nextResponse.medianH), h(m.agent.nextResponse.medianH))}
                  {row('Số thư / ticket', `${m.staff.repliesPerTicket.mean ?? '—'}`, `${m.agent.repliesPerTicket.mean ?? '—'}`)}
                  {row('Ticket cần > 3 thư', pct(m.staff.repliesPerTicket.over3Pct), pct(m.agent.repliesPerTicket.over3Pct))}
                  {row('Đóng non (khách viết lại sau khi đóng)', `${m.staff.prematureCloses.count} / ${m.staff.prematureCloses.closedTickets} (${pct(m.staff.prematureCloses.pct)})`, '—')}
                  {row('Cảm xúc sau thư · tốt lên / giữ / xấu đi', `${m.staff.sentimentAfterReply.improved} / ${m.staff.sentimentAfterReply.same} / ${m.staff.sentimentAfterReply.worse}`, `${m.agent.sentimentAfterReply.improved} / ${m.agent.sentimentAfterReply.same} / ${m.agent.sentimentAfterReply.worse}`)}
                  {row('Gửi nguyên nháp agent', `${m.staff.draftUnchanged}`, '')}
                </tbody>
              </table>
            ))}

            <div className="grid grid-cols-1 gap-lg xl:grid-cols-3">
              {card('Chậm nhất (phản hồi đầu)', m.staff.firstResponse.worst.length ? <ul className="text-body-sm">{m.staff.firstResponse.worst.slice(0, 5).map(w => <li key={w.ticketId}><Link href={`/cs/${w.ticketId}`} className="text-secondary">#{w.fdTicketId}</Link> · {w.hours}h</li>)}</ul> : <p className="text-body-sm text-on-surface-variant">—</p>)}
              {card('Đóng non', m.staff.prematureCloses.items.length ? <ul className="text-body-sm">{m.staff.prematureCloses.items.map(w => <li key={w.ticketId}><Link href={`/cs/${w.ticketId}`} className="text-secondary">#{w.fdTicketId}</Link> · khách viết lại: {w.reopenSentiment ?? '—'}</li>)}</ul> : <p className="text-body-sm text-on-surface-variant">—</p>)}
              {card('Xấu đi sau khi trả lời', m.staff.sentimentAfterReply.worseItems.length ? <ul className="text-body-sm">{m.staff.sentimentAfterReply.worseItems.map((w, i) => <li key={i}><Link href={`/cs/${w.ticketId}`} className="text-secondary">#{w.fdTicketId}</Link></li>)}</ul> : <p className="text-body-sm text-on-surface-variant">—</p>)}
            </div>

            <div className="grid grid-cols-1 gap-lg xl:grid-cols-2">
              {card('Điểm từng thư (1 → 5)', <Histogram values={data.scoreHistogram} labels={['1', '2', '3', '4', '5']} />)}
              {card('Lỗi theo rubric', <Bars data={data.issueCounts} labels={RUBRIC_LABELS} />)}
            </div>

            {card(`Thư đã chấm (${reviews.length})`, (
              <div className="space-y-md">
                {reviews.length === 0 && <p className="text-body-sm text-on-surface-variant">Chưa có thư nào được chấm trong kỳ. Chạy backfill ở Cài đặt CS để chấm lịch sử.</p>}
                {reviews.map(r => (
                  <div key={r.id} className="rounded-lg border border-outline-variant/20 p-md">
                    <div className="flex flex-wrap items-center gap-sm text-label-sm text-on-surface-variant">
                      <span className={`rounded-full px-sm py-xs text-label-sm ${r.score <= 2 ? 'bg-error text-on-error' : r.score === 3 ? 'bg-surface-container-high' : 'bg-tertiary-container text-on-tertiary-container'}`}>{r.score}/5</span>
                      <Link href={`/cs/${r.ticketId}`} className="text-secondary">#{r.fdTicketId}</Link>
                      <span>{fmtDate(r.at, true)}</span>
                      <span>{r.who === 'AGENT' ? 'Agent' : 'Nhân sự'}{r.source === 'DRAFT_UNCHANGED' ? ' (gửi nguyên nháp)' : ''}</span>
                      {r.issues.map(i => <span key={i} className="rounded-full bg-surface-container px-sm py-xs">{RUBRIC_LABELS[i as keyof typeof RUBRIC_LABELS] ?? i}</span>)}
                    </div>
                    <p className="mt-xs whitespace-pre-wrap text-body-sm italic text-on-surface-variant">“{r.quote}”</p>
                    <p className="mt-xs text-body-sm">{r.reason}</p>
                    {r.rewrite && <p className="mt-xs rounded-lg bg-surface-container-low p-sm text-body-sm"><span className="text-label-sm uppercase text-on-surface-variant">Nên viết:</span> {r.rewrite}</p>}
                  </div>
                ))}
              </div>
            ), (
              <select value={issueFilter} onChange={e => setIssueFilter(e.target.value)} className="rounded-lg border border-outline-variant/40 bg-surface px-md py-xs text-body-sm">
                <option value="">Mọi lỗi</option>
                {Object.entries(RUBRIC_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            ))}

            {data.reports.length > 1 && card('Các bản đánh giá trước', <ul className="space-y-sm text-body-sm">{data.reports.slice(1).map(r => <li key={r.id}><details><summary className="cursor-pointer text-secondary">{fmtDate(r.periodStart)} – {fmtDate(r.periodEnd)} · {r.kind === 'WEEKLY' ? 'tự động' : 'bấm tay'}</summary><div className="mt-sm"><Markdown text={r.body} /></div></details></li>)}</ul>)}
          </div>
        )}
      </main>
    </div>
    </RoleGate>
  )
}
