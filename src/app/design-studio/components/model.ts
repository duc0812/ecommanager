import { isLayerlessField } from '@/lib/layer-fields'
import type { ArtworkRow, LayerMapEntry, Readiness, TaskDetail, TaskRow, TaskStatus, TemplateArea, TemplateRow, WorkspaceLine } from './types'

export const OPEN_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']
export const OWNED_MOVES: TaskStatus[] = ['DOING', 'NEW', 'REVIEW', 'ASK_CUSTOMER']

export function canTransition(from: TaskStatus, to: TaskStatus, isLeader: boolean, readiness: Readiness): boolean {
  if (from === to || from === 'CANCELLED') return false
  if (to === 'ASK_CUSTOMER') return OPEN_STATUSES.includes(from)
  if (to === 'CANCELLED') return isLeader && (OPEN_STATUSES.includes(from) || from === 'ASK_CUSTOMER')
  switch (to) {
    case 'ASSIGNED': return isLeader && (from === 'NEW' || from === 'DOING' || from === 'REJECTED')
    case 'NEW': return from === 'ASSIGNED'
    case 'DOING': return from === 'NEW' || from === 'ASSIGNED' || from === 'DONE' || from === 'REJECTED'
    case 'REVIEW': return from === 'DOING' || from === 'REJECTED'
    case 'DONE': return isLeader ? from === 'REVIEW' : (readiness === 'AUTO' && ['NEW', 'ASSIGNED', 'DOING'].includes(from))
    case 'REJECTED': return isLeader && from === 'REVIEW'
    default: return false
  }
}

export function needsLeaderApproval(line: Pick<WorkspaceLine, 'artworks'>): boolean {
  return line.artworks.some(a => a.source === 'AUTO')
}

export function canMove(detail: Pick<TaskDetail, 'task' | 'line' | 'me'>, to: TaskStatus): boolean {
  const { task, me } = detail
  if (!canTransition(task.status, to, me.isLeader, task.readiness)) return false
  if (to === 'DONE' && !me.isLeader && needsLeaderApproval(detail.line)) return false
  const owns = me.isLeader || !task.assigneeId || task.assigneeId === me.id
  return owns || !OWNED_MOVES.includes(to)
}

export function isImage(a: ArtworkRow): boolean {
  return a.mimeType === 'image/png' || a.mimeType === 'image/jpeg'
}

export function slotNames(detail: Pick<TaskDetail, 'slots'>): string[] {
  return detail.slots
}

export function versionsFor(line: WorkspaceLine, area: string): ArtworkRow[] {
  return line.artworks.filter(a => a.printArea === area).sort((a, b) => b.version - a.version)
}

export function newestFor(line: WorkspaceLine, area: string): ArtworkRow | undefined {
  return versionsFor(line, area)[0]
}

export function allSlotsFilled(detail: Pick<TaskDetail, 'line' | 'slots'>): boolean {
  return slotNames(detail).every(s => detail.line.artworks.some(a => a.printArea === s))
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
  const ms = new Date(t.dueAt).getTime() - now
  const h = Math.floor(Math.abs(ms) / 3.6e6)
  if (ms < 0) return { label: `quá ${h}h`, tone: 'bad', icon: 'error' }
  if (h <= 4) return { label: `còn ${h}h`, tone: 'warn', icon: 'schedule' }
  return { label: `còn ${h}h`, tone: 'idle', icon: 'schedule' }
}

export function layerOf(key: string): string {
  if (isLayerlessField(key)) return '—'
  const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
  if (/number/i.test(key)) return 'TXT · number'
  if (/name|text/i.test(key)) return `TXT · ${slug}`
  return `SWAP · ${slug}`
}

export function findLayer(layerMap: LayerMapEntry[] | null | undefined, field: string): LayerMapEntry | undefined {
  const norm = field.toLowerCase().trim()
  return layerMap?.find(e => e.field.toLowerCase().trim() === norm)
}

