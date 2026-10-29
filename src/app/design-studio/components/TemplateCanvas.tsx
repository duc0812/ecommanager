'use client'
import { useEffect, useId, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import type { ArtworkRow, TemplateArea, TemplateRow, WorkspaceLine } from './types'
import { isImage, newestFor, printFiles, sharpnessRatio } from './model'
import { ALL_GUIDES, NO_GUIDES, areaAt, clientToTemplate, type Guides, type ViewBox } from './canvas-guides'
import { Icon, chip } from './ui'
import { ArtImg, SvgArtImage } from './art-src'

export type CanvasBg = 'checker' | 'white' | 'black'
export type CanvasUpload = {
  /** `area` null = the files name their own part (several files dropped at once, or a product without a template). */
  onDrop: (area: string | null, files: File[]) => void
  onReject: (msg: string) => void
  onPick: (area: string) => void
  /** Opens the picker for any number of files; each file name becomes its own part. */
  onPickMany: () => void
  fallbackArea: string
  busy: { area: string; pct: number; label: string; more: number } | null
}
export type CanvasArtActions = {
  onView: (a: ArtworkRow) => void
  onRemove: (a: ArtworkRow) => void
  canRemove: (a: ArtworkRow) => { ok: boolean; why?: string }
}

const W = 1200

function sheetGeometry(template: TemplateRow): { k: number; H: number; viewBox: ViewBox } {
  const k = W / template.widthPx
  const H = Math.round(template.heightPx * k)
  return { k, H, viewBox: { x: -30, y: -22, w: W + 60, h: H + 50 } }
}

function useNaturalSize(url: string | null): { w: number; h: number } | null {
  const [size, setSize] = useState<{ url: string; w: number; h: number } | null>(null)
  useEffect(() => {
    if (!url) return
    let alive = true
    const img = new Image()
    img.onload = () => { if (alive) setSize({ url, w: img.naturalWidth, h: img.naturalHeight }) }
    img.src = url
    return () => { alive = false }
  }, [url])
  return size && size.url === url ? { w: size.w, h: size.h } : null
}

function fit(box: { x: number; y: number; w: number; h: number }, w: number, h: number) {
  const s = Math.min(box.w / w, box.h / h)
  const aw = w * s, ah = h * s
  return { x: box.x + (box.w - aw) / 2, y: box.y + (box.h - ah) / 2, w: aw, h: ah, s }
}

export function CanvasTools({ bg, onBg, guide, onGuide, hasGuide, guides, onGuides, hasBleed = true }: {
  bg: CanvasBg; onBg: (b: CanvasBg) => void; guide: number; onGuide: (n: number) => void; hasGuide: boolean
  guides?: Guides; onGuides?: (g: Guides) => void; hasBleed?: boolean
}) {
  const swatches: { k: CanvasBg; label: string; cls: string }[] = [
    { k: 'checker', label: 'Nền ô cờ', cls: 'bg-[repeating-conic-gradient(theme(colors.outline-variant)_0_25%,theme(colors.surface-container-lowest)_0_50%)] bg-[length:8px_8px]' },
    { k: 'white', label: 'Nền trắng', cls: 'bg-white' },
    { k: 'black', label: 'Nền đen', cls: 'bg-black' },
  ]
  const toggles: { k: keyof Guides; label: string; show: boolean }[] = [
    { k: 'areas', label: 'Vùng in', show: true },
    { k: 'safe', label: 'An toàn', show: true },
    { k: 'bleed', label: 'Bleed', show: hasBleed },
    { k: 'guide', label: 'Artguide', show: hasGuide },
  ]
  const shown = toggles.filter(t => t.show)
  const allOff = !!guides && shown.every(t => !guides[t.k])
  const showSlider = hasGuide && (!guides || guides.guide)
  return (
    <div className="flex items-center gap-md flex-wrap text-label-sm text-on-surface-variant">
      <span className="inline-flex items-center gap-xs">Nền
        {swatches.map(s => (
          <button key={s.k} type="button" aria-label={s.label} aria-pressed={bg === s.k} title={s.label} onClick={() => onBg(s.k)}
            className={`w-[18px] h-[18px] rounded border border-outline-variant ${s.cls} ${bg === s.k ? 'outline outline-2 outline-offset-1 outline-secondary' : ''}`} />
        ))}
      </span>
      {guides && onGuides && (
        <span className="inline-flex items-center gap-xs flex-wrap" role="group" aria-label="Hiện guide">
          {shown.map(t => (
            <button key={t.k} type="button" aria-pressed={guides[t.k]} onClick={() => onGuides({ ...guides, [t.k]: !guides[t.k] })} className={chip(guides[t.k])}>
              {t.label}
            </button>
          ))}
          <button type="button" onClick={() => onGuides(allOff ? ALL_GUIDES : NO_GUIDES)} className={chip(false)}>
            <Icon name={allOff ? 'visibility' : 'visibility_off'} className="text-[14px]" />{allOff ? 'Hiện lại guide' : 'Chỉ xem artwork'}
          </button>
        </span>
      )}
      {showSlider && (
        <label className="inline-flex items-center gap-xs">{guides ? 'Độ mờ' : 'Artguide'}
          <input type="range" min={0} max={100} value={guide} onChange={e => onGuide(Number(e.target.value))} className="w-24 accent-secondary" aria-label="Độ mờ artguide" />
          <span className="w-8 text-right">{guide}%</span>
        </label>
      )}
    </div>
  )
}

type AreaBox = { x: number; y: number; w: number; h: number }
type AreaPct = { left: string; top: string; width: string; height: string }

function Sheet({ template, bg, guide, guides, renderArea, overlay, underlay, legend, svgRef, highlight, frameProps, frameOverlay, areaLayer, maxVh, compact }: {
  template: TemplateRow; bg: CanvasBg; guide: number; guides: Guides
  /** Caps the sheet's height to this share of the viewport, keeping its proportions. */
  maxVh?: number
  /** Legend and rulers go into the frame's tooltip instead of a line under the sheet. */
  compact?: boolean
  renderArea: (a: TemplateArea, box: AreaBox) => ReactNode
  overlay: (k: number) => ReactNode
  underlay?: (k: number, W: number, H: number) => ReactNode
  legend: ReactNode
  svgRef?: Ref<SVGSVGElement>
  highlight?: AreaBox | null
  frameProps?: HTMLAttributes<HTMLDivElement>
  frameOverlay?: ReactNode
  areaLayer?: (a: TemplateArea, index: number) => ReactNode
}) {
  const rawId = useId()
  const patternId = `ck${rawId.replace(/[^a-zA-Z0-9]/g, '')}`
  const { k, H, viewBox } = sheetGeometry(template)
  const bleed = template.bleedIn * template.dpi * k
  const safe = template.safeIn * template.dpi * k
  const showBleed = guides.bleed && template.bleedIn > 0
  const bgFill = bg === 'checker' ? `url(#${patternId})` : undefined
  const bgCls = bg === 'white' ? 'fill-white' : bg === 'black' ? 'fill-black' : ''

  const pct = (a: TemplateArea): AreaPct => ({
    left: `${((a.x * k - viewBox.x) / viewBox.w) * 100}%`, top: `${((a.y * k - viewBox.y) / viewBox.h) * 100}%`,
    width: `${((a.w * k) / viewBox.w) * 100}%`, height: `${((a.h * k) / viewBox.h) * 100}%`,
  })

  const ratio = viewBox.w / viewBox.h
  const legendText = [
    showBleed && `nét đỏ = bleed ${template.bleedIn}″`,
    guides.safe && `nét xanh = an toàn ${template.safeIn}″`,
    template.guideImageUrl && guides.guide && 'lớp artguide',
    guides.areas && 'xám = panel phải phủ kín',
    template.mirror && 'xưởng in mirror',
    `${template.widthPx}×${template.heightPx} px`,
  ].filter(Boolean).join(' · ')

  return (
    <div className="flex flex-col gap-sm flex-1 min-h-0">
      <div {...frameProps} title={compact ? frameProps?.title ? `${frameProps.title} — ${legendText}` : legendText : frameProps?.title}
        className={`relative flex-1 rounded-lg ${compact ? '' : 'border border-outline-variant/20 bg-surface-container-low p-sm'} grid place-items-center overflow-hidden ${frameProps?.className ?? ''}`}>
        <div className="relative w-full mx-auto" style={maxVh ? { width: `min(100%, calc(${maxVh}vh * ${ratio.toFixed(4)}))` } : undefined}>
        <svg ref={svgRef} viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.w} ${viewBox.h}`} role="img" aria-label={`Template ${template.name}`} className="block max-w-full h-auto w-full">
          <defs>
            <pattern id={patternId} width="18" height="18" patternUnits="userSpaceOnUse">
              <rect width="18" height="18" className="fill-surface-container-lowest" />
              <rect width="9" height="9" className="fill-surface-container" />
              <rect x="9" y="9" width="9" height="9" className="fill-surface-container" />
            </pattern>
          </defs>
          <rect width={W} height={H} fill={bgFill} className={bgCls} />
          {underlay?.(k, W, H)}
          {template.areas.map(a => {
            const x = a.x * k, y = a.y * k, w = a.w * k, h = a.h * k
            return (
              <g key={a.name}>
                {guides.areas && <rect x={x} y={y} width={w} height={h} className="fill-outline/20 stroke-outline-variant" />}
                {renderArea(a, { x, y, w, h })}
                {showBleed && <rect x={x + bleed} y={y + bleed} width={Math.max(0, w - 2 * bleed)} height={Math.max(0, h - 2 * bleed)} fill="none" strokeWidth="1.2" strokeDasharray="5 4" className="stroke-error" />}
                {guides.safe && <rect x={x + safe} y={y + safe} width={Math.max(0, w - 2 * safe)} height={Math.max(0, h - 2 * safe)} fill="none" strokeWidth="1.2" strokeDasharray="3 4" className="stroke-on-tertiary-container" />}
                {guides.areas && <text x={x + 6} y={y + 14} fontSize="10" className="fill-on-surface-variant font-mono">{a.name} · {a.w}×{a.h}</text>}
              </g>
            )
          })}
          {overlay(k)}
          {template.guideImageUrl && guides.guide && (
            <image href={template.guideImageUrl} x={0} y={0} width={W} height={H} preserveAspectRatio="none" opacity={guide / 100} pointerEvents="none" />
          )}
          {highlight && <rect x={highlight.x} y={highlight.y} width={highlight.w} height={highlight.h} strokeWidth="3" className="fill-secondary/20 stroke-secondary" pointerEvents="none" />}
          <rect width={W} height={H} fill="none" className="stroke-outline-variant" />
          {!compact && <g fontSize="11" className="fill-on-surface-variant font-mono">
            <line x1="0" y1={H + 12} x2={W} y2={H + 12} className="stroke-outline-variant" />
            <text x={W / 2} y={H + 26} textAnchor="middle">{template.widthPx} px</text>
            <line x1="-12" y1="0" x2="-12" y2={H} className="stroke-outline-variant" />
            <text x="-16" y={H / 2} textAnchor="middle" transform={`rotate(-90 -16 ${H / 2})`}>{template.heightPx} px</text>
          </g>}
        </svg>
        {areaLayer && (
          <div className="absolute inset-0 pointer-events-none">
            {template.areas.map((a, i) => <div key={`${a.name}-${i}`} className="absolute" style={pct(a)}>{areaLayer(a, i)}</div>)}
          </div>
        )}
        </div>
        {frameOverlay}
      </div>
      {!compact && <div className="flex gap-md flex-wrap text-label-sm text-on-surface-variant">
        {showBleed && <span className="inline-flex items-center gap-xs text-error"><i className="inline-block w-3.5 border-t-2 border-dashed border-current" />bleed {template.bleedIn}″</span>}
        {guides.safe && <span className="inline-flex items-center gap-xs text-on-tertiary-container"><i className="inline-block w-3.5 border-t-2 border-dashed border-current" />an toàn {template.safeIn}″</span>}
        {template.guideImageUrl && guides.guide && <span className="inline-flex items-center gap-xs text-secondary"><Icon name="layers" className="text-[14px]" />artguide</span>}
        {legend}
        {guides.areas && <span>xám = panel phải phủ kín</span>}
        {template.mirror && <span className="text-amber-900">mirror</span>}
      </div>}
      {compact && legend && <div className="flex gap-md flex-wrap text-label-sm">{legend}</div>}
    </div>
  )
}

function FittedImage({ url, area, size, label, k }: { url: string; area: TemplateArea; size: { w: number; h: number } | null; label: string; k: number }) {
  if (!size) return <image href={url} x={area.x * k} y={area.y * k} width={area.w * k} height={area.h * k} preserveAspectRatio="xMidYMid meet" />
  const box = fit(area, size.w, size.h)
  return (
    <g>
      <image href={url} x={box.x * k} y={box.y * k} width={box.w * k} height={box.h * k} preserveAspectRatio="xMidYMid meet" />
      <rect x={box.x * k} y={box.y * k} width={box.w * k} height={box.h * k} fill="none" strokeWidth="1.5" className="stroke-amber-500" />
      <text x={box.x * k + 4} y={(box.y + box.h) * k - 6} fontSize="10" className="fill-amber-600 font-mono">
        {label} {size.w}×{size.h} → ×{box.s.toFixed(1)}
      </text>
    </g>
  )
}

function OverlayLegend({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center gap-xs text-amber-600"><i className="inline-block w-3.5 border-t-2 border-current" />{children}</span>
}

function hasFiles(e: DragEvent) {
  return Array.from(e.dataTransfer?.types ?? []).includes('Files')
}

const MANY = '\u0000many'

function UploadOverlay({ busy, target }: { busy: CanvasUpload['busy']; target: string | null }) {
  if (busy) {
    return (
      <div role="status" aria-live="polite" className="absolute left-1/2 bottom-md -translate-x-1/2 z-10 w-[420px] max-w-[90%] flex items-center gap-sm rounded-lg bg-surface-container-lowest border border-outline-variant/60 shadow-overlay px-[14px] py-[10px] pointer-events-none">
        <Icon name="upload" className="text-[22px] text-secondary" />
        <div className="flex-1 min-w-0 flex flex-col gap-xs">
          <div className="flex gap-sm text-body-sm">
            <span className="font-semibold truncate">{busy.area}</span>
            <span className="ml-auto font-mono text-label-sm text-on-surface-variant">{busy.pct}%</span>
          </div>
          <div className="h-1.5 rounded-full bg-surface-container overflow-hidden" role="progressbar" aria-label={`Tiến độ tải ${busy.area}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={busy.pct}>
            <div className="h-full rounded-full bg-secondary transition-all" style={{ width: `${busy.pct}%` }} />
          </div>
          <span className="text-label-sm text-on-surface-variant">{busy.label}{busy.more > 0 ? ` · còn ${busy.more} file chờ tải` : ''}</span>
        </div>
      </div>
    )
  }
  if (target === null) return null
  return (
    <div className="absolute top-sm left-1/2 -translate-x-1/2 z-10 rounded-full bg-secondary text-on-secondary px-sm py-[2px] text-label-sm font-semibold pointer-events-none whitespace-nowrap">
      {target === MANY ? 'Thả để tải lên — mỗi tên file là một file riêng' : target ? `Thả để tải vào ${target}` : 'Kéo vào một vùng in'}
    </div>
  )
}

