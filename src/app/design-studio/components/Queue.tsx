'use client'
import { useState } from 'react'
import type { Readiness, TaskRow, TaskStatus } from './types'
import { timeLeft } from './model'
import { Avatar, ErrorBanner, Icon, Note, Pill, READY_META, TEXT_TONE, btn, card } from './ui'

export type QueueFilter = 'ALL' | Readiness

const SECTIONS: { title: string; statuses: TaskStatus[]; tone?: string }[] = [
  { title: 'Bị trả lại — sửa trước', statuses: ['REJECTED'], tone: 'text-error' },
  { title: 'Đang hỏi khách', statuses: ['ASK_CUSTOMER'], tone: 'text-amber-900' },
  { title: 'Mới / Đã giao', statuses: ['NEW', 'ASSIGNED'] },
  { title: 'Đang làm', statuses: ['DOING'] },
  { title: 'Chờ duyệt', statuses: ['REVIEW'] },
  { title: 'Xong hôm nay', statuses: ['DONE'] },
]

// A search reaches every task, so finished ones are not only today's and cancelled ones show too.
const SEARCH_SECTIONS: { title: string; statuses: TaskStatus[]; tone?: string }[] = [
  ...SECTIONS.slice(0, -1),
  { title: 'Đã duyệt', statuses: ['DONE'] },
  { title: 'Đã huỷ', statuses: ['CANCELLED'] },
]

export function byDue(a: TaskRow, b: TaskRow): number {
  if (a.dueAt === b.dueAt) return 0
  if (a.dueAt === null) return 1
  if (b.dueAt === null) return -1
  return a.dueAt < b.dueAt ? -1 : 1
}

function QueueRow({ t, selected, onSelect }: { t: TaskRow; selected: boolean; onSelect: (key: string) => void }) {
  const left = timeLeft(t)
  const ready = READY_META[t.readiness]
  return (
    <button type="button" onClick={() => onSelect(t.taskKey)} aria-current={selected ? 'true' : undefined}
      className={`flex gap-sm p-sm mx-xs rounded-lg text-left ${selected ? 'bg-secondary/10 ring-1 ring-inset ring-secondary/40' : 'hover:bg-surface-container-low'}`}>
      <span className="w-10 h-10 rounded-lg bg-surface-container-high overflow-hidden grid place-items-center text-on-surface-variant shrink-0">
        {(t.previewUrl ?? t.imageUrl)
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={(t.previewUrl ?? t.imageUrl)!} alt="" className="w-full h-full object-cover" loading="lazy" />
          : <Icon name={t.customized ? 'image' : 'checkroom'} className="text-[20px]" />}
      </span>
      <span className="flex-1 min-w-0 flex flex-col gap-[2px]">
        <span className="flex items-center gap-xs">
          <span className="font-mono text-label-sm font-medium text-on-surface">{t.taskKey}</span>
          <span className={`ml-auto inline-flex items-center gap-[2px] text-label-sm whitespace-nowrap ${left.tone === 'idle' ? 'text-on-surface-variant' : `${TEXT_TONE[left.tone]} font-semibold`}`}>
            {left.label}
          </span>
        </span>
        <span className="text-label-sm text-on-surface-variant truncate">{t.productTitle}{t.variantTitle ? ` · ${t.variantTitle}` : ''}</span>
        <span className="flex items-center gap-xs">
          <Pill tone={ready.tone} icon={ready.icon}>{ready.label}</Pill>
          {t.assigneeName && <span className="ml-auto"><Avatar name={t.assigneeName} /></span>}
        </span>
      </span>
    </button>
  )
}

export default function Queue({ tasks, sel, onSelect, q, onQ, loading, error, retrying, emptyText, onClearFilters, filter, onFilter, counts, mine, onMine }: {
  tasks: TaskRow[]; sel: string | null; onSelect: (key: string) => void
  q: string; onQ: (v: string) => void; loading: boolean; error: string; retrying: boolean
  emptyText: string; onClearFilters: (() => void) | null
  filter: QueueFilter; onFilter: (f: QueueFilter) => void; counts: Record<QueueFilter, number>
  mine: boolean; onMine: (v: boolean) => void
}) {
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const groups = (q.trim() ? SEARCH_SECTIONS : SECTIONS).map(s => ({ ...s, rows: tasks.filter(t => s.statuses.includes(t.status)).sort(byDue) })).filter(g => g.rows.length > 0)
  const chipCls = (on: boolean) => `inline-flex items-center gap-xs h-7 px-sm rounded-full border text-label-sm ${on ? 'bg-secondary/10 text-secondary border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant text-on-surface-variant'}`
  return (
    <aside aria-label="Hàng đợi task" className={`${card} sticky top-md max-h-[calc(100vh-2rem)] overflow-auto flex flex-col pb-md`}>
      <div className="p-sm flex flex-col gap-sm sticky top-0 bg-surface-container-lowest z-10 border-b border-outline-variant/20">
        <div className="flex items-center gap-sm">
          <label className="flex-1 min-w-0 flex items-center gap-xs h-9 px-sm rounded-lg bg-surface-container-low text-on-surface-variant">
            <Icon name="search" className="text-[18px]" />
            <input value={q} onChange={e => onQ(e.target.value)} placeholder="Task ID, SKU, tên in…" aria-label="Tìm task"
              className="flex-1 min-w-0 bg-transparent text-[13px] text-on-surface outline-none" />
            {loading && <Icon name="progress_activity" className="text-[16px] animate-spin" />}
          </label>
          <button type="button" aria-pressed={mine} onClick={() => onMine(!mine)}
            className={`h-9 px-sm rounded-lg border text-label-sm whitespace-nowrap ${mine ? 'bg-secondary/10 text-secondary border-transparent font-semibold' : 'border-outline-variant bg-surface-container-lowest text-on-surface'}`}>
            Của tôi
          </button>
        </div>
        <div className="flex flex-wrap gap-xs">
          {(['ALL', 'AUTO', 'LOW', 'MANUAL'] as QueueFilter[]).map(f => (
            <button key={f} type="button" aria-pressed={filter === f} onClick={() => onFilter(f)} className={chipCls(filter === f)}>
              {f === 'ALL' ? 'Tất cả' : READY_META[f].label}<span className="opacity-75 font-normal">{counts[f]}</span>
            </button>
          ))}
        </div>
        {retrying
          ? <div role="status"><Note tone="warn" icon="cloud_off">Mất kết nối tới máy chủ — đang thử lại…</Note></div>
          : <ErrorBanner msg={error} />}
      </div>
      <div className="flex flex-col gap-[2px]">
        {groups.map(g => {
          const open = !closed[g.title]
          return (
            <div key={g.title} className="flex flex-col gap-[2px]">
              <button type="button" aria-expanded={open} onClick={() => setClosed({ ...closed, [g.title]: open })}
                className="flex items-center gap-xs mx-sm mt-sm mb-[2px] px-xs py-xs text-label-sm font-semibold text-on-surface-variant text-left">
                <Icon name={open ? 'expand_more' : 'chevron_right'} className="text-[18px]" />
                <span className={g.tone ?? ''}>{g.title}</span>
                <span className="font-medium">({g.rows.length})</span>
              </button>
              {open && g.rows.map(t => <QueueRow key={t.taskKey} t={t} selected={t.taskKey === sel} onSelect={onSelect} />)}
            </div>
          )
        })}
        {groups.length === 0 && !loading && !error && !retrying && (
          <div className="px-md py-md flex flex-col items-start gap-sm text-label-sm text-on-surface-variant">
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
