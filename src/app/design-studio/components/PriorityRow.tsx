'use client'

import type { Tone } from './model'
import type { Readiness } from './types'
import type { PriorityGroupDef, SecondaryFilter, StreamDef } from './streams'
import { card, chip, Icon, READY_META, TEXT_TONE } from './ui'

const TONE_ICON: Record<Tone, string> = { bad: 'local_fire_department', warn: 'schedule', idle: 'check_circle', ok: 'check_circle', brand: 'check_circle' }

const CHIP_TONE: Record<Tone, string> = {
  bad: 'bg-error-container text-on-error-container',
  warn: 'bg-amber-100 text-amber-900',
  idle: 'bg-surface-container-low text-on-surface-variant',
  ok: 'bg-tertiary/15 text-tertiary',
  brand: 'bg-secondary/10 text-secondary',
}

const READINESS: Readiness[] = ['AUTO', 'LOW', 'MANUAL']

export function GroupHeader({ def, count }: { def: PriorityGroupDef<any>; count: number }) {
  return (
    <div className={`flex items-center gap-sm text-label-md font-semibold ${TEXT_TONE[def.tone]}`}>
      <Icon name={TONE_ICON[def.tone]} className="text-[18px]" />
      <span>{def.title}</span>
      <span className="rounded-full bg-surface-container px-sm text-label-sm">{count}</span>
    </div>
  )
}

type Secondary = {
  filter: SecondaryFilter; onFilter: (f: SecondaryFilter) => void; autoLabel: string
  counts: Record<SecondaryFilter, number>
  /** The chips this stream offers (`secondaryFiltersOf`); "Của tôi" is always there. */
  filters: SecondaryFilter[]
  mine: boolean; onMine: () => void
}

export default function PriorityRow({ stream, total, unit, groups, group, onGroup, secondary, titleOnly }: {
  stream: StreamDef
  total: number
  unit: 'task' | 'đơn'
  groups: { def: PriorityGroupDef<any>; count: number }[]
  group: string | null
  onGroup: (id: string | null) => void
  secondary: Secondary | null
  titleOnly?: boolean
}) {
  const groupChip = ({ def, count }: { def: PriorityGroupDef<any>; count: number }) => (
    <button
      key={def.id}
      type="button"
      aria-pressed={group === def.id}
      title={def.sub}
      onClick={() => onGroup(group === def.id ? null : def.id)}
      className={`inline-flex items-center gap-xs rounded-full px-md py-xs text-label-sm font-semibold ${CHIP_TONE[def.tone]} ${count === 0 ? 'opacity-50' : ''} ${group === def.id ? 'ring-2 ring-secondary' : ''}`}
    >
      <Icon name={def.extra ? 'history' : TONE_ICON[def.tone]} className="text-[14px]" />
      {def.title}
      <span className="rounded-full bg-surface-container-lowest px-sm text-on-surface">{count}</span>
    </button>
  )
  return (
    <section className={card}>
      <div className={`flex items-center gap-sm px-lg py-sm ${titleOnly ? '' : 'border-b border-outline-variant/20'}`}>
        <Icon name={stream.icon} className="text-on-surface-variant text-[20px]" />
        <span className="text-body-md font-semibold text-on-surface">{stream.title}</span>
        <span className="text-label-sm text-on-surface-variant">
          {titleOnly ? stream.who : `${stream.who} · ${total} ${unit}${stream.id === 'FILE' ? ' chưa duyệt' : ''} · nhóm ưu tiên từ trái sang phải, bấm để lọc`}
        </span>
        {secondary && !titleOnly && (
          <div className="ml-auto flex flex-wrap items-center gap-xs">
            <span className="text-label-sm text-on-surface-variant">Lọc thêm:</span>
            {READINESS.filter(r => secondary.filters.includes(r)).map(r => (
              <button
                key={r}
                type="button"
                aria-pressed={secondary.filter === r}
                className={chip(secondary.filter === r)}
                onClick={() => secondary.onFilter(secondary.filter === r ? 'ALL' : r)}
              >
                <Icon name={READY_META[r].icon} className="text-[14px]" />{r === 'AUTO' ? secondary.autoLabel : READY_META[r].label}
                <span className="rounded-full bg-surface-container-lowest px-sm text-on-surface">{secondary.counts[r]}</span>
              </button>
            ))}
            {secondary.filters.includes('NEEDS_ARTWORK') && (
              <button
                type="button"
                aria-pressed={secondary.filter === 'NEEDS_ARTWORK'}
                className={chip(secondary.filter === 'NEEDS_ARTWORK')}
                onClick={() => secondary.onFilter(secondary.filter === 'NEEDS_ARTWORK' ? 'ALL' : 'NEEDS_ARTWORK')}
              >
                <Icon name="brush" className="text-[14px]" />Cần làm artwork
                <span className="rounded-full bg-surface-container-lowest px-sm text-on-surface">{secondary.counts.NEEDS_ARTWORK}</span>
              </button>
            )}
            <button type="button" aria-pressed={secondary.mine} className={chip(secondary.mine)} onClick={secondary.onMine}>
              <Icon name="person" className="text-[14px]" />Của tôi
            </button>
          </div>
        )}
      </div>
      {!titleOnly && (
        <div className="flex flex-wrap items-center gap-xs px-lg py-sm">
          <button
            type="button"
            aria-pressed={group === null}
            onClick={() => onGroup(null)}
            className={`inline-flex items-center gap-xs rounded-full px-md py-xs text-label-sm font-semibold bg-surface-container text-on-surface ${group === null ? 'ring-2 ring-secondary' : ''}`}
          >
            Tất cả <span className="rounded-full bg-surface-container-lowest px-sm">{total}</span>
          </button>
          {groups.filter(g => !g.def.extra).map(groupChip)}
          {groups.some(g => g.def.extra) && (
            <div role="group" aria-label="Lịch sử" className="ml-auto flex items-center gap-xs border-l border-outline-variant/40 pl-sm">
              <span className="text-label-sm text-on-surface-variant">Lịch sử</span>
              {groups.filter(g => g.def.extra).map(groupChip)}
            </div>
          )}
        </div>
      )}
    </section>
  )
}
