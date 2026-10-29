'use client'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import type { Me, TaskDetail, TaskRow } from './components/types'
import { emptyQueueText, isRetryable, postJson, requestJson, retryDelay, taskImages, taskUrl } from './components/model'
import { machineQa } from './components/ai-qa'
import { LightboxProvider } from './components/Lightbox'
import Queue, { type QueueFilter } from './components/Queue'
import TaskHeader from './components/TaskHeader'
import CustomerInputs from './components/CustomerInputs'
import ArtworkPanel from './components/ArtworkPanel'
import CompareRow from './components/CompareRow'
import AiQaPanel from './components/AiQaPanel'
import ActivityPanel from './components/ActivityPanel'
import ReviewGrid from './components/ReviewGrid'
import HandoffGrid from './components/HandoffGrid'
import SentGrid from './components/SentGrid'
import DriveHealthBanner from './components/DriveHealthBanner'
import { ToastProvider, useToast } from './components/overlay'
import { useShopifyRefresh } from './components/useShopifyRefresh'
import { ErrorBanner, Icon, READY_META, card, fmtDate, fmtDateTime } from './components/ui'

type Mode = 'work' | 'review' | 'handoff' | 'sent'

const DRIVE_BADGE_POLL_MS = [4000, 8000, 15000, 30000, 60000, 120000]
const DRIVE_BADGE_WINDOW_MS = 15 * 60 * 1000

function Banners({ detail }: { detail: TaskDetail }) {
  const { task } = detail
  const last = (type: string) => [...detail.events].reverse().find(e => e.type === type)
  if (task.status === 'REJECTED') {
    const ev = last('REJECT')
    return (
      <div role="alert" className="flex items-start gap-sm rounded-xl bg-error-container/50 border border-error/30 px-md py-sm">
        <Icon name="assignment_return" className="text-[22px] text-error" />
        <div className="flex-1 min-w-0 flex flex-col gap-[2px] text-body-sm">
          <span className="font-semibold text-on-error-container">Bị trả lại: {task.rejectReasons.join(', ') || '—'}</span>
          {task.rejectNote && <span className="text-on-surface">{task.rejectNote}</span>}
          {ev && <span className="text-label-sm text-on-surface-variant">{ev.actorName ?? 'Hệ thống'} · {fmtDate(ev.createdAt)}</span>}
        </div>
      </div>
    )
  }
  if (task.status === 'ASK_CUSTOMER') {
    const ev = last('ASK')
    return (
      <div role="status" className="flex items-start gap-sm rounded-xl bg-amber-50 border border-amber-200 px-md py-sm">
        <Icon name="contact_support" className="text-[22px] text-amber-800" />
        <div className="flex-1 min-w-0 flex flex-col gap-[2px] text-body-sm">
          <span className="font-semibold text-amber-950">Đang chờ khách trả lời</span>
          {ev && <span className="text-on-surface">{ev.message.replace(/^Hỏi khách:\s*/, '')}</span>}
          {ev && <span className="text-label-sm text-on-surface-variant">{ev.actorName ?? 'Hệ thống'} hỏi · {fmtDateTime(ev.createdAt)}</span>}
        </div>
      </div>
    )
  }
  return null
}

function TaskWorkspace({ detail, holdCount, onChanged }: { detail: TaskDetail; holdCount: Record<string, number>; onChanged: () => void }) {
  const { refreshing, refresh } = useShopifyRefresh(detail.task.orderId, onChanged)
  const qa = useMemo(() => machineQa(detail), [detail])
  const key = detail.task.taskKey
  return (
    <>
      <Banners detail={detail} />
      <TaskHeader key={`h-${key}`} detail={detail} qa={qa} holdCount={holdCount} refreshing={refreshing} onRefresh={refresh} onChanged={onChanged} />
      <CustomerInputs key={`c-${key}`} detail={detail} refreshing={refreshing} onRefresh={refresh} onChanged={onChanged} />
      <ArtworkPanel key={`a-${key}`} detail={detail} onChanged={onChanged} />
      <CompareRow key={`m-${key}`} detail={detail} onChanged={onChanged} />
      <AiQaPanel qa={qa} />
      <ActivityPanel key={`e-${key}`} detail={detail} onChanged={onChanged} />
    </>
  )
}

