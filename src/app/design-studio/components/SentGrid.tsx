'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { HandoffCard, Me } from './types'
import { requestJson } from './model'
import { SENT_STAGE_LABELS, type HandoffSent, type SentStage } from '@/lib/handoff-shared'
import { fmtDateTime } from './HandoffGrid'
import HandoffButton from './HandoffButton'
import { ErrorBanner, ExtLink, Icon, Pill, btn, card, input } from './ui'

type SentResponse = {
  sent: HandoffCard[]; windowDays: number; total: number; matched: number; me: Me
  stageCounts: Partial<Record<SentStage, number>>; suppliers: { id: string; name: string; count: number }[]
}
type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'brand'

const STAGE_ORDER: SentStage[] = ['API_SENDING', 'API_COOLING', 'CSV_WAITING', 'API_SENT', 'SHEET_SENT', 'CSV_EXPORTED', 'TRACKING', 'FULFILLED']
const STAGE_LOOK: Record<SentStage, { tone: Tone; icon: string }> = {
  API_SENDING: { tone: 'bad', icon: 'sync_problem' },
  API_COOLING: { tone: 'warn', icon: 'timer' },
  CSV_WAITING: { tone: 'warn', icon: 'inventory' },
  API_SENT: { tone: 'brand', icon: 'precision_manufacturing' },
  CSV_EXPORTED: { tone: 'brand', icon: 'description' },
  SHEET_SENT: { tone: 'brand', icon: 'table_view' },
  TRACKING: { tone: 'ok', icon: 'local_shipping' },
  FULFILLED: { tone: 'ok', icon: 'task_alt' },
}

