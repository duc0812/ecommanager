import { prisma } from '@/lib/db'

export const FLAT_TEXT_AUTO_KEY = 'flat_text_auto_products'

/**
 * A product whose prints come from the flat-text library on the office PC (owner 11-04: TN2605261712 moved to the 12 pieces of WZIP).
 * Prod holds no artwork for it, so it can't queue the render, but the task is still automatic: flat_text_batch.py renders the whole set.
 */
export type FlatTextAutoProduct = {
  storeId: string; shopifyProductId: string
  templateIds: string[]; skus: string[]
  nameField: string
  /** Older orders keep the files of the old template, so a task of theirs that reopens is not rendered from this library. */
  fromOrder?: number
}

export type FlatTextAutoLine = {
  storeId: string; shopifyProductId: string; templateId: string; sku: string | null; orderNumber: string
  personalization: { key: string; value: string }[]
}

export function parseFlatTextAuto(json: string | null | undefined): FlatTextAutoProduct[] {
  if (!json) return []
  try {
    const parsed = JSON.parse(json)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

const fieldKey = (key: string) => key.toLowerCase().trim().replace(/[:?\s]+$/, '')

/** The same reading as flat_text_batch.py: a lone No prints no name, whatever is left in the box. Yes with no name goes to a person. */
function nameIsSettled(nameField: string, personalization: FlatTextAutoLine['personalization']): boolean {
  const field = fieldKey(nameField)
  const values = personalization.filter(p => fieldKey(p.key) === field || p.key.toLowerCase().includes('yes or no')).map(p => p.value.trim().toLowerCase())
  if (values.includes('no') && !values.includes('yes')) return true
  return values.some(v => v && v !== 'yes' && v !== 'no')
}

export function flatTextCoversLine(products: FlatTextAutoProduct[], line: FlatTextAutoLine): boolean {
  const sku = (line.sku ?? '').trim().toLowerCase()
  const orderNo = Number(/\d+/.exec(line.orderNumber)?.[0] ?? 0)
  return products.some(p => p.storeId === line.storeId && p.shopifyProductId === line.shopifyProductId
    && p.templateIds.includes(line.templateId)
    && p.skus.some(s => s.toLowerCase() === sku)
    && (!p.fromOrder || orderNo >= p.fromOrder)
    && nameIsSettled(p.nameField, line.personalization))
}

export async function loadFlatTextAuto(): Promise<FlatTextAutoProduct[]> {
  const row = await prisma.appSetting.findUnique({ where: { key: FLAT_TEXT_AUTO_KEY }, select: { value: true } })
  return parseFlatTextAuto(row?.value)
}
