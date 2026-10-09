'use client'
import { useEffect, useId, useState } from 'react'
import type { TemplateRow, WorkspaceLine } from './types'
import { isImage, newestFor, newestArtwork } from './model'
import { Icon, Note } from './ui'

export type CanvasBg = 'checker' | 'white' | 'black'

const W = 1200

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

export function CanvasTools({ bg, onBg, guide, onGuide, hasGuide }: { bg: CanvasBg; onBg: (b: CanvasBg) => void; guide: number; onGuide: (n: number) => void; hasGuide: boolean }) {
  const swatches: { k: CanvasBg; label: string; cls: string }[] = [
    { k: 'checker', label: 'Nền ô cờ', cls: 'bg-[repeating-conic-gradient(theme(colors.outline-variant)_0_25%,theme(colors.surface-container-lowest)_0_50%)] bg-[length:8px_8px]' },
    { k: 'white', label: 'Nền trắng', cls: 'bg-white' },
    { k: 'black', label: 'Nền đen', cls: 'bg-black' },
  ]
  return (
    <div className="flex items-center gap-md flex-wrap text-label-sm text-on-surface-variant">
      <span className="inline-flex items-center gap-xs">Nền
        {swatches.map(s => (
          <button key={s.k} type="button" aria-label={s.label} aria-pressed={bg === s.k} title={s.label} onClick={() => onBg(s.k)}
            className={`w-[18px] h-[18px] rounded border border-outline-variant ${s.cls} ${bg === s.k ? 'outline outline-2 outline-offset-1 outline-secondary' : ''}`} />
        ))}
      </span>
      {hasGuide && (
        <label className="inline-flex items-center gap-xs">Artguide
          <input type="range" min={0} max={100} value={guide} onChange={e => onGuide(Number(e.target.value))} className="w-24 accent-secondary" aria-label="Độ mờ artguide" />
          <span className="w-8 text-right">{guide}%</span>
        </label>
      )}
    </div>
  )
}

