'use client'
import { useRef, useState } from 'react'
import type { HandoffState } from './types'
import { postJson, requestJson } from './model'
import { HANDOFF_LABELS } from '@/lib/handoff-shared'
import PgprintsPushModal from '@/components/PgprintsPushModal'
import { Icon, Pill, btn, btnPrimary } from './ui'

export default function HandoffButton({ orderId, state, canHandoff, onChanged, onError }: {
  orderId: string; state: HandoffState; canHandoff: boolean; onChanged: (info: string) => void; onError: (msg: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [modal, setModal] = useState(false)
  const dirty = useRef(false)
  const url = `/api/design-studio/orders/${encodeURIComponent(orderId)}/handoff`

  async function saveCsv() {
    if (busy) return
    setBusy(true)
    const r = await postJson(url, { mode: 'CSV' })
    setBusy(false)
    if (!r.ok) { onError(r.error); return }
    onChanged('Đã lưu chờ xuất CSV — đơn nằm sẵn ở trang CSV Export')
  }

  async function undo() {
    if (busy) return
    setBusy(true)
    const r = await requestJson(url, { method: 'DELETE' })
    setBusy(false)
    if (!r.ok) { onError(r.error); return }
    onChanged('Đã hoàn tác — đơn trở lại chờ chuyển xưởng')
  }

  const viewPush = (
    <button type="button" className={btn} onClick={() => setModal(true)}>
      <Icon name="open_in_new" className="text-[16px]" />Xem đơn PGprints
    </button>
  )
  let body: JSX.Element
  if (state.handedOff?.mode === 'CSV') {
    body = (
      <>
        <Pill tone="ok" icon="inventory">{HANDOFF_LABELS.savedCsv}</Pill>
        {canHandoff && state.canUndo && (
          <button type="button" className={btn} disabled={busy} onClick={undo}>
            <Icon name="undo" className="text-[16px]" />{busy ? 'Đang hoàn tác…' : HANDOFF_LABELS.undo}
          </button>
        )}
      </>
    )
  } else if (state.handedOff) {
    body = <><Pill tone="ok" icon="cloud_done">Đã chuyển supplier qua API</Pill>{canHandoff && viewPush}</>
  } else if (state.push) {
    body = canHandoff ? viewPush : <span className="text-label-sm text-on-surface-variant">Đơn đã gửi PGprints</span>
  } else if (!state.pending) {
    body = (
      <button type="button" className={btnPrimary} disabled title={state.blocked ?? undefined}>
        <Icon name="local_shipping" className="text-[16px]" />{HANDOFF_LABELS.generic}
      </button>
    )
  } else if (!canHandoff) {
    body = (
      <button type="button" className={btnPrimary} disabled title="Cần quyền Admin hoặc CSV Export để chuyển đơn sang xưởng">
        <Icon name="hourglass_top" className="text-[16px]" />{HANDOFF_LABELS.wait}
      </button>
    )
  } else if (state.mode === 'API') {
    body = (
      <button type="button" className={btnPrimary} onClick={() => setModal(true)} title="Xem trước rồi xác nhận gửi đơn sang xưởng qua API">
        <Icon name="cloud_upload" className="text-[16px]" />{HANDOFF_LABELS.api(state.apiName)}
      </button>
    )
  } else {
    body = (
      <button type="button" className={btnPrimary} disabled={busy} onClick={saveCsv} title="Lưu vào hệ thống — đơn sẵn sàng khi xuất CSV cho xưởng">
        <Icon name="inventory" className="text-[16px]" />{busy ? 'Đang lưu…' : HANDOFF_LABELS.csv}
      </button>
    )
  }

  return (
    <>
      {body}
      {modal && (
        <PgprintsPushModal orderId={orderId} onChanged={() => { dirty.current = true }}
          onClose={() => { setModal(false); if (dirty.current) { dirty.current = false; onChanged('') } }} />
      )}
    </>
  )
}
