import { prisma } from '@/lib/db'
import { findProfile } from '@/lib/product-profiles'
import { loadTemplateContext, pickTemplate, requiredSlotsFor } from '@/lib/design-tasks'
import { PublicUrlError, isLineApproved } from '@/lib/public-artwork'
import {
  appFileArtworkId, factoryLinkFor, isAppFileLink, isStudioLink, joinDesignLinks, lazyPublicBase, type LinkArtwork, type SlotLink,
} from '@/lib/design-links'
import { currentFiles, orderedPrintFiles } from '@/lib/task-files'

export type ExportLineInput = {
  id: string; orderId: string; shopifyLineId: string; linePosition: number; designDriveLink: string | null
  resolvedSupplierId: string | null; resolvedSupplierSku: string | null; shopifyProductId: string | null; customAttributesJson: string | null
}
export type ExportOrderInput = { id: string; storeId: string; shopifyOrderNumber: string; designDriveLink: string | null; lines: ExportLineInput[] }

export type StudioLineLinks = { joined: string; byArea: Record<string, string> }
export type ExportLinkProblem = { orderNumber: string; reason: string }
export type ExportLinkNeeds = {
  /** The joined design link of a line (`line.designDriveLink`, `line.designLinks`). */
  design?: boolean
  /** One link per print part (`line.designArea:<part>`). */
  areas?: boolean
  /** The newest mockup file of a line (`line.mockupLink`). */
  mockup?: boolean
}
export type ExportDesignLinks = {
  byLineId: Map<string, StudioLineLinks>
  /** Lines with an uploaded mockup file: the link of the newest one. */
  mockupByLineId: Map<string, string>
  /** A stored value as the factory can open it: an app file path becomes the Drive or public link, anything else is returned untouched. */
  translate: (stored: string | null) => string | null
  problems: ExportLinkProblem[]
}

type ArtworkRecord = LinkArtwork & { orderId: string; shopifyLineId: string; kind: string; removedAt: Date | null; createdAt: Date }

const ARTWORK_SELECT = {
  id: true, orderId: true, shopifyLineId: true, kind: true, printArea: true, version: true, fileName: true, mimeType: true,
  storage: true, driveWebViewLink: true, removedAt: true, createdAt: true,
} as const
const CHUNK = 400
const lineKey = (orderId: string, shopifyLineId: string) => `${orderId}\u0000${shopifyLineId}`

function chunks<T>(list: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}

/**
 * Links for a supplier CSV. A line approved in Design Studio whose stored link is its task folder exports that folder as is.
 * Any other Studio line gets one link per print part (template areas first, then the other parts; Drive link, or the public
 * artwork URL while the file is still local), joined. Every other line keeps its stored link. An app-relative
 * `/api/design-studio/file/...` path never leaves this function: it is translated, or reported as a problem.
 */
