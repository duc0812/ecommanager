'use client'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import StoreFilter from '@/components/StoreFilter'
import { useSellerReadOnly } from '@/components/RoleGate'
import { useStoreFilter } from '@/lib/use-store-filter'
import type { Me, SentLineRow, TaskDetail, TaskRow, TaskStatus } from './components/types'
import { artworkProducts, emptyQueueText, isRetryable, matchesQueueFilter, postJson, requestJson, retryDelay, taskImages, taskUrl } from './components/model'
import { machineQa } from './components/ai-qa'
import { LightboxProvider } from './components/Lightbox'
import Queue, { type QueueGroup } from './components/Queue'
import TaskHeader from './components/TaskHeader'
import TaskHandoffChecks from './components/TaskHandoffChecks'
import CustomerInputs from './components/CustomerInputs'
import ProductionEditor from './components/ProductionEditor'
import ArtworkPanel from './components/ArtworkPanel'
import CompareRow from './components/CompareRow'
import AiQaPanel from './components/AiQaPanel'
import ActivityPanel from './components/ActivityPanel'
import ReviewWorkspace from './components/ReviewWorkspace'
import ReviewToolbar from './components/ReviewToolbar'
import HandoffGrid from './components/HandoffGrid'
import SentGrid from './components/SentGrid'
import SentLinePanel from './components/SentLinePanel'
import DropshipGrid from './components/DropshipGrid'
import DriveHealthBanner from './components/DriveHealthBanner'
import { ToastProvider, useToast } from './components/overlay'
import { useShopifyRefresh } from './components/useShopifyRefresh'
import StreamStepper from './components/StreamStepper'
import PriorityRow, { type SecondaryFilter } from './components/PriorityRow'
import Flags from './components/Flags'
import { HANDOFF_GROUPS, STREAMS, TASK_GROUPS, TASK_STREAMS, groupCounts, groupTasks, streamCounts, streamOf, type StreamId } from './components/streams'
import { ErrorBanner, Icon, READY_META, btn, card, fmtDate, fmtDateTime } from './components/ui'

type TaskStreamId = 'MAP' | 'TPL' | 'FILE' | 'REVIEW'
type ListResponse = { tasks: TaskRow[]; me: Me; handoffCount?: number; handoffOverdue?: number; lastSync?: { ranAt: string; trigger: string; error: string | null } | null; sentLines?: SentLineRow[] }

const ALL_STREAMS: StreamId[] = STREAMS.map(s => s.id)

const isTaskStream = (s: StreamId | null): s is TaskStreamId => s !== null && TASK_STREAMS.includes(s)

function groupDefsOf(stream: StreamId): { id: string }[] {
  if (isTaskStream(stream)) return TASK_GROUPS[stream]
  return stream === 'HANDOFF' ? HANDOFF_GROUPS : []
}

function secondaryRows(rows: TaskRow[], stream: TaskStreamId, filter: SecondaryFilter, mineId: string | null): TaskRow[] {
  const shown = filter === 'NEEDS_ARTWORK' && stream === 'FILE' ? artworkProducts(rows).rows : rows.filter(t => matchesQueueFilter(t, filter, stream === 'REVIEW'))
  return mineId ? shown.filter(t => t.assigneeId === mineId) : shown
}

function streamRows(all: TaskRow[], stream: TaskStreamId, filter: SecondaryFilter, mineId: string | null, group: string | null, now: number) {
  return groupTasks(stream, secondaryRows(all.filter(t => streamOf(t) === stream), stream, filter, mineId), group, now)
}

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

