import { isPrintCutTemplate } from '@/lib/print-cut'
import { sameLabel } from '@/lib/task-files'

type FitArea = { name: string; w: number; h: number; sizing?: string }
type FitTemplate = { widthPx: number; heightPx: number; areas: FitArea[]; altSets?: { areas: FitArea[]; filesUntil?: string | null }[] }
type FitFile = { widthPx: number | null; heightPx: number | null; createdAt?: Date | string | null }

export type FileFit =
  | { state: 'ok' | 'bad'; expected: { w: number; h: number } }
  | { state: 'unknown'; expected: { w: number; h: number } }
  | { state: 'no-template' | 'extra' | 'paired'; expected: null }

/** The pixel size a print area must have: the area's own box when it has one, else the whole template. */
export function expectedSize(template: FitTemplate | null, area: string): { w: number; h: number } | null {
  if (!template || isPrintCutTemplate(template)) return null
  const hit = template.areas.find(a => sameLabel(a.name, area))
  if (!hit) return null
  return hit.w > 0 && hit.h > 0 ? { w: hit.w, h: hit.h } : { w: template.widthPx, h: template.heightPx }
}

function madeBy(file: FitFile, until: string): boolean {
  return !!file.createdAt && new Date(file.createdAt).getTime() <= new Date(until).getTime()
}

/** Whether a print file matches its template: the area's size, the whole template (a full-canvas export), or the size this part has in an alternative set all pass. A set with `filesUntil` is the template's old layout: only a file made by then keeps passing. */
export function printFileFit(template: FitTemplate | null, area: string, file: FitFile): FileFit {
  if (!template) return { state: 'no-template', expected: null }
  if (isPrintCutTemplate(template) && template.areas.some(a => sameLabel(a.name, area))) return { state: 'paired', expected: null }
  const expected = expectedSize(template, area)
  if (!expected) return { state: 'extra', expected: null }
  if (!file.widthPx || !file.heightPx) return { state: 'unknown', expected }
  const ok = (file.widthPx === expected.w && file.heightPx === expected.h) || (file.widthPx === template.widthPx && file.heightPx === template.heightPx)
    || (template.altSets ?? []).some(s => (!s.filesUntil || madeBy(file, s.filesUntil)) && s.areas.some(a => sameLabel(a.name, area) && a.w === file.widthPx && a.h === file.heightPx))
  return { state: ok ? 'ok' : 'bad', expected }
}

export function fileFormatLabel(mimeType: string): string {
  if (mimeType === 'image/png') return 'PNG'
  if (mimeType === 'image/jpeg') return 'JPG'
  if (mimeType === 'application/pdf') return 'PDF'
  if (mimeType === 'image/vnd.adobe.photoshop') return 'PSD'
  const tail = mimeType.split('/')[1]
  return tail ? tail.toUpperCase() : mimeType
}