export default function TemplateCanvas({ template, line, slots, bg, guide }: { template: TemplateRow | null; line: WorkspaceLine; slots: string[]; bg: CanvasBg; guide: number }) {
  const rawId = useId()
  const patternId = `ck${rawId.replace(/[^a-zA-Z0-9]/g, '')}`
  const firstArea = template?.areas.find(a => a.name === slots[0]) ?? template?.areas[0]
  const sourceUrl = line.sourcePrintFiles[0]?.url ?? null
  const firstHasArt = !!(firstArea && newestFor(line, firstArea.name))
  const showSource = !!(template && firstArea && sourceUrl && !firstHasArt)
  const sourceSize = useNaturalSize(showSource ? sourceUrl : null)

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

  const k = W / template.widthPx
  const H = Math.round(template.heightPx * k)
  const bleed = template.bleedIn * template.dpi * k
  const safe = template.safeIn * template.dpi * k
  const bgFill = bg === 'checker' ? `url(#${patternId})` : undefined
  const bgCls = bg === 'white' ? 'fill-white' : bg === 'black' ? 'fill-black' : ''

  const src = showSource && firstArea && sourceSize ? fit(firstArea, sourceSize.w, sourceSize.h) : null

  return (
    <div className="flex flex-col gap-sm">
      <div className="rounded-lg border border-outline-variant/20 bg-surface-container-low p-sm grid place-items-center overflow-hidden">
        <svg viewBox={`-30 -22 ${W + 60} ${H + 50}`} role="img" aria-label={`Template ${template.name}`} className="block max-w-full h-auto w-full">
          <defs>
            <pattern id={patternId} width="18" height="18" patternUnits="userSpaceOnUse">
              <rect width="18" height="18" className="fill-surface-container-lowest" />
              <rect width="9" height="9" className="fill-surface-container" />
              <rect x="9" y="9" width="9" height="9" className="fill-surface-container" />
            </pattern>
          </defs>
          <rect width={W} height={H} fill={bgFill} className={bgCls} />
          {template.areas.map(a => {
            const art = newestFor(line, a.name)
            const x = a.x * k, y = a.y * k, w = a.w * k, h = a.h * k
            return (
              <g key={a.name}>
                <rect x={x} y={y} width={w} height={h} className="fill-outline/20 stroke-outline-variant" />
                {art && isImage(art) && <image href={art.url} x={x} y={y} width={w} height={h} preserveAspectRatio="xMidYMid meet" />}
                {art && !isImage(art) && <text x={x + w / 2} y={y + h / 2} textAnchor="middle" fontSize="11" className="fill-on-surface-variant font-mono">{art.fileName}</text>}
                <rect x={x + bleed} y={y + bleed} width={Math.max(0, w - 2 * bleed)} height={Math.max(0, h - 2 * bleed)} fill="none" strokeWidth="1.2" strokeDasharray="5 4" className="stroke-error" />
                <rect x={x + safe} y={y + safe} width={Math.max(0, w - 2 * safe)} height={Math.max(0, h - 2 * safe)} fill="none" strokeWidth="1.2" strokeDasharray="3 4" className="stroke-on-tertiary-container" />
                <text x={x + 6} y={y + 14} fontSize="10" className="fill-on-surface-variant font-mono">{a.name} · {a.w}×{a.h}</text>
              </g>
            )
          })}
          {src && sourceUrl && sourceSize && (
            <g>
              <image href={sourceUrl} x={src.x * k} y={src.y * k} width={src.w * k} height={src.h * k} preserveAspectRatio="xMidYMid meet" />
              <rect x={src.x * k} y={src.y * k} width={src.w * k} height={src.h * k} fill="none" strokeWidth="1.5" className="stroke-amber-500" />
              <text x={src.x * k + 4} y={(src.y + src.h) * k - 6} fontSize="10" className="fill-amber-600 font-mono">
                khối nguồn {sourceSize.w}×{sourceSize.h} → ×{src.s.toFixed(1)}
              </text>
            </g>
          )}
          {src === null && showSource && sourceUrl && firstArea && (
            <image href={sourceUrl} x={firstArea.x * k} y={firstArea.y * k} width={firstArea.w * k} height={firstArea.h * k} preserveAspectRatio="xMidYMid meet" />
          )}
          {template.guideImageUrl && (
            <image href={template.guideImageUrl} x={0} y={0} width={W} height={H} preserveAspectRatio="none" opacity={guide / 100} pointerEvents="none" />
          )}
          <rect width={W} height={H} fill="none" className="stroke-outline-variant" />
          <g fontSize="11" className="fill-on-surface-variant font-mono">
            <line x1="0" y1={H + 12} x2={W} y2={H + 12} className="stroke-outline-variant" />
            <text x={W / 2} y={H + 26} textAnchor="middle">{template.widthPx} px</text>
            <line x1="-12" y1="0" x2="-12" y2={H} className="stroke-outline-variant" />
            <text x="-16" y={H / 2} textAnchor="middle" transform={`rotate(-90 -16 ${H / 2})`}>{template.heightPx} px</text>
          </g>
        </svg>
      </div>
      <div className="flex gap-md flex-wrap text-label-sm text-on-surface-variant">
        <span className="inline-flex items-center gap-xs text-error"><i className="inline-block w-3.5 border-t-2 border-dashed border-current" />bleed {template.bleedIn}″</span>
        <span className="inline-flex items-center gap-xs text-on-tertiary-container"><i className="inline-block w-3.5 border-t-2 border-dashed border-current" />an toàn {template.safeIn}″</span>
        {template.guideImageUrl && <span className="inline-flex items-center gap-xs text-secondary"><Icon name="layers" className="text-[14px]" />artguide</span>}
        {showSource && <span className="inline-flex items-center gap-xs text-amber-600"><i className="inline-block w-3.5 border-t-2 border-current" />khối artwork nguồn</span>}
        <span>xám = panel phải phủ kín</span>
        {template.mirror && <span className="text-amber-900">mirror</span>}
      </div>
    </div>
  )
}
