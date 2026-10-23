type FitTemplate = { widthPx: number; heightPx: number; areas: { name: string; w: number; h: number }[] }
type FitFile = { widthPx: number | null; heightPx: number | null }

export type FileFit =
  | { state: 'ok' | 'bad'; expected: { w: number; h: number } }
  | { state: 'unknown'; expected: { w: number; h: number } }
  | { state: 'no-template' | 'extra'; expected: null }

/** The pixel size a print area must have: the area's own box when it has one, else the whole template. */
export function expectedSize(template: FitTemplate | null, area: string): { w: number; h: number } | null {
  if (!template) return null
  const hit = template.areas.find(a => a.name === area)
  if (!hit) return null
  return hit.w > 0 && hit.h > 0 ? { w: hit.w, h: hit.h } : { w: template.widthPx, h: template.heightPx }
}

/** Whether a print file matches its template: the area's size, or the whole template (a full-canvas export) both pass. */
export function printFileFit(template: FitTemplate | null, area: string, file: FitFile): FileFit {
  if (!template) return { state: 'no-template', expected: null }
  const expected = expectedSize(template, area)
  if (!expected) return { state: 'extra', expected: null }
  if (!file.widthPx || !file.heightPx) return { state: 'unknown', expected }
  const ok = (file.widthPx === expected.w && file.heightPx === expected.h) || (file.widthPx === template.widthPx && file.heightPx === template.heightPx)
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
