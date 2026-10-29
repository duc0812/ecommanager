import type { ArtworkRow, TaskDetail, TemplateRow } from './types'
import { isImage, missingAreas, newestFor, printFiles, sharpnessRatio, targetFor } from './model'

export type QaLevel = 'pass' | 'warn' | 'error'
export type QaKey = 'size' | 'format' | 'coverage' | 'areas'
export type QaItem = { key: QaKey; label: string; level: QaLevel; detail: string }
export type QaStatus = 'none' | 'pass' | 'warn' | 'error'
export type QaResult = { status: QaStatus; items: QaItem[]; newest: ArtworkRow | null }

const RANK: Record<QaLevel, number> = { error: 0, warn: 1, pass: 2 }

function worst(levels: QaLevel[]): QaLevel {
  return levels.reduce<QaLevel>((w, l) => (RANK[l] < RANK[w] ? l : w), 'pass')
}

function sizeOf(template: TemplateRow, art: ArtworkRow): { level: QaLevel; text: string } {
  const t = targetFor(template, art.printArea)
  if (!art.widthPx || !art.heightPx) return { level: 'warn', text: `${art.printArea}: chưa đọc được kích thước` }
  const ratio = sharpnessRatio(template, art) ?? 0
  const exact = (art.widthPx === t.w && art.heightPx === t.h) || (art.widthPx === template.widthPx && art.heightPx === template.heightPx)
  const dpi = Math.round(template.dpi * ratio)
  const level: QaLevel = ratio < 0.5 ? 'error' : ratio < 0.95 || !exact ? 'warn' : 'pass'
  const text = level === 'pass'
    ? `${art.printArea} ${art.widthPx}×${art.heightPx} · ${template.dpi} DPI`
    : `${art.printArea} ${art.widthPx}×${art.heightPx} (cần ${t.w}×${t.h}) · ~${dpi} DPI (${Math.round(ratio * 100)}%)`
  return { level, text }
}

/**
 * The checks the app can make from the files alone: size and sharpness against the template area, format, whether the
 * file covers the panel, and whether every area has a file. Checks that need a model to look at the picture (text, colour,
 * safe zone, preview match) are not here until a backend makes them.
 */
export function machineQa(detail: Pick<TaskDetail, 'line' | 'slots' | 'template'>): QaResult {
  const { line, slots, template } = detail
  const files = printFiles(line, slots)
  if (files.length === 0) return { status: 'none', items: [], newest: null }
  const newest = [...files].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))[0]
  const items: QaItem[] = []

  // Files under other names than the template's areas have no size to meet; the missing areas already say what is wrong.
  const inAreas = template ? slots.map(s => newestFor(line, s)).filter((a): a is ArtworkRow => !!a) : []
  if (template && inAreas.length > 0) {
    const checked = inAreas
    const sizes = checked.map(a => sizeOf(template, a))
    const level = worst(sizes.map(s => s.level))
    const shown = level === 'pass' ? sizes : sizes.filter(s => s.level !== 'pass')
    items.push({ key: 'size', label: 'Khổ & DPI', level, detail: shown.map(s => s.text).join(' · ') })

    const cover = checked.map(a => ({ a, r: sharpnessRatio(template, a) }))
    const short = cover.filter(c => c.r !== null && c.r < 1).map(c => c.a.printArea)
    items.push({
      key: 'coverage', label: 'Phủ panel / bleed', level: short.length ? 'warn' : 'pass',
      detail: short.length ? `File nhỏ hơn panel: ${short.join(', ')}` : template.bleedIn > 0 ? `Phủ kín panel, bleed ${template.bleedIn}″` : 'Phủ kín panel',
    })
  }

  const odd = files.filter(f => !isImage(f))
  items.push({
    key: 'format', label: 'Định dạng', level: odd.length ? 'warn' : 'pass',
    detail: odd.length ? `${odd.map(f => `${f.printArea} (${f.fileName.split('.').pop()?.toUpperCase()})`).join(', ')} — xưởng in từ PNG/JPG` : 'PNG/JPG',
  })

  const missing = missingAreas({ line, slots })
  items.push({
    key: 'areas', label: 'Đủ file mọi vùng', level: missing.length ? 'error' : 'pass',
    detail: missing.length ? `Thiếu ${missing.join(', ')}` : slots.length ? `${slots.length}/${slots.length} vùng in có file` : `${files.length} file in`,
  })

  items.sort((a, b) => RANK[a.level] - RANK[b.level])
  const level = worst(items.map(i => i.level))
  return { status: level, items, newest }
}
