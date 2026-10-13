'use client'
import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import type { ArtworkRow } from './types'
import { requestJson } from './model'
import { ErrorBanner, Icon, btn } from './ui'

export function ConfirmDialog({ title, children, confirmLabel, busy, error, onConfirm, onCancel }: {
  title: string; children: ReactNode; confirmLabel: string; busy: boolean; error: string; onConfirm: () => void; onCancel: () => void
}) {
  const titleId = useId()
  const cancelRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    cancelRef.current?.focus()
    return () => previous?.focus?.()
  }, [])
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape' && !busy) { e.preventDefault(); onCancel() } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onCancel])
  return (
    <div className="fixed inset-0 z-[110] grid place-items-center bg-black/50 p-md" onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}>
      <div role="alertdialog" aria-modal="true" aria-labelledby={titleId}
        className="w-full max-w-md rounded-xl bg-surface-container-lowest shadow-overlay border border-outline-variant/20 p-lg flex flex-col gap-md">
        <h2 id={titleId} className="flex items-center gap-sm text-headline-sm text-on-surface">
          <Icon name="delete" className="text-error text-[22px]" />{title}
        </h2>
        <div className="text-body-sm text-on-surface-variant">{children}</div>
        <ErrorBanner msg={error} />
        <div className="flex justify-end gap-sm">
          <button ref={cancelRef} type="button" className={btn} onClick={onCancel} disabled={busy}>Huỷ bỏ</button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className="inline-flex items-center gap-xs rounded-lg bg-error text-on-error px-md py-xs text-label-sm font-semibold hover:opacity-90 disabled:opacity-40">
            <Icon name="delete" className="text-[18px]" />{busy ? 'Đang xoá…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

export function useArtworkRemove(onRemoved: () => void) {
  const [target, setTarget] = useState<ArtworkRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function ask(a: ArtworkRow) { setTarget(a); setError('') }

  async function confirm() {
    if (!target || busy) return
    setBusy(true); setError('')
    const r = await requestJson(`/api/design-studio/artwork/${encodeURIComponent(target.id)}`, { method: 'DELETE' })
    setBusy(false)
    if (!r.ok) { setError(r.error); return }
    setTarget(null)
    onRemoved()
  }

  const dialog = target ? (
    <ConfirmDialog title={`Xoá file ${target.printArea} v${target.version}?`} confirmLabel="Xoá file" busy={busy} error={error}
      onConfirm={confirm} onCancel={() => { if (!busy) setTarget(null) }}>
      <p><b className="text-on-surface">{target.fileName}</b> sẽ bị gỡ khỏi task và không còn tính là {target.kind === 'MOCKUP' ? 'mockup' : 'file in'} &quot;{target.printArea}&quot;.</p>
      <p className="mt-xs">Bản trên Drive (nếu có) được chuyển sang thư mục con _old của task, xưởng không còn thấy nó trong thư mục chính; số phiên bản v{target.version} sẽ không được dùng lại.</p>
    </ConfirmDialog>
  ) : null

  return { ask, dialog }
}
