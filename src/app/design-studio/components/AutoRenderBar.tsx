'use client'
import { useEffect, useRef, useState } from 'react'
import { autoRenderEligibility } from '@/lib/artwork-render-eligibility'
import type { TaskDetail } from './types'
import { requestJson } from './model'
import { Icon, Note, btnPrimary } from './ui'

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

  return (
    <div className="flex flex-col gap-xs rounded-lg border border-outline-variant/20 bg-surface-container-low p-sm">
      <div className="flex items-center gap-sm flex-wrap">
        <button type="button" className={btnPrimary} disabled={!check.ok || busy} onClick={() => void start()}
          title={check.reason ?? 'Dựng file in từ artwork gốc với thông tin khách'} aria-describedby="auto-render-reason">
          <Icon name="auto_awesome" className="text-[16px]" />{busy ? 'Đang xếp hàng…' : 'Tạo file in tự động'}
        </button>
        <span id="auto-render-reason" className="text-label-sm text-on-surface-variant min-w-0">
          {running
            ? (job?.status === 'RUNNING' ? 'Worker đang dựng file in…' : 'Đang chờ worker dựng file in (worker chạy trên máy designer)')
            : check.reason
              ?? `Dựng ${slots[0]} từ artwork gốc${library?.optionLabel ? ` ${library.optionLabel}` : ''} · ${check.fields.join(', ') || 'không có trường custom'}`}
        </span>
      </div>
      {job?.status === 'FAILED' && <Note tone="bad" icon="error">Lần dựng gần nhất lỗi: {job.error ?? 'không rõ'}</Note>}
      {job?.status === 'DONE' && (
        <span className="text-label-sm text-on-surface-variant">
          Đã dựng lúc {job.finishedAt ? new Date(job.finishedAt).toLocaleString('en-US') : '—'} — kiểm tra file rồi gửi duyệt như file làm tay.
        </span>
      )}
      {error && <span role="alert" className="text-label-sm text-error">{error}</span>}
    </div>
  )
}
