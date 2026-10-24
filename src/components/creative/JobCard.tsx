'use client'
import { useState } from 'react'
import { type Job, PROVIDER_LABEL, STATUS_LABEL } from './types'

type Props = {
  job: Job
  china: boolean
  onReuse: (job: Job) => void
  onDelete: (job: Job) => void
}

const STATUS_CLASS: Record<Job['status'], string> = {
  queued: 'bg-surface-container text-on-surface-variant',
  running: 'bg-secondary/10 text-secondary',
  done: 'bg-primary/10 text-primary',
  failed: 'bg-error/10 text-error',
}

function elapsed(job: Job) {
  const ms = job.durationMs ?? (job.status === 'running' || job.status === 'queued' ? Date.now() - new Date(job.createdAt).getTime() : null)
  if (ms == null) return null
  const s = Math.round(ms / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`
}

export function JobCard({ job, china, onReuse, onDelete }: Props) {
  const [copied, setCopied] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const file = (name: string) => `/api/tools/creative/file/${job.id}/${name}`
  const created = new Date(job.createdAt).toLocaleString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  async function copyPrompt() {
    try { await navigator.clipboard.writeText(job.prompt); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  return (
    <article className="flex flex-col rounded-xl border border-outline-variant/20 bg-surface-container-lowest shadow-card overflow-hidden">
      <div className="relative bg-surface-container min-h-[180px]">
        {job.status === 'done' && job.resultFiles.length > 0 ? (
          <div className={`grid gap-px ${job.resultFiles.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {job.resultFiles.map(name => (
              <a key={name} href={file(name)} target="_blank" rel="noreferrer" className="block bg-surface-container">
                <img src={file(name)} alt={job.prompt} loading="lazy" className="w-full aspect-square object-cover" />
              </a>
            ))}
          </div>
        ) : (
          <div className="flex h-[180px] flex-col items-center justify-center gap-xs text-on-surface-variant">
            <span className={`material-symbols-outlined text-[36px] ${job.status === 'running' ? 'animate-spin' : ''}`}>
              {job.status === 'failed' ? 'error' : job.status === 'done' ? 'image_not_supported' : 'progress_activity'}
            </span>
            <span className="text-body-sm">{job.status === 'failed' ? 'Tạo ảnh thất bại' : job.status === 'done' ? 'Không có file' : `${STATUS_LABEL[job.status]}…`}</span>
          </div>
        )}
        {job.refImages.length > 0 && (
          <div className="absolute left-2 bottom-2 flex gap-1">
            {job.refImages.map(name => <img key={name} src={file(name)} alt="" className="h-9 w-9 rounded border border-surface object-cover shadow-card" />)}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-sm p-md">
        <div className="flex items-center gap-xs flex-wrap">
          <span className={`rounded-full px-sm py-0.5 text-label-sm ${STATUS_CLASS[job.status]}`}>{STATUS_LABEL[job.status]}</span>
          <span className="rounded-full bg-surface-container px-sm py-0.5 text-label-sm text-on-surface-variant">{PROVIDER_LABEL[job.provider]}</span>
          {china && <span className="rounded-full bg-error/10 px-sm py-0.5 text-label-sm text-error">CN</span>}
          <span className="ml-auto text-label-sm text-on-surface-variant">{created}</span>
        </div>
        <p className="font-mono text-label-sm text-primary truncate" title={job.model}>{job.model}</p>
        <p className={`text-body-sm text-on-surface ${expanded ? '' : 'line-clamp-3'}`} onClick={() => setExpanded(v => !v)} title="Bấm để xem đầy đủ">{job.prompt}</p>
        {job.error && <p className="text-body-sm text-error break-words">{job.error}</p>}
        <div className="flex items-center gap-md text-label-sm text-on-surface-variant">
          {job.cost && <span className="flex items-center gap-xs"><span className="material-symbols-outlined text-[16px]">paid</span>{job.cost}</span>}
          {elapsed(job) && <span className="flex items-center gap-xs"><span className="material-symbols-outlined text-[16px]">timer</span>{elapsed(job)}</span>}
        </div>
        <div className="flex items-center gap-xs border-t border-outline-variant/20 pt-sm">
          <button type="button" onClick={copyPrompt} className="flex items-center gap-xs rounded-lg px-sm py-xs text-label-sm text-on-surface-variant hover:bg-surface-container">
            <span className="material-symbols-outlined text-[16px]">{copied ? 'check' : 'content_copy'}</span>{copied ? 'Đã copy' : 'Copy prompt'}
          </button>
          <button type="button" onClick={() => onReuse(job)} className="flex items-center gap-xs rounded-lg px-sm py-xs text-label-sm text-secondary hover:bg-surface-container">
            <span className="material-symbols-outlined text-[16px]">replay</span>Dùng lại
          </button>
          <button type="button" onClick={() => onDelete(job)} className="ml-auto flex items-center gap-xs rounded-lg px-sm py-xs text-label-sm text-error hover:bg-error/10">
            <span className="material-symbols-outlined text-[16px]">delete</span>
          </button>
        </div>
      </div>
    </article>
  )
}
