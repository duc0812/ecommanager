import { decompressFromBase64 } from 'lz-string'
import { unpack } from 'jsonpack'
import { prisma } from '@/lib/db'

// Orders from Customall-app products carry no readable text: only `_customallcustomid` and a mockup.
// Customall keeps what the shopper typed under that id. A request names its target as JSON, XORed
// byte-wise with 0x47 and hex-encoded; packed answers are lz-string base64 around jsonpack.
//   order-info/<hex({customization_id})>   {<artworkId>: {template, <layerId>: value}}  (plain JSON)
//   <hex({uri: 'hash/<shop>/<pid>'})>.json  {data: packed {hash}}
//   <hex({uri: '<shop>/<pid>/<hash>'})>.json {data: packed campaign}: artworks[].templates[].layers[] give the field names

const API = 'https://apis-v2.customall.io/app'
const XOR_KEY = 0x47
const TIMEOUT_MS = 10_000
const ID_RE = /^\d{4}-\d{2}-\d{2}\/[A-Za-z0-9]+$/
const SHOP_RE = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/
const RETRY_MS = 6 * 3600_000

export type CustomallField = { key: string; value: string }
export type CustomallValues = Record<string, unknown>
type Layer = { id?: string; type?: string; title?: string; options?: Array<{ label?: string; value?: string }> }
type Artwork = { id?: string; templateDisplayLabel?: string; templates?: Array<{ title?: string; layers?: Layer[] }> }
export type Campaign = { artworks?: Artwork[] }

export function customizationIdOf(attrs: Array<{ key: string; value: string }>): string | null {
  const v = attrs.find(a => a.key === '_customallcustomid')?.value?.trim()
  return v && ID_RE.test(v) ? v : null
}

export function customizationIdFromJson(json: string | null): string | null {
  if (!json) return null
  try {
    const attrs = JSON.parse(json)
    return Array.isArray(attrs) ? customizationIdOf(attrs.filter(a => a && typeof a.key === 'string' && typeof a.value === 'string')) : null
  } catch { return null }
}

export function encodeRequest(obj: unknown): string {
  return Array.from(Buffer.from(JSON.stringify(obj), 'utf8'), b => (b ^ XOR_KEY).toString(16).padStart(2, '0')).join('')
}

export function decodePacked(data: string): any {
  const packed = decompressFromBase64(data)
  if (!packed) throw new Error('Customall: answer is not lz-string base64')
  return unpack(packed)
}

export function numericProductId(gid: string | null | undefined): string | null {
  const m = gid?.match(/(\d+)$/)
  return m ? m[1] : null
}

export function parseCustomallFields(json: string | null): CustomallField[] | null {
  if (json == null) return null
  try {
    const v = JSON.parse(json)
    if (!Array.isArray(v)) return null
    return v.filter((f): f is CustomallField => !!f && typeof f.key === 'string' && typeof f.value === 'string')
  } catch { return null }
}

/** The shopper's own input, named by the campaign's layer titles. Picture layers hold item ids, not text, and are left out. */
export function customallFields(values: CustomallValues, campaign: Campaign | null): CustomallField[] {
  const out: CustomallField[] = []
  const seen = new Set<string>()
  const push = (key: string, raw: unknown) => {
    if (typeof raw !== 'string' && typeof raw !== 'number') return
    const value = String(raw).trim()
    if (!value) return
    const id = `${key.toLowerCase().trim()}\u0000${value}`
    if (seen.has(id)) return
    seen.add(id)
    out.push({ key, value })
  }
  for (const [artworkId, chosen] of Object.entries(values)) {
    if (!chosen || typeof chosen !== 'object' || Array.isArray(chosen)) continue
    const picked = chosen as Record<string, unknown>
    const artwork = campaign?.artworks?.find(a => a.id === artworkId)
    const templates = artwork?.templates ?? []
    const template = templates[typeof picked.template === 'number' ? picked.template : 0]
    if (templates.length > 1 && template?.title) push(artwork?.templateDisplayLabel?.trim() || 'Template', template.title)
    const known = new Set<string>()
    for (const layer of template?.layers ?? []) {
      if (!layer.id) continue
      known.add(layer.id)
      const raw = picked[layer.id]
      if (layer.type === 'Text') push(layer.title?.trim() || 'Text', raw)
      else if (layer.type === 'Option') push(layer.title?.trim() || 'Option', layer.options?.find(o => o.value === raw)?.label ?? raw)
    }
    for (const [layerId, raw] of Object.entries(picked)) {
      if (layerId !== 'template' && !known.has(layerId)) push(`Layer ${layerId}`, raw)
    }
  }
  return out
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' })
  if (!res.ok) throw new Error(`Customall HTTP ${res.status}`)
  return res.json()
}

