'use client'
import { useState, type ReactNode } from 'react'
import type { TaskDetail } from './types'
import { isImage, newestFor } from './model'
import TemplateCanvas, { CanvasTools, type CanvasBg } from './TemplateCanvas'
import { ExtLink, Icon, card } from './ui'

type PaneKey = 'tpl' | 'prev' | 'mock'
type Side = 'Front' | 'Back'

const PANES: { key: PaneKey; icon: string; title: string }[] = [
  { key: 'tpl', icon: 'print', title: 'File in trên template' },
  { key: 'prev', icon: 'visibility', title: 'Khách đã thấy' },
  { key: 'mock', icon: 'checkroom', title: 'Mockup xưởng' },
]

function Pane({ icon, title, right, expanded, onToggle, children }: { icon: string; title: string; right: string; expanded: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section className={`${card} min-w-0`}>
      <div className="flex items-center gap-xs px-sm py-sm border-b border-outline-variant/20 text-label-sm font-semibold uppercase tracking-wider text-on-surface-variant">
        <Icon name={icon} className="text-[17px]" />
        <span className="truncate">{title}</span>
        <span className="ml-auto normal-case tracking-normal font-medium truncate">{right}</span>
        <button type="button" onClick={onToggle} aria-label={expanded ? `Thu nhỏ ${title}` : `Phóng to ${title}`} title={expanded ? 'Thu nhỏ' : 'Phóng to'}
          className="p-[2px] rounded text-on-surface-variant hover:text-secondary hover:bg-surface-container-low leading-none">
          <Icon name={expanded ? 'close_fullscreen' : 'open_in_full'} className="text-[17px]" />
        </button>
      </div>
      <div className="p-sm flex flex-col gap-sm">{children}</div>
    </section>
  )
}

function chip(on: boolean) {
  return `inline-flex items-center gap-xs rounded-full border px-sm py-[2px] text-label-sm ${on ? 'bg-secondary/10 text-secondary border-transparent font-semibold' : 'bg-surface-container-lowest border-outline-variant/40 text-on-surface-variant'}`
}

function Img({ src, alt }: { src: string; alt: string }) {
  return (
    <a href={src} target="_blank" rel="noreferrer" className="block">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={alt} className="max-w-full max-h-[520px] object-contain mx-auto" loading="lazy" />
    </a>
  )
}

export default function ImagePanes({ detail }: { detail: TaskDetail }) {
  const { line, template } = detail
  const [expand, setExpand] = useState<PaneKey | null>(null)
  const [bg, setBg] = useState<CanvasBg>('checker')
  const [guide, setGuide] = useState(50)
  const [side, setSide] = useState<Side>('Front')

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
    prev: 'preview lúc đặt',
    mock: newest.length > 0 ? 'từ file in' : 'file nguồn',
  }

  const body: Record<PaneKey, () => ReactNode> = {
    tpl: () => (
      <>
        {template && <CanvasTools bg={bg} onBg={setBg} guide={guide} onGuide={setGuide} hasGuide={!!template.guideImageUrl} />}
        <TemplateCanvas template={template} line={line} bg={bg} guide={guide} />
      </>
    ),
    prev: () => (
      <>
        <div className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-sm grid place-items-center aspect-square overflow-hidden">
          {line.previewUrl ? <Img src={line.previewUrl} alt="Preview khách thấy" /> : <span className="text-label-sm text-on-surface-variant">Không có preview</span>}
        </div>
        <div className="text-label-sm text-on-surface-variant flex flex-wrap gap-x-sm">
          <span>Ảnh lúc Add to cart · đối chiếu nội dung</span>
          {line.customerDesignLink && <ExtLink href={line.customerDesignLink}>Mở lại thiết kế ↗</ExtLink>}
        </div>
      </>
    ),
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
    <Pane key={p.key} icon={p.icon} title={p.title} right={right[p.key]} expanded={expand === p.key} onToggle={() => setExpand(expand === p.key ? null : p.key)}>
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
