'use client'
import { useState, type FormEvent } from 'react'
import { LINE_FIX_HELP, LINE_FIX_NOTE_MAX, LINE_FIX_NOTE_MIN, LINE_FIX_REASONS, type LineFix, type LineFixReason } from '@/lib/line-fix'
import { Icon, btnMd, btnPrimaryMd, field, fieldLabel } from './ui'

/** The reason and the "Cần sửa ở đâu" a line already at its supplier is reopened with. */
export default function LineFixForm({ busy, onSubmit, onCancel }: { busy: boolean; onSubmit: (fix: LineFix) => void; onCancel: () => void }) {
  const [reason, setReason] = useState<LineFixReason>(LINE_FIX_REASONS[0])
  const [note, setNote] = useState('')
  const length = note.trim().length
  const ok = length >= LINE_FIX_NOTE_MIN && length <= LINE_FIX_NOTE_MAX

  function submit(e: FormEvent) {
    e.preventDefault()
    if (ok && !busy) onSubmit({ reason, note: note.trim() })
  }

  return (
    <form onSubmit={submit} aria-label="Mở lại để sửa" className="flex flex-col gap-sm">
      <label className={fieldLabel}>Lý do
        <select value={reason} onChange={e => setReason(e.target.value as LineFixReason)} className={field}>
          {LINE_FIX_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
        </select>
      </label>
      <label className={fieldLabel}>Cần sửa ở đâu
        <textarea rows={3} required autoFocus maxLength={LINE_FIX_NOTE_MAX} value={note} onChange={e => setNote(e.target.value)}
          placeholder="Vd. chỗ cái dao lệch so với mockup" className={`${field} h-auto py-sm`} />
        <span className="text-on-surface-variant">{length}/{LINE_FIX_NOTE_MAX} ký tự · tối thiểu {LINE_FIX_NOTE_MIN}</span>
      </label>
      <span className="text-label-sm text-on-surface-variant">{LINE_FIX_HELP}</span>
      <div className="flex justify-end gap-sm">
        <button type="button" className={btnMd} disabled={busy} onClick={onCancel}>Huỷ</button>
        <button type="submit" className={btnPrimaryMd} disabled={busy || !ok}>
          <Icon name="edit" className="text-[18px]" />{busy ? 'Đang mở lại…' : 'Mở lại để sửa'}
        </button>
      </div>
    </form>
  )
}
