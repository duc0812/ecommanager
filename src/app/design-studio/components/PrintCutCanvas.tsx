'use client'
import { useState, type DragEvent } from 'react'
import { printCutCheck } from '@/lib/print-cut'
import type { TemplateRow, WorkspaceLine } from './types'
import type { CanvasUpload, CanvasArtActions, CanvasBg } from './TemplateCanvas'
import { isImage, newestFor } from './model'
import { ArtImg, SvgArtImage } from './art-src'
import { btn } from './ui'

export default function PrintCutCanvas({ template, line, upload, artActions, bg = 'checker' }: {
  template: TemplateRow; line: Pick<WorkspaceLine, 'artworks'>; upload?: CanvasUpload | null; artActions?: CanvasArtActions | null; bg?: CanvasBg
}) {
  const [overlay, setOverlay] = useState(false)
  const [opacity, setOpacity] = useState(50)
  const [drag, setDrag] = useState<string | null>(null)
  const [print, cut] = template.areas.map(a => newestFor(line, a.name))
  const check = printCutCheck(template, line.artworks)!
  const canOverlay = check.ok && print && cut && isImage(print) && isImage(cut)
  const background = bg === 'black' ? 'bg-black' : bg === 'white' ? 'bg-white' : 'bg-[repeating-conic-gradient(theme(colors.outline-variant)_0_25%,theme(colors.surface-container-lowest)_0_50%)] bg-[length:8px_8px]'

  function drop(e: DragEvent, area: string) {
    e.preventDefault()
    e.stopPropagation()
    setDrag(null)
    if (!upload || upload.busy) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length !== 1) { upload.onReject('Mỗi ô nhận một file — thả riêng file in và file cắt'); return }
    upload.onDrop(area, files)
  }

  return <div className="space-y-md" aria-label="Canvas file in và file cắt">
    <p className="text-body-sm text-on-surface-variant">Upload file in và file cắt vào từng ô. Không quy định khổ hay DPI; hai file cần cùng khổ và đường cắt khớp artwork.</p>
    <div className="grid grid-cols-1 md:grid-cols-2 gap-md">
      {template.areas.map((area, i) => {
        const art = i === 0 ? print : cut
        return <div key={area.name} aria-label={i === 0 ? 'Ô file in' : 'Ô file cắt'}
          onDragOver={e => { e.preventDefault(); if (upload && !upload.busy) setDrag(area.name) }}
          onDragLeave={() => setDrag(null)} onDrop={e => drop(e, area.name)}
          className={`rounded-xl border-2 p-md space-y-sm ${drag === area.name ? 'border-secondary' : 'border-outline-variant/40'}`}>
          <div className="flex items-center gap-sm"><b>{i === 0 ? 'File in' : 'File cắt'}</b>
            {upload && <button type="button" className={`${btn} ml-auto`} disabled={!!upload.busy} onClick={() => upload.onPick(area.name)}>
              {upload.busy?.area === area.name ? `${upload.busy.pct}%` : art ? 'Thay file' : 'Upload art'}
            </button>}
          </div>
          <div className={`h-[320px] grid place-items-center rounded-lg overflow-hidden ${background}`}>
            {art && isImage(art) ? <button type="button" className="w-full h-full" aria-label={`Xem ${area.name}`} onClick={() => artActions?.onView(art)}>
              <ArtImg art={art} px={2000} full alt={i === 0 ? 'Artwork in' : 'Artwork cắt'} className="w-full h-full object-contain" />
            </button> : <span className="text-body-sm text-on-surface-variant">{art?.fileName ?? 'Kéo thả một file vào đây'}</span>}
          </div>
          {art && <p className="text-label-sm text-on-surface-variant break-all">{art.fileName} · v{art.version}{art.widthPx && art.heightPx ? ` · ${art.widthPx}×${art.heightPx} px` : ''}</p>}
        </div>
      })}
    </div>
    <p role="status" className={`text-body-sm ${check.ok ? 'text-on-tertiary-container' : 'text-error'}`}>{check.message}</p>
    {canOverlay && <div className="space-y-sm">
      <button type="button" className={btn} aria-pressed={overlay} onClick={() => setOverlay(v => !v)}>Chồng file in / cắt</button>
      {overlay && <>
        <label className="flex items-center gap-sm text-body-sm">Độ mờ file cắt
          <input type="range" min="0" max="100" value={opacity} aria-label="Độ mờ file cắt" onChange={e => setOpacity(Number(e.target.value))} />{opacity}%
        </label>
        <svg viewBox={`0 0 ${print.widthPx} ${print.heightPx}`} role="img" aria-label="Chồng ảnh kiểm tra đường cắt" className={`w-full max-h-[70vh] ${background}`}>
          <SvgArtImage art={print} px={2000} x="0" y="0" width={print.widthPx!} height={print.heightPx!} preserveAspectRatio="none" />
          <SvgArtImage art={cut} px={2000} x="0" y="0" width={cut.widthPx!} height={cut.heightPx!} preserveAspectRatio="none" opacity={opacity / 100} />
        </svg>
        <p className="text-label-sm text-on-surface-variant">Kiểm tra đường viền, vị trí và hướng cắt trên ảnh chồng trước khi duyệt.</p>
      </>}
    </div>}
  </div>
}
