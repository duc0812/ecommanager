'use client'
import { useRef, useState } from 'react'
import type { ArtworkRow, WorkspaceLine } from './types'
import { requestJson, versionsFor } from './model'
import { Card, ErrorBanner, Icon, Note, Pill, btn, fmtSize } from './ui'
import { ARTWORK_ACCEPT, useArtworkUpload } from './useArtworkUpload'

const mini = 'inline-flex items-center gap-xs rounded-md border border-outline-variant/40 px-xs py-[2px] text-label-sm font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap'

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
    return ok
  }
}

export default function ArtworkSlots({ line, slots, driveConnected, onUploaded }: {
  line: WorkspaceLine; slots: string[]; driveConnected: boolean; onUploaded: () => void
}) {
  const { progress, warnings, setWarning, error, setError, upload, busyLabel } = useArtworkUpload(line.id, driveConnected, onUploaded)
  const [pushing, setPushing] = useState<string[]>([])
  const [over, setOver] = useState('')
  const [copied, setCopied] = useState('')
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})
  const fileCount = line.artworks.length

  async function push(area: string, artworkId: string) {
    if (pushing.includes(artworkId)) return
    setPushing(p => [...p, artworkId]); setWarning(area, '')
    const r = await requestJson(`/api/design-studio/artwork/${encodeURIComponent(artworkId)}/push`, { method: 'POST' })
    setPushing(p => p.filter(id => id !== artworkId))
    if (!r.ok) { setWarning(area, r.error); return }
    onUploaded()
  }

  async function copyLink(v: ArtworkRow) {
    if (!v.driveWebViewLink) return
    setCopied(await copyText(v.driveWebViewLink) ? `Đã chép link Drive v${v.version}` : 'Không chép được link')
    window.setTimeout(() => setCopied(''), 2500)
  }

  return (
    <Card icon="folder_open" title="Artwork theo panel" right={`${fileCount} file`}>
      <ErrorBanner msg={error} onClose={() => setError('')} />
      <span role="status" aria-live="polite" className={copied ? 'text-label-sm text-on-surface-variant' : 'sr-only'}>{copied}</span>
      {slots.map(area => {
        const versions = versionsFor(line, area)
        const pct = progress[area]
        const isBusy = pct !== undefined
        return (
          <div key={area} className="rounded-lg border border-outline-variant/20 p-sm flex flex-col gap-xs">
            <div className="flex items-center gap-xs text-body-sm font-semibold">
              <span>{area}</span>
              <span className="text-label-sm font-medium text-on-surface-variant">{versions.length ? `${versions.length} phiên bản` : 'chưa có file'}</span>
              <input ref={el => { inputs.current[area] = el }} type="file" accept={ARTWORK_ACCEPT} hidden aria-label={`Chọn file cho ${area}`}
                onChange={e => { const f = e.target.files?.[0]; if (f) upload(area, f); e.target.value = '' }} />
              <button type="button" disabled={isBusy} onClick={() => inputs.current[area]?.click()} className={`${btn} ml-auto`}>
                <Icon name="upload" className="text-[16px]" />{isBusy ? busyLabel(pct) : 'Upload'}
              </button>
            </div>
            {warnings[area] && <Note tone="warn" icon="cloud_off">{warnings[area]}</Note>}
            {versions.map((v, i) => {
              const isDrive = v.storage === 'DRIVE'
              const isPushing = pushing.includes(v.id)
              return (
                <div key={v.id} className={`grid grid-cols-[32px_minmax(0,1fr)_auto] gap-sm items-center p-xs rounded-lg border ${i === 0 ? 'border-secondary' : 'border-outline-variant/20'}`}>
                  <span className="w-8 h-8 rounded-md bg-surface-container-low grid place-items-center text-on-surface-variant">
                    <Icon name={v.mimeType.startsWith('image/') ? 'image' : 'description'} className="text-[18px]" />
                  </span>
                  <span className="min-w-0 flex flex-col">
                    <span className="flex items-center gap-xs min-w-0">
                      <span className="text-label-sm font-semibold truncate text-on-surface">v{v.version} · {v.fileName}</span>
                      <Pill tone={isDrive ? 'ok' : 'warn'} icon={isDrive ? 'cloud_done' : 'hard_drive'}>{isDrive ? 'Drive' : 'Local'}</Pill>
                    </span>
                    <span className="text-label-sm text-on-surface-variant truncate">
                      {v.widthPx && v.heightPx ? `${v.widthPx}×${v.heightPx} · ` : ''}{fmtSize(v.size)} · {new Date(v.createdAt).toLocaleString('en-US')}
                    </span>
                  </span>
                  <span className="flex items-center gap-xs">
                    {isDrive && v.driveWebViewLink && (
                      <>
                        <button type="button" onClick={() => copyLink(v)} className={mini} aria-label={`Copy link Drive v${v.version}`}>
                          <Icon name="content_copy" className="text-[14px]" />Copy link Drive
                        </button>
                        <a href={v.driveWebViewLink} target="_blank" rel="noreferrer" className={mini} aria-label={`Mở v${v.version} trên Drive`}>
                          <Icon name="open_in_new" className="text-[14px]" />Mở trên Drive
                        </a>
                      </>
                    )}
                    {!isDrive && driveConnected && (
                      <button type="button" disabled={isPushing} onClick={() => push(area, v.id)} className={mini} aria-label={`Đẩy v${v.version} lên Drive`}>
                        <Icon name="cloud_upload" className="text-[14px]" />{isPushing ? 'Đang đẩy…' : 'Đẩy lên Drive'}
                      </button>
                    )}
                    <a href={v.url} target="_blank" rel="noreferrer" aria-label={`Tải v${v.version} ${v.fileName}`} className="text-on-surface-variant hover:text-secondary">
                      <Icon name="download" className="text-[18px]" />
                    </a>
                  </span>
                </div>
              )
            })}
            <div role="button" tabIndex={0} aria-label={`Kéo thả hoặc chọn file cho ${area}`}
              onClick={() => inputs.current[area]?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputs.current[area]?.click() } }}
              onDragOver={e => { e.preventDefault(); if (over !== area) setOver(area) }}
              onDragLeave={() => setOver('')}
              onDrop={e => { e.preventDefault(); setOver(''); const f = e.dataTransfer.files?.[0]; if (f) upload(area, f) }}
              className={`rounded-lg border-[1.5px] border-dashed px-sm py-xs text-center text-label-sm cursor-pointer ${over === area ? 'border-secondary bg-secondary/10 text-secondary' : 'border-outline-variant text-on-surface-variant'}`}>
              {isBusy ? busyLabel(pct) : 'Kéo thả PNG/JPG/PSD → phiên bản mới'}
            </div>
            {isBusy && (
              <div className="h-1 rounded-full bg-surface-container overflow-hidden" role="progressbar" aria-label={`Tiến độ tải ${area}`}
                aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className="h-full bg-secondary transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
          </div>
        )
      })}
      {line.sourcePrintFiles.map(f => (
        <div key={f.url} className="grid grid-cols-[32px_minmax(0,1fr)_auto] gap-sm items-center p-xs rounded-lg border border-outline-variant/20">
          <span className="w-8 h-8 rounded-md bg-surface-container-low grid place-items-center text-on-surface-variant"><Icon name="link" className="text-[18px]" /></span>
          <span className="min-w-0 flex items-center gap-xs">
            <Pill tone="idle">nguồn</Pill>
            <span className="text-label-sm truncate">{f.printArea} · {f.url.split('/').pop()}</span>
          </span>
          <a href={f.url} target="_blank" rel="noreferrer" aria-label={`Mở file nguồn ${f.printArea}`} className="text-on-surface-variant hover:text-secondary">
            <Icon name="open_in_new" className="text-[18px]" />
          </a>
        </div>
      ))}
    </Card>
  )
}
