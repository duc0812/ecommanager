'use client'
import { useState, type FormEvent } from 'react'
import { NO_SKU_PREFIX_MESSAGE, formatWhen, httpsUrl, prefixOf, type CloneStore, type CloneWorkerState } from './types'

export type PasteNotice = {
  error: string
  productUrl?: string
  jobId?: string
  attempt?: { url: string; storeId: string }
}

type Props = {
  ready: boolean
  stores: CloneStore[]
  hasSkuPrefix: boolean
  paused: boolean
  worker: CloneWorkerState | null
  busy: boolean
  notice: PasteNotice | null
  isSuperadmin: boolean
  onSubmit: (url: string, storeId: string, force: boolean) => Promise<boolean>
  onDismiss: () => void
}

function WorkerLine({ worker, paused }: { worker: CloneWorkerState | null; paused: boolean }) {
  if (!worker) return null
  const since = worker.lastSeenAt ? ` từ ${formatWhen(worker.lastSeenAt)}` : ''
  return (
    <div className="flex flex-wrap items-center gap-md border-t border-outline-variant/20 px-lg py-md text-body-sm text-on-surface-variant">
      <span className="inline-flex items-center gap-sm">
        <span aria-hidden className={`h-2 w-2 rounded-full ${worker.online ? 'bg-on-tertiary-container' : 'bg-error'}`} />
        {worker.online ? 'Máy xử lý đang kết nối' : `Máy xử lý đang tắt${since} — link sẽ chạy khi máy bật`}
      </span>
      {paused && <span className="rounded-full bg-error/10 px-sm py-xs text-label-sm text-error">Hàng chờ đang tạm dừng</span>}
    </div>
  )
}

export function CloneForm({ ready, stores, hasSkuPrefix, paused, worker, busy, notice, isSuperadmin, onSubmit, onDismiss }: Props) {
  const [url, setUrl] = useState('')
  const [storeId, setStoreId] = useState('')
  const chosen = stores.some(s => s.id === storeId) ? storeId : stores[0]?.id ?? ''
  const locked = !ready || !hasSkuPrefix || stores.length === 0
  const canSubmit = !locked && !busy && url.trim() !== ''
  const productHref = httpsUrl(notice?.productUrl)

  async function send(e: FormEvent) {
    e.preventDefault()
    if (canSubmit && (await onSubmit(url.trim(), chosen, false))) setUrl('')
  }

  async function forceAgain() {
    const attempt = notice?.attempt
    if (!attempt || busy) return
    if ((await onSubmit(attempt.url, attempt.storeId, true)) && url.trim() === attempt.url) setUrl('')
  }

  const field = 'rounded-lg border border-outline-variant/40 bg-surface px-md py-sm text-body-sm disabled:opacity-50'

  return (
    <section className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="flex items-center gap-sm px-lg py-md border-b border-outline-variant/20">
        <span className="material-symbols-outlined text-secondary">content_copy</span>
        <h3 className="text-headline-sm text-primary">Dán link sản phẩm</h3>
      </div>
      <form onSubmit={send} className="p-lg">
        <div className="flex flex-wrap items-end gap-md">
          <label className="min-w-[260px] flex-1 text-label-sm text-on-surface-variant">Link sản phẩm cần clone
            <input value={url} onChange={e => setUrl(e.target.value)} disabled={locked} inputMode="url" autoComplete="off" spellCheck={false}
              placeholder="https://…" className={`mt-xs w-full ${field}`} />
          </label>
          {stores.length > 1 && (
            <label className="text-label-sm text-on-surface-variant">Store
              <select value={chosen} onChange={e => setStoreId(e.target.value)} disabled={locked} className={`mt-xs block ${field}`}>
                {stores.map(s => <option key={s.id} value={s.id}>{prefixOf(s)} · {s.shop}</option>)}
              </select>
            </label>
          )}
          <button type="submit" disabled={!canSubmit} className="bg-secondary text-on-secondary px-lg py-sm rounded-lg text-label-md disabled:opacity-50">
            {busy ? 'Đang gửi…' : 'Clone'}
          </button>
        </div>
        {ready && !hasSkuPrefix && <p className="mt-sm text-body-sm text-error">{NO_SKU_PREFIX_MESSAGE}</p>}
        {ready && hasSkuPrefix && stores.length === 0 && <p className="mt-sm text-body-sm text-error">Chưa có store nào có tiền tố đơn để clone.</p>}
        {notice && (
          <div role="alert" className="mt-md flex flex-wrap items-center gap-md rounded-lg border border-error/30 bg-error/5 px-md py-sm text-body-sm text-error">
            <span className="material-symbols-outlined text-[18px]">error</span>
            <span className="break-words">{notice.error}</span>
            {productHref && <a href={productHref} target="_blank" rel="noopener noreferrer" className="text-label-md text-secondary hover:underline">Mở sản phẩm đang có</a>}
            {notice.productUrl && !productHref && <span className="max-w-[320px] truncate" title={notice.productUrl}>{notice.productUrl}</span>}
            {isSuperadmin && notice.attempt && (
              <button type="button" disabled={busy} onClick={forceAgain} className="text-label-md text-secondary hover:underline disabled:opacity-50">Vẫn clone lại</button>
            )}
            <button type="button" onClick={onDismiss} aria-label="Đóng thông báo" className="ml-auto text-on-surface-variant hover:text-primary">
              <span className="material-symbols-outlined text-[18px]">close</span>
            </button>
          </div>
        )}
      </form>
      <WorkerLine worker={worker} paused={paused} />
    </section>
  )
}
