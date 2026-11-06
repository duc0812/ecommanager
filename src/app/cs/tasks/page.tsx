'use client'
import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import { RoleGate } from '@/components/RoleGate'
import { fmtDate } from '@/components/cs/UrgencyChip'
import { DEPT_LABELS, STATUS_LABELS, TASK_DEPTS, TASK_META, TASK_TYPES, type TaskDept, type TaskStatus, type TaskType } from '@/lib/cs/task-labels'

type Task = {
  id: string; ticketId: string | null; orderNumber: string | null; type: TaskType; dept: TaskDept; priority: number; status: TaskStatus
  detail: string; amount: number | null; source: string; createdByName: string | null; dueAt: string | null; doneAt: string | null; createdAt: string; updatedAt: string
  ticket: { id: string; fdTicketId: number; subject: string; requesterName: string | null } | null; eventCount: number
}
type TaskEvent = { id: string; kind: string; body: string; fromStatus: string | null; toStatus: string | null; authorName: string | null; createdAt: string }

const COLUMNS: { key: TaskStatus; hint: string }[] = [
  { key: 'NEW', hint: 'Agent vừa tạo, CS cần xác nhận' },
  { key: 'IN_PROGRESS', hint: 'Đã chuyển bên xử lý' },
  { key: 'WAITING', hint: 'Chờ khách hoặc bên thứ 3' },
  { key: 'DONE', hint: 'Xong / huỷ trong 7 ngày' },
]
const PRIORITY_CHIP: Record<number, { label: string; cls: string }> = {
  1: { label: 'Bên thứ 3', cls: 'bg-error/10 text-error' },
  2: { label: 'Tiền', cls: 'bg-tertiary-container text-on-tertiary-container' },
  3: { label: 'Khác', cls: 'bg-surface-container-high text-on-surface-variant' },
}
const EVENT_LABELS: Record<string, string> = { CREATED: 'Tạo task', STATUS: 'Đổi trạng thái', COMMENT: 'Bình luận', AGENT: 'Agent cập nhật', DEPT: 'Đổi bộ phận', AMOUNT: 'Số tiền' }
const MONEY: TaskType[] = ['REFUND', 'DISCOUNT_CODE']
const money = (n: number) => '$' + n.toFixed(2)
const isOpen = (s: TaskStatus) => s === 'NEW' || s === 'IN_PROGRESS' || s === 'WAITING'

