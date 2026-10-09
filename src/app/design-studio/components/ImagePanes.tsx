'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TaskDetail } from './types'
import { isImage, newestFor } from './model'
import TemplateCanvas, { CanvasTools, type CanvasBg, type CanvasUpload } from './TemplateCanvas'
import { ALL_GUIDES, GUIDES_STORAGE_KEY, parseGuides, type Guides } from './canvas-guides'
import { ARTWORK_ACCEPT, useArtworkUpload } from './useArtworkUpload'
import { ErrorBanner, ExtLink, Icon, Note, btn, card, chip, input } from './ui'

type PaneKey = 'tpl' | 'prev' | 'mock'
type Side = 'Front' | 'Back'

const PANES: { key: PaneKey; icon: string; title: string }[] = [
  { key: 'tpl', icon: 'print', title: 'File in trên template' },
  { key: 'prev', icon: 'photo_library', title: 'Mockup / Preview' },
  { key: 'mock', icon: 'checkroom', title: 'Mockup xưởng' },
]

function Pane({ icon, title, right, actions, expanded, onToggle, children }: { icon: string; title: string; right: string; actions?: ReactNode; expanded: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`${card} min-w-0`}>
      <div className="flex items-center gap-xs px-sm py-sm border-b border-outline-variant/20 text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">
        <Icon name={icon} className="text-[17px]" />
        <span className="truncate">{title}</span>
        <span className="ml-auto normal-case tracking-normal font-medium truncate">{right}</span>
        {actions}
        <button type="button" onClick={onToggle} aria-label={expanded ? `Thu nhỏ ${title}` : `Phóng to ${title}`} title={expanded ? 'Thu nhỏ' : 'Phóng to'}
          className="p-[2px] rounded text-on-surface-variant hover:text-secondary hover:bg-surface-container-low leading-none">
          <Icon name={expanded ? 'close_fullscreen' : 'open_in_full'} className="text-[17px]" />
        </button>
      </div>
      <div className="p-sm flex flex-col gap-sm">{children}</div>
    </section>
  )
}

function Img({ src, alt }: { src: string; alt: string }) {
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-w-full max-h-[520px] object-contain mx-auto" loading="lazy" />
    </a>
  )
}

function useStoredGuides(): [Guides, (g: Guides) => void] {
  const [guides, setGuides] = useState<Guides>(ALL_GUIDES)
  useEffect(() => {
    try { setGuides(parseGuides(window.localStorage.getItem(GUIDES_STORAGE_KEY))) } catch {}
  }, [])
  function save(g: Guides) {
    setGuides(g)
    try { window.localStorage.setItem(GUIDES_STORAGE_KEY, JSON.stringify(g)) } catch {}
  }
  return [guides, save]
}