export async function resolveExportDesignLinks(orders: ExportOrderInput[], needs: ExportLinkNeeds = { design: true, areas: true }): Promise<ExportDesignLinks> {
  const byLineId = new Map<string, StudioLineLinks>()
  const mockupByLineId = new Map<string, string>()
  const stored = new Map<string, string>()
  const problems: ExportLinkProblem[] = []
  const seenProblem = new Set<string>()
  const problem = (orderNumber: string, reason: string) => {
    const key = `${orderNumber}\u0000${reason}`
    if (seenProblem.has(key)) return
    seenProblem.add(key)
    problems.push({ orderNumber, reason })
  }
  const translate = (value: string | null) => (value && isAppFileLink(value) ? stored.get(value) ?? null : value)
  if (orders.length === 0) return { byLineId, mockupByLineId, translate, problems }

  const orderIds = orders.map(o => o.id)
  const artworks: ArtworkRecord[] = []
  const taskStatus = new Map<string, string>()
  const folderUrl = new Map<string, string>()
  for (const ids of chunks(orderIds)) {
    artworks.push(...await prisma.designArtwork.findMany({ where: { orderId: { in: ids }, removedAt: null }, select: ARTWORK_SELECT, orderBy: { version: 'desc' } }))
    const tasks = await prisma.designTask.findMany({ where: { orderId: { in: ids } }, select: { orderId: true, shopifyLineId: true, status: true, driveFolderUrl: true } })
    for (const t of tasks) {
      taskStatus.set(lineKey(t.orderId, t.shopifyLineId), t.status)
      if (t.driveFolderUrl) folderUrl.set(lineKey(t.orderId, t.shopifyLineId), t.driveFolderUrl)
    }
  }
  const byLine = new Map<string, ArtworkRecord[]>()
  for (const a of artworks) {
    const key = lineKey(a.orderId, a.shopifyLineId)
    byLine.set(key, [...(byLine.get(key) ?? []), a])
  }

  type StudioLine = { order: ExportOrderInput; line: ExportLineInput; artworks: ArtworkRecord[]; folder: string | null }
  const studio: StudioLine[] = []
  const withMockup: StudioLine[] = []
  for (const order of orders) {
    for (const line of order.lines) {
      const key = lineKey(order.id, line.shopifyLineId)
      const mine = byLine.get(key) ?? []
      const folder = folderUrl.get(key) ?? null
      const entry = { order, line, artworks: mine, folder }
      if (currentFiles(mine, 'PRINT').length > 0 && isStudioLink(line.designDriveLink, mine, folder)) studio.push(entry)
      if (needs.mockup && currentFiles(mine, 'MOCKUP').length > 0) withMockup.push(entry)
    }
  }

  const wantsDesign = !!(needs.design || needs.areas)
  const templated = wantsDesign ? studio : []
  const profiles = new Map<string, { printTemplateId: string | null } | null>()
  for (const { order, line } of templated) {
    if (!line.shopifyProductId) continue
    const key = `${order.storeId}\u0000${line.shopifyProductId}`
    if (!profiles.has(key)) profiles.set(key, await findProfile(order.storeId, line.shopifyProductId))
  }
  const profileFor = (order: ExportOrderInput, line: ExportLineInput) =>
    line.shopifyProductId ? profiles.get(`${order.storeId}\u0000${line.shopifyProductId}`) ?? null : null
  const ctx = await loadTemplateContext(templated.map(s => s.line), templated.map(s => profileFor(s.order, s.line)?.printTemplateId))
  const publicBase = lazyPublicBase()

  async function link(order: ExportOrderInput, line: { designDriveLink: string | null; linePosition?: number }, art: ArtworkRecord, area: string): Promise<SlotLink | null> {
    try {
      const r = await factoryLinkFor(art, publicBase)
      if (r.local) {
        const status = taskStatus.get(lineKey(art.orderId, art.shopifyLineId))
        if (!isLineApproved(line, status ? { status } : null)) {
          problem(order.shopifyOrderNumber, `design chưa được duyệt${status ? ` (task đang ${status})` : ''} — link file in công khai chưa mở`)
          return null
        }
      }
      return { area, url: r.url, artworkId: art.id, local: r.local }
    } catch (e: any) {
      if (!(e instanceof PublicUrlError)) throw e
      problem(order.shopifyOrderNumber, e.message)
      return null
    }
  }

  for (const { order, line, artworks: mine, folder } of templated) {
    const handsFolder = !!folder && line.designDriveLink === folder
    // The folder link needs no per-file link; those are only resolved for a column that prints one part.
    if (handsFolder && !needs.areas) { byLineId.set(line.id, { joined: folder, byArea: {} }); continue }
    const template = pickTemplate(line, profileFor(order, line), ctx)
    const picked = orderedPrintFiles(mine, requiredSlotsFor(template))
    const links: SlotLink[] = []
    for (const p of picked) {
      const l = await link(order, line, p, p.printArea)
      if (l) links.push(l)
    }
    if (links.length === picked.length) {
      byLineId.set(line.id, { joined: handsFolder ? folder : joinDesignLinks(links), byArea: Object.fromEntries(links.map(l => [l.area, l.url])) })
    }
  }

  for (const { order, line, artworks: mine } of withMockup) {
    const newest = currentFiles(mine, 'MOCKUP').sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0]
    const l = await link(order, line, newest, newest.printArea)
    if (l) mockupByLineId.set(line.id, l.url)
  }

  // Stored app paths outside the Studio lines above: an order-level link, or a line whose artworks were all removed.
  const studioLineIds = new Set(templated.map(s => s.line.id))
  const pending = new Map<string, ExportOrderInput>()
  for (const order of orders) {
    if (isAppFileLink(order.designDriveLink)) pending.set(order.designDriveLink, order)
    for (const line of order.lines) {
      if (wantsDesign && !studioLineIds.has(line.id) && isAppFileLink(line.designDriveLink)) pending.set(line.designDriveLink, order)
    }
  }
  if (pending.size > 0) {
    const idByLink = new Map(Array.from(pending.keys()).map(l => [l, appFileArtworkId(l)]))
    const ids = Array.from(new Set(Array.from(idByLink.values()).filter((x): x is string => !!x)))
    const rows: ArtworkRecord[] = []
    for (const part of chunks(ids)) rows.push(...await prisma.designArtwork.findMany({ where: { id: { in: part } }, select: ARTWORK_SELECT }))
    const artById = new Map(rows.map(r => [r.id, r]))
    for (const [value, order] of Array.from(pending.entries())) {
      const art = artById.get(idByLink.get(value) ?? '')
      if (!art || art.removedAt) { problem(order.shopifyOrderNumber, 'file in của link design đã bị xoá — duyệt lại design'); continue }
      const key = lineKey(art.orderId, art.shopifyLineId)
      if (!taskStatus.has(key)) {
        const task = await prisma.designTask.findUnique({ where: { orderId_shopifyLineId: { orderId: art.orderId, shopifyLineId: art.shopifyLineId } }, select: { status: true } })
        if (task) taskStatus.set(key, task.status)
      }
      const owner = await prisma.orderLine.findFirst({ where: { orderId: art.orderId, shopifyLineId: art.shopifyLineId }, select: { designDriveLink: true } })
      const l = await link(order, owner ?? { designDriveLink: null }, art, art.printArea)
      if (l) stored.set(value, l.url)
    }
  }

  return { byLineId, mockupByLineId, translate, problems }
}

export function exportLinkErrorMessage(problems: ExportLinkProblem[]): string {
  const byReason = new Map<string, string[]>()
  for (const p of problems) byReason.set(p.reason, [...(byReason.get(p.reason) ?? []), p.orderNumber])
  const parts = Array.from(byReason.entries()).map(([reason, orders]) => {
    const shown = orders.slice(0, 30).join(', ')
    return `${reason} — đơn: ${shown}${orders.length > 30 ? ` … (+${orders.length - 30})` : ''}`
  })
  return `Không xuất được CSV vì có link design xưởng không mở được. ${parts.join('; ')}`
}
