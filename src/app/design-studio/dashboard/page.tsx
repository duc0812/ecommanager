'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import Sidebar from '@/components/Sidebar'
import type { Me, TaskRow } from '../components/types'
import { OPEN_STATUSES, requestJson } from '../components/model'
import { Avatar, Card, ErrorBanner, Icon, Pill, card, btn } from '../components/ui'

const WEEK_MS = 7 * 24 * 3.6e6
const UNASSIGNED = 'Chưa giao'

type PersonRow = { name: string; holding: number; overdue: number; review: number; done7: number; kpi: number }

function Tile({ icon, label, value, tone }: { icon: string; label: string; value: number; tone?: 'bad' | 'warn' }) {
  const color = tone === 'bad' && value > 0 ? 'text-error' : tone === 'warn' && value > 0 ? 'text-amber-900' : 'text-on-surface'
  return (
    <div className={`${card} px-md py-sm flex items-center gap-md`}>
      <Icon name={icon} className="text-[24px] text-on-surface-variant" />
      <div>
        <div className={`text-headline-sm font-bold leading-tight ${color}`}>{value}</div>
        <div className="text-label-sm text-on-surface-variant">{label}</div>
      </div>
    </div>
  )
}

function Empty({ children }: { children: string }) {
  return <p className="py-md text-center text-body-sm text-on-surface-variant">{children}</p>
}