function timeLeft(untilIso: string, now: number): string {
  const min = Math.max(0, Math.round((new Date(untilIso).getTime() - now) / 60000))
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min} phút`
}

function fmtDay(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' }) : '—'
}

function SentRow({ c, sent, me, now, onOpenTask, onChanged, onError }: {
  c: HandoffCard; sent: HandoffSent; me: Me | null; now: number; onOpenTask: (key: string) => void; onChanged: (info: string) => void; onError: (msg: string) => void
}) {
  const look = STAGE_LOOK[sent.stage]
  const live = !!c.state.handedOff || !!c.state.push
  const known = c.lines.filter(l => l.baseCost != null)
  const cost = known.reduce((sum, l) => sum + (l.baseCost ?? 0), 0)
  return (
    <tr className="border-t border-outline-variant/20 align-top hover:bg-surface-container-low/60">
      <td className="px-sm py-sm">
        <span className="font-mono font-semibold text-on-surface">{c.order.orderNumber}</span>
        <div className="text-label-sm text-on-surface-variant truncate">{c.order.storeName}</div>
      </td>
      <td className="px-sm py-sm">
        <div className="flex flex-col gap-[2px]">
          {c.lines.map(l => (
            <button key={l.line.id} type="button" onClick={() => onOpenTask(l.taskKey)} title={l.line.productTitle} className="text-left font-mono text-label-sm text-secondary hover:underline truncate">{l.taskKey}</button>
          ))}
        </div>
      </td>
      <td className="px-sm py-sm">
        <div className="flex flex-col gap-[2px] text-label-sm min-w-0">
          {c.lines.map(l => <span key={l.line.id} className="truncate text-on-surface" title={l.line.productTitle}>{l.line.productTitle}</span>)}
        </div>
      </td>
      <td className="px-sm py-sm text-label-sm truncate">{c.suppliers.map(x => x.name).join(', ') || '—'}</td>
      <td className="px-sm py-sm text-right text-label-sm" title="Base cost, chưa gồm phí ship">{known.length ? `$${cost.toFixed(2)}${known.length < c.lines.length ? '+' : ''}` : '—'}</td>
      <td className="px-sm py-sm text-label-sm" title={c.order.shipTo ?? undefined}>{c.order.countryCode ?? c.order.country ?? '—'}</td>
      <td className="px-sm py-sm">
        <div className="flex flex-col items-start gap-[2px]">
          <Pill tone={look.tone} icon={look.icon}>{SENT_STAGE_LABELS[sent.stage]}</Pill>
          {sent.cancelUntil && <span className="text-label-sm text-amber-900 font-semibold">Huỷ được, còn {timeLeft(sent.cancelUntil, now)}</span>}
          {sent.stage === 'API_SENDING' && <span className="text-label-sm text-error font-semibold">Chưa rõ xưởng đã nhận chưa, mở đơn và cập nhật trước</span>}
        </div>
      </td>
      <td className="px-sm py-sm text-label-sm">{sent.via}</td>
      <td className="px-sm py-sm text-label-sm">
        {sent.code && <div className="font-mono truncate" title={sent.code}>{sent.code}</div>}
        {sent.remoteStatus && <div className="text-on-surface-variant truncate" title={sent.remoteStatus}>{sent.remoteStatus}</div>}
        {!sent.code && !sent.remoteStatus && '—'}
      </td>
      <td className="px-sm py-sm text-label-sm">
        {sent.tracking.length === 0 && '—'}
        {sent.tracking.map(t => (
          <div key={t.number} className="font-mono truncate" title={t.carrier ?? undefined}>{t.url ? <ExtLink href={t.url}>{t.number}</ExtLink> : t.number}</div>
        ))}
      </td>
      <td className="px-sm py-sm text-label-sm" title={sent.at ? fmtDateTime(sent.at) : undefined}>
        {fmtDay(sent.at)}
        {sent.byName && <div className="text-on-surface-variant truncate">{sent.byName}</div>}
      </td>
      <td className="px-sm py-sm">
        {live && (
          <div className="flex flex-col items-start gap-xs text-label-sm">
            <HandoffButton compact orderId={c.order.id} state={c.state} canHandoff={!!me?.canHandoff} onChanged={onChanged} onError={onError} />
            {sent.stage === 'CSV_WAITING' && <Link href="/fulfillment/export" className="text-secondary hover:underline">CSV Export</Link>}
          </div>
        )}
      </td>
    </tr>
  )
}

export default function SentGrid({ q, rawQ, onQ, version, onOpenTask, onChanged }: {
  q: string; rawQ: string; onQ: (v: string) => void; version: number; onOpenTask: (key: string) => void; onChanged: () => void
}) {
  const [data, setData] = useState<SentResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [info, setInfo] = useState('')
  const [stage, setStage] = useState<SentStage | 'ALL'>('ALL')
  const [supplier, setSupplier] = useState<string>('ALL')
  const [now, setNow] = useState(() => Date.now())
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  useEffect(() => { setPage(1) }, [q, stage, supplier, pageSize])

  const load = useCallback(async () => {
    setLoading(true)
    const qs = new URLSearchParams({ view: 'sent' })
    if (q) qs.set('q', q)
    if (stage !== 'ALL') qs.set('stage', stage)
    if (supplier !== 'ALL') qs.set('supplier', supplier)
    qs.set('page', String(page))
    qs.set('pageSize', String(pageSize))
    const r = await requestJson<SentResponse>(`/api/design-studio/handoff?${qs}`)
    setLoading(false)
    if (!r.ok) { setError(r.status === 0 ? 'Mất kết nối tới máy chủ — bấm "Tải lại" để thử lại' : r.error); return }
    setError('')
    setData(r.data)
  }, [q, stage, supplier, page, pageSize])

  useEffect(() => { load() }, [load, version])
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(t)
  }, [])

  const changed = useCallback((message: string) => {
    setActionError('')
    setInfo(message)
    void load()
    onChanged()
  }, [load, onChanged])
  const fail = useCallback((message: string) => { setInfo(''); setActionError(message) }, [])

  const shown = useMemo(() => (data?.sent ?? []).filter(c => c.sent), [data])
  const suppliers = data?.suppliers ?? []
  const total = data?.total ?? 0
  const matched = data?.matched ?? 0
  const lastPage = Math.max(1, Math.ceil(matched / pageSize))
  const stageCount = (s: SentStage) => data?.stageCounts[s] ?? 0
  const me = data?.me ?? null
  const chip = (on: boolean) => `inline-flex items-center gap-xs rounded-full border px-sm py-[2px] text-label-sm ${on ? 'bg-secondary/10 text-secondary border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant'}`

  return (
    <section aria-label="Đã chuyển xưởng" className="flex flex-col gap-md min-w-0">
      <div className={`${card} px-md py-sm flex flex-col gap-sm`}>
        <div className="flex items-center gap-sm flex-wrap">
          <Icon name="local_shipping" className="text-secondary text-[20px]" />
          <h2 className="text-body-md font-semibold text-on-surface">Đã chuyển xưởng</h2>
          <span className="text-label-sm text-on-surface-variant">
            {q ? `${total} đơn khớp "${q}" (mọi thời gian)` : `${total} đơn chuyển xưởng trong ${data?.windowDays ?? 14} ngày qua · gõ tìm kiếm để xem đơn cũ hơn`}
          </span>
          {loading && <Icon name="progress_activity" className="text-on-surface-variant text-[16px] animate-spin" />}
          <input type="search" value={rawQ} onChange={e => onQ(e.target.value)} placeholder="Tìm mã đơn, tên, SKU…" aria-label="Tìm đơn đã chuyển" className={`${input} ml-auto w-[240px]`} />
          <button type="button" className={btn} onClick={load} disabled={loading}><Icon name="refresh" className="text-[16px]" />Tải lại</button>
        </div>
        <div className="flex items-center gap-xs flex-wrap" role="group" aria-label="Lọc theo trạng thái">
          <button type="button" aria-pressed={stage === 'ALL'} className={chip(stage === 'ALL')} onClick={() => setStage('ALL')}>Tất cả <span className="font-normal">{total}</span></button>
          {STAGE_ORDER.filter(s => stageCount(s) > 0 || stage === s).map(s => (
            <button key={s} type="button" aria-pressed={stage === s} className={chip(stage === s)} onClick={() => setStage(stage === s ? 'ALL' : s)}>
              <Icon name={STAGE_LOOK[s].icon} className="text-[14px]" />{SENT_STAGE_LABELS[s]} <span className="font-normal">{stageCount(s)}</span>
            </button>
          ))}
        </div>
        {suppliers.length > 1 && (
          <div className="flex items-center gap-xs flex-wrap" role="group" aria-label="Lọc theo xưởng">
            <button type="button" aria-pressed={supplier === 'ALL'} className={chip(supplier === 'ALL')} onClick={() => setSupplier('ALL')}><Icon name="factory" className="text-[14px]" />Mọi xưởng</button>
            {suppliers.map(s => (
              <button key={s.id} type="button" aria-pressed={supplier === s.id} className={chip(supplier === s.id)} onClick={() => setSupplier(supplier === s.id ? 'ALL' : s.id)}>
                {s.name} <span className="font-normal">{s.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
      <ErrorBanner msg={actionError} onClose={() => setActionError('')} />
      <ErrorBanner msg={error} />
      {!loading && !error && shown.length === 0 && (
        <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
          <Icon name="inbox" />Không có đơn nào{stage !== 'ALL' ? ` ở trạng thái "${SENT_STAGE_LABELS[stage]}"` : ''}.
        </div>
      )}
      {shown.length > 0 && (
        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-x-auto">
          <table className="w-full table-fixed text-body-sm min-w-[1040px]">
            <thead className="bg-surface-container">
              <tr className="text-left">
                <th className="w-[8%] px-sm py-sm">Order #</th>
                <th className="w-[8%] px-sm py-sm">Task</th>
                <th className="w-[17%] px-sm py-sm">Sản phẩm</th>
                <th className="w-[8%] px-sm py-sm">Xưởng</th>
                <th className="w-[6%] px-sm py-sm text-right">Base cost</th>
                <th className="w-[4%] px-sm py-sm">Nước</th>
                <th className="w-[13%] px-sm py-sm">Trạng thái</th>
                <th className="w-[5%] px-sm py-sm">Kênh</th>
                <th className="w-[9%] px-sm py-sm">Mã xưởng</th>
                <th className="w-[9%] px-sm py-sm">Tracking</th>
                <th className="w-[7%] px-sm py-sm">Ngày gửi</th>
                <th className="w-[6%] px-sm py-sm"></th>
              </tr>
            </thead>
            <tbody>
              {shown.map(c => <SentRow key={c.order.id} c={c} sent={c.sent!} me={me} now={now} onOpenTask={onOpenTask} onChanged={changed} onError={fail} />)}
            </tbody>
          </table>
        </div>
      )}
      {matched > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-md text-body-sm text-on-surface-variant">
          <span className="flex items-center gap-sm">
            {`Đang hiện ${(page - 1) * pageSize + 1}–${Math.min(page * pageSize, matched)} / ${matched} đơn`}
            <select value={pageSize} onChange={e => setPageSize(Number(e.target.value))} aria-label="Số đơn mỗi trang" className="border rounded-lg px-sm py-xs text-body-sm">
              {[25, 50, 100].map(n => <option key={n} value={n}>{n}/trang</option>)}
            </select>
          </span>
          <span className="flex items-center gap-xs">
            <button type="button" className={btn} disabled={page <= 1} onClick={() => setPage(page - 1)}>Trước</button>
            <span>Trang {page}/{lastPage}</span>
            <button type="button" className={btn} disabled={page >= lastPage} onClick={() => setPage(page + 1)}>Sau</button>
          </span>
        </div>
      )}
    </section>
  )
}
