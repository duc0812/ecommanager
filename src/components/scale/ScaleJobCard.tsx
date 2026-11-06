'use client'
import { SCALE_STATUS_LABEL, scaleFileUrl, type ScaleJobView } from '@/components/scale/types'

type Props = {
  job: ScaleJobView
  canDelete: boolean
  allowFallback: boolean
  showDebug: boolean
  onRerun: (job: ScaleJobView) => void
  onFallback: (job: ScaleJobView) => void
  onDelete: (job: ScaleJobView) => void
}

const STATUS_STYLE: Record<ScaleJobView['status'], string> = {
  describing: 'bg-secondary/10 text-secondary',
  running: 'bg-secondary/10 text-secondary',
  done: 'bg-primary/10 text-primary',
  failed: 'bg-error/10 text-error',
}

function when(iso: string) {
  const d = new Date(iso)
  return `${d.toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`
}

export function ScaleJobCard({ job, canDelete, allowFallback, showDebug, onRerun, onFallback, onDelete }: Props) {
  const active = job.status === 'describing' || job.status === 'running'
  const resultUrl = job.resultFile ? scaleFileUrl('jobs', job.id, job.resultFile) : null
  const canFallback = job.status === 'failed' && job.hasDesign

  return (
    <article className="rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card">
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-t-xl bg-outline-variant/20">
        <div className="bg-surface">
          {job.sourceFile && <img src={scaleFileUrl('jobs', job.id, job.sourceFile)} alt="Ảnh gốc" className="aspect-square w-full object-contain" />}
          <p className="px-sm py-xs text-label-sm text-on-surface-variant">Ảnh gốc</p>
        </div>
        <div className="bg-surface">
          {resultUrl ? (
            <a href={resultUrl} target="_blank" rel="noreferrer"><img src={resultUrl} alt="Kết quả" className="aspect-square w-full bg-white object-contain" /></a>
          ) : (
            <div className="flex aspect-square items-center justify-center p-md text-center text-body-sm text-on-surface-variant">
              {active ? <span className="material-symbols-outlined animate-spin text-secondary">progress_activity</span> : 'Không có ảnh'}
            </div>
          )}
          <p className="px-sm py-xs text-label-sm text-on-surface-variant">{job.targetName}</p>
        </div>
      </div>
      <div className="p-md">
        <div className="flex flex-wrap items-center gap-sm">
          <span className={`rounded-full px-sm py-xs text-label-sm ${STATUS_STYLE[job.status]}`}>{SCALE_STATUS_LABEL[job.status]}</span>
          {job.cost && <span className="text-body-sm text-on-surface-variant">{job.cost}</span>}
          {job.durationMs != null && <span className="text-body-sm text-on-surface-variant">{Math.round(job.durationMs / 1000)}s</span>}
        </div>
        <p className="mt-xs text-body-sm text-on-surface-variant">{job.createdByName ?? 'Không rõ'} · {when(job.createdAt)} · {job.model}</p>
        {job.error && <p className="mt-xs break-words text-body-sm text-error">{job.error}</p>}
        {canFallback && !allowFallback && <p className="mt-xs text-body-sm text-on-surface-variant">Model dự phòng chưa được bật.</p>}
        <div className="mt-sm flex flex-wrap items-center gap-md text-label-md">
          {resultUrl && <a href={resultUrl} download={`scale-${job.targetName.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}-${job.id}.${job.resultFile!.split('.').pop()}`} className="text-secondary hover:underline">Tải về</a>}
          {!active && <button type="button" onClick={() => onRerun(job)} className="text-secondary hover:underline">Tạo lại</button>}
          {canFallback && allowFallback && <button type="button" onClick={() => onFallback(job)} className="text-secondary hover:underline">Thử model dự phòng</button>}
          {canDelete && <button type="button" onClick={() => onDelete(job)} className="ml-auto text-on-surface-variant hover:text-error">Xoá</button>}
        </div>
        {showDebug && job.prompt && (
          <details className="mt-sm">
            <summary className="cursor-pointer text-label-sm text-on-surface-variant">Prompt đã gửi</summary>
            <pre className="mt-xs max-h-60 overflow-auto whitespace-pre-wrap rounded-lg bg-surface p-sm text-body-sm text-on-surface-variant">{job.prompt}</pre>
          </details>
        )}
      </div>
    </article>
  )
}