function DesignTasks() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const paramTask = searchParams.get('task')
  const toast = useToast()

  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [, setMe] = useState<Me | null>(null)
  const [handoffCount, setHandoffCount] = useState(0)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [mode, setMode] = useState<Mode>('work')
  const [reviewVersion, setReviewVersion] = useState(0)
  const [sel, setSel] = useState<string | null>(paramTask)
  const [filter, setFilter] = useState<QueueFilter>('ALL')
  const [mine, setMine] = useState(false)
  const [q, setQ] = useState('')
  const [debouncedQ, setDebouncedQ] = useState('')
  const [detail, setDetail] = useState<TaskDetail | null>(null)
  const [detailError, setDetailError] = useState('')
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState('')
  const [lastSync, setLastSync] = useState<{ ranAt: string; trigger: string; error: string | null } | null>(null)
  const listReq = useRef(0)
  const retryAttempt = useRef(0)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const loadListRef = useRef<() => void>(() => {})
  const onRecovered = useRef<() => void>(() => {})
  const detailReq = useRef(0)
  const [driveVersion, setDriveVersion] = useState(0)
  const drivePoll = useRef({ key: '', attempts: 0 })

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
    setDriveVersion(v => v + 1)
  }, [loadList, loadDetail, sel])

  const selectTask = useCallback((key: string) => {
    setSel(key)
    setMode('work')
  }, [])

  async function sync() {
    setSyncing(true); setSyncError('')
    const r = await postJson<{ created: number; cancelled: number; completed: number; reopened: number; orders: number; refresh?: { refreshed: number; notFound: number; otherStore: number; deferred?: number; error: string | null }; errors?: string[] }>('/api/design-studio/tasks/sync', {})
    setSyncing(false)
    if (!r.ok) { setSyncError(r.error); return }
    const rf = r.data.refresh
    if (rf?.error) setSyncError(`Nạp từ Shopify lỗi: ${rf.error}`)
    toast.say(`${r.data.orders} đơn · nạp Shopify ${rf?.refreshed ?? 0}${rf?.notFound ? ` (không thấy ${rf.notFound})` : ''}${rf?.otherStore ? ` · store khác ${rf.otherStore}` : ''}${rf?.deferred ? ` · để lượt sau ${rf.deferred}` : ''} · tạo ${r.data.created} · huỷ ${r.data.cancelled} · xong ${r.data.completed} · mở lại ${r.data.reopened}${r.data.errors?.length ? ` · lỗi ${r.data.errors.length}` : ''}`)
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
    } as Record<QueueFilter, number>
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

  useEffect(() => {
    if (!current || !current.driveConnected) return
    const waiting = current.line.artworks.filter(a => a.storage === 'LOCAL' && Date.now() - new Date(a.createdAt).getTime() < DRIVE_BADGE_WINDOW_MS)
    if (waiting.length === 0) return
    const key = `${current.task.taskKey}:${waiting.map(a => a.id).join(',')}`
    if (drivePoll.current.key !== key) drivePoll.current = { key, attempts: 0 }
    const delay = DRIVE_BADGE_POLL_MS[drivePoll.current.attempts]
    if (delay === undefined) return
    const taskKey = current.task.taskKey
    const t = setTimeout(() => {
      drivePoll.current.attempts++
      loadDetail(taskKey)
      setDriveVersion(v => v + 1)
    }, delay)
    return () => clearTimeout(t)
  }, [current, loadDetail])
  const images = useMemo(() => (current ? taskImages(current) : []), [current])

  const tabs: { mode: Mode; label: string; count?: number; hot?: boolean; tip: string }[] = [
    { mode: 'work', label: 'Làm task', tip: 'Màn làm từng task' },
    { mode: 'review', label: 'Duyệt mẫu', count: reviewCount, hot: reviewCount > 0, tip: 'Xem và duyệt các mẫu đang chờ duyệt' },
    { mode: 'handoff', label: 'Duyệt sản xuất', count: handoffCount, hot: handoffCount > 0, tip: 'Các đơn đã duyệt hết design, chờ gửi xưởng (API hoặc lưu chờ xuất CSV)' },
    { mode: 'sent', label: 'Đã chuyển xưởng', tip: 'Các đơn đã gửi xưởng: chờ xuất CSV, đã xuất, đã gửi API, đã có tracking' },
  ]
  const syncTip = lastSync
    ? `${lastSync.error ? `Lượt gần nhất lỗi: ${lastSync.error}` : `Tự đồng bộ mỗi 15 phút · lượt gần nhất ${lastSync.trigger === 'schedule' ? 'tự động' : 'bấm tay'}`} · ${fmtDateTime(lastSync.ranAt)}`
    : 'Đồng bộ task từ Shopify'

  return (
    <>
      <div className="flex items-center gap-lg flex-wrap mb-md">
        <div className="flex items-center gap-xs">
          <h1 className="text-headline-sm text-on-surface">Design Tasks</h1>
          <span role="img" aria-label="Giải thích Task ID" title="Task ID = mã đơn_dòng hàng (vd. LIT5000_1 = đơn #LIT5000, dòng 1) · mỗi task là một dòng hàng cần file in">
            <Icon name="info" className="text-[18px] text-on-surface-variant" />
          </span>
        </div>
        <div role="tablist" aria-label="Chế độ" className="flex items-center gap-xs">
          {tabs.map(t => {
            const on = mode === t.mode
            return (
              <button key={t.mode} type="button" role="tab" aria-selected={on} title={t.tip} onClick={() => setMode(t.mode)}
                className={`inline-flex items-center gap-xs h-9 px-md rounded-lg text-body-sm font-semibold ${on ? 'bg-on-surface text-surface' : 'text-on-surface-variant hover:bg-surface-container-low'}`}>
                {t.label}
                {t.count !== undefined && (
                  <span className={`inline-flex items-center h-5 px-[7px] rounded-full text-[11px] ${on ? 'bg-surface/20' : t.hot ? 'bg-amber-100 text-amber-900' : 'bg-surface-container text-on-surface-variant'}`}>{t.count}</span>
                )}
              </button>
            )
          })}
        </div>
        <button type="button" onClick={sync} disabled={syncing} aria-label="Đồng bộ task từ Shopify" title={syncTip}
          className={`ml-auto inline-grid place-items-center w-10 h-10 rounded-lg border bg-surface-container-lowest hover:bg-surface-container-low disabled:opacity-60 ${lastSync?.error ? 'border-error text-error' : 'border-outline-variant text-on-surface-variant'}`}>
          <Icon name="sync" className={`text-[20px] ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {syncError && <div className="mb-md"><ErrorBanner msg={syncError} onClose={() => setSyncError('')} /></div>}
      <DriveHealthBanner version={driveVersion} />

      <div className="grid grid-cols-[290px_minmax(0,1fr)] gap-md items-start">
        <Queue tasks={visible} sel={mode === 'work' ? sel : null} onSelect={selectTask} q={q} onQ={setQ} loading={listLoading} error={listError} retrying={retrying}
          emptyText={filtered ? emptyText : 'Không có task'} onClearFilters={filtered ? clearFilters : null}
          filter={filter} onFilter={setFilter} counts={counts} mine={mine} onMine={setMine} />
        {mode === 'review' ? (
          <ReviewGrid mine={mine} q={debouncedQ} version={reviewVersion} onOpenTask={selectTask} onChanged={reload} />
        ) : mode === 'handoff' ? (
          <HandoffGrid q={debouncedQ} version={reviewVersion} onOpenTask={selectTask} onChanged={reload} />
        ) : mode === 'sent' ? (
          <SentGrid q={debouncedQ} version={reviewVersion} onOpenTask={selectTask} onChanged={reload} />
        ) : (
        <div className="flex flex-col gap-md min-w-0">
          {!sel && !listLoading && !listError && (
            <div className={`${card} p-lg text-body-sm text-on-surface-variant`}>Chưa có task nào. Bấm nút đồng bộ ở góc phải để tạo task từ các đơn đang chờ design.</div>
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
              <TaskWorkspace detail={current} holdCount={holdCount} onChanged={reload} />
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
        <ToastProvider>
          <Suspense fallback={<div className="text-body-sm text-on-surface-variant">Đang tải…</div>}>
            <DesignTasks />
          </Suspense>
        </ToastProvider>
      </main>
    </div>
  )
}
