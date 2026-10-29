import { isLayerlessField } from '@/lib/layer-fields'
import { currentFiles, extraPrintParts, fileKindOf, missingPrintAreas, orderedPrintFiles, printFilesReady, type FileKind } from '@/lib/task-files'
import type { ArtworkRow, LayerMapEntry, TaskDetail, TaskRow, TaskStatus, TemplateArea, TemplateRow, WorkspaceLine } from './types'

export const OPEN_STATUSES: TaskStatus[] = ['NEW', 'ASSIGNED', 'DOING', 'REVIEW', 'REJECTED']
export const OWNED_MOVES: TaskStatus[] = ['DOING', 'NEW', 'REVIEW', 'ASK_CUSTOMER']

export function canTransition(from: TaskStatus, to: TaskStatus, isLeader: boolean, canApprove: boolean = isLeader): boolean {
  if (from === to || from === 'CANCELLED') return false
  if (to === 'ASK_CUSTOMER') return OPEN_STATUSES.includes(from)
  if (to === 'CANCELLED') return isLeader && (OPEN_STATUSES.includes(from) || from === 'ASK_CUSTOMER')
  switch (to) {
    case 'ASSIGNED': return isLeader && (from === 'NEW' || from === 'DOING' || from === 'REJECTED')
    case 'NEW': return from === 'ASSIGNED'
    case 'DOING': return from === 'NEW' || from === 'ASSIGNED' || from === 'DONE' || from === 'REJECTED'
    case 'REVIEW': return from === 'DOING' || from === 'REJECTED'
    case 'DONE': return canApprove && from === 'REVIEW'
    case 'REJECTED': return canApprove && from === 'REVIEW'
    default: return false
  }
}

export function canMove(detail: Pick<TaskDetail, 'task' | 'me'>, to: TaskStatus): boolean {
  const { task, me } = detail
  if (!canTransition(task.status, to, me.isLeader, me.canApprove)) return false
  const owns = me.isLeader || !task.assigneeId || task.assigneeId === me.id
  return owns || !OWNED_MOVES.includes(to)
}

export function isImage(a: ArtworkRow): boolean {
  return a.mimeType === 'image/png' || a.mimeType === 'image/jpeg'
}

export function slotNames(detail: Pick<TaskDetail, 'slots'>): string[] {
  return detail.slots
}

type Files = Pick<WorkspaceLine, 'artworks'>

export function versionsFor(line: Files, area: string, kind: FileKind = 'PRINT'): ArtworkRow[] {
  return line.artworks.filter(a => fileKindOf(a.kind) === kind && a.printArea === area).sort((a, b) => b.version - a.version)
}

export function newestFor(line: Files, area: string, kind: FileKind = 'PRINT'): ArtworkRow | undefined {
  return versionsFor(line, area, kind)[0]
}

/** The files the factory prints: one per part, template areas first, then every other part by name. */
export function printFiles(line: Files, slots: string[]): ArtworkRow[] {
  return orderedPrintFiles(line.artworks, slots)
}

/** Print parts shown on a card: every template area (filled or not), then the extra parts that have a file. */
export function printPartNames(line: Files, slots: string[]): string[] {
  return [...slots, ...extraPrintParts(line.artworks, slots)]
}

export function mockupFiles(line: Files): ArtworkRow[] {
  return currentFiles(line.artworks, 'MOCKUP').sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
}

export function missingAreas(detail: Pick<TaskDetail, 'line' | 'slots'>): string[] {
  return missingPrintAreas(detail.line.artworks, detail.slots)
}

/** A template task needs a file for every area; a task without a template needs at least one print file. */
export function allSlotsFilled(detail: Pick<TaskDetail, 'line' | 'slots'>): boolean {
  return printFilesReady(detail.line.artworks, slotNames(detail))
}

export function filesMissingHint(detail: Pick<TaskDetail, 'slots'>): string {
  return detail.slots.length > 0 ? 'Upload đủ file cho mọi vùng in trước' : 'Upload ít nhất một file in trước'
}

export function newestArtwork(line: Files): ArtworkRow | undefined {
  return line.artworks.filter(a => fileKindOf(a.kind) === 'PRINT')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : b.version - a.version))[0]
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
  if (t.status === 'DONE') return { label: 'đã duyệt', tone: 'ok', icon: 'check' }
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

/** status 0 = the request never reached the server (offline, dev server restarting). */
export async function requestJson<T = any>(url: string, init?: RequestInit): Promise<{ ok: true; data: T } | { ok: false; error: string; status: number }> {
  try {
    const res = await fetch(url, init)
    const data = await res.json().catch(() => ({}))
    if (!res.ok) return { ok: false, error: (data as any)?.error ?? `HTTP ${res.status}`, status: res.status }
    return { ok: true, data: data as T }
  } catch (e: any) {
    return { ok: false, error: e?.message ?? 'Lỗi mạng', status: 0 }
  }
}

export const RETRY_DELAYS_MS = [2000, 5000, 10000]
export const RETRY_STEADY_MS = 30000

export function retryDelay(attempt: number): number {
  return RETRY_DELAYS_MS[attempt] ?? RETRY_STEADY_MS
}

export function isRetryable(status: number): boolean {
  return status === 0 || status >= 500
}

