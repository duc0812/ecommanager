'use client'
import { useEffect, useRef, useState } from 'react'
import { autoRenderEligibility } from '@/lib/artwork-render-eligibility'
import type { TaskDetail } from './types'
import { requestJson } from './model'
import { Icon } from './ui'

const POLL_MS = 5000

export default function AutoRenderBar({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const { task, line, library, template, slots, autoRender: job } = detail
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const check = autoRenderEligibility({
    taskStatus: task.status, hasTemplate: !!template, slots, library, personalization: line.personalization, job,
  })
  const running = job?.status === 'QUEUED' || job?.status === 'RUNNING'
  const refresh = useRef(onChanged)
  refresh.current = onChanged

  useEffect(() => {
    if (!running) return
    const t = setInterval(() => refresh.current(), POLL_MS)
    return () => clearInterval(t)
  }, [running])

  if (!library?.entryId && !job) return null

  async function start() {
    if (busy || !check.ok) return
    setBusy(true); setError('')
    const r = await requestJson(`/api/design-studio/tasks/${encodeURIComponent(task.taskKey)}/auto-render`, { method: 'POST' })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    onChanged()
  }

  const failed = job?.status === 'FAILED'
  const status = running
    ? (job?.status === 'RUNNING' ? 'Worker đang dựng file in…' : 'Đang chờ worker dựng file in (worker chạy trên máy designer)')
    : check.reason
      ?? `${slots.length > 1 ? `Dựng ${slots.length} file in` : `Dựng ${slots[0]}`} từ artwork gốc${library?.optionLabel ? ` ${library.optionLabel}` : ''} · ${check.fields.join(', ') || 'không có trường custom'}`
  const doneAt = job?.status === 'DONE' && job.finishedAt ? ` · lần dựng gần nhất ${new Date(job.finishedAt).toLocaleString('en-US')}` : ''

  return (
    <span className="inline-flex items-center gap-xs">
      <button type="button" disabled={!check.ok || busy} onClick={() => void start()} title={`${status}${doneAt}`}
        className="inline-flex items-center gap-xs h-9 px-sm rounded-lg border border-outline-variant bg-surface-container-lowest text-[13px] leading-[18px] font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap">
        <Icon name={running ? 'progress_activity' : 'auto_awesome'} className={`text-[18px] text-secondary ${running ? 'animate-spin' : ''}`} />
        {busy ? 'Đang xếp hàng…' : running ? 'Đang dựng…' : 'Tạo file in tự động'}
      </button>
      {failed && <span role="alert" title={job?.error ?? undefined} className="text-label-sm text-error">lần dựng trước lỗi</span>}
      {error && <span role="alert" title={error} className="text-label-sm text-error max-w-[200px] truncate">{error}</span>}
    </span>
  )
}