export type LayerSource =
  | { source: 'none'; layer: string }
  | { source: 'library'; layer: string; fit: string; maxChars?: number; optionLabel: string | null }
  | { source: 'library-missing'; layer: string; optionLabel: string | null }
  | { source: 'profile'; layer: string; fit: string; maxChars?: number }
  | { source: 'guess'; layer: string }

export function layerForField(field: string, library: TaskDetail['library'], layerMap: LayerMapEntry[] | null | undefined): LayerSource {
  if (isLayerlessField(field)) return { source: 'none', layer: '—' }
  const norm = field.toLowerCase().trim()
  if (library?.entryId && library.layers.length > 0) {
    const hit = library.layers.find(l => l.field.toLowerCase().trim() === norm)
    if (hit) return { source: 'library', layer: hit.layer, fit: hit.fit, maxChars: hit.maxChars, optionLabel: library.optionLabel }
    return { source: 'library-missing', layer: `@${field.trim()}`, optionLabel: library.optionLabel }
  }
  const legacy = findLayer(layerMap, field)
  if (legacy) return { source: 'profile', layer: legacy.layer, fit: legacy.fit, maxChars: legacy.maxChars }
  return { source: 'guess', layer: layerOf(field) }
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

export function putJson<T = any>(url: string, body: unknown) {
  return requestJson<T>(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export function productUrl(key: string): string {
  return `/api/design-studio/products/${encodeURIComponent(key)}`
}

export function productPageUrl(key: string): string {
  return `/design-studio/products/${encodeURIComponent(key)}`
}

export function postJson<T = any>(url: string, body: unknown) {
  return requestJson<T>(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
}

export function taskUrl(key: string, suffix = ''): string {
  return `/api/design-studio/tasks/${encodeURIComponent(key)}${suffix}`
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    let ok = false
    try { ok = document.execCommand('copy') } catch {}
    document.body.removeChild(ta)
    return ok
  }
}

export type LightboxImage = { url: string; label: string; openUrl?: string | null; copyUrl?: string | null }

export function artworkImage(a: ArtworkRow): LightboxImage {
  return { url: a.url, label: `${a.printArea} · v${a.version} · ${a.fileName}`, openUrl: a.url, copyUrl: a.driveWebViewLink ?? a.url }
}

export function taskImages(detail: Pick<TaskDetail, 'line'>): LightboxImage[] {
  const { line } = detail
  const out: LightboxImage[] = []
  const seen = new Set<string>()
  const add = (m: LightboxImage) => { if (!seen.has(m.url)) { seen.add(m.url); out.push(m) } }
  if (line.previewUrl) add({ url: line.previewUrl, label: 'Preview khách tạo lúc đặt hàng' })
  if (line.imageUrl) add({ url: line.imageUrl, label: 'Ảnh variant (Shopify)' })
  const arts = line.artworks.filter(isImage)
  const areas = Array.from(new Set(arts.map(a => a.printArea)))
  for (const area of areas) add(artworkImage(newestFor({ ...line, artworks: arts }, area)!))
  for (const a of [...arts].sort((x, y) => x.printArea.localeCompare(y.printArea) || y.version - x.version)) add(artworkImage(a))
  for (const f of line.sourcePrintFiles) add({ url: f.url, label: `File nguồn · ${f.printArea}` })
  return out
}

export function canRemoveArtwork(a: Pick<ArtworkRow, 'uploadedById'>, me: { id: string; role: string }, status: TaskStatus): { ok: boolean; why?: string } {
  if (status === 'DONE') return { ok: false, why: 'Task đã gửi xưởng — bấm "Sửa & gửi lại" trước khi xoá' }
  if (me.role === 'SUPERADMIN' || me.role === 'ADMIN' || a.uploadedById === me.id) return { ok: true }
  return { ok: false, why: 'Chỉ người upload hoặc admin được xoá file này' }
}
