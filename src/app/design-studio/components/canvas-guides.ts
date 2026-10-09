import type { TemplateArea } from './types'

export type Guides = { areas: boolean; safe: boolean; bleed: boolean; guide: boolean }
export const ALL_GUIDES: Guides = { areas: true, safe: true, bleed: true, guide: true }
export const NO_GUIDES: Guides = { areas: false, safe: false, bleed: false, guide: false }
export const GUIDES_STORAGE_KEY = 'design-studio:canvas-guides'

export function parseGuides(json: string | null | undefined): Guides {
  if (!json) return ALL_GUIDES
  let raw: unknown
  try { raw = JSON.parse(json) } catch { return ALL_GUIDES }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return ALL_GUIDES
  const r = raw as Record<string, unknown>
  const pick = (k: keyof Guides) => typeof r[k] === 'boolean' ? r[k] as boolean : true
  return { areas: pick('areas'), safe: pick('safe'), bleed: pick('bleed'), guide: pick('guide') }
}

export type ViewBox = { x: number; y: number; w: number; h: number }
export type ClientRect = { left: number; top: number; width: number; height: number }

export function clientToTemplate(rect: ClientRect, viewBox: ViewBox, scale: number, clientX: number, clientY: number): { x: number; y: number } {
  const s = Math.min(rect.width / viewBox.w, rect.height / viewBox.h)
  const ox = rect.left + (rect.width - viewBox.w * s) / 2
  const oy = rect.top + (rect.height - viewBox.h * s) / 2
  return { x: (viewBox.x + (clientX - ox) / s) / scale, y: (viewBox.y + (clientY - oy) / s) / scale }
}

export function areaAt<T extends TemplateArea>(areas: T[], x: number, y: number): T | null {
  if (areas.length === 0) return null
  if (new Set(areas.map(a => a.name)).size === 1) return areas[0]
  const hits = areas.filter(a => x >= a.x && x <= a.x + a.w && y >= a.y && y <= a.y + a.h)
  hits.sort((a, b) => a.w * a.h - b.w * b.h)
  return hits[0] ?? null
}
