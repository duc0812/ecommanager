import { prisma } from '@/lib/db'
import { isNonProductLine } from '@/lib/order-lines'
import { loadTemplateContext, pickTemplate, type TemplateContext, type TemplateLookupLine, type TemplateRow } from '@/lib/print-template-resolve'
import { observationSince } from '@/lib/product-profiles'
import {
  optionsLabel, parseArtworkSplits, parseVariantOptions, resolveEntryForLine, slotOptionKey, splitOptionFor, summarizeOptions,
  type ArtworkSplit, type OptionSummary,
} from '@/lib/artwork-options'
import { productStatus, type EntryStatus, type LibraryProductStatus, type SlotStatus } from '@/lib/artwork-fields'

export const LIBRARY_LINE_LIMIT = 500

export type SlotLine = TemplateLookupLine & { variantOptions: string | null; variantTitle: string | null }
export type SlotEntry = { id: string; printTemplateId: string; optionKey: string; status: string }
export type SlotProfile = { printTemplateId: string | null; artworkSplits?: string | null }

export type SlotDraft<L extends SlotLine> = {
  key: string
  supplierId: string
  templateId: string | null
  template: TemplateRow | null
  optionKey: string
  splitOption: string | null
  sku: string | null
  skus: string[]
  lines: L[]
  options: OptionSummary[]
  title: string
  splitChoices: OptionSummary[]
}

export type SlotAssignment<L extends SlotLine, E extends SlotEntry> = SlotDraft<L> & { entry: E | null; inherited: boolean; status: SlotStatus }

export const ALL_VARIANTS_LABEL = 'Mọi biến thể'

function slotTitle(lines: Array<{ variantOptions: string | null; variantTitle: string | null }>, options: OptionSummary[]): string {
  const label = optionsLabel(options)
  if (label) return label
  const titles = Array.from(new Set(lines.map(l => l.variantTitle?.trim()).filter((t): t is string => !!t)))
  return titles.length ? titles.join(', ') : ALL_VARIANTS_LABEL
}

export function buildSlotDrafts<L extends SlotLine>(lines: L[], profile: SlotProfile | null, ctx: TemplateContext): { slots: SlotDraft<L>[]; unmapped: number } {
  const splits = parseArtworkSplits(profile?.artworkSplits)
  type Acc = { key: string; supplierId: string; template: TemplateRow | null; optionKey: string; splitOption: string | null; sku: string | null; skus: Set<string>; lines: L[] }
  const groups = new Map<string, Acc>()
  const byTemplate = new Map<string, L[]>()
  let unmapped = 0
  for (const l of lines) {
    if (!l.resolvedSupplierId) { unmapped++; continue }
    const tpl = pickTemplate(l, profile, ctx)
    const sku = l.resolvedSupplierSku?.trim() || null
    let key: string, optionKey = '', splitOption: string | null = null
    if (tpl) {
      splitOption = splitOptionFor(splits, tpl.id)
      optionKey = slotOptionKey(parseVariantOptions(l.variantOptions), splitOption)
      key = `tpl:${tpl.id}|${optionKey}`
      byTemplate.set(tpl.id, [...(byTemplate.get(tpl.id) ?? []), l])
    } else {
      key = `none:${l.resolvedSupplierId}:${(sku ?? '').toLowerCase()}`
    }
    let g = groups.get(key)
    if (!g) {
      g = { key, supplierId: l.resolvedSupplierId, template: tpl, optionKey, splitOption, sku: tpl ? null : sku, skus: new Set(), lines: [] }
      groups.set(key, g)
    }
    if (sku) g.skus.add(sku)
    g.lines.push(l)
  }
  const choices = new Map(Array.from(byTemplate.entries()).map(([id, ls]) => [id, summarizeOptions(ls)]))
  const slots = Array.from(groups.values()).map(g => {
    const options = summarizeOptions(g.lines)
    return {
      key: g.key, supplierId: g.supplierId, templateId: g.template?.id ?? null, template: g.template, optionKey: g.optionKey, splitOption: g.splitOption,
      sku: g.sku, skus: Array.from(g.skus).sort(), lines: g.lines, options, title: slotTitle(g.lines, options),
      splitChoices: g.template ? (choices.get(g.template.id) ?? []) : [],
    }
  })
  slots.sort((a, b) => (a.template ? 0 : 1) - (b.template ? 0 : 1)
    || (a.template?.name ?? a.sku ?? '').localeCompare(b.template?.name ?? b.sku ?? '')
    || (a.optionKey ? 1 : 0) - (b.optionKey ? 1 : 0)
    || a.title.localeCompare(b.title))
  return { slots, unmapped }
}

