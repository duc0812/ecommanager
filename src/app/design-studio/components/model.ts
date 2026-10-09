import type { ArtworkRow, Readiness, TaskRow, TaskStatus, TemplateArea, TemplateRow, WorkspaceLine } from './types'

export const OPEN_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']

export function canTransition(from: TaskStatus, to: TaskStatus, isLeader: boolean, readiness: Readiness): boolean {
  if (from === to || from === 'CANCELLED') return false
  if (to === 'ASK_CUSTOMER') return OPEN_STATUSES.includes(from)
  if (to === 'CANCELLED') return isLeader && (OPEN_STATUSES.includes(from) || from === 'ASK_CUSTOMER')
  switch (to) {
    case 'ASSIGNED': return isLeader && (from === 'NEW' || from === 'DOING' || from === 'REJECTED')
    case 'NEW': return from === 'ASSIGNED'
    case 'DOING': return from === 'NEW' || from === 'ASSIGNED' || from === 'DONE' || from === 'REJECTED'
    case 'REVIEW': return from === 'DOING' || from === 'REJECTED'
    case 'DONE': return isLeader ? from === 'REVIEW' : (readiness === 'AUTO' && ['NEW', 'ASSIGNED', 'DOING', 'REVIEW'].includes(from))
    case 'REJECTED': return isLeader && from === 'REVIEW'
    default: return false
  }
}

export function isImage(a: ArtworkRow): boolean {
  return a.mimeType === 'image/png' || a.mimeType === 'image/jpeg'
}

export function slotNames(line: WorkspaceLine, template: TemplateRow | null): string[] {
  if (!template || template.areas.length === 0) return line.printAreas
  const names = template.areas.map(a => a.name)
  return [...names, ...line.printAreas.filter(p => !names.includes(p))]
}

export function versionsFor(line: WorkspaceLine, area: string): ArtworkRow[] {
  return line.artworks.filter(a => a.printArea === area).sort((a, b) => b.version - a.version)
}

export function newestFor(line: WorkspaceLine, area: string): ArtworkRow | undefined {
  return versionsFor(line, area)[0]
}

export function allSlotsFilled(line: WorkspaceLine, template: TemplateRow | null): boolean {
  return slotNames(line, template).every(s => line.artworks.some(a => a.printArea === s))
}

export function newestArtwork(line: WorkspaceLine): ArtworkRow | undefined {
  return [...line.artworks].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.version - a.version))[0]
}

export function targetFor(template: TemplateRow, printArea: string | undefined): { w: number; h: number; area: TemplateArea | null } {
  const area = template.areas.find(a => a.name === printArea) ?? null
  return area ? { w: area.w, h: area.h, area } : { w: template.widthPx, h: template.heightPx, area: null }
}

export function sharpnessRatio(template: TemplateRow, art: ArtworkRow | undefined): number | null {
  if (!art || !art.widthPx || !art.heightPx) return null
  const t = targetFor(template, art.printArea)
  return Math.min(art.widthPx / t.w, art.heightPx / t.h)
}

export type Tone = 'ok' | 'warn' | 'bad' | 'idle' | 'brand'

export function timeLeft(t: Pick<TaskRow, 'status' | 'dueAt'>, now = Date.now()): { label: string; tone: Tone; icon: string } {
  if (t.status === 'DONE') return { label: 'đã gửi', tone: 'ok', icon: 'check' }
  if (!t.dueAt) return { label: 'chưa hạn', tone: 'idle', icon: 'schedule' }
  const h = Math.round((new Date(t.dueAt).getTime() - now) / 3_600_000)
  if (h < 0) return { label: `quá ${-h}h`, tone: 'bad', icon: 'error' }
  if (h <= 4) return { label: `còn ${h}h`, tone: 'warn', icon: 'schedule' }
  return { label: `còn ${h}h`, tone: 'idle', icon: 'schedule' }
}

export function layerOf(key: string): string {
  if (/size|yes or no/i.test(key)) return '—'
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  if (/number/i.test(key)) return 'TXT · number'
  if (/name|text/i.test(key)) return `TXT · ${slug}`
  return `SWAP · ${slug}`
}

export function sourceEngine(line: WorkspaceLine): string {
  return line.sourcePrintFiles.length ? 'Customall (app gốc)' : line.customized ? 'Customizer' : 'Non-custom'
}

export async function requestJson<T = any>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    const res = await fetch(url, init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: (data as any)?.error ?? `HTTP ${res.status}` }
    return { ok: true, data: data as T }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Lỗi mạng' }
  }
}

export function postJson<T = any>(url: string, body: unknown) {
  return requestJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export function taskUrl(key: string, suffix = ''): string {
  return `/api/design-studio/tasks/${encodeURIComponent(key)}${suffix}`
}
