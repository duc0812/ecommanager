'use client'
import { useEffect, useState } from 'react'
import { postJson, requestJson } from './model'
import { ErrorBanner, Icon, Pill, btn, btnPrimary, card } from './ui'
import type { SheetLineStatus, SheetPushPreview, SheetPushResult } from '@/lib/repos/sheet-push'

const STATUS: Record<SheetLineStatus, { label: string; tone: 'ok' | 'warn' | 'bad' | 'idle' }> = {
  WRITTEN: { label: 'Đã ghi', tone: 'ok' },
  ALREADY: { label: 'Đã có sẵn', tone: 'idle' },
  BLOCKED: { label: 'Chưa gửi', tone: 'warn' },
  FAILED: { label: 'Lỗi', tone: 'bad' },
}

/** Confirms, writes and shows line by line what happened: a row in the supplier's sheet cannot be taken back from here. */
export default function SheetPushDialog({ supplierId, orderIds, onClose, onDone }: {
  supplierId: string; orderIds?: string[]; onClose: () => void; onDone: () => void
}) {
  const [preview, setPreview] = useState<SheetPushPreview | null>(null)
  const [result, setResult] = useState<SheetPushResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    let live = true
    const qs = new URLSearchParams({ supplier: supplierId })
    for (const id of orderIds ?? []) qs.append('order', id)
    void requestJson<SheetPushPreview>(`/api/design-studio/handoff/sheet?${qs}`).then(r => {
      if (!live) return
      if (r.ok) setPreview(r.data)
      else setError(r.error)
    })
    return () => { live = false }
  }, [supplierId, orderIds])

  async function send() {
    if (busy) return
    setBusy(true)
    setError('')
    const r = await postJson<SheetPushResult>('/api/design-studio/handoff/sheet', { confirm: true, supplierId, orderIds })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setResult(r.data)
    onDone()
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Ghi đơn vào sheet xưởng" className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-md">
      <div className={`${card} w-full max-w-[560px] max-h-[80vh] overflow-auto p-md flex flex-col gap-sm`}>
        <div className="flex items-center gap-sm">
          <Icon name="table_view" className="text-secondary text-[20px]" />
          <b className="text-body-md text-on-surface">{preview ? `Sản xuất — ${preview.supplierName}` : 'Sản xuất'}</b>
          <button type="button" className={`${btn} ml-auto`} onClick={onClose}><Icon name="close" className="text-[18px]" />Đóng</button>
        </div>
        <ErrorBanner msg={error} />
        {!preview && !error && <span className="text-body-sm text-on-surface-variant">Đang kiểm tra sheet…</span>}
        {preview && !result && (
          <>
            <p className="text-body-sm text-on-surface">
              Ghi <b>{preview.ready} dòng</b> vào tab <b>{preview.tabName}</b>. Dòng đã có trong sheet sẽ được bỏ qua.
            </p>
            {preview.blocked > 0 && <p className="text-label-sm text-amber-900">{preview.blocked} dòng có cảnh báo được giữ lại. Các dòng hợp lệ vẫn được gửi.</p>}
            <div className="overflow-auto">
              <table className="w-full text-label-sm text-left">
                <thead><tr><th>Dòng</th><th>Mã xưởng</th><th>Mã sheet</th><th>Size</th><th>Màu</th><th>Tên in</th><th>Trạng thái</th></tr></thead>
                <tbody>{preview.lines?.map(l => (
                  <tr key={l.lineKey} className={l.blocked ? 'text-amber-900' : ''}>
                    <td className="py-xs font-mono">{l.lineKey}</td><td>{l.supplierSku}</td><td>{l.sku}</td><td className="font-semibold">{l.size}</td><td>{l.color}</td><td>{l.customName || '—'}</td>
                    <td>{l.blocked ? l.message : 'Sẵn sàng gửi'}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
            <p className="text-label-sm text-on-surface-variant">Tool không xoá được dòng đã ghi. Muốn huỷ phải làm việc trực tiếp với xưởng.</p>
            <div className="flex justify-end">
              <button type="button" className={btnPrimary} disabled={busy || preview.ready === 0} onClick={send}>
                <Icon name="table_view" className="text-[16px]" />{busy ? 'Đang ghi…' : 'Xác nhận ghi vào sheet'}
              </button>
            </div>
          </>
        )}
        {result && (
          <>
            <span className="text-body-sm text-on-surface">Tab <b>{result.tabName}</b></span>
            {result.results.length === 0 && <span className="text-body-sm text-on-surface-variant">Không có dòng nào cần ghi.</span>}
            <ul className="flex flex-col gap-xs">
              {result.results.map(r => (
                <li key={`${r.lineKey}-${r.status}`} className="flex items-start gap-sm text-label-sm">
                  <Pill tone={STATUS[r.status].tone}>{STATUS[r.status].label}</Pill>
                  <span className="font-mono font-semibold text-on-surface">{r.lineKey}</span>
                  {r.message && <span className="text-on-surface-variant min-w-0">{r.message}</span>}
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