/** The empty-area call to action: a dashed box that opens the picker for that area; files can also be dropped on it. */
export function UploadCta({ area, onPick, disabled, size = 'lg' }: { area: string; onPick: (area: string) => void; disabled?: boolean; size?: 'lg' | 'sm' }) {
  return (
    <button type="button" disabled={disabled} onClick={e => { e.stopPropagation(); onPick(area) }} aria-label={`Upload file in cho vùng ${area}`}
      className="pointer-events-auto absolute inset-[6%] flex flex-col items-center justify-center gap-[2px] rounded-lg border-[1.5px] border-dashed border-amber-500 bg-amber-50/80 text-amber-900 text-center hover:bg-amber-100/90 disabled:opacity-50 disabled:cursor-not-allowed overflow-hidden">
      <Icon name="add_photo_alternate" className={size === 'lg' ? 'text-[28px]' : 'text-[18px]'} />
      {size === 'lg'
        ? <><span className="text-body-sm font-semibold">Kéo thả file in vào vùng {area}</span><span className="text-label-sm">hoặc bấm để chọn file</span></>
        : <span className="text-[11px] leading-[14px] font-semibold px-[2px] break-words">{area}</span>}
    </button>
  )
}

const tool = 'pointer-events-auto inline-flex items-center gap-[2px] rounded-md bg-surface-container-lowest/95 border border-outline-variant/40 px-xs py-[2px] text-label-sm font-semibold text-on-surface shadow-card hover:bg-surface-container-low disabled:opacity-50 disabled:cursor-not-allowed'

