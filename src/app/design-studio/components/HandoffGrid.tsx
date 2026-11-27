'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { HandoffCard, Me } from './types'
import { requestJson } from './model'
import { HANDOFF_GROUPS, byDue, groupOf } from './streams'
import { GroupChips, GroupHeader } from './PriorityRow'
import { UNMAPPED_TAB, type HubTab } from '@/lib/handoff-shared'
import { fmtUsd, hubView } from '@/lib/handoff-hub'
import HubCard from './HubCard'
import SheetPushDialog from './SheetPushDialog'
import { ErrorBanner, Icon, Pill, btn, btnPrimary, card } from './ui'

type HandoffResponse = { tabs: HubTab[]; selected: string | null; pending: HandoffCard[]; pendingCount: number; sheetsConnected: boolean; me: Me }

const TAB_KEY = 'design-studio.hub-tab'

export const fmtDateTime = (iso: string) => new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' })

const CHANNEL_ICON: Record<string, string> = { API: 'cloud_upload', SHEET: 'table_view', CSV: 'description' }

export default function HandoffGrid({ q, rawQ, onQ, version, onOpenTask, onChanged, group = null, onGroup, onGroupCounts }: {
  q: string; rawQ?: string; onQ?: (q: string) => void; version: number; onOpenTask: (key: string) => void; onChanged: () => void
  group?: string | null; onGroup?: (id: string | null) => void; onGroupCounts?: (counts: Record<string, number>) => void
}) {
  const countsRef = useRef(onGroupCounts)
  countsRef.current = onGroupCounts
  const [data, setData] = useState<HandoffResponse | null>(null)
  // The moment the list was loaded: the chip counts and the section grouping are both read against it, so they never disagree.
  const [loadedAt, setLoadedAt] = useState(() => Date.now())
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
    const now = Date.now()
    setLoadedAt(now)
    const counts: Record<string, number> = {}
    for (const g of HANDOFF_GROUPS) counts[g.id] = 0
    for (const c of r.data.pending) counts[groupOf(HANDOFF_GROUPS, { dueAt: c.dueAt }, now).id]++
    countsRef.current?.(counts)
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
  const pending = useMemo(() => data?.pending ?? [], [data])
  const groupCounts = useMemo(() => HANDOFF_GROUPS.map(def => ({ def, count: pending.filter(c => groupOf(HANDOFF_GROUPS, { dueAt: c.dueAt }, loadedAt).id === def.id).length })), [pending, loadedAt])
  const grouped = useMemo(() => {
    const sorted = [...pending].sort((a, b) => byDue({ dueAt: a.dueAt }, { dueAt: b.dueAt }))
    return HANDOFF_GROUPS
      .filter(def => !group || def.id === group)
      .map(def => ({ def, rows: sorted.filter(c => groupOf(HANDOFF_GROUPS, { dueAt: c.dueAt }, loadedAt).id === def.id) }))
      .filter(g => g.rows.length > 0)
  }, [pending, group, loadedAt])
  const me = data?.me ?? null
  const warned = selected ? pending.filter(c => hubView(c, selected).warnings.length > 0).length : 0
  const sendable = selected ? pending.filter(c => hubView(c, selected).sendableLines.length > 0).length : 0

  const mainTabs = tabs.filter(t => t.id !== UNMAPPED_TAB)
  const unmappedTab = tabs.find(t => t.id === UNMAPPED_TAB) ?? null
  const tabButton = (t: HubTab) => {
    const on = t.id === selected
    return (
      <button key={t.id} type="button" role="tab" aria-selected={on} onClick={() => pick(t.id)}
        title={t.designCount > 0 ? `${t.designCount} đơn đang làm design` : undefined}
        className={`w-full flex items-center gap-sm px-sm py-xs rounded-lg text-left text-body-sm ${on ? 'bg-secondary text-on-secondary font-semibold' : `text-on-surface hover:bg-surface-container-low ${t.orderCount === 0 ? 'opacity-60' : ''}`}`}>
        <Icon name={t.channel ? CHANNEL_ICON[t.channel] : 'link_off'} className={`text-[16px] ${on ? '' : 'text-on-surface-variant'}`} />
        <span className="flex-1 min-w-0 truncate">{t.name}</span>
        <span className={`shrink-0 rounded-full px-sm text-label-sm ${on ? 'bg-on-secondary/20' : t.orderCount > 0 ? 'bg-secondary/10 text-secondary font-semibold' : 'text-on-surface-variant'}`}>{t.orderCount}</span>
      </button>
    )
  }

  return (
    <section aria-label="Duyệt sản xuất" className="flex flex-col gap-md min-w-0">
      <div className={`${card} px-md py-sm flex items-center gap-sm flex-wrap`}>
        <Icon name="precision_manufacturing" className="text-secondary text-[20px]" />
        <h2 className="text-body-md font-semibold text-on-surface">Duyệt sản xuất</h2>
        <span className="text-label-sm text-on-surface-variant">{data?.pendingCount ?? 0} đơn chờ gửi xưởng</span>
        {loading && <Icon name="progress_activity" className="text-on-surface-variant text-[16px] animate-spin" />}
        {onQ && (
          <label className="flex items-center gap-xs h-9 px-sm rounded-lg bg-surface-container-low text-on-surface-variant w-full sm:w-72 sm:ml-md">
            <Icon name="search" className="text-[18px]" />
            <input value={rawQ ?? ''} onChange={e => onQ(e.target.value)} placeholder="Tìm đơn, task ID, SKU…" aria-label="Tìm đơn"
              className="flex-1 min-w-0 bg-transparent text-[13px] text-on-surface outline-none" />
          </label>
        )}
        <span className="ml-auto flex items-center gap-sm flex-wrap">
          {me && !me.canHandoff && <span className="text-label-sm text-on-surface-variant">Bạn chỉ xem — Admin hoặc người có quyền CSV Export mới chuyển xưởng</span>}
          <button type="button" className={btn} onClick={load} disabled={loading}><Icon name="refresh" className="text-[16px]" />Tải lại</button>
        </span>
      </div>
      <ErrorBanner msg={error} />
      <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-md items-start">
        <nav aria-label="Xưởng" className={`${card} p-xs sticky top-md max-h-[calc(100vh-2rem)] overflow-y-auto`}>
          <p className="px-sm pt-xs pb-sm text-label-sm font-semibold text-on-surface-variant">Xưởng</p>
          <div role="tablist" aria-orientation="vertical" className="flex flex-col gap-[2px]">
            {mainTabs.map(tabButton)}
            {unmappedTab && <div className="mt-xs pt-xs border-t border-outline-variant/30">{tabButton(unmappedTab)}</div>}
            {tabs.length === 0 && !loading && <p className="px-sm py-xs text-label-sm text-on-surface-variant">Không có xưởng nào</p>}
          </div>
        </nav>
        <div className="flex flex-col gap-md min-w-0">
          {current && (
            <div className={`${card} px-md py-sm flex flex-col gap-sm`}>
              <div className="flex items-center gap-sm flex-wrap text-label-sm text-on-surface-variant">
                <b className="text-body-md text-on-surface">{current.name}</b>
                {current.channel && <Pill tone={current.channel === 'API' ? 'brand' : 'idle'} icon={CHANNEL_ICON[current.channel]}>{current.channel}</Pill>}
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
              {onGroup && <GroupChips total={pending.length} groups={groupCounts} group={group} onGroup={onGroup} />}
            </div>
          )}
          {info && <span role="status" className="text-label-sm text-on-surface-variant">{info}</span>}
          <ErrorBanner msg={actionError} onClose={() => setActionError('')} />
          {!loading && !error && pending.length === 0 && (
            <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
              <Icon name="task_alt" className="text-on-tertiary-container" />{q ? 'Không tìm thấy đơn nào đang chờ gửi xưởng.' : current ? `${current.name} không có đơn nào chờ gửi.` : 'Không có đơn nào chờ gửi xưởng.'}
            </div>
          )}
          {!loading && !error && group && pending.length > 0 && grouped.length === 0 && (
            <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
              <Icon name="task_alt" className="text-on-tertiary-container" />Không có đơn nào trong nhóm này.
            </div>
          )}
          {selected && grouped.map(({ def, rows }) => (
            <div key={def.id} className="flex flex-col gap-sm">
              <GroupHeader def={def} count={rows.length} />
              <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,320px),1fr))] gap-md">
                {rows.map(c => <HubCard key={c.order.id} c={c} tabId={selected} sheet={current?.channel === 'SHEET' && !!data?.sheetsConnected} me={me} onOpenTask={onOpenTask}
                  onSheet={id => setSheetDialog({ orderIds: [id] })} onChanged={changed} onError={fail} />)}
              </div>
            </div>
          ))}
        </div>
      </div>
      {sheetDialog && selected && (
        <SheetPushDialog supplierId={selected} orderIds={sheetDialog.orderIds} onClose={() => setSheetDialog(null)} onDone={() => { void load(); onChanged() }} />
      )}
    </section>
  )
}
