'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { HandoffCard, Me } from './types'
import { copyText, mockupFiles, printPartNames, requestJson, taskImages, type LightboxImage } from './model'
import { pushChipLabel, type HubTab } from '@/lib/handoff-shared'
import { fmtUsd, hubView } from '@/lib/handoff-hub'
import { LightboxProvider } from './Lightbox'
import PrintFileThumb from './PrintFileThumb'
import ExternalDesignPreview from './ExternalDesignPreview'
import HandoffButton from './HandoffButton'
import HubCard from './HubCard'
import SheetPushDialog from './SheetPushDialog'
import { PreSendChecks } from './PreSendChecks'
import { ErrorBanner, ExtLink, Icon, Pill, btn, btnPrimary, card } from './ui'

type HandoffResponse = { tabs: HubTab[]; selected: string | null; pending: HandoffCard[]; pendingCount: number; sheetsConnected: boolean; me: Me }

const TAB_KEY = 'design-studio.hub-tab'

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US')
export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' })

export function OrderCard({ c, me, onOpenTask, onChanged, onError, footer }: {
  c: HandoffCard; me: Me | null; onOpenTask: (key: string) => void; onChanged: (info: string) => void; onError: (msg: string) => void
  /** Replaces the hand-off button row (the "Đã chuyển xưởng" list shows where the order is instead). */
  footer?: JSX.Element
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
      <article aria-label={`Đơn ${order.orderNumber}`} className={`${card} flex flex-col ${c.lines.some(l => l.mappingNow || l.wrongSizeAreas.length) ? 'ring-1 ring-error/40' : ''}`}>
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
        <div className="mx-md mt-sm empty:hidden"><PreSendChecks c={c} canHandoff={!!me?.canHandoff} onChanged={onChanged} onError={onError} /></div>
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
                      {parts.map(area => <PrintFileThumb key={area} line={l.line} area={area} refLabel={l.taskKey} wrongSize={l.wrongSizeAreas.includes(area)} />)}
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
        {footer ?? (
        <div className="mt-auto px-md py-sm border-t border-outline-variant/20 flex items-center gap-sm flex-wrap">
          <HandoffButton orderId={order.id} state={state} canHandoff={!!me?.canHandoff} onChanged={onChanged} onError={onError} />
          {state.handedOff && (
            <span className="text-label-sm text-on-surface-variant">
              {state.handedOff.byName ? `${state.handedOff.byName} · ` : ''}{fmtDateTime(state.handedOff.at)}
            </span>
          )}
          {!state.handedOff && state.apiNote && <span className="text-label-sm text-amber-900">{state.apiNote}</span>}
        </div>
        )}
      </article>
    </LightboxProvider>
  )
}

