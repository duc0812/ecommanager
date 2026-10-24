'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { UrgencyChip, fmtDate, hoursLabel } from '@/components/cs/UrgencyChip'
import { CATEGORY_LABELS, FACTORY_LABELS, ISSUE_LABELS, SENTIMENT_LABELS, STAGE_LABELS } from '@/lib/cs/labels'
import { STAGES } from '@/lib/cs/root-cause-prompt'
import { RUBRIC_LABELS } from '@/lib/cs/review-prompt'

type Message = { id: string; author: string; private: boolean; bodyText: string; displayText: string; quoted: string | null; createdAt: string; fromEmail: string | null; source: string; sentiment: string | null }
type ReviewRow = { messageId: string; score: number; issues: string; reason: string; rewrite: string | null }
type Analysis = { id: string; runAt: string; category: string; urgency: string; sentiment: string; summary: string; proposal: string; draftReply: string | null; needsHuman: boolean; citedCaseIds: string; gateJson: string; outputJson: string; model: string; rootCauseStage: string | null; rootCauseEvidence: string | null; rootCauseConfidence: string | null; issueType: string | null }
type Order = {
  shopifyOrderNumber: string; placedAt: string; customerName: string | null; shipTo: string; factoryState: keyof typeof FACTORY_LABELS; pipelineStatus: string; supplierHandoffAt: string | null
  lines: { title: string; variant: string | null; qty: number; customized: boolean }[]
  shipments: { trackingNumber: string | null; carrier: string | null; status: string; lastCheckpointAt: string | null; trackingUrl: string | null }[]
  designTaskStatuses: string[]
}
type Detail = {
  ticket: { id: string; fdTicketId: number; subject: string; requesterEmail: string | null; requesterName: string | null; orderNumber: string | null; urgency: string | null; category: string | null; sentiment: string | null; needsHuman: boolean; autoReplied: boolean; resolvedInTool: boolean; fdStatus: number; lastCustomerAt: string | null; lastReplyAt: string | null; rootCauseStageOverride: string | null; rootCauseNote: string | null }
  messages: Message[]
  analysis: Analysis | null
  order: { match: string; order: Order | null; candidates: string[] }
  cases: { id: string; title: string }[]
  reviews: ReviewRow[]
}

const FACTORY_COLOR: Record<string, string> = { NOT_SENT: 'text-on-tertiary-container', AT_FACTORY: 'text-secondary', SHIPPED: 'text-primary', DELIVERED: 'text-on-surface-variant', CANCELLED: 'text-error' }

