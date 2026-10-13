'use client'
import { useEffect, useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { TaskDetail } from './types'
import { artworkImage, canRemoveArtwork, isImage, mockupFiles, printFiles, type LightboxImage } from './model'
import TemplateCanvas, { CanvasTools, type CanvasArtActions, type CanvasBg, type CanvasUpload } from './TemplateCanvas'
import { ALL_GUIDES, GUIDES_STORAGE_KEY, parseGuides, type Guides } from './canvas-guides'
import { ARTWORK_ACCEPT, MOCKUP_ACCEPT, useArtworkUpload } from './useArtworkUpload'
import { UploadList } from './ArtworkSlots'
import { useArtworkRemove } from './useArtworkRemove'
import { useLightbox } from './Lightbox'
import { ErrorBanner, ExtLink, Icon, Note, card, chip, input } from './ui'

type PaneKey = 'tpl' | 'prev' | 'mock'
type Side = 'Front' | 'Back'

const PANES: { key: PaneKey; icon: string; title: string }[] = [
  { key: 'tpl', icon: 'print', title: 'File in trên template' },
  { key: 'prev', icon: 'photo_library', title: 'Mockup / Preview' },
  { key: 'mock', icon: 'checkroom', title: 'Mockup xưởng' },
]

const uploadBtn = 'inline-flex items-center gap-xs rounded-lg bg-error text-on-error px-sm py-[3px] text-label-sm font-semibold shadow-card hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap'

function Pane({ icon, title, right, actions, expanded, onToggle, children }: { icon: string; title: string; right: string; actions?: ReactNode; expanded: boolean; onToggle: () => void; children: ReactNode }) {
  return (
    <section aria-label={title} className={`${card} min-w-0 min-h-0 flex flex-col`}>
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
      <div className="p-sm flex flex-col gap-sm flex-1 min-h-0">{children}</div>
    </section>
  )
}

function Gallery({ name, images, empty, tall }: { name: string; images: LightboxImage[]; empty: ReactNode; tall: boolean }) {
  const lightbox = useLightbox()
  const [i, setI] = useState(0)
  const idx = Math.min(i, Math.max(0, images.length - 1))
  const cur = images[idx]
  const step = (d: number) => setI((idx + d + images.length) % images.length)
  return (
    <>
      <div className={`relative flex-1 ${tall ? 'min-h-[520px]' : 'min-h-[180px]'} rounded-lg border border-outline-variant/20 bg-surface-container-low overflow-hidden`}>
        {cur
          ? <button type="button" onClick={() => lightbox?.open(cur.url, cur)} aria-label={`Phóng to: ${cur.label}`} title="Bấm để phóng to" className="absolute inset-0 cursor-zoom-in">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={cur.url} alt={cur.label} className="absolute inset-0 w-full h-full object-contain p-sm" loading="lazy" />
            </button>
          : <div className="absolute inset-0 grid place-items-center p-md text-label-sm text-on-surface-variant text-center">{empty}</div>}
      </div>
      <div className="h-6 flex items-center gap-xs text-label-sm text-on-surface-variant">
        <span className="truncate flex-1" title={cur?.label}>{cur?.label ?? '—'}</span>
        {images.length > 1 && (
          <span className="flex items-center gap-[2px] shrink-0">
            <button type="button" onClick={() => step(-1)} aria-label={`${name}: ảnh trước`} className="rounded hover:bg-surface-container-low leading-none"><Icon name="chevron_left" className="text-[18px]" /></button>
            <span>{idx + 1}/{images.length}</span>
            <button type="button" onClick={() => step(1)} aria-label={`${name}: ảnh sau`} className="rounded hover:bg-surface-container-low leading-none"><Icon name="chevron_right" className="text-[18px]" /></button>
          </span>
        )}
      </div>
    </>
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
  const [guides, setGuides] = useStoredGuides()
  const [pickedArea, setPickedArea] = useState('')
  const fileInput = useRef<HTMLInputElement>(null)
  const manyInput = useRef<HTMLInputElement>(null)
  const mockInput = useRef<HTMLInputElement>(null)
  const pending = useRef('')
  const up = useArtworkUpload(detail.task.taskKey, onChanged)
  const mockUp = useArtworkUpload(detail.task.taskKey, onChanged)
  const [mockOver, setMockOver] = useState(false)
  const remover = useArtworkRemove(onChanged)
  const lightbox = useLightbox()
  const hasSlots = detail.slots.length > 0
  const targetArea = detail.slots.includes(pickedArea) ? pickedArea : (detail.slots[0] ?? '')
  const uploading = up.active[0]
  const busy = uploading ? { area: uploading.part ?? uploading.name, pct: uploading.pct, label: up.busyLabel(uploading.pct), more: up.active.length - 1 } : null

  function pick(area: string) {
    pending.current = area
    if (detail.slots.includes(area)) setPickedArea(area)
    fileInput.current?.click()
  }

  const canvasUpload: CanvasUpload = {
    onDrop: (area, files) => { if (area && files.length === 1) up.upload(area, files[0]); else up.uploadFiles(files, { kind: 'PRINT' }) },
    onReject: msg => up.setError(msg), onPick: pick, onPickMany: () => manyInput.current?.click(), fallbackArea: targetArea, busy,
  }

  function addMockups(files: File[]) {
    const images = files.filter(f => /\.(png|jpe?g)$/i.test(f.name))
    if (images.length < files.length) mockUp.setError('Mockup chỉ nhận ảnh PNG hoặc JPG')
    mockUp.uploadFiles(images, { kind: 'MOCKUP' })
  }
  const dragHasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files')
  const artActions: CanvasArtActions = {
    onView: a => lightbox?.open(a.url, artworkImage(a)),
    onRemove: remover.ask,
    canRemove: a => canRemoveArtwork(a, detail.me, detail.task.status),
  }

  const areaNames = template?.areas.map(a => a.name) ?? []
  const hasSides = areaNames.some(n => n.startsWith('Front')) && areaNames.some(n => n.startsWith('Back'))
  const newest = printFiles(line, detail.slots).filter(isImage)
  const shownArt = hasSides ? newest.filter(a => a.printArea.startsWith(side)) : newest
  const mockups = mockupFiles(line)
  // Mockups the designer uploaded come first; without one the pane shows what it always did.
  const mockImages: LightboxImage[] = mockups.length > 0
    ? mockups.filter(isImage).map(artworkImage)
    : newest.length > 0
      ? shownArt.map(artworkImage)
      : line.sourcePrintFiles.map(f => ({ url: f.url, label: `File nguồn · ${f.printArea}` }))
  const previewImages: LightboxImage[] = [
    ...(line.previewUrl ? [{ url: line.previewUrl, label: 'Preview khách tạo lúc đặt hàng' }] : []),
    ...(line.imageUrl ? [{ url: line.imageUrl, label: line.previewUrl ? 'Ảnh variant (Shopify)' : 'Ảnh variant/sản phẩm Shopify (chưa có preview riêng)' }] : []),
  ]

  const right: Record<PaneKey, string> = {
    tpl: template ? `${template.name} · ${template.widthPx}×${template.heightPx} · ${template.dpi} DPI` : 'chưa có template',
    prev: line.previewUrl ? 'preview lúc đặt' : line.imageUrl ? 'ảnh Shopify' : 'chưa có ảnh',
    mock: mockups.length > 0 ? `${mockups.length} mockup đã upload` : newest.length > 0 ? 'từ file in · chưa dựng lên áo' : 'file nguồn',
  }

  const actions: Partial<Record<PaneKey, ReactNode>> = {
    tpl: (
      <span className="flex items-center gap-xs normal-case tracking-normal font-medium">
        {detail.slots.length > 1 && (
          <select value={targetArea} onChange={e => setPickedArea(e.target.value)} aria-label="Vùng in để upload" className={`${input} py-[2px] text-label-sm max-w-[120px]`}>
            {detail.slots.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <input ref={fileInput} type="file" accept={ARTWORK_ACCEPT} hidden aria-label={`Chọn file cho ${targetArea || 'file in'}`}
          onChange={e => {
            const f = e.target.files?.[0]
            const area = pending.current || targetArea
            pending.current = ''
            if (f && area) up.upload(area, f)
            else if (f) up.uploadFiles([f], { kind: 'PRINT' })
            e.target.value = ''
          }} />
        <input ref={manyInput} type="file" accept={ARTWORK_ACCEPT} multiple hidden aria-label="Chọn nhiều file in"
          onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; up.uploadFiles(files, { kind: 'PRINT' }) }} />
        {hasSlots ? (
          <button type="button" disabled={up.progress[targetArea] !== undefined} onClick={() => pick(targetArea)}
            title={`Upload vào ${targetArea}`} className={uploadBtn}>
            <Icon name="upload" className="text-[16px]" />Upload vào vùng in
          </button>
        ) : (
          <button type="button" disabled={up.busy} onClick={() => manyInput.current?.click()} title="Chọn một hoặc nhiều file in" className={uploadBtn}>
            <Icon name="upload" className="text-[16px]" />Upload file in
          </button>
        )}
      </span>
    ),
    prev: line.customerDesignLink ? (
      <span className="normal-case tracking-normal font-medium"><ExtLink href={line.customerDesignLink}>Mở lại thiết kế ↗</ExtLink></span>
    ) : undefined,
    mock: (
      <span className="flex items-center gap-xs normal-case tracking-normal font-medium">
        {hasSides && mockups.length === 0 && newest.length > 0 && (
          <span className="flex items-center gap-xs" role="group" aria-label="Mặt mockup">
            {(['Front', 'Back'] as Side[]).map(s => (
              <button key={s} type="button" aria-pressed={side === s} onClick={() => setSide(s)} className={chip(side === s)}>{s === 'Front' ? 'Trước' : 'Sau'}</button>
            ))}
          </span>
        )}
        <input ref={mockInput} type="file" accept={MOCKUP_ACCEPT} multiple hidden aria-label="Chọn ảnh mockup"
          onChange={e => { const files = Array.from(e.target.files ?? []); e.target.value = ''; addMockups(files) }} />
        <button type="button" disabled={mockUp.busy} onClick={() => mockInput.current?.click()} title="Upload một hoặc nhiều ảnh mockup — vào cùng thư mục Drive của task"
          className="inline-flex items-center gap-xs rounded-lg border border-outline-variant/40 bg-surface-container-lowest px-sm py-[3px] text-label-sm font-semibold text-on-surface hover:bg-surface-container-low disabled:opacity-40 whitespace-nowrap">
          <Icon name="upload" className="text-[16px]" />Upload mockup
        </button>
      </span>
    ),
  }

  const body: Record<PaneKey, (tall: boolean) => ReactNode> = {
    tpl: () => (
      <>
        {template && (
          <CanvasTools bg={bg} onBg={setBg} guide={guide} onGuide={setGuide} hasGuide={!!template.guideImageUrl}
            guides={guides} onGuides={setGuides} hasBleed={template.bleedIn > 0} />
        )}
        <ErrorBanner msg={up.error} onClose={() => up.setError('')} />
        {Object.entries(up.warnings).map(([area, msg]) => <Note key={area} tone="warn" icon="cloud_off">{area}: {msg}</Note>)}
        <TemplateCanvas template={template} line={line} slots={detail.slots} bg={bg} guide={guide} guides={guides} upload={canvasUpload} artActions={artActions} />
      </>
    ),
    prev: tall => <Gallery name="Mockup / Preview" images={previewImages} tall={tall} empty="Không có preview hay ảnh sản phẩm — bấm Nạp lại từ Shopify" />,
    mock: tall => (
      <div className={`flex flex-col gap-sm flex-1 min-h-0 rounded-lg ${mockOver ? 'outline outline-2 outline-secondary bg-secondary/10' : ''}`}
        title="Kéo thả ảnh mockup vào đây để tải lên"
        onDragOver={e => { if (!dragHasFiles(e)) return; e.preventDefault(); if (!mockOver) setMockOver(true) }}
        onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setMockOver(false) }}
        onDrop={e => { if (!dragHasFiles(e)) return; e.preventDefault(); setMockOver(false); addMockups(Array.from(e.dataTransfer.files ?? [])) }}>
        <ErrorBanner msg={mockUp.error} onClose={() => mockUp.setError('')} />
        <Gallery key={`${side}-${mockups.length}`} name="Mockup xưởng" images={mockImages} tall={tall}
          empty="Chưa có mockup hay file in — kéo thả ảnh mockup vào đây, hoặc bấm Upload mockup" />
        <UploadList items={mockUp.items} onDismiss={mockUp.dismiss} />
      </div>
    ),
  }

  const render = (p: typeof PANES[number], tall = false) => (
    <Pane key={p.key} icon={p.icon} title={p.title} right={right[p.key]} actions={actions[p.key]} expanded={expand === p.key} onToggle={() => setExpand(expand === p.key ? null : p.key)}>
      {body[p.key](tall)}
    </Pane>
  )

  if (expand) {
    const p = PANES.find(x => x.key === expand)!
    return (
      <div className="flex flex-col gap-sm">
        {remover.dialog}
        {render(p, true)}
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

  return (
    <div className="grid grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-md items-stretch">
      {remover.dialog}
      {render(PANES[0])}
      <div className="grid grid-rows-2 gap-md min-w-0 min-h-0">
        {render(PANES[1])}
        {render(PANES[2])}
      </div>
    </div>
  )
}
