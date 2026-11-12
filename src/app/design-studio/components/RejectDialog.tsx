'use client'
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { OTHER_REASON_LABEL, OTHER_REASON_MAX, otherReasonError, rejectSelection } from '@/lib/reject-reasons'
import { PopoverHead } from './overlay'
import { Icon, btnMd, btnPrimaryMd, field, fieldLabel, popover } from './ui'

const chipClass = (on: boolean) =>
  `inline-flex items-center gap-xs h-8 px-sm rounded-full border text-label-sm ${on ? 'bg-secondary/10 border-secondary text-secondary font-semibold' : 'bg-surface-container-lowest border-outline-variant text-on-surface'}`

export default function RejectDialog({ reasons, busy, note, onNoteChange, onCancel, onSubmit }: {
  reasons: string[]; busy: boolean; note: string; onNoteChange: (note: string) => void
  onCancel: () => void; onSubmit: (reasons: string[], note: string) => void
}) {
  const [picked, setPicked] = useState<string[]>([])
  const [otherOn, setOtherOn] = useState(false)
  const [otherText, setOtherText] = useState('')
  const [otherTouched, setOtherTouched] = useState(false)
  const noteRef = useRef<HTMLTextAreaElement>(null)
  const selection = rejectSelection(picked, otherOn, otherText)
  const count = picked.length + (otherOn ? 1 : 0)
  const otherError = otherReasonError(otherOn, otherText, otherTouched)

  function submit(e: FormEvent) {
    e.preventDefault()
    setOtherTouched(true)
    if (selection.error) return
    onSubmit(selection.reasons, note.trim())
  }

  function otherKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    noteRef.current?.focus()
  }

  return (
    <form role="dialog" aria-label="Trả lại sửa" onSubmit={submit} className={`${popover} top-12 right-12 w-[400px] p-md flex flex-col gap-sm`}>
      <PopoverHead title="Trả lại sửa" onClose={onCancel} />
      <div className="flex flex-col gap-xs">
        <span className="text-label-sm text-on-surface-variant">Lý do (chọn nhiều)</span>
        <div className="flex flex-wrap gap-xs">
          {reasons.map(r => {
            const on = picked.includes(r)
            return (
              <button key={r} type="button" aria-pressed={on} onClick={() => setPicked(on ? picked.filter(x => x !== r) : [...picked, r])} className={chipClass(on)}>
                {on && <Icon name="check" className="text-[16px]" />}{r}
              </button>
            )
          })}
          <button type="button" aria-pressed={otherOn} onClick={() => setOtherOn(!otherOn)} className={chipClass(otherOn)}>
            {otherOn && <Icon name="check" className="text-[16px]" />}{OTHER_REASON_LABEL}
          </button>
        </div>
        {otherOn && (
          <>
            <input autoFocus value={otherText} onChange={e => { setOtherText(e.target.value); setOtherTouched(true) }} onKeyDown={otherKey} maxLength={OTHER_REASON_MAX} aria-label="Lý do khác"
              placeholder="Vd. sao trên mũ bị lệch" className={field} />
            {otherError && <span className="text-label-sm text-error">{otherError}</span>}
          </>
        )}
      </div>
      <label className={fieldLabel}>Ghi chú cho designer
        <textarea ref={noteRef} rows={3} value={note} onChange={e => onNoteChange(e.target.value)} placeholder="Vd. tên đang là Emely, khách nhập Emily" className={`${field} h-auto py-sm`} />
      </label>
      <div className="flex justify-end gap-sm">
        <button type="button" className={btnMd} onClick={onCancel}>Huỷ</button>
        <button type="submit" className={btnPrimaryMd} disabled={busy || !!selection.error}>Trả lại · {count} lý do</button>
      </div>
    </form>
  )
}
