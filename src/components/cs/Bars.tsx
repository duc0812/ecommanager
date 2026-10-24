'use client'

export function Bars({ data, labels, empty = 'Chưa có dữ liệu' }: { data: Record<string, number>; labels?: Record<string, string>; empty?: string }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1])
  if (!entries.length) return <p className="text-body-sm text-on-surface-variant">{empty}</p>
  const max = Math.max(...entries.map(e => e[1]), 1)
  return (
    <div className="space-y-xs">
      {entries.map(([key, value]) => (
        <div key={key} className="flex items-center gap-sm text-body-sm">
          <span className="w-40 shrink-0 truncate text-on-surface-variant" title={labels?.[key] ?? key}>{labels?.[key] ?? key}</span>
          <div className="h-3 flex-1 overflow-hidden rounded-full bg-surface-container">
            <div className="h-3 rounded-full bg-secondary" style={{ width: `${Math.max(4, (value / max) * 100)}%` }} />
          </div>
          <span className="w-8 text-right text-label-sm text-primary">{value}</span>
        </div>
      ))}
    </div>
  )
}

const STAGE_COLORS: Record<string, string> = { DESIGN: '#4b41e1', FULFILLMENT: '#645efb', FACTORY: '#00a472', CARRIER: '#f59e0b', CUSTOMER: '#94a3b8', LISTING: '#c026d3', UNKNOWN: '#cbd5e1' }

export function WeeklyStacked({ weeks, labels }: { weeks: { week: string; byStage: Record<string, number> }[]; labels: Record<string, string> }) {
  if (!weeks.length) return <p className="text-body-sm text-on-surface-variant">Chưa có dữ liệu</p>
  const max = Math.max(...weeks.map(w => Object.values(w.byStage).reduce((a, b) => a + b, 0)), 1)
  const stages = Object.keys(STAGE_COLORS)
  return (
    <div>
      <div className="flex items-end gap-sm" style={{ height: 140 }}>
        {weeks.map(w => {
          const total = Object.values(w.byStage).reduce((a, b) => a + b, 0)
          return (
            <div key={w.week} className="flex flex-1 flex-col items-center gap-xs">
              <div className="flex w-full flex-col-reverse overflow-hidden rounded-md bg-surface-container" style={{ height: 120 }} title={`${w.week}: ${total}`}>
                {stages.map(s => w.byStage[s] ? <div key={s} style={{ height: `${(w.byStage[s] / max) * 100}%`, background: STAGE_COLORS[s] }} title={`${labels[s] ?? s}: ${w.byStage[s]}`} /> : null)}
              </div>
              <span className="text-label-sm text-on-surface-variant">{w.week.slice(5)}</span>
            </div>
          )
        })}
      </div>
      <div className="mt-sm flex flex-wrap gap-md text-label-sm text-on-surface-variant">
        {stages.map(s => <span key={s} className="flex items-center gap-xs"><span className="inline-block h-2 w-3 rounded-sm" style={{ background: STAGE_COLORS[s] }} />{labels[s] ?? s}</span>)}
      </div>
    </div>
  )
}

export function Histogram({ values, labels }: { values: number[]; labels: string[] }) {
  const max = Math.max(...values, 1)
  return (
    <div className="flex items-end gap-sm" style={{ height: 100 }}>
      {values.map((v, i) => (
        <div key={i} className="flex flex-1 flex-col items-center gap-xs">
          <span className="text-label-sm text-primary">{v}</span>
          <div className="w-full rounded-md bg-secondary" style={{ height: `${(v / max) * 70}px` }} />
          <span className="text-label-sm text-on-surface-variant">{labels[i]}</span>
        </div>
      ))}
    </div>
  )
}