export default function CsTasksPage() {
  const [tasks, setTasks] = useState<Task[]>([])
  const [loading, setLoading] = useState(true)
  const [dept, setDept] = useState<TaskDept | ''>('')
  const [type, setType] = useState<TaskType | ''>('')
  const [openId, setOpenId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const qs = new URLSearchParams()
    if (dept) qs.set('dept', dept)
    if (type) qs.set('type', type)
    const res = await fetch(`/api/cs/tasks?${qs}`)
    const data = await res.json().catch(() => ({}))
    setTasks(data.tasks ?? [])
    setLoading(false)
  }, [dept, type])

  useEffect(() => { load() }, [load])
  useEffect(() => { const id = setInterval(load, 60_000); return () => clearInterval(id) }, [load])
  useEffect(() => { const t = new URLSearchParams(window.location.search).get('task'); if (t) setOpenId(t) }, [])

  const now = Date.now()
  const open = tasks.filter(t => isOpen(t.status))
  const overdue = open.filter(t => t.dueAt && new Date(t.dueAt).getTime() < now)
  const unpricedRefunds = open.filter(t => t.type === 'REFUND' && t.amount == null)

  return (
    <RoleGate>
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-0 lg:ml-[280px] mt-14 lg:mt-0 flex-1 p-xl">
        <header className="mb-lg flex flex-wrap items-end justify-between gap-md">
          <div>
            <p className="text-label-sm uppercase tracking-wider text-on-surface-variant">Customer Service</p>
            <h2 className="text-display-md font-bold text-primary">Task</h2>
            <p className="mt-xs text-body-md text-on-surface-variant">Việc phát sinh từ ticket cần bên khác xử lý. Agent tạo, nhân sự cập nhật trạng thái và ghi kết quả vào từng task.</p>
          </div>
          <div className="flex flex-wrap gap-sm text-label-md">
            <span className="rounded-lg bg-surface-container px-md py-sm">Đang mở: <b>{open.length}</b></span>
            <span className={`rounded-lg px-md py-sm ${overdue.length ? 'bg-error/10 text-error' : 'bg-surface-container'}`}>Quá hạn 24h: <b>{overdue.length}</b></span>
            <span className={`rounded-lg px-md py-sm ${unpricedRefunds.length ? 'bg-error/10 text-error' : 'bg-surface-container'}`}>Refund chưa chốt số tiền: <b>{unpricedRefunds.length}</b></span>
          </div>
        </header>

        <div className="mb-md flex flex-wrap items-center gap-sm">
          {(['', ...TASK_DEPTS] as (TaskDept | '')[]).map(d => (
            <button key={d || 'all'} onClick={() => setDept(d)} className={`rounded-lg px-md py-xs text-label-md ${dept === d ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>{d ? DEPT_LABELS[d] : 'Tất cả'}</button>
          ))}
          <select value={type} onChange={e => setType(e.target.value as TaskType | '')} className="ml-auto rounded-lg border border-outline-variant/40 bg-surface px-md py-xs text-body-sm">
            <option value="">Mọi loại task</option>
            {TASK_TYPES.map(t => <option key={t} value={t}>{TASK_META[t].label}</option>)}
          </select>
        </div>

        {loading ? <p className="text-body-sm text-on-surface-variant">Đang tải…</p> : (
          <div className="grid grid-cols-1 gap-md md:grid-cols-2 xl:grid-cols-4">
            {COLUMNS.map(col => {
              const items = tasks.filter(t => col.key === 'DONE' ? !isOpen(t.status) : t.status === col.key)
              return (
                <section key={col.key} className="rounded-xl border border-outline-variant/20 bg-surface-container-low">
                  <div className="flex items-center gap-sm border-b border-outline-variant/20 px-md py-sm">
                    <h3 className="text-label-md text-primary">{STATUS_LABELS[col.key]}</h3>
                    <span className="rounded-full bg-surface-container-high px-sm text-label-sm">{items.length}</span>
                    <span className="ml-auto text-label-sm text-on-surface-variant">{col.hint}</span>
                  </div>
                  <div className="space-y-sm p-sm">
                    {items.length === 0 && <p className="px-sm py-md text-center text-label-sm text-on-surface-variant">Trống</p>}
                    {items.map(t => <TaskCard key={t.id} t={t} now={now} onOpen={() => setOpenId(t.id)} />)}
                  </div>
                </section>
              )
            })}
          </div>
        )}
      </main>
      {openId && <TaskDrawer id={openId} onClose={() => setOpenId(null)} onChanged={load} />}
    </div>
    </RoleGate>
  )
}

function TaskCard({ t, now, onOpen }: { t: Task; now: number; onOpen: () => void }) {
  const late = isOpen(t.status) && t.dueAt && new Date(t.dueAt).getTime() < now
  const chip = PRIORITY_CHIP[t.priority] ?? PRIORITY_CHIP[3]
  return (
    <button onClick={onOpen} className={`w-full rounded-lg border bg-surface-container-lowest p-sm text-left shadow-card ${late ? 'border-error/50' : 'border-outline-variant/20'} ${t.status === 'CANCELLED' ? 'opacity-60' : ''}`}>
      <p className="flex flex-wrap items-center gap-xs">
        <span className={`rounded-full px-sm text-label-sm ${chip.cls}`}>{chip.label}</span>
        <span className="text-label-md text-primary">{TASK_META[t.type]?.label ?? t.type}</span>
        {t.status === 'CANCELLED' && <span className="text-label-sm text-on-surface-variant">· huỷ</span>}
      </p>
      <p className="mt-xs line-clamp-3 text-body-sm text-on-surface">{t.detail}</p>
      {MONEY.includes(t.type) && (
        t.amount != null
          ? <p className="mt-xs text-label-md text-primary">{money(t.amount)}</p>
          : t.type === 'REFUND' && <p className="mt-xs text-label-sm text-error">Chưa chốt số tiền</p>
      )}
      <p className="mt-xs flex flex-wrap gap-x-sm text-label-sm text-on-surface-variant">
        <span>{t.orderNumber ?? 'không đơn'}</span>
        {t.ticket && <span>· #{t.ticket.fdTicketId}</span>}
        <span>· {DEPT_LABELS[t.dept] ?? t.dept}</span>
        <span>· {t.eventCount} cập nhật</span>
      </p>
      <p className={`mt-xs text-label-sm ${late ? 'text-error' : 'text-on-surface-variant'}`}>
        {t.status === 'DONE' && t.doneAt ? `Xong ${fmtDate(t.doneAt, true)}` : late ? `Quá hạn · tạo ${fmtDate(t.createdAt, true)}` : `Tạo ${fmtDate(t.createdAt, true)}`}
      </p>
    </button>
  )
}

function TaskDrawer({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<{ task: Task; events: TaskEvent[] } | null>(null)
  const [note, setNote] = useState('')
  const [comment, setComment] = useState('')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    const res = await fetch(`/api/cs/tasks/${id}`)
    if (!res.ok) { setError('Không tìm thấy task'); return }
    const d = await res.json()
    setData(d)
    setAmount(d.task.amount != null ? String(d.task.amount) : '')
  }, [id])
  useEffect(() => { load() }, [load])

  async function call(path: string, method: string, body: unknown) {
    setBusy(true)
    setError(null)
    const res = await fetch(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    const d = await res.json().catch(() => ({}))
    setBusy(false)
    if (!res.ok) { setError(d.error ?? 'Thao tác thất bại'); return false }
    await load()
    onChanged()
    return true
  }

  const t = data?.task
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <aside className="h-full w-full max-w-[480px] overflow-y-auto bg-surface-container-lowest shadow-card" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-sm border-b border-outline-variant/20 px-lg py-md">
          <h3 className="text-headline-sm text-primary">{t ? TASK_META[t.type]?.label ?? t.type : 'Task'}</h3>
          <button onClick={onClose} className="ml-auto text-on-surface-variant"><span className="material-symbols-outlined">close</span></button>
        </div>
        {error && <p className="mx-lg mt-md rounded-lg bg-error/10 px-md py-sm text-body-sm text-error">{error}</p>}
        {!t ? <p className="p-lg text-body-sm text-on-surface-variant">Đang tải…</p> : (
          <div className="space-y-md p-lg text-body-sm">
            <div className="space-y-xs">
              <p className="flex flex-wrap gap-xs">
                <span className={`rounded-full px-sm text-label-sm ${(PRIORITY_CHIP[t.priority] ?? PRIORITY_CHIP[3]).cls}`}>{(PRIORITY_CHIP[t.priority] ?? PRIORITY_CHIP[3]).label}</span>
                <span className="rounded-full bg-surface-container px-sm text-label-sm">{STATUS_LABELS[t.status]}</span>
              </p>
              <p className="whitespace-pre-wrap">{t.detail}</p>
              <p className="text-label-sm text-on-surface-variant">
                {t.orderNumber ?? 'không đơn'}
                {t.ticket && <> · <Link href={`/cs/${t.ticket.id}`} className="text-secondary">Ticket #{t.ticket.fdTicketId}</Link></>}
                {' '}· tạo bởi {t.createdByName ?? 'Agent'} {fmtDate(t.createdAt, true)}
                {t.dueAt && isOpen(t.status) && <> · hạn {fmtDate(t.dueAt, true)}</>}
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-sm">
              <label className="text-label-sm text-on-surface-variant">Bộ phận</label>
              <select value={t.dept} disabled={busy} onChange={e => call(`/api/cs/tasks/${id}`, 'PATCH', { dept: e.target.value })} className="rounded-lg border border-outline-variant/40 bg-surface px-md py-xs">
                {TASK_DEPTS.map(d => <option key={d} value={d}>{DEPT_LABELS[d]}</option>)}
              </select>
            </div>

            {MONEY.includes(t.type) && (
              <div className="flex flex-wrap items-center gap-sm">
                <label className="text-label-sm text-on-surface-variant">Số tiền đã chốt ($)</label>
                <input value={amount} onChange={e => setAmount(e.target.value)} inputMode="decimal" placeholder="vd 30.41" className="w-28 rounded-lg border border-outline-variant/40 bg-surface px-md py-xs" />
                <button disabled={busy || amount === (t.amount != null ? String(t.amount) : '')} onClick={() => call(`/api/cs/tasks/${id}`, 'PATCH', { amount: amount.trim() === '' ? null : Number(amount) })} className="rounded-lg border border-outline-variant/40 px-md py-xs text-label-md text-primary disabled:opacity-50">Lưu số tiền</button>
              </div>
            )}

            <div className="space-y-xs rounded-lg bg-surface-container-low p-md">
              <p className="text-label-sm uppercase text-on-surface-variant">Chuyển trạng thái</p>
              <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} placeholder="Ghi chú kết quả (vd: đã báo xưởng Mango, xưởng xác nhận đổi size)" className="w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-xs" />
              <div className="flex flex-wrap gap-xs">
                {(Object.keys(STATUS_LABELS) as TaskStatus[]).filter(s => s !== t.status).map(s => (
                  <button key={s} disabled={busy} onClick={async () => { if (await call(`/api/cs/tasks/${id}`, 'PATCH', { status: s, note })) setNote('') }}
                    className={`rounded-lg px-md py-xs text-label-md disabled:opacity-50 ${s === 'DONE' ? 'bg-secondary text-on-secondary' : 'border border-outline-variant/40 text-primary'}`}>{STATUS_LABELS[s]}</button>
                ))}
              </div>
            </div>

            <div>
              <p className="mb-sm text-label-sm uppercase text-on-surface-variant">Lịch sử</p>
              <ol className="space-y-sm border-l border-outline-variant/40 pl-md">
                {data!.events.map(e => (
                  <li key={e.id}>
                    <p className="text-label-sm text-on-surface-variant">
                      {e.authorName ?? 'Agent'} · {fmtDate(e.createdAt, true)} · {EVENT_LABELS[e.kind] ?? e.kind}
                      {e.kind === 'STATUS' && e.fromStatus && e.toStatus && <> · {STATUS_LABELS[e.fromStatus as TaskStatus] ?? e.fromStatus} → <b>{STATUS_LABELS[e.toStatus as TaskStatus] ?? e.toStatus}</b></>}
                    </p>
                    {e.body && <p className="whitespace-pre-wrap">{e.body}</p>}
                  </li>
                ))}
              </ol>
            </div>

            <div className="space-y-xs">
              <textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} placeholder="Bình luận / cập nhật cho task" className="w-full rounded-lg border border-outline-variant/40 bg-surface px-md py-xs" />
              <button disabled={busy || !comment.trim()} onClick={async () => { if (await call(`/api/cs/tasks/${id}/comments`, 'POST', { body: comment })) setComment('') }} className="rounded-lg bg-secondary px-lg py-sm text-label-md text-on-secondary disabled:opacity-50">Gửi bình luận</button>
            </div>
          </div>
        )}
      </aside>
    </div>
  )
}
