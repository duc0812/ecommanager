'use client'
import type { TaskRow, TaskStatus } from './types'
import { timeLeft } from './model'
import { Avatar, ErrorBanner, Icon, Note, Pill, READY_META, STATUS_META, TEXT_TONE, btn, card } from './ui'

const SECTIONS: { title: string; statuses: TaskStatus[] }[] = [
  { title: 'Bị trả lại — sửa trước', statuses: ['REJECTED'] },
  { title: 'Đang hỏi khách', statuses: ['ASK_CUSTOMER'] },
  { title: 'Mới / Đã giao', statuses: ['NEW', 'ASSIGNED'] },
  { title: 'Đang làm', statuses: ['DOING'] },
  { title: 'Chờ duyệt', statuses: ['REVIEW'] },
  { title: 'Xong hôm nay', statuses: ['DONE'] },
]

function byDue(a: TaskRow, b: TaskRow): number {
  if (a.dueAt === b.dueAt) return 0
  if (a.dueAt === null) return 1
  if (b.dueAt === null) return -1
  return a.dueAt < b.dueAt ? -1 : 1
}

function QueueRow({ t, selected, onSelect }: { t: TaskRow; selected: boolean; onSelect: (key: string) => void }) {
  const left = timeLeft(t)
  const ready = READY_META[t.readiness]
  const status = STATUS_META[t.status]
  return (
    <button type="button" onClick={() => onSelect(t.taskKey)} aria-current={selected ? 'true' : undefined}
      className={`grid grid-cols-[44px_minmax(0,1fr)] gap-sm p-sm rounded-lg border text-left w-full ${selected ? 'bg-secondary/10 border-secondary/40' : 'border-transparent hover:bg-surface-container-low'}`}>
      <span className="w-11 h-11 rounded-md bg-surface-container-high border border-outline-variant/20 overflow-hidden grid place-items-center text-on-surface-variant">
        {(t.previewUrl ?? t.imageUrl)
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={(t.previewUrl ?? t.imageUrl)!} alt="" className="w-full h-full object-cover" loading="lazy" />
          : <Icon name={t.customized ? 'image' : 'checkroom'} />}
      </span>
      <span className="flex flex-col gap-[2px] min-w-0">
        <span className="flex items-center gap-xs">
          <span className="font-mono font-semibold text-label-sm text-on-surface">{t.taskKey}</span>
          <span className={`ml-auto inline-flex items-center gap-[2px] text-label-sm font-semibold whitespace-nowrap ${left.tone === 'idle' ? 'text-on-surface-variant' : TEXT_TONE[left.tone]}`}>
            <Icon name={left.icon} className="text-[13px]" />{left.label}
          </span>
        </span>
        <span className="text-label-sm text-on-surface-variant truncate">{t.productTitle}{t.variantTitle ? ` · ${t.variantTitle}` : ''}</span>
        <span className="flex items-center gap-xs flex-wrap">
          <Pill tone={ready.tone} icon={ready.icon}>{ready.label}</Pill>
          <Pill tone={status.tone}>{status.label}</Pill>
          {t.assigneeName && <span className="ml-auto"><Avatar name={t.assigneeName} /></span>}
        </span>
      </span>
    </button>
  )
}

export default function Queue({ tasks, sel, onSelect, q, onQ, loading, error, retrying, emptyText, onClearFilters }: {
  tasks: TaskRow[]; sel: string | null; onSelect: (key: string) => void
  q: string; onQ: (v: string) => void; loading: boolean; error: string; retrying: boolean
  emptyText: string; onClearFilters: (() => void) | null
}) {
  const groups = SECTIONS.map(s => ({ ...s, rows: tasks.filter(t => s.statuses.includes(t.status)).sort(byDue) })).filter(g => g.rows.length > 0)
  return (
    <aside className={`${card} sticky top-md max-h-[calc(100vh-2rem)] overflow-auto flex flex-col`}>
      <div className="p-sm border-b border-outline-variant/20 flex flex-col gap-sm sticky top-0 bg-surface-container-lowest z-10">
        <label className="flex items-center gap-xs rounded-lg border border-outline-variant/20 bg-surface-container-low px-sm">
          <Icon name="search" className="text-on-surface-variant text-[18px]" />
          <input value={q} onChange={e => onQ(e.target.value)} placeholder="Tìm task ID, SKU, tên in…" aria-label="Tìm task"
            className="flex-1 min-w-0 bg-transparent py-xs text-body-sm outline-none" />
          {loading && <Icon name="progress_activity" className="text-on-surface-variant text-[16px] animate-spin" />}
        </label>
        {retrying
          ? <div role="status"><Note tone="warn" icon="cloud_off">Mất kết nối tới máy chủ — đang thử lại…</Note></div>
          : <ErrorBanner msg={error} />}
      </div>
      <div className="p-xs flex flex-col gap-xs">
        {groups.map(g => (
          <div key={g.title} className="flex flex-col gap-xs">
            <div className="flex justify-between px-sm pt-sm text-label-sm uppercase tracking-wider text-on-surface-variant">
              <span>{g.title}</span><span>{g.rows.length}</span>
            </div>
            {g.rows.map(t => <QueueRow key={t.taskKey} t={t} selected={t.taskKey === sel} onSelect={onSelect} />)}
          </div>
        ))}
        {groups.length === 0 && !loading && !error && !retrying && (
          <div className="px-sm py-md flex flex-col items-start gap-sm text-label-sm text-on-surface-variant">
            <span>{emptyText}</span>
            {onClearFilters && (
              <button type="button" onClick={onClearFilters} className={btn}><Icon name="filter_alt_off" className="text-[16px]" />Bỏ lọc</button>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
