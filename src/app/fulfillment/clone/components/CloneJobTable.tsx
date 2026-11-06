'use client'
import {
  FAIL_KIND_LABEL, STATUS_LABEL, canCancel, canRetry, formatDuration, formatWhen, httpsUrl, leftoverProductId, prefixOf, retryQuestion, showsReused,
  visibleStage,
  type CloneJobView, type CloneStatus, type CloneStore, type Viewer,
} from './types'

type Props = {
  jobs: CloneJobView[]
  stores: CloneStore[]
  viewer: Viewer
  highlightId: string | null
  acting: string | null
  onCancel: (job: CloneJobView) => void
  onRetry: (job: CloneJobView) => void
}

const STATUS_STYLE: Record<CloneStatus, string> = {
  QUEUED: 'bg-surface-container-high text-on-surface-variant',
  RUNNING: 'bg-secondary/10 text-secondary',
  DONE: 'bg-primary/10 text-primary',
  FAILED: 'bg-error/10 text-error',
  CANCELLED: 'bg-surface-container-high text-on-surface-variant',
}

const th = 'px-md py-sm font-medium whitespace-nowrap'
const td = 'px-md py-sm align-top'
const muted = 'text-on-surface-variant'

function SourceCell({ url }: { url: string }) {
  const href = httpsUrl(url)
  if (!href) return <span title={url} className="block max-w-[260px] truncate">{url}</span>
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" title={url} className="block max-w-[260px] truncate text-secondary hover:underline">
      {url.replace(/^https:\/\//i, '')}
    </a>
  )
}

function ProductCell({ job, viewer }: { job: CloneJobView; viewer: Viewer }) {
  const value = job.status === 'DONE' ? job.productUrl : null
  const href = httpsUrl(value)
  const reused = showsReused(job)
  const leftover = leftoverProductId(job, viewer)
  if (!value && !reused && !leftover) return <span className={muted}>—</span>
  return (
    <div className="flex flex-col gap-xs">
      {href && (
        <a href={href} target="_blank" rel="noopener noreferrer" title={href} className="inline-flex items-center gap-xs text-secondary hover:underline">
          Mở sản phẩm <span className="material-symbols-outlined text-[16px]">open_in_new</span>
        </a>
      )}
      {value && !href && <span title={value} className="block max-w-[200px] truncate">{value}</span>}
      {reused && <span className="text-label-sm text-on-surface-variant">Đã có sẵn</span>}
      {leftover && <span className="text-label-sm text-on-surface-variant">Còn sản phẩm trên store: {leftover}</span>}
    </div>
  )
}

function ErrorCell({ job }: { job: CloneJobView }) {
  const kind = job.failKind ? FAIL_KIND_LABEL[job.failKind] ?? job.failKind : null
  if (!kind && !job.error && job.status !== 'FAILED') return <span className={muted}>—</span>
  return (
    <div className="max-w-[280px] break-words">
      <p className="text-error">{kind ?? 'Lỗi'}</p>
      {job.error && <p className={`mt-xs line-clamp-3 ${muted}`} title={job.error}>{job.error}</p>}
    </div>
  )
}

export function CloneJobTable({ jobs, stores, viewer, highlightId, acting, onCancel, onRetry }: Props) {
  const storeById = new Map(stores.map(s => [s.id, s]))
  const showRequester = viewer.role !== null && viewer.role !== 'SELLER'
  const retry = (job: CloneJobView) => {
    const question = retryQuestion(job, viewer)
    if (question && !window.confirm(question)) return
    onRetry(job)
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <table className="w-full min-w-[980px] text-left text-body-sm">
        <thead className="border-b border-outline-variant/20 text-label-sm uppercase tracking-wider text-on-surface-variant">
          <tr>
            <th className={th}>Thời gian</th>
            <th className={th}>Store</th>
            <th className={th}>Link nguồn</th>
            <th className={th}>Trạng thái</th>
            <th className={th}>Mã SKU</th>
            <th className={th}>Sản phẩm</th>
            <th className={th}>Lỗi</th>
            {viewer.superadmin && <th className={th}>Chi phí</th>}
            {viewer.superadmin && <th className={th}>Thời gian chạy</th>}
            {viewer.superadmin && <th className={th}>Product type</th>}
            <th className={th}><span className="sr-only">Thao tác</span></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-outline-variant/20">
          {jobs.map(job => {
            const store = storeById.get(job.storeId)
            const busy = acting === job.id
            const stage = visibleStage(job)
            return (
              <tr key={job.id} id={`clone-job-${job.id}`} className={job.id === highlightId ? 'bg-secondary/10 ring-2 ring-inset ring-secondary' : undefined}>
                <td className={`${td} whitespace-nowrap`}>
                  {formatWhen(job.createdAt)}
                  {showRequester && <p className={`mt-xs max-w-[180px] truncate text-label-sm ${muted}`} title={job.requestedByName}>Người dán: {job.requestedByName}</p>}
                </td>
                <td className={td} title={store?.shop}>{store ? prefixOf(store) ?? store.shop : '—'}</td>
                <td className={td}><SourceCell url={job.sourceUrl} /></td>
                <td className={td}>
                  <span className={`inline-block rounded-full px-sm py-xs text-label-sm ${STATUS_STYLE[job.status] ?? STATUS_STYLE.QUEUED}`}>{STATUS_LABEL[job.status] ?? job.status}</span>
                  {stage && <p className={`mt-xs text-label-sm ${muted}`}>{stage}</p>}
                </td>
                <td className={`${td} font-mono text-label-sm`}>{job.skuCode ?? '—'}</td>
                <td className={td}><ProductCell job={job} viewer={viewer} /></td>
                <td className={td}><ErrorCell job={job} /></td>
                {viewer.superadmin && <td className={`${td} whitespace-nowrap`}>{job.costUsd == null ? '—' : `$${job.costUsd.toFixed(2)}`}</td>}
                {viewer.superadmin && <td className={`${td} whitespace-nowrap`}>{formatDuration(job.durationMs)}</td>}
                {viewer.superadmin && <td className={td}>{job.productType || '—'}</td>}
                <td className={`${td} whitespace-nowrap text-label-md`}>
                  {canCancel(job, viewer) && (
                    <button type="button" disabled={busy} onClick={() => onCancel(job)} className="text-on-surface-variant hover:text-error disabled:opacity-50">Huỷ</button>
                  )}
                  {canRetry(job, viewer) && (
                    <button type="button" disabled={busy} onClick={() => retry(job)} className="text-secondary hover:underline disabled:opacity-50">Thử lại</button>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
