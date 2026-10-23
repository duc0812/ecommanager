'use client'
import { URGENCY_LABELS } from '@/lib/cs/labels'

const STYLES: Record<string, string> = {
  URGENT: 'bg-error text-on-error',
  HIGH: 'bg-tertiary-container text-on-tertiary-container',
  NORMAL: 'bg-surface-container-high text-on-surface',
  LOW: 'bg-surface-container text-on-surface-variant',
}

export function UrgencyChip({ urgency }: { urgency: string | null }) {
  if (!urgency) return <span className="inline-block rounded-full border border-dashed border-outline-variant px-sm py-xs text-label-sm text-on-surface-variant">Chưa phân tích</span>
  return (
    <span className={`inline-block rounded-full px-sm py-xs text-label-sm ${STYLES[urgency] ?? STYLES.NORMAL}`}>
      {URGENCY_LABELS[urgency as keyof typeof URGENCY_LABELS] ?? urgency}
    </span>
  )
}

export function fmtDate(value: string | Date | null | undefined, withTime = false): string {
  if (!value) return '—'
  const d = typeof value === 'string' ? new Date(value) : value
  if (Number.isNaN(d.getTime())) return '—'
  const date = d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })
  if (!withTime) return date
  return `${date} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
}

export function hoursLabel(hours: number): string {
  if (hours <= 0) return 'đã trả lời'
  if (hours < 1) return `chưa trả lời ${Math.round(hours * 60)} phút`
  if (hours < 48) return `chưa trả lời ${Math.round(hours)}h`
  return `chưa trả lời ${Math.round(hours / 24)} ngày`
}