function TaskWorkspace({ detail, holdCount, onChanged, stream, inQueue }: { detail: TaskDetail; holdCount: Record<string, number>; onChanged: () => void; stream: StreamId | null; inQueue: boolean }) {
  const { refreshing, refresh } = useShopifyRefresh(detail.task.orderId, onChanged)
  const qa = useMemo(() => machineQa(detail), [detail])
  const key = detail.task.taskKey
  return (
    <>
      <Banners detail={detail} />
      <Flags detail={detail} stream={stream} inQueue={inQueue} />
      <TaskHeader key={`h-${key}`} detail={detail} qa={qa} holdCount={holdCount} refreshing={refreshing} onRefresh={refresh} onChanged={onChanged} />
      {detail.handoff?.pending && <TaskHandoffChecks key={`checks-${key}`} orderId={detail.task.orderId} me={detail.me} onChanged={onChanged} />}
      <CustomerInputs key={`c-${key}`} detail={detail} refreshing={refreshing} onRefresh={refresh} onChanged={onChanged} />
      <ProductionEditor key={`p-${key}`} detail={detail} onChanged={onChanged} />
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
  const storeFilter = useStoreFilter()
  const readOnly = useSellerReadOnly()

  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [baseTasks, setBaseTasks] = useState<TaskRow[]>([])
  const [baseLoaded, setBaseLoaded] = useState(false)
  const [sentLines, setSentLines] = useState<SentLineRow[]>([])
  const [selLine, setSelLine] = useState<string | null>(null)
  const [me, setMe] = useState<Me | null>(null)
  const [handoffCount, setHandoffCount] = useState(0)
  const [handoffOverdue, setHandoffOverdue] = useState(0)
  const [handoffGroupCounts, setHandoffGroupCounts] = useState<Record<string, number> | null>(null)
  const [dropshipCount, setDropshipCount] = useState<number | undefined>(undefined)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [rawStream, setRawStream] = useState<StreamId>(() => {
    const s = searchParams.get('stream') as StreamId | null
    return s && ALL_STREAMS.includes(s) ? s : 'FILE'
  })
  // A seller's role is known only once the current user has loaded, so the offered set is applied on read rather than frozen at mount.
  const offered = readOnly ? TASK_STREAMS : ALL_STREAMS
  const stream: StreamId = offered.includes(rawStream) ? rawStream : 'FILE'
  const workStream = stream === 'MAP' || stream === 'TPL' || stream === 'FILE'
  const [group, setGroup] = useState<string | null>(() => searchParams.get('group'))
  const activeGroup = group && groupDefsOf(stream).some(d => d.id === group) ? group : null
  const [taskOpen, setTaskOpen] = useState(false)
  const [pinned, setPinned] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  // The hand-off and sent lists are not filtered by store, so the picker is drawn only on the task streams it works on and the list loaded
  // beside the hand-off list is not narrowed by a pick that cannot be seen there.
  const storeFiltered = isTaskStream(stream)
  const listStoreId = storeFiltered ? storeFilter.storeId : null
  const [reviewVersion, setReviewVersion] = useState(0)
  const onDropship = stream === 'DROPSHIP'
  useEffect(() => {
    if (readOnly || onDropship) return
    requestJson<{ unmapped: unknown[]; mapped: unknown[] }>('/api/design-studio/dropship').then(r => { if (r.ok) setDropshipCount(r.data.unmapped.length + r.data.mapped.length) })
  }, [readOnly, onDropship, reviewVersion])
  const [sel, setSel] = useState<string | null>(null)
  const [reviewSel, setReviewSel] = useState<string | null>(null)
  const [filter, setFilter] = useState<SecondaryFilter>('ALL')
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
  const [arrived, setArrived] = useState<string | null>(null)
  const written = useRef<string[]>([])
  const [driveVersion, setDriveVersion] = useState(0)
  const drivePoll = useRef({ key: '', attempts: 0 })

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(i)
  }, [])

  const loadList = useCallback(async () => {
    if (retryTimer.current) { clearTimeout(retryTimer.current); retryTimer.current = null }
    const id = ++listReq.current
    setListLoading(true)
    const qs = new URLSearchParams()
    if (debouncedQ) qs.set('q', debouncedQ)
    if (listStoreId) qs.set('storeId', listStoreId)
    const query = qs.toString()
    const r = await requestJson<ListResponse>(`/api/design-studio/tasks${query ? `?${query}` : ''}`)
    if (id !== listReq.current) return
    setListLoading(false)
    if (!r.ok) {
      if (!isRetryable(r.status)) { retryAttempt.current = 0; setRetrying(false); setListError(r.error); setBaseLoaded(true); return }
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
    if (!debouncedQ) setBaseTasks(r.data.tasks)
    setBaseLoaded(true)
    setSentLines(r.data.sentLines ?? [])
    setMe(r.data.me)
    setHandoffCount(r.data.handoffCount ?? 0)
    setHandoffOverdue(r.data.handoffOverdue ?? 0)
    setLastSync(r.data.lastSync ?? null)
  }, [debouncedQ, listStoreId])

  const loadDetail = useCallback(async (key: string) => {
    const id = ++detailReq.current
    setDetailError('')
    const r = await requestJson<TaskDetail>(taskUrl(key))
    if (id !== detailReq.current) return
    if (!r.ok) { setDetailError(r.error); return }
    setDetailError('')
    setDetail(r.data)
  }, [])

  const openKey = workStream ? sel : stream === 'REVIEW' && taskOpen ? reviewSel : null

  useEffect(() => { loadListRef.current = loadList }, [loadList])
  useEffect(() => {
    onRecovered.current = () => { if (openKey && detailError) loadDetail(openKey) }
  }, [openKey, detailError, loadDetail])
  useEffect(() => { if (storeFilter.ready) loadList() }, [loadList, storeFilter.ready])
  useEffect(() => () => { if (retryTimer.current) clearTimeout(retryTimer.current) }, [])

  useEffect(() => {
    if (openKey) loadDetail(openKey)
  }, [openKey, loadDetail])

  const mineId = mine && me ? me.id : null
  const streamTasks = useMemo(() => baseTasks.filter(t => streamOf(t) === stream), [baseTasks, stream])
  const secondary = useMemo(() => (isTaskStream(stream) ? secondaryRows(streamTasks, stream, filter, mineId) : []), [streamTasks, stream, filter, mineId])
  const visible = useMemo(() => (isTaskStream(stream) ? groupTasks(stream, secondary, activeGroup, now) : []), [stream, secondary, activeGroup, now])
  const queueGroups = useMemo<QueueGroup[]>(() => visible.map(({ def, rows }) => ({ key: def.id, title: def.title, tone: def.tone, rows })), [visible])
  const flat = useMemo(() => visible.flatMap(g => g.rows), [visible])
  const artwork = useMemo(() => artworkProducts(streamTasks), [streamTasks])

  const counts = useMemo(() => streamCounts(baseTasks, { count: handoffCount, overdue: handoffOverdue }, dropshipCount ?? null, now), [baseTasks, handoffCount, handoffOverdue, dropshipCount, now])
  const rowGroups = useMemo(() => {
    if (isTaskStream(stream)) {
      const c = groupCounts(stream, secondary, now)
      return TASK_GROUPS[stream].map(def => ({ def, count: c[def.id] ?? 0 }))
    }
    if (stream === 'HANDOFF') return HANDOFF_GROUPS.map(def => ({ def, count: handoffGroupCounts?.[def.id] ?? 0 }))
    return []
  }, [stream, secondary, now, handoffGroupCounts])
  const rowTotal = stream === 'HANDOFF' && !handoffGroupCounts ? handoffCount : rowGroups.reduce((n, g) => n + g.count, 0)
  const chipCounts = useMemo(() => {
    const review = stream === 'REVIEW'
    const open = streamTasks.filter(t => t.status !== 'DONE' && (!mineId || t.assigneeId === mineId))
    return {
      ALL: open.length,
      AUTO: review ? open.filter(t => t.readiness === 'AUTO' && t.status === 'REVIEW').length : open.filter(t => matchesQueueFilter(t, 'AUTO', false)).length,
      LOW: open.filter(t => matchesQueueFilter(t, 'LOW', review)).length,
      MANUAL: open.filter(t => matchesQueueFilter(t, 'MANUAL', review)).length,
      NEEDS_ARTWORK: artwork.rows.filter(t => !mineId || t.assigneeId === mineId).length,
    } as Record<SecondaryFilter, number>
  }, [streamTasks, stream, mineId, artwork])

  const switchStream = useCallback((id: StreamId) => {
    setRawStream(id)
    setGroup(null)
    setTaskOpen(false)
    setPinned(null)
    if (id !== stream) setHandoffGroupCounts(null)
    if (id !== 'FILE') setFilter(f => (f === 'NEEDS_ARTWORK' ? 'ALL' : f))
  }, [stream])

  const selectTask = useCallback((key: string) => {
    const t = tasks.find(x => x.taskKey === key) ?? baseTasks.find(x => x.taskKey === key)
    const s = t ? streamOf(t) : null
    const target: TaskStreamId = isTaskStream(s) ? s : 'FILE'
    const sameStream = target === stream
    if (!sameStream) switchStream(target)
    const listed = !!t && streamRows(baseTasks, target, filter, mineId, sameStream ? activeGroup : null, now).some(g => g.rows.some(r => r.taskKey === key))
    setPinned(listed ? null : key)
    if (target === 'REVIEW') {
      setReviewSel(key)
      setTaskOpen(true)
    } else {
      setSel(key)
      setSelLine(null)
    }
  }, [tasks, baseTasks, stream, switchStream, filter, mineId, activeGroup, now])

  const pickReview = useCallback((key: string) => {
    if (flat.some(t => t.taskKey === key)) setReviewSel(key)
    else selectTask(key)
  }, [flat, selectTask])

  const arrivalPending = !!paramTask && arrived !== paramTask

  useEffect(() => {
    if (!workStream || !baseLoaded || arrivalPending) return
    if (sel && (sel === pinned || flat.some(t => t.taskKey === sel))) return
    const next = flat[0]?.taskKey ?? null
    if (next !== sel) setSel(next)
  }, [workStream, baseLoaded, arrivalPending, sel, pinned, flat])

  useEffect(() => {
    if (stream !== 'REVIEW' || !baseLoaded || arrivalPending) return
    if (reviewSel && (reviewSel === pinned || flat.some(t => t.taskKey === reviewSel))) return
    const next = flat[0]?.taskKey ?? null
    if (next !== reviewSel) { setReviewSel(next); setTaskOpen(false) }
  }, [stream, baseLoaded, arrivalPending, reviewSel, pinned, flat])

  useEffect(() => {
    const landed = written.current.indexOf(searchParams.toString())
    if (landed >= 0) {
      written.current.splice(0, landed + 1)
      setArrived(paramTask)
      return
    }
    if (!baseLoaded || !paramTask || arrived === paramTask) return
    setArrived(paramTask)
    if (paramTask !== openKey) selectTask(paramTask)
  }, [baseLoaded, paramTask, searchParams, arrived, openKey, selectTask])

  useEffect(() => {
    if (!baseLoaded || arrivalPending) return
    const p = new URLSearchParams()
    if (stream !== 'FILE') p.set('stream', stream)
    if (activeGroup) p.set('group', activeGroup)
    if (openKey) p.set('task', openKey)
    const next = p.toString()
    if (next === searchParams.toString() || written.current[written.current.length - 1] === next) return
    written.current.push(next)
    router.replace(next ? `/design-studio?${next}` : '/design-studio', { scroll: false })
  }, [baseLoaded, arrivalPending, stream, activeGroup, openKey, searchParams, router])

  const reload = useCallback(() => {
    loadList()
    if (openKey) loadDetail(openKey)
    setDriveVersion(v => v + 1)
  }, [loadList, loadDetail, openKey])

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

  const reviewRows = useMemo(() => (stream === 'REVIEW' ? flat : []), [stream, flat])
  const reviewKeys = useMemo(() => reviewRows.map(t => t.taskKey), [reviewRows])
  // A reviewed task leaves the review list at once and the next one in due order takes its place; the list reload confirms.
  const reviewMoved = useCallback((keys: string[], to: TaskStatus) => {
    const next = reviewRows.find((t, i) => !keys.includes(t.taskKey) && i > reviewRows.findIndex(x => x.taskKey === reviewSel)) ?? reviewRows.find(t => !keys.includes(t.taskKey))
    const move = (ts: TaskRow[]) => ts.map(t => (keys.includes(t.taskKey) ? { ...t, status: to } : t))
    setTasks(move)
    setBaseTasks(move)
    if (reviewSel && keys.includes(reviewSel)) setReviewSel(next?.taskKey ?? null)
    reload()
    setReviewVersion(v => v + 1)
  }, [reviewRows, reviewSel, reload])

  const groupTitle = activeGroup ? rowGroups.find(g => g.def.id === activeGroup)?.def.title ?? null : null
  const filterLabel = filter === 'ALL' ? null : filter === 'NEEDS_ARTWORK' ? 'Cần làm artwork' : filter === 'AUTO' && stream === 'REVIEW' ? 'Auto' : READY_META[filter].label
  const filtered = filter !== 'ALL' || mine || !!debouncedQ || !!activeGroup
  const emptyText = emptyQueueText({ readinessLabel: [groupTitle, filterLabel].filter(Boolean).join(' · ') || null, mine, q: debouncedQ })
  const clearFilters = useCallback(() => { setFilter('ALL'); setMine(false); setQ(''); setGroup(null) }, [])

  const holdCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of baseTasks) if (t.assigneeId && t.status !== 'DONE') m[t.assigneeId] = (m[t.assigneeId] ?? 0) + 1
    return m
  }, [baseTasks])

  const current = detail && detail.task.taskKey === openKey ? detail : null
  const currentLine = workStream && selLine ? sentLines.find(l => l.lineId === selLine) ?? null : null

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

  const syncTip = lastSync
    ? `${lastSync.error ? `Lượt gần nhất lỗi: ${lastSync.error}` : `Tự đồng bộ mỗi 15 phút · lượt gần nhất ${lastSync.trigger === 'schedule' ? 'tự động' : 'bấm tay'}`} · ${fmtDateTime(lastSync.ranAt)}`
    : 'Đồng bộ task từ Shopify'
  const streamDef = STREAMS.find(s => s.id === stream) ?? STREAMS[2]
  const showStore = storeFilter.stores.length > 1

  const workspace = openKey && (
    <>
      {detailError && (
        <div className={`${card} p-md`}><ErrorBanner msg={`${openKey}: ${detailError}`} onClose={() => setDetailError('')} /></div>
      )}
      {!detailError && !current && (
        <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
          <Icon name="progress_activity" className="animate-spin" />Đang tải {openKey}…
        </div>
      )}
      {current && (
        <LightboxProvider images={images}>
          <TaskWorkspace detail={current} holdCount={holdCount} onChanged={reload}
            stream={streamOf(current.task) ?? stream} inQueue={baseTasks.some(t => t.taskKey === current.task.taskKey)} />
        </LightboxProvider>
      )}
    </>
  )

  const queue = isTaskStream(stream) && (
    <Queue tasks={tasks} groups={queueGroups} sel={stream === 'REVIEW' ? reviewSel : sel} onSelect={stream === 'REVIEW' ? pickReview : selectTask}
      q={q} onQ={setQ} loading={listLoading} error={listError} retrying={retrying} showStore={showStore}
      emptyText={filtered ? emptyText : 'Không có task'} onClearFilters={filtered ? clearFilters : null}
      artworkWaiting={stream === 'FILE' ? artwork.waiting : undefined} needsArtworkMode={stream === 'FILE' && filter === 'NEEDS_ARTWORK'}
      sentLines={workStream ? sentLines : []} selLine={currentLine?.lineId ?? null} onSelectLine={workStream ? setSelLine : undefined} />
  )

  return (
    <>
      <div className="flex items-center gap-lg flex-wrap mb-md">
        <div className="flex items-center gap-xs">
          <h1 className="text-headline-sm text-on-surface">Design Tasks</h1>
          <span role="img" aria-label="Giải thích Task ID" title="Task ID = mã đơn_dòng hàng (vd. LIT5000_1 = đơn #LIT5000, dòng 1) · mỗi task là một dòng hàng cần file in">
            <Icon name="info" className="text-[18px] text-on-surface-variant" />
          </span>
        </div>
        {storeFiltered && <StoreFilter filter={storeFilter} />}
        <button type="button" onClick={sync} disabled={syncing} aria-label="Đồng bộ task từ Shopify" title={syncTip}
          className={`ml-auto inline-grid place-items-center w-10 h-10 rounded-lg border bg-surface-container-lowest hover:bg-surface-container-low disabled:opacity-60 ${lastSync?.error ? 'border-error text-error' : 'border-outline-variant text-on-surface-variant'}`}>
          <Icon name="sync" className={`text-[20px] ${syncing ? 'animate-spin' : ''}`} />
        </button>
      </div>
      {syncError && <div className="mb-md"><ErrorBanner msg={syncError} onClose={() => setSyncError('')} /></div>}
      <DriveHealthBanner version={driveVersion} />

      <div className="flex flex-col gap-md mb-md">
        <StreamStepper counts={counts} active={stream} streams={offered} onSelect={switchStream} />
        <PriorityRow stream={streamDef} total={rowTotal} unit={streamDef.unit} groups={rowGroups} group={activeGroup} onGroup={setGroup}
          titleOnly={stream === 'SENT' || stream === 'DROPSHIP'}
          secondary={isTaskStream(stream) ? {
            filter, onFilter: setFilter, autoLabel: stream === 'REVIEW' ? 'Auto' : READY_META.AUTO.label,
            counts: chipCounts, needsArtwork: stream === 'FILE', mine, onMine: () => setMine(m => !m),
          } : null} />
      </div>

      {workStream ? (
        <div className="grid grid-cols-[290px_minmax(0,1fr)] gap-md items-start">
          {queue}
          {currentLine ? (
            <SentLinePanel key={currentLine.lineId} line={currentLine} onReopened={key => { setSelLine(null); selectTask(key); loadList() }} />
          ) : (
            <div className="flex flex-col gap-md min-w-0">
              {baseLoaded && !sel && !listLoading && !listError && (
                <div className={`${card} p-lg text-body-sm text-on-surface-variant`}>
                  {baseTasks.length === 0 ? 'Chưa có task nào. Bấm nút đồng bộ ở góc phải để tạo task từ các đơn đang chờ design.' : 'Luồng này không có task nào.'}
                </div>
              )}
              {workspace}
            </div>
          )}
        </div>
      ) : stream === 'REVIEW' ? (
        <div className="grid grid-cols-[290px_minmax(0,1fr)] gap-md items-start">
          {queue}
          <div className="flex flex-col gap-md min-w-0">
            {taskOpen && reviewSel ? (
              <>
                <div><button type="button" className={btn} onClick={() => setTaskOpen(false)}><Icon name="arrow_back" className="text-[16px]" />Màn duyệt</button></div>
                {workspace}
              </>
            ) : (
              <>
                <ReviewToolbar total={reviewKeys.length} only={reviewKeys} version={reviewVersion} onApproved={keys => reviewMoved(keys, 'DONE')} />
                {reviewSel ? (
                  <ReviewWorkspace key={reviewSel} taskKey={reviewSel} position={{ index: Math.max(0, reviewKeys.indexOf(reviewSel)), total: reviewKeys.length }}
                    onMoved={(key, to) => reviewMoved([key], to)} onOpenTask={selectTask} onChanged={reload} />
                ) : !listLoading && (
                  <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
                    <Icon name="task_alt" className="text-on-tertiary-container" />Không có mẫu nào chờ duyệt.
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      ) : stream === 'HANDOFF' ? (
        <div className="flex flex-col gap-md min-w-0">
          <div className={`${card} p-sm`}>
            <label className="flex items-center gap-xs h-9 px-sm rounded-lg bg-surface-container-low text-on-surface-variant">
              <Icon name="search" className="text-[18px]" />
              <input value={q} onChange={e => setQ(e.target.value)} placeholder="Tìm đơn, task ID, SKU…" aria-label="Tìm đơn"
                className="flex-1 min-w-0 bg-transparent text-[13px] text-on-surface outline-none" />
              {listLoading && <Icon name="progress_activity" className="text-[16px] animate-spin" />}
            </label>
          </div>
          <HandoffGrid q={debouncedQ} version={reviewVersion} group={activeGroup} onGroupCounts={setHandoffGroupCounts} onOpenTask={selectTask} onChanged={reload} />
        </div>
      ) : stream === 'DROPSHIP' ? (
        <DropshipGrid q="" version={reviewVersion} onCount={setDropshipCount} onSend={orderNumber => { setQ(orderNumber); switchStream('HANDOFF') }} />
      ) : (
        <SentGrid q={debouncedQ} rawQ={q} onQ={setQ} version={reviewVersion} showStore={showStore} onOpenTask={selectTask} onChanged={reload} />
      )}
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