export function emptyQueueText(f: { readinessLabel: string | null; mine: boolean; q: string }): string {
  return `Không có task${f.readinessLabel ? ` '${f.readinessLabel}'` : ''}${f.mine ? ' của bạn' : ''}${f.q ? ` khớp "${f.q}"` : ''}`
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

export function patchJson<T = any>(url: string, body: unknown) {
  return requestJson<T>(url, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
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

/** Google renders a resized copy of a shared Drive image on request, but only for files up to about this size. */
export const DRIVE_RESIZE_MAX_BYTES = 40 * 1024 * 1024

/** Google's resized copy of a shared Drive image, served to the browser straight from Google. Null when Drive will not have one. */
export function driveImageUrl(a: Pick<ArtworkRow, 'storage' | 'driveFileId' | 'size' | 'mimeType'>, px: number): string | null {
  if (a.storage !== 'DRIVE' || !a.driveFileId || !isImage(a as ArtworkRow) || a.size > DRIVE_RESIZE_MAX_BYTES) return null
  if (!/^[A-Za-z0-9_-]+$/.test(a.driveFileId)) return null
  return `https://lh3.googleusercontent.com/d/${a.driveFileId}=s${Math.round(px)}`
}

/**
 * Where to load a picture of the file from, best first: a preview made at upload or render time, Google's resized copy,
 * the server's thumbnail, and (when `full`) the original. The office reaches Google ~100x faster than the server, and
 * originals run to 100+ MB, so the original is only for the lightbox and downloads.
 */
export function artSources(a: ArtworkRow, px: number, full = false): string[] {
  if (!isImage(a)) return []
  const out: string[] = []
  if (a.previewUrl?.includes('preview=1')) out.push(a.previewUrl)
  const drive = driveImageUrl(a, px)
  if (drive) out.push(drive)
  // Drive has no thumbnail either for a file it will not resize, so asking the server for one only costs a round trip.
  if (a.previewUrl && !a.previewUrl.includes('preview=1') && (a.storage !== 'DRIVE' || a.size <= DRIVE_RESIZE_MAX_BYTES)) out.push(a.previewUrl)
  if (full) out.push(a.url)
  return out
}

export type LightboxImage = { url: string; label: string; openUrl?: string | null; copyUrl?: string | null }

export function artworkImage(a: ArtworkRow): LightboxImage {
  const what = fileKindOf(a.kind) === 'MOCKUP' ? `Mockup · ${a.printArea}` : a.printArea
  return { url: a.url, label: `${what} · v${a.version} · ${a.fileName}`, openUrl: a.url, copyUrl: a.driveWebViewLink ?? a.url }
}

/** A link somebody can paste: the Drive link, or the file's address in this app while it is still on the server. */
export function artworkShareLink(a: ArtworkRow): string {
  if (a.driveWebViewLink) return a.driveWebViewLink
  return typeof window === 'undefined' ? a.url : new URL(a.url, window.location.origin).toString()
}

/**
 * What the customer saw: the custom preview (Customily, Customall, our builder) and the variant's own mockup image.
 * The plain product image comes only when neither exists, since it does not show the chosen variant.
 */
export function previewImages(line: Pick<TaskDetail['line'], 'previewUrl' | 'imageUrl' | 'imageIsVariant'>): LightboxImage[] {
  const out: LightboxImage[] = []
  if (line.previewUrl) out.push({ url: line.previewUrl, label: 'Preview custom khách tạo lúc đặt hàng' })
  if (line.imageUrl && line.imageIsVariant) out.push({ url: line.imageUrl, label: 'Mockup variant (Shopify)' })
  if (out.length === 0 && line.imageUrl) {
    out.push({ url: line.imageUrl, label: line.imageIsVariant === false ? 'Ảnh sản phẩm Shopify (variant không có ảnh riêng)' : 'Ảnh Shopify (đơn đồng bộ trước — bấm Nạp lại từ Shopify để biết ảnh variant)' })
  }
  return out
}

export function taskImages(detail: Pick<TaskDetail, 'line'>): LightboxImage[] {
  const { line } = detail
  const out: LightboxImage[] = []
  const seen = new Set<string>()
  const add = (m: LightboxImage) => { if (!seen.has(m.url)) { seen.add(m.url); out.push(m) } }
  for (const m of previewImages(line)) add(m)
  const arts = line.artworks.filter(isImage)
  const images = { artworks: arts }
  for (const area of Array.from(new Set(arts.filter(x => fileKindOf(x.kind) === 'PRINT').map(x => x.printArea)))) add(artworkImage(newestFor(images, area)!))
  for (const m of mockupFiles(images)) add(artworkImage(m))
  const order = (a: ArtworkRow) => (fileKindOf(a.kind) === 'PRINT' ? 0 : 1)
  for (const a of [...arts].sort((x, y) => order(x) - order(y) || x.printArea.localeCompare(y.printArea) || y.version - x.version)) add(artworkImage(a))
  for (const f of line.sourcePrintFiles) add({ url: f.url, label: `File nguồn · ${f.printArea}` })
  return out
}

export function canRemoveArtwork(a: Pick<ArtworkRow, 'uploadedById'>, me: { id: string; role: string }, status: TaskStatus): { ok: boolean; why?: string } {
  if (status === 'DONE') return { ok: false, why: 'Task đã duyệt design — bấm "Sửa & gửi lại" trước khi xoá' }
  if (me.role === 'SUPERADMIN' || me.role === 'ADMIN' || a.uploadedById === me.id) return { ok: true }
  return { ok: false, why: 'Chỉ người upload hoặc admin được xoá file này' }
}
