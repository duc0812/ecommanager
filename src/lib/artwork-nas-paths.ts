import { parseOptionKey } from '@/lib/artwork-options'

const MAX_SEGMENT = 80

/** One folder name: no characters Windows refuses, no trailing dot or space, bounded length. */
export function nasSegment(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_SEGMENT).replace(/[. ]+$/, '')
  return s || '_'
}

const CODE_RE = /\b([A-Z]{2,3}\d{8,10})\b/g

/** The design code in a product title (DN2509261948), else "P" + the Shopify product number. */
export function nasProductKey(title: string, shopifyProductId: string): string {
  const codes = Array.from(title.matchAll(CODE_RE)).map(m => m[1])
  return codes.length ? codes[codes.length - 1] : `P${shopifyProductId.split('/').pop() ?? shopifyProductId}`
}

export function nasProductFolder(title: string, shopifyProductId: string): string {
  const key = nasProductKey(title, shopifyProductId)
  const short = title.replace(CODE_RE, ' ').split(/\s+-\s+|\s+–\s+/).map(s => s.trim()).find(Boolean) ?? ''
  return nasSegment(short ? `${key} - ${short.slice(0, 55)}` : key)
}

export function nasSlotFolder(input: { templateName: string; supplierName: string; supplierSku: string | null; optionKey: string }): string {
  const combo = input.optionKey ? parseOptionKey(input.optionKey) : null
  const label = combo ? Object.values(combo).join(' ') : input.templateName
  return nasSegment(`${label} - ${input.supplierName}${input.supplierSku ? ` ${input.supplierSku}` : ''}`)
}

/** Folder segments of a slot under the NAS root: the PSD's own folder once one was found, else store / product / slot. */
export function nasSlotPath(i: {
  storeName: string; title: string; shopifyProductId: string; templateName: string; supplierName: string; supplierSku: string | null
  optionKey: string; nasPath?: string | null
}): string[] {
  if (i.nasPath) return i.nasPath.split('/').slice(0, -1)
  return [
    nasSegment(i.storeName), nasProductFolder(i.title, i.shopifyProductId),
    nasSlotFolder({ templateName: i.templateName, supplierName: i.supplierName, supplierSku: i.supplierSku, optionKey: i.optionKey }),
  ]
}