export function assignSlotEntries<L extends SlotLine, E extends SlotEntry>(drafts: SlotDraft<L>[], entries: E[]): { slots: SlotAssignment<L, E>[]; stale: E[] } {
  const used = new Set<string>()
  const slots = drafts.map(d => {
    if (!d.templateId) return { ...d, entry: null, inherited: false, status: 'NO_TEMPLATE' as SlotStatus }
    const own = entries.find(e => e.printTemplateId === d.templateId && e.optionKey === d.optionKey) ?? null
    const shared = !own && d.optionKey ? entries.find(e => e.printTemplateId === d.templateId && e.optionKey === '') ?? null : null
    const entry = own ?? shared
    if (entry) used.add(entry.id)
    return { ...d, entry, inherited: !!shared, status: ((entry?.status as EntryStatus | undefined) ?? 'EMPTY') as SlotStatus }
  })
  return { slots, stale: entries.filter(e => !used.has(e.id)) }
}

export function slotStatusSummary<E extends SlotEntry>(slots: Array<{ status: SlotStatus }>, stale: E[], unmapped: number): LibraryProductStatus {
  return productStatus({ active: slots.map(s => s.status), stale: stale.map(e => e.status as SlotStatus), unmapped })
}

export function resolveLineEntry<E extends SlotEntry>(entries: E[], templateId: string, variantOptions: string | Record<string, unknown> | null, splits: ArtworkSplit[]): E | null {
  return resolveEntryForLine(entries.filter(e => e.printTemplateId === templateId), parseVariantOptions(variantOptions), splitOptionFor(splits, templateId))
}

export const SLOT_LINE_SELECT = {
  orderId: true, shopifyLineId: true, shopifyProductId: true, productTitle: true, shopifyProductType: true, imageUrl: true,
  customAttributesJson: true, sku: true, resolvedSupplierId: true, resolvedSupplierSku: true, variantTitle: true, variantOptions: true,
} as const

export async function productSlotLines(storeId: string, shopifyProductId: string) {
  const lines = await prisma.orderLine.findMany({
    where: { shopifyProductId, order: { storeId, placedAt: { gte: observationSince() } } },
    orderBy: { order: { placedAt: 'desc' } },
    take: LIBRARY_LINE_LIMIT,
    select: SLOT_LINE_SELECT,
  })
  return lines.filter(l => !isNonProductLine(l))
}

export async function computeProductSlots<L extends SlotLine, E extends SlotEntry>(lines: L[], profile: SlotProfile | null, entries: E[]) {
  const ctx = await loadTemplateContext(lines.filter(l => l.resolvedSupplierId), [profile?.printTemplateId])
  const { slots: drafts, unmapped } = buildSlotDrafts(lines, profile, ctx)
  const { slots, stale } = assignSlotEntries(drafts, entries)
  return { slots, stale, unmapped, status: slotStatusSummary(slots, stale, unmapped) }
}

export async function productArtworkStatus(storeId: string, shopifyProductId: string): Promise<LibraryProductStatus> {
  const [profile, lines, entries] = await Promise.all([
    prisma.productProfile.findUnique({ where: { storeId_shopifyProductId: { storeId, shopifyProductId } }, select: { printTemplateId: true, artworkSplits: true } }),
    productSlotLines(storeId, shopifyProductId),
    prisma.artworkEntry.findMany({ where: { storeId, shopifyProductId }, select: { id: true, printTemplateId: true, optionKey: true, status: true } }),
  ])
  return (await computeProductSlots(lines, profile, entries)).status
}
