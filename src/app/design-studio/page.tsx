'use client'
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Sidebar from '@/components/Sidebar'
import type { Me, Readiness, TaskDetail, TaskRow } from './components/types'
import { postJson, requestJson, taskUrl } from './components/model'
import Queue from './components/Queue'
import TaskHeader from './components/TaskHeader'
import ImagePanes from './components/ImagePanes'
import LowerGrid from './components/LowerGrid'
import { ErrorBanner, Icon, Note, READY_META, btnPrimary, card } from './components/ui'

type Filter = 'ALL' | Readiness

function Flags({ detail }: { detail: TaskDetail }) {
  const { task, line } = detail
  return (
    <>
      {task.status === 'REJECTED' && (
        <Note tone="bad" icon="undo">
          <b>Leader trả lại:</b> {task.rejectReasons.join(', ') || '—'}{task.rejectNote ? ` — ${task.rejectNote}` : ''}
        </Note>
      )}
      {!line.supplier && <Note tone="bad" icon="error">Dòng này chưa map xưởng — không biết template / yêu cầu file.</Note>}
      {line.designNote && <Note tone="idle" icon="sticky_note_2">{line.designNote}</Note>}
    </>
  )
}

function DesignTasks() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const paramTask = searchParams.get('task')

  const [tasks, setTasks] = useState<TaskRow[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [listLoading, setListLoading] = useState(false)
  const [listError, setListError] = useState('')
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
  const listReq = useRef(0)
  const detailReq = useRef(0)

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  useEffect(() => {
    if (paramTask) setSel(paramTask)
  }, [paramTask])

  const loadList = useCallback(async () => {
    const id = ++listReq.current
    setListLoading(true)
    const qs = new URLSearchParams()
    if (mine) qs.set('mine', '1')
    if (debouncedQ) qs.set('q', debouncedQ)
    const query = qs.toString()
    const r = await requestJson<{ tasks: TaskRow[]; me: Me }>(`/api/design-studio/tasks${query ? `?${query}` : ''}`)
    if (id !== listReq.current) return
    setListLoading(false)
    if (!r.ok) { setListError(r.error); return }
    setListError('')
    setTasks(r.data.tasks)
    setMe(r.data.me)
  }, [mine, debouncedQ])

  const loadDetail = useCallback(async (key: string) => {
    const id = ++detailReq.current
    setDetailError('')
    const r = await requestJson<TaskDetail>(taskUrl(key))
    if (id !== detailReq.current) return
    if (!r.ok) { setDetailError(r.error); setDetail(null); return }
    setDetailError('')
    setDetail(r.data)
  }, [])

  useEffect(() => { loadList() }, [loadList])

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

  async function sync() {
    setSyncing(true); setSyncMsg(''); setSyncError('')
    const r = await postJson<{ created: number; cancelled: number; completed: number; orders: number }>('/api/design-studio/tasks/sync', {})
    setSyncing(false)
    if (!r.ok) { setSyncError(r.error); return }
    setSyncMsg(`${r.data.orders} đơn · tạo ${r.data.created} · huỷ ${r.data.cancelled} · xong ${r.data.completed}`)
    loadList()
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

  const holdCount = useMemo(() => {
    const m: Record<string, number> = {}
    for (const t of tasks) if (t.assigneeId && t.status !== 'DONE') m[t.assigneeId] = (m[t.assigneeId] ?? 0) + 1
    return m
  }, [tasks])

  const current = detail && detail.task.taskKey === sel ? detail : null
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
        </div>
        <div className="ml-auto flex items-center gap-sm">
          {me && <span className="text-label-sm text-on-surface-variant">{me.name} · {me.isLeader ? 'Leader' : 'Designer'}</span>}
          {syncMsg && <span role="status" className="text-label-sm text-on-surface-variant">{syncMsg}</span>}
          <button type="button" onClick={sync} disabled={syncing} className={`${btnPrimary} px-lg py-sm text-label-md`}>
            <Icon name="sync" className={`text-[18px] ${syncing ? 'animate-spin' : ''}`} />{syncing ? 'Đang đồng bộ…' : 'Đồng bộ task'}
          </button>
        </div>
      </div>
      {syncError && <div className="mb-md"><ErrorBanner msg={syncError} onClose={() => setSyncError('')} /></div>}

      <div className="grid grid-cols-[290px_minmax(0,1fr)] gap-md items-start">
        <Queue tasks={visible} sel={sel} onSelect={setSel} q={q} onQ={setQ} loading={listLoading} error={listError} />
        <div className="flex flex-col gap-md min-w-0">
          {!sel && !listLoading && (
            <div className={`${card} p-lg text-body-sm text-on-surface-variant`}>Chưa có task nào. Bấm &quot;Đồng bộ task&quot; để tạo task từ các đơn đang chờ design.</div>
          )}
          {sel && detailError && (
            <div className={`${card} p-md`}><ErrorBanner msg={`${sel}: ${detailError}`} /></div>
          )}
          {sel && !detailError && !current && (
            <div className={`${card} p-lg text-body-sm text-on-surface-variant flex items-center gap-sm`}>
              <Icon name="progress_activity" className="animate-spin" />Đang tải {sel}…
            </div>
          )}
          {current && (
            <>
              <TaskHeader key={`h-${current.task.taskKey}`} detail={current} holdCount={holdCount} onChanged={reload} />
              <ImagePanes key={`i-${current.task.taskKey}`} detail={current} />
              <Flags detail={current} />
              <LowerGrid key={`l-${current.task.taskKey}`} detail={current} onChanged={reload} />
            </>
          )}
        </div>
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
