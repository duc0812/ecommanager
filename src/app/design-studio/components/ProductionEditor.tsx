'use client'
import { useState, type FormEvent } from 'react'
import type { TaskDetail } from './types'
import type { productionEditView } from '@/lib/repos/line-production'
import { requestJson, taskUrl } from './model'
import { ErrorBanner, btn, btnPrimary, card, field, fieldLabel } from './ui'

type EditView = Awaited<ReturnType<typeof productionEditView>>

export default function ProductionEditor({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const [open, setOpen] = useState(false)
  const [view, setView] = useState<EditView | null>(null)
  const [product, setProduct] = useState('')
  const [name, setName] = useState('')
  const [editName, setEditName] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const saved = detail.line.productionEdit
  const url = `${taskUrl(detail.task.taskKey)}/production`
  async function begin() {
    setOpen(true); setBusy(true); setError('')
    const r = await requestJson<EditView>(url)
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setView(r.data); setProduct(r.data.currentProductId ?? '')
    setEditName(r.data.override?.customName !== null && r.data.override?.customName !== undefined)
    setName(r.data.override?.customName ?? ''); setReason('')
  }
  async function save(e: FormEvent) {
    e.preventDefault()
    if (!view || busy) return
    setBusy(true); setError('')
    const r = await requestJson<EditView>(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ supplierProductId: product, customName: editName ? name : null, reason, revision: view.revision }) })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setOpen(false); onChanged()
  }
  if (!detail.me.isLeader && !saved) return null
  return <section className={`${card} p-md flex flex-col gap-sm`} aria-label="Thông tin sản xuất">
    <div className="flex items-center gap-sm">
      <b className="text-body-sm">Thông tin sản xuất</b>
      <span className="text-body-sm">{detail.line.variantTitle} · {detail.line.supplierSku}</span>
      {detail.me.isLeader && !['DONE', 'CANCELLED'].includes(detail.task.status) && <button type="button" onClick={begin} className={`${btn} ml-auto`}>Chỉnh thông tin sản xuất</button>}
    </div>
    {saved && <div className="text-label-sm text-on-surface-variant">Shopify lúc chỉnh: {saved.source.variantTitle} · Sản xuất: {saved.variantTitle} / {saved.supplierSku}{saved.customName !== null ? ` · Tên: ${saved.customName || 'Không tên'}` : ''}<br />{saved.history.at(-1)?.byName}: {saved.history.at(-1)?.reason}</div>}
    {open && <form onSubmit={save} className="flex flex-col gap-sm border-t border-outline-variant/30 pt-sm">
      <ErrorBanner msg={error} />
      {!view && busy && <span>Đang tải size xưởng…</span>}
      {view && <>
        {!view.editable && <p className="text-error text-body-sm">Dòng đã duyệt hoặc chuyển xưởng; mở lại xử lý trước khi chỉnh.</p>}
        <label className={fieldLabel}>Size / mã hàng xưởng
          <select value={product} onChange={e => setProduct(e.target.value)} className={field} disabled={busy || !view.editable}>
            {view.options.map(o => <option key={o.id} value={o.id}>{o.size} · {o.sku}{o.color ? ` · ${o.color}` : ''}</option>)}
          </select>
        </label>
        <label className="text-body-sm flex gap-sm"><input type="checkbox" checked={editName} onChange={e => setEditName(e.target.checked)} disabled={busy || !view.editable} />Cập nhật tên custom theo khách</label>
        {editName && <label className={fieldLabel}>Tên in (để trống khi khách yêu cầu không tên)<input value={name} onChange={e => setName(e.target.value)} maxLength={200} className={field} disabled={busy || !view.editable} /></label>}
        <label className={fieldLabel}>Lý do / xác nhận của khách<textarea required value={reason} onChange={e => setReason(e.target.value)} maxLength={1500} className={`${field} h-auto py-sm`} rows={2} disabled={busy || !view.editable} /></label>
        <p className="text-label-sm text-on-surface-variant">Dữ liệu sản xuất này được giữ khi đồng bộ Shopify và dùng cho file in, mã xưởng và dòng sheet gửi xưởng. Sau khi lưu, kiểm tra lại artwork theo size/tên mới.</p>
      </>}
      <div className="flex justify-end gap-sm"><button type="button" className={btn} disabled={busy} onClick={() => setOpen(false)}>Đóng</button><button type="submit" className={btnPrimary} disabled={busy || !view?.editable || !reason.trim() || !product}>{busy ? 'Đang lưu…' : 'Lưu thông tin sản xuất'}</button></div>
    </form>}
  </section>
}