export function ArtToolbar({ art, actions, onPick }: { art: ArtworkRow; actions?: CanvasArtActions | null; onPick?: (area: string) => void }) {
  const removable = actions?.canRemove(art) ?? { ok: false }
  return (
    <span className="flex items-center gap-[2px] flex-wrap justify-end">
      {actions && isImage(art) && (
        <button type="button" onClick={e => { e.stopPropagation(); actions.onView(art) }} className={tool} aria-label={`Xem ${art.printArea} v${art.version}`}>
          <Icon name="zoom_in" className="text-[14px]" />Xem
        </button>
      )}
      {onPick && (
        <button type="button" onClick={e => { e.stopPropagation(); onPick(art.printArea) }} className={tool} aria-label={`Thay file ${art.printArea}`}>
          <Icon name="upload" className="text-[14px]" />Thay file
        </button>
      )}
      {actions && (
        <button type="button" onClick={e => { e.stopPropagation(); actions.onRemove(art) }} disabled={!removable.ok} title={removable.why}
          className={`${tool} text-error`} aria-label={`Xoá ${art.printArea} v${art.version}`}>
          <Icon name="delete" className="text-[14px]" />Xoá
        </button>
      )}
    </span>
  )
}

/** `resolve` names the area under the pointer; MANY means "anywhere — the files name their own part". */
function useDropZone(upload: CanvasUpload | null | undefined, resolve: (e: DragEvent) => string | null, title = 'Kéo thả file vào một vùng in để tải lên') {
  const [drag, setDrag] = useState<string | null>(null)
  const dropAllowed = !!upload && !upload.busy
  const frameProps: HTMLAttributes<HTMLDivElement> | undefined = upload ? {
    title: upload.busy ? 'Đang tải file lên — chờ xong rồi thả tiếp' : title,
    onDragOver: e => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const several = e.dataTransfer.items && e.dataTransfer.items.length > 1
      const a = !dropAllowed ? null : several ? MANY : resolve(e)
      e.dataTransfer.dropEffect = a ? 'copy' : 'none'
      const next = a ?? ''
      if (next !== drag) setDrag(next)
    },
    onDragLeave: e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(null) },
    onDrop: e => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDrag(null)
      if (!dropAllowed) return
      const files = Array.from(e.dataTransfer.files ?? [])
      if (files.length === 0) return
      // Several files at once go by their names: `Front.png` lands on the area "Front", any other name becomes its own file.
      if (files.length > 1) { upload.onDrop(null, files); return }
      const a = resolve(e)
      if (!a) { upload.onReject('Thả file vào trong một vùng in'); return }
      upload.onDrop(a === MANY ? null : a, files)
    },
  } : undefined
  return { drag, frameProps }
}

