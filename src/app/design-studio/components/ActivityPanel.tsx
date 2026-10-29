'use client'
import { useState, type FormEvent } from 'react'
import type { TaskDetail } from './types'
import { postJson, taskUrl } from './model'
import { Avatar, ErrorBanner, Icon, card, field, fmtDateTime } from './ui'

export default function ActivityPanel({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const events = detail.events
  const last = events[events.length - 1]

  async function send(e: FormEvent) {
    e.preventDefault()
    const message = msg.trim()
    if (!message || busy) return
    setBusy(true); setError('')
    const r = await postJson(taskUrl(detail.task.taskKey, '/events'), { message })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setMsg('')
    onChanged()
  }

  return (
    <section aria-label="Trao đổi và lịch sử" className={card}>
      <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}
        className="w-full flex items-center gap-sm h-[52px] px-md text-left text-body-sm font-semibold text-on-surface">
        <Icon name="forum" className="text-[20px] text-on-surface-variant" />Trao đổi &amp; lịch sử
        <span className="inline-flex items-center h-5 px-[7px] rounded-full bg-secondary text-on-secondary text-[11px] font-semibold">{events.length}</span>
        {last && !open && <span className="min-w-0 truncate font-normal text-on-surface-variant">{last.actorName ? `${last.actorName}: ` : ''}{last.message}</span>}
        <Icon name={open ? 'expand_less' : 'expand_more'} className="ml-auto text-[20px] text-on-surface-variant" />
      </button>
      {open && (
        <div className="flex flex-col gap-sm px-md pb-md pt-xs border-t border-outline-variant/40">
          {events.map(ev => {
            const system = ev.type === 'SYSTEM' || !ev.actorName
            return (
              <div key={ev.id} className="flex gap-sm pt-sm text-body-sm">
                {system
                  ? <span className="w-6 h-6 rounded-full bg-surface-container-low grid place-items-center text-on-surface-variant shrink-0"><Icon name="smart_toy" className="text-[15px]" /></span>
                  : <Avatar name={ev.actorName!} size="md" />}
                <span className="min-w-0 flex flex-col">
                  <span className="flex items-baseline gap-sm">
                    <span className="font-semibold">{system ? 'Hệ thống' : ev.actorName}</span>
                    <span className="text-label-sm text-on-surface-variant">{fmtDateTime(ev.createdAt)}</span>
                  </span>
                  <span className="break-words">{ev.message}</span>
                </span>
              </div>
            )
          })}
          {events.length === 0 && <div className="pt-sm text-label-sm text-on-surface-variant">Chưa có hoạt động</div>}
          <ErrorBanner msg={error} onClose={() => setError('')} />
          <form onSubmit={send} className="flex gap-sm items-center">
            <input value={msg} onChange={e => setMsg(e.target.value)} placeholder="Viết ghi chú cho task… (@CS để hỏi khách)" aria-label="Ghi chú mới" autoComplete="off" className={`${field} flex-1`} />
            <button type="submit" disabled={busy || !msg.trim()} aria-label="Gửi ghi chú"
              className="inline-grid place-items-center w-10 h-10 rounded-lg border border-outline-variant bg-surface-container-lowest text-secondary hover:bg-surface-container-low disabled:opacity-40">
              <Icon name="send" className="text-[20px]" />
            </button>
          </form>
        </div>
      )}
    </section>
  )
}
