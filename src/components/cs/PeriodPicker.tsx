'use client'
import { useState } from 'react'

export type PeriodValue = { from: string; to: string; preset: string }

function vnMonday(now: Date, offsetWeeks: number): Date {
  const vn = new Date(now.getTime() + 7 * 3600_000)
  const dow = (vn.getUTCDay() + 6) % 7
  const monday = Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), vn.getUTCDate() - dow) + offsetWeeks * 7 * 86400_000
  return new Date(monday - 7 * 3600_000)
}

export function presetPeriod(preset: string, now = new Date()): { from: string; to: string } {
  const end = (d: Date) => new Date(d.getTime() - 1)
  if (preset === 'week') { const from = vnMonday(now, 0); return { from: from.toISOString(), to: end(new Date(from.getTime() + 7 * 86400_000)).toISOString() } }
  if (preset === 'last4') { const from = vnMonday(now, -3); return { from: from.toISOString(), to: end(new Date(vnMonday(now, 0).getTime() + 7 * 86400_000)).toISOString() } }
  if (preset === 'month') {
    const vn = new Date(now.getTime() + 7 * 3600_000)
    const from = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth(), 1) - 7 * 3600_000)
    const to = new Date(Date.UTC(vn.getUTCFullYear(), vn.getUTCMonth() + 1, 1) - 7 * 3600_000 - 1)
    return { from: from.toISOString(), to: to.toISOString() }
  }
  const from = vnMonday(now, -3)
  return { from: from.toISOString(), to: end(new Date(vnMonday(now, 0).getTime() + 7 * 86400_000)).toISOString() }
}

const PRESETS = [{ key: 'week', label: 'Tuần này' }, { key: 'last4', label: '4 tuần' }, { key: 'month', label: 'Tháng này' }, { key: 'custom', label: 'Tuỳ chọn' }]

export function PeriodPicker({ value, onChange }: { value: PeriodValue; onChange: (v: PeriodValue) => void }) {
  const [custom, setCustom] = useState({ from: value.from.slice(0, 10), to: value.to.slice(0, 10) })
  return (
    <div className="flex flex-wrap items-center gap-sm">
      <div className="flex gap-xs">
        {PRESETS.map(p => (
          <button key={p.key} onClick={() => p.key === 'custom' ? onChange({ ...value, preset: 'custom' }) : onChange({ ...presetPeriod(p.key), preset: p.key })} className={`rounded-lg px-md py-xs text-label-md ${value.preset === p.key ? 'bg-primary text-on-primary' : 'text-on-surface-variant hover:bg-surface-container'}`}>{p.label}</button>
        ))}
      </div>
      {value.preset === 'custom' && (
        <div className="flex items-center gap-xs text-body-sm">
          <input type="date" value={custom.from} onChange={e => setCustom({ ...custom, from: e.target.value })} className="rounded-lg border border-outline-variant/40 bg-surface px-sm py-xs" />
          <span>→</span>
          <input type="date" value={custom.to} onChange={e => setCustom({ ...custom, to: e.target.value })} className="rounded-lg border border-outline-variant/40 bg-surface px-sm py-xs" />
          <button onClick={() => custom.from && custom.to && onChange({ from: new Date(`${custom.from}T00:00:00+07:00`).toISOString(), to: new Date(`${custom.to}T23:59:59.999+07:00`).toISOString(), preset: 'custom' })} className="rounded-lg border border-outline-variant/40 px-md py-xs text-label-md text-primary">Áp dụng</button>
        </div>
      )}
    </div>
  )
}
