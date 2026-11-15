type MadeFile = { kind: string; printArea: string; fileName: string; version: number; widthPx?: number | null; heightPx?: number | null }

export const PUSH_EVENT_PREFIX = 'Render tự động (máy local 25/10)'
export const NO_NAME_SUFFIX = ' · khách không đặt tên'

export function hasNoNameFile(files: { fileName: string }[]): boolean {
  return files.some(f => /-noname\./.test(f.fileName))
}

/** What a delivery made, worded like the local push script so the timeline reads the same as before the API. */
export function madeText(files: MadeFile[]): string {
  const fresh = files.filter(f => f.kind === 'PRINT')
  const mockups = files.filter(f => f.kind === 'MOCKUP').length
  const parts = !fresh.length
    ? `${mockups} mockup`
    : fresh.length === 1
      ? `${fresh[0].printArea} v${fresh[0].version} · ${fresh[0].widthPx ?? '?'}×${fresh[0].heightPx ?? '?'} px`
      : `${fresh.length} mảnh: ${fresh.map(f => `${f.printArea} v${f.version}`).join(', ')}`
  return parts + (fresh.length && mockups ? ` · ${mockups} mockup` : '')
}

export function pushEventMessage(files: MadeFile[], eventMessage?: string): string {
  return eventMessage ?? `${PUSH_EVENT_PREFIX} · ${madeText(files)}${hasNoNameFile(files) ? NO_NAME_SUFFIX : ''}`
}