export default function DesignDashboard() {
  const [open, setOpen] = useState<TaskRow[]>([])
  const [done, setDone] = useState<TaskRow[]>([])
  const [me, setMe] = useState<Me | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    setLoading(true)
    const [a, b] = await Promise.all([
      requestJson<{ tasks: TaskRow[]; me: Me }>('/api/design-studio/tasks'),
      requestJson<{ tasks: TaskRow[] }>('/api/design-studio/tasks?statuses=DONE'),
    ])
    setLoading(false)
    setNow(Date.now())
    if (!a.ok) { setError(a.error); return }
    if (!b.ok) { setError(b.error); return }
    setError('')
    setOpen(a.data.tasks)
    setMe(a.data.me)
    setDone(b.data.tasks)
  }, [])

  useEffect(() => { void load() }, [load])

  const stats = useMemo(() => {
    const active = open.filter(t => OPEN_STATUSES.includes(t.status))
    const overdue = active.filter(t => t.dueAt && new Date(t.dueAt).getTime() < now)
    const done7 = done.filter(t => now - new Date(t.dueAt ?? t.placedAt).getTime() <= WEEK_MS)

    const people = new Map<string, PersonRow>()
    const row = (name: string) => {
      let r = people.get(name)
      if (!r) { r = { name, holding: 0, overdue: 0, review: 0, done7: 0, kpi: 0 }; people.set(name, r) }
      return r
    }
    for (const t of active) {
      const r = row(t.assigneeName ?? UNASSIGNED)
      r.holding++
      r.kpi += t.kpi
      if (t.status === 'REVIEW') r.review++
      if (t.dueAt && new Date(t.dueAt).getTime() < now) r.overdue++
    }
    for (const t of done7) if (t.assigneeName) row(t.assigneeName).done7++
    const byPerson = Array.from(people.values()).sort((x, y) => y.overdue - x.overdue || y.holding - x.holding || x.name.localeCompare(y.name))

    const reasonTasks = new Map<string, TaskRow>()
    for (const t of [...open, ...done]) if ((t.status === 'REJECTED' || t.status === 'DONE') && t.rejectReasons.length) reasonTasks.set(t.id, t)
    const counts = new Map<string, number>()
    for (const t of Array.from(reasonTasks.values())) for (const r of t.rejectReasons) counts.set(r, (counts.get(r) ?? 0) + 1)
    const reasons = Array.from(counts.entries()).sort((x, y) => y[1] - x[1])

    return {
      active: active.length,
      overdue: overdue.sort((x, y) => new Date(x.dueAt!).getTime() - new Date(y.dueAt!).getTime()),
      review: open.filter(t => t.status === 'REVIEW').length,
      ask: open.filter(t => t.status === 'ASK_CUSTOMER').length,
      rejected: open.filter(t => t.status === 'REJECTED').length,
      done7: done7.length,
      byPerson, reasons,
    }
  }, [open, done, now])

  const maxReason = stats.reasons[0]?.[1] ?? 1

  return (
    <div className="flex min-h-screen bg-surface">
      <Sidebar />
      <main className="ml-[280px] flex-1 p-xl">
        <div className="flex items-center gap-sm mb-lg">
          <Icon name="space_dashboard" className="text-[28px] text-secondary" />
          <h1 className="text-headline-sm font-bold text-primary">Design Studio · Dashboard</h1>
          <span className="ml-auto text-label-sm text-on-surface-variant">{me ? `${me.name} · ` : ''}xong 7 ngày: {stats.done7}</span>
          <button type="button" className={btn} onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" className="text-[16px]" />Làm mới
          </button>
        </div>

        <ErrorBanner msg={error} onClose={() => setError('')} />
        {loading && open.length === 0 && !error && <p className="text-body-sm text-on-surface-variant">Đang tải…</p>}

        <div className="grid grid-cols-2 xl:grid-cols-5 gap-md mt-md">
          <Tile icon="folder_open" label="Đang mở" value={stats.active} />
          <Tile icon="alarm" label="Quá hạn SLA" value={stats.overdue.length} tone="bad" />
          <Tile icon="rate_review" label="Chờ duyệt" value={stats.review} />
          <Tile icon="help" label="Đang hỏi khách" value={stats.ask} tone="warn" />
          <Tile icon="undo" label="Bị trả lại" value={stats.rejected} tone="bad" />
        </div>

        <div className="grid grid-cols-1 xl:grid-cols-2 gap-md mt-md">
          <Card icon="group" title="Theo người" right={`${stats.byPerson.length} người`}>
            {stats.byPerson.length === 0 ? <Empty>Chưa có task đang mở.</Empty> : (
              <table className="w-full text-body-sm">
                <thead>
                  <tr className="text-left text-label-sm text-on-surface-variant">
                    <th className="py-xs font-medium">Người</th>
                    <th className="py-xs font-medium text-right">Đang giữ</th>
                    <th className="py-xs font-medium text-right">Quá hạn</th>
                    <th className="py-xs font-medium text-right">Chờ duyệt</th>
                    <th className="py-xs font-medium text-right">Xong 7 ngày</th>
                    <th className="py-xs font-medium text-right">KPI</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.byPerson.map(p => (
                    <tr key={p.name} className="border-t border-outline-variant/20">
                      <td className="py-xs"><span className="inline-flex items-center gap-xs">{p.name !== UNASSIGNED && <Avatar name={p.name} />}{p.name}</span></td>
                      <td className="py-xs text-right">{p.holding}</td>
                      <td className={`py-xs text-right ${p.overdue ? 'text-error font-semibold' : ''}`}>{p.overdue}</td>
                      <td className="py-xs text-right">{p.review}</td>
                      <td className="py-xs text-right">{p.done7}</td>
                      <td className="py-xs text-right">{p.kpi.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Card>

          <Card icon="undo" title="Lý do bị trả lại" right={`${stats.reasons.reduce((n, r) => n + r[1], 0)} lượt`}>
            {stats.reasons.length === 0 ? <Empty>Chưa có task nào bị trả lại.</Empty> : (
              <ul className="flex flex-col gap-xs">
                {stats.reasons.map(([reason, n]) => (
                  <li key={reason} className="flex items-center gap-sm text-body-sm">
                    <span className="w-48 shrink-0 truncate" title={reason}>{reason}</span>
                    <span className="flex-1 h-2 rounded bg-surface-container">
                      <span className="block h-2 rounded bg-secondary" style={{ width: `${Math.max(4, (n / maxReason) * 100)}%` }} />
                    </span>
                    <span className="w-6 text-right font-semibold">{n}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>

        <Card className="mt-md" icon="alarm" title="Việc quá hạn" right={`${stats.overdue.length} task`}>
          {stats.overdue.length === 0 ? <Empty>Không có việc quá hạn SLA.</Empty> : (
            <table className="w-full text-body-sm">
              <thead>
                <tr className="text-left text-label-sm text-on-surface-variant">
                  <th className="py-xs font-medium">Task</th>
                  <th className="py-xs font-medium">Sản phẩm</th>
                  <th className="py-xs font-medium">Người làm</th>
                  <th className="py-xs font-medium">Hạn</th>
                  <th className="py-xs font-medium text-right">Trễ</th>
                </tr>
              </thead>
              <tbody>
                {stats.overdue.map(t => (
                  <tr key={t.id} className="border-t border-outline-variant/20">
                    <td className="py-xs"><Link href={`/design-studio?task=${encodeURIComponent(t.taskKey)}`} className="text-secondary hover:underline font-semibold">{t.taskKey}</Link></td>
                    <td className="py-xs max-w-[320px] truncate" title={t.productTitle}>{t.productTitle}</td>
                    <td className="py-xs">{t.assigneeName ?? UNASSIGNED}</td>
                    <td className="py-xs">{new Date(t.dueAt!).toLocaleDateString('en-US')}</td>
                    <td className="py-xs text-right"><Pill tone="bad" icon="error">quá {Math.floor((now - new Date(t.dueAt!).getTime()) / 3.6e6)}h</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </main>
    </div>
  )
}
