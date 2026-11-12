'use client'
import { useState } from 'react'
import type { TaskDetail, TaskStatus } from './types'
import { agentStripState, postJson } from './model'
import { useToast } from './overlay'
import { Icon, Pill, STATUS_META, btnMd, btnPrimaryMd, fmtDate } from './ui'

const LIST_LIMIT = 20

export default function AgentStrip({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const view = detail.agent
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  if (!view) return null

  const state = agentStripState(view, detail.task.status)
  const text = view.status === 'FAILED' ? view.error : view.summary
  const shown = view.affected.slice(0, LIST_LIMIT)
  const more = view.affected.length - shown.length

  async function answer(save: boolean) {
    if (busy || !view) return
    setBusy(true)
    const r = await postJson(`/api/design-agent/jobs/${view.jobId}/library`, { save })
    setBusy(false)
    if (!r.ok) toast.say(r.error, 'bad')
    onChanged()
  }

  return (
    <div className="border-t border-outline-variant/40">
      <div className="flex flex-wrap items-center gap-x-[14px] gap-y-xs px-[20px] py-[10px] bg-surface-container-low text-[13px] leading-[18px]">
        <span className="inline-flex items-center gap-xs text-on-surface">
          <Icon name="smart_toy" className="text-[18px] text-on-surface-variant" /><b>Agent</b>
        </span>
        <Pill tone={state.tone} icon={state.icon}>{state.label}</Pill>
        {text && <span className="text-on-surface-variant">{text}</span>}
        {view.requestedBy && <span className="text-on-surface-variant">{`yêu cầu: ${view.requestedBy}`}</span>}
      </div>

      {view.libraryState === 'ASKED' && (
        <div className="flex flex-col gap-sm px-[20px] py-[10px] bg-surface-container-low border-t border-outline-variant/40 text-body-sm text-on-surface">
          <span className="font-semibold">Lưu bản sửa này vào thư viện?</span>
          {shown.length > 0 && (
            <div className="max-h-60 max-w-3xl overflow-y-auto">
              <table className="w-full text-left text-[13px] leading-[18px]">
                <thead className="sticky top-0 bg-surface-container-low">
                  <tr className="text-label-sm text-on-surface-variant">
                    <th className="py-xs pr-md font-medium">Đơn</th>
                    <th className="py-xs pr-md font-medium">Ngày đặt</th>
                    <th className="py-xs pr-md font-medium">Trạng thái</th>
                    <th className="py-xs font-medium">Xưởng</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(a => (
                    <tr key={a.taskKey} className="border-t border-outline-variant/30">
                      <td className="py-xs pr-md"><b>{a.orderNumber}</b> <span className="font-mono text-on-surface-variant">{a.taskKey}</span></td>
                      <td className="py-xs pr-md">{fmtDate(a.placedAt)}</td>
                      <td className="py-xs pr-md">{a.taskStatus ? STATUS_META[a.taskStatus as TaskStatus]?.label ?? a.taskStatus : 'Chưa có task'}</td>
                      <td className="py-xs">{a.sent ? 'Đã gửi xưởng' : 'Chưa gửi'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {more > 0 && <span className="text-on-surface-variant">{`và ${more} đơn khác`}</span>}
          {view.fulfilledCount > 0 && <span className="text-on-surface-variant">{`${view.fulfilledCount} đơn đã giao, không sửa được`}</span>}
          <div className="flex flex-wrap gap-sm">
            <button type="button" className={btnPrimaryMd} disabled={busy} onClick={() => answer(true)}>{`Lưu thư viện và cập nhật ${view.affected.length} đơn`}</button>
            <button type="button" className={btnMd} disabled={busy} onClick={() => answer(false)}>Chỉ sửa đơn này</button>
          </div>
        </div>
      )}

      {view.libraryState === 'YES' && !view.apply && (
        <div className="px-[20px] py-[10px] bg-surface-container-low border-t border-outline-variant/40 text-body-sm text-on-surface-variant">Sẽ cập nhật sau khi bạn duyệt task này.</div>
      )}
      {view.libraryState === 'YES' && view.apply && (view.apply.status === 'QUEUED' || view.apply.status === 'RUNNING') && (
        <div className="px-[20px] py-[10px] bg-surface-container-low border-t border-outline-variant/40 text-body-sm text-on-surface-variant">Đang cập nhật thư viện và các đơn liên quan…</div>
      )}
      {view.libraryState === 'YES' && view.apply && (view.apply.status === 'NEEDS_OWNER' || view.apply.status === 'FAILED') && (
        <div className="px-[20px] py-[10px] bg-surface-container-low border-t border-outline-variant/40 text-body-sm text-on-surface-variant">
          Cập nhật thư viện chưa xong — cần chủ shop.{view.apply.summary ? ` ${view.apply.summary}` : ''}
        </div>
      )}
      {view.libraryState === 'APPLIED' && (
        <div className="px-[20px] py-[10px] bg-surface-container-low border-t border-outline-variant/40 text-body-sm text-on-surface-variant">{`Đã cập nhật thư viện và ${view.affected.length} đơn.`}</div>
      )}
    </div>
  )
}