export default function ImagePanes({ detail, onChanged }: { detail: TaskDetail; onChanged: () => void }) {
  const { line, template } = detail
  const [expand, setExpand] = useState<PaneKey | null>(null)
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [guide, setGuide] = useState(50)
  const [side, setSide] = useState<Side>('Front')
  const [swapped, setSwapped] = useState(false)
  const [guides, setGuides] = useStoredGuides()
  const [pickedArea, setPickedArea] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const up = useArtworkUpload(line.id, detail.driveConnected, onChanged)
  const targetArea = detail.slots.includes(pickedArea) ? pickedArea : (detail.slots[0] ?? '')
  const busyEntry = Object.entries(up.progress)[0]
  const busy = busyEntry ? { area: busyEntry[0], pct: busyEntry[1], label: up.busyLabel(busyEntry[1]) } : null
  const canvasUpload: CanvasUpload | null = template && detail.slots.length > 0
    ? { onDrop: (area, file) => { void up.upload(area, file) }, onReject: msg => up.setError(msg), busy }
    : null

  const areaNames = template?.areas.map(a => a.name) ?? []
  const hasSides = areaNames.some(n => n.startsWith('Front')) && areaNames.some(n => n.startsWith('Back'))
  const newest = Array.from(new Set(line.artworks.map(a => a.printArea)))
    .map(area => newestFor(line, area)!)
    .filter(a => a && isImage(a))
  const shownArt = hasSides ? newest.filter(a => a.printArea.startsWith(side)) : newest
  const mockImages = newest.length > 0
    ? shownArt.map(a => ({ url: a.url, label: `${a.printArea} · v${a.version}` }))
    : line.sourcePrintFiles.map(f => ({ url: f.url, label: `nguồn · ${f.printArea}` }))

  const right: Record<PaneKey, string> = {
    tpl: template ? `${template.name} · ${template.widthPx}×${template.heightPx} · ${template.dpi} DPI` : 'chưa có template',
    prev: line.previewUrl ? 'preview lúc đặt' : line.imageUrl ? 'ảnh Shopify' : 'chưa có ảnh',
    mock: newest.length > 0 ? 'từ file in' : 'file nguồn',
  }

  const actions: Partial<Record<PaneKey, ReactNode>> = {
    tpl: detail.slots.length > 0 ? (
      <span className="flex items-center gap-xs normal-case tracking-normal font-medium">
        {detail.slots.length > 1 && (
          <select value={targetArea} onChange={e => setPickedArea(e.target.value)} aria-label="Vùng in để upload" className={`${input} py-[2px] text-label-sm max-w-[120px]`}>
            {detail.slots.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <input ref={fileInput} type="file" accept={ARTWORK_ACCEPT} hidden aria-label={`Chọn file cho ${targetArea}`}
          onChange={e => { const f = e.target.files?.[0]; if (f && targetArea) void up.upload(targetArea, f); e.target.value = '' }} />
        <button type="button" disabled={up.progress[targetArea] !== undefined} onClick={() => fileInput.current?.click()}
          title={detail.slots.length > 1 ? `Upload vào ${targetArea}` : undefined} className={`${btn} px-sm py-[2px] whitespace-nowrap`}>
          <Icon name="upload" className="text-[16px]" />Upload vào vùng in
        </button>
      </span>
    ) : undefined,
  }

  const body: Record<PaneKey, () => ReactNode> = {
    tpl: () => (
      <>
        {template && (
          <CanvasTools bg={bg} onBg={setBg} guide={guide} onGuide={setGuide} hasGuide={!!template.guideImageUrl}
            guides={guides} onGuides={setGuides} hasBleed={template.bleedIn > 0} />
        )}
        <ErrorBanner msg={up.error} onClose={() => up.setError('')} />
        {Object.entries(up.warnings).map(([area, msg]) => <Note key={area} tone="warn" icon="cloud_off">{area}: {msg}</Note>)}
        <TemplateCanvas template={template} line={line} slots={detail.slots} bg={bg} guide={guide} guides={guides} upload={canvasUpload} />
      </>
    ),
    prev: () => {
      const hasBoth = !!line.previewUrl && !!line.imageUrl
      const showVariant = !line.previewUrl || (hasBoth && swapped)
      const large = showVariant ? line.imageUrl : line.previewUrl
      const small = hasBoth ? (swapped ? line.previewUrl : line.imageUrl) : null
      const caption = !line.previewUrl && line.imageUrl
        ? 'Chưa có preview riêng — ảnh variant/sản phẩm trên Shopify'
        : showVariant ? 'Ảnh variant (Shopify)' : 'Preview khách tạo lúc đặt hàng'
      return (
        <>
          <div className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-sm grid place-items-center aspect-square overflow-hidden">
            {large
              ? <Img src={large} alt={showVariant ? 'Ảnh variant Shopify' : 'Preview khách thấy'} />
              : <span className="text-label-sm text-on-surface-variant text-center">Không có preview hay ảnh sản phẩm — bấm Nạp lại từ Shopify</span>}
          </div>
          {large && <div className="text-label-sm text-on-surface-variant">{caption}</div>}
          {small && (
            <button type="button" onClick={() => setSwapped(!swapped)} title="Bấm để đổi ảnh lớn"
              className="self-start flex flex-col gap-[2px] items-start rounded-lg border border-outline-variant/40 p-xs hover:bg-surface-container-low">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={small} alt="" className="w-16 h-16 object-cover rounded-md" loading="lazy" />
              <span className="text-label-sm text-on-surface-variant">{swapped ? 'Preview khách tạo' : 'Ảnh variant (Shopify)'}</span>
            </button>
          )}
          {line.customerDesignLink && (
            <div className="text-label-sm text-on-surface-variant flex flex-wrap gap-x-sm">
              <ExtLink href={line.customerDesignLink}>Mở lại thiết kế ↗</ExtLink>
            </div>
          )}
        </>
      )
    },
    mock: () => (
      <>
        {hasSides && newest.length > 0 && (
          <div className="flex items-center gap-xs text-label-sm text-on-surface-variant">
            <span>Mặt</span>
            {(['Front', 'Back'] as Side[]).map(s => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} className={chip(side === s)}>{s === 'Front' ? 'Trước' : 'Sau'}</button>
            ))}
          </div>
        )}
        <div className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-sm flex flex-col gap-sm items-center">
          {mockImages.length === 0 && <span className="text-label-sm text-on-surface-variant py-md">Chưa có file in để xem</span>}
          {mockImages.map(m => (
            <figure key={m.url} className="flex flex-col gap-xs items-center w-full">
              <Img src={m.url} alt={m.label} />
              <figcaption className="text-label-sm text-on-surface-variant">{m.label}</figcaption>
            </figure>
          ))}
        </div>
        <div className="text-label-sm text-on-surface-variant">Chưa dựng mockup lên áo — xem file in theo panel</div>
      </>
    ),
  }

  const render = (p: typeof PANES[number]) => (
    <Pane key={p.key} icon={p.icon} title={p.title} right={right[p.key]} actions={actions[p.key]} expanded={expand === p.key} onToggle={() => setExpand(expand === p.key ? null : p.key)}>
      {body[p.key]()}
    </Pane>
  )

  if (expand) {
    const p = PANES.find(x => x.key === expand)!
    return (
      <div className="flex flex-col gap-sm">
        <div className="grid grid-cols-1 gap-md">{render(p)}</div>
        <div className="flex gap-xs flex-wrap">
          {PANES.filter(x => x.key !== expand).map(x => (
            <button key={x.key} type="button" onClick={() => setExpand(x.key)} className={chip(false)}>
              <Icon name={x.icon} className="text-[14px]" />{x.title}
            </button>
          ))}
        </div>
      </div>
    )
  }

  return <div className="grid grid-cols-[2.1fr_1fr_1fr] gap-md items-start">{PANES.map(render)}</div>
}