function NoTemplateCanvas({ line, upload, artActions, selected }: { line: WorkspaceLine; upload?: CanvasUpload | null; artActions?: CanvasArtActions | null; selected?: string }) {
  const files = printFiles(line, [])
  const art = files.find(f => f.printArea === selected) ?? files[0]
  // Only the designer's own print files belong here; the customer's source file is shown with the order info, never as if it were artwork.
  const shown = art && isImage(art) ? art.url : null
  const { drag, frameProps } = useDropZone(upload, () => MANY, 'Kéo thả một hoặc nhiều file vào đây để tải lên')
  return (
    <div {...frameProps} className={`relative min-h-[360px] rounded-lg border-[1.5px] border-dashed ${drag !== null ? 'border-secondary bg-secondary/10' : 'border-outline-variant'} p-md flex flex-col items-center justify-center gap-sm overflow-hidden`}>
      {shown && art && (artActions ? (
        <button type="button" onClick={() => artActions.onView(art)} aria-label={`Xem ${art.printArea} v${art.version} (phóng to)`} className="max-w-full grid place-items-center cursor-zoom-in">
          <ArtImg art={art} px={2000} full alt={`File in ${art.printArea} v${art.version}`} className="max-w-full max-h-[60vh] object-contain" />
        </button>
      ) : (
        <ArtImg art={art} px={2000} full alt="File in hiện có" className="max-w-full max-h-[60vh] object-contain" />
      ))}
      {art && !isImage(art) && (
        <div className="flex items-center gap-sm rounded-lg bg-surface-container-lowest border border-outline-variant/20 px-md py-sm text-body-sm">
          <Icon name="description" className="text-[22px] text-on-surface-variant" />
          <span><b>{art.printArea} · v{art.version}</b> · {art.fileName}</span>
        </div>
      )}
      {files.length === 0 && (
        <div className="flex flex-col items-center gap-xs text-center text-on-surface-variant max-w-[520px]">
          <Icon name="add_photo_alternate" className="text-[40px]" />
          <span className="text-body-md font-semibold text-on-surface">Chưa có template — kéo thả mọi file in của sản phẩm vào đây</span>
          <span className="text-body-sm">Mỗi tên file là một file riêng (front.png, back.png, sleeve.png…), upload lại cùng tên là phiên bản mới.</span>
        </div>
      )}
      {upload && <UploadOverlay busy={upload.busy} target={drag} />}
    </div>
  )
}

