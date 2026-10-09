'use client'
import { useEffect, useId, useRef, useState, type DragEvent, type HTMLAttributes, type ReactNode, type Ref } from 'react'
import type { TemplateArea, TemplateRow, WorkspaceLine } from './types'
import { isImage, newestFor, newestArtwork } from './model'
import { ALL_GUIDES, NO_GUIDES, areaAt, clientToTemplate, type Guides, type ViewBox } from './canvas-guides'
import { Icon, Note, chip } from './ui'

export type CanvasBg = 'checker' | 'white' | 'black'
export type CanvasUpload = {
  onDrop: (area: string, file: File) => void
  onReject: (msg: string) => void
  busy: { area: string; pct: number; label: string } | null
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

function Sheet({ template, bg, guide, guides, renderArea, overlay, underlay, legend, svgRef, highlight, frameProps, frameOverlay }: {
  template: TemplateRow; bg: CanvasBg; guide: number; guides: Guides
  renderArea: (a: TemplateArea, box: AreaBox) => ReactNode
  overlay: (k: number) => ReactNode
  underlay?: (k: number, W: number, H: number) => ReactNode
  legend: ReactNode
  svgRef?: Ref<SVGSVGElement>
  highlight?: AreaBox | null
  frameProps?: HTMLAttributes<HTMLDivElement>
  frameOverlay?: ReactNode
}) {
  const rawId = useId()
  const patternId = `ck${rawId.replace(/[^a-zA-Z0-9]/g, '')}`
  const { k, H, viewBox } = sheetGeometry(template)
  const bleed = template.bleedIn * template.dpi * k
  const safe = template.safeIn * template.dpi * k
  const showBleed = guides.bleed && template.bleedIn > 0
  const bgFill = bg === 'checker' ? `url(#${patternId})` : undefined
  const bgCls = bg === 'white' ? 'fill-white' : bg === 'black' ? 'fill-black' : ''

  return (
    <div className="flex flex-col gap-sm">
      <div {...frameProps} className={`relative rounded-lg border border-outline-variant/20 bg-surface-container-low p-sm grid place-items-center overflow-hidden ${frameProps?.className ?? ''}`}>
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
          <g fontSize="11" className="fill-on-surface-variant font-mono">
            <line x1="0" y1={H + 12} x2={W} y2={H + 12} className="stroke-outline-variant" />
            <text x={W / 2} y={H + 26} textAnchor="middle">{template.widthPx} px</text>
            <line x1="-12" y1="0" x2="-12" y2={H} className="stroke-outline-variant" />
            <text x="-16" y={H / 2} textAnchor="middle" transform={`rotate(-90 -16 ${H / 2})`}>{template.heightPx} px</text>
          </g>
        </svg>
        {frameOverlay}
      </div>
      <div className="flex gap-md flex-wrap text-label-sm text-on-surface-variant">
        {showBleed && <span className="inline-flex items-center gap-xs text-error"><i className="inline-block w-3.5 border-t-2 border-dashed border-current" />bleed {template.bleedIn}″</span>}
        {guides.safe && <span className="inline-flex items-center gap-xs text-on-tertiary-container"><i className="inline-block w-3.5 border-t-2 border-dashed border-current" />an toàn {template.safeIn}″</span>}
        {template.guideImageUrl && guides.guide && <span className="inline-flex items-center gap-xs text-secondary"><Icon name="layers" className="text-[14px]" />artguide</span>}
        {legend}
        {guides.areas && <span>xám = panel phải phủ kín</span>}
        {template.mirror && <span className="text-amber-900">mirror</span>}
      </div>
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

function UploadOverlay({ busy, target }: { busy: CanvasUpload['busy']; target: string | null }) {
  if (busy) {
    return (
      <div className="absolute inset-0 grid place-items-center bg-surface/70 pointer-events-none" role="status" aria-live="polite">
        <div className="flex flex-col items-center gap-xs w-56 rounded-lg bg-surface-container-lowest shadow-card border border-outline-variant/20 p-sm">
          <span className="text-label-sm font-semibold text-on-surface">{busy.area} · {busy.label}</span>
          <div className="h-1 w-full rounded-full bg-surface-container overflow-hidden" role="progressbar" aria-label={`Tiến độ tải ${busy.area}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={busy.pct}>
            <div className="h-full bg-secondary transition-all" style={{ width: `${busy.pct}%` }} />
          </div>
        </div>
      </div>
    )
  }
  if (target === null) return null
  return (
    <div className="absolute top-sm left-1/2 -translate-x-1/2 rounded-full bg-secondary text-on-secondary px-sm py-[2px] text-label-sm font-semibold pointer-events-none">
      {target ? `Thả để tải vào ${target}` : 'Kéo vào một vùng in'}
    </div>
  )
}

function TaskCanvas({ template, line, slots, bg, guide, guides, upload }: TaskProps) {
  const firstArea = template?.areas.find(a => a.name === slots[0]) ?? template?.areas[0]
  const sourceUrl = line.sourcePrintFiles[0]?.url ?? null
  const firstHasArt = !!(firstArea && newestFor(line, firstArea.name))
  const showSource = !!(template && firstArea && sourceUrl && !firstHasArt)
  const sourceSize = useNaturalSize(showSource ? sourceUrl : null)
  const svgRef = useRef<SVGSVGElement>(null)
  const [drag, setDrag] = useState<string | null>(null)

  if (!template) {
    const firstSlotArt = slots[0] ? newestFor(line, slots[0]) : undefined
    const art = firstSlotArt && isImage(firstSlotArt) ? firstSlotArt : newestArtwork(line)
    const fallback = art && isImage(art) ? art.url : sourceUrl
    return (
      <div className="flex flex-col gap-sm">
        <Note tone="idle" icon="dashboard_customize">
          <b>Chưa có template cho SKU này</b>
          <div className="text-label-sm">Xưởng: {line.supplier ? `${line.supplier.name} (${line.supplier.code})` : 'chưa map'}{line.supplierSku ? ` · SKU xưởng ${line.supplierSku}` : ''}</div>
        </Note>
        {fallback && (
          <div className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-sm grid place-items-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={fallback} alt="File in hiện có" className="max-w-full max-h-[420px] object-contain" />
          </div>
        )}
      </div>
    )
  }

  const tpl = template
  const { k, H, viewBox } = sheetGeometry(tpl)
  const singleArea = new Set(tpl.areas.map(a => a.name)).size === 1

  function areaFor(e: DragEvent): TemplateArea | null {
    const svg = svgRef.current
    if (!svg) return null
    const p = clientToTemplate(svg.getBoundingClientRect(), viewBox, k, e.clientX, e.clientY)
    return areaAt(tpl.areas, p.x, p.y)
  }

  const dropAllowed = !!upload && !upload.busy
  const frameProps: HTMLAttributes<HTMLDivElement> | undefined = upload ? {
    title: upload.busy ? 'Đang tải file lên — chờ xong rồi thả tiếp' : 'Kéo thả file vào một vùng in để tải lên',
    onDragOver: e => {
      if (!hasFiles(e)) return
      e.preventDefault()
      const a = dropAllowed ? areaFor(e) : null
      e.dataTransfer.dropEffect = a ? 'copy' : 'none'
      const next = a?.name ?? ''
      if (next !== drag) setDrag(next)
    },
    onDragLeave: e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrag(null) },
    onDrop: e => {
      if (!hasFiles(e)) return
      e.preventDefault()
      setDrag(null)
      if (!dropAllowed) return
      const a = areaFor(e)
      const f = e.dataTransfer.files?.[0]
      if (!f) return
      if (!a) { upload.onReject('Thả file vào trong một vùng in'); return }
      upload.onDrop(a.name, f)
    },
  } : undefined

  const dragArea = drag ? tpl.areas.find(a => a.name === drag) : undefined
  const highlight = dragArea ? (singleArea ? { x: 0, y: 0, w: W, h: H } : { x: dragArea.x * k, y: dragArea.y * k, w: dragArea.w * k, h: dragArea.h * k }) : null

  return (
    <Sheet
      template={tpl} bg={bg} guide={guide} guides={guides} svgRef={svgRef} highlight={highlight} frameProps={frameProps}
      frameOverlay={upload ? <UploadOverlay busy={upload.busy} target={drag} /> : null}
      renderArea={(a, { x, y, w, h }) => {
        const art = newestFor(line, a.name)
        return (
          <>
            {art && isImage(art) && <image href={art.url} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" />}
            {art && !isImage(art) && <text x={x + w / 2} y={y + h / 2} textAnchor="middle" fontSize="11" className="fill-on-surface-variant font-mono">{art.fileName}</text>}
          </>
        )
      }}
      overlay={kk => (showSource && sourceUrl && firstArea ? <FittedImage url={sourceUrl} area={firstArea} size={sourceSize} label="khối nguồn" k={kk} /> : null)}
      legend={showSource && <OverlayLegend>khối artwork nguồn</OverlayLegend>}
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

type TaskProps = { template: TemplateRow | null; line: WorkspaceLine; slots: string[]; bg: CanvasBg; guide: number; guides: Guides; upload?: CanvasUpload | null }
type StandaloneProps = { template: TemplateRow; masterUrl?: string | null; line?: undefined; slots?: undefined; bg?: CanvasBg; guide?: number }

export default function TemplateCanvas(props: (Omit<TaskProps, 'guides'> & { guides?: Guides }) | StandaloneProps) {
  if (props.line) return <TaskCanvas template={props.template} line={props.line} slots={props.slots} bg={props.bg} guide={props.guide} guides={props.guides ?? ALL_GUIDES} upload={props.upload} />
  const p = props as StandaloneProps
  return <StandaloneCanvas template={p.template} masterUrl={p.masterUrl ?? null} bg={p.bg ?? 'checker'} guide={p.guide ?? 50} />
}
