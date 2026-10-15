'use client'
import { useEffect, useState } from 'react'
import { useLightbox } from './Lightbox'
import { ExtLink, Icon } from './ui'

type PublicFile = { id: string; name: string; folder: boolean; viewUrl: string }
type PublicLink = { url: string; kind: 'file' | 'folder'; files: PublicFile[]; error: string | null }

const thumb = (id: string, w: number) => `https://drive.google.com/thumbnail?id=${encodeURIComponent(id)}&sz=w${w}`

function Tile({ f, refLabel }: { f: PublicFile; refLabel: string }) {
  const lb = useLightbox()
  const [broken, setBroken] = useState(false)
  const label = `${refLabel} · ${f.name || 'file Drive'}`
  if (f.folder) {
    return (
      <a href={f.viewUrl} target="_blank" rel="noreferrer" title={`Mở thư mục ${f.name}`}
        className="aspect-[4/3] rounded-lg border border-outline-variant/30 bg-surface-container-low grid place-items-center text-label-sm text-on-surface-variant hover:ring-2 hover:ring-secondary/40 p-xs text-center">
        <span className="flex flex-col items-center gap-xs"><Icon name="folder" className="text-[32px]" /><span className="break-all">{f.name}</span></span>
      </a>
    )
  }
  return (
    <div className="flex flex-col gap-xs min-w-0">
      <button type="button" title="Bấm để xem lớn" aria-label={`Xem lớn ${label}`}
        onClick={() => (broken ? window.open(f.viewUrl, '_blank', 'noreferrer') : lb?.open(thumb(f.id, 1600), { url: thumb(f.id, 1600), label, openUrl: f.viewUrl, copyUrl: f.viewUrl }))}
        className="relative aspect-[4/3] rounded-lg overflow-hidden border border-outline-variant/30 bg-[repeating-conic-gradient(theme(colors.outline-variant)_0_25%,theme(colors.surface-container-lowest)_0_50%)] bg-[length:12px_12px] grid place-items-center hover:ring-2 hover:ring-secondary/40">
        {broken
          ? <span className="flex flex-col items-center gap-xs text-label-sm text-on-surface-variant p-xs text-center"><Icon name="description" className="text-[32px]" /><span className="break-all">{f.name || 'Không có ảnh xem trước'}</span></span>
          // eslint-disable-next-line @next/next/no-img-element
          : <img src={thumb(f.id, 480)} alt={label} loading="lazy" referrerPolicy="no-referrer" onError={() => setBroken(true)} className="max-w-full max-h-full object-contain" />}
      </button>
      {f.name && <span className="text-label-sm text-on-surface truncate" title={f.name}>{f.name}</span>}
    </div>
  )
}

/** Preview of a design that was made outside the studio: the files behind its public Drive link(s), read through the app. */
export default function ExternalDesignPreview({ link, refLabel }: { link: string; refLabel: string }) {
  const [links, setLinks] = useState<PublicLink[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    setLinks(null)
    setFailed(false)
    fetch(`/api/design-studio/external-preview?url=${encodeURIComponent(link)}`)
      .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then(d => { if (alive) setLinks(Array.isArray(d.links) ? d.links : []) })
      .catch(() => { if (alive) setFailed(true) })
    return () => { alive = false }
  }, [link])

  const files = (links ?? []).flatMap(l => l.files)
  const errors = (links ?? []).map(l => l.error).filter((e): e is string => !!e)
  const box = 'aspect-[4/3] rounded-lg border border-outline-variant/30 bg-surface-container-low grid place-items-center text-label-sm text-on-surface-variant p-sm text-center'

  if (!links && !failed) return <div className={`${box} animate-pulse`}>Đang tải xem trước…</div>
  if (files.length === 0) {
    return (
      <div className={box}>
        <span className="flex flex-col items-center gap-xs">
          <ExtLink href={link.split(' | ')[0]}>Design ngoài studio — mở link</ExtLink>
          {errors[0] && <span>{errors[0]}</span>}
        </span>
      </div>
    )
  }
  return (
    <div className="col-span-full flex flex-col gap-xs">
      <div className={`grid gap-sm ${files.length > 1 ? 'grid-cols-2' : 'grid-cols-1'}`}>
        {files.map(f => <Tile key={f.id} f={f} refLabel={refLabel} />)}
      </div>
      <span className="inline-flex items-center gap-xs text-label-sm text-on-surface-variant flex-wrap">
        <Icon name="link" className="text-[16px]" />Design ngoài studio ·
        {(links ?? []).map((l, i) => <ExtLink key={`${l.url}-${i}`} href={l.url}>{l.kind === 'folder' ? 'mở thư mục' : 'mở file'} ↗</ExtLink>)}
      </span>
    </div>
  )
}