function TaskCanvas({ template, line, slots, bg, guide, guides, upload, artActions, selected, maxVh }: TaskProps) {
  const firstArea = template?.areas.find(a => a.name === slots[0]) ?? template?.areas[0]
  const sourceUrl = line.sourcePrintFiles[0]?.url ?? null
  const firstHasArt = !!(firstArea && newestFor(line, firstArea.name))
  const showSource = !!(template && firstArea && sourceUrl && !firstHasArt)
  const sourceSize = useNaturalSize(showSource ? sourceUrl : null)
  const svgRef = useRef<SVGSVGElement>(null)
  const { drag, frameProps } = useDropZone(template ? upload : null, e => {
    const svg = svgRef.current
    if (!svg || !template) return null
    const g = sheetGeometry(template)
    const p = clientToTemplate(svg.getBoundingClientRect(), g.viewBox, g.k, e.clientX, e.clientY)
    return areaAt(template.areas, p.x, p.y)?.name ?? null
  })

  if (!template) return <NoTemplateCanvas line={line} upload={upload} artActions={artActions} selected={selected} />

  const tpl = template
  const { k, H } = sheetGeometry(tpl)
  const singleArea = new Set(tpl.areas.map(a => a.name)).size === 1
  const firstIndex = new Map<string, number>()
  tpl.areas.forEach((a, i) => { if (!firstIndex.has(a.name)) firstIndex.set(a.name, i) })

  const dragArea = drag ? tpl.areas.find(a => a.name === drag) : undefined
  const highlight = dragArea ? (singleArea ? { x: 0, y: 0, w: W, h: H } : { x: dragArea.x * k, y: dragArea.y * k, w: dragArea.w * k, h: dragArea.h * k }) : null

  return (
    <Sheet
      template={tpl} bg={bg} guide={guide} guides={guides} svgRef={svgRef} highlight={highlight} frameProps={frameProps} maxVh={maxVh} compact
      frameOverlay={upload ? <UploadOverlay busy={upload.busy} target={drag} /> : null}
      renderArea={(a, { x, y, w, h }) => {
        const art = newestFor(line, a.name)
        return (
          <>
            {art && isImage(art) && <SvgArtImage art={art} px={2000} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" />}
            {art && !isImage(art) && <text x={x + w / 2} y={y + h / 2} textAnchor="middle" fontSize="11" className="fill-on-surface-variant font-mono">{art.fileName}</text>}
            {selected === a.name && !singleArea && <rect x={x} y={y} width={w} height={h} fill="none" strokeWidth="2.5" className="stroke-secondary" pointerEvents="none" />}
          </>
        )
      }}
      areaLayer={(a, i) => {
        if (firstIndex.get(a.name) !== i) return null
        const art = newestFor(line, a.name)
        if (!art) {
          if (!upload || !slots.includes(a.name)) return null
          return <UploadCta area={a.name} onPick={upload.onPick} disabled={!!upload.busy} size={tpl.areas.length > 2 || a.w * k < 240 ? 'sm' : 'lg'} />
        }
        const ratio = sharpnessRatio(tpl, art)
        return (
          <>
            {artActions && isImage(art) && (
              <button type="button" onClick={() => artActions.onView(art)} aria-label={`Xem ${a.name} v${art.version} (phóng to)`} className="pointer-events-auto absolute inset-0 cursor-zoom-in" />
            )}
            {ratio !== null && ratio < 0.95 && (
              <span title={`File ${art.widthPx}×${art.heightPx} — cần ${a.w}×${a.h}`}
                className="absolute top-xs left-xs inline-flex items-center gap-[2px] h-6 px-sm rounded-full bg-error text-on-error text-label-sm font-semibold whitespace-nowrap">
                <Icon name="error" className="text-[14px]" />{art.widthPx}×{art.heightPx} · {Math.round(ratio * 100)}% DPI
              </span>
            )}
          </>
        )
      }}
      overlay={kk => (showSource && sourceUrl && firstArea ? <FittedImage url={sourceUrl} area={firstArea} size={sourceSize} label="khối nguồn" k={kk} /> : null)}
      legend={showSource && <OverlayLegend>khung vàng = file nguồn của khách, chưa phải file in</OverlayLegend>}
    />
  )
}

function StandaloneCanvas({ template, masterUrl, bg, guide }: { template: TemplateRow; masterUrl: string | null; bg: CanvasBg; guide: number }) {
  const firstArea = template.areas[0]
  const showMaster = !!(firstArea && masterUrl)
  const size = useNaturalSize(showMaster ? masterUrl : null)
  return (
    <Sheet
      template={template} bg={bg} guide={guide} guides={ALL_GUIDES}
      renderArea={() => null}
      overlay={k => (showMaster && masterUrl && firstArea ? <FittedImage url={masterUrl} area={firstArea} size={size} label="master" k={k} /> : null)}
      legend={showMaster && <OverlayLegend>master artwork</OverlayLegend>}
    />
  )
}

export type CanvasText = {
  key: string; label: string; box: { x: number; y: number; w: number; h: number }
  text?: { value: string; font: string; sizePx: number; color: string; align: 'left' | 'center' | 'right'; anchor: 'top' | 'center' | 'bottom'; tracking: number; stroke?: { px: number; color: string } }
}

export function LibraryCanvas({ template, imageUrl, boxes, bg, guide, guides, showBoxes = true }: {
  template: TemplateRow; imageUrl: string | null; boxes: CanvasText[]; bg: CanvasBg; guide: number; guides: Guides; showBoxes?: boolean
}) {
  return (
    <Sheet
      template={template} bg={bg} guide={guide} guides={guides}
      renderArea={() => null}
      underlay={(_k, w, h) => (imageUrl ? <image href={imageUrl} x={0} y={0} width={w} height={h} preserveAspectRatio="none" /> : null)}
      overlay={k => (
        <g>
          {boxes.map(b => {
            const x = b.box.x * k, y = b.box.y * k, w = b.box.w * k, h = b.box.h * k
            const t = b.text
            const tx = !t || t.align === 'left' ? x : t.align === 'right' ? x + w : x + w / 2
            const ty = !t || t.anchor === 'top' ? y : t.anchor === 'bottom' ? y + h : y + h / 2
            return (
              <g key={b.key}>
                {t && (
                  <text x={tx} y={ty} fontFamily={`"${t.font}"`} fontSize={t.sizePx * k} fill={t.color}
                    textAnchor={t.align === 'left' ? 'start' : t.align === 'right' ? 'end' : 'middle'}
                    dominantBaseline={t.anchor === 'top' ? 'hanging' : t.anchor === 'bottom' ? 'text-after-edge' : 'central'}
                    letterSpacing={(t.tracking / 1000) * t.sizePx * k}
                    stroke={t.stroke?.color} strokeWidth={t.stroke ? t.stroke.px * 2 * k : undefined} paintOrder="stroke">
                    {t.value}
                  </text>
                )}
                {showBoxes && <rect x={x} y={y} width={w} height={h} fill="none" strokeWidth="1.5" strokeDasharray="6 3" className="stroke-secondary" />}
                {showBoxes && <text x={x + 3} y={y - 4} fontSize="11" className="fill-secondary font-mono">{b.label}</text>}
              </g>
            )
          })}
        </g>
      )}
      legend={showBoxes && boxes.length > 0 && <span className="inline-flex items-center gap-xs text-secondary"><i className="inline-block w-3.5 border-t-2 border-dashed border-current" />khung trường custom</span>}
    />
  )
}

type TaskProps = {
  template: TemplateRow | null; line: WorkspaceLine; slots: string[]; bg: CanvasBg; guide: number; guides: Guides; upload?: CanvasUpload | null; artActions?: CanvasArtActions | null
  /** The area the header's Upload goes to; outlined on the sheet. */
  selected?: string
  maxVh?: number
}
type StandaloneProps = { template: TemplateRow; masterUrl?: string | null; line?: undefined; slots?: undefined; bg?: CanvasBg; guide?: number }

export default function TemplateCanvas(props: (Omit<TaskProps, 'guides'> & { guides?: Guides }) | StandaloneProps) {
  if (props.line) return <TaskCanvas template={props.template} line={props.line} slots={props.slots} bg={props.bg} guide={props.guide} guides={props.guides ?? ALL_GUIDES} upload={props.upload} artActions={props.artActions} selected={props.selected} maxVh={props.maxVh} />
  const p = props as StandaloneProps
  return <StandaloneCanvas template={p.template} masterUrl={p.masterUrl ?? null} bg={p.bg ?? 'checker'} guide={p.guide ?? 50} />
}
