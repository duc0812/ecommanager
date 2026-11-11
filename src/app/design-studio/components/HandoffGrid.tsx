'use client'
import { useCallback, useEffect, useState } from 'react'
import type { HandoffCard, Me } from './types'
import { requestJson } from './model'
import type { HubTab } from '@/lib/handoff-shared'
import { fmtUsd, hubView } from '@/lib/handoff-hub'
import HubCard from './HubCard'
import SheetPushDialog from './SheetPushDialog'
import { ErrorBanner, Icon, Pill, btn, btnPrimary, card } from './ui'

type HandoffResponse = { tabs: HubTab[]; selected: string | null; pending: HandoffCard[]; pendingCount: number; sheetsConnected: boolean; me: Me }

const TAB_KEY = 'design-studio.hub-tab'

export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' })

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
  const sendable = selected ? pending.filter(c => hubView(c, selected).sendableLines.length > 0).length : 0

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
          {current.channel === 'SHEET' && !data?.sheetsConnected && <a href="/setup?block=fulfill" className="ml-auto text-secondary font-semibold hover:underline">Kết nối Google Sheets ở Setup</a>}
          {current.channel === 'SHEET' && data?.sheetsConnected && (
            <button type="button" className={`${btnPrimary} ml-auto`} disabled={!me?.canHandoff || sendable === 0} onClick={() => setSheetDialog({})}>
              <Icon name="table_view" className="text-[16px]" />Sản xuất tất cả ({sendable})
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
