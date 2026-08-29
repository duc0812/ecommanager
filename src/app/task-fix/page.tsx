'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Sidebar from '@/components/Sidebar'
import { TASK_META, TASK_TYPES, type TaskType, type TaskDept } from '@/lib/order-tasks'

type TaskRow = {
  orderId: string
  shopifyOrderNumber: string
  placedAt: string
  projectName: string | null
  task: { type: TaskType; dept: TaskDept; label: string; detail: string }
}
type Project = { id: string; name: string }

const DEPT_LABEL: Record<TaskDept, string> = { MAPPING: 'Mapping', DESIGN: 'Design' }
const TYPE_TONE: Record<TaskType, string> = {
  MISSING_SKU: 'bg-rose-100 text-rose-900',
  UNMAPPED: 'bg-amber-100 text-amber-900',
  MISSING_BASE_COST: 'bg-orange-100 text-orange-900',
  MISSING_DESIGN: 'bg-indigo-100 text-indigo-900',
}

export default function TaskFixPage() {
  const [projects, setProjects] = useState<Project[]>([])
  const [projectId, setProjectId] = useState('')
  const [deptFilter, setDeptFilter] = useState<'' | TaskDept>('')
  const [typeFilter, setTypeFilter] = useState<'' | TaskType>('')

  const [rows, setRows] = useState<TaskRow[]>([])
  const [counts, setCounts] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(false)
  const [rechecking, setRechecking] = useState<string>('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    fetch('/api/projects').then(r => r.json()).then(d => setProjects(Array.isArray(d) ? d : (d.projects ?? []))).catch(() => {})
  }, [])

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const qs = projectId ? `?projectId=${projectId}` : ''
      const res = await fetch(`/api/fulfillment/task-fix${qs}`)
      const data = await res.json()
      setRows(data.rows ?? [])
      setCounts(data.counts ?? {})
    } catch (e: any) {
      setMessage(`Load thất bại: ${e.message}`)
    } finally {
      setLoading(false)
    }
  }, [projectId])

  useEffect(() => { load() }, [load])

  const visible = useMemo(
    () => rows.filter(r =>
      (!deptFilter || r.task.dept === deptFilter) &&
      (!typeFilter || r.task.type === typeFilter)),
    [rows, deptFilter, typeFilter],
  )

  async function recheck(row: TaskRow) {
    setRechecking(`${row.orderId}:${row.task.type}`)
    setMessage('')
    try {
      const res = await fetch(`/api/fulfillment/orders/${row.orderId}/recheck`, { method: 'POST' })
      const body = await res.json()
      if (!res.ok) { setMessage(`Lỗi: ${body.error ?? res.statusText}`); return }
      const stillOpen = (body.remaining ?? []).some((t: any) => t.type === row.task.type)
      setMessage(
        stillOpen
          ? `${row.shopifyOrderNumber}: task "${row.task.label}" vẫn chưa xong.`
          : `${row.shopifyOrderNumber}: đã xong "${row.task.label}"${body.skuBackfilled ? ` (điền ${body.skuBackfilled} SKU)` : ''}.`,
      )
      await load()
    } catch (e: any) {
      setMessage(`Lỗi: ${e.message}`)
    } finally {
      setRechecking('')
    }
  }

  const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 w-full lg:w-[calc(100vw-280px)] min-w-0 overflow-x-hidden p-xl">
        <div className="flex items-center justify-between mb-lg gap-md">
          <div>
            <p className="text-label-sm text-on-surface-variant uppercase tracking-wider mb-xs">Fulfillment</p>
            <h1 className="text-display-md text-primary">Task Need Fix</h1>
          </div>
          <select value={projectId} onChange={e => setProjectId(e.target.value)} className="border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm">
            <option value="">All projects</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        {message && <p className="mb-md text-body-sm text-on-surface-variant">{message}</p>}

        {/* Count chips per task type */}
        <div className="flex flex-wrap gap-sm mb-md">
          {TASK_TYPES.map(t => (
            <button
              key={t}
              onClick={() => setTypeFilter(typeFilter === t ? '' : t)}
              className={`inline-flex items-center gap-xs px-md py-xs rounded-full text-label-sm border transition-colors ${
                typeFilter === t ? `${TYPE_TONE[t]} border-transparent ring-1 ring-inset ring-current`
                  : 'bg-surface-container-lowest text-on-surface-variant border-outline-variant/40 hover:bg-surface-container'
              }`}
            >
              {TASK_META[t].label} <span className="opacity-70">({counts[t] ?? 0})</span>
            </button>
          ))}
        </div>

        {/* Dept filter */}
        <div className="flex flex-wrap gap-sm mb-md">
          <select value={deptFilter} onChange={e => setDeptFilter(e.target.value as any)} className="border border-outline-variant/40 rounded-lg px-md py-sm text-body-sm">
            <option value="">Tất cả bộ phận</option>
            <option value="MAPPING">Mapping</option>
            <option value="DESIGN">Design</option>
          </select>
          {(deptFilter || typeFilter) && (
            <button onClick={() => { setDeptFilter(''); setTypeFilter('') }} className="text-label-sm text-on-surface-variant underline underline-offset-2">Bỏ lọc</button>
          )}
        </div>

        <div className="bg-surface-container-lowest rounded-xl border border-outline-variant/20 overflow-hidden">
          <table className="w-full text-body-sm">
            <thead className="bg-surface-container text-on-surface-variant">
              <tr className="text-left">
                <th className="px-md py-sm font-medium">Order #</th>
                <th className="px-md py-sm font-medium">Bộ phận</th>
                <th className="px-md py-sm font-medium">Issue</th>
                <th className="px-md py-sm font-medium">Chi tiết</th>
                <th className="px-md py-sm font-medium">Project</th>
                <th className="px-md py-sm font-medium">Ngày</th>
                <th className="px-md py-sm font-medium text-right">Re-check</th>
              </tr>
            </thead>
            <tbody>
              {visible.map(r => (
                <tr key={`${r.orderId}:${r.task.type}`} className="border-t border-outline-variant/20 hover:bg-surface-container/40">
                  <td className="px-md py-sm font-medium">{r.shopifyOrderNumber}</td>
                  <td className="px-md py-sm">{DEPT_LABEL[r.task.dept]}</td>
                  <td className="px-md py-sm">
                    <span className={`inline-block rounded-full px-sm py-[3px] text-label-sm ${TYPE_TONE[r.task.type]}`}>{r.task.label}</span>
                  </td>
                  <td className="px-md py-sm max-w-[280px] truncate text-on-surface-variant" title={r.task.detail}>{r.task.detail}</td>
                  <td className="px-md py-sm text-on-surface-variant">{r.projectName ?? '—'}</td>
                  <td className="px-md py-sm text-label-sm text-on-surface-variant whitespace-nowrap">{fmtDate(r.placedAt)}</td>
                  <td className="px-md py-sm text-right">
                    <button
                      onClick={() => recheck(r)}
                      disabled={rechecking === `${r.orderId}:${r.task.type}`}
                      className="inline-flex items-center gap-xs border border-outline-variant/40 rounded-lg px-md py-xs text-label-sm hover:bg-surface-container disabled:opacity-50"
                    >
                      <span className={`material-symbols-outlined text-[16px] ${rechecking === `${r.orderId}:${r.task.type}` ? 'animate-spin' : ''}`}>{rechecking === `${r.orderId}:${r.task.type}` ? 'sync' : 'refresh'}</span>
                      Re-check
                    </button>
                  </td>
                </tr>
              ))}
              {visible.length === 0 && (
                <tr>
                  <td colSpan={7} className="px-md py-lg text-center text-on-surface-variant">
                    {loading ? 'Đang tải…' : '🎉 Không có task nào cần fix.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </main>
    </div>
  )
}
