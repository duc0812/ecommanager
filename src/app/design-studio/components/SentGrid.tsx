'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { HandoffCard, Me } from './types'
import { requestJson } from './model'
import { SENT_STAGE_LABELS, type HandoffSent, type SentStage } from '@/lib/handoff-shared'
import { OrderCard, fmtDateTime } from './HandoffGrid'
import HandoffButton from './HandoffButton'
import { ErrorBanner, ExtLink, Icon, Pill, btn, card } from './ui'

type SentResponse = {
  sent: HandoffCard[]; windowDays: number; total: number; me: Me
  stageCounts: Partial<Record<SentStage, number>>; suppliers: { id: string; name: string; count: number }[]
}
type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'brand'

const STAGE_ORDER: SentStage[] = ['API_SENDING', 'API_COOLING', 'CSV_WAITING', 'API_SENT', 'CSV_EXPORTED', 'TRACKING', 'FULFILLED']
const STAGE_LOOK: Record<SentStage, { tone: Tone; icon: string }> = {
  API_SENDING: { tone: 'bad', icon: 'sync_problem' },
  API_COOLING: { tone: 'warn', icon: 'timer' },
  CSV_WAITING: { tone: 'warn', icon: 'inventory' },
  API_SENT: { tone: 'brand', icon: 'precision_manufacturing' },
  CSV_EXPORTED: { tone: 'brand', icon: 'description' },
  TRACKING: { tone: 'ok', icon: 'local_shipping' },
  FULFILLED: { tone: 'ok', icon: 'task_alt' },
}

function timeLeft(untilIso: string, now: number): string {
  const min = Math.max(0, Math.round((new Date(untilIso).getTime() - now) / 60000))
  return min >= 60 ? `${Math.floor(min / 60)}h${String(min % 60).padStart(2, '0')}` : `${min} phút`
}

function SentFooter({ c, sent, me, now, onChanged, onError }: {
  c: HandoffCard; sent: HandoffSent; me: Me | null; now: number; onChanged: (info: string) => void; onError: (msg: string) => void
}) {
  const look = STAGE_LOOK[sent.stage]
  const live = !!c.state.handedOff || !!c.state.push
  return (
    <div className="mt-auto px-md py-sm border-t border-outline-variant/20 flex flex-col gap-xs text-label-sm">
      <div className="flex items-center gap-sm flex-wrap">
        <Pill tone={look.tone} icon={look.icon}>{SENT_STAGE_LABELS[sent.stage]}</Pill>
        <Pill tone="idle" icon={sent.via === 'API' ? 'cloud_done' : 'table_view'}>{sent.via === 'API' ? 'API' : 'CSV'}</Pill>
        {sent.code && <span className="font-mono text-on-surface">{sent.code}</span>}
        {sent.remoteStatus && <span className="text-on-surface-variant">· xưởng: {sent.remoteStatus}</span>}
        <span className="text-on-surface-variant">
          {sent.at ? fmtDateTime(sent.at) : ''}{sent.byName ? ` · ${sent.byName}` : ''}
        </span>
      </div>
      {sent.cancelUntil && (
        <span className="text-amber-900 font-semibold inline-flex items-center gap-xs">
          <Icon name="timer" className="text-[15px]" />Huỷ được tới {fmtDateTime(sent.cancelUntil)} (còn {timeLeft(sent.cancelUntil, now)}) — mở &quot;Xem đơn PGprints&quot; để huỷ
        </span>
      )}
      {sent.stage === 'API_SENDING' && (
        <span className="text-error font-semibold">Chưa rõ PGprints đã nhận đơn chưa — mở &quot;Xem đơn PGprints&quot; và bấm cập nhật trạng thái trước khi làm gì khác</span>
      )}
      {sent.tracking.length > 0 && (
        <span className="inline-flex items-center gap-xs flex-wrap">
          <Icon name="local_shipping" className="text-[15px] text-on-surface-variant" />
          {sent.tracking.map(t => (
            <span key={t.number} className="font-mono">
              {t.url ? <ExtLink href={t.url}>{t.number}</ExtLink> : t.number}{t.carrier ? <span className="font-sans text-on-surface-variant"> ({t.carrier})</span> : null}
            </span>
          ))}
        </span>
      )}
      {live && (
        <div className="flex items-center gap-sm flex-wrap">
          <HandoffButton orderId={c.order.id} state={c.state} canHandoff={!!me?.canHandoff} onChanged={onChanged} onError={onError} />
          {sent.stage === 'CSV_WAITING' && <Link href="/fulfillment/export" className="text-secondary hover:underline">Mở trang CSV Export</Link>}
        </div>
      )}
    </div>
  )
}

export default function SentGrid({ q, version, onOpenTask, onChanged }: {
  q: string; version: number; onOpenTask: (key: string) => void; onChanged: () => void
}) {
  const [data, setData] = useState<SentResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [info, setInfo] = useState('')
  const [stage, setStage] = useState<SentStage | 'ALL'>('ALL')
  const [supplier, setSupplier] = useState<string>('ALL')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    setLoading(true)
    const qs = new URLSearchParams({ view: 'sent' })
    if (q) qs.set('q', q)
    if (stage !== 'ALL') qs.set('stage', stage)
    if (supplier !== 'ALL') qs.set('supplier', supplier)
    const r = await requestJson<SentResponse>(`/api/design-studio/handoff?${qs}`)
    setLoading(false)
    if (!r.ok) { setError(r.status === 0 ? 'Mất kết nối tới máy chủ — bấm "Tải lại" để thử lại' : r.error); return }
    setError('')
    setData(r.data)
  }, [q, stage, supplier])

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
            {shown.length < (stage === 'ALL' ? total : stageCount(stage as SentStage)) ? ` · đang hiện ${shown.length} đơn mới nhất` : ''}
          </span>
          {loading && <Icon name="progress_activity" className="text-on-surface-variant text-[16px] animate-spin" />}
          <button type="button" className={`${btn} ml-auto`} onClick={load} disabled={loading}><Icon name="refresh" className="text-[16px]" />Tải lại</button>
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
      <div className="grid grid-cols-[repeat(auto-fill,minmax(460px,1fr))] gap-md items-start">
        {shown.map(c => (
          <OrderCard key={c.order.id} c={c} me={me} onOpenTask={onOpenTask} onChanged={changed} onError={fail}
            footer={<SentFooter c={c} sent={c.sent!} me={me} now={now} onChanged={changed} onError={fail} />} />
        ))}
      </div>
    </section>
  )
}
