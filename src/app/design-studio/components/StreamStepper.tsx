'use client'

import { Fragment } from 'react'
import { STREAMS, type StreamCounts, type StreamId } from './streams'
import { card, Icon } from './ui'

export default function StreamStepper({ counts, active, streams, onSelect }: { counts: StreamCounts; active: StreamId; streams: StreamId[]; onSelect: (id: StreamId) => void }) {
  const shown = STREAMS.filter(s => streams.includes(s.id))
  return (
    <div className={`${card} flex flex-wrap items-center gap-xs px-sm py-xs`}>
      {shown.map((s, i) => {
        const { total, overdue } = counts[s.id]
        const on = s.id === active
        return (
          <Fragment key={s.id}>
            {i > 0 && <Icon name="chevron_right" className="text-outline-variant" />}
            <button
              type="button"
              aria-pressed={on}
              title={`${i + 1}. ${s.title} · ${s.who}`}
              onClick={() => onSelect(s.id)}
              className={`inline-flex items-center gap-xs rounded-lg px-sm py-xs text-label-md font-semibold ${on ? 'bg-secondary/10 text-secondary' : 'text-on-surface-variant hover:bg-surface-container-low'}`}
            >
              <Icon name={s.icon} className="text-[18px]" />
              <span>{s.title}</span>
              {total !== null && <span className="rounded-full bg-surface-container px-sm text-label-sm">{total}</span>}
              {overdue > 0 && <span className="rounded-full bg-error-container px-sm text-label-sm text-on-error-container">{overdue} gấp</span>}
            </button>
          </Fragment>
        )
      })}
    </div>
  )
}
