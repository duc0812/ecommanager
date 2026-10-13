'use client'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import type { Me, Readiness, TaskDetail, TaskRow } from './components/types'
import { emptyQueueText, isRetryable, postJson, requestJson, retryDelay, taskImages, taskUrl } from './components/model'
import { LightboxProvider } from './components/Lightbox'
import Queue from './components/Queue'
import TaskHeader from './components/TaskHeader'
import ImagePanes from './components/ImagePanes'
import LowerGrid from './components/LowerGrid'
import ReviewGrid from './components/ReviewGrid'
import HandoffGrid from './components/HandoffGrid'
import { ErrorBanner, Icon, Note, READY_META, btnPrimary, card } from './components/ui'

type Filter = 'ALL' | Readiness
type Mode = 'work' | 'review' | 'handoff'

function fmtSyncTime(iso: string) {
  return new Date(iso).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

function Flags({ detail }: { detail: TaskDetail }) {
  const { task } = detail
  return (
    <>
      {task.status === 'REJECTED' && (
        <Note tone="bad" icon="undo">
          <b>Bị trả lại:</b> {task.rejectReasons.join(', ') || '—'}{task.rejectNote ? ` — ${task.rejectNote}` : ''}
        </Note>
      )}
    </>
  )
}

function DesignTasks() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const paramTask = searchParams.get('task')

  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [handoffCount, setHandoffCount] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [mode, setMode] = useState<Mode>('work')
  const [reviewVersion, setReviewVersion] = useState(0)
  const [sel, setSel] = useState<string | null>(paramTask)
  const [filter, setFilter] = useState<Filter>('ALL')
  const [mine, setMine] = useState(false)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const [syncError, setSyncError] = useState('')
  const [lastSync, setLastSync] = useState<{ ranAt: string; trigger: string; error: string | null } | null>(null)
  const listReq = useRef(0)
  const retryAttempt = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadListRef = useRef<() => void>(() => {})
  const onRecovered = useRef<() => void>(() => {})
  const detailReq = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    if (paramTask) setSel(paramTask)
  }, [paramTask])

  const loadList = useCallback(async () => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    const id = ++listReq.current
    setListLoading(true)
    const qs = new URLSearchParams()
    if (mine) qs.set('mine', '1')
    if (debouncedQ) qs.set('q', debouncedQ)
    const query = qs.toString()
    const r = await requestJson<{ tasks: TaskRow[]; me: Me; handoffCount?: number; lastSync?: { ranAt: string; trigger: string; error: string | null } | null }>(`/api/design-studio/tasks${query ? `?${query}` : ''}`)
    if (id !== listReq.current) return
    setListLoading(false)
    if (!r.ok) {
      if (!isRetryable(r.status)) { retryAttempt.current = 0; setRetrying(false); setListError(r.error); return }
      const delay = retryDelay(retryAttempt.current)
      retryAttempt.current++
      setRetrying(true)
      setListError(r.error)
      retryTimer.current = setTimeout(() => loadListRef.current(), delay)
      return
    }
    const recovered = retryAttempt.current > 0
    retryAttempt.current = 0
    setRetrying(false)
    setListError('')
    if (recovered) onRecovered.current()
    setTasks(r.data.tasks)
    setMe(r.data.me)
    setHandoffCount(r.data.handoffCount ?? 0)
    setLastSync(r.data.lastSync ?? null)
  }, [mine, debouncedQ])

  const loadDetail = useCallback(async (key: string) => {
    const id = ++detailReq.current
    setDetailError('')
    const r = await requestJson<TaskDetail>(taskUrl(key))
    if (id !== detailReq.current) return
    if (!r.ok) { setDetailError(r.error); return }
    setDetailError('')
    setDetail(r.data)
  }, [])

  useEffect(() => { loadListRef.current = loadList }, [loadList])
  useEffect(() => {
    onRecovered.current = () => { if (sel && detailError) loadDetail(sel) }
  }, [sel, detailError, loadDetail])
  useEffect(() => { loadList() }, [loadList])
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current) }, [])

  useEffect(() => {
    if (sel) loadDetail(sel)
  }, [sel, loadDetail])

  const visible = useMemo(() => tasks.filter(t => filter === 'ALL' || t.readiness === filter), [tasks, filter])

  useEffect(() => {
    if (!sel && visible.length > 0) setSel(visible[0].taskKey)
  }, [sel, visible])

  useEffect(() => {
    if (!sel || paramTask === sel) return
    router.replace(`/design-studio?task=${encodeURIComponent(sel)}`, { scroll: false })
  }, [sel, paramTask, router])

  const reload = useCallback(() => {
    loadList()
    if (sel) loadDetail(sel)
  }, [loadList, loadDetail, sel])

  const selectTask = useCallback((key: string) => {
    setSel(key)
    setMode('work')
  }, [])

  async function sync() {
    setSyncing(true); setSyncMsg(''); setSyncError('')
    const r = await postJson<{ created: number; cancelled: number; completed: number; reopened: number; orders: number; refresh?: { refreshed: number; notFound: number; otherStore: number; deferred?: number; error: string | null }; errors?: string[] }>('/api/design-studio/tasks/sync', {})
    setSyncing(false)
    if (!r.ok) { setSyncError(r.error); return }
    const rf = r.data.refresh
    if (rf?.error) setSyncError(`Nạp từ Shopify lỗi: ${rf.error}`)
    setSyncMsg(`${r.data.orders} đơn · nạp Shopify ${rf?.refreshed ?? 0}${rf?.notFound ? ` (không thấy ${rf.notFound})` : ''}${rf?.otherStore ? ` · store khác ${rf.otherStore}` : ''}${rf?.deferred ? ` · để lượt sau ${rf.deferred}` : ''} · tạo ${r.data.created} · huỷ ${r.data.cancelled} · xong ${r.data.completed} · mở lại ${r.data.reopened}${r.data.errors?.length ? ` · lỗi ${r.data.errors.length}` : ''}`)
    loadList()
    setReviewVersion(v => v + 1)
  }

  const counts = useMemo(() => {
    const open = tasks.filter(t => t.status !== 'DONE')
    return {
      ALL: open.length,
      AUTO: open.filter(t => t.readiness === 'AUTO').length,
      LOW: open.filter(t => t.readiness === 'LOW').length,
      MANUAL: open.filter(t => t.readiness === 'MANUAL').length,
    } as Record<Filter, number>
  }, [tasks])

  const reviewCount = useMemo(() => tasks.filter(t => t.status === 'REVIEW').length, [tasks])
  const filtered = filter !== 'ALL' || mine || !!debouncedQ
  const emptyText = emptyQueueText({ readinessLabel: filter === 'ALL' ? null : READY_META[filter].label, mine, q: debouncedQ })
  const clearFilters = useCallback(() => { setFilter('ALL'); setMine(false); setQ('') }, [])

  const holdCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of tasks) if (t.assigneeId && t.status !== 'DONE') m[t.assigneeId] = (m[t.assigneeId] ?? 0) + 1
    return m
  }, [tasks])

  const current = detail && detail.task.taskKey === sel ? detail : null
  const images = useMemo(() => (current ? taskImages(current) : []), [current])
  const chipCls = (on: boolean) => `inline-flex items-center gap-xs rounded-full border px-sm py-[2px] text-label-sm ${on ? 'bg-secondary/10 text-secondary border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant'}`

  return (
    <>
      <div className="flex items-center gap-md flex-wrap mb-md">
        <h1 className="text-headline-lg text-on-surface">Design Tasks</h1>
        <span className="text-label-sm text-on-surface-variant">Task ID = mã đơn_dòng · mỗi task là một dòng hàng cần file in</span>
        <div className="flex items-center gap-xs flex-wrap">
          {(['ALL', 'AUTO', 'LOW', 'MANUAL'] as Filter[]).map(f => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => setFilter(f)} className={chipCls(filter === f)}>
              {f === 'ALL' ? 'Tất cả' : READY_META[f].label}
              <span className="text-on-surface-variant font-normal">{counts[f]}</span>
            </button>
          ))}
          <button type="button" aria-pressed={mine} onClick={() => setMine(!mine)} className={chipCls(mine)}>
            <Icon name="person" className="text-[14px]" />Của tôi
          </button>
          <button type="button" aria-pressed={mode === 'review'} onClick={() => setMode(mode === 'review' ? 'work' : 'review')}
            title={mode === 'review' ? 'Quay lại màn làm task' : 'Xem và duyệt các mẫu đang chờ duyệt'}
            className={`inline-flex items-center gap-xs rounded-full border px-sm py-[2px] text-label-sm ${mode === 'review'
              ? 'bg-secondary text-on-secondary border-transparent font-semibold'
              : reviewCount > 0 ? 'bg-amber-100 text-amber-900 border-amber-300 font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant'}`}>
            <Icon name="fact_check" className="text-[14px]" />Duyệt mẫu
            <span className={mode === 'review' ? 'font-semibold' : reviewCount > 0 ? 'font-bold' : 'font-normal'}>{reviewCount}</span>
          </button>
          <button type="button" aria-pressed={mode === 'handoff'} onClick={() => setMode(mode === 'handoff' ? 'work' : 'handoff')}
            title={mode === 'handoff' ? 'Quay lại màn làm task' : 'Các đơn đã duyệt hết design, chờ chuyển supplier (API hoặc lưu chờ xuất CSV)'}
            className={`inline-flex items-center gap-xs rounded-full border px-sm py-[2px] text-label-sm ${mode === 'handoff'
              ? 'bg-secondary text-on-secondary border-transparent font-semibold'
              : handoffCount > 0 ? 'bg-emerald-100 text-emerald-900 border-emerald-300 font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant'}`}>
            <Icon name="local_shipping" className="text-[14px]" />Chuyển xưởng
            <span className={mode === 'handoff' ? 'font-semibold' : handoffCount > 0 ? 'font-bold' : 'font-normal'}>{handoffCount}</span>
          </button>
        </div>
        <div className="ml-auto flex items-center gap-sm">
          {me && <span className="text-label-sm text-on-surface-variant">{me.name} · {me.isLeader ? 'Leader' : 'Designer'}</span>}
          {syncMsg && <span role="status" className="text-label-sm text-on-surface-variant">{syncMsg}</span>}
          {lastSync && (
            <span className={`text-label-sm ${lastSync.error ? 'text-error' : 'text-on-surface-variant'}`}
              title={lastSync.error ? `Lượt gần nhất lỗi: ${lastSync.error}` : `Task tự đồng bộ mỗi 15 phút · lượt gần nhất ${lastSync.trigger === 'schedule' ? 'tự động' : 'bấm tay'}`}>
              Đồng bộ lần cuối: {fmtSyncTime(lastSync.ranAt)}
            </span>
          )}
          <button type="button" onClick={sync} disabled={syncing} className={`${btnPrimary} px-lg py-sm text-label-md`}>
            <Icon name="sync" className={`text-[18px] ${syncing ? 'animate-spin' : ''}`} />{syncing ? 'Đang đồng bộ…' : 'Đồng bộ task'}
          </button>
        </div>
      </div>
      {syncError && <div className="mb-md"><ErrorBanner msg={syncError} onClose={() => setSyncError('')} /></div>}

      <div className="grid grid-cols-[290px_minmax(0,1fr)] gap-md items-start">
        <Queue tasks={visible} sel={mode === 'work' ? sel : null} onSelect={selectTask} q={q} onQ={setQ} loading={listLoading} error={listError} retrying={retrying}
          emptyText={filtered ? emptyText : 'Không có task'} onClearFilters={filtered ? clearFilters : null} />
        {mode === 'review' ? (
          <ReviewGrid mine={mine} q={debouncedQ} version={reviewVersion} onOpenTask={selectTask} onChanged={reload} />
        ) : mode === 'handoff' ? (
          <HandoffGrid q={debouncedQ} version={reviewVersion} onOpenTask={selectTask} onChanged={reload} />
        ) : (
        <div className="flex flex-col gap-md min-w-0">
          {!sel && !listLoading && !listError && (
            <div className={`${card} p-lg text-body-sm text-on-surface-variant`}>Chưa có task nào. Bấm &quot;Đồng bộ task&quot; để tạo task từ các đơn đang chờ design.</div>
          )}
          {sel && detailError && (
            <div className={`${card} p-md`}><ErrorBanner msg={`${sel}: ${detailError}`} onClose={() => setDetailError('')} /></div>
          )}
          {sel && !detailError && !current && (
            <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
              <Icon name="progress_activity" className="animate-spin" />Đang tải {sel}…
            </div>
          )}
          {current && (
            <LightboxProvider images={images}>
              <Flags detail={current} />
              <TaskHeader key={`h-${current.task.taskKey}`} detail={current} holdCount={holdCount} onChanged={reload} />
              <ImagePanes key={`i-${current.task.taskKey}`} detail={current} onChanged={reload} />
              <LowerGrid key={`l-${current.task.taskKey}`} detail={current} onChanged={reload} />
            </LightboxProvider>
          )}
        </div>
        )}
      </div>
    </>
  )
}

export default function DesignTasksPage() {
  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl min-w-0">
        <Suspense fallback={<div className="text-body-sm text-on-surface-variant">Đang tải…</div>}>
          <DesignTasks />
        </Suspense>
      </main>
    </div>
  )
}