export async function fetchCustomizationValues(customizationId: string): Promise<CustomallValues> {
  const body = await getJson(`${API}/order-info/${encodeRequest({ customization_id: customizationId })}`)
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Customall: unexpected order-info answer')
  return body
}

async function getPacked(uri: string): Promise<any> {
  const body = await getJson(`${API}/${encodeRequest({ uri })}.json`)
  if (typeof body?.data !== 'string') throw new Error('Customall: answer has no data')
  return decodePacked(body.data)
}

/** The product's current campaign, or null when Customall no longer serves one for it. */
export async function fetchCampaign(shop: string, productId: string): Promise<Campaign | null> {
  if (!SHOP_RE.test(shop) || !/^\d+$/.test(productId)) return null
  try {
    const h = await getPacked(`hash/${shop}/${productId}`)
    if (typeof h?.hash !== 'string' || !/^[A-Za-z0-9]+$/.test(h.hash)) return null
    const campaign = await getPacked(`${shop}/${productId}/${h.hash}`)
    return campaign && typeof campaign === 'object' ? campaign : null
  } catch { return null }
}

declare global {
  // eslint-disable-next-line no-var
  var __customallFieldAttempts: Map<string, number> | undefined
}

function attempts(): Map<string, number> {
  if (!globalThis.__customallFieldAttempts) globalThis.__customallFieldAttempts = new Map()
  return globalThis.__customallFieldAttempts
}

export type FillResult = { filled: number; failed: number; errors: string[] }

/**
 * Stores what the shopper typed on every Customall line of these orders that has not been read yet
 * (`force` reads them again). A line Customall does not answer for stays unread and is retried later;
 * `throttle` keeps a background run from asking about it more than once per RETRY_MS.
 */
export async function fillCustomallFields(orderIds: string[], opts: { force?: boolean; throttle?: boolean; now?: number } = {}): Promise<FillResult> {
  const result: FillResult = { filled: 0, failed: 0, errors: [] }
  if (orderIds.length === 0) return result
  const lines = await prisma.orderLine.findMany({
    where: {
      orderId: { in: orderIds },
      customAttributesJson: { contains: '_customallcustomid' },
      ...(opts.force ? {} : { customallFieldsJson: null }),
    },
    select: { id: true, customAttributesJson: true, shopifyProductId: true, order: { select: { store: { select: { shop: true } } } } },
  })
  const now = opts.now ?? Date.now()
  const tried = attempts()
  const campaigns = new Map<string, Promise<Campaign | null>>()
  for (const line of lines) {
    const customizationId = customizationIdFromJson(line.customAttributesJson)
    if (!customizationId) continue
    const last = tried.get(customizationId)
    if (opts.throttle && last !== undefined && now - last < RETRY_MS) continue
    tried.set(customizationId, now)
    try {
      const values = await fetchCustomizationValues(customizationId)
      const shop = line.order.store.shop
      const productId = numericProductId(line.shopifyProductId)
      let campaign: Campaign | null = null
      if (productId) {
        const key = `${shop}/${productId}`
        if (!campaigns.has(key)) campaigns.set(key, fetchCampaign(shop, productId))
        campaign = await campaigns.get(key)!
      }
      await prisma.orderLine.update({ where: { id: line.id }, data: { customallFieldsJson: JSON.stringify(customallFields(values, campaign)) } })
      tried.delete(customizationId)
      result.filled++
    } catch (e: any) {
      result.failed++
      result.errors.push(`${customizationId}: ${e?.message ?? String(e)}`)
    }
  }
  return result
}