export default function HandoffGrid({ q, version, onOpenTask, onChanged }: {
  q: string; version: number; onOpenTask: (key: string) => void; onChanged: () => void
}) {
  const [data, setData] = useState<HandoffResponse | null>(null)
  const [tab, setTab] = useState<string | null>(() => {
    try { return window.localStorage.getItem(TAB_KEY) } catch { return null }
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [info, setInfo] = useState('')
  const [sheetDialog, setSheetDialog] = useState<{ orderIds?: string[] } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const qs = new URLSearchParams()
    if (q) qs.set('q', q)
    if (tab) qs.set('supplier', tab)
    const query = qs.toString()
    const r = await requestJson<HandoffResponse>(`/api/design-studio/handoff${query ? `?${query}` : ''}`)
    setLoading(false)
    if (!r.ok) { setError(r.status === 0 ? 'Mất kết nối tới máy chủ — bấm "Tải lại" để thử lại' : r.error); return }
    setError('')
    setData(r.data)
  }, [q, tab])

  useEffect(() => { load() }, [load, version])

  const changed = useCallback((message: string) => {
    setActionError('')
    setInfo(message)
    void load()
    onChanged()
  }, [load, onChanged])

  const fail = useCallback((message: string) => { setInfo(''); setActionError(message) }, [])
  const pick = (id: string) => {
    setTab(id)
    try { window.localStorage.setItem(TAB_KEY, id) } catch {}
  }
  const tabs = data?.tabs ?? []
  const selected = data?.selected ?? null
  const current = tabs.find(t => t.id === selected) ?? null
  const pending = data?.pending ?? []
  const me = data?.me ?? null
  const warned = selected ? pending.filter(c => hubView(c, selected).warnings.length > 0).length : 0

  return (
    <section aria-label="Duyệt sản xuất" className="flex flex-col gap-md min-w-0">
      <div className={`${card} px-md py-sm flex items-center gap-sm flex-wrap`}>
        <Icon name="precision_manufacturing" className="text-secondary text-[20px]" />
        <h2 className="text-body-md font-semibold text-on-surface">Duyệt sản xuất</h2>
        <span className="text-label-sm text-on-surface-variant">{data?.pendingCount ?? 0} đơn chờ gửi xưởng</span>
        {loading && <Icon name="progress_activity" className="text-on-surface-variant text-[16px] animate-spin" />}
        <span className="ml-auto flex items-center gap-sm flex-wrap">
          {me && !me.canHandoff && <span className="text-label-sm text-on-surface-variant">Bạn chỉ xem — Admin hoặc người có quyền CSV Export mới chuyển xưởng</span>}
          <button type="button" className={btn} onClick={load} disabled={loading}><Icon name="refresh" className="text-[16px]" />Tải lại</button>
        </span>
      </div>
      {tabs.length > 0 && (
        <div role="tablist" aria-label="Xưởng" className="sticky top-0 z-20 -mx-xs px-xs py-xs bg-surface flex gap-xs overflow-x-auto">
          {tabs.map(t => {
            const on = t.id === selected
            return (
              <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => pick(t.id)}
                className={`shrink-0 inline-flex items-center gap-xs h-9 px-md rounded-full border text-body-sm font-semibold whitespace-nowrap ${on ? 'bg-secondary text-on-secondary border-transparent' : 'bg-surface-container-lowest text-on-surface border-outline-variant/60 hover:bg-surface-container-low'}`}>
                {t.name}<span className={on ? 'opacity-80' : 'text-on-surface-variant'}>{t.orderCount}</span>
              </button>
            )
          })}
        </div>
      )}
      {current && (
        <div className="flex items-center gap-sm flex-wrap text-label-sm text-on-surface-variant">
          <b className="text-body-sm text-on-surface">{current.name}</b>
          {current.channel && <Pill tone={current.channel === 'API' ? 'brand' : 'idle'} icon={current.channel === 'API' ? 'cloud_upload' : 'description'}>{current.channel}</Pill>}
          <span>{current.orderCount} đơn chờ gửi</span>
          {current.designCount > 0 && <span title="Đơn đặt trong 30 ngày, còn đang làm design">{current.designCount} đơn đang làm design</span>}
          <span title="Tổng base cost các dòng đang chờ, chưa gồm phí ship">Base cost <b className="text-on-surface">{fmtUsd(current.baseCostTotal)}</b></span>
          {warned > 0 && <span className="text-error font-semibold">{warned} đơn có cảnh báo</span>}
          {current.orderCount > pending.length && !loading && <span>đang hiện {pending.length} đơn cũ nhất</span>}
          {current.channel === 'CSV' && <a href="/fulfillment/export" className="ml-auto text-secondary font-semibold hover:underline">Mở CSV Export</a>}
          {current.channel === 'SHEET' && !data?.sheetsConnected && <a href="/setup" className="ml-auto text-secondary font-semibold hover:underline">Kết nối Google Sheets ở Setup</a>}
          {current.channel === 'SHEET' && data?.sheetsConnected && (
            <button type="button" className={`${btnPrimary} ml-auto`} disabled={!me?.canHandoff || pending.length === warned} onClick={() => setSheetDialog({})}>
              <Icon name="table_view" className="text-[16px]" />Sản xuất tất cả ({pending.length - warned})
            </button>
          )}
        </div>
      )}
      {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
      <ErrorBanner msg={actionError} onClose={() => setActionError('')} />
      <ErrorBanner msg={error} />
      {!loading && !error && pending.length === 0 && (
        <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
          <Icon name="task_alt" className="text-on-tertiary-container" />{q ? 'Không tìm thấy đơn nào đang chờ gửi xưởng.' : current ? `${current.name} không có đơn nào chờ gửi.` : 'Không có đơn nào chờ gửi xưởng.'}
        </div>
      )}
      {selected && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,340px),1fr))] gap-md">
          {pending.map(c => <HubCard key={c.order.id} c={c} tabId={selected} sheet={current?.channel === 'SHEET' && !!data?.sheetsConnected} me={me} onOpenTask={onOpenTask}
            onSheet={id => setSheetDialog({ orderIds: [id] })} onChanged={changed} onError={fail} />)}
        </div>
      )}
      {sheetDialog && selected && (
        <SheetPushDialog supplierId={selected} orderIds={sheetDialog.orderIds} onClose={() => setSheetDialog(null)} onDone={() => { void load(); onChanged() }} />
      )}
    </section>
  )
}
