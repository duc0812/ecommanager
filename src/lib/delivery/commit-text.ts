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

export const REPLACE_EVENT_PREFIX = 'Render lại (máy local 26/10)'
export const REVERT_EVENT_PREFIX = 'Gỡ file in tự động (máy local 26/10)'
export const RESUBMIT_EVENT = 'Gửi duyệt lại'

/** Retired rows as the timeline names them: prints first, `<area> v<n>`, mockups as `mockup <area> v<n>`. */
export function goneText(rows: { kind: string; printArea: string; version: number }[]): string {
  const ordered = [...rows.filter(r => r.kind === 'PRINT'), ...rows.filter(r => r.kind !== 'PRINT')]
  return ordered.map(r => `${r.kind === 'PRINT' ? '' : 'mockup '}${r.printArea} v${r.version}`).join(', ')
}

/** `gone` is empty when the replace only added parts that had no live file. */
export function replaceEventMessage(files: MadeFile[], gone: string, eventMessage?: string): string {
  const swapped = gone ? ` · thay ${gone}` : ''
  return eventMessage
    ? `${eventMessage}${swapped}`
    : `${REPLACE_EVENT_PREFIX} · ${madeText(files)}${swapped}${hasNoNameFile(files) ? NO_NAME_SUFFIX : ''}`
}

export function retireEventMessage(gone: string, eventMessage?: string): string {
  return `${eventMessage ?? 'Gỡ file'} · gỡ ${gone}`
}

export function revertEventMessage(gone: string, eventMessage?: string): string {
  return `${REVERT_EVENT_PREFIX}: gỡ ${gone} — ${eventMessage ?? 'rút qua API'}`
}
