'use client'
import { useRef, useState } from 'react'
import type { WorkspaceLine } from './types'
import { requestJson, versionsFor } from './model'
import { Card, ErrorBanner, Icon, Pill, btn, fmtSize } from './ui'

const ACCEPT = '.png,.jpg,.jpeg,.pdf,.psd,.zip'

export default function ArtworkSlots({ line, slots, onUploaded }: { line: WorkspaceLine; slots: string[]; onUploaded: () => void }) {
  const [busy, setBusy] = useState<string[]>([])
  const [over, setOver] = useState('')
  const [error, setError] = useState('')
  const busyRef = useRef(new Set<string>())
  const inputs = useRef<Record<string, HTMLInputElement | null>>({})
  const fileCount = line.artworks.length

  async function upload(printArea: string, file: File) {
    if (busyRef.current.has(printArea)) return
    busyRef.current.add(printArea)
    setBusy(Array.from(busyRef.current)); setError('')
    const fd = new FormData()
    fd.set('printArea', printArea)
    fd.set('file', file)
    const r = await requestJson(`/api/design-studio/lines/${encodeURIComponent(line.id)}/artwork`, { method: 'POST', body: fd })
    busyRef.current.delete(printArea)
    setBusy(Array.from(busyRef.current))
    if (!r.ok) { setError(`${printArea}: ${r.error}`); return }
    onUploaded()
  }

  return (
    <Card icon="folder_open" title="Artwork theo panel" right={`${fileCount} file`}>
      <ErrorBanner msg={error} onClose={() => setError('')} />
      {slots.map(area => {
        const versions = versionsFor(line, area)
        const isBusy = busy.includes(area)
        return (
          <div key={area} className="rounded-lg border border-outline-variant/20 p-sm flex flex-col gap-xs">
            <div className="flex items-center gap-xs text-body-sm font-semibold">
              <span>{area}</span>
              <span className="text-label-sm font-medium text-on-surface-variant">{versions.length ? `${versions.length} phiên bản` : 'chưa có file'}</span>
              <input ref={el => { inputs.current[area] = el }} type="file" accept={ACCEPT} hidden aria-label={`Chọn file cho ${area}`}
                onChange={e => { const f = e.target.files?.[0]; if (f) upload(area, f); e.target.value = '' }} />
              <button type="button" disabled={isBusy} onClick={() => inputs.current[area]?.click()} className={`${btn} ml-auto`}>
                <Icon name="upload" className="text-[16px]" />{isBusy ? 'Đang tải…' : 'Upload'}
              </button>
            </div>
            {versions.map((v, i) => (
              <div key={v.id} className={`grid grid-cols-[32px_minmax(0,1fr)_auto] gap-sm items-center p-xs rounded-lg border ${i === 0 ? 'border-secondary' : 'border-outline-variant/20'}`}>
                <span className="w-8 h-8 rounded-md bg-surface-container-low grid place-items-center text-on-surface-variant">
                  <Icon name={v.mimeType.startsWith('image/') ? 'image' : 'description'} className="text-[18px]" />
                </span>
                <span className="min-w-0 flex flex-col">
                  <span className="text-label-sm font-semibold truncate text-on-surface">v{v.version} · {v.fileName}</span>
                  <span className="text-label-sm text-on-surface-variant truncate">
                    {v.widthPx && v.heightPx ? `${v.widthPx}×${v.heightPx} · ` : ''}{fmtSize(v.size)} · {new Date(v.createdAt).toLocaleString('en-US')}
                  </span>
                </span>
                <a href={v.url} target="_blank" rel="noreferrer" aria-label={`Tải v${v.version} ${v.fileName}`} className="text-on-surface-variant hover:text-secondary">
                  <Icon name="download" className="text-[18px]" />
                </a>
              </div>
            ))}
            <div role="button" tabIndex={0} aria-label={`Kéo thả hoặc chọn file cho ${area}`}
              onClick={() => inputs.current[area]?.click()}
              onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inputs.current[area]?.click() } }}
              onDragOver={e => { e.preventDefault(); if (over !== area) setOver(area) }}
              onDragLeave={() => setOver('')}
              onDrop={e => { e.preventDefault(); setOver(''); const f = e.dataTransfer.files?.[0]; if (f) upload(area, f) }}
              className={`rounded-lg border-[1.5px] border-dashed px-sm py-xs text-center text-label-sm cursor-pointer ${over === area ? 'border-secondary bg-secondary/10 text-secondary' : 'border-outline-variant text-on-surface-variant'}`}>
              {isBusy ? 'Đang tải lên…' : 'Kéo thả PNG/JPG/PSD → phiên bản mới'}
            </div>
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