export default function CsTicketPage() {
  const { id } = useParams<{ id: string }>()
  const router = useRouter()
  const [detail, setDetail] = useState<Detail | null>(null)
  const [reply, setReply] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [lastSent, setLastSent] = useState<string | null>(null)
  const [rootCauseForm, setRootCauseForm] = useState<{ stage: string; note: string } | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/cs/tickets/${id}`)
    if (!res.ok) { setDetail(null); return }
    const d: Detail = await res.json()
    setDetail(d)
    if (!d.ticket.lastReplyAt) setReply(prev => prev || d.analysis?.draftReply || '')
  }, [id])
  useEffect(() => { load() }, [load])

  async function post(path: string, body?: unknown, label?: string) {
    setBusy(label ?? path)
    setMessage(null)
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await res.json().catch(() => ({}))
    setBusy(null)
    if (!res.ok) { setMessage(data.error ?? 'Thao tác thất bại'); return null }
    return data
  }

  async function send(isPrivate: boolean) {
    if (!reply.trim()) return
    const data = await post(`/api/cs/tickets/${id}/reply`, { body: reply, private: isPrivate }, 'send')
    if (!data) return
    setMessage(isPrivate ? 'Đã lưu ghi chú nội bộ.' : 'Đã gửi cho khách.')
    if (!isPrivate) setLastSent(reply)
    setReply('')
    load()
  }

  async function promote() {
    if (!lastSent) return
    const data = await post('/api/cs/cases/promote', { ticketId: id, replyBody: lastSent }, 'promote')
    if (data?.case) router.push(`/cs/cases?edit=${data.case.id}`)
  }

  if (!detail) {
    return (
      <RoleGate>
      <div className="flex min-h-screen bg-surface"><Sidebar /><main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl"><p className="text-body-sm text-on-surface-variant">Đang tải ticket…</p></main></div>
      </RoleGate>
    )
  }

  const { ticket, messages, analysis, order, cases, reviews } = detail
  const reviewByMessage = new Map(reviews.map(r => [r.messageId, r]))
  const effectiveStage = ticket.rootCauseStageOverride ?? analysis?.rootCauseStage ?? null
  const o = order.order
  const gate: { allowed?: boolean; reasons?: string[] } = analysis ? (() => { try { return JSON.parse(analysis.gateJson) } catch { return {} } })() : {}
  const facts: string[] = analysis ? (() => { try { return JSON.parse(analysis.outputJson).facts ?? [] } catch { return [] } })() : []
  const hours = ticket.lastCustomerAt && (!ticket.lastReplyAt || ticket.lastReplyAt < ticket.lastCustomerAt) ? (Date.now() - new Date(ticket.lastCustomerAt).getTime()) / 3600_000 : 0

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-lg">
          <Link href="/cs" className="text-label-sm uppercase tracking-wider text-on-surface-variant">← Tickets</Link>
          <div className="mt-xs flex flex-wrap items-center gap-sm">
            <UrgencyChip urgency={ticket.urgency} />
            <h2 className="text-headline-lg text-primary">#{ticket.fdTicketId} · {ticket.subject || '(không tiêu đề)'}</h2>
          </div>
          <p className="mt-xs text-body-sm text-on-surface-variant">
            {ticket.requesterName ?? '—'} &lt;{ticket.requesterEmail ?? '—'}&gt; · <span className={hours > 24 ? 'text-error' : ''}>{hoursLabel(hours)}</span> ·{' '}
            <a className="text-secondary" href={`https://litzzy.freshdesk.com/a/tickets/${ticket.fdTicketId}`} target="_blank" rel="noreferrer">Mở trên Freshdesk</a>
            {ticket.autoReplied && <span className="ml-sm rounded-full bg-secondary/10 px-sm py-xs text-label-sm text-secondary">Agent đã trả lời</span>}
            {ticket.resolvedInTool && <span className="ml-sm rounded-full bg-surface-container-high px-sm py-xs text-label-sm">Đã xong</span>}
          </p>
        </header>
        {message && <p className="mb-md rounded-lg bg-surface-container px-md py-sm text-body-sm text-on-surface-variant">{message}</p>}

        <div className="grid grid-cols-1 gap-lg xl:grid-cols-[1fr_380px]">
          <section className="space-y-md">
            <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
              <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">Hội thoại</h3></div>
              <div className="space-y-md p-lg">
                {messages.map(m => {
                  const mine = m.author !== 'CUSTOMER'
                  return (
                    <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] rounded-xl px-md py-sm ${m.private ? 'border border-dashed border-outline-variant bg-surface' : mine ? 'bg-secondary-container text-on-secondary-container' : 'bg-surface-container'}`}>
                        <p className={`mb-xs text-label-sm ${m.private ? 'text-on-surface-variant' : mine ? 'text-on-secondary-container/80' : 'text-on-surface-variant'}`}>
                          {m.author === 'CUSTOMER' ? 'Khách' : m.author === 'AGENT' ? 'Agent' : m.author === 'STAFF' ? 'Nhân sự' : m.author}{m.private ? ' · Ghi chú nội bộ' : ''} · {fmtDate(m.createdAt, true)}
                        </p>
                        <p className="whitespace-pre-wrap text-body-sm leading-relaxed">{m.displayText || m.bodyText || '(trống)'}</p>
                        {m.quoted && (
                          <details className="mt-xs">
                            <summary className="cursor-pointer text-label-sm text-on-surface-variant">Phần trích dẫn / chữ ký</summary>
                            <p className="mt-xs whitespace-pre-wrap text-label-sm text-on-surface-variant">{m.quoted}</p>
                          </details>
                        )}
                        {m.author === 'STAFF' && m.source === 'DRAFT_UNCHANGED' && <p className="mt-xs text-label-sm text-on-secondary-container/80">gửi nguyên nháp agent</p>}
                        {m.author === 'STAFF' && m.source === 'DRAFT_EDITED' && <p className="mt-xs text-label-sm text-on-secondary-container/80">nháp agent đã sửa</p>}
                        {m.author === 'CUSTOMER' && m.sentiment && <p className="mt-xs text-label-sm text-on-surface-variant">{SENTIMENT_LABELS[m.sentiment as keyof typeof SENTIMENT_LABELS] ?? m.sentiment}</p>}
                        {reviewByMessage.get(m.id) && (() => { const r = reviewByMessage.get(m.id)!; const issues: string[] = (() => { try { return JSON.parse(r.issues) } catch { return [] } })(); return (
                          <div className={`mt-sm rounded-lg p-sm text-label-sm ${mine ? 'bg-surface-container-lowest/80 text-on-surface' : 'bg-surface'}`}>
                            <span className={`mr-xs rounded-full px-sm ${r.score <= 2 ? 'bg-error text-on-error' : r.score === 3 ? 'bg-surface-container-high' : 'bg-tertiary-container text-on-tertiary-container'}`}>{r.score}/5</span>
                            {issues.map(i => <span key={i} className="mr-xs rounded-full bg-surface-container px-sm">{RUBRIC_LABELS[i as keyof typeof RUBRIC_LABELS] ?? i}</span>)}
                            <p className="mt-xs">{r.reason}</p>
                            {r.rewrite && <p className="mt-xs italic">Nên viết: {r.rewrite}</p>}
                          </div>
                        ) })()}
                      </div>
                    </div>
                  )
                })}
                {messages.length === 0 && <p className="text-body-sm text-on-surface-variant">Chưa có tin nhắn.</p>}
              </div>
            </div>

            <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
              <div className="flex items-center justify-between border-b border-outline-variant/20 px-lg py-md">
                <h3 className="text-headline-sm text-primary">Trả lời</h3>
                {analysis?.draftReply && reply !== analysis.draftReply && <button onClick={() => setReply(analysis.draftReply!)} className="text-label-sm text-secondary">Lấy lại bản nháp của agent</button>}
              </div>
              <div className="p-lg">
                <textarea value={reply} onChange={e => setReply(e.target.value)} rows={8} placeholder="Viết thư cho khách (tiếng Anh)…" className="w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm" />
                <div className="mt-sm flex flex-wrap items-center gap-sm">
                  <button onClick={() => send(false)} disabled={busy !== null || !reply.trim()} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary disabled:opacity-50">{busy === 'send' ? 'Đang gửi…' : 'Gửi khách'}</button>
                  <button onClick={() => send(true)} disabled={busy !== null || !reply.trim()} className="rounded-lg border border-outline-variant/40 px-lg py-sm text-label-md text-primary disabled:opacity-50">Ghi chú nội bộ</button>
                  {lastSent && <button onClick={promote} disabled={busy !== null} className="ml-auto rounded-lg border border-secondary/40 px-lg py-sm text-label-md text-secondary">Lưu thành case mẫu</button>}
                </div>
              </div>
            </div>
          </section>

          <aside className="space-y-md">
            <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
              <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">Đơn hàng</h3></div>
              <div className="space-y-sm p-lg text-body-sm">
                {!o && <p className="text-on-surface-variant">{order.match === 'AMBIGUOUS' ? `Nhiều đơn cùng email: ${order.candidates.join(', ')}` : 'Không tìm thấy đơn trong tool.'}</p>}
                {o && (
                  <>
                    <p><Link href={`/fulfillment/orders?q=${encodeURIComponent(o.shopifyOrderNumber)}`} className="text-label-md text-secondary">{o.shopifyOrderNumber}</Link> <span className="text-on-surface-variant">· đặt {fmtDate(o.placedAt)}{order.match === 'BY_EMAIL' ? ' · tìm theo email' : ''}</span></p>
                    <p className={`text-label-md ${FACTORY_COLOR[o.factoryState] ?? ''}`}>{FACTORY_LABELS[o.factoryState] ?? o.factoryState}{o.supplierHandoffAt ? ` (${fmtDate(o.supplierHandoffAt)})` : ''}</p>
                    <p className="text-on-surface-variant">Ship to: {o.shipTo || '—'}</p>
                    <ul className="list-disc pl-md">
                      {o.lines.map((l, i) => <li key={i}>{l.qty}× {l.title}{l.variant ? ` (${l.variant})` : ''}{l.customized ? ' · cá nhân hoá' : ''}</li>)}
                    </ul>
                    {o.shipments.length > 0 ? o.shipments.map((s, i) => (
                      <p key={i}>
                        {s.trackingUrl ? <a className="text-secondary" href={s.trackingUrl} target="_blank" rel="noreferrer">{s.trackingNumber}</a> : (s.trackingNumber ?? 'chưa có tracking')}
                        <span className="text-on-surface-variant"> · {s.carrier ?? ''} {s.status} · scan {fmtDate(s.lastCheckpointAt)}</span>
                      </p>
                    )) : <p className="text-on-surface-variant">Chưa có tracking.</p>}
                    {o.designTaskStatuses.length > 0 && <p className="text-on-surface-variant">Design: {o.designTaskStatuses.join(', ')}</p>}
                  </>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
              <div className="flex items-center justify-between border-b border-outline-variant/20 px-lg py-md">
                <h3 className="text-headline-sm text-primary">Agent</h3>
                <button onClick={async () => { if (await post(`/api/cs/tickets/${id}/analyze`, undefined, 'analyze')) { setReply(''); load() } }} disabled={busy !== null} className="text-label-sm text-secondary disabled:opacity-50">{busy === 'analyze' ? 'Đang phân tích…' : 'Phân tích lại'}</button>
              </div>
              <div className="space-y-sm p-lg text-body-sm">
                {!analysis && <p className="text-on-surface-variant">Chưa có phân tích (cần Anthropic API key trong Cài đặt CS).</p>}
                {analysis && (
                  <>
                    <p className="flex flex-wrap gap-xs">
                      <UrgencyChip urgency={analysis.urgency} />
                      <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm">{CATEGORY_LABELS[analysis.category as keyof typeof CATEGORY_LABELS] ?? analysis.category}</span>
                      <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm">{SENTIMENT_LABELS[analysis.sentiment as keyof typeof SENTIMENT_LABELS] ?? analysis.sentiment}</span>
                    </p>
                    <p className="whitespace-pre-wrap">{analysis.summary}</p>
                    {facts.length > 0 && <ul className="list-disc pl-md text-on-surface-variant">{facts.map((f, i) => <li key={i}>{f}</li>)}</ul>}
                    <div className="rounded-lg bg-surface-container-low p-md">
                      <p className="text-label-sm uppercase text-on-surface-variant">Đề xuất</p>
                      <p className="whitespace-pre-wrap">{analysis.proposal}</p>
                      {cases.length > 0 && <p className="mt-xs text-label-sm">Theo case: {cases.map(c => <Link key={c.id} href={`/cs/cases?edit=${c.id}`} className="mr-sm text-secondary">{c.title}</Link>)}</p>}
                    </div>
                    {gate.allowed === false && gate.reasons && gate.reasons.length > 0 && (
                      <p className="text-label-sm text-on-surface-variant">Không tự gửi vì: {gate.reasons.join('; ')}</p>
                    )}
                    <p className="text-label-sm text-on-surface-variant">{analysis.model} · {fmtDate(analysis.runAt, true)}</p>
                  </>
                )}
                {!ticket.resolvedInTool && (
                  <button onClick={async () => { if (await post(`/api/cs/tickets/${id}/resolve`, undefined, 'resolve')) load() }} disabled={busy !== null} className="mt-sm w-full rounded-lg border border-outline-variant/40 px-lg py-sm text-label-md text-primary disabled:opacity-50">{busy === 'resolve' ? 'Đang cập nhật…' : 'Đánh dấu xong'}</button>
                )}
              </div>
            </div>
            <div className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
              <div className="border-b border-outline-variant/20 px-lg py-md"><h3 className="text-headline-sm text-primary">Nguyên nhân</h3></div>
              <div className="space-y-sm p-lg text-body-sm">
                {!effectiveStage && <p className="text-on-surface-variant">Chưa điều tra (chỉ ticket có vấn đề và có đơn khớp mới được điều tra).</p>}
                {effectiveStage && (
                  <>
                    <p className="flex flex-wrap items-center gap-xs">
                      <span className="rounded-full bg-primary px-sm py-xs text-label-sm text-on-primary">{STAGE_LABELS[effectiveStage as keyof typeof STAGE_LABELS] ?? effectiveStage}</span>
                      {analysis?.issueType && <span className="rounded-full bg-surface-container px-sm py-xs text-label-sm">{ISSUE_LABELS[analysis.issueType as keyof typeof ISSUE_LABELS] ?? analysis.issueType}</span>}
                      {ticket.rootCauseStageOverride ? <span className="text-label-sm text-secondary">sửa tay</span> : analysis?.rootCauseConfidence && <span className="text-label-sm text-on-surface-variant">tin cậy {analysis.rootCauseConfidence}</span>}
                    </p>
                    <p className="whitespace-pre-wrap text-on-surface-variant">{ticket.rootCauseNote ?? analysis?.rootCauseEvidence}</p>
                  </>
                )}
                {rootCauseForm ? (
                  <div className="space-y-xs">
                    <select value={rootCauseForm.stage} onChange={e => setRootCauseForm({ ...rootCauseForm, stage: e.target.value })} className="w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-xs">
                      <option value="">— theo agent —</option>
                      {STAGES.map(s => <option key={s} value={s}>{STAGE_LABELS[s]}</option>)}
                    </select>
                    <textarea value={rootCauseForm.note} onChange={e => setRootCauseForm({ ...rootCauseForm, note: e.target.value })} rows={2} placeholder="Ghi chú (vì sao)" className="w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-xs" />
                    <div className="flex gap-sm">
                      <button onClick={async () => { const res = await fetch(`/api/cs/tickets/${id}/root-cause`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ stage: rootCauseForm.stage || null, note: rootCauseForm.note }) }); if (res.ok) { setRootCauseForm(null); load() } else setMessage((await res.json().catch(() => ({}))).error ?? 'Lưu thất bại') }} className="rounded-lg bg-secondary px-md py-xs text-label-md text-on-secondary">Lưu</button>
                      <button onClick={() => setRootCauseForm(null)} className="rounded-lg border border-outline-variant/40 px-md py-xs text-label-md">Huỷ</button>
                    </div>
                  </div>
                ) : (
                  <button onClick={() => setRootCauseForm({ stage: ticket.rootCauseStageOverride ?? '', note: ticket.rootCauseNote ?? '' })} className="text-label-sm text-secondary">Sửa khâu lỗi</button>
                )}
              </div>
            </div>
          </aside>
        </div>
      </main>
    </div>
    </RoleGate>
  )
}
