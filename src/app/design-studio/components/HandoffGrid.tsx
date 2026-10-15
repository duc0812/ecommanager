'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import type { HandoffCard, Me } from './types'
import { copyText, mockupFiles, printPartNames, requestJson, taskImages, type LightboxImage } from './model'
import { pushChipLabel } from '@/lib/handoff-shared'
import { LightboxProvider } from './Lightbox'
import PrintFileThumb from './PrintFileThumb'
import ExternalDesignPreview from './ExternalDesignPreview'
import HandoffButton from './HandoffButton'
import { ErrorBanner, ExtLink, Icon, Pill, btn, card } from './ui'

type HandoffResponse = { pending: HandoffCard[]; saved: HandoffCard[]; pendingCount: number; me: Me }

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US')
const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' })

function OrderCard({ c, me, onOpenTask, onChanged, onError }: {
  c: HandoffCard; me: Me | null; onOpenTask: (key: string) => void; onChanged: (info: string) => void; onError: (msg: string) => void
}) {
  const images = useMemo(() => {
    const out: LightboxImage[] = []
    const seen = new Set<string>()
    for (const l of c.lines) for (const m of taskImages(l)) if (!seen.has(m.url)) { seen.add(m.url); out.push(m) }
    return out
  }, [c])
  const { order, state } = c
  const [copied, setCopied] = useState('')
  const destination = order.countryName ? `${order.countryName} (${order.countryCode})` : order.country || 'chưa rõ nước'

  return (
    <LightboxProvider images={images}>
      <article aria-label={`Đơn ${order.orderNumber}`} className={`${card} flex flex-col`}>
        <header className="flex items-center gap-sm flex-wrap px-md py-sm border-b border-outline-variant/20">
          <span className="font-mono font-semibold text-body-md text-on-surface">{order.orderNumber}</span>
          <span className="text-label-sm text-on-surface-variant">{order.storeName} · {fmtDate(order.placedAt)}</span>
          {c.suppliers.map(s => <Pill key={s.id} tone="idle" icon="factory">{s.name}</Pill>)}
          {c.suppliers.length === 0 && <Pill tone="bad" icon="factory">chưa map xưởng</Pill>}
          {state.push && <Pill tone="warn" icon="local_shipping">{pushChipLabel(state.push)}</Pill>}
          {c.exportNote && <Pill tone="warn" icon="call_split">{c.exportNote}</Pill>}
          <span className="ml-auto inline-flex items-center gap-xs text-label-sm text-on-surface" title="Nước giao hàng">
            <Icon name="public" className="text-[16px] text-on-surface-variant" /><b>{destination}</b>
            {order.shipTo && <span className="text-on-surface-variant">· {order.shipTo}</span>}
          </span>
        </header>
        <ul className="divide-y divide-outline-variant/20">
          {c.lines.map(l => {
            const parts = printPartNames(l.line, l.slots)
            const mockups = mockupFiles(l.line)
            return (
            <li key={l.line.id} className="px-md py-sm flex gap-md">
              <div className={`w-[46%] shrink-0 grid gap-sm content-start ${parts.length + mockups.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
                {l.line.artworks.length > 0
                  ? (
                    <>
                      {parts.map(area => <PrintFileThumb key={area} line={l.line} area={area} refLabel={l.taskKey} />)}
                      {mockups.map(m => <PrintFileThumb key={`m-${m.printArea}`} line={l.line} area={m.printArea} kind="MOCKUP" refLabel={l.taskKey} />)}
                    </>
                  )
                  : l.line.designDriveLink && /^https?:/.test(l.line.designDriveLink)
                    ? <ExternalDesignPreview link={l.line.designDriveLink} refLabel={l.taskKey} />
                    : (
                      <div className="aspect-[4/3] rounded-lg border border-outline-variant/30 bg-surface-container-low grid place-items-center text-label-sm text-on-surface-variant p-sm text-center">
                        Design có từ ngoài studio
                      </div>
                    )}
              </div>
              <div className="flex-1 min-w-0 flex flex-col gap-xs text-body-sm">
                <span className="flex items-center gap-xs flex-wrap">
                  <button type="button" onClick={() => onOpenTask(l.taskKey)} title="Mở task" className="font-mono font-semibold text-secondary hover:underline">{l.taskKey}</button>
                  {l.line.supplier && <span className="text-label-sm text-on-surface-variant">{l.line.supplier.name}</span>}
                  {l.exportedTo && <Pill tone="ok" icon="check">Đã xuất {l.exportedTo}</Pill>}
                </span>
                <span className="text-on-surface font-semibold break-words">{l.line.productTitle}</span>
                <span className="text-label-sm text-on-surface-variant">{l.line.variantTitle ? `${l.line.variantTitle} · ` : ''}SL {l.line.qty}</span>
                <span className="text-label-sm text-on-surface-variant">
                  SKU xưởng <span className="font-mono text-on-surface">{l.line.supplierSku ?? '—'}</span>
                  {l.apiSku && <> · SKU API <span className="font-mono text-on-surface">{l.apiSku}</span></>}
                </span>
                {l.driveFolderUrl ? (
                  <span className="inline-flex items-center gap-xs flex-wrap text-label-sm">
                    <Icon name="folder" className="text-[16px] text-secondary" />
                    <ExtLink href={l.driveFolderUrl}>Thư mục Drive của task ↗</ExtLink>
                    <button type="button" aria-label={`Copy link thư mục Drive ${l.taskKey}`} title="Copy link thư mục Drive" className="text-on-surface-variant hover:text-secondary leading-none"
                      onClick={async () => setCopied(await copyText(l.driveFolderUrl as string) ? l.taskKey : '')}>
                      <Icon name={copied === l.taskKey ? 'check' : 'content_copy'} className="text-[15px]" />
                    </button>
                    {copied === l.taskKey && <span role="status" className="text-on-surface-variant">đã chép link</span>}
                    {l.line.designDriveLink !== l.driveFolderUrl && l.line.artworks.length > 0 && (
                      <span className="text-amber-900" title="Còn file chưa lên Drive hoặc chưa nằm trong thư mục — CSV sẽ xuất link từng file cho tới khi đủ">link xưởng: từng file</span>
                    )}
                  </span>
                ) : l.line.artworks.length > 0 && (
                  <span className="inline-flex items-center gap-xs text-label-sm text-on-surface-variant">
                    <Icon name="cloud_off" className="text-[16px]" />Chưa có thư mục Drive — CSV xuất link từng file
                  </span>
                )}
                {l.line.personalization.length > 0 && (
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-sm gap-y-[2px] text-label-sm">
                    {l.line.personalization.map((p, i) => (
                      <div key={`${p.key}-${i}`} className="contents">
                        <dt className="text-on-surface-variant">{p.key}:</dt>
                        <dd className="text-on-surface font-semibold break-words">{p.value}</dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            </li>
            )
          })}
        </ul>
        <div className="mt-auto px-md py-sm border-t border-outline-variant/20 flex items-center gap-sm flex-wrap">
          <HandoffButton orderId={order.id} state={state} canHandoff={!!me?.canHandoff} onChanged={onChanged} onError={onError} />
          {state.handedOff && (
            <span className="text-label-sm text-on-surface-variant">
              {state.handedOff.byName ? `${state.handedOff.byName} · ` : ''}{fmtDateTime(state.handedOff.at)}
            </span>
          )}
          {!state.handedOff && state.apiNote && <span className="text-label-sm text-amber-900">{state.apiNote}</span>}
        </div>
      </article>
    </LightboxProvider>
  )
}

export default function HandoffGrid({ q, version, onOpenTask, onChanged }: {
  q: string; version: number; onOpenTask: (key: string) => void; onChanged: () => void
}) {
  const [data, setData] = useState<HandoffResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [info, setInfo] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const r = await requestJson<HandoffResponse>(`/api/design-studio/handoff${q ? `?q=${encodeURIComponent(q)}` : ''}`)
    setLoading(false)
    if (!r.ok) { setError(r.status === 0 ? 'Mất kết nối tới máy chủ — bấm "Tải lại" để thử lại' : r.error); return }
    setError('')
    setData(r.data)
  }, [q])

  useEffect(() => { load() }, [load, version])

  const changed = useCallback((message: string) => {
    setActionError('')
    setInfo(message)
    void load()
    onChanged()
  }, [load, onChanged])

  const fail = useCallback((message: string) => { setInfo(''); setActionError(message) }, [])
  const pending = data?.pending ?? []
  const saved = data?.saved ?? []
  const me = data?.me ?? null
  const grid = 'grid grid-cols-[repeat(auto-fill,minmax(460px,1fr))] gap-md items-start'

  return (
    <section aria-label="Chuyển xưởng" className="flex flex-col gap-md min-w-0">
      <div className={`${card} px-md py-sm flex items-center gap-sm flex-wrap`}>
        <Icon name="local_shipping" className="text-secondary text-[20px]" />
        <h2 className="text-body-md font-semibold text-on-surface">Chuyển xưởng</h2>
        <span className="text-label-sm text-on-surface-variant">
          {pending.length} đơn đã duyệt hết design, chờ chuyển supplier{data && data.pendingCount > pending.length && !q ? ` (đang hiện ${pending.length}/${data.pendingCount})` : ''} · mỗi thẻ là một đơn
        </span>
        {loading && <Icon name="progress_activity" className="text-on-surface-variant text-[16px] animate-spin" />}
        <span className="ml-auto flex items-center gap-sm flex-wrap">
          {me && !me.canHandoff && <span className="text-label-sm text-on-surface-variant">Bạn chỉ xem — Admin hoặc người có quyền CSV Export mới chuyển xưởng</span>}
          <button type="button" className={btn} onClick={load} disabled={loading}><Icon name="refresh" className="text-[16px]" />Tải lại</button>
        </span>
      </div>
      {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
      <ErrorBanner msg={actionError} onClose={() => setActionError('')} />
      <ErrorBanner msg={error} />
      {!loading && !error && pending.length === 0 && (
        <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
          <Icon name="task_alt" className="text-on-tertiary-container" />Không có đơn nào chờ chuyển xưởng.
        </div>
      )}
      <div className={grid}>
        {pending.map(c => <OrderCard key={c.order.id} c={c} me={me} onOpenTask={onOpenTask} onChanged={changed} onError={fail} />)}
      </div>
      {saved.length > 0 && (
        <>
          <div className="flex items-center gap-sm flex-wrap pt-sm">
            <Icon name="inventory" className="text-on-surface-variant text-[18px]" />
            <h3 className="text-body-sm font-semibold text-on-surface">Đã lưu chờ xuất CSV ({saved.length})</h3>
            <span className="text-label-sm text-on-surface-variant">Đơn vẫn ở Ready to Production cho tới khi xuất CSV</span>
            <Link href="/fulfillment/export" className="text-label-sm text-secondary hover:underline">Mở trang CSV Export</Link>
          </div>
          <div className={grid}>
            {saved.map(c => <OrderCard key={c.order.id} c={c} me={me} onOpenTask={onOpenTask} onChanged={changed} onError={fail} />)}
          </div>
        </>
      )}
    </section>
  )
}
