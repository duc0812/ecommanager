'use client'
import type { FileKind, WorkspaceLine } from './types'
import { artworkImage, isImage, newestFor } from './model'
import { useLightbox } from './Lightbox'
import { Icon, Pill } from './ui'

export default function PrintFileThumb({ line, area, refLabel, kind = 'PRINT', wrongSize = false }: { line: WorkspaceLine; area: string; refLabel: string; kind?: FileKind; wrongSize?: boolean }) {
  const lb = useLightbox()
  const art = newestFor(line, area, kind)
  if (!art) {
    return (
      <div className="flex flex-col gap-xs">
        <div className="aspect-[4/3] rounded-lg border border-dashed border-error/50 grid place-items-center text-label-sm text-error">Thiếu file {area}</div>
      </div>
    )
  }
  const src = art.previewUrl ?? (isImage(art) ? art.url : null)
  const label = `${refLabel} · ${kind === 'MOCKUP' ? 'mockup ' : ''}${area} · v${art.version}`
  return (
    <div className="flex flex-col gap-xs min-w-0">
      <button type="button" onClick={() => lb?.open(art.url, artworkImage(art))} aria-label={`Xem lớn file in ${label}`} title="Bấm để xem lớn"
        className={`relative aspect-[4/3] rounded-lg overflow-hidden border border-outline-variant/30 bg-[repeating-conic-gradient(theme(colors.outline-variant)_0_25%,theme(colors.surface-container-lowest)_0_50%)] bg-[length:12px_12px] grid place-items-center hover:ring-2 hover:ring-secondary/40 ${wrongSize ? 'ring-2 ring-error' : ''}`}>
        {src
          // eslint-disable-next-line @next/next/no-img-element
          ? <img src={src} alt={`File in ${label}`} loading="lazy" className="max-w-full max-h-full object-contain" />
          : <span className="flex flex-col items-center gap-xs text-label-sm text-on-surface-variant"><Icon name="description" className="text-[32px]" />{art.fileName}</span>}
      </button>
      <span className="flex items-center gap-xs text-label-sm text-on-surface-variant min-w-0">
        {kind === 'MOCKUP' && <Pill tone="idle" icon="checkroom">Mockup</Pill>}
        <span className="font-semibold text-on-surface truncate" title={area}>{area}</span>
        <span>v{art.version}</span>
        {art.widthPx && art.heightPx && <span className={wrongSize ? 'text-error font-semibold' : ''}>{art.widthPx}×{art.heightPx}</span>}
        {art.source === 'AUTO' && <Pill tone="brand" icon="auto_awesome">Tự động</Pill>}
      </span>
    </div>
  )
}
