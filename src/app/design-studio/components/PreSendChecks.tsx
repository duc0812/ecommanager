'use client'
import { useState } from 'react'
import type { HandoffCard } from './types'
import { requestJson } from './model'
import { Icon, btn } from './ui'

/** What must be fixed before the order goes to a supplier: lines costed with an older mapping, print files off the template size. */
export function PreSendChecks({ c, canHandoff, onChanged, onError }: { c: HandoffCard; canHandoff: boolean; onChanged: (info: string) => void; onError: (msg: string) => void }) {
  const [busy, setBusy] = useState(false)
  const remaps = c.lines.filter(l => l.mappingNow && !l.waiting)
  const sizes = c.lines.filter(l => l.wrongSizeAreas.length > 0 && !l.waiting)
  if (remaps.length === 0 && sizes.length === 0) return null

  async function remap() {
    if (busy) return
    setBusy(true)
    const r = await requestJson<{ changed: string[] }>(`/api/design-studio/orders/${encodeURIComponent(c.order.id)}/handoff`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'REMAP' }),
    })
    setBusy(false)
    if (!r.ok) { onError(r.error); return }
    onChanged(r.data.changed.length ? `${c.order.orderNumber}: đã cập nhật xưởng — ${r.data.changed.join('; ')}` : `${c.order.orderNumber}: xưởng đã đúng mapping, không đổi gì`)
  }

  return (
    <div role="alert" className="p-sm rounded-lg border border-error/40 bg-error-container/40 flex flex-col gap-xs text-label-sm">
      <b className="text-on-error-container inline-flex items-center gap-xs"><Icon name="warning" className="text-[16px]" />Kiểm tra trước khi gửi xưởng</b>
      {remaps.map(l => (
        <span key={`m-${l.taskKey}`} className="text-on-surface">
          <span className="font-mono font-semibold">{l.taskKey}</span>: đang ghi <b>{l.line.supplier?.name} {l.line.supplierSku ?? ''}</b>, mapping hiện tại chọn <b>{l.mappingNow!.supplierName} {l.mappingNow!.sku}</b> (đơn vào trước khi đổi mapping)
        </span>
      ))}
      {sizes.map(l => (
        <span key={`s-${l.taskKey}`} className="text-on-surface">
          <span className="font-mono font-semibold">{l.taskKey}</span>: file {l.wrongSizeAreas.join(', ')} sai khổ template — mở task để sửa
        </span>
      ))}
      {remaps.length > 0 && canHandoff && (
        <span>
          <button type="button" className={btn} disabled={busy} onClick={remap} title="Gán lại xưởng cho các dòng theo mapping hiện tại — chỉ được khi đơn chưa chuyển xưởng">
            <Icon name="sync_alt" className="text-[16px]" />{busy ? 'Đang cập nhật…' : 'Cập nhật xưởng theo mapping'}
          </button>
        </span>
      )}
    </div>
  )
}
